/**
 * The #1188 battery for the narrowed `backslash-whitespace` roster: the
 * admitted surface, its real-bash argv agreement, the exemption EXIT, the
 * derived line-break facts, the degrade seam, and the retained diagnostics.
 *
 * The freeze is the point. #1188 moved the two arms in OPPOSITE directions, so
 * no single spelling can stand for the class any more: `a\ b` and `a \`+LF+` b`
 * are admitted while `a\`+LF+`b`, `a \\ b` and `$X\ b` stay hard-denied. Every
 * row below therefore names the spelling that decides it and why, and the
 * admitted rows are checked against a real `bash` argv rather than `bash -n` —
 * `bash -n` accepts every row in this file, denied ones included, which is
 * exactly why it cannot be the oracle (`specs/backslash-whitespace-veto-repair.md`
 * SC2).
 *
 * The `bashArgv` fields are measurements taken on this host through the NUL
 * probe below; recording them keeps each row falsifiable without re-deriving
 * the measurement by hand.
 *
 * READY-path only, with one exception: the SC5a describe imports a fresh
 * module instance through `vi.resetModules()`, because a load failure is
 * process-terminal and would destroy every other pin in this file.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, afterAll, afterEach, vi } from "vitest";

import {
  parseForSecurity,
  parserConstructionCountForTest,
  scanWithLegacyDegrade,
} from "../../../src/harness/permission/shell-parse.js";
import {
  findDangerousPattern,
  isAllowedCommand,
} from "../../../src/harness/permission/hard-walls.js";
import { createPermissionRuntime } from "../../../src/harness/permission/permission-executor.js";
import { createPermissionPolicy } from "../../../src/harness/permission/policy.js";
import { createSessionGrants } from "../../../src/harness/permission/session-grants.js";
import { createRegistry } from "../../../src/harness/tools/registry.js";
import type { SessionGrants } from "../../../src/harness/permission/session-grants.js";
import type { PermissionMode } from "../../../src/harness/permission/modes.js";
import type {
  LegacyDangerScan,
  ParseBindingLoader,
  SecurityParseOk,
  SecurityParseVetoed,
  VetoClass,
} from "../../../src/harness/permission/shell-parse.js";

/**
 * The permission layer treats a call as shell-bearing from the catalog entry's
 * `aci.category` and then reads `input.command` (policy.ts:168). A stand-in
 * carrying that metadata exercises the real gate and the real wall without
 * assembling the sandboxed tool — which `createBashTool` does, and which throws
 * on a CI runner without user namespaces.
 */
const SHELL_BEARING_DEF = {
  name: "bash",
  description: "stand-in carrying the shell-bearing catalog metadata",
  inputSchema: {
    type: "object",
    properties: { command: { type: "string" } },
  },
  aci: {
    category: "execute",
    isConcurrencySafe: false,
    interruptBehavior: "cancel",
  },
  // Unreachable by construction: the gate must return `blocked` for every row
  // driven through this def, and a dispatch would mean a retained shape had been
  // let through. It throws rather than returning, so a miss is loud.
  handler: () => {
    throw new Error("a retained shape reached execution");
  },
} as const;

const LF = "\n";
const CR = "\r";
const TAB = "\t";
const FF = "\f";
const VT = "\v";

/**
 * Spelled by code point rather than as an escape, so the file carries no
 * literal control or invisible bytes and a reviewer can see what it means.
 */
const BEL = String.fromCharCode(0x07);
const ESC = String.fromCharCode(0x1b);
const NBSP = String.fromCharCode(0xa0);
const ZWJ = String.fromCharCode(0x200d);

const SHELL_PARSE_MODULE = "../../../src/harness/permission/shell-parse.js";

/**
 * The argv oracle is a real spawn, so a host without `bash` on `PATH` skips
 * only the comparison cases; the outcome pins beside them still run.
 */
const BASH_RESOLVABLE =
  spawnSync("bash", ["--noprofile", "--norc", "-c", "exit 0"]).status === 0;

interface BashRun {
  readonly argv: readonly string[];
  readonly status: number | null;
}

/**
 * Real argv from a bounded fixed probe: one shell function prints its
 * arguments NUL-delimited, under a controlled environment so no profile, rc
 * file, locale or inherited variable can change the tokenization.
 */
function bashArgv(command: string): BashRun {
  const script = `probe() { printf '%s\\0' "$@"; }\nprobe ${command}`;
  const run = spawnSync("bash", ["--noprofile", "--norc", "-c", script], {
    cwd: probeCwd(),
    encoding: "utf8",
    env: { LANG: "C", PATH: "/usr/bin:/bin" },
  });
  const argv = run.stdout.split("\0");
  if (argv.at(-1) === "") {
    argv.pop();
  }
  return { argv, status: run.status };
}

/**
 * The probe splices each row verbatim into a script, and one retained row is a
 * redirection (`cat > a\ b`). Running in a scratch cwd keeps that redirect out
 * of the repository instead of dropping a file next to package.json.
 */
let probeCwdCache: string | null = null;
function probeCwd(): string {
  probeCwdCache ??= mkdtempSync(join(tmpdir(), "iknow-1188-probe-"));
  return probeCwdCache;
}

