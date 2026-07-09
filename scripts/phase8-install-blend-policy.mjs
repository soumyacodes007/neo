#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import { SMART_ACCOUNT_KIT_TESTNET_DEFAULTS, WalletBridge } from "../packages/wallet-bridge/dist/index.js";
import { registerOzpbTools } from "../packages/mcp-server/dist/register-tools.js";
import { InMemoryRegistry, RpcClient, encodeAddContextRuleArgs, encodeInstallParams, inspectAccount } from "../packages/stellar/dist/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const requireFromWalletBridge = createRequire(path.join(root, "packages", "wallet-bridge", "package.json"));
const sdk = await import(pathToFileURL(requireFromWalletBridge.resolve("@stellar/stellar-sdk")).href);
const { Keypair } = sdk;

const walletFixturePath = path.join(root, "fixtures", "testnet", "phase8-wallet-demo-result.json");
const deploymentsPath = path.join(root, "fixtures", "testnet", "pb-policy-deployments.json");
const sessionPath = path.join(root, ".tmp", "phase8-blend-session-key.json");
const planPath = path.resolve(root, process.env.PLAN_PATH ?? "fixtures/testnet/phase8-blend-policy-plan.json");
const outPath = path.resolve(root, process.env.OUT_PATH ?? "fixtures/testnet/phase8-blend-policy-install-result.json");
const registryUrl = "https://raw.githubusercontent.com/blend-capital/blend-utils/main/testnet.contracts.json";

const walletFixture = JSON.parse(await fs.readFile(walletFixturePath, "utf8"));
const deployments = JSON.parse(await fs.readFile(deploymentsPath, "utf8"));
const blendRegistry = await fetchJson(registryUrl);
const walletKit = { ...SMART_ACCOUNT_KIT_TESTNET_DEFAULTS, rpc_url: process.env.STELLAR_RPC_URL ?? SMART_ACCOUNT_KIT_TESTNET_DEFAULTS.rpc_url };
const account = process.env.SMART_ACCOUNT_ADDRESS ?? walletFixture.approval?.account;
const ownerCredentialId = process.env.OWNER_CREDENTIAL_ID ?? walletFixture.approval?.wallet?.public_signer_ref;
const ownerPublicKeyHint = process.env.OWNER_PUBLIC_KEY_HINT ?? walletFixture.approval?.wallet?.public_key_hint;
if (!account || !ownerCredentialId || !ownerPublicKeyHint) throw new Error(`Missing wallet metadata in ${walletFixturePath}`);
if (!walletKit.ed25519_verifier_address) throw new Error("Missing ed25519 verifier address in wallet kit");

