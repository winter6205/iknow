#!/usr/bin/env node
/**
 * Stage 2 floor-differential generator.
 *
 * Dual-runs a command-shape population through the PRE-migration oracle — the
 * base commit's own `hard-walls.ts`, materialized by `git show` into a
 * throwaway path outside the repository, never the working tree's legacy
 * export — and through the working tree, then writes one JSONL row per
 * (command, wall) pair to the tracked fixture.
 *
 * Rows carry the closed divergence vocabulary: `same` when both sides agree
 * exactly, `expected-relaxation` with the licensed class number AND the spec
 * clause that licenses it when the base denied and the working tree allows,
 * `authorized-id-move` for the one denial whose reported id changes while its
 * tier does not, and `open` for anything else — including any row where the
 * migration newly denies, which this generator can never license. `open` is a
 * loud result: the fixture test fails on it.
 *
 * The licensing predicates here are written from the spec and the parse facts,
 * never read off the wall: a predicate that imported the roster it is grading
 * could not fail when the roster narrowed. That independence is why
 * `EXECUTION_CARRIER_NAMES` is a second list rather than an import, and why the
 * fixture test pins the two lists agreeing by membership.
 *
 * Corpus input is inert text. Nothing here executes a command; the only child
 * process is `git show`, and the only oracle import is a source file.
 *
 * Usage: npx tsx scripts/stage2-floor-differential-generate.ts
 *            [--out <path>] [--base <rev>]
 */

import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { checkCorpusLine } from "./shell-parse-divergence.ts";
import {
  commandContainsSensitivePath,
  findDangerousPattern,
  type DangerousPatternHit,
} from "../src/harness/permission/hard-walls.js";
import {
  parseForSecurity,
  type FactSpan,
  type SecurityParseOkFacts,
  type WordFact,
} from "../src/harness/permission/shell-parse.js";

/** The commit the destructive walls moved away from. */
export const DEFAULT_BASE_REV = "3b31b5562";

/** The migrated file, both in `git show` form and on disk. */
const WALL_PATH = "src/harness/permission/hard-walls.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Where the committed shape fixtures live. */
export const CORPUS_DIR = join(REPO_ROOT, "tests", "fixtures", "shell-corpus");

/**
 * This tool's own rows go to a separate directory: `shell-corpus/` has a
 * committed schema contract (every `.jsonl` there is one-key `{command}` corpus
 * lines, asserted by SC10's format gate), and a six-key row dropped into it
 * would break that gate while teaching the population sweep to feed on itself.
 */
const DIFFERENTIAL_DIR = join(
  REPO_ROOT,
  "tests",
  "fixtures",
  "shell-divergence"
);

const DEFAULT_OUT = join(DIFFERENTIAL_DIR, "stage2-differential.jsonl");

export type WallName = "pattern" | "sensitive";

export type DivergenceLabel =
  "same" | "expected-relaxation" | "authorized-id-move" | "fixed" | "open";

/** The licensed relaxation classes: quote/heredoc, inert-span, operand-scope. */
export type RelaxationClass = "1" | "2" | "3";

export type WallValue = DangerousPatternHit | boolean | null;

/**
 * The clause each licensed class cites, per SC-GATES-3's requirement that every
 * diff be tagged to a clause. Abbreviated to the criterion, the class number and
 * the one limit that class may never cross.
 */
export const RELAXATION_CLAUSES: Record<RelaxationClass, string> = {
  "1": "specs/hard-wall-ast-migration.md SC-GATES-3 class (1) quote/heredoc (SC-S2-1; never a declared code or carrier operand)",
  "2": "specs/hard-wall-ast-migration.md SC-GATES-3 class (2) inert-span (SC-S2-7 comment text, non-code-receiver quoted body)",
  "3": "specs/hard-wall-ast-migration.md SC-GATES-3 class (3) operand-scope (SC-S2-1 third flip; an operand that is data, so not a carrier's)",
};

export interface DifferentialRow {
  readonly command: string;
  readonly wall: WallName;
  readonly base: WallValue;
  readonly head: WallValue;
  readonly label: DivergenceLabel;
  readonly class?: RelaxationClass;
  readonly clause?: string;
}

/** One wall answered by one side of the differential. */
interface Oracle {
  readonly pattern: (command: string) => DangerousPatternHit | null;
  readonly sensitive: (command: string) => boolean;
}

/** The working-tree side: the live exports, read at call time. */
const headOracle: Oracle = {
  pattern: findDangerousPattern,
  sensitive: commandContainsSensitivePath,
};

/**
 * The one `{id, pattern}` pair the migration authorizes to move: the fork-bomb
 * shape, denied on both sides, whose reported id changes with the structural
 * rule. Anything else that moves is not authorized and lands `open`.
 */
