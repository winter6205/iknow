/**
 * #D2: per-call concurrency safety for the bash tool.
 *
 * The bash tool's static ACI flag stays `isConcurrencySafe: false` — most
 * bash calls mutate the filesystem, so the tool as a whole is not
 * concurrency-safe. This module answers the narrower per-call question the
 * wave splitter asks BEFORE schema validation: "may this specific call join a
 * wave of concurrent bash calls?".
 *
 * The answer is deny-by-default. A call joins a wave only when it is
 * PROVABLY read-only; anything uncertain stays serial. The reason the fence
 * cannot backstop a wrong answer is in `src/harness/sandbox/bwrap.ts`: the
 * host `/` is bind-mounted WRITABLE (only `--ro-bind cwd` is added in
 * readonly mode), so a command that slips through this predicate can write
 * outside the workspace.
 *
 * The policy tables are NOT re-implemented here — they are reused:
 *   - `validateReadonlyCommand` (`bash-readonly.ts`) — the frozen readonly
 *     command roster (`permission/command-roster.ts`) plus the per-command
 *     flag policies for `find` / `sort` / `git`;
 *   - `findDangerousPattern` (`permission/hard-walls.ts`) — the destructive
 *     pattern wall. It is called WITHOUT the cleanup-root snapshot, which
 *     makes it STRICTER than the bash handler's own call (the handler's
 *     roots can turn a `destructive-rm` into a bounded-cleanup exception).
 *     Strictness is the right direction here.
 *
 * Three gaps in `validateReadonlyCommand` are closed by this module's own
 * conditions, each verified against the real implementation:
 *   1. a write can hide inside a command substitution — `cat $(touch x) f`
 *      and "echo `touch x`" both PASS the readonly validator;
 *   2. the segment splitter cuts on `;` `&&` `||` `|` but NOT on a newline,
 *      so "ls\ntouch x" PASSES the readonly validator;
 *   3. a shell expansion is not a substitution but is equally unknowable at
 *      judgment time — `cat ${HOME}/x` PASSES the readonly validator, and so
 *      does the UNBRACED `cat $HOME/x`; the rule therefore refuses ANY `$`
 *      (braced or not) and any backtick, not just the two shapes the
 *      validator is commonly probed with.
 * The output-form scan (no `tee`, no `--output`, no standalone `-o`) is
 * DEFENSIVE REDUNDANCY: the readonly policy rejects every targeted write
 * form STRUCTURALLY — `tee` is not in the readonly command roster, and
 * `sort -o` / `git --output` are rejected by their own flag policies — so
 * the scan changes no verdict the other conjuncts would have changed. Its
 * only observable effect today is to refuse a handful of harmless read-only
 * commands (`ls -o`, `od -o`, `find . -name tee`). It is kept because it
 * is the guard that SURVIVES a roster change: if `tee` ever enters the
 * readonly roster, the scan is still there to refuse the write form.
 *
 * A second export answers the companion question the fence env needs:
 * `commandInvokesGit` — "does this command actually run git?" — because the
 * `GIT_OPTIONAL_LOCKS=0` injection is git-specific and a read-only call that
 * never runs git must not carry it (see `gitOptionalLocksFenceEnv` in
 * `bash.ts`). It reuses the readonly policy's own command-word notion, so
 * the two can never disagree about which unit is a git unit.
 *
 * This module never throws: the wave splitter must not fail because a
 * judgment was hard to make. Anything undecidable is answered `false`.
 */

/* ---------------------------------------------------------------------------
 * Imports
 * ------------------------------------------------------------------------- */

import {
  findDangerousPattern,
  firstToken,
} from "../../permission/hard-walls.js";
import { commandFlagPolicy } from "../../permission/command-roster.js";
import { splitShellSegments } from "../../permission/text-segments.js";
import {
  parseForSecurity,
  type SecurityParseOk,
} from "../../permission/shell-parse.js";
import { validateReadonlyCommand } from "./bash-readonly.js";

/* ---------------------------------------------------------------------------
 * Policy tables (pure data, frozen; no shared mutable state)
 * ------------------------------------------------------------------------- */

/**
 * Command words that WRITE: `tee` copies its input to a file (and to
 * stdout), so a `tee` in the command means the call is not read-only.
 */
const OUTPUT_COMMAND_WORDS: ReadonlySet<string> = Object.freeze(
  new Set(["tee"])
);

/**
 * Commands whose `-o` flag means `--only-matching` (print only the matching
 * part of the line) and NOT "write output to this file". The flag is only
 * exempt for these commands when they are the FIRST word of the command.
 */
const ONLY_MATCHING_COMMANDS: ReadonlySet<string> = Object.freeze(
  new Set(["grep", "rg"])
);

