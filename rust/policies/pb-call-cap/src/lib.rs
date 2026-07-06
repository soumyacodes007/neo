//! # `pb_call_cap` — Parameterized Rolling-Window Call Cap
//!
//! A cumulative cap on an amount read from a **configurable** `(fn, arg path)` —
//! the generic DeFi spend policy that OZ `spending_limit` is not (which only
//! meters SEP-41 `transfer` arg[2]). Reads the amount via a JSONPath-lite path
//! (mirrors the TS `resolvePath`, FN-ST.22), sums `[*]` fan-out, and applies an
//! optional token filter so only the intended asset counts (Blend
//! `submit.requests[*].amount`, Soroswap swap amounts — EC-S16).
//!
//! Deliberately mirrors OZ `spending_limit` window/history/zero/overflow
//! semantics (EC-P02/P10/S12/S13); it only generalizes the amount source.
//!
//! Error range: **3340–3359**.
#![no_std]

use soroban_sdk::{
    auth::{Context, ContractContext},
    contract, contracterror, contractevent, contractimpl, contracttype, panic_with_error, Address,
    Env, Map, Symbol, TryFromVal, Val, Vec,
};
use stellar_accounts::{
    policies::Policy,
    smart_account::{ContextRule, ContextRuleType, Signer},
};

// ################## EVENTS ##################

#[contractevent]
#[derive(Clone)]
pub struct PbCallCapEnforced {
    #[topic]
    pub smart_account: Address,
    pub context_rule_id: u32,
    pub amount: i128,
    pub total_in_period: i128,
}

#[contractevent]
#[derive(Clone)]
pub struct PbCallCapInstalled {
    #[topic]
    pub smart_account: Address,
    pub context_rule_id: u32,
    pub cap: i128,
    pub period_ledgers: u32,
}

#[contractevent]
#[derive(Clone)]
pub struct PbCallCapChanged {
    #[topic]
    pub smart_account: Address,
    pub context_rule_id: u32,
    pub cap: i128,
}

#[contractevent]
#[derive(Clone)]
pub struct PbCallCapUninstalled {
    #[topic]
    pub smart_account: Address,
    pub context_rule_id: u32,
}

// ################## TYPES ##################

