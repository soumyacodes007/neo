import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PolicyClassification } from "@ozpb/core";
import { encodeInstallParams } from "@ozpb/stellar";
import { SMART_ACCOUNT_KIT_TESTNET_DEFAULTS } from "@ozpb/wallet-bridge";
import { withToolBoundary } from "../tool-boundary.js";
import { InstallActionSchema, NetworkSchema, WalletKitConfigSchema, type McpToolContext } from "./types.js";

const DeploymentSchema = z.object({
  classification: z.string(),
  address: z.string(),
  wasm_hash: z.string().optional(),
});

const DeploymentsFileSchema = z.object({
  deployments: z.array(DeploymentSchema),
});

const CommonSchema = z.object({
  network: NetworkSchema.default("testnet"),
  account: z.string().min(1),
  session_signer_public_key_hex: z.string().regex(/^[0-9a-f]+$/iu),
  owner_credential_id: z.string().optional(),
  valid_until_ledger: z.number().int().min(1),
  wallet_kit: WalletKitConfigSchema.optional(),
  pb_deployments_path: z.string().min(1).default("fixtures/testnet/pb-policy-deployments.json"),
});

const XlmProfileSchema = CommonSchema.extend({
  profile: z.literal("xlm_transfer"),
  token_contract: z.string().min(1).default(SMART_ACCOUNT_KIT_TESTNET_DEFAULTS.native_token_contract ?? ""),
  recipient: z.string().min(1),
  amount_i128: z.string().regex(/^\d+$/u),
  rule_name: z.string().min(1).max(20).optional(),
});

const BlendProfileSchema = CommonSchema.extend({
  profile: z.literal("blend_submit"),
  pool_contract: z.string().min(1),
  reserve_contract: z.string().min(1),
  amount_i128: z.string().regex(/^\d+$/u),
  period_ledgers: z.number().int().min(1).default(17_280),
  pool_rule_name: z.string().min(1).max(20).optional(),
  token_rule_name: z.string().min(1).max(20).optional(),
});

type PreparedInstallAction = z.infer<typeof InstallActionSchema>;
const InputSchema = z.discriminatedUnion("profile", [XlmProfileSchema, BlendProfileSchema]);

export function registerPrepareSessionPolicyInstallTool(server: McpServer, _context: McpToolContext): void {
  server.registerTool(
    "ozpb_prepare_session_policy_install",
    {
      title: "Prepare session policy install",
      description: "Builds concrete install actions for the production XLM and Blend demo profiles. It does not sign or submit.",
      inputSchema: InputSchema,
    },
    withToolBoundary("ozpb_prepare_session_policy_install", async (rawInput) => {
      const input = InputSchema.parse(rawInput);
      const walletKit = input.wallet_kit ?? SMART_ACCOUNT_KIT_TESTNET_DEFAULTS;
      if (!walletKit.ed25519_verifier_address) throw new Error("wallet_kit.ed25519_verifier_address is required");
      const deployments = await loadDeployments(input.pb_deployments_path);
      const actions = input.profile === "xlm_transfer"
        ? [buildXlmAction(input, walletKit.ed25519_verifier_address, deployments)]
        : buildBlendActions(input, walletKit.ed25519_verifier_address, deployments);
      return {
        profile: input.profile,
        network: input.network,
        account: input.account,
        install_actions: actions,
        install_requests: actions.map((action) => ({
          tool: "ozpb_install_policy",
          input: {
            network: input.network,
            account: input.account,
            plan_hash: planHash(action),
            human_summary_markdown: summaryFor(action, input.profile),
            policy_diff_markdown: policyDiff(action),
            risk_summary_markdown: riskSummary(input.profile),
            wallet_kit: walletKit,
            ...(input.owner_credential_id !== undefined ? { owner_credential_id: input.owner_credential_id } : {}),
            install_action: action,
            steps: [{
              order: 1,
              step_hash: `install:${action.rule_name}:${planHash(action).slice(0, 16)}`,
              unsigned_xdr: `smart-account-kit:add_context_rule:${action.rule_name}`,
              description: `Owner approval installs ${action.rule_name}.`,
              network_passphrase: walletKit.network_passphrase,
              auth_requirements: [],
            }],
          },
        })),
        session_signer: {
          verifier: walletKit.ed25519_verifier_address,
          public_key_hex: input.session_signer_public_key_hex,
        },
        next_steps: [
          "Run ozpb_prepare_verification_profile with run=true for each returned verifier profile.",
          "Only after all verifier reports are all_green, call ozpb_install_policy for each install_request.",
          "After install, use ozpb_execute_with_session for matching actions and route non-matching actions to ozpb_request_owner_approval.",
        ],
        deployment_source: input.pb_deployments_path,
      };
    }),
  );
}

function buildXlmAction(
  input: z.infer<typeof XlmProfileSchema>,
  verifier: string,
  deployments: Map<string, z.infer<typeof DeploymentSchema>>,
): PreparedInstallAction {
  const allow = deployment(deployments, "pb:function_allowlist");
  const arg = deployment(deployments, "pb:arg_guard");
  return {
    kind: "session_rule",
    account: input.account,
    ...(input.owner_credential_id !== undefined ? { owner_credential_id: input.owner_credential_id } : {}),
    target_contract: input.token_contract,
    rule_name: input.rule_name ?? "ozpb-xlm-transfer",
    valid_until_ledger: input.valid_until_ledger,
    session_signer: { verifier, public_key_hex: input.session_signer_public_key_hex },
    policies: {
      custom: [
        custom(allow, { functions: ["transfer"] }),
        custom(arg, {
          rules: [
            { fnName: "transfer", argIndex: 0, path: [], pred: { kind: "addr_eq", address: input.account }, forall: false },
            { fnName: "transfer", argIndex: 1, path: [], pred: { kind: "addr_eq", address: input.recipient }, forall: false },
            { fnName: "transfer", argIndex: 2, path: [], pred: { kind: "range", min: "0", max: input.amount_i128 }, forall: false },
          ],
        }),
      ],
    },
  };
}

