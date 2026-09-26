/**
 * tests/harness/permission/substitution-divergence.test.ts
 *
 * Stage 1's own divergence gate (`specs/substitution-hard-walls.md` SC14,
 * revised). Two decisions that are not visible from the code:
 *
 * WHY A SECOND GATE INSTEAD OF WIDENING STAGE 0's: SC15 forbids editing
 * `tests/harness/permission/shadow-divergence.test.ts`, and Stage 0's
 * classification rule already labels every legacy `command-substitution` row
 * sitting on a real substitution node EXPECTED — so "zero UNEXPECTED" is
 * pre-satisfied for this family and cannot falsify anything Stage 1 did. What
 * can go red here is the review artifact: every emitted row must be on
 * `substitution.review.jsonl` carrying the two verdicts the report actually
 * measured, and every citation must resolve to a flip site this stage changed
 * or to a numbered clause of ADR-0125.
 *
 * WHY CITATIONS ARE ENUMERATED RATHER THAN PREFIX-MATCHED: the check this
 * criterion used to carry was `grep -cvE '^(SC4:|ADR-0125 §[0-9])'`, which
 * admitted the fabricated `SC4:src/harness/bogus.ts:1-9999` and
 * `ADR-0125 §99-not-a-clause`. The `§[1-7]` bound is honest rather than
 * convenient: `docs/adr/0125-substitution-policy.md` numbers exactly seven
 * Decision clauses, so `§8` is not a clause that exists.
 */

import { spawn } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  dualRunCommand,
  formatReportRow,
  loadCorpus,
  runDualPass,
} from "../../../scripts/shell-parse-divergence.ts";

type RawRecord = Record<string, unknown>;

interface LedgerEntry {
  readonly command: string;
  readonly old: string;
  readonly new: string;
  readonly citation: string;
}

/** One report row as the gate reads it: the four emitted columns. */
interface GateRow {
  readonly command: string;
  readonly oldVerdict: string;
  readonly verdictTag: string;
  readonly classTag: string;
}

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const scriptPath = join(repoRoot, "scripts", "shell-parse-divergence.ts");
const corpusFile = join(
  repoRoot,
  "tests",
  "fixtures",
  "shell-corpus",
  "substitution.jsonl"
);
const ledgerFile = join(here, "substitution.review.jsonl");

/** SC4's six flip sites — the whole admitted `SC4:` set, basename plus range. */
const SC4_FLIP_SITES: readonly string[] = [
  "SC4:permission.test.ts:188-190",
  "SC4:permission.test.ts:331-335",
  "SC4:permission.test.ts:379",
  "SC4:permission.test.ts:615-621",
  "SC4:role-substitution-boundaries.test.ts:216-233",
  "SC4:bare-metachar-hard-wall.test.ts:119-126",
];

/** SC14's record schema, sorted: these four keys, every value a string. */
const RECORD_FIELDS: readonly string[] = ["citation", "command", "new", "old"];

/** SC14's coverage floor: this many records, and every flip site cited. */
const MIN_RECORDS = 6;

// --------------------------------------------------------------------------
// helpers
// --------------------------------------------------------------------------

/** The parse-verdict tag out of a `verdict=<tag> …` column value. */
function verdictTagOf(newVerdict: string): string {
  const body = newVerdict.startsWith("verdict=")
    ? newVerdict.slice("verdict=".length)
    : newVerdict;
  return body.split(/[\s,;]+/)[0] ?? body;
}

/** Item (iv)'s decoding: the two-character escapes back to raw characters. */
function decodeReportField(field: string): string {
  return field.replace(/\\(.)/g, (_match, char: string) =>
    char === "n"
      ? "\n"
      : char === "r"
        ? "\r"
        : char === "t"
          ? "\t"
          : char === "\\"
            ? "\\"
            : `\\${char}`
  );
}

/** The four TAB columns, class last — anything else is a broken report. */
function stdoutRows(reportStdout: string): GateRow[] {
  return reportStdout
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const fields = line.split("\t");
      expect(fields.length, `row is not four tab fields: ${line}`).toBe(4);
      return {
        command: decodeReportField(fields[0]),
        oldVerdict: fields[1],
        verdictTag: verdictTagOf(fields[2]),
        classTag: fields[3],
      };
    });
}

/** The same row read in process, via the report's own encoder. */
function dualRowToGateRow(row: ReturnType<typeof dualRunCommand>): GateRow {
  return stdoutRows(formatReportRow(row))[0];
}

/**
 * Read the ledger. The `JSON.parse` status is inspected where a status can be
 * seen: the failure propagates out of the read instead of being filtered into
 * a value the caller never counts, so a truncated record fails the run rather
 * than shrinking the record count.
 */
