/** SCH-PolicyIntent (Vol 02 §6). The only artifact the AI authors; B3 normalizes it. */
import { z } from "zod";
import { Amount, ContractId } from "../primitives.js";
import { LedgerWindow, Network, Provenance, SchemaVersion } from "./common.js";
import { SignerModel } from "./signer.js";

const PATH_RE = /^\$(\.[A-Za-z_][A-Za-z0-9_]*|\[\*\]|\[\d+\])*$/;

export const ArgConstraintSpec = z.object({
  index: z.number().int().min(0),
  path: z.string().regex(PATH_RE).optional(),
  op: z.enum(["any", "eq", "in", "range", "addr_eq", "addr_in"]),
  values: z.array(z.unknown()).optional(),
  min: z.string().optional(),
  max: z.string().optional(),
  provenance: Provenance,
});
export type ArgConstraintSpec = z.infer<typeof ArgConstraintSpec>;

export const IntentFunction = z.object({
  name: z.string().min(1).max(60),
  arg_constraints: z.array(ArgConstraintSpec),
});
export type IntentFunction = z.infer<typeof IntentFunction>;

export const IntentTarget = z.object({
  contract: ContractId,
  label: z.string().max(80).optional(),
  functions: z.array(IntentFunction).min(1),
  provenance: Provenance,
});
export type IntentTarget = z.infer<typeof IntentTarget>;

export const IntentBudget = z
  .object({
    token: ContractId,
    cap: Amount,
    decimals: z.number().int(),
    window: LedgerWindow,
    scope: z.enum(["outflow_via_transfer", "per_call_arg"]),
    arg_source: z.object({ contract: ContractId, fn: z.string(), path: z.string() }).optional(),
    provenance: Provenance,
  })
  // INV-Intent-2: per_call_arg requires arg_source; outflow_via_transfer forbids it.
  .superRefine((b, ctx) => {
    if (b.scope === "per_call_arg" && b.arg_source === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "per_call_arg requires arg_source" });
    }
    if (b.scope === "outflow_via_transfer" && b.arg_source !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "outflow_via_transfer forbids arg_source" });
    }
  });
export type IntentBudget = z.infer<typeof IntentBudget>;

export const PolicyIntent = z.object({
  schema_version: SchemaVersion,
  network: Network,
  account: ContractId,
  grantee: z.object({ signer: SignerModel, label: z.string().max(80) }),
  targets: z.array(IntentTarget).min(1),
  budgets: z.array(IntentBudget),
  quorum: z.object({ threshold: z.number().int().min(1), of_signers: z.array(SignerModel) }).optional(),
  expiry: z.object({ ledgers: z.number().int().positive() }), // REQUIRED — no unbounded grants (INV-Intent-1)
  preserve: z.array(z.number().int()),
  allow_default_context: z.literal(false).default(false),
  explicit_denies: z.array(z.object({ description: z.string(), provenance: Provenance })),
  clarifications_resolved: z.array(z.object({ question: z.string(), answer: z.string() })),
});
export type PolicyIntent = z.infer<typeof PolicyIntent>;
