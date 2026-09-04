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
 * Segment model reuses `splitShellSegments` (hard-walls.ts) + three
 * strictenings:
 *   1. Bare `&` (background operator) → reject. Note `&&` is already consumed
 *      by `splitShellSegments` so any remaining `&` in a segment is bare.
 *   2. Output redirect `>` / `>>` / `&>` → reject (any `>` in a segment is
 *      treated as write redirection; `<` input redirects are allowed since
 *      `<(...)` process substitution is already caught upstream).
 *   3. Each segment `firstToken` must be in the policy table; deny-by-default.
 */

import { ToolExecutionError } from "../../errors.js";
import { firstToken, splitShellSegments } from "../../permission/hard-walls.js";

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
 * Validate a command for readonly mode. Throws `ReadonlyViolationError` on
 * violation; returns silently if the command is allowed.
 *
 * Called by the bash handler when `bashMode === "readonly"`. Assumes the
 * command has already passed `isDangerousCommand` (so `$(...)` / backticks /
 * `${}` / `<(...)` / newlines are already excluded upstream).
 */
export function validateReadonlyCommand(command: string): void {
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
  // Strictening 1: bare & (background operator). `&&` is already split by
  // splitShellSegments, so any remaining `&` in the segment is either bare
  // `&`, `&>`, or `2>&1` — all rejected in readonly mode (conservative).
  if (segment.includes("&")) {
    throw new ReadonlyViolationError({
      command,
      reason: "background operator '&' is not allowed in readonly mode",
    });
  }
  // Strictening 2: output redirection (>, >>, &>, 2>). Catching any `>` in
  // the segment covers all output-redirect forms. Quoted `>` strings are a
  // rare false-positive cost; deny-by-default accepts it.
  if (segment.includes(">")) {
    throw new ReadonlyViolationError({
      command,
      reason: "output redirection is not allowed in readonly mode",
    });
  }
  validateSegmentPolicy(segment, command);
}

/**
 * Strictening 3 (firstToken policy lookup) as a standalone predicate-style
 * export: throws `ReadonlyViolationError` when the segment's command is not
 * in the readonly policy, returns silently when it is. Unlike
 * `validateSegment` it does NOT own the `>` / bare-`&` strictenings — those
 * are readonly-MODE rules; the worktree gate reuses only this policy lookup
 * (READONLY_ALLOWED + find/sort/git flag tables) for its workspace-write
 * classifier, so the two consumers whitelist from one table and cannot drift.
 */
export function validateSegmentPolicy(segment: string, command: string): void {
  const token = firstToken(segment);
  if (FORBIDDEN_COMMANDS.has(token)) {
    throw new ReadonlyViolationError({
      command,
      reason: `'${token}' is an execution agent, forbidden in readonly mode`,
    });
  }
  if (READONLY_ALLOWED.has(token)) return;
  if (token === "find") {
    validateFindFlags(segment, command);
    return;
  }
  if (token === "sort") {
    validateSortFlags(segment, command);
    return;
  }
  if (token === "git") {
    validateGitSubcommand(segment, command);
    return;
  }
  // Deny-by-default: anything not in any policy entry is rejected.
  throw new ReadonlyViolationError({
    command,
    reason: `'${token}' is not in the readonly command policy`,
  });
}

/**
 * Whitespace tokenizer for a single segment. Does not handle quotes — false
 * positives (e.g. `find . -name "-delete"`) are accepted as a deny-by-default
 * cost. The model can avoid flag-like tokens inside quotes in readonly mode.
 */
function tokenize(segment: string): string[] {
  return segment
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

function validateFindFlags(segment: string, command: string): void {
  const tokens = tokenize(segment);
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

function validateSortFlags(segment: string, command: string): void {
  const tokens = tokenize(segment);
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

function validateGitSubcommand(segment: string, command: string): void {
  const tokens = tokenize(segment);
  // Global --output rejection (any --output / --output= token in the segment).
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
  tokens: string[],
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
  tokens: string[],
  start: number
): string | undefined {
  for (let i = start; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (!token.startsWith("-")) return token;
  }
  return undefined;
}
