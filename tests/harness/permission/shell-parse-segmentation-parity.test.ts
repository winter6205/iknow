/**
 * Stage 4a shared-preparation parity battery (SC-S4-1 / SC-S4-2): the
 * segmentation facts published by
 * the `ok` payload (`operators[]`, `bareNewlineOffsets`,
 * `bareCarriageReturnOffsets`, `quotedSpans`) reproduce TODAY's segmentation
 * answers on the pinned populations, BEFORE any production caller moves.
 *
 * Population: the `DENIED` / `ALLOWED` / `NOT_THE_WALK_WALL` spelling lists
 * of `root-find-hard-wall.test.ts` (byte-copied here on purpose — those consts
 * are not exported and that file's expectations are not this battery's to
 * edit) plus the 421-command column of
 * `tests/fixtures/shell-divergence/stage2-differential.jsonl`.
 *
 * Method: the internal `text-segments.splitShellSegments` seam (the retired
 * `hard-walls` export, SC-S4-6) is the ORACLE — read
 * only, never modified — and every test-local segmentation here is a replica
 * that first proves itself against that oracle on the same population. The
 * prototypes below mirror what the moved consumers WILL compute from facts;
 * they ship nothing: production files still run their own code (SC-S4-1).
 *
 * Divergences are not hidden: every mismatch is an exactly-pinned row with
 * its class, and the classes are the ones the migration already licenses
 * (quote/comment-blind scan relaxations, the non-`ok` declarations of
 * `docs/shell-parse-non-ok-consumer-contracts.md`).
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

import { parseForSecurity } from "../../../src/harness/permission/shell-parse.js";
import type { SecurityParseOk } from "../../../src/harness/permission/shell-parse.js";
import { isAllowedCommand } from "../../../src/harness/permission/hard-walls.js";
import { splitShellSegments } from "../../../src/harness/permission/text-segments.js";
import {
  detectBashGrepSubstitution,
  GREP_FAMILY_TOKENS,
} from "../../../src/harness/aci/tools/role-substitution.js";
import {
  ReadonlyViolationError,
  validateReadonlyCommand,
} from "../../../src/harness/aci/tools/bash-readonly.js";

/* ---------- population ---------- */

/** Copied from `root-find-hard-wall.test.ts:45-125` — keep in step on edits there. */
const ROOT_FIND_DENIED: readonly string[] = [
  "find /", "find / -maxdepth 3", "find / -maxdepth 1", "find / -name x",
  "find / -type f -print", "find  /", "find / ", 'find "/"', "find '/'",
  "find //", "find / -maxdepth 3 -name '*.ts'", "find /tmp/.. -maxdepth 2",
  "find /./ -name x", "find /../ -maxdepth 1", "find -L / -maxdepth 2",
  "find -- / -maxdepth 1", "find -O2 / -maxdepth 1", "find -D tree / -maxdepth 1",
  "sudo find / -maxdepth 2", "env -i find / -maxdepth 1", "nohup find / -maxdepth 1",
  "sudo -u root find / -maxdepth 3", "sudo --user root find / -maxdepth 3",
  "sudo -uroot find / -maxdepth 3", "env -u HOME find / -maxdepth 3",
  "env --unset HOME find / -maxdepth 3", "timeout -s KILL 5 find / -maxdepth 3",
  "nice -n 5 find / -maxdepth 3", "stdbuf -o L find / -maxdepth 3",
  "setsid find / -maxdepth 3", "xargs find / -maxdepth 3",
  '"find" / -maxdepth 3', "'find' / -maxdepth 3", "cd / && find ./.. && ls",
  "cd / && find ../ && ls", "cd / && find ../.", "cd /tmp && find ..",
  "cd / && find ./.", "cd /home && find ..", "cd /usr && find ..", "find /*",
  "find /?", "cd / && find .", "cd /; find .", "cd / && find -maxdepth 2",
  'cd "/" && find .', "cd /tmp/.. && find .", "cd / && find . -name x",
  "cd -- / && find .", "cd -P / && find .", "cd /tmp && cd .. && find .",
  "cd /tmp && cd ./.. && find .", "cd / && cd /tmp && cd - && find .",
  "cd / && find", "cd / && find -name x", "echo go\ncd / && find .", "f\\ind /",
];

