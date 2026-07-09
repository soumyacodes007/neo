import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CandidateRuleset, TestCase, canonicalHash, type JsonValue } from "@ozpb/core";
import { ForkHarnessEngine, runSimulation, type ForkPolicy } from "@ozpb/plans";
import { encodeAddressScValB64, encodeBlendSupplyCollateralSubmitArgsB64, encodeI128ScValB64 } from "@ozpb/stellar";
import { SMART_ACCOUNT_KIT_TESTNET_DEFAULTS } from "@ozpb/wallet-bridge";
import { withToolBoundary } from "../tool-boundary.js";
import { NetworkSchema, WalletKitConfigSchema, type McpToolContext } from "./types.js";

const DockerSchema = z.object({
  image: z.string().default("ozpb-sandbox:local"),
  cpus: z.string().default("2"),
  memory: z.string().default("4g"),
  network: z.enum(["none", "host"]).default("none"),
}).default({});

const CommonSchema = z.object({
  network: NetworkSchema.default("testnet"),
  account: z.string().min(1),
  session_signer_public_key_hex: z.string().regex(/^[0-9a-f]+$/iu).optional(),
  valid_until_ledger: z.number().int().min(1),
  wallet_kit: WalletKitConfigSchema.optional(),
  docker: DockerSchema,
  run: z.boolean().default(false),
});

const XlmSchema = CommonSchema.extend({
  profile: z.literal("xlm_transfer"),
  token_contract: z.string().min(1).default(SMART_ACCOUNT_KIT_TESTNET_DEFAULTS.native_token_contract ?? ""),
  recipient: z.string().min(1),
  amount_i128: z.string().regex(/^\d+$/u),
});

const BlendSchema = CommonSchema.extend({
  profile: z.literal("blend_submit"),
  pool_contract: z.string().min(1),
  reserve_contract: z.string().min(1),
  wrong_reserve_contract: z.string().min(1).optional(),
  amount_i128: z.string().regex(/^\d+$/u),
  period_ledgers: z.number().int().min(1).default(17_280),
});

interface VerificationProfile {
  name: string;
  ruleset: z.infer<typeof CandidateRuleset>;
  cases: z.infer<typeof TestCase>[];
  fork: {
    account: string;
    rule: { id: number; target_contract: string; valid_until: number };
    policies: ForkPolicy[];
    docker: { image: string; cpus: string; memory: string; network: "none" | "host" };
  };
}

const InputSchema = z.discriminatedUnion("profile", [XlmSchema, BlendSchema]);

export function registerPrepareVerificationProfileTool(server: McpServer, _context: McpToolContext): void {
  server.registerTool(
    "ozpb_prepare_verification_profile",
    {
      title: "Prepare verification profile",
      description: "Builds install-ready Docker fork verification defaults for XLM transfer and Blend submit profiles.",
      inputSchema: InputSchema,
    },
    withToolBoundary("ozpb_prepare_verification_profile", async (rawInput) => {
      const input = InputSchema.parse(rawInput);
      const walletKit = input.wallet_kit ?? SMART_ACCOUNT_KIT_TESTNET_DEFAULTS;
      const verifier = walletKit.ed25519_verifier_address || SMART_ACCOUNT_KIT_TESTNET_DEFAULTS.ed25519_verifier_address || input.account;
      const profiles = input.profile === "xlm_transfer"
        ? [xlmProfile(input, verifier)]
        : blendProfiles(input, verifier);
      const simulationRequests = profiles.map((profile) => ({
        profile: profile.name,
        tool: "ozpb_run_simulation",
        input: {
          ruleset: profile.ruleset,
          cases: profile.cases,
          engine: "fork",
          fork: profile.fork,
        },
      }));
      const reports = input.run
        ? await Promise.all(profiles.map(async (profile) => {
          const report = await runSimulation({
            ruleset: profile.ruleset,
            cases: profile.cases,
            engines: [new ForkHarnessEngine({
              account: profile.fork.account,
              rule: profile.fork.rule,
              policies: profile.fork.policies,
              docker: {
                image: profile.fork.docker.image,
                cpus: profile.fork.docker.cpus,
                memory: profile.fork.docker.memory,
                network: profile.fork.docker.network,
              },
            })],
          });
          return { profile: profile.name, report };
        }))
        : [];
      return {
        profile: input.profile,
        install_ready_profile_count: profiles.length,
        simulation_requests: simulationRequests,
        ...(input.run ? { simulation_reports: reports } : {}),
        install_allowed: input.run ? reports.every((r) => r.report.verdict === "all_green") : false,
        next_step: input.run
          ? "if install_allowed is true, call ozpb_prepare_session_policy_install and then ozpb_install_policy"
          : "call ozpb_run_simulation for every simulation_request, or rerun this tool with run=true",
      };
    }),
  );
}

