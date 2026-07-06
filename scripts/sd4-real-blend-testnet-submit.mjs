#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import { PoolContractV2, RequestType } from "@blend-capital/blend-sdk";
import {
  PolicyIntent,
  TransactionTrace,
  canonicalHash,
  synthesizeRuleset,
  toLedgerSeq,
} from "../packages/core/dist/index.js";
import {
  InMemoryRegistry,
  RpcClient,
  computeAuthDigest,
  decodeAuthEntries,
  decodeTransactionEnvelope,
  extractAuthContexts,
  inspectAccount,
  traceTransaction,
} from "../packages/stellar/dist/index.js";
import { detectBypass } from "../packages/plans/dist/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const requireFromBlend = createRequire(createRequire(import.meta.url).resolve("@blend-capital/blend-sdk"));
const sdk = await import(pathToFileURL(requireFromBlend.resolve("@stellar/stellar-sdk")).href);
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

const fixturePath = path.join(root, "fixtures", "testnet", "oz-fixture.json");
const outPath = path.join(root, "fixtures", "testnet", "sd4-real-blend-submit-tx.json");
const registryUrl = "https://raw.githubusercontent.com/blend-capital/blend-utils/main/testnet.contracts.json";
const rpcUrl = process.env.STELLAR_RPC_URL ?? "https://soroban-testnet.stellar.org";
const sourceAlias = process.env.SOURCE_ACCOUNT ?? "ozpb-feepayer";
const externalSignerSeedHex = process.env.OZPB_EXTERNAL_SIGNER_SEED_HEX ?? "00".repeat(32);
const amount = BigInt(process.env.SD4_BLEND_AMOUNT ?? "100000");
const fundingAmount = BigInt(process.env.SD4_BLEND_FUND_AMOUNT ?? "1000000");

const fixture = JSON.parse(await fs.readFile(fixturePath, "utf8"));
const blendRegistry = await fetchJson(registryUrl);
const poolId = process.env.SD4_BLEND_POOL ?? blendRegistry.ids.TestnetV2;
const reserve = process.env.SD4_BLEND_RESERVE ?? blendRegistry.ids.XLM;
const server = new rpc.Server(rpcUrl);
const backend = new JsonRpcBackend(rpcUrl);
const feePayerSecret = process.env.FEEPAYER_SECRET ?? readStellarSecret(sourceAlias);
const feePayer = Keypair.fromSecret(feePayerSecret);
const externalSigner = Keypair.fromRawEd25519Seed(Buffer.from(externalSignerSeedHex, "hex"));
if (externalSigner.rawPublicKey().toString("hex") !== fixture.external_signer_key_hex) {
  throw new Error("external signer seed does not match fixture.external_signer_key_hex");
}
if (feePayer.publicKey() !== fixture.source_account) {
  throw new Error(`fee payer ${feePayer.publicKey()} does not match fixture source ${fixture.source_account}`);
}

const funding = await fundSmartAccount();
const blend = await submitBlend();

const client = RpcClient.create(backend, { budget: 1000 });
const registry = new InMemoryRegistry()
  .registerAccountWasm(fixture.account_wasm_hash)
  .registerVerifier(fixture.ed25519_verifier_wasm_hash, "ed25519")
  .registerPolicy(fixture.threshold_policy_wasm_hash, "oz:simple_threshold");
