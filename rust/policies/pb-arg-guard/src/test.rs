extern crate std;

use soroban_sdk::{
    auth::{Context, ContractContext},
    contract,
    testutils::Address as _,
    Address, Env, IntoVal, Map, String as SorobanString, Symbol, Val, Vec,
};
use stellar_accounts::smart_account::{ContextRule, ContextRuleType, Signer};

use crate::*;

#[contract]
struct MockContract;

fn rule(e: &Env) -> ContextRule {
    let mut signers = Vec::new(e);
    signers.push_back(Signer::Delegated(Address::generate(e)));
    ContextRule {
        id: 1,
        context_type: ContextRuleType::CallContract(Address::generate(e)),
        name: SorobanString::from_str(e, "rule"),
        signers,
        signer_ids: Vec::new(e),
        policies: Vec::new(e),
        policy_ids: Vec::new(e),
        valid_until: None,
    }
}

fn params(e: &Env, rules: &[ArgRule]) -> ArgGuardParams {
    let mut v = Vec::new(e);
    for r in rules {
        v.push_back(r.clone());
    }
    ArgGuardParams { rules: v }
}

fn ctx(e: &Env, fn_name: &str, args: Vec<Val>) -> Context {
    Context::Contract(ContractContext { contract: Address::generate(e), fn_name: Symbol::new(e, fn_name), args })
}

fn path(e: &Env, segs: &[PathSeg]) -> Vec<PathSeg> {
    let mut p = Vec::new(e);
    for s in segs {
        p.push_back(s.clone());
    }
    p
}

fn install_rules(e: &Env, a: &Address, sa: &Address, r: &ContextRule, rules: &[ArgRule]) {
    e.as_contract(a, || install(e, &params(e, rules), r, sa));
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
    use soroban_sdk::xdr::{Limits, ScVal, WriteXdr};
    use soroban_sdk::{IntoVal, TryFromVal, Val};
    let e = Env::default();

    // Construct the expected params in Rust and serialize to XDR.
    let mut set = Vec::new(&e);
    set.push_back(0u32);
    set.push_back(1u32);
    let mut p = Vec::new(&e);
    p.push_back(PathSeg::Wildcard);
    p.push_back(PathSeg::Field(Symbol::new(&e, "request_type")));
    let mut rules = Vec::new(&e);
    rules.push_back(ArgRule { fn_name: Symbol::new(&e, "submit"), arg_index: 0, path: p, pred: Predicate::U32In(set), forall: true });
    let expected = ArgGuardParams { rules };
    let expected_val: Val = expected.into_val(&e);
    let expected_scval = ScVal::try_from_val(&e, &expected_val).unwrap();
    let expected_b64 = expected_scval.to_xdr_base64(Limits::none()).unwrap();

    std::println!("RUST : {expected_b64}");
    std::println!("TS   : {}", fixture("arg_guard"));
    assert_eq!(expected_b64, fixture("arg_guard"), "TS-encoded arg_guard params differ from Rust");
}

// --- install battery ---

#[test]
fn install_success() {
    let e = Env::default();
    let a = e.register(MockContract, ());
    let sa = Address::generate(&e);
    e.mock_all_auths();
    let r = rule(&e);
    let arg = ArgRule {
        fn_name: Symbol::new(&e, "transfer"),
        arg_index: 2,
        path: Vec::new(&e),
        pred: Predicate::Range(0, 1000),
        forall: false,
    };
    install_rules(&e, &a, &sa, &r, &[arg]);
    e.as_contract(&a, || assert_eq!(get_arg_rules(&e, r.id, &sa).len(), 1));
}

#[test]
#[should_panic(expected = "Error(Contract, #3322)")]
fn install_empty_fails() {
    let e = Env::default();
    let a = e.register(MockContract, ());
    let sa = Address::generate(&e);
    e.mock_all_auths();
    install_rules(&e, &a, &sa, &rule(&e), &[]);
}

#[test]
#[should_panic(expected = "Error(Contract, #3328)")]
fn install_noncallcontract_fails() {
    let e = Env::default();
    let a = e.register(MockContract, ());
    let sa = Address::generate(&e);
    e.mock_all_auths();
    let mut r = rule(&e);
    r.context_type = ContextRuleType::Default;
    let arg = ArgRule { fn_name: Symbol::new(&e, "t"), arg_index: 0, path: Vec::new(&e), pred: Predicate::U32Eq(1), forall: false };
    install_rules(&e, &a, &sa, &r, &[arg]);
}

