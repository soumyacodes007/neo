#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SMART_ACCOUNT_KIT_TESTNET_DEFAULTS,
  WalletBridge,
} from "../packages/wallet-bridge/dist/index.js";
import {
  PolicyIntent,
  canonicalHash,
  synthesizeRuleset,
} from "../packages/core/dist/index.js";
import {
  detectBypass,
} from "../packages/plans/dist/index.js";
import {
  InMemoryRegistry,
  RpcClient,
  extractAuthContexts,
  inspectAccount,
  submitSignedXdr,
  traceTransaction,
} from "../packages/stellar/dist/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const mode = process.env.PHASE8_DEMO_MODE ?? "create_wallet";
const outPath = path.join(root, "fixtures", "testnet", "phase8-wallet-demo-result.json");
const walletKit = {
  ...SMART_ACCOUNT_KIT_TESTNET_DEFAULTS,
  rpc_url: process.env.STELLAR_RPC_URL ?? SMART_ACCOUNT_KIT_TESTNET_DEFAULTS.rpc_url,
};

class JsonRpcBackend {
  constructor(url) {
    this.url = url;
  }

  async call(method, params) {
    const response = await fetch(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const json = await response.json();
    if (json.error !== undefined) throw new Error(`${method} failed: ${JSON.stringify(json.error)}`);
    return json.result;
  }

  async getLatestLedger() {
    const r = await this.call("getLatestLedger", {});
    return { sequence: r.sequence, protocolVersion: r.protocolVersion, id: r.id ?? "" };
  }

  async getLedgerEntries(keysB64) {
    const r = await this.call("getLedgerEntries", { keys: keysB64 });
    return {
      latestLedger: r.latestLedger,
      entries: (r.entries ?? []).map((entry) => ({
        keyB64: entry.key,
        xdrB64: entry.xdr,
        liveUntilLedgerSeq: entry.liveUntilLedgerSeq,
      })),
    };
  }

  async getTransaction(hash) {
    const r = await this.call("getTransaction", { hash });
    if (r.status === "NOT_FOUND") return { status: "NOT_FOUND" };
    return {
      status: r.status,
      ledger: r.ledger,
      createdAt: r.createdAt,
      envelopeXdr: r.envelopeXdr,
      resultXdr: r.resultXdr,
      resultMetaXdr: r.resultMetaXdr,
    };
  }

  async getTransactions(params) {
    const r = await this.call("getTransactions", params);
    return {
      transactions: r.transactions ?? [],
      cursor: r.cursor,
      latestLedger: r.latestLedger ?? 0,
      oldestLedger: r.oldestLedger ?? params.startLedger,
    };
  }
}

const bridge = new WalletBridge();
try {
  const approval = await bridge.createSigningRequest(buildRequest());
  console.log(`Open approval URL:\n${approval.approval_url}\n`);
  if (process.env.OPEN_BROWSER !== "false") openBrowser(approval.approval_url);

  const completed = await bridge.waitForResult(approval.sid, Number(process.env.PHASE8_DEMO_TIMEOUT_MS ?? 10 * 60 * 1000));
  if (completed.status !== "completed" || !completed.result) {
    throw new Error(`approval ended with status ${completed.status}`);
  }

  const submitted = [];
  for (const step of completed.result.signed_steps) {
    if (step.tx_hash) {
      submitted.push({ ...step, source: "browser_submitted" });
      continue;
    }
    if (!step.signed_xdr) continue;
    const submit = await submitSignedXdr({
      signed_xdr: step.signed_xdr,
      network_passphrase: walletKit.network_passphrase,
      rpc_url: walletKit.rpc_url,
    });
    submitted.push({ ...step, tx_hash: submit.hash, ledger: submit.ledger, source: "mcp_submitted", submit });
  }

  const backend = new JsonRpcBackend(walletKit.rpc_url);
  const rpc = RpcClient.create(backend, { budget: 200 });
  const traces = [];
  for (const step of submitted) {
    if (!step.tx_hash) continue;
    traces.push(await traceTransaction(
      { source: { tx_hash: step.tx_hash } },
      { rpc, network: "testnet", now: () => new Date().toISOString() },
    ));
  }
  const pipeline = await buildPipeline({
    rpc,
    traces,
    account: completed.result.account,
    signerRef: completed.result.wallet.public_signer_ref,
  });

  const out = {
    schema_version: "1",
    created_at: new Date().toISOString(),
    mode,
    approval: {
      sid: approval.sid,
      account: completed.result.account,
      wallet: completed.result.wallet,
    },
    wallet_kit: {
      rpc_url: walletKit.rpc_url,
      account_wasm_hash: walletKit.account_wasm_hash,
      webauthn_verifier_address: walletKit.webauthn_verifier_address,
      native_token_contract: walletKit.native_token_contract,
    },
    submitted,
    traces: traces.map((trace) => ({
      tx_hash: trace.tx_hash,
      ledger: trace.ledger,
      successful: trace.successful,
      source_account: trace.source_account,
      operations: trace.operations.map((op) => op.type),
      auth_entries: trace.auth_entries.length,
      token_deltas: trace.token_deltas,
    })),
    pipeline,
  };

  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, `${JSON.stringify(out, null, 2)}\n`);
  console.log(JSON.stringify(out, null, 2));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (message === "E_WALLET_BRIDGE_AWAIT_TIMEOUT") {
    console.error("Timed out waiting for browser/passkey approval.");
  } else {
    console.error(message);
  }
  process.exitCode = 1;
} finally {
  await bridge.stop();
}

