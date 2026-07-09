import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withToolBoundary } from "../tool-boundary.js";
import type { McpToolContext } from "./types.js";

interface BlendFixture {
  network: string;
  tx_hash: string;
  tx_status: string;
  ledger: number;
  blend: {
    pool: string;
    reserve: string;
  };
  auth_digest_replay: {
    replay_result: string;
  };
  pipeline: {
    trace: {
      successful: boolean;
      meta_decode_status: string;
      auth_entries: number;
      operations: number;
      token_deltas: number;
    };
    evidence: {
      context_count: number;
      contexts: Array<{
        contract: string;
        fn_name: string;
        depth: string;
      }>;
    };
    ruleset: {
      rule_count: number;
      unsatisfied_count: number;
    };
  };
}

interface ExpectedFailureUse {
  accepted: boolean;
  expected_failure: boolean;
  final_status: string;
  transaction_hash: string;
}

interface XlmUseFixture {
  network: string;
  account: string;
  matching: {
    accepted: boolean;
    owner_passkey_used: boolean;
    transaction: {
      status: string;
      hash: string;
      ledger: number;
      fn: string;
    };
  };
  deny_cases: Record<string, ExpectedFailureUse>;
}

export function registerAssertActionTestnetFixturesTool(server: McpServer, _context: McpToolContext): void {
  server.registerTool(
    "ozpb_assert_action_testnet_fixtures",
    {
      title: "Assert action testnet fixtures",
      description: "Validates real testnet evidence for the two hardened transaction actions: Blend submit and XLM transfer.",
      inputSchema: {
        fixtures_dir: z.string().min(1).default("fixtures/testnet"),
      },
    },
    withToolBoundary("ozpb_assert_action_testnet_fixtures", async (input) => {
      const root = process.cwd();
      const dir = path.resolve(root, input.fixtures_dir);
      const blend = await readJson<BlendFixture>(path.join(dir, "sd4-real-blend-submit-tx.json"));
      const xlm = await readJson<XlmUseFixture>(path.join(dir, "phase8-strict-policy-use-result.json"));

      assertEq(blend.network, "testnet", "Blend network");
      assertEq(blend.tx_status, "SUCCESS", "Blend tx status");
      assertEq(blend.pipeline.trace.successful, true, "Blend trace successful");
      assertEq(blend.pipeline.trace.meta_decode_status, "decoded", "Blend meta decoded");
      assertEq(blend.auth_digest_replay.replay_result, "accepted_on_real_blend_testnet_submit", "Blend auth replay");
      assertEq(blend.pipeline.ruleset.unsatisfied_count, 0, "Blend ruleset unsatisfied count");
      const blendSubmit = findContext(blend.pipeline.evidence.contexts, blend.blend.pool, "submit", "root");
      const blendTransfer = findContext(blend.pipeline.evidence.contexts, blend.blend.reserve, "transfer", "sub");
      if (!blendSubmit || !blendTransfer) {
        throw new Error("Blend fixture must include root submit context and sub token transfer context");
      }

      assertEq(xlm.network, "testnet", "XLM network");
      assertEq(xlm.matching.accepted, true, "XLM matching transfer accepted");
      assertEq(xlm.matching.owner_passkey_used, false, "XLM session key path used");
      assertEq(xlm.matching.transaction.status, "SUCCESS", "XLM matching tx status");
      assertEq(xlm.matching.transaction.fn, "transfer", "XLM matching function");
      for (const name of ["amount_plus_one", "wrong_recipient", "wrong_function"]) {
        const deny = requireDenyCase(xlm.deny_cases, name);
        assertEq(deny.accepted, false, `${name} denied`);
        assertEq(deny.expected_failure, true, `${name} expected failure`);
        assertEq(deny.final_status, "FAILED", `${name} final status`);
      }

      return {
        ok: true,
        checked: [
          path.relative(root, path.join(dir, "sd4-real-blend-submit-tx.json")),
          path.relative(root, path.join(dir, "phase8-strict-policy-use-result.json")),
        ],
        blend: {
          tx_hash: blend.tx_hash,
          ledger: blend.ledger,
          pool: blend.blend.pool,
          reserve: blend.blend.reserve,
          contexts: blend.pipeline.evidence.contexts.map((ctx) => ({
            contract: ctx.contract,
            fn_name: ctx.fn_name,
            depth: ctx.depth,
          })),
        },
        xlm_transfer: {
          account: xlm.account,
          matching_tx_hash: xlm.matching.transaction.hash,
          matching_ledger: xlm.matching.transaction.ledger,
          owner_passkey_used: xlm.matching.owner_passkey_used,
          deny_tx_hashes: {
            amount_plus_one: requireDenyCase(xlm.deny_cases, "amount_plus_one").transaction_hash,
            wrong_recipient: requireDenyCase(xlm.deny_cases, "wrong_recipient").transaction_hash,
            wrong_function: requireDenyCase(xlm.deny_cases, "wrong_function").transaction_hash,
          },
        },
      };
    }),
  );
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await fs.readFile(file, "utf8")) as T;
}

function assertEq(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function findContext(
  contexts: readonly BlendFixture["pipeline"]["evidence"]["contexts"][number][],
  contract: string,
  fnName: string,
  depth: string,
): boolean {
  return contexts.some((ctx) => ctx.contract === contract && ctx.fn_name === fnName && ctx.depth === depth);
}

function requireDenyCase(denyCases: Record<string, ExpectedFailureUse>, name: string): ExpectedFailureUse {
  const deny = denyCases[name];
  if (!deny) {
    throw new Error(`missing deny case: ${name}`);
  }
  return deny;
}
