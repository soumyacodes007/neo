#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SMART_ACCOUNT_KIT_TESTNET_DEFAULTS,
  WalletBridge,
} from "../packages/wallet-bridge/dist/index.js";
import {
  InMemoryRegistry,
  RpcClient,
  inspectAccount,
  traceTransaction,
} from "../packages/stellar/dist/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const walletFixturePath = path.join(root, "fixtures", "testnet", "phase8-wallet-demo-result.json");
const strictPlanPath = path.join(root, "fixtures", "testnet", "phase8-strict-policy-plan.json");
const pbDeploymentsPath = path.join(root, "fixtures", "testnet", "pb-policy-deployments.json");
const outPath = path.join(root, "fixtures", "testnet", "phase8-strict-policy-install-result.json");
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
const strictPlan = JSON.parse(await fs.readFile(strictPlanPath, "utf8"));
const pbDeployments = JSON.parse(await fs.readFile(pbDeploymentsPath, "utf8"));
const account = strictPlan.account;
const ownerCredentialId = walletFixture.approval?.wallet?.public_signer_ref;
if (!account || !ownerCredentialId) throw new Error("missing wallet account or credential id");

const backend = new JsonRpcBackend(walletKit.rpc_url);
const rpc = RpcClient.create(backend, { budget: 900 });
const registry = new InMemoryRegistry().registerAccountWasm(walletKit.account_wasm_hash);
for (const deployment of pbDeployments.deployments) {
  registry.registerPolicy(deployment.wasm_hash, deployment.classification);
}

const before = await inspect(account, rpc, registry);
const planHash = createHash("sha256").update(JSON.stringify(strictPlan)).digest("hex");
const bridge = new WalletBridge();

try {
  const approval = await bridge.createSigningRequest({
    kind: "sign_install_plan",
    network: "testnet",
    plan_hash: planHash,
    account,
    payload: {
      human_summary_markdown: [
        `Install strict policy rule "${strictPlan.rule_name}" on ${account}.`,
        `The session key will be limited to ${strictPlan.guarantees.function}.`,
        `Recipient: ${strictPlan.guarantees.recipient}.`,
        `Max amount: ${strictPlan.guarantees.max_amount_stroops} stroops.`,
      ].join("\n"),
      policy_diff_markdown: strictPlan.policies
        .map((policy) => `Attach ${policy.classification} at ${policy.address}.`)
        .join("\n"),
      risk_summary_markdown: "This is a real testnet add_context_rule. The owner passkey signs once; future matching actions use the Ed25519 session key.",
      wallet_kit: walletKit,
      install_action: {
        kind: "session_rule",
        account,
        owner_credential_id: ownerCredentialId,
        target_contract: strictPlan.target_contract,
        rule_name: strictPlan.rule_name,
        valid_until_ledger: strictPlan.valid_until_ledger,
        session_signer: {
          verifier: walletKit.ed25519_verifier_address,
          public_key_hex: strictPlan.session_signer_public_key_hex,
        },
        policies: {
          custom: strictPlan.policies.map((policy) => ({
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
        step_hash: `install_strict_rule:${planHash.slice(0, 24)}`,
        unsigned_xdr: "smart-account-kit:rules.add:custom-policies",
        description: "Browser passkey signs and submits strict add_context_rule.",
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
  if (!txHash) throw new Error("browser did not return a strict install tx hash");
  const trace = await traceTransaction(
    { source: { tx_hash: txHash } },
    { rpc, network: "testnet", now: () => new Date().toISOString() },
  );
  const after = await inspect(account, rpc, registry);
  const installed = after.rules.find((rule) => rule.name === strictPlan.rule_name);
  if (!installed) throw new Error(`strict rule ${strictPlan.rule_name} was not found after install`);

  const out = {
    schema_version: "1",
    test_id: "phase8.strict-policy-install",
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
    guarantees: strictPlan.guarantees,
    source_plan: path.relative(root, strictPlanPath),
  };
  await fs.writeFile(outPath, `${JSON.stringify(out, null, 2)}\n`);
  console.log(JSON.stringify(out, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await bridge.stop();
}

async function inspect(accountId, client, classificationRegistry) {
  return inspectAccount(
    { account: accountId, resolve_policy_state: false },
    { rpc: client, registry: classificationRegistry, network: "testnet", now: () => new Date().toISOString() },
  );
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
