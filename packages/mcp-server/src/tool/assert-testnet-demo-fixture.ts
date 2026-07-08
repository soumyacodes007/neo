import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withToolBoundary } from "../tool-boundary.js";
import type { McpToolContext } from "./types.js";

interface InstallFixture {
  network: string;
  transaction: {
    hash: string;
  };
  readback: {
    installed_rule: {
      id: number;
      status: string;
    };
  };
}

interface SuccessfulMatchingUse {
  accepted: boolean;
  owner_passkey_used: boolean;
  transaction: {
    hash: string;
  };
}

interface ExpectedFailureUse {
  accepted: boolean;
  expected_failure: boolean;
  final_status: string;
  transaction_hash: string;
}

interface UseFixture {
  rule_id: number;
  matching: SuccessfulMatchingUse;
  deny_cases: Record<string, ExpectedFailureUse>;
}

interface ExpiredUseFixture {
  rule_id: number;
  matching: ExpectedFailureUse;
}

export function registerAssertTestnetDemoFixtureTool(server: McpServer, _context: McpToolContext): void {
  server.registerTool(
    "ozpb_assert_testnet_demo_fixture",
    {
      title: "Assert testnet demo fixture",
      description: "Validates the captured real testnet composed-policy install/use/deny/expired fixture set.",
      inputSchema: {
        fixtures_dir: z.string().min(1).default("fixtures/testnet"),
      },
    },
    withToolBoundary("ozpb_assert_testnet_demo_fixture", async (input) => {
      const root = process.cwd();
      const dir = path.resolve(root, input.fixtures_dir);
      const install = await readJson<InstallFixture>(path.join(dir, "phase8-composed-policy-install-result.json"));
      const use = await readJson<UseFixture>(path.join(dir, "phase8-composed-policy-use-result.json"));
      const expiredInstall = await readJson<InstallFixture>(
        path.join(dir, "phase8-composed-expired-policy-install-result.json"),
      );
      const expiredUse = await readJson<ExpiredUseFixture>(
        path.join(dir, "phase8-composed-expired-policy-use-result.json"),
      );
      assertEq(install.network, "testnet", "install network");
      assertEq(install.readback.installed_rule.status, "active", "composed install active");
      assertEq(use.rule_id, install.readback.installed_rule.id, "use rule id matches install");
      assertEq(use.matching.accepted, true, "matching transfer accepted");
      assertEq(use.matching.owner_passkey_used, false, "matching transfer did not use owner passkey");
      for (const [name, deny] of Object.entries(use.deny_cases)) {
        assertEq(deny.accepted, false, `${name} denied`);
        assertEq(deny.expected_failure, true, `${name} expected failure`);
        assertEq(deny.final_status, "FAILED", `${name} final status`);
      }
      assertEq(expiredUse.rule_id, expiredInstall.readback.installed_rule.id, "expired use rule id matches install");
      assertEq(expiredUse.matching.accepted, false, "expired matching transfer denied");
      assertEq(expiredUse.matching.expected_failure, true, "expired matching expected failure");
      assertEq(expiredUse.matching.final_status, "FAILED", "expired matching final status");
      const amountPlusOne = requireDenyCase(use.deny_cases, "amount_plus_one");
      const wrongRecipient = requireDenyCase(use.deny_cases, "wrong_recipient");
      const wrongFunction = requireDenyCase(use.deny_cases, "wrong_function");
      return {
        ok: true,
        checked: [
          path.relative(root, path.join(dir, "phase8-composed-policy-install-result.json")),
          path.relative(root, path.join(dir, "phase8-composed-policy-use-result.json")),
          path.relative(root, path.join(dir, "phase8-composed-expired-policy-install-result.json")),
          path.relative(root, path.join(dir, "phase8-composed-expired-policy-use-result.json")),
        ],
        tx_hashes: {
          install: install.transaction.hash,
          matching: use.matching.transaction.hash,
          amount_plus_one: amountPlusOne.transaction_hash,
          wrong_recipient: wrongRecipient.transaction_hash,
          wrong_function: wrongFunction.transaction_hash,
          expired_matching: expiredUse.matching.transaction_hash,
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

function requireDenyCase(denyCases: Record<string, ExpectedFailureUse>, name: string): ExpectedFailureUse {
  const deny = denyCases[name];
  if (!deny) {
    throw new Error(`missing deny case: ${name}`);
  }
  return deny;
}
