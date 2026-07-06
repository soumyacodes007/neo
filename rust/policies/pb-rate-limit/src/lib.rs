//! # `pb_rate_limit` — Parameterized Rate-Limit Policy
//!
//! Caps the number of authorized calls (optionally scoped to one function) in a
//! rolling ledger window. Throttles an agent independent of amount, and pairs
//! with `pb_call_cap` to bound the 1000-entry DoS surface (EC-P02).
//!
//! Threshold-free by construction, so the signer-drift hazard (EC-P01) does not
//! apply. Storage keyed `(smart_account, context_rule_id)` (EC-P04).
//!
//! Error range: **3360–3379**.
#![no_std]

use soroban_sdk::{
    auth::{Context, ContractContext},
    contract, contracterror, contractevent, contractimpl, contracttype, panic_with_error, Address,
    Env, Symbol, Vec,
};
use stellar_accounts::{
    policies::Policy,
    smart_account::{ContextRule, ContextRuleType, Signer},
};

// ################## EVENTS ##################

#[contractevent]
#[derive(Clone)]
pub struct PbRateLimitInstalled {
    #[topic]
    pub smart_account: Address,
    pub context_rule_id: u32,
    pub max_calls: u32,
    pub period_ledgers: u32,
}

#[contractevent]
#[derive(Clone)]
pub struct PbRateLimitEnforced {
    #[topic]
    pub smart_account: Address,
    pub context_rule_id: u32,
    pub calls_in_window: u32,
}

#[contractevent]
#[derive(Clone)]
pub struct PbRateLimitUninstalled {
    #[topic]
    pub smart_account: Address,
    pub context_rule_id: u32,
}

// ################## TYPES ##################

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct RateLimitParams {
    pub max_calls: u32,
    pub period_ledgers: u32,
    pub fn_scope: Option<Symbol>,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct RateLimitData {
    pub params: RateLimitParams,
    /// Ledger sequences of recent calls in the window.
    pub calls: Vec<u32>,
}

#[contracttype]
pub enum PbRateLimitStorageKey {
    AccountContext(Address, u32),
}

// ################## ERRORS ##################

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum PbRateLimitError {
    SmartAccountNotInstalled = 3360,
    AlreadyInstalled = 3361,
    InvalidParams = 3362,
    RateLimitExceeded = 3363,
    HistoryCapacityExceeded = 3364,
    NotAllowed = 3365,
    OnlyCallContractAllowed = 3366,
}

// ################## CONSTANTS ##################

const DAY_IN_LEDGERS: u32 = 17280;
pub const RATE_LIMIT_EXTEND_AMOUNT: u32 = 30 * DAY_IN_LEDGERS;
pub const RATE_LIMIT_TTL_THRESHOLD: u32 = RATE_LIMIT_EXTEND_AMOUNT - DAY_IN_LEDGERS;
pub const MAX_CALL_ENTRIES: u32 = 1000;

// ################## QUERY STATE ##################

pub fn get_rate_limit_data(e: &Env, context_rule_id: u32, smart_account: &Address) -> RateLimitData {
    let key = PbRateLimitStorageKey::AccountContext(smart_account.clone(), context_rule_id);
    e.storage()
        .persistent()
        .get(&key)
        .inspect(|_| {
            e.storage().persistent().extend_ttl(&key, RATE_LIMIT_TTL_THRESHOLD, RATE_LIMIT_EXTEND_AMOUNT);
        })
        .unwrap_or_else(|| panic_with_error!(e, PbRateLimitError::SmartAccountNotInstalled))
}

// ################## CHANGE STATE ##################

pub fn install(e: &Env, params: &RateLimitParams, context_rule: &ContextRule, smart_account: &Address) {
    smart_account.require_auth();

    if !matches!(context_rule.context_type, ContextRuleType::CallContract(_)) {
        panic_with_error!(e, PbRateLimitError::OnlyCallContractAllowed)
    }
    if params.max_calls == 0 || params.period_ledgers == 0 {
        panic_with_error!(e, PbRateLimitError::InvalidParams)
    }
    let key = PbRateLimitStorageKey::AccountContext(smart_account.clone(), context_rule.id);
    if e.storage().persistent().has(&key) {
        panic_with_error!(e, PbRateLimitError::AlreadyInstalled)
    }
    let data = RateLimitData { params: params.clone(), calls: Vec::new(e) };
    e.storage().persistent().set(&key, &data);

    PbRateLimitInstalled {
        smart_account: smart_account.clone(),
        context_rule_id: context_rule.id,
        max_calls: params.max_calls,
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
        panic_with_error!(e, PbRateLimitError::NotAllowed)
    }

    let fn_name = match context {
        Context::Contract(ContractContext { fn_name, .. }) => fn_name.clone(),
        _ => panic_with_error!(e, PbRateLimitError::NotAllowed),
    };

    let key = PbRateLimitStorageKey::AccountContext(smart_account.clone(), context_rule.id);
    let mut data = get_rate_limit_data(e, context_rule.id, smart_account);

    // Out-of-scope function: pass without recording.
    if let Some(scope) = &data.params.fn_scope {
        if scope != &fn_name {
            return;
        }
    }

    let current = e.ledger().sequence();
    evict_old(&mut data.calls, current, data.params.period_ledgers);

    if data.calls.len() >= data.params.max_calls {
        panic_with_error!(e, PbRateLimitError::RateLimitExceeded)
    }
    if data.calls.len() >= MAX_CALL_ENTRIES {
        panic_with_error!(e, PbRateLimitError::HistoryCapacityExceeded)
    }

    data.calls.push_back(current);
    let calls_in_window = data.calls.len();
    e.storage().persistent().set(&key, &data);

    PbRateLimitEnforced { smart_account: smart_account.clone(), context_rule_id: context_rule.id, calls_in_window }.publish(e);
}

pub fn uninstall(e: &Env, context_rule: &ContextRule, smart_account: &Address) {
    smart_account.require_auth();
    let key = PbRateLimitStorageKey::AccountContext(smart_account.clone(), context_rule.id);
    if e.storage().persistent().has(&key) {
        e.storage().persistent().remove(&key);
    }
    PbRateLimitUninstalled { smart_account: smart_account.clone(), context_rule_id: context_rule.id }.publish(e);
}

// ################## LOW-LEVEL HELPERS ##################

/// Remove call entries at or before `current - period` (exclusive window start).
fn evict_old(calls: &mut Vec<u32>, current: u32, period: u32) {
    let cutoff = current.saturating_sub(period);
    let mut kept = Vec::new(calls.env());
    for c in calls.iter() {
        if c > cutoff {
            kept.push_back(c);
        }
    }
    *calls = kept;
}

// ################## CONTRACT WRAPPER ##################

#[contract]
pub struct PbRateLimitContract;

#[contractimpl]
impl Policy for PbRateLimitContract {
    type AccountParams = RateLimitParams;

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
impl PbRateLimitContract {
    pub fn get_rate_limit_data(e: Env, context_rule_id: u32, smart_account: Address) -> RateLimitData {
        get_rate_limit_data(&e, context_rule_id, &smart_account)
    }
}

#[cfg(test)]
mod test;
