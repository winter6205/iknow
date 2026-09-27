/**
 * src/harness/permission/command-roster.ts
 *
 * SSOT (Single Source of Truth) for command-NAME classification
 * (specs/hard-wall-ast-migration.md SC-S4-4, Stage 4b). One frozen table
 * keyed by command name; each entry carries the classification facets the
 * consumers project:
 *   - `allowlisted`   — the former `ALLOWED_COMMAND_TOKENS` (hard-walls.ts),
 *     read by `isAllowedCommand` / `isSegmentAllowed`.
 *   - `readonly_safe` / `execution_agent` — the former readonly name sets
 *     (bash-readonly.ts `READONLY_ALLOWED` / `FORBIDDEN_COMMANDS`).
 *   - `interpreter`   — Stage 1's closed interpreter roster (ADR-0125
 *     Assumption 7), read by the combo wall and the heredoc receiver test.
 *   - `flag_policy`   — a string KEY, never a table reference. The per-command
 *     flag tables stay module-private in `bash-readonly.ts`, which resolves
 *     key → table there; this module holds no reference to them and imports
 *     nothing, so no `permission/ → aci/tools → permission/` cycle can form.
 *
 * Out of this roster on purpose: environment-variable names
 * (`BASE_ENV_WHITELIST`, sandbox/env-isolation.ts) are a different subject,
 * and the Windows shell-family trio stays with its destructive-wall owner in
 * `hard-walls.ts` (SC-S2-9).
 */

/** The per-command flag grammars, keyed by name, resolved in bash-readonly.ts. */
export type CommandFlagPolicy = "find" | "sort" | "git";

export interface CommandRosterEntry {
  /** Former `ALLOWED_COMMAND_TOKENS` membership. */
  readonly allowlisted: boolean;
  /** Former readonly `READONLY_ALLOWED` membership. */
  readonly readonly_safe: boolean;
  /** Former readonly `FORBIDDEN_COMMANDS` membership. */
  readonly execution_agent: boolean;
  /** Stage 1 interpreter roster membership. */
  readonly interpreter: boolean;
  /** Which flag table governs this name's arguments, or null. */
  readonly flag_policy: CommandFlagPolicy | null;
}

