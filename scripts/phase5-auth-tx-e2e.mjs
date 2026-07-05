#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import {
  PolicyIntent,
  TransactionTrace,
  canonicalHash,
  synthesizeRuleset,
  toContractId,
  toLedgerSeq,
} from "../packages/core/dist/index.js";
import {
  RpcClient,
  InMemoryRegistry,
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

const fixturePath = process.argv[2] ?? path.join(root, "fixtures", "testnet", "oz-fixture.json");
const reportPath = path.join(root, "fixtures", "testnet", "phase5-smoke-report.json");
const outPath = path.join(root, "fixtures", "testnet", "phase5-auth-tx.json");
const rpcUrl = process.env.STELLAR_RPC_URL ?? "https://soroban-testnet.stellar.org";
const sourceAlias = process.env.SOURCE_ACCOUNT ?? "ozpb-feepayer";
const externalSignerSeedHex = process.env.OZPB_EXTERNAL_SIGNER_SEED_HEX ?? "00".repeat(32);

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
const smokeReport = await readJsonIfExists(reportPath);
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

const server = new rpc.Server(rpcUrl);
const source = await server.getAccount(feePayer.publicKey());
const op = new Contract(fixture.account).call(
  "batch_add_signer",
  xdr.ScVal.scvU32(0),
  xdr.ScVal.scvVec([]),
);
const tx = new TransactionBuilder(source, {
  fee: "1000000",
  networkPassphrase: Networks.TESTNET,
})
  .addOperation(op)
  .setTimeout(300)
  .build();

const sim = await server.simulateTransaction(tx);
if (sim.error !== undefined) throw new Error(`simulation failed: ${sim.error}`);
const authEntries = sim.result?.auth ?? [];
if (authEntries.length !== 1) throw new Error(`expected one auth entry, got ${authEntries.length}`);
const latest = await server.getLatestLedger();
const authValidUntil = latest.sequence + 1000;
tx.operations[0].auth = [signOzAuthEntry(authEntries[0], authValidUntil, externalSigner, fixture)];
const signedAuthSim = await server.simulateTransaction(tx);
if (signedAuthSim.error !== undefined) throw new Error(`signed-auth simulation failed: ${signedAuthSim.error}`);
const assembled = rpc.assembleTransaction(tx, signedAuthSim).build();
appendAuthNonceFootprint(assembled, fixture.account);
applySorobanResourceLeeway(assembled);
assertAuthNonceFootprint(assembled);
assembled.sign(feePayer);

const send = await server.sendTransaction(assembled);
const txHash = send.hash;
let final = { status: send.status, hash: txHash };
for (let i = 0; i < 40 && final.status !== "SUCCESS" && final.status !== "ERROR" && final.status !== "FAILED"; i++) {
  await sleep(1500);
  final = await backend.call("getTransaction", { hash: txHash });
}
if (final.status !== "SUCCESS") {
  throw new Error(`submitted tx did not succeed: ${JSON.stringify(final)}`);
}

const client = RpcClient.create(backend, { budget: 800 });
const registry = new InMemoryRegistry()
  .registerAccountWasm(fixture.account_wasm_hash)
  .registerVerifier(fixture.ed25519_verifier_wasm_hash, "ed25519")
  .registerPolicy(fixture.threshold_policy_wasm_hash, "oz:simple_threshold");
const snapshot = await inspectAccount(
  { account: fixture.account },
  { rpc: client, registry, network: "testnet", now: () => new Date().toISOString() },
);
const { trace, metaDecodeStatus } = await traceTransactionWithMetaFallback(txHash, final);
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
    provenance: ctx.occurrences[0]?.provenance ?? { kind: "observed_tx", tx_hash: txHash, context_index: 0 },
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
  { currentLedger: latest.sequence },
);
const bypass = detectBypass({ ruleset, accountSnapshot: snapshot });

