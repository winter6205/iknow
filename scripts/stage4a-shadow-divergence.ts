#!/usr/bin/env npx tsx
/**
 * SC-S4-7 shadow divergence (Stage 4a, plan row T26). Dual-runs one
 * command-shape corpus through the PRE-migration consumers (stage3 tip
 * c5058d76f — all four consumers on text segmentation) and through the
 * working tree, diffing EXACTLY the four Stage-4 decision inputs:
 *
 *   1. `validateReadonlyCommand` — "allow" vs. "deny:<ReadonlyViolationError
 *      message>" (verbatim message in the value);
 *   2. `extractSingleReadPath` — the recorded read path or null (the
 *      last-read ledger, ADR-0084);
 *   3. `detectBashGrepSubstitution` — the returned token or null (the
 *      替岗拒绝 refusal, ADR-0117);
 *   4. `declarative.ts` rule matching — matched / not matched, per rule, for
 *      a small fixed rule set mirrored from
 *      `tests/harness/permission/declarative-rules.test.ts` (compound
 *      `Bash(git status:*)` included).
 *
 * Each row is tagged `same`, `expected-relaxation` (only with a named
 * warrant from WARRANTS below), `fixed`, or `open`. BINARIES (SC-S4-7): zero
 * rows tagged `open`; zero deny→silence rows (a pre-4a deny, refusal, or
 * ledger record that went silent post-4a) without one of the named warrants.
 * Exit 0 iff both hold. The full row set is written to
 * `tests/fixtures/shell-divergence/stage4a-shadow.jsonl`; the test
 * `tests/harness/permission/shadow-divergence-stage4a.test.ts` replays the
 * committed fixture (POST side only — this script is the one that reads PRE).
 *
 * Corpus: the 421-command column of
 * `tests/fixtures/shell-divergence/stage2-differential.jsonl` + each file's
 * pinned lists (snapshots of `root-find-hard-wall.test.ts`
 * DENIED/ALLOWED/NOT_THE_WALK_WALL, taken at f81eb8f33) + ~100 adversarial
 * shapes drafted from the T22 parity battery's populations
 * (`shell-parse-segmentation-parity.test.ts`: the non-ok census rows, the
 * compound-scope roster, quote/comment/heredoc boundary shapes, substitution
 * bodies, pipeline tails, wrapper and prefix-assignment leads, statement
 * scopes, and per-consumer redirect/background/ledger shapes). The 64 KiB+
 * over-cap shapes exercise the perf battery's exclusion count instead of the
 * shadow fixture: they would add ~0.5 MB of repeated bytes per row and carry
 * no extra consumer signal over the pinned `vetoed` / `malformed` /
 * `unknown-syntax` rows already present.
 *
 * Corpus input is inert text. Nothing here executes a command: there is no
 * child process and no shell invocation in this file at all — the PRE side
 * is reached by IMPORT only.
 *
 * PRE materialization (one-time, run in the shell OUTSIDE this script; the
 * script refuses to start with a clear message when the mirror is absent):
 *
 *   PRE=/tmp/iknow-stage4a-shadow/pre
 *   mkdir -p "$PRE"
 *   git -C ~/projects/iknow-shell-s4a archive c5058d76f src/ | tar -x -C "$PRE"
 *   printf '{"type":"module"}\n' > "$PRE/package.json"
 *   ln -s ~/projects/iknow-shell-s4a/node_modules "$PRE/node_modules"
 *
 * Usage: npx tsx scripts/stage4a-shadow-divergence.ts [--out <path>]
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  extractSingleReadPath as postExtractSingleReadPath,
} from "../src/harness/aci/tools/bash-read-extract.js";
import {
  validateReadonlyCommand as postValidateReadonlyCommand,
} from "../src/harness/aci/tools/bash-readonly.js";
import {
  detectBashGrepSubstitution as postDetectBashGrepSubstitution,
} from "../src/harness/aci/tools/role-substitution.js";
import { compileDeclarativePermissions as postCompile } from "../src/harness/permission/declarative.js";
import {
  parseForSecurity,
  type SecurityParseResult,
} from "../src/harness/permission/shell-parse.js";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The pinned PRE revision: stage3 tip, all four consumers on text segments. */
export const PRE_REV = "c5058d76f";

