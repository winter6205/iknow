/**
 * tests/harness/permission/shadow-divergence.test.ts
 *
 * Stage 0 bullet T6 — "The offline dual-run corpus gate exists, and it is the
 * thing later stages switch on". This file is the CI face of the 离线影子对照
 * tooling: it grades `specs/shell-parse-foundation.md` **SC10** (deterministic,
 * secret-free corpus tool + decidable fixture format + admission predicate) and
 * **SC11** (zero UNEXPECTED divergences, plus the committed class-(e)
 * membership assertion round 9 demands of this file).
 *
 * ---------------------------------------------------------------------------
 * IMPORT STRATEGY (chosen, with the reason): direct import of the script.
 * ---------------------------------------------------------------------------
 * `tests/scripts/trace-migrate.test.ts:26` already imports a `scripts/` module
 * straight into vitest (`import { migrateTraceFile } from
 * "../../scripts/trace-migrate.ts"`), and `tsconfig.test.json:9` sets
 * `allowImportingTsExtensions`, so the `.ts` specifier resolves for both vitest
 * and `npm run typecheck:tests`. Spawning `npx tsx` per assertion would move
 * every failure behind a subprocess boundary and lose the compile-time check on
 * the contract below. The three `runScript()` cases in this file are NOT that
 * fallback: SC10 and the plan's T6 Acceptance state those three properties as
 * **command forms** (`npx tsx scripts/shell-parse-divergence.ts --corpus …`
 * exits 0 and prints one row per record), so they are graded by running the
 * real CLI, exactly as `tests/cli/cli-yolo-non-tui-reject.test.ts:29-87` does.
 *
 * ---------------------------------------------------------------------------
 * TOOL CONTRACT this file codes against (the script is landing in parallel).
 * ---------------------------------------------------------------------------
 * `scripts/shell-parse-divergence.ts` must export:
 *   dualRunCommand(command: string, expectations?): { command: string;
 *       oldVerdict: string | null;
 *       newVerdict: string; class: "EXPECTED" | "UNEXPECTED"; clause?: string }
 *       — one dual run: `oldVerdict` is `findDangerousPattern`'s answer (a
 *       DangerousPatternId or null — SC11 def. (i), NOT a wall verdict),
 *       `newVerdict` is the parse verdict plus payload facts, encoded per SC10
 *       as `verdict=<tag>` + facts (SC11 def. (ii)).
 *   classifyRow(row: { command; oldVerdict; newVerdict }, expectations?):
 *       { class; clause? }
 *       — the pure SC11 rule, total and binary, over the two columns only.
 *       `clause` is the spec's own machine-readable name for the EXPECTED
 *       branch: "a" | "b" | "c" | "d" | "e"; absent/undefined on an UNEXPECTED
 *       row. (a) inert text, (b) real substitution node (Stage 1's policy),
 *       (c) ask-parity `unknown-syntax` over a legacy-allow row, (d) hard-deny
 *       class (`malformed` / `over-cap` / `vetoed`) over a legacy-allow row,
 *       (e) `not-yet-migrated` (B1: requires an `ok` verdict; B2 precedence).
 *   formatReportRow(row): string — tooling item (iv)'s TSV: exactly four
 *       TAB-separated fields in the order command / old-verdict / new-verdict /
 *       class, `class` LAST, embedded newlines encoded as `\n` `\r` `\t`, one
 *       record = one physical line. The (e) tag literal is `not-yet-migrated`
 *       (SC11 B3's `awk -F'\t' '$4 == "not-yet-migrated"'`).
 *   checkCorpusLine(raw: string): string | null — SC10's single-line format
 *       gate; returns a violation message, or null when the line parses to an
 *       object with EXACTLY one key `command` holding a `string`.
 *   loadCorpus(dir: string): string[] — reads every file in the corpus dir,
 *       runs `checkCorpusLine` over every line (throwing / reporting on any
 *       violation rather than skipping), returns the DECODED command strings.
 *   redactionHits(decoded: string): string[] — the OQ1 admission roster
 *       (the 7 `DEFAULT_SECRET_PATTERNS` floor + exactly the four surviving
 *       extras: Bearer/Basic header literals, JWT three-segment shapes,
 *       `?token=`/`key=` query shapes, `…_TOKEN=…` assignment forms), matched
 *       against the DECODED value. Non-empty ⇒ the candidate is dropped whole.
 *   extractCommands(sessionDir: string): string[] — item (i)+(ii): the `command`
 *       field of `bash` tool_use blocks of `<id>/<id>.jsonl`, honoring
 *       `argumentsCaptured` on `<id>/trace.jsonl` by SKIPPING, never touching
 *       message bodies / other tools' argv / paths / env, dropping any
 *       candidate with a roster hit whole (never masked), in fixture order.
 *   runDualPass(commands: string[], expectations?): { rows; histogram } — the
 *       same pass over an ordered command list; `histogram` is the node-type
 *       inventory OQ3 closes on. The optional `expectations` map is the one
 *       label input `classifyRow`/`dualRunCommand`/`runDualPass` take.
 *
 * ---------------------------------------------------------------------------
 * #1188 SC7 — INDEPENDENT EXPECTATIONS (a sibling roster, never a corpus key)
 * ---------------------------------------------------------------------------
 * `specs/backslash-whitespace-veto-repair.md` SC7 demands that the report tell a
 * supported benign form that is wrongly vetoed apart from an intentionally
 * retained fidelity denial, on independent fixture labels. The corpus record
 * format is frozen at exactly one `command` key (SC10's decidable format, and
 * the format `--extract` emits), so the labels live in the SIBLING file
 * `backslash-whitespace-expectations.jsonl`: `command` + `expectation`
 * ("supported-benign" | "retained-fidelity") + a reviewer-facing `rationale`.
 * The tool finds that file next to the corpus it was given (a swept directory
 * or a single file's parent), skips it while sweeping a corpus directory, and
 * treats a MISSING file as the empty map — so an unlabeled corpus classifies
 * exactly as it did before the roster existed.
 *
 * `loadExpectations`/`checkExpectationLine` are the roster's own reader, and it
 * reads TEXT: no `parseForSecurity`, no exemption predicate, no `bash -n`. A
 * label is only ever the committed rationale-free text in the roster, so the
 * gate cannot ratify whatever production currently does. The `rationale` string
 * is documentation for reviewers and is never read by the classifier.
 *
 * The refinement is confined to the `vetoed` arm of a legacy-allow row: a
 * `supported-benign` row that production still vetoes is UNEXPECTED, and every
 * other combination (retained-fidelity + vetoed, any label + `ok`,
 * `unknown-syntax`, `malformed`, `over-cap`, no label at all) keeps its
 * pre-roster classification byte-for-byte.
 *

 * CI placement (noted, not asserted — this file must say nothing about config):
 * `vitest.config.ts:18` collects every file under `tests/` whose name ends in
 * `.test.ts`, and this path matches that shape; it appears in neither
 * `CI_EXCLUDES` nor `CI_FAST_EXCLUDES` (`vitest.ci-excludes.ts:52`, `:275`), so
 * `test:ci:fast` runs it — which is SC11's "enforced in CI by
 * `npx vitest run …` (exit 0)".
 *
 * TWO READINGS OF THE SPEC THIS FILE HAS TO STATE EXPLICITLY:
 *  1. The EXPECTED clauses are **five**, not four: round 7 added class (e)
 *     `not-yet-migrated` to SC11, and SC10's P1 arithmetic only closes because
 *     three of its five id rows *are* (e) rows. A ticket text that says "four
 *     clauses" predates that round; the spec on disk is the SSOT, so (e) is
 *     graded here — and so is the membership assertion round 9 assigns to this
 *     file by name.
 *  2. A row where the two columns *agree* (legacy null and parse `ok`) carries
 *     no clause. SC11's sentence lists only divergent rows, but a real
 *     transcript corpus is mostly agreement rows and SC11 demands ZERO
 *     UNEXPECTED over it, so "EXPECTED with no clause" is the only reading
 *     under which the criterion is satisfiable; every divergent EXPECTED row
 *     does name its clause, which is what the admission predicate counts.
 */

import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  checkCorpusLine,
  checkExpectationLine,
  classifyRow,
  dualRunCommand,
  EXPECTATION_LABELS,
  extractCommands,
  formatReportRow,
  loadCorpus,
  loadExpectations,
  redactionHits,
  runDualPass,
  type Expectation,
} from "../../../scripts/shell-parse-divergence.ts";

type DivergenceRow = ReturnType<typeof dualRunCommand>;
type ClassifyInput = Parameters<typeof classifyRow>[0];

const repoRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  ".."
);
const scriptPath = join(repoRoot, "scripts", "shell-parse-divergence.ts");
const corpusDir = join(repoRoot, "tests", "fixtures", "shell-corpus");
const corpusFile = join(corpusDir, "benign.jsonl");

/** The sibling roster's one filename: the corpus dir's only NON-corpus file. */
const EXPECTATIONS_FILENAME = "backslash-whitespace-expectations.jsonl";
const expectationsFile = join(corpusDir, EXPECTATIONS_FILENAME);

/**
 * The incident pair from #1188, pinned as text. Both spellings are ordinary
 * Bash: an escaped space inside a long option's value, and a word-separator LF
 * continuation between two options.
 */
const INCIDENT_ESCAPED_SPACE = "ls -lt --time-style=+%m-%d\\ %H:%M docs/evidence";
const INCIDENT_SEPARATOR_CONTINUATION =
  "gh issue view 1188 --json number,title \\\n -q '.title'";

/** The two reduced counterparts: identical prefix, only the follower differs. */
const SHAPED_ESCAPED_SPACE = "printf '<%s>\\n' a\\ b";
const SHAPED_SEPARATOR_CONTINUATION = "printf '<%s>\\n' a \\\n b";

/** The two retained fidelity denials: one mid-word LF join, one backslash+TAB. */
const RETAINED_MIDWORD_JOIN = "printf '<%s>\\n' a\\\nb";
const RETAINED_BACKSLASH_TAB = "printf '<%s>\\n' a\\\tb";

const SUPPORTED_BENIGN_COMMANDS: readonly string[] = [
  INCIDENT_ESCAPED_SPACE,
  INCIDENT_SEPARATOR_CONTINUATION,
  SHAPED_ESCAPED_SPACE,
  SHAPED_SEPARATOR_CONTINUATION,
];
const RETAINED_FIDELITY_COMMANDS: readonly string[] = [
  RETAINED_MIDWORD_JOIN,
  RETAINED_BACKSLASH_TAB,
];

/**
 * The pre-#1188 generic denial representative. It is an escaped-space form, so
 * the repair makes it a supported spelling: it can no longer stand in for a
 * retained hard denial anywhere in this file.
 */
const RETIRED_DENIAL_REPRESENTATIVE = "echo\\ test";

/** The closed dangerous-pattern set — SC10's P1 column vocabulary. */
const DANGEROUS_PATTERN_IDS = [
  "destructive-rm",
  "destructive-disk",
  "command-substitution",
  "bare-metachar",
  "root-find-walk",
] as const;

/** SC11 class (e)'s membership list: exactly these four ids own a deferral. */
const CLASS_E_IDS = [
  "destructive-rm",
  "destructive-disk",
  "bare-metachar",
  "root-find-walk",
] as const;

/** The verdict tags class (d) names, one demanded row each (SC10 P2). */
const HARD_DENY_CLASS_D_VERDICTS = ["malformed", "over-cap", "vetoed"] as const;

/** Item (iv)'s pinned literal tag for the deferral class. */
const CLASS_E_TAG = "not-yet-migrated";

// --------------------------------------------------------------------------
// helpers
// --------------------------------------------------------------------------

/** The parse-verdict tag out of a `new-verdict` column value (`verdict=ok …`). */
function verdictTag(row: { newVerdict: string }): string {
  const raw = row.newVerdict;
  const body = raw.startsWith("verdict=") ? raw.slice("verdict=".length) : raw;
  return body.split(/[\s,;]+/)[0] ?? body;
}

/**
 * SC4's over-cap input, generated here rather than committed: committing a
 * line over 65 536 bytes to reach one classifier branch is exactly what
 * SC10's P2 arithmetic refuses. Legacy-allow (measured: `null` from
 * `findDangerousPattern`) so it is a class-(d) row.
 */
function generatedOverCapCommand(): string {
  const command = `echo ${"a".repeat(70_000)}`;
  if (Buffer.byteLength(command, "utf8") <= 65_536) {
    throw new Error(
      "generator produced a sub-cap input; the over-cap row is unfed"
    );
  }
  return command;
}

/** One synthetic row for the pure classifier, encoded per SC10's field 3. */
function rowWithVerdict(
  command: string,
  oldVerdict: string | null,
  verdict: string
): ClassifyInput {
  return { command, oldVerdict, newVerdict: `verdict=${verdict}` };
}

/** Item (iv) decoding: the two-character escapes back to the raw characters. */
function decodeReportField(field: string): string {
  return field.replace(/\\(.)/g, (_m, ch: string) =>
    ch === "n"
      ? "\n"
      : ch === "r"
        ? "\r"
        : ch === "t"
          ? "\t"
          : ch === "\\"
            ? "\\"
            : `\\${ch}`
  );
}

interface ScriptRun {
  readonly code: number | null;
  readonly out: string;
  readonly err: string;
}

/** Resolve the pinned tsx entry point the way tests/cli does. */
function resolveTsxCli(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
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

const tsxCli = resolveTsxCli();

/** Run the real report command (SC10/SC11 state these as command forms). */
function runScript(args: string[]): Promise<ScriptRun> {
  const child = spawn(process.execPath, [tsxCli, scriptPath, ...args], {
    cwd: repoRoot,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => (out += String(d)));
  child.stderr.on("data", (d) => (err += String(d)));
  return new Promise((resolve) => {
    child.on("close", (code) => resolve({ code, out, err }));
    child.on("error", (e) =>
      resolve({ code: null, out, err: err + String(e) })
    );
  });
}

/**
 * SC10's admission predicate, implemented as a function over the CLASSIFIED
 * REPORT (never a hand-count of lines, never a reviewer's assurance).
 * Returns the violation list; an empty list means the corpus is admissible.
 */
function admissionViolations(
  rows: readonly DivergenceRow[],
  committedRecordCount: number,
  expectations: ReadonlyMap<string, Expectation>
): string[] {
  const violations: string[] = [];

  // Every row must carry a verdict at all — a row with no class is an
  // un-classified row, and SC11's rule is total + binary.
  for (const row of rows) {
    if (row.class !== "EXPECTED" && row.class !== "UNEXPECTED") {
      violations.push(
        `row ${JSON.stringify(row.command).slice(0, 40)}: class is neither EXPECTED nor UNEXPECTED`
      );
    }
  }

  // (P1) every DangerousPatternId appears in the old-verdict column.
  for (const id of DANGEROUS_PATTERN_IDS) {
    if (!rows.some((r) => r.oldVerdict === id)) {
      violations.push(`P1: old-verdict column never shows ${id}`);
    }
  }

  // (P2) at least one row in each SC11 class; class (d) one per verdict it names.
  const expected = rows.filter((r) => r.class === "EXPECTED");
  for (const clause of ["a", "b", "c", "e"] as const) {
    if (!expected.some((r) => r.clause === clause)) {
      violations.push(`P2: no EXPECTED row carries class (${clause})`);
    }
  }
  const classD = expected.filter((r) => r.clause === "d");
  for (const verdict of HARD_DENY_CLASS_D_VERDICTS) {
    if (!classD.some((r) => verdictTag(r) === verdict)) {
      violations.push(
        `P2: no class-(d) row with new-verdict ${verdict} (premise: legacy allows)`
      );
    }
  }

  // (P3) the JSONL format exists for this shape: one admitted command carries
  // an embedded newline (a heredoc), which no line-oriented format could hold.
  if (!rows.some((r) => r.command.includes("\n"))) {
    violations.push(
      "P3: no admitted record's decoded command contains an embedded newline"
    );
  }

  // (P4) SC7's labeled population reached the report, and both labels are
  // exercised: a roster that only ever labels one side cannot tell a wrongly
  // vetoed supported form apart from an intended denial.
  const labeled = new Set(rows.map((r) => r.command));
  for (const command of expectations.keys()) {
    if (!labeled.has(command)) {
      violations.push(
        `P4: labeled row never reached the report: ${JSON.stringify(command)}`
      );
    }
  }
  for (const label of EXPECTATION_LABELS) {
    const exercised = [...expectations.values()].filter((e) => e === label);
    if (exercised.length === 0) {
      violations.push(`P4: the roster carries no ${label} row`);
    }
  }

  // The derived floor, on the page: 5 id rows + 4 legacy-allow rows.
  if (rows.length < 9) {
    violations.push(
      `floor: report holds ${rows.length} classified rows, SC10 derives >= 9`
    );
  }
  if (committedRecordCount < 8) {
    violations.push(
      `floor: committed corpus holds ${committedRecordCount} records, SC10 derives >= 8 (the over-cap row alone may be generated)`
    );
  }

  return violations;
}

// --------------------------------------------------------------------------
// scratch dirs
// --------------------------------------------------------------------------

let scratch: string;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "iknow-shadow-divergence-"));
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const tempDirs: string[] = [];