/** Shell syntax that can change an unquoted `cd` word at execution time. */
const UNQUOTED_PATH_EXPANSION_CHARACTERS: ReadonlySet<string> = Object.freeze(
  new Set([
    "~",
    "*",
    "?",
    "[",
    "]",
    "{",
    "}",
    "\\",
    "'",
    '"',
    "`",
    "$",
    "(",
    ")",
    "|",
    "&",
    ";",
    "<",
    ">",
  ])
);

/* ---------------------------------------------------------------------------
 * Predicate
 * ------------------------------------------------------------------------- */

/**
 * Is this bash call safe to run concurrently with its neighbours?
 *
 * Receives the RAW tool input (`unknown`): the wave splitter calls it before
 * schema validation, so the input is narrowed here and never trusted.
 *
 * The answer is a CONJUNCTION of independent rules. Each rule lives in
 * exactly one named helper below, so a new rule is added as a new named
 * rule and never as another branch of one growing function:
 *   - `concurrencyCandidate` — the call is well-formed and foreground;
 *   - `hasNoStatementSeparator` — no newline / carriage return;
 *   - `hasNoShellExpansion` — no `$` of any form and no backtick;
 *   - `passesReadonlyPolicy` — each command is accepted by
 *     `validateReadonlyCommand`;
 *   - `passesDestructiveWall` — `findDangerousPattern` returns null for the
 *     entire original command;
 *   - `hasOutputForm` — no route by which a command can write a file.
 *
 * Never throws: any throw inside the body is answered `false`.
 */
export function isReadonlyBashConcurrencySafe(input: unknown): boolean {
  try {
    const command = concurrencyCandidate(input);
    if (command === null) return false;
    return isDecidableReadOnlyCommand(command);
  } catch {
    // EXIT: undecidable ⇒ serial.
    return false;
  }
}

/**
 * Rule: the call is a well-formed, FOREGROUND call.
 *
 * The input must be a non-null object, `command` must be a non-empty
 * string, and `background` must not be `true` — a background job is
 * long-lived, outlives the wave, must never share one, and never reaches
 * the foreground fence env.
 *
 * Returns the candidate command, or `null` when the call cannot be a
 * concurrency candidate at all.
 */
function concurrencyCandidate(input: unknown): string | null {
  if (typeof input !== "object" || input === null) return null;
  const raw = input as { command?: unknown; background?: unknown };
  if (raw.background === true) return null;
  const command = raw.command;
  if (typeof command !== "string" || command.length === 0) return null;
  return command;
}

/**
 * The rule conjunction: every rule must hold, or the call stays serial.
 * A leading literal `cd` is judged from a complete AST chain, while ordinary
 * commands continue through the existing readonly policy unchanged.
 */
function isDecidableReadOnlyCommand(command: string): boolean {
  if (
    !hasNoStatementSeparator(command) ||
    !hasNoShellExpansion(command) ||
    !passesDestructiveWall(command)
  ) {
    return false;
  }

  const parsed = parseForSecurity(command);
  if (parsed.kind === "ok") {
    const firstCommand = parsed.commands.find(
      (candidate) => candidate.index === 0 && candidate.depth === 0
    );
    if (firstCommand?.argv[0]?.value === "cd") {
      const readonlyCommands = literalCdReadonlyCommands(parsed);
      return (
        readonlyCommands !== null &&
        readonlyCommands.every(
          (candidate) =>
            passesReadonlyPolicy(candidate) && !hasOutputForm(candidate)
        )
      );
    }
  }

  return passesReadonlyPolicy(command) && !hasOutputForm(command);
}

/**
 * Return the individual read-only commands after a literal leading
 * `cd <path> &&`, or null when the parsed command is not that exact safe
 * shape. Parse facts prove every shell boundary; raw-text stripping is never
 * used to decide which part of the original command is safe.
 */
function literalCdReadonlyCommands(parsed: SecurityParseOk): string[] | null {
  const commands = parsed.commands;
  if (
    !hasSimpleCompleteCommandFacts(parsed) ||
    !hasLiteralLeadingCdPath(commands[0]) ||
    !hasLinearAndOperators(parsed)
  ) {
    return null;
  }

  return commands
    .slice(1)
    .map((candidate) =>
      parsed.text.slice(candidate.span.start, candidate.span.end)
    );
}

function hasSimpleCompleteCommandFacts(parsed: SecurityParseOk): boolean {
  const { commands, operators } = parsed;
  return (
    commands.length >= 2 &&
    operators.length === commands.length - 1 &&
    parsed.substitutions.length === 0 &&
    parsed.expansions.length === 0 &&
    parsed.redirects.length === 0 &&
    parsed.heredocs.length === 0 &&
    parsed.bareNewlineOffsets.length === 0 &&
    parsed.bareCarriageReturnOffsets.length === 0 &&
    commands.every(isTopLevelPlainCommand)
  );
}