function xlmProfile(input: z.infer<typeof XlmSchema>, verifier: string): VerificationProfile {
  const amountPlusOne = (BigInt(input.amount_i128) + 1n).toString();
  const signerModel = signer(verifier, input.session_signer_public_key_hex);
  const candidate = buildRuleset({
    account: input.account,
    network: input.network,
    target: input.token_contract,
    fnName: "transfer",
    validUntil: input.valid_until_ledger,
    signer: signerModel,
    constraints: [
      { kind: "func_allowlist", id: "fn-transfer", contract: input.token_contract, functions: ["transfer"], provenance: provenance("XLM transfer function") },
      { kind: "arg_predicate", id: "sender-lock", contract: input.token_contract, fn: "transfer", arg_index: 0, op: "addr_eq", provenance: provenance("smart account sender lock") },
      { kind: "arg_predicate", id: "recipient-lock", contract: input.token_contract, fn: "transfer", arg_index: 1, op: "addr_eq", provenance: provenance("recipient lock") },
      { kind: "arg_predicate", id: "amount-max", contract: input.token_contract, fn: "transfer", arg_index: 2, op: "range", min_i128: "0", max_i128: input.amount_i128, provenance: provenance("amount ceiling") },
      { kind: "expiry", id: "expiry", valid_until_ledger: input.valid_until_ledger, provenance: provenance("user-selected expiry") },
    ],
  });
  const baseArgs = [encodeAddressScValB64(input.account), encodeAddressScValB64(input.recipient), encodeI128ScValB64(input.amount_i128)];
  return {
    name: "xlm_transfer",
    ruleset: candidate,
    cases: [
      test("xlm-transfer-allowed", "allow", input.token_contract, "transfer", baseArgs, "pass"),
      test("xlm-transfer-amount-plus-one-denied", "deny", input.token_contract, "transfer", [baseArgs[0]!, baseArgs[1]!, encodeI128ScValB64(amountPlusOne)], "panic", 3325),
      test("xlm-transfer-wrong-recipient-denied", "deny", input.token_contract, "transfer", [baseArgs[0]!, encodeAddressScValB64(input.account), baseArgs[2]!], "panic", 3325),
      test("xlm-transfer-wrong-function-denied", "deny", input.token_contract, "approve", baseArgs, "panic", 3303),
      test("xlm-transfer-wrong-contract-denied", "deny", input.account, "transfer", baseArgs, "panic", 3303),
      test("xlm-transfer-expired-denied", "deny", input.token_contract, "transfer", baseArgs, "panic", 3013, 1),
    ],
    fork: {
      account: input.account,
      rule: { id: 1, target_contract: input.token_contract, valid_until: input.valid_until_ledger },
      policies: [
        { kind: "function_allowlist", allowed: ["transfer"] },
        {
          kind: "arg_guard",
          rules: [
            { fn_name: "transfer", arg_index: 0, path: [], pred: { kind: "addr_eq", address: input.account }, forall: false },
            { fn_name: "transfer", arg_index: 1, path: [], pred: { kind: "addr_eq", address: input.recipient }, forall: false },
            { fn_name: "transfer", arg_index: 2, path: [], pred: { kind: "range", min: "0", max: input.amount_i128 }, forall: false },
          ],
        },
      ],
      docker: input.docker,
    },
  };
}