const AUTHORIZED_ID_MOVE: readonly [DangerousPatternHit, DangerousPatternHit] =
  [
    { id: "bare-metachar", pattern: "|" },
    { id: "destructive-disk", pattern: ":(){ :|:& };:" },
  ];

// ---------------------------------------------------------------------------
// the pre-migration oracle
// ---------------------------------------------------------------------------

/**
 * A revision reaches `git show` as part of one `rev:path` argument. The value
 * comes from `--base`, so it is restricted to sha/ref-shaped text: anything
 * starting with a dash would arrive at git as an option. Arguments go to
 * `execFileSync` as an array, never through a shell, so no metacharacter in the
 * accepted shape can be interpreted by anything but git.
 */
const BASE_REV_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._@/-]*$/;

/** `git show <rev>:<path>` — the only faithful source of the pre-state. */
function gitShow(rev: string, path: string): string {
  if (!BASE_REV_SHAPE.test(rev)) {
    throw new Error(
      `the pre-migration revision must be a sha or ref name, got ${JSON.stringify(rev)}`
    );
  }
  return execFileSync("git", ["show", `${rev}:${path}`], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
}

/**
 * The base file imports its siblings with `./name.js` specifiers, which resolve
 * to nothing once the file sits outside the repository. Point them at the
 * sibling that is actually on disk; `assertSiblingsFrozen` proves below that
 * "on disk" and "at the base rev" are the same bytes.
 */
function rewriteSiblingSpecifiers(source: string): string {
  return source.replace(
    /from "\.\/([A-Za-z0-9_-]+)\.js"/g,
    (_match, name: string) =>
      `from "${join(REPO_ROOT, "src", "harness", "permission", `${name}.ts`)}"`
  );
}

/** Every sibling module name the copied file imports from its own directory. */
function siblingModules(source: string): string[] {
  return [
    ...new Set(
      [...source.matchAll(/from "\.\/([A-Za-z0-9_-]+)\.js"/g)].map(
        (match) => match[1] as string
      )
    ),
  ];
}

/**
 * The oracle's validity hinge: only `hard-walls.ts` may have moved since the
 * base rev. A sibling that moved would silently change what the frozen copy
 * computes, so the copy would stop being the pre-state. Fail rather than measure
 * something else.
 */
function assertSiblingsFrozen(rev: string, modules: readonly string[]): void {
  const dir = dirname(WALL_PATH);
  for (const name of modules) {
    const path = join(dir, `${name}.ts`);
    const atBase = gitShow(rev, path);
    if (atBase !== readFileSync(join(REPO_ROOT, path), "utf8")) {
      throw new Error(
        `oracle is not frozen: ${path} differs between ${rev} and the working tree`
      );
    }
  }
}

/** The base `hard-walls.ts` written outside the repo, ready to import. */
function materializeBaseSource(rev: string, outDir: string): string {
  const frozen = gitShow(rev, WALL_PATH);
  assertSiblingsFrozen(rev, siblingModules(frozen));
  const file = join(outDir, "base-hard-walls.ts");
  writeFileSync(file, rewriteSiblingSpecifiers(frozen));
  return file;
}

type ImportedModule = {
  readonly findDangerousPattern: (
    command: string
  ) => DangerousPatternHit | null;
  readonly commandContainsSensitivePath: (command: string) => boolean;
};

/** Load the frozen copy as the pre-migration oracle. */
async function loadBaseOracle(rev: string, outDir: string): Promise<Oracle> {
  const file = materializeBaseSource(rev, outDir);
  const mod = (await import(pathToFileURL(file).href)) as ImportedModule;
  return {
    pattern: mod.findDangerousPattern,
    sensitive: mod.commandContainsSensitivePath,
  };
}

// ---------------------------------------------------------------------------
// licensing: the spans the migration is allowed to stop judging
// ---------------------------------------------------------------------------

/** `text` with each span replaced by blanks — never trimmed or joined. */
function blankSpans(text: string, spans: readonly FactSpan[]): string {
  if (spans.length === 0) return text;
  const chars = text.split("");
  for (const span of spans) {
    const start = Math.max(0, span.start);
    const end = Math.min(chars.length, span.end);
    for (let i = start; i < end; i += 1) chars[i] = " ";
  }
  return chars.join("");
}

/** Names that eat a string as another program's source. */
const CODE_CONSUMING_NAMES: ReadonlySet<string> = new Set([
  "bash",
  "sh",
  "zsh",
  "dash",
  "ksh",
  "python",
  "python2",
  "python3",
  "node",
  "perl",
  "ruby",
  "php",
  "powershell",
  "pwsh",
  "cmd",
]);

/**
 * Names that run what they are handed somewhere other than in this shell: `ssh`
 * and `su` hand the words to a shell on the far side or under another uid,
 * `docker` / `podman` / `kubectl exec` spawn them, `watch`, `parallel` and
 * `xargs` build a command out of them. An operand run elsewhere is not data in
 * SC-S2-1's third-flip sense, so no relaxation class may license a span one of
 * these names was handed. This list is written from the spec, not imported from
 * the wall — the fixture test pins the two agreeing by membership, so drift in
 * either direction fails loudly instead of re-tagging a regression `same`.
 */
export const EXECUTION_CARRIER_NAMES: ReadonlySet<string> = new Set([
  "ssh",
  "su",
  "docker",
  "podman",
  "kubectl",
  "watch",
  "parallel",
  "xargs",
]);

/**
 * The wall's other four, which are not carriers across a process boundary but
 * still neither discard nor print what they are handed: `eval` runs it in this
 * shell, `trap` stores it to run later, `alias` stores it as a name, `env` runs
 * it as the program's own argv. Written from the spec and pinned by membership
 * against the wall's own literal, exactly as the carrier list is.
 */
export const STORED_OR_RUNNED_OPERAND_NAMES: ReadonlySet<string> = new Set([
  "eval",
  "trap",
  "alias",
  "env",
]);

/** Names whose operand run is executed: another program's source, a carrier's. */
const EXECUTED_OPERAND_NAMES: ReadonlySet<string> = new Set([
  ...CODE_CONSUMING_NAMES,
  ...EXECUTION_CARRIER_NAMES,
  ...STORED_OR_RUNNED_OPERAND_NAMES,
]);

/**
 * Wrappers that stay in front of a command position without owning it — the
 * wall's own fold universe, minus the names that own it by running or storing
 * what they are handed. Pinned by membership against the wall's two roster
 * literals, because a prefix answered as an ordinary data command here hands
 * its operand to class 3: `timeout 5 rm -rf /x` relaxed would be excused, not
 * opened.
 */
export const TRANSPARENT_WRAPPERS: ReadonlySet<string> = new Set([
  "sudo",
  "doas",
  "command",
  "builtin",
  "exec",
  "time",
  "timeout",
  "nohup",
  "nice",
  "stdbuf",
  "setsid",
  "ionice",
]);

/** Names the destructive roster matches in command position. */
const DESTRUCTIVE_NAMES = new Set([
  "rm",
  "rmdir",
  "remove-item",
  "del",
  "rd",
  "dd",
  "chmod",
  "find",
  "format",
  "shutdown",
  "reboot",
]);

function isDestructiveName(name: string): boolean {
  return DESTRUCTIVE_NAMES.has(name) || name.startsWith("mkfs");
}

function wordName(word: WordFact | undefined): string {
  const raw = (word?.value ?? word?.text ?? "")
    .toLowerCase()
    .replace(/\\/g, "");
  const slash = Math.max(raw.lastIndexOf("/"), raw.lastIndexOf("\\"));
  return raw.slice(slash + 1).trim();
}

/**
 * What owns a node's command position: a named command, an ordinary data
 * command, or nothing this file can name because a wrapper prefix ran out into
 * a token it does not model (`sudo -u root …`, whose arity the wall reads and
 * this ledger deliberately does not import). The third arm licenses nothing.
 */
type NodeOwner =
  | { readonly state: "owner"; readonly at: number }
  | { readonly state: "data" }
  | { readonly state: "unresolved"; readonly at: number };

/** A token that is one wrapper's own argument, never the wrapped command. */
function isWrapperArgument(word: WordFact): boolean {
  const raw = word.text ?? word.value ?? "";
  if (raw.includes("=")) return true;
  if (!raw.startsWith("-")) return /^\d+(?:\.\d+)?[smhd]?$/.test(raw);
  // Any flag on a known wrapper is its own argument. Guessing the other way
  // hands a wrapped command's operand to the licensing classes.
  return true;
}

/** The node's command position, folded the way the wall folds. */
function nodeOwner(argv: readonly WordFact[]): NodeOwner {
  let wrapped = false;
  for (let i = 0; i < argv.length; i += 1) {
    const name = wordName(argv[i]);
    if (EXECUTED_OPERAND_NAMES.has(name) || isDestructiveName(name))
      return { state: "owner", at: i };
    if (TRANSPARENT_WRAPPERS.has(name)) {
      wrapped = true;
      continue;
    }
    if (wrapped && isWrapperArgument(argv[i]!)) continue;
    return wrapped ? { state: "unresolved", at: i } : { state: "data" };
  }
  return wrapped ? { state: "unresolved", at: argv.length } : { state: "data" };
}

function spansOf(words: readonly WordFact[]): FactSpan[] {
  return words.map((word) => word.span);
}

/**
 * Regions the parse declares are executed somewhere: an interpreter's or a
 * carrier's operand run, and everything from the token that hid a wrapper's
 * owner. Never licensed as inert text by any class.
 */
function executedOperandSpans(facts: SecurityParseOkFacts): FactSpan[] {
  const spans: FactSpan[] = [];
  for (const command of facts.commands) {
    const owner = nodeOwner(command.argv);
    if (owner.state === "unresolved") {
      spans.push(...spansOf(command.argv.slice(owner.at)));
      continue;
    }
    if (
      owner.state !== "owner" ||
      !EXECUTED_OPERAND_NAMES.has(wordName(command.argv[owner.at]))
    )
      continue;
    spans.push(...spansOf(command.argv.slice(owner.at + 1)));
  }
  return spans;
}

/** Operands of a data-consuming command: the operand-scope class's material. */
function dataOperandSpans(facts: SecurityParseOkFacts): FactSpan[] {
  const spans: FactSpan[] = [];
  for (const command of facts.commands) {
    const argv = command.argv;
    const owner = nodeOwner(argv);
    if (owner.state !== "data") continue;
    spans.push(...spansOf(argv.slice(1)));
  }
  return spans;
}

/** Comments and single-quoted words — inert text for both walls. */
function inertTextSpans(facts: SecurityParseOkFacts): FactSpan[] {
  return facts.inert
    .filter((inert) => inert.why === "comment" || inert.why === "single-quoted")
    .map((inert) => inert.span);
}

/** Double-quoted words: one word for argv, still expanded for the path wall. */
function doubleQuotedSpans(facts: SecurityParseOkFacts): FactSpan[] {
  return facts.words
    .filter((word) => word.quoteKind === "double")
    .map((word) => word.span);
}

/**
 * A quoted-delimiter heredoc body whose receiver, wrappers folded, neither eats
 * code nor runs what it is handed — so the body is that command's data.
 */
function dataHeredocSpans(facts: SecurityParseOkFacts): FactSpan[] {
  const spans: FactSpan[] = [];
  for (const heredoc of facts.heredocs) {
    if (!heredoc.delimiterQuoted) continue;
    const receiver = facts.commands.find(
      (command) => command.index === heredoc.receiverCommandIndex
    );
    // No receiver, or a receiver this file cannot name an owner for, is not
    // evidence that the body is data.
    if (receiver !== undefined && nodeOwner(receiver.argv).state !== "data")
      continue;
    spans.push(heredoc.bodySpan);
  }
  return spans;
}

/** Drop any span that begins inside a blocker region. */
function outsideOf(
  spans: readonly FactSpan[],
  blockers: readonly FactSpan[]
): FactSpan[] {
  return spans.filter(
    (span) =>
      !blockers.some(
        (block) => span.start >= block.start && span.start < block.end
      )
  );
}

// ---------------------------------------------------------------------------
// labeling
// ---------------------------------------------------------------------------

export interface Verdict {
  readonly label: DivergenceLabel;
  readonly class?: RelaxationClass;
  readonly clause?: string;
}

export function valuesEqual(left: WallValue, right: WallValue): boolean {
  if (typeof left === "boolean" || typeof right === "boolean")
    return left === right;
  if (left === null || right === null) return left === right;
  return left.id === right.id && left.pattern === right.pattern;
}

function factsOf(command: string): SecurityParseOkFacts | null {
  const parse = parseForSecurity(command);
  return parse.kind === "ok" ? parse : null;
}

/**
 * Spans the quote / comment / data-heredoc class may stop judging. An executed
 * operand blocks the excuse in every direction: the words a carrier was handed
 * are run somewhere, so no class may record them as inert text.
 */
function quoteLicensedSpans(command: string): FactSpan[] {
  const facts = factsOf(command);
  if (facts === null) return [];
  return outsideOf(
    [
      ...inertTextSpans(facts),
      ...doubleQuotedSpans(facts),
      ...dataHeredocSpans(facts),
    ],
    executedOperandSpans(facts)
  );
}

/** The inert spans the path wall may excise: comment text and data bodies. */
function inertLicensedSpans(command: string): FactSpan[] {
  const facts = factsOf(command);
  if (facts === null) return [];
  return [...inertTextSpans(facts), ...dataHeredocSpans(facts)];
}

/**
 * Operands of a command that eats no code, runs nothing it is handed and is not
 * itself destructive — the only operands class (3) may call data.
 */
function operandLicensedSpans(command: string): FactSpan[] {
  const facts = factsOf(command);
  if (facts === null) return [];
  return outsideOf(dataOperandSpans(facts), executedOperandSpans(facts));
}

/** The base scan answers nothing at all once these spans are blanked. */
function excusedBy(
  command: string,
  spans: readonly FactSpan[],
  oracle: Oracle
): boolean {
  const blanked = blankSpans(command, spans);
  return (
    spans.length > 0 && blanked !== command && oracle.pattern(blanked) === null
  );
}

function isAuthorizedMove(
  base: DangerousPatternHit,
  head: DangerousPatternHit
): boolean {
  const [from, to] = AUTHORIZED_ID_MOVE;
  return (
    base.id === from.id &&
    base.pattern === from.pattern &&
    head.id === to.id &&
    head.pattern === to.pattern
  );
}

/** A licensed relaxation always arrives with the clause that licensed it. */
function relaxation(cls: RelaxationClass): Verdict {
  return {
    label: "expected-relaxation",
    class: cls,
    clause: RELAXATION_CLAUSES[cls],
  };
}

export function classifyPattern(
  command: string,
  base: DangerousPatternHit | null,
  head: DangerousPatternHit | null,
  oracle: Oracle
): Verdict {
  if (valuesEqual(base, head)) return { label: "same" };
  if (base === null) return { label: "open" };
  if (head !== null) {
    return isAuthorizedMove(base, head)
      ? { label: "authorized-id-move" }
      : { label: "open" };
  }
  const quotes = quoteLicensedSpans(command);
  if (excusedBy(command, quotes, oracle)) return relaxation("1");
  const spans = [...quotes, ...operandLicensedSpans(command)];
  return excusedBy(command, spans, oracle)
    ? relaxation("3")
    : { label: "open" };
}

export function classifySensitive(
  command: string,
  base: boolean,
  head: boolean,
  oracle: Oracle
): Verdict {
  if (base === head) return { label: "same" };
  if (!base) return { label: "open" };
  const spans = inertLicensedSpans(command);
  return spans.length > 0 && !oracle.sensitive(blankSpans(command, spans))
    ? relaxation("2")
    : { label: "open" };
}

export function buildRows(
  commands: readonly string[],
  oracle: Oracle
): DifferentialRow[] {
  const rows: DifferentialRow[] = [];
  for (const command of commands) {
    const pattern = classifyPattern(
      command,
      oracle.pattern(command),
      headOracle.pattern(command),
      oracle
    );
    const sensitive = classifySensitive(
      command,
      oracle.sensitive(command),
      headOracle.sensitive(command),
      oracle
    );
    rows.push(
      {
        command,
        wall: "pattern",
        base: oracle.pattern(command),
        head: headOracle.pattern(command),
        ...pattern,
      },
      {
        command,
        wall: "sensitive",
        base: oracle.sensitive(command),
        head: headOracle.sensitive(command),
        ...sensitive,
      }
    );
  }
  return rows;
}

// ---------------------------------------------------------------------------
// the shape population
// ---------------------------------------------------------------------------

/** The commands already committed as corpus fixtures. */
function corpusCommands(dir: string): string[] {
  const commands: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".jsonl")) continue;
    const lines = readFileSync(join(dir, name), "utf8").split("\n");
    for (const [index, line] of lines.entries()) {
      if (line.length === 0) continue;
      const violation = checkCorpusLine(line);
      if (violation !== null)
        throw new Error(`${name}:${index + 1} ${violation}`);
      commands.push((JSON.parse(line) as { command: string }).command);
    }
  }
  return commands;
}