function buildRequest() {
  if (mode === "one_off_xlm") {
    const recipient = process.env.RECIPIENT_ADDRESS;
    if (!recipient) throw new Error("RECIPIENT_ADDRESS is required for PHASE8_DEMO_MODE=one_off_xlm");
    const amount = Number(process.env.AMOUNT_XLM ?? "1");
    return {
      kind: "sign_one_off_tx",
      network: "testnet",
      payload: {
        human_summary_markdown: `Send ${amount} XLM to ${recipient}.`,
        policy_diff_markdown: "No policy is installed by this one-off action. The returned tx hash becomes recorder evidence.",
        risk_summary_markdown: "This spends real testnet XLM from the connected smart account.",
        wallet_kit: walletKit,
        demo_action: {
          kind: "xlm_transfer",
          token_contract: walletKit.native_token_contract,
          recipient,
          amount_xlm: amount,
        },
        expected_signer: { signer_kind: "webauthn" },
        steps: [{
          order: 1,
          step_hash: "one_off_xlm_transfer",
          unsigned_xdr: "smart-account-kit:transfer",
          description: "Browser passkey signs and submits the one-off XLM transfer.",
          network_passphrase: walletKit.network_passphrase,
          auth_requirements: [],
        }],
      },
    };
  }

  if (mode !== "create_wallet") throw new Error(`unknown PHASE8_DEMO_MODE ${mode}`);
  return {
    kind: "create_wallet",
    network: "testnet",
    payload: {
      human_summary_markdown: "Create and deploy an OpenZeppelin Stellar smart account.",
      policy_diff_markdown: "No policy grant is installed by wallet creation.",
      risk_summary_markdown: "The owner passkey stays in the browser. The MCP receives account metadata and a tx hash/signed XDR only.",
      wallet_kit: walletKit,
      expected_signer: { signer_kind: "webauthn" },
      steps: [{
        order: 1,
        step_hash: "wallet_deploy",
        unsigned_xdr: "smart-account-kit:create_wallet",
        description: "Deploy the OZ smart account controlled by this browser passkey.",
        network_passphrase: walletKit.network_passphrase,
        auth_requirements: [],
      }],
    },
  };
}

function openBrowser(url) {
  if (process.platform === "win32") {
    spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
  } else if (process.platform === "darwin") {
    spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
  } else {
    spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
  }
}

async function buildPipeline({ rpc, traces, account, signerRef }) {
  if (!account || traces.length === 0) {
    return { status: "skipped", reason: "missing account or trace" };
  }
  try {
    const registry = new InMemoryRegistry().registerAccountWasm(walletKit.account_wasm_hash);
    const latest = await rpc.getLatestLedger();
    const snapshot = await inspectAccount(
      { account, resolve_policy_state: false },
      {
        rpc,
        registry,
        network: "testnet",
        now: () => new Date().toISOString(),
      },
    );
    const evidence = extractAuthContexts({
      account,
      polarity: "positive",
      traces,
    });
    const firstContext = evidence.contexts[0];
    if (!firstContext) throw new Error("no auth contexts extracted");
    const credentialBytes = Buffer.from(signerRef ?? "browser-passkey", "utf8");
    const intent = PolicyIntent.parse({
      schema_version: "1",
      network: "testnet",
      account,
      grantee: {
        signer: {
          type: "external",
          verifier: walletKit.webauthn_verifier_address,
          key_data_b64: credentialBytes.toString("base64"),
          verifier_kind: "webauthn",
        },
        label: "browser passkey signer",
      },
      targets: evidence.contexts.map((ctx) => ({
        contract: ctx.contract,
        label: `observed ${ctx.fn_name}`,
        functions: [{ name: ctx.fn_name, arg_constraints: [] }],
        provenance: ctx.occurrences[0]?.provenance ?? {
          kind: "observed_tx",
          tx_hash: traces[0].tx_hash,
          context_index: 0,
        },
      })),
      budgets: [],
      expiry: { ledgers: 17280 },
      preserve: [],
      explicit_denies: [],
      clarifications_resolved: [],
    });
    const intentHash = canonicalHash(intent);
    const ruleset = synthesizeRuleset(
      { intent, intentHash, snapshotHash: snapshot.snapshot_hash, evidence },
      { currentLedger: latest.sequence },
    );
    const bypass = detectBypass({ ruleset, accountSnapshot: snapshot });
    return {
      status: "ok",
      latest_ledger: latest.sequence,
      snapshot: {
        hash: snapshot.snapshot_hash,
        account_wasm_hash: snapshot.account_wasm_hash,
        rule_count: snapshot.rule_count,
      },
      evidence: {
        hash: evidence.evidence_hash,
        context_count: evidence.contexts.length,
        contexts: evidence.contexts.map((ctx) => ({
          contract: ctx.contract,
          fn_name: ctx.fn_name,
          arity: ctx.arity,
          depth: ctx.depth,
          observed_args: ctx.arg_summary.length,
        })),
      },
      ruleset: {
        hash: ruleset.ruleset_hash,
        rule_count: ruleset.rules.length,
        unsatisfied_count: ruleset.unsatisfied.length,
      },
      bypass: {
        hash: bypass.report_hash,
        bypass_count: bypass.findings.filter((finding) => finding.verdict === "BYPASS").length,
        unknown_count: bypass.findings.filter((finding) => finding.verdict === "UNKNOWN").length,
        exhaustive: bypass.exhaustive,
      },
    };
  } catch (error) {
    return {
      status: "error",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