/** Where the `git archive` PRE mirror lives (see header for setup). */
export const PRE_DIR =
  process.env.STAGE4A_PRE_DIR ?? join(tmpdir(), "iknow-stage4a-shadow", "pre");

export const DEFAULT_OUT = join(
  REPO_ROOT,
  "tests",
  "fixtures",
  "shell-divergence",
  "stage4a-shadow.jsonl"
);

/* -------------------------------------------------------------------------- */
/* Vocabulary                                                                  */
/* -------------------------------------------------------------------------- */

export type ShadowOutput = "readonly" | "readpath" | "grep" | "declarative";

export type ShadowLabel =
  | "same"
  | "expected-relaxation"
  | "fixed"
  | "open";

export interface ShadowRow {
  readonly command: string;
  readonly output: ShadowOutput;
  /** Rule specifier, on `declarative` rows only. */
  readonly rule?: string;
  readonly pre: string | boolean | null;
  readonly post: string | boolean | null;
  readonly label: ShadowLabel;
  /** Named warrant; required exactly on `expected-relaxation` rows. */
  readonly warrant?: string;
  /** Owning cause on `fixed` rows. */
  readonly cause?: string;
}

/**
 * The admitted warrants, closed set (SC-S4-7): the three SC-S2-6 relaxation
 * classes, the SC-S4-1 non-`ok` declarations (with the registered
 * `unknown-syntax`-then-approved role-substitution silence citing ADR-0117's
 * 不是 hard-wall scope), and Stage-0 unmodellability. Any other string on a
 * relaxation row is a prose appeal and scores `open`.
 */
export const WARRANTS = Object.freeze({
  class1: "SC-S2-6 class (1) destructive inert-span relaxation (SC-S2-1)",
  class2: "SC-S2-6 class (2) sensitive-path comment / proven inert heredoc-body relaxation (SC-S2-7)",
  class3: "SC-S2-6 class (3) dangerous-looking operand relaxation, positively proven inert (SC-S2-9)",
  nonOk: (kind: string): string =>
    `SC-S4-1 non-ok declaration: parse is \`${kind}\`, the consumer's declared non-ok answer applies (docs/shell-parse-non-ok-consumer-contracts.md)`,
  roleSubUnknownSyntax:
    "ADR-0117 不是 hard-wall scope: registered unknown-syntax-then-user-approved role-substitution silence (SC-S4-1, SC-S4-7)",
  unmodelled: "the item is unmodelled in Stage 0",
  /**
   * The contract-doc bullet warrant (T26 mission list): for
   * `extractSingleReadPath` specifically, silence is never a lost protection
   * — "a ledger record is an affordance, not a refusal, so recording
   * nothing is always the stricter side"
   * (docs/shell-parse-non-ok-consumer-contracts.md). Admitted only on the
   * newline-blind-misrecord class proven at `labelRow`.
   */
  ledgerAffordance:
    "docs/shell-parse-non-ok-consumer-contracts.md extractSingleReadPath bullet: a ledger record is an affordance, not a refusal — recording nothing is the stricter side; newline-blind PRE misrecord removed by parse facts (bash-read-extract.test.ts:87/:851 pin the moved semantics)",
} as const);

const NON_OK_KINDS: ReadonlySet<string> = new Set([
  "unknown-syntax",
  "malformed",
  "aborted",
  "over-cap",
  "parser-unavailable",
  "vetoed",
]);

/* -------------------------------------------------------------------------- */
/* Corpus                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Snapshot (taken at f81eb8f33) of the pinned lists in
 * `tests/harness/permission/root-find-hard-wall.test.ts` — 57 DENIED,
 * 21 ALLOWED, 9 NOT_THE_WALK_WALL. The generator embeds the snapshot so a
 * concurrent test-file edit cannot change the corpus under its own run; the
 * committed fixture carries the rows, the replay test carries the assertion.
 */
