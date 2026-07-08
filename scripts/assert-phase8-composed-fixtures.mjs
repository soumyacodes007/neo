#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const installPath = path.join(root, "fixtures", "testnet", "phase8-composed-policy-install-result.json");
const usePath = path.join(root, "fixtures", "testnet", "phase8-composed-policy-use-result.json");
const expiredInstallPath = path.join(root, "fixtures", "testnet", "phase8-composed-expired-policy-install-result.json");
const expiredUsePath = path.join(root, "fixtures", "testnet", "phase8-composed-expired-policy-use-result.json");

const install = await readJson(installPath);
const use = await readJson(usePath);
const expiredInstall = await readJson(expiredInstallPath);
const expiredUse = await readJson(expiredUsePath);

assertEq(install.network, "testnet", "install network");
assertEq(install.readback.installed_rule.status, "active", "composed install active");
assertIncludes(
  install.readback.installed_rule.policies.map((p) => p.address),
  install.guarantees.recipient_policy === "pb:arg_guard"
    ? "CADIBF4HZOMPVC5STXKCUAMAPGGJYI5EXMWEESKBSRAWOCBLSA22IKMZ"
    : "",
  "arg_guard policy installed",
);
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

console.log(JSON.stringify({
  ok: true,
  checked: [
    path.relative(root, installPath),
    path.relative(root, usePath),
    path.relative(root, expiredInstallPath),
    path.relative(root, expiredUsePath),
  ],
  tx_hashes: {
    install: install.transaction.hash,
    matching: use.matching.transaction.hash,
    amount_plus_one: use.deny_cases.amount_plus_one.transaction_hash,
    wrong_recipient: use.deny_cases.wrong_recipient.transaction_hash,
    wrong_function: use.deny_cases.wrong_function.transaction_hash,
    expired_matching: expiredUse.matching.transaction_hash,
  },
}, null, 2));

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

function assertEq(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertIncludes(values, expected, label) {
  if (expected === "" || !values.includes(expected)) {
    throw new Error(`${label}: missing ${expected}`);
  }
}
