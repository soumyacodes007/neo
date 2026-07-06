import type { SigningResult } from "./types.js";

export interface CreateWalletInput {
  network: "testnet" | "mainnet";
}

export interface CreateWalletResult {
  account: string;
  owner_signer: {
    signer_kind: "webauthn" | "ed25519" | "delegated";
    verifier?: string;
    public_key_hint?: string;
  };
}

export interface ConnectWalletInput {
  network: "testnet" | "mainnet";
  expected_account?: string;
}

export interface SignPlanInput {
  request: unknown;
}

export interface SmartAccountKitAdapter {
  createWallet(input: CreateWalletInput): Promise<CreateWalletResult>;
  connectWallet(input: ConnectWalletInput): Promise<CreateWalletResult>;
  signPlan(input: SignPlanInput): Promise<SigningResult>;
}

export async function loadSmartAccountKit(): Promise<unknown> {
  // Browser-only adapter seam. The concrete calls are version-pinned during
  // Phase 8 passkey integration; server-side tests use mocks.
  return import("smart-account-kit");
}
