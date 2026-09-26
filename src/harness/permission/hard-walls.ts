import type { HardRuleSpec } from "./types.js";
import { VIOLATION_PREFIXES } from "./prefixes.js";
import {
  parseForSecurity,
  scanWithLegacyDegrade,
  type CommandFact,
  type ExpansionFact,
  type SecurityParseOk,
  type SecurityParseResult,
  type SecurityParseUnknownSyntax,
  type SubstitutionFact,
} from "./shell-parse.js";

// Re-export the SSOT hard-wall prefix for callers that historically imported
// it from here. The authoritative definition lives in `./prefixes.ts`.
export const HARD_WALL_DENY_PREFIX = VIOLATION_PREFIXES.hardWall;

export type HardWallId =
  "hard-wall:execute-dangerous" | "hard-wall:sensitive-path";

/**
 * Machine-readable pattern ids for the execute-dangerous hard-wall. ADR-0125
 * requires the deny `reason` to carry the specific id of the matched pattern,
 * not just a generic shell-metachar label. Categories:
 *   - destructive-rm: recursive / forced removal / chmod recursive / find
 *     -delete. Misuse destroys the writable root or a sibling subtree.
 *   - destructive-disk: filesystem wipe (`mkfs`, `dd if=`), fork-bomb,
 *     system shutdown / reboot, Windows `del /f` / `rd /s`, lexical
 *     `format` command. Affects the host, not just one file.
 *   - command-substitution: a site that really executes a command
 *     (`$(...)`, backticks, `<(...)`) whose inner command is denied. The hit
 *     names the site and the inner's own id, so the reason carries both.
 *   - bare-metachar: command body consisting only of separators /
 *     redirects / pipes with no command word anywhere (e.g. `;`, `|`,
 *     `&&`, `>/tmp/x`). It is NOT an allowlist gate: a segment that names
 *     any command (allowlisted or not) has a body and is judged by the
 *     other ids only.
 *   - root-find-walk: `find` whose search root is the filesystem root
 *     (`/`, `//`, `"/"`), or a bare / `.`-rooted `find` reached after a
 *     `cd /` in the same command. The fence cannot see a whole-machine read
 *     walk (ADR-0068), and in the default global FS posture nothing else
 *     bounds it — the 2026-09-14 incident ran `find /` for ~232 s until the
 *     host cancelled. Not overridable by session grants or `full_auto`.
 *   - unparseable: the parse verdicts ADR-0124 routes to a hard deny
 *     (`malformed`, `aborted`, `over-cap`), its pre-parse veto arm
 *     (`vetoed`), the degrade seam's own backstop (`legacy-threw`), and a
 *     fault inside this file's substitution walk (`analysis-fault`). The
 *     `pattern` carries the routed name as `verdict=<v>` plus ADR-0124's own
 *     human text where that ADR has one.
 *   - parameter-expansion: a `${name}` / `$((name))` site whose NAME Stage 0
 *     read off `expansions[]` matches the secret-name roster (ADR-0125 §3's
 *     first bucket). The other two buckets are not denials: a base-environment
 *     name says nothing, an unknown one is the ask tier's `param-unknown`. The
 *     `pattern` carries the bucket as `param=<bucket>`.
 *   - interpreter-procsub: the combo wall — an interpreter command word fed a
 *     `<(...)` process substitution (ADR-0125 §4). The content becomes code
 *     only at runtime, so no recursion can name it: the deny is decided by the
 *     receiver, never by the inner, and `pattern` carries `combo=<interp>-procsub`.
 */
