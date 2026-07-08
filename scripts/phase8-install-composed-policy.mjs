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
} from "../packages/wallet-bridge/dist/index.js";
import {
  InMemoryRegistry,
  RpcClient,
  encodeAddContextRuleArgs,
  encodeInstallParams,
  inspectAccount,
  traceTransaction,
} from "../packages/stellar/dist/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const requireFromWalletBridge = createRequire(path.join(root, "packages", "wallet-bridge", "package.json"));
const sdk = await import(pathToFileURL(requireFromWalletBridge.resolve("@stellar/stellar-sdk")).href);
const { Keypair } = sdk;

const walletFixturePath = path.join(root, "fixtures", "testnet", "phase8-wallet-demo-result.json");
const pbDeploymentsPath = path.join(root, "fixtures", "testnet", "pb-policy-deployments.json");
const sessionPath = path.join(root, ".tmp", "phase8-session-key.json");
const defaultPlanPath = path.join(root, "fixtures", "testnet", "phase8-composed-policy-plan.json");
const defaultOutPath = path.join(root, "fixtures", "testnet", "phase8-composed-policy-install-result.json");
const planPath = path.resolve(root, process.env.PLAN_PATH ?? defaultPlanPath);
const outPath = path.resolve(root, process.env.OUT_PATH ?? defaultOutPath);
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
}

const walletFixture = JSON.parse(await fs.readFile(walletFixturePath, "utf8"));
const pbDeployments = JSON.parse(await fs.readFile(pbDeploymentsPath, "utf8"));
const account = process.env.SMART_ACCOUNT_ADDRESS ?? walletFixture.approval?.account;
const ownerCredentialId = process.env.OWNER_CREDENTIAL_ID ?? walletFixture.approval?.wallet?.public_signer_ref;
if (!account) throw new Error(`Missing account in ${walletFixturePath}`);
if (!ownerCredentialId) throw new Error(`Missing owner credential id in ${walletFixturePath}`);
if (!walletKit.ed25519_verifier_address) throw new Error("Missing ed25519 verifier address");
if (!walletKit.spending_limit_policy_address) throw new Error("Missing spending-limit policy address");
if (!walletKit.native_token_contract) throw new Error("Missing native token contract");

const backend = new JsonRpcBackend(walletKit.rpc_url);
const rpc = RpcClient.create(backend, { budget: 900 });
const before = await inspect(account, rpc);
const latest = await rpc.getLatestLedger();
const session = await loadOrCreateSessionKey();
const recipient = process.env.RECIPIENT ?? "GCJNG3JWPRVPAIT4WNRYFWOPSV66HESAFNGCZQTCGYPGA6HDXVLQC235";
const amountStroops = process.env.AMOUNT_STROOPS ?? "1000000";
const periodLedgers = Number(process.env.PERIOD_LEDGERS ?? 17_280);
const validUntil = latest.sequence + Number(process.env.VALID_FOR_LEDGERS ?? 720);
const prefix = process.env.RULE_NAME_PREFIX ?? "ozpb-composed";
const ruleName = `${prefix}-${String(before.next_rule_id)}`.slice(0, 20);
const functionAllowlist = deployment(pbDeployments, "pb:function_allowlist");
const argGuard = deployment(pbDeployments, "pb:arg_guard");

const policies = [
  {
    classification: "oz:spending_limit",
    address: walletKit.spending_limit_policy_address,
    install_params: {
      spending_limit: amountStroops,
      period_ledgers: periodLedgers,
    },
  },
  {
    classification: "pb:function_allowlist",
    address: functionAllowlist.address,
    install_params: { functions: ["transfer"] },
  },
  {
    classification: "pb:arg_guard",
    address: argGuard.address,
    install_params: {
      rules: [
        { fnName: "transfer", argIndex: 0, path: [], pred: { kind: "addr_eq", address: account }, forall: false },
        { fnName: "transfer", argIndex: 1, path: [], pred: { kind: "addr_eq", address: recipient }, forall: false },
      ],
    },
  },
].map((policy) => ({
  ...policy,
  params_xdr_b64: encodeInstallParams(policy.classification, policy.install_params),
}));

const plan = {
  schema_version: "1",
  account,
  intended_rule_id: before.next_rule_id,
  target_contract: walletKit.native_token_contract,
  rule_name: ruleName,
  valid_until_ledger: validUntil,
  session_signer_public_key_hex: session.public_key_hex,
  policies,
  guarantees: {
    function: "transfer only",
    sender: account,
    recipient,
    max_amount_stroops: amountStroops,
    amount_policy: "oz:spending_limit",
    recipient_policy: "pb:arg_guard",
    function_policy: "pb:function_allowlist",
    owner_passkey_required_for_any_unmatched_action: true,
  },
  status: "planned_not_installed",
};
plan.add_context_rule_args_xdr = encodeAddContextRuleArgs({
  contextType: { kind: "call_contract", address: plan.target_contract },
  name: plan.rule_name,
  validUntil: plan.valid_until_ledger,
  signers: [{
    type: "external",
    verifier: walletKit.ed25519_verifier_address,
    key_data_b64: Buffer.from(session.public_key_hex, "hex").toString("base64"),
    verifier_kind: "ed25519",
  }],
  policies: policies.map((policy) => ({
    address: policy.address,
    installParams: policy.params_xdr_b64,
  })),
}).map((arg) => arg.toXDR("base64"));

