import {
  createCallContractContext,
  createEd25519Signer,
  createSpendingLimitParams,
  createThresholdParams,
  IndexedDBStorage,
  SmartAccountKit,
} from "smart-account-kit";
import { startAuthentication } from "@simplewebauthn/browser";
import { Address, Contract, Operation, Transaction, TransactionBuilder, hash, rpc, xdr } from "@stellar/stellar-sdk";
import base64url from "base64url";
import { Buffer } from "buffer";

globalThis.Buffer = Buffer;

interface BrowserSigningStep {
  order: number;
  step_hash: string;
  unsigned_xdr: string;
  description: string;
}

interface WalletKitConfig {
  rpc_url: string;
  network_passphrase: string;
  account_wasm_hash: string;
  webauthn_verifier_address: string;
  native_token_contract?: string;
  ed25519_verifier_address?: string;
  threshold_policy_address?: string;
  spending_limit_policy_address?: string;
  relayer_url?: string;
  rp_id?: string;
  rp_name?: string;
  passkey_user_name?: string;
  passkey_nickname?: string;
}

interface WalletDemoAction {
  kind: "xlm_transfer";
  token_contract: string;
  recipient: string;
  amount_xlm: number;
}

interface WalletInstallAction {
  kind: "session_rule";
  account: string;
  owner_credential_id?: string;
  target_contract: string;
  rule_name: string;
  valid_until_ledger: number;
  session_signer: {
    verifier: string;
    public_key_hex: string;
  };
  policies?: {
    simple_threshold?: {
      address: string;
      threshold: number;
    };
    spending_limit?: {
      address: string;
      spending_limit_stroops: string;
      period_ledgers: number;
    };
    custom?: Array<{
      address: string;
      classification: string;
      params_xdr_b64: string;
    }>;
  };
}

interface BrowserApprovalRequest {
  sid: string;
  kind: "create_wallet" | "connect_wallet" | "sign_install_plan" | "sign_revocation_plan" | "sign_one_off_tx";
  network: "testnet" | "mainnet";
  plan_hash?: string;
  account?: string;
  payload: {
    human_summary_markdown: string;
    policy_diff_markdown: string;
    risk_summary_markdown: string;
    wallet_kit?: WalletKitConfig;
    demo_action?: WalletDemoAction;
    install_action?: WalletInstallAction;
    expected_signer: {
      account?: string;
      signer_kind: "webauthn" | "ed25519" | "delegated";
      verifier?: string;
      public_key_hint?: string;
    };
    steps: BrowserSigningStep[];
  };
}

const status = requireElement("status");
const details = requireElement("details") as HTMLElement;
const sid = location.pathname.split("/").filter(Boolean).at(-1);
const bearer = location.hash.slice(1);
const auth = `Bearer ${sid ?? ""}.${bearer}`;
let request: BrowserApprovalRequest;

document.getElementById("createWallet")?.addEventListener("click", () => void createWallet());
document.getElementById("connectWallet")?.addEventListener("click", () => void connectWallet());
document.getElementById("runOneOff")?.addEventListener("click", () => void runOneOff());
document.getElementById("signInstall")?.addEventListener("click", () => void signInstallPlan());
document.getElementById("mockApprove")?.addEventListener("click", () => void mockApprove());
document.getElementById("reject")?.addEventListener("click", () => void reject());

void load().catch((error: unknown) => {
  status.innerHTML = `<span class="error">${escapeHtml(messageOf(error))}</span>`;
});

