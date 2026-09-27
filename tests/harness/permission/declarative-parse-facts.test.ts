/**
 * tests/harness/permission/declarative-parse-facts.test.ts
 *
 * SC-S4-3 measurement battery (ticket T25): pairwise segmentation over
 * `splitCommandSegments`' population — the command column of
 * `tests/fixtures/shell-divergence/stage2-differential.jsonl` plus every
 * bash command literal of `declarative-rules.test.ts` — comparing:
 *
 *  1. the SHIPPED derivation (facts arm ∪ quote-blind char arm, as
 *     implemented in `declarative.ts#splitCommandSegments`), against the
 *     verbatim old char scan;
 *  2. the PURE-FACTS arm (what a quote-aware rewrite would have shipped),
 *     against the old char scan — the "wider boundaries measured before
 *     T26" numbers of SC-S4-3.
 *
 * Headline counts (pinned below): shipped vs old = {same: 446,
 * widened-boundaries: 0, dropped-boundaries: 0} over the 446 `ok` rows;
 * pure-facts vs old = {same: 407, widened-boundaries: 0,
 * dropped-boundaries: 39}, where the 39 are 33 rows whose SEGMENT STRINGS
 * widen (every dropped boundary is a fabrication inside a quoted span, a
 * heredoc body, or a comment — the class the consumer contract licenses as
 * quote-blindness, and the class whose removal could flip a rule MATCH from
 * no-match to match, e.g. `Bash(echo:*)` allow on
 * `echo "a; rm -rf /" x`) and 6 rows where only the offset SET differs (the
 * second character of a multi-char operator token is a scan no-op that
 * changes no segment).
 *
 * Method follows `shell-parse-segmentation-parity.test.ts`: the replicas
 * here are test-local; the first pin proves the offset-slice replica is
 * byte-identical to the verbatim old scan before any claim rides on it.
 * Production behavior is graded through the real
 * `compileDeclarativePermissions` API in the last block, and by
 * `declarative-rules.test.ts` staying green unchanged.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

import { parseForSecurity } from "../../../src/harness/permission/shell-parse.js";
import type { SecurityParseOk } from "../../../src/harness/permission/shell-parse.js";
import { compileDeclarativePermissions } from "../../../src/harness/permission/declarative.js";

/* ---------- population ---------- */

/**
 * Copied from `declarative-rules.test.ts` (every bash `command` literal and
 * the `it.each` wrapper table) — that file's consts are not exported; keep
 * in step on edits there, the same convention as the parity battery's
 * `ROOT_FIND_*` copies. Includes the SC-S4-3 pins appended to that file.
 */
const DECLARATIVE_COMMAND_LITERALS: readonly string[] = [
  "git status",
  "git status -sb",
  "git status && rm -rf /tmp/x",
  "lsof",
  "rm -rf /",
  "echo hi",
  "timeout 30 git status",
  "time git status",
  "nice git status",
  "nice -n 10 git status",
  "nohup git status",
  "stdbuf -o0 git status",
  "command git status",
  "builtin git status",
  "noglob git status",
  "xargs git status",
  "git status; rm -rf /",
  "git status | rm -rf /",
  "git status |& rm -rf /",
  "git status & rm -rf /",
  "git status\nrm -rf /",
  "git status -sb && git diff",
  "git commit --force",
  "echo hi",
  "x",
  "y;z",
  "network:true",
  "curl x",
  // SC-S4-3 pins appended to declarative-rules.test.ts:
  'echo "a; rm -rf /" x',
  "echo\\;hi",
  "git status\rrm -rf /",
  'git "status; rm',
];

function corpusCommands(): string[] {
  const repoRoot = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
  );
  const fixture = join(
    repoRoot,
    "tests",
    "fixtures",
    "shell-divergence",
    "stage2-differential.jsonl",
  );
  const seen = new Set<string>();
  for (const line of readFileSync(fixture, "utf8").split("\n")) {
    if (line.length === 0) continue;
    seen.add((JSON.parse(line) as { command: string }).command);
  }
  return [...seen];
}

function population(): string[] {
  return [
    ...new Set([
      ...corpusCommands(),
      ...DECLARATIVE_COMMAND_LITERALS,
    ]),
  ];
}

/** The population shapes that carry no `ok` payload — the degrade census. */
const NON_OK_ROWS: ReadonlyMap<string, string> = new Map([
  ["[[ a == b ]]", "unknown-syntax"],
  ["echo hi &&", "malformed"],
  ["powershell -c Remove-Item -Recurse -Force C:\\", "malformed"],
  ["echo\\ test", "vetoed"],
  ['git "status; rm', "malformed"],
]);