function freshTempDir(label: string): string {
  const dir = mkdtempSync(join(scratch, `${label}-`));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

/** The committed corpus, read once per test that needs it (red = dir missing). */
function committedCommands(): string[] {
  return loadCorpus(corpusDir);
}

/**
 * The corpus directory's own files. The expectation roster is a sibling with a
 * different format and its own reader, so it is excluded here exactly as
 * `loadCorpus`'s directory sweep excludes it.
 */
function corpusFileNames(): string[] {
  return readdirSync(corpusDir)
    .filter((name) => name !== EXPECTATIONS_FILENAME)
    .filter((name) => statSync(join(corpusDir, name)).isFile())
    .sort();
}

// ==========================================================================
// 0. the contract surface this file is written against
// ==========================================================================

describe("shell-parse-divergence: tool contract surface", () => {
  it("exports every function this gate imports, as functions", () => {
    const surface: Record<string, unknown> = {
      dualRunCommand,
      classifyRow,
      formatReportRow,
      checkCorpusLine,
      loadCorpus,
      redactionHits,
      extractCommands,
      runDualPass,
    };
    expect(
      Object.entries(surface)
        .filter(([, fn]) => typeof fn !== "function")
        .map(([name]) => name),
      "missing exports"
    ).toEqual([]);
  });

  it("one dual run carries the four report values and nothing else decides them", () => {
    const row = dualRunCommand("echo hi");
    for (const key of [
      "command",
      "oldVerdict",
      "newVerdict",
      "class",
    ] as const) {
      expect(row, `row from ${key} check`).toHaveProperty(key);
    }
    expect(row.command).toBe("echo hi");
    expect(["EXPECTED", "UNEXPECTED"]).toContain(row.class);
    // SC10 field 3's pinned encoding: the new-verdict column names the verdict.
    expect(row.newVerdict).toMatch(/^verdict=[a-z-]+/);
    // SC11 definition (i): the old-verdict column is the SCAN's answer, so a
    // clean row is null — never a wall's deny/ask/allow word.
    expect(row.oldVerdict ?? null).toBeNull();
  });

  it("does not execute what it classifies: `bash -n` is parse-only (item (ii))", () => {
    const marker = join(freshTempDir("noexec"), "should-not-exist");
    // A dangling `&&` — measured: `findDangerousPattern` null, the parse says
    // `malformed`, `bash -n` exits 2 — and the tail is a real `touch`, so an
    // implementation that dropped `-n` and *ran* the input leaves a file.
    const command = `touch ${marker} &&`;
    const classified = classifyRow(rowWithVerdict(command, null, "malformed"));
    const ran = dualRunCommand(command);
    expect(classified.class).toBe("EXPECTED");
    expect(classified.clause).toBe("d");
    expect(ran.class).toBe("EXPECTED");
    expect(verdictTag(ran)).toBe("malformed");
    expect(
      existsSync(marker),
      "the gate ran corpus input instead of parsing it"
    ).toBe(false);
  });
});

// ==========================================================================
// 1. SC10 — the fixture format is decidable, not prose
// ==========================================================================

describe("SC10: corpus JSONL format gate", () => {
  it("accepts a single-key command record, including one whose value holds a newline", () => {
    expect(checkCorpusLine(JSON.stringify({ command: "echo hi" }))).toBeNull();
    expect(
      checkCorpusLine(JSON.stringify({ command: "cat <<'EOF'\nhello\nEOF" }))
    ).toBeNull();
    expect(
      checkCorpusLine(JSON.stringify({ command: 'echo "rm -rf /\t\n\r"' }))
    ).toBeNull();
  });

  it("rejects a bare string line — the shape a .txt corpus would have been", () => {
    expect(checkCorpusLine("echo hi")).toBeTruthy();
    expect(checkCorpusLine('"echo hi"')).toBeTruthy();
  });

  it("rejects any second key: input, argv, path, env, id", () => {
    const extras: Record<string, unknown>[] = [
      { command: "echo hi", input: { command: "echo hi" } },
      { command: "echo hi", argv: ["echo", "hi"] },
      { command: "echo hi", path: "/tmp/f" },
      { command: "echo hi", env: { HOME: "/tmp" } },
      { command: "echo hi", id: "sess-1:t1" },
    ];
    for (const record of extras) {
      expect(
        checkCorpusLine(JSON.stringify(record)),
        JSON.stringify(record)
      ).toBeTruthy();
    }
  });

  it("rejects a non-string, missing or misnamed `command`, and non-object lines", () => {
    const bad = [
      JSON.stringify({ command: 42 }),
      JSON.stringify({ command: null }),
      JSON.stringify({ command: ["echo", "hi"] }),
      JSON.stringify({ command: { text: "echo hi" } }),
      JSON.stringify({ argv: ["echo", "hi"] }),
      JSON.stringify({ Command: "echo hi" }),
      JSON.stringify({}),
      JSON.stringify(["echo hi"]),
      JSON.stringify(null),
      "{ not json",
      "",
    ];
    for (const line of bad) {
      expect(checkCorpusLine(line), JSON.stringify(line)).toBeTruthy();
    }
  });

  it("every line of every committed CORPUS file passes the gate, and the directory is not empty", () => {
    const files = corpusFileNames();
    expect(files.length, `no corpus file under ${corpusDir}`).toBeGreaterThan(
      0
    );
    for (const name of files) {
      const lines = readFileSync(join(corpusDir, name), "utf8").split("\n");
      lines.forEach((line, i) => {
        if (line.length === 0 && i === lines.length - 1) return; // trailing newline
        const violation = checkCorpusLine(line);
        expect(
          violation,
          `${name}:${i + 1} is not a single-key command record: ${violation}`
        ).toBeNull();
      });
    }
  });

  it("the expectation roster is NOT a corpus file: each format rejects the other's records", () => {
    // The corpus format is frozen at exactly one `command` key, and the roster
    // is a separate reader. If either reader ever accepted the other's lines the
    // two populations could be silently interchanged, so both directions are
    // pinned here rather than inferred from the directory layout.
    const rosterLines = readFileSync(expectationsFile, "utf8")
      .split("\n")
      .filter((line) => line.length > 0);
    expect(rosterLines.length, "the roster carries no labeled row").toBeGreaterThan(0);
    for (const line of rosterLines) {
      expect(
        checkCorpusLine(line),
        `the corpus reader admitted a labeled record: ${line.slice(0, 60)}`
      ).toBeTruthy();
      expect(checkExpectationLine(line), line.slice(0, 60)).toBeNull();
    }
    expect(checkExpectationLine(JSON.stringify({ command: "echo hi" }))).toBe(
      "`expectation` must be one of [\"supported-benign\",\"retained-fidelity\"]"
    );
    expect(corpusFileNames()).not.toContain(EXPECTATIONS_FILENAME);
  });

  it("every roster line carries a closed-vocabulary label and a rationale, one per physical line", () => {
    const raw = readFileSync(expectationsFile, "utf8");
    const lines = raw.split("\n");
    expect(
      lines[lines.length - 1],
      "the roster's last line is not terminated"
    ).toBe("");
    const records = lines
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records.length).toBeGreaterThanOrEqual(4);
    for (const record of records) {
      expect(EXPECTATION_LABELS).toContain(record.expectation);
      expect(typeof record.command).toBe("string");
      expect(
        String(record.rationale).length,
        "a label with no stated reason is not reviewable"
      ).toBeGreaterThan(20);
    }
    const supported = records.filter(
      (r) => r.expectation === "supported-benign"
    );
    const retained = records.filter(
      (r) => r.expectation === "retained-fidelity"
    );
    expect(
      supported.map((r) => r.command),
      "the roster lost an incident-equivalent supported row"
    ).toEqual(expect.arrayContaining([INCIDENT_ESCAPED_SPACE, INCIDENT_SEPARATOR_CONTINUATION]));
    expect(
      retained.map((r) => r.command),
      "the roster lost a retained denial"
    ).toEqual(expect.arrayContaining([RETAINED_MIDWORD_JOIN]));
    expect(
      retained.some(
        (r) => typeof r.command === "string" && r.command.includes("\t")
      ),
      "no unquoted backslash+TAB row: the measured TAB disagreement is unlabelled"
    ).toBe(true);
  });

  it("every labeled row is a committed corpus row, and no labeled row is a secret", () => {
    const committed = committedCommands();
    const expectations = loadExpectations(expectationsFile);
    expect(expectations.size).toBeGreaterThan(0);
    for (const command of expectations.keys()) {
      expect(
        committed,
        `a label with no corpus row can never be reached: ${JSON.stringify(command)}`
      ).toContain(command);
      expect(redactionHits(command), command).toEqual([]);
    }
  });

  it("at least one admitted record's DECODED command carries an embedded newline", () => {
    const newlineCarriers = committedCommands().filter((c) => c.includes("\n"));
    expect(
      newlineCarriers.length,
      "no heredoc-shaped record: the JSONL format is then unjustified and SC11's quoted-heredoc class has no supplier"
    ).toBeGreaterThanOrEqual(1);
  });

  it("a corpus directory holding one bad line fails the load instead of skipping it", () => {
    const dir = freshTempDir("bad-corpus");
    writeFileSync(
      join(dir, "good.jsonl"),
      JSON.stringify({ command: "echo hi" }) +
        "\n" +
        JSON.stringify({ command: "echo $HOME" }) +
        "\n"
    );
    writeFileSync(
      join(dir, "bad.jsonl"),
      JSON.stringify({ command: "echo hi", id: "x" }) + "\n"
    );
    expect(() => loadCorpus(dir)).toThrow();
  });

  it("the committed corpus commits no over-cap record: the (d) over-cap row is generated", () => {
    const overCap = committedCommands().filter(
      (c) => Buffer.byteLength(c, "utf8") > 65_536
    );
    expect(
      overCap.length,
      "a >65 536-byte line was committed instead of generated"
    ).toBe(0);
    const generated = dualRunCommand(generatedOverCapCommand());
    expect(verdictTag(generated)).toBe("over-cap");
    expect(generated.class).toBe("EXPECTED");
    expect(generated.clause).toBe("d");
  });
});

