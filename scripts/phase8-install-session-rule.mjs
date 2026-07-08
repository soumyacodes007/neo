#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import {
  SMART_ACCOUNT_KIT_TESTNET_DEFAULTS,
  WalletBridge,
  checkPolicyCoverage,
} from "../packages/wallet-bridge/dist/index.js";
import {
  InMemoryRegistry,
  RpcClient,
  extractAuthContexts,
  inspectAccount,
  traceTransaction,
} from "../packages/stellar/dist/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const requireFromWalletBridge = createRequire(path.join(root, "packages", "wallet-bridge", "package.json"));
const sdk = await import(pathToFileURL(requireFromWalletBridge.resolve("@stellar/stellar-sdk")).href);
const { Keypair } = sdk;

const walletFixturePath = path.join(root, "fixtures", "testnet", "phase8-wallet-demo-result.json");
const outPath = path.join(root, "fixtures", "testnet", "phase8-session-rule-install-result.json");
const localSessionPath = path.join(root, ".tmp", "phase8-session-key.json");
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

const walletFixture = JSON.parse(await fs.readFile(walletFixturePath, "utf8"));
const account = process.env.SMART_ACCOUNT_ADDRESS ?? walletFixture.approval?.account;
const ownerCredentialId = process.env.OWNER_CREDENTIAL_ID ?? walletFixture.approval?.wallet?.public_signer_ref;
if (!account) throw new Error(`Missing account in ${walletFixturePath}`);
if (!ownerCredentialId) throw new Error(`Missing owner credential id in ${walletFixturePath}`);
if (!walletKit.ed25519_verifier_address) throw new Error("Missing ed25519 verifier address");
if (!walletKit.threshold_policy_address) throw new Error("Missing threshold policy address");
if (!walletKit.spending_limit_policy_address) throw new Error("Missing spending-limit policy address");
if (!walletKit.native_token_contract) throw new Error("Missing native token contract");

const backend = new JsonRpcBackend(walletKit.rpc_url);
const rpc = RpcClient.create(backend, { budget: 600 });
const latest = await rpc.getLatestLedger();
const before = await inspect(account, rpc);
const session = await loadOrCreateSessionKey();
const validUntil = latest.sequence + Number(process.env.VALID_FOR_LEDGERS ?? 17_280);
const maxXlm = process.env.MAX_XLM ?? "1";
const maxStroops = String(BigInt(Math.round(Number(maxXlm) * 10_000_000)));
const periodLedgers = Number(process.env.PERIOD_LEDGERS ?? 17_280);
const ruleName = (process.env.RULE_NAME ?? `ozpb-${String(before.next_rule_id)}`).slice(0, 20);
const includeSpendingLimit = process.env.INCLUDE_SPENDING_LIMIT === "true";
const plan = {
  account,
  target_contract: walletKit.native_token_contract,
  rule_name: ruleName,
  valid_until_ledger: validUntil,
  session_signer_public_key_hex: session.public_key_hex,
  policies: {
    simple_threshold: {
      address: walletKit.threshold_policy_address,
      threshold: 1,
    },
    ...(includeSpendingLimit ? { spending_limit: {
      address: walletKit.spending_limit_policy_address,
      spending_limit_stroops: maxStroops,
      period_ledgers: periodLedgers,
    } } : {}),
  },
};
const planHash = sha256Json(plan);
const bridge = new WalletBridge();

