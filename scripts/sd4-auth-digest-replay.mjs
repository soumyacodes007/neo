#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const phase5Path = path.join(root, "fixtures", "testnet", "phase5-auth-tx.json");
const outPath = path.join(root, "fixtures", "testnet", "sd4-auth-digest-replay.json");

execFileSync(process.execPath, [path.join(root, "scripts", "phase5-auth-tx-e2e.mjs")], {
  cwd: root,
  stdio: "inherit",
  env: process.env,
});

const phase5 = JSON.parse(await fs.readFile(phase5Path, "utf8"));
if (phase5.tx_status !== "SUCCESS") {
  throw new Error(`phase5 auth tx was not successful: ${phase5.tx_status}`);
}
if (phase5.auth_digest_replay?.replay_result !== "accepted_on_testnet") {
  throw new Error("phase5 auth tx fixture does not contain accepted auth_digest_replay proof");
}

const out = {
  schema_version: "1",
  test_id: "T-ST.18-2",
  created_at: new Date().toISOString(),
  network: phase5.network,
  account: phase5.account,
  signer: phase5.signer,
  target: phase5.target,
  tx_hash: phase5.tx_hash,
  ledger: phase5.ledger,
  wasm_hashes: phase5.wasm_hashes,
  proof: {
    signature_payload_hex: phase5.auth_digest_replay.signature_payload_hex,
    context_rule_ids: phase5.auth_digest_replay.context_rule_ids,
    auth_digest_hex: phase5.auth_digest_replay.auth_digest_hex,
    signature_hex: phase5.auth_digest_replay.signature_hex,
    replay_result: "accepted_on_real_testnet_smart_account",
  },
  pipeline: phase5.pipeline,
};

await fs.writeFile(outPath, `${JSON.stringify(out, null, 2)}\n`);
console.log(JSON.stringify(out, null, 2));