const snapshot = await inspectAccount(
  { account: fixture.account },
  { rpc: client, registry, network: "testnet", now: () => new Date().toISOString() },
);
const { trace, metaDecodeStatus } = await traceTransactionWithMetaFallback(blend.hash, blend.final);
const evidence = extractAuthContexts({
  account: fixture.account,
  polarity: "positive",
  traces: [trace],
});
const intent = PolicyIntent.parse({
  schema_version: "1",
  network: "testnet",
  account: fixture.account,
  grantee: {
    signer: {
      type: "external",
      verifier: fixture.ed25519_verifier,
      key_data_b64: Buffer.from(fixture.external_signer_key_hex, "hex").toString("base64"),
      verifier_kind: "ed25519",
    },
    label: "fixture external signer",
  },
  targets: evidence.contexts.map((ctx) => ({
    contract: ctx.contract,
    label: `observed ${ctx.fn_name}`,
    functions: [{ name: ctx.fn_name, arg_constraints: [] }],
    provenance: ctx.occurrences[0]?.provenance ?? { kind: "observed_tx", tx_hash: blend.hash, context_index: 0 },
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
  { currentLedger: blend.latestLedger },
);
const bypass = detectBypass({ ruleset, accountSnapshot: snapshot });

const out = {
  schema_version: "1",
  test_id: "SD4.real-blend-testnet-submit",
  created_at: new Date().toISOString(),
  network: "testnet",
  rpc_url: rpcUrl,
  account: fixture.account,
  source_account: fixture.source_account,
  signer: {
    type: "external",
    verifier: fixture.ed25519_verifier,
    key_data_hex: fixture.external_signer_key_hex,
  },
  blend: {
    registry_url: registryUrl,
    pool: poolId,
    reserve,
    request_type: "SupplyCollateral",
    request_type_id: RequestType.SupplyCollateral,
    amount: amount.toString(),
  },
  funding,
  tx_hash: blend.hash,
  tx_status: blend.final.status,
  ledger: blend.final.ledger,
  auth_digest_replay: blend.authProof,
  wasm_hashes: {
    account: fixture.account_wasm_hash,
    ed25519_verifier: fixture.ed25519_verifier_wasm_hash,
    blend_lending_pool_v2: blendRegistry.hashes.lendingPoolV2,
  },
  pipeline: {
    trace: {
      tx_hash: trace.tx_hash,
      successful: trace.successful,
      meta_decode_status: metaDecodeStatus,
      auth_entries: trace.auth_entries.length,
      operations: trace.operations.length,
      events: trace.events.length,
      token_deltas: trace.token_deltas.length,
    },
    evidence: {
      evidence_hash: evidence.evidence_hash,
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
      ruleset_hash: ruleset.ruleset_hash,
      rule_count: ruleset.rules.length,
      unsatisfied_count: ruleset.unsatisfied.length,
    },
    bypass: {
      report_hash: bypass.report_hash,
      bypass_count: bypass.findings.filter((finding) => finding.verdict === "BYPASS").length,
      unknown_count: bypass.findings.filter((finding) => finding.verdict === "UNKNOWN").length,
      exhaustive: bypass.exhaustive,
    },
  },
};

await fs.writeFile(outPath, `${JSON.stringify(out, null, 2)}\n`);
console.log(JSON.stringify(out, null, 2));

async function fundSmartAccount() {
  const source = await server.getAccount(feePayer.publicKey());
  const op = new Contract(reserve).call(
    "transfer",
    Address.fromString(feePayer.publicKey()).toScVal(),
    Address.fromString(fixture.account).toScVal(),
    nativeToScVal(fundingAmount, { type: "i128" }),
  );
  const tx = new TransactionBuilder(source, { fee: "1000000", networkPassphrase: Networks.TESTNET })
    .addOperation(op)
    .setTimeout(300)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (sim.error !== undefined) throw new Error(`Blend reserve funding simulation failed: ${sim.error}`);
  const assembled = rpc.assembleTransaction(tx, sim).build();
  applySorobanResourceLeeway(assembled);
  assembled.sign(feePayer);
  const send = await server.sendTransaction(assembled);
  const final = await waitForTx(send.hash);
  if (final.status !== "SUCCESS") throw new Error(`Blend reserve funding failed: ${JSON.stringify({ send, final })}`);
  return {
    reserve,
    amount: fundingAmount.toString(),
    tx_hash: send.hash,
    status: final.status,
    ledger: final.ledger,
  };
}

async function submitBlend() {
  const source = await server.getAccount(feePayer.publicKey());
  const op = xdr.Operation.fromXDR(
    new PoolContractV2(poolId).submit({
      from: fixture.account,
      spender: fixture.account,
      to: fixture.account,
      requests: [{ request_type: RequestType.SupplyCollateral, address: reserve, amount }],
    }),
    "base64",
  );
  const tx = new TransactionBuilder(source, { fee: "1000000", networkPassphrase: Networks.TESTNET })
    .addOperation(op)
    .setTimeout(300)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (sim.error !== undefined) throw new Error(`Blend submit simulation failed: ${sim.error}`);
  const authEntries = sim.result?.auth ?? [];
  if (authEntries.length !== 1) throw new Error(`expected one Blend auth entry, got ${String(authEntries.length)}`);
  const latest = await server.getLatestLedger();
  const contextRuleIds = Array.from({ length: countAuthContexts(authEntries[0]) }, () => 0);
  const signedAuth = signOzAuthEntry(authEntries[0], latest.sequence + 1000, externalSigner, fixture, contextRuleIds);
  tx.operations[0].auth = [signedAuth.entry];
  const signedAuthSim = await server.simulateTransaction(tx);
  if (signedAuthSim.error !== undefined) throw new Error(`signed Blend auth simulation failed: ${signedAuthSim.error}`);
  const assembled = rpc.assembleTransaction(tx, signedAuthSim).build();
  appendAuthNonceFootprint(assembled, fixture.account);
  appendOzAccountAuthFootprint(assembled, fixture, 0, 0);
  applySorobanResourceLeeway(assembled);
  assembled.sign(feePayer);
  const send = await server.sendTransaction(assembled);
  const final = await waitForTx(send.hash);
  if (final.status !== "SUCCESS") throw new Error(`Blend submit failed: ${JSON.stringify({ send, final })}`);
  return {
    hash: send.hash,
    final,
    latestLedger: latest.sequence,
    authProof: {
      test_id: "T-ST.18-2",
      signature_payload_hex: signedAuth.proof.signature_payload_hex,
      context_rule_ids: contextRuleIds,
      auth_digest_hex: signedAuth.proof.auth_digest_hex,
      signature_hex: signedAuth.proof.signature_hex,
      replay_result: "accepted_on_real_blend_testnet_submit",
    },
  };
}

function signOzAuthEntry(entry, validUntilLedger, signer, fx, contextRuleIds) {
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
  credentials.signature(encodeAuthPayloadScVal(fx, contextRuleIds, signature));
  return {
    entry: clone,
    proof: {
      signature_payload_hex: Buffer.from(signaturePayload).toString("hex"),
      auth_digest_hex: Buffer.from(authDigest).toString("hex"),
      signature_hex: Buffer.from(signature).toString("hex"),
    },
  };
}

function countAuthContexts(entry) {
  return countInvocationContexts(entry.rootInvocation());
}

function countInvocationContexts(invocation) {
  return 1 + invocation.subInvocations()
    .map(countInvocationContexts)
    .reduce((sum, count) => sum + count, 0);
}

function encodeAuthPayloadScVal(fx, contextRuleIds, signature) {
  const signerScVal = xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol("External"),
    Address.fromString(fx.ed25519_verifier).toScVal(),
    xdr.ScVal.scvBytes(Buffer.from(fx.external_signer_key_hex, "hex")),
  ]);
  const signaturesMap = sortedMap([
    new xdr.ScMapEntry({ key: signerScVal, val: xdr.ScVal.scvBytes(signature) }),
  ]);
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("context_rule_ids"), val: xdr.ScVal.scvVec(contextRuleIds.map((id) => xdr.ScVal.scvU32(id))) }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("signers"),
      val: signaturesMap,
    }),
  ]);
}

