import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { NativeCargoSandbox, generatePolicyCode, type CodegenResidual } from "@ozpb/plans";
import { withToolBoundary } from "../tool-boundary.js";
import type { McpToolContext } from "./types.js";

export function registerGenerateCustomPolicyCodeTool(server: McpServer, _context: McpToolContext): void {
  server.registerTool(
    "ozpb_generate_custom_policy_code",
    {
      title: "Generate custom policy code",
      description: "Visible C3 step for custom Rust policy generation; optionally compiles an already materialized crate path in the native sandbox.",
      inputSchema: {
        policy_name: z.string().min(1).max(80),
        residual: z.unknown(),
        compile: z.boolean().default(false),
        crate_path: z.string().optional(),
      },
    },
    withToolBoundary("ozpb_generate_custom_policy_code", async (input) => {
      const generated = generatePolicyCode({ policyName: input.policy_name, residual: input.residual as CodegenResidual });
      if (!input.compile) return { generated, compile_status: "not_requested", next_step: "review_files_then_compile_policy" };
      if (input.crate_path === undefined) {
        return { generated, compile_status: "crate_path_required", next_step: "materialize_generated_files_then_call_again_with_crate_path" };
      }
      const compileResult = await new NativeCargoSandbox().compilePolicy(input.crate_path);
      return { generated, compile_status: compileResult.ok ? "passed" : "failed", compile_result: compileResult };
    }),
  );
}