async function load(): Promise<void> {
  if (!sid || !bearer) throw new Error("Missing approval token");
  const res = await fetch(`/api/request/${encodeURIComponent(sid)}`, { headers: { Authorization: auth } });
  if (!res.ok) throw new Error(`Could not load request: ${String(res.status)}`);
  request = (await res.json()) as BrowserApprovalRequest;
  setText("kind", request.kind);
  setText("network", request.network);
  setText("planHash", request.plan_hash ?? "(none)");
  setText("summary", request.payload.human_summary_markdown);
  setText("diff", request.payload.policy_diff_markdown);
  setText("risk", request.payload.risk_summary_markdown);
  setText(
    "steps",
    JSON.stringify(request.payload.steps.map((step) => ({
      order: step.order,
      step_hash: step.step_hash,
      description: step.description,
    })), null, 2),
  );
  const hasKit = request.payload.wallet_kit !== undefined;
  setHidden("createWallet", !(hasKit && request.kind === "create_wallet"));
  setHidden("connectWallet", !(hasKit && request.kind === "connect_wallet"));
  setHidden("runOneOff", !(hasKit && request.kind === "sign_one_off_tx" && request.payload.demo_action !== undefined));
  setHidden("signInstall", !(hasKit && request.kind === "sign_install_plan" && request.payload.install_action !== undefined));
  setHidden("mockApprove", hasKit);
  status.hidden = true;
  details.hidden = false;
}

function loadKit(): SmartAccountKit {
  const cfg = request.payload.wallet_kit;
  if (!cfg) throw new Error("Missing smart-account-kit config");
  return new SmartAccountKit({
    rpcUrl: cfg.rpc_url,
    networkPassphrase: cfg.network_passphrase,
    accountWasmHash: cfg.account_wasm_hash,
    webauthnVerifierAddress: cfg.webauthn_verifier_address,
    storage: new IndexedDBStorage(`oz-policy-builder:${request.network}:${cfg.account_wasm_hash.slice(0, 12)}`),
    rpId: cfg.rp_id ?? "localhost",
    rpName: cfg.rp_name ?? "OZ Policy Builder",
    relayerUrl: cfg.relayer_url || undefined,
  });
}

async function createWallet(): Promise<void> {
  try {
    setStatus("Creating smart account. Complete the passkey prompt in this browser.");
    const kit = loadKit();
    const cfg = request.payload.wallet_kit;
    if (!cfg) throw new Error("Missing smart-account-kit config");
    const result = await kit.createWallet(cfg.rp_name ?? "OZ Policy Builder", cfg.passkey_user_name ?? "oz-policy-builder-user", {
      nickname: cfg.passkey_nickname ?? "OZ Policy Builder owner passkey",
      authenticatorSelection: {
        authenticatorAttachment: "platform",
        residentKey: "required",
        userVerification: "required",
      },
      autoSubmit: true,
      autoFund: Boolean(cfg.native_token_contract),
      nativeTokenContract: cfg.native_token_contract,
      forceMethod: cfg.relayer_url ? undefined : "rpc",
    });
    const base = resultBase(result.contractId, result.credentialId, bytesToHex(result.publicKey));
    const step = request.payload.steps[0] ?? { order: 1, step_hash: "wallet_deploy" };
    if (!result.signedTransaction && !result.submitResult?.hash) {
      throw new Error("Wallet creation did not return a signed transaction or tx hash");
    }
    base.signed_steps.push({
      order: step.order,
      step_hash: step.step_hash,
      ...(result.signedTransaction ? { signed_xdr: result.signedTransaction } : {}),
      ...(result.submitResult?.hash ? { tx_hash: result.submitResult.hash } : {}),
      ...(result.submitResult?.ledger !== undefined ? { ledger: result.submitResult.ledger } : {}),
    });
    await postResult(base);
  } catch (error: unknown) {
    setStatus(messageOf(error), "error");
  }
}

async function connectWallet(): Promise<void> {
  try {
    setStatus("Connecting smart account. Complete the passkey prompt in this browser.");
    const result = await loadKit().connectWallet({ prompt: true });
    if (!result) throw new Error("No smart account connected");
    await postResult(resultBase(
      result.contractId,
      result.credentialId,
      result.credential?.publicKey ? bytesToHex(result.credential.publicKey) : undefined,
    ));
  } catch (error: unknown) {
    setStatus(messageOf(error), "error");
  }
}