export const COMMAND_ROSTER = Object.freeze({
  "base64": { allowlisted: true, readonly_safe: false, execution_agent: false, interpreter: false, flag_policy: null },
  "basename": { allowlisted: false, readonly_safe: true, execution_agent: false, interpreter: false, flag_policy: null },
  "bash": { allowlisted: false, readonly_safe: false, execution_agent: false, interpreter: true, flag_policy: null },
  "cat": { allowlisted: true, readonly_safe: true, execution_agent: false, interpreter: false, flag_policy: null },
  "chmod": { allowlisted: true, readonly_safe: false, execution_agent: false, interpreter: false, flag_policy: null },
  "chown": { allowlisted: true, readonly_safe: false, execution_agent: false, interpreter: false, flag_policy: null },
  "column": { allowlisted: false, readonly_safe: true, execution_agent: false, interpreter: false, flag_policy: null },
  "cp": { allowlisted: true, readonly_safe: false, execution_agent: false, interpreter: false, flag_policy: null },
  "curl": { allowlisted: true, readonly_safe: false, execution_agent: false, interpreter: false, flag_policy: null },
  "dash": { allowlisted: false, readonly_safe: false, execution_agent: false, interpreter: true, flag_policy: null },
  "date": { allowlisted: false, readonly_safe: true, execution_agent: false, interpreter: false, flag_policy: null },
  "df": { allowlisted: false, readonly_safe: true, execution_agent: false, interpreter: false, flag_policy: null },
  "diff": { allowlisted: true, readonly_safe: true, execution_agent: false, interpreter: false, flag_policy: null },
  "dir": { allowlisted: true, readonly_safe: false, execution_agent: false, interpreter: false, flag_policy: null },
  "dirname": { allowlisted: false, readonly_safe: true, execution_agent: false, interpreter: false, flag_policy: null },
  "du": { allowlisted: false, readonly_safe: true, execution_agent: false, interpreter: false, flag_policy: null },
  "echo": { allowlisted: true, readonly_safe: true, execution_agent: false, interpreter: false, flag_policy: null },
  "env": { allowlisted: true, readonly_safe: false, execution_agent: true, interpreter: false, flag_policy: null },
  "export": { allowlisted: true, readonly_safe: false, execution_agent: false, interpreter: false, flag_policy: null },
  "false": { allowlisted: true, readonly_safe: true, execution_agent: false, interpreter: false, flag_policy: null },
  "file": { allowlisted: true, readonly_safe: true, execution_agent: false, interpreter: false, flag_policy: null },
  "find": { allowlisted: false, readonly_safe: false, execution_agent: false, interpreter: false, flag_policy: "find" },
  "fold": { allowlisted: false, readonly_safe: true, execution_agent: false, interpreter: false, flag_policy: null },
  "git": { allowlisted: true, readonly_safe: false, execution_agent: false, interpreter: false, flag_policy: "git" },
  "grep": { allowlisted: false, readonly_safe: true, execution_agent: false, interpreter: false, flag_policy: null },
  "head": { allowlisted: true, readonly_safe: true, execution_agent: false, interpreter: false, flag_policy: null },
  "hexdump": { allowlisted: false, readonly_safe: true, execution_agent: false, interpreter: false, flag_policy: null },
  "hostname": { allowlisted: false, readonly_safe: true, execution_agent: false, interpreter: false, flag_policy: null },
  "id": { allowlisted: false, readonly_safe: true, execution_agent: false, interpreter: false, flag_policy: null },
  "jq": { allowlisted: true, readonly_safe: true, execution_agent: false, interpreter: false, flag_policy: null },
  "ksh": { allowlisted: false, readonly_safe: false, execution_agent: false, interpreter: true, flag_policy: null },
  "ls": { allowlisted: true, readonly_safe: true, execution_agent: false, interpreter: false, flag_policy: null },
  "md5sum": { allowlisted: false, readonly_safe: true, execution_agent: false, interpreter: false, flag_policy: null },
  "mkdir": { allowlisted: true, readonly_safe: false, execution_agent: false, interpreter: false, flag_policy: null },
  "mv": { allowlisted: true, readonly_safe: false, execution_agent: false, interpreter: false, flag_policy: null },
  "nl": { allowlisted: false, readonly_safe: true, execution_agent: false, interpreter: false, flag_policy: null },
  "node": { allowlisted: true, readonly_safe: false, execution_agent: false, interpreter: true, flag_policy: null },
  "nohup": { allowlisted: false, readonly_safe: false, execution_agent: true, interpreter: false, flag_policy: null },
  "npm": { allowlisted: true, readonly_safe: false, execution_agent: false, interpreter: false, flag_policy: null },
  "od": { allowlisted: false, readonly_safe: true, execution_agent: false, interpreter: false, flag_policy: null },
  "perl": { allowlisted: false, readonly_safe: false, execution_agent: false, interpreter: true, flag_policy: null },
  "php": { allowlisted: false, readonly_safe: false, execution_agent: false, interpreter: true, flag_policy: null },
  "printenv": { allowlisted: false, readonly_safe: true, execution_agent: false, interpreter: false, flag_policy: null },
  "printf": { allowlisted: true, readonly_safe: true, execution_agent: false, interpreter: false, flag_policy: null },
  "ps": { allowlisted: false, readonly_safe: true, execution_agent: false, interpreter: false, flag_policy: null },
  "pwd": { allowlisted: true, readonly_safe: true, execution_agent: false, interpreter: false, flag_policy: null },
  "python": { allowlisted: false, readonly_safe: false, execution_agent: false, interpreter: true, flag_policy: null },
  "python2": { allowlisted: false, readonly_safe: false, execution_agent: false, interpreter: true, flag_policy: null },
  "python3": { allowlisted: false, readonly_safe: false, execution_agent: false, interpreter: true, flag_policy: null },
  "readlink": { allowlisted: false, readonly_safe: true, execution_agent: false, interpreter: false, flag_policy: null },
  "realpath": { allowlisted: false, readonly_safe: true, execution_agent: false, interpreter: false, flag_policy: null },
  "rg": { allowlisted: false, readonly_safe: true, execution_agent: false, interpreter: false, flag_policy: null },
  "ruby": { allowlisted: false, readonly_safe: false, execution_agent: false, interpreter: true, flag_policy: null },
  "sed": { allowlisted: true, readonly_safe: false, execution_agent: false, interpreter: false, flag_policy: null },
  "sh": { allowlisted: false, readonly_safe: false, execution_agent: false, interpreter: true, flag_policy: null },
  "sha256sum": { allowlisted: false, readonly_safe: true, execution_agent: false, interpreter: false, flag_policy: null },
  "sort": { allowlisted: false, readonly_safe: false, execution_agent: false, interpreter: false, flag_policy: "sort" },
  "stat": { allowlisted: false, readonly_safe: true, execution_agent: false, interpreter: false, flag_policy: null },
  "strings": { allowlisted: false, readonly_safe: true, execution_agent: false, interpreter: false, flag_policy: null },
  "tail": { allowlisted: true, readonly_safe: true, execution_agent: false, interpreter: false, flag_policy: null },
  "tee": { allowlisted: true, readonly_safe: false, execution_agent: false, interpreter: false, flag_policy: null },
  "time": { allowlisted: false, readonly_safe: false, execution_agent: true, interpreter: false, flag_policy: null },
  "timeout": { allowlisted: false, readonly_safe: false, execution_agent: true, interpreter: false, flag_policy: null },
  "touch": { allowlisted: true, readonly_safe: false, execution_agent: false, interpreter: false, flag_policy: null },
  "true": { allowlisted: true, readonly_safe: true, execution_agent: false, interpreter: false, flag_policy: null },
  "type": { allowlisted: true, readonly_safe: false, execution_agent: false, interpreter: false, flag_policy: null },
  "uname": { allowlisted: false, readonly_safe: true, execution_agent: false, interpreter: false, flag_policy: null },
  "unset": { allowlisted: true, readonly_safe: false, execution_agent: false, interpreter: false, flag_policy: null },
  "wc": { allowlisted: true, readonly_safe: true, execution_agent: false, interpreter: false, flag_policy: null },
  "where": { allowlisted: true, readonly_safe: false, execution_agent: false, interpreter: false, flag_policy: null },
  "whereis": { allowlisted: false, readonly_safe: true, execution_agent: false, interpreter: false, flag_policy: null },
  "which": { allowlisted: false, readonly_safe: true, execution_agent: false, interpreter: false, flag_policy: null },
  "whoami": { allowlisted: false, readonly_safe: true, execution_agent: false, interpreter: false, flag_policy: null },
  "xargs": { allowlisted: false, readonly_safe: false, execution_agent: true, interpreter: false, flag_policy: null },
  "xxd": { allowlisted: false, readonly_safe: true, execution_agent: false, interpreter: false, flag_policy: null },
  "zsh": { allowlisted: false, readonly_safe: false, execution_agent: false, interpreter: true, flag_policy: null },
} as const satisfies Record<string, CommandRosterEntry>);

