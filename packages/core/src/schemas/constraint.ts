/** SCH-Constraint (the IR) + SCH-CandidateRuleset (Vol 02 §7). */
import { z } from "zod";
import { ContractId, LedgerSeq, XdrBase64 } from "../primitives.js";
import { LedgerWindow, Network, Provenance, SchemaVersion } from "./common.js";
import { ContextType, PolicyClassification } from "./context-rule.js";
import { SignerModel } from "./signer.js";

const AmountSource = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("transfer_arg2") }),
  z.object({
    kind: z.literal("call_arg"),
    contract: ContractId,
    fn: z.string(),
    path: z.string(),
    token_filter_path: z.string().optional(),
  }),
]);

export const Constraint = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("func_allowlist"), contract: ContractId, functions: z.array(z.string()).min(1) }),
    z.object({
      kind: z.literal("arg_predicate"),
      contract: ContractId,
      fn: z.string(),
      arg_index: z.number().int(),
      path: z.string().optional(),
      op: z.enum(["eq", "in", "range", "addr_eq", "addr_in"]),
      values_scval_b64: z.array(XdrBase64).optional(),
      min_i128: z.string().optional(),
      max_i128: z.string().optional(),
    }),
    z.object({
      kind: z.literal("amount_cap"),
      token: ContractId,
      cap_i128: z.string(),
      window: LedgerWindow,
      source: AmountSource,
    }),
    z.object({ kind: z.literal("rate_limit"), max_calls: z.number().int().positive(), window: LedgerWindow }),
    z.object({
      kind: z.literal("threshold"),
      m: z.number().int().min(1),
      weighted: z.boolean(),
      weights: z.array(z.object({ signer: SignerModel, weight: z.number().int() })).optional(),
    }),
    z.object({ kind: z.literal("expiry"), valid_until_ledger: LedgerSeq }),
  ])
  .and(z.object({ id: z.string(), provenance: z.array(Provenance).min(1) }));
export type Constraint = z.infer<typeof Constraint>;

export const PolicyBinding = z.object({
  constraint_ids: z.array(z.string()).min(1),
  binding: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("none_needed") }),
    z.object({
      kind: z.literal("existing"),
      classification: PolicyClassification,
      address: ContractId.optional(),
      install_params_scval_b64: XdrBase64,
    }),
    z.object({ kind: z.literal("codegen"), codegen_ref: z.string() }),
  ]),
  limitations: z.array(z.object({ code: z.string(), message: z.string() })),
});
export type PolicyBinding = z.infer<typeof PolicyBinding>;

export const CandidateRule = z.object({
  name: z.string().max(20),
  context_type: ContextType,
  valid_until_ledger: LedgerSeq,
  signers: z.array(SignerModel).min(0).max(15),
  constraints: z.array(Constraint),
  policy_bindings: z.array(PolicyBinding).max(5),
});
export type CandidateRule = z.infer<typeof CandidateRule>;

export const CandidateRuleset = z.object({
  schema_version: SchemaVersion,
  account: ContractId,
  network: Network,
  based_on: z.object({
    snapshot_hash: z.string().optional(),
    evidence_hash: z.string().optional(),
    intent_hash: z.string(),
  }),
  rules: z.array(CandidateRule).min(1),
  removals: z.array(z.object({ rule_id: z.number().int(), reason: z.string() })),
  updates: z.array(z.object({ rule_id: z.number().int(), set_valid_until: LedgerSeq })),
  unsatisfied: z.array(z.object({ constraint_id: z.string(), reason: z.string() })),
  ruleset_hash: z.string().length(64),
});
export type CandidateRuleset = z.infer<typeof CandidateRuleset>;