async function runOneOff(): Promise<void> {
  try {
    setStatus("Signing and submitting one-off action. Complete the passkey prompt in this browser.");
    const kit = loadKit();
    const action = request.payload.demo_action;
    if (!action || action.kind !== "xlm_transfer") throw new Error("Unsupported demo action");
    const connected = await kit.connectWallet({ prompt: true });
    if (!connected) throw new Error("No smart account connected");
    const tx = await kit.transfer(action.token_contract, action.recipient, action.amount_xlm, { forceMethod: "rpc" });
    if (!tx.success || !tx.hash) throw new Error(tx.error ?? "Transaction failed");
    const step = request.payload.steps[0] ?? { order: 1, step_hash: "one_off_action" };
    await postResult({
      ...resultBase(
        connected.contractId,
        connected.credentialId,
        connected.credential?.publicKey ? bytesToHex(connected.credential.publicKey) : undefined,
      ),
      signed_steps: [{
        order: step.order,
        step_hash: step.step_hash,
        tx_hash: tx.hash,
        ledger: tx.ledger,
      }],
    });
  } catch (error: unknown) {
    setStatus(messageOf(error), "error");
  }
}

async function signInstallPlan(): Promise<void> {
  try {
    setStatus("Signing and submitting install plan. Complete the passkey prompt in this browser.");
    const kit = loadKit();
    const action = request.payload.install_action;
    if (!action || action.kind !== "session_rule") throw new Error("Unsupported install action");
    const connected = await kit.connectWallet(
      action.owner_credential_id
        ? { contractId: action.account, credentialId: action.owner_credential_id }
        : { prompt: true },
    );
    if (!connected) throw new Error("No smart account connected");
    if (connected.contractId !== action.account) {
      throw new Error(`Connected account ${connected.contractId} does not match requested account ${action.account}`);
    }
    if (action.owner_credential_id && request.payload.expected_signer.public_key_hint) {
      installKnownPasskeySigner(kit, action.owner_credential_id, request.payload.expected_signer.public_key_hint);
    }

    if ((action.policies?.custom?.length ?? 0) > 0) {
      const submit = await signAndSubmitRawInstall(kit, action, connected.credentialId);
      if (!submit.success || !submit.hash) {
        throw new Error(submit.error ?? "Strict install transaction failed");
      }
      const step = request.payload.steps[0] ?? { order: 1, step_hash: "install_session_rule" };
      await postResult({
        ...resultBase(
          connected.contractId,
          connected.credentialId,
          connected.credential?.publicKey ? bytesToHex(connected.credential.publicKey) : request.payload.expected_signer.public_key_hint,
        ),
        signed_steps: [{
          order: step.order,
          step_hash: step.step_hash,
          tx_hash: submit.hash,
          ledger: submit.ledger,
        }],
      });
      return;
    }

    const context = createCallContractContext(action.target_contract);
    const sessionSigner = createEd25519Signer(action.session_signer.verifier, hexToBytes(action.session_signer.public_key_hex));
    const policies = new Map<string, unknown>();
    if (action.policies?.simple_threshold) {
      const policy = action.policies.simple_threshold;
      policies.set(policy.address, kit.convertPolicyParams("threshold", createThresholdParams(policy.threshold)));
    }
    if (action.policies?.spending_limit) {
      const policy = action.policies.spending_limit;
      policies.set(policy.address, kit.convertPolicyParams(
        "spending_limit",
        createSpendingLimitParams(BigInt(policy.spending_limit_stroops), policy.period_ledgers),
      ));
    }
    for (const policy of action.policies?.custom ?? []) {
      policies.set(policy.address, xdr.ScVal.fromXDR(policy.params_xdr_b64, "base64"));
    }

    const tx = await kit.rules.add(
      context,
      action.rule_name,
      [sessionSigner],
      policies,
      action.valid_until_ledger,
    );
    const submit = await kit.signAndSubmit(tx, {
      credentialId: connected.credentialId,
      forceMethod: "rpc",
    });
    if (!submit.success || !submit.hash) {
      throw new Error(submit.error ?? "Install transaction failed");
    }
    const step = request.payload.steps[0] ?? { order: 1, step_hash: "install_session_rule" };
    await postResult({
      ...resultBase(
        connected.contractId,
        connected.credentialId,
        connected.credential?.publicKey ? bytesToHex(connected.credential.publicKey) : request.payload.expected_signer.public_key_hint,
      ),
      signed_steps: [{
        order: step.order,
        step_hash: step.step_hash,
        tx_hash: submit.hash,
        ledger: submit.ledger,
      }],
    });
  } catch (error: unknown) {
    setStatus(messageOf(error), "error");
  }
}

