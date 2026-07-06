import { IndexedDBStorage, SmartAccountKit } from "smart-account-kit";
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
  relayer_url?: string;
  rp_name?: string;
}

interface WalletDemoAction {
  kind: "xlm_transfer";
  token_contract: string;
  recipient: string;
  amount_xlm: number;
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
    expected_signer: { signer_kind: "webauthn" | "ed25519" | "delegated" };
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
    const result = await kit.createWallet("OZ Policy Builder", "demo-user", {
      autoSubmit: true,
      autoFund: Boolean(cfg.native_token_contract),
      nativeTokenContract: cfg.native_token_contract,
    });
    const base = resultBase(result.contractId, result.credentialId);
    const step = request.payload.steps[0] ?? { order: 1, step_hash: "wallet_deploy" };
    if (result.submitResult?.hash) {
      base.signed_steps.push({
        order: step.order,
        step_hash: step.step_hash,
        tx_hash: result.submitResult.hash,
        ledger: result.submitResult.ledger,
      });
    } else if (result.signedTransaction) {
      base.signed_steps.push({
        order: step.order,
        step_hash: step.step_hash,
        signed_xdr: result.signedTransaction,
      });
    } else {
      throw new Error("Wallet creation did not return a signed transaction or tx hash");
    }
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
    await postResult(resultBase(result.contractId, result.credentialId));
  } catch (error: unknown) {
    setStatus(messageOf(error), "error");
  }
}

async function runOneOff(): Promise<void> {
  try {
    setStatus("Signing and submitting one-off action. Complete the passkey prompt in this browser.");
    const kit = loadKit();
    const connected = await kit.connectWallet({ prompt: true });
    if (!connected) throw new Error("No smart account connected");
    const action = request.payload.demo_action;
    if (!action || action.kind !== "xlm_transfer") throw new Error("Unsupported demo action");
    const tx = await kit.transfer(action.token_contract, action.recipient, action.amount_xlm, { forceMethod: "rpc" });
    if (!tx.success || !tx.hash) throw new Error(tx.error ?? "Transaction failed");
    const step = request.payload.steps[0] ?? { order: 1, step_hash: "one_off_action" };
    await postResult({
      ...resultBase(connected.contractId, connected.credentialId),
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

function resultBase(account: string, signerRef: string): {
  sid: string | undefined;
  plan_hash: string | undefined;
  account: string;
  wallet: {
    sdk: "smart-account-kit";
    sdk_version: string;
    signer_kind: "webauthn" | "ed25519" | "delegated";
    public_signer_ref: string;
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
    },
    signed_steps: [],
  };
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