/** Copied from `root-find-hard-wall.test.ts:128-156`. */
const ROOT_FIND_ALLOWED: readonly string[] = [
  "find .", "find ..", "find . -name x", "find ./src -name '*.ts'",
  "find src -maxdepth 2", "find -maxdepth 2 ./src", "find /tmp",
  "find /tmp -maxdepth 2", "find /tmp -maxdepth 2 -name x", "find /home",
  "find /usr/share -maxdepth 1", "sudo find /tmp -maxdepth 1",
  "sudo -u root find /tmp -maxdepth 1", "env -u HOME find /usr/share -maxdepth 1",
  "cd / && ls", "cd / && head -1 /etc/hostname", "echo find /", "cat find",
  "which find", "find -maxdepth 1 /", "find -maxdepth 2 /tmp",
];

/** Copied from `root-find-hard-wall.test.ts:164-179`. */
const NOT_THE_WALK_WALL: readonly string[] = [
  "cd /tmp && find .", "cd /usr/share && find .", "cd ~ && find .",
  "cd && find .", "cd /tmp && find", "cd / && cd /tmp && find .",
  "cd / && cd /tmp && find", "cd / && cd ~ && find .", "cd / && cd $HOME && find .",
];

function corpusCommands(): string[] {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const fixture = join(
    repoRoot, "tests", "fixtures", "shell-divergence", "stage2-differential.jsonl"
  );
  const seen = new Set<string>();
  for (const line of readFileSync(fixture, "utf8").split("\n")) {
    if (line.length === 0) continue;
    seen.add((JSON.parse(line) as { command: string }).command);
  }
  return [...seen];
}

function population(): string[] {
  return [...new Set([
    ...ROOT_FIND_DENIED, ...ROOT_FIND_ALLOWED, ...NOT_THE_WALK_WALL,
    ...corpusCommands(),
  ])];
}

/** The four population shapes that carry no `ok` payload — the census pins them. */
const NON_OK_ROWS: ReadonlyMap<string, string> = new Map([
  ["[[ a == b ]]", "unknown-syntax"],
  ["echo hi &&", "malformed"],
  ["powershell -c Remove-Item -Recurse -Force C:\\", "malformed"],
  ["echo\\ test", "vetoed"],
]);

function okRows(): { command: string; ok: SecurityParseOk }[] {
  const rows: { command: string; ok: SecurityParseOk }[] = [];
  for (const command of population()) {
    const result = parseForSecurity(command);
    if (result.kind === "ok") {
      rows.push({ command, ok: result });
    } else {
      expect(
        NON_OK_ROWS.get(command),
        `non-ok row must be in the pinned census: ${JSON.stringify(command)}`
      ).toBe(result.kind);
    }
  }
  return rows;
}

/* ---------- boundary views ---------- */

/**
 * Replica of `splitShellSegments`' boundary walk, extended the way
 * `splitForDangerousScan` extends it (newline / CR end a segment too).
 * `replicaSegmentsMatchOracle` pins its fidelity to the exported oracle
 * before any claim built on it is graded.
 */
function scanBoundaries(text: string, includeLineBreaks: boolean): number[] {
  const out: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (includeLineBreaks && (ch === "\n" || ch === "\r")) {
      out.push(i);
      continue;
    }
    if (ch === "\\" && i + 1 < text.length) {
      i += 1;
      continue;
    }
    if (
      ch === ";" ||
      (ch === "&" && text[i + 1] === "&") ||
      (ch === "|" && text[i + 1] === "|") ||
      ch === "|"
    ) {
      out.push(i);
      if (text[i + 1] === ch) i += 1;
    }
  }
  return out;
}

function replicaSegments(text: string): string[] {
  const bounds = scanBoundaries(text, false);
  const pieces: string[] = [];
  let from = 0;
  for (const b of bounds) {
    pieces.push(text.slice(from, b));
    from = b + (text[b] === "|" || text[b] === ";" ? 1 : 2);
  }
  pieces.push(text.slice(from));
  return pieces.map((p) => p.trim()).filter((p) => p.length > 0);
}