async function signAndSubmitRawInstall(
  kit: SmartAccountKit,
  action: WalletInstallAction,
  credentialId: string,
): Promise<{ success: boolean; hash?: string; ledger?: number; error?: string }> {
  const cfg = request.payload.wallet_kit;
  if (!cfg) throw new Error("Missing smart-account-kit config");
  const rpcServer = (kit as unknown as { rpc?: rpc.Server }).rpc;
  const deployerKeypair = (kit as unknown as { deployerKeypair?: { publicKey: () => string; sign: (data: Buffer) => Buffer } }).deployerKeypair;
  if (!rpcServer || !deployerKeypair) {
    throw new Error("smart-account-kit internals needed for raw strict install are unavailable");
  }

  const source = await rpcServer.getAccount(deployerKeypair.publicKey());
  const unsignedTx = new TransactionBuilder(source, {
    fee: "1000000",
    networkPassphrase: cfg.network_passphrase,
  })
    .addOperation(new Contract(action.account).call("add_context_rule", ...encodeRawAddContextRuleArgs(action)))
    .setTimeout(300)
    .build();
  const firstSim = await rpcServer.simulateTransaction(unsignedTx);
  if ("error" in firstSim) throw new Error(`Strict install simulation failed: ${firstSim.error}`);
  const authEntries = firstSim.result?.auth ?? [];
  if (authEntries.length !== 1) throw new Error(`expected one strict install auth entry, got ${String(authEntries.length)}`);
  const signedEntry = await signKnownWebAuthnAuthEntry(authEntries[0], {
    credentialId,
    publicKeyHex: request.payload.expected_signer.public_key_hint ?? "",
    webauthnVerifierAddress: cfg.webauthn_verifier_address,
    rpcUrl: cfg.rpc_url,
    networkPassphrase: cfg.network_passphrase,
    contextRuleIds: [0],
  });
  const hostFunc = unsignedTx.operations[0].type === "invokeHostFunction"
    ? unsignedTx.operations[0].func
    : undefined;
  if (!hostFunc) throw new Error("strict install operation is not invokeHostFunction");
  const resimSource = await rpcServer.getAccount(deployerKeypair.publicKey());
  const resimTx = new TransactionBuilder(resimSource, {
    fee: "1000000",
    networkPassphrase: cfg.network_passphrase,
  })
    .addOperation(Operation.invokeHostFunction({ func: hostFunc, auth: [signedEntry] }))
    .setTimeout(300)
    .build();
  const resim = await rpcServer.simulateTransaction(resimTx);
  if ("error" in resim) throw new Error(`Strict install re-simulation failed: ${resim.error}`);
  const prepared = rpc.assembleTransaction(resimTx, resim).build() as Transaction;
  prepared.sign(deployerKeypair as never);
  const send = await rpcServer.sendTransaction(prepared);
  if (send.status !== "PENDING" && send.status !== "DUPLICATE") {
    return { success: false, hash: "hash" in send ? send.hash : undefined, error: JSON.stringify(send) };
  }
  const hashValue = send.hash;
  for (let i = 0; i < 40; i++) {
    const tx = await rpcServer.getTransaction(hashValue);
    if (tx.status === "SUCCESS") return { success: true, hash: hashValue, ledger: tx.ledger };
    if (tx.status === "FAILED" || tx.status === "ERROR") {
      return { success: false, hash: hashValue, error: JSON.stringify(tx) };
    }
    await sleep(1500);
  }
  return { success: false, hash: hashValue, error: "Timed out waiting for strict install transaction" };
}

