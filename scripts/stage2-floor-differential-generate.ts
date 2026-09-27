#!/usr/bin/env node
/**
 * Stage 2 floor-differential generator.
 *
 * Dual-runs a command-shape population through the PRE-migration oracle — the
 * base commit's own `hard-walls.ts` AND its runtime import graph, each module
 * materialized from its base blob by `git show` into a throwaway mirror
 * outside the repository, never the working tree's legacy exports or siblings —
 * and through the working tree, then writes one JSONL row per
 * (command, wall) pair to the tracked fixture.
 *
 * Rows carry the closed divergence vocabulary: `same` when both sides agree
 * exactly, `expected-relaxation` with the licensed class number AND the spec
 * clause that licenses it when the base denied and the working tree allows,
 * `authorized-id-move` for the one denial whose reported id changes while its
 * tier does not, `fixed` for the allow-to-deny move the spec authorizes in
 * advance — the two code-bearing fork-bomb variants, with their cause recorded —
 * `security-review` for the deny-to-reviewed-ask move ADR-0127 routes (SC-S2-6
 * class (4): the live review tier is asked first on every deny-to-allow
 * transition, so no row a reviewed HEAD puts before a human is ever priced
 * here as an inert relaxation), and `open` for anything else, including every
 * other row on which the migration newly denies, which this generator can
 * never license. `open` is a loud result: the fixture test fails on it.
 *
 * The licensing predicates here are written from the spec and the parse facts,
 * never read off the wall: a predicate that imported the roster it is grading
 * could not fail when the roster narrowed. That independence runs in both
 * directions — this file prices a span as inert only from positive proofs it
 * carries itself (an inert-consumer set it wrote, per-command labels in
 * `tests/fixtures/shell-divergence/independent-class-fixtures.jsonl`, and the
 * baseline hits recorded in the rows), never from an absence in any production
 * roster, and the grader re-derives every license from those same fixture-side
 * facts, so a name dropped from either side fails loudly instead of re-tagging
 * a regression `same`.
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
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { checkCorpusLine } from "./shell-parse-divergence.ts";
import {
  analyzeSecurityReview,
  commandContainsSensitivePath,
  findDangerousPattern,
  type DangerousPatternHit,
} from "../src/harness/permission/hard-walls.js";
import type { SecurityReviewRequirement } from "../src/harness/permission/security-review.js";
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
  | "same"
  | "expected-relaxation"
  | "authorized-id-move"
  | "fixed"
  | "security-review"
  | "open";

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

/**
 * ADR-0127's per-call answers for a reviewed row: policy evaluates the
 * requirement above both mode branches, so an interactive default and an
 * interactive full_auto call each ask.
 */
export interface ReviewEvidence {
  readonly default: "ask";
  readonly full_auto: "ask";
}

export interface DifferentialRow {
  readonly command: string;
  readonly wall: WallName;
  readonly base: WallValue;
  readonly head: WallValue;
  readonly label: DivergenceLabel;
  readonly class?: RelaxationClass;
  readonly clause?: string;
  /** The evidence a `fixed` or `security-review` row arrives with. */
  readonly span?: FactSpan;
  readonly cause?: string;
  readonly review?: ReviewEvidence;
}

/** One wall answered by one side of the differential. */
export interface Oracle {
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
 * The oracle's validity hinge, moved from comparison to construction: every
 * module the copied file imports at RUNTIME is written from its own base blob,
 * so a sibling that drifted in the working tree (a repaired receiver
 * attribution, a moved roster) cannot silently change what the frozen copy
 * computes. Type-only specifiers are left untouched — they carry no runtime
 * edge and are erased when the mirror is loaded. `node_modules` is symlinked
 * into the scratch root so the mirror's package requires resolve the same
 * bindings the repository's would.
 */
function materializeOracleModule(
  rev: string,
  relPath: string,
  outDir: string,
  written: Map<string, string>
): string {
  const cached = written.get(relPath);
  if (cached !== undefined) return cached;
  const file = join(
    outDir,
    `base-${relPath.replace(/[/.]/g, "_")}.ts`
  );
  written.set(relPath, file);
  const source = gitShow(rev, relPath);
  const dir = dirname(relPath);
  const runtime = new Set(runtimeSiblingPaths(relPath, source));
  const rewritten = source.replace(
    /from "(\.{1,2}\/[^"]+\.js)"/g,
    (match, spec: string) => {
      const abs = resolve(REPO_ROOT, dir, spec.replace(/\.js$/, ".ts"));
      const edge = relative(REPO_ROOT, abs).replace(/\\/g, "/");
      if (!runtime.has(edge)) return match;
      return `from "${materializeOracleModule(rev, edge, outDir, written)}"`;
    }
  );
  writeFileSync(file, rewritten);
  return file;
}