/**
 * Each of the 16 roster literals as a command whose base answer is that very
 * literal. `assertRosterWitnesses` checks the pairing, so a roster edit cannot
 * silently repurpose one of these shapes.
 */
function rosterShapes(): string[] {
  return [
    "rm -rf /tmp/x",
    "rm -fr /tmp/x",
    "rm -r /tmp/tree",
    "rm -f /tmp/file",
    "rm --recursive /tmp/tree",
    "rmdir /tmp/x",
    "Remove-Item -Recurse C:\\x",
    "find /tmp -delete",
    "chmod -R 777 /",
    "mkfs -t ext4 /dev/sdb1",
    "dd if=/dev/zero of=/dev/sda",
    ":(){ :|:& };:",
    "shutdown -h now",
    "reboot",
    "del /f important.txt",
    "rd /s /q C:\\path",
  ];
}

/** The roster literal each shape above is meant to exercise. */
const ROSTER_WITNESSES: readonly [string, string, string][] = [
  ["rm -rf /tmp/x", "destructive-rm", "rm -rf"],
  ["rm -fr /tmp/x", "destructive-rm", "rm -fr"],
  ["rm -r /tmp/tree", "destructive-rm", "rm -r "],
  ["rm -f /tmp/file", "destructive-rm", "rm -f "],
  ["rm --recursive /tmp/tree", "destructive-rm", "rm --recursive"],
  ["rmdir /tmp/x", "destructive-rm", "rmdir"],
  ["Remove-Item -Recurse C:\\x", "destructive-rm", "remove-item"],
  ["find /tmp -delete", "destructive-rm", " -delete"],
  ["chmod -R 777 /", "destructive-rm", "chmod -r"],
  ["mkfs -t ext4 /dev/sdb1", "destructive-disk", "mkfs"],
  ["dd if=/dev/zero of=/dev/sda", "destructive-disk", "dd if="],
  [":(){ :|:& };:", "bare-metachar", "|"],
  ["shutdown -h now", "destructive-disk", "shutdown"],
  ["reboot", "destructive-disk", "reboot"],
  ["del /f important.txt", "destructive-disk", "del /f"],
  ["rd /s /q C:\\path", "destructive-disk", "rd /s"],
];

