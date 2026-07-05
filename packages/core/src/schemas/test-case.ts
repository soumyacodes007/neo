/** SCH-TestCase & SCH-SimulationReport (Vol 02 §8). */
import { z } from "zod";
import { ContractId, XdrBase64 } from "../primitives.js";
import { SchemaVersion } from "./common.js";
import { Provenance } from "./common.js";
import { SignerModel } from "./signer.js";

export const MutationOperator = z.enum([
  "wrong_function",
  "wrong_contract",
  "wrong_token",
  "amount_plus_epsilon",
  "cumulative_overflow",
  "expired_window",
  "wrong_signer",
  "arg_tamper",
  "extra_context",
  "reordered_contexts",
  "zero_amount",
  "negative_amount",
]);
export type MutationOperator = z.infer<typeof MutationOperator>;

export const TestCase = z.object({
  id: z.string(),
  kind: z.enum(["allow", "deny"]),
  origin: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("observed"), provenance: Provenance }),
    z.object({ kind: z.literal("user_example"), provenance: Provenance }),
    z.object({ kind: z.literal("mutation"), operator: MutationOperator, base_case: z.string() }),
  ]),
  context: z.object({ contract: ContractId, fn_name: z.string(), args_scval_b64: z.array(XdrBase64) }),
  signer_set: z.array(SignerModel),
  ledger_offset: z.number().int().default(0),
  expected: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("pass") }),
    z.object({ kind: z.literal("panic"), contract_error_code: z.number().int() }),
  ]),
});
export type TestCase = z.infer<typeof TestCase>;

export const SimulationReport = z.object({
  schema_version: SchemaVersion,
  ruleset_hash: z.string(),
  engine_runs: z.array(
    z.object({
      engine: z.enum(["unit", "fork", "testnet"]),
      toolchain_fingerprint: z.string(),
      cases: z.array(
        z.object({
          case_id: z.string(),
          outcome: z.enum(["pass", "fail", "error", "skipped"]),
          detail: z.string().optional(),
        }),
      ),
    }),
  ),
  coverage: z.object({ constraints_exercised: z.array(z.string()), constraints_total: z.number().int() }),
  verdict: z.enum(["all_green", "failures"]),
  artifacts_dir: z.string(),
  report_hash: z.string().length(64),
});
export type SimulationReport = z.infer<typeof SimulationReport>;