const out = {
  schema_version: "1",
  network: "testnet",
  created_at: new Date().toISOString(),
  rpc_url: rpcUrl,
  account: fixture.account,
  source_account: fixture.source_account,
  signer: {
    type: "external",
    verifier: fixture.ed25519_verifier,
    key_data_hex: fixture.external_signer_key_hex,
  },
  target: {
    contract: fixture.account,
    fn: "batch_add_signer",
    description: "real smart-account-authorized fixture call with an empty signer addition",
  },
  tx_hash: txHash,
  tx_status: final.status,
  ledger: final.ledger,
  auth_valid_until_ledger: authValidUntil,
  latest_smoke_report: smokeReport?.plan?.hash !== undefined ? {
    path: path.relative(root, reportPath).replaceAll("\\", "/"),
    plan_hash: smokeReport.plan.hash,
    snapshot_hash: smokeReport.snapshot?.hash,
  } : undefined,
  wasm_hashes: {
    account: fixture.account_wasm_hash,
    ed25519_verifier: fixture.ed25519_verifier_wasm_hash,
    threshold_policy: fixture.threshold_policy_wasm_hash,
  },
  pipeline: {
    trace: {
      tx_hash: trace.tx_hash,
      successful: trace.successful,
      meta_decode_status: metaDecodeStatus,
      auth_entries: trace.auth_entries.length,
      operations: trace.operations.length,
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

await fs.mkdir(path.dirname(outPath), { recursive: true });
await fs.writeFile(outPath, `${JSON.stringify(out, null, 2)}\n`);
console.log(JSON.stringify(out, null, 2));

function signOzAuthEntry(entry, validUntilLedger, signer, fx) {
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
  const authDigest = computeAuthDigest(Buffer.from(signaturePayload), [0]);
  const signature = signer.sign(authDigest);
  credentials.signature(encodeAuthPayloadScVal(fx, signature));
  return clone;
}

function encodeAuthPayloadScVal(fx, signature) {
  const signerScVal = xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol("External"),
    Address.fromString(fx.ed25519_verifier).toScVal(),
    xdr.ScVal.scvBytes(Buffer.from(fx.external_signer_key_hex, "hex")),
  ]);
  const signaturesMap = sortedMap([
    new xdr.ScMapEntry({ key: signerScVal, val: xdr.ScVal.scvBytes(signature) }),
  ]);
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("context_rule_ids"), val: xdr.ScVal.scvVec([xdr.ScVal.scvU32(0)]) }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("signers"), val: signaturesMap }),
  ]);
}

function sortedMap(entries) {
  return xdr.ScVal.scvMap(
    [...entries].sort((a, b) => Buffer.compare(a.key().toXDR(), b.key().toXDR())),
  );
}

function applySorobanResourceLeeway(transaction) {
  const data = transaction._tx.ext().sorobanData();
  const resources = data.resources();
  resources.instructions(Math.max(resources.instructions(), 20_000_000));
  resources.readBytes(resources.readBytes() + 1024);
  resources.writeBytes(resources.writeBytes() + 1024);
  data.resourceFee(Hyper.fromString("25000000"));
  transaction._tx.fee(30000000);
}

function appendAuthNonceFootprint(transaction, account) {
  const authEntry = transaction._tx.operations()[0].body().invokeHostFunctionOp().auth()[0];
  const credentials = authEntry.credentials().address();
  const nonce = xdr.Int64.fromString(credentials.nonce().toString());
  const nonceKey = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: Address.fromString(account).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyNonce(new xdr.ScNonceKey({ nonce })),
      durability: xdr.ContractDataDurability.temporary(),
    }),
  );
  const data = transaction._tx.ext().sorobanData();
  const builder = new SorobanDataBuilder(data);
  const readOnly = builder.getReadOnly();
  const readWrite = [...builder.getReadWrite().filter((key) => !isNonceLedgerKey(key)), nonceKey];
  const footprint = data.resources().footprint();
  footprint.readOnly(readOnly);
  footprint.readWrite(readWrite);
}

function isNonceLedgerKey(key) {
  return key.switch().name === "contractData"
    && key.contractData().key().switch().name === "scvLedgerKeyNonce";
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
        ...(decoded.feeBump !== undefined ? { fee_bump: { fee_source: decoded.feeBump.feeSource } } : {}),
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

function assertAuthNonceFootprint(transaction) {
  const authNonce = transaction._tx
    .operations()[0]
    .body()
    .invokeHostFunctionOp()
    .auth()[0]
    .credentials()
    .address()
    .nonce()
    .toString();
  const footprintNonces = transaction._tx
    .ext()
    .sorobanData()
    .resources()
    .footprint()
    .readWrite()
    .filter(isNonceLedgerKey)
    .map((key) => key.contractData().key().nonceKey().nonce().toString());
  if (footprintNonces.length !== 1 || footprintNonces[0] !== authNonce) {
    throw new Error(`auth nonce footprint mismatch: auth=${authNonce} footprint=${footprintNonces.join(",")}`);
  }
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

async function readJsonIfExists(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return undefined;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
