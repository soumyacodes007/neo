import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CandidateRuleset } from "@ozpb/core";
import { preparePolicyAuthoringDraft } from "@ozpb/plans";
import { encodeInstallParams } from "@ozpb/stellar";
import { withToolBoundary } from "../tool-boundary.js";
import type { McpToolContext } from "./types.js";

const ResidualSchema = z.union([
  z.object({
    kind: z.literal("cross_arg_lt"),
    constraint_id: z.string(),
    fn_name: z.string(),
    left_index: z.number().int().min(0),
    right_index: z.number().int().min(0),
  }),
  z.object({
    kind: z.literal("context_guard"),
    constraint_id: z.string(),
    fn_name: z.string(),
    checks: z.array(z.union([
      z.object({ kind: z.literal("arg_i128_range"), arg_index: z.number().int().min(0), min: z.string().regex(/^-?\d+$/), max: z.string().regex(/^-?\d+$/) }),
      z.object({ kind: z.literal("arg_u32_eq"), arg_index: z.number().int().min(0), value: z.number().int().min(0) }),
      z.object({
        kind: z.literal("cross_arg_compare"),
        left_index: z.number().int().min(0),
        op: z.enum(["lt", "lte", "gt", "gte", "eq"]),
        right_index: z.number().int().min(0),
      }),
    ])).min(1),
  }),
]);

export function registerAuthorPolicyDraftTool(server: McpServer, _context: McpToolContext): void {
  server.registerTool(
    "ozpb_author_policy_draft",
    {
      title: "Author policy draft",
      description: "Creates an explicit compose-existing or generate-custom policy authoring draft. Custom code is review-gated.",
      inputSchema: {
        ruleset: z.unknown(),
        mode: z.enum(["compose_existing", "generate_custom", "auto"]).default("compose_existing"),
        residuals: z.array(ResidualSchema).optional(),
        policy_name: z.string().min(1).max(80).optional(),
        known_deployments: z.array(z.object({ classification: z.string(), address: z.string() })).optional(),
      },
    },
    withToolBoundary("ozpb_author_policy_draft", (input) => preparePolicyAuthoringDraft({
      ruleset: CandidateRuleset.parse(input.ruleset),
      mode: input.mode,
      encodeInstallParams,
      ...(input.residuals !== undefined ? { residuals: input.residuals as never } : {}),
      ...(input.policy_name !== undefined ? { policyName: input.policy_name } : {}),
      ...(input.known_deployments !== undefined ? { knownDeployments: input.known_deployments as never } : {}),
    })),
  );
}
