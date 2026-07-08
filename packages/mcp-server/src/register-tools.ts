import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WalletBridge } from "@ozpb/wallet-bridge";
import { registerProductFlowTools } from "./tool/product-flow-tools.js";
import { registerSplitToolModules } from "./tool/registry.js";

export interface RegisterOzpbToolsOptions {
  bridge?: WalletBridge;
}

export function registerOzpbTools(server: McpServer, options: RegisterOzpbToolsOptions = {}): WalletBridge {
  const bridge = options.bridge ?? new WalletBridge();

  registerProductFlowTools(server, bridge);
  registerSplitToolModules(server, bridge);

  return bridge;
}