function readLedger(file: string): RawRecord[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line, index) => {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        throw new Error(
          `ledger holds a record JSON.parse rejects (record ${index + 1})`
        );
      }
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`ledger record ${index + 1} is not a JSON object`);
      }
      return value as RawRecord;
    });
}

function fieldSetDescription(record: RawRecord): string {
  const keys = Object.keys(record).sort();
  const types = RECORD_FIELDS.every(
    (field) => typeof record[field] === "string"
  )
    ? "all-string"
    : "non-string";
  return `BAD keys=[${keys.join(",")}] types=${types}`;
}

function ledgerEntry(record: RawRecord): LedgerEntry | null {
  const keys = Object.keys(record).sort();
  const shapeOk =
    keys.length === RECORD_FIELDS.length &&
    RECORD_FIELDS.every((field) => keys.includes(field)) &&
    RECORD_FIELDS.every((field) => typeof record[field] === "string");
  if (!shapeOk) {
    return null;
  }
  return {
    command: record.command as string,
    old: record.old as string,
    new: record.new as string,
    citation: record.citation as string,
  };
}

/** Requirement (b)'s two admitted routes, both exact, neither a prefix. */
function isAdmittedCitation(citation: string): boolean {
  return (
    SC4_FLIP_SITES.includes(citation) || /^ADR-0125 §[1-7]$/.test(citation)
  );
}

function shorten(command: string): string {
  return JSON.stringify(command).slice(0, 60);
}

/**
 * SC14's shell block as a function, so every branch has a falsifier below.
 * Each violation names what it rejected, because the version this replaces
 * failed by printing a count that nobody read.
 */
function gateViolations(
  rows: readonly GateRow[],
  records: readonly RawRecord[]
): string[] {
  const violations: string[] = [];
  const entries: LedgerEntry[] = [];

  records.forEach((record, index) => {
    const entry = ledgerEntry(record);
    if (entry === null) {
      violations.push(
        `ledger holds a record outside the four string fields: ${fieldSetDescription(record)} (record ${index + 1})`
      );
      return;
    }
    entries.push(entry);
    if (!isAdmittedCitation(entry.citation)) {
      violations.push(`unadmitted citation: ${entry.citation}`);
    }
  });

  if (entries.length < MIN_RECORDS) {
    violations.push(
      `ledger holds ${entries.length} records, floor is ${MIN_RECORDS}`
    );
  }
  for (const site of SC4_FLIP_SITES) {
    if (!entries.some((entry) => entry.citation === site)) {
      violations.push(`no ledger row cites ${site}`);
    }
  }

  for (const row of rows) {
    const matches = entries.filter((entry) => entry.command === row.command);
    if (matches.length === 0) {
      violations.push(
        `report row has no ledger entry: ${shorten(row.command)}`
      );
      continue;
    }
    if (
      !matches.some(
        (entry) => entry.old === row.oldVerdict && entry.new === row.verdictTag
      )
    ) {
      violations.push(
        `ledger row for ${shorten(row.command)} disagrees with the report: old=${row.oldVerdict} new=${row.verdictTag}`
      );
    }
  }
  return violations;
}

/** Resolve the pinned tsx entry point the way tests/cli does. */
function resolveTsxCli(): string {
  let dir = here;
  for (;;) {
    const candidate = join(dir, "node_modules", "tsx", "dist", "cli.mjs");
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // keep walking up
    }
    const parent = join(dir, "..");
    if (parent === dir) throw new Error("cannot locate tsx/dist/cli.mjs");
    dir = parent;
  }
}

interface ScriptRun {
  readonly code: number | null;
  readonly out: string;
  readonly err: string;
}

/** SC14's binary is a command form, so the real CLI is what gets read. */
function runScript(args: string[]): Promise<ScriptRun> {
  const child = spawn(
    process.execPath,
    [resolveTsxCli(), scriptPath, ...args],
    {
      cwd: repoRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  let out = "";
  let err = "";
  child.stdout.on("data", (chunk) => (out += String(chunk)));
  child.stderr.on("data", (chunk) => (err += String(chunk)));
  return new Promise((resolve) => {
    child.on("close", (code) => resolve({ code, out, err }));
    child.on("error", (error) =>
      resolve({ code: null, out, err: `${err}${String(error)}` })
    );
  });
}

// --------------------------------------------------------------------------
// the real report run, taken once
// --------------------------------------------------------------------------

let scratch: string;
let report: ScriptRun;
let cliRows: GateRow[];

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), "iknow-substitution-divergence-"));
  report = await runScript(["--corpus", corpusFile]);
  cliRows = stdoutRows(report.out);
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function corpusCommands(): string[] {
  return loadCorpus(corpusFile);
}

function inProcessRows(): GateRow[] {
  return runDualPass(corpusCommands()).rows.map(dualRowToGateRow);
}

