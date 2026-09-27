#!/usr/bin/env npx tsx
/**
 * SC-S4-5 performance battery (Stage 4a, plan row T26). Binary tool, run with
 * `npx tsx scripts/stage4a-perf-battery.ts`; exit 0 iff both binaries hold:
 *
 *   (1) steady-state — over a fixed internal corpus of simple single-command
 *       bash tool-call strings (memo hits plus one-word fresh commands, any
 *       shape the parse classifies `aborted` / `over-cap` EXCLUDED and
 *       counted), the per-call overhead the permission check adds — the
 *       handler's readonly/dangerous pipeline
 *       (`isDangerousCommand` → `validateReadonlyCommand`, the exact pair
 *       `bash.ts` runs per call) minus the no-parse baseline
 *       (`legacyFindDangerousPattern`, the quote-blind text scan) — has a
 *       MEDIAN ≤ 5 ms. p95 and the excluded-row count are printed either way.
 *
 *   (2) first-parse init — in this cold process, the FIRST completed
 *       `parseForSecurity` (which carries the lazy tree-sitter binding load,
 *       hard-walls.ts → shell-parse.ts) returns within the Stage-0 200 ms
 *       sync bound. The timing starts before the first pipeline call and
 *       stops when it returns, so the assertion covers the whole
 *       first-turn check, not just the parse internals.
 *
 * Methodology pins:
 *   - Real production entries only: the imports below are the same modules
 *     `src/harness/aci/tools/bash.ts` wires, no test stubs, no injected
 *     loaders. Warm-up runs through this same path. Nothing here reads or
 *     writes `~/.iknow` or any settings/HOME surface — the four chosen
 *     entries are pure functions of their command string.
 *   - The memo (shell-parse.ts `MEMO_CAPACITY` = 64) is kept honest: the hot
 *     population is 32 commands re-walked every pass (memo hits by
 *     construction), and each pass adds exactly ONE never-seen one-word
 *     command, so fresh parses occupy the LRU tail and evict only each
 *     other, never the hot set.
 *   - Corpus candidates include shapes engineered to leave the `ok`
 *     population (over-cap by length); rows are excluded from timing AFTER
 *     the exclusion classification is measured, so `excluded_rows` is a real
 *     count, not a constant.
 */

import { isDangerousCommand } from "../src/harness/aci/permission.js";
import { validateReadonlyCommand } from "../src/harness/aci/tools/bash-readonly.js";
import { legacyFindDangerousPattern } from "../src/harness/permission/hard-walls.js";
import { parseForSecurity } from "../src/harness/permission/shell-parse.js";

/** SC-S4-5 binary 1: median per-call overhead, ms. */
const MEDIAN_BUDGET_MS = 5;
/** Stage-0 sync bound consumed (not re-decided) by SC-S4-5 binary 2. */
const FIRST_PARSE_BOUND_MS = 200;

const PASSES = 300;

/** Hot population: simple single-command bash tool-call strings, < 64 total
 * so every command stays a memo hit after the warm-up pass. */
const HOT: ReadonlyArray<string> = [
  "ls",
  "pwd",
  "echo hi",
  "cat notes.md",
  "head -n 5 notes.txt",
  "tail -n 20 log",
  "wc -l file.txt",
  "git status",
  "git log --oneline -5",
  "du -sh .",
  "find src -name x",
  "sort list.txt",
  "uniq",
  "diff a b",
  "file photo.png",
  "which node",
  "date",
  "uptime",
  "free -m",
  "id",
  "whoami",
  "history 5",
  "df -h",
  "hostname",
  "basename a/b",
  "dirname a/b",
  "tr a-z d",
  "cut -d, -f1 s",
  "tree -L 2",
  "stat file.txt",
  "lsof -i 4",
  "true",
];

/** Fresh one-word commands, one consumed per pass (never repeated). */
function freshCommand(pass: number): string {
  return `echo fresh${pass}`;
}

/** Candidates run through the exclusion classifier first; the two 64 KiB+
 * rows are over-cap by construction (shell-parse.ts CAP_BYTES = 65_536). */
const OVER_CAP_PROBE_A = "echo " + "x".repeat(66_000);
const OVER_CAP_PROBE_B = "cat " + "y".repeat(70_000);

type Exclusion = { kind: string; excluded: boolean };

