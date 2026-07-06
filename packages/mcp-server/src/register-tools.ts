import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  AccountSnapshot,
  BypassReport,
  CandidateRuleset,
  PolicyIntent,
  RiskReport,
  SimulationReport,
  TestCase,
  canonicalHash,
  generateTests,
  matchPolicies,
  synthesizeRuleset,
} from "@ozpb/core";
import {
  RpcClient,
  encodeInstallParams,
  extractAuthContexts,
  submitSignedXdr,
  traceTransaction,
} from "@ozpb/stellar";
import { detectBypass, explainPolicy, ForkHarnessEngine, prepareInstallPlan, runSimulation, type SimulationEngine } from "@ozpb/plans";
import { SMART_ACCOUNT_KIT_TESTNET_DEFAULTS, WalletBridge, checkPolicyCoverage } from "@ozpb/wallet-bridge";
import type { CreateSigningRequestInput } from "@ozpb/wallet-bridge";
import { withToolBoundary } from "./tool-boundary.js";
import { existingToolManifest } from "./tool-manifest.js";

const Network = z.enum(["testnet", "mainnet"]);
const SignerKind = z.enum(["webauthn", "ed25519", "delegated"]);
const testnetDefaults = SMART_ACCOUNT_KIT_TESTNET_DEFAULTS;
type NetworkName = z.infer<typeof Network>;

const WalletKitConfigSchema = z.object({
  rpc_url: z.string().url().default(testnetDefaults.rpc_url),
  network_passphrase: z.string().default(testnetDefaults.network_passphrase),
  account_wasm_hash: z.string().default(testnetDefaults.account_wasm_hash),
  webauthn_verifier_address: z.string().default(testnetDefaults.webauthn_verifier_address),
  native_token_contract: z.string().optional().default(testnetDefaults.native_token_contract ?? ""),
  ed25519_verifier_address: z.string().optional().default(testnetDefaults.ed25519_verifier_address ?? ""),
  threshold_policy_address: z.string().optional().default(testnetDefaults.threshold_policy_address ?? ""),
  spending_limit_policy_address: z.string().optional().default(testnetDefaults.spending_limit_policy_address ?? ""),
  weighted_threshold_policy_address: z.string().optional().default(testnetDefaults.weighted_threshold_policy_address ?? ""),
  relayer_url: z.string().optional().default(""),
  rp_name: z.string().optional().default(testnetDefaults.rp_name ?? "OZ Policy Builder"),
});

const DemoActionSchema = z.object({
  kind: z.literal("xlm_transfer"),
  token_contract: z.string().default(testnetDefaults.native_token_contract ?? ""),
  recipient: z.string().min(1),
  amount_xlm: z.number().positive(),
});

const SigningStepSchema = z.object({
  order: z.number().int().min(1),
  step_hash: z.string().min(1),
  unsigned_xdr: z.string().min(1),
  description: z.string(),
  network_passphrase: z.string(),
  auth_requirements: z.array(z.unknown()).default([]),
});

class JsonRpcBackend {
  constructor(private readonly url: string) {}

  async call(method: string, params: unknown): Promise<Record<string, unknown>> {
    const response = await fetch(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const json = await response.json() as { result?: Record<string, unknown>; error?: unknown };
    if (json.error !== undefined) throw new Error(`${method} failed: ${JSON.stringify(json.error)}`);
    return json.result ?? {};
  }

  async getLatestLedger(): Promise<{ sequence: number; protocolVersion: number; id: string }> {
    const r = await this.call("getLatestLedger", {});
    return {
      sequence: Number(r["sequence"]),
      protocolVersion: Number(r["protocolVersion"]),
      id: typeof r["id"] === "string" ? r["id"] : "",
    };
  }

  async getLedgerEntries(keysB64: string[]): Promise<{ latestLedger: number; entries: { keyB64: string; xdrB64: string; liveUntilLedgerSeq?: number }[] }> {
    const r = await this.call("getLedgerEntries", { keys: keysB64 });
    const entriesValue = r["entries"];
    const entries = Array.isArray(entriesValue) ? entriesValue : [];
    return {
      latestLedger: Number(r["latestLedger"]),
      entries: entries
        .filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null)
        .map((entry) => ({
          keyB64: String(entry["key"]),
          xdrB64: String(entry["xdr"]),
          ...(entry["liveUntilLedgerSeq"] !== undefined ? { liveUntilLedgerSeq: Number(entry["liveUntilLedgerSeq"]) } : {}),
        })),
    };
  }

