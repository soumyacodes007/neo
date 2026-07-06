extern crate std;

use soroban_sdk::{
    auth::{Context, ContractContext},
    contract,
    testutils::{Address as _, Ledger},
    Address, Env, String as SorobanString, Symbol, Vec,
};
use stellar_accounts::smart_account::{ContextRule, ContextRuleType, Signer};

use crate::*;

#[contract]
struct MockContract;

fn signers(e: &Env) -> Vec<Signer> {
    let mut s = Vec::new(e);
    s.push_back(Signer::Delegated(Address::generate(e)));
    s
}

fn rule(e: &Env) -> ContextRule {
    ContextRule {
        id: 1,
        context_type: ContextRuleType::CallContract(Address::generate(e)),
        name: SorobanString::from_str(e, "rule"),
        signers: signers(e),
        signer_ids: Vec::new(e),
        policies: Vec::new(e),
        policy_ids: Vec::new(e),
        valid_until: None,
    }
}

fn ctx(e: &Env, fn_name: &str) -> Context {
    Context::Contract(ContractContext {
        contract: Address::generate(e),
        fn_name: Symbol::new(e, fn_name),
        args: Vec::new(e),
    })
}

fn params(max_calls: u32, period: u32, scope: Option<Symbol>) -> RateLimitParams {
    RateLimitParams { max_calls, period_ledgers: period, fn_scope: scope }
}

fn fixture(key: &str) -> std::string::String {
    let path = std::concat!(env!("CARGO_MANIFEST_DIR"), "/../../pb-install-params-fixtures.json");
    let content = std::fs::read_to_string(path).expect("fixtures file");
    let needle = std::format!("\"{key}\":");
    let after = &content[content.find(&needle).expect("key") + needle.len()..];
    let q1 = after.find('"').unwrap() + 1;
    let q2 = after[q1..].find('"').unwrap();
    after[q1..q1 + q2].into()
}

#[test]
fn parity_ts_encoded_install_params() {
    use soroban_sdk::xdr::{Limits, ReadXdr, ScVal};
    use soroban_sdk::{TryFromVal, Val};
    let e = Env::default();
    let scval = ScVal::from_xdr_base64(fixture("rate_limit"), Limits::none()).unwrap();
    let val = Val::try_from_val(&e, &scval).unwrap();
    let p = RateLimitParams::try_from_val(&e, &val).unwrap();
    assert_eq!(p.max_calls, 5);
    assert_eq!(p.period_ledgers, 100);
    assert_eq!(p.fn_scope, Some(Symbol::new(&e, "submit")));
}

#[test]
fn install_and_enforce_under_limit() {
    let e = Env::default();
    let a = e.register(MockContract, ());
    let sa = Address::generate(&e);
    e.mock_all_auths();
    let r = rule(&e);
    let s = signers(&e);
    e.as_contract(&a, || install(&e, &params(3, 100, None), &r, &sa));
    e.as_contract(&a, || enforce(&e, &ctx(&e, "claim"), &s, &r, &sa));
    e.as_contract(&a, || assert_eq!(get_rate_limit_data(&e, r.id, &sa).calls.len(), 1));
}

#[test]
#[should_panic(expected = "Error(Contract, #3362)")]
fn install_invalid_params_fails() {
    let e = Env::default();
    let a = e.register(MockContract, ());
    let sa = Address::generate(&e);
    e.mock_all_auths();
    e.as_contract(&a, || install(&e, &params(0, 100, None), &rule(&e), &sa));
}

#[test]
#[should_panic(expected = "Error(Contract, #3366)")]
fn install_noncallcontract_fails() {
    let e = Env::default();
    let a = e.register(MockContract, ());
    let sa = Address::generate(&e);
    e.mock_all_auths();
    let mut r = rule(&e);
    r.context_type = ContextRuleType::Default;
    e.as_contract(&a, || install(&e, &params(1, 100, None), &r, &sa));
}

#[test]
#[should_panic(expected = "Error(Contract, #3361)")]
fn double_install_fails() {
    let e = Env::default();
    let a = e.register(MockContract, ());
    let sa = Address::generate(&e);
    e.mock_all_auths();
    let r = rule(&e);
    e.as_contract(&a, || install(&e, &params(1, 100, None), &r, &sa));
    e.as_contract(&a, || install(&e, &params(1, 100, None), &r, &sa));
}

#[test]
#[should_panic(expected = "Error(Contract, #3363)")]
fn at_limit_then_exceeds() {
    let e = Env::default();
    let a = e.register(MockContract, ());
    let sa = Address::generate(&e);
    e.mock_all_auths();
    let r = rule(&e);
    let s = signers(&e);
    e.as_contract(&a, || install(&e, &params(2, 100, None), &r, &sa));
    e.ledger().set_sequence_number(10);
    e.as_contract(&a, || enforce(&e, &ctx(&e, "claim"), &s, &r, &sa));
    e.as_contract(&a, || enforce(&e, &ctx(&e, "claim"), &s, &r, &sa));
    // Third call in the same window exceeds max_calls=2.
    e.as_contract(&a, || enforce(&e, &ctx(&e, "claim"), &s, &r, &sa));
}

#[test]
fn window_slides_allows_more() {
    let e = Env::default();
    let a = e.register(MockContract, ());
    let sa = Address::generate(&e);
    e.mock_all_auths();
    let r = rule(&e);
    let s = signers(&e);
    e.as_contract(&a, || install(&e, &params(1, 100, None), &r, &sa));
    e.ledger().set_sequence_number(10);
    e.as_contract(&a, || enforce(&e, &ctx(&e, "claim"), &s, &r, &sa));
    // Advance beyond the window: the old call is evicted, so a new one is allowed.
    e.ledger().set_sequence_number(200);
    e.as_contract(&a, || enforce(&e, &ctx(&e, "claim"), &s, &r, &sa));
    e.as_contract(&a, || assert_eq!(get_rate_limit_data(&e, r.id, &sa).calls.len(), 1));
}

#[test]
fn out_of_scope_function_unaffected() {
    let e = Env::default();
    let a = e.register(MockContract, ());
    let sa = Address::generate(&e);
    e.mock_all_auths();
    let r = rule(&e);
    let s = signers(&e);
    e.as_contract(&a, || install(&e, &params(1, 100, Some(Symbol::new(&e, "submit"))), &r, &sa));
    // "claim" is out of scope → passes and records nothing, even repeatedly.
    e.as_contract(&a, || enforce(&e, &ctx(&e, "claim"), &s, &r, &sa));
    e.as_contract(&a, || enforce(&e, &ctx(&e, "claim"), &s, &r, &sa));
    e.as_contract(&a, || assert_eq!(get_rate_limit_data(&e, r.id, &sa).calls.len(), 0));
}

#[test]
#[should_panic(expected = "Error(Contract, #3365)")]
fn enforce_no_signers_fails() {
    let e = Env::default();
    let a = e.register(MockContract, ());
    let sa = Address::generate(&e);
    e.mock_all_auths();
    let r = rule(&e);
    let empty: Vec<Signer> = Vec::new(&e);
    e.as_contract(&a, || install(&e, &params(1, 100, None), &r, &sa));
    e.as_contract(&a, || enforce(&e, &ctx(&e, "claim"), &empty, &r, &sa));
}

#[test]
fn uninstall_missing_is_idempotent() {
    let e = Env::default();
    let a = e.register(MockContract, ());
    let sa = Address::generate(&e);
    e.mock_all_auths();
    e.as_contract(&a, || uninstall(&e, &rule(&e), &sa));
}
