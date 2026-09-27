/**
 * #562 T4: Readonly command validator for bash readonly mode.
 *
 * Pure function module — no shared mutable state, no I/O. Policy tables are
 * frozen data. Called by the bash handler when `bashMode === "readonly"`,
 * placed between `isDangerousCommand` and `commandContainsSensitivePath` in
 * the enforcement sequence:
 *
 *   isDangerousCommand → validateReadonlyCommand → commandContainsSensitivePath → bwrap fence
 *
 * `$(...)` / backticks / `${}` are rejected upstream by `findDangerousPattern`
 * (via `isDangerousCommand`); this validator does NOT re-declare those rules.
 *
 * Admission model (SC-S4-1, Stage 4a): `parseForSecurity` grades the command.
 *   - `ok` verdict → the command is admitted through *named parse claims* over
 *     the facts: units are the text ranges between top-level separator
 *     operator spans, and each unit carries
 *     (1a) a word-text mark: a word whose text (quotes included) contains
 *          `&` or `>` keeps today's denial;
 *     (1b) an owned redirect mark: a redirect fact owned by the unit (via
 *          `redirects[].ownerCommandIndex`) whose operator text contains `>`
 *          (which also catches `>&` / `&>`-style operators, but there the
 *          `&` claim fires first, mirroring today's check order);
 *     (1c) a background mark: a `background` (or `|&` `pipe-both`) list
 *          operator fact touching the unit — the `&` that terminates a
 *          command rather than the `&&` that joins two.
 *     The claim vocabulary is exactly the three strictenings below, restated
 *     from a segment-text scan to a parse-fact scan; the tables are consulted
 *     per raw token (quotes included), as today. A quoted or escaped `;`
 *     `|` `&` — text the quote-blind fold cut or marked on and denied — makes
 *     the facts path abstain, so it never un-does one of those denials.
 *   - any non-`ok` verdict (`unknown-syntax` / `malformed` / `aborted` /
 *     `over-cap` / `parser-unavailable`) and the pre-parse `vetoed` arm →
 *     the text fold (`validateReadonlyTextPath`) answers with today's
 *     segment-scan verdict — keep-today's-answer, add no throw
 *     (docs/shell-parse-non-ok-consumer-contracts.md).
 *   - an `ok` parse whose facts this gate cannot fully attribute (a command
 *     node nested in a substitution or compound scope, an ownerless redirect,
 *     a separator with no command to attribute, text not covered by word /
 *     redirect spans) also degrades to the text fold, so the facts
 *     path never answers a shape it does not completely see.
 */

import { ToolExecutionError } from "../../errors.js";
import { firstToken } from "../../permission/hard-walls.js";
import { splitShellSegments } from "../../permission/text-segments.js";
import {
  parseForSecurity,
  type FactSpan,
  type OperatorFact,
  type RedirectFact,
  type SecurityParseOk,
  type WordFact,
} from "../../permission/shell-parse.js";

/**
 * #562 T4: Typed error for readonly mode violations.
 *
 * Extends `ToolExecutionError` (same as `NetworkViolationError` precedent) so
 * the executor's `sanitizeFailure` returns `err.message` directly to the model.
 * Carries a readonly `context` field mirroring `SubAgentSandboxRootError`.
 * Message includes alternative tool guidance (read_file / grep / glob / lsp_*).
 */
export class ReadonlyViolationError extends ToolExecutionError {
  readonly context: {
    readonly command: string;
    readonly reason: string;
  };
  constructor(context: { readonly command: string; readonly reason: string }) {
    super(
      `bash readonly: ${context.reason}. Use read_file / grep / glob / lsp_* tools for read operations instead of bash. Command: ${context.command}`
    );
    this.context = context;
  }
}

/* ---------------------------------------------------------------------------
 * Policy tables (pure data, frozen; no shared mutable state)
 * ------------------------------------------------------------------------- */

/** Class 1: Execution agents — directly forbidden regardless of flags. */
const FORBIDDEN_COMMANDS: ReadonlySet<string> = Object.freeze(
  new Set(["env", "xargs", "time", "nohup", "timeout"])
);

