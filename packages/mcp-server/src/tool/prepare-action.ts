import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withToolBoundary } from "../tool-boundary.js";
import { NetworkSchema, type McpToolContext } from "./types.js";
import { ProductActionSchema, normalizeProductAction } from "./product-flow-shared.js";

export function registerPrepareActionTool(server: McpServer, _context: McpToolContext): void {
  server.registerTool(
    "ozpb_prepare_action",
    {
      title: "Prepare action",
      description: "Normalizes a user intent into a contract/function/action surface that can be policy-checked and then signed.",
      inputSchema: {
        network: NetworkSchema.default("testnet"),
        action: ProductActionSchema,
      },
    },
    withToolBoundary("ozpb_prepare_action", (input) => {
      const normalized = normalizeProductAction(input.action);
      return {
        network: input.network,
        action: normalized,
        coverage_query: {
          contract: normalized.contract,
          fn: normalized.fn,
          ...(normalized.amount_i128 !== undefined ? { amount_i128: normalized.amount_i128 } : {}),
          ...(normalized.recipient !== undefined ? { recipient: normalized.recipient } : {}),
        },
        adapter_status: normalized.adapter === "native_token" || normalized.adapter === "sep41_token"
          ? "transaction_builder_ready"
          : "adapter_surface_ready_requires_contract_specific_builder",
      };
    }),
  );
}