/* ---------- replicas of the two segmenters ---------- */

/** The verbatim pre-T25 `splitCommandSegments`, read-only oracle. */
function oldScanSegments(command: string): string[] {
  const segments: string[] = [];
  let buf = "";
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]!;
    if (ch === "\\" && i + 1 < command.length) {
      buf += ch + command[i + 1]!;
      i += 1;
      continue;
    }
    if (ch === ";" || ch === "&" || ch === "|" || ch === "\n" || ch === "\r") {
      if (buf.length > 0) segments.push(buf);
      buf = "";
      continue;
    }
    buf += ch;
  }
  if (buf.length > 0) segments.push(buf);
  return segments.map((s) => s.trim()).filter((s) => s.length > 0);
}

/** Replica of `declarative.ts#quoteBlindCutOffsets`. */
function scanCutOffsets(command: string): Set<number> {
  const cuts = new Set<number>();
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]!;
    if (ch === "\\" && i + 1 < command.length) {
      i += 1;
      continue;
    }
    if (ch === ";" || ch === "&" || ch === "|" || ch === "\n" || ch === "\r") {
      cuts.add(i);
    }
  }
  return cuts;
}

/** Replica of `declarative.ts#sliceAtCutOffsets`. */
function sliceAtCuts(command: string, cuts: ReadonlySet<number>): string[] {
  const segments: string[] = [];
  let from = 0;
  for (const cut of [...cuts].sort((a, b) => a - b)) {
    segments.push(command.slice(from, cut));
    from = cut + 1;
  }
  segments.push(command.slice(from));
  return segments.map((s) => s.trim()).filter((s) => s.length > 0);
}

/** The shipped ok-arm: facts starts ∪ quote-blind char cuts. */
function shippedSegments(ok: SecurityParseOk, command: string): string[] {
  const cuts = scanCutOffsets(command);
  for (const operator of ok.operators) cuts.add(operator.span.start);
  for (const offset of ok.bareNewlineOffsets) cuts.add(offset);
  for (const offset of ok.bareCarriageReturnOffsets) cuts.add(offset);
  return sliceAtCuts(command, cuts);
}

interface Boundary {
  readonly start: number;
  readonly end: number;
}

/** The pure-facts arm (quote-aware): operator spans + bare line breaks. */
function factsBoundaries(ok: SecurityParseOk): Boundary[] {
  const bounds: Boundary[] = [];
  for (const operator of ok.operators) bounds.push(operator.span);
  for (const offset of ok.bareNewlineOffsets) {
    bounds.push({ start: offset, end: offset + 1 });
  }
  for (const offset of ok.bareCarriageReturnOffsets) {
    bounds.push({ start: offset, end: offset + 1 });
  }
  return bounds;
}

function sliceAtBoundaries(command: string, bounds: Boundary[]): string[] {
  const segments: string[] = [];
  let from = 0;
  for (const b of [...bounds].sort((x, y) => x.start - y.start)) {
    if (b.start < from) continue;
    segments.push(command.slice(from, b.start));
    from = b.end;
  }
  segments.push(command.slice(from));
  return segments.map((s) => s.trim()).filter((s) => s.length > 0);
}

function factsOnlySegments(ok: SecurityParseOk, command: string): string[] {
  return sliceAtBoundaries(command, factsBoundaries(ok));
}

/**
 * Content the char scan is quote-blind to and the facts arm protects away:
 * quoted spans, heredoc bodies, comments.
 */
function protectedAt(ok: SecurityParseOk, offset: number): boolean {
  const spans = [
    ...ok.quotedSpans,
    ...ok.heredocs.map((h) => h.bodySpan),
    ...ok.inert.filter((i) => i.why === "comment").map((i) => i.span),
  ];
  return spans.some((s) => s.start <= offset && offset < s.end);
}

function okRows(): { command: string; ok: SecurityParseOk }[] {
  const rows: { command: string; ok: SecurityParseOk }[] = [];
  for (const command of population()) {
    const result = parseForSecurity(command);
    if (result.kind === "ok") {
      rows.push({ command, ok: result });
    } else {
      expect(
        NON_OK_ROWS.get(command),
        `non-ok row must be in the pinned census: ${JSON.stringify(command)}`,
      ).toBe(result.kind);
    }
  }
  return rows;
}

/* ---------- the battery ---------- */

describe("replica fidelity: the offset-slice arm is the verbatim scan", () => {
  it("sliceAtCuts(scanCutOffsets) equals the old scan on every row", () => {
    for (const command of population()) {
      expect(
        sliceAtCuts(command, scanCutOffsets(command)),
        JSON.stringify(command),
      ).toEqual(oldScanSegments(command));
    }
  });
});