const PINNED_ROOT_FIND_DENIED: ReadonlyArray<string> = Object.freeze([
  "find /",
  "find / -maxdepth 3",
  "find / -maxdepth 1",
  "find / -name x",
  "find / -type f -print",
  "find  /",
  "find / ",
  'find "/"',
  "find '/'",
  "find //",
  "find / -maxdepth 3 -name '*.ts'",
  "find /tmp/.. -maxdepth 2",
  "find /./ -name x",
  "find /../ -maxdepth 1",
  "find -L / -maxdepth 2",
  "find -- / -maxdepth 1",
  "find -O2 / -maxdepth 1",
  "find -D tree / -maxdepth 1",
  "sudo find / -maxdepth 2",
  "env -i find / -maxdepth 1",
  "nohup find / -maxdepth 1",
  "sudo -u root find / -maxdepth 3",
  "sudo --user root find / -maxdepth 3",
  "sudo -uroot find / -maxdepth 3",
  "env -u HOME find / -maxdepth 3",
  "env --unset HOME find / -maxdepth 3",
  "timeout -s KILL 5 find / -maxdepth 3",
  "nice -n 5 find / -maxdepth 3",
  "stdbuf -o L find / -maxdepth 3",
  "setsid find / -maxdepth 1",
  "xargs find / -maxdepth 3",
  '"find" / -maxdepth 3',
  "'find' / -maxdepth 3",
  "cd / && find ./.. && ls",
  "cd / && find ../ && ls",
  "cd / && find ../.",
  "cd /tmp && find ..",
  "cd / && find ./.",
  "cd /home && find ..",
  "cd /usr && find ..",
  "find /*",
  "find /?",
  "cd / && find .",
  "cd /; find .",
  "cd / && find -maxdepth 2",
  'cd "/" && find .',
  "cd /tmp/.. && find .",
  "cd / && find . -name x",
  "cd -- / && find .",
  "cd -P / && find .",
  "cd /tmp && cd .. && find .",
  "cd /tmp && cd ./.. && find .",
  "cd / && cd /tmp && cd - && find .",
  "cd / && find",
  "cd / && find -name x",
  "echo go\ncd / && find .",
  "f\\ind /",
]);

const PINNED_ROOT_FIND_ALLOWED: ReadonlyArray<string> = Object.freeze([
  "find .",
  "find ..",
  "find . -name x",
  "find ./src -name '*.ts'",
  "find src -maxdepth 2",
  "find -maxdepth 2 ./src",
  "find /tmp",
  "find /tmp -maxdepth 2",
  "find /tmp -maxdepth 2 -name x",
  "find /home",
  "find /usr/share -maxdepth 1",
  "sudo find /tmp -maxdepth 1",
  "sudo -u root find /tmp -maxdepth 1",
  "env -u HOME find /usr/share -maxdepth 1",
  "cd / && ls",
  "cd / && head -1 /etc/hostname",
  "echo find /",
  "cat find",
  "which find",
  "find -maxdepth 1 /",
  "find -maxdepth 2 /tmp",
]);

const PINNED_NOT_THE_WALK_WALL: ReadonlyArray<string> = Object.freeze([
  "cd /tmp && find .",
  "cd /usr/share && find .",
  "cd ~ && find .",
  "cd && find .",
  "cd /tmp && find",
  "cd / && cd /tmp && find .",
  "cd / && cd /tmp && find",
  "cd / && cd ~ && find .",
  "cd / && cd $HOME && find .",
]);

/**
 * ~100 adversarial shapes drafted from the T22 parity battery's populations:
 * the non-ok census rows (shell-parse-segmentation-parity.test.ts
 * `NON_OK_ROWS`), the `COMPOUND_SCOPES` roster, quote/comment/heredoc
 * boundary shapes, substitution bodies vs. pipeline tails, wrapper and
 * prefix-assignment leads, and per-consumer redirect / background /
 * single-read / `git status:*`-rule shapes.
 */
