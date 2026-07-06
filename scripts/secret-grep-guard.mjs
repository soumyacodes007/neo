#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const ignoredDirs = new Set([
  ".git",
  ".claude",
  "coverage",
  "dist",
  "node_modules",
  "rust/target",
  "stellar-contracts",
  "graphify-out",
]);
const secretPatterns = [
  { name: "stellar-secret-seed", re: /\bS[A-Z2-7]{55}\b/g },
  { name: "generic-private-key", re: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/g },
  { name: "openai-api-key", re: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
];
const findings = [];

for (const file of walk(root)) {
  const rel = slash(path.relative(root, file));
  if (isIgnored(rel)) continue;
  const text = fs.readFileSync(file, "utf8");
  for (const pattern of secretPatterns) {
    for (const match of text.matchAll(pattern.re)) {
      findings.push(`${rel}: ${pattern.name} at byte ${match.index ?? 0}`);
    }
  }
}

if (findings.length > 0) {
  console.error("Secret grep guard failed:");
  for (const finding of findings) console.error(`- ${finding}`);
  process.exit(1);
}

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    const rel = slash(path.relative(root, file));
    if (entry.isDirectory()) {
      if (!isIgnored(rel)) yield* walk(file);
      continue;
    }
    if (entry.isFile() && isTextFile(entry.name)) yield file;
  }
}

function isIgnored(rel) {
  return [...ignoredDirs].some((dir) => rel === dir || rel.startsWith(`${dir}/`));
}

function isTextFile(name) {
  return /\.(?:cjs|js|json|md|mjs|rs|sh|toml|ts|tsx|yaml|yml)$/u.test(name) || name === ".gitignore";
}

function slash(value) {
  return value.replaceAll(path.sep, "/");
}