// ==========================================================================
// 2. SC10 — the redaction roster and the extractor, run not assumed
// ==========================================================================

describe("SC10/OQ1: redaction roster", () => {
  it("matches the seven DEFAULT_SECRET_PATTERNS floor shapes", () => {
    const floorSamples = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "echo sk-PLACEHOLDERPLACEHOLDERPLACEHOLDER01234",
      "aws --access-key-id AKIAABCDEFGHIJKLMNOP",
      "gh api --header ghp_" + "A".repeat(36),
      "gh api --header github_pat_" + "A".repeat(52),
      "slack say xoxb-PLACEHOLDER01",
      "cat ~/.ssh/id_rsa",
    ];
    for (const sample of floorSamples) {
      expect(redactionHits(sample), sample).not.toEqual([]);
    }
  });

  it("carries the four OQ1 extras beyond the floor", () => {
    const extras = [
      'curl -H "Authorization: Bearer PLACEHOLDER0123456789" https://api.example.com',
      'curl -H "Authorization: Basic UGxhY2Vob2xkZXIxMjM0NTY3ODlLZXk=" https://api.example.com',
      "curl -H 'X-Auth: eyJhbGciOiJIUzI1NiJ9.PLACEHOLDERPAYLOAD0123456789.signatureseg0123456789'",
      'curl "https://api.example.com/v1?token=PLACEHOLDER0123456789&key=PLACEHOLDER0123456789"',
      "export DEPLOY_API_TOKEN=PLACEHOLDER0123456789 && echo done",
    ];
    for (const sample of extras) {
      expect(redactionHits(sample), sample).not.toEqual([]);
    }
  });

  it("does not fire on ordinary words — an over-broad roster shrinks the corpus", () => {
    for (const clean of [
      "echo hi",
      "echo $HOME",
      "git log --oneline",
      "cat <<'EOF'\nhello\nEOF",
    ]) {
      expect(redactionHits(clean), clean).toEqual([]);
    }
  });

  it("every committed corpus record is secret-free on its DECODED value and on its raw bytes", () => {
    for (const command of committedCommands()) {
      expect(
        redactionHits(command),
        JSON.stringify(command.slice(0, 60))
      ).toEqual([]);
    }
    for (const name of readdirSync(corpusDir)) {
      const raw = readFileSync(join(corpusDir, name), "utf8");
      expect(raw, `${name} carries a raw secret byte sequence`).not.toMatch(
        /sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|BEGIN [A-Z ]*PRIVATE KEY/
      );
    }
  });
});

/**
 * A synthetic session tree in the shape item (i) reads: `<id>/<id>.jsonl`
 * transcript records whose tool_use blocks are `{type,id,name,input}`
 * (`src/session-api/store/schema.ts:537-542`), plus `<id>/trace.jsonl`
 * `ToolCallRecord`s (`src/harness/trace/types.ts:90-103`, persisted snake_case
 * with `record_type:"tool_call"` by `src/harness/trace/jsonl.ts:280-299`).
 *
 * Modeled byte-for-byte in shape on a real transcript line from
 * ~/.iknow/projects/iknow-ddcb805367a0/611a66df-…/611a66df-….jsonl:
 *   {"type":"message","id":"e2","parent":"e1","message":{"role":"assistant",
 *    "content":[{"type":"tool_use","id":"call_65d9e67f7d754f428f65678e",
 *    "name":"bash","input":{"command":"cd /home/winner/projects/iknow && git remote -v …"}}]}}
 *
 * SC10's clause (A) grades a checked-in fixture directory; this test builds the
 * same population under a fresh temp path so its red mode never depends on a
 * sibling worker landing a fixture it does not own.
 */
const ADMITTED_POPULATION = [
  "echo hi",
  "echo $HOME",
  "cat <<'EOF'\nhello\nEOF",
  "echo '$(whoami)'",
  "rm -rf /tmp/deep",
  "echo $(whoami)",
] as const;

const SECRET_ROWS = {
  floor: "echo sk-PLACEHOLDERPLACEHOLDERPLACEHOLDER0123456789",
  extraAssignment:
    "export DEPLOY_API_TOKEN=PLACEHOLDER0123456789ABCDEF && echo done",
  // Written into the file as a JSON \\u escape so the raw bytes hold no "sk-":
  // only the DECODED value can trip the roster, which is the point of the row.
  escapedDecoded: "echo sk-PLACEHOLDERESCAPED0123456789ABCDEF",
};

function writeBashToolUse(
  id: string,
  index: number,
  command: string
): Record<string, unknown> {
  return {
    type: "message",
    id: `e${index}`,
    parent: `e${index - 1}`,
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: `call_${id}_${index}`,
          name: "bash",
          input: { command },
        },
      ],
    },
    createdAt: "2026-09-25T00:00:00.000Z",
  };
}

