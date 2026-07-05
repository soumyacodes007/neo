import { StrKey } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { toContractId } from "@ozpb/core";
import { parseIntent, type ParseIntentDeps } from "./parse-intent.js";

const C_ACCOUNT = toContractId(StrKey.encodeContract(Buffer.alloc(32, 1)));
const C_BLEND = toContractId(StrKey.encodeContract(Buffer.alloc(32, 2)));
const C_USDC = toContractId(StrKey.encodeContract(Buffer.alloc(32, 3)));
const G_AGENT = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 4));

const allExist: ParseIntentDeps = { existsContract: () => Promise.resolve(true) };

function draft(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    account: C_ACCOUNT,
    grantee: { signer: { type: "delegated", address: G_AGENT }, label: "agent" },
    targets: [
      {
        contract: C_BLEND,
        functions: [{ name: "claim", arg_constraints: [] }],
        provenance: { kind: "user_intent", quote: "use Blend" },
      },
    ],
    budgets: [
      {
        token: C_USDC,
        cap: "500",
        decimals: 7,
        window: { days: 1 },
        scope: "outflow_via_transfer",
        provenance: { kind: "user_intent", quote: "500/day" },
      },
    ],
    preserve: [0],
    explicit_denies: [],
    clarifications_resolved: [],
    expiry: { days: 7 },
    ...overrides,
  };
}

describe("parseIntent (B3)", () => {
  it("T-B3.1-10: normalizes days→ledgers and returns a stable intent_hash", async () => {
    const r1 = await parseIntent({ draft: draft(), network: "testnet" }, allExist);
    const r2 = await parseIntent({ draft: draft(), network: "testnet" }, allExist);
    if (!("intent" in r1) || !("intent" in r2)) throw new Error("expected intent");
    expect(r1.intent.expiry.ledgers).toBe(7 * 17280);
    expect(r1.intent.budgets[0]?.window.ledgers).toBe(17280);
    expect(r1.intent_hash).toBe(r2.intent_hash);
    expect(r1.intent_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("T-B3.1-1: missing provenance → E_INPUT_PROVENANCE_MISSING with paths", async () => {
    const bad = draft();
    delete (bad["targets"] as Record<string, unknown>[])[0]!["provenance"];
    await expect(parseIntent({ draft: bad, network: "testnet" }, allExist)).rejects.toMatchObject({
      code: "E_INPUT_PROVENANCE_MISSING",
    });
  });

  it("T-B3.1-2: nonexistent target contract → E_DATA_CONTRACT_NOT_FOUND", async () => {
    const deps: ParseIntentDeps = { existsContract: (c) => Promise.resolve(c !== C_BLEND) };
    await expect(parseIntent({ draft: draft(), network: "testnet" }, deps)).rejects.toMatchObject({
      code: "E_DATA_CONTRACT_NOT_FOUND",
    });
  });

  it("T-B3.1-5: missing expiry → clarification, not a default", async () => {
    const noExpiry = draft();
    delete noExpiry["expiry"];
    const r = await parseIntent({ draft: noExpiry, network: "testnet" }, allExist);
    expect("clarifications_needed" in r).toBe(true);
    if ("clarifications_needed" in r) expect(r.clarifications_needed[0]?.field).toBe("expiry");
  });

  it("T-B3.1-7: conflicting budgets for one token → E_INPUT_CONTRADICTION", async () => {
    const conflict = draft({
      budgets: [
        { token: C_USDC, cap: "500", decimals: 7, window: { days: 1 }, scope: "outflow_via_transfer", provenance: { kind: "user_intent", quote: "a" } },
        { token: C_USDC, cap: "999", decimals: 7, window: { days: 1 }, scope: "outflow_via_transfer", provenance: { kind: "user_intent", quote: "b" } },
      ],
    });
    await expect(parseIntent({ draft: conflict, network: "testnet" }, allExist)).rejects.toMatchObject({
      code: "E_INPUT_CONTRADICTION",
    });
  });

  it("T-B3.1-8: allow_default_context is forced false", async () => {
    const r = await parseIntent({ draft: draft({ allow_default_context: true }), network: "testnet" }, allExist);
    if (!("intent" in r)) throw new Error("expected intent");
    expect(r.intent.allow_default_context).toBe(false);
  });
});
