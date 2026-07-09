import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RpcClient } from "@ozpb/stellar";
import { SMART_ACCOUNT_KIT_TESTNET_DEFAULTS, WalletBridge } from "@ozpb/wallet-bridge";

export const NetworkSchema = z.enum(["testnet", "mainnet"]);
export type NetworkName = z.infer<typeof NetworkSchema>;
export const SignerKindSchema = z.enum(["webauthn", "ed25519", "delegated"]);

export const WalletKitConfigSchema = z.object({
  rpc_url: z.string().url().default(SMART_ACCOUNT_KIT_TESTNET_DEFAULTS.rpc_url),
  network_passphrase: z.string().default(SMART_ACCOUNT_KIT_TESTNET_DEFAULTS.network_passphrase),
  account_wasm_hash: z.string().default(SMART_ACCOUNT_KIT_TESTNET_DEFAULTS.account_wasm_hash),
  webauthn_verifier_address: z.string().default(SMART_ACCOUNT_KIT_TESTNET_DEFAULTS.webauthn_verifier_address),
  native_token_contract: z.string().optional().default(SMART_ACCOUNT_KIT_TESTNET_DEFAULTS.native_token_contract ?? ""),
  ed25519_verifier_address: z.string().optional().default(SMART_ACCOUNT_KIT_TESTNET_DEFAULTS.ed25519_verifier_address ?? ""),
  threshold_policy_address: z.string().optional().default(SMART_ACCOUNT_KIT_TESTNET_DEFAULTS.threshold_policy_address ?? ""),
  spending_limit_policy_address: z.string().optional().default(SMART_ACCOUNT_KIT_TESTNET_DEFAULTS.spending_limit_policy_address ?? ""),
  weighted_threshold_policy_address: z.string().optional().default(SMART_ACCOUNT_KIT_TESTNET_DEFAULTS.weighted_threshold_policy_address ?? ""),
  relayer_url: z.string().optional().default(""),
  rp_name: z.string().optional().default(SMART_ACCOUNT_KIT_TESTNET_DEFAULTS.rp_name ?? "OZ Policy Builder"),
});

export const DemoActionSchema = z.object({
  kind: z.literal("xlm_transfer"),
  token_contract: z.string().default(SMART_ACCOUNT_KIT_TESTNET_DEFAULTS.native_token_contract ?? ""),
  recipient: z.string().min(1),
  amount_xlm: z.number().positive(),
});

export const InstallActionSchema = z.object({
  kind: z.literal("session_rule"),
  account: z.string().min(1),
  owner_credential_id: z.string().optional(),
  target_contract: z.string().min(1),
  rule_name: z.string().min(1),
  valid_until_ledger: z.number().int().min(1),
  session_signer: z.object({
    verifier: z.string().min(1),
    public_key_hex: z.string().regex(/^[0-9a-f]+$/iu),
  }),
  policies: z.object({
    simple_threshold: z.object({
      address: z.string().min(1),
      threshold: z.number().int().min(1),
    }).optional(),
    spending_limit: z.object({
      address: z.string().min(1),
      spending_limit_stroops: z.string().regex(/^\d+$/u),
      period_ledgers: z.number().int().min(1),
    }).optional(),
    custom: z.array(z.object({
      address: z.string().min(1),
      classification: z.string().min(1),
      params_xdr_b64: z.string().min(1),
    })).optional(),
  }).optional(),
});

export interface McpToolContext {
  bridge: WalletBridge;
}

export type RegisterToolModule = (server: McpServer, context: McpToolContext) => void;

export class JsonRpcBackend {
  constructor(private readonly url: string) {}

  async call(method: string, params: unknown): Promise<Record<string, unknown>> {
    const response = await fetch(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const json = await response.json() as { result?: Record<string, unknown>; error?: unknown };
    if (json.error !== undefined) throw new Error(`${method} failed: ${JSON.stringify(json.error)}`);
    return json.result ?? {};
  }

  async getLatestLedger(): Promise<{ sequence: number; protocolVersion: number; id: string }> {
    const r = await this.call("getLatestLedger", {});
    return {
      sequence: Number(r["sequence"]),
      protocolVersion: Number(r["protocolVersion"]),
      id: typeof r["id"] === "string" ? r["id"] : "",
    };
  }

  async getLedgerEntries(keysB64: string[]): Promise<{ latestLedger: number; entries: { keyB64: string; xdrB64: string; liveUntilLedgerSeq?: number }[] }> {
    const r = await this.call("getLedgerEntries", { keys: keysB64 });
    const entriesValue = r["entries"];
    const entries = Array.isArray(entriesValue) ? entriesValue : [];
    return {
      latestLedger: Number(r["latestLedger"]),
      entries: entries
        .filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null)
        .map((entry) => ({
          keyB64: String(entry["key"]),
          xdrB64: String(entry["xdr"]),
          ...(entry["liveUntilLedgerSeq"] !== undefined ? { liveUntilLedgerSeq: Number(entry["liveUntilLedgerSeq"]) } : {}),
        })),
    };
  }

  async getTransaction(hash: string): Promise<{
    status: "SUCCESS" | "FAILED" | "NOT_FOUND";
    ledger?: number;
    createdAt?: number;
    envelopeXdr?: string;
    resultXdr?: string;
    resultMetaXdr?: string;
  }> {
    const r = await this.call("getTransaction", { hash });
    if (r["status"] === "NOT_FOUND") return { status: "NOT_FOUND" };
    return {
      status: r["status"] === "FAILED" ? "FAILED" : "SUCCESS",
      ...(typeof r["ledger"] === "number" ? { ledger: r["ledger"] } : {}),
      ...(typeof r["createdAt"] === "number" ? { createdAt: r["createdAt"] } : {}),
      ...(typeof r["envelopeXdr"] === "string" ? { envelopeXdr: r["envelopeXdr"] } : {}),
      ...(typeof r["resultXdr"] === "string" ? { resultXdr: r["resultXdr"] } : {}),
      ...(typeof r["resultMetaXdr"] === "string" ? { resultMetaXdr: r["resultMetaXdr"] } : {}),
    };
  }

  async getTransactions(params: { startLedger: number; cursor?: string; limit: number }): Promise<{
    transactions: { hash: string; ledger: number; createdAt: number; envelopeXdr: string; resultXdr?: string; resultMetaXdr?: string }[];
    cursor: string | undefined;
    latestLedger: number;
    oldestLedger: number;
  }> {
    const r = await this.call("getTransactions", params);
    const transactionsValue = r["transactions"];
    const transactions = Array.isArray(transactionsValue) ? transactionsValue : [];
    return {
      transactions: transactions
        .filter((tx): tx is Record<string, unknown> => typeof tx === "object" && tx !== null)
        .map((tx) => ({
          hash: String(tx["hash"]),
          ledger: Number(tx["ledger"]),
          createdAt: Number(tx["createdAt"]),
          envelopeXdr: String(tx["envelopeXdr"]),
          ...(typeof tx["resultXdr"] === "string" ? { resultXdr: tx["resultXdr"] } : {}),
          ...(typeof tx["resultMetaXdr"] === "string" ? { resultMetaXdr: tx["resultMetaXdr"] } : {}),
        })),
      cursor: typeof r["cursor"] === "string" ? r["cursor"] : undefined,
      latestLedger: Number(r["latestLedger"] ?? 0),
      oldestLedger: Number(r["oldestLedger"] ?? params.startLedger),
    };
  }
}

export function rpcClient(rpcUrl: string): RpcClient {
  return RpcClient.create(new JsonRpcBackend(rpcUrl), { budget: 500 });
}