function okPayload(command: string): SecurityParseOk {
  const result = parseForSecurity(command);
  if (result.kind !== "ok") {
    throw new Error(
      `expected the ok arm for ${JSON.stringify(command)}, got ${JSON.stringify(result)}`
    );
  }
  return result;
}

function vetoPayload(command: string): SecurityParseVetoed {
  const result = parseForSecurity(command);
  if (result.kind !== "vetoed") {
    throw new Error(
      `expected the vetoed arm for ${JSON.stringify(command)}, got ${result.kind}`
    );
  }
  return result;
}

/**
 * The argv the facts claim, flattened across commands. A word without a
 * complete static value throws instead of degrading: an incomplete value is
 * precisely what the exemption must refuse, so it can never be papered over
 * into a comparison.
 */
function factArgv(ok: SecurityParseOk): readonly string[] {
  return ok.commands.flatMap((command) =>
    command.argv.map((word) => {
      if (word.value === undefined) {
        throw new Error(
          `incomplete static value at [${word.span.start},${word.span.end}) ${JSON.stringify(word.text)}`
        );
      }
      return word.value;
    })
  );
}

function constructionsAcross(call: () => void): number {
  const before = parserConstructionCountForTest();
  call();
  return parserConstructionCountForTest() - before;
}

interface Admission {
  /**
   * The roster clause that admits this spelling, in the frozen table's own
   * terms. Carried as data so a row can never lose its rationale silently.
   */
  readonly because: string;
  /** What real bash passed to the probe, measured on this host. */
  readonly bashArgv: readonly string[];
  readonly command: string;
}

const ADMITTED: readonly Admission[] = [
  {
    bashArgv: ["a b"],
    because:
      "escaped U+0020 inside a whole unquoted word whose static value is complete",
    command: "a\\ b",
  },
  {
    bashArgv: ["cat a.ts"],
    because: "escaped U+0020 inside a whole unquoted word, dotted operand",
    command: "cat\\ a.ts",
  },
  {
    bashArgv: ["ls", "-lt", "--time-style=+%m-%d %H:%M", "docs/evidence"],
    because:
      "the #1188 incident spelling: one escaped space inside one long option",
    command: "ls -lt --time-style=+%m-%d\\ %H:%M docs/evidence",
  },
  {
    bashArgv: ["grep", "x f"],
    because: "escaped U+0020 in a non-first operand word",
    command: "grep x\\ f",
  },
  {
    bashArgv: ["grep", "a\\ b"],
    because:
      "escaped U+0020 inside a standalone double-quoted word; bash keeps the backslash literal there",
    command: 'grep "a\\ b"',
  },
  {
    bashArgv: ["grep", "a\\ b"],
    because: "escaped U+0020 inside a standalone single-quoted word",
    command: "grep 'a\\ b'",
  },
  {
    bashArgv: ["a", "b"],
    because:
      "unquoted LF continuation with a space on each side: two words, no concatenation",
    command: `a \\${LF} b`,
  },
  {
    bashArgv: [
      "gh",
      "issue",
      "view",
      "1188",
      "--json",
      "number,title",
      "-q",
      ".title",
    ],
    because: "the #1188 incident continuation: an option split across the break",
    command: `gh issue view 1188 --json number,title \\${LF} -q '.title'`,
  },
  {
    bashArgv: ["printf", "x", "a", "b"],
    because: "unquoted LF continuation separating two operands of one command",
    command: `printf x a \\${LF} b`,
  },
];

interface RetainedRow {
  /** Why the row stayed on the hard-denial side of the freeze. */
  readonly because: string;
  /** What real bash did, where the measurement explains the retention. */
  readonly bashArgv?: readonly string[];
  readonly class: VetoClass;
  readonly command: string;
}