describe("shipped derivation vs the old char scan (SC-S4-3 move)", () => {
  it("is byte-identical: {same: 446, widened-boundaries: 0, dropped-boundaries: 0}", () => {
    const rows = okRows();
    expect(rows.length).toBe(446);
    let same = 0;
    let widened = 0;
    let dropped = 0;
    for (const { command, ok } of rows) {
      const oldCuts = scanCutOffsets(command);
      const shippedCuts = new Set(oldCuts);
      for (const b of factsBoundaries(ok)) shippedCuts.add(b.start);
      if (shippedCuts.size > oldCuts.size) widened += 1;
      else if (shippedCuts.size < oldCuts.size) dropped += 1;
      expect(
        shippedSegments(ok, command),
        JSON.stringify(command),
      ).toEqual(oldScanSegments(command));
      if (shippedCuts.size === oldCuts.size) same += 1;
    }
    // Every facts boundary is also a literal scan cut, so the union can
    // neither widen nor drop a boundary: no shape can flip a rule MATCH in
    // either direction. Non-ok rows (the 5 census entries) degrade to the
    // scan verbatim inside production `splitCommandSegments`.
    expect({ okRows: rows.length, same, widenedBoundaries: widened, droppedBoundaries: dropped }).toEqual({
      okRows: 446,
      same: 446,
      widenedBoundaries: 0,
      droppedBoundaries: 0,
    });
  });
});

describe("pure-facts arm vs the old scan — T26 measurement", () => {
  /**
   * The 33 rows whose segment STRINGS widen under a quote-aware (pure
   * facts) derivation: every dropped boundary is a char-scan fabrication
   * inside a quoted span, a heredoc body, or a comment. Warrant:
   * `docs/shell-parse-non-ok-consumer-contracts.md` ("declarative.ts rule
   * matching — fail toward no match": a separator inside quotes makes the
   * rule miss, never a silent grant). Shipping the pure-facts arm would
   * turn e.g. the `Bash(echo:*)` no-match on `echo "a; rm -rf /" x` into a
   * MATCH (a denial-of-match → allow flip for an allow rule), so T25 keeps
   * the quote-blind arm; each row is pinned, not waved through.
   */
  const SEG_SHAPE_DIVERGENCE: readonly string[] = [
    "cat <<'EOF'\n$(whoami)\nEOF",
    "cat <<'EOF'\nrm -rf /\nEOF",
    "python3 -c \"import os; os.system('rm -rf /tmp/z')\"",
    "sudo bash <<'EOF'\nrm -rf /tmp/x\nEOF",
    "python3 - <<'EOF'\nprint($(rm -rf /))\nEOF",
    "cat <<'EOF'\n$(whoami) ${ANTHROPIC_AUTH_TOKEN} `id`\nEOF",
    "cmd /c 'echo one & echo two'",
    "bash -c 'echo one & echo two'",
    "docker exec -i c sh <<'EOF'\nrm -rf /tmp/x\nEOF",
    "python3 <<EOF\nrm -rf /tmp/x\nEOF",
    "python3 <<'EOF'\nos.system('rm -rf /tmp/x')\nEOF",
    "sudo python3 <<'EOF'\nrm -rf /tmp/x\nEOF",
    "cat <<'EOF'\nrm -rf /tmp/x\nEOF",
    "cat <<EOF\nrm -rf /tmp/x\nEOF",
    "powershell <<'EOF'\ndel /f x.txt\nEOF",
    "cat <<'EOF'\nhello\nEOF",
    "cat sh <<'EOF'\nrm -rf /tmp/x\nEOF",
    "python3 <<'EOF'\nrm -rf /tmp/x\nEOF",
    "docker exec -i c sh <<'EOF'\ncat /etc/passwd\nEOF",
    "cd /tmp && cat <<'EOF'\nrm -rf /tmp/x\nEOF",
    "cd /tmp && cat <<'EOF'\nid_rsa\nEOF",
    "if true; then cat <<'EOF'\nrm -rf /tmp/x\nEOF\nfi",
    "FOO=1 <<'EOF'\nrm -rf /tmp/x\nEOF",
    "FOO=1 <<'EOF'\nid_rsa\nEOF",
    "echo a | cat <<'EOF'\nrm -rf /tmp/x\nEOF",
    "{ true; } <<'EOF'\nrm -rf /tmp/x\nEOF",
    "bash -c ':(){ :|:& };:'",
    "eval ':(){ :|:& };:'",
    "python3 <<'EOF'\n:(){ :|:& };:\nEOF",
    "cat <<'EOF'\nid_rsa\nEOF",
    "cat <<'EOF'\n/etc/passwd\nEOF",
    "python3 <<'EOF'\nopen('/etc/passwd').read()\nEOF",
    'echo "a; rm -rf /" x',
  ];

  /**
   * The 6 rows where only the offset SET differs — the scan records the
   * second character of `&&` / `|&` / `||` as a (no-op) cut the facts arm
   * expresses as one token span. Segment strings are identical, so no rule
   * match can differ; pinned so a future facts change shows up loudly.
   */
  const BOUNDARY_ONLY_DIVERGENCE: readonly string[] = [
    "echo a && rm -rf /",
    "echo hi && :(){ :|:& };:",
    "echo a > /tmp/x.pem && notify",
    "git status && rm -rf /tmp/x",
    "git status |& rm -rf /",
    "git status -sb && git diff",
  ];

  it("widened-boundaries = 0: every facts boundary is a scan cut", () => {
    for (const { command, ok } of okRows()) {
      const cuts = scanCutOffsets(command);
      for (const b of factsBoundaries(ok)) {
        expect(cuts.has(b.start), `${JSON.stringify(command)}@${b.start}`).toBe(
          true,
        );
      }
    }
  });

  it("dropped-boundaries = 39, exactly the pinned rows, each a licensed class", () => {
    const segShape = new Set<string>();
    const boundaryOnly = new Set<string>();
    for (const { command, ok } of okRows()) {
      const starts = new Set(factsBoundaries(ok).map((b) => b.start));
      const missing = [...scanCutOffsets(command)].filter(
        (o) => !starts.has(o),
      );
      if (missing.length === 0) continue;
      for (const offset of missing) {
        const secondOperatorChar = starts.has(offset - 1);
        expect(
          protectedAt(ok, offset) || secondOperatorChar,
          `${JSON.stringify(command)}@${offset}`,
        ).toBe(true);
      }
      if (
        JSON.stringify(factsOnlySegments(ok, command)) ===
        JSON.stringify(oldScanSegments(command))
      ) {
        boundaryOnly.add(command);
      } else {
        segShape.add(command);
      }
    }
    expect([...segShape].sort()).toEqual(
      [...SEG_SHAPE_DIVERGENCE].sort(),
      "segment-shape divergences",
    );
    expect([...boundaryOnly].sort()).toEqual(
      [...BOUNDARY_ONLY_DIVERGENCE].sort(),
      "boundary-only divergences",
    );
  });

  it("the counts feed T26: {same: 407, widened: 0, dropped: 39}", () => {
    let same = 0;
    let widened = 0;
    let dropped = 0;
    for (const { command, ok } of okRows()) {
      const starts = new Set(factsBoundaries(ok).map((b) => b.start));
      const cuts = scanCutOffsets(command);
      const extra = [...starts].some((o) => !cuts.has(o));
      const missing = [...cuts].some((o) => !starts.has(o));
      if (extra) widened += 1;
      else if (missing) dropped += 1;
      else same += 1;
    }
    expect({ same, widened, dropped }).toEqual({
      same: 407,
      widened: 0,
      dropped: 39,
    });
  });
});

