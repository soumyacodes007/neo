//! # `pb_function_allowlist` — Parameterized Function Allowlist Policy
//!
//! Permits only an explicit set of function names on the rule's target contract
//! and denies all others. This fills the gap that OpenZeppelin context rules
//! scope per-contract but not per-function (Vol 02 §2.3.2).
//!
//! One deployed contract serves the whole ecosystem: storage is keyed
//! `(smart_account, context_rule_id)` (OZ convention) so allowlists never bleed
//! across accounts or rules (tenant isolation, EC-P04).
//!
//! Error range: **3300–3319** (no overlap with OZ policies).
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
pub struct PbAllowlistInstalled {
    #[topic]
    pub smart_account: Address,
    pub context_rule_id: u32,
    pub allowed_len: u32,
}

#[contractevent]
#[derive(Clone)]
pub struct PbAllowlistEnforced {
    #[topic]
    pub smart_account: Address,
    pub context_rule_id: u32,
    pub fn_name: Symbol,
}

#[contractevent]
#[derive(Clone)]
pub struct PbAllowlistChanged {
    #[topic]
    pub smart_account: Address,
    pub context_rule_id: u32,
    pub allowed_len: u32,
}

#[contractevent]
#[derive(Clone)]
pub struct PbAllowlistUninstalled {
    #[topic]
    pub smart_account: Address,
    pub context_rule_id: u32,
}

// ################## TYPES ##################

/// Installation parameters: the set of allowed function names.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct FunctionAllowlistParams {
    pub allowed: Vec<Symbol>,
}

/// Storage keys for allowlist data, keyed by `(smart_account, context_rule_id)`.
#[contracttype]
pub enum PbAllowlistStorageKey {
    AccountContext(Address, u32),
}

// ################## ERRORS ##################

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum PbAllowlistError {
    /// No allowlist policy is installed for this account/rule.
    SmartAccountNotInstalled = 3300,
    /// A policy is already installed for this account/rule.
    AlreadyInstalled = 3301,
    /// The provided allowlist is empty.
    EmptyAllowlist = 3302,
    /// The called function is not in the allowlist.
    FunctionNotAllowed = 3303,
    /// Only the `CallContract` context rule type is allowed.
    OnlyCallContractAllowed = 3304,
    /// The allowlist exceeds `MAX_ALLOWED`.
    TooManyFunctions = 3305,
}

// ################## CONSTANTS ##################

const DAY_IN_LEDGERS: u32 = 17280;
pub const ALLOWLIST_EXTEND_AMOUNT: u32 = 30 * DAY_IN_LEDGERS;
pub const ALLOWLIST_TTL_THRESHOLD: u32 = ALLOWLIST_EXTEND_AMOUNT - DAY_IN_LEDGERS;

/// Maximum number of allowed function names (bounds storage).
pub const MAX_ALLOWED: u32 = 32;

// ################## QUERY STATE ##################

/// Reads the stored allowlist, extending its TTL on read.
///
/// # Errors
/// * [`PbAllowlistError::SmartAccountNotInstalled`] - when not installed.
pub fn get_allowlist(e: &Env, context_rule_id: u32, smart_account: &Address) -> Vec<Symbol> {
    let key = PbAllowlistStorageKey::AccountContext(smart_account.clone(), context_rule_id);
    e.storage()
        .persistent()
        .get(&key)
        .inspect(|_| {
            e.storage().persistent().extend_ttl(&key, ALLOWLIST_TTL_THRESHOLD, ALLOWLIST_EXTEND_AMOUNT);
        })
        .unwrap_or_else(|| panic_with_error!(e, PbAllowlistError::SmartAccountNotInstalled))
}

// ################## CHANGE STATE ##################

/// Installs the allowlist for a context rule. Requires smart-account auth.
///
/// # Errors
/// * [`PbAllowlistError::OnlyCallContractAllowed`], [`PbAllowlistError::EmptyAllowlist`],
///   [`PbAllowlistError::TooManyFunctions`], [`PbAllowlistError::AlreadyInstalled`].
pub fn install(
    e: &Env,
    params: &FunctionAllowlistParams,
    context_rule: &ContextRule,
    smart_account: &Address,
) {
    smart_account.require_auth();

    if !matches!(context_rule.context_type, ContextRuleType::CallContract(_)) {
        panic_with_error!(e, PbAllowlistError::OnlyCallContractAllowed)
    }
    validate_allowed(e, &params.allowed);

    let key = PbAllowlistStorageKey::AccountContext(smart_account.clone(), context_rule.id);
    if e.storage().persistent().has(&key) {
        panic_with_error!(e, PbAllowlistError::AlreadyInstalled)
    }
    e.storage().persistent().set(&key, &params.allowed);

    PbAllowlistInstalled {
        smart_account: smart_account.clone(),
        context_rule_id: context_rule.id,
        allowed_len: params.allowed.len(),
    }
    .publish(e);
}