const RETAINED_BACKSLASH_WHITESPACE: readonly RetainedRow[] = [
  {
    bashArgv: ["ab"],
    because: "mid-word LF: bash joins the halves, so the word boundary is wrong",
    class: "backslash-whitespace",
    command: `a\\${LF}b`,
  },
  {
    bashArgv: ["ab"],
    because:
      "double-quoted LF: bash folds it away, so the quoted word's static value is wrong",
    class: "backslash-whitespace",
    command: `"a\\${LF}b"`,
  },
  {
    bashArgv: ["a\tb"],
    because: "backslash+TAB: bash keeps the backslash and emits a literal TAB",
    class: "backslash-whitespace",
    command: `a\\${TAB}b`,
  },
  {
    bashArgv: ["a\rb"],
    because: "backslash+CR: the CR is not a bash line continuation",
    class: "backslash-whitespace",
    command: `a\\${CR}b`,
  },
  {
    bashArgv: ["a\r"],
    because:
      "backslash+CRLF: bash ends the line at the CR and runs the rest as a command",
    class: "backslash-whitespace",
    command: `a\\${CR}${LF}b`,
  },
  {
    bashArgv: [" b"],
    because:
      "escaped space in a word that also holds an expansion: the static value is not complete",
    class: "backslash-whitespace",
    command: "$X\\ b",
  },
  {
    bashArgv: ["a\\ b c"],
    because:
      "concatenation across an escape: the word is an assembly, not a whole lexical word",
    class: "backslash-whitespace",
    command: '"a\\ b"\\ c',
  },
  {
    bashArgv: ["a\\ b"],
    because: "ANSI-C quoting: a different escaping language inside the same token",
    class: "backslash-whitespace",
    command: "$'a\\ b'",
  },
  {
    bashArgv: ["a", "\\", "b"],
    because:
      "EVEN backslash run before a space: the space is a real separator, so the shape is unproven",
    class: "backslash-whitespace",
    command: "a \\\\ b",
  },
  {
    bashArgv: ["a", "\\"],
    because:
      "EVEN backslash run before an LF: bash ends the line and runs the remainder separately",
    class: "backslash-whitespace",
    command: `a \\\\${LF} b`,
  },
  {
    bashArgv: ["a", "b"],
    because:
      "leading continuation: no space before the run, so the separator position is unproven",
    class: "backslash-whitespace",
    command: `\\${LF} a b`,
  },
  {
    bashArgv: ["a", "b"],
    because:
      "operator-adjacent continuation: no space after the LF, so it may join a word instead of separating two",
    class: "backslash-whitespace",
    command: `a \\${LF}b`,
  },
  {
    bashArgv: [],
    because:
      "escaped space in a redirect target: the target is a redirect fact, not an argv word",
    class: "backslash-whitespace",
    command: "cat > a\\ b",
  },
  {
    bashArgv: ["echo", "a"],
    because:
      "escaped space in a comment body: bash drops the comment, the fact view models it as inert, and the two are not reconciled here",
    class: "backslash-whitespace",
    command: "echo a # b\\ c",
  },
];

/**
 * `control-character` is ordered before `backslash-whitespace`, so these two
 * answer as the earlier class rather than as the escape shape they also carry.
 */
const RETAINED_CONTROL_CHARACTER: readonly RetainedRow[] = [
  {
    because:
      "backslash+FF: FF is a control character, and the class order pins it there",
    class: "control-character",
    command: `a\\${FF}b`,
  },
  {
    because:
      "backslash+VT: VT is a control character, and the class order pins it there",
    class: "control-character",
    command: `a\\${VT}b`,
  },
];

/**
 * SC6's named former-unsound shapes, split by the arm they now take. The
 * rewrite used to be carried in the veto reason, so the two halves are
 * different proofs: an admitted spelling produces no reason to inspect, and a
 * retained one produces a reason with nothing executable in it.
 */
const FORMER_REWRITE_ADMITTED: readonly {
  readonly command: string;
  readonly note: string;
}[] = [
  { command: "a\\ b", note: "the unsound space case" },
  { command: `a \\${LF} b`, note: "the line-continuation case" },
];

const FORMER_REWRITE_RETAINED: readonly {
  readonly command: string;
  readonly note: string;
}[] = [
  { command: "cat > a\\ b", note: "the redirection case" },
  { command: "echo a;\\ b", note: "the semicolon case" },
  { command: "echo a &&\\ b", note: "the `&&` case" },
  { command: `"a\\${LF}b"`, note: "the quoted-LF case" },
  { command: "$X\\ b", note: "the split-flag case" },
];

/**
 * A trailing backslash has no follower character, so it is not a
 * backslash-whitespace site at all: it reaches the parser and comes back
 * `malformed`. There is still no reason to carry a rewrite, which is the same
 * SC6 property by a different route.
 */
const FORMER_REWRITE_NO_SITE: readonly {
  readonly command: string;
  readonly note: string;
}[] = [
  { command: "echo a \\", note: "the trailing-continuation case" },
  { command: "a \\", note: "a bare trailing continuation" },
];

afterAll(() => {
  if (probeCwdCache !== null) {
    rmSync(probeCwdCache, { force: true, recursive: true });
  }
});

describe("SC1 — the two incident spellings reach ordinary permission handling", () => {
  it("answers the long-option escaped space and the option continuation ok, with the argv the incident expected", () => {
    const timeStyle = okPayload(
      "ls -lt --time-style=+%m-%d\\ %H:%M docs/evidence"
    );
    expect(timeStyle.commands).toHaveLength(1);
    expect(factArgv(timeStyle)).toEqual([
      "ls",
      "-lt",
      "--time-style=+%m-%d %H:%M",
      "docs/evidence",
    ]);

    const continuation = okPayload(
      `gh issue view 1188 --json number,title \\${LF} -q '.title'`
    );
    expect(continuation.commands).toHaveLength(1);
    expect(factArgv(continuation)).toEqual([
      "gh",
      "issue",
      "view",
      "1188",
      "--json",
      "number,title",
      "-q",
      ".title",
    ]);
  });

  it("admits every frozen spelling, each with a complete static value and no invented structure", () => {
    for (const row of ADMITTED) {
      const ok = okPayload(row.command);
      expect(ok.text, row.command).toBe(row.command);
      expect(ok.redirects, row.command).toEqual([]);
      expect(ok.operators, row.command).toEqual([]);
      for (const command of ok.commands) {
        for (const word of command.argv) {
          expect(word.value, `${row.command} ${word.text}`).toBeDefined();
        }
      }
    }
  });

  it("routes the admitted spellings through the ordinary parse path, not a bypass", () => {
    for (const row of ADMITTED) {
      // The seam answers `parsed` for everything that is not
      // `parser-unavailable`, so this arm is the ordinary route the admitted
      // spelling now takes.
      const outcome = scanWithLegacyDegrade(row.command, () => null);
      expect(outcome.kind, row.command).toBe("parsed");
      expect(outcome.degraded, row.command).toBe(false);
      if (outcome.kind === "parsed") {
        expect(outcome.result.kind, row.command).toBe("ok");
      }

      // Memoized like any other parse result: the same object back, and no
      // second parser. A denied verdict is never memoized, so this also shows
      // the admission produced a real parse rather than a short circuit.
      const first = okPayload(row.command);
      expect(
        constructionsAcross(() => {
          expect(parseForSecurity(row.command)).toBe(first);
        }),
        row.command
      ).toBe(0);
    }
  });
});

