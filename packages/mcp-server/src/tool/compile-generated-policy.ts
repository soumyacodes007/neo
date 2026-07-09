import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { NativeCargoSandbox } from "@ozpb/plans";
import { withToolBoundary } from "../tool-boundary.js";
import type { McpToolContext } from "./types.js";

export function registerCompileGeneratedPolicyTool(server: McpServer, _context: McpToolContext): void {
  server.registerTool(
    "ozpb_compile_generated_policy",
    {
      title: "Compile generated policy",
      description: "Compiles a materialized generated policy crate in the native sandbox. Build-only; never deploys.",
      inputSchema: {
        crate_path: z.string().min(1),
        timeout_ms: z.number().int().min(1_000).max(600_000).default(300_000),
      },
    },
    withToolBoundary("ozpb_compile_generated_policy", async (input) => {
      const compile = await new NativeCargoSandbox({ timeoutMs: input.timeout_ms }).compilePolicy(input.crate_path);
      return {
        compile,
        deployment_allowed: false,
        repair_loop: {
          max_attempts: 3,
          allowed_edit_scope: "only between // >>> GENERATED: ... and // <<< GENERATED markers",
          frozen_template_edits_allowed: false,
          diagnostic_count: compile.diagnostics.length,
          errors: compile.diagnostics.filter((d) => d.level === "error").slice(0, 20),
        },
        next_tool: compile.ok ? "ozpb_review_generated_policy" : "ozpb_generate_custom_policy_code or manual fenced repair, then ozpb_compile_generated_policy",
        next_step: compile.ok
          ? "pass this compile result plus a real simulation report hash to ozpb_review_generated_policy"
          : "repair only inside GENERATED markers, then compile again",
      };
    }),
  );
}