const planHash = sha256Json(plan);
await fs.mkdir(path.dirname(planPath), { recursive: true });
await fs.writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`);

const bridge = new WalletBridge();
try {
  const approval = await bridge.createSigningRequest({
    kind: "sign_install_plan",
    network: "testnet",
    plan_hash: planHash,
    account,
    payload: {
      human_summary_markdown: [
        `Install composed policy rule "${ruleName}" on ${account}.`,
        `Target: ${walletKit.native_token_contract}.`,
        `Allows session-key transfer to ${recipient} up to ${amountStroops} stroops until ledger ${String(validUntil)}.`,
      ].join("\n"),
      policy_diff_markdown: policies
        .map((policy) => `Attach ${policy.classification} at ${policy.address}.`)
        .join("\n"),
      risk_summary_markdown: "This is a real testnet add_context_rule. The owner passkey signs once; matching transfers use the Ed25519 session key.",
      wallet_kit: walletKit,
      install_action: {
        kind: "session_rule",
        account,
        owner_credential_id: ownerCredentialId,
        target_contract: plan.target_contract,
        rule_name: ruleName,
        valid_until_ledger: validUntil,
        session_signer: {
          verifier: walletKit.ed25519_verifier_address,
          public_key_hex: session.public_key_hex,
        },
        policies: {
          spending_limit: {
            address: walletKit.spending_limit_policy_address,
            spending_limit_stroops: amountStroops,
            period_ledgers: periodLedgers,
          },
          custom: policies
            .filter((policy) => policy.classification.startsWith("pb:"))
            .map((policy) => ({
              address: policy.address,
              classification: policy.classification,
              params_xdr_b64: policy.params_xdr_b64,
            })),
        },
      },
      expected_signer: {
        account,
        signer_kind: "webauthn",
        verifier: walletKit.webauthn_verifier_address,
        public_key_hint: walletFixture.approval?.wallet?.public_key_hint,
      },
      steps: [{
        order: 1,
        step_hash: `install_composed_rule:${planHash.slice(0, 24)}`,
        unsigned_xdr: "smart-account-kit:raw:add_context_rule:spending_limit+pb",
        description: "Browser passkey signs and submits composed add_context_rule.",
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
  if (!txHash) throw new Error("browser did not return a composed install tx hash");
  const trace = await traceTransaction(
    { source: { tx_hash: txHash } },
    { rpc, network: "testnet", now: () => new Date().toISOString() },
  );
  const after = await inspect(account, rpc);
  const installed = after.rules.find((rule) => rule.name === ruleName);
  if (!installed) throw new Error(`composed rule ${ruleName} was not found after install`);

  const out = {
    schema_version: "1",
    test_id: "phase8.composed-policy-install",
    created_at: new Date().toISOString(),
    network: "testnet",
    rpc_url: walletKit.rpc_url,
    plan_hash: planHash,
    account,
    wallet: completed.result.wallet,
    transaction: {
      hash: txHash,
      ledger: completed.result.signed_steps[0]?.ledger ?? trace.ledger,
      source: "browser_submitted",
    },
    readback: {
      before_rule_count: before.rule_count,
      after_rule_count: after.rule_count,
      installed_rule: installed,
      snapshot_hash: after.snapshot_hash,
    },
    trace: {
      tx_hash: trace.tx_hash,
      ledger: trace.ledger,
      successful: trace.successful,
      auth_entries: trace.auth_entries.length,
    },
    guarantees: plan.guarantees,
    source_plan: path.relative(root, planPath),
    session_signer: {
      verifier: walletKit.ed25519_verifier_address,
      public_key_hex: session.public_key_hex,
      secret_storage: path.relative(root, sessionPath),
    },
  };
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, `${JSON.stringify(out, null, 2)}\n`);
  console.log(JSON.stringify(out, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
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
  await fs.mkdir(path.dirname(sessionPath), { recursive: true });
  try {
    const existing = JSON.parse(await fs.readFile(sessionPath, "utf8"));
    if (typeof existing.secret === "string") return keyInfo(Keypair.fromSecret(existing.secret));
  } catch {
    // Create a fresh gitignored session key below.
  }
  const keypair = Keypair.random();
  await fs.writeFile(sessionPath, `${JSON.stringify({
    schema_version: "1",
    created_at: new Date().toISOString(),
    warning: "Local testnet demo key. This file is intentionally gitignored.",
    secret: keypair.secret(),
    public_key: keypair.publicKey(),
    public_key_hex: keypair.rawPublicKey().toString("hex"),
  }, null, 2)}\n`);
  return keyInfo(keypair);
}

function keyInfo(keypair) {
  return {
    public_key: keypair.publicKey(),
    public_key_hex: keypair.rawPublicKey().toString("hex"),
  };
}

function deployment(deployments, classification) {
  const found = deployments.deployments.find((d) => d.classification === classification);
  if (!found) throw new Error(`missing deployment for ${classification}`);
  return found;
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