/** Own-name lookup, prototype-safe: only table keys answer, never `toString`. */
export function commandRosterEntry(
  name: string
): CommandRosterEntry | undefined {
  const table: Record<string, CommandRosterEntry | undefined> = COMMAND_ROSTER;
  return Object.prototype.hasOwnProperty.call(table, name)
    ? table[name]
    : undefined;
}

/** The `flag_policy` key governing this name's arguments, or null. */
export function commandFlagPolicy(
  name: string
): CommandFlagPolicy | null {
  return commandRosterEntry(name)?.flag_policy ?? null;
}

function namesWith(
  predicate: (entry: CommandRosterEntry) => boolean
): string[] {
  return Object.entries(COMMAND_ROSTER)
    .filter(([, entry]) => predicate(entry))
    .map(([name]) => name);
}

/* Projections — each former literal is now a read of the roster, so every
 * membership below is derived, never a second copy. */

/** Former `ALLOWED_COMMAND_TOKENS` (`hard-walls.ts`). */
export const ALLOWED_COMMAND_TOKENS: ReadonlySet<string> = Object.freeze(
  new Set(namesWith((entry) => entry.allowlisted))
);

/** Former readonly `FORBIDDEN_COMMANDS` (`bash-readonly.ts`). */
export const FORBIDDEN_COMMANDS: ReadonlySet<string> = Object.freeze(
  new Set(namesWith((entry) => entry.execution_agent))
);

/** Former readonly `READONLY_ALLOWED` (`bash-readonly.ts`). */
export const READONLY_ALLOWED: ReadonlySet<string> = Object.freeze(
  new Set(namesWith((entry) => entry.readonly_safe))
);

/** Former `INTERPRETER_COMMAND_NAMES` (`hard-walls.ts`). */
export const INTERPRETER_COMMAND_NAMES: ReadonlySet<string> = Object.freeze(
  new Set(namesWith((entry) => entry.interpreter))
);
