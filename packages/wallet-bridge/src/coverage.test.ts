import { describe, expect, it } from "vitest";
import { checkPolicyCoverage } from "./coverage.js";

describe("checkPolicyCoverage", () => {
  it("routes covered actions to the session signer", () => {
    expect(
      checkPolicyCoverage({
        action: { contract: "C_TOKEN", fn: "transfer", amount_i128: "400", recipient: "GJAMES" },
        installed: [{ contract: "C_TOKEN", fn: "transfer", max_amount_i128: "400", recipient: "GJAMES" }],
      }),
    ).toMatchObject({ covered: true });
  });

  it("routes new or wider actions back to owner approval", () => {
    expect(
      checkPolicyCoverage({
        action: { contract: "C_TOKEN", fn: "transfer", amount_i128: "401", recipient: "GJAMES" },
        installed: [{ contract: "C_TOKEN", fn: "transfer", max_amount_i128: "400", recipient: "GJAMES" }],
      }),
    ).toEqual({ covered: false, reason: "amount_exceeds_policy" });
  });
});