describe("SC2 — the admitted surface matches real bash argv", () => {
  it.skipIf(!BASH_RESOLVABLE)(
    "agrees with real bash on command count and every word value",
    () => {
      for (const row of ADMITTED) {
        const run = bashArgv(row.command);
        expect(run.status, row.command).toBe(0);
        const ok = okPayload(row.command);
        expect(ok.commands, row.command).toHaveLength(1);
        expect([...factArgv(ok)], row.command).toEqual([...row.bashArgv]);
        expect(factArgv(ok), row.command).toEqual([
          ...bashArgv(row.command).argv,
        ]);
      }
    }
  );

  it.skipIf(!BASH_RESOLVABLE)(
    "keeps a continuation two words, not one concatenated word",
    () => {
      expect(bashArgv(`a \\${LF} b`).argv).toEqual(["a", "b"]);
      const ok = okPayload(`a \\${LF} b`);
      expect(ok.commands).toHaveLength(1);
      expect(ok.commands[0]!.argv).toHaveLength(2);
      expect(ok.commands[0]!.argv.map((word) => word.value)).toEqual([
        "a",
        "b",
      ]);
    }
  );

  it("keeps every word span inside the verbatim source and slicing back to its own text", () => {
    for (const row of ADMITTED) {
      const ok = okPayload(row.command);
      for (const command of ok.commands) {
        expect(
          ok.text.slice(command.span.start, command.span.end),
          row.command
        ).not.toBe("");
        const starts: number[] = [];
        for (const word of command.argv) {
          expect(ok.text.slice(word.span.start, word.span.end), word.text).toBe(
            word.text
          );
          expect(word.span.end, word.text).toBeLessThanOrEqual(
            row.command.length
          );
          starts.push(word.span.start);
        }
        expect(starts, row.command).toEqual(
          [...starts].sort((left, right) => left - right)
        );
      }
    }
  });

  it.skipIf(!BASH_RESOLVABLE)(
    "draws the odd/even backslash-run line where bash draws it",
    () => {
      // An odd run escapes the space, so bash sees ONE word and the parse
      // agrees. An even run leaves the space a real separator, so bash sees
      // THREE words and the parse refuses rather than guessing which it meant.
      expect(bashArgv("a\\ b").argv).toEqual(["a b"]);
      expect(factArgv(okPayload("a\\ b"))).toEqual(["a b"]);
      expect(bashArgv("a \\\\ b").argv).toEqual(["a", "\\", "b"]);
      expect(vetoPayload("a \\\\ b").class).toBe("backslash-whitespace");
    }
  );

  it.skipIf(!BASH_RESOLVABLE)(
    "holds the quote and concatenation boundaries",
    () => {
      expect(bashArgv('grep "a\\ b"').argv).toEqual(["grep", "a\\ b"]);
      expect(bashArgv("grep 'a\\ b'").argv).toEqual(["grep", "a\\ b"]);
      expect(factArgv(okPayload('grep "a\\ b"'))).toEqual(["grep", "a\\ b"]);
      expect(factArgv(okPayload("grep 'a\\ b'"))).toEqual(["grep", "a\\ b"]);

      // A concatenation joins two differently-quoted fragments into one word,
      // so no single complete static value exists for the parse to compare.
      expect(bashArgv('"a\\ b"\\ c').argv).toEqual(["a\\ b c"]);
      expect(vetoPayload('"a\\ b"\\ c').class).toBe("backslash-whitespace");
    }
  );

  it.skipIf(!BASH_RESOLVABLE)(
    "keeps every unsupported case conservative, with bash's own answer on record",
    () => {
      for (const row of RETAINED_BACKSLASH_WHITESPACE) {
        if (row.bashArgv === undefined) {
          continue;
        }
        expect(bashArgv(row.command).argv, row.command).toEqual([
          ...row.bashArgv,
        ]);
        expect(vetoPayload(row.command).class, row.command).toBe(row.class);
      }
    }
  );
});