/** A roster shape whose pre-state is not its own literal is a broken witness. */
function assertRosterWitnesses(oracle: Oracle): void {
  for (const [command, id, pattern] of ROSTER_WITNESSES) {
    const hit = oracle.pattern(command);
    if (hit?.id !== id || hit?.pattern !== pattern) {
      throw new Error(
        `roster witness drifted: ${JSON.stringify(command)} pre-state is ` +
          `${JSON.stringify(hit)}, expected ${id}/${JSON.stringify(pattern)}`
      );
    }
  }
}

/** Interpreter and Windows-shell code operands, in every operand shape they take. */
function codeOperandShapes(): string[] {
  return [
    "bash -c 'rm -rf /x'",
    'bash -c "rm -rf /tmp/x"',
    "bash -lc'rm -rf /'",
    "bash -ic'shutdown now'",
    "bash -ic rm -rf /",
    "bash -c rm -rf /",
    "zsh -luc rd /s",
    "bash --login -c 'rm -rf /tmp/x'",
    "python3 -c 'rm -rf /'",
    "python3 -c'rm -rf /'",
    "python3 -c \"import os; os.system('rm -rf /tmp/z')\"",
    "python -i 'rm -rf /'",
    'node -e \'require("child_process").execSync("rm -rf /")\'',
    "node --eval 'rm -rf /'",
    "perl -e 'rmdir'",
    "perl -te 'rmdir /tmp/x'",
    "php -r 'rm -rf /'",
    "php -e 'shutdown'",
    "powershell -c Remove-Item -Recurse -Force C:\\",
    "powershell -c 'Write-Output rm -rf /'",
    "pwsh -Command 'del /f x.txt'",
    'powershell -Command"del /f x.txt"',
    "cmd /c 'rmdir /s /q C:\\Windows'",
    "cmd /c echo del /f x.txt",
    "cmd /k echo del /f x.txt",
    "cmd /c 'echo one & echo two'",
    "bash -c 'echo one & echo two'",
    "grep -c rm -rf f",
    "echo powershell -c rm -rf x",
  ];
}