/** The facts-derived boundary offsets: operator spans plus line breaks. */
function factsBoundaries(ok: SecurityParseOk): Map<number, string> {
  const out = new Map<number, string>();
  for (const op of ok.operators) out.set(op.span.start, op.kind);
  for (const offset of ok.bareNewlineOffsets) out.set(offset, "newline");
  for (const offset of ok.bareCarriageReturnOffsets) out.set(offset, "carriage");
  return out;
}

/**
 * Content the text splitter is quote-blind to: quoted sites, heredoc bodies,
 * comments. A splitter boundary inside one of these is a fabrication the
 * facts view declines to reproduce — the licensed class, made checkable.
 */
function protectedAt(ok: SecurityParseOk, offset: number): boolean {
  const spans = [
    ...ok.quotedSpans,
    ...ok.heredocs.map((h) => h.bodySpan),
    ...ok.inert.filter((i) => i.why === "comment").map((i) => i.span),
  ];
  return spans.some((s) => s.start <= offset && offset < s.end);
}

/* ---------- consumer-answer prototypes (pre-move demonstrations only) ---------- */

const COMPOUND_SCOPES = [
  "arithmetic_expansion", "case_statement", "c_style_for_statement",
  "compound_statement", "for_statement", "function_definition", "if_statement",
  "negated_command", "subshell", "test_command", "while_statement",
  "until_statement",
];

/**
 * The SC-S4-2 re-home answer: per-node allowlist membership (projected
 * through the exported `isAllowedCommand` on the first argv token, so no
 * second copy of the roster exists here), PLUS the second syntactic fact —
 * no bare newline / CR — PLUS the substitution / compound scopes today's
 * `(` `)` backtick metachars already refuse.
 */
function isAllowedFromFacts(ok: SecurityParseOk): boolean {
  if (ok.commands.length === 0) return false;
  if (ok.bareNewlineOffsets.length > 0) return false;
  if (ok.bareCarriageReturnOffsets.length > 0) return false;
  if (ok.substitutions.length > 0) return false;
  for (const scope of COMPOUND_SCOPES) {
    if ((ok.nodeTypes[scope] ?? 0) > 0) return false;
  }
  return ok.commands.every((command) => {
    const first = command.argv[0];
    if (first === undefined) return false;
    return isAllowedCommand(first.text.split(/\s+/)[0] ?? "");
  });
}

/**
 * The SC-S4-1 (1a)(1b)(1c) readonly strictenings as three named claims over
 * the facts — word text, owned redirect operators, background operators. No
 * whole-command `includes` fallback (forbidden by the spec: it would break
 * the pinned allow `ls && pwd`).
 */
function readonlyStrictenedByFacts(ok: SecurityParseOk): boolean {
  const wordMarks = ok.words.some(
    (word) => word.text.includes("&") || word.text.includes(">")
  );
  const ownedRedirect = ok.redirects.some((redirect) => redirect.op.includes(">"));
  const background = ok.operators.some((op) => op.kind === "background");
  return wordMarks || ownedRedirect || background;
}

/** Today's readonly strictenings, read off the oracle's segments. */
function readonlyStrictenedBySegments(command: string): boolean {
  return splitShellSegments(command).some(
    (segment) => segment.includes("&") || segment.includes(">")
  );
}

/**
 * The SC-S4-1 role-substitution scope: a command node that lives inside a
 * substitution site is a body and stays silent; a pipeline part is not.
 */
function grepFromFacts(ok: SecurityParseOk): string | undefined {
  const sites = ok.substitutions.map((site) => site.span);
  for (const command of ok.commands) {
    const insideSite = sites.some(
      (s) => s.start <= command.span.start && command.span.end <= s.end
    );
    if (insideSite) continue;
    const first = command.argv[0];
    if (first === undefined) continue;
    const token = basenameLower(first.text);
    if (GREP_FAMILY_TOKENS.includes(token)) return token;
  }
  return undefined;
}

function basenameLower(text: string): string {
  const word = text.trim().split(/\s+/)[0] ?? "";
  const slash = Math.max(word.lastIndexOf("/"), word.lastIndexOf("\\"));
  return (slash >= 0 ? word.slice(slash + 1) : word).toLowerCase();
}

/* ---------- the battery ---------- */

describe("the pinned population parses, and its non-ok rows are exactly the census", () => {
  it("carries 507 shapes of which only the four census rows are non-ok", () => {
    const rows = okRows();
    expect(population().length).toBe(507);
    expect(rows.length).toBe(503);
  });
});

