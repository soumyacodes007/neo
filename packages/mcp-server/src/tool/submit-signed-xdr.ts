import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { submitSignedXdr } from "@ozpb/stellar";
import { SMART_ACCOUNT_KIT_TESTNET_DEFAULTS } from "@ozpb/wallet-bridge";
import { withToolBoundary } from "../tool-boundary.js";
import type { McpToolContext } from "./types.js";

const testnetDefaults = SMART_ACCOUNT_KIT_TESTNET_DEFAULTS;

export function registerSubmitSignedXdrTool(server: McpServer, _context: McpToolContext): void {
  server.registerTool(
    "ozpb_submit_signed_xdr",
    {
      title: "Submit signed XDR",
      description: "Submits a browser-signed transaction envelope to Stellar RPC and polls final status.",
      inputSchema: {
        signed_xdr: z.string().min(1),
        network_passphrase: z.string().default(testnetDefaults.network_passphrase),
        rpc_url: z.string().url().default(testnetDefaults.rpc_url),
        poll_attempts: z.number().int().min(1).max(60).default(10),
      },
    },
    withToolBoundary("ozpb_submit_signed_xdr", (input) => submitSignedXdr(input)),
  );
}
