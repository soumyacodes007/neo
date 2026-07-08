import { StrKey, xdr } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { toContractId, toXdrBase64, type CandidateRuleset, type PolicyClassification, type XdrBase64 } from "@ozpb/core";
import { preparePolicyAuthoringDraft } from "./authoring.js";

const ACCOUNT = toContractId(StrKey.encodeContract(Buffer.alloc(32, 1)));
const TOKEN = toContractId(StrKey.encodeContract(Buffer.alloc(32, 2)));

const encode = (_classification: PolicyClassification, _params: Record<string, unknown>): XdrBase64 =>
  toXdrBase64(xdr.ScVal.scvVoid().toXDR("base64"));

function ruleset(): CandidateRuleset {
  return {
    schema_version: "1",
    account: ACCOUNT,
    network: "testnet",
    based_on: { intent_hash: "intent" },
    rules: [{
      name: "transfer-cap",
      context_type: { kind: "call_contract", address: TOKEN },
      valid_until_ledger: 200,
      signers: [],
      constraints: [{
        kind: "amount_cap",
        token: TOKEN,
        cap_i128: "100",
        window: { ledgers: 100 },
        source: { kind: "transfer_arg2" },
        id: "c:amount",
        provenance: [{ kind: "user_intent", quote: "100" }],
      }],
      policy_bindings: [],
    }],
    removals: [],
    updates: [],
    unsatisfied: [],
    ruleset_hash: "aa".repeat(32),
  };
}

describe("preparePolicyAuthoringDraft", () => {
  it("compose_existing mode returns a simulation-ready draft when OZ/pb composition covers the ruleset", () => {
    const draft = preparePolicyAuthoringDraft({ ruleset: ruleset(), mode: "compose_existing", encodeInstallParams: encode });
    expect(draft.next_step).toBe("simulate");
    expect(draft.generation.status).toBe("not_required");
    expect(draft.composition.existing_policy_bindings).toBe(1);
    expect(draft.ruleset.rules[0]?.policy_bindings[0]?.binding.kind).toBe("existing");
  });

  it("compose_existing mode refuses residual codegen instead of hiding it inside the draft", () => {
    expect(() => preparePolicyAuthoringDraft({
      ruleset: ruleset(),
      mode: "compose_existing",
      encodeInstallParams: encode,
      residuals: [{ kind: "cross_arg_lt", constraint_id: "c:slippage", fn_name: "swap", left_index: 2, right_index: 3 }],
    })).toThrow(expect.objectContaining({ code: "E_C3_UNEXPRESSIBLE" }));
  });

  it("generate_custom mode emits review-gated generated code artifacts as a separate step", () => {
    const draft = preparePolicyAuthoringDraft({
      ruleset: ruleset(),
      mode: "generate_custom",
      policyName: "slippage guard",
      encodeInstallParams: encode,
      residuals: [{ kind: "cross_arg_lt", constraint_id: "c:slippage", fn_name: "swap", left_index: 2, right_index: 3 }],
    });
    expect(draft.next_step).toBe("review_compile_then_simulate");
    expect(draft.generation.status).toBe("review_required");
    expect(draft.generation.deployment_blocked_until_review).toBe(true);
    expect(draft.generation.artifacts[0]?.manifest.regions[0]?.constraint_id).toBe("c:slippage");
  });
});
