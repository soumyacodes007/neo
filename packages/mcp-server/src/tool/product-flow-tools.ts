import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WalletBridge } from "@ozpb/wallet-bridge";
import { registerCheckPolicyCoverageTool } from "./check-policy-coverage.js";
import { registerDraftPolicyFromRecordingTool } from "./draft-policy-from-recording.js";
import { registerExecuteWithSessionTool } from "./execute-with-session.js";
import { registerExplainPolicyTool } from "./explain-policy.js";
import { registerGenerateCustomPolicyCodeTool } from "./generate-custom-policy-code.js";
import { registerInstallPolicyTool } from "./install-policy.js";
import { registerPrepareActionTool } from "./prepare-action.js";
import { registerRecordTransactionTool } from "./record-transaction.js";
import { registerRequestOwnerApprovalTool } from "./request-owner-approval.js";
import { registerRevokePolicyTool } from "./revoke-policy.js";
import { registerVerifyPolicyTool } from "./verify-policy.js";
import { registerWalletStatusTool } from "./wallet-status.js";
import { SigningStepSchema } from "./product-flow-shared.js";
import type { McpToolContext, RegisterToolModule } from "./types.js";

export { SigningStepSchema };

const productFlowModules: RegisterToolModule[] = [
  registerWalletStatusTool,
  registerPrepareActionTool,
  registerCheckPolicyCoverageTool,
  registerExecuteWithSessionTool,
  registerRequestOwnerApprovalTool,
  registerRecordTransactionTool,
  registerDraftPolicyFromRecordingTool,
  registerGenerateCustomPolicyCodeTool,
  registerVerifyPolicyTool,
  registerExplainPolicyTool,
  registerInstallPolicyTool,
  registerRevokePolicyTool,
];

export function registerProductFlowTools(server: McpServer, bridge: WalletBridge): void {
  const context: McpToolContext = { bridge };
  for (const registerTool of productFlowModules) {
    registerTool(server, context);
  }
}