/** Class 3: Pure read commands — bare allow, any flags. */
const READONLY_ALLOWED: ReadonlySet<string> = Object.freeze(
  new Set([
    "ls",
    "cat",
    "grep",
    "wc",
    "stat",
    "du",
    "df",
    "ps",
    "diff",
    "sha256sum",
    "md5sum",
    "jq",
    "head",
    "tail",
    "printenv",
    "rg",
    "file",
    "which",
    "whereis",
    "uname",
    "hostname",
    "id",
    "whoami",
    "date",
    "pwd",
    "echo",
    "printf",
    "true",
    "false",
    "basename",
    "dirname",
    "realpath",
    "readlink",
    "column",
    "nl",
    "fold",
    "od",
    "xxd",
    "hexdump",
    "strings",
  ])
);

/** Class 2: find — denied flags (write/execute side effects). */
const FIND_DENIED_FLAGS: ReadonlySet<string> = Object.freeze(
  new Set([
    "-delete",
    "-exec",
    "-execdir",
    "-ok",
    "-okdir",
    "-fprint",
    "-fprint0",
    "-fprintf",
    "-fls",
  ])
);

/** Class 2: sort — denied flags (write output to file). */
const SORT_DENIED_FLAGS: ReadonlySet<string> = Object.freeze(
  new Set([
    "-o",
    "--output",
    "-T",
    "--temporary-directory",
    "--compress-program",
  ])
);

/** Class 2: git — read-only subcommand whitelist. */
const GIT_ALLOWED_SUBCOMMANDS: ReadonlySet<string> = Object.freeze(
  new Set([
    "status",
    "log",
    "diff",
    "show",
    "rev-parse",
    "ls-files",
    "ls-tree",
    "describe",
    "shortlog",
    "blame",
    "reflog",
    "rev-list",
    "cat-file",
    "name-rev",
    "grep",
    "whatchanged",
    "count-objects",
    "verify-pack",
    "fsck",
    "remote",
  ])
);

/**
 * Git global flags that consume the next token as an argument. Used to
 * correctly identify the git subcommand position when such flags appear
 * (e.g. `git -C /path status` → subcommand is `status`, not `/path`).
 */
const GIT_GLOBAL_FLAGS_WITH_ARGS: ReadonlySet<string> = Object.freeze(
  new Set(["-C", "--git-dir", "--work-tree", "--namespace", "--super-prefix"])
);

/** Git nested actions/flags that mutate local repository state. */
const GIT_REMOTE_MUTATING_SUBCOMMANDS: ReadonlySet<string> = Object.freeze(
  new Set([
    "add",
    "rename",
    "remove",
    "set-head",
    "prune",
    "update",
    "set-branches",
    "set-url",
  ])
);
const GIT_REFLOG_MUTATING_ACTIONS: ReadonlySet<string> = Object.freeze(
  new Set(["delete", "drop", "expire", "write"])
);
const GIT_FSCK_MUTATING_FLAGS: ReadonlySet<string> = Object.freeze(
  new Set(["--lost-found"])
);

/* ---------------------------------------------------------------------------
 * Validator
 * ------------------------------------------------------------------------- */

/**
 * The admission unit both verdict paths share: the three strictening claims
 * (1a/1b/1c folded into `ampersand` / `greaterThan`) plus the raw token list
 * (quotes included, exactly what the old whitespace tokenizer produced) the
 * policy and flag tables are consulted with.
 */
interface ReadonlyUnit {
  /** `&` claim: background operator (1c), or a word text / redirect
   * operator carrying `&` (1a/1b). Checked first, as today. */
  readonly ampersand: boolean;
  /** `>` claim: output-redirect operator (1b), or a word text carrying `>`
   * (1a). */
  readonly greaterThan: boolean;
  readonly tokens: readonly string[];
}

/**
 * Validate a command for readonly mode. Throws `ReadonlyViolationError` on
 * violation; returns silently if the command is allowed.
 *
 * Called by the bash handler when `bashMode === "readonly"`. Assumes the
 * command has already passed `isDangerousCommand` (so `$(...)` / backticks /
 * `${}` / `<(...)` / newlines are already excluded upstream).
 *
 * An `ok` parse answers from the named parse claims via
 * `readonlyUnitsFromFacts`; every other verdict — and any `ok` parse whose
 * facts cannot be fully attributed — answers from the text fold, which is
 * today's segment-scan path unchanged (SC-S4-1's keep-today's-answer
 * contract, docs/shell-parse-non-ok-consumer-contracts.md).
 */
