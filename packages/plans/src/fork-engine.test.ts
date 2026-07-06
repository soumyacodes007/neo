import { Address, nativeToScVal } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { ForkHarnessEngine, type ForkPolicy } from "./fork-engine.js";
import type { TestCase } from "@ozpb/core";

const ACCOUNT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
const TARGET = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";

function scvI128(n: bigint): string {
  return nativeToScVal(n, { type: "i128" }).toXDR("base64");
}

function addr(a: string): string {
  return Address.fromString(a).toScVal().toXDR("base64");
}

function transferCase(id: string, amount: bigint, expected: TestCase["expected"]): TestCase {
  return {
    id,
    kind: expected.kind === "pass" ? "allow" : "deny",
    origin: { kind: "mutation", operator: "amount_plus_epsilon", base_case: "base" },
    context: { contract: TARGET, fn_name: "transfer", args_scval_b64: [addr(ACCOUNT), addr(ACCOUNT), scvI128(amount)] },
    signer_set: [{ type: "delegated", address: ACCOUNT }],
    ledger_offset: 0,
    expected,
  };
}

describe("ForkHarnessEngine", () => {
  it("wraps the Rust harness and preserves per-case verdicts", async () => {
    const policies: ForkPolicy[] = [
      { kind: "function_allowlist", allowed: ["transfer"] },
      { kind: "call_cap", cap: "400", period_ledgers: 100, fn_name: "transfer", amount_path: [{ kind: "index", index: 2 }] },
    ];
    const cases = [
      transferCase("allow-400", 400n, { kind: "pass" }),
      transferCase("deny-401", 401n, { kind: "panic", contract_error_code: 3344 }),
    ];
    const engine = new ForkHarnessEngine({
      account: ACCOUNT,
      rule: { id: 1, target_contract: TARGET },
      policies,
      runProcess: async (_cmd, args) => {
        expect(args).toContain("--manifest-path");
        return {
          code: 0,
          stderr: "",
          stdout: JSON.stringify({
            toolchain_fingerprint: "rust-harness:soroban-sdk-26.1.0",
            cases: [
              { case_id: "allow-400", outcome: "pass" },
              { case_id: "deny-401", outcome: "pass", detail: "Error(Contract, #3344)" },
            ],
          }),
        };
      },
    });

    await expect(engine.run(cases)).resolves.toEqual([
      { case_id: "allow-400", outcome: "pass" },
      { case_id: "deny-401", outcome: "pass", detail: "Error(Contract, #3344)" },
    ]);
  });

  it("turns harness infrastructure failures into per-case errors", async () => {
    const cases = [transferCase("allow-400", 400n, { kind: "pass" })];
    const engine = new ForkHarnessEngine({
      rule: { id: 1, target_contract: TARGET },
      policies: [{ kind: "function_allowlist", allowed: ["transfer"] }],
      runProcess: async () => ({ code: 1, stdout: "", stderr: "snapshot missing footprint" }),
    });

    await expect(engine.run(cases)).resolves.toEqual([{ case_id: "allow-400", outcome: "error", detail: "snapshot missing footprint" }]);
  });

  it("creates a snapshot before invoking the Rust harness when snapshot input is supplied", async () => {
    const cases = [transferCase("allow-400", 400n, { kind: "pass" })];
    const snapshotCalls: string[][] = [];
    const engine = new ForkHarnessEngine({
      account: ACCOUNT,
      rule: { id: 1, target_contract: TARGET },
      policies: [{ kind: "function_allowlist", allowed: ["transfer"] }],
      snapshot: {
        addresses: [TARGET],
        ledger: 123,
        network: "testnet",
        runProcess: async (_cmd, args) => {
          snapshotCalls.push(args);
          return { code: 0, stdout: "", stderr: "" };
        },
      },
      runProcess: async (_cmd, _args) => ({
        code: 0,
        stderr: "",
        stdout: JSON.stringify({ cases: [{ case_id: "allow-400", outcome: "pass" }] }),
      }),
    });

    await expect(engine.run(cases)).resolves.toEqual([{ case_id: "allow-400", outcome: "pass" }]);
    expect(snapshotCalls[0]).toContain("--ledger");
    expect(snapshotCalls[0]).toContain("123");
    expect(snapshotCalls[0]).toContain("--address");
    expect(snapshotCalls[0]).toContain(TARGET);
  });
});