/// Enforces the allowlist: the called function must be in the set. Requires auth.
///
/// # Errors
/// * [`PbAllowlistError::FunctionNotAllowed`] - function not in the allowlist,
///   or the context is not a contract call (deny-by-default).
pub fn enforce(e: &Env, context: &Context, context_rule: &ContextRule, smart_account: &Address) {
    smart_account.require_auth();

    let allowed = get_allowlist(e, context_rule.id, smart_account);
    match context {
        Context::Contract(ContractContext { fn_name, .. }) => {
            if !contains(&allowed, fn_name) {
                panic_with_error!(e, PbAllowlistError::FunctionNotAllowed)
            }
            PbAllowlistEnforced {
                smart_account: smart_account.clone(),
                context_rule_id: context_rule.id,
                fn_name: fn_name.clone(),
            }
            .publish(e);
        }
        // Deny-by-default: create-contract or any non-contract-call context.
        _ => panic_with_error!(e, PbAllowlistError::FunctionNotAllowed),
    }
}

/// Replaces the allowlist. Requires auth. Errors mirror [`install`] validation.
pub fn set_allowed(e: &Env, allowed: &Vec<Symbol>, context_rule: &ContextRule, smart_account: &Address) {
    smart_account.require_auth();
    validate_allowed(e, allowed);
    // Ensure it exists (extends TTL / panics if not installed).
    let _ = get_allowlist(e, context_rule.id, smart_account);
    let key = PbAllowlistStorageKey::AccountContext(smart_account.clone(), context_rule.id);
    e.storage().persistent().set(&key, allowed);

    PbAllowlistChanged {
        smart_account: smart_account.clone(),
        context_rule_id: context_rule.id,
        allowed_len: allowed.len(),
    }
    .publish(e);
}

/// Uninstalls the allowlist. Idempotent — missing state does not panic (EC-P07).
pub fn uninstall(e: &Env, context_rule: &ContextRule, smart_account: &Address) {
    smart_account.require_auth();
    let key = PbAllowlistStorageKey::AccountContext(smart_account.clone(), context_rule.id);
    if e.storage().persistent().has(&key) {
        e.storage().persistent().remove(&key);
    }
    PbAllowlistUninstalled { smart_account: smart_account.clone(), context_rule_id: context_rule.id }.publish(e);
}

// ################## LOW-LEVEL HELPERS ##################

fn validate_allowed(e: &Env, allowed: &Vec<Symbol>) {
    if allowed.is_empty() {
        panic_with_error!(e, PbAllowlistError::EmptyAllowlist)
    }
    if allowed.len() > MAX_ALLOWED {
        panic_with_error!(e, PbAllowlistError::TooManyFunctions)
    }
}

fn contains(allowed: &Vec<Symbol>, needle: &Symbol) -> bool {
    allowed.iter().any(|s| &s == needle)
}

// ################## CONTRACT WRAPPER ##################

/// Deployable policy contract: one deployment, many accounts/rules.
#[contract]
pub struct PbFunctionAllowlistContract;

#[contractimpl]
impl Policy for PbFunctionAllowlistContract {
    type AccountParams = FunctionAllowlistParams;

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
impl PbFunctionAllowlistContract {
    /// Read the allowlist (for off-chain inspection / classification, Vol 04 A1.5).
    pub fn get_allowlist(e: Env, context_rule_id: u32, smart_account: Address) -> Vec<Symbol> {
        get_allowlist(&e, context_rule_id, &smart_account)
    }

    /// Replace the allowlist.
    pub fn set_allowed(e: Env, allowed: Vec<Symbol>, context_rule: ContextRule, smart_account: Address) {
        set_allowed(&e, &allowed, &context_rule, &smart_account)
    }
}

#[cfg(test)]
mod test;
