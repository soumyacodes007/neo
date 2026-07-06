/**
 * C3 — `generate-policy-code` (Vol 06 §4). The last resort: generate a minimal
 * custom Soroban Policy contract for a residual constraint that no OZ primitive
 * or `pb_*` policy can express (e.g. a cross-argument invariant). Everything
 * outside the `// >>> GENERATED` … `// <<< GENERATED` markers is frozen template
 * text; only the fenced region is filled, and a manifest maps each region back
 * to its source constraint (for review + the sandbox diff-guard). Build-only —
 * never deploys, no `build.rs`, deps limited to soroban-sdk (+ stellar-accounts).
 *
 * Generated crates use the `GeneratedPolicyError` enum in range 3400–3499.
 */
import { ToolError } from "@ozpb/core";

/** A residual the IR can't express but a template can. */
export type CodegenResidual = {
  kind: "cross_arg_lt";
  constraint_id: string;
  fn_name: string;
  left_index: number;
  right_index: number;
};

export interface CodegenRegion {
  constraint_id: string;
  semantics: string;
  marker_start: string;
  marker_end: string;
}

export interface CodegenManifest {
  crate_name: string;
  regions: CodegenRegion[];
  no_build_rs: true;
  deps: string[];
}

export interface GeneratedCrate {
  crate_name: string;
  files: { path: string; content: string }[];
  manifest: CodegenManifest;
}

const DEP_ALLOWLIST = ["soroban-sdk", "stellar-accounts"];

export function generatePolicyCode(input: { policyName: string; residual: CodegenResidual }): GeneratedCrate {
  if (input.residual.kind !== "cross_arg_lt") {
    throw new ToolError("E_C3_UNEXPRESSIBLE", `no template family for residual kind "${(input.residual as { kind: string }).kind}"`, {
      suggestion: "narrow the intent, or capture the invariant with an existing pb policy",
    });
  }
  const slug = slugify(input.policyName);
  const crate_name = `stellar-generated-${slug}`;
  const r = input.residual;
  const marker_start = `// >>> GENERATED: ${r.constraint_id}`;
  const marker_end = `// <<< GENERATED`;

  const generated = [
    marker_start,
    `            // constraint: ${r.constraint_id} — args[${String(r.left_index)}] must be strictly less than args[${String(r.right_index)}]`,
    `            let left = read_i128(e, &args, ${String(r.left_index)});`,
    `            let right = read_i128(e, &args, ${String(r.right_index)});`,
    `            if !(left < right) {`,
    `                panic_with_error!(e, GeneratedPolicyError::Denied)`,
    `            }`,
    marker_end,
  ].join("\n");

  const libRs = renderLib(structName(slug), r.fn_name, generated);
  const cargoToml = renderCargo(crate_name);

  return {
    crate_name,
    files: [
      { path: "Cargo.toml", content: cargoToml },
      { path: "src/lib.rs", content: libRs },
    ],
    manifest: {
      crate_name,
      regions: [
        {
          constraint_id: r.constraint_id,
          semantics: `args[${String(r.left_index)}] < args[${String(r.right_index)}] on ${r.fn_name}`,
          marker_start,
          marker_end,
        },
      ],
      no_build_rs: true,
      deps: DEP_ALLOWLIST,
    },
  };
}

function renderCargo(name: string): string {
  // Fixed template; pinned versions matching the sandbox image; NO build.rs.
  return `[package]
name = "${name}"
edition = "2021"
version = "0.1.0"
license = "Apache-2.0"

[lib]
crate-type = ["lib", "cdylib"]
doctest = false

[dependencies]
soroban-sdk = { version = "26.1.0", features = ["experimental_spec_shaking_v2"] }
stellar-accounts = { path = "../../../stellar-contracts/packages/accounts", version = "0.7.1" }

[dev-dependencies]
soroban-sdk = { version = "26.1.0", features = ["experimental_spec_shaking_v2", "testutils"] }
`;
}

function renderLib(structName: string, fnName: string, generated: string): string {
  return `//! GENERATED custom policy — UNAUDITED. Review the fenced region before use.
#![no_std]

use soroban_sdk::{
    auth::{Context, ContractContext},
    contract, contracterror, contractimpl, contracttype, panic_with_error, Address, Env, Symbol,
    TryFromVal, Val, Vec,
};
use stellar_accounts::{
    policies::Policy,
    smart_account::{ContextRule, ContextRuleType, Signer},
};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum GeneratedPolicyError {
    NotInstalled = 3400,
    AlreadyInstalled = 3401,
    Denied = 3402,
    OnlyCallContractAllowed = 3403,
    TypeMismatch = 3404,
}

#[contracttype]
pub enum GeneratedStorageKey {
    AccountContext(Address, u32),
}

pub fn install(e: &Env, _params: (), context_rule: &ContextRule, smart_account: &Address) {
    smart_account.require_auth();
    if !matches!(context_rule.context_type, ContextRuleType::CallContract(_)) {
        panic_with_error!(e, GeneratedPolicyError::OnlyCallContractAllowed)
    }
    let key = GeneratedStorageKey::AccountContext(smart_account.clone(), context_rule.id);
    if e.storage().persistent().has(&key) {
        panic_with_error!(e, GeneratedPolicyError::AlreadyInstalled)
    }
    e.storage().persistent().set(&key, &true);
}

pub fn enforce(e: &Env, context: &Context, context_rule: &ContextRule, smart_account: &Address) {
    smart_account.require_auth();
    let key = GeneratedStorageKey::AccountContext(smart_account.clone(), context_rule.id);
    if !e.storage().persistent().has(&key) {
        panic_with_error!(e, GeneratedPolicyError::NotInstalled)
    }
    match context {
        Context::Contract(ContractContext { fn_name, args, .. }) => {
            if fn_name == &Symbol::new(e, "${fnName}") {
${generated}
            }
        }
        _ => panic_with_error!(e, GeneratedPolicyError::Denied),
    }
}

pub fn uninstall(e: &Env, context_rule: &ContextRule, smart_account: &Address) {
    smart_account.require_auth();
    let key = GeneratedStorageKey::AccountContext(smart_account.clone(), context_rule.id);
    if e.storage().persistent().has(&key) {
        e.storage().persistent().remove(&key);
    }
}

fn read_i128(e: &Env, args: &Vec<Val>, index: u32) -> i128 {
    match args.get(index) {
        Some(v) => i128::try_from_val(e, &v).unwrap_or_else(|_| panic_with_error!(e, GeneratedPolicyError::TypeMismatch)),
        None => panic_with_error!(e, GeneratedPolicyError::Denied),
    }
}

#[contract]
pub struct ${structName};

#[contractimpl]
impl Policy for ${structName} {
    type AccountParams = ();

    fn enforce(e: &Env, context: Context, _s: Vec<Signer>, context_rule: ContextRule, smart_account: Address) {
        enforce(e, &context, &context_rule, &smart_account)
    }
    fn install(e: &Env, install_params: Self::AccountParams, context_rule: ContextRule, smart_account: Address) {
        install(e, install_params, &context_rule, &smart_account)
    }
    fn uninstall(e: &Env, context_rule: ContextRule, smart_account: Address) {
        uninstall(e, &context_rule, &smart_account)
    }
}
`;
}

/** Slug-sanitize a name for a crate/path (EC-B03 workspace jail defense). */
function slugify(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (s.length === 0) throw new ToolError("E_INPUT_SCHEMA", "policy name has no valid slug characters");
  return s.slice(0, 40);
}

function structName(slug: string): string {
  return (
    slug
      .split("-")
      .filter((p) => p.length > 0)
      .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
      .join("") + "Policy"
  );
}
