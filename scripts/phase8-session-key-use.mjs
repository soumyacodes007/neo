#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import {
  InMemoryRegistry,
  RpcClient,
  accountInstanceKey,
  computeAuthDigest,
  contractCodeKey,
  encodeAddContextRuleArgs,
  encodeInstallParams,
  inspectAccount,
  traceTransaction,
} from "../packages/stellar/dist/index.js";
import {
  SMART_ACCOUNT_KIT_TESTNET_DEFAULTS,
  checkPolicyCoverage,
} from "../packages/wallet-bridge/dist/index.js";

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
  nativeToScVal,
  rpc,
  xdr,
} = sdk;

const walletFixturePath = path.join(root, "fixtures", "testnet", "phase8-wallet-demo-result.json");
const installFixturePath = path.join(root, "fixtures", "testnet", "phase8-session-rule-install-result.json");
const sessionPath = path.join(root, ".tmp", "phase8-session-key.json");
const outPath = path.join(root, "fixtures", "testnet", "phase8-session-key-use-result.json");
const strictOutPath = path.join(root, "fixtures", "testnet", "phase8-strict-policy-plan.json");
const rpcUrl = process.env.STELLAR_RPC_URL ?? SMART_ACCOUNT_KIT_TESTNET_DEFAULTS.rpc_url;
const walletKit = { ...SMART_ACCOUNT_KIT_TESTNET_DEFAULTS, rpc_url: rpcUrl };
const transferAmountStroops = BigInt(process.env.PHASE8_TRANSFER_STROOPS ?? "1000000");

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

  async getTransaction(txHash) {
    const r = await this.call("getTransaction", { hash: txHash });
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
const installFixture = JSON.parse(await fs.readFile(installFixturePath, "utf8"));
const sessionFixture = JSON.parse(await fs.readFile(sessionPath, "utf8"));
const account = installFixture.account ?? walletFixture.approval?.account;
const rule = installFixture.readback?.installed_rule;
const sessionSigner = Keypair.fromSecret(sessionFixture.secret);
const sessionKeyHex = sessionSigner.rawPublicKey().toString("hex");
if (!account || !rule) throw new Error("phase8 install fixture is missing account or installed rule");
if (sessionKeyHex !== installFixture.session_signer?.public_key_hex) {
  throw new Error("local session key does not match installed fixture signer");
}

const backend = new JsonRpcBackend(rpcUrl);
const server = new rpc.Server(rpcUrl);
const client = RpcClient.create(backend, { budget: 1200 });
const ed25519WasmHash = await wasmHash(walletKit.ed25519_verifier_address);
const registry = new InMemoryRegistry()
  .registerAccountWasm(walletKit.account_wasm_hash)
  .registerVerifier(ed25519WasmHash, "ed25519")
  .registerPolicy(installFixture.readback.installed_rule.policies[0].wasm_hash, "oz:simple_threshold");
const feePayer = Keypair.fromSecret(process.env.FEEPAYER_SECRET ?? readStellarSecret(process.env.FEEPAYER_ALIAS ?? "ozpb-feepayer"));
const recipient = process.env.PHASE8_RECIPIENT_ADDRESS ?? feePayer.publicKey();
const latest = await server.getLatestLedger();

const matching = await submitSignedSmartAccountInvocation({
  contract: walletKit.native_token_contract,
  fn: "transfer",
  args: [
    Address.fromString(account).toScVal(),
    Address.fromString(recipient).toScVal(),
    nativeToScVal(transferAmountStroops, { type: "i128" }),
  ],
  signingKey: sessionSigner,
  signerKeyHex: sessionKeyHex,
  contextRuleIds: [rule.id],
  authFootprint: await authFootprint(rule.id, installFixture.session_signer.signer_id),
  description: "matching session-key native transfer",
});

const changedWrongFunction = await simulateSignedSmartAccountInvocation({
  contract: walletKit.native_token_contract,
  fn: "approve",
  args: [
    Address.fromString(account).toScVal(),
    Address.fromString(recipient).toScVal(),
    nativeToScVal(transferAmountStroops, { type: "i128" }),
    xdr.ScVal.scvU32(latest.sequence + 1000),
  ],
  signingKey: sessionSigner,
  signerKeyHex: sessionKeyHex,
  contextRuleIds: [rule.id],
  authFootprint: await authFootprint(rule.id, installFixture.session_signer.signer_id),
});

const changedWrongContract = await simulateSignedSmartAccountInvocation({
  contract: account,
  fn: "remove_context_rule",
  args: [xdr.ScVal.scvU32(0)],
  signingKey: sessionSigner,
  signerKeyHex: sessionKeyHex,
  contextRuleIds: [rule.id],
  authFootprint: await authFootprint(rule.id, installFixture.session_signer.signer_id),
});

const matchingTrace = await traceTransaction(
  { source: { tx_hash: matching.hash } },
  { rpc: client, network: "testnet", now: () => new Date().toISOString() },
);
const snapshot = await inspect();
const strictPolicyPlan = await writeStrictPolicyPlan(snapshot);
const installedCoverage = [{
  contract: walletKit.native_token_contract,
  fn: "transfer",
  max_amount_i128: transferAmountStroops.toString(),
  valid_until_ledger: rule.valid_until_ledger,
}];
const routeDecisions = {
  matching_transfer: checkPolicyCoverage({
    action: { contract: walletKit.native_token_contract, fn: "transfer", amount_i128: transferAmountStroops.toString() },
    installed: installedCoverage,
    current_ledger: latest.sequence,
  }),
  amount_plus_one: checkPolicyCoverage({
    action: { contract: walletKit.native_token_contract, fn: "transfer", amount_i128: (transferAmountStroops + 1n).toString() },
    installed: installedCoverage,
    current_ledger: latest.sequence,
  }),
  wrong_function: checkPolicyCoverage({
    action: { contract: walletKit.native_token_contract, fn: "approve", amount_i128: transferAmountStroops.toString() },
    installed: installedCoverage,
    current_ledger: latest.sequence,
  }),
  wrong_contract: checkPolicyCoverage({
    action: { contract: account, fn: "remove_context_rule" },
    installed: installedCoverage,
    current_ledger: latest.sequence,
  }),
};

const out = {
  schema_version: "1",
  test_id: "phase8.session-key-use-and-fallback",
  created_at: new Date().toISOString(),
  network: "testnet",
  rpc_url: rpcUrl,
  account,
  installed_rule_id: rule.id,
  installed_rule_name: rule.name,
  session_signer: {
    type: "external",
    verifier: walletKit.ed25519_verifier_address,
    public_key_hex: sessionKeyHex,
    signer_id: installFixture.session_signer.signer_id,
  },
  matching_session_key_action: {
    description: "native token transfer signed only by the Ed25519 session key",
    owner_passkey_used: false,
    recipient,
    amount_stroops: transferAmountStroops.toString(),
    transaction: matching,
    trace: {
      tx_hash: matchingTrace.tx_hash,
      ledger: matchingTrace.ledger,
      successful: matchingTrace.successful,
      auth_entries: matchingTrace.auth_entries.length,
      token_deltas: matchingTrace.token_deltas,
    },
  },
  changed_action_fallbacks: {
    amount_plus_one: {
      submitted: false,
      route_decision: routeDecisions.amount_plus_one,
      fallback: "human_passkey_required",
    },
    wrong_function: {
      submitted: false,
      route_decision: routeDecisions.wrong_function,
      session_signed_simulation: changedWrongFunction,
      fallback: "human_passkey_required",
    },
    wrong_contract: {
      submitted: false,
      route_decision: routeDecisions.wrong_contract,
      session_signed_simulation: changedWrongContract,
      fallback: "human_passkey_required",
    },
  },
  route_decisions: routeDecisions,
  strict_policy_plan: strictPolicyPlan,
  readback: {
    rule_count: snapshot.rule_count,
    snapshot_hash: snapshot.snapshot_hash,
  },
};

await fs.mkdir(path.dirname(outPath), { recursive: true });
await fs.writeFile(outPath, `${JSON.stringify(out, null, 2)}\n`);
console.log(JSON.stringify(out, null, 2));

async function submitSignedSmartAccountInvocation(input) {
  const built = await buildSignedSmartAccountInvocation(input);
  if (built.signedAuthSimulationError !== undefined) {
    throw new Error(`${input.description} signed-auth simulation failed: ${built.signedAuthSimulationError}`);
  }
  const assembled = rpc.assembleTransaction(built.tx, built.signedAuthSimulation).build();
  appendAuthNonceFootprint(assembled, account);
  appendOzAccountAuthFootprint(assembled, input.authFootprint);
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
  return {
    accepted: built.signedAuthSimulationError === undefined,
    phase: "signed_auth_simulation",
    ...(built.signedAuthSimulationError ? { error: built.signedAuthSimulationError } : {}),
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
  const targetEntry = authEntries.find((entry) =>
    entry.credentials().switch().name === "sorobanCredentialsAddress" &&
    Address.fromScAddress(entry.credentials().address().address()).toString() === account
  );
  if (targetEntry === undefined) throw new Error(`no auth entry for ${account} in ${input.fn}`);
  const latestLedger = await server.getLatestLedger();
  const signedAuth = signOzAuthEntry(
    targetEntry,
    latestLedger.sequence + 1000,
    input.signingKey,
    input.signerKeyHex,
    input.contextRuleIds,
  );
  tx.operations[0].auth = authEntries.map((entry) => entry === targetEntry ? signedAuth.entry : entry);
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
    Address.fromString(walletKit.ed25519_verifier_address).toScVal(),
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

async function authFootprint(ruleId, signerId) {
  const current = await inspect();
  const currentRule = current.rules.find((r) => r.id === ruleId);
  if (!currentRule) throw new Error(`rule ${String(ruleId)} is not installed`);
  return {
    ruleId,
    signerId,
    policyIds: currentRule.policies.map((policy) => policy.policy_id).filter((id) => id !== undefined),
    policyContracts: currentRule.policies.map((policy) => ({
      address: policy.address,
      wasmHash: policy.wasm_hash,
      classification: policy.classification,
    })).filter((policy) => policy.wasmHash !== undefined),
  };
}

function appendAuthNonceFootprint(transaction, smartAccount) {
  const authEntry = transaction._tx.operations()[0].body().invokeHostFunctionOp().auth()[0];
  const credentials = authEntry.credentials().address();
  const nonce = xdr.Int64.fromString(credentials.nonce().toString());
  const nonceKey = xdr.LedgerKey.contractData(new xdr.LedgerKeyContractData({
    contract: Address.fromString(smartAccount).toScAddress(),
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

function appendOzAccountAuthFootprint(transaction, footprint) {
  const data = transaction._tx.ext().sorobanData();
  const builder = new SorobanDataBuilder(data);
  const readWrite = builder.getReadWrite();
  const readWriteKeys = new Set(readWrite.map((key) => key.toXDR("base64")));
  const readOnly = uniqueLedgerKeys([
    ...builder.getReadOnly(),
    accountStorageKey(account, "ContextRuleData", xdr.ScVal.scvU32(footprint.ruleId)),
    accountStorageKey(account, "SignerData", xdr.ScVal.scvU32(footprint.signerId)),
    ...footprint.policyIds.map((id) => accountStorageKey(account, "PolicyData", xdr.ScVal.scvU32(id))),
    ...footprint.policyContracts.flatMap((policy) => [
      contractInstanceKey(policy.address),
      contractCodeKey(policy.wasmHash),
      policyAccountContextKey(policy.address, account, footprint.ruleId),
    ]),
    contractInstanceKey(walletKit.ed25519_verifier_address),
    contractCodeKey(ed25519WasmHash),
  ]).filter((key) => !readWriteKeys.has(key.toXDR("base64")));
  data.resources().footprint().readOnly(readOnly);
}

function policyAccountContextKey(policy, smartAccount, ruleId) {
  return xdr.LedgerKey.contractData(new xdr.LedgerKeyContractData({
    contract: Address.fromString(policy).toScAddress(),
    key: xdr.ScVal.scvVec([
      xdr.ScVal.scvSymbol("AccountContext"),
      Address.fromString(smartAccount).toScVal(),
      xdr.ScVal.scvU32(ruleId),
    ]),
    durability: xdr.ContractDataDurability.persistent(),
  }));
}

function accountStorageKey(smartAccount, label, id) {
  return xdr.LedgerKey.contractData(new xdr.LedgerKeyContractData({
    contract: Address.fromString(smartAccount).toScAddress(),
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
    { account, resolve_policy_state: false },
    { rpc: client, registry, network: "testnet", now: () => new Date().toISOString() },
  );
}

async function writeStrictPolicyPlan(snapshot) {
  const nextRuleId = snapshot.next_rule_id;
  const pbDeployments = JSON.parse(await fs.readFile(path.join(root, "fixtures", "testnet", "pb-policy-deployments.json"), "utf8"));
  const functionAllowlist = deployment(pbDeployments, "pb:function_allowlist");
  const argGuard = deployment(pbDeployments, "pb:arg_guard");
  const strictPlan = {
    account,
    intended_rule_id: nextRuleId,
    target_contract: walletKit.native_token_contract,
    rule_name: `ozpb-strict-${String(nextRuleId)}`.slice(0, 20),
    valid_until_ledger: rule.valid_until_ledger,
    session_signer_public_key_hex: sessionKeyHex,
    policies: [
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
            { fnName: "transfer", argIndex: 2, path: [], pred: { kind: "range", min: "0", max: transferAmountStroops.toString() }, forall: false },
          ],
        },
      },
    ],
  };
  const policiesWithXdr = strictPlan.policies.map((policy) => ({
    ...policy,
    params_xdr_b64: encodeInstallParams(policy.classification, policy.install_params),
  }));
  const args = encodeAddContextRuleArgs({
    contextType: { kind: "call_contract", address: strictPlan.target_contract },
    name: strictPlan.rule_name,
    validUntil: strictPlan.valid_until_ledger,
    signers: [{
      type: "external",
      verifier: walletKit.ed25519_verifier_address,
      key_data_b64: Buffer.from(sessionKeyHex, "hex").toString("base64"),
      verifier_kind: "ed25519",
    }],
    policies: policiesWithXdr.map((policy) => ({
      address: policy.address,
      installParams: policy.params_xdr_b64,
    })),
  });
  const artifact = {
    ...strictPlan,
    policies: policiesWithXdr,
    status: "planned_not_installed",
    reason: "strict policy plan is ready; owner passkey install is the next interactive step",
    add_context_rule_args_xdr: args.map((arg) => arg.toXDR("base64")),
    guarantees: {
      function: "transfer only",
      sender: account,
      recipient,
      max_amount_stroops: transferAmountStroops.toString(),
      owner_passkey_required_for_any_unmatched_action: true,
    },
  };
  await fs.writeFile(strictOutPath, `${JSON.stringify(artifact, null, 2)}\n`);
  return {
    fixture: path.relative(root, strictOutPath),
    status: artifact.status,
    rule_name: artifact.rule_name,
    policies: artifact.policies.map((p) => ({ classification: p.classification, address: p.address })),
    guarantees: artifact.guarantees,
  };
}

function deployment(deployments, classification) {
  const found = deployments.deployments.find((d) => d.classification === classification);
  if (!found) throw new Error(`missing deployment for ${classification}`);
  return found;
}

async function wasmHash(contract) {
  const read = await backend.getLedgerEntries([accountInstanceKey(contract).toXDR("base64")]);
  const entry = read.entries[0];
  if (!entry?.xdrB64) throw new Error(`could not read contract instance for ${contract}`);
  const data = xdr.LedgerEntryData.fromXDR(entry.xdrB64, "base64");
  const val = data.contractData().val();
  const executable = val.instance().executable();
  if (executable.switch().name !== "contractExecutableWasm") throw new Error(`${contract} is not a WASM contract`);
  return Buffer.from(executable.wasmHash()).toString("hex");
}

async function waitForTx(txHash) {
  let final = await backend.call("getTransaction", { hash: txHash });
  for (let i = 0; i < 40 && final.status !== "SUCCESS" && final.status !== "ERROR" && final.status !== "FAILED"; i++) {
    await sleep(1500);
    final = await backend.call("getTransaction", { hash: txHash });
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
