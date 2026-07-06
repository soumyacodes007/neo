#!/usr/bin/env node
import * as esbuild from "esbuild";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const entry = path.join(root, "packages", "wallet-bridge", "browser", "companion.ts");
const outfile = path.join(root, "packages", "wallet-bridge", "dist", "client", "companion.js");

await fs.mkdir(path.dirname(outfile), { recursive: true });

await esbuild.build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  sourcemap: true,
  legalComments: "none",
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
});

const bundle = await fs.readFile(outfile, "utf8");
if (bundle.includes("https://esm.sh") || bundle.includes("https://cdn.")) {
  throw new Error("wallet bridge companion bundle contains a CDN reference");
}

console.log(`Built ${path.relative(root, outfile)}`);
