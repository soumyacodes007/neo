import { ToolError, matchPolicies, type CandidateRuleset, type PolicyClassification, type XdrBase64 } from "@ozpb/core";
import { generatePolicyCode, type CodegenResidual, type GeneratedCrate } from "./codegen.js";

export type PolicyAuthoringMode = "compose_existing" | "generate_custom" | "auto";

export interface PolicyAuthoringInput {
  ruleset: CandidateRuleset;
  mode: PolicyAuthoringMode;
  residuals?: CodegenResidual[];
  policyName?: string;
  encodeInstallParams: (classification: PolicyClassification, params: Record<string, unknown>) => XdrBase64;
  knownDeployments?: { classification: PolicyClassification; address: string }[];
}

export interface PolicyAuthoringDraft {
  schema_version: "1";
  mode: PolicyAuthoringMode;
  ruleset: CandidateRuleset;
  composition: {
    existing_policy_bindings: number;
    requires_codegen: string[];
  };
  generation: {
    status: "not_required" | "review_required";
    artifacts: GeneratedCrate[];
    deployment_blocked_until_review: boolean;
  };
  next_step: "simulate" | "review_compile_then_simulate";
}

export function preparePolicyAuthoringDraft(input: PolicyAuthoringInput): PolicyAuthoringDraft {
  const matched = matchPolicies(input.ruleset, {
    encodeInstallParams: input.encodeInstallParams,
    ...(input.knownDeployments !== undefined ? { knownDeployments: input.knownDeployments } : {}),
  });
  const residuals = input.residuals ?? [];
  const requires_codegen = [...new Set([...matched.requires_codegen, ...residuals.map((r) => r.constraint_id)])].sort();

  if (input.mode === "compose_existing" && requires_codegen.length > 0) {
    throw new ToolError("E_C3_UNEXPRESSIBLE", "compose_existing mode refuses residual custom-policy work", {
      details: { requires_codegen },
      suggestion: "switch mode to generate_custom or auto after the user explicitly asks to review custom code",
    });
  }

  const shouldGenerate = input.mode === "generate_custom" || (input.mode === "auto" && residuals.length > 0);
  const artifacts = shouldGenerate
    ? residuals.map((residual, index) => generatePolicyCode({ policyName: `${input.policyName ?? "generated-policy"}-${String(index + 1)}`, residual }))
    : [];

  if (input.mode === "generate_custom" && residuals.length === 0) {
    throw new ToolError("E_C3_UNEXPRESSIBLE", "generate_custom mode requires explicit residual constraints", {
      suggestion: "run match-policies first and pass only the residual constraints that could not be composed",
    });
  }

  return {
    schema_version: "1",
    mode: input.mode,
    ruleset: matched.ruleset,
    composition: {
      existing_policy_bindings: matched.ruleset.rules.reduce((sum, rule) => sum + rule.policy_bindings.filter((b) => b.binding.kind === "existing").length, 0),
      requires_codegen,
    },
    generation: {
      status: artifacts.length > 0 ? "review_required" : "not_required",
      artifacts,
      deployment_blocked_until_review: artifacts.length > 0,
    },
    next_step: artifacts.length > 0 ? "review_compile_then_simulate" : "simulate",
  };
}
