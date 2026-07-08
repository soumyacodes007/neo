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
        next_step: compile.ok ? "run real allow/deny simulation before install" : "repair only inside GENERATED markers, then compile again",
      };
    }),
  );
}
