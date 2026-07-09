//! Fork simulation harness for OZ Policy Builder.
//!
//! This is host-side test tooling, not a contract. It optionally loads a
//! `stellar snapshot create` JSON file with `Env::from_ledger_snapshot_file`,
//! installs configured pb policies for one context rule, drives each TestCase,
//! and emits deterministic JSON verdicts on stdout.

use serde::{Deserialize, Serialize};
use soroban_sdk::{
    auth::{Context, ContractContext},
    contract,
    testutils::{Address as _, Ledger},
    xdr::{Limits, ReadXdr, ScVal},
    Address, Env, String as SorobanString, Symbol, TryFromVal, Val, Vec,
};
use stellar_accounts::smart_account::{ContextRule, ContextRuleType, Signer};

#[contract]
struct HarnessPolicyHost;

#[derive(Debug, Deserialize)]
struct HarnessInput {
    snapshot_path: Option<String>,
    account: Option<String>,
    rule: RuleInput,
    policies: std::vec::Vec<PolicyInput>,
    cases: std::vec::Vec<CaseInput>,
}

#[derive(Debug, Deserialize)]
struct RuleInput {
    id: u32,
    target_contract: String,
    valid_until: Option<u32>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum PolicyInput {
    FunctionAllowlist { allowed: std::vec::Vec<String> },
    ArgGuard { rules: std::vec::Vec<ArgRuleInput> },
    CallCap {
        cap: String,
        period_ledgers: u32,
        fn_name: String,
        amount_path: std::vec::Vec<PathSegInput>,
        #[serde(default)]
        token_filter_path: std::vec::Vec<PathSegInput>,
        token_filter_token: Option<String>,
    },
    RateLimit {
        max_calls: u32,
        period_ledgers: u32,
        fn_scope: Option<String>,
    },
}

#[derive(Debug, Deserialize)]
struct ArgRuleInput {
    fn_name: String,
    arg_index: u32,
    path: std::vec::Vec<PathSegInput>,
    pred: PredicateInput,
    forall: bool,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum PredicateInput {
    U32Eq { value: u32 },
    U32In { values: std::vec::Vec<u32> },
    Range { min: String, max: String },
    AddrEq { address: String },
    AddrIn { addresses: std::vec::Vec<String> },
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum PathSegInput {
    Field { name: String },
    Index { index: u32 },
    Wildcard,
}

#[derive(Debug, Deserialize)]
struct CaseInput {
    id: String,
    #[serde(rename = "kind")]
    _kind: String,
    context: ContextInput,
    #[serde(default)]
    signer_set: std::vec::Vec<serde_json::Value>,
    #[serde(default)]
    ledger_offset: u32,
    expected: ExpectedInput,
}

#[derive(Debug, Deserialize)]
struct ContextInput {
    contract: String,
    fn_name: String,
    args_scval_b64: std::vec::Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum ExpectedInput {
    Pass,
    Panic { contract_error_code: u32 },
}

#[derive(Debug, Serialize)]
struct HarnessOutput {
    toolchain_fingerprint: String,
    cases: std::vec::Vec<CaseVerdict>,
}

#[derive(Debug, Serialize)]
struct CaseVerdict {
    case_id: String,
    outcome: String,
    detail: Option<String>,
}

fn main() {
    std::panic::set_hook(Box::new(|_| {}));
    let input_path = std::env::args().nth(1).unwrap_or_else(|| {
        eprintln!("usage: ozpb-fork-harness <input.json>");
        std::process::exit(2);
    });
    let bytes = std::fs::read(&input_path).unwrap_or_else(|e| {
        eprintln!("failed to read input: {e}");
        std::process::exit(2);
    });
    let input: HarnessInput = serde_json::from_slice(&bytes).unwrap_or_else(|e| {
        eprintln!("failed to parse input: {e}");
        std::process::exit(2);
    });
    let output = run(input);
    println!("{}", serde_json::to_string_pretty(&output).expect("json output"));
}

fn run(input: HarnessInput) -> HarnessOutput {
    let e = match &input.snapshot_path {
        Some(path) => Env::from_ledger_snapshot_file(path),
        None => Env::default(),
    };
    e.mock_all_auths();
    let hosts: std::vec::Vec<Address> = input.policies.iter().map(|_| e.register(HarnessPolicyHost, ())).collect();
    let account = input
        .account
        .as_ref()
        .map(|a| address(&e, a))
        .unwrap_or_else(|| Address::generate(&e));
    let rule = context_rule(&e, &input.rule);
    install_policies(&e, &hosts, &input.policies, &rule, &account);

    let base_ledger = input.rule.valid_until.unwrap_or_else(|| e.ledger().sequence());
    let mut cases = std::vec::Vec::new();
    for case in &input.cases {
        e.ledger().set_sequence_number(base_ledger.saturating_add(case.ledger_offset));
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let context = contract_context(&e, &case.context);
            enforce_context_rule(&e, &context, &rule);
            let signers = signer_vec(&e, case.signer_set.len());
            enforce_policies(&e, &hosts, &input.policies, &context, &signers, &rule, &account);
        }));
        cases.push(verdict(case, result));
    }

