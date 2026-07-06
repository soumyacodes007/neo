#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import {
  InMemoryRegistry,
  RpcClient,
  computeAuthDigest,
  encodeAddContextRuleArgs,
  encodeInstallParams,
  inspectAccount,
} from "../packages/stellar/dist/index.js";
import { checkPolicyCoverage } from "../packages/wallet-bridge/dist/index.js";

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
  SorobanDataBuilder,
  TransactionBuilder,
  hash,
  rpc,
  xdr,
} = sdk;

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
}

const fixturePath = path.join(root, "fixtures", "testnet", "oz-fixture.json");
const pbDeploymentsPath = path.join(root, "fixtures", "testnet", "pb-policy-deployments.json");
const outPath = path.join(root, "fixtures", "testnet", "sd4-session-key-demo-result.json");
const rpcUrl = process.env.STELLAR_RPC_URL ?? "https://soroban-testnet.stellar.org";
const sourceAlias = process.env.SOURCE_ACCOUNT ?? "ozpb-feepayer";
const ownerSeedHex = process.env.OZPB_EXTERNAL_SIGNER_SEED_HEX ?? "00".repeat(32);

const fixture = JSON.parse(await fs.readFile(fixturePath, "utf8"));
const pbDeployments = JSON.parse(await fs.readFile(pbDeploymentsPath, "utf8"));
const functionAllowlist = deployment(pbDeployments, "pb:function_allowlist");
const backend = new JsonRpcBackend(rpcUrl);
const client = RpcClient.create(backend, { budget: 1200 });
const registry = buildRegistry(fixture, pbDeployments);
const server = new rpc.Server(rpcUrl);
const feePayerSecret = process.env.FEEPAYER_SECRET ?? readStellarSecret(sourceAlias);
const feePayer = Keypair.fromSecret(feePayerSecret);
const ownerSigner = Keypair.fromRawEd25519Seed(Buffer.from(ownerSeedHex, "hex"));
if (ownerSigner.rawPublicKey().toString("hex") !== fixture.external_signer_key_hex) {
  throw new Error("OZPB_EXTERNAL_SIGNER_SEED_HEX does not match fixture.external_signer_key_hex");
}

const before = await inspect();
const newRuleId = before.next_rule_id;
const sessionSeed = randomBytes(32);
const sessionSigner = Keypair.fromRawEd25519Seed(sessionSeed);
const sessionKeyHex = sessionSigner.rawPublicKey().toString("hex");
const latest = await server.getLatestLedger();
const validUntil = latest.sequence + 17_280;
const ruleName = `sd4-${String(newRuleId)}`.slice(0, 20);

const installArgs = encodeAddContextRuleArgs({
  contextType: { kind: "call_contract", address: fixture.account },
  name: ruleName,
  validUntil,
  signers: [{
    type: "external",
    verifier: fixture.ed25519_verifier,
    key_data_b64: Buffer.from(sessionKeyHex, "hex").toString("base64"),
    verifier_kind: "ed25519",
  }],
  policies: [{
    address: functionAllowlist.contract_id ?? functionAllowlist.address,
    installParams: encodeInstallParams("pb:function_allowlist", { functions: ["batch_add_signer"] }),
  }],
});

const install = await submitSignedSmartAccountInvocation({
  contract: fixture.account,
  fn: "add_context_rule",
  args: installArgs,
  signingKey: ownerSigner,
  signerKeyHex: fixture.external_signer_key_hex,
  contextRuleIds: [0],
  authFootprint: { ruleId: 0, signerId: 0 },
  description: "install session-key context rule",
});

const afterInstall = await inspect();
const installedRule = afterInstall.rules.find((r) => r.id === newRuleId);
if (installedRule === undefined) {
  throw new Error(`installed tx succeeded but rule ${String(newRuleId)} was not found`);
}
const sessionSignerRef = installedRule.signers.find((s) =>
  s.signer.type === "external" &&
  Buffer.from(s.signer.key_data_b64, "base64").toString("hex") === sessionKeyHex
);
if (sessionSignerRef?.signer_id === undefined) {
  throw new Error("installed rule did not expose the session signer id");
}

