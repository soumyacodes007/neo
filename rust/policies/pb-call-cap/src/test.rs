extern crate std;

use soroban_sdk::{
    auth::{Context, ContractContext},
    contract,
    testutils::{Address as _, Ledger},
    Address, Env, IntoVal, Map, String as SorobanString, Symbol, Val, Vec,
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

fn seg_index(e: &Env, i: u32) -> Vec<PathSeg> {
    let mut p = Vec::new(e);
    p.push_back(PathSeg::Index(i));
    p
}

/// A `transfer(from,to,amount)` context; amount at args[2].
fn transfer_ctx(e: &Env, amount: i128) -> Context {
    let mut args: Vec<Val> = Vec::new(e);
    args.push_back(Address::generate(e).into_val(e));
    args.push_back(Address::generate(e).into_val(e));
    args.push_back(amount.into_val(e));
    Context::Contract(ContractContext { contract: Address::generate(e), fn_name: Symbol::new(e, "transfer"), args })
}

fn transfer_params(e: &Env, cap: i128) -> CallCapParams {
    CallCapParams {
        cap,
        period_ledgers: 100,
        fn_name: Symbol::new(e, "transfer"),
        amount_path: seg_index(e, 2),
        token_filter_path: Vec::new(e),
        token_filter_token: None,
    }
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
    use soroban_sdk::{IntoVal, String as SorobanString, TryFromVal, Val};
    let e = Env::default();
    let mk_path = |segs: &[PathSeg]| {
        let mut v = Vec::new(&e);
        for s in segs {
            v.push_back(s.clone());
        }
        v
    };
    let usdc = Address::from_string(&SorobanString::from_str(&e, &fixture("usdc")));
    let expected = CallCapParams {
        cap: 500,
        period_ledgers: 100,
        fn_name: Symbol::new(&e, "submit"),
        amount_path: mk_path(&[PathSeg::Index(0), PathSeg::Wildcard, PathSeg::Field(Symbol::new(&e, "amount"))]),
        token_filter_path: mk_path(&[PathSeg::Index(0), PathSeg::Wildcard, PathSeg::Field(Symbol::new(&e, "token"))]),
        token_filter_token: Some(usdc),
    };
    let val: Val = expected.into_val(&e);
    let scval = ScVal::try_from_val(&e, &val).unwrap();
    std::println!("RUST : {}", scval.to_xdr_base64(Limits::none()).unwrap());
    std::println!("TS   : {}", fixture("call_cap"));
    assert_eq!(scval.to_xdr_base64(Limits::none()).unwrap(), fixture("call_cap"));
}

#[test]
fn enforce_under_and_exact_cap() {
    let e = Env::default();
    let a = e.register(MockContract, ());
    let sa = Address::generate(&e);
    e.mock_all_auths();
    let r = rule(&e);
    let s = signers(&e);
    e.ledger().set_sequence_number(1000);
    e.as_contract(&a, || install(&e, &transfer_params(&e, 1000), &r, &sa));
    e.as_contract(&a, || enforce(&e, &transfer_ctx(&e, 500), &s, &r, &sa));
    // Exactly reaching the cap passes.
    e.as_contract(&a, || enforce(&e, &transfer_ctx(&e, 500), &s, &r, &sa));
    e.as_contract(&a, || assert_eq!(get_call_cap_data(&e, r.id, &sa).cached_total, 1000));
}

#[test]
#[should_panic(expected = "Error(Contract, #3344)")]
fn enforce_over_cap_fails() {
    let e = Env::default();
    let a = e.register(MockContract, ());
    let sa = Address::generate(&e);
    e.mock_all_auths();
    let r = rule(&e);
    let s = signers(&e);
    e.ledger().set_sequence_number(1000);
    e.as_contract(&a, || install(&e, &transfer_params(&e, 1000), &r, &sa));
    e.as_contract(&a, || enforce(&e, &transfer_ctx(&e, 600), &s, &r, &sa));
    e.as_contract(&a, || enforce(&e, &transfer_ctx(&e, 500), &s, &r, &sa));
}

#[test]
#[should_panic(expected = "Error(Contract, #3346)")]
fn enforce_negative_fails() {
    let e = Env::default();
    let a = e.register(MockContract, ());
    let sa = Address::generate(&e);
    e.mock_all_auths();
    let r = rule(&e);
    let s = signers(&e);
    e.as_contract(&a, || install(&e, &transfer_params(&e, 1000), &r, &sa));
    e.as_contract(&a, || enforce(&e, &transfer_ctx(&e, -1), &s, &r, &sa));
}

#[test]
fn enforce_zero_passes_no_record() {
    let e = Env::default();
    let a = e.register(MockContract, ());
    let sa = Address::generate(&e);
    e.mock_all_auths();
    let r = rule(&e);
    let s = signers(&e);
    e.as_contract(&a, || install(&e, &transfer_params(&e, 1000), &r, &sa));
    e.as_contract(&a, || enforce(&e, &transfer_ctx(&e, 0), &s, &r, &sa));
    e.as_contract(&a, || assert_eq!(get_call_cap_data(&e, r.id, &sa).history.len(), 0));
}

#[test]
fn window_evicts_old_spend() {
    let e = Env::default();
    let a = e.register(MockContract, ());
    let sa = Address::generate(&e);
    e.mock_all_auths();
    let r = rule(&e);
    let s = signers(&e);
    e.as_contract(&a, || install(&e, &transfer_params(&e, 1000), &r, &sa));
    e.ledger().set_sequence_number(10);
    e.as_contract(&a, || enforce(&e, &transfer_ctx(&e, 900), &s, &r, &sa));
    // Advance past the window: prior 900 is evicted, so a fresh 900 fits.
    e.ledger().set_sequence_number(200);
    e.as_contract(&a, || enforce(&e, &transfer_ctx(&e, 900), &s, &r, &sa));
    e.as_contract(&a, || assert_eq!(get_call_cap_data(&e, r.id, &sa).cached_total, 900));
}

#[test]
#[should_panic(expected = "Error(Contract, #3347)")]
fn unresolved_path_denies() {
    let e = Env::default();
    let a = e.register(MockContract, ());
    let sa = Address::generate(&e);
    e.mock_all_auths();
    let r = rule(&e);
    let s = signers(&e);
    // Amount path points at args[9], which does not exist.
    let params = CallCapParams {
        cap: 1000,
        period_ledgers: 100,
        fn_name: Symbol::new(&e, "transfer"),
        amount_path: seg_index(&e, 9),
        token_filter_path: Vec::new(&e),
        token_filter_token: None,
    };
    e.as_contract(&a, || install(&e, &params, &r, &sa));
    e.as_contract(&a, || enforce(&e, &transfer_ctx(&e, 500), &s, &r, &sa));
}

#[test]
fn out_of_scope_fn_passes() {
    let e = Env::default();
    let a = e.register(MockContract, ());
    let sa = Address::generate(&e);
    e.mock_all_auths();
    let r = rule(&e);
    let s = signers(&e);
    e.as_contract(&a, || install(&e, &transfer_params(&e, 1000), &r, &sa));
    // A "claim" call is not the metered function → passes, records nothing.
    let claim = Context::Contract(ContractContext {
        contract: Address::generate(&e),
        fn_name: Symbol::new(&e, "claim"),
        args: Vec::new(&e),
    });
    e.as_contract(&a, || enforce(&e, &claim, &s, &r, &sa));
    e.as_contract(&a, || assert_eq!(get_call_cap_data(&e, r.id, &sa).history.len(), 0));
}

// --- Blend-style: submit(requests: Vec<{amount, token}>) with a token filter ---

fn submit_ctx(e: &Env, entries: &[(i128, &Address)]) -> Context {
    let mut requests: Vec<Val> = Vec::new(e);
    for (amount, token) in entries {
        let mut req: Map<Symbol, Val> = Map::new(e);
        req.set(Symbol::new(e, "amount"), (*amount).into_val(e));
        req.set(Symbol::new(e, "token"), (*token).clone().into_val(e));
        requests.push_back(req.to_val());
    }
    let mut args: Vec<Val> = Vec::new(e);
    args.push_back(requests.to_val());
    Context::Contract(ContractContext { contract: Address::generate(e), fn_name: Symbol::new(e, "submit"), args })
}

fn submit_params(e: &Env, cap: i128, usdc: &Address) -> CallCapParams {
    let amount_path = {
        let mut p = Vec::new(e);
        p.push_back(PathSeg::Index(0));
        p.push_back(PathSeg::Wildcard);
        p.push_back(PathSeg::Field(Symbol::new(e, "amount")));
        p
    };
    let token_path = {
        let mut p = Vec::new(e);
        p.push_back(PathSeg::Index(0));
        p.push_back(PathSeg::Wildcard);
        p.push_back(PathSeg::Field(Symbol::new(e, "token")));
        p
    };
    CallCapParams {
        cap,
        period_ledgers: 100,
        fn_name: Symbol::new(e, "submit"),
        amount_path,
        token_filter_path: token_path,
        token_filter_token: Some(usdc.clone()),
    }
}

#[test]
fn token_filter_counts_only_matching_asset() {
    let e = Env::default();
    let a = e.register(MockContract, ());
    let sa = Address::generate(&e);
    e.mock_all_auths();
    let r = rule(&e);
    let s = signers(&e);
    let usdc = Address::generate(&e);
    let other = Address::generate(&e);
    // Cap 150: 100 USDC + 999 OTHER. Only USDC counts ⇒ 100 ≤ 150 passes.
    e.as_contract(&a, || install(&e, &submit_params(&e, 150, &usdc), &r, &sa));
    e.as_contract(&a, || enforce(&e, &submit_ctx(&e, &[(100, &usdc), (999, &other)]), &s, &r, &sa));
    e.as_contract(&a, || assert_eq!(get_call_cap_data(&e, r.id, &sa).cached_total, 100));
}

#[test]
#[should_panic(expected = "Error(Contract, #3344)")]
fn forall_sum_exceeds_cap() {
    let e = Env::default();
    let a = e.register(MockContract, ());
    let sa = Address::generate(&e);
    e.mock_all_auths();
    let r = rule(&e);
    let s = signers(&e);
    let usdc = Address::generate(&e);
    // Two USDC elements 100+100=200 > cap 150.
    e.as_contract(&a, || install(&e, &submit_params(&e, 150, &usdc), &r, &sa));
    e.as_contract(&a, || enforce(&e, &submit_ctx(&e, &[(100, &usdc), (100, &usdc)]), &s, &r, &sa));
}

#[test]
#[should_panic(expected = "Error(Contract, #3342)")]
fn install_invalid_cap_fails() {
    let e = Env::default();
    let a = e.register(MockContract, ());
    let sa = Address::generate(&e);
    e.mock_all_auths();
    e.as_contract(&a, || install(&e, &transfer_params(&e, 0), &rule(&e), &sa));
}

#[test]
#[should_panic(expected = "Error(Contract, #3341)")]
fn double_install_fails() {
    let e = Env::default();
    let a = e.register(MockContract, ());
    let sa = Address::generate(&e);
    e.mock_all_auths();
    let r = rule(&e);
    e.as_contract(&a, || install(&e, &transfer_params(&e, 1000), &r, &sa));
    e.as_contract(&a, || install(&e, &transfer_params(&e, 1000), &r, &sa));
}

#[test]
fn set_cap_replaces_limit() {
    let e = Env::default();
    let a = e.register(MockContract, ());
    let sa = Address::generate(&e);
    e.mock_all_auths();
    let r = rule(&e);
    let s = signers(&e);
    e.ledger().set_sequence_number(1000);
    e.as_contract(&a, || install(&e, &transfer_params(&e, 100), &r, &sa));
    e.as_contract(&a, || set_cap(&e, 200, &r, &sa));
    e.as_contract(&a, || enforce(&e, &transfer_ctx(&e, 150), &s, &r, &sa));
    e.as_contract(&a, || assert_eq!(get_call_cap_data(&e, r.id, &sa).params.cap, 200));
}

#[test]
fn uninstall_missing_is_idempotent() {
    let e = Env::default();
    let a = e.register(MockContract, ());
    let sa = Address::generate(&e);
    e.mock_all_auths();
    e.as_contract(&a, || uninstall(&e, &rule(&e), &sa));
}