function buildSyntheticSession(): { dir: string; transcriptPath: string } {
  const projectDir = freshTempDir("sess");
  const conversationId = "sess-0001";
  const dir = join(projectDir, conversationId);
  mkdirSync(dir, { recursive: true });
  const transcriptPath = join(dir, `${conversationId}.jsonl`);

  const lines: string[] = [];
  lines.push(
    JSON.stringify({
      type: "session",
      schemaVersion: 1,
      conversation_id: conversationId,
      jsonMode: true,
      turnCount: 12,
      updatedAt: "2026-09-25T00:00:00.000Z",
      title: "synthetic extract fixture",
      cwd: "/tmp/does-not-matter",
      sanitized_at: "2026-09-25T00:00:00.000Z",
      checkpoints: [],
    })
  );
  lines.push(
    JSON.stringify({
      type: "message",
      id: "e0",
      parent: null,
      message: {
        role: "user",
        // A message BODY carrying a secret and a decoy command record: item (i)
        // forbids reading these, so neither may appear in the output.
        content: [
          {
            type: "text",
            text:
              "run this please: " +
              JSON.stringify({ command: "echo DECOY-FROM-MESSAGE-BODY" }) +
              " and here is the key sk-PLACEHOLDERINTEXTBODY0123456789ABCDEF",
          },
        ],
      },
    })
  );
  lines.push(JSON.stringify(writeBashToolUse("a", 1, ADMITTED_POPULATION[0])));
  lines.push(JSON.stringify(writeBashToolUse("s", 2, SECRET_ROWS.floor)));
  lines.push(JSON.stringify(writeBashToolUse("b", 3, ADMITTED_POPULATION[1])));
  lines.push(JSON.stringify(writeBashToolUse("c", 4, ADMITTED_POPULATION[2])));
  lines.push(JSON.stringify(writeBashToolUse("d", 5, ADMITTED_POPULATION[3])));
  lines.push(
    JSON.stringify({
      type: "message",
      id: "e6",
      parent: "e5",
      message: {
        role: "assistant",
        content: [
          {
            // Not a bash call: its argv/path must contribute nothing.
            type: "tool_use",
            id: "call_read_1",
            name: "read_file",
            input: {
              path: "/etc/shadow",
              command: "echo DECOY-FROM-OTHER-TOOL",
            },
          },
        ],
      },
    })
  );
  lines.push(
    JSON.stringify(writeBashToolUse("t", 7, SECRET_ROWS.extraAssignment))
  );
  lines.push(JSON.stringify(writeBashToolUse("e", 8, ADMITTED_POPULATION[4])));
  lines.push(JSON.stringify(writeBashToolUse("f", 9, ADMITTED_POPULATION[5])));
  // Hand-written so the escape survives into the FILE bytes (a JSON.stringify of
  // the decoded string would emit the raw "sk-" and stop testing anything).
  lines.push(
    '{"type":"message","id":"e10","parent":"e9","message":{"role":"assistant","content":' +
      '[{"type":"tool_use","id":"call_esc","name":"bash","input":{"command":"echo \\u0073k-' +
      "PLACEHOLDERESCAPED0123456789ABCDEF" +
      '"}}]}}'
  );
  writeFileSync(transcriptPath, lines.join("\n") + "\n");
  // The escaped row must survive into the file as an escape, not as bytes:
  // otherwise this row proves nothing about decoded-vs-raw matching.
  const rawFile = readFileSync(transcriptPath, "utf8");
  expect(rawFile).not.toContain("sk-PLACEHOLDERESCAPED");
  expect(rawFile).toContain("\\u0073k-PLACEHOLDERESCAPED");
  const parsed = rawFile
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  const escapedRecord = parsed.find((r) =>
    JSON.stringify(r).includes("call_esc")
  );
  expect(
    escapedRecord,
    "the escaped-secret row never reached the file"
  ).toBeTruthy();
  // Decoded, it IS a roster hit — which is what the gate must see, not the bytes.
  expect(JSON.stringify(escapedRecord)).toContain("sk-PLACEHOLDERESCAPED");

  writeFileSync(
    join(dir, "trace.jsonl"),
    [
      JSON.stringify({
        conversation_id: conversationId,
        record_type: "tool_call",
        tool_call_id: "tc-uncaptured",
        parent_llm_call_id: null,
        // Declared shape (trace/types.ts:90-103) and persisted snake_case shape
        // written by trace/jsonl.ts:280-299 — both spellings, so honoring the
        // flag cannot depend on which reader the extractor grew.
        toolName: "bash",
        tool_name: "bash",
        toolKind: "ok",
        tool_kind: "ok",
        startedAt: "2026-09-25T00:00:01.000Z",
        endedAt: "2026-09-25T00:00:02.000Z",
        durationMs: 1,
        argumentsCaptured: false,
        arguments_captured: false,
        resultCaptured: false,
        result_captured: false,
        status: "ok",
      }),
    ].join("\n") + "\n"
  );
  return { dir, transcriptPath };
}

describe("SC10(A): the extractor is run, not assumed", () => {
  it("emits exactly the admitted population, in fixture order, and nothing else", () => {
    const { dir } = buildSyntheticSession();
    const emitted = extractCommands(dir);
    expect(emitted).toEqual([...ADMITTED_POPULATION]);
    expect(emitted).not.toContain(SECRET_ROWS.floor);
    expect(emitted).not.toContain(SECRET_ROWS.extraAssignment);
    expect(emitted).not.toContain(SECRET_ROWS.escapedDecoded);
    expect(emitted.join("\n")).not.toContain("DECOY");
    expect(emitted.join("\n")).not.toContain("/etc/shadow");
  });

  it("drops a secret-bearing candidate WHOLE rather than masking it", () => {
    const { dir } = buildSyntheticSession();
    const emitted = extractCommands(dir);
    // A masked row would still be present, with the secret replaced — so the
    // count would be 7 and no emitted string would equal its source command.
    expect(emitted.length).toBe(ADMITTED_POPULATION.length);
    expect(emitted.some((c) => /\*{3,}|<redacted>|<MASK>/i.test(c))).toBe(
      false
    );
    const pinned: readonly string[] = ADMITTED_POPULATION;
    expect(emitted.every((c) => pinned.includes(c))).toBe(true);
  });

  it("skips the uncaptured trace call instead of guessing a command for it", () => {
    const { dir } = buildSyntheticSession();
    const emitted = extractCommands(dir);
    expect(emitted.every((c) => typeof c === "string" && c.length > 0)).toBe(
      true
    );
    expect(emitted.some((c) => c.includes("tc-uncaptured"))).toBe(false);
    expect(emitted.length).toBe(ADMITTED_POPULATION.length);
  });

  it("the same two checks the corpus is put through, applied to --extract stdout", async () => {
    const { dir } = buildSyntheticSession();
    const run = await runScript(["--extract", dir]);
    expect(run.code, `--extract exited ${run.code}: ${run.err}`).toBe(0);
    const lines = run.out.split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBe(ADMITTED_POPULATION.length);
    const decoded: string[] = [];
    for (const line of lines) {
      expect(checkCorpusLine(line), line).toBeNull();
      decoded.push(JSON.parse(line).command as string);
    }
    expect(decoded).toEqual([...ADMITTED_POPULATION]);
    expect(decoded.some((c) => c.includes("\n"))).toBe(true);
    for (const command of decoded)
      expect(redactionHits(command), command).toEqual([]);
  });
});

// ==========================================================================
// 3. SC11 — classification is total, binary, and clause-bound
// ==========================================================================

describe("SC11: EXPECTED clauses", () => {
  it("(a) quote-blind false positive on inert text — single quotes, comment, quoted heredoc", () => {
    for (const command of [
      "echo '$(whoami)'",
      "echo hi # $(whoami)",
      "cat <<'EOF'\n$(whoami)\nEOF",
    ]) {
      const row = dualRunCommand(command);
      expect(
        row.oldVerdict,
        `${command} should have fired the substitution scan`
      ).toBe("command-substitution");
      expect(verdictTag(row)).toBe("ok");
      expect(row.class).toBe("EXPECTED");
      expect(row.clause).toBe("a");
    }
  });

  it("(a) wins over (e) by B2 when the id is on (e)'s list but the text was inert", () => {
    const row = dualRunCommand('echo "rm -rf /"');
    expect(row.oldVerdict).toBe("destructive-rm");
    expect(row.class).toBe("EXPECTED");
    expect(row.clause).toBe("a");
  });

  it("(b) a real substitution node, whose policy is Stage 1's", () => {
    const row = dualRunCommand("echo $(whoami)");
    expect(row.oldVerdict).toBe("command-substitution");
    expect(verdictTag(row)).toBe("ok");
    expect(row.class).toBe("EXPECTED");
    expect(row.clause).toBe("b");
  });

  it("(c) ask-parity: unknown-syntax over a legacy-allow row", () => {
    // Synthetic because no corpus command is required to land outside the
    // day-one roster (OQ3); SC10 P2 demands the class, the roster supplies it.
    const classified = classifyRow(
      rowWithVerdict("echo hi", null, "unknown-syntax")
    );
    expect(classified.class).toBe("EXPECTED");
    expect(classified.clause).toBe("c");
  });

  it("(d) one row per hard-deny verdict the class names, over a legacy-allow row", () => {
    const malformed = dualRunCommand("echo hi &&");
    expect(malformed.oldVerdict).toBeNull();
    expect(verdictTag(malformed)).toBe("malformed");
    expect(malformed.class).toBe("EXPECTED");
    expect(malformed.clause).toBe("d");

    const overCap = dualRunCommand(generatedOverCapCommand());
    expect(overCap.oldVerdict).toBeNull();
    expect(verdictTag(overCap)).toBe("over-cap");
    expect(overCap.class).toBe("EXPECTED");
    expect(overCap.clause).toBe("d");

    // SC8: `echo\ test` is an escaped-space form, i.e. a shape the repair
    // SUPPORTS, so it can no longer represent a hard denial. The vetoed cell
    // now uses a committed mid-word continuation — a shape real Bash joins into
    // one argument — and the roster's retained-fidelity label must not weaken
    // it: the row stays an expected class-(d) denial.
    const expectations = loadExpectations(expectationsFile);
    expect(expectations.get(RETAINED_MIDWORD_JOIN)).toBe("retained-fidelity");
    const vetoed = dualRunCommand(RETAINED_MIDWORD_JOIN, expectations);
    expect(vetoed.oldVerdict).toBeNull();
    expect(verdictTag(vetoed)).toBe("vetoed");
    expect(vetoed.class).toBe("EXPECTED");
    expect(vetoed.clause).toBe("d");
  });

  it("(d)(iii) the malformed-over-allow cell is adjudicated by `bash -n`, not by the parse", () => {
    // bash -n exit 2 on both (measured) → the parse agrees with the shell.
    for (const command of ["echo hi &&", "echo )(", "if x; then echo y"]) {
      const classified = classifyRow(
        rowWithVerdict(command, null, "malformed")
      );
      expect(classified.class, command).toBe("EXPECTED");
      expect(classified.clause, command).toBe("d");
    }
    // bash -n exit 0: the parse disagrees with the shell — the divergence signal
    // this gate exists to catch, so it is UNEXPECTED and an OQ3 ticket.
    const balanced = "cat <<'EOF'\nbody";
    const classified = classifyRow(rowWithVerdict(balanced, null, "malformed"));
    expect(classified.class).toBe("UNEXPECTED");
    expect(classified.clause ?? null).toBeNull();
  });

  it("(e) a legacy-deny row the parse calls clean, only for the four listed ids", () => {
    const expectedIds: Record<string, string> = {
      "rm -rf /tmp/deep": "destructive-rm",
      "dd if=/dev/zero of=/dev/sda": "destructive-disk",
      "> /tmp/x": "bare-metachar",
      // A MUTATING root search: SC6 withdrew the deny for a read-only one, so
      // `find /` itself is no longer a legacy-deny row and class (e) has no
      // premise left for it. This id still defers for the searches the wall
      // owns, which is what the class is about.
      "find / -delete": "root-find-walk",
    };
    for (const [command, id] of Object.entries(expectedIds)) {
      const row = dualRunCommand(command);
      expect(row.oldVerdict, command).toBe(id);
      expect(verdictTag(row), command).toBe("ok");
      expect(row.class, command).toBe("EXPECTED");
      expect(row.clause, command).toBe("e");
    }
  });

  it("a read-only root search is no longer a legacy-deny row at all", () => {
    // The premise of clause (e) is a LEGACY DENY, so the command SC6 released
    // cannot carry the clause: with no old verdict there is nothing to defer.
    const row = dualRunCommand("find /");
    expect(row.oldVerdict).toBeNull();
    expect(row.class).toBe("EXPECTED");
    expect(row.clause ?? null).toBeNull();
  });

  it("a row with no divergence at all is EXPECTED and carries no clause (the corpus is mostly this)", () => {
    const classified = classifyRow(rowWithVerdict("echo hi", null, "ok"));
    expect(classified.class).toBe("EXPECTED");
    expect(classified.clause ?? null).toBeNull();
  });
});

