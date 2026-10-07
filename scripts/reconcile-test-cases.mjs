#!/usr/bin/env node
// Reconciliation guard: count test-case declarations (it / test / describe)
// per changed test file, at HEAD and in the working tree. Any decrease means
// a case was deleted or turned into a skip while fixing types — the exact
// failure mode the TS6133 cleanup risked (agent #4 proved an unread binding
// can wrap a load-bearing side-effecting call).
//
// Usage: node scripts/reconcile-test-cases.mjs [--base HEAD]

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const baseIdx = process.argv.indexOf("--base");
const base = baseIdx === -1 ? "HEAD" : process.argv[baseIdx + 1];

function sh(cmd) {
  return execFileSync("sh", ["-c", cmd], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

const PATTERN = /(^|[^.\w])(it|test|describe)(\.\w+)?\s*(?:\.\s*)?\(/g;

// Strip comments before counting: prose like "assembly always fills it
// (buildWorkerToolSurface ...)" matches the bare `it (` pattern and would
// otherwise read as a spurious case-count change. Not a parser — a heuristic
// that only has to be good enough not to lie about deletions.
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function countDecls(text) {
  let n = 0;
  for (const _m of stripComments(text).matchAll(PATTERN)) n++;
  return n;
}

const changed = sh(
  `git diff --name-only --diff-filter=ACMR ${base} HEAD -- 'tests/**/*.ts' 'tests/**/*.tsx'`
)
  .split("\n")
  .filter(Boolean);

let mismatches = 0;
let checked = 0;
const rows = [];

for (const file of changed) {
  let headText;
  try {
    headText = sh(`git show ${base}:${JSON.stringify(file)}`);
  } catch {
    continue; // new file — nothing to compare against
  }
  let workText;
  try {
    workText = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  const before = countDecls(headText);
  const after = countDecls(workText);
  checked++;
  if (before !== after) {
    mismatches++;
    rows.push(
      `  ${file}: ${before} → ${after}  (${after - before >= 0 ? "+" : ""}${after - before})`
    );
  }
}

console.log(`base: ${base}`);
console.log(`changed test files: ${changed.length}, comparable: ${checked}`);
if (mismatches === 0) {
  console.log("OK — no test-case declaration count changed in any file.");
} else {
  console.log(`MISMATCH in ${mismatches} file(s):`);
  rows.forEach((r) => console.log(r));
  process.exitCode = 1;
}