function sortedMap(entries) {
  return xdr.ScVal.scvMap(
    [...entries].sort((a, b) => Buffer.compare(a.key().toXDR(), b.key().toXDR())),
  );
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

function appendOzAccountAuthFootprint(transaction, fx, ruleId, signerId) {
  const data = transaction._tx.ext().sorobanData();
  const builder = new SorobanDataBuilder(data);
  const readWriteKeys = new Set(builder.getReadWrite().map((key) => key.toXDR("base64")));
  const readOnly = uniqueLedgerKeys([
    ...builder.getReadOnly(),
    accountStorageKey(fx.account, "ContextRuleData", xdr.ScVal.scvU32(ruleId)),
    accountStorageKey(fx.account, "SignerData", xdr.ScVal.scvU32(signerId)),
    contractInstanceKey(fx.ed25519_verifier),
    contractCodeKey(fx.ed25519_verifier_wasm_hash),
  ]).filter((key) => !readWriteKeys.has(key.toXDR("base64")));
  data.resources().footprint().readOnly(readOnly);
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
  resources.instructions(Math.max(resources.instructions(), 100_000_000));
  if (typeof resources.diskReadBytes === "function") {
    resources.diskReadBytes(resources.diskReadBytes() + 16384);
  } else {
    resources.readBytes(resources.readBytes() + 16384);
  }
  resources.writeBytes(resources.writeBytes() + 8192);
  data.resourceFee(Hyper.fromString("100000000"));
  transaction._tx.fee(110000000);
}

async function traceTransactionWithMetaFallback(txHash, finalTx) {
  try {
    return {
      trace: await traceTransaction(
        { source: { tx_hash: txHash } },
        { rpc: client, network: "testnet", now: () => new Date().toISOString() },
      ),
      metaDecodeStatus: "decoded",
    };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    const nested = cause?.cause instanceof Error ? cause.cause.message : "";
    if (!message.includes("could not decode TransactionMeta") && !nested.includes("Bad union switch: 4")) {
      throw cause;
    }
    const txRecord = await backend.getTransaction(txHash);
    if (txRecord.status !== "SUCCESS" || txRecord.envelopeXdr === undefined) throw cause;
    const decoded = decodeTransactionEnvelope(txRecord.envelopeXdr);
    return {
      trace: TransactionTrace.parse({
        schema_version: "1",
        network: "testnet",
        tx_hash: txHash,
        ledger: toLedgerSeq(txRecord.ledger ?? finalTx.ledger ?? 0),
        closed_at: txRecord.createdAt !== undefined
          ? new Date(Number(txRecord.createdAt) * 1000).toISOString()
          : new Date().toISOString(),
        successful: true,
        source_account: decoded.sourceAccount,
        ...(decoded.invocation !== undefined ? { host_function: decoded.invocation } : {}),
        operations: decoded.operations,
        auth_entries: decodeAuthEntries(decoded.authEntries),
        events: [],
        token_deltas: [],
        raw: {
          envelope_xdr: txRecord.envelopeXdr,
          ...(txRecord.resultXdr !== undefined ? { result_xdr: txRecord.resultXdr } : {}),
          ...(txRecord.resultMetaXdr !== undefined ? { result_meta_xdr: txRecord.resultMetaXdr } : {}),
        },
      }),
      metaDecodeStatus: "fallback_envelope_only_sdk_meta_v4",
    };
  }
}

async function waitForTx(hashValue) {
  let final = await backend.call("getTransaction", { hash: hashValue });
  for (let i = 0; i < 50 && final.status !== "SUCCESS" && final.status !== "ERROR" && final.status !== "FAILED"; i++) {
    await sleep(1500);
    final = await backend.call("getTransaction", { hash: hashValue });
  }
  return final;
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`failed to fetch ${url}: ${String(response.status)}`);
  return await response.json();
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