describe("SC11: UNEXPECTED — the class cannot absorb the gate", () => {
  it("(d)'s premise is 'the legacy scan allows': a legacy-deny row never qualifies", () => {
    const denied: [string, string][] = [
      ["root-find-walk", "unknown-syntax"], // clause (c) premise fails
      ["destructive-rm", "vetoed"], // clause (d) premise fails
      ["destructive-disk", "over-cap"],
      ["bare-metachar", "malformed"],
    ];
    for (const [oldVerdict, verdict] of denied) {
      const classified = classifyRow(rowWithVerdict("x", oldVerdict, verdict));
      expect(classified.class, `${oldVerdict} + ${verdict}`).toBe("UNEXPECTED");
      expect(
        classified.clause ?? null,
        `${oldVerdict} + ${verdict}`
      ).toBeNull();
    }
  });

  it("aborted over an allowed row is a defect, not a policy", () => {
    const classified = classifyRow(rowWithVerdict("echo hi", null, "aborted"));
    expect(classified.class).toBe("UNEXPECTED");
    expect(classified.clause ?? null).toBeNull();
  });

  it("a verdict outside the six is UNEXPECTED, including parser-unavailable", () => {
    for (const verdict of ["parser-unavailable", "not-a-verdict"]) {
      expect(classifyRow(rowWithVerdict("echo hi", null, verdict)).class).toBe(
        "UNEXPECTED"
      );
    }
  });

  it("(e)'s B1: a legacy-deny row whose parse verdict is not `ok` stays UNEXPECTED", () => {
    for (const verdict of [
      "malformed",
      "unknown-syntax",
      "aborted",
      "over-cap",
      "vetoed",
    ]) {
      const classified = classifyRow(
        rowWithVerdict("rm -rf /tmp/deep", "destructive-rm", verdict)
      );
      expect(classified.class, `destructive-rm + ${verdict}`).toBe(
        "UNEXPECTED"
      );
    }
  });

  it("classification is total and binary over a mixed batch", () => {
    const commands = [
      "echo hi",
      'echo "rm -rf /"',
      "echo '$(whoami)'",
      "echo $(whoami)",
      "rm -rf /tmp/deep",
      "> /tmp/x",
      "find /",
      "echo hi &&",
      RETAINED_MIDWORD_JOIN,
      generatedOverCapCommand(),
    ];
    for (const command of commands) {
      const row = dualRunCommand(command);
      expect(["EXPECTED", "UNEXPECTED"], command).toContain(row.class);
      if (row.class === "EXPECTED" && row.oldVerdict !== null) {
        expect(["a", "b", "c", "d", "e"], `${command} clause`).toContain(
          row.clause
        );
      }
      // The classifier agrees with the dual run on the same two columns.
      const classified = classifyRow({
        command: row.command,
        oldVerdict: row.oldVerdict,
        newVerdict: row.newVerdict,
      });
      expect(classified.class, command).toBe(row.class);
    }
  });
});

// ==========================================================================
// 4. SC11 — the CI run this whole stage switches on
// ==========================================================================