describe("oracle fidelity: the boundary replica is the oracle", () => {
  it("replica segments equal splitShellSegments on every population row", () => {
    for (const { command } of okRows()) {
      expect(replicaSegments(command), JSON.stringify(command)).toEqual(
        splitShellSegments(command)
      );
    }
  });
});

describe("dangerous-scan segmentation parity (splitShellSegments, quote-blind arm)", () => {
  it("E1: every facts boundary is a splitter boundary, or a superset separator", () => {
    const superset = new Set(["background", "pipe-both", "newline", "carriage"]);
    for (const { command, ok } of okRows()) {
      const splitter = new Set(scanBoundaries(command, false));
      for (const [offset, kind] of factsBoundaries(ok)) {
        if (superset.has(kind)) continue;
        expect(splitter.has(offset), `${JSON.stringify(command)}@${offset}`).toBe(true);
      }
    }
  });

  it("E2: every splitter boundary is a facts boundary or a protected fabrication", () => {
    for (const { command, ok } of okRows()) {
      const facts = factsBoundaries(ok);
      for (const offset of scanBoundaries(command, false)) {
        if (facts.has(offset)) continue;
        expect(protectedAt(ok, offset), `${JSON.stringify(command)}@${offset}`).toBe(true);
      }
    }
  });

  it("newline-carried splitForDangerousScan boundaries are facts boundaries", () => {
    for (const { command, ok } of okRows()) {
      const facts = factsBoundaries(ok);
      for (const offset of scanBoundaries(command, true)) {
        if (protectedAt(ok, offset)) continue;
        expect(facts.has(offset), `${JSON.stringify(command)}@${offset}`).toBe(true);
      }
    }
  });
});

describe("declarative superset segmentation parity (SC-S4-3 separators)", () => {
  /**
   * Replica of declarative's private `splitCommandSegments` boundary walk:
   * splits on `;`/`&`/`|`/newline/CR char-by-char; a cut counts only when a
   * buffered character precedes it (the `&&` second `&` cuts nothing).
   */
  function declarativeCuts(text: string): number[] {
    const out: number[] = [];
    let hasBuf = false;
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i];
      if (ch === "\\" && i + 1 < text.length) {
        i += 1;
        hasBuf = true;
        continue;
      }
      if (ch === ";" || ch === "&" || ch === "|" || ch === "\n" || ch === "\r") {
        if (hasBuf) out.push(i);
        hasBuf = false;
        continue;
      }
      if (ch.trim().length > 0) hasBuf = true;
    }
    return out;
  }

  it("E1: every facts boundary is a declarative cut", () => {
    for (const { command, ok } of okRows()) {
      const cuts = new Set(declarativeCuts(command));
      for (const offset of factsBoundaries(ok).keys()) {
        expect(cuts.has(offset), `${JSON.stringify(command)}@${offset}`).toBe(true);
      }
    }
  });

  it("E2: every declarative cut is a facts boundary or a protected fabrication", () => {
    for (const { command, ok } of okRows()) {
      const facts = factsBoundaries(ok);
      for (const offset of declarativeCuts(command)) {
        if (facts.has(offset)) continue;
        expect(protectedAt(ok, offset), `${JSON.stringify(command)}@${offset}`).toBe(true);
      }
    }
  });
});

