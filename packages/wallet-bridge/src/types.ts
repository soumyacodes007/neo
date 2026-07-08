export type SigningRequestKind =
  | "create_wallet"
  | "connect_wallet"
  | "sign_install_plan"
  | "sign_revocation_plan"
  | "sign_one_off_tx";

export type SigningNetwork = "testnet" | "mainnet";

export interface SigningStep {
  order: number;
  step_hash: string;
  unsigned_xdr: string;
  description: string;
  network_passphrase: string;
  auth_requirements: unknown[];
}

export interface WalletKitConfig {
  rpc_url: string;
  network_passphrase: string;
  account_wasm_hash: string;
  webauthn_verifier_address: string;
  native_token_contract?: string;
  ed25519_verifier_address?: string;
  threshold_policy_address?: string;
  spending_limit_policy_address?: string;
  weighted_threshold_policy_address?: string;
  relayer_url?: string;
  rp_id?: string;
  rp_name?: string;
  passkey_user_name?: string;
  passkey_nickname?: string;
}

export interface WalletDemoAction {
  kind: "xlm_transfer";
  token_contract: string;
  recipient: string;
  amount_xlm: number;
}

export interface WalletInstallAction {
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
  };
}

export interface SigningPayload {
  human_summary_markdown: string;
  risk_summary_markdown: string;
  policy_diff_markdown: string;
  wallet_kit?: WalletKitConfig;
  demo_action?: WalletDemoAction;
  install_action?: WalletInstallAction;
  expected_signer: {
    account?: string;
    signer_kind: "webauthn" | "ed25519" | "delegated";
    verifier?: string;
    public_key_hint?: string;
  };
  steps: SigningStep[];
}

export interface CreateSigningRequestInput {
  kind: SigningRequestKind;
  network: SigningNetwork;
  payload: SigningPayload;
  plan_hash?: string;
  account?: string;
  ttl_ms?: number;
}

export interface SigningRequest {
  sid: string;
  bearer_hash: string;
  kind: SigningRequestKind;
  network: SigningNetwork;
  plan_hash?: string;
  account?: string;
  created_at_ms: number;
  expires_at_ms: number;
  status: "pending" | "completed" | "rejected" | "expired";
  payload: SigningPayload;
  result?: SigningResult;
}

export interface SigningResult {
  sid: string;
  plan_hash?: string;
  account?: string;
  wallet: {
    sdk: "smart-account-kit" | "mock";
    sdk_version: string;
    signer_kind: "webauthn" | "ed25519" | "delegated";
    public_signer_ref?: string;
    public_key_hint?: string;
  };
  signed_steps: {
    order: number;
    step_hash: string;
    signed_xdr?: string;
    tx_hash?: string;
    ledger?: number;
  }[];
}

export interface PublicSigningRequest {
  sid: string;
  kind: SigningRequestKind;
  network: SigningNetwork;
  plan_hash?: string;
  account?: string;
  expires_at_ms: number;
  payload: SigningPayload;
}

export interface ApprovalRequest {
  sid: string;
  approval_url: string;
  expires_at_ms: number;
}