function committedLedger(): RawRecord[] {
  return readLedger(ledgerFile);
}

// ==========================================================================
// 1. the report runs over this family's own corpus
// ==========================================================================

describe("SC14: the report emits rows for this family", () => {
  it("`npx tsx scripts/shell-parse-divergence.ts --corpus …substitution.jsonl` exits 0, one row per record, zero UNEXPECTED", () => {
    expect(report.code, `exit ${report.code}; stderr: ${report.err}`).toBe(0);
    expect(cliRows.length).toBe(corpusCommands().length);
    expect(
      cliRows
        .filter((row) => row.classTag === "UNEXPECTED")
        .map((row) => row.command),
      "UNEXPECTED rows gate the next stage"
    ).toEqual([]);
  });

  it("the corpus is not curated down to agreement rows", () => {
    expect(
      cliRows.filter((row) => row.oldVerdict !== "null").length,
      "a family gate whose rows all agree measures nothing"
    ).toBeGreaterThan(0);
    for (const tag of ["expected-a", "expected-b", "not-yet-migrated"]) {
      expect(
        cliRows.some((row) => row.classTag === tag),
        `no row carries class tag ${tag}`
      ).toBe(true);
    }
  });

  it("the in-process dual run and the emitted report are the same rows", () => {
    expect(inProcessRows()).toEqual(cliRows);
    for (const command of corpusCommands().slice(0, 3)) {
      expect(report.out.split("\n")).toContain(
        formatReportRow(dualRunCommand(command))
      );
    }
  });

  it("the corpus holds the shape only JSON Lines can carry: an embedded-newline heredoc", () => {
    const decodedHeredocs = corpusCommands().filter((command) =>
      command.includes("\n")
    );
    expect(
      decodedHeredocs.length,
      "no heredoc record, so the single-key format has no justification"
    ).toBeGreaterThanOrEqual(1);
    expect(
      cliRows
        .filter((row) => row.command.includes("\n"))
        .map((row) => row.command)
        .sort()
    ).toEqual(decodedHeredocs.slice().sort());
  });
});

// ==========================================================================
// 2. SC14 requirement (a) — rows to ledger, compared decoded
// ==========================================================================

describe("SC14(a): every emitted row is on the ledger", () => {
  it("the committed ledger covers the report, read both ways", () => {
    expect(gateViolations(cliRows, committedLedger())).toEqual([]);
    expect(gateViolations(inProcessRows(), committedLedger())).toEqual([]);
  });

  it("(a) compares decoded strings: a `\\n` escape and a real newline are one command", () => {
    const entries = committedLedger().map((record) => ledgerEntry(record));
    const heredocRows = cliRows.filter((row) => row.command.includes("\n"));
    expect(heredocRows.length).toBeGreaterThanOrEqual(1);
    for (const row of heredocRows) {
      expect(
        entries.some((entry) => entry?.command === row.command),
        shorten(row.command)
      ).toBe(true);
    }
    // The raw ledger line escapes that newline, which is why a raw-bytes
    // reading of (a) could never have matched a heredoc row at all.
    expect(readFileSync(ledgerFile, "utf8")).toContain("\\n");
  });

  it("(a) falsifier: a family row whose ledger entry is deleted fails the run", () => {
    const orphan = cliRows[0];
    const without = committedLedger().filter(
      (record) => ledgerEntry(record)?.command !== orphan.command
    );
    const violations = gateViolations(cliRows, without);
    expect(violations.join("\n")).toContain(
      `report row has no ledger entry: ${shorten(orphan.command)}`
    );
  });
});

// ==========================================================================
// 3. SC14 requirement (b) — citations admitted by enumeration
// ==========================================================================

