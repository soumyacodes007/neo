//! # `pb_arg_guard` — Parameterized Argument Predicate Policy
//!
//! Enforces per-function argument predicates with JSONPath-lite extraction and
//! ∀ semantics over vectors (Blend `requests[*]`, EC-S16). One installed instance
//! guards *all* arg predicates for a rule (packing, EC-S08). Functions not
//! covered by any rule are out of scope here — they are gated by the accompanying
//! `pb_function_allowlist` on the same rule (composition).
//!
//! Predicates are stored as concrete typed variants (not raw `Val`s, which do
//! not persist stably): `U32Eq/U32In` for enum discriminants (request_type),
//! `Range` for amounts, `AddrEq/AddrIn` for recipients/tokens. Unresolved paths
//! and empty ∀ fan-outs deny by default (EC-P08/S16).
//!
//! Error range: **3320–3339**.
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
pub struct PbArgGuardInstalled {
    #[topic]
    pub smart_account: Address,
    pub context_rule_id: u32,
    pub rules_len: u32,
}

#[contractevent]
#[derive(Clone)]
pub struct PbArgGuardEnforced {
    #[topic]
    pub smart_account: Address,
    pub context_rule_id: u32,
    pub fn_name: Symbol,
}

#[contractevent]
#[derive(Clone)]
pub struct PbArgGuardUninstalled {
    #[topic]
    pub smart_account: Address,
    pub context_rule_id: u32,
}

// ################## TYPES ##################

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum PathSeg {
    Field(Symbol),
    Index(u32),
    Wildcard,
}

