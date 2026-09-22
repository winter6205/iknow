/**
 * Structural lock: every case in the #1089 real-model boundary set has a
 * registered judge, and every registered judge belongs to a case. The judge
 * dispatcher is typed exhaustive (`Record<CaseId, CaseJudge>`), but
 * `real-llm/**` sits outside both tsconfig includes and vitest transpiles
 * without typechecking — the type alone never fires in the default pipeline,
 * so this offline source-text lock is what catches the drift. The module is
 * read, never imported: importing a real-LLM test file would register its
 * real-model harness suite in this run.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SOURCE = readFileSync(
  new URL(
    "../../../../real-llm/role-substitution-boundaries-real.test.ts",
    import.meta.url
  ),
  "utf8"
);

function block(begin: string, end: string): string {
  const start = SOURCE.indexOf(begin);
  expect(start, `registry source must contain ${begin}`).toBeGreaterThanOrEqual(
    0
  );
  const stop = SOURCE.indexOf(end, start);
  expect(stop, `registry source must close the ${begin} block`).toBeGreaterThan(
    start
  );
  return SOURCE.slice(start, stop);
}

function captures(pattern: RegExp, text: string): string[] {
  return [...text.matchAll(pattern)].map((m) => m[1]!);
}

// "\n]" closes the CASES array whether it ends `];` or `] as const;`.
const caseIds = captures(
  /^\s+id: "([^"]+)"/gm,
  block("const CASES = [", "\n]")
);
const judgeIds = captures(
  /^\s*"([^"]+)":\s*judge\w+,/gm,
  block("const CASE_JUDGES", "\n};")
);

describe("boundary-set judge registry is total", () => {
  it("collects a non-empty case roster from the source", () => {
    expect(caseIds.length).toBeGreaterThan(0);
  });

  it("registers exactly one judge per case id (no silent skip, no orphan)", () => {
    expect(new Set(judgeIds).size, "duplicate judge key").toBe(judgeIds.length);
    expect(judgeIds.sort()).toEqual([...caseIds].sort());
  });
});
