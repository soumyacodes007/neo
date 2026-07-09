#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import { PoolContractV2, RequestType } from "@blend-capital/blend-sdk";
import {
  InMemoryRegistry,
  RpcClient,
  accountInstanceKey,
  computeAuthDigest,
  contractCodeKey,
  inspectAccount,
  traceTransaction,
} from "../packages/stellar/dist/index.js";
import { SMART_ACCOUNT_KIT_TESTNET_DEFAULTS } from "../packages/wallet-bridge/dist/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const requireFromStellar = createRequire(path.join(root, "packages", "stellar", "package.json"));
const sdk = await import(pathToFileURL(requireFromStellar.resolve("@stellar/stellar-sdk")).href);
const {
  Address,
  Contract,
  Hyper,
  Keypair,
  Networks,
  Operation,
  SorobanDataBuilder,
  TransactionBuilder,
  hash,
  nativeToScVal,
  rpc,
  xdr,
} = sdk;

const rpcUrl = process.env.STELLAR_RPC_URL ?? SMART_ACCOUNT_KIT_TESTNET_DEFAULTS.rpc_url;
const walletKit = { ...SMART_ACCOUNT_KIT_TESTNET_DEFAULTS, rpc_url: rpcUrl };
const installFixturePath = path.resolve(root, process.env.INSTALL_FIXTURE ?? "fixtures/testnet/phase8-blend-policy-install-result.json");
const planFixturePath = path.resolve(root, process.env.PLAN_FIXTURE ?? "fixtures/testnet/phase8-blend-policy-plan.json");
const useOutPath = path.resolve(root, process.env.USE_OUT ?? "fixtures/testnet/phase8-blend-policy-use-result.json");
const deploymentsPath = path.join(root, "fixtures", "testnet", "pb-policy-deployments.json");

const installFixture = JSON.parse(await fs.readFile(installFixturePath, "utf8"));
const plan = JSON.parse(await fs.readFile(planFixturePath, "utf8"));
const deployments = JSON.parse(await fs.readFile(deploymentsPath, "utf8"));
const sessionFixture = JSON.parse(await fs.readFile(path.join(root, ".tmp", "phase8-blend-session-key.json"), "utf8"));
const account = installFixture.account;
const pool = plan.blend.pool;
const reserve = plan.blend.reserve;
const wrongReserve = process.env.BLEND_WRONG_RESERVE ?? plan.blend.wrong_reserve ?? "CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU";
const amount = BigInt(plan.blend.amount);
const sessionSigner = Keypair.fromSecret(sessionFixture.secret);
const sessionKeyHex = sessionSigner.rawPublicKey().toString("hex");
const feePayer = Keypair.fromSecret(process.env.FEEPAYER_SECRET ?? readStellarSecret(process.env.FEEPAYER_ALIAS ?? "ozpb-feepayer"));

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
  async getTransaction(txHash) {
    const r = await this.call("getTransaction", { hash: txHash });
    if (r.status === "NOT_FOUND") return { status: "NOT_FOUND" };
    return { status: r.status, ledger: r.ledger, createdAt: r.createdAt, envelopeXdr: r.envelopeXdr, resultXdr: r.resultXdr, resultMetaXdr: r.resultMetaXdr };
  }
}

const backend = new JsonRpcBackend(rpcUrl);
const server = new rpc.Server(rpcUrl);
const client = RpcClient.create(backend, { budget: 1600 });
const ed25519WasmHash = await wasmHash(walletKit.ed25519_verifier_address);
const registry = new InMemoryRegistry()
  .registerAccountWasm(walletKit.account_wasm_hash)
  .registerVerifier(ed25519WasmHash, "ed25519");
for (const d of deployments.deployments) registry.registerPolicy(d.wasm_hash, d.classification);

