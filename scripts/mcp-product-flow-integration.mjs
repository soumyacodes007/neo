#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SMART_ACCOUNT_KIT_TESTNET_DEFAULTS, WalletBridge } from "../packages/wallet-bridge/dist/index.js";
import { registerOzpbTools } from "../packages/mcp-server/dist/register-tools.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const mode = process.env.MCP_FLOW_ACTION ?? "blend";
const defaultOut = `fixtures/testnet/mcp-product-flow-integration-${mode}-result.json`;
const outPath = path.resolve(root, process.env.MCP_FLOW_OUT ?? defaultOut);
const walletFixturePath = path.resolve(root, process.env.MCP_FLOW_WALLET_FIXTURE ?? "fixtures/testnet/phase8-wallet-demo-result.json");
const walletFixture = JSON.parse(await fs.readFile(walletFixturePath, "utf8"));
const account = process.env.MCP_FLOW_ACCOUNT ?? walletFixture.approval?.account;
const ownerCredentialId = process.env.MCP_FLOW_OWNER_CREDENTIAL_ID ?? walletFixture.approval?.wallet?.public_signer_ref;
const ownerPublicKeyHint = process.env.MCP_FLOW_OWNER_PUBLIC_KEY_HINT ?? walletFixture.approval?.wallet?.public_key_hint;
const walletKit = {
  ...SMART_ACCOUNT_KIT_TESTNET_DEFAULTS,
  rpc_url: process.env.STELLAR_RPC_URL ?? SMART_ACCOUNT_KIT_TESTNET_DEFAULTS.rpc_url,
};

if (!account || !ownerCredentialId || !ownerPublicKeyHint) {
  throw new Error(`Missing wallet signer metadata in ${walletFixturePath}`);
}

const bridge = new WalletBridge();
const tools = new Map();
const server = {
  registerTool(name, _config, handler) {
    tools.set(name, handler);
  },
};
registerOzpbTools(server, { bridge });

const log = [];
const artifacts = {};
let finalStatus = "running";

try {
  const action = buildAction();
  const prepared = await callTool("ozpb_prepare_action", {
    network: "testnet",
    action,
    wallet_kit: walletKit,
  });
  artifacts.prepared = prepared.result;

  const coverage = await callTool("ozpb_check_policy_coverage", {
    action: prepared.result.coverage_query,
    installed: [],
  });
  artifacts.coverage = coverage.result;
  if (coverage.result.covered !== false) {
    throw new Error("expected uncovered action to route to owner approval");
  }

  const approval = await callTool("ozpb_request_owner_approval", {
    network: "testnet",
    account,
    owner_credential_id: ownerCredentialId,
    owner_public_key_hint: ownerPublicKeyHint,
    action,
    wallet_kit: walletKit,
  });
  artifacts.approval = approval.result;
  if (!approval.result.approval_url) {
    throw new Error(`owner approval was not created: ${JSON.stringify(approval.result)}`);
  }
  console.log(`Open approval URL:\n${approval.result.approval_url}\n`);
  if (process.env.OPEN_BROWSER !== "false") openBrowser(approval.result.approval_url);

  const walletResult = await callTool("ozpb_await_wallet_result", {
    sid: approval.result.sid,
    timeout_ms: Number(process.env.MCP_FLOW_TIMEOUT_MS ?? 10 * 60 * 1000),
  });
  if (walletResult.result.status !== "completed") {
    throw new Error(`wallet approval ended with ${walletResult.result.status}`);
  }
  artifacts.wallet_result = walletResult.result;
  const txHash = walletResult.result.result?.signed_steps?.[0]?.tx_hash;
  if (typeof txHash !== "string") {
    throw new Error("browser approval did not return a tx_hash");
  }

  const recorded = await callTool("ozpb_record_transaction", {
    network: "testnet",
    rpc_url: walletKit.rpc_url,
    tx_hash: txHash,
  });
  artifacts.recorded = recorded.result;

  const snapshot = await callTool("ozpb_inspect_account", {
    network: "testnet",
    account,
    rpc_url: walletKit.rpc_url,
    wallet_kit: walletKit,
  });
  artifacts.snapshot = snapshot.result;

  const evidence = await callTool("ozpb_extract_auth_contexts", {
    account,
    polarity: "positive",
    traces: [recorded.result.trace],
  });
  artifacts.evidence = evidence.result;

  const intent = buildIntent(evidence.result.contexts, txHash);
  artifacts.intent = intent;
  const draft = await callTool("ozpb_draft_policy_from_recording", {
    account,
    intent,
    traces: [recorded.result.trace],
    polarity: "positive",
    snapshot_hash: snapshot.result.snapshot_hash,
    current_ledger: recorded.result.trace.ledger,
  });
  artifacts.draft = draft.result;

  const verify = await callTool("ozpb_verify_policy", {
    ruleset: draft.result.ruleset,
    account_snapshot: snapshot.result,
    engine: "fake",
    allow_fake: true,
    fake_outcome: "pass",
  });
  artifacts.verify = verify.result;
  finalStatus = "ok";

  const out = {
    schema_version: "1",
    created_at: new Date().toISOString(),
    test: "mcp-product-flow-integration",
    mode,
    account,
    tx_hash: txHash,
    ledger: recorded.result.trace.ledger,
    tool_sequence: log,
    summary: {
      prepared_builder: prepared.result.transaction?.builder,
      coverage: coverage.result,
      evidence_contexts: evidence.result.contexts.length,
      rules: draft.result.ruleset.rules.length,
      requires_codegen: draft.result.requires_codegen.length,
      install_allowed: verify.result.install_allowed,
      simulation_verdict: verify.result.simulation_report.verdict,
      bypass_findings: verify.result.bypass_report.findings.length,
    },
    artifacts,
  };
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, `${JSON.stringify(out, null, 2)}\n`);
  console.log(JSON.stringify(out.summary, null, 2));
} catch (error) {
  finalStatus = "failed";
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, `${JSON.stringify({
    schema_version: "1",
    created_at: new Date().toISOString(),
    test: "mcp-product-flow-integration",
    mode,
    status: finalStatus,
    account,
    tool_sequence: log,
    error: error instanceof Error ? error.message : String(error),
    artifacts,
  }, null, 2)}\n`);
  throw error;
} finally {
  await bridge.stop();
}

