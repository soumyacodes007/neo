export interface IntentAction {
  contract: string;
  fn: string;
  amount_i128?: string | undefined;
  recipient?: string | undefined;
}

export interface InstalledPolicyPattern {
  contract: string;
  fn: string;
  max_amount_i128?: string | undefined;
  recipient?: string | undefined;
  valid_until_ledger?: number | undefined;
}

export interface CoverageCheckInput {
  action: IntentAction;
  installed: InstalledPolicyPattern[];
  current_ledger?: number | undefined;
}

export type CoverageCheckResult =
  | { covered: true; pattern: InstalledPolicyPattern; reason: "matched_policy" }
  | { covered: false; reason: "no_matching_policy" | "amount_exceeds_policy" | "recipient_mismatch" | "expired" };

export function checkPolicyCoverage(input: CoverageCheckInput): CoverageCheckResult {
  for (const pattern of input.installed) {
    if (pattern.contract !== input.action.contract || pattern.fn !== input.action.fn) continue;

    if (
      pattern.valid_until_ledger !== undefined &&
      input.current_ledger !== undefined &&
      pattern.valid_until_ledger < input.current_ledger
    ) {
      return { covered: false, reason: "expired" };
    }

    if (pattern.recipient !== undefined && pattern.recipient !== input.action.recipient) {
      return { covered: false, reason: "recipient_mismatch" };
    }

    if (
      pattern.max_amount_i128 !== undefined &&
      input.action.amount_i128 !== undefined &&
      BigInt(input.action.amount_i128) > BigInt(pattern.max_amount_i128)
    ) {
      return { covered: false, reason: "amount_exceeds_policy" };
    }

    return { covered: true, pattern, reason: "matched_policy" };
  }

  return { covered: false, reason: "no_matching_policy" };
}
