extern crate std;

use soroban_sdk::{
    auth::{Context, ContractContext, ContractExecutable, CreateContractHostFnContext},
    contract,
    testutils::Address as _,
    Address, BytesN, Env, String as SorobanString, Symbol, Vec,
};
use stellar_accounts::smart_account::{ContextRule, ContextRuleType, Signer};

use crate::*;

#[contract]
struct MockContract;

fn allowlist(e: &Env, names: &[&str]) -> Vec<Symbol> {
    let mut v = Vec::new(e);
    for n in names {
        v.push_back(Symbol::new(e, n));
    }
    v
}

fn call_contract_rule(e: &Env) -> ContextRule {
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

fn contract_context(e: &Env, fn_name: Symbol) -> Context {
    Context::Contract(ContractContext { contract: Address::generate(e), fn_name, args: Vec::new(e) })
}

fn create_context(e: &Env) -> Context {
    Context::CreateContractHostFn(CreateContractHostFnContext {
        executable: ContractExecutable::Wasm(BytesN::from_array(e, &[0u8; 32])),
        salt: BytesN::from_array(e, &[0u8; 32]),
    })
}

/// Read one base64 XDR value out of the TS-emitted fixtures JSON (naive parse).
fn fixture(key: &str) -> std::string::String {
    let path = std::concat!(env!("CARGO_MANIFEST_DIR"), "/../../pb-install-params-fixtures.json");
    let content = std::fs::read_to_string(path).expect("fixtures file");
    let needle = std::format!("\"{key}\":");
    let after = &content[content.find(&needle).expect("key") + needle.len()..];
    let q1 = after.find('"').unwrap() + 1;
    let q2 = after[q1..].find('"').unwrap();
    after[q1..q1 + q2].into()
}

/// Parity: the TS install-param encoder produces XDR that decodes into the real
/// Rust `#[contracttype]` structs — host-verified map ordering/shape (Vol 06 C2).
#[test]
fn parity_ts_encoded_install_params() {
    use soroban_sdk::xdr::{Limits, ReadXdr, ScVal};
    use soroban_sdk::{TryFromVal, Val};
    use stellar_accounts::policies::{simple_threshold, spending_limit};

    let e = Env::default();
    let decode = |key: &str| -> Val {
        let scval = ScVal::from_xdr_base64(fixture(key), Limits::none()).expect("xdr");
        Val::try_from_val(&e, &scval).expect("val")
    };

    let allow = FunctionAllowlistParams::try_from_val(&e, &decode("function_allowlist")).unwrap();
    assert_eq!(allow.allowed.len(), 2);

    let sl = spending_limit::SpendingLimitAccountParams::try_from_val(&e, &decode("spending_limit")).unwrap();
    assert_eq!(sl.spending_limit, 5_000_000_000);
    assert_eq!(sl.period_ledgers, 17280);

    let st = simple_threshold::SimpleThresholdAccountParams::try_from_val(&e, &decode("simple_threshold")).unwrap();
    assert_eq!(st.threshold, 2);
}

#[test]
fn install_success() {
    let e = Env::default();
    let address = e.register(MockContract, ());
    let sa = Address::generate(&e);
    e.mock_all_auths();
    e.as_contract(&address, || {
        let rule = call_contract_rule(&e);
        install(&e, &FunctionAllowlistParams { allowed: allowlist(&e, &["claim", "submit"]) }, &rule, &sa);
        assert_eq!(get_allowlist(&e, rule.id, &sa).len(), 2);
    });
}

#[test]
#[should_panic(expected = "Error(Contract, #3302)")]
fn install_empty_fails() {
    let e = Env::default();
    let address = e.register(MockContract, ());
    let sa = Address::generate(&e);
    e.mock_all_auths();
    e.as_contract(&address, || {
        install(&e, &FunctionAllowlistParams { allowed: allowlist(&e, &[]) }, &call_contract_rule(&e), &sa);
    });
}

#[test]
#[should_panic(expected = "Error(Contract, #3304)")]
fn install_noncallcontract_fails() {
    let e = Env::default();
    let address = e.register(MockContract, ());
    let sa = Address::generate(&e);
    e.mock_all_auths();
    e.as_contract(&address, || {
        let mut rule = call_contract_rule(&e);
        rule.context_type = ContextRuleType::Default;
        install(&e, &FunctionAllowlistParams { allowed: allowlist(&e, &["claim"]) }, &rule, &sa);
    });
}

#[test]
#[should_panic(expected = "Error(Contract, #3305)")]
fn install_toomany_fails() {
    let e = Env::default();
    let address = e.register(MockContract, ());
    let sa = Address::generate(&e);
    e.mock_all_auths();
    e.as_contract(&address, || {
        let mut names = Vec::new(&e);
        for i in 0..(MAX_ALLOWED + 1) {
            names.push_back(Symbol::new(&e, &std::format!("f{i}")));
        }
        install(&e, &FunctionAllowlistParams { allowed: names }, &call_contract_rule(&e), &sa);
    });
}

#[test]
#[should_panic(expected = "Error(Contract, #3301)")]
fn double_install_fails() {
    let e = Env::default();
    let address = e.register(MockContract, ());
    let sa = Address::generate(&e);
    e.mock_all_auths();
    let rule = call_contract_rule(&e);
    let p = FunctionAllowlistParams { allowed: allowlist(&e, &["claim"]) };
    e.as_contract(&address, || install(&e, &p, &rule, &sa));
    e.as_contract(&address, || install(&e, &p, &rule, &sa));
}

#[test]
fn enforce_allowed_passes() {
    let e = Env::default();
    let address = e.register(MockContract, ());
    let sa = Address::generate(&e);
    e.mock_all_auths();
    let rule = call_contract_rule(&e);
    e.as_contract(&address, || {
        install(&e, &FunctionAllowlistParams { allowed: allowlist(&e, &["claim", "submit"]) }, &rule, &sa)
    });
    e.as_contract(&address, || enforce(&e, &contract_context(&e, Symbol::new(&e, "submit")), &rule, &sa));
}

#[test]
#[should_panic(expected = "Error(Contract, #3303)")]
fn enforce_denied_panics() {
    let e = Env::default();
    let address = e.register(MockContract, ());
    let sa = Address::generate(&e);
    e.mock_all_auths();
    let rule = call_contract_rule(&e);
    e.as_contract(&address, || {
        install(&e, &FunctionAllowlistParams { allowed: allowlist(&e, &["claim"]) }, &rule, &sa)
    });
    e.as_contract(&address, || enforce(&e, &contract_context(&e, Symbol::new(&e, "transfer")), &rule, &sa));
}

#[test]
#[should_panic(expected = "Error(Contract, #3303)")]
fn enforce_create_context_denies() {
    let e = Env::default();
    let address = e.register(MockContract, ());
    let sa = Address::generate(&e);
    e.mock_all_auths();
    let rule = call_contract_rule(&e);
    e.as_contract(&address, || {
        install(&e, &FunctionAllowlistParams { allowed: allowlist(&e, &["claim"]) }, &rule, &sa)
    });
    e.as_contract(&address, || enforce(&e, &create_context(&e), &rule, &sa));
}

#[test]
fn uninstall_missing_is_idempotent() {
    let e = Env::default();
    let address = e.register(MockContract, ());
    let sa = Address::generate(&e);
    e.mock_all_auths();
    e.as_contract(&address, || {
        // Never installed — must not panic.
        uninstall(&e, &call_contract_rule(&e), &sa);
    });
}

#[test]
fn set_allowed_replaces() {
    let e = Env::default();
    let address = e.register(MockContract, ());
    let sa = Address::generate(&e);
    e.mock_all_auths();
    let rule = call_contract_rule(&e);
    e.as_contract(&address, || {
        install(&e, &FunctionAllowlistParams { allowed: allowlist(&e, &["claim"]) }, &rule, &sa)
    });
    e.as_contract(&address, || set_allowed(&e, &allowlist(&e, &["claim", "submit", "withdraw"]), &rule, &sa));
    e.as_contract(&address, || assert_eq!(get_allowlist(&e, rule.id, &sa).len(), 3));
}

#[test]
#[should_panic(expected = "Error(Contract, #3300)")]
fn get_not_installed_panics() {
    let e = Env::default();
    let address = e.register(MockContract, ());
    let sa = Address::generate(&e);
    e.as_contract(&address, || {
        get_allowlist(&e, 1, &sa);
    });
}

#[test]
fn tenant_isolation_across_accounts() {
    let e = Env::default();
    let address = e.register(MockContract, ());
    let sa1 = Address::generate(&e);
    let sa2 = Address::generate(&e);
    e.mock_all_auths();
    e.as_contract(&address, || {
        let rule = call_contract_rule(&e);
        install(&e, &FunctionAllowlistParams { allowed: allowlist(&e, &["claim"]) }, &rule, &sa1);
        install(&e, &FunctionAllowlistParams { allowed: allowlist(&e, &["submit", "withdraw"]) }, &rule, &sa2);
        assert_eq!(get_allowlist(&e, rule.id, &sa1).len(), 1);
        assert_eq!(get_allowlist(&e, rule.id, &sa2).len(), 2);
    });
}