describe("SC11: the corpus run in CI", () => {
  it("every committed record yields one classified row, and the only UNEXPECTED rows are labeled supported forms still vetoed", () => {
    const committed = committedCommands();
    const expectations = loadExpectations(expectationsFile);
    const pass = runDualPass(
      [...committed, generatedOverCapCommand()],
      expectations
    );
    expect(pass.rows.length).toBe(committed.length + 1);

    // SC7: the planted false positives ARE the UNEXPECTED rows — no unlabeled
    // row may be excused by the label, and no labeled supported form may be
    // quietly dropped. A repaired parse shrinks this set to empty; the
    // assertion is the relation, not a frozen count.
    const unexpected = pass.rows.filter((r) => r.class === "UNEXPECTED");
    expect(
      unexpected.map((r) => r.command),
      "UNEXPECTED divergences gate the next stage"
    ).toEqual(
      pass.rows
        .filter(
          (r) =>
            verdictTag(r) === "vetoed" &&
            expectations.get(r.command) === "supported-benign"
        )
        .map((r) => r.command)
    );
    const unexcused = pass.rows.filter(
      (r) =>
        r.class === "UNEXPECTED" && expectations.get(r.command) === undefined
    );
    expect(
      unexcused.map((r) => r.command),
      "an unlabeled row went UNEXPECTED: outside this repair's label surface"
    ).toEqual([]);
  });

  it("the report satisfies SC10's admission predicate — and fails the moment rows are curated out", () => {
    const committed = committedCommands();
    const expectations = loadExpectations(expectationsFile);
    const rows = runDualPass(
      [...committed, generatedOverCapCommand()],
      expectations
    ).rows;
    expect(admissionViolations(rows, committed.length, expectations)).toEqual(
      []
    );

    // Falsifier, the graded form of "the corpus was curated to make the gate
    // green": delete the whitespace (vetoed) and over-cap rows to quiet (d).
    const curatedOut = rows.filter(
      (r) =>
        !(r.clause === "d" && ["vetoed", "over-cap"].includes(verdictTag(r)))
    );
    const afterCurating = admissionViolations(
      curatedOut,
      committed.length,
      expectations
    );
    expect(afterCurating.length).toBeGreaterThan(0);
    expect(afterCurating.join("\n")).toContain("vetoed");
    expect(afterCurating.join("\n")).toContain("over-cap");

    // Falsifier in the other direction: drop the only bare-metachar row.
    const withoutBare = rows.filter((r) => r.oldVerdict !== "bare-metachar");
    expect(
      admissionViolations(withoutBare, committed.length, expectations).join("\n")
    ).toContain("bare-metachar");
  });

  it("P4 is a floor too: curating the labeled rows out of the report fails admission", () => {
    const committed = committedCommands();
    const expectations = loadExpectations(expectationsFile);
    const rows = runDualPass([...committed], expectations).rows;
    expect(rows.length).toBe(committed.length);
    const withoutLabeled = rows.filter(
      (r) => expectations.get(r.command) === undefined
    );
    expect(withoutLabeled.length).toBe(committed.length - expectations.size);
    const violations = admissionViolations(
      withoutLabeled,
      withoutLabeled.length,
      expectations
    ).join("\n");
    expect(violations).toContain("P4");
  });

  it("class-(e) membership is a committed assertion, not a reading of the tool (SC11 round 9)", () => {
    const rows = runDualPass([
      ...committedCommands(),
      generatedOverCapCommand(),
    ]).rows;
    const eRows = rows.filter((r) => r.clause === "e");
    expect(
      eRows.length,
      "class (e) with no row is an excuse, not a class"
    ).toBeGreaterThan(0);
    const observed = [...new Set(eRows.map((r) => r.oldVerdict))].sort();
    expect(observed).toEqual([...CLASS_E_IDS].sort());
    for (const row of eRows) {
      expect(
        verdictTag(row),
        `${row.command} must parse ok to be deferred`
      ).toBe("ok");
      expect(row.oldVerdict).not.toBe("command-substitution");
    }
    expect(
      rows.some(
        (r) => r.oldVerdict === "command-substitution" && r.clause === "e"
      )
    ).toBe(false);
  });

  it("(e)'s report tag is the literal `not-yet-migrated`, as the LAST tab field", () => {
    const rows = runDualPass([
      ...committedCommands(),
      generatedOverCapCommand(),
    ]).rows;
    const eRows = rows.filter((r) => r.clause === "e");
    expect(eRows.length, "no (e) row to tag").toBeGreaterThan(0);
    const fields = formatReportRow(eRows[0]).split("\t");
    expect(fields.length).toBe(4);
    expect(fields[3]).toBe(CLASS_E_TAG);
  });

  it("one record is exactly one physical line, four tab fields, class last", () => {
    const rows = runDualPass([
      ...committedCommands(),
      generatedOverCapCommand(),
    ]).rows;
    for (const row of rows) {
      const line = formatReportRow(row);
      expect(
        line.includes("\n"),
        "a raw newline split one record across two lines"
      ).toBe(false);
      const fields = line.split("\t");
      expect(fields.length, line.slice(0, 80)).toBe(4);
      expect(decodeReportField(fields[0])).toBe(row.command);
      if (row.oldVerdict !== null) expect(fields[1]).toBe(row.oldVerdict);
      expect(fields[2]).toBe(row.newVerdict);
      expect(
        fields[3].length,
        "the class column may not be empty"
      ).toBeGreaterThan(0);
    }
  });

  it("the run's node-type histogram is the artifact that closes OQ3", () => {
    const pass = runDualPass([
      ...committedCommands(),
      generatedOverCapCommand(),
    ]);
    const entries = Object.entries(pass.histogram);
    expect(entries.length, "empty histogram cannot close OQ3").toBeGreaterThan(
      0
    );
    expect(
      entries.every(([type, count]) => typeof type === "string" && count > 0)
    ).toBe(true);
    for (const type of ["program", "word", "command"]) {
      expect(pass.histogram, `histogram missing ${type}`).toHaveProperty(type);
      expect(pass.histogram[type]).toBeGreaterThan(0);
    }
  });
});

// ==========================================================================
// 5. the command forms the Acceptance names
// ==========================================================================

describe("T6 Acceptance: the report is a command, not a ceremony", () => {
  it("`npx tsx scripts/shell-parse-divergence.ts --corpus tests/fixtures/shell-corpus/benign.jsonl` prints one classified row per record", async () => {
    const run = await runScript(["--corpus", corpusFile]);
    const records = readFileSync(corpusFile, "utf8")
      .split("\n")
      .filter((line) => line.length > 0);
    const lines = run.out.split("\n").filter((l) => l.length > 0);
    expect(run.code, `exit ${run.code}; stderr: ${run.err}`).toBe(
      // The committed corpus now carries SC7's planted rows, so the exit code
      // is a computed consequence of the report, not a pinned literal: 1 while a
      // labeled supported form is still vetoed, 0 once none is.
      lines.some((l) => l.split("\t")[3] === "UNEXPECTED") ? 1 : 0
    );
    expect(lines.length, "one row per record").toBe(records.length);
    for (const line of lines) {
      const fields = line.split("\t");
      expect(fields.length).toBe(4);
      expect(fields[3].length).toBeGreaterThan(0);
    }
  }, 120_000);

  it("SC10's stdout format test: one quoted inert record with a real LF, CR and TAB yields exactly one physical row", async () => {
    const dir = freshTempDir("one-record");
    const command = 'echo "rm -rf /\t\n\r"';
    const file = join(dir, "one.jsonl");
    writeFileSync(file, JSON.stringify({ command }) + "\n");

    const run = await runScript(["--corpus", file]);
    expect(run.code, `exit ${run.code}; stderr: ${run.err}`).toBe(0);
    const lines = run.out.split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBe(1);

    const [field1, field2, field3, field4] = lines[0].split("\t");
    expect(field2).toBe("destructive-rm");
    expect(field3.startsWith("verdict=ok")).toBe(true);
    expect(field4).not.toBe("UNEXPECTED");
    expect(field4).not.toBe(CLASS_E_TAG);
    expect(field1).not.toMatch(/[\n\r\t]/);
    expect(field1).toContain("\\n");
    expect(field1).toContain("\\r");
    expect(field1).toContain("\\t");
    expect(decodeReportField(field1)).toBe(command);
  }, 120_000);

  it("exits non-zero when the corpus holds a line that is not a single-key command record", async () => {
    const dir = freshTempDir("rejects-bad");
    const file = join(dir, "bad.jsonl");
    writeFileSync(
      file,
      JSON.stringify({ command: "echo hi", argv: ["echo"] }) + "\n"
    );
    const run = await runScript(["--corpus", file]);
    expect(
      typeof run.code,
      "the child process never ran — nothing was checked"
    ).toBe("number");
    expect(
      run.code,
      "a malformed corpus must fail the run, not be skipped"
    ).not.toBe(0);
    expect(run.out, "a rejected corpus may not print rows anyway").toBe("");
  }, 120_000);

  it("an empty corpus is not an error: no rows, no crash, exit 0", async () => {
    const dir = freshTempDir("empty-corpus");
    const file = join(dir, "empty.jsonl");
    writeFileSync(file, "");
    const run = await runScript(["--corpus", file]);
    expect(run.code, `exit ${run.code}; stderr: ${run.err}`).toBe(0);
    expect(run.out).toBe("");
  }, 120_000);
});

// ==========================================================================
// 6. #1188 SC7 — the labeled roster falsifies a planted false positive
// ==========================================================================

/** One corpus file plus its sibling roster, in a fresh temp dir. */
function writeCorpusWithRoster(
  label: string,
  commands: readonly string[],
  roster: readonly Record<string, unknown>[]
): string {
  const dir = freshTempDir(label);
  const file = join(dir, "planted.jsonl");
  writeFileSync(
    file,
    commands.map((command) => JSON.stringify({ command })).join("\n") + "\n"
  );
  if (roster.length > 0) {
    writeFileSync(
      join(dir, EXPECTATIONS_FILENAME),
      roster.map((record) => JSON.stringify(record)).join("\n") + "\n"
    );
  }
  return file;
}

/** The four TSV fields of each printed row, class column last. */
function reportFields(stdout: string): string[][] {
  return stdout
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => line.split("\t"));
}