/**
 * The runtime import edges of one source: statements beginning `import type`
 * or `export type` are stripped first, because they contribute nothing the
 * copy can observe at load.
 */
function runtimeSiblingPaths(relPath: string, source: string): string[] {
  const stripped = source
    .replace(/^[ \t]*import\s+type\s+[\s\S]*?from\s+"[^"]+";?[ \t]*$/gm, "")
    .replace(/^[ \t]*export\s+type\s+[\s\S]*?from\s+"[^"]+";?[ \t]*$/gm, "");
  const dir = dirname(relPath);
  const edges: string[] = [];
  for (const match of stripped.matchAll(/from\s+"(\.{1,2}\/[^"]+\.js)"/g)) {
    const abs = resolve(REPO_ROOT, dir, match[1]!.replace(/\.js$/, ".ts"));
    edges.push(relative(REPO_ROOT, abs).replace(/\\/g, "/"));
  }
  return [...new Set(edges)];
}

/** The base `hard-walls.ts` and its runtime graph, mirrored outside the repo. */
function materializeBaseSource(rev: string, outDir: string): string {
  symlinkSync(join(REPO_ROOT, "node_modules"), join(outDir, "node_modules"));
  return materializeOracleModule(rev, WALL_PATH, outDir, new Map());
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
export function blankSpans(text: string, spans: readonly FactSpan[]): string {
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
 * The receivers this file positively classifies as inert data consumers: names
 * whose own sweeps it has priced as treating operands as text, written here as
 * fixture data with their expectations labeled per command in
 * `independent-class-fixtures.jsonl`. This is the only path to a `data` owner:
 * absence from the carriers and wrappers proves nothing, so an unlisted head
 * like `chroot` is classified as unproven, never as inert (SC-S2-9).
 * `awk` is deliberately NOT in this set — its program operand can call
 * `system()`, so SC-S2-9 keeps it outside the proof of inertness and its
 * security-relevant operands land before the review tier instead.
 */
const PROVEN_INERT_CONSUMERS: ReadonlySet<string> = new Set([
  "echo",
  "cat",
  "test",
  "head",
  "grep",
  "printf",
  "ls",
  "notify-send",
]);

/**
 * Names that run what they are handed somewhere other than in this shell: `ssh`
 * and `su` hand the words to a shell on the far side or under another uid,
 * `docker` / `podman` / `kubectl exec` spawn them, `watch`, `parallel` and
 * `xargs` build a command out of them. An operand run elsewhere is not data in
 * SC-S2-1's third-flip sense, so no relaxation class may license a span one of
 * these names was handed. This list is the ledger's own classification, written
 * from the spec and priced through the carrier sweep; a wall that stops
 * denying any swept shape fails the fixture test on the wall's live answer, not
 * on a comparison of the two declarations.
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
 * it as the program's own argv. Ledger-owned classifications like the carrier
 * list, each priced by a swept shape that must stay denied on both sides.
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
 * what they are handed. A prefix answered as an ordinary data command here
 * hands its operand to class 3: `timeout 5 rm -rf /x` relaxed would be excused,
 * not opened, so every wrapper spelling is swept as a shape that must stay
 * unlicensable.
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
 * What owns a node's command position: a named command, a positively
 * classified inert consumer, an executor this file has no label for, or
 * nothing it can name because a wrapper prefix ran out into a token it does not
 * model (`sudo -u root …`, whose arity the wall reads and this ledger
 * deliberately does not import). The last two arms license nothing: SC-S2-9
 * refuses the inference "absent from the runner list, therefore data", so an
 * unlisted head like `chroot` is `unproven` and its operands are never
 * class-(3) material.
 */
export type NodeOwner =
  | { readonly state: "owner"; readonly at: number }
  | { readonly state: "data" }
  | { readonly state: "unproven" }
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

/** Does this folded word name own (execute) what follows it? */
function ownsExecutedOperand(name: string): boolean {
  return EXECUTED_OPERAND_NAMES.has(name) || isDestructiveName(name);
}

/** A word with no wrapper ahead of it: proven data consumer or unproven. */
function firstWordOwner(name: string): NodeOwner {
  return PROVEN_INERT_CONSUMERS.has(name)
    ? { state: "data" }
    : { state: "unproven" };
}

/** The node's command position, folded the way the wall folds. Exported for
 * the fixture test, which prices its labeled unknown-executor cases through it
 * without reading any production declaration. */
export function nodeOwner(argv: readonly WordFact[]): NodeOwner {
  let wrapped = false;
  for (let i = 0; i < argv.length; i += 1) {
    const name = wordName(argv[i]);
    if (ownsExecutedOperand(name)) return { state: "owner", at: i };
    if (TRANSPARENT_WRAPPERS.has(name)) {
      wrapped = true;
      continue;
    }
    if (wrapped && isWrapperArgument(argv[i]!)) continue;
    if (wrapped) return { state: "unresolved", at: i };
    return firstWordOwner(name);
  }
  if (wrapped) return { state: "unresolved", at: argv.length };
  return argv.length === 0 ? { state: "data" } : { state: "unproven" };
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
 * A quoted-delimiter heredoc body whose receiver, wrappers folded, is
 * positively classified as an inert data consumer — so the body is that
 * command's data. A missing `receiverCommandIndex`, a receiver the parse does
 * not name, and a receiver this file cannot prove inert are all unresolved
 * cases, never data by fallback (SC-S2-6).
 */
export function dataHeredocSpans(facts: SecurityParseOkFacts): FactSpan[] {
  const spans: FactSpan[] = [];
  for (const heredoc of facts.heredocs) {
    if (!heredoc.delimiterQuoted) continue;
    const receiver = facts.commands.find(
      (command) => command.index === heredoc.receiverCommandIndex
    );
    if (receiver === undefined) continue;
    if (nodeOwner(receiver.argv).state !== "data") continue;
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
  readonly cause?: string;
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
export function quoteLicensedSpans(command: string): FactSpan[] {
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
export function inertLicensedSpans(command: string): FactSpan[] {
  const facts = factsOf(command);
  if (facts === null) return [];
  return [...inertTextSpans(facts), ...dataHeredocSpans(facts)];
}

/**
 * Operands of a command that eats no code, runs nothing it is handed and is not
 * itself destructive — the only operands class (3) may call data.
 */
export function operandLicensedSpans(command: string): FactSpan[] {
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

/**
 * The two code-bearing fork-bomb shapes SC-S2-8 authorizes to newly deny, and
 * the hit the structural rule must report for the authorization to hold. The
 * direct form is not here — it keeps its deny and owns the one authorized id
 * move instead.
 */
const AUTHORIZED_NEW_DENY_SHAPES: readonly string[] = [
  "eval ':(){ :|:& };:'",
  "bash -c ':(){ :|:& };:'",
];

const FORK_BOMB_DENY: DangerousPatternHit = {
  id: "destructive-disk",
  pattern: ":(){ :|:& };:",
};

const NEW_DENY_CAUSE =
  "specs/hard-wall-ast-migration.md SC-S2-8: a confirmed fork-bomb structure supplied as code to eval or a shell -c operand";

function isAuthorizedNewDeny(
  command: string,
  head: DangerousPatternHit
): boolean {
  return (
    AUTHORIZED_NEW_DENY_SHAPES.includes(command) &&
    head.id === FORK_BOMB_DENY.id &&
    head.pattern === FORK_BOMB_DENY.pattern
  );
}

export function classifyPattern(
  command: string,
  base: DangerousPatternHit | null,
  head: DangerousPatternHit | null,
  oracle: Oracle
): Verdict {
  if (valuesEqual(base, head)) return { label: "same" };
  if (base === null) {
    return head !== null && isAuthorizedNewDeny(command, head)
      ? { label: "fixed", cause: NEW_DENY_CAUSE }
      : { label: "open" };
  }
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

/**
 * A review row's evidence: ADR-0127's requirement carries the unresolved span
 * and typed cause, and policy evaluates the requirement above both mode
 * branches, so each interactive call answers `ask`.
 */
function reviewRowEvidence(requirement: SecurityReviewRequirement): {
  label: "security-review";
  span: FactSpan;
  cause: string;
  review: ReviewEvidence;
} {
  return {
    label: "security-review",
    span: requirement.span,
    cause: `${requirement.cause}: ${requirement.detail}`,
    review: { default: "ask", full_auto: "ask" },
  };
}

/**
 * SC-S2-6 class (4): the review tier is asked FIRST on any deny-to-allow
 * transition. A command live HEAD routes to security review records the
 * requirement's span, typed cause and both-mode ask evidence — never a
 * relaxation that prices reviewed content as inert. An `invalid` or `fault`
 * scan ends in a typed flow deny, so such a transition is left unresolved
 * (`open`) and fails the fixture loudly instead of being priced inert.
 */
export function priceWall(
  command: string,
  base: WallValue,
  head: WallValue,
  classify: () => Verdict
): Verdict & Pick<DifferentialRow, "span" | "review"> {
  if (denies(base) && !denies(head)) {
    const scan = analyzeSecurityReview(command);
    if (scan.verdict === "review") {
      return reviewRowEvidence(scan.requirement);
    }
    if (scan.verdict !== "clean") return { label: "open" };
  }
  return classify();
}

export function buildRows(
  commands: readonly string[],
  oracle: Oracle
): DifferentialRow[] {
  const rows: DifferentialRow[] = [];
  for (const command of commands) {
    const patternBase = oracle.pattern(command);
    const patternHead = headOracle.pattern(command);
    const sensitiveBase = oracle.sensitive(command);
    const sensitiveHead = headOracle.sensitive(command);
    const pattern = priceWall(
      command,
      patternBase,
      patternHead,
      () => classifyPattern(command, patternBase, patternHead, oracle)
    );
    const sensitive = priceWall(
      command,
      sensitiveBase,
      sensitiveHead,
      () => classifySensitive(command, sensitiveBase, sensitiveHead, oracle)
    );
    rows.push(
      {
        command,
        wall: "pattern",
        base: patternBase,
        head: patternHead,
        ...pattern,
      },
      {
        command,
        wall: "sensitive",
        base: sensitiveBase,
        head: sensitiveHead,
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

/**
 * Every shape the carrier floor is priced on: each roster carrier, every
 * folded wrapper, the store-or-run four, and the carrier heredoc — all of them
 * in the priced population, all of them denied on both sides. The fixture test
 * re-checks every one, so a name dropped from the wall's roster surfaces as a
 * loud failure on the wall's live answer, not on a comparison of declarations.
 */
export function carrierFloorShapes(): string[] {
  return [
    ...carrierSweepShapes(),
    ...carrierShapes(),
    ...CARRIER_HEREDOC_SHAPES,
    ...wrapperShapes(),
  ];
}

/**
 * The shapes whose receiver or head this file cannot positively classify —
 * carriers, wrappers, store-or-run names, unknown executors, bodies with no
 * attributed receiver. None of them may ever be licensed as an inert
 * relaxation, whether or not the wall currently allows them.
 */
export function unlicensableFloorShapes(): string[] {
  return [
    ...carrierFloorShapes(),
    ...UNPROVEN_EXECUTOR_SHAPES,
    ...nullReceiverHeredocShapes(),
  ];
}

/**
 * The license's own floor, asked where only this file can ask it: hand each
 * carrier, wrapper-fold, and unknown-executor shape to the licensing
 * predicates as if the wall had stopped denying it, and require the answer
 * `open`. A shape that came back `expected-relaxation` would mean this
 * generator could excuse the very regression the rosters exist to catch —
 * including the regression of a roster narrowing on one side only.
 */
function assertCarrierOperandsUnlicensable(oracle: Oracle): void {
  for (const command of unlicensableFloorShapes()) {
    const base = oracle.pattern(command);
    const head = headOracle.pattern(command);
    if (base === null && head === null) continue;
    if (base === null) {
      throw new Error(
        `carrier floor shape has no pre-state deny to price: ${JSON.stringify(command)}`
      );
    }
    const verdict = classifyPattern(command, base, null, oracle);
    if (verdict.label !== "open") {
      throw new Error(
        `an unlicensable operand would be licensed: ${JSON.stringify(command)} ` +
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

/**
 * The names the inert sweep prices, one spelling per class-(3) supplier the
 * ledger owns. The sweep and the `data` classification read this one list, so
 * a name can never be swept as inert while being priced as something else.
 */
const INERT_NAMES: readonly string[] = [...PROVEN_INERT_CONSUMERS];

/**
 * The name SC-S2-9 withholds from the positive-inert set on purpose — `awk`'s
 * program operand can call `system()`. Swept in the same four spellings as
 * the inert names so the withholding is priced, not asserted: a
 * security-relevant awk operand must land before the review tier, never
 * inside a data license.
 */
const EXCLUDED_FROM_INERT_NAMES: readonly string[] = ["awk"];

/** One real invocation per name × roster literal, in each operand spelling. */
function sweepFor(names: readonly string[]): string[] {
  return names.flatMap((name) =>
    SWEEP_LITERALS.flatMap((literal) => [
      `${name} ${literal}`,
      `${name} '${literal}'`,
      `${name} "${literal}"`,
      `${name} notes.txt # ${literal}`,
    ])
  );
}

/** An executor no roster of this file knows: neither carrier, wrapper, nor
 * proven inert consumer — the class SC-S2-9 keeps out of the inert set. */
const UNPROVEN_EXECUTOR_SHAPES: readonly string[] = [
  "chroot /srv rm -rf /tmp/x",
  "chroot /srv shutdown -h now",
];

/** Every inert name × every roster literal, in each inert spelling. */
function inertNameSweepShapes(): string[] {
  return sweepFor(INERT_NAMES);
}

/** The excluded-name sweep, priced in the ledger as review, never as data. */
export function excludedFromInertSweepShapes(): string[] {
  return sweepFor(EXCLUDED_FROM_INERT_NAMES);
}

/**
 * Heredocs whose receiver the parse genuinely cannot attribute: an assignment
 * prefix owning no command, a redirect hoisted onto a pipeline or a compound
 * statement. None of them may be priced as data; on HEAD each one with
 * relevant dangerous content is the review tier's (`receiver-unresolved`).
 * `cd /tmp && cat <<'EOF'` is NOT here: the list-body attribution repair names
 * `cat` as the receiver, which makes its quoted body a data body under the
 * proven-inert rule.
 */
function nullReceiverHeredocShapes(): string[] {
  return [
    "FOO=1 <<'EOF'\nrm -rf /tmp/x\nEOF",
    "FOO=1 <<'EOF'\nid_rsa\nEOF",
    "echo a | cat <<'EOF'\nrm -rf /tmp/x\nEOF",
    "{ true; } <<'EOF'\nrm -rf /tmp/x\nEOF",
  ];
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
    // The list- and compound-body attributions SC-S2-7 pins: the receiver is
    // parse-derived in a multi-command segment, so `cat`'s quoted bodies here
    // are data bodies under the positive-inert rule.
    "cd /tmp && cat <<'EOF'\nrm -rf /tmp/x\nEOF",
    "cd /tmp && cat <<'EOF'\nid_rsa\nEOF",
    "if true; then cat <<'EOF'\nrm -rf /tmp/x\nEOF\nfi",
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
    excludedFromInertSweepShapes(),
    [...UNPROVEN_EXECUTOR_SHAPES],
    heredocShapes(),
    nullReceiverHeredocShapes(),
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

/** Both recorded answers are `ask`: the review reached the human surface. */
function reviewedAsAsk(row: DifferentialRow): boolean {
  return (
    row.review !== undefined &&
    row.review.default === "ask" &&
    row.review.full_auto === "ask"
  );
}

/** The evidence bumps a `security-review` row arrives with. */
function securityReviewBumps(row: DifferentialRow): string[] {
  const keys = [
    "deny-to-review",
    reviewedAsAsk(row) ? "reviewed-ask" : "review-evidence-missing",
  ];
  if (row.cause !== undefined) {
    keys.push(`review-cause:${row.cause.split(":")[0]}`);
  }
  return keys;
}

/** Row-kind → extra report keys, one table per label (the bump names are the
 * report vocabulary; unknown labels contribute nothing). */
const LABEL_ROW_BUMPS: Readonly<
  Partial<Record<DivergenceLabel, (row: DifferentialRow) => string[]>>
> = {
  "expected-relaxation": (row) => [
    row.clause === undefined ? "clauseless" : "cited",
  ],
  "security-review": securityReviewBumps,
  fixed: () => ["authorized-new-deny"],
};

/** The report buckets one row falls into. */
function rowBumps(row: DifferentialRow): string[] {
  const keys = [`label:${row.label}`];
  if (row.class !== undefined) keys.push(`class:${row.class}`);
  const labelBumps = LABEL_ROW_BUMPS[row.label];
  if (labelBumps !== undefined) keys.push(...labelBumps(row));
  if (!denies(row.base) && denies(row.head)) keys.push("new-deny");
  if (denies(row.base) && !denies(row.head) && row.label !== "security-review")
    keys.push("new-allow");
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