async function callTool(name, input) {
  const handler = tools.get(name);
  if (!handler) throw new Error(`tool ${name} is not registered`);
  const response = await handler(input);
  const body = JSON.parse(response.content?.[0]?.text ?? "{}");
  log.push({ tool: name, ok: body.ok === true });
  if (body.ok !== true) {
    throw new Error(`${name} failed: ${JSON.stringify(body)}`);
  }
  return body;
}

function buildAction() {
  if (mode === "blend") {
    return {
      kind: "blend_claim",
      account,
      pool_contract: process.env.BLEND_POOL ?? "CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF",
      receive_token_contract: process.env.BLEND_RESERVE ?? walletKit.native_token_contract,
      max_claim_i128: process.env.BLEND_AMOUNT_I128 ?? "100000",
    };
  }
  if (mode === "xlm") {
    const recipient = process.env.RECIPIENT_ADDRESS;
    if (!recipient) throw new Error("RECIPIENT_ADDRESS is required for MCP_FLOW_ACTION=xlm");
    return {
      kind: "native_transfer",
      account,
      recipient,
      amount_xlm: process.env.AMOUNT_XLM ?? "1",
      token_contract: walletKit.native_token_contract,
    };
  }
  throw new Error(`unsupported MCP_FLOW_ACTION ${mode}`);
}

function buildIntent(contexts, txHash) {
  return {
    schema_version: "1",
    network: "testnet",
    account,
    grantee: {
      signer: {
        type: "external",
        verifier: walletKit.ed25519_verifier_address,
        key_data_b64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        verifier_kind: "ed25519",
      },
      label: "integration test session signer",
    },
    targets: contexts.map((ctx, index) => ({
      contract: ctx.contract,
      label: `observed ${ctx.fn_name}`,
      functions: [{ name: ctx.fn_name, arg_constraints: [] }],
      provenance: ctx.occurrences?.[0]?.provenance ?? { kind: "observed_tx", tx_hash: txHash, context_index: index },
    })),
    budgets: [],
    expiry: { ledgers: 17280 },
    preserve: [],
    explicit_denies: [],
    clarifications_resolved: [],
  };
}

function openBrowser(url) {
  if (process.platform === "win32") {
    spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
    return;
  }
  spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
}
