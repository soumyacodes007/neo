import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WalletBridge } from "@ozpb/wallet-bridge";
import { registerAssertActionTestnetFixturesTool } from "./assert-action-testnet-fixtures.js";
import { registerAssertTestnetDemoFixtureTool } from "./assert-testnet-demo-fixture.js";
import { registerAuthorPolicyDraftTool } from "./author-policy-draft.js";
import { registerAwaitWalletResultTool } from "./await-wallet-result.js";
import { registerConnectWalletApprovalTool } from "./connect-wallet-approval.js";
import { registerCreateWalletApprovalTool } from "./create-wallet-approval.js";
import { registerCompileGeneratedPolicyTool } from "./compile-generated-policy.js";
import { registerDetectBypassTool } from "./detect-bypass.js";
import { registerExtractAuthContextsTool } from "./extract-auth-contexts.js";
import { registerGenerateTestsTool } from "./generate-tests.js";
import { registerHealthTool } from "./health.js";
import { registerInspectAccountTool } from "./inspect-account.js";
import { registerLookupTransactionsTool } from "./lookup-transactions.js";
import { registerMatchPoliciesTool } from "./match-policies.js";
import { registerMaterializeGeneratedPolicyTool } from "./materialize-generated-policy.js";
import { registerPrepareInstallPlanTool } from "./prepare-install-plan.js";
import { registerRecordEvidenceTool } from "./record-evidence.js";
import { registerReviewGeneratedPolicyTool } from "./review-generated-policy.js";
import { registerRunSimulationTool } from "./run-simulation.js";
import { registerSignPlanApprovalTool } from "./sign-plan-approval.js";
import { registerSubmitSignedXdrTool } from "./submit-signed-xdr.js";
import { registerSynthesizeRulesetTool } from "./synthesize-ruleset.js";
import { registerTraceTransactionTool } from "./trace-transaction.js";
import { registerWorkflowStatusTool } from "./workflow-status.js";
import type { RegisterToolModule } from "./types.js";

const splitToolModules: RegisterToolModule[] = [
  registerHealthTool,
  registerInspectAccountTool,
  registerCreateWalletApprovalTool,
  registerConnectWalletApprovalTool,
  registerSignPlanApprovalTool,
  registerAwaitWalletResultTool,
  registerSubmitSignedXdrTool,
  registerLookupTransactionsTool,
  registerTraceTransactionTool,
  registerExtractAuthContextsTool,
  registerSynthesizeRulesetTool,
  registerMatchPoliciesTool,
  registerGenerateTestsTool,
  registerRunSimulationTool,
  registerDetectBypassTool,
  registerPrepareInstallPlanTool,
  registerAssertActionTestnetFixturesTool,
  registerRecordEvidenceTool,
  registerAuthorPolicyDraftTool,
  registerMaterializeGeneratedPolicyTool,
  registerCompileGeneratedPolicyTool,
  registerReviewGeneratedPolicyTool,
  registerAssertTestnetDemoFixtureTool,
  registerWorkflowStatusTool,
];

export function registerSplitToolModules(server: McpServer, bridge: WalletBridge): void {
  for (const register of splitToolModules) register(server, { bridge });
}