const matching = await submitSignedSmartAccountInvocation({
  contract: fixture.account,
  fn: "batch_add_signer",
  args: [xdr.ScVal.scvU32(newRuleId), xdr.ScVal.scvVec([])],
  signingKey: sessionSigner,
  signerKeyHex: sessionKeyHex,
  contextRuleIds: [newRuleId],
  authFootprint: {
    ruleId: newRuleId,
    signerId: sessionSignerRef.signer_id,
    policyIds: installedRule.policies.map((policy) => policy.policy_id).filter((id) => id !== undefined),
    policyContracts: installedRule.policies.map((policy) => ({
      address: policy.address,
      wasmHash: policy.wasm_hash,
      classification: policy.classification,
    })).filter((policy) => policy.wasmHash !== undefined),
  },
  description: "matching session-key action",
});

const changed = await simulateSignedSmartAccountInvocation({
  contract: fixture.account,
  fn: "remove_context_rule",
  args: [xdr.ScVal.scvU32(0)],
  signingKey: sessionSigner,
  signerKeyHex: sessionKeyHex,
  contextRuleIds: [newRuleId],
});

const coverageInstalled = [{
  contract: fixture.account,
  fn: "batch_add_signer",
  valid_until_ledger: validUntil,
}];
const coverage = {
  matching: checkPolicyCoverage({
    action: { contract: fixture.account, fn: "batch_add_signer" },
    installed: coverageInstalled,
    current_ledger: latest.sequence,
  }),
  changed: checkPolicyCoverage({
    action: { contract: fixture.account, fn: "remove_context_rule" },
    installed: coverageInstalled,
    current_ledger: latest.sequence,
  }),
};

const out = {
  schema_version: "1",
  test_id: "SD4.full-policy-install-session-key",
  created_at: new Date().toISOString(),
  network: "testnet",
  rpc_url: rpcUrl,
  account: fixture.account,
  owner_signer: {
    type: "external",
    verifier: fixture.ed25519_verifier,
    key_data_hex: fixture.external_signer_key_hex,
  },
  session_signer: {
    type: "external",
    verifier: fixture.ed25519_verifier,
    key_data_hex: sessionKeyHex,
    signer_id: sessionSignerRef.signer_id,
  },
  installed_rule: {
    id: newRuleId,
    name: ruleName,
    valid_until_ledger: validUntil,
    context_type: installedRule.context_type,
    policies: installedRule.policies,
  },
  transactions: {
    install_context_rule: install,
    matching_session_action: matching,
  },
  changed_action: {
    contract: fixture.account,
    fn: "remove_context_rule",
    submitted: false,
    reason_not_submitted: "coverage_router_requires_owner_approval",
    session_signed_simulation_diagnostic: changed,
    route_decision: coverage.changed,
  },
  coverage_decisions: coverage,
  wasm_hashes: {
    account: fixture.account_wasm_hash,
    ed25519_verifier: fixture.ed25519_verifier_wasm_hash,
    function_allowlist: functionAllowlist.wasm_hash,
  },
};
await fs.writeFile(outPath, `${JSON.stringify(out, null, 2)}\n`);
console.log(JSON.stringify(out, null, 2));

async function submitSignedSmartAccountInvocation(input) {
  const built = await buildSignedSmartAccountInvocation(input);
  if (built.signedAuthSimulationError !== undefined) {
    throw new Error(`${input.description} signed-auth simulation failed: ${built.signedAuthSimulationError}`);
  }
  const assembled = rpc.assembleTransaction(built.tx, built.signedAuthSimulation).build();
  appendAuthNonceFootprint(assembled, fixture.account);
  appendOzAccountAuthFootprint(
    assembled,
    fixture,
    input.authFootprint.ruleId,
    input.authFootprint.signerId,
    input.authFootprint.policyIds ?? [],
    input.authFootprint.policyContracts ?? [],
  );
  applySorobanResourceLeeway(assembled);
  assembled.sign(feePayer);
  const send = await sendWithRetry(assembled);
  if (send.status !== "PENDING" && send.status !== "DUPLICATE") {
    throw new Error(`${input.description} submit failed before ingestion: ${JSON.stringify(send)}`);
  }
  const final = await waitForTx(send.hash);
  if (final.status !== "SUCCESS") {
    throw new Error(`${input.description} did not succeed: ${JSON.stringify({ send, final })}`);
  }
  return {
    status: final.status,
    hash: send.hash,
    ledger: final.ledger,
    fn: input.fn,
    auth_digest_hex: built.authProof.auth_digest_hex,
    context_rule_ids: input.contextRuleIds,
  };
}