#[test]
#[should_panic(expected = "Error(Contract, #3321)")]
fn double_install_fails() {
    let e = Env::default();
    let a = e.register(MockContract, ());
    let sa = Address::generate(&e);
    e.mock_all_auths();
    let r = rule(&e);
    let arg = ArgRule { fn_name: Symbol::new(&e, "t"), arg_index: 0, path: Vec::new(&e), pred: Predicate::U32Eq(1), forall: false };
    install_rules(&e, &a, &sa, &r, core::slice::from_ref(&arg));
    install_rules(&e, &a, &sa, &r, &[arg]);
}

// --- predicates ---

#[test]
fn range_boundaries() {
    let e = Env::default();
    let a = e.register(MockContract, ());
    let sa = Address::generate(&e);
    e.mock_all_auths();
    let r = rule(&e);
    let arg = ArgRule { fn_name: Symbol::new(&e, "transfer"), arg_index: 2, path: Vec::new(&e), pred: Predicate::Range(0, 1000), forall: false };
    install_rules(&e, &a, &sa, &r, &[arg]);
    let mk = |amount: i128| {
        let mut args: Vec<Val> = Vec::new(&e);
        args.push_back(Address::generate(&e).into_val(&e));
        args.push_back(Address::generate(&e).into_val(&e));
        args.push_back(amount.into_val(&e));
        args
    };
    // min and max inclusive pass.
    e.as_contract(&a, || enforce(&e, &ctx(&e, "transfer", mk(0)), &r, &sa));
    e.as_contract(&a, || enforce(&e, &ctx(&e, "transfer", mk(1000)), &r, &sa));
}

#[test]
#[should_panic(expected = "Error(Contract, #3325)")]
fn range_over_max_fails() {
    let e = Env::default();
    let a = e.register(MockContract, ());
    let sa = Address::generate(&e);
    e.mock_all_auths();
    let r = rule(&e);
    let arg = ArgRule { fn_name: Symbol::new(&e, "transfer"), arg_index: 2, path: Vec::new(&e), pred: Predicate::Range(0, 1000), forall: false };
    install_rules(&e, &a, &sa, &r, &[arg]);
    let mut args: Vec<Val> = Vec::new(&e);
    args.push_back(Address::generate(&e).into_val(&e));
    args.push_back(Address::generate(&e).into_val(&e));
    args.push_back(1001i128.into_val(&e));
    e.as_contract(&a, || enforce(&e, &ctx(&e, "transfer", args), &r, &sa));
}

#[test]
fn addr_eq_recipient() {
    let e = Env::default();
    let a = e.register(MockContract, ());
    let sa = Address::generate(&e);
    e.mock_all_auths();
    let r = rule(&e);
    let dest = Address::generate(&e);
    let arg = ArgRule { fn_name: Symbol::new(&e, "transfer"), arg_index: 1, path: Vec::new(&e), pred: Predicate::AddrEq(dest.clone()), forall: false };
    install_rules(&e, &a, &sa, &r, &[arg]);
    let mut args: Vec<Val> = Vec::new(&e);
    args.push_back(Address::generate(&e).into_val(&e));
    args.push_back(dest.into_val(&e));
    args.push_back(5i128.into_val(&e));
    e.as_contract(&a, || enforce(&e, &ctx(&e, "transfer", args), &r, &sa));
}

// --- ∀ over Blend-style requests[*].request_type ∈ {0,1} ---

fn submit_args(e: &Env, request_types: &[u32]) -> Vec<Val> {
    let mut requests: Vec<Val> = Vec::new(e);
    for rt in request_types {
        let mut req: Map<Symbol, Val> = Map::new(e);
        req.set(Symbol::new(e, "request_type"), (*rt).into_val(e));
        requests.push_back(req.to_val());
    }
    let mut args: Vec<Val> = Vec::new(e);
    args.push_back(requests.to_val());
    args
}