const pool = process.env.BLEND_POOL ?? blendRegistry.ids.TestnetV2;
const reserve = process.env.BLEND_RESERVE ?? blendRegistry.ids.XLM ?? walletKit.native_token_contract;
const amount = process.env.BLEND_AMOUNT_I128 ?? "100000";
const periodLedgers = Number(process.env.PERIOD_LEDGERS ?? 17_280);
class JsonRpcBackend {
  constructor(url) { this.url = url; }
  async call(method, params) {
    const response = await fetch(this.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
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
    return { latestLedger: r.latestLedger, entries: (r.entries ?? []).map((entry) => ({ keyB64: entry.key, xdrB64: entry.xdr, liveUntilLedgerSeq: entry.liveUntilLedgerSeq })) };
  }
}
const backend = new JsonRpcBackend(walletKit.rpc_url);
const rpc = RpcClient.create(backend, { budget: 1200 });
const before = await inspect(account, rpc);
const latest = await rpc.getLatestLedger();
const validUntil = latest.sequence + Number(process.env.VALID_FOR_LEDGERS ?? 720);
const session = await loadOrCreateSessionKey();

const policies = {
  allow: deployment("pb:function_allowlist"),
  arg: deployment("pb:arg_guard"),
  cap: deployment("pb:call_cap"),
};

const poolPlan = buildRulePlan({
  account,
  intendedRuleId: before.next_rule_id,
  target: pool,
  ruleName: `ozpb-blend-${String(before.next_rule_id)}`.slice(0, 20),
  validUntil,
  session,
  policies: [
    customPolicy(policies.allow, { functions: ["submit"] }),
    customPolicy(policies.arg, {
      rules: [
        { fnName: "submit", argIndex: 0, path: [], pred: { kind: "addr_eq", address: account }, forall: false },
        { fnName: "submit", argIndex: 1, path: [], pred: { kind: "addr_eq", address: account }, forall: false },
        { fnName: "submit", argIndex: 2, path: [], pred: { kind: "addr_eq", address: account }, forall: false },
        { fnName: "submit", argIndex: 3, path: [{ kind: "wildcard" }, { kind: "field", name: "request_type" }], pred: { kind: "u32_in", values: [2] }, forall: true },
        { fnName: "submit", argIndex: 3, path: [{ kind: "wildcard" }, { kind: "field", name: "address" }], pred: { kind: "addr_eq", address: reserve }, forall: true },
      ],
    }),
    customPolicy(policies.cap, {
      cap: amount,
      periodLedgers,
      fnName: "submit",
      amountPath: [{ kind: "index", index: 3 }, { kind: "wildcard" }, { kind: "field", name: "amount" }],
      tokenFilterPath: [{ kind: "index", index: 3 }, { kind: "wildcard" }, { kind: "field", name: "address" }],
      tokenFilterToken: reserve,
    }),
  ],
});

const tokenPlan = buildRulePlan({
  account,
  intendedRuleId: before.next_rule_id + 1,
  target: reserve,
  ruleName: `ozpb-btok-${String(before.next_rule_id + 1)}`.slice(0, 20),
  validUntil,
  session,
  policies: [
    customPolicy(policies.allow, { functions: ["transfer"] }),
    customPolicy(policies.arg, {
      rules: [
        { fnName: "transfer", argIndex: 0, path: [], pred: { kind: "addr_eq", address: account }, forall: false },
        { fnName: "transfer", argIndex: 1, path: [], pred: { kind: "addr_eq", address: pool }, forall: false },
      ],
    }),
    customPolicy(policies.cap, {
      cap: amount,
      periodLedgers,
      fnName: "transfer",
      amountPath: [{ kind: "index", index: 2 }],
    }),
  ],
});

const fullPlan = {
  schema_version: "1",
  account,
  network: "testnet",
  blend: { registry_url: registryUrl, pool, reserve, request_type: "SupplyCollateral", request_type_id: 2, amount },
  session_signer_public_key_hex: session.public_key_hex,
  valid_until_ledger: validUntil,
  rules: [poolPlan, tokenPlan],
  guarantees: {
    root: "Blend pool submit only",
    subcall: "reserve transfer from smart account to selected pool only",
    request_type: "SupplyCollateral",
    reserve,
    max_amount_i128: amount,
    owner_passkey_required_for_unmatched_action: true,
  },
};
await fs.mkdir(path.dirname(planPath), { recursive: true });
await fs.writeFile(planPath, `${JSON.stringify(fullPlan, null, 2)}\n`);

const bridge = new WalletBridge();
const tools = new Map();
registerOzpbTools({ registerTool(name, _config, handler) { tools.set(name, handler); } }, { bridge });
const installs = [];
try {
  for (const rulePlan of fullPlan.rules) {
    const approval = await callTool("ozpb_install_policy", {
      network: "testnet",
      account,
      plan_hash: sha256Json(rulePlan),
      human_summary_markdown: `Install Blend session rule "${rulePlan.rule_name}" on ${account}.`,
      policy_diff_markdown: rulePlan.policies.map((p) => `Attach ${p.classification} at ${p.address}.`).join("\n"),
      risk_summary_markdown: "This is a real testnet add_context_rule. It grants the local Ed25519 session key only the described Blend context.",
      wallet_kit: walletKit,
      owner_credential_id: ownerCredentialId,
      owner_public_key_hint: ownerPublicKeyHint,
      install_action: {
        kind: "session_rule",
        account,
        owner_credential_id: ownerCredentialId,
        target_contract: rulePlan.target_contract,
        rule_name: rulePlan.rule_name,
        valid_until_ledger: validUntil,
        session_signer: {
          verifier: walletKit.ed25519_verifier_address,
          public_key_hex: session.public_key_hex,
        },
        policies: {
          custom: rulePlan.policies.map((p) => ({
            address: p.address,
            classification: p.classification,
            params_xdr_b64: p.params_xdr_b64,
          })),
        },
      },
      steps: [{
        order: 1,
        step_hash: `install_blend_rule:${rulePlan.rule_name}:${sha256Json(rulePlan).slice(0, 16)}`,
        unsigned_xdr: "smart-account-kit:raw:add_context_rule:blend",
        description: `Browser passkey signs and submits ${rulePlan.rule_name}.`,
        network_passphrase: walletKit.network_passphrase,
        auth_requirements: [],
      }],
    });
    console.log(`Open approval URL for ${rulePlan.rule_name}:\n${approval.approval_url}\n`);
    if (process.env.OPEN_BROWSER !== "false") openBrowser(approval.approval_url);
    const completed = await callTool("ozpb_await_wallet_result", {
      sid: approval.sid,
      timeout_ms: Number(process.env.PHASE8_DEMO_TIMEOUT_MS ?? 10 * 60 * 1000),
    });
    if (completed.status !== "completed" || !completed.result) throw new Error(`approval ended with ${completed.status}`);
    installs.push({ rule_name: rulePlan.rule_name, approval: completed.result });
  }
  const after = await inspect(account, rpc);
  const installedRules = fullPlan.rules.map((r) => {
    const found = after.rules.find((rule) => rule.name === r.rule_name);
    if (!found) throw new Error(`installed rule ${r.rule_name} not found`);
    return found;
  });
  const out = {
    schema_version: "1",
    test_id: "phase8.blend-policy-install",
    created_at: new Date().toISOString(),
    network: "testnet",
    rpc_url: walletKit.rpc_url,
    account,
    plan_path: path.relative(root, planPath),
    installs: installs.map((i) => ({
      rule_name: i.rule_name,
      tx_hash: i.approval.signed_steps?.[0]?.tx_hash,
      ledger: i.approval.signed_steps?.[0]?.ledger,
      wallet: i.approval.wallet,
    })),
    readback: {
      before_rule_count: before.rule_count,
      after_rule_count: after.rule_count,
      installed_rules: installedRules,
      snapshot_hash: after.snapshot_hash,
    },
    blend: fullPlan.blend,
    guarantees: fullPlan.guarantees,
    session_signer: {
      verifier: walletKit.ed25519_verifier_address,
      public_key_hex: session.public_key_hex,
      secret_storage: path.relative(root, sessionPath),
    },
  };
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, `${JSON.stringify(out, null, 2)}\n`);
  console.log(JSON.stringify(out, null, 2));
} finally {
  await bridge.stop();
}

