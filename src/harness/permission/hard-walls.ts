import type { HardRuleSpec } from "./types.js";
import { VIOLATION_PREFIXES } from "./prefixes.js";

// Re-export the SSOT hard-wall prefix for callers that historically imported
// it from here. The authoritative definition lives in `./prefixes.ts`.
export const HARD_WALL_DENY_PREFIX = VIOLATION_PREFIXES.hardWall;

export type HardWallId =
  "hard-wall:execute-dangerous" | "hard-wall:sensitive-path";

const ALLOWED_COMMAND_TOKENS: ReadonlySet<string> = Object.freeze(
  new Set([
    "echo",
    "node",
    "npm",
    "git",
    "ls",
    "cat",
    "pwd",
    "wc",
    "head",
    "tail",
    "dir",
    "type",
    "where",
  ])
);

const DANGEROUS_COMMAND_PATTERNS: readonly string[] = Object.freeze([
  "rm -rf",
  "rm -fr",
  "rm -r ",
  "rm -f ",
  "rm --recursive",
  "rmdir",
  "remove-item",
  "mkfs",
  "dd if=",
  ":(){ :|:& };:",
  "shutdown",
  "reboot",
  "format",
  "del /f",
  "rd /s",
  " -delete",
  "chmod -r",
  "chown",
]);

const SENSITIVE_PATH_FRAGMENTS: readonly string[] = Object.freeze([
  ".ssh/",
  ".ssh\\\\",
  "\\.ssh$",
  ".aws/",
  "\\.aws$",
  ".gnupg/",
  "\\.gnupg$",
  ".config/gh/",
  "\\.kube/",
  "\\.kube$",
  ".docker/config.json",
  ".netrc",
  "\\.env$",
  "\\.env\\.",
  "\\.pem$",
  "\\.key$",
  "\\.p12$",
  "id_rsa",
  "id_ed25519",
  "/etc/passwd",
  "/etc/shadow",
  "/proc/self/environ",
]);

export function firstToken(command: string): string {
  const trimmed = command.trim();
  if (trimmed.length === 0) return "";
  const firstWord = trimmed.split(/\s+/)[0] ?? "";
  const lastSlash = Math.max(
    firstWord.lastIndexOf("/"),
    firstWord.lastIndexOf("\\")
  );
  const basename = lastSlash >= 0 ? firstWord.slice(lastSlash + 1) : firstWord;
  return basename.toLowerCase();
}

export function isAllowedCommand(command: string): boolean {
  if (command.length === 0) return false;
  const segments = splitShellSegments(command);
  if (segments.length === 0) return false;
  for (const segment of segments) {
    if (!isSegmentAllowed(segment)) return false;
  }
  return true;
}