describe("SC2a — an incomplete exemption candidate keeps the hard denial", () => {
  it("refuses the mixed literal/expansion word whose value cannot be complete", () => {
    for (const command of ["$X\\ b", 'echo "a\\ b"$X', "$X\\ b c"]) {
      const verdict = vetoPayload(command);
      expect(verdict.class, command).toBe("backslash-whitespace");
      expect(verdict.reason, command).toContain("backslash-whitespace");
    }
  });

  it("refuses the ANSI-C and concatenation spellings for the same reason", () => {
    for (const command of ["$'a\\ b'", '"a\\ b"\\ c']) {
      expect(vetoPayload(command).class, command).toBe("backslash-whitespace");
    }
  });

  it("still models an unrelated expansion word with no escape site: the denial is site-local", () => {
    for (const command of ["echo $X b", "echo ${X} b", "ls -lt $STYLE docs"]) {
      const ok = okPayload(command);
      const expansion = ok.words.find((word) => word.text.startsWith("$"));
      expect(expansion, command).toBeDefined();
      // The dynamic word is the one with no static value; the denial above
      // comes from the ESCAPED SITE, never from expansions being present.
      expect(expansion?.value, command).toBeUndefined();
      expect(ok.expansions.length, command).toBeGreaterThan(0);
    }
  });

  it("does not demand a runtime value for the incident's own issue-number operand", () => {
    const ok = okPayload(
      `gh issue view 1188 --json number,title \\${LF} -q '.title'`
    );
    const number = ok.commands[0]!.argv[3]!;
    expect(number.text).toBe("1188");
    expect(number.value).toBe("1188");
  });

  it("refuses an exemption candidate whose parse lands on `unknown-syntax`", () => {
    // The EXIT is a conjunction, so a candidate whose parse settles on any
    // non-`ok` arm keeps the class-bearing veto. `unknown-syntax` is the one
    // reachable without a loader fault: the `regex` node is unmodelled, so the
    // facts never complete. The escaped-space site is provable, so the veto is
    // DEFERRED into the parse and then reinstated by the non-`ok` answer — the
    // public verdict is the veto, not the syntax arm.
    const candidate = `[[ $x =~ ^esc\\ space$ ]]`;
    const verdict = vetoPayload(candidate);
    expect(verdict.class).toBe("backslash-whitespace");
    expect(verdict.reason).toContain("backslash-whitespace");

    // The same test WITHOUT the escaped site stays a syntax arm, so the veto
    // above is the exemption EXIT firing and not the syntax rule itself.
    expect(parseForSecurity("[[ $x =~ ^esc-space$ ]]").kind).toBe(
      "unknown-syntax"
    );
  });
});

describe("SC3 — the retained shapes cannot reach execution, with an explicit outcome per follower", () => {
  it("denies every retained backslash-whitespace row with its class", () => {
    for (const row of RETAINED_BACKSLASH_WHITESPACE) {
      const verdict = vetoPayload(row.command);
      expect(verdict.class, row.command).toBe(row.class);
      expect(verdict.reason, row.command).toContain(row.class);
    }
  });

  it("denies backslash+FF and backslash+VT as `control-character`, pinning the class order", () => {
    for (const row of RETAINED_CONTROL_CHARACTER) {
      const verdict = vetoPayload(row.command);
      expect(verdict.class, row.command).toBe("control-character");
      // The escape shape is present, but the earlier class owns the answer.
      expect(verdict.reason, row.command).not.toContain("backslash-whitespace");
    }
  });

  it("answers SPACE, LF, TAB, CR, FF and VT explicitly, one outcome each", () => {
    const outcomes: Readonly<Record<string, string>> = {
      "CR": "vetoed",
      "CRLF": "vetoed",
      "FF": "vetoed",
      "LF, after an even backslash run": "vetoed",
      "LF, continuation between two words": "ok",
      "LF, mid-word": "vetoed",
      "SPACE, escaped beside an expansion": "vetoed",
      "SPACE, escaped in a whole word": "ok",
      "TAB": "vetoed",
      "VT": "vetoed",
    };
    const commands: Readonly<Record<string, string>> = {
      "CR": `a\\${CR}b`,
      "CRLF": `a\\${CR}${LF}b`,
      "FF": `a\\${FF}b`,
      "LF, after an even backslash run": `a \\\\${LF} b`,
      "LF, continuation between two words": `a \\${LF} b`,
      "LF, mid-word": `a\\${LF}b`,
      "SPACE, escaped beside an expansion": "$X\\ b",
      "SPACE, escaped in a whole word": "a\\ b",
      "TAB": `a\\${TAB}b`,
      "VT": `a\\${VT}b`,
    };
    expect(Object.keys(outcomes)).toHaveLength(10);
    for (const [label, kind] of Object.entries(outcomes)) {
      const command = commands[label];
      expect(command, label).toBeDefined();
      expect(parseForSecurity(command).kind, label).toBe(kind);
    }
  });

  it("leaves the control-character and Unicode vetoes exactly as they were", () => {
    for (const command of [`echo${BEL} bell`, `echo${ESC} ansi`]) {
      expect(vetoPayload(command).class, command).toBe("control-character");
    }
    for (const command of [`echo${NBSP} nbsp`, `echo${ZWJ} zwj`]) {
      expect(vetoPayload(command).class, command).toBe(
        "unicode-whitespace-or-zero-width"
      );
    }
  });
});