/** Carriers that run what they are handed, whether or not the rules name them. */
function carrierShapes(): string[] {
  return [
    "timeout 5 rm -rf /tmp/x",
    "env FOO=1 rm -rf /tmp/x",
    "nice -n 5 rm -rf /tmp/x",
    "nohup rm -rf /tmp/x",
    "time rm -rf /tmp/x",
    "stdbuf -oL rm -rf /tmp/x",
    "watch -n 1 rm -rf /tmp/x",
    "ssh host rm -rf /tmp/x",
    "docker exec c rm -rf /tmp/x",
    "su root -c 'rm -rf /tmp/x'",
    "parallel rm -rf {} ::: /tmp/x",
    "echo /tmp/x | xargs rm -rf",
    "eval 'rm -rf /tmp/x'",
    "trap 'rm -rf /tmp/x' EXIT",
    "alias rmall='rm -rf /tmp/x'",
    "env rm -rf /tmp/x",
  ];
}

/** The roster literals every sweep is built over. */
const SWEEP_LITERALS: readonly string[] = [
  "rm -rf /tmp/x",
  "dd if=/dev/zero of=/dev/sda",
  "mkfs -t ext4 /dev/sdb1",
  "chmod -R 777 /",
  "shutdown -h now",
  "find /tmp -delete",
];