export function findDangerousPattern(command: string): string | null {
  // Strip backslash escapes before scanning so that `r\m -rf /` (an attempt
  // to defeat substring matching) still triggers the `rm -rf` pattern.
  const lower = command.toLowerCase().replace(/\\/g, "");
  for (const pattern of DANGEROUS_COMMAND_PATTERNS) {
    if (lower.includes(pattern)) return pattern;
  }
  if (/\$\(/.test(command)) return "$(";
  if (/\$\{/.test(command)) return "${";
  if (/\$[A-Za-z_]/.test(command)) return "$VAR";
  if (/`/.test(command)) return "`";
  if (/<\s?\(/.test(command)) return "<(";
  if (/\r|\n/.test(command)) return "\\n";
  // Bare metacharacters (no command body): a command consisting only of
  // separators / redirects / pipes has nothing safe to execute.
  const segments = splitShellSegments(command);
  if (
    segments.length === 0 ||
    segments.every((s) => !ALLOWED_COMMAND_TOKENS.has(firstToken(s)))
  ) {
    for (const bare of ["|", ";", ">", "<", "&", "&&", "||"]) {
      if (command.includes(bare)) return bare;
    }
  }
  return null;
}

export function isDangerousCommand(command: string): boolean {
  return findDangerousPattern(command) !== null;
}

/**
 * Split a command into top-level segments on `;`, `&&`, `||`. Each segment is
 * independently validated against the allowlist / dangerous-pattern checks so
 * compound commands made of read-only tokens (e.g.
 * `ls -la ~/.iknow 2>/dev/null; echo ---; ls | head -30`) are no longer
 * denied wholesale for containing shell metacharacters.
 *
 * Conservative: backslash-escaped separators (`\;`) are kept literal so a
 * command like `r\m -rf /` does NOT split into `r` + `m -rf /` and remain
 * matched by the substring scan in `findDangerousPattern`.
 */
export function splitShellSegments(command: string): string[] {
  const segments: string[] = [];
  let buf = "";
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (ch === "\\" && i + 1 < command.length) {
      buf += ch + (command[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (
      ch === ";" ||
      (ch === "&" && command[i + 1] === "&") ||
      (ch === "|" && command[i + 1] === "|") ||
      ch === "|"
    ) {
      segments.push(buf);
      buf = "";
      if (command[i + 1] === ch) i += 1;
      continue;
    }
    buf += ch;
  }
  if (buf.length > 0) segments.push(buf);
  return segments.map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * Per-segment allowlist check. Strips redirection tokens (>, >>, <, 2>,
 * file paths after them) before token inspection so the redirect exemption
 * is enforced at the segment boundary. Subshell / command-substitution
 * parens are still rejected because they are matched by
 * `findDangerousPattern` (single `$(` / backtick scan over the full command).
 */
function isSegmentAllowed(segment: string): boolean {
  if (segment.length === 0) return false;
  if (!ALLOWED_COMMAND_TOKENS.has(firstToken(segment))) return false;
  const withoutRedirects = segment.replace(REDIRECTION_PATTERN, "");
  for (const metachar of NON_REDIRECT_METACHARS) {
    if (withoutRedirects.includes(metachar)) return false;
  }
  return true;
}

// Match `>` / `>>` / `<` / `2>` / `2>>` / `&>` / `<<<` redirection operators,
// plus the optional following filename/path (up to next shell boundary).
// `<<<` is a here-string (read-only stdin feed), no file write — safe.
const REDIRECTION_PATTERN = /(?:<<<?|>>?|2>>?|2?>)\s*\S+/g;

const NON_REDIRECT_METACHARS: readonly string[] = Object.freeze([
  "$",
  "`",
  "\n",
  "\r",
  "(",
  ")",
]);

function matchDangerousExecute(input: {
  tool: string;
  input: unknown;
}): boolean {
  if (input.tool !== "bash" && input.tool !== "execute") return false;
  const command = (input.input as { command?: unknown } | null | undefined)
    ?.command;
  if (typeof command !== "string") return false;
  if (isDangerousCommand(command)) return true;
  // Redirection exemption must NOT leak sensitive paths: `echo x > /etc/shadow`
  // is now allowlisted by the redirect exemption but must still be denied.
  if (commandContainsSensitivePath(command)) return true;
  return !isAllowedCommand(command);
}

/**
 * Scan a command string for sensitive path fragments (`.ssh/`, `/etc/passwd`,
 * `/etc/shadow`, `.env`, `.pem`, etc.). This mirrors `matchSensitivePath` for
 * path-bearing tools, applied to the `command` field of execute tools so the
 * redirect exemption cannot be abused to write to a sensitive location.
 *
 * Exported so `src/harness/aci/tools/bash.ts` (the handler-level gate) applies
 * the same check as the hard-wall — otherwise a redirect like `>> /etc/shadow`
 * would pass `isDangerousCommand`/`isAllowedCommand` at the handler and only be
 * stopped by bwrap's ro-bind, not by policy (axis2 skeptic finding).
 */
export function commandContainsSensitivePath(command: string): boolean {
  return SENSITIVE_PATH_FRAGMENTS.some((fragment) => {
    if (fragment.startsWith("\\")) return new RegExp(fragment).test(command);
    return command.includes(fragment);
  });
}

function getPathLikeString(input: unknown): string | undefined {
  if (input === null || typeof input !== "object") return undefined;
  const obj = input as Record<string, unknown>;
  for (const key of ["path", "file", "filepath", "target"]) {
    const value = obj[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

function matchSensitivePath(input: { tool: string; input: unknown }): boolean {
  const path = getPathLikeString(input.input);
  if (path === undefined) return false;
  return SENSITIVE_PATH_FRAGMENTS.some(
    (fragment) =>
      path.includes(fragment) ||
      (fragment.startsWith("\\") && new RegExp(fragment).test(path))
  );
}

export function hardWalls(): ReadonlyArray<HardRuleSpec> {
  return Object.freeze([
    Object.freeze({
      id: "hard-wall:execute-dangerous" satisfies HardWallId,
      match: matchDangerousExecute,
      decision: "deny" as const,
      reason:
        "execute tool received a dangerous command pattern (remove / fork-bomb / format / dd / shell-metachar)",
      tier: "hard-wall" as const,
    }),
    Object.freeze({
      id: "hard-wall:sensitive-path" satisfies HardWallId,
      match: matchSensitivePath,
      decision: "deny" as const,
      reason:
        "path matches a sensitive ch05 §6 location (.ssh/.aws/.gnupg/.kube/.docker/.env/.pem/.key/id_rsa/id_ed25519/etc/passwd/etc/shadow/proc/self/environ)",
      tier: "hard-wall" as const,
    }),
  ]);
}
