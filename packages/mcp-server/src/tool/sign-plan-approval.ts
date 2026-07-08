import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CreateSigningRequestInput } from "@ozpb/wallet-bridge";
import { withToolBoundary } from "../tool-boundary.js";
import { DemoActionSchema, NetworkSchema, SignerKindSchema, WalletKitConfigSchema, type McpToolContext } from "./types.js";
import { SigningStepSchema } from "./product-flow-shared.js";

export function registerSignPlanApprovalTool(server: McpServer, context: McpToolContext): void {
  server.registerTool(
    "ozpb_sign_plan_approval",
    {
      title: "Sign plan approval",
      description: "Creates a browser companion approval request for signing an already prepared install/revocation plan.",
      inputSchema: {
        kind: z.enum(["sign_install_plan", "sign_revocation_plan", "sign_one_off_tx"]).default("sign_install_plan"),
        network: NetworkSchema.default("testnet"),
        plan_hash: z.string().length(64).optional(),
        account: z.string().optional(),
        human_summary_markdown: z.string(),
        policy_diff_markdown: z.string().default("No diff supplied."),
        risk_summary_markdown: z.string().default("No risk summary supplied."),
        expected_signer_kind: SignerKindSchema.default("webauthn"),
        wallet_kit: WalletKitConfigSchema.optional(),
        demo_action: DemoActionSchema.optional(),
        steps: z.array(SigningStepSchema).min(1),
      },
    },
    withToolBoundary("ozpb_sign_plan_approval", async (input) => {
      const request: CreateSigningRequestInput = {
        kind: input.kind,
        network: input.network,
        payload: {
          human_summary_markdown: input.human_summary_markdown,
          policy_diff_markdown: input.policy_diff_markdown,
          risk_summary_markdown: input.risk_summary_markdown,
          ...(input.wallet_kit !== undefined ? { wallet_kit: input.wallet_kit } : {}),
          ...(input.demo_action !== undefined ? { demo_action: input.demo_action } : {}),
          expected_signer: {
            signer_kind: input.expected_signer_kind,
            ...(input.account !== undefined ? { account: input.account } : {}),
          },
          steps: input.steps,
        },
        ...(input.plan_hash !== undefined ? { plan_hash: input.plan_hash } : {}),
        ...(input.account !== undefined ? { account: input.account } : {}),
      };
      return context.bridge.createSigningRequest(request);
    }),
  );
}
