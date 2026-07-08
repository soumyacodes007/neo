import { z } from "zod";
import { SMART_ACCOUNT_KIT_TESTNET_DEFAULTS } from "@ozpb/wallet-bridge";

const testnetDefaults = SMART_ACCOUNT_KIT_TESTNET_DEFAULTS;

export const ProductActionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("native_transfer"),
    account: z.string().min(1),
    recipient: z.string().min(1),
    amount_xlm: z.union([z.string().min(1), z.number().positive()]),
    token_contract: z.string().default(testnetDefaults.native_token_contract ?? ""),
  }),
  z.object({
    kind: z.literal("sep41_transfer"),
    account: z.string().min(1),
    token_contract: z.string().min(1),
    recipient: z.string().min(1),
    amount_i128: z.string().regex(/^\d+$/),
    decimals: z.number().int().min(0).max(18).default(7),
  }),
  z.object({
    kind: z.literal("blend_claim"),
    account: z.string().min(1),
    pool_contract: z.string().min(1),
    max_claim_i128: z.string().regex(/^\d+$/).optional(),
    receive_token_contract: z.string().optional(),
  }),
  z.object({
    kind: z.literal("soroswap_swap"),
    account: z.string().min(1),
    router_contract: z.string().min(1),
    token_in: z.string().min(1),
    token_out: z.string().min(1),
    amount_in_i128: z.string().regex(/^\d+$/),
    min_out_i128: z.string().regex(/^\d+$/),
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

export function normalizeProductAction(action: z.infer<typeof ProductActionSchema>): {
  contract: string;
  fn: string;
  amount_i128?: string;
  recipient?: string;
  adapter: string;
  human_summary: string;
  args_preview: unknown[];
} {
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
        args_preview: [action.account, action.max_claim_i128 ?? "observed_amount"],
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

function xlmToStroops(amount: string | number): string {
  const parts = String(amount).trim().split(".");
  const wholeRaw = parts[0] ?? "";
  const fracRaw = parts[1] ?? "";
  if (!/^\d+$/.test(wholeRaw) || !/^\d*$/.test(fracRaw) || fracRaw.length > 7) {
    throw new Error("amount_xlm must be a non-negative decimal with at most 7 fractional digits");
  }
  return (BigInt(wholeRaw) * 10_000_000n + BigInt(fracRaw.padEnd(7, "0") || "0")).toString();
}