function buildBlendActions(
  input: z.infer<typeof BlendProfileSchema>,
  verifier: string,
  deployments: Map<string, z.infer<typeof DeploymentSchema>>,
): PreparedInstallAction[] {
  const allow = deployment(deployments, "pb:function_allowlist");
  const arg = deployment(deployments, "pb:arg_guard");
  const cap = deployment(deployments, "pb:call_cap");
  return [
    {
      kind: "session_rule",
      account: input.account,
      ...(input.owner_credential_id !== undefined ? { owner_credential_id: input.owner_credential_id } : {}),
      target_contract: input.pool_contract,
      rule_name: input.pool_rule_name ?? "ozpb-blend-pool",
      valid_until_ledger: input.valid_until_ledger,
      session_signer: { verifier, public_key_hex: input.session_signer_public_key_hex },
      policies: {
        custom: [
          custom(allow, { functions: ["submit"] }),
          custom(arg, {
            rules: [
              { fnName: "submit", argIndex: 0, path: [], pred: { kind: "addr_eq", address: input.account }, forall: false },
              { fnName: "submit", argIndex: 1, path: [], pred: { kind: "addr_eq", address: input.account }, forall: false },
              { fnName: "submit", argIndex: 2, path: [], pred: { kind: "addr_eq", address: input.account }, forall: false },
              { fnName: "submit", argIndex: 3, path: [{ kind: "wildcard" }, { kind: "field", name: "request_type" }], pred: { kind: "u32_in", values: [2] }, forall: true },
              { fnName: "submit", argIndex: 3, path: [{ kind: "wildcard" }, { kind: "field", name: "address" }], pred: { kind: "addr_eq", address: input.reserve_contract }, forall: true },
            ],
          }),
          custom(cap, {
            cap: input.amount_i128,
            periodLedgers: input.period_ledgers,
            fnName: "submit",
            amountPath: [{ kind: "index", index: 3 }, { kind: "wildcard" }, { kind: "field", name: "amount" }],
            tokenFilterPath: [{ kind: "index", index: 3 }, { kind: "wildcard" }, { kind: "field", name: "address" }],
            tokenFilterToken: input.reserve_contract,
          }),
        ],
      },
    },
    {
      kind: "session_rule",
      account: input.account,
      ...(input.owner_credential_id !== undefined ? { owner_credential_id: input.owner_credential_id } : {}),
      target_contract: input.reserve_contract,
      rule_name: input.token_rule_name ?? "ozpb-blend-token",
      valid_until_ledger: input.valid_until_ledger,
      session_signer: { verifier, public_key_hex: input.session_signer_public_key_hex },
      policies: {
        custom: [
          custom(allow, { functions: ["transfer"] }),
          custom(arg, {
            rules: [
              { fnName: "transfer", argIndex: 0, path: [], pred: { kind: "addr_eq", address: input.account }, forall: false },
              { fnName: "transfer", argIndex: 1, path: [], pred: { kind: "addr_eq", address: input.pool_contract }, forall: false },
            ],
          }),
          custom(cap, {
            cap: input.amount_i128,
            periodLedgers: input.period_ledgers,
            fnName: "transfer",
            amountPath: [{ kind: "index", index: 2 }],
          }),
        ],
      },
    },
  ];
}

async function loadDeployments(filePath: string): Promise<Map<string, z.infer<typeof DeploymentSchema>>> {
  const parsed = DeploymentsFileSchema.parse(JSON.parse(await readFile(filePath, "utf8")));
  return new Map(parsed.deployments.map((d) => [d.classification, d]));
}

function deployment(map: Map<string, z.infer<typeof DeploymentSchema>>, classification: PolicyClassification): z.infer<typeof DeploymentSchema> {
  const found = map.get(classification);
  if (found === undefined) throw new Error(`missing ${classification} in pb deployment registry`);
  return found;
}

function custom(deploymentEntry: z.infer<typeof DeploymentSchema>, installParams: Record<string, unknown>) {
  return {
    address: deploymentEntry.address,
    classification: deploymentEntry.classification,
    params_xdr_b64: encodeInstallParams(deploymentEntry.classification as PolicyClassification, installParams),
  };
}

function planHash(action: PreparedInstallAction): string {
  return createHash("sha256").update(JSON.stringify(action)).digest("hex");
}

function summaryFor(action: PreparedInstallAction, profile: "xlm_transfer" | "blend_submit"): string {
  return `Install ${profile === "xlm_transfer" ? "XLM transfer" : "Blend"} session rule "${action.rule_name}" on ${action.account}.`;
}

function policyDiff(action: PreparedInstallAction): string {
  const policies = action.policies?.custom ?? [];
  return [
    `Target contract: ${action.target_contract}`,
    `Valid until ledger: ${String(action.valid_until_ledger)}`,
    ...policies.map((p) => `Attach ${p.classification} at ${p.address}.`),
  ].join("\n");
}

function riskSummary(profile: "xlm_transfer" | "blend_submit"): string {
  return profile === "xlm_transfer"
    ? "Owner approval grants the Ed25519 session key transfer-only access for the exact sender, recipient, and amount ceiling."
    : "Owner approval grants the Ed25519 session key only the paired Blend pool submit and reserve-token transfer contexts.";
}