function buildRulePlan({ account, intendedRuleId, target, ruleName, validUntil, session, policies }) {
  const add_context_rule_args_xdr = encodeAddContextRuleArgs({
    contextType: { kind: "call_contract", address: target },
    name: ruleName,
    validUntil,
    signers: [{
      type: "external",
      verifier: walletKit.ed25519_verifier_address,
      key_data_b64: Buffer.from(session.public_key_hex, "hex").toString("base64"),
      verifier_kind: "ed25519",
    }],
    policies: policies.map((policy) => ({ address: policy.address, installParams: policy.params_xdr_b64 })),
  }).map((arg) => arg.toXDR("base64"));
  return { account, intended_rule_id: intendedRuleId, target_contract: target, rule_name: ruleName, valid_until_ledger: validUntil, policies, add_context_rule_args_xdr };
}

function customPolicy(deploymentEntry, installParams) {
  return {
    classification: deploymentEntry.classification,
    address: deploymentEntry.address,
    install_params: installParams,
    params_xdr_b64: encodeInstallParams(deploymentEntry.classification, installParams),
  };
}

function deployment(classification) {
  const found = deployments.deployments.find((d) => d.classification === classification);
  if (!found) throw new Error(`missing deployment for ${classification}`);
  return found;
}

async function inspect(accountId, client) {
  const registry = new InMemoryRegistry().registerAccountWasm(walletKit.account_wasm_hash);
  for (const d of deployments.deployments) registry.registerPolicy(d.wasm_hash, d.classification);
  return inspectAccount({ account: accountId, resolve_policy_state: false }, { rpc: client, registry, network: "testnet", now: () => new Date().toISOString() });
}

async function loadOrCreateSessionKey() {
  await fs.mkdir(path.dirname(sessionPath), { recursive: true });
  try {
    const existing = JSON.parse(await fs.readFile(sessionPath, "utf8"));
    if (typeof existing.secret === "string") return keyInfo(Keypair.fromSecret(existing.secret));
  } catch {}
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
  return { public_key: keypair.publicKey(), public_key_hex: keypair.rawPublicKey().toString("hex") };
}

async function callTool(name, input) {
  const handler = tools.get(name);
  if (!handler) throw new Error(`tool ${name} is not registered`);
  const response = await handler(input);
  const body = JSON.parse(response.content?.[0]?.text ?? "{}");
  if (body.ok !== true) throw new Error(`${name} failed: ${JSON.stringify(body)}`);
  return body.result;
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`failed to fetch ${url}: ${String(response.status)}`);
  return await response.json();
}

function sha256Json(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function openBrowser(url) {
  if (process.platform === "win32") spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
  else spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
}