function encodeRawAddContextRuleArgs(action: WalletInstallAction): xdr.ScVal[] {
  const context = xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol("CallContract"),
    Address.fromString(action.target_contract).toScVal(),
  ]);
  const signer = xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol("External"),
    Address.fromString(action.session_signer.verifier).toScVal(),
    xdr.ScVal.scvBytes(Buffer.from(action.session_signer.public_key_hex, "hex")),
  ]);
  const policyEntries = (action.policies?.custom ?? [])
    .map((policy) => new xdr.ScMapEntry({
      key: Address.fromString(policy.address).toScVal(),
      val: xdr.ScVal.fromXDR(policy.params_xdr_b64, "base64"),
    }))
    .sort((a, b) => Buffer.compare(a.key().toXDR(), b.key().toXDR()));
  return [
    context,
    xdr.ScVal.scvString(action.rule_name),
    xdr.ScVal.scvU32(action.valid_until_ledger),
    xdr.ScVal.scvVec([signer]),
    xdr.ScVal.scvMap(policyEntries),
  ];
}

function installKnownPasskeySigner(kit: SmartAccountKit, credentialId: string, publicKeyHex: string): void {
  const cfg = request.payload.wallet_kit;
  if (!cfg) throw new Error("Missing smart-account-kit config");
  (kit as unknown as { signAuthEntry: (entry: xdr.SorobanAuthorizationEntry, options?: { expiration?: number }) => Promise<xdr.SorobanAuthorizationEntry> }).signAuthEntry =
    async (entry, options) => signKnownWebAuthnAuthEntry(entry, {
      credentialId,
      publicKeyHex,
      webauthnVerifierAddress: cfg.webauthn_verifier_address,
      rpcUrl: cfg.rpc_url,
      networkPassphrase: cfg.network_passphrase,
      expiration: options?.expiration,
    });
}

async function signKnownWebAuthnAuthEntry(
  entry: xdr.SorobanAuthorizationEntry,
  input: {
    credentialId: string;
    publicKeyHex: string;
    webauthnVerifierAddress: string;
    rpcUrl: string;
    networkPassphrase: string;
    expiration?: number;
  },
): Promise<xdr.SorobanAuthorizationEntry> {
  const normalizedEntry = xdr.SorobanAuthorizationEntry.fromXDR(entry.toXDR());
  const credentials = normalizedEntry.credentials().address();
  const expiration = input.expiration ?? await latestLedgerPlus(input.rpcUrl, 720);
  credentials.signatureExpirationLedger(expiration);
  const preimage = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(new xdr.HashIdPreimageSorobanAuthorization({
    networkId: hash(Buffer.from(input.networkPassphrase)),
    nonce: credentials.nonce(),
    signatureExpirationLedger: credentials.signatureExpirationLedger(),
    invocation: normalizedEntry.rootInvocation(),
  }));
  const payload = hash(preimage.toXDR());
  const contextRuleIds = [0];
  const authDigest = hash(Buffer.concat([
    Buffer.from(payload),
    contextRuleIdsToXdr(contextRuleIds),
  ]));
  const authResponse = await startAuthentication({
    optionsJSON: {
      challenge: base64url.encode(Buffer.from(authDigest)),
      rpId: "localhost",
      userVerification: "required",
      timeout: 60_000,
      allowCredentials: [{ id: input.credentialId, type: "public-key", transports: ["internal"] }],
    },
  });
  const authenticatorData = base64url.toBuffer(authResponse.response.authenticatorData);
  assertWebAuthnVerifierFlags(authenticatorData);
  const keyData = Buffer.concat([
    Buffer.from(input.publicKeyHex, "hex"),
    base64url.toBuffer(authResponse.id),
  ]);
  const signerId = {
    tag: "External" as const,
    values: [
      input.webauthnVerifierAddress,
      keyData,
    ] as const,
  };
  const scMapEntry = buildWebAuthnSignatureMapEntry(signerId, {
    authenticator_data: authenticatorData,
    client_data: base64url.toBuffer(authResponse.response.clientDataJSON),
    signature: Buffer.from(compactSignature(base64url.toBuffer(authResponse.response.signature))),
  });
  credentials.signature(buildAuthPayloadScVal(contextRuleIds, [scMapEntry]));
  return normalizedEntry;
}

