#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PolicyIntent,
  canonicalHash,
  synthesizeRuleset,
  toContractId,
  toLedgerSeq,
} from "../packages/core/dist/index.js";
import { RpcClient, InMemoryRegistry, inspectAccount } from "../packages/stellar/dist/index.js";
import { detectBypass, prepareInstallPlan } from "../packages/plans/dist/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const fixturePath = process.argv[2] ?? path.join(root, "fixtures", "testnet", "oz-fixture.json");
const rpcUrl = process.env.STELLAR_RPC_URL ?? "https://soroban-testnet.stellar.org";

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
    if (json.error !== undefined) {
      throw new Error(`${method} failed: ${JSON.stringify(json.error)}`);
    }
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

const fixture = JSON.parse(await fs.readFile(fixturePath, "utf8"));
const rpc = RpcClient.create(new JsonRpcBackend(rpcUrl), { budget: 500 });
const latest = await rpc.getLatestLedger();

const registry = new InMemoryRegistry()
  .registerAccountWasm(fixture.account_wasm_hash)
  .registerVerifier(fixture.ed25519_verifier_wasm_hash, "ed25519")
  .registerPolicy(fixture.threshold_policy_wasm_hash, "oz:simple_threshold");

const snapshot = await inspectAccount(
  { account: fixture.account },
  {
    rpc,
    registry,
    network: "testnet",
    now: () => new Date().toISOString(),
  },
);

const keyDataB64 = Buffer.from(fixture.external_signer_key_hex, "hex").toString("base64");
const target = toContractId(fixture.ed25519_verifier);
const intent = PolicyIntent.parse({
  schema_version: "1",
  network: "testnet",
  account: fixture.account,
  grantee: {
    signer: {
      type: "external",
      verifier: fixture.ed25519_verifier,
      key_data_b64: keyDataB64,
      verifier_kind: "ed25519",
    },
    label: "fixture external signer",
  },
  targets: [
    {
      contract: target,
      label: "fixture verifier",
      functions: [{ name: "verify", arg_constraints: [] }],
      provenance: { kind: "observed_tx", tx_hash: "00".repeat(32), context_index: 0 },
    },
  ],
  budgets: [],
  expiry: { ledgers: 17280 },
  preserve: [],
  explicit_denies: [],
  clarifications_resolved: [],
});

const intentHash = canonicalHash(intent);
const ruleset = synthesizeRuleset(
  { intent, intentHash, snapshotHash: snapshot.snapshot_hash },
  { currentLedger: latest.sequence },
);
const bypass = detectBypass({ ruleset, accountSnapshot: snapshot });
const bypasses = bypass.findings.filter((finding) => finding.verdict === "BYPASS");
if (bypasses.length === 0) {
  throw new Error("expected the planted no-policy Default rule to be reported as BYPASS");
}

for (const finding of bypasses) {
  if (finding.recommendation.kind === "expire_rule" && !ruleset.updates.some((u) => u.rule_id === finding.rule_id)) {
    ruleset.updates.push({ rule_id: finding.rule_id, set_valid_until: toLedgerSeq(latest.sequence) });
  }
}

const simReport = {
  schema_version: "1",
  ruleset_hash: ruleset.ruleset_hash,
  engine_runs: [
    {
      engine: "testnet",
      toolchain_fingerprint: `rpc:${rpcUrl}`,
      cases: [{ case_id: "phase5-live-inspect-bypass-plan", outcome: "pass" }],
    },
  ],
  coverage: { constraints_exercised: ruleset.rules.flatMap((r) => r.constraints.map((c) => c.id)), constraints_total: ruleset.rules.flatMap((r) => r.constraints).length },
  verdict: "all_green",
  artifacts_dir: path.relative(root, path.dirname(fixturePath)),
  report_hash: "11".repeat(32),
};
const riskReport = {
  schema_version: "1",
  ruleset_hash: ruleset.ruleset_hash,
  residual_risks: [],
  limitations: [],
  unknown_policies: [],
  bypass_summary: {
    safe: bypass.findings.filter((f) => f.verdict === "SAFE").length,
    bypass: bypasses.length,
    unknown: bypass.findings.filter((f) => f.verdict === "UNKNOWN").length,
  },
  irreversibility_notes: [],
  expiry_summary: `expires at ledger ${ruleset.rules[0].valid_until_ledger}`,
  revocation_summary: "expire generated rule",
  report_hash: "22".repeat(32),
};
const bypassForGate = { ...bypass, ruleset_hash: ruleset.ruleset_hash };

const { plan } = await prepareInstallPlan(
  {
    ruleset,
    accountSnapshot: snapshot,
    simulationReport: simReport,
    bypassReport: bypassForGate,
    riskReport,
  },
  {
    currentLedger: latest.sequence,
    entropy: () => "TESTNET-SMOKE-TOKEN-NOT-STORED",
    simulateStep: async () => ({ fee_stroops: "0", footprint_hash: "testnet-smoke-not-submitted", at_ledger: latest.sequence }),
  },
);

const planFns = plan.steps.map((step) => step.invoke?.fn);
if (planFns.at(-1) !== "update_context_rule_valid_until") {
  throw new Error(`expected bypass expiry last, got ${JSON.stringify(planFns)}`);
}

const out = {
  fixture: {
    account: fixture.account,
    verifier: fixture.ed25519_verifier,
    source_account: fixture.source_account,
  },
  rpc: {
    url: rpcUrl,
    latest_ledger: latest.sequence,
  },
  snapshot: {
    hash: snapshot.snapshot_hash,
    rule_count: snapshot.rule_count,
    admin_paths: snapshot.admin_paths,
    rules: snapshot.rules.map((rule) => ({
      id: rule.id,
      name: rule.name,
      context_type: rule.context_type,
      signer_count: rule.signers.length,
      policy_count: rule.policies.length,
      privilege: rule.privilege,
      status: rule.status,
    })),
  },
  ruleset: {
    hash: ruleset.ruleset_hash,
    generated_rules: ruleset.rules.length,
    update_count: ruleset.updates.length,
  },
  bypass: {
    hash: bypass.report_hash,
    bypass_count: bypasses.length,
    findings: bypasses.map((finding) => ({
      rule_id: finding.rule_id,
      context: finding.context,
      recommendation: finding.recommendation.kind,
    })),
  },
  plan: {
    hash: plan.plan_hash,
    steps: plan.steps.map((step) => ({ order: step.order, fn: step.invoke?.fn, reversible: step.reversible })),
  },
};

const outPath = path.join(root, "fixtures", "testnet", "phase5-smoke-report.json");
await fs.writeFile(outPath, `${JSON.stringify(out, null, 2)}\n`);
console.log(JSON.stringify(out, null, 2));