function isTopLevelPlainCommand(
  candidate: SecurityParseOk["commands"][number],
  index: number
): boolean {
  return (
    candidate.index === index &&
    candidate.depth === 0 &&
    candidate.parentId === undefined &&
    candidate.argv.length > 0
  );
}

function hasLiteralLeadingCdPath(
  firstCommand: SecurityParseOk["commands"][number] | undefined
): boolean {
  if (firstCommand === undefined) return false;
  const commandWord = firstCommand.argv[0];
  const pathWord = firstCommand.argv[1];
  return (
    commandWord !== undefined &&
    commandWord.text === "cd" &&
    commandWord.value === "cd" &&
    commandWord.span.start === firstCommand.span.start &&
    firstCommand.argv.length === 2 &&
    pathWord !== undefined &&
    isStaticCdPath(pathWord)
  );
}

function isStaticCdPath(pathWord: SecurityParseOk["words"][number]): boolean {
  const path = pathWord.value;
  if (path === undefined || path.length === 0 || path.startsWith("-")) {
    return false;
  }
  if (pathWord.quoteKind === "single" || pathWord.quoteKind === "double") {
    return true;
  }
  return (
    pathWord.quoteKind === "none" &&
    pathWord.text === path &&
    hasNoUnquotedPathExpansion(path)
  );
}

function hasNoUnquotedPathExpansion(path: string): boolean {
  for (const character of path) {
    if (UNQUOTED_PATH_EXPANSION_CHARACTERS.has(character)) return false;
  }
  return true;
}

function hasLinearAndOperators(parsed: SecurityParseOk): boolean {
  const { commands, operators, text } = parsed;
  let cursor = 0;
  for (let index = 0; index < commands.length; index += 1) {
    const candidate = commands[index];
    if (
      candidate === undefined ||
      !isWhitespaceOnly(text.slice(cursor, candidate.span.start))
    ) {
      return false;
    }
    cursor = candidate.span.end;
    if (index === commands.length - 1) continue;

    const operator = operators[index];
    if (!isAndBetweenAdjacentCommands(operator, index, cursor, text)) {
      return false;
    }
    cursor = operator.span.end;
  }
  return isWhitespaceOnly(text.slice(cursor));
}

function isAndBetweenAdjacentCommands(
  operator: SecurityParseOk["operators"][number] | undefined,
  index: number,
  cursor: number,
  text: string
): operator is SecurityParseOk["operators"][number] {
  return (
    operator !== undefined &&
    operator.kind === "and" &&
    operator.depth === 0 &&
    operator.leftCommandIndex === index &&
    operator.rightCommandIndex === index + 1 &&
    isWhitespaceOnly(text.slice(cursor, operator.span.start)) &&
    text.slice(operator.span.start, operator.span.end) === "&&"
  );
}

function isWhitespaceOnly(value: string): boolean {
  return value.trim().length === 0;
}

/**
 * Rule: no newline and no carriage return.
 *
 * A newline separates statements without being a segment separator for the
 * readonly splitter: "ls\ntouch x" would pass the readonly validator.
 */
function hasNoStatementSeparator(command: string): boolean {
  return !command.includes("\n") && !command.includes("\r");
}

/**
 * Rule: no shell expansion of any form — ANY `$` (braced `${…}` or unbraced
 * `$NAME`) and any backtick.
 *
 * A shell expansion's value is not knowable at judgment time, and a write
 * can hide inside it (`cat $(touch x) f` passes the readonly validator).
 * The bwrap fence cannot backstop it either — the host root is
 * bind-mounted WRITABLE, so an expansion that names an outside path is a
 * real write. The rule is deliberately shape-blind: a literal `$` in a
 * file name (`cat file$.txt`) is refused as well. A false positive here
 * only costs concurrency, never correctness, so the conservative side is
 * the right side to err on.
 */
function hasNoShellExpansion(command: string): boolean {
  return !command.includes("$") && !command.includes("`");
}

/**
 * Rule: the readonly command policy accepts the command.
 *
 * `validateReadonlyCommand` is reused, not re-implemented: the deny-by-
 * default command-word roster (`permission/command-roster.ts`) plus the
 * per-command flag policies for `find` / `sort` / `git`. A violation is
 * reported by throwing, so a throw means "not provably read-only".
 */
function passesReadonlyPolicy(command: string): boolean {
  try {
    validateReadonlyCommand(command);
    return true;
  } catch {
    // EXIT: the readonly policy refused the command ⇒ not read-only ⇒ serial.
    return false;
  }
}

/**
 * Rule: the destructive wall sees no destructive shape.
 *
 * Called WITHOUT the cleanup-root snapshot, so this is strictly stricter
 * than the bash handler's own call: no cleanup-root exception can turn a
 * `destructive-rm` hit into a pass here.
 */