describe("production rule matching through the real API", () => {
  function bashRule(specifier: string) {
    const rules = compileDeclarativePermissions(
      { allow: [`Bash(${specifier})`] },
      { workRoot: "/w" },
    );
    return (command: string) =>
      rules[0]!.match({ tool: "bash", input: { command } });
  }

  it("keeps the quote-blind no-match on the pinned fabrication rows", () => {
    const echo = bashRule("echo:*");
    // The scan fabricated `echo "a` / `rm -rf /" x`; the second segment
    // refuses to match, so the allow rule stays a no-match — and the
    // shipped facts path keeps that answer (it does NOT match the wide
    // single segment a quote-aware derivation would have produced).
    expect(echo('echo "a; rm -rf /" x')).toBe(false);
    expect(echo("cmd /c 'echo one & echo two'")).toBe(false);
    expect(echo("bash -c 'echo one & echo two'")).toBe(false);
    const cat = bashRule("cat:*");
    expect(cat("cat <<'EOF'\nrm -rf /\nEOF")).toBe(false);
    expect(cat("{ true; } <<'EOF'\nrm -rf /tmp/x\nEOF")).toBe(false);
  });

  it("keeps the degrade arm's scan answer on the census rows", () => {
    const git = bashRule("git *");
    // malformed (unclosed quote): the scan cuts on the in-quote `;`, so the
    // fabricated `rm` segment refuses the wide `git *` allow.
    expect(git('git "status; rm')).toBe(false);
  });
});