describe("a continuation inside a heredoc body settles on the body, not the word", () => {
  it("admits a benign body and models the body as inert rather than as a word", () => {
    const command = `cat <<'EOF'\nx \\${LF} y\nEOF`;
    const parsed = parseForSecurity(command);
    expect(parsed.kind).toBe("ok");
    if (parsed.kind !== "ok") return;
    // A heredoc body is receiver input, never argv, so the continuation inside
    // it produces no word and no bare-fact offset. Nothing the consumers read is
    // claimed from the body, which is why admitting the site is sound here.
    expect(parsed.words.map((word) => word.text)).toEqual(["cat"]);
    expect(parsed.heredocs).toHaveLength(1);
    expect(parsed.inert.map((span) => span.why)).toEqual(["heredoc-body"]);
    // The line break after the heredoc header is a real statement boundary and
    // must still be published.
    expect(parsed.bareNewlineOffsets).toEqual([11]);
    // Real bash agrees: the body is receiver input, so `cat` is the only
    // argument and the continuation inside the body adds nothing to argv.
    expect(bashArgv(`cat <<'EOF'\nx \\${LF} y\nEOF`).argv).toEqual(["cat"]);
  });

  it("still denies a destructive body when an interpreter reads it as code", () => {
    // The body is data to `cat` but code to `bash`, and the wall recurses into it
    // either way. This is the case a heredoc exemption could have smuggled.
    for (const command of [
      `bash <<EOF\nrm -rf \\${LF} /\nEOF`,
      `bash <<'EOF'\nrm -rf \\${LF} /\nEOF`,
    ]) {
      const parsed = parseForSecurity(command);
      expect(parsed.kind, command).toBe("ok");
      expect(findDangerousPattern(command)?.id, command).toBe("destructive-rm");
      expect(isAllowedCommand(command), command).toBe(false);
    }
  });
});

describe("SC3 — a retained shape stays denied in every mode and under a blanket session grant", () => {
  // A rule that matches every bash call and allows it. A fidelity denial must
  // survive it: the roster is a hard wall, and CONTEXT defines a matched deny as
  // something a session grant cannot override.
  const blanketGrant = (): SessionGrants => {
    const grants = createSessionGrants();
    grants.add({
      id: "blanket-allow",
      match: () => true,
      decision: "allow",
      reason: "blanket allow from the test",
    });
    return grants;
  };

  const gateFor = (session: SessionGrants, mode: PermissionMode) => {
    const runtime = createPermissionRuntime({
      inner: { executeAll: async () => [] },
      registry: createRegistry([SHELL_BEARING_DEF]),
      policy: createPermissionPolicy({ mode, session }),
      askUser: async () => true,
      isDiscovered: () => true,
      discover: () => undefined,
    });
    return runtime.gateOne;
  };

  for (const mode of ["default", "full_auto"] as const) {
    it(`denies a retained shape in ${mode} mode with a blanket session grant`, async () => {
      const gateOne = gateFor(blanketGrant(), mode);
      for (const row of RETAINED_BACKSLASH_WHITESPACE) {
        const gate = await gateOne(
          { id: `g-${mode}`, name: "bash", input: { command: row.command } },
          undefined
        );
        expect(gate.kind, `${row.command} @ ${mode}`).toBe("blocked");
      }
    });
  }

  it("denies the same shape once the grant is removed, so the grant is what was probed", async () => {
    const gateOne = gateFor(createSessionGrants(), "full_auto");
    for (const row of RETAINED_BACKSLASH_WHITESPACE) {
      const gate = await gateOne(
        { id: "g-none", name: "bash", input: { command: row.command } },
        undefined
      );
      expect(gate.kind, row.command).toBe("blocked");
    }
  });
});