/** One real invocation per carrier name; `%s` marks the operand it is handed. */
const CARRIER_TEMPLATES: readonly [string, string][] = [
  ["ssh", "ssh host %s"],
  ["su", "su root -c '%s'"],
  ["docker", "docker exec c %s"],
  ["podman", "podman exec c %s"],
  ["kubectl", "kubectl exec c -- %s"],
  ["watch", "watch -n 1 %s"],
  ["parallel", "parallel %s ::: /tmp/x"],
  ["xargs", "echo /tmp/x | xargs %s"],
];

/** A sweep that misses a carrier measures a floor it was written to prove. */
function assertCarrierSweepCoversRoster(): void {
  const swept = new Set(CARRIER_TEMPLATES.map(([name]) => name));
  const missing = [...EXECUTION_CARRIER_NAMES].filter(
    (name) => !swept.has(name)
  );
  const extra = [...swept].filter((name) => !EXECUTION_CARRIER_NAMES.has(name));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `carrier sweep does not cover the carrier roster: missing ` +
        `${JSON.stringify(missing)}, not on it ${JSON.stringify(extra)}`
    );
  }
}

/** A body handed to a carrier's shell, which the carrier then runs. */
const CARRIER_HEREDOC_SHAPES: readonly string[] = [
  "docker exec -i c sh <<'EOF'\nrm -rf /tmp/x\nEOF",
];

