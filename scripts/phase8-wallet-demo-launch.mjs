#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const logDir = path.join(root, ".tmp", "phase8-passkey-live");
fs.mkdirSync(logDir, { recursive: true });

const outPath = path.join(logDir, "out.log");
const errPath = path.join(logDir, "err.log");
const metaPath = path.join(logDir, "meta.json");
const out = fs.openSync(outPath, "w");
const err = fs.openSync(errPath, "w");

const child = spawn(process.execPath, [path.join(root, "scripts", "phase8-wallet-demo.mjs")], {
  cwd: root,
  detached: true,
  stdio: ["ignore", out, err],
  windowsHide: true,
  env: {
    ...process.env,
    PHASE8_DEMO_TIMEOUT_MS: process.env.PHASE8_DEMO_TIMEOUT_MS ?? "600000",
    OPEN_BROWSER: process.env.OPEN_BROWSER ?? "false",
  },
});

fs.writeFileSync(metaPath, JSON.stringify({
  pid: child.pid,
  stdout: outPath,
  stderr: errPath,
  started_at: new Date().toISOString(),
}, null, 2));

child.unref();
console.log(JSON.stringify({ pid: child.pid, stdout: outPath, stderr: errPath, meta: metaPath }, null, 2));
