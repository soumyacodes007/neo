#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const requireFromStellar = createRequire(path.join(root, "packages", "stellar", "package.json"));
const sdk = await import(pathToFileURL(requireFromStellar.resolve("@stellar/stellar-sdk")).href);
const { Address, nativeToScVal, xdr } = sdk;

const fixtureDir = path.join(root, "fixtures", "testnet");
const pbDeploymentsPath = path.join(fixtureDir, "pb-policy-deployments.json");
const phase5TokenPath = path.join(fixtureDir, "phase5-token-transfer-tx.json");
const inputPath = path.join(fixtureDir, "sd4-compose-blend-submit-input.json");
const reportPath = path.join(fixtureDir, "sd4-compose-blend-submit-report.json");

const deployments = JSON.parse(await fs.readFile(pbDeploymentsPath, "utf8"));
const blendRegistry = await loadBlendRegistry();
const tokenFixture = await readJsonIfExists(phase5TokenPath);

const targetContract = process.env.SD4_BLEND_TARGET_CONTRACT
  ?? blendRegistry.ids.TestnetV2;
const reserve = process.env.SD4_BLEND_TOKEN_CONTRACT
  ?? blendRegistry.ids.XLM
  ?? tokenFixture?.target?.contract;
const wrongToken = process.env.SD4_BLEND_WRONG_TOKEN_CONTRACT
  ?? blendRegistry.ids.USDC
  ?? deploymentAddress(deployments, "pb:rate_limit");
const smartAccount = process.env.SD4_SMART_ACCOUNT
  ?? tokenFixture?.account
  ?? "CAQDTHE55MGS5XX5GV7QSWXM4BKXCUF5D2E5CHH6T2UDU4NP7Z3O62HG";

const submit400 = submitArgs(reserve, "400");
const submit401 = submitArgs(reserve, "401");
const submitWrongToken = submitArgs(wrongToken, "400");

const input = {
  snapshot_path: null,
  account: smartAccount,
  rule: {
    id: 42,
    target_contract: targetContract,
    valid_until: 4_000_000,
  },
  policies: [
    { kind: "function_allowlist", allowed: ["submit"] },
    {
      kind: "arg_guard",
      rules: [
        {
          fn_name: "submit",
          arg_index: 0,
          path: [{ kind: "wildcard" }, { kind: "field", name: "request_type" }],
          pred: { kind: "u32_in", values: [2] },
          forall: true,
        },
        {
          fn_name: "submit",
          arg_index: 0,
          path: [{ kind: "wildcard" }, { kind: "field", name: "address" }],
          pred: { kind: "addr_eq", address: reserve },
          forall: true,
        },
      ],
    },
    {
      kind: "call_cap",
      cap: "400",
      period_ledgers: 17_280,
      fn_name: "submit",
      amount_path: [{ kind: "index", index: 0 }, { kind: "wildcard" }, { kind: "field", name: "amount" }],
      token_filter_path: [{ kind: "index", index: 0 }, { kind: "wildcard" }, { kind: "field", name: "address" }],
      token_filter_token: reserve,
    },
  ],
  cases: [
    {
      id: "blend-submit-400-reserve",
      kind: "permit",
      context: { contract: targetContract, fn_name: "submit", args_scval_b64: [submit400] },
      expected: { kind: "pass" },
    },
    {
      id: "blend-submit-401-reserve-denied",
      kind: "deny",
      context: { contract: targetContract, fn_name: "submit", args_scval_b64: [submit401] },
      expected: { kind: "panic", contract_error_code: 3344 },
    },
    {
      id: "blend-submit-wrong-token-denied",
      kind: "deny",
      context: { contract: targetContract, fn_name: "submit", args_scval_b64: [submitWrongToken] },
      expected: { kind: "panic", contract_error_code: 3325 },
    },
    {
      id: "blend-withdraw-wrong-function-denied",
      kind: "deny",
      context: { contract: targetContract, fn_name: "withdraw", args_scval_b64: [submit400] },
      expected: { kind: "panic", contract_error_code: 3303 },
    },
  ],
};

await fs.mkdir(fixtureDir, { recursive: true });
await fs.writeFile(inputPath, `${JSON.stringify(input, null, 2)}\n`);

const stdout = execFileSync("wsl", [
  "bash",
  "-lc",
  `cd ${shellQuote(await wslPath(root))} && cargo run --quiet --manifest-path rust/harness/Cargo.toml -- ${shellQuote(await wslPath(inputPath))}`,
], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const harness = JSON.parse(stdout);
const failed = harness.cases.filter((c) => c.outcome !== "pass");
const report = {
  schema_version: "1",
  test_id: "T-P.compose-blend-submit",
  created_at: new Date().toISOString(),
  network_evidence: {
    pb_deployments_fixture: "fixtures/testnet/pb-policy-deployments.json",
    deployed_policy_contracts: deployments.deployments,
    blend_registry_source: "https://raw.githubusercontent.com/blend-capital/blend-utils/main/testnet.contracts.json",
    blend_contracts: blendRegistry.ids,
    source_account: deployments.source_account,
  },
  sandbox: {
    engine: "rust/harness",
    input_fixture: "fixtures/testnet/sd4-compose-blend-submit-input.json",
    toolchain_fingerprint: harness.toolchain_fingerprint,
  },
  blend_shape: {
    target_contract: targetContract,
    asset_token: reserve,
    request_vector_fields: ["request_type", "address", "amount"],
  },
  verdict: failed.length === 0 ? "pass" : "fail",
  cases: harness.cases,
};
await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));

function submitArgs(token, amount) {
  const request = xdr.ScVal.scvMap([
    entry("amount", nativeToScVal(BigInt(amount), { type: "i128" })),
    entry("address", Address.fromString(token).toScVal()),
    entry("request_type", xdr.ScVal.scvU32(2)),
  ].sort((a, b) => symbolOf(a.key()).localeCompare(symbolOf(b.key()))));
  return xdr.ScVal.scvVec([request]).toXDR("base64");
}

function entry(key, val) {
  return new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val });
}

function symbolOf(scVal) {
  return Buffer.from(scVal.sym()).toString("utf8");
}

function deploymentAddress(deployments, classification) {
  const found = deployments.deployments.find((d) => d.classification === classification);
  if (found === undefined) throw new Error(`missing deployment for ${classification}`);
  return found.contract_id ?? found.address;
}

async function loadBlendRegistry() {
  const url = "https://raw.githubusercontent.com/blend-capital/blend-utils/main/testnet.contracts.json";
  const response = await fetch(url);
  if (!response.ok) throw new Error(`failed to fetch Blend registry ${url}: ${String(response.status)}`);
  return await response.json();
}

async function readJsonIfExists(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return undefined;
  }
}

async function wslPath(file) {
  return execFileSync("wsl", ["wslpath", "-a", file.replaceAll("\\", "/")], { encoding: "utf8" }).trim();
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}