const ADVERSARIAL: ReadonlyArray<string> = Object.freeze([
  // role-substitution population: segment-leading grep, pipeline tails,
  // substitution bodies, statement scopes, wrapper and assignment leads
  "echo a\ngrep pattern f",
  "cd /tmp\ngrep x f",
  "grep x f\necho done",
  "echo $(grep x f)",
  "echo `grep x f`",
  "cat f | grep x",
  "grep x f && echo done",
  "echo hi; grep -r foo .",
  "if grep -q x f; then echo y; fi",
  "while read l; do grep $l f; done",
  "for f in a b; do rg x $f; done",
  "sudo grep x f",
  "env FOO=1 grep x f",
  "GREP=1 grep x f",
  "egrep x f",
  "fgrep x f",
  "rg pattern src",
  "grep",
  "echo 'grep x f'",
  'echo "grep x f"',
  "cat <<EOF\ngrep x f\nEOF",
  "cat << 'EOF'\ngrep x f\nEOF",
  "# grep x f\necho hi",
  "echo hi && grep x f",
  "x=1\ngrep y f",
  "echo a | { grep x; }",
  "(grep x f)",
  "case $1 in a) grep x f;; esac",
  "! grep -q x f",
  "time grep x f",
  "command grep x f",
  // readonly population: background, redirects, quoted flags, compound
  // scopes, and the four non-ok census spellings
  "echo a & ls",
  "cat file.txt &",
  "ls; echo test > /tmp/x",
  "echo hi > out.txt",
  "echo hi >> out.txt",
  "cat < in.txt",
  "true && cat /etc/hostname",
  "printf '%s\\n' hi",
  "echo\\ test",
  "[[ a == b ]]",
  "for f in *.txt; do cat $f; done",
  "sort -o out in",
  "find . -delete",
  "git status",
  "git add x",
  "git commit -m msg",
  "ls -la ~/.iknow 2>/dev/null; echo ---; ls | head -30",
  "",
  "   ",
  "echo hi &&",
  'echo "x',
  "powershell -c Remove-Item -Recurse -Force C:\\",
  "case x in a|b)",
  "echo a\rb",
  "echo 'rm -rf /'",
  "echo a > '/etc/passwd'",
  "ls | head -30 && echo --- && ls -1 /tmp",
  "sed -n 1,10p file.txt",
  "awk '{print $1}' file.txt",
  "wc -l < file.txt",
  "du -sh . | head -1",
  "git log --oneline -5 | cat",
  "cd /tmp && ls",
  "PAGER=cat git status",
  "git --no-pager status",
  "touch newfile",
  "rm file",
  "mkdir -p a/b",
  "chmod +x script.sh",
  "echo $HOME",
  "echo ${BASH_VERSION}",
  "echo a;b",
  "echo a || echo b",
  "echo a |& cat",
  "nohup sleep 1 &",
  "sleep 0.1 & wait",
  "(cd sub && pwd); echo done",
  "if test -f a; then cat a; fi",
  "test -f a && cat a",
  "trap 'echo x' EXIT",
  "echo {a,b}",
  "echo *.ts",
  // ledger population: single-read shapes, globs, redirect arms,
  // substitution bodies, statement scopes
  "cat f | wc -l",
  "cat a b",
  "cat notes.md",
  "head -n 5 notes.txt",
  "cat *.md",
  "less file.txt",
  "sort f",
  "tail -f log",
  "cat f; echo done",
  "cat -",
  "cat -- file.txt",
  "nl file.txt",
  "cat file.txt 2>/dev/null",
  "cat \"notes.md\"",
  "cat 'a b.txt'",
  "cat $HOME/x",
  "cat $(pwd)/x",
  "cat\nf",
  "cat f\n",
  "\ncat f",
  "cat f;",
  "  cat f  ",
  "cat ./*",
  "cat f | cat",
  "echo $(cat f)",
  "cat 'unclosed",
  "cat f # trailing",
  // declarative population: the compound git rule's own boundary shapes
  "git status > /tmp/x",
  "git status ;",
  "git 'status'",
  '"git" status',
  "git status --porcelain=1 | cat",
  "GIT_DIR=. git status",
  "git -c core.pager=cat status --short",
  "(cd repo && git status)",
  "if true; then git status; fi",
  "git status # comment",
  "echo 'a;b;c' && git status",
  "git status &",
  "rm -rf x; git status",
  "git status\ngit diff",
  "git diff HEAD~1..HEAD",
  "echo $(git status)",
  "echo `git status`",
  "git commit -m 'status'",
  "git push origin main",
  "git push --force-with-lease",
  "echo hello && ls -1",
]);