const poolRule = installFixture.readback.installed_rules.find((rule) => rule.context_type.address === pool);
const tokenRule = installFixture.readback.installed_rules.find((rule) => rule.context_type.address === reserve);
if (!poolRule || !tokenRule) throw new Error("Blend install fixture must contain pool and reserve token rules");
const contextRuleIds = [poolRule.id, tokenRule.id];
const allRules = [poolRule, tokenRule];

const funding = await fundSmartAccount(amount * 2n);
const amountPlusOne = await submitExpectedFailure({ reserve, amount: amount + 1n, description: "Blend deny amount+1" });
const wrongToken = await submitExpectedFailure({ reserve: wrongReserve, amount, description: "Blend deny wrong reserve" });
const matching = await submitSignedBlend({ reserve, amount, description: "Blend matching submit" });
const trace = await traceTransaction({ source: { tx_hash: matching.hash } }, { rpc: client, network: "testnet", now: () => new Date().toISOString() });
const snapshot = await inspectAccount({ account, resolve_policy_state: false }, { rpc: client, registry, network: "testnet", now: () => new Date().toISOString() });

const out = {
  schema_version: "1",
  test_id: "phase8.blend-policy-use",
  created_at: new Date().toISOString(),
  network: "testnet",
  rpc_url: rpcUrl,
  account,
  blend: { pool, reserve, wrong_reserve: wrongReserve, amount: amount.toString(), request_type: "SupplyCollateral" },
  rule_ids: { pool: poolRule.id, token: tokenRule.id, context_rule_ids: contextRuleIds },
  funding,
  matching: {
    accepted: true,
    owner_passkey_used: false,
    transaction: matching,
    token_deltas: trace.token_deltas,
  },
  deny_cases: {
    amount_plus_one: amountPlusOne,
    wrong_reserve: wrongToken,
  },
  readback: {
    rule_count: snapshot.rule_count,
    snapshot_hash: snapshot.snapshot_hash,
  },
  source_fixtures: {
    install: path.relative(root, installFixturePath),
    plan: path.relative(root, planFixturePath),
  },
};
await fs.mkdir(path.dirname(useOutPath), { recursive: true });
await fs.writeFile(useOutPath, `${JSON.stringify(out, null, 2)}\n`);
console.log(JSON.stringify(out, null, 2));

async function fundSmartAccount(fundingAmount) {
  const source = await server.getAccount(feePayer.publicKey());
  const tx = new TransactionBuilder(source, { fee: "1000000", networkPassphrase: Networks.TESTNET })
    .addOperation(new Contract(reserve).call(
      "transfer",
      Address.fromString(feePayer.publicKey()).toScVal(),
      Address.fromString(account).toScVal(),
      nativeToScVal(fundingAmount, { type: "i128" }),
    ))
    .setTimeout(300)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (sim.error !== undefined) throw new Error(`Blend reserve funding simulation failed: ${sim.error}`);
  const assembled = rpc.assembleTransaction(tx, sim).build();
  applySorobanResourceLeeway(assembled);
  assembled.sign(feePayer);
  const send = await sendWithRetry(assembled);
  if (send.status !== "PENDING" && send.status !== "DUPLICATE") throw new Error(`Blend reserve funding submit failed: ${JSON.stringify(send)}`);
  const final = await waitForTx(send.hash);
  if (final.status !== "SUCCESS") throw new Error(`Blend reserve funding failed: ${JSON.stringify(final)}`);
  return { reserve, amount: fundingAmount.toString(), tx_hash: send.hash, status: final.status, ledger: final.ledger };
}