fn forall_rule(e: &Env) -> ArgRule {
    let mut set = Vec::new(e);
    set.push_back(0u32);
    set.push_back(1u32);
    ArgRule {
        fn_name: Symbol::new(e, "submit"),
        arg_index: 0,
        path: path(e, &[PathSeg::Wildcard, PathSeg::Field(Symbol::new(e, "request_type"))]),
        pred: Predicate::U32In(set),
        forall: true,
    }
}

#[test]
fn forall_all_pass() {
    let e = Env::default();
    let a = e.register(MockContract, ());
    let sa = Address::generate(&e);
    e.mock_all_auths();
    let r = rule(&e);
    install_rules(&e, &a, &sa, &r, &[forall_rule(&e)]);
    e.as_contract(&a, || enforce(&e, &ctx(&e, "submit", submit_args(&e, &[0, 1, 0])), &r, &sa));
}

#[test]
#[should_panic(expected = "Error(Contract, #3325)")]
fn forall_one_fails() {
    let e = Env::default();
    let a = e.register(MockContract, ());
    let sa = Address::generate(&e);
    e.mock_all_auths();
    let r = rule(&e);
    install_rules(&e, &a, &sa, &r, &[forall_rule(&e)]);
    // request_type 5 is not in {0,1}.
    e.as_contract(&a, || enforce(&e, &ctx(&e, "submit", submit_args(&e, &[0, 5])), &r, &sa));
}

#[test]
#[should_panic(expected = "Error(Contract, #3324)")]
fn forall_empty_denies() {
    let e = Env::default();
    let a = e.register(MockContract, ());
    let sa = Address::generate(&e);
    e.mock_all_auths();
    let r = rule(&e);
    install_rules(&e, &a, &sa, &r, &[forall_rule(&e)]);
    // Empty requests vector ⇒ empty fan-out ⇒ deny (fail-closed).
    e.as_contract(&a, || enforce(&e, &ctx(&e, "submit", submit_args(&e, &[])), &r, &sa));
}

#[test]
#[should_panic(expected = "Error(Contract, #3323)")]
fn missing_index_denies() {
    let e = Env::default();
    let a = e.register(MockContract, ());
    let sa = Address::generate(&e);
    e.mock_all_auths();
    let r = rule(&e);
    let arg = ArgRule { fn_name: Symbol::new(&e, "transfer"), arg_index: 9, path: Vec::new(&e), pred: Predicate::Range(0, 10), forall: false };
    install_rules(&e, &a, &sa, &r, &[arg]);
    let args: Vec<Val> = Vec::new(&e);
    e.as_contract(&a, || enforce(&e, &ctx(&e, "transfer", args), &r, &sa));
}

#[test]
#[should_panic(expected = "Error(Contract, #3326)")]
fn wrong_type_denies() {
    let e = Env::default();
    let a = e.register(MockContract, ());
    let sa = Address::generate(&e);
    e.mock_all_auths();
    let r = rule(&e);
    // Predicate expects u32 but arg[0] is an Address.
    let arg = ArgRule { fn_name: Symbol::new(&e, "t"), arg_index: 0, path: Vec::new(&e), pred: Predicate::U32Eq(1), forall: false };
    install_rules(&e, &a, &sa, &r, &[arg]);
    let mut args: Vec<Val> = Vec::new(&e);
    args.push_back(Address::generate(&e).into_val(&e));
    e.as_contract(&a, || enforce(&e, &ctx(&e, "t", args), &r, &sa));
}

#[test]
fn out_of_scope_function_passes() {
    let e = Env::default();
    let a = e.register(MockContract, ());
    let sa = Address::generate(&e);
    e.mock_all_auths();
    let r = rule(&e);
    let arg = ArgRule { fn_name: Symbol::new(&e, "transfer"), arg_index: 2, path: Vec::new(&e), pred: Predicate::Range(0, 10), forall: false };
    install_rules(&e, &a, &sa, &r, &[arg]);
    // "claim" has no matching rule ⇒ arg_guard passes it (allowlist gates functions).
    e.as_contract(&a, || enforce(&e, &ctx(&e, "claim", Vec::new(&e)), &r, &sa));
}

#[test]
fn uninstall_missing_is_idempotent() {
    let e = Env::default();
    let a = e.register(MockContract, ());
    let sa = Address::generate(&e);
    e.mock_all_auths();
    e.as_contract(&a, || uninstall(&e, &rule(&e), &sa));
}