export function validateReadonlyCommand(command: string): void {
  const parsed = parseForSecurity(command);
  if (parsed.kind === "ok") {
    const units = readonlyUnitsFromFacts(parsed);
    if (units !== null) {
      for (const unit of units) {
        admitUnit(unit, command);
      }
      return;
    }
  }
  validateReadonlyTextPath(command);
}

/**
 * The text fold: today's quote-blind segment scan, retained verbatim as the
 * answer for every non-`ok` parse verdict (the wall pre-empts the hard-deny
 * verdicts before this gate is reached in production, so what lands here is
 * `unknown-syntax`, `vetoed`, and the degrade arms). Also the answer when the
 * facts path abstains on a shape it cannot fully attribute.
 */
function validateReadonlyTextPath(command: string): void {
  const segments = splitShellSegments(command);
  if (segments.length === 0) {
    throw new ReadonlyViolationError({
      command,
      reason: "empty command has no read-only semantics",
    });
  }
  for (const segment of segments) {
    validateSegment(segment, command);
  }
}

function validateSegment(segment: string, command: string): void {
  admitUnit(
    {
      // Strictening 1: bare & (background operator) — the raw-text reading,
      // where `&&` is already consumed by the text splitter so any remaining
      // `&` in a segment is bare `&`, `&>`, or `2>&1` (conservative reject).
      ampersand: segment.includes("&"),
      // Strictening 2: output redirection (>, >>, &>, 2>). Catching any `>`
      // in the segment covers all output-redirect forms. Quoted `>` strings
      // are a rare false-positive cost; deny-by-default accepts it.
      greaterThan: segment.includes(">"),
      tokens: tokenize(segment),
    },
    command
  );
}

/**
 * The shared admission step for one unit, in today's fixed order:
 * the `&` claim, then the `>` claim, then the policy lookup.
 */
function admitUnit(unit: ReadonlyUnit, command: string): void {
  if (unit.ampersand) {
    throw new ReadonlyViolationError({
      command,
      reason: "background operator '&' is not allowed in readonly mode",
    });
  }
  if (unit.greaterThan) {
    throw new ReadonlyViolationError({
      command,
      reason: "output redirection is not allowed in readonly mode",
    });
  }
  validateSegmentTokens(unit.tokens, command);
}

/**
 * Strictening 3 (firstToken policy lookup) as a standalone predicate-style
 * export: throws `ReadonlyViolationError` when the command word is not in
 * the readonly policy, returns silently when it is. Unlike `validateSegment`
 * it does NOT own the `>` / bare-`&` strictenings — those are readonly-MODE
 * rules on the unit as a whole. There is no external consumer: an
 * earlier-era comment claimed the isolation worktree gate whitelisted from
 * this table, and that claim was retracted — `worktree-gate.ts` `classifyCall`
 * stopped consulting the readonly tables entirely when issue 1059 replaced
 * the prediction with the physical ro-bind fence. Today this function and
 * its token-array twin `validateSegmentTokens` are reached only from
 * `admitUnit`, and the export stays as the policy-table seam for the Stage 4b
 * roster consolidation (specs/hard-wall-ast-migration.md SC-S4-4).
 */
export function validateSegmentPolicy(segment: string, command: string): void {
  validateSegmentTokens(tokenize(segment), command);
}

function validateSegmentTokens(
  tokens: readonly string[],
  command: string
): void {
  const token = firstToken(tokens[0] ?? "");
  if (FORBIDDEN_COMMANDS.has(token)) {
    throw new ReadonlyViolationError({
      command,
      reason: `'${token}' is an execution agent, forbidden in readonly mode`,
    });
  }
  if (READONLY_ALLOWED.has(token)) return;
  if (token === "find") {
    validateFindFlags(tokens, command);
    return;
  }
  if (token === "sort") {
    validateSortFlags(tokens, command);
    return;
  }
  if (token === "git") {
    validateGitSubcommand(tokens, command);
    return;
  }
  // Deny-by-default: anything not in any policy entry is rejected.
  throw new ReadonlyViolationError({
    command,
    reason: `'${token}' is not in the readonly command policy`,
  });
}