async function submitSignedBlend(input) {
  const built = await buildSignedBlend(input);
  if (built.signedAuthSimulationError !== undefined) throw new Error(`${input.description} signed-auth simulation failed: ${built.signedAuthSimulationError}`);
  const assembled = rpc.assembleTransaction(built.tx, built.signedAuthSimulation).build();
  appendAuthNonceFootprint(assembled);
  appendOzAccountAuthFootprint(assembled);
  applySorobanResourceLeeway(assembled);
  assembled.sign(feePayer);
  const send = await sendWithRetry(assembled);
  if (send.status !== "PENDING" && send.status !== "DUPLICATE") throw new Error(`${input.description} submit failed: ${JSON.stringify(send)}`);
  const final = await waitForTx(send.hash);
  if (final.status !== "SUCCESS") throw new Error(`${input.description} did not succeed: ${JSON.stringify(final)}`);
  return { status: final.status, hash: send.hash, ledger: final.ledger, auth_digest_hex: built.authProof.auth_digest_hex, context_rule_ids: contextRuleIds };
}

async function submitExpectedFailure(input) {
  let built;
  try {
    built = await buildSignedBlend(input);
  } catch (error) {
    return {
      accepted: false,
      expected_failure: true,
      phase: "unsigned_simulation",
      error: error instanceof Error ? error.message : String(error),
      context_rule_ids: contextRuleIds,
    };
  }
  if (built.signedAuthSimulationError !== undefined) {
    return { accepted: false, phase: "signed_auth_simulation", error: built.signedAuthSimulationError, auth_digest_hex: built.authProof.auth_digest_hex, context_rule_ids: contextRuleIds };
  }
  const assembled = rpc.assembleTransaction(built.tx, built.signedAuthSimulation).build();
  appendAuthNonceFootprint(assembled);
  appendOzAccountAuthFootprint(assembled);
  applySorobanResourceLeeway(assembled);
  assembled.sign(feePayer);
  const send = await sendWithRetry(assembled);
  if (send.status !== "PENDING" && send.status !== "DUPLICATE") {
    return { accepted: false, phase: "submit", submit_status: send.status, submit_error: JSON.stringify(send), auth_digest_hex: built.authProof.auth_digest_hex, context_rule_ids: contextRuleIds };
  }
  const final = await waitForTx(send.hash);
  return { accepted: final.status === "SUCCESS", expected_failure: final.status !== "SUCCESS", phase: "ledger_result", transaction_hash: send.hash, ledger: final.ledger, final_status: final.status, auth_digest_hex: built.authProof.auth_digest_hex, context_rule_ids: contextRuleIds };
}

async function buildSignedBlend(input) {
  const source = await server.getAccount(feePayer.publicKey());
  const op = xdr.Operation.fromXDR(
    new PoolContractV2(pool).submit({
      from: account,
      spender: account,
      to: account,
      requests: [{ request_type: RequestType.SupplyCollateral, address: input.reserve, amount: input.amount }],
    }),
    "base64",
  );
  const tx = new TransactionBuilder(source, { fee: "1000000", networkPassphrase: Networks.TESTNET })
    .addOperation(op)
    .setTimeout(300)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (sim.error !== undefined) throw new Error(`${input.description} simulation failed: ${sim.error}`);
  const authEntries = sim.result?.auth ?? [];
  const targetEntry = authEntries.find((entry) =>
    entry.credentials().switch().name === "sorobanCredentialsAddress" &&
    Address.fromScAddress(entry.credentials().address().address()).toString() === account
  );
  if (!targetEntry) throw new Error(`no auth entry for ${account}`);
  const latest = await server.getLatestLedger();
  const signedAuth = signOzAuthEntry(targetEntry, latest.sequence + 1000);
  tx.operations[0].auth = authEntries.map((entry) => entry === targetEntry ? signedAuth.entry : entry);
  const signedAuthSimulation = await server.simulateTransaction(tx);
  return { tx, authProof: signedAuth.proof, signedAuthSimulation, signedAuthSimulationError: signedAuthSimulation.error };
}

