import { describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WalletBridge } from "@ozpb/wallet-bridge";
import { registerOzpbTools } from "./register-tools.js";
import { existingToolManifest } from "./tool-manifest.js";

describe("registerOzpbTools", () => {
  it("registers the core Phase 8 MCP tools without starting stdio", async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    const bridge = registerOzpbTools(server, { bridge: new WalletBridge() });

    expect(bridge).toBeInstanceOf(WalletBridge);
    expect(existingToolManifest).toContain("trace-transaction");
  });
});