async function simulateSignedSmartAccountInvocation(input) {
  const built = await buildSignedSmartAccountInvocation(input);
  if (built.signedAuthSimulationError !== undefined) {
    return {
      accepted: false,
      phase: "signed_auth_simulation",
      error: built.signedAuthSimulationError,
      auth_digest_hex: built.authProof.auth_digest_hex,
      context_rule_ids: input.contextRuleIds,
    };
  }
  return {
    accepted: true,
    phase: "signed_auth_simulation",
    auth_digest_hex: built.authProof.auth_digest_hex,
    context_rule_ids: input.contextRuleIds,
  };
}

async function buildSignedSmartAccountInvocation(input) {
  const source = await server.getAccount(feePayer.publicKey());
  const tx = new TransactionBuilder(source, { fee: "1000000", networkPassphrase: Networks.TESTNET })
    .addOperation(new Contract(input.contract).call(input.fn, ...input.args))
    .setTimeout(300)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (sim.error !== undefined) throw new Error(`${input.fn} simulation failed: ${sim.error}`);
  const authEntries = sim.result?.auth ?? [];
  if (authEntries.length !== 1) throw new Error(`expected one auth entry for ${input.fn}, got ${String(authEntries.length)}`);
  const latestLedger = await server.getLatestLedger();
  const signedAuth = signOzAuthEntry(
    authEntries[0],
    latestLedger.sequence + 1000,
    input.signingKey,
    input.signerKeyHex,
    input.contextRuleIds,
  );
  tx.operations[0].auth = [signedAuth.entry];
  const signedAuthSimulation = await server.simulateTransaction(tx);
  return {
    tx,
    authProof: signedAuth.proof,
    signedAuthSimulation,
    signedAuthSimulationError: signedAuthSimulation.error,
  };
}

function signOzAuthEntry(entry, validUntilLedger, signer, signerKeyHex, contextRuleIds) {
  const clone = xdr.SorobanAuthorizationEntry.fromXDR(entry.toXDR());
  const credentials = clone.credentials().address();
  credentials.signatureExpirationLedger(validUntilLedger);
  const preimage = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
    new xdr.HashIdPreimageSorobanAuthorization({
      networkId: hash(Buffer.from(Networks.TESTNET)),
      nonce: credentials.nonce(),
      invocation: clone.rootInvocation(),
      signatureExpirationLedger: credentials.signatureExpirationLedger(),
    }),
  );
  const signaturePayload = hash(preimage.toXDR());
  const authDigest = computeAuthDigest(Buffer.from(signaturePayload), contextRuleIds);
  const signature = signer.sign(authDigest);
  credentials.signature(encodeAuthPayloadScVal(signerKeyHex, contextRuleIds, signature));
  return {
    entry: clone,
    proof: {
      signature_payload_hex: Buffer.from(signaturePayload).toString("hex"),
      auth_digest_hex: Buffer.from(authDigest).toString("hex"),
      signature_hex: Buffer.from(signature).toString("hex"),
    },
  };
}

function encodeAuthPayloadScVal(keyHex, contextRuleIds, signature) {
  const signerScVal = xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol("External"),
    Address.fromString(fixture.ed25519_verifier).toScVal(),
    xdr.ScVal.scvBytes(Buffer.from(keyHex, "hex")),
  ]);
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("context_rule_ids"), val: xdr.ScVal.scvVec(contextRuleIds.map((id) => xdr.ScVal.scvU32(id))) }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("signers"),
      val: xdr.ScVal.scvMap([new xdr.ScMapEntry({ key: signerScVal, val: xdr.ScVal.scvBytes(signature) })]),
    }),
  ]);
}

function appendAuthNonceFootprint(transaction, account) {
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
  const readOnly = builder.getReadOnly();
  const readWrite = [...builder.getReadWrite().filter((key) => !isNonceLedgerKey(key)), nonceKey];
  data.resources().footprint().readOnly(readOnly);
  data.resources().footprint().readWrite(readWrite);
}

