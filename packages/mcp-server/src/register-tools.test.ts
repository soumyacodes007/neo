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

  it("publishes the 12 product-flow tools for the demo loop", () => {
    expect(existingToolManifest).toEqual(expect.arrayContaining([
      "ozpb_wallet_status",
      "ozpb_prepare_action",
      "ozpb_check_policy_coverage",
      "ozpb_execute_with_session",
      "ozpb_request_owner_approval",
      "ozpb_record_transaction",
      "ozpb_draft_policy_from_recording",
      "ozpb_generate_custom_policy_code",
      "ozpb_verify_policy",
      "ozpb_explain_policy",
      "ozpb_install_policy",
      "ozpb_revoke_policy",
    ]));
  });

  it("publishes split production infra tools that map directly to reusable planner APIs", () => {
    expect(existingToolManifest).toEqual(expect.arrayContaining([
      "ozpb_record_evidence",
      "ozpb_author_policy_draft",
      "ozpb_materialize_generated_policy",
      "ozpb_compile_generated_policy",
      "ozpb_assert_testnet_demo_fixture",
      "ozpb_workflow_status",
    ]));
  });
});
