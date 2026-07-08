/**
 * C3 - `generate-policy-code` (Vol 06 section 4). Last-resort custom Soroban
 * Policy generation for residual constraints no existing OZ or pb policy can
 * express. The generated region is fenced and mapped back to constraints in a
 * manifest. Build-only: never signs, submits, or deploys.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { ToolError } from "@ozpb/core";

export type CodegenCheck =
  | { kind: "arg_i128_range"; arg_index: number; min: string; max: string }
  | { kind: "arg_u32_eq"; arg_index: number; value: number }
  | { kind: "cross_arg_compare"; left_index: number; op: "lt" | "lte" | "gt" | "gte" | "eq"; right_index: number };

/** A residual the IR cannot bind to OZ/pb but a fixed template can express. */
export type CodegenResidual =
  | {
      kind: "cross_arg_lt";
      constraint_id: string;
      fn_name: string;
      left_index: number;
      right_index: number;
    }
  | {
      kind: "context_guard";
      constraint_id: string;
      fn_name: string;
      checks: CodegenCheck[];
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
  const residual = normalizeResidual(input.residual);
  if (residual.checks.length === 0) {
    throw new ToolError("E_C3_UNEXPRESSIBLE", `no checks supplied for residual "${residual.constraint_id}"`, {
      suggestion: "capture the invariant with an existing pb policy, or provide a supported codegen check",
    });
  }

  const slug = slugify(input.policyName);
  const crate_name = `stellar-generated-${slug}`;
  const marker_start = `// >>> GENERATED: ${residual.constraint_id}`;
  const marker_end = "// <<< GENERATED";
  const generated = [
    marker_start,
    ...residual.checks.flatMap((check) => renderCheck(residual.constraint_id, check)),
    marker_end,
  ].join("\n");

  const libRs = renderLib(structName(slug), residual.fn_name, generated);
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
          constraint_id: residual.constraint_id,
          semantics: `${residual.checks.map(checkSemantics).join("; ")} on ${residual.fn_name}`,
          marker_start,
          marker_end,
        },
      ],
      no_build_rs: true,
      deps: DEP_ALLOWLIST,
    },
  };
}

export function renderGeneratedPolicyReview(crate: GeneratedCrate): string {
  const regions = crate.manifest.regions.map((r) => `- ${r.constraint_id}: ${r.semantics}`).join("\n");
  const files = crate.files.map((f) => `- ${f.path}`).join("\n");
  return `# Generated Policy Review

Crate: ${crate.crate_name}

Status: REVIEW REQUIRED before deployment.

Generated regions:
${regions}

Files:
${files}

Reviewer checklist:
- Confirm every generated region maps to the intended constraint.
- Confirm no file named build.rs exists.
- Compile with the sandbox before deployment.
- Run allow/deny simulation before install.
`;
}

export async function writeGeneratedPolicyWorkspace(crate: GeneratedCrate, workspaceDir: string): Promise<{ crate_path: string; review_path: string; manifest_path: string }> {
  const cratePath = resolve(workspaceDir, crate.crate_name);
  for (const file of crate.files) {
    const target = resolve(cratePath, file.path);
    if (!isInside(cratePath, target)) {
      throw new ToolError("E_BUILD_TEMPLATE", `generated file escaped crate workspace: ${file.path}`);
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.content);
  }
  const manifestPath = resolve(cratePath, "codegen_manifest.json");
  const reviewPath = resolve(cratePath, "REVIEW.md");
  await writeFile(manifestPath, `${JSON.stringify(crate.manifest, null, 2)}\n`);
  await writeFile(reviewPath, renderGeneratedPolicyReview(crate));
  return { crate_path: cratePath, review_path: reviewPath, manifest_path: manifestPath };
}

function normalizeResidual(residual: CodegenResidual): Extract<CodegenResidual, { kind: "context_guard" }> {
  if (residual.kind === "context_guard") return residual;
  if (residual.kind === "cross_arg_lt") {
    return {
      kind: "context_guard",
      constraint_id: residual.constraint_id,
      fn_name: residual.fn_name,
      checks: [{ kind: "cross_arg_compare", left_index: residual.left_index, op: "lt", right_index: residual.right_index }],
    };
  }
  throw new ToolError("E_C3_UNEXPRESSIBLE", `no template family for residual kind "${(residual as { kind: string }).kind}"`, {
    suggestion: "narrow the intent, or capture the invariant with an existing pb policy",
  });
}

function renderCargo(name: string): string {
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
  return `//! GENERATED custom policy - UNAUDITED. Review the fenced region before use.
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

fn read_u32(e: &Env, args: &Vec<Val>, index: u32) -> u32 {
    match args.get(index) {
        Some(v) => u32::try_from_val(e, &v).unwrap_or_else(|_| panic_with_error!(e, GeneratedPolicyError::TypeMismatch)),
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

function renderCheck(constraintId: string, check: CodegenCheck): string[] {
  switch (check.kind) {
    case "arg_i128_range":
      assertIntegerLiteral(check.min, "min");
      assertIntegerLiteral(check.max, "max");
      return [
        `            // constraint: ${constraintId} - args[${String(check.arg_index)}] in [${check.min}, ${check.max}]`,
        `            let value = read_i128(e, &args, ${String(check.arg_index)});`,
        `            if value < ${check.min}i128 || value > ${check.max}i128 {`,
        "                panic_with_error!(e, GeneratedPolicyError::Denied)",
        "            }",
      ];
    case "arg_u32_eq":
      return [
        `            // constraint: ${constraintId} - args[${String(check.arg_index)}] == ${String(check.value)}`,
        `            let value = read_u32(e, &args, ${String(check.arg_index)});`,
        `            if value != ${String(check.value)}u32 {`,
        "                panic_with_error!(e, GeneratedPolicyError::Denied)",
        "            }",
      ];
    case "cross_arg_compare": {
      const op = rustOp(check.op);
      return [
        `            // constraint: ${constraintId} - args[${String(check.left_index)}] ${op} args[${String(check.right_index)}]`,
        `            let left = read_i128(e, &args, ${String(check.left_index)});`,
        `            let right = read_i128(e, &args, ${String(check.right_index)});`,
        `            if !(left ${op} right) {`,
        "                panic_with_error!(e, GeneratedPolicyError::Denied)",
        "            }",
      ];
    }
  }
}

function checkSemantics(check: CodegenCheck): string {
  switch (check.kind) {
    case "arg_i128_range":
      return `args[${String(check.arg_index)}] in [${check.min}, ${check.max}]`;
    case "arg_u32_eq":
      return `args[${String(check.arg_index)}] == ${String(check.value)}`;
    case "cross_arg_compare":
      return `args[${String(check.left_index)}] ${rustOp(check.op)} args[${String(check.right_index)}]`;
  }
}

function rustOp(op: Extract<CodegenCheck, { kind: "cross_arg_compare" }>["op"]): string {
  switch (op) {
    case "lt":
      return "<";
    case "lte":
      return "<=";
    case "gt":
      return ">";
    case "gte":
      return ">=";
    case "eq":
      return "==";
  }
}

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

function assertIntegerLiteral(value: string, label: string): void {
  if (!/^-?\d+$/.test(value)) {
    throw new ToolError("E_INPUT_SCHEMA", `invalid ${label} integer literal for generated Rust policy`);
  }
}

function isInside(root: string, target: string): boolean {
  return target === root || target.startsWith(`${root}\\`) || target.startsWith(`${root}/`);
}