function blendProfiles(input: z.infer<typeof BlendSchema>, verifier: string): VerificationProfile[] {
  const wrongReserve = input.wrong_reserve_contract ?? input.account;
  const signerModel = signer(verifier, input.session_signer_public_key_hex);
  const poolArgs = encodeBlendSupplyCollateralSubmitArgsB64({ account: input.account, reserve: input.reserve_contract, amount: input.amount_i128 });
  const poolPlusOneArgs = encodeBlendSupplyCollateralSubmitArgsB64({
    account: input.account,
    reserve: input.reserve_contract,
    amount: (BigInt(input.amount_i128) + 1n).toString(),
  });
  const wrongReserveArgs = encodeBlendSupplyCollateralSubmitArgsB64({ account: input.account, reserve: wrongReserve, amount: input.amount_i128 });
  const tokenArgs = [encodeAddressScValB64(input.account), encodeAddressScValB64(input.pool_contract), encodeI128ScValB64(input.amount_i128)];
  const tokenPlusOneArgs = [tokenArgs[0]!, tokenArgs[1]!, encodeI128ScValB64((BigInt(input.amount_i128) + 1n).toString())];
  return [
    {
      name: "blend_pool_submit",
      ruleset: buildRuleset({
        account: input.account,
        network: input.network,
        target: input.pool_contract,
        fnName: "submit",
        validUntil: input.valid_until_ledger,
        signer: signerModel,
        constraints: [
          { kind: "func_allowlist", id: "fn-submit", contract: input.pool_contract, functions: ["submit"], provenance: provenance("Blend submit only") },
          { kind: "amount_cap", id: "blend-submit-cap", token: input.reserve_contract, cap_i128: input.amount_i128, window: { ledgers: input.period_ledgers }, source: { kind: "call_arg", contract: input.pool_contract, fn: "submit", path: "$[3][*].amount", token_filter_path: "$[3][*].address" }, provenance: provenance("Blend amount cap") },
          { kind: "expiry", id: "expiry", valid_until_ledger: input.valid_until_ledger, provenance: provenance("user-selected expiry") },
        ],
      }),
      cases: [
        test("blend-submit-allowed", "allow", input.pool_contract, "submit", poolArgs, "pass"),
        test("blend-submit-amount-plus-one-denied", "deny", input.pool_contract, "submit", poolPlusOneArgs, "panic", 3344),
        test("blend-submit-wrong-reserve-denied", "deny", input.pool_contract, "submit", wrongReserveArgs, "panic", 3325),
        test("blend-submit-wrong-function-denied", "deny", input.pool_contract, "withdraw", poolArgs, "panic", 3303),
        test("blend-submit-expired-denied", "deny", input.pool_contract, "submit", poolArgs, "panic", 3013, 1),
      ],
      fork: {
        account: input.account,
        rule: { id: 1, target_contract: input.pool_contract, valid_until: input.valid_until_ledger },
        policies: [
          { kind: "function_allowlist", allowed: ["submit"] },
          {
            kind: "arg_guard",
            rules: [
              { fn_name: "submit", arg_index: 0, path: [], pred: { kind: "addr_eq", address: input.account }, forall: false },
              { fn_name: "submit", arg_index: 1, path: [], pred: { kind: "addr_eq", address: input.account }, forall: false },
              { fn_name: "submit", arg_index: 2, path: [], pred: { kind: "addr_eq", address: input.account }, forall: false },
              { fn_name: "submit", arg_index: 3, path: [{ kind: "wildcard" }, { kind: "field", name: "request_type" }], pred: { kind: "u32_in", values: [2] }, forall: true },
              { fn_name: "submit", arg_index: 3, path: [{ kind: "wildcard" }, { kind: "field", name: "address" }], pred: { kind: "addr_eq", address: input.reserve_contract }, forall: true },
            ],
          },
          {
            kind: "call_cap",
            cap: input.amount_i128,
            period_ledgers: input.period_ledgers,
            fn_name: "submit",
            amount_path: [{ kind: "index", index: 3 }, { kind: "wildcard" }, { kind: "field", name: "amount" }],
            token_filter_path: [{ kind: "index", index: 3 }, { kind: "wildcard" }, { kind: "field", name: "address" }],
            token_filter_token: input.reserve_contract,
          },
        ],
        docker: input.docker,
      },
    },
    {
      name: "blend_token_transfer_subcall",
      ruleset: buildRuleset({
        account: input.account,
        network: input.network,
        target: input.reserve_contract,
        fnName: "transfer",
        validUntil: input.valid_until_ledger,
        signer: signerModel,
        constraints: [
          { kind: "func_allowlist", id: "fn-transfer", contract: input.reserve_contract, functions: ["transfer"], provenance: provenance("Blend reserve token transfer only") },
          { kind: "amount_cap", id: "reserve-transfer-cap", token: input.reserve_contract, cap_i128: input.amount_i128, window: { ledgers: input.period_ledgers }, source: { kind: "transfer_arg2" }, provenance: provenance("reserve token amount cap") },
          { kind: "expiry", id: "expiry", valid_until_ledger: input.valid_until_ledger, provenance: provenance("user-selected expiry") },
        ],
      }),
      cases: [
        test("blend-token-transfer-allowed", "allow", input.reserve_contract, "transfer", tokenArgs, "pass"),
        test("blend-token-transfer-amount-plus-one-denied", "deny", input.reserve_contract, "transfer", tokenPlusOneArgs, "panic", 3344),
        test("blend-token-transfer-wrong-recipient-denied", "deny", input.reserve_contract, "transfer", [tokenArgs[0]!, encodeAddressScValB64(input.account), tokenArgs[2]!], "panic", 3325),
        test("blend-token-transfer-wrong-function-denied", "deny", input.reserve_contract, "approve", tokenArgs, "panic", 3303),
        test("blend-token-transfer-expired-denied", "deny", input.reserve_contract, "transfer", tokenArgs, "panic", 3013, 1),
      ],
      fork: {
        account: input.account,
        rule: { id: 1, target_contract: input.reserve_contract, valid_until: input.valid_until_ledger },
        policies: [
          { kind: "function_allowlist", allowed: ["transfer"] },
          {
            kind: "arg_guard",
            rules: [
              { fn_name: "transfer", arg_index: 0, path: [], pred: { kind: "addr_eq", address: input.account }, forall: false },
              { fn_name: "transfer", arg_index: 1, path: [], pred: { kind: "addr_eq", address: input.pool_contract }, forall: false },
            ],
          },
          {
            kind: "call_cap",
            cap: input.amount_i128,
            period_ledgers: input.period_ledgers,
            fn_name: "transfer",
            amount_path: [{ kind: "index", index: 2 }],
          },
        ],
        docker: input.docker,
      },
    },
  ];
}

