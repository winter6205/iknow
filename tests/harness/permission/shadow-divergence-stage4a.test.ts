/**
 * tests/harness/permission/shadow-divergence-stage4a.test.ts
 *
 * SC-S4-7 replay gate (Stage 4a, plan row T26). Replays the COMMITTED
 * fixture `tests/fixtures/shell-divergence/stage4a-shadow.jsonl` — produced
 * once by `scripts/stage4a-shadow-divergence.ts` — and asserts the two
 * binaries over the four Stage-4 decision inputs:
 *
 *   (1) `open=0`: no row carries the `open` label, and every
 *       `expected-relaxation` row carries a warrant from the closed
 *       admitted set (a prose appeal scores as `open`);
 *   (2) `deny→silence without warrant = 0`: no row where a pre-4a deny,
 *       refusal, or ledger record went silent post-4a lacks a named warrant.
 *
 * It also re-derives the POST column from the current tree for every row, so
 * the fixture cannot drift from the code it describes. The PRE column is
 * frozen evidence: this test never re-materializes git — the script owns
 * generation, the test owns assertion.
 *
 * Import strategy follows `shadow-divergence.test.ts`: the script module is
 * imported directly (`allowImportingTsExtensions`, tsconfig.test.json:9),
 * which also guarantees the rule set, the warrant vocabulary, and the
 * value/silence predicates asserted here are the generator's own, not a copy
 * (`readonlyValue` and `isDenyToSilence` are exported from the script for
 * exactly this reason).
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  admittedWarrants,
  isDenyToSilence,
  readonlyValue,
  RULE_SET,
  type ShadowRow,
} from "../../../scripts/stage4a-shadow-divergence.ts";
import { extractSingleReadPath } from "../../../src/harness/aci/tools/bash-read-extract.js";
import { validateReadonlyCommand } from "../../../src/harness/aci/tools/bash-readonly.js";
import { detectBashGrepSubstitution } from "../../../src/harness/aci/tools/role-substitution.js";
import { compileDeclarativePermissions } from "../../../src/harness/permission/declarative.js";

const FIXTURE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "fixtures",
  "shell-divergence",
  "stage4a-shadow.jsonl"
);

function rows(): ShadowRow[] {
  return readFileSync(FIXTURE, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as ShadowRow);
}

const postRuleMatchers = (() => {
  const rules = compileDeclarativePermissions(
    { deny: [...RULE_SET.deny] },
    { workRoot: "/w", home: "/stage4a-shadow-anchor", onWarn: () => undefined }
  );
  return (command: string): boolean[] =>
    rules.map((rule) => rule.match({ tool: "bash", input: { command } }));
})();

function postValue(row: ShadowRow): string | boolean | null {
  switch (row.output) {
    case "readonly":
      return readonlyValue(validateReadonlyCommand, row.command);
    case "readpath":
      return extractSingleReadPath(row.command) ?? null;
    case "grep":
      return detectBashGrepSubstitution(row.command) ?? null;
    case "declarative": {
      const index = RULE_SET.deny.indexOf(row.rule as string);
      expect(index, `unknown rule specifier ${row.rule}`).toBeGreaterThanOrEqual(0);
      return postRuleMatchers(row.command)[index] as boolean;
    }
  }
}

const ADMITTED = admittedWarrants();

describe("SC-S4-7 stage4a shadow divergence replay", () => {
  const fixture = rows();

  it("certifies exactly the warrant families the amended SC-S4-7 admits", () => {
    // specs/hard-wall-ast-migration.md SC-S4-7 admits (post Stage 4a
    // review, H4/M2 reconciliation): the three SC-S2-6 relaxation
    // classes, the six non-`ok` declarations (`unknown-syntax` /
    // `malformed` / `aborted` / `over-cap` / `parser-unavailable` /
    // `vetoed`), the ADR-0117 role-substitution `unknown-syntax` warrant,
    // the Stage-0 unmodellable label, and the SC-S4-1 single-command-node
    // re-home ledger warrant — 12 strings, none added without a spec
    // amendment. Counted off the imported set, never a copied listing.
    expect(ADMITTED.size).toBe(12);
  });

  it("carries the full row set over the four decision inputs", () => {
    const outputs = new Set(fixture.map((row) => row.output));
    expect([...outputs].sort()).toEqual([
      "declarative",
      "grep",
      "readonly",
      "readpath",
    ]);
    const commands = new Set(fixture.map((row) => row.command));
    // 421 stage2 column + 87 pinned lists + ~100 adversarial, deduped.
    expect(commands.size).toBeGreaterThanOrEqual(600);
    const rules = new Set(
      fixture.filter((r) => r.output === "declarative").map((r) => r.rule)
    );
    expect([...rules].sort()).toEqual([...RULE_SET.deny].sort());
    // one row per (command, output, rule) — readonly/readpath/grep once per
    // command, declarative once per command and rule.
    expect(fixture.length).toBe(
      commands.size * 3 + commands.size * RULE_SET.deny.length
    );
  });

  it("pins the non-ok census rows into the population", () => {
    const commands = new Set(fixture.map((row) => row.command));
    for (const censusRow of [
      "[[ a == b ]]",
      "echo hi &&",
      "powershell -c Remove-Item -Recurse -Force C:\\",
      "echo\\ test",
    ]) {
      expect(commands.has(censusRow), `census row ${censusRow}`).toBe(true);
    }
  });

  it("binary 1: zero rows are tagged open (directly or by an unadmitted warrant)", () => {
    for (const row of fixture) {
      expect(["same", "expected-relaxation", "fixed", "open"]).toContain(
        row.label
      );
      const openLike =
        row.label === "open" ||
        (row.label === "expected-relaxation" &&
          !(row.warrant !== undefined && ADMITTED.has(row.warrant)));
      expect(openLike, `open row: ${JSON.stringify(row)}`).toBe(false);
    }
    expect(fixture.filter((r) => r.label === "open").length).toBe(0);
  });

  it("binary 2: zero deny-to-silence rows without a named warrant", () => {
    const offenders = fixture.filter(
      (row) =>
        isDenyToSilence(row) &&
        !(
          row.label === "expected-relaxation" &&
          row.warrant !== undefined &&
          ADMITTED.has(row.warrant)
        )
    );
    expect(offenders.map((row) => JSON.stringify(row))).toEqual([]);
  });

  it("every differing row keeps its recorded tag direction", () => {
    for (const row of fixture) {
      const differs = JSON.stringify(row.pre) !== JSON.stringify(row.post);
      if (!differs) {
        expect(row.label, `same-value row must be labeled same: ${JSON.stringify(row)}`).toBe(
          "same"
        );
      } else {
        expect(row.label).not.toBe("same");
      }
    }
  });

  it("replays the POST column against the current tree, row by row", () => {
    const mismatches: string[] = [];
    for (const row of fixture) {
      const fresh = postValue(row);
      if (JSON.stringify(fresh) !== JSON.stringify(row.post)) {
        mismatches.push(
          `${row.output}${row.rule ? `(${row.rule})` : ""} ${JSON.stringify(row.command)}: stored ${JSON.stringify(row.post)} vs live ${JSON.stringify(fresh)}`
        );
      }
    }
    expect(mismatches.slice(0, 10), mismatches.join("\n")).toEqual([]);
  });
});