/// JSONPath-lite segment (mirrors FN-ST.22 `PathSeg`).
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum PathSeg {
    Field(Symbol),
    Index(u32),
    Wildcard,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct CallCapParams {
    pub cap: i128,
    pub period_ledgers: u32,
    pub fn_name: Symbol,
    /// Path into the call args where the amount(s) live (from the args container).
    pub amount_path: Vec<PathSeg>,
    /// Per-element token filter path (empty ⇒ no filter). When set, an element's
    /// amount counts only if the token at this path (fanned out in the same order)
    /// equals `token_filter_token`.
    pub token_filter_path: Vec<PathSeg>,
    pub token_filter_token: Option<Address>,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct SpendEntry {
    pub amount: i128,
    pub ledger: u32,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct CallCapData {
    pub params: CallCapParams,
    pub history: Vec<SpendEntry>,
    pub cached_total: i128,
}

#[contracttype]
pub enum PbCallCapStorageKey {
    AccountContext(Address, u32),
}

// ################## ERRORS ##################

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum PbCallCapError {
    SmartAccountNotInstalled = 3340,
    AlreadyInstalled = 3341,
    InvalidLimitOrPeriod = 3342,
    NotAllowed = 3343,
    CapExceeded = 3344,
    HistoryCapacityExceeded = 3345,
    LessThanZero = 3346,
    ArgPathUnresolved = 3347,
    MathOverflow = 3348,
    OnlyCallContractAllowed = 3349,
}

// ################## CONSTANTS ##################

const DAY_IN_LEDGERS: u32 = 17280;
pub const CALL_CAP_EXTEND_AMOUNT: u32 = 30 * DAY_IN_LEDGERS;
pub const CALL_CAP_TTL_THRESHOLD: u32 = CALL_CAP_EXTEND_AMOUNT - DAY_IN_LEDGERS;
pub const MAX_HISTORY_ENTRIES: u32 = 1000;

// ################## QUERY STATE ##################

pub fn get_call_cap_data(e: &Env, context_rule_id: u32, smart_account: &Address) -> CallCapData {
    let key = PbCallCapStorageKey::AccountContext(smart_account.clone(), context_rule_id);
    e.storage()
        .persistent()
        .get(&key)
        .inspect(|_| {
            e.storage().persistent().extend_ttl(&key, CALL_CAP_TTL_THRESHOLD, CALL_CAP_EXTEND_AMOUNT);
        })
        .unwrap_or_else(|| panic_with_error!(e, PbCallCapError::SmartAccountNotInstalled))
}

// ################## CHANGE STATE ##################

pub fn install(e: &Env, params: &CallCapParams, context_rule: &ContextRule, smart_account: &Address) {
    smart_account.require_auth();
    if !matches!(context_rule.context_type, ContextRuleType::CallContract(_)) {
        panic_with_error!(e, PbCallCapError::OnlyCallContractAllowed)
    }
    if params.cap <= 0 || params.period_ledgers == 0 {
        panic_with_error!(e, PbCallCapError::InvalidLimitOrPeriod)
    }
    let key = PbCallCapStorageKey::AccountContext(smart_account.clone(), context_rule.id);
    if e.storage().persistent().has(&key) {
        panic_with_error!(e, PbCallCapError::AlreadyInstalled)
    }
    let data = CallCapData { params: params.clone(), history: Vec::new(e), cached_total: 0 };
    e.storage().persistent().set(&key, &data);

    PbCallCapInstalled {
        smart_account: smart_account.clone(),
        context_rule_id: context_rule.id,
        cap: params.cap,
        period_ledgers: params.period_ledgers,
    }
    .publish(e);
}

pub fn enforce(
    e: &Env,
    context: &Context,
    authenticated_signers: &Vec<Signer>,
    context_rule: &ContextRule,
    smart_account: &Address,
) {
    smart_account.require_auth();
    if authenticated_signers.is_empty() {
        panic_with_error!(e, PbCallCapError::NotAllowed)
    }

    let (fn_name, args) = match context {
        Context::Contract(ContractContext { fn_name, args, .. }) => (fn_name.clone(), args.clone()),
        _ => panic_with_error!(e, PbCallCapError::NotAllowed),
    };

    let key = PbCallCapStorageKey::AccountContext(smart_account.clone(), context_rule.id);
    let mut data = get_call_cap_data(e, context_rule.id, smart_account);

    // Out of scope: this policy only meters its configured function.
    if fn_name != data.params.fn_name {
        return;
    }

    let amount = sum_amounts(e, &args, &data.params);
    if amount < 0 {
        panic_with_error!(e, PbCallCapError::LessThanZero)
    }
    // Zero moves no funds — always allowed, not recorded (EC-S12 parity).
    if amount == 0 {
        return;
    }

    let current = e.ledger().sequence();
    let removed = cleanup(&mut data.history, current, data.params.period_ledgers);
    data.cached_total = data.cached_total.checked_sub(removed).unwrap_or_else(|| panic_with_error!(e, PbCallCapError::MathOverflow));

    let projected = data.cached_total.checked_add(amount).unwrap_or_else(|| panic_with_error!(e, PbCallCapError::MathOverflow));
    if projected > data.params.cap {
        panic_with_error!(e, PbCallCapError::CapExceeded)
    }
    if data.history.len() >= MAX_HISTORY_ENTRIES {
        panic_with_error!(e, PbCallCapError::HistoryCapacityExceeded)
    }

    data.history.push_back(SpendEntry { amount, ledger: current });
    data.cached_total = projected;
    e.storage().persistent().set(&key, &data);

    PbCallCapEnforced {
        smart_account: smart_account.clone(),
        context_rule_id: context_rule.id,
        amount,
        total_in_period: data.cached_total,
    }
    .publish(e);
}

pub fn set_cap(e: &Env, cap: i128, context_rule: &ContextRule, smart_account: &Address) {
    smart_account.require_auth();
    if cap <= 0 {
        panic_with_error!(e, PbCallCapError::InvalidLimitOrPeriod)
    }
    let key = PbCallCapStorageKey::AccountContext(smart_account.clone(), context_rule.id);
    let mut data = get_call_cap_data(e, context_rule.id, smart_account);
    data.params.cap = cap;
    e.storage().persistent().set(&key, &data);
    PbCallCapChanged { smart_account: smart_account.clone(), context_rule_id: context_rule.id, cap }.publish(e);
}

pub fn uninstall(e: &Env, context_rule: &ContextRule, smart_account: &Address) {
    smart_account.require_auth();
    let key = PbCallCapStorageKey::AccountContext(smart_account.clone(), context_rule.id);
    if e.storage().persistent().has(&key) {
        e.storage().persistent().remove(&key);
    }
    PbCallCapUninstalled { smart_account: smart_account.clone(), context_rule_id: context_rule.id }.publish(e);
}

// ################## LOW-LEVEL HELPERS ##################

/// Sum the amounts resolved by `amount_path` (∀ over `[*]`), applying the token
/// filter positionally. An empty resolution denies (EC-P08/S16 fail-closed).
fn sum_amounts(e: &Env, args: &Vec<Val>, params: &CallCapParams) -> i128 {
    let amount_vals = resolve(e, args, &params.amount_path);
    if amount_vals.is_empty() {
        panic_with_error!(e, PbCallCapError::ArgPathUnresolved)
    }

    let filter_active = !params.token_filter_path.is_empty() && params.token_filter_token.is_some();
    let keep: Option<Vec<Address>> = if filter_active {
        let tokens = resolve(e, args, &params.token_filter_path);
        if tokens.len() != amount_vals.len() {
            panic_with_error!(e, PbCallCapError::ArgPathUnresolved)
        }
        let mut out = Vec::new(e);
        for tv in tokens.iter() {
            match Address::try_from_val(e, &tv) {
                Ok(a) => out.push_back(a),
                Err(_) => panic_with_error!(e, PbCallCapError::ArgPathUnresolved),
            }
        }
        Some(out)
    } else {
        None
    };

    let mut total: i128 = 0;
    for (i, av) in amount_vals.iter().enumerate() {
        if let Some(tokens) = &keep {
            let want = params.token_filter_token.as_ref().unwrap();
            if tokens.get(i as u32).as_ref() != Some(want) {
                continue; // element is a different asset — not counted here
            }
        }
        let amount = match i128::try_from_val(e, &av) {
            Ok(a) => a,
            Err(_) => panic_with_error!(e, PbCallCapError::ArgPathUnresolved),
        };
        total = total.checked_add(amount).unwrap_or_else(|| panic_with_error!(e, PbCallCapError::MathOverflow));
    }
    total
}

/// Walk a JSONPath-lite path over the call args (mirrors TS `resolvePath`).
fn resolve(e: &Env, args: &Vec<Val>, path: &Vec<PathSeg>) -> Vec<Val> {
    // Root is the args container itself, so `Index(i)` selects `args[i]`.
    let mut current: Vec<Val> = Vec::new(e);
    current.push_back(args.to_val());
    for seg in path.iter() {
        let mut next: Vec<Val> = Vec::new(e);
        for v in current.iter() {
            match &seg {
                PathSeg::Field(sym) => {
                    if let Ok(m) = Map::<Symbol, Val>::try_from_val(e, &v) {
                        if let Some(x) = m.get(sym.clone()) {
                            next.push_back(x);
                        }
                    }
                }
                PathSeg::Index(i) => {
                    if let Ok(vec) = Vec::<Val>::try_from_val(e, &v) {
                        if let Some(x) = vec.get(*i) {
                            next.push_back(x);
                        }
                    }
                }
                PathSeg::Wildcard => {
                    if let Ok(vec) = Vec::<Val>::try_from_val(e, &v) {
                        for x in vec.iter() {
                            next.push_back(x);
                        }
                    }
                }
            }
        }
        current = next;
    }
    current
}

/// Remove entries at or before `current - period`; return the evicted total.
fn cleanup(history: &mut Vec<SpendEntry>, current: u32, period: u32) -> i128 {
    let cutoff = current.saturating_sub(period);
    let mut kept = Vec::new(history.env());
    let mut removed: i128 = 0;
    for entry in history.iter() {
        if entry.ledger > cutoff {
            kept.push_back(entry);
        } else {
            removed += entry.amount;
        }
    }
    *history = kept;
    removed
}

// ################## CONTRACT WRAPPER ##################

#[contract]
pub struct PbCallCapContract;

#[contractimpl]
impl Policy for PbCallCapContract {
    type AccountParams = CallCapParams;

    fn enforce(
        e: &Env,
        context: Context,
        authenticated_signers: Vec<Signer>,
        context_rule: ContextRule,
        smart_account: Address,
    ) {
        enforce(e, &context, &authenticated_signers, &context_rule, &smart_account)
    }

    fn install(e: &Env, install_params: Self::AccountParams, context_rule: ContextRule, smart_account: Address) {
        install(e, &install_params, &context_rule, &smart_account)
    }

    fn uninstall(e: &Env, context_rule: ContextRule, smart_account: Address) {
        uninstall(e, &context_rule, &smart_account)
    }
}

#[contractimpl]
impl PbCallCapContract {
    pub fn get_call_cap_data(e: Env, context_rule_id: u32, smart_account: Address) -> CallCapData {
        get_call_cap_data(&e, context_rule_id, &smart_account)
    }

    pub fn set_cap(e: Env, cap: i128, context_rule: ContextRule, smart_account: Address) {
        set_cap(&e, cap, &context_rule, &smart_account)
    }
}

#[cfg(test)]
mod test;