export function corpusCommands(): string[] {
  const fixture = join(
    REPO_ROOT,
    "tests",
    "fixtures",
    "shell-divergence",
    "stage2-differential.jsonl"
  );
  const seen: string[] = [];
  const dedupe = new Set<string>();
  for (const line of readFileSync(fixture, "utf8").split("\n")) {
    if (line.length === 0) continue;
    const command = (JSON.parse(line) as { command: string }).command;
    if (dedupe.has(command)) continue;
    dedupe.add(command);
    seen.push(command);
  }
  const all = [
    ...PINNED_ROOT_FIND_DENIED,
    ...PINNED_ROOT_FIND_ALLOWED,
    ...PINNED_NOT_THE_WALK_WALL,
    ...seen,
    ...ADVERSARIAL,
  ];
  return [...new Set(all)];
}

/* -------------------------------------------------------------------------- */
/* Rule set (mirrors tests/harness/permission/declarative-rules.test.ts)       */
/* -------------------------------------------------------------------------- */

/**
 * Small fixed rule set, deny section (a matched deny rule is the visible
 * decision), with the exact specifier literals the declarative-rules test
 * pins: the compound `Bash(git status:*)` (whose "compound requires all
 * segments" boundary is its named case), the `:*` tail, `Bash(git *)`, and
 * the space form `Bash(ls *)` with its token-boundary case.
 */
export const RULE_SET: Readonly<{ deny: readonly string[] }> = Object.freeze({
  deny: Object.freeze([
    "Bash(git status:*)",
    "Bash(ls:*)",
    "Bash(git *)",
    "Bash(ls *)",
  ] as const),
});

const COMPILE_OPTS = Object.freeze({
  workRoot: "/w",
  // Fixed anchor, never os.homedir(): the run must not read ~/.iknow or any
  // real HOME surface (the `~/` expansion path is irrelevant to the Bash
  // rules here, and pinning it keeps the dual run environment-free).
  home: "/stage4a-shadow-anchor",
  onWarn: (): void => undefined,
});

/* -------------------------------------------------------------------------- */
/* PRE graph import                                                            */
/* -------------------------------------------------------------------------- */

interface ShadowGraph {
  readonly validateReadonlyCommand: (command: string) => void;
  readonly extractSingleReadPath: (command: string) => string | undefined;
  readonly detectBashGrepSubstitution: (command: string) => string | undefined;
  readonly compile: typeof postCompile;
}

async function loadGraph(dir: string): Promise<ShadowGraph> {
  const at = (p: string): string => pathToFileURL(join(dir, p)).href;
  const ro = (await import(at("src/harness/aci/tools/bash-readonly.js"))) as {
    validateReadonlyCommand: (command: string) => void;
  };
  const rp = (await import(at("src/harness/aci/tools/bash-read-extract.js"))) as {
    extractSingleReadPath: (command: string) => string | undefined;
  };
  const gs = (await import(at("src/harness/aci/tools/role-substitution.js"))) as {
    detectBashGrepSubstitution: (command: string) => string | undefined;
  };
  const decl = (await import(at("src/harness/permission/declarative.js"))) as {
    compileDeclarativePermissions: typeof postCompile;
  };
  return {
    validateReadonlyCommand: ro.validateReadonlyCommand,
    extractSingleReadPath: rp.extractSingleReadPath,
    detectBashGrepSubstitution: gs.detectBashGrepSubstitution,
    compile: decl.compileDeclarativePermissions,
  };
}

/* -------------------------------------------------------------------------- */
/* Four outputs                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The readonly output value for one command and graph arm: `"allow"` or
 * `deny:<message>`. Shared with the SC-S4-7 replay test so the POST replay
 * reads the generator's own predicate, never a copy.
 */