  async getTransaction(hash: string): Promise<{
    status: "SUCCESS" | "FAILED" | "NOT_FOUND";
    ledger?: number;
    createdAt?: number;
    envelopeXdr?: string;
    resultXdr?: string;
    resultMetaXdr?: string;
  }> {
    const r = await this.call("getTransaction", { hash });
    if (r["status"] === "NOT_FOUND") return { status: "NOT_FOUND" };
    const status = r["status"] === "FAILED" ? "FAILED" : "SUCCESS";
    return {
      status,
      ...(typeof r["ledger"] === "number" ? { ledger: r["ledger"] } : {}),
      ...(typeof r["createdAt"] === "number" ? { createdAt: r["createdAt"] } : {}),
      ...(typeof r["envelopeXdr"] === "string" ? { envelopeXdr: r["envelopeXdr"] } : {}),
      ...(typeof r["resultXdr"] === "string" ? { resultXdr: r["resultXdr"] } : {}),
      ...(typeof r["resultMetaXdr"] === "string" ? { resultMetaXdr: r["resultMetaXdr"] } : {}),
    };
  }

  async getTransactions(params: { startLedger: number; cursor?: string; limit: number }): Promise<{
    transactions: { hash: string; ledger: number; createdAt: number; envelopeXdr: string; resultXdr?: string; resultMetaXdr?: string }[];
    cursor: string | undefined;
    latestLedger: number;
    oldestLedger: number;
  }> {
    const r = await this.call("getTransactions", params);
    const transactionsValue = r["transactions"];
    const transactions = Array.isArray(transactionsValue) ? transactionsValue : [];
    return {
      transactions: transactions
        .filter((tx): tx is Record<string, unknown> => typeof tx === "object" && tx !== null)
        .map((tx) => ({
          hash: String(tx["hash"]),
          ledger: Number(tx["ledger"]),
          createdAt: Number(tx["createdAt"]),
          envelopeXdr: String(tx["envelopeXdr"]),
          ...(typeof tx["resultXdr"] === "string" ? { resultXdr: tx["resultXdr"] } : {}),
          ...(typeof tx["resultMetaXdr"] === "string" ? { resultMetaXdr: tx["resultMetaXdr"] } : {}),
        })),
      cursor: typeof r["cursor"] === "string" ? r["cursor"] : undefined,
      latestLedger: Number(r["latestLedger"] ?? 0),
      oldestLedger: Number(r["oldestLedger"] ?? params.startLedger),
    };
  }
}

function rpcClient(rpcUrl: string): RpcClient {
  return RpcClient.create(new JsonRpcBackend(rpcUrl), { budget: 500 });
}

export interface RegisterOzpbToolsOptions {
  bridge?: WalletBridge;
}