describe("SC4 — the derived line-break facts agree with the escape parity", () => {
  it("omits an admitted escaped LF, and keeps the same LF bare once the escape is removed", () => {
    const escaped = okPayload(`a \\${LF} b`);
    expect(escaped.bareNewlineOffsets).toEqual([]);
    // The two texts differ by exactly one backslash and the bare-fact answer
    // flips, so the parity rule — not a blanket newline exemption — is what
    // produced the empty list.
    const genuine = okPayload(`a ${LF} b`);
    expect(genuine.bareNewlineOffsets).toEqual([2]);
    expect(escaped.text[3]).toBe(LF);
    expect(genuine.text[2]).toBe(LF);
  });

  it("keeps a genuine unquoted LF and a genuine CR present as bare facts", () => {
    expect(okPayload("echo a\nls").bareNewlineOffsets).toEqual([6]);
    expect(okPayload("echo a\rb").bareCarriageReturnOffsets).toEqual([6]);
    expect(okPayload("echo a\rb").bareNewlineOffsets).toEqual([]);
  });

  it("leaves the quoted spans' line breaks exempt exactly as before", () => {
    for (const command of ['echo "a\nb"', "echo 'a\nb'", "echo $'a\nb'"]) {
      const ok = okPayload(command);
      expect(ok.quotedSpans.length, command).toBeGreaterThan(0);
      expect(ok.bareNewlineOffsets, command).toEqual([]);
      expect(ok.bareCarriageReturnOffsets, command).toEqual([]);
    }
  });

  it("leaves the heredoc body exempt and the opener's own break bare", () => {
    const ok = okPayload("cat <<'EOF'\nx\nEOF");
    expect(ok.heredocs).toHaveLength(1);
    expect(ok.bareNewlineOffsets).toEqual([11]);
  });

  it("excludes the escaped LF for every admitted continuation shape", () => {
    const continuations = ADMITTED.filter((entry) =>
      entry.command.includes(LF)
    );
    expect(continuations.length).toBe(3);
    for (const row of continuations) {
      const ok = okPayload(row.command);
      expect(ok.bareNewlineOffsets, row.command).toEqual([]);
      expect(ok.bareCarriageReturnOffsets, row.command).toEqual([]);
    }
  });

  it("makes the even-run and CR parity directions unobservable by refusing them first", () => {
    // SC4 asks for the parity rule in both directions, and only the
    // odd-parity direction is observable through the public entry: EVERY
    // command whose text puts a backslash immediately before an LF or a CR is
    // settled `vetoed` at the pre-parse arm UNLESS it is the one admitted
    // separating continuation. So no `ok` payload can carry any other such
    // line break, and the "an even run is still a bare fact" arm is dead
    // under the current roster. These cases pin the refusal that makes it
    // dead, so the gap stays visible instead of being asserted away.
    const unreachable: readonly string[] = [
      `a\\${LF}b`,
      `\\${LF} a b`,
      `a \\${LF}b`,
      `"a\\${LF}b"`,
      `a\\${CR}b`,
      `a\\${CR}${LF}b`,
      `a \\\\${CR}b`,
      `a \\\\${LF} b`,
    ];
    expect(new Set(unreachable).size).toBe(unreachable.length);
    for (const command of unreachable) {
      expect(parseForSecurity(command).kind, JSON.stringify(command)).toBe(
        "vetoed"
      );
    }
    // A backslash run followed by any other character is not a site at all, so
    // the veto probe never fires and a genuine line break beside it stays
    // bare: this is the control that shows the refusal above is site-local.
    const control = okPayload("a \\\\b\nc");
    expect(control.bareNewlineOffsets).toEqual([5]);
  });
});

describe("SC5a — a binding load that never succeeded keeps the hard denial", () => {
  /**
   * The loader is only consulted while the foundation is un-READY, and the
   * module instance this file imports is READY from the describes above, so the
   * terminal state has to be built on a fresh instance. `vi.resetModules()`
   * gives one, with its own module-scoped `activeBinding`, `foundationState`
   * and memo; the loader is handed back afterwards so nothing leaks.
   */
  async function terminalGraph(): Promise<{
    readonly parse: (command: string) => ReturnType<typeof parseForSecurity>;
    readonly seam: (
      command: string,
      legacyScan: LegacyDangerScan
    ) => ReturnType<typeof scanWithLegacyDegrade>;
  }> {
    vi.doUnmock(SHELL_PARSE_MODULE);
    vi.resetModules();
    const mod = await import(SHELL_PARSE_MODULE);
    const failing: ParseBindingLoader = () => {
      throw new Error("forced load failure for the #1188 degrade case");
    };
    mod.setBindingLoaderForTest(failing);
    return {
      parse: mod.parseForSecurity,
      seam: (command, legacyScan) =>
        mod.scanWithLegacyDegrade(command, legacyScan),
    };
  }

  afterEach(() => {
    vi.doUnmock(SHELL_PARSE_MODULE);
    vi.resetModules();
  });

  it("denies the harmless admitted spellings at the PARSE arm, not at the legacy scanner", async () => {
    const graph = await terminalGraph();
    const rows: readonly { readonly command: string; readonly note: string }[] = [
      {
        command: "ls -lt --time-style=+%m-%d\\ %H:%M docs/evidence",
        note: "harmless incident spelling 1",
      },
      {
        command: `gh issue view 1188 --json number,title \\${LF} -q '.title'`,
        note: "harmless incident spelling 2",
      },
      { command: "echo a\\ b", note: "harmless escaped space" },
      { command: `a \\${LF} b`, note: "harmless continuation" },
    ];
    for (const row of rows) {
      const verdict = graph.parse(row.command);
      expect(verdict.kind, row.note).toBe("vetoed");
      if (verdict.kind !== "vetoed") {
        throw new Error(`expected vetoed, got ${verdict.kind}`);
      }
      expect(verdict.class, row.note).toBe("backslash-whitespace");

      // A scanner returning `null` is the proof the denial is not the legacy
      // route: had the legacy scan denied, the arm would be `legacy-clean` and
      // the parse verdict would be `parser-unavailable`.
      const outcome = graph.seam(row.command, () => null);
      expect(outcome.kind, row.note).toBe("parsed");
      expect(outcome.degraded, row.note).toBe(false);
      if (outcome.kind !== "parsed") {
        throw new Error(`expected parsed, got ${outcome.kind}`);
      }
      expect(outcome.result.kind, row.note).toBe("vetoed");
      if (outcome.result.kind !== "vetoed") {
        throw new Error(`expected vetoed, got ${outcome.result.kind}`);
      }
      expect(outcome.result.class, row.note).toBe("backslash-whitespace");
    }
  });

  it("denies the split destructive flag and the sensitive operand at the PARSE arm too", async () => {
    const graph = await terminalGraph();
    // Synthetic harmless stand-ins for the two shapes the criterion names: a
    // destructive flag split by the escape, and a sensitive path split by it.
    // Nothing here is ever executed; the parse is the only thing that runs.
    const rows = [
      "rm -r\\ f /tmp/iknow-1188-probe",
      "echo > /etc/pas\\ swd",
    ];
    for (const command of rows) {
      const verdict = graph.parse(command);
      expect(verdict.kind, command).toBe("vetoed");
      if (verdict.kind !== "vetoed") {
        throw new Error(`expected vetoed, got ${verdict.kind}`);
      }
      expect(verdict.class, command).toBe("backslash-whitespace");
      expect(graph.seam(command, () => null).kind, command).toBe("parsed");
    }
  });

  it("answers the first call and the terminal-state call the same way", async () => {
    const graph = await terminalGraph();
    for (const [label, verdict] of [
      ["first", graph.parse(`a \\${LF} b`)],
      ["second", graph.parse(`a \\${LF} b`)],
    ] as const) {
      expect(verdict.kind, label).toBe("vetoed");
      if (verdict.kind !== "vetoed") {
        throw new Error(`expected vetoed, got ${verdict.kind}`);
      }
      expect(verdict.class, label).toBe("backslash-whitespace");
    }
  });

  it("keeps the legacy route for an ordinary command outside the exemption surface", async () => {
    const graph = await terminalGraph();
    const command = "echo iknow-1188-ordinary";
    expect(graph.parse(command).kind).toBe("parser-unavailable");

    const clean = graph.seam(command, () => null);
    expect(clean.kind).toBe("legacy-clean");
    expect(clean.degraded).toBe(true);

    const hit = graph.seam("rm -rf /", () => ({
      id: "destructive-rm",
      pattern: "rm -rf",
    }));
    expect(hit.kind).toBe("legacy-hit");
  });
});