export type DangerousPatternId =
  | "destructive-rm"
  | "destructive-disk"
  | "command-substitution"
  | "bare-metachar"
  | "root-find-walk"
  | "unparseable"
  | "parameter-expansion"
  | "interpreter-procsub";

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
 * `;` / `&&` / `||` / `|`, preserving the left-to-right order. This is the
 * per-segment scan surface used by `findDangerousPattern` only — the
 * allowlist / readonly-mode code paths keep their existing
 * newline-as-metachar semantics so existing allowlist assertions stay green.
 * Newlines are segment separators per ADR-0068; they are NOT
 * dangerous patterns. The order is what the root-find fold needs: `cd /` and
 * the `find` it arms must be judged in sequence, across newlines too (one
 * bash invocation is one shell, so a `cd /` on an earlier line still sets the
 * cwd a later line's `find .` walks).
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
 * Strip one paired layer of surrounding quotes from a token. `find "/"` and
 * `find /` reach the same syscall, so the quote layer must not decide whether
 * the wall fires. Unpaired quotes are left verbatim (deny-by-default keeps
 * them on the wall's side).
 */
export function stripQuoteLayer(token: string): string {
  if (token.length >= 2) {
    const first = token[0];
    const last = token[token.length - 1];
    if ((first === '"' || first === "'") && last === first) {
      return token.slice(1, -1);
    }
  }
  return token;
}

/**
 * Lexically normalize a path token to the directory it denotes, or
 * `undefined` when it is not absolute. `.` and redundant slashes are
 * dropped, `..` pops one level and clamps at the root — so the root's many
 * spellings (`/`, `//`, `/./`, `/../`, `/tmp/..`) all land on `/` and the
 * wall cannot be spelled around. Pure and non-throwing; relative spellings
 * (`.` / `..` / `src`) return `undefined` and the caller decides.
 */
function normalizeAbsoluteRoot(token: string): string | undefined {
  if (!token.startsWith("/")) return undefined;
  const resolved: string[] = [];
  for (const part of token.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      resolved.pop();
      continue;
    }
    resolved.push(part);
  }
  return `/${resolved.join("/")}`;
}

/**
 * Wrapper tokens that forward the rest of the segment to the named command
 * (`sudo find /` runs `find /`). Transparent for this wall only: the intent
 * is unchanged by the wrapper, so a wall that stopped at the wrapper would be
 * spelled around by one word.
 *
 * The set is the union of the launchers already recognised elsewhere in the
 * repo (`declarative.ts` command wrappers) plus `xargs`, which forwards its
 * argument run the same way — a `find` reached through any of these is the
 * same walk.
 */
const FIND_WRAPPER_TOKENS: ReadonlySet<string> = Object.freeze(
  new Set([
    "sudo",
    "doas",
    "command",
    "exec",
    "env",
    "nohup",
    "time",
    "timeout",
    "nice",
    "stdbuf",
    "setsid",
    "ionice",
    "xargs",
  ])
);

/**
 * Wrapper flags that CONSUME the next token as their value (`sudo -u root …`,
 * `env -u HOME …`, `timeout -s KILL 5 …`). Without arity, a value-taking flag
 * would swallow its value and the scan would land on the value as if it were
 * the command — `sudo -u root find /` would read as the command `root` and the
 * wall would miss the walk (the 2026-09-14 shape reaching spawn).
 *
 * Keys are `<wrapper>:<flag>`; the value is how many tokens the flag eats.
 * `-`-prefixed flags NOT listed here are treated as consuming one value when
 * they are not the last token — fail-closed, because guessing wrong in the
 * other direction is what opens the bypass.
 */
const WRAPPER_FLAG_ARITY: ReadonlyMap<string, number> = new Map([
  ["sudo:-u", 1],
  ["sudo:--user", 1],
  ["sudo:-g", 1],
  ["sudo:--group", 1],
  ["sudo:-C", 1],
  ["sudo:--close-from", 1],
  ["sudo:-p", 1],
  ["sudo:--prompt", 1],
  ["doas:-u", 1],
  ["env:-u", 1],
  ["env:--unset", 1],
  ["env:-C", 1],
  ["env:--chdir", 1],
  ["env:-S", 1],
  ["env:--split-string", 1],
  ["timeout:-s", 1],
  ["timeout:--signal", 1],
  ["timeout:-k", 1],
  ["timeout:--kill-after", 1],
  ["nice:-n", 1],
  ["nice:--adjustment", 1],
  ["stdbuf:-i", 1],
  ["stdbuf:-o", 1],
  ["stdbuf:-e", 1],
  ["ionice:-c", 1],
  ["ionice:-n", 1],
  ["ionice:-p", 1],
]);

/** Token that is one wrapper's own argument (not the wrapped command). */
function isWrapperArgument(
  token: string,
  wrapper: string | undefined
): boolean {
  if (token.includes("=")) return true;
  if (!token.startsWith("-")) return /^\d+(?:\.\d+)?[smhd]?$/.test(token);
  // Short flags may be glued to their value (`-uroot`, `-sKILL`).
  const flag = token.split("=")[0]!;
  const glued = flag.length > 2 ? flag.slice(0, 2) : flag;
  if (wrapper !== undefined) {
    if (WRAPPER_FLAG_ARITY.has(`${wrapper}:${flag}`)) return true;
    if (WRAPPER_FLAG_ARITY.has(`${wrapper}:${glued}`)) return true;
  }
  // EXIT: unmodeled flag on a known wrapper — fail closed, treat it as
  // consuming the next token so the wrapped command word is never mistaken
  // for a flag value.
  return true;
}

/**
 * Tokens of one segment, whitespace-split with quotes kept (the split is
 * deliberately simple — quoted spellings are handled by `stripQuoteLayer`).
 */
function segmentTokens(segment: string): string[] {
  return segment.trim().split(/\s+/);
}

/** Command word of a token with backslash escapes stripped (`f\ind` → `find`). */
function commandWord(token: string): string {
  return firstToken(token.replace(/\\/g, ""));
}

/**
 * Name of the command a segment runs, skipping wrapper prefixes (`sudo` /
 * `env` / `nohup` …) and their own arguments. Backslash escapes are stripped
 * for the same reason the substring scan strips them: `f\ind /` is `find /`
 * to bash. Returns the command word and its token index.
 */
function commandAt(
  tokens: ReadonlyArray<string>
): { name: string; index: number } | undefined {
  let i = 0;
  let wrapper: string | undefined;
  while (i < tokens.length) {
    const bare = stripQuoteLayer(tokens[i]!.replace(/\\/g, "")).toLowerCase();
    if (FIND_WRAPPER_TOKENS.has(bare)) {
      wrapper = bare;
      i += 1;
      continue;
    }
    // A wrapper's own argument run: value-taking flags eat their value, so the
    // scan lands on the wrapped command, never on a flag value.
    if (wrapper !== undefined && isWrapperArgument(tokens[i]!, wrapper)) {
      i += valueTokensEaten(tokens, i, wrapper) + 1;
      continue;
    }
    // Quote-normalized: `"find" /` and `find /` are the same command to bash.
    return {
      name: commandWord(stripQuoteLayer(tokens[i]!)),
      index: i,
    };
  }
  return undefined;
}

/**
 * How many tokens beyond the flag itself the flag consumes: 1 for a modelled
 * value-taking flag spelled separately (`-u root`), 0 when the value is glued
 * (`-uroot`) or when the flag is not modelled (nothing to eat — the token was
 * already treated as an opaque wrapper argument by `isWrapperArgument`).
 */
function valueTokensEaten(
  tokens: ReadonlyArray<string>,
  index: number,
  wrapper: string
): number {
  const token = tokens[index]!;
  if (token.includes("=")) return 0;
  const flag = token.split("=")[0]!;
  const arity =
    WRAPPER_FLAG_ARITY.get(`${wrapper}:${flag}`) ??
    WRAPPER_FLAG_ARITY.get(`${wrapper}:${flag.slice(0, 2)}`);
  if (arity !== 1) return 0;
  // Modelled long flag (`--user root`): the value is always a separate token,
  // since a glued value would have carried `=` and exited above.
  if (flag.startsWith("--")) return 1;
  // Modelled short flag: eats its value only when the value is a separate
  // token (`-u root`); a glued spelling (`-uroot`) is one token already.
  return flag.length > 2 ? 0 : 1;
}

/**
 * True when a `find` segment walks the whole machine. Restated invariant (T4
 * acceptance): `find <root> …` never spawns when `<root>` denotes the
 * filesystem root — with or without predicates such as `-maxdepth N`; the
 * wall does not wait for a predicate to appear, because the walk is the thing
 * being denied, not its output shape. Roots that are NOT this wall: `.` /
 * `..` / relative paths / `/tmp` and any other non-root absolute path —
 * scoping the tree is the reader's job (ADR-0068; the 300 s bash
 * `timeoutTier: build` is not the control).
 *
 * Whole-command form (`enclosedByRootCd`): `cd / && find .` is the same
 * whole-machine walk with the root hidden in the `cd`, so the caller passes
 * the `cd`-aware decision in. A `cd /` followed by a NON-`find` segment is
 * out of this wall's scope (the walk's repository is what is hard-walled, not
 * `cd` itself).
 *
 * Bare `find` with no path operand walks the shell cwd (GNU find; the
 * options-first spelling `find -name x` included), so it is denied exactly
 * when that cwd is the filesystem root. The near-miss `find /tmp -maxdepth N`
 * is NOT denied — the readonly find-flag table answers for it, same as any
 * other non-root walk.
 */
function isRootFindSegment(segment: string, cwd: string | undefined): boolean {
  const tokens = segmentTokens(segment);
  const command = commandAt(tokens);
  // EXIT: not a find segment — the wall does not speak about other commands.
  if (command === undefined || command.name !== "find") return false;
  const operands = commandOperands(tokens, command.index);
  // No path operand: find walks the shell cwd, which is the filesystem root
  // only when a preceding segment moved there (`cd / && find`).
  if (operands.length === 0) return cwd === "/";
  return operands.some((raw) => operandDenotesRoot(raw, cwd));
}

/**
 * True when one `find` path operand resolves to the walk root. Every operand
 * is tested (not just the first) so a multi-root `find /tmp /` cannot hide the
 * root behind a non-root prefix.
 *
 * Resolution is the SAME one `cd` uses (`resolveCdTarget`), so a relative
 * operand is judged against the known cwd rather than compared literally:
 * `cd /tmp && find ..` and `cd / && find ./..` are as much `find /` as the
 * absolute `find /tmp/..` spelling, and denying one while allowing the other
 * would leave the wall spellable-around. With no known cwd a relative operand
 * stays out of the wall (nothing to resolve against — fail-closed only where
 * the cwd is actually known).
 *
 * Glob stems: `find /*` expands to every top-level entry, i.e. the same
 * whole-machine walk, so the prefix before the first glob metacharacter is
 * what gets resolved (`/*` stem is `/`). This over-denies the rare
 * single-character pattern rooted directly at `/` (e.g. `/?tmp`); the
 * fail-closed direction is the accepted cost.
 */
function operandDenotesRoot(raw: string, cwd: string | undefined): boolean {
  const operand = stripQuoteLayer(raw);
  const stem = operand.split(/[*?[{]/, 1)[0] ?? "";
  const absolute = normalizeAbsoluteRoot(stem);
  if (absolute === "/") return true;
  if (absolute !== undefined) return false;
  // Relative operand: resolve against the cwd the `cd` fold established.
  return resolveCdTarget(stem, cwd) === "/";
}

/**
 * Global options `find` accepts BEFORE the search root and how many following
 * tokens each consumes: symlink handling (`-H` / `-L` / `-P`) and `--` take
 * none, `-D<debug>` takes one, and `-O<level>` is glued (`find -O2 /` is a
 * real root walk — verified against GNU findutils 4.10). Nothing else
 * starting with `-` precedes the root, so a `-`-token ends the operand run;
 * that is what makes `find -name x` with no path operand read as a bare walk
 * rather than as a root named `-name`.
 */
const FIND_GLOBAL_OPTION_ARITY: ReadonlyMap<string, number> = new Map([
  ["-H", 0],
  ["-L", 0],
  ["-P", 0],
  ["-D", 1],
  ["--", 0],
]);

/**
 * Search roots of a `find` command named at `at`: the global options that may
 * precede the path list are skipped, then every token up to the first
 * predicate / operator is collected — GNU find's own grammar (`find
 * [global-options] [path…] [expression]`, paths must precede the expression).
 * Every token is returned, not just the first: `find /tmp /` walks both
 * roots, so a root in any path position is the same whole-machine walk.
 *
 * Options-first spellings (`find -maxdepth 1 /`) are deliberately NOT read as
 * paths: GNU find rejects them with "paths must precede expression" before it
 * walks anything (verified against findutils 4.10), so they cannot produce
 * the walk this wall exists to stop, and reading them as paths would deny the
 * harmless scoped spelling `find -name x .`-adjacent forms.
 */
function commandOperands(tokens: ReadonlyArray<string>, at: number): string[] {
  const out: string[] = [];
  for (let i = at + 1; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (out.length === 0) {
      const skip = findGlobalOptionArity(token);
      if (skip !== undefined) {
        i += skip;
        continue;
      }
    }
    if (token.startsWith("-") || token === "(" || token === "!") break;
    out.push(token);
  }
  return out;
}

/**
 * Tokens a leading `find` global option consumes before the search root:
 * `undefined` = not a global option (a root or a predicate), 0 = consumes
 * nothing (`-L`, `--`, `-O2`), 1 = consumes the next token (`-D tree`).
 */
function findGlobalOptionArity(token: string): number | undefined {
  const known = FIND_GLOBAL_OPTION_ARITY.get(token);
  if (known !== undefined) return known;
  return /^-O\d+$/.test(token) ? 0 : undefined;
}

/**
 * Shell cwd tracked lexically through a command's `cd` segments. `undefined`
 * means "not lexically known" (never set, `~`, `cd "$VAR"`, a relative target
 * from an unknown cwd) — the wall then cannot claim the cwd is the root.
 */
interface CwdState {
  readonly cwd: string | undefined;
  readonly oldpwd: string | undefined;
}

/**
 * The cwd state a `cd` segment moves to, or `null` when the segment is not a
 * `cd`. Chained `cd`s must be tracked as a path, not a root boolean: `cd / &&
 * cd /tmp && find .` ends outside the root while `cd /tmp && cd .. && find .`
 * ends on it. `cd -` swaps in OLDPWD (`cd / && cd /tmp && cd -` is back on
 * `/`), so OLDPWD is tracked too — that swap is a root walk otherwise.
 *
 * `..` is resolved against the cwd known so far and clamps at the root
 * (`cd / && cd ..` is still `/`), matching the bash builtin. Destinations
 * that cannot be read lexically (`~`, `$VAR`, a relative path with no known
 * cwd) clear both fields rather than guess.
 */
function applyCd(segment: string, state: CwdState): CwdState | null {
  const tokens = segmentTokens(segment);
  const command = commandAt(tokens);
  if (command === undefined || command.name !== "cd") return null;
  const operand = cdTargetOperand(tokens, command.index);
  // OLDPWD becomes the cwd being left, for every cd spelling including `-`.
  const oldpwd = state.cwd;
  if (operand === "-") return { cwd: state.oldpwd, oldpwd };
  if (operand !== undefined) {
    const resolved = resolveCdTarget(operand, state.cwd);
    if (resolved !== undefined) return { cwd: resolved, oldpwd };
  }
  return { cwd: undefined, oldpwd };
}

/**
 * The destination operand of a `cd` named at `at`, unquoted, skipping `cd`'s
 * own options (`-P` / `-L` / `--`). `undefined` for a bare `cd` with no
 * destination (which moves to `$HOME`, not lexically readable).
 */
function cdTargetOperand(
  tokens: ReadonlyArray<string>,
  at: number
): string | undefined {
  let i = at + 1;
  while (
    i < tokens.length &&
    (tokens[i] === "--" || tokens[i] === "-P" || tokens[i] === "-L")
  ) {
    i += 1;
  }
  const raw = tokens[i];
  return raw === undefined ? undefined : stripQuoteLayer(raw);
}

/**
 * Absolute cwd a `cd` target denotes, resolving relative targets against the
 * known cwd (`cd ./..` from `/tmp` is `/`). `undefined` when the target is
 * not lexically readable: `~` expansions, `$VAR` / backtick substitutions and
 * anything with no known cwd to resolve against (`normalizeAbsoluteRoot`
 * clamps `..` at the root, so `cd / && cd ..` stays `/`).
 */
function resolveCdTarget(
  operand: string,
  cwd: string | undefined
): string | undefined {
  const absolute = normalizeAbsoluteRoot(operand);
  if (absolute !== undefined) return absolute;
  if (cwd === undefined) return undefined;
  if (
    operand.startsWith("~") ||
    operand.includes("$") ||
    operand.includes("`")
  ) {
    return undefined;
  }
  return normalizeAbsoluteRoot(`${cwd}/${operand}`);
}

/**
 * Scan a command's ordered segment sequence for the root-find walk, folding
 * the shell cwd left-to-right: `cd / && find .` hides the walk root in the
 * `cd`, and only the `cd` sequence can read it back. The cwd starts unknown,
 * so a command that never `cd`s cannot be judged beyond its own operands.
 */
function matchRootFindWalk(
  segments: ReadonlyArray<string>
): DangerousPatternHit | null {
  let state: CwdState = { cwd: undefined, oldpwd: undefined };
  for (const segment of segments) {
    const moved = applyCd(segment, state);
    if (moved !== null) state = moved;
    if (isRootFindSegment(segment, state.cwd)) {
      // EXIT: reject on the first root-walk find — the whole-machine walk is
      // the intent being denied, so no later segment can rescue the command.
      return { id: "root-find-walk", pattern: "find" };
    }
  }
  return null;
}

/**
 * Deny rules that hold inside ONE segment, independent of its position.
 * Returns the first hit or null. Split out of `findDangerousPattern` so the
 * per-segment scan and the ordered walk fold stay separate decision surfaces.
 *
 * The substitution sites are NOT judged here: on the primary path they are
 * decided by the parse (`analyzeSubstitutions`), and the quote-blind needles
 * that used to stand at the end of this function live on only in
 * function legacySubstitutionScan(segment), which the degrade path reaches.
 */
function scanSegment(segment: string): DangerousPatternHit | null {
  // Strip backslash escapes before scanning so that `r\m -rf /` (an attempt
  // to defeat substring matching) still triggers the `rm -rf` pattern.
  // Collapse runs of whitespace so `rm  -rf` (extra spaces) still hits.
  const lower = segment.toLowerCase().replace(/\\/g, "").replace(/\s+/g, " ");
  for (const entry of DANGEROUS_COMMAND_PATTERNS) {
    if (lower.includes(entry.pattern)) return entry;
  }
  // Lexical `format` command (ADR-0068: no substring matching).
  // Fed the SAME normalized segment as the substring scan: the backslash
  // strip exists to defeat escape attempts (`fo\rmat` → `format` in bash),
  // so the lexical gate must not be bypassed by the same escape
  // (`isLexicalFormatCommand(raw)` saw firstToken `rmat` and let it through).
  if (isLexicalFormatCommand(lower)) {
    return { id: "destructive-disk", pattern: "format" };
  }
  return null;
}

/**
 * The four quote-blind substitution needles, kept verbatim as the degrade
 * path's answer (ADR-0124's parser-unavailable state, ADR-0125's Assumption
 * 11): a hard deny must not degrade into a silent allow just because the
 * parser is unavailable. Reachable only through the legacy pair below, never
 * from the primary path.
 */
function legacySubstitutionScan(segment: string): DangerousPatternHit | null {
  // Command-substitution / process substitution per-segment. Backticks
  // and `<(` are still per-segment because they form a complete intent
  // inside one segment.
  if (/\$\(/.test(segment)) {
    return { id: "command-substitution", pattern: "$(" };
  }
  if (/\$\{/.test(segment)) {
    return { id: "command-substitution", pattern: "${" };
  }
  if (/\x60/.test(segment)) {
    return { id: "command-substitution", pattern: "`" };
  }
  if (/<\s?\(/.test(segment)) {
    return { id: "command-substitution", pattern: "<(" };
  }
  return null;
}

/**
 * Today's whole-command scan, kept as the seam's `legacyScan` role: the text
 * branches in the same order as the primary path, plus the quote-blind
 * substitution needles that the primary path no longer reads. Exported only
 * so the degrade seam can be handed this value; nothing else may call it.
 */
export function legacyFindDangerousPattern(
  command: string
): DangerousPatternHit | null {
  if (command.length === 0) return null;
  return scanTextWalls(command, (segment) => {
    return scanSegment(segment) ?? legacySubstitutionScan(segment);
  });
}

/**
 * The shared skeleton of both text scans: the ordered root-find fold gets
 * first claim, then the per-segment rules, then — only when no segment ever
 * started a command — the bare-metachar branch.
 */
function scanTextWalls(
  command: string,
  segmentScan: (segment: string) => DangerousPatternHit | null
): DangerousPatternHit | null {
  const segments = splitForDangerousScan(command);
  if (segments.length === 0) {
    // Command is purely metachar(s) — a bare separator / pipe / redirect
    // with no body. Fall through to the bare-metachar check below.
    return matchBareMetachar(command);
  }

  // Ordered fold: needs the `cd /` that preceded a `find` in the same shell.
  const walkHit = matchRootFindWalk(segments);
  if (walkHit !== null) return walkHit;

  let anySegmentHasCommandWord = false;
  for (const segment of segments) {
    const hit = segmentScan(segment);
    if (hit !== null) return hit;
    if (segmentHasCommandWord(segment)) anySegmentHasCommandWord = true;
  }

  // No segment ever started a command — the body is nothing but
  // separators / redirects / pipes. The raw-string metachar scan is only
  // sound for THAT shape; run against a real command word it would score
  // heredoc `<<` or interpreter source punctuation as danger (ADR-0068:
  // the wall is not a syntax blacklist simulating the fence).
  if (!anySegmentHasCommandWord) {
    return matchBareMetachar(command);
  }
  return null;
}

/** The text branches of the primary path: destructive / disk / root-find / bare-metachar. */
function findTextDangerPattern(command: string): DangerousPatternHit | null {
  return scanTextWalls(command, scanSegment);
}

/**
 * True when every segment of the command is operator noise — no segment ever
 * started a command. This is the shape the bare-metachar wall speaks about,
 * and it is a property of the text: a tree-sitter ERROR for `;` does not turn
 * separator noise into an unparseable deny (ADR-0068 keeps the id).
 */
function isPureMetacharBody(command: string): boolean {
  const segments = splitForDangerousScan(command);
  if (segments.length === 0) return true;
  return segments.every((segment) => !segmentHasCommandWord(segment));
}

/**
 * The human-facing reason of ADR-0124's over-cap state and of the pre-parse
 * veto is carried into the deny so the operator sees the class, not only a
 * structural token; `malformed` and `aborted` render their `verdict=` alone.
 */
function routeParseVerdict(
  result: SecurityParseResult
): DangerousPatternHit | null {
  switch (result.kind) {
    case "malformed":
      return { id: "unparseable", pattern: "verdict=malformed" };
    case "aborted":
      return { id: "unparseable", pattern: "verdict=aborted" };
    case "over-cap":
      return {
        id: "unparseable",
        pattern: `verdict=over-cap ${result.reason}`,
      };
    case "vetoed":
      return { id: "unparseable", pattern: `verdict=vetoed ${result.reason}` };
    default:
      return null;
  }
}

/**
 * Returns the first dangerous pattern hit in `command`. Returns `null` if the
 * command triggers no deny rule.
 *
 * Per-segment semantics (ADR-0068 / ADR-0124 / ADR-0125):
 *   - The single seam call, scanWithLegacyDegrade(command,
 *     legacyFindDangerousPattern), decides everything: the parse answers the
 *     substitution family, and only a parser that never loaded answers from
 *     the legacy text scan.
 *   - ADR-0124's hard-deny outcomes (malformed / aborted / over-cap / the
 *     pre-parse veto) fold into `unparseable` and outrank every other branch.
 *   - Substitution sites are judged by the parse: each inner command of
 *     `substitutions[]` runs through the same text rules as the outer one and
 *     only a DENY propagates upward (the wall cannot emit an ask). A `<(...)`
 *     handed to an interpreter denies on the receiver alone (`combo=`), and a
 *     `${name}` site is judged by NAME off `expansions[]` (`param=`): the
 *     secret-name bucket is the only denial there, the unknown bucket and a
 *     name-less site are the ask tier's, and the whitelist bucket is silence.
 *   - A heredoc body is judged by its receiver: an interpreter's body is code
 *     whatever its delimiter's quoting — re-parsed through the same entry and
 *     routed by that sub-parse's verdict — and a quoted body of a text receiver
 *     is data the substitution family never speaks about.
 *   - Newlines are segment separators, NOT a dangerous pattern.
 *   - Each segment is independently normalized (lowercase, backslash strip,
 *     whitespace collapse) and scanned against `DANGEROUS_COMMAND_PATTERNS`.
 *     Those text branches stay quote-blind until the AST migration.
 *   - The bare-metachar branch (segment = nothing but separators / pipes /
 *     redirects) only fires when NO segment has a command word — the
 *     "no command body" intent. Allowlist membership is irrelevant here:
 *     the raw-string scan must not judge a payload that belongs to some
 *     command word (`python3 -c "…;…"`), only a body that is pure noise.
 *   - `format` is matched lexically (segment-leading token), never as a
 *     substring.
 *   - The root-find walk is decided on the ORDERED segment fold (a `cd /`
 *     arms the `find` that follows it), which the flat per-segment scan
 *     cannot see; it runs before the scan loop so it gets first claim.
 */
export function findDangerousPattern(
  command: string
): DangerousPatternHit | null {
  if (command.length === 0) return null;

  const outcome = scanWithLegacyDegrade(command, legacyFindDangerousPattern);
  switch (outcome.kind) {
    case "legacy-hit":
      // Structurally this is `legacyFindDangerousPattern`'s own record; the
      // seam types it loosely so `shell-parse.ts` stays out of this module's
      // import graph.
      return outcome.hit as DangerousPatternHit;
    case "legacy-clean":
      return null;
    case "legacy-threw":
      return {
        id: "unparseable",
        pattern: `verdict=legacy-threw ${outcome.reason}`,
      };
    case "parsed":
      break;
  }

  const result = outcome.result;
  const routed = routeParseVerdict(result);
  if (routed !== null) {
    // One shape keeps its old id across the routing: a body that is nothing
    // but separators / pipes / redirects is bare-metachar noise (ADR-0068),
    // and the wall says so rather than blaming the parser for a tree-sitter
    // ERROR on `;`.
    if (isPureMetacharBody(command)) {
      const bare = matchBareMetachar(command);
      if (bare !== null) return bare;
    }
    return routed;
  }

  if (result.kind === "ok" || result.kind === "unknown-syntax") {
    const analysis = analyzeSubstitutions(result);
    if (analysis.verdict === "denied") return analysis.hit;
    if (analysis.verdict === "analysis-fault") {
      return { id: "unparseable", pattern: "verdict=analysis-fault" };
    }
    // `ask` is not this layer's channel: it falls through to the text rules
    // and the mode / category default, which is where an ask is emitted.
  }

  return findTextDangerPattern(command);
}

/**
 * The one closed roster of interpreters (ADR-0125 Assumption 7), consumed by
 * both rules that ask "does this word execute what it is handed?": the combo
 * wall below and the heredoc receiver test. Frozen here rather than imported:
 * `permission/` takes no value from `sandbox/`, and merging this list with the
 * map-fog allowlist is the sibling spec's Stage 2-4 criterion, not this stage's.
 */
const INTERPRETER_COMMAND_NAMES: ReadonlySet<string> = Object.freeze(
  new Set([
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
  ])
);

/**
 * ADR-0125 §3's first bucket, as a frozen duplicate of the sandbox module's own
 * name matcher (`src/harness/sandbox/env-isolation.ts`'s private
 * `SECRET_PATTERN`, whose alternation these source characters copy). Copied and
 * not imported for two separate reasons, both recorded in
 * `specs/substitution-hard-walls.md`: `permission/` takes no value from
 * `sandbox/` (`prefixes.ts:10-11`), and that module's exported
 * `SECRET_ENV_NAMES` is a snapshot of the names present in the live environment
 * at load time — a deny whose trigger depends on the operator's environment
 * would be weaker than an unconditional one, so bucket 1 needs the classifier,
 * never the snapshot. `tests/harness/permission/substitution-matrix.test.ts`
 * pins this pattern byte-for-byte against the sandbox source, where crossing the
 * boundary is legal; Stage 4 of `specs/hard-wall-ast-migration.md` (its
 * SC-S4-4) merges the copy back into one roster under the `secret_name` facet.
 * It matches NAMES: a secret-shaped VALUE (`sk-…`) is the egress sentinel's and
 * `DEFAULT_SECRET_PATTERNS`' business, never this wall's.
 */
export const SECRET_NAME_PATTERN =
  /API[_-]?KEY|SECRET|TOKEN|PASSWD|PASSWORD|PRIVATE[_-]?KEY/i;

/**
 * ADR-0125 Assumption 4's second bucket, as a frozen duplicate of
 * `src/harness/sandbox/env-isolation.ts`'s `BASE_ENV_WHITELIST` — the same nine
 * names, for the same reason `SECRET_NAME_PATTERN` is a copy (the boundary rule
 * above), pinned equal from the test side and merged into one roster by the
 * sibling spec's Stage 4 under the `base_env_name` facet. Membership here buys
 * silence, not an allow: the command still faces the rules, the mode and the
 * fence.
 */
export const BASE_ENV_NAMES: readonly string[] = Object.freeze([
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TMPDIR",
  "NODE_NO_WARNINGS",
  "NODE_PATH",
]);

/** Substitution sites and heredoc bodies share this one analysis ceiling. */
const MAX_SUBSTITUTION_LEVEL = 2;

/** One reason the wall layer has to hand a command to the ask tier. */
export interface SubstitutionAsk {
  readonly kind:
    | "param-unknown"
    | "substitution-depth-exceeded"
    | "unknown-syntax"
    | "receiver-unresolvable"
    | "inner-ask";
  /** The rendered token the reason carries (ADR-0125's bucket / site name). */
  readonly detail: string;
  /** Present exactly for the two reasons a human needs the inner to act on. */
  readonly inner?: string;
}

/**
 * The three answers of the substitution walk. `ask` with an empty list means
 * "nothing to report"; a `null` owner or receiver index is a declared arm of
 * Stage 0's payload and goes to that arm, never to `analysis-fault`, which is
 * reserved for shapes the declared types cannot produce.
 */
export type SubstitutionAnalysis =
  | { readonly verdict: "denied"; readonly hit: DangerousPatternHit }
  | { readonly verdict: "ask"; readonly asks: readonly SubstitutionAsk[] }
  | { readonly verdict: "analysis-fault"; readonly reason: string };

/**
 * One heredoc body the walk has to read, with the receiver's verdict already
 * attached: `isCode` says the command word on the other end of the heredoc
 * executes this text, which is the only thing quoting can never take away.
 */
interface HeredocBody {
  readonly text: string;
  readonly isCode: boolean;
}

/** A prepared parse: the lookups the walk needs, already shape-checked. */
interface PreparedParse {
  readonly text: string;
  readonly byIndex: ReadonlyMap<number, CommandFact>;
  readonly roots: readonly SubstitutionFact[];
  readonly children: ReadonlyMap<number, readonly SubstitutionFact[]>;
  readonly expansions: readonly ExpansionFact[];
  readonly bodies: readonly HeredocBody[];
}

type Preparation =
  | { readonly ok: true; readonly prepared: PreparedParse }
  | { readonly ok: false; readonly reason: string };

type WalkStep =
  | { readonly kind: "hit"; readonly hit: DangerousPatternHit }
  | { readonly kind: "fault"; readonly reason: string }
  | { readonly kind: "clean" };

const CLEAN_STEP: WalkStep = Object.freeze({ kind: "clean" });

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function hasSpan(value: unknown): value is { start: number; end: number } {
  if (value === null || typeof value !== "object") return false;
  const span = value as { start?: unknown; end?: unknown };
  return isFiniteNumber(span.start) && isFiniteNumber(span.end);
}

function nameOfWord(word: unknown): string | undefined {
  if (word === null || typeof word !== "object") return undefined;
  const text = (word as { text?: unknown }).text;
  return typeof text === "string"
    ? commandWord(stripQuoteLayer(text))
    : undefined;
}

/**
 * The span of one command node, read off the parse's own text. The destructive
 * text rules are still substring rules (the AST migration retires them), so
 * the inner command is handed to them in the same normalized form the outer
 * segments are.
 */
function commandText(text: string, command: CommandFact): string {
  if (!hasSpan(command.span)) return "";
  return text.slice(command.span.start, command.span.end);
}

/**
 * Shape-check the payload the walk is about to consume and collect the asks
 * its declared `null` arms carry. Every lookup the walk performs is proven
 * here, so the walk itself cannot miss.
 */
function preparePayload(
  payload: SecurityParseOk,
  asks: SubstitutionAsk[]
): Preparation {
  const text = typeof payload.text === "string" ? payload.text : undefined;
  if (text === undefined) {
    return { ok: false, reason: "the parsed text is not a string" };
  }
  if (!Array.isArray(payload.commands)) {
    return { ok: false, reason: "commands[] is not a list of command facts" };
  }
  const byIndex = new Map<number, CommandFact>();
  for (const command of payload.commands) {
    if (command === null || typeof command !== "object") {
      return { ok: false, reason: "a commands[] entry is not a command fact" };
    }
    if (!isFiniteNumber(command.index)) {
      return {
        ok: false,
        reason: "a commands[] entry carries no resolvable index",
      };
    }
    if (!Array.isArray(command.argv)) {
      return {
        ok: false,
        reason: `commands[${command.index}].argv is not a list`,
      };
    }
    if (byIndex.has(command.index)) {
      return {
        ok: false,
        reason: `commands[] names index ${command.index} twice`,
      };
    }
    byIndex.set(command.index, command);
  }

  if (!Array.isArray(payload.substitutions)) {
    return { ok: false, reason: "substitutions[] is not a list of site facts" };
  }
  const innerIndexes = new Set<number>();
  for (const site of payload.substitutions) {
    if (site === null || typeof site !== "object") {
      return {
        ok: false,
        reason: "a substitutions[] entry is not a site fact",
      };
    }
    if (site.innerCommandIndex !== null) {
      if (!isFiniteNumber(site.innerCommandIndex)) {
        return {
          ok: false,
          reason: "innerCommandIndex holds something other than an index",
        };
      }
      innerIndexes.add(site.innerCommandIndex);
    }
  }
  const roots: SubstitutionFact[] = [];
  const children = new Map<number, SubstitutionFact[]>();
  for (const site of payload.substitutions) {
    const inner = site.innerCommandIndex;
    if (inner !== null && !byIndex.has(inner)) {
      return {
        ok: false,
        reason: `innerCommandIndex ${String(inner)} names no command in the parse`,
      };
    }
    const owner = site.ownerCommandIndex;
    if (owner === null) {
      roots.push(site);
      continue;
    }
    if (!isFiniteNumber(owner) || !byIndex.has(owner)) {
      return {
        ok: false,
        reason: `ownerCommandIndex ${String(owner)} names no command in the parse`,
      };
    }
    // A site whose owner is itself some site's inner command is nested; the
    // nesting level comes from that chain, never from a text rescan. A null
    // owner is a declared arm (a redirect hanging off a compound node) and
    // then the site is judged on its own, one level down from the top.
    if (innerIndexes.has(owner)) {
      const bucket = children.get(owner);
      if (bucket === undefined) children.set(owner, [site]);
      else bucket.push(site);
    } else {
      roots.push(site);
    }
  }

  if (!Array.isArray(payload.expansions)) {
    return {
      ok: false,
      reason: "expansions[] is not a list of expansion facts",
    };
  }
  const expansions: ExpansionFact[] = [];
  for (const entry of payload.expansions) {
    if (entry === null || typeof entry !== "object") {
      return {
        ok: false,
        reason: "an expansions[] entry is not an expansion fact",
      };
    }
    if (entry.name !== null && typeof entry.name !== "string") {
      return {
        ok: false,
        reason: "an expansions[] name is neither a string nor null",
      };
    }
    if (!hasSpan(entry.span)) {
      return { ok: false, reason: "an expansions[] span is not a span" };
    }
    // SC7's bucket key is the NAME and nothing else, so `ownerCommandIndex` is
    // not consulted here: a null owner is a declared arm that resolves through
    // this same name bucket (SC11's round-8 narrowing), and a number needs no
    // lookup for the same reason.
    expansions.push(entry);
  }

  if (!Array.isArray(payload.heredocs)) {
    return { ok: false, reason: "heredocs[] is not a list of body facts" };
  }
  const bodies: HeredocBody[] = [];
  for (const heredoc of payload.heredocs) {
    if (heredoc === null || typeof heredoc !== "object") {
      return { ok: false, reason: "a heredocs[] entry is not a body fact" };
    }
    if (!hasSpan(heredoc.bodySpan)) {
      return { ok: false, reason: "a heredocs[] bodySpan is not a span" };
    }
    const { start, end } = heredoc.bodySpan;
    if (start < 0 || end < start || end > text.length) {
      return {
        ok: false,
        reason: `heredocs[] bodySpan ${start}..${end} names nothing in the text`,
      };
    }
    if (typeof heredoc.delimiterQuoted !== "boolean") {
      return {
        ok: false,
        reason: "a heredocs[] delimiter is neither quoted nor not",
      };
    }
    const receiverIndex = heredoc.receiverCommandIndex;
    if (receiverIndex === null) {
      // A declared arm of the field's type: no receiver classification at all,
      // so the body is neither code nor data here — the ask bucket decides it.
      asks.push({
        kind: "receiver-unresolvable",
        detail: "receiver-unresolvable=heredoc",
      });
      continue;
    }
    if (!isFiniteNumber(receiverIndex) || !byIndex.has(receiverIndex)) {
      return {
        ok: false,
        reason: `receiverCommandIndex ${String(receiverIndex)} names no command`,
      };
    }
    const receiver = byIndex.get(receiverIndex) as CommandFact;
    const name = nameOfWord(receiver.argv[0]);
    if (name === undefined) {
      return {
        ok: false,
        reason: `the receiver command ${receiverIndex} carries no command word`,
      };
    }
    // The receiver, not the delimiter, decides whether this text is code: an
    // interpreter executes its body whatever the quoting, and an unquoted body
    // is live for any receiver because bash expands it. A quoted body of a text
    // command is data and never reaches the walk at all.
    const isCode = INTERPRETER_COMMAND_NAMES.has(name);
    if (isCode || !heredoc.delimiterQuoted) {
      bodies.push({ text: text.slice(start, end), isCode });
    }
  }

  if (!Array.isArray(payload.redirects)) {
    return { ok: false, reason: "redirects[] is not a list of redirect facts" };
  }
  for (const redirect of payload.redirects) {
    if (redirect === null || typeof redirect !== "object") {
      return {
        ok: false,
        reason: "a redirects[] entry is not a redirect fact",
      };
    }
    if (redirect.ownerCommandIndex === null) {
      asks.push({
        kind: "receiver-unresolvable",
        detail: "receiver-unresolvable=redirect",
      });
      continue;
    }
    if (
      !isFiniteNumber(redirect.ownerCommandIndex) ||
      !byIndex.has(redirect.ownerCommandIndex)
    ) {
      return {
        ok: false,
        reason: `redirect ownerCommandIndex ${String(redirect.ownerCommandIndex)} names no command`,
      };
    }
  }

  return {
    ok: true,
    prepared: { text, byIndex, roots, children, expansions, bodies },
  };
}

/** The text rules of the primary path, applied to one command node's source. */
function scanCommandText(source: string): DangerousPatternHit | null {
  const segments = splitForDangerousScan(source);
  const walkHit = matchRootFindWalk(segments);
  if (walkHit !== null) return walkHit;
  for (const segment of segments) {
    const hit = scanSegment(segment);
    if (hit !== null) return hit;
  }
  return null;
}

/** ADR-0125 §3's three buckets, keyed on the only input the spec allows. */
function expansionBucketOf(
  name: string
): "secret" | "whitelist" | "unknown" {
  if (SECRET_NAME_PATTERN.test(name)) return "secret";
  if (BASE_ENV_NAMES.includes(name)) return "whitelist";
  return "unknown";
}

/**
 * True when one site is only the WRAPPER of another. Stage 0 publishes
 * `$(( … ))` as a name-less site whose span holds the site of every name the
 * arithmetic really expands, so re-judging the wrapper would ask twice about one
 * expansion the payload already names. The comparison is between two payload
 * fields' own spans: no text is sliced, nothing is re-parsed, and a name-less
 * site that hides no other site is still reported.
 */
function wrapsAnotherExpansion(
  entry: ExpansionFact,
  all: readonly ExpansionFact[]
): boolean {
  return all.some(
    (other) =>
      other !== entry &&
      other.span.start >= entry.span.start &&
      other.span.end <= entry.span.end &&
      (other.span.start > entry.span.start || other.span.end < entry.span.end)
  );
}

/**
 * The `${name}` sites of one parse, judged by name alone (Assumption 4): a
 * secret name is the deny that names the sanctioned channel, a base-environment
 * name is silence, anything else — including a site Stage 0 modeled without a
 * name — is the ask tier's `param-unknown`. Re-deriving a name by slicing the
 * site's own text is SC7's ban: bash's spelling rules are Stage 0's job, and a
 * wall that re-reads them grows its own parser.
 */
function scanExpansions(
  prepared: PreparedParse,
  asks: SubstitutionAsk[]
): WalkStep {
  for (const entry of prepared.expansions) {
    if (entry.name === null) {
      if (wrapsAnotherExpansion(entry, prepared.expansions)) continue;
      asks.push({ kind: "param-unknown", detail: "param=none" });
      continue;
    }
    const bucket = expansionBucketOf(entry.name);
    if (bucket === "secret") {
      return {
        kind: "hit",
        hit: { id: "parameter-expansion", pattern: "param=secret" },
      };
    }
    if (bucket === "unknown") {
      asks.push({ kind: "param-unknown", detail: "param=unknown" });
    }
  }
  return CLEAN_STEP;
}

/**
 * ADR-0125 §4's combo wall: an interpreter handed a `<(...)` reads bytes that
 * only become code at run time, so recursion could at best surface the inner
 * command while the generated content stays invisible — the deny is the
 * receiver's, whatever the inner holds. The write side (`>(...)`) feeds a
 * command that is already parsed, so it never combos (Assumption 5); a null
 * owner index names no receiver, and then nothing combos either.
 */
function comboHitFor(
  prepared: PreparedParse,
  site: SubstitutionFact
): DangerousPatternHit | null {
  if (site.kind !== "procsub-in") return null;
  const ownerIndex = site.ownerCommandIndex;
  if (!isFiniteNumber(ownerIndex)) return null;
  const owner = prepared.byIndex.get(ownerIndex);
  if (owner === undefined) return null;
  const name = nameOfWord(owner.argv[0]);
  if (name === undefined || !INTERPRETER_COMMAND_NAMES.has(name)) return null;
  return { id: "interpreter-procsub", pattern: `combo=${name}-procsub` };
}

function walkSites(
  prepared: PreparedParse,
  sites: readonly SubstitutionFact[],
  level: number,
  visited: Set<number>,
  asks: SubstitutionAsk[]
): WalkStep {
  for (const site of sites) {
    const step = walkSite(prepared, site, level, visited, asks);
    if (step.kind !== "clean") return step;
  }
  return CLEAN_STEP;
}

/**
 * Judge one substitution site at `level`: the combo wall first, because that
 * denial belongs to the receiver and does not care what the inner holds; then
 * the inner command's own text, then the sites nested inside that command. Deny
 * propagates upward; sites beyond the ceiling become an ask, never a deny.
 */
function walkSite(
  prepared: PreparedParse,
  site: SubstitutionFact,
  level: number,
  visited: Set<number>,
  asks: SubstitutionAsk[]
): WalkStep {
  const combo = comboHitFor(prepared, site);
  if (combo !== null) return { kind: "hit", hit: combo };
  const inner = site.innerCommandIndex;
  if (inner === null) return CLEAN_STEP;
  const command = prepared.byIndex.get(inner);
  if (command === undefined) {
    return {
      kind: "fault",
      reason: `innerCommandIndex ${String(inner)} vanished from the parse`,
    };
  }
  if (visited.has(inner)) return CLEAN_STEP;
  visited.add(inner);
  const source = commandText(prepared.text, command);
  const own = scanCommandText(source);
  if (own !== null) {
    return {
      kind: "hit",
      hit: {
        id: "command-substitution",
        pattern: `subst=${String(site.kind)}→${own.id}`,
      },
    };
  }
  const nested = prepared.children.get(inner) ?? [];
  if (nested.length === 0) return CLEAN_STEP;
  if (level + 1 > MAX_SUBSTITUTION_LEVEL) {
    asks.push({
      kind: "substitution-depth-exceeded",
      detail: `depth=${level + 1}`,
      inner: source,
    });
    return CLEAN_STEP;
  }
  return walkSites(prepared, nested, level + 1, visited, asks);
}

/**
 * Judge one parse at nesting `level`: its `${name}` sites by name, then every
 * root site, then the bodies of the heredocs it receives. Deny propagates
 * upward; an inner command whose own verdict could only be an ask never becomes
 * a wall deny (Assumption 1). `visited` is per parse — the indexes of a
 * re-parsed body count from zero again, and the strictly shrinking text of a
 * body ends every descent.
 */
function walkPrepared(
  prepared: PreparedParse,
  level: number,
  asks: SubstitutionAsk[]
): WalkStep {
  const names = scanExpansions(prepared, asks);
  if (names.kind !== "clean") return names;
  const step = walkSites(
    prepared,
    prepared.roots,
    level,
    new Set<number>(),
    asks
  );
  if (step.kind !== "clean") return step;
  for (const body of prepared.bodies) {
    if (level + 1 > MAX_SUBSTITUTION_LEVEL) {
      asks.push({
        kind: "substitution-depth-exceeded",
        detail: `depth=${level + 1}`,
      });
      continue;
    }
    const bodyStep = walkBody(body, level + 1, asks);
    if (bodyStep.kind !== "clean") return bodyStep;
  }
  return CLEAN_STEP;
}

/**
 * Judge one heredoc body. The receiver already decided what the text is: a code
 * body is re-parsed through the same public entry and routed by that sub-parse's
 * own verdict (Assumption 6) — resolvable text is judged, unresolvable text is
 * denied with the verdict named, ask-parity text asks — while the body of a text
 * command that bash never expands stays data. A live body of a non-interpreter
 * receiver keeps the narrower reading this stage inherited: bash expands it, so
 * its substitution sites are judged, and its command words remain the substring
 * scan's business until the AST migration retires that.
 */
function walkBody(
  body: HeredocBody,
  level: number,
  asks: SubstitutionAsk[]
): WalkStep {
  const parsed = parseForSecurity(body.text);
  if (parsed.kind === "unknown-syntax") {
    asks.push(unknownSyntaxAsk(parsed));
    return CLEAN_STEP;
  }
  if (parsed.kind === "ok") {
    const preparedBody = preparePayload(parsed, asks);
    if (!preparedBody.ok) {
      return { kind: "fault", reason: preparedBody.reason };
    }
    const walkStep = walkPrepared(preparedBody.prepared, level, asks);
    if (walkStep.kind !== "clean") return walkStep;
    return body.isCode ? scanBodyCommands(preparedBody.prepared) : CLEAN_STEP;
  }
  if (!body.isCode) return CLEAN_STEP;
  if (parsed.kind === "parser-unavailable") {
    // The outer text reached a parser and its body did not: no declared shape
    // produces that, so the walk reports the fault as a value (SC19).
    return {
      kind: "fault",
      reason: "a heredoc body had no parser to read it",
    };
  }
  const routed = routeParseVerdict(parsed);
  if (routed === null) return CLEAN_STEP;
  return { kind: "hit", hit: routed };
}

/**
 * The other half of "the body is code": every command of the body sub-parse runs
 * through the same inner-command rule as a substituted command. The hit is that
 * command's own record, verbatim — SC11's `pattern=` mini-grammar has no heredoc
 * token, and a body line `rm -rf /` must read as `destructive-rm` here exactly
 * as it does at the top level.
 */
function scanBodyCommands(prepared: PreparedParse): WalkStep {
  for (const command of prepared.byIndex.values()) {
    const source = commandText(prepared.text, command);
    if (source.length === 0) continue;
    const hit = scanCommandText(source);
    if (hit !== null) return { kind: "hit", hit };
  }
  return CLEAN_STEP;
}

/**
 * ADR-0124 §2's state 2 rendered for the ask tier: the `unmodelled[]` inventory
 * as SC11's token, plus that ADR's own human text, so an operator who has never
 * heard of node types still sees why the command is not being judged.
 */
function unknownSyntaxAsk(
  payload: SecurityParseUnknownSyntax
): SubstitutionAsk {
  const nodes = Array.isArray(payload.unmodelled)
    ? payload.unmodelled.join(",")
    : "";
  return {
    kind: "unknown-syntax",
    detail: `unknown-syntax=${nodes}（含未识别语法结构）`,
  };
}

/** The parse verdicts step 1 folds into `unparseable`; none of them is a story
 *  the ask tier tells, because no command survives them. */
type HardDenyParseResult = Extract<
  SecurityParseResult,
  { kind: "malformed" | "aborted" | "over-cap" | "vetoed" }
>;

function isHardDenyVerdict(
  result: SecurityParseResult
): result is HardDenyParseResult {
  return routeParseVerdict(result) !== null;
}

/**
 * The ask channel's entry point: the substitution-shaped asks of one raw
 * command (`param-unknown`, `substitution-depth-exceeded`, `unknown-syntax`,
 * `receiver-unresolvable`). An `inner-ask` is not constructible here — this
 * module sees no rules, no mode and no category — so the caller that owns those
 * builds it. Total over every string, like the walk it delegates to: it never
 * throws, and it never reports an ask inferred from a region it could not
 * analyze. The verdicts step 1 hard-denies answer with an empty list because
 * nothing reaches the tier below them; `parser-unavailable` answers the same
 * way, because the degrade path has no `ok` payload to read (ADR-0124 §4 keeps
 * `unknown-syntax` out of that set: it is this tier's, never a deny).
 */
export function findSubstitutionAsk(
  command: string
): readonly SubstitutionAsk[] {
  if (command.length === 0) return [];
  const result = parseForSecurity(command);
  if (result.kind === "parser-unavailable") return [];
  if (isHardDenyVerdict(result)) return [];
  const analysis = analyzeSubstitutions(result);
  if (analysis.verdict !== "ask") return [];
  return analysis.asks;
}

/**
 * ADR-0125's recursion over one parse: every substitution site's inner command
 * runs through the same text rules as the outer one, nested to
 * `MAX_SUBSTITUTION_LEVEL` sites, and a body that is code is re-parsed through
 * this same entry rather than walked line by line. Total by construction: an
 * impossible shape returns `analysis-fault` as a value, and nothing here may
 * throw — no caller wraps this predicate (ADR-0124 state 4's taste).
 */
export function analyzeSubstitutions(
  payload: SecurityParseOk | SecurityParseUnknownSyntax
): SubstitutionAnalysis {
  const asks: SubstitutionAsk[] = [];
  try {
    if (payload.kind === "unknown-syntax") {
      return { verdict: "ask", asks: [unknownSyntaxAsk(payload)] };
    }
    const prepared = preparePayload(payload, asks);
    if (!prepared.ok) {
      return { verdict: "analysis-fault", reason: prepared.reason };
    }
    const step = walkPrepared(prepared.prepared, 1, asks);
    if (step.kind === "fault") {
      return { verdict: "analysis-fault", reason: step.reason };
    }
    if (step.kind === "hit") return { verdict: "denied", hit: step.hit };
    return { verdict: "ask", asks };
  } catch (fault) {
    const name = fault instanceof Error ? fault.name || "Error" : typeof fault;
    return {
      verdict: "analysis-fault",
      reason: `替换分析异常（${String(name)}），硬拒该条命令`,
    };
  }
}

/**
 * Single-character bare operators the wall treats as separator noise. SSOT
 * for both the raw-string scan below and the operator-lead check in
 * `segmentHasCommandWord`, so the two views cannot drift. (`&&` / `||` need
 * no entry: the scan is substring-based, so `&` / `|` already cover them.)
 */
const BARE_METACHAR_CHARS: readonly string[] = Object.freeze([
  "|",
  ";",
  ">",
  "<",
  "&",
]);

/** A token that begins (after optional fd digits) with a bare operator. */
const OPERATOR_LEAD_PATTERN = new RegExp(
  `^[0-9]*[${BARE_METACHAR_CHARS.join("")}]`
);

/**
 * True when a segment's first command-bearing token names a command —
 * anything that is not operator / redirect punctuation. Group punctuation
 * glued to a word (`(echo`, `{echo`) or standing alone (`(`, `{`) is
 * transparent: the scan moves to the next token. A leading fd digit (`2>`)
 * or a glued redirect target (`>/tmp/x`) is still an operator spelling: no
 * command has started. A token with no alphanumerics at all (`:(){`) cannot
 * name a command either, which keeps the fork-bomb body in front of the
 * bare-metachar branch.
 */
function segmentHasCommandWord(segment: string): boolean {
  for (const raw of segmentTokens(segment)) {
    const token = raw.replace(/\\/g, "");
    if (/^[(){}\[\]]+$/.test(token)) continue;
    if (!/[A-Za-z0-9]/.test(token)) return false;
    return !OPERATOR_LEAD_PATTERN.test(token);
  }
  return false;
}

/**
 * Bare-metachar detector. Returns the first bare separator / redirect /
 * pipe / background operator that appears in `command`, or null. Used only
 * when the command is purely metachar(s) — `;`, `&&`, `|`, ... on their own
 * or every produced segment lacking a command word (see
 * `segmentHasCommandWord`): there is no executable body, so the only
 * intent on screen is separator noise.
 */
function matchBareMetachar(command: string): DangerousPatternHit | null {
  for (const bare of BARE_METACHAR_CHARS) {
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
 * `findDangerousPattern` — by the parse on the primary path, by the
 * quote-blind scan on the degrade path.
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
// `echo $HOME`) is safe and must be allowed. What an expansion can hide is no
// longer answered here either — `findDangerousPattern` judges each site from the
// parse (the `${name}` buckets, the recursion into `$(...)`), and this gate only
// keeps the redirect exemption narrow. Subshell parens `(`/`)` still reject
// `$(...)` at this level.
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
    const reason = `dangerous command pattern matched (id=${hit.id}, pattern="${hit.pattern}")`;
    // SC3's wrapper stays byte-identical; only the secret-name bucket gets a
    // clause after it, because that denial has a right answer the model can
    // still act on: ADR-0125 §3 names the placeholder round-trip as the one
    // sanctioned way to carry a secret value through a command.
    return hit.id === "parameter-expansion" && hit.pattern === "param=secret"
      ? `${reason} — to use the value, reference it as <<<SECRET_N>>> (the placeholder round-trip) instead of naming the variable`
      : reason;
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