export function registerOzpbTools(server: McpServer, options: RegisterOzpbToolsOptions = {}): WalletBridge {
  const bridge = options.bridge ?? new WalletBridge();

  server.registerTool(
    "ozpb_health",
    {
      title: "OZ Policy Builder health",
      description: "Reports MCP server health and the deterministic tool manifest.",
      inputSchema: {},
    },
    withToolBoundary("ozpb_health", () => ({
      status: "ok",
      tools: existingToolManifest,
      wallet_bridge: "available",
    })),
  );

  server.registerTool(
    "ozpb_create_wallet_approval",
    {
      title: "Create wallet approval",
      description: "Creates a browser companion approval request for creating or connecting an OZ smart account.",
      inputSchema: {
        network: Network.default("testnet"),
        owner_signer_kind: SignerKind.default("webauthn"),
        wallet_kit: WalletKitConfigSchema.default(testnetDefaults),
      },
    },
    withToolBoundary("ozpb_create_wallet_approval", async (input) => {
      const request: CreateSigningRequestInput = {
        kind: "create_wallet",
        network: input.network,
        payload: {
          human_summary_markdown: "Create or connect an OpenZeppelin Stellar smart account.",
          policy_diff_markdown: "No policy grant is installed by wallet creation.",
          risk_summary_markdown: "The owner key remains in the browser/passkey wallet. The MCP receives public account metadata only.",
          wallet_kit: input.wallet_kit,
          expected_signer: { signer_kind: input.owner_signer_kind },
          steps: [{
            order: 1,
            step_hash: "wallet_deploy",
            unsigned_xdr: "smart-account-kit:create_wallet",
            description: "Deploy the OZ smart account controlled by this browser passkey.",
            network_passphrase: input.wallet_kit.network_passphrase,
            auth_requirements: [],
          }],
        },
      };
      return bridge.createSigningRequest(request);
    }),
  );

  server.registerTool(
    "ozpb_connect_wallet_approval",
    {
      title: "Connect wallet approval",
      description: "Creates a browser companion approval request for connecting an existing OZ smart account.",
      inputSchema: {
        network: Network.default("testnet"),
        wallet_kit: WalletKitConfigSchema.default(testnetDefaults),
      },
    },
    withToolBoundary("ozpb_connect_wallet_approval", async (input) => bridge.createSigningRequest({
      kind: "connect_wallet",
      network: input.network,
      payload: {
        human_summary_markdown: "Connect an existing OpenZeppelin Stellar smart account.",
        policy_diff_markdown: "No policy grant is installed by wallet connection.",
        risk_summary_markdown: "The owner key remains in the browser/passkey wallet. The MCP receives public account metadata only.",
        wallet_kit: input.wallet_kit,
        expected_signer: { signer_kind: "webauthn" },
        steps: [],
      },
    })),
  );

  server.registerTool(
    "ozpb_sign_plan_approval",
    {
      title: "Sign plan approval",
      description: "Creates a browser companion approval request for signing an already prepared install/revocation plan.",
      inputSchema: {
        kind: z.enum(["sign_install_plan", "sign_revocation_plan", "sign_one_off_tx"]).default("sign_install_plan"),
        network: Network.default("testnet"),
        plan_hash: z.string().length(64).optional(),
        account: z.string().optional(),
        human_summary_markdown: z.string(),
        policy_diff_markdown: z.string().default("No diff supplied."),
        risk_summary_markdown: z.string().default("No risk summary supplied."),
        expected_signer_kind: SignerKind.default("webauthn"),
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
      return bridge.createSigningRequest(request);
    }),
  );

  server.registerTool(
    "ozpb_await_wallet_result",
    {
      title: "Await wallet result",
      description: "Waits for a browser companion approval request to be completed or rejected.",
      inputSchema: {
        sid: z.string().min(1),
        timeout_ms: z.number().int().min(1).max(10 * 60 * 1000).default(10 * 60 * 1000),
      },
    },
    withToolBoundary("ozpb_await_wallet_result", async (input) => {
      const request = await bridge.waitForResult(input.sid, input.timeout_ms);
      return {
        sid: request.sid,
        status: request.status,
        result: request.result,
      };
    }),
  );

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

  server.registerTool(
    "ozpb_lookup_transactions",
    {
      title: "Lookup transactions",
      description: "Looks up real Stellar RPC transactions by hash. Contract-window lookup requires a deep-history provider and is intentionally not emulated.",
      inputSchema: {
        rpc_url: z.string().url().default(testnetDefaults.rpc_url),
        hashes: z.array(z.string().length(64)).min(1),
      },
    },
    withToolBoundary("ozpb_lookup_transactions", async (input) => {
      const backend = new JsonRpcBackend(input.rpc_url);
      const records = [];
      for (const hash of input.hashes) {
        const tx = await backend.getTransaction(hash);
        records.push({
          hash,
          found: tx.status !== "NOT_FOUND",
          status: tx.status,
          ledger: tx.ledger ?? 0,
          provider: "rpc",
        });
      }
      return {
        records,
        window_covered: undefined,
        providers_used: ["rpc"],
        partial: records.some((record) => !record.found),
      };
    }),
  );

  server.registerTool(
    "ozpb_trace_transaction",
    {
      title: "Trace transaction",
      description: "Traces a real on-chain transaction by hash through the deterministic recorder.",
      inputSchema: {
        rpc_url: z.string().url().default(testnetDefaults.rpc_url),
        network: Network.default("testnet"),
        tx_hash: z.string().length(64),
      },
    },
    withToolBoundary("ozpb_trace_transaction", async (input) => traceTransaction(
      { source: { tx_hash: input.tx_hash } },
      { rpc: rpcClient(input.rpc_url), network: input.network as NetworkName, now: () => new Date().toISOString() },
    )),
  );

  server.registerTool(
    "ozpb_extract_auth_contexts",
    {
      title: "Extract auth contexts",
      description: "Extracts positive or negative authorization-context evidence from decoded transaction traces.",
      inputSchema: {
        account: z.string(),
        polarity: z.enum(["positive", "negative"]).default("positive"),
        traces: z.array(z.unknown()).min(1),
      },
    },
    withToolBoundary("ozpb_extract_auth_contexts", (input) => extractAuthContexts(input as Parameters<typeof extractAuthContexts>[0])),
  );

  server.registerTool(
    "ozpb_synthesize_ruleset",
    {
      title: "Synthesize ruleset",
      description: "Synthesizes a candidate context-rule/policy ruleset from a normalized intent and optional evidence.",
      inputSchema: {
        intent: z.unknown(),
        evidence: z.unknown().optional(),
        snapshot_hash: z.string().length(64).optional(),
        current_ledger: z.number().int(),
      },
    },
    withToolBoundary("ozpb_synthesize_ruleset", (input) => {
      const intent = PolicyIntent.parse(input.intent);
      return synthesizeRuleset(
        {
          intent,
          intentHash: canonicalHash(intent as never),
          ...(input.snapshot_hash !== undefined ? { snapshotHash: input.snapshot_hash } : {}),
          ...(input.evidence !== undefined ? { evidence: input.evidence as never } : {}),
        },
        { currentLedger: input.current_ledger },
      );
    }),
  );

  server.registerTool(
    "ozpb_match_policies",
    {
      title: "Match policies",
      description: "Composes known OZ/pb policy primitives for a synthesized ruleset and marks remaining constraints for codegen.",
      inputSchema: {
        ruleset: z.unknown(),
      },
    },
    withToolBoundary("ozpb_match_policies", (input) => matchPolicies(CandidateRuleset.parse(input.ruleset), { encodeInstallParams })),
  );

  server.registerTool(
    "ozpb_generate_tests",
    {
      title: "Generate tests",
      description: "Generates deterministic permit/deny test cases for a synthesized ruleset.",
      inputSchema: {
        ruleset: z.unknown(),
        allow_coverage_gaps: z.boolean().default(false),
      },
    },
    withToolBoundary("ozpb_generate_tests", (input) => generateTests(
      { ruleset: CandidateRuleset.parse(input.ruleset) },
      { allowCoverageGaps: input.allow_coverage_gaps },
    )),
  );

  server.registerTool(
    "ozpb_run_simulation",
    {
      title: "Run simulation",
      description: "Runs generated cases through either the deterministic fake engine or the Rust fork harness.",
      inputSchema: {
        ruleset: z.unknown(),
        cases: z.array(z.unknown()),
        engine: z.enum(["fake", "fork"]).default("fake"),
        fake_outcome: z.enum(["pass", "fail", "error", "skipped"]).default("pass"),
        fork: z.object({
          account: z.string().optional(),
          rule: z.object({
            id: z.number().int(),
            target_contract: z.string(),
            valid_until: z.number().int().optional(),
          }),
          policies: z.array(z.unknown()),
          snapshot_path: z.string().optional(),
          snapshot: z.object({
            addresses: z.array(z.string()).min(1),
            ledger: z.number().int().optional(),
            network: z.string().optional(),
            archive_url: z.string().optional(),
            rpc_url: z.string().url().optional(),
            network_passphrase: z.string().optional(),
            stellar_bin: z.string().optional(),
          }).optional(),
          harness_manifest_path: z.string().optional(),
          command: z.string().optional(),
        }).optional(),
      },
    },
    withToolBoundary("ozpb_run_simulation", async (input) => {
      const cases = input.cases.map((testCase) => TestCase.parse(testCase));
      const parsedRuleset = CandidateRuleset.parse(input.ruleset);
      const forkRule = input.fork?.rule === undefined
        ? { id: 1, target_contract: parsedRuleset.account }
        : {
          id: input.fork.rule.id,
          target_contract: input.fork.rule.target_contract,
          ...(input.fork.rule.valid_until !== undefined ? { valid_until: input.fork.rule.valid_until } : {}),
        };
      const engine: SimulationEngine = input.engine === "fork"
        ? new ForkHarnessEngine({
          ...(input.fork?.account !== undefined ? { account: input.fork.account } : {}),
          rule: forkRule,
          policies: (input.fork?.policies ?? []) as never,
          ...(input.fork?.snapshot_path !== undefined ? { snapshotPath: input.fork.snapshot_path } : {}),
          ...(input.fork?.snapshot !== undefined ? {
            snapshot: {
              addresses: input.fork.snapshot.addresses,
              ...(input.fork.snapshot.ledger !== undefined ? { ledger: input.fork.snapshot.ledger } : {}),
              ...(input.fork.snapshot.network !== undefined ? { network: input.fork.snapshot.network } : {}),
              ...(input.fork.snapshot.archive_url !== undefined ? { archiveUrl: input.fork.snapshot.archive_url } : {}),
              ...(input.fork.snapshot.rpc_url !== undefined ? { rpcUrl: input.fork.snapshot.rpc_url } : {}),
              ...(input.fork.snapshot.network_passphrase !== undefined ? { networkPassphrase: input.fork.snapshot.network_passphrase } : {}),
              ...(input.fork.snapshot.stellar_bin !== undefined ? { stellarBin: input.fork.snapshot.stellar_bin } : {}),
            },
          } : {}),
          ...(input.fork?.harness_manifest_path !== undefined ? { harnessManifestPath: input.fork.harness_manifest_path } : {}),
          ...(input.fork?.command !== undefined ? { command: input.fork.command } : {}),
        })
        : {
          engine: "unit",
          toolchainFingerprint: `mcp-fake:${input.fake_outcome}`,
          async run(testCases) {
            return testCases.map((testCase) => ({
              case_id: testCase.id,
              outcome: input.fake_outcome,
              detail: input.fake_outcome === "pass" ? "deterministic MCP fake engine" : "forced fake outcome",
            }));
          },
        };
      return runSimulation({ ruleset: parsedRuleset, cases, engines: [engine] });
    }),
  );

  server.registerTool(
    "ozpb_detect_bypass",
    {
      title: "Detect bypass",
      description: "Runs static bypass detection against a candidate ruleset and account snapshot.",
      inputSchema: {
        ruleset: z.unknown(),
        account_snapshot: z.unknown(),
      },
    },
    withToolBoundary("ozpb_detect_bypass", (input) => detectBypass({
      ruleset: CandidateRuleset.parse(input.ruleset),
      accountSnapshot: AccountSnapshot.parse(input.account_snapshot),
    })),
  );

  server.registerTool(
    "ozpb_explain_policy",
    {
      title: "Explain policy",
      description: "Renders deterministic human-readable policy explanation and risk report.",
      inputSchema: {
        ruleset: z.unknown(),
        account_snapshot: z.unknown().optional(),
        bypass_report: z.unknown().optional(),
        now_ledger: z.number().int().optional(),
      },
    },
    withToolBoundary("ozpb_explain_policy", (input) => explainPolicy({
      ruleset: CandidateRuleset.parse(input.ruleset),
      ...(input.account_snapshot !== undefined ? { accountSnapshot: AccountSnapshot.parse(input.account_snapshot) } : {}),
      ...(input.bypass_report !== undefined ? { bypassReport: BypassReport.parse(input.bypass_report) } : {}),
      ...(input.now_ledger !== undefined ? { nowLedger: input.now_ledger } : {}),
    })),
  );

  server.registerTool(
    "ozpb_prepare_install_plan",
    {
      title: "Prepare install plan",
      description: "Prepares unsigned install-plan XDR after verification artifacts are green and hash-matched.",
      inputSchema: {
        ruleset: z.unknown(),
        account_snapshot: z.unknown(),
        simulation_report: z.unknown(),
        bypass_report: z.unknown(),
        risk_report: z.unknown(),
        current_ledger: z.number().int(),
        policy_addresses: z.record(z.string()).optional(),
      },
    },
    withToolBoundary("ozpb_prepare_install_plan", async (input) => prepareInstallPlan(
      {
        ruleset: CandidateRuleset.parse(input.ruleset),
        accountSnapshot: AccountSnapshot.parse(input.account_snapshot),
        simulationReport: SimulationReport.parse(input.simulation_report),
        bypassReport: BypassReport.parse(input.bypass_report),
        riskReport: RiskReport.parse(input.risk_report),
        ...(input.policy_addresses !== undefined ? { policyAddresses: input.policy_addresses as never } : {}),
      },
      {
        currentLedger: input.current_ledger,
        entropy: () => "MCP_APPROVAL_TOKEN_WRITE_TO_PLAN_FILE",
        simulateStep: async () => ({
          fee_stroops: "0",
          footprint_hash: "mcp-not-live-simulated",
          at_ledger: input.current_ledger,
        }),
      },
    )),
  );

  server.registerTool(
    "ozpb_check_policy_coverage",
    {
      title: "Check policy coverage",
      description: "Routes an intended action to session-key execution if covered, otherwise to owner approval.",
      inputSchema: {
        action: z.object({
          contract: z.string(),
          fn: z.string(),
          amount_i128: z.string().optional(),
          recipient: z.string().optional(),
        }),
        installed: z.array(
          z.object({
            contract: z.string(),
            fn: z.string(),
            max_amount_i128: z.string().optional(),
            recipient: z.string().optional(),
            valid_until_ledger: z.number().int().optional(),
          }),
        ),
        current_ledger: z.number().int().optional(),
      },
    },
    withToolBoundary("ozpb_check_policy_coverage", (input) => checkPolicyCoverage(input)),
  );

  return bridge;
}