describe("isAllowedCommand re-home prototype vs today's answer", () => {
  /**
   * The four rows where the answers differ are all the same licensed class:
   * today's scan prices punctuation inside quoted or commented DATA as a
   * metachar (`(`, `)`, backtick), and the facts prove it inert. Deny-to-
   * silence on inert text is SC-S2-6's relaxation family, not a new allow of
   * executable syntax; each row is pinned, not waved through.
   */
  const EXPECTED_DIVERGENCE: ReadonlySet<string> = new Set([
    "echo '$(whoami)'",
    "echo '$(whoami) ${HOME} \\`id\\`'",
    "echo hi # $(whoami) ${HOME} not a command",
    'node -e \'require("child_process").execSync("rm -rf /")\'',
  ]);

  it("agrees everywhere except the pinned inert-punctuation rows", () => {
    const seen: string[] = [];
    for (const { command, ok } of okRows()) {
      if (isAllowedCommand(command) !== isAllowedFromFacts(ok)) {
        seen.push(command);
      }
    }
    expect(new Set(seen)).toEqual(EXPECTED_DIVERGENCE);
  });

  it("keeps the SC-S4-2 newline / CR deny pins on both sides", () => {
    for (const command of ["echo a\nls", "echo a\rb", "echo a\nrm -rf /"]) {
      const ok = parseForSecurity(command);
      expect(ok.kind).toBe("ok");
      expect(isAllowedCommand(command), command).toBe(false);
      expect(isAllowedFromFacts(ok as SecurityParseOk), command).toBe(false);
    }
  });

  it("answers the per-node re-home for the list shapes", () => {
    // `ls && pwd` stays allowlisted per node; `cd` and `find` are not, on
    // either carrier — the membership answer moves, the value does not.
    expect(isAllowedFromFacts(okPayloadOf("ls && pwd"))).toBe(true);
    expect(isAllowedCommand("ls && pwd")).toBe(true);
    expect(isAllowedFromFacts(okPayloadOf("cd / && find ."))).toBe(false);
    expect(isAllowedCommand("cd / && find .")).toBe(false);
  });
});

describe("role-substitution scope prototype vs today's recognition", () => {
  it("agrees on every population row, including the silent-body rule", () => {
    for (const { command, ok } of okRows()) {
      expect(grepFromFacts(ok), JSON.stringify(command)).toEqual(
        detectBashGrepSubstitution(command)
      );
    }
  });

  it("keeps the pipeline tail and refuses to see inside the substitution body", () => {
    expect(detectBashGrepSubstitution("cat f | grep x")).toBe("grep");
    expect(grepFromFacts(okPayloadOf("cat f | grep x"))).toBe("grep");
    expect(detectBashGrepSubstitution("echo $(grep x f)")).toBeUndefined();
    expect(grepFromFacts(okPayloadOf("echo $(grep x f)"))).toBeUndefined();
  });
});

describe("readonly strictening claims (1a/1b/1c) vs today's segment scan", () => {
  /**
   * The single pinned mismatch: `&` inside a QUOTED-DELIMITER HEREDOC BODY.
   * The body is data this parse does not tokenize, so no word, redirect, or
   * operator fact carries the mark — SC-S4-1 rule (1) sees no boundary there.
   * The shape stays denied upstream: the receiver is `python3`, its body is
   * code by SC-S2-1, and the fork-bomb inside rides `destructive-disk`
   * (SC-S2-8), so the wall pre-empts the readonly gate either way.
   */
  const EXPECTED_DIVERGENCE: ReadonlySet<string> = new Set([
    "python3 <<'EOF'\n:(){ :|:& };:\nEOF",
  ]);

  it("facts (1a/1b/1c) reject exactly what the segment scan rejects, modulo the pinned row", () => {
    const seen: string[] = [];
    for (const { command, ok } of okRows()) {
      if (
        readonlyStrictenedBySegments(command) !== readonlyStrictenedByFacts(ok)
      ) {
        seen.push(command);
      }
    }
    expect(new Set(seen)).toEqual(EXPECTED_DIVERGENCE);
  });

  it("throws in agreement with validateReadonlyCommand on the named spellings", () => {
    const rows: { command: string; throws: boolean }[] = [
      { command: "ls && pwd", throws: false },
      { command: "ls & pwd", throws: true },
      { command: "ls; echo done > log", throws: true },
      { command: "ls 2>&1", throws: true },
      { command: 'echo "a>b"', throws: true },
      { command: 'find . -name "-delete"', throws: false },
    ];
    for (const row of rows) {
      let actual = false;
      try {
        validateReadonlyCommand(row.command);
      } catch (fault) {
        expect(fault).toBeInstanceOf(ReadonlyViolationError);
        actual = true;
      }
      expect(actual, row.command).toBe(row.throws);
      expect(readonlyStrictenedByFacts(okPayloadOf(row.command)), row.command).toBe(
        row.throws
      );
    }
  });
});

function okPayloadOf(command: string): SecurityParseOk {
  const result = parseForSecurity(command);
  if (result.kind !== "ok") {
    throw new Error(`expected ok for ${JSON.stringify(command)}, got ${result.kind}`);
  }
  return result;
}