function appendOzAccountAuthFootprint(transaction, fx, ruleId, signerId, policyIds, policyContracts) {
  const data = transaction._tx.ext().sorobanData();
  const builder = new SorobanDataBuilder(data);
  const readWrite = builder.getReadWrite();
  const readWriteKeys = new Set(readWrite.map((key) => key.toXDR("base64")));
  const readOnly = uniqueLedgerKeys([
    ...builder.getReadOnly(),
    accountStorageKey(fx.account, "ContextRuleData", xdr.ScVal.scvU32(ruleId)),
    accountStorageKey(fx.account, "SignerData", xdr.ScVal.scvU32(signerId)),
    ...policyIds.map((id) => accountStorageKey(fx.account, "PolicyData", xdr.ScVal.scvU32(id))),
    ...policyContracts.flatMap((policy) => [
      contractInstanceKey(policy.address),
      contractCodeKey(policy.wasmHash),
      ...(policy.classification === "pb:function_allowlist"
        ? [policyAccountContextKey(policy.address, fx.account, ruleId)]
        : []),
    ]),
    contractInstanceKey(fx.ed25519_verifier),
    contractCodeKey(fx.ed25519_verifier_wasm_hash),
  ]).filter((key) => !readWriteKeys.has(key.toXDR("base64")));
  data.resources().footprint().readOnly(readOnly);
}

function policyAccountContextKey(policy, account, ruleId) {
  return xdr.LedgerKey.contractData(new xdr.LedgerKeyContractData({
    contract: Address.fromString(policy).toScAddress(),
    key: xdr.ScVal.scvVec([
      xdr.ScVal.scvSymbol("AccountContext"),
      Address.fromString(account).toScVal(),
      xdr.ScVal.scvU32(ruleId),
    ]),
    durability: xdr.ContractDataDurability.persistent(),
  }));
}

function accountStorageKey(account, label, id) {
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

function contractCodeKey(wasmHash) {
  return xdr.LedgerKey.contractCode(new xdr.LedgerKeyContractCode({ hash: Buffer.from(wasmHash, "hex") }));
}

function uniqueLedgerKeys(keys) {
  const seen = new Set();
  const out = [];
  for (const key of keys) {
    const b64 = key.toXDR("base64");
    if (seen.has(b64)) continue;
    seen.add(b64);
    out.push(key);
  }
  return out;
}

function isNonceLedgerKey(key) {
  return key.switch().name === "contractData" && key.contractData().key().switch().name === "scvLedgerKeyNonce";
}

function applySorobanResourceLeeway(transaction) {
  const data = transaction._tx.ext().sorobanData();
  const resources = data.resources();
  resources.instructions(Math.max(resources.instructions(), 50_000_000));
  if (typeof resources.diskReadBytes === "function") {
    resources.diskReadBytes(resources.diskReadBytes() + 8192);
  } else {
    resources.readBytes(resources.readBytes() + 8192);
  }
  resources.writeBytes(resources.writeBytes() + 4096);
  data.resourceFee(Hyper.fromString("50000000"));
  transaction._tx.fee(60000000);
}

async function inspect() {
  return inspectAccount(
    { account: fixture.account },
    { rpc: client, registry, network: "testnet", now: () => new Date().toISOString() },
  );
}

async function waitForTx(hashValue) {
  let final = await backend.call("getTransaction", { hash: hashValue });
  for (let i = 0; i < 40 && final.status !== "SUCCESS" && final.status !== "ERROR" && final.status !== "FAILED"; i++) {
    await sleep(1500);
    final = await backend.call("getTransaction", { hash: hashValue });
  }
  return final;
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

function deployment(deployments, classification) {
  const found = deployments.deployments.find((d) => d.classification === classification);
  if (found === undefined) throw new Error(`missing deployment for ${classification}`);
  return found;
}

function buildRegistry(fx, deployments) {
  const r = new InMemoryRegistry()
    .registerAccountWasm(fx.account_wasm_hash)
    .registerVerifier(fx.ed25519_verifier_wasm_hash, "ed25519")
    .registerPolicy(fx.threshold_policy_wasm_hash, "oz:simple_threshold");
  for (const d of deployments.deployments) {
    r.registerPolicy(d.wasm_hash, d.classification);
  }
  return r;
}

function readStellarSecret(alias) {
  return execFileSync("wsl", ["bash", "-lc", `stellar keys secret ${shellQuote(alias)}`], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
