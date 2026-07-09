import { z } from "zod";
import { canonicalHash } from "@ozpb/core";
import { SMART_ACCOUNT_KIT_TESTNET_DEFAULTS } from "@ozpb/wallet-bridge";

const testnetDefaults = SMART_ACCOUNT_KIT_TESTNET_DEFAULTS;
const stellarAddress = /^[CG][A-Z2-7]{55}$/u;
const contractAddress = /^C[A-Z2-7]{55}$/u;
const nonNegativeInteger = /^\d+$/u;

const StellarAddressSchema = z.string().regex(stellarAddress, "expected a Stellar G... or C... address");
const ContractAddressSchema = z.string().regex(contractAddress, "expected a Stellar contract C... address");

export const ProductActionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("native_transfer"),
    account: ContractAddressSchema,
    recipient: StellarAddressSchema,
    amount_xlm: z.union([z.string().min(1), z.number().positive()]),
    token_contract: ContractAddressSchema.default(testnetDefaults.native_token_contract ?? ""),
  }),
  z.object({
    kind: z.literal("sep41_transfer"),
    account: ContractAddressSchema,
    token_contract: ContractAddressSchema,
    recipient: StellarAddressSchema,
    amount_i128: z.string().regex(nonNegativeInteger),
    decimals: z.number().int().min(0).max(18).default(7),
  }),
  z.object({
    kind: z.literal("blend_claim"),
    account: ContractAddressSchema,
    pool_contract: ContractAddressSchema,
    max_claim_i128: z.string().regex(nonNegativeInteger).optional(),
    receive_token_contract: ContractAddressSchema.optional(),
  }),
  z.object({
    kind: z.literal("soroswap_swap"),
    account: ContractAddressSchema,
    router_contract: ContractAddressSchema,
    token_in: ContractAddressSchema,
    token_out: ContractAddressSchema,
    amount_in_i128: z.string().regex(nonNegativeInteger),
    min_out_i128: z.string().regex(nonNegativeInteger),
    max_slippage_bps: z.number().int().min(0).max(10_000).optional(),
  }),
]);

export const CoveragePatternSchema = z.object({
  contract: z.string(),
  fn: z.string(),
  max_amount_i128: z.string().optional(),
  recipient: z.string().optional(),
  valid_until_ledger: z.number().int().optional(),
});

export const SigningStepSchema = z.object({
  order: z.number().int().min(1),
  step_hash: z.string().min(1),
  unsigned_xdr: z.string().min(1),
  description: z.string(),
  network_passphrase: z.string(),
  auth_requirements: z.array(z.unknown()).default([]),
});

export type ProductAction = z.infer<typeof ProductActionSchema>;

export interface NormalizedProductAction {
  contract: string;
  fn: string;
  amount_i128?: string;
  recipient?: string;
  adapter: string;
  human_summary: string;
  args_preview: unknown[];
}

export interface ExecutableActionPlan {
  status: "ready";
  builder: "smart-account-kit.transfer" | "blend-sdk.submit";
  wallet_demo_action:
    | {
      kind: "xlm_transfer";
      token_contract: string;
      recipient: string;
      amount_xlm: number;
    }
    | {
      kind: "blend_submit";
      pool_contract: string;
      reserve: string;
      request_type: "SupplyCollateral";
      amount_i128: string;
    };
  default_step: z.infer<typeof SigningStepSchema>;
}

export interface UnsupportedActionPlan {
  status: "unsupported";
  builder: "blend.claim" | "soroswap.swap" | "sep41.transfer";
  reason: string;
  required_work: string[];
  safe_next_step: string;
}

export type TransactionActionPlan = ExecutableActionPlan | UnsupportedActionPlan;

export interface ProductActionPlan {
  action: NormalizedProductAction;
  coverage_query: {
    contract: string;
    fn: string;
    amount_i128?: string;
    recipient?: string;
  };
  transaction: TransactionActionPlan;
}

export function buildProductActionPlan(action: ProductAction, networkPassphrase: string): ProductActionPlan {
  const normalized = normalizeProductAction(action);
  return {
    action: normalized,
    coverage_query: {
      contract: normalized.contract,
      fn: normalized.fn,
      ...(normalized.amount_i128 !== undefined ? { amount_i128: normalized.amount_i128 } : {}),
      ...(normalized.recipient !== undefined ? { recipient: normalized.recipient } : {}),
    },
    transaction: transactionPlanForAction(action, normalized, networkPassphrase),
  };
}