describe("#1188 SC7: a planted supported-form veto is reported UNEXPECTED", () => {
  it("the real CLI exits non-zero on a labeled supported form that production still vetoes", async () => {
    // Planted by hand, not committed: the mid-word continuation is a shape the
    // repair RETAINS, and this roster claims it is supported-benign. That is the
    // false positive the gate exists to name, and it stays a false positive
    // whether or not the incident forms have been repaired yet.
    const file = writeCorpusWithRoster(
      "planted",
      [RETAINED_MIDWORD_JOIN],
      [
        {
          command: RETAINED_MIDWORD_JOIN,
          expectation: "supported-benign",
          rationale: "planted on purpose: this corpus must fail the run",
        },
      ]
    );
    const run = await runScript(["--corpus", file]);
    expect(run.code, `exit ${run.code}; stdout: ${run.out}`).toBe(1);
    const fields = reportFields(run.out);
    expect(fields.length).toBe(1);
    expect(fields[0][2]).toBe("verdict=vetoed");
    expect(fields[0][3], "a labeled supported veto is not reported").toBe(
      "UNEXPECTED"
    );
    expect(fields[0][1], "clause (d)'s premise is a legacy-allow row").toBe(
      "null"
    );
  }, 120_000);

  it("the same corpus WITHOUT the label is an expected class-(d) denial and exits 0", async () => {
    const file = writeCorpusWithRoster("unplanted", [RETAINED_MIDWORD_JOIN], []);
    const run = await runScript(["--corpus", file]);
    expect(run.code, `exit ${run.code}; stdout: ${run.out}`).toBe(0);
    const fields = reportFields(run.out);
    expect(fields[0][2]).toBe("verdict=vetoed");
    expect(fields[0][3]).toBe("expected-d");
  }, 120_000);

  it("a missing roster is the empty map: the unlabeled rows classify exactly as before", async () => {
    expect(
      loadExpectations(join(corpusDir, "no-such-roster.jsonl")).size,
      "a missing roster file crashed or invented labels"
    ).toBe(0);
    // A corpus dir with no sibling roster still runs, and the unlabeled rows
    // are byte-for-byte their pre-roster classification.
    const file = writeCorpusWithRoster(
      "no-roster",
      [RETAINED_MIDWORD_JOIN],
      []
    );
    const run = await runScript(["--corpus", file]);
    expect(run.code, `exit ${run.code}; stderr: ${run.err}`).toBe(0);
    expect(dualRunCommand(RETAINED_MIDWORD_JOIN)).toEqual(
      dualRunCommand(RETAINED_MIDWORD_JOIN, new Map())
    );
    expect(dualRunCommand(RETAINED_MIDWORD_JOIN).class).toBe("EXPECTED");
    expect(dualRunCommand(RETAINED_MIDWORD_JOIN).clause).toBe("d");
  }, 120_000);

  it("a malformed roster line fails the load before any row prints", async () => {
    const dir = freshTempDir("bad-roster");
    const file = join(dir, "planted.jsonl");
    writeFileSync(
      file,
      JSON.stringify({ command: "echo hi" }) + "\n"
    );
    writeFileSync(
      join(dir, EXPECTATIONS_FILENAME),
      JSON.stringify({ command: "echo hi", expectation: "probably-fine" }) + "\n"
    );
    const run = await runScript(["--corpus", file]);
    expect(typeof run.code, "the child process never ran").toBe("number");
    expect(run.code, "an undecidable label must not be read as a label").toBe(1);
    expect(run.out, "a rejected roster may not print rows anyway").toBe("");
    expect(run.err).toContain("expectation");
  }, 120_000);
});

describe("#1188 SC7: the labeled population separates the two denials", () => {
  const expectations = loadExpectations(expectationsFile);

  it("a supported-benign row is UNEXPECTED only while production vetoes it", () => {
    const rows = runDualPass(
      [...SUPPORTED_BENIGN_COMMANDS, ...RETAINED_FIDELITY_COMMANDS],
      expectations
    ).rows;
    expect(rows.length).toBe(6);
    for (const row of rows) {
      const planted = verdictTag(row) === "vetoed";
      const supported = expectations.get(row.command) === "supported-benign";
      expect(
        row.class,
        `${JSON.stringify(row.command)} verdict=${verdictTag(row)} label=${expectations.get(row.command)}`
      ).toBe(planted && supported ? "UNEXPECTED" : "EXPECTED");
      if (row.class === "EXPECTED" && row.oldVerdict === null) {
        // An agreement row carries no clause; a denied row names clause (d).
        expect(
          [null, "d"],
          `${row.command} clause`
        ).toContain(row.clause ?? null);
      }
    }
  });

  it("the retained fidelity denials are still denials, and still EXPECTED", () => {
    for (const command of RETAINED_FIDELITY_COMMANDS) {
      expect(expectations.get(command), command).toBe("retained-fidelity");
      const row = dualRunCommand(command, expectations);
      // SC3: a real or unresolved Bash disagreement stays a hard denial, and
      // the label must not be able to talk the gate out of that.
      expect(verdictTag(row), `${command} lost its denial`).toBe("vetoed");
      expect(row.oldVerdict, command).toBeNull();
      expect(row.class, command).toBe("EXPECTED");
      expect(row.clause, command).toBe("d");
    }
  });

  it("the mid-word join is the committed denial representative, and `echo\\ test` is gone", () => {
    const committed = committedCommands();
    expect(committed, "the retired representative is still a corpus row").not.toContain(
      RETIRED_DENIAL_REPRESENTATIVE
    );
    for (const command of RETAINED_FIDELITY_COMMANDS) {
      expect(committed, `${command} is not a committed corpus row`).toContain(
        command
      );
    }
    for (const command of SUPPORTED_BENIGN_COMMANDS) {
      expect(committed, `${command} is not a committed corpus row`).toContain(
        command
      );
    }
  });

  it("the roster is read as text: a label comes back whether or not the parse vetoes it", () => {
    // Independence, behaviorally: the loader returns the committed label for a
    // vetoed command and for an admitted one alike, so nothing in the label can
    // be a function of production behavior.
    const dir = freshTempDir("label-text");
    const roster = join(dir, EXPECTATIONS_FILENAME);
    writeFileSync(
      roster,
      [
        JSON.stringify({ command: RETAINED_MIDWORD_JOIN, expectation: "supported-benign" }),
        JSON.stringify({ command: "echo hi", expectation: "retained-fidelity" }),
        "",
      ].join("\n")
    );
    const loaded = loadExpectations(roster);
    expect(loaded.get(RETAINED_MIDWORD_JOIN)).toBe("supported-benign");
    expect(loaded.get("echo hi")).toBe("retained-fidelity");
    expect(verdictTag(dualRunCommand(RETAINED_MIDWORD_JOIN))).toBe("vetoed");
    expect(verdictTag(dualRunCommand("echo hi"))).toBe("ok");
    // Only the vetoed one flips, which is the veto's doing, not the label's.
    expect(dualRunCommand(RETAINED_MIDWORD_JOIN, loaded).class).toBe(
      "UNEXPECTED"
    );
    expect(dualRunCommand("echo hi", loaded).class).toBe("EXPECTED");
  });

  it("the real CLI run over the committed corpus: the class column follows the label, and the exit code follows the class column", async () => {
    const run = await runScript(["--corpus", corpusFile]);
    const fields = reportFields(run.out);
    const committed = readFileSync(corpusFile, "utf8")
      .split("\n")
      .filter((line) => line.length > 0).length;
    expect(fields.length, "one row per record").toBe(committed);

    let unexpected = 0;
    for (const [, , newVerdict, classColumn] of fields) {
      expect(classColumn.length, "the class column may not be empty").toBeGreaterThan(0);
      if (classColumn === "UNEXPECTED") {
        unexpected += 1;
        expect(
          newVerdict,
          "only a still-vetoed supported form may be UNEXPECTED"
        ).toBe("verdict=vetoed");
      }
    }
    expect(run.code, `exit ${run.code}; stdout: ${run.out}`).toBe(
      unexpected > 0 ? 1 : 0
    );

    // Every labeled row is present in the report, and stdout agrees with the
    // in-process classification of that same row. The class column is the tool's
    // own encoding of the class, so an admitted supported form reads
    // `expected-agree` and a retained denial reads `expected-d`.
    const pass = runDualPass(committedCommands(), expectations);
    for (const command of expectations.keys()) {
      const row = pass.rows.find((r) => r.command === command);
      if (row === undefined) {
        throw new Error(`${command} never reached the report`);
      }
      const printed = fields.find((f) => decodeReportField(f[0]) === command);
      expect(printed, `${command} is missing from stdout`).toBeTruthy();
      expect(printed, command).toEqual(formatReportRow(row).split("\t"));
    }
  }, 120_000);

  it("the accepted corpus — the committed rows minus the labeled supported forms — exits 0", async () => {
    const accepted = committedCommands().filter(
      (command) => !SUPPORTED_BENIGN_COMMANDS.includes(command)
    );
    expect(
      accepted.length,
      "the accepted corpus is empty: the assertion would be vacuous"
    ).toBeGreaterThan(40);
    const dir = freshTempDir("accepted");
    const file = join(dir, "accepted.jsonl");
    writeFileSync(
      file,
      accepted.map((command) => JSON.stringify({ command })).join("\n") + "\n"
    );
    const run = await runScript(["--corpus", file]);
    expect(run.code, `exit ${run.code}; stderr: ${run.err}`).toBe(0);
    const fields = reportFields(run.out);
    expect(fields.length).toBe(accepted.length);
    expect(
      fields.filter((f) => f[3] === "UNEXPECTED").map((f) => f[0]),
      "the accepted corpus carries a divergence"
    ).toEqual([]);
  }, 120_000);
});
