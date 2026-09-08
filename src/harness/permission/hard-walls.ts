import type { HardRuleSpec } from "./types.js";
import { VIOLATION_PREFIXES } from "./prefixes.js";

// Re-export the SSOT hard-wall prefix for callers that historically imported
// it from here. The authoritative definition lives in `./prefixes.ts`.
export const HARD_WALL_DENY_PREFIX = VIOLATION_PREFIXES.hardWall;

export type HardWallId =
  "hard-wall:execute-dangerous" | "hard-wall:sensitive-path";

/**
 * Machine-readable pattern ids for the execute-dangerous hard-wall. SC3
 * (`specs/mutate-write-contract.md`) requires the deny `reason` to carry the
 * specific id of the matched pattern, not just a generic shell-metachar
 * label. Categories:
 *   - destructive-rm: recursive / forced removal / chmod recursive / find
 *     -delete. Misuse destroys the writable root or a sibling subtree.
 *   - destructive-disk: filesystem wipe (`mkfs`, `dd if=`), fork-bomb,
 *     system shutdown / reboot, Windows `del /f` / `rd /s`, lexical
 *     `format` command. Affects the host, not just one file.
 *   - command-substitution: `$(...)` / `${...}` / backticks / `<(...)`.
 *     Process substitution / expansion that the substring scan cannot
 *     statically bound.
 *   - bare-metachar: command body consisting only of separators /
 *     redirects / pipes with no allowlisted token (e.g. `;`, `|`, `&&`).
 */
export type DangerousPatternId =
  | "destructive-rm"
  | "destructive-disk"
  | "command-substitution"
  | "bare-metachar";

/** Per-pattern hit record returned by `findDangerousPattern`. */
export interface DangerousPatternHit {
  readonly id: DangerousPatternId;
  /** The literal pattern / token that matched (for diagnostic display). */
  readonly pattern: string;
}

const ALLOWED_COMMAND_TOKENS: ReadonlySet<string> = Object.freeze(
  new Set([
    "mkdir",
    "cp",
    "mv",
    "touch",
    "tee",
    "sed",
    "chmod",
    "chown",
    "diff",
    "file",
    "base64",
    "jq",
    "curl",
    "env",
    "export",
    "unset",
    "true",
    "false",
    "echo",
    "pwd",
    "printf",
    "wc",
    "cat",
    "head",
    "tail",
    "ls",
    "node",
    "npm",
    "git",
    "dir",
    "type",
    "where",
  ])
);

/**
 * Each entry pairs the machine-readable id (SC3) with the literal substring
 * the segment scan looks for after the standard normalize step (lowercase,
 * backslash strip, whitespace collapse). The `format` substring is
 * deliberately NOT here: ADR-0068 forbids substring matching on `format`
 * because legitimate commands (`git format-patch`, CSS `text-transform: ...
 * format(...)`, `printf "%s format %s"`) would be wrongly denied. The
 * lexical `format` command is caught separately by `isLexicalFormatCommand`.
 */