describe("SC6 — the retained diagnostic names the limitation and no rewritten command", () => {
  it("carries the class token and the bash limitation for every retained escape row", () => {
    for (const row of RETAINED_BACKSLASH_WHITESPACE) {
      const verdict = vetoPayload(row.command);
      expect(verdict.reason, row.command).toContain(row.class);
      expect(verdict.reason, row.command).toContain("bash");
      // The limitation is named as a list of refused shapes, not as advice.
      expect(verdict.reason, row.command).toContain("不一致");
      expect(verdict.reason, row.command).toContain("硬拒");
    }
  });

  it("carries the class token for the control-character rows, whose reason names no bash comparison", () => {
    // The class order hands these to `control-character`, whose diagnostic is
    // about the character itself; the bash-limitation clause belongs only to
    // the escape class, and asserting it here would be asserting a fact about
    // a different reason than the one this arm returns.
    for (const row of RETAINED_CONTROL_CHARACTER) {
      const verdict = vetoPayload(row.command);
      expect(verdict.reason, row.command).toContain("control-character");
      expect(verdict.reason, row.command).toContain("硬拒");
      expect(verdict.reason, row.command).not.toContain("例如");
    }
  });

  it("produces no diagnostic at all for the admitted former-rewrite examples", () => {
    for (const entry of FORMER_REWRITE_ADMITTED) {
      const verdict = parseForSecurity(entry.command);
      expect(verdict.kind, entry.note).toBe("ok");
      // No `reason` field exists on the `ok` arm, so there is no surface a
      // rewrite could have been carried in.
      expect(
        Object.prototype.hasOwnProperty.call(verdict, "reason"),
        entry.note
      ).toBe(false);
    }
  });

  it("carries no reconstructed command in any retained former-rewrite example", () => {
    for (const entry of FORMER_REWRITE_RETAINED) {
      const verdict = vetoPayload(entry.command);
      expect(verdict.class, entry.note).toBe("backslash-whitespace");
      // A reconstruction always quotes something, so the absence of any ASCII
      // quote character in the reason is the structural proof, beside the
      // absence of the old `例如 <rewritten>` marker and of the command bytes.
      expect(verdict.reason, entry.note).not.toContain("例如");
      expect(verdict.reason, entry.note).not.toContain(entry.command);
      expect(verdict.reason, entry.note).not.toContain('"');
      expect(verdict.reason, entry.note).not.toContain("'");
    }
  });

  it("carries no rewrite for a trailing backslash either, which is not a site at all", () => {
    for (const entry of FORMER_REWRITE_NO_SITE) {
      const verdict = parseForSecurity(entry.command);
      expect(verdict.kind, entry.note).toBe("malformed");
      if (verdict.kind !== "malformed") {
        throw new Error(`expected malformed, got ${verdict.kind}`);
      }
      expect(verdict.reason, entry.note).not.toContain("例如");
      expect(verdict.reason, entry.note).not.toContain('"');
    }
  });

  it("keeps the reason byte-identical across commands of the same class", () => {
    const first = vetoPayload(`a\\${LF}b`);
    const second = vetoPayload("cat > a\\ b");
    expect(second.reason).toBe(first.reason);
    expect(vetoPayload(`a\\${FF}b`).reason).not.toBe(first.reason);
  });
});