    HarnessOutput { toolchain_fingerprint: "rust-harness:soroban-sdk-26.1.0".to_owned(), cases }
}

fn install_policies(e: &Env, hosts: &[Address], policies: &[PolicyInput], rule: &ContextRule, account: &Address) {
    for (i, policy) in policies.iter().enumerate() {
        let host = &hosts[i];
        match policy {
            PolicyInput::FunctionAllowlist { allowed } => {
                let params = stellar_pb_function_allowlist::FunctionAllowlistParams { allowed: symbols(e, allowed) };
                e.as_contract(host, || stellar_pb_function_allowlist::install(e, &params, rule, account));
            }
            PolicyInput::ArgGuard { rules } => {
                let params = stellar_pb_arg_guard::ArgGuardParams { rules: arg_rules(e, rules) };
                e.as_contract(host, || stellar_pb_arg_guard::install(e, &params, rule, account));
            }
            PolicyInput::CallCap { cap, period_ledgers, fn_name, amount_path, token_filter_path, token_filter_token } => {
                let params = stellar_pb_call_cap::CallCapParams {
                    cap: parse_i128(cap),
                    period_ledgers: *period_ledgers,
                    fn_name: Symbol::new(e, fn_name),
                    amount_path: call_cap_path(e, amount_path),
                    token_filter_path: call_cap_path(e, token_filter_path),
                    token_filter_token: token_filter_token.as_ref().map(|a| address(e, a)),
                };
                e.as_contract(host, || stellar_pb_call_cap::install(e, &params, rule, account));
            }
            PolicyInput::RateLimit { max_calls, period_ledgers, fn_scope } => {
                let params = stellar_pb_rate_limit::RateLimitParams {
                    max_calls: *max_calls,
                    period_ledgers: *period_ledgers,
                    fn_scope: fn_scope.as_ref().map(|s| Symbol::new(e, s)),
                };
                e.as_contract(host, || stellar_pb_rate_limit::install(e, &params, rule, account));
            }
        }
    }
}

fn enforce_policies(e: &Env, hosts: &[Address], policies: &[PolicyInput], context: &Context, signers: &Vec<Signer>, rule: &ContextRule, account: &Address) {
    for (i, policy) in policies.iter().enumerate() {
        let host = &hosts[i];
        match policy {
            PolicyInput::FunctionAllowlist { .. } => e.as_contract(host, || stellar_pb_function_allowlist::enforce(e, context, rule, account)),
            PolicyInput::ArgGuard { .. } => e.as_contract(host, || stellar_pb_arg_guard::enforce(e, context, rule, account)),
            PolicyInput::CallCap { .. } => e.as_contract(host, || stellar_pb_call_cap::enforce(e, context, signers, rule, account)),
            PolicyInput::RateLimit { .. } => e.as_contract(host, || stellar_pb_rate_limit::enforce(e, context, signers, rule, account)),
        }
    }
}

fn enforce_context_rule(e: &Env, context: &Context, rule: &ContextRule) {
    if let Some(valid_until) = rule.valid_until {
        if e.ledger().sequence() > valid_until {
            panic!("#3013 context rule expired")
        }
    }

    match (&rule.context_type, context) {
        (ContextRuleType::CallContract(target), Context::Contract(ContractContext { contract, .. })) if contract == target => {}
        (ContextRuleType::CallContract(_), _) => panic!("#3303 context contract not allowed"),
        _ => panic!("#3303 context type not allowed"),
    }
}

fn verdict(case: &CaseInput, result: Result<(), Box<dyn std::any::Any + Send>>) -> CaseVerdict {
    match (&case.expected, result) {
        (ExpectedInput::Pass, Ok(())) => CaseVerdict { case_id: case.id.clone(), outcome: "pass".to_owned(), detail: None },
        (ExpectedInput::Pass, Err(e)) => CaseVerdict { case_id: case.id.clone(), outcome: "fail".to_owned(), detail: Some(panic_detail(e)) },
        (ExpectedInput::Panic { contract_error_code }, Ok(())) => CaseVerdict {
            case_id: case.id.clone(),
            outcome: "fail".to_owned(),
            detail: Some(format!("expected panic #{contract_error_code}, got pass")),
        },
        (ExpectedInput::Panic { contract_error_code }, Err(e)) => {
            let detail = panic_detail(e);
            let needle = format!("#{contract_error_code}");
            let outcome = if detail.contains(&needle) || detail.contains(&contract_error_code.to_string()) { "pass" } else { "fail" };
            CaseVerdict { case_id: case.id.clone(), outcome: outcome.to_owned(), detail: Some(detail) }
        }
    }
}

fn panic_detail(e: Box<dyn std::any::Any + Send>) -> String {
    if let Some(s) = e.downcast_ref::<String>() {
        s.clone()
    } else if let Some(s) = e.downcast_ref::<&str>() {
        (*s).to_owned()
    } else {
        "panic".to_owned()
    }
}

fn context_rule(e: &Env, input: &RuleInput) -> ContextRule {
    ContextRule {
        id: input.id,
        context_type: ContextRuleType::CallContract(address(e, &input.target_contract)),
        name: SorobanString::from_str(e, "fork-harness-rule"),
        signers: signer_vec(e, 1),
        signer_ids: Vec::new(e),
        policies: Vec::new(e),
        policy_ids: Vec::new(e),
        valid_until: input.valid_until,
    }
}

fn contract_context(e: &Env, input: &ContextInput) -> Context {
    let mut args = Vec::new(e);
    for b64 in &input.args_scval_b64 {
        args.push_back(scval_to_val(e, b64));
    }
    Context::Contract(ContractContext { contract: address(e, &input.contract), fn_name: Symbol::new(e, &input.fn_name), args })
}

fn scval_to_val(e: &Env, b64: &str) -> Val {
    let scval = ScVal::from_xdr_base64(b64, Limits::none()).expect("valid ScVal XDR");
    Val::try_from_val(e, &scval).expect("ScVal convertible to Val")
}

fn signer_vec(e: &Env, count: usize) -> Vec<Signer> {
    let mut out = Vec::new(e);
    let n = if count == 0 { 1 } else { count };
    for _ in 0..n {
        out.push_back(Signer::Delegated(Address::generate(e)));
    }
    out
}

fn address(e: &Env, s: &str) -> Address {
    Address::from_string(&SorobanString::from_str(e, s))
}

fn symbols(e: &Env, values: &[String]) -> Vec<Symbol> {
    let mut out = Vec::new(e);
    for value in values {
        out.push_back(Symbol::new(e, value));
    }
    out
}

fn arg_rules(e: &Env, rules: &[ArgRuleInput]) -> Vec<stellar_pb_arg_guard::ArgRule> {
    let mut out = Vec::new(e);
    for rule in rules {
        out.push_back(stellar_pb_arg_guard::ArgRule {
            fn_name: Symbol::new(e, &rule.fn_name),
            arg_index: rule.arg_index,
            path: arg_path(e, &rule.path),
            pred: predicate(e, &rule.pred),
            forall: rule.forall,
        });
    }
    out
}

fn predicate(e: &Env, pred: &PredicateInput) -> stellar_pb_arg_guard::Predicate {
    match pred {
        PredicateInput::U32Eq { value } => stellar_pb_arg_guard::Predicate::U32Eq(*value),
        PredicateInput::U32In { values } => {
            let mut out = Vec::new(e);
            for value in values {
                out.push_back(*value);
            }
            stellar_pb_arg_guard::Predicate::U32In(out)
        }
        PredicateInput::Range { min, max } => stellar_pb_arg_guard::Predicate::Range(parse_i128(min), parse_i128(max)),
        PredicateInput::AddrEq { address: a } => stellar_pb_arg_guard::Predicate::AddrEq(address(e, a)),
        PredicateInput::AddrIn { addresses } => {
            let mut out = Vec::new(e);
            for a in addresses {
                out.push_back(address(e, a));
            }
            stellar_pb_arg_guard::Predicate::AddrIn(out)
        }
    }
}

fn arg_path(e: &Env, path: &[PathSegInput]) -> Vec<stellar_pb_arg_guard::PathSeg> {
    let mut out = Vec::new(e);
    for seg in path {
        out.push_back(match seg {
            PathSegInput::Field { name } => stellar_pb_arg_guard::PathSeg::Field(Symbol::new(e, name)),
            PathSegInput::Index { index } => stellar_pb_arg_guard::PathSeg::Index(*index),
            PathSegInput::Wildcard => stellar_pb_arg_guard::PathSeg::Wildcard,
        });
    }
    out
}

fn call_cap_path(e: &Env, path: &[PathSegInput]) -> Vec<stellar_pb_call_cap::PathSeg> {
    let mut out = Vec::new(e);
    for seg in path {
        out.push_back(match seg {
            PathSegInput::Field { name } => stellar_pb_call_cap::PathSeg::Field(Symbol::new(e, name)),
            PathSegInput::Index { index } => stellar_pb_call_cap::PathSeg::Index(*index),
            PathSegInput::Wildcard => stellar_pb_call_cap::PathSeg::Wildcard,
        });
    }
    out
}

fn parse_i128(s: &str) -> i128 {
    s.parse::<i128>().expect("i128 string")
}