/**
 * Whitespace tokenizer for a single segment of the text fold. Does not handle
 * quotes — false positives (e.g. `find . -name "-delete"`) are accepted as a
 * deny-by-default cost. The model can avoid flag-like tokens inside quotes in
 * readonly mode. The facts path never calls this: its token list is built
 * from WordFact texts, which carry the same raw (quote-included) spelling.
 */
function tokenize(segment: string): string[] {
  return segment
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

function validateFindFlags(tokens: readonly string[], command: string): void {
  for (let i = 1; i < tokens.length; i += 1) {
    const flag = tokens[i]!;
    if (FIND_DENIED_FLAGS.has(flag)) {
      throw new ReadonlyViolationError({
        command,
        reason: `find flag '${flag}' has write/execute side effects, not allowed in readonly mode`,
      });
    }
  }
}

function validateSortFlags(tokens: readonly string[], command: string): void {
  for (let i = 1; i < tokens.length; i += 1) {
    const flag = tokens[i]!;
    if (
      SORT_DENIED_FLAGS.has(flag) ||
      flag.startsWith("--output=") ||
      flag.startsWith("--temporary-directory=") ||
      flag.startsWith("--compress-program=") ||
      (flag.startsWith("-T") && flag.length > 2)
    ) {
      throw new ReadonlyViolationError({
        command,
        reason: `sort flag '${flag}' has file-write or execution side effects, not allowed in readonly mode`,
      });
    }
  }
}

function validateGitSubcommand(
  tokens: readonly string[],
  command: string
): void {
  // Global --output rejection (any --output / --output= token in the unit).
  for (const token of tokens) {
    if (token === "--output" || token.startsWith("--output=")) {
      throw new ReadonlyViolationError({
        command,
        reason: "git --output is not allowed in readonly mode",
      });
    }
  }
  // Find the git subcommand: first non-flag token after `git`, skipping
  // global flags that take arguments (`git -C /path status` → subcommand
  // is `status`, not `/path`).
  let i = 1;
  while (i < tokens.length) {
    const token = tokens[i]!;
    if (token.startsWith("-")) {
      if (GIT_GLOBAL_FLAGS_WITH_ARGS.has(token)) i += 2;
      else i += 1;
      continue;
    }
    // Found the subcommand candidate.
    if (!GIT_ALLOWED_SUBCOMMANDS.has(token)) {
      throw new ReadonlyViolationError({
        command,
        reason: `git subcommand '${token}' is not in the readonly whitelist`,
      });
    }
    validateGitMutation(tokens, i, token, command);
    return;
  }
  // No subcommand found (bare `git` or only flags).
  throw new ReadonlyViolationError({
    command,
    reason:
      "git command has no subcommand; readonly mode requires an explicit read-only subcommand",
  });
}

function validateGitMutation(
  tokens: readonly string[],
  subcommandIndex: number,
  subcommand: string,
  command: string
): void {
  if (subcommand === "remote") {
    const nested = firstNonFlagToken(tokens, subcommandIndex + 1);
    if (nested !== undefined && GIT_REMOTE_MUTATING_SUBCOMMANDS.has(nested)) {
      throw new ReadonlyViolationError({
        command,
        reason: `git remote subcommand '${nested}' mutates repository configuration, not allowed in readonly mode`,
      });
    }
  }
  if (subcommand === "reflog") {
    const action = firstNonFlagToken(tokens, subcommandIndex + 1);
    if (action !== undefined && GIT_REFLOG_MUTATING_ACTIONS.has(action)) {
      throw new ReadonlyViolationError({
        command,
        reason: `git reflog action '${action}' mutates repository state, not allowed in readonly mode`,
      });
    }
  }
  if (
    subcommand === "fsck" &&
    tokens
      .slice(subcommandIndex + 1)
      .some((token) => GIT_FSCK_MUTATING_FLAGS.has(token))
  ) {
    throw new ReadonlyViolationError({
      command,
      reason:
        "git fsck --lost-found writes recovery files, not allowed in readonly mode",
    });
  }
}

function firstNonFlagToken(
  tokens: readonly string[],
  start: number
): string | undefined {
  for (let i = start; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (!token.startsWith("-")) return token;
  }
  return undefined;
}

/* ---------------------------------------------------------------------------
 * Facts path (SC-S4-1): readonly units derived from the SecurityParseOk facts
 * ------------------------------------------------------------------------- */

/**
 * Operator kinds that carry today's bare-`&` denial: `&` as a terminator
 * (1c's background) and `|&`, whose trailing `&` the quote-blind text fold
 * left inside the following segment and rejected there.
 */
const AMPERSAND_OPERATOR_KINDS: ReadonlySet<string> = Object.freeze(
  new Set(["background", "pipe-both"])
);

/**
 * The separator characters the quote-blind text fold cut or marked on
 * (the internal `text-segments` seam cuts `;` `&&` `||` `|`, and any
 * leftover `&` rode the strictening). On the facts path each occurrence must
 * live inside a
 * top-level operator span; a quoted or escaped occurrence (which the fold
 * cut or marked on and rejected) instead abstains to the fold, so no
 * quote-blind denial is lost.
 */
const FOLD_SEPARATOR_CHARACTERS: ReadonlySet<string> = Object.freeze(
  new Set([";", "|", "&"])
);

interface UnitDraft {
  ampersand: boolean;
  greaterThan: boolean;
  redirects: RedirectFact[];
  words: WordFact[];
}

/**
 * Derive the admission units from an `ok` parse, or return `null` to abstain
 * (the caller then runs the text fold, keeping today's answer). The path
 * commits only when every fact can be attributed:
 *   - there is at least one command node and every command node is
 *     top-level (`depth === 0`) — a nested node means a substitution or
 *     compound scope this gate does not re-admit, and zero command nodes is
 *     the shapes the text fold answers with "empty" or with a punctuation
 *     first token (`&`, `>`, `(ls)`), whose exact denial the fold keeps;
 *   - every operator fact is top-level and every `&`-carrying operator
 *     (background, `|&`) attributes to a command;
 *   - every redirect has a resolvable owner command;
 *   - every `;` / `|` / `&` character in the text sits inside a top-level
 *     operator span (quoted or escaped occurrences abstain to the fold,
 *     which denied them via its quote-blind cut/`&`-scan);
 *   - the text between operators is fully covered by word and redirect
 *     spans up to whitespace — comments, variable-assignment prefixes
 *     (`FOO=bar ls`), or any other unmodelled spelling abstain to the fold.
 *
 * Units are the text ranges between top-level separator-operator spans.
 * Bare line breaks are deliberately NOT cuts: the internal `text-segments`
 * seam never split on `\n`/`\r` (the shape SC-S4-2's correction names), so
 * today's
 * `echo a\nls`-style answers rest on the whole text being one segment whose
 * first token rules; a unit here spans line breaks exactly as one segment
 * did, and `bareNewlineOffsets` / `bareCarriageReturnOffsets` are what prove
 * a line break is a bare separator the grammar consumed without a token —
 * pinned by the newline rows in bash-readonly.test.ts.
 */
function readonlyUnitsFromFacts(ok: SecurityParseOk): ReadonlyUnit[] | null {
  const ranges = readonlyCutRanges(ok);
  if (ranges === null) return null;
  if (!foldSurvivorsAttributed(ok)) return null;
  const drafts = attributeUnitDrafts(ok, ranges);
  if (drafts === null) return null;
  if (!draftsCoveredByFacts(ok.text, ranges, drafts)) return null;
  return buildReadonlyUnits(drafts);
}

/** Steps 0-1: attribution guards, then cut points — top-level separator
 * operators only — and the text ranges between them. */
function readonlyCutRanges(ok: SecurityParseOk): FactSpan[] | null {
  if (ok.commands.length === 0) {
    return null;
  }
  for (const command of ok.commands) {
    if (command.depth !== 0) return null;
  }

  const cuts: FactSpan[] = [];
  for (const operator of ok.operators) {
    if (operator.depth !== 0) return null;
    cuts.push(operator.span);
  }
  return complementOfCuts(cuts, ok.text.length);
}

/** Step 2. Quote-blind survivors: any `;` `|` `&` the fold would have cut or
 * marked on must be a real top-level operator here, or the fold answers. */
function foldSurvivorsAttributed(ok: SecurityParseOk): boolean {
  return ampersandOperatorsAttributed(ok) && separatorCharactersCut(ok);
}

function ampersandOperatorsAttributed(ok: SecurityParseOk): boolean {
  for (const operator of ok.operators) {
    if (!AMPERSAND_OPERATOR_KINDS.has(operator.kind)) continue;
    if (!operatorAttributesToCommand(ok, operator)) return false;
  }
  return true;
}

function operatorAttributesToCommand(
  ok: SecurityParseOk,
  operator: OperatorFact
): boolean {
  return (
    (operator.leftCommandIndex !== null &&
      ok.commands.some((c) => c.index === operator.leftCommandIndex)) ||
    (operator.rightCommandIndex !== null &&
      ok.commands.some((c) => c.index === operator.rightCommandIndex))
  );
}

function separatorCharactersCut(ok: SecurityParseOk): boolean {
  for (let index = 0; index < ok.text.length; index += 1) {
    if (!FOLD_SEPARATOR_CHARACTERS.has(ok.text[index]!)) continue;
    if (!ok.operators.some((o) => o.span.start <= index && index < o.span.end)) {
      return false;
    }
  }
  return true;
}

/** Step 3. Attribute commands, redirects, operators, and words to ranges by
 * span position. */
function attributeUnitDrafts(
  ok: SecurityParseOk,
  ranges: readonly FactSpan[]
): UnitDraft[] | null {
  const drafts: UnitDraft[] = ranges.map(() => ({
    ampersand: false,
    greaterThan: false,
    redirects: [],
    words: [],
  }));
  const unitOfCommand = new Map<number, number>();
  if (!attributeCommands(ok, ranges, unitOfCommand)) return null;
  if (!attributeRedirects(ok, ranges, drafts, unitOfCommand)) return null;
  if (!attributeAmpersandOperators(ok, drafts, unitOfCommand)) return null;
  if (!attributeWords(ok, ranges, drafts)) return null;
  return drafts;
}

function attributeCommands(
  ok: SecurityParseOk,
  ranges: readonly FactSpan[],
  unitOfCommand: Map<number, number>
): boolean {
  for (const command of ok.commands) {
    const slot = rangeIndexCovering(ranges, command.span);
    if (slot === null || !withinRange(command.span, ranges[slot]!)) {
      return false;
    }
    unitOfCommand.set(command.index, slot);
  }
  return true;
}

function attributeRedirects(
  ok: SecurityParseOk,
  ranges: readonly FactSpan[],
  drafts: UnitDraft[],
  unitOfCommand: ReadonlyMap<number, number>
): boolean {
  for (const redirect of ok.redirects) {
    const slot = redirectOwnerSlot(redirect, unitOfCommand);
    if (slot === null || !withinRange(redirect.span, ranges[slot]!)) {
      return false;
    }
    markRedirectDraft(drafts[slot]!, redirect);
  }
  return true;
}

function redirectOwnerSlot(
  redirect: RedirectFact,
  unitOfCommand: ReadonlyMap<number, number>
): number | null {
  const owner = redirect.ownerCommandIndex;
  if (owner === null) return null;
  const slot = unitOfCommand.get(owner);
  return slot === undefined ? null : slot;
}

function markRedirectDraft(draft: UnitDraft, redirect: RedirectFact): void {
  draft.redirects.push(redirect);
  if (redirect.op.includes("&") || redirect.target.text.includes("&")) {
    draft.ampersand = true;
  }
  if (redirect.op.includes(">") || redirect.target.text.includes(">")) {
    draft.greaterThan = true;
  }
}

function attributeAmpersandOperators(
  ok: SecurityParseOk,
  drafts: UnitDraft[],
  unitOfCommand: ReadonlyMap<number, number>
): boolean {
  for (const operator of ok.operators) {
    if (!AMPERSAND_OPERATOR_KINDS.has(operator.kind)) continue;
    const slot =
      operator.leftCommandIndex !== null
        ? unitOfCommand.get(operator.leftCommandIndex)
        : operator.rightCommandIndex !== null
          ? unitOfCommand.get(operator.rightCommandIndex)
          : undefined;
    if (slot === undefined) return false;
    drafts[slot]!.ampersand = true;
  }
  return true;
}

function attributeWords(
  ok: SecurityParseOk,
  ranges: readonly FactSpan[],
  drafts: UnitDraft[]
): boolean {
  for (const word of ok.words) {
    const slot = rangeIndexCovering(ranges, word.span);
    if (slot === null || !withinRange(word.span, ranges[slot]!)) return false;
    const draft = drafts[slot]!;
    draft.words.push(word);
    if (word.text.includes("&")) draft.ampersand = true;
    if (word.text.includes(">")) draft.greaterThan = true;
  }
  return true;
}

/** Step 4. Coverage: within each range, everything that is not whitespace
 * must sit inside a word or redirect span. */
function draftsCoveredByFacts(
  text: string,
  ranges: readonly FactSpan[],
  drafts: readonly UnitDraft[]
): boolean {
  for (let index = 0; index < ranges.length; index += 1) {
    const range = ranges[index]!;
    const draft = drafts[index]!;
    const covered: FactSpan[] = [
      ...draft.words.map((word) => word.span),
      ...draft.redirects.map((redirect) => redirect.span),
    ];
    if (!spansCoverRange(text, range, covered)) return false;
  }
  return true;
}

/** Step 5. Build the token list per unit: word texts plus each redirect's
 * operator text at its span start — the same raw strings (quotes and escapes
 * included) the old per-segment whitespace tokenizer produced. */
function buildReadonlyUnits(drafts: readonly UnitDraft[]): ReadonlyUnit[] {
  const units: ReadonlyUnit[] = [];
  for (const draft of drafts) {
    if (draft.words.length === 0 && draft.redirects.length === 0) continue;
    const pieces: { start: number; text: string }[] = [
      ...draft.words.map((word) => ({
        start: word.span.start,
        text: word.text,
      })),
      ...draft.redirects.map((redirect) => ({
        start: redirect.span.start,
        text: redirect.op,
      })),
    ];
    pieces.sort((left, right) => left.start - right.start);
    units.push({
      ampersand: draft.ampersand,
      greaterThan: draft.greaterThan,
      tokens: pieces.map((piece) => piece.text),
    });
  }
  return units;
}

function withinRange(span: FactSpan, range: FactSpan): boolean {
  return range.start <= span.start && span.end <= range.end;
}

/** Sorted, merged cut intervals → the ranges of text between them. */
function complementOfCuts(cuts: readonly FactSpan[], length: number): FactSpan[] {
  const sorted = [...cuts].sort((left, right) => left.start - right.start);
  const ranges: FactSpan[] = [];
  let cursor = 0;
  for (const cut of sorted) {
    if (cut.start > cursor) ranges.push({ start: cursor, end: cut.start });
    cursor = Math.max(cursor, cut.end);
  }
  if (cursor < length) ranges.push({ start: cursor, end: length });
  return ranges;
}

function rangeIndexCovering(
  ranges: readonly FactSpan[],
  span: FactSpan
): number | null {
  for (let index = 0; index < ranges.length; index += 1) {
    const range = ranges[index]!;
    if (range.start <= span.start && span.start < range.end) return index;
  }
  return null;
}

/** True when the range's non-whitespace text all sits inside `covered` spans. */
function spansCoverRange(
  text: string,
  range: FactSpan,
  covered: readonly FactSpan[]
): boolean {
  const sorted = [...covered].sort((left, right) => left.start - right.start);
  let cursor = range.start;
  for (const span of sorted) {
    if (span.end <= cursor) continue;
    if (span.start > cursor) {
      if (text.slice(cursor, span.start).trim().length > 0) return false;
    }
    cursor = Math.max(cursor, span.end);
  }
  return cursor >= range.end || text.slice(cursor, range.end).trim() === "";
}
