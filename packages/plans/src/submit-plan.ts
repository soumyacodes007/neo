/**
 * F1 — `submit-plan` (Vol 09 §4). The ONLY tool that touches the network with
 * state changes, and it is disabled by default. It never signs — it accepts
 * user-signed XDR (from the wallet / smart-account-kit / Pollywallet flow) or
 * routes through a relayer transport.
 *
 * Every gate is evaluated BEFORE any side effect, and the whole hash chain is
 * re-verified from disk-loaded artifacts (never from conversation), so a
 * compromised model cannot fabricate an approval. The approval token is compared
 * in constant time against the disk token file (INV-Plan-3, EC-L01).
 */
import { timingSafeEqual } from "node:crypto";
import { ToolError, type InstallPlan, type Network, type PlanStep } from "@ozpb/core";
import { computePlanHash } from "./install-plan.js";

export interface SignedStep {
  order: number;
  signed_xdr: string;
}

export interface SubmitResult {
  order: number;
  status: "submitted" | "skipped";
  tx_hash?: string;
  detail?: string;
}

export interface SubmitDeps {
  /** Server flag `--enable-submit` (default off). */
  enableSubmit: boolean;
  /** Load the plan from disk by hash (NOT from conversation, EC-T03/T07). */
  loadPlan: (planHash: string) => InstallPlan | null;
  /** Read the approval token file referenced by the plan (EC-L01). */
  readApprovalToken: (ref: string) => string | null;
  currentLedger: number;
  network: Network;
  /** Live pre-flight: false iff the account was upgraded since the snapshot (EC-L03). */
  accountWasmHashMatches: () => boolean;
  /** Submit signed XDR via the chosen transport; the relayer cannot forge auth (EC-L06). */
  submit: (signedXdr: string, transport: "direct" | "relayer") => Promise<{ tx_hash: string }>;
  /** Idempotent resume: true iff the step's effect already exists on-chain (EC-L04/L05). */
  isStepApplied?: (step: PlanStep) => boolean;
  /** Extra confirmation phrase required when the plan has irreversible steps (INV-Plan-4). */
  confirmationPhrase?: string;
}

export interface SubmitInput {
  plan_hash: string;
  approval_token: string;
  signed_steps: SignedStep[];
  transport: "direct" | "relayer";
  confirmation_phrase?: string;
}

export async function submitPlan(input: SubmitInput, deps: SubmitDeps): Promise<{ results: SubmitResult[] }> {
  // 1. Disabled → refuse immediately, before parsing anything (EC-L07).
  if (!deps.enableSubmit) {
    throw new ToolError("E_GATE_SUBMIT_DISABLED", "submission is disabled (--enable-submit is off)", {
      suggestion: "the plan + revocation are ready to sign in your wallet; enable submit only when you intend to install",
    });
  }

  // 2. Load the plan from disk and re-verify its hash (tamper/drift detection).
  const plan = deps.loadPlan(input.plan_hash);
  if (plan === null) {
    throw new ToolError("E_GATE_STALE_ARTIFACTS", `no plan on disk for hash ${input.plan_hash}`);
  }
  const recomputed = computePlanHash(plan);
  if (recomputed !== plan.plan_hash || recomputed !== input.plan_hash) {
    throw new ToolError("E_GATE_STALE_ARTIFACTS", "plan hash does not match its contents (tampered or stale)", {
      details: { recomputed, claimed: plan.plan_hash, requested: input.plan_hash },
    });
  }

  // 3. Constant-time approval-token comparison against the disk token file.
  const token = deps.readApprovalToken(plan.approval_token_ref);
  if (token === null || !constantTimeEqual(input.approval_token, token)) {
    throw new ToolError("E_GATE_TOKEN_MISMATCH", "approval token missing or incorrect");
  }

  // 4. Plan freshness.
  if (deps.currentLedger > plan.expires_at_ledger) {
    throw new ToolError("E_GATE_PLAN_EXPIRED", "plan has expired; re-run prepare-install-plan to refresh fees/footprints", {
      details: { expires_at_ledger: plan.expires_at_ledger, current: deps.currentLedger },
    });
  }

  // 5. Network equality across the plan and the target.
  if (plan.network !== deps.network) {
    throw new ToolError("E_INPUT_NETWORK_MISMATCH", `plan is for ${plan.network} but target is ${deps.network}`);
  }

  // 6. Live pre-flight: the account must not have been upgraded since the snapshot.
  if (!deps.accountWasmHashMatches()) {
    throw new ToolError("E_GATE_STALE_ARTIFACTS", "account was upgraded since the snapshot (EC-L03)");
  }

  // 7. Irreversible steps require an extra confirmation phrase (INV-Plan-4).
  const hasIrreversible = plan.steps.some((s) => !s.reversible);
  if (hasIrreversible) {
    if (deps.confirmationPhrase === undefined || input.confirmation_phrase !== deps.confirmationPhrase) {
      throw new ToolError("E_INPUT_SCHEMA", "this plan contains irreversible steps; the confirmation phrase is required", {
        details: { irreversible_steps: plan.steps.filter((s) => !s.reversible).map((s) => s.order) },
      });
    }
  }

  // 8. Per step, in order, resumable. All gates passed — side effects begin here.
  const signedByOrder = new Map(input.signed_steps.map((s) => [s.order, s.signed_xdr]));
  const results: SubmitResult[] = [];
  for (const step of [...plan.steps].sort((a, b) => a.order - b.order)) {
    if (deps.isStepApplied?.(step) === true) {
      results.push({ order: step.order, status: "skipped", detail: "already applied (idempotent resume)" });
      continue;
    }
    const signed = signedByOrder.get(step.order);
    if (signed === undefined) {
      throw new ToolError("E_INPUT_SCHEMA", `no signed XDR provided for step ${String(step.order)}`);
    }
    const { tx_hash } = await deps.submit(signed, input.transport);
    results.push({ order: step.order, status: "submitted", tx_hash });
  }
  return { results };
}

/** Length-safe constant-time string comparison. */
function constantTimeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