function assertWebAuthnVerifierFlags(authenticatorData: Buffer): void {
  const flags = authenticatorData[32];
  if (flags === undefined) {
    throw new Error("Passkey assertion returned malformed authenticator data");
  }
  const hasUserPresent = (flags & 0x01) !== 0;
  const hasUserVerified = (flags & 0x04) !== 0;
  if (!hasUserPresent || !hasUserVerified) {
    throw new Error(
      `Passkey assertion is not accepted by the OZ WebAuthn verifier: flags=0x${flags.toString(16).padStart(2, "0")} ` +
      `(userPresent=${String(hasUserPresent)}, userVerified=${String(hasUserVerified)}). ` +
      "Use a platform authenticator/Windows Hello PIN or security key that sets the User Verified bit.",
    );
  }
}

function contextRuleIdsToXdr(contextRuleIds: readonly number[]): Buffer {
  return xdr.ScVal.scvVec(contextRuleIds.map((id) => xdr.ScVal.scvU32(id))).toXDR();
}

function buildAuthPayloadScVal(contextRuleIds: readonly number[], signatures: readonly xdr.ScMapEntry[]): xdr.ScVal {
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("context_rule_ids"),
      val: xdr.ScVal.scvVec(contextRuleIds.map((id) => xdr.ScVal.scvU32(id))),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("signers"),
      val: sortedMap(signatures),
    }),
  ]);
}

function sortedMap(entries: readonly xdr.ScMapEntry[]): xdr.ScVal {
  return xdr.ScVal.scvMap(
    [...entries].sort((a, b) => Buffer.compare(a.key().toXDR(), b.key().toXDR())),
  );
}

function buildWebAuthnSignatureMapEntry(
  signerId: { tag: "External"; values: readonly [string, Buffer] },
  sigData: { authenticator_data: Buffer; client_data: Buffer; signature: Buffer },
): xdr.ScMapEntry {
  const keyVal = xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol("External"),
    xdr.ScVal.scvAddress(Address.fromString(signerId.values[0]).toScAddress()),
    xdr.ScVal.scvBytes(signerId.values[1]),
  ]);
  const sigDataScVal = xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("authenticator_data"),
      val: xdr.ScVal.scvBytes(sigData.authenticator_data),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("client_data"),
      val: xdr.ScVal.scvBytes(sigData.client_data),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("signature"),
      val: xdr.ScVal.scvBytes(sigData.signature),
    }),
  ]);
  return new xdr.ScMapEntry({
    key: keyVal,
    val: xdr.ScVal.scvBytes(sigDataScVal.toXDR()),
  });
}