export function readonlyValue(
  fn: (command: string) => void,
  command: string
): string {
  try {
    fn(command);
    return "allow";
  } catch (error) {
    return `deny:${(error as Error).message}`;
  }
}

interface RuleMatchers {
  readonly specifiers: ReadonlyArray<string>;
  readonly matches: (command: string) => boolean[];
}

function ruleMatchers(
  compile: typeof postCompile,
  specifiers: ReadonlyArray<string>
): RuleMatchers {
  const rules = compile({ deny: specifiers }, COMPILE_OPTS);
  return {
    specifiers,
    matches: (command: string): boolean[] =>
      rules.map((rule) => rule.match({ tool: "bash", input: { command } })),
  };
}

/* -------------------------------------------------------------------------- */
/* Labeling                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Is this row a deny-to-silence pair (pre-4a deny / refusal / ledger record,
 * post-4a silence)? Shared with the SC-S4-7 replay test (binary 2) so the
 * assertion reads the generator's own predicate, never a copy.
 */
export function isDenyToSilence(row: Omit<ShadowRow, "label">): boolean {
  switch (row.output) {
    case "readonly":
      return (
        typeof row.pre === "string" &&
        row.pre.startsWith("deny") &&
        row.post === "allow"
      );
    case "readpath":
    case "grep":
      return row.pre !== null && row.post === null;
    case "declarative":
      return row.pre === true && row.post === false;
  }
}

type OkParse = Extract<SecurityParseResult, { kind: "ok" }>;

/** Positive proof for the inert-span classes: the refusal token the PRE text
 * scan led on sits, on the POST `ok` facts, strictly inside a quoted span,
 * a comment, or a heredoc body (`inert` facts). Returns null when unproven —
 * an absence never licenses a relaxation. */
function inertSpanWarrant(ok: OkParse, token: string): string | null {
  const idx = ok.text.indexOf(token);
  if (idx < 0) return null;
  const end = idx + token.length;
  const protectedSpans: ReadonlyArray<readonly [number, number]> = [
    ...ok.quotedSpans.map((span) => [span.start, span.end] as const),
    ...ok.inert.map((fact) => [fact.span.start, fact.span.end] as const),
  ];
  const inside = protectedSpans.some(
    ([start, stop]) => start <= idx && end <= stop
  );
  if (!inside) return null;
  return /rm -rf|mkfs|dd if=|remove-item/.test(token)
    ? WARRANTS.class1
    : WARRANTS.class2;
}

function labelRow(
  base: Omit<ShadowRow, "label">,
  postParse: SecurityParseResult
): ShadowRow {
  if (JSON.stringify(base.pre) === JSON.stringify(base.post)) {
    return { ...base, label: "same" };
  }
  if (!isDenyToSilence(base)) {
    // Silence/absence pre → refusal/deny/record post: the migration ADDED an
    // answer. Not a widening, so not binary-2 material; recorded `fixed`
    // with the cause the consumer contracts name.
    return {
      ...base,
      label: "fixed",
      cause:
        "stricter-or-extra answer from parse facts on an ok parse (SC-S4-1 parity); " +
        "no pre-4a denial was weakened",
    };
  }
  return labelSilenceRow(base, postParse);
}

/**
 * Deny/refusal/record pre → silence post. Admitted warrants by shape:
 * the role-substituent unknown-syntax silence, the declared non-`ok`
 * silences, the single-command-node ledger re-home on `ok`, and the inert
 * grep spans; everything else scores `open`.
 */
function labelSilenceRow(
  base: Omit<ShadowRow, "label">,
  postParse: SecurityParseResult
): ShadowRow {
  if (postParse.kind !== "ok") {
    const warrant = nonOkSilenceWarrant(base, postParse.kind);
    return warrant === undefined
      ? { ...base, label: "open" }
      : { ...base, label: "expected-relaxation", warrant };
  }
  if (base.output === "readpath") {
    return ledgerSilenceRow(base, postParse);
  }
  if (base.output === "grep") {
    const warrant = inertSpanWarrant(postParse, base.pre as string);
    if (warrant !== null) {
      return { ...base, label: "expected-relaxation", warrant };
    }
  }
  return { ...base, label: "open" };
}

