import { describe, expect, it } from "vitest";
import { inspectRule } from "./inspect-rule.js";
import { ACCOUNT, buildFixture, makeInspectDeps } from "./testkit.js";

describe("inspectRule (A2)", () => {
  it("returns a scoped rule with expiry + install-state note", async () => {
    // valid_until 5000 > snapshot ledger 1000 ⇒ still active.
    const { rule, health } = await inspectRule(
      { account: ACCOUNT, rule_id: 1 },
      makeInspectDeps(buildFixture({ agentValidUntil: 5000 })),
    );
    expect(rule.id).toBe(1);
    expect(rule.privilege).toBe("scoped");
    expect(rule.valid_until_ledger).toBe(5000);
    expect(health.dormant).toBe(false);
    expect(health.note).toMatch(/install-state/);
    expect(health.expires_at_approx).toMatch(/^~/);
  });

  it("T-A2.1-2: missing rule → E_RULE_NOT_FOUND", async () => {
    await expect(
      inspectRule({ account: ACCOUNT, rule_id: 99 }, makeInspectDeps(buildFixture())),
    ).rejects.toMatchObject({ code: "E_RULE_NOT_FOUND" });
  });

  it("T-A2.1-3: an expired rule is dormant", async () => {
    // Agent rule valid_until=100 while snapshot ledger is 1000 ⇒ expired/dormant.
    const { rule, health } = await inspectRule(
      { account: ACCOUNT, rule_id: 1 },
      makeInspectDeps(buildFixture({ agentValidUntil: 100 })),
    );
    expect(rule.status).toBe("expired");
    expect(health.dormant).toBe(true);
  });
});