function buildRuleset(input: {
  account: string;
  network: "testnet" | "mainnet";
  target: string;
  fnName: string;
  validUntil: number;
  signer: { type: "external"; verifier: string; key_data_b64: string; verifier_kind: "ed25519" };
  constraints: Record<string, unknown>[];
}): z.infer<typeof CandidateRuleset> {
  const draft = {
    schema_version: "1" as const,
    account: input.account,
    network: input.network,
    based_on: { intent_hash: canonicalHash({ profile: input.fnName } as JsonValue) },
    rules: [{
      name: `verify-${input.fnName}`.slice(0, 20),
      context_type: { kind: "call_contract" as const, address: input.target },
      valid_until_ledger: input.validUntil,
      signers: [input.signer],
      constraints: input.constraints,
      policy_bindings: [],
    }],
    removals: [],
    updates: [],
    unsatisfied: [],
  };
  return CandidateRuleset.parse({ ...draft, ruleset_hash: canonicalHash(draft as unknown as JsonValue) });
}

function test(
  id: string,
  kind: "allow" | "deny",
  contract: string,
  fnName: string,
  args: string[],
  expected: "pass" | "panic",
  contractErrorCode?: number,
  ledgerOffset = 0,
): z.infer<typeof TestCase> {
  return TestCase.parse({
    id,
    kind,
    origin: kind === "allow"
      ? { kind: "user_example", provenance: { kind: "default", rule: "install-ready verification profile" } }
      : { kind: "mutation", operator: id.includes("amount") ? "amount_plus_epsilon" : id.includes("function") ? "wrong_function" : id.includes("contract") ? "wrong_contract" : id.includes("expired") ? "expired_window" : "arg_tamper", base_case: id.split("-").slice(0, 2).join("-") },
    context: { contract, fn_name: fnName, args_scval_b64: args },
    signer_set: [],
    ledger_offset: ledgerOffset,
    expected: expected === "pass" ? { kind: "pass" } : { kind: "panic", contract_error_code: contractErrorCode },
  });
}

function signer(verifier: string, keyHex: string | undefined) {
  return {
    type: "external" as const,
    verifier,
    key_data_b64: Buffer.from(keyHex ?? "00".repeat(32), "hex").toString("base64"),
    verifier_kind: "ed25519" as const,
  };
}

function provenance(rule: string) {
  return [{ kind: "default" as const, rule }];
}