function compactSignature(derSignature: Buffer): Uint8Array {
  let offset = 2;
  const rLength = derSignature[offset + 1];
  if (rLength === undefined) throw new Error("Invalid DER signature");
  const r = derSignature.slice(offset + 2, offset + 2 + rLength);
  offset += 2 + rLength;
  const sLength = derSignature[offset + 1];
  if (sLength === undefined) throw new Error("Invalid DER signature");
  const s = derSignature.slice(offset + 2, offset + 2 + sLength);
  const rBigInt = BigInt(`0x${r.toString("hex")}`);
  let sBigInt = BigInt(`0x${s.toString("hex")}`);
  const n = BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");
  const halfN = n / 2n;
  if (sBigInt > halfN) sBigInt = n - sBigInt;
  const rPadded = Buffer.from(rBigInt.toString(16).padStart(64, "0"), "hex");
  const sLowS = Buffer.from(sBigInt.toString(16).padStart(64, "0"), "hex");
  return Uint8Array.from(Buffer.concat([rPadded, sLowS]));
}

async function latestLedgerPlus(rpcUrl: string, ledgers: number): Promise<number> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getLatestLedger", params: {} }),
  });
  const json = await response.json() as { result?: { sequence?: number } };
  const sequence = json.result?.sequence;
  if (!Number.isInteger(sequence)) throw new Error("Could not read latest ledger for passkey auth expiration");
  return sequence + ledgers;
}

async function mockApprove(): Promise<void> {
  await postResult({
    sid,
    plan_hash: request.plan_hash,
    account: request.account,
    wallet: {
      sdk: "mock",
      sdk_version: "0.0.0",
      signer_kind: request.payload.expected_signer.signer_kind,
    },
    signed_steps: request.payload.steps.map((step) => ({
      order: step.order,
      step_hash: step.step_hash,
      signed_xdr: `mock-signed:${step.unsigned_xdr}`,
    })),
  });
}

async function reject(): Promise<void> {
  if (!sid) return;
  const res = await fetch(`/api/reject/${encodeURIComponent(sid)}`, {
    method: "POST",
    headers: { Authorization: auth },
  });
  setStatus(res.ok ? "Rejected. You can return to Claude Desktop." : `Reject failed: ${await res.text()}`, res.ok ? "success" : "error");
}

function resultBase(account: string, signerRef: string, publicKeyHint?: string): {
  sid: string | undefined;
  plan_hash: string | undefined;
  account: string;
  wallet: {
    sdk: "smart-account-kit";
    sdk_version: string;
    signer_kind: "webauthn" | "ed25519" | "delegated";
    public_signer_ref: string;
    public_key_hint?: string;
  };
  signed_steps: Array<{
    order: number;
    step_hash: string;
    signed_xdr?: string;
    tx_hash?: string;
    ledger?: number;
  }>;
} {
  return {
    sid,
    plan_hash: request.plan_hash,
    account,
    wallet: {
      sdk: "smart-account-kit",
      sdk_version: "0.2.10",
      signer_kind: request.payload.expected_signer.signer_kind,
      public_signer_ref: signerRef,
      ...(publicKeyHint ? { public_key_hint: publicKeyHint } : {}),
    },
    signed_steps: [],
  };
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string): Uint8Array {
  if (!/^[0-9a-f]+$/iu.test(hex) || hex.length % 2 !== 0) throw new Error("Invalid hex bytes");
  return Uint8Array.from(hex.match(/.{2}/gu)?.map((byte) => Number.parseInt(byte, 16)) ?? []);
}

async function postResult(result: unknown): Promise<void> {
  if (!sid) throw new Error("Missing approval token");
  const res = await fetch(`/api/result/${encodeURIComponent(sid)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: auth },
    body: JSON.stringify(result),
  });
  setStatus(res.ok ? "Approved. You can return to Claude Desktop." : `Approval failed: ${await res.text()}`, res.ok ? "success" : "error");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function setStatus(text: string, className = ""): void {
  status.hidden = false;
  status.className = className;
  status.textContent = text;
}

function requireElement(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) throw new Error(`missing #${id}`);
  return element;
}

function setText(id: string, text: string): void {
  requireElement(id).textContent = text;
}

function setHidden(id: string, hidden: boolean): void {
  requireElement(id).hidden = hidden;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
