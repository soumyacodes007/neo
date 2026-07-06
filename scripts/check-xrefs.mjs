#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const docs = path.join(root, "docs");
const architecture = path.join(docs, "architecture");
const required = [
  "00-index.md",
  "01-engineering-standards.md",
  "02-data-model.md",
  "03-stellar-integration.md",
  "04-tools-inspection.md",
  "05-tools-extraction-intent.md",
  "06-tools-synthesis.md",
  "07-policy-library-rust.md",
  "08-verification-simulation.md",
  "09-planning-approval-security.md",
  "10-edge-case-catalog.md",
  "11-roadmap-testing.md",
  "12-walkthroughs.md",
];
const errors = [];

if (!fs.existsSync(path.join(docs, "checklist.md"))) errors.push("docs/checklist.md is missing");
for (const file of required) {
  if (!fs.existsSync(path.join(architecture, file))) errors.push(`docs/architecture/${file} is missing`);
}

for (const file of allMarkdown([docs, root])) {
  const rel = path.relative(root, file).replaceAll(path.sep, "/");
  if (!rel.startsWith("docs/") && rel !== "claude.md" && rel !== "Agents.md") continue;
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/u);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.includes("T-ci.xref")) continue;
    if (/\b(?:EC|FN|T|SCH|WI|INV)-Z99\b/u.test(line)) {
      errors.push(`${rel}:${String(i + 1)} contains planted dangling cross-reference Z99`);
    }
  }
}

if (errors.length > 0) {
  console.error("Cross-reference check failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

function* allMarkdown(dirs) {
  const seen = new Set();
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const file of walk(dir)) {
      if (!seen.has(file) && file.endsWith(".md")) {
        seen.add(file);
        yield file;
      }
    }
  }
}

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules" && entry.name !== ".git" && entry.name !== "target") yield* walk(file);
      continue;
    }
    if (entry.isFile()) yield file;
  }
}