function classify(cmd: string): Exclusion {
  const kind = parseForSecurity(cmd).kind;
  return { kind, excluded: kind === "aborted" || kind === "over-cap" };
}

function median(sorted: ReadonlyArray<number>): number {
  if (sorted.length === 0) return Number.NaN;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

function p95(sorted: ReadonlyArray<number>): number {
  if (sorted.length === 0) return Number.NaN;
  const idx = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return sorted[idx] as number;
}

/** The per-call permission check the bash handler runs in readonly mode. */
function pipeline(cmd: string): void {
  const dangerous = isDangerousCommand(cmd);
  if (dangerous) return;
  try {
    validateReadonlyCommand(cmd);
  } catch {
    // A ReadonlyViolationError is a normal measured outcome: the throw path
    // is part of the per-call overhead this battery prices.
  }
}

function timedPipeline(cmd: string): number {
  const t0 = performance.now();
  pipeline(cmd);
  return performance.now() - t0;
}

function timedBaseline(cmd: string): number {
  const t0 = performance.now();
  legacyFindDangerousPattern(cmd);
  return performance.now() - t0;
}

/** Warm both production entries once per candidate before any timing. */
function warmUp(): void {
  const candidates = [...HOT, freshCommand(-1)];
  for (const cmd of candidates) {
    pipeline(cmd);
    legacyFindDangerousPattern(cmd);
  }
}

/**
 * Exclusion census: every timed candidate first classifies. Aborted and
 * over-cap shapes are kept out of the timed population.
 */
function collectTimedPopulation(): {
  readonly timed: string[];
  readonly excludedRows: number;
} {
  const timed: string[] = [];
  let excludedRows = 0;
  const exclusionKinds = new Map<string, number>();
  for (const cmd of [...HOT, OVER_CAP_PROBE_A, OVER_CAP_PROBE_B]) {
    const verdict = classify(cmd);
    if (verdict.excluded) {
      excludedRows += 1;
      exclusionKinds.set(verdict.kind, (exclusionKinds.get(verdict.kind) ?? 0) + 1);
      continue;
    }
    timed.push(cmd);
  }
  return { timed, excludedRows };
}

/**
 * Steady-state per-call overhead. Fresh rows are one-word commands by
 * construction; they join only while they classify inside the set.
 */
function measureSteadyOverhead(timed: string[]): {
  readonly overheads: number[];
  readonly freshExcluded: number;
} {
  const overheads: number[] = [];
  let freshExcluded = 0;
  for (let pass = 0; pass < PASSES; pass += 1) {
    for (const cmd of timed) {
      const pipe = timedPipeline(cmd);
      const base = timedBaseline(cmd);
      overheads.push(pipe - base);
    }
    const fresh = freshCommand(pass);
    if (classify(fresh).excluded) {
      freshExcluded += 1;
      continue;
    }
    const pipe = timedPipeline(fresh);
    const base = timedBaseline(fresh);
    overheads.push(pipe - base);
  }
  overheads.sort((a, b) => a - b);
  return { overheads, freshExcluded };
}

function main(): number {
  // --- binary 2: first completed parse in this cold process ---------------
  // (run before any warm-up so the lazy binding load is inside the sample)
  const initMs = timedPipeline(HOT[0] as string);
  const initOk = initMs <= FIRST_PARSE_BOUND_MS;

  warmUp();
  const population = collectTimedPopulation();
  const steady = measureSteadyOverhead(population.timed);
  const excluded = population.excludedRows + steady.freshExcluded;

  const med = median(steady.overheads);
  const high = p95(steady.overheads);
  const steadyOk = med <= MEDIAN_BUDGET_MS;

  console.log(
    `steady-state: samples=${steady.overheads.length} ` +
      `median=${med.toFixed(4)} ms p95=${high.toFixed(4)} ms ` +
      `(budget median <= ${MEDIAN_BUDGET_MS} ms) -> ${steadyOk ? "PASS" : "FAIL"}`
  );
  console.log(`excluded_rows=${excluded} (aborted/over-cap shapes kept out of the population)`);
  console.log(
    `first-parse init: ${initMs.toFixed(2)} ms (bound ${FIRST_PARSE_BOUND_MS} ms) -> ${initOk ? "PASS" : "FAIL"}`
  );
  return steadyOk && initOk ? 0 : 1;
}

process.exit(main());