function signOzAuthEntry(entry, validUntilLedger) {
  const clone = xdr.SorobanAuthorizationEntry.fromXDR(entry.toXDR());
  const credentials = clone.credentials().address();
  credentials.signatureExpirationLedger(validUntilLedger);
  const preimage = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(new xdr.HashIdPreimageSorobanAuthorization({
    networkId: hash(Buffer.from(Networks.TESTNET)),
    nonce: credentials.nonce(),
    invocation: clone.rootInvocation(),
    signatureExpirationLedger: credentials.signatureExpirationLedger(),
  }));
  const signaturePayload = hash(preimage.toXDR());
  const authDigest = computeAuthDigest(Buffer.from(signaturePayload), contextRuleIds);
  const signature = sessionSigner.sign(authDigest);
  credentials.signature(encodeAuthPayloadScVal(signature));
  return { entry: clone, proof: { signature_payload_hex: Buffer.from(signaturePayload).toString("hex"), auth_digest_hex: Buffer.from(authDigest).toString("hex"), signature_hex: Buffer.from(signature).toString("hex") } };
}

function encodeAuthPayloadScVal(signature) {
  const signerScVal = xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol("External"),
    Address.fromString(walletKit.ed25519_verifier_address).toScVal(),
    xdr.ScVal.scvBytes(Buffer.from(sessionKeyHex, "hex")),
  ]);
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("context_rule_ids"), val: xdr.ScVal.scvVec(contextRuleIds.map((id) => xdr.ScVal.scvU32(id))) }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("signers"), val: xdr.ScVal.scvMap([new xdr.ScMapEntry({ key: signerScVal, val: xdr.ScVal.scvBytes(signature) })]) }),
  ]);
}

function appendAuthNonceFootprint(transaction) {
  const authEntry = transaction._tx.operations()[0].body().invokeHostFunctionOp().auth()[0];
  const credentials = authEntry.credentials().address();
  const nonce = xdr.Int64.fromString(credentials.nonce().toString());
  const nonceKey = xdr.LedgerKey.contractData(new xdr.LedgerKeyContractData({
    contract: Address.fromString(account).toScAddress(),
    key: xdr.ScVal.scvLedgerKeyNonce(new xdr.ScNonceKey({ nonce })),
    durability: xdr.ContractDataDurability.temporary(),
  }));
  const data = transaction._tx.ext().sorobanData();
  const builder = new SorobanDataBuilder(data);
  data.resources().footprint().readWrite([...builder.getReadWrite().filter((key) => !isNonceLedgerKey(key)), nonceKey]);
}

function appendOzAccountAuthFootprint(transaction) {
  const data = transaction._tx.ext().sorobanData();
  const builder = new SorobanDataBuilder(data);
  const callCapKeys = allRules.flatMap((rule) => rule.policies
    .filter((policy) => policy.classification === "pb:call_cap")
    .map((policy) => policyAccountContextKey(policy.address, account, rule.id)));
  const readWrite = uniqueLedgerKeys([...builder.getReadWrite(), ...callCapKeys]);
  data.resources().footprint().readWrite(readWrite);
  const readWriteKeys = new Set(readWrite.map((key) => key.toXDR("base64")));
  const readOnly = uniqueLedgerKeys([
    ...builder.getReadOnly(),
    ...allRules.flatMap((rule) => [
      accountStorageKey("ContextRuleData", xdr.ScVal.scvU32(rule.id)),
      ...rule.signers.map((signer) => accountStorageKey("SignerData", xdr.ScVal.scvU32(signer.signer_id))),
      ...rule.policies.map((policy) => accountStorageKey("PolicyData", xdr.ScVal.scvU32(policy.policy_id))),
      ...rule.policies.flatMap((policy) => [
        contractInstanceKey(policy.address),
        contractCodeKey(policy.wasm_hash),
        policyAccountContextKey(policy.address, account, rule.id),
      ]),
    ]),
    contractInstanceKey(walletKit.ed25519_verifier_address),
    contractCodeKey(ed25519WasmHash),
  ]).filter((key) => !readWriteKeys.has(key.toXDR("base64")));
  data.resources().footprint().readOnly(readOnly);
}