const DANGEROUS_COMMAND_PATTERNS: readonly DangerousPatternHit[] =
  Object.freeze([
    { id: "destructive-rm", pattern: "rm -rf" },
    { id: "destructive-rm", pattern: "rm -fr" },
    { id: "destructive-rm", pattern: "rm -r " },
    { id: "destructive-rm", pattern: "rm -f " },
    { id: "destructive-rm", pattern: "rm --recursive" },
    { id: "destructive-rm", pattern: "rmdir" },
    { id: "destructive-rm", pattern: "remove-item" },
    { id: "destructive-rm", pattern: " -delete" },
    { id: "destructive-rm", pattern: "chmod -r" },
    { id: "destructive-disk", pattern: "mkfs" },
    { id: "destructive-disk", pattern: "dd if=" },
    { id: "destructive-disk", pattern: ":(){ :|:& };:" },
    { id: "destructive-disk", pattern: "shutdown" },
    { id: "destructive-disk", pattern: "reboot" },
    { id: "destructive-disk", pattern: "del /f" },
    { id: "destructive-disk", pattern: "rd /s" },
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

/**
 * Split a command into top-level segments on newline boundaries first, then
 * `;` / `&&` / `||` / `|`. This is the per-segment scan surface used by
 * `findDangerousPattern` only — the allowlist / readonly-mode code paths keep
 * their existing newline-as-metachar semantics so existing allowlist
 * assertions stay green. Newlines are segment separators per ADR-0068
 * (换行只作分段符); they are NOT dangerous patterns.
 */
function splitForDangerousScan(command: string): string[] {
  // Normalize `\r\n` and bare `\r` to `\n` first so a single split works.
  const normalized = command.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  const out: string[] = [];
  for (const line of lines) {
    for (const seg of splitShellSegments(line)) {
      out.push(seg);
    }
  }
  return out;
}

/**
 * Lexical (token-boundary) `format` command check for a normalized segment
 * (lowercase, backslash-stripped, whitespace-collapsed — the same form the
 * substring scan consumes). Per ADR-0068, `format` is no longer
 * substring-matched; instead the hard-wall only fires when the segment's
 * first token is exactly `format` (with no leading shell noise), catching
 * the `format C:` / `format c:` / bare `format` / backslash-escaped
 * `fo\rmat` host-disk-format case while letting `text-transform`,
 * `git format-patch`, `printf format`, `formatting`, etc. through.
 */
function isLexicalFormatCommand(segment: string): boolean {
  const token = firstToken(segment);
  return token === "format";
}

/**
 * Returns the first dangerous pattern hit in `command`, scanning per-segment
 * after splitting on newlines and shell separators. Returns `null` if no
 * segment triggers a deny rule.
 *
 * Per-segment semantics (ADR-0068 / SC1 / SC8):
 *   - Newlines are segment separators, NOT a dangerous pattern.
 *   - Each segment is independently normalized (lowercase, backslash strip,
 *     whitespace collapse) and scanned against `DANGEROUS_COMMAND_PATTERNS`.
 *   - Command-substitution metachars (`$(`, `${`, backtick, `<(`) still
 *     trigger per-segment: a single segment containing them is enough.
 *   - The bare-metachar branch (segment = nothing but separators / pipes /
 *     redirects) only fires when NO segment has an allowlisted first token,
 *     matching the original "no command body" intent.
 *   - `format` is matched lexically (segment-leading token), never as a
 *     substring.
 */
export function findDangerousPattern(
  command: string
): DangerousPatternHit | null {
  if (command.length === 0) return null;

  const segments = splitForDangerousScan(command);
  if (segments.length === 0) {
    // Command is purely metachar(s) — a bare separator / pipe / redirect
    // with no body. Fall through to the bare-metachar check below.
    return matchBareMetachar(command);
  }

  let anySegmentAllowlisted = false;
  for (const segment of segments) {
    // Strip backslash escapes before scanning so that `r\m -rf /` (an attempt
    // to defeat substring matching) still triggers the `rm -rf` pattern.
    // Collapse runs of whitespace so `rm  -rf` (extra spaces) still hits.
    const lower = segment.toLowerCase().replace(/\\/g, "").replace(/\s+/g, " ");
    for (const entry of DANGEROUS_COMMAND_PATTERNS) {
      if (lower.includes(entry.pattern)) return entry;
    }
    // Lexical `format` command (SC2 / ADR-0068: no substring matching).
    // Fed the SAME normalized segment as the substring scan: the backslash
    // strip exists to defeat escape attempts (`fo\rmat` → `format` in bash),
    // so the lexical gate must not be bypassed by the same escape
    // (`isLexicalFormatCommand(raw)` saw firstToken `rmat` and let it through).
    if (isLexicalFormatCommand(lower)) {
      return { id: "destructive-disk", pattern: "format" };
    }
    // Command-substitution / process substitution per-segment. Backticks
    // and `<(` are still per-segment because they form a complete intent
    // inside one segment.
    if (/\$\(/.test(segment)) {
      return { id: "command-substitution", pattern: "$(" };
    }
    if (/\$\{/.test(segment)) {
      return { id: "command-substitution", pattern: "${" };
    }
    if (/`/.test(segment)) {
      return { id: "command-substitution", pattern: "`" };
    }
    if (/<\s?\(/.test(segment)) {
      return { id: "command-substitution", pattern: "<(" };
    }
    if (ALLOWED_COMMAND_TOKENS.has(firstToken(segment))) {
      anySegmentAllowlisted = true;
    }
  }

  if (!anySegmentAllowlisted) {
    return matchBareMetachar(command);
  }
  return null;
}

/**
 * Bare-metachar detector. Returns the first bare separator / redirect /
 * pipe / background operator that appears in `command`, or null. Used both
 * when the entire command consists of metachars (`;`, `&&`, `|`, ...) and
 * when all segments lack an allowlisted first token.
 */
function matchBareMetachar(command: string): DangerousPatternHit | null {
  for (const bare of ["|", ";", ">", "<", "&", "&&", "||"]) {
    if (command.includes(bare)) {
      return { id: "bare-metachar", pattern: bare };
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

// `$` is deliberately NOT a segment metachar: a plain `$VAR` read (e.g.
// `echo $HOME`) is safe and must be allowed. Command substitution / expansion
// is still blocked — `$(...)` and `${...}` are upstream hard-walled in
// `findDangerousPattern`, and subshell parens `(`/`)` reject `$(...)` here too.
const NON_REDIRECT_METACHARS: readonly string[] = Object.freeze([
  "`",
  "\n",
  "\r",
  "(",
  ")",
]);

/**
 * Shared classification for the `hard-wall:execute-dangerous` match and its
 * SC3 `reasonFor` renderer — a single seam so a future deny branch added
 * here automatically flows into both the decision and the reason (no silent
 * fallback to the static reason when the two drift apart).
 */
function classifyDangerousExecute(input: {
  tool: string;
  input: unknown;
}): string | null {
  if (input.tool !== "bash" && input.tool !== "execute") return null;
  const command = (input.input as { command?: unknown } | null | undefined)
    ?.command;
  if (typeof command !== "string") return null;
  const hit = findDangerousPattern(command);
  if (hit !== null) {
    return `dangerous command pattern matched (id=${hit.id}, pattern="${hit.pattern}")`;
  }
  // Redirection exemption must NOT leak sensitive paths: `echo x > /etc/shadow`
  // passes the segment allowlist via redirect stripping but must still be denied.
  if (commandContainsSensitivePath(command)) {
    return "dangerous command: sensitive path targeted by command";
  }
  // Non-allowlisted commands are NOT hard-walled: they fall through to the
  // mode / category default (ask in default mode). The bwrap fence is the
  // execution-time boundary; a blanket allowlist deny made `pytest`, `cargo`,
  // `go test` etc. impossible to run even with user approval.
  return null;
}

function matchDangerousExecute(input: {
  tool: string;
  input: unknown;
}): boolean {
  return classifyDangerousExecute(input) !== null;
}

/**
 * SC3 deny-reason input-specific override for `hard-wall:execute-dangerous`.
 * Falls back to `undefined` so the static `reason` on the spec is used
 * (defensive: a deny path that provides no classified reason still gets a
 * sensible default).
 */
function dangerousExecuteReasonFor(input: {
  tool: string;
  input: unknown;
}): string | undefined {
  return classifyDangerousExecute(input) ?? undefined;
}

/**
 * Scan a command string for sensitive path fragments (`.ssh/`, `/etc/passwd`,
 * `/etc/shadow`, `.env`, `.pem`, etc.). This mirrors `matchSensitivePath` for
 * path-bearing tools, applied to the `command` field of execute tools so the
 * redirect exemption cannot be abused to write to a sensitive location.
 *
 * Exported so `src/harness/aci/tools/bash.ts` (the handler-level gate) applies
 * the same check as the hard-wall — otherwise a redirect like `>> /etc/shadow`
 * would pass `isDangerousCommand` at the handler and only be stopped by
 * bwrap's ro-bind, not by policy (axis2 skeptic finding).
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
        "execute tool received a dangerous command pattern (remove / fork-bomb / dd / shell-metachar)",
      reasonFor: dangerousExecuteReasonFor,
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