describe("SC14(b): citations are enumerated, not prefix-matched", () => {
  it("every committed citation resolves to a flip site or to ADR-0125 §1-§7", () => {
    const citations = committedLedger().map(
      (record) => ledgerEntry(record)?.citation
    );
    expect(citations.length).toBeGreaterThanOrEqual(MIN_RECORDS);
    for (const citation of citations) {
      expect(isAdmittedCitation(citation as string), String(citation)).toBe(
        true
      );
    }
  });

  it("both ends of the clause route exist; one clause past the end does not", () => {
    expect(isAdmittedCitation("ADR-0125 §1")).toBe(true);
    expect(isAdmittedCitation("ADR-0125 §7")).toBe(true);
    expect(isAdmittedCitation("ADR-0125 §8")).toBe(false);
    expect(isAdmittedCitation("ADR-0125 §99-not-a-clause")).toBe(false);
    expect(isAdmittedCitation("ADR-0125 §")).toBe(false);
    expect(isAdmittedCitation("SC4:permission.test.ts:188")).toBe(false);
  });

  it("(b) falsifier: a fabricated SC4 site is rejected in both placements", () => {
    const bogus = "SC4:src/harness/bogus.ts:1-9999";
    const records = committedLedger();
    const soleSite = "SC4:permission.test.ts:379";

    // Placement 1: the only record carrying one required site is re-pointed at
    // the fabrication, so the citation route and the site roster both go red.
    const swapped = records.map((record) =>
      ledgerEntry(record)?.citation === soleSite
        ? { ...record, citation: bogus }
        : record
    );
    const swappedViolations = gateViolations(cliRows, swapped);
    expect(swappedViolations).toContain(`unadmitted citation: ${bogus}`);
    expect(swappedViolations.join("\n")).toContain(
      `no ledger row cites ${soleSite}`
    );

    // The direction the old prefix check let through: extra garbage on top of
    // a ledger that is otherwise complete.
    const extra = [
      ...records,
      { command: "echo hi", old: "null", new: "ok", citation: bogus },
    ];
    expect(gateViolations(cliRows, extra)).toContain(
      `unadmitted citation: ${bogus}`
    );
  });

  it("(b) falsifier: a citation outside both routes names the value", () => {
    const records = committedLedger().map((record, index) =>
      index === 0 ? { ...record, citation: "gut-feeling" } : record
    );
    expect(gateViolations(cliRows, records)).toContain(
      "unadmitted citation: gut-feeling"
    );
  });
});

// ==========================================================================
// 4. SC14 requirement (c) — field set, floors, corrupt record
// ==========================================================================

describe("SC14(c): the ledger's schema and floors", () => {
  it("every committed record holds exactly the four string fields", () => {
    for (const record of committedLedger()) {
      expect(Object.keys(record).sort()).toEqual([...RECORD_FIELDS]);
      expect(ledgerEntry(record), JSON.stringify(record)).not.toBeNull();
    }
  });

  it("(c) falsifier: a fifth key, a missing key and a non-string value each fail the field set", () => {
    const records = committedLedger();
    const mutated: RawRecord[] = [
      { ...records[0], note: "gut feeling" },
      { command: records[1].command, new: "ok", old: "command-substitution" },
      { ...records[2], old: 3 },
    ];
    const violations = gateViolations(cliRows, mutated).filter((line) =>
      line.startsWith("ledger holds a record outside the four string fields")
    );
    expect(violations.length).toBe(3);
    expect(violations.join("\n")).toContain(
      "BAD keys=[citation,command,new,note,old]"
    );
    expect(violations.join("\n")).toContain("BAD keys=[command,new,old]");
    expect(violations.join("\n")).toContain("types=non-string");
  });

  it("(c) falsifier: an empty ledger fails the run instead of passing vacuously", () => {
    const violations = gateViolations(cliRows, []);
    expect(violations).toContain(
      `ledger holds 0 records, floor is ${MIN_RECORDS}`
    );
    for (const site of SC4_FLIP_SITES) {
      expect(violations).toContain(`no ledger row cites ${site}`);
    }
    expect(gateViolations(cliRows, [{}]).join("\n")).toContain(
      "ledger holds a record outside the four string fields"
    );
  });

  it("(c) falsifier: deleting one flip site's record is caught site by site", () => {
    const site = "SC4:role-substitution-boundaries.test.ts:216-233";
    const without = committedLedger().filter(
      (record) => ledgerEntry(record)?.citation !== site
    );
    expect(without.length).toBeLessThan(committedLedger().length);
    expect(gateViolations(cliRows, without)).toContain(
      `no ledger row cites ${site}`
    );
  });

  it("(c) a corrupt record fails the read wherever it sits in the file", () => {
    const good = readFileSync(ledgerFile, "utf8");
    const corrupt = '{"command":"x"';
    for (const [label, text] of [
      ["tail", `${good}${corrupt}\n`],
      ["head", `${corrupt}\n${good}`],
    ]) {
      const file = join(scratch, `ledger-${label}.jsonl`);
      writeFileSync(file, text);
      expect(() => readLedger(file), label).toThrow(
        /ledger holds a record JSON\.parse rejects/
      );
    }
  });

  it("the ledger's old/new columns are the verdicts the report measured", () => {
    const entries = committedLedger().map((record) => ledgerEntry(record));
    for (const row of cliRows) {
      expect(
        entries.some(
          (entry) =>
            entry?.command === row.command &&
            entry?.old === row.oldVerdict &&
            entry?.new === row.verdictTag
        ),
        shorten(row.command)
      ).toBe(true);
    }
    const records = committedLedger();
    const wrongOld = [
      { ...records[0], old: "gut-feeling" },
      ...records.slice(1),
    ];
    expect(gateViolations(cliRows, wrongOld).join("\n")).toContain(
      "disagrees with the report"
    );
  });
});