/**
 * Admitted silences on a degraded parse: the role-substituent
 * unknown-syntax silence, and the declared non-`ok` silences of the
 * record/refusal consumers. The readonly gate's declared non-ok answer is
 * today's answer (text fold), so a readonly diff is NOT licensed here.
 */
function nonOkSilenceWarrant(
  base: Omit<ShadowRow, "label">,
  kind: Exclude<SecurityParseResult["kind"], "ok">
): string | undefined {
  if (base.output === "grep" && kind === "unknown-syntax") {
    return WARRANTS.roleSubUnknownSyntax;
  }
  if (
    NON_OK_KINDS.has(kind) &&
    (base.output === "readpath" ||
      base.output === "grep" ||
      base.output === "declarative")
  ) {
    return WARRANTS.nonOk(kind);
  }
  return undefined;
}

/**
 * The one authorized ledger diff class: PRE's newline-blind text fold
 * recorded a read path ACROSS a bare newline — two shell statements
 * (`cat\nf` = `cat` reading stdin, then `f`) misfolded as one `cat f`.
 * The parse-derived answer records nothing, which is the stricter side
 * ("a ledger record is an affordance, not a refusal",
 * docs/shell-parse-non-ok-consumer-contracts.md) and is the behavior
 * T24 pinned at tests/harness/aci/tools/bash-read-extract.test.ts:87
 * (bare `cat` records nothing) and :851 (newline is a statement
 * boundary). Proof is read off the facts: the recorded value starts at
 * or after the first bare newline. Anything else stays `open`.
 */
function ledgerSilenceRow(
  base: Omit<ShadowRow, "label">,
  postParse: Extract<SecurityParseResult, { kind: "ok" }>
): ShadowRow {
  const newline = postParse.bareNewlineOffsets[0];
  const prePath = base.pre as string;
  const at = postParse.text.indexOf(prePath);
  if (
    newline !== undefined &&
    at >= 0 &&
    at > newline &&
    postParse.commands.filter((c) => c.depth === 0).length > 1
  ) {
    return {
      ...base,
      label: "expected-relaxation",
      warrant: WARRANTS.ledgerAffordance,
    };
  }
  return { ...base, label: "open" };
}

/* -------------------------------------------------------------------------- */
/* Run                                                                         */
/* -------------------------------------------------------------------------- */

export function admittedWarrants(): ReadonlySet<string> {
  return new Set([
    WARRANTS.class1,
    WARRANTS.class2,
    WARRANTS.class3,
    WARRANTS.roleSubUnknownSyntax,
    WARRANTS.ledgerAffordance,
    WARRANTS.unmodelled,
    ...[...NON_OK_KINDS].map((kind) => WARRANTS.nonOk(kind)),
  ]);
}

export async function buildRows(): Promise<ShadowRow[]> {
  if (
    !existsSync(join(PRE_DIR, "src", "harness", "aci", "tools", "bash-readonly.ts"))
  ) {
    throw new Error(
      `PRE mirror missing at ${PRE_DIR} — materialize it first (header of this file: git archive ${PRE_REV} src/ | tar -x, package.json shim, node_modules symlink)`
    );
  }
  const pre = await loadGraph(PRE_DIR);
  const post: ShadowGraph = {
    validateReadonlyCommand: postValidateReadonlyCommand,
    extractSingleReadPath: postExtractSingleReadPath,
    detectBashGrepSubstitution: postDetectBashGrepSubstitution,
    compile: postCompile,
  };
  const preRules = ruleMatchers(pre.compile, RULE_SET.deny);
  const postRules = ruleMatchers(post.compile, RULE_SET.deny);

  const rows: ShadowRow[] = [];
  for (const command of corpusCommands()) {
    const postParse = parseForSecurity(command);
    const add = (
      output: ShadowOutput,
      preValue: string | boolean | null,
      postValue: string | boolean | null,
      rule?: string
    ): void => {
      const base: Omit<ShadowRow, "label"> = {
        command,
        output,
        ...(rule === undefined ? {} : { rule }),
        pre: preValue,
        post: postValue,
      };
      rows.push(labelRow(base, postParse));
    };
    add(
      "readonly",
      readonlyValue(pre.validateReadonlyCommand, command),
      readonlyValue(post.validateReadonlyCommand, command)
    );
    add(
      "readpath",
      pre.extractSingleReadPath(command) ?? null,
      post.extractSingleReadPath(command) ?? null
    );
    add(
      "grep",
      pre.detectBashGrepSubstitution(command) ?? null,
      post.detectBashGrepSubstitution(command) ?? null
    );
    const preMatches = preRules.matches(command);
    const postMatches = postRules.matches(command);
    for (let i = 0; i < RULE_SET.deny.length; i += 1) {
      add(
        "declarative",
        preMatches[i] ?? false,
        postMatches[i] ?? false,
        RULE_SET.deny[i]
      );
    }
  }
  return rows;
}

