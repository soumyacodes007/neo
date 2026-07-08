import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { submitSignedXdr } from "@ozpb/stellar";
import { SMART_ACCOUNT_KIT_TESTNET_DEFAULTS, checkPolicyCoverage } from "@ozpb/wallet-bridge";
import { withToolBoundary } from "../tool-boundary.js";
import type { McpToolContext } from "./types.js";
import { CoveragePatternSchema } from "./product-flow-shared.js";

const testnetDefaults = SMART_ACCOUNT_KIT_TESTNET_DEFAULTS;

export function registerExecuteWithSessionTool(server: McpServer, _context: McpToolContext): void {
  server.registerTool(
    "ozpb_execute_with_session",
    {
      title: "Execute with session",
      description: "Submits a session-signed XDR only if coverage says the action is covered; otherwise returns an owner-approval fallback.",
      inputSchema: {
        action: z.object({
          contract: z.string(),
          fn: z.string(),
          amount_i128: z.string().optional(),
          recipient: z.string().optional(),
        }),
        installed: z.array(CoveragePatternSchema),
        current_ledger: z.number().int().optional(),
        signed_xdr: z.string().optional(),
        network_passphrase: z.string().default(testnetDefaults.network_passphrase),
        rpc_url: z.string().url().default(testnetDefaults.rpc_url),
      },
    },
    withToolBoundary("ozpb_execute_with_session", async (input) => {
      const coverage = checkPolicyCoverage({
        action: input.action,
        installed: input.installed,
        ...(input.current_ledger !== undefined ? { current_ledger: input.current_ledger } : {}),
      });
      if (!coverage.covered) return { status: "fallback_required", reason: coverage.reason, next_tool: "ozpb_request_owner_approval" };
      if (input.signed_xdr === undefined) {
        return {
          status: "ready_for_session_signature",
          coverage,
          next_step: "sign this action with the scoped Ed25519/session signer, then call this tool with signed_xdr",
        };
      }
      try {
        return {
          status: "submitted",
          coverage,
          submit: await submitSignedXdr({
            signed_xdr: input.signed_xdr,
            network_passphrase: input.network_passphrase,
            rpc_url: input.rpc_url,
          }),
        };
      } catch (error) {
        return {
          status: "fallback_required",
          reason: "session_execution_failed",
          error: error instanceof Error ? error.message : String(error),
          next_tool: "ozpb_request_owner_approval",
          recovery: "refresh wallet_status and check_policy_coverage before asking the owner to approve",
        };
      }
    }),
  );
}