/** Every shape the carrier floor is priced on. */
export function carrierFloorShapes(): string[] {
  return [
    ...carrierSweepShapes(),
    ...carrierShapes(),
    ...CARRIER_HEREDOC_SHAPES,
  ];
}

/**
 * The license's own floor, asked where only this file can ask it: hand each
 * carrier shape to the licensing predicates as if the wall had stopped denying
 * it, and require the answer `open`. A carrier shape that came back
 * `expected-relaxation` would mean this generator could excuse the very
 * regression the carrier roster exists to catch.
 */
function assertCarrierOperandsUnlicensable(oracle: Oracle): void {
  for (const command of carrierFloorShapes()) {
    const base = oracle.pattern(command);
    if (base === null) {
      throw new Error(
        `carrier floor shape has no pre-state deny to price: ${JSON.stringify(command)}`
      );
    }
    const verdict = classifyPattern(command, base, null, oracle);
    if (verdict.label !== "open") {
      throw new Error(
        `a carrier's operand must stay unlicensable: ${JSON.stringify(command)} ` +
          `would be recorded ${JSON.stringify(verdict)}`
      );
    }
  }
}

/** Every carrier × every roster literal: the shape class the review priced. */
function carrierSweepShapes(): string[] {
  return CARRIER_TEMPLATES.flatMap(([, template]) =>
    SWEEP_LITERALS.map((literal) => template.replace("%s", literal))
  );
}

/** Names on neither roster, so their operands are the class-(3) material. */
const INERT_NAMES: readonly string[] = [
  "grep",
  "echo",
  "cat",
  "awk",
  "head",
  "test",
];

/** Every inert name × every roster literal, in each inert spelling. */
function inertNameSweepShapes(): string[] {
  return INERT_NAMES.flatMap((name) =>
    SWEEP_LITERALS.flatMap((literal) => [
      `${name} ${literal}`,
      `${name} '${literal}'`,
      `${name} "${literal}"`,
      `${name} notes.txt # ${literal}`,
    ])
  );
}

/** Heredocs under a code receiver and under a data receiver, quoted or not. */
function heredocShapes(): string[] {
  return [
    ...CARRIER_HEREDOC_SHAPES,
    "python3 <<EOF\nrm -rf /tmp/x\nEOF",
    "python3 <<'EOF'\nos.system('rm -rf /tmp/x')\nEOF",
    "sudo python3 <<'EOF'\nrm -rf /tmp/x\nEOF",
    "cat <<'EOF'\nrm -rf /tmp/x\nEOF",
    "cat <<EOF\nrm -rf /tmp/x\nEOF",
    "powershell <<'EOF'\ndel /f x.txt\nEOF",
    "bash <<< 'rm -rf /tmp/x'",
    "cat <<'EOF'\nhello\nEOF",
    "cat sh <<'EOF'\nrm -rf /tmp/x\nEOF",
    "python3 <<'EOF'\nrm -rf /tmp/x\nEOF",
    "sudo bash <<'EOF'\nrm -rf /tmp/x\nEOF",
    "docker exec -i c sh <<'EOF'\ncat /etc/passwd\nEOF",
  ];
}

/** Wrapper folds: the destructive name survives the wrapper, or should not. */
function wrapperShapes(): string[] {
  return [
    "builtin rm -rf /tmp/x",
    "builtin docker exec c rm -rf /tmp/x",
    "command rm -rf /tmp/x",
    "sudo rm -rf /home",
    "sudo format C:",
    "command docker exec c rm -rf /tmp/x",
    "nice command rm -rf /tmp/x",
  ];
}

/** Comment text, quoted data, and the operand-scope shapes beside them. */
function inertTextShapes(): string[] {
  return [
    "echo hi # rm -rf /",
    'echo "rm -rf /"',
    "echo 'rm -rf /'",
    "printf 'rm -rf /'",
    "echo rm -rf",
    "grep rm -rf /tmp/x",
    "echo rmdir",
    "echo 'text-transform: uppercase'",
    "echo 'git format-patch -1'",
    "printf '%s format %s' a b",
    "cat format-notes.md",
    "echo a && rm -rf /",
    "echo a; rm -rf /",
    "echo a\nrm -rf /",
    "echo $(rm -rf /tmp/x)",
    "echo '$(whoami)'",
  ];
}

/**
 * The bomb in each place it can sit. Bare, it is the one authorized `{id,
 * pattern}` move; inside an operand or a body the quote-blind scan never saw it,
 * because there its `|` and `&` are quoted text behind a command word, so a
 * substring reading of the roster's bomb entry would be the migration denying
 * shapes it promised never to.
 */