export function census(rows: ReadonlyArray<ShadowRow>): {
  total: number;
  same: number;
  relaxation: number;
  fixed: number;
  open: number;
  denyToSilenceUnwarranted: number;
} {
  const admitted = admittedWarrants();
  const tally = {
    total: rows.length,
    same: 0,
    relaxation: 0,
    fixed: 0,
    open: 0,
    denyToSilenceUnwarranted: 0,
  };
  for (const row of rows) {
    censusRow(row, admitted, tally);
  }
  return tally;
}

/** A relaxation row scores open unless its warrant is in the admitted set. */
function hasAdmittedWarrant(
  row: ShadowRow,
  admitted: ReadonlySet<string>
): boolean {
  return (
    row.label === "expected-relaxation" &&
    row.warrant !== undefined &&
    admitted.has(row.warrant)
  );
}

function censusRow(
  row: ShadowRow,
  admitted: ReadonlySet<string>,
  tally: {
    same: number;
    relaxation: number;
    fixed: number;
    open: number;
    denyToSilenceUnwarranted: number;
  }
): void {
  if (row.label === "same") tally.same += 1;
  if (row.label === "expected-relaxation") tally.relaxation += 1;
  if (row.label === "fixed") tally.fixed += 1;
  const warranted = hasAdmittedWarrant(row, admitted);
  if (isDenyToSilence(row) && !warranted && row.label !== "same") {
    tally.denyToSilenceUnwarranted += 1;
  }
  // A relaxation row without an admitted warrant scores open (SC-S4-7).
  if (row.label === "expected-relaxation" && !warranted) {
    tally.open += 1;
  } else if (row.label === "open") {
    tally.open += 1;
  }
}

async function main(): Promise<number> {
  const outIndex = process.argv.indexOf("--out");
  const out =
    outIndex >= 0 && process.argv[outIndex + 1] !== undefined
      ? resolve(process.argv[outIndex + 1])
      : DEFAULT_OUT;
  const rows = await buildRows();
  writeFileSync(out, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  const result = census(rows);
  console.log(
    `rows=${result.total} same=${result.same} expected-relaxation=${result.relaxation} fixed=${result.fixed} open=${result.open}`
  );
  console.log(`deny_to_silence_without_warrant=${result.denyToSilenceUnwarranted}`);
  for (const row of rows) {
    if (row.label !== "same") {
      console.log(
        `DIVERGENT ${row.output}${row.rule === undefined ? "" : `(${row.rule})`} ${JSON.stringify(row.command)}: ${JSON.stringify(row.pre)} -> ${JSON.stringify(row.post)} [${row.label}] ${row.warrant ?? row.cause ?? ""}`
      );
    }
  }
  console.log(`fixture written: ${out}`);
  return result.open === 0 && result.denyToSilenceUnwarranted === 0 ? 0 : 1;
}

const isDirectRun =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) ===
    fileURLToPath(pathToFileURL(process.argv[1]));

if (isDirectRun) {
  process.exitCode = await main();
}
