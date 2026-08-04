import type { HardRuleSpec } from "./types.js";

export const HARD_WALL_DENY_PREFIX = "[hard_wall]";

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

const SHELL_METACHARS: readonly string[] = Object.freeze([
  "|",
  ";",
  "&",
  "<",
  ">",
  "(",
  ")",
  "$",
  "`",
  "\n",
  "\r",
]);

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
  if (!ALLOWED_COMMAND_TOKENS.has(firstToken(command))) return false;
  return !SHELL_METACHARS.some((metachar) => command.includes(metachar));
}

export function findDangerousPattern(command: string): string | null {
  const lower = command.toLowerCase();
  for (const pattern of DANGEROUS_COMMAND_PATTERNS) {
    if (lower.includes(pattern)) return pattern;
  }
  if (/&&/.test(command)) return "&&";
  if (/\|\|/.test(command)) return "||";
  if (/\|/.test(command)) return "|";
  if (/;/.test(command)) return ";";
  if (/`/.test(command)) return "`";
  if (/\$\(/.test(command)) return "$(";
  if (/\$\{/.test(command)) return "${";
  if (/\$[A-Za-z_]/.test(command)) return "$VAR";
  if (/>(?:\s?>)?/.test(command)) return ">";
  if (/<\s?\(/.test(command)) return "<(";
  if (/\r|\n/.test(command)) return "\\n";
  return null;
}

export function isDangerousCommand(command: string): boolean {
  return findDangerousPattern(command) !== null;
}

function matchDangerousExecute(input: {
  tool: string;
  input: unknown;
}): boolean {
  if (input.tool !== "bash" && input.tool !== "execute") return false;
  const command = (input.input as { command?: unknown } | null | undefined)
    ?.command;
  if (typeof command !== "string") return false;
  return isDangerousCommand(command) || !isAllowedCommand(command);
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
