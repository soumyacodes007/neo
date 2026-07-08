import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { generatePolicyCode, writeGeneratedPolicyWorkspace } from "@ozpb/plans";
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

export function registerMaterializeGeneratedPolicyTool(server: McpServer, _context: McpToolContext): void {
  server.registerTool(
    "ozpb_materialize_generated_policy",
    {
      title: "Materialize generated policy",
      description: "Writes generated custom Rust policy files plus REVIEW.md and codegen_manifest.json. Does not compile, sign, submit, or deploy.",
      inputSchema: {
        policy_name: z.string().min(1).max(80),
        residual: ResidualSchema,
        workspace_dir: z.string().min(1).default(".ozpb/generated"),
      },
    },
    withToolBoundary("ozpb_materialize_generated_policy", async (input) => {
      const generated = generatePolicyCode({ policyName: input.policy_name, residual: input.residual as never });
      const written = await writeGeneratedPolicyWorkspace(generated, input.workspace_dir);
      return {
        generated,
        written,
        next_tool: "ozpb_compile_generated_policy",
        deployment_blocked_until_review: true,
      };
    }),
  );
}