export function normalizeProductAction(action: ProductAction): NormalizedProductAction {
  switch (action.kind) {
    case "native_transfer": {
      const amount = xlmToStroops(action.amount_xlm);
      return {
        contract: action.token_contract,
        fn: "transfer",
        amount_i128: amount,
        recipient: action.recipient,
        adapter: "native_token",
        human_summary: `Send ${String(action.amount_xlm)} XLM to ${action.recipient}`,
        args_preview: [action.account, action.recipient, amount],
      };
    }
    case "sep41_transfer":
      return {
        contract: action.token_contract,
        fn: "transfer",
        amount_i128: action.amount_i128,
        recipient: action.recipient,
        adapter: "sep41_token",
        human_summary: `Transfer ${action.amount_i128} raw units to ${action.recipient}`,
        args_preview: [action.account, action.recipient, action.amount_i128],
      };
    case "blend_claim":
      return {
        contract: action.pool_contract,
        fn: "claim",
        ...(action.max_claim_i128 !== undefined ? { amount_i128: action.max_claim_i128 } : {}),
        adapter: "blend",
        human_summary: "Claim Blend yield from the selected pool",
        args_preview: [action.account, action.pool_contract, action.max_claim_i128 ?? "observed_amount"],
      };
    case "soroswap_swap":
      return {
        contract: action.router_contract,
        fn: "swap",
        amount_i128: action.amount_in_i128,
        adapter: "soroswap",
        human_summary: `Swap ${action.amount_in_i128} input units with min output ${action.min_out_i128}`,
        args_preview: [action.account, action.token_in, action.token_out, action.amount_in_i128, action.min_out_i128],
      };
  }
}

function transactionPlanForAction(
  action: ProductAction,
  normalized: NormalizedProductAction,
  networkPassphrase: string,
): TransactionActionPlan {
  switch (action.kind) {
    case "native_transfer": {
      const amountXlm = amountToSafeNumber(action.amount_xlm);
      return {
        status: "ready",
        builder: "smart-account-kit.transfer",
        wallet_demo_action: {
          kind: "xlm_transfer",
          token_contract: action.token_contract,
          recipient: action.recipient,
          amount_xlm: amountXlm,
        },
        default_step: {
          order: 1,
          step_hash: canonicalHash({
            kind: "smart_account_kit_transfer",
            contract: normalized.contract,
            fn: normalized.fn,
            recipient: action.recipient,
            amount_i128: normalized.amount_i128,
          } as never),
          unsigned_xdr: "smart-account-kit:transfer",
          description: normalized.human_summary,
          network_passphrase: networkPassphrase,
          auth_requirements: [{ kind: "owner_webauthn", reason: "one_off_transfer" }],
        },
      };
    }
    case "blend_claim":
      return {
        status: "ready",
        builder: "blend-sdk.submit",
        wallet_demo_action: {
          kind: "blend_submit",
          pool_contract: action.pool_contract,
          reserve: action.receive_token_contract ?? testnetDefaults.native_token_contract ?? "",
          request_type: "SupplyCollateral",
          amount_i128: action.max_claim_i128 ?? "100000",
        },
        default_step: {
          order: 1,
          step_hash: canonicalHash({
            kind: "blend_submit",
            pool_contract: action.pool_contract,
            reserve: action.receive_token_contract ?? testnetDefaults.native_token_contract ?? "",
            request_type: "SupplyCollateral",
            amount_i128: action.max_claim_i128 ?? "100000",
          } as never),
          unsigned_xdr: "blend-sdk:submit",
          description: normalized.human_summary,
          network_passphrase: networkPassphrase,
          auth_requirements: [{ kind: "owner_webauthn", reason: "one_off_blend_submit" }],
        },
      };
    case "sep41_transfer":
      return {
        status: "unsupported",
        builder: "sep41.transfer",
        reason: "SEP-41 transfer normalization exists, but the current browser companion only has a native XLM transfer helper wired.",
        required_work: [
          "Add a token-amount-aware browser builder for arbitrary SEP-41 contracts.",
          "Prove one real testnet transfer fixture through record_transaction.",
        ],
        safe_next_step: "Use native_transfer for the current end-to-end demo or provide an externally signed transaction hash.",
      };
    case "soroswap_swap":
      return {
        status: "unsupported",
        builder: "soroswap.swap",
        reason: "Soroswap swap is recognized for future policy planning, but no router-specific transaction builder is wired yet.",
        required_work: [
          "Confirm router contract function names and argument order from contractspec.",
          "Add a browser-side swap builder and slippage guard evidence capture.",
        ],
        safe_next_step: "Use an external wallet/app to perform the swap once, then call ozpb_record_transaction with the real tx hash.",
      };
  }
}

function xlmToStroops(amount: string | number): string {
  const parts = String(amount).trim().split(".");
  const wholeRaw = parts[0] ?? "";
  const fracRaw = parts[1] ?? "";
  if (!/^\d+$/.test(wholeRaw) || !/^\d*$/.test(fracRaw) || fracRaw.length > 7) {
    throw new Error("amount_xlm must be a non-negative decimal with at most 7 fractional digits");
  }
  const stroops = BigInt(wholeRaw) * 10_000_000n + BigInt(fracRaw.padEnd(7, "0") || "0");
  if (stroops <= 0n) {
    throw new Error("amount_xlm must be greater than zero");
  }
  return stroops.toString();
}

function amountToSafeNumber(amount: string | number): number {
  const parsed = Number(String(amount).trim());
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("amount_xlm must be a positive finite number");
  }
  const roundTrip = xlmToStroops(parsed);
  const original = xlmToStroops(amount);
  if (roundTrip !== original) {
    throw new Error("amount_xlm is not safely representable for smart-account-kit.transfer");
  }
  return parsed;
}