try {
  const approval = await bridge.createSigningRequest({
    kind: "sign_install_plan",
    network: "testnet",
    plan_hash: planHash,
    account,
    payload: {
      human_summary_markdown: [
        `Install a scoped session-key rule on ${account}.`,
        `Target contract: ${walletKit.native_token_contract}.`,
        `Session key can authorize matching native-token calls until ledger ${String(validUntil)}.`,
      ].join("\n"),
      policy_diff_markdown: [
        `Add context rule "${ruleName}" for call_contract(${walletKit.native_token_contract}).`,
        includeSpendingLimit
          ? `Attach simple_threshold(1) and spending_limit(${maxStroops} stroops / ${String(periodLedgers)} ledgers).`
          : "Attach simple_threshold(1). Multi-policy spending-limit install is disabled for this run until policy-map XDR sorting is patched.",
        "The owner passkey signs this install once. The session secret is stored only under .tmp for this demo.",
      ].join("\n"),
      risk_summary_markdown: [
        "This is a real testnet install.",
        includeSpendingLimit
          ? "It grants an Ed25519 session signer scoped by the token contract and spending-limit policy."
          : "It grants an Ed25519 session signer scoped by the token contract plus a one-signer threshold policy. This proves the real install path, not the final recipient/amount policy.",
        "Production should replace this broad token-contract rule with recipient/function policy composition before mainnet.",
      ].join("\n"),
      wallet_kit: walletKit,
      install_action: {
        kind: "session_rule",
        account,
        owner_credential_id: ownerCredentialId,
        target_contract: walletKit.native_token_contract,
        rule_name: ruleName,
        valid_until_ledger: validUntil,
        session_signer: {
          verifier: walletKit.ed25519_verifier_address,
          public_key_hex: session.public_key_hex,
        },
        policies: plan.policies,
      },
      expected_signer: {
        account,
        signer_kind: "webauthn",
        verifier: walletKit.webauthn_verifier_address,
        public_key_hint: walletFixture.approval?.wallet?.public_key_hint,
      },
      steps: [{
        order: 1,
        step_hash: `install_session_rule:${planHash.slice(0, 24)}`,
        unsigned_xdr: "smart-account-kit:rules.add",
        description: "Browser passkey signs and submits add_context_rule for the session signer.",
        network_passphrase: walletKit.network_passphrase,
        auth_requirements: [],
      }],
    },
  });

  console.log(`Open approval URL:\n${approval.approval_url}\n`);
  if (process.env.OPEN_BROWSER !== "false") openBrowser(approval.approval_url);

  const completed = await bridge.waitForResult(approval.sid, Number(process.env.PHASE8_DEMO_TIMEOUT_MS ?? 10 * 60 * 1000));
  if (completed.status !== "completed" || !completed.result) {
    throw new Error(`approval ended with status ${completed.status}`);
  }

  const txHash = completed.result.signed_steps[0]?.tx_hash;
  if (!txHash) throw new Error("browser did not return an install tx hash");
  const trace = await traceTransaction(
    { source: { tx_hash: txHash } },
    { rpc, network: "testnet", now: () => new Date().toISOString() },
  );
  const after = await inspect(account, rpc);
  const installed = findInstalledRule(after, {
    ruleName,
    targetContract: walletKit.native_token_contract,
    sessionPublicKeyHex: session.public_key_hex,
  });
  if (!installed) {
    throw new Error(`install transaction succeeded but rule "${ruleName}" was not found in account readback`);
  }
  const evidence = extractAuthContexts({ account, polarity: "positive", traces: [trace] });
  const coverage = {
    matching: checkPolicyCoverage({
      action: {
        contract: walletKit.native_token_contract,
        fn: "transfer",
        amount_i128: maxStroops,
      },
      installed: [{
        contract: walletKit.native_token_contract,
        fn: "transfer",
        max_amount_i128: maxStroops,
        valid_until_ledger: validUntil,
      }],
      current_ledger: latest.sequence,
    }),
    amount_plus_one: checkPolicyCoverage({
      action: {
        contract: walletKit.native_token_contract,
        fn: "transfer",
        amount_i128: String(BigInt(maxStroops) + 1n),
      },
      installed: [{
        contract: walletKit.native_token_contract,
        fn: "transfer",
        max_amount_i128: maxStroops,
        valid_until_ledger: validUntil,
      }],
      current_ledger: latest.sequence,
    }),
    wrong_function: checkPolicyCoverage({
      action: {
        contract: walletKit.native_token_contract,
        fn: "approve",
        amount_i128: maxStroops,
      },
      installed: [{
        contract: walletKit.native_token_contract,
        fn: "transfer",
        max_amount_i128: maxStroops,
        valid_until_ledger: validUntil,
      }],
      current_ledger: latest.sequence,
    }),
  };

  const out = {
    schema_version: "1",
    test_id: "phase8.passkey-install-session-rule",
    created_at: new Date().toISOString(),
    network: "testnet",
    rpc_url: walletKit.rpc_url,
    plan_hash: planHash,
    account,
    wallet: completed.result.wallet,
    session_signer: {
      type: "external",
      verifier: walletKit.ed25519_verifier_address,
      public_key_hex: session.public_key_hex,
      secret_storage: path.relative(root, localSessionPath),
      signer_id: installed.signer_id,
    },
    install_request: plan,
    transaction: {
      hash: txHash,
      ledger: completed.result.signed_steps[0]?.ledger ?? trace.ledger,
      source: "browser_submitted",
    },
    readback: {
      before_rule_count: before.rule_count,
      after_rule_count: after.rule_count,
      installed_rule: installed.rule,
      snapshot_hash: after.snapshot_hash,
    },
    trace: {
      tx_hash: trace.tx_hash,
      ledger: trace.ledger,
      successful: trace.successful,
      auth_entries: trace.auth_entries.length,
      token_deltas: trace.token_deltas,
    },
    evidence: {
      status: evidence.contexts.length > 0 ? "ok" : "skipped",
      context_count: evidence.contexts.length,
      evidence_hash: evidence.evidence_hash,
      note: evidence.contexts.length > 0 ? undefined : "install transactions may not produce reusable user-action auth contexts",
    },
    coverage_router_smoke: coverage,
    known_contracts: {
      account_wasm_hash: walletKit.account_wasm_hash,
      webauthn_verifier_address: walletKit.webauthn_verifier_address,
      ed25519_verifier_address: walletKit.ed25519_verifier_address,
      threshold_policy_address: walletKit.threshold_policy_address,
      spending_limit_policy_address: walletKit.spending_limit_policy_address,
      native_token_contract: walletKit.native_token_contract,
    },
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

async function inspect(accountId, client) {
  const registry = new InMemoryRegistry().registerAccountWasm(walletKit.account_wasm_hash);
  return inspectAccount(
    { account: accountId, resolve_policy_state: false },
    { rpc: client, registry, network: "testnet", now: () => new Date().toISOString() },
  );
}

async function loadOrCreateSessionKey() {
  await fs.mkdir(path.dirname(localSessionPath), { recursive: true });
  if (process.env.SESSION_SECRET) {
    const keypair = Keypair.fromSecret(process.env.SESSION_SECRET);
    await writeLocalSession(keypair);
    return keyInfo(keypair);
  }
  try {
    const existing = JSON.parse(await fs.readFile(localSessionPath, "utf8"));
    if (typeof existing.secret === "string") return keyInfo(Keypair.fromSecret(existing.secret));
  } catch {
    // Create a fresh gitignored session key below.
  }
  const keypair = Keypair.random();
  await writeLocalSession(keypair);
  return keyInfo(keypair);
}

async function writeLocalSession(keypair) {
  await fs.writeFile(localSessionPath, `${JSON.stringify({
    schema_version: "1",
    created_at: new Date().toISOString(),
    warning: "Local testnet demo key. This file is intentionally gitignored.",
    secret: keypair.secret(),
    public_key: keypair.publicKey(),
    public_key_hex: keypair.rawPublicKey().toString("hex"),
  }, null, 2)}\n`);
}

function keyInfo(keypair) {
  return {
    public_key: keypair.publicKey(),
    public_key_hex: keypair.rawPublicKey().toString("hex"),
  };
}

function findInstalledRule(snapshot, expected) {
  for (const rule of snapshot.rules) {
    if (rule.name !== expected.ruleName) continue;
    if (rule.context_type.kind !== "call_contract" || rule.context_type.address !== expected.targetContract) continue;
    for (const signer of rule.signers) {
      const model = signer.signer;
      if (model.type !== "external") continue;
      const hex = Buffer.from(model.key_data_b64, "base64").toString("hex");
      if (hex === expected.sessionPublicKeyHex) {
        return {
          rule,
          signer_id: signer.signer_id,
        };
      }
    }
  }
  return undefined;
}

function sha256Json(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
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