function forkBombShapes(): string[] {
  return [
    ":(){ :|:& };:",
    "ls; :(){ :|:& };:",
    "echo hi && :(){ :|:& };:",
    "bash -c ':(){ :|:& };:'",
    "eval ':(){ :|:& };:'",
    "python3 <<'EOF'\n:(){ :|:& };:\nEOF",
  ];
}

/** The path wall's shapes: operands, targets, code, inert text, expansions. */
function sensitiveShapes(): string[] {
  return [
    "cat <<'EOF'\nid_rsa\nEOF",
    "cat <<'EOF'\n/etc/passwd\nEOF",
    "python3 <<'EOF'\nopen('/etc/passwd').read()\nEOF",
    "bash -c 'cat /etc/passwd'",
    "sh -c 'cat /etc/shadow'",
    "echo $(cat ~/.ssh/id_rsa)",
    "echo $(cat /etc/passwd)",
    "cat notes.txt # id_rsa here",
    "cp '/home/u/.ssh/id_rsa' /tmp/x",
    "cat '/etc/shadow'",
    'mv "$HOME/.aws/credentials" /tmp',
    "echo a > '/etc/passwd'",
    "FOO='id_rsa' printenv",
    "echo 'cat ~/.ssh/id_rsa'",
    'echo "cat ~/.ssh/id_rsa"',
    'test -r "$HOME/.ssh/id_ed25519"',
    "echo a > ~/.ssh/x",
    "echo a >> /etc/shadow",
    "cat .env | head",
    "echo a > /tmp/x.pem && notify",
    "cp app.key '.bak'",
    "cp app.key # backup",
  ];
}

export function buildPopulation(corpusDir: string): string[] {
  const groups = [
    corpusCommands(corpusDir),
    rosterShapes(),
    codeOperandShapes(),
    carrierShapes(),
    carrierSweepShapes(),
    inertNameSweepShapes(),
    heredocShapes(),
    wrapperShapes(),
    inertTextShapes(),
    forkBombShapes(),
    sensitiveShapes(),
  ];
  return [...new Set(groups.flat())];
}

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

/** Whether a wall value withholds the command. */
const denies = (value: WallValue): boolean =>
  typeof value === "boolean" ? value : value !== null;

/** Whether a pattern row keeps the deny but changes which rule answered it. */
function movedId(row: DifferentialRow): boolean {
  return (
    row.wall === "pattern" &&
    row.base !== null &&
    row.head !== null &&
    !valuesEqual(row.base, row.head)
  );
}

/** The report buckets one row falls into. */
function rowBumps(row: DifferentialRow): string[] {
  const keys = [`label:${row.label}`];
  if (row.class !== undefined) keys.push(`class:${row.class}`);
  if (row.label === "expected-relaxation") {
    keys.push(row.clause === undefined ? "clauseless" : "cited");
  }
  if (!denies(row.base) && denies(row.head)) keys.push("new-deny");
  if (denies(row.base) && !denies(row.head)) keys.push("new-allow");
  if (movedId(row)) keys.push("moved");
  return keys;
}

export function summarize(
  rows: readonly DifferentialRow[]
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    for (const key of rowBumps(row)) counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function flagValue(args: readonly string[], flag: string): string | null {
  const index = args.indexOf(flag);
  return index < 0 ? null : (args[index + 1] ?? null);
}

async function generate(
  outPath: string,
  corpusDir: string,
  baseRev: string
): Promise<void> {
  const scratch = mkdtempSync(join(tmpdir(), "iknow-floor-differential-"));
  try {
    const oracle = await loadBaseOracle(baseRev, scratch);
    assertRosterWitnesses(oracle);
    assertCarrierSweepCoversRoster();
    assertCarrierOperandsUnlicensable(oracle);
    const commands = buildPopulation(corpusDir);
    const rows = buildRows(commands, oracle);
    const body = rows.map((row) => JSON.stringify(row)).join("\n");
    writeFileSync(outPath, `${body}\n`);
    const counts = summarize(rows);
    process.stdout.write(
      `population=${commands.length} rows=${rows.length}\n` +
        `${Object.entries(counts)
          .map(([key, value]) => `${key}=${value}`)
          .join(" ")}\n`
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const out = flagValue(args, "--out") ?? DEFAULT_OUT;
  const corpusDir = flagValue(args, "--corpus") ?? CORPUS_DIR;
  const baseRev = flagValue(args, "--base") ?? DEFAULT_BASE_REV;
  mkdirSync(dirname(out), { recursive: true });
  await generate(out, corpusDir, baseRev);
}

const isDirectRun =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) ===
    fileURLToPath(pathToFileURL(process.argv[1]));

if (isDirectRun) {
  await main();
}