function policyAccountContextKey(policy, smartAccount, ruleId) {
  return xdr.LedgerKey.contractData(new xdr.LedgerKeyContractData({
    contract: Address.fromString(policy).toScAddress(),
    key: xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("AccountContext"), Address.fromString(smartAccount).toScVal(), xdr.ScVal.scvU32(ruleId)]),
    durability: xdr.ContractDataDurability.persistent(),
  }));
}

function accountStorageKey(label, id) {
  return xdr.LedgerKey.contractData(new xdr.LedgerKeyContractData({
    contract: Address.fromString(account).toScAddress(),
    key: xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(label), id]),
    durability: xdr.ContractDataDurability.persistent(),
  }));
}

function contractInstanceKey(contract) {
  return xdr.LedgerKey.contractData(new xdr.LedgerKeyContractData({
    contract: Address.fromString(contract).toScAddress(),
    key: xdr.ScVal.scvLedgerKeyContractInstance(),
    durability: xdr.ContractDataDurability.persistent(),
  }));
}

function uniqueLedgerKeys(keys) {
  const seen = new Set();
  const out = [];
  for (const key of keys) {
    const b64 = key.toXDR("base64");
    if (!seen.has(b64)) {
      seen.add(b64);
      out.push(key);
    }
  }
  return out;
}

function isNonceLedgerKey(key) {
  return key.switch().name === "contractData" && key.contractData().key().switch().name === "scvLedgerKeyNonce";
}

function applySorobanResourceLeeway(transaction) {
  const data = transaction._tx.ext().sorobanData();
  const resources = data.resources();
  resources.instructions(Math.max(resources.instructions(), 120_000_000));
  if (typeof resources.diskReadBytes === "function") resources.diskReadBytes(resources.diskReadBytes() + 32768);
  else resources.readBytes(resources.readBytes() + 32768);
  resources.writeBytes(resources.writeBytes() + 16384);
  data.resourceFee(Hyper.fromString("120000000"));
  transaction._tx.fee(130000000);
}

async function wasmHash(contract) {
  const read = await backend.getLedgerEntries([accountInstanceKey(contract).toXDR("base64")]);
  const entry = read.entries[0];
  if (!entry?.xdrB64) throw new Error(`could not read contract instance for ${contract}`);
  const data = xdr.LedgerEntryData.fromXDR(entry.xdrB64, "base64");
  const executable = data.contractData().val().instance().executable();
  if (executable.switch().name !== "contractExecutableWasm") throw new Error(`${contract} is not a WASM contract`);
  return Buffer.from(executable.wasmHash()).toString("hex");
}

async function sendWithRetry(transaction) {
  let last;
  for (let i = 0; i < 5; i++) {
    last = await server.sendTransaction(transaction);
    if (last.status !== "TRY_AGAIN_LATER") return last;
    await sleep(2000);
  }
  return last;
}

async function waitForTx(txHash) {
  let final = await backend.call("getTransaction", { hash: txHash });
  for (let i = 0; i < 50 && final.status !== "SUCCESS" && final.status !== "ERROR" && final.status !== "FAILED"; i++) {
    await sleep(1500);
    final = await backend.call("getTransaction", { hash: txHash });
  }
  return final;
}

function readStellarSecret(alias) {
  const direct = spawnSync("stellar", ["keys", "secret", alias], { cwd: root, encoding: "utf8" });
  if (direct.status === 0 && direct.stdout.trim()) return direct.stdout.trim();
  const viaWsl = spawnSync("wsl", ["bash", "-lc", `stellar keys secret ${shellQuote(alias)}`], { cwd: root, encoding: "utf8" });
  if (viaWsl.status === 0 && viaWsl.stdout.trim()) return viaWsl.stdout.trim();
  throw new Error(`could not read Stellar key alias ${alias}: ${direct.stderr || viaWsl.stderr}`);
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