/// A concrete, durably-storable argument predicate.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum Predicate {
    U32Eq(u32),
    U32In(Vec<u32>),
    Range(i128, i128),
    AddrEq(Address),
    AddrIn(Vec<Address>),
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct ArgRule {
    pub fn_name: Symbol,
    pub arg_index: u32,
    pub path: Vec<PathSeg>,
    pub pred: Predicate,
    /// When true the path yields a vector and EVERY element must satisfy `pred`.
    pub forall: bool,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct ArgGuardParams {
    pub rules: Vec<ArgRule>,
}

#[contracttype]
pub enum PbArgGuardStorageKey {
    AccountContext(Address, u32),
}

// ################## ERRORS ##################

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum PbArgGuardError {
    SmartAccountNotInstalled = 3320,
    AlreadyInstalled = 3321,
    EmptyRules = 3322,
    ArgIndexOutOfRange = 3323,
    ArgPathUnresolved = 3324,
    PredicateFailed = 3325,
    TypeMismatch = 3326,
    TooManyRules = 3327,
    OnlyCallContractAllowed = 3328,
}

// ################## CONSTANTS ##################

const DAY_IN_LEDGERS: u32 = 17280;
pub const ARG_GUARD_EXTEND_AMOUNT: u32 = 30 * DAY_IN_LEDGERS;
pub const ARG_GUARD_TTL_THRESHOLD: u32 = ARG_GUARD_EXTEND_AMOUNT - DAY_IN_LEDGERS;
pub const MAX_RULES: u32 = 32;

// ################## QUERY STATE ##################

pub fn get_arg_rules(e: &Env, context_rule_id: u32, smart_account: &Address) -> Vec<ArgRule> {
    let key = PbArgGuardStorageKey::AccountContext(smart_account.clone(), context_rule_id);
    e.storage()
        .persistent()
        .get(&key)
        .inspect(|_| {
            e.storage().persistent().extend_ttl(&key, ARG_GUARD_TTL_THRESHOLD, ARG_GUARD_EXTEND_AMOUNT);
        })
        .unwrap_or_else(|| panic_with_error!(e, PbArgGuardError::SmartAccountNotInstalled))
}

// ################## CHANGE STATE ##################

pub fn install(e: &Env, params: &ArgGuardParams, context_rule: &ContextRule, smart_account: &Address) {
    smart_account.require_auth();
    if !matches!(context_rule.context_type, ContextRuleType::CallContract(_)) {
        panic_with_error!(e, PbArgGuardError::OnlyCallContractAllowed)
    }
    if params.rules.is_empty() {
        panic_with_error!(e, PbArgGuardError::EmptyRules)
    }
    if params.rules.len() > MAX_RULES {
        panic_with_error!(e, PbArgGuardError::TooManyRules)
    }
    let key = PbArgGuardStorageKey::AccountContext(smart_account.clone(), context_rule.id);
    if e.storage().persistent().has(&key) {
        panic_with_error!(e, PbArgGuardError::AlreadyInstalled)
    }
    e.storage().persistent().set(&key, &params.rules);

    PbArgGuardInstalled {
        smart_account: smart_account.clone(),
        context_rule_id: context_rule.id,
        rules_len: params.rules.len(),
    }
    .publish(e);
}

pub fn enforce(e: &Env, context: &Context, context_rule: &ContextRule, smart_account: &Address) {
    smart_account.require_auth();

    let (fn_name, args) = match context {
        Context::Contract(ContractContext { fn_name, args, .. }) => (fn_name.clone(), args.clone()),
        // Non-contract context is out of scope for arg predicates.
        _ => return,
    };

    let rules = get_arg_rules(e, context_rule.id, smart_account);
    for rule in rules.iter() {
        if rule.fn_name != fn_name {
            continue; // out of scope for this rule
        }
        let root = match args.get(rule.arg_index) {
            Some(v) => v,
            None => panic_with_error!(e, PbArgGuardError::ArgIndexOutOfRange),
        };
        let resolved = resolve_from(e, root, &rule.path);
        if resolved.is_empty() {
            panic_with_error!(e, PbArgGuardError::ArgPathUnresolved)
        }
        if rule.forall {
            for v in resolved.iter() {
                apply(e, &v, &rule.pred);
            }
        } else {
            apply(e, &resolved.get(0).unwrap(), &rule.pred);
        }
    }

    PbArgGuardEnforced { smart_account: smart_account.clone(), context_rule_id: context_rule.id, fn_name }.publish(e);
}

pub fn uninstall(e: &Env, context_rule: &ContextRule, smart_account: &Address) {
    smart_account.require_auth();
    let key = PbArgGuardStorageKey::AccountContext(smart_account.clone(), context_rule.id);
    if e.storage().persistent().has(&key) {
        e.storage().persistent().remove(&key);
    }
    PbArgGuardUninstalled { smart_account: smart_account.clone(), context_rule_id: context_rule.id }.publish(e);
}

// ################## LOW-LEVEL HELPERS ##################

/// Apply a predicate to a resolved value; panics on failure (deny-by-default).
fn apply(e: &Env, v: &Val, pred: &Predicate) {
    match pred {
        Predicate::U32Eq(want) => {
            let got = u32_of(e, v);
            if got != *want {
                panic_with_error!(e, PbArgGuardError::PredicateFailed)
            }
        }
        Predicate::U32In(set) => {
            let got = u32_of(e, v);
            if !set.iter().any(|x| x == got) {
                panic_with_error!(e, PbArgGuardError::PredicateFailed)
            }
        }
        Predicate::Range(lo, hi) => {
            let got = i128_of(e, v);
            if got < *lo || got > *hi {
                panic_with_error!(e, PbArgGuardError::PredicateFailed)
            }
        }
        Predicate::AddrEq(want) => {
            let got = addr_of(e, v);
            if &got != want {
                panic_with_error!(e, PbArgGuardError::PredicateFailed)
            }
        }
        Predicate::AddrIn(set) => {
            let got = addr_of(e, v);
            if !set.iter().any(|a| a == got) {
                panic_with_error!(e, PbArgGuardError::PredicateFailed)
            }
        }
    }
}

fn u32_of(e: &Env, v: &Val) -> u32 {
    u32::try_from_val(e, v).unwrap_or_else(|_| panic_with_error!(e, PbArgGuardError::TypeMismatch))
}
fn i128_of(e: &Env, v: &Val) -> i128 {
    i128::try_from_val(e, v).unwrap_or_else(|_| panic_with_error!(e, PbArgGuardError::TypeMismatch))
}
fn addr_of(e: &Env, v: &Val) -> Address {
    Address::try_from_val(e, v).unwrap_or_else(|_| panic_with_error!(e, PbArgGuardError::TypeMismatch))
}

/// Walk a JSONPath-lite path from a root value (mirrors TS `resolvePath`).
fn resolve_from(e: &Env, root: Val, path: &Vec<PathSeg>) -> Vec<Val> {
    let mut current: Vec<Val> = Vec::new(e);
    current.push_back(root);
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

// ################## CONTRACT WRAPPER ##################

#[contract]
pub struct PbArgGuardContract;

#[contractimpl]
impl Policy for PbArgGuardContract {
    type AccountParams = ArgGuardParams;

    fn enforce(
        e: &Env,
        context: Context,
        _authenticated_signers: Vec<Signer>,
        context_rule: ContextRule,
        smart_account: Address,
    ) {
        enforce(e, &context, &context_rule, &smart_account)
    }

    fn install(e: &Env, install_params: Self::AccountParams, context_rule: ContextRule, smart_account: Address) {
        install(e, &install_params, &context_rule, &smart_account)
    }

    fn uninstall(e: &Env, context_rule: ContextRule, smart_account: Address) {
        uninstall(e, &context_rule, &smart_account)
    }
}

#[contractimpl]
impl PbArgGuardContract {
    pub fn get_arg_rules(e: Env, context_rule_id: u32, smart_account: Address) -> Vec<ArgRule> {
        get_arg_rules(&e, context_rule_id, &smart_account)
    }
}

#[cfg(test)]
mod test;