function passesDestructiveWall(command: string): boolean {
  return findDangerousPattern(command) === null;
}

/* ---------------------------------------------------------------------------
 * Git invocation (the fence-env trigger)
 * ------------------------------------------------------------------------- */

/**
 * Does this command run git?
 *
 * The `GIT_OPTIONAL_LOCKS=0` fence-env injection is triggered by a call that
 * (a) the concurrency predicate judges safe AND (b) actually runs git. This
 * helper answers (b) — the half of the trigger a per-call seam CAN answer,
 * because the command text is in hand.
 *
 * The answer reuses the readonly policy's own command-word notion: a unit
 * runs git iff its FIRST word is the command whose flag policy is git
 * (`command-roster.ts` is the single owner of that table). That is the very
 * word `validateReadonlyCommand` looked at when it admitted the unit, so the
 * two can never disagree about which unit is a git unit. A git word later in
 * a unit (`cat git`, `ls /usr/bin/git`) is an ARGUMENT, not an invocation,
 * and is not matched.
 *
 * Two paths, mirroring the readonly validator's own structure
 * (`validateReadonlyCommand`): the PARSE FACTS when the shell parse answered
 * `ok` (exact — a `;` inside a quoted word is not a separator there), and the
 * quote-blind TEXT FOLD otherwise (the same fold the readonly policy falls
 * back to, so the two agree on every command they both admit).
 *
 * Never throws: an undecidable command answers false. That costs the
 * injection (and with it the `.git/index.lock` protection) — a benign race,
 * never a wrong verdict.
 */
export function commandInvokesGit(command: string): boolean {
  try {
    const parsed = parseForSecurity(command);
    if (parsed.kind === "ok") {
      return parsed.commands.some((cmd) =>
        isGitCommandWord(cmd.argv[0]?.text ?? "")
      );
    }
    return splitShellSegments(command).some((segment) =>
      isGitCommandWord(firstToken(segment))
    );
  } catch {
    // EXIT: an undecidable command cannot be shown to run git ⇒ no injection.
    return false;
  }
}

/**
 * Is this command word a git unit? The roster owns the command → flag-policy
 * table, and "git" is the command whose flag policy is the git one.
 */
function isGitCommandWord(word: string): boolean {
  return commandFlagPolicy(firstToken(word)) === "git";
}

/* ---------------------------------------------------------------------------
 * Output-form scan
 * ------------------------------------------------------------------------- */

/**
 * Rule: the command has no OUTPUT FORM — a route by which it can write to a
 * file (or to another command's stdout).
 *
 * The scan is QUOTE-BLIND on purpose: the token split is whitespace-only and
 * quote characters are stripped, never parsed. A false positive (e.g.
 * `echo "tee"`) only costs concurrency, never correctness, while a false
 * negative would let a write into a shared wave. The scan therefore errs
 * toward the conservative side.
 *
 * `-o` is a standalone-token rule: only the exact token `-o` counts. The
 * exemption for `grep` / `rg` is scoped to the FIRST WORD of the command,
 * because that is where `-o` is `--only-matching`.
 *
 * The scan is DEFENSIVE REDUNDANCY, not a hole filler. The readonly
 * policy already refuses every write form this scan targets, structurally:
 * `tee` is not in the readonly command roster, and `sort -o` / `git
 * --output` are rejected by their own flag policies. The scan therefore
 * refuses nothing the other conjuncts would not have refused, except for a
 * handful of harmless read-only commands (`ls -o`, `od -o`, `find . -name
 * tee`), which it refuses on purpose. It is kept as the guard that
 * survives a future roster change — if `tee` ever enters the readonly
 * roster, this scan is what still refuses the write form.
 */
function hasOutputForm(command: string): boolean {
  const firstWord = firstToken(command);
  const onlyMatching = ONLY_MATCHING_COMMANDS.has(firstWord);
  for (const raw of command.split(/\s+/)) {
    const token = stripQuotes(raw);
    if (token.length === 0) continue;
    if (OUTPUT_COMMAND_WORDS.has(commandWord(token))) return true;
    if (token === "--output" || token.startsWith("--output=")) return true;
    if (!onlyMatching && token === "-o") return true;
  }
  return false;
}

/**
 * Strip quote characters from a token. Quotes are not parsed (the scan is
 * quote-blind); they are only removed so that `"tee"` and `'tee'` compare
 * equal to `tee` instead of slipping past the comparison.
 */
function stripQuotes(token: string): string {
  return token.replace(/["']/g, "");
}

/**
 * The command word of a token: its basename, lowercased. A token that names
 * a program by path (`/usr/bin/tee`) is the same program as the bare name.
 */
function commandWord(token: string): string {
  const slash = token.lastIndexOf("/");
  const base = slash >= 0 ? token.slice(slash + 1) : token;
  return base.toLowerCase();
}
