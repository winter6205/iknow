import type { HardRuleSpec } from "./types.js";
import type {
  SecurityReviewCause,
  SecurityReviewRequirement,
} from "./security-review.js";
import { VIOLATION_PREFIXES } from "./prefixes.js";
import {
  parseForSecurity,
  scanWithLegacyDegrade,
  type CommandFact,
  type ExpansionFact,
  type FactSpan,
  type HeredocFact,
  type InertFact,
  type SecurityParseOk,
  type SecurityParseResult,
  type SecurityParseUnknownSyntax,
  type SubstitutionFact,
  type WordFact,
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
 * Two denies the roster and a structural/text rule BOTH state, so each is one
 * frozen object rather than a literal at two sites: a rule that reconstructs
 * either one can drift its id or its spelling without touching the roster, and
 * the `pattern=` desc is what an operator reads (SC-GATES-6).
 */
const FORMAT_GATE_HIT: DangerousPatternHit = Object.freeze({
  id: "destructive-disk",
  pattern: "format",
});

const FORK_BOMB_HIT: DangerousPatternHit = Object.freeze({
  id: "destructive-disk",
  pattern: ":(){ :|:& };:",
});

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
    FORK_BOMB_HIT,
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
  tokens: ReadonlyArray<string>,
  extraWrappers?: ReadonlySet<string>
): { name: string; index: number } | undefined {
  let i = 0;
  let wrapper: string | undefined;
  while (i < tokens.length) {
    const bare = stripQuoteLayer(tokens[i]!.replace(/\\/g, "")).toLowerCase();
    if (
      FIND_WRAPPER_TOKENS.has(bare) ||
      (extraWrappers !== undefined && extraWrappers.has(bare))
    ) {
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
 * True when a `find` command's token run walks the whole machine. Restated
 * invariant (T4 acceptance): `find <root> …` never spawns when `<root>` denotes
 * the filesystem root — with or without predicates such as `-maxdepth N`; the
 * wall does not wait for a predicate to appear, because the walk is the thing
 * being denied, not its output shape. Roots that are NOT this wall: `.` /
 * `..` / relative paths / `/tmp` and any other non-root absolute path —
 * scoping the tree is the reader's job (ADR-0068; the 300 s bash
 * `timeoutTier: build` is not the control).
 *
 * Whole-command form: `cd / && find .` is the same whole-machine walk with the
 * root hidden in the `cd`, so the caller passes the `cd`-aware decision in. A
 * `cd /` followed by a NON-`find` command is out of this wall's scope (the
 * walk's repository is what is hard-walled, not `cd` itself).
 *
 * Bare `find` with no path operand walks the shell cwd (GNU find; the
 * options-first spelling `find -name x` included), so it is denied exactly
 * when that cwd is the filesystem root. The near-miss `find /tmp -maxdepth N`
 * is NOT denied — the readonly find-flag table answers for it, same as any
 * other non-root walk.
 */
function isRootFindTokens(
  tokens: ReadonlyArray<string>,
  cwd: string | undefined,
  wordsIncomplete: boolean
): boolean {
  const command = commandAt(tokens);
  // EXIT: not a find segment — the wall does not speak about other commands.
  if (command === undefined || command.name !== "find") return false;
  const operands = commandOperands(tokens, command.index);
  // No path operand: find walks the shell cwd, which is the filesystem root
  // only when a preceding segment moved there (`cd / && find`).
  if (operands.length === 0) {
    // EXIT: a run that lost words on the way here (a redirect, see
    // `RootFindRun`) cannot be proven bare from argv, so the cwd rule stays
    // unapplied and the shape keeps today's answer.
    if (wordsIncomplete) return false;
    return cwd === "/";
  }
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
 * The cwd state a `cd` command moves to, or `null` when the token run is not a
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
function applyCd(
  tokens: ReadonlyArray<string>,
  state: CwdState
): CwdState | null {
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
 *
 * This is the SEGMENT carrier: it answers wherever the tree cannot speak (the
 * degrade path, the non-`ok` arms) and `matchRootFindWalkOnParse` answers for
 * an `ok` parse. Both drive the same fold (`foldRootFind`), so a shape cannot
 * be judged by two different cwds depending on which carrier reached it.
 */
function matchRootFindWalk(
  segments: ReadonlyArray<string>
): DangerousPatternHit | null {
  return foldRootFind(segments.map(segmentRun));
}

/** One splitter segment as a fold run — its full written form is the segment. */
function segmentRun(segment: string): RootFindRun {
  return { tokens: segmentTokens(segment), wordsIncomplete: false };
}

/**
 * One position of the ordered fold: a command's token run, plus whether those
 * words are the command's whole written form.
 *
 * `wordsIncomplete` is set only by the tree carrier. A redirect is a word of the
 * command as bash runs it but not a `WordFact`, so a node like
 * `cd / && find > /dev/null` reaches the fold as the bare one-word run `find`,
 * which the empty-operand rule below would read as "bare `find` at the cwd" and
 * deny. Today's run carries the `>` and its target as ordinary tokens, and the
 * first of them — never a root — ends the search-root run, so today's answer is
 * allow. The flag suppresses the empty-operand rule for such a run and nothing
 * else: a run that spells its roots out (`cd / && find . > /`) is still judged
 * on its operands exactly as the text path judges it.
 */
interface RootFindRun {
  readonly tokens: ReadonlyArray<string>;
  readonly wordsIncomplete: boolean;
}

/**
 * The fold itself, over the ordered token runs of a command sequence: each run
 * moves the cwd (a `cd`) or is judged (a `find`), and the first root walk ends
 * the scan — a later segment cannot rescue the intent, and no segment can
 * un-set a cwd the shell already moved.
 */
function foldRootFind(runs: Iterable<RootFindRun>): DangerousPatternHit | null {
  let state: CwdState = { cwd: undefined, oldpwd: undefined };
  for (const run of runs) {
    const moved = applyCd(run.tokens, state);
    if (moved !== null) state = moved;
    if (isRootFindTokens(run.tokens, state.cwd, run.wordsIncomplete)) {
      // EXIT: reject on the first root-walk find — the whole-machine walk is
      // the intent being denied, so no later segment can rescue the command.
      return { id: "root-find-walk", pattern: "find" };
    }
  }
  return null;
}

/**
 * The anonymous node type bash's pipeline negation renders as. Its `!` is a
 * token Stage 0 counts in `nodeTypes` but publishes in no `argv` and attaches
 * to no span, so the tree cannot tell the fold which node a negation led — and
 * `! cd / && find .` is exactly the shape where guessing "the node after the
 * `!`" would move today's answer.
 */
const NEGATED_COMMAND_NODE = "negated_command";

/**
 * The token `&` that runs a command in the background. Like the negation mark it
 * is a counted token with no word fact and no span anyone can attribute, and its
 * whole effect is invisible to the tree: `cd / & find .` executes the `cd` in a
 * subshell, so the `find` still walks the ORIGINAL cwd, while an ordered read of
 * the two nodes would arm a root walk the shell never performs. Handing the
 * shape back to the splitter keeps today's allow — the splitter cannot act on a
 * backgrounded `cd` either, which is why the shape is allowed at all.
 */
const BACKGROUND_LEAD = "&";

/**
 * The token run one command node contributes to the fold: its argv words in
 * source order, raw text (quote layer included, backslashes unescaped) exactly
 * as the segment carrier read them, so `commandAt`'s wrapper fold and
 * `commandOperands`' "paths must precede expression" run apply unchanged.
 *
 * `undefined` abstains, and the abstain arm is one fact: something other than
 * this node's command word leads the node's own span, so the segment scan named
 * a different command there and never judged this one — `X=1 find /` (a prefix
 * `variable_assignment`, which is not argv) and `2>/dev/null find /` (a redirect
 * hung in front of the word). Stage 3 moves the CARRIER, not the answer: both
 * shapes are allowed today and stay allowed here, pinned in
 * `tests/harness/permission/root-find-hard-wall.test.ts`; closing them is a
 * trigger-semantics flip this stage is not licensed to make (SC-GATES-3 admits
 * no new deny from a carrier move).
 */
function commandTokenRun(
  cmd: CommandFact,
  wordsIncomplete: boolean
): RootFindRun | undefined {
  const lead = cmd.argv[0];
  if (lead === undefined) return undefined;
  if (lead.span.start !== cmd.span.start) return undefined;
  return { tokens: cmd.argv.map(wordSource), wordsIncomplete };
}

/**
 * SC-S3-2's parsed-path carrier: the same ordered fold driven by the parse's
 * command nodes instead of the splitter's segments.
 *
 * Reach is `depth === 0` — the nodes one shell script runs in sequence, which is
 * the population the segment carrier could actually name. A node inside a
 * `$( … )` body, a subshell or a `{ …; }` group stays out of the fold's order,
 * because the segment scan never reached it either: `cd / && (find .)` and
 * `cd / && echo $(find .)` are allowed today, and reading the nested node here
 * would arm a walk the wall does not claim (a widening, not a re-labelling).
 *
 * Heredoc bodies are spliced in at their own offset, in source order, on the
 * segment carrier: Stage 0 records a body's span but parses no nodes inside it
 * (it is another program's source), and the fold has always read those lines.
 * Dropping them would let a real `cd /` followed by `find .` execute as shell
 * code through — a relaxation no arm of the floor licenses, since the receiver's
 * inertness is exactly what the wall's own comment says it cannot judge.
 *
 * Two trees hand the whole string back to the splitter: one carrying a negation
 * (see `NEGATED_COMMAND_NODE`) and one carrying a background `&` (see
 * `BACKGROUND_LEAD`). Both are counted tokens that reach no word fact and no
 * attributable span, so a node-level read would have to guess which node the
 * mark led — and for each shape there is a guess that moves today's answer.
 */
function matchRootFindWalkOnParse(
  parse: SecurityParseOk
): DangerousPatternHit | null {
  if (
    (parse.nodeTypes[NEGATED_COMMAND_NODE] ?? 0) > 0 ||
    (parse.nodeTypes[BACKGROUND_LEAD] ?? 0) > 0
  ) {
    return matchRootFindWalk(splitForDangerousScan(parse.text));
  }
  const ordered = rootFindRunsInSourceOrder(parse);
  ordered.sort((left, right) => left.start - right.start);
  return foldRootFind(ordered.map((entry) => entry.run));
}

/** The commands whose own span ends before a redirect they own begins. */
function trailingRedirectOwners(parse: SecurityParseOk): Set<number> {
  const owners = new Set<number>();
  for (const redirect of parse.redirects) {
    const owner = redirect.ownerCommandIndex;
    if (owner !== null && redirect.span.start >= parse.commands[owner]?.span.end) {
      owners.add(owner);
    }
  }
  return owners;
}

/** Depth-0 command runs plus heredoc-body segment runs, unsorted. */
function rootFindRunsInSourceOrder(
  parse: SecurityParseOk
): Array<{ start: number; run: RootFindRun }> {
  const trailing = trailingRedirectOwners(parse);
  const ordered: Array<{ start: number; run: RootFindRun }> = [];
  for (const cmd of parse.commands) {
    if (cmd.depth > 0) continue;
    const run = commandTokenRun(cmd, trailing.has(cmd.index));
    if (run === undefined) continue;
    ordered.push({ start: cmd.span.start, run });
  }
  for (const body of parse.heredocs) {
    const text = parse.text.slice(body.bodySpan.start, body.bodySpan.end);
    for (const segment of splitForDangerousScan(text)) {
      ordered.push({ start: body.bodySpan.start, run: segmentRun(segment) });
    }
  }
  return ordered;
}

/**
 * The normalize the substring roster and the lexical `format` gate share, and
 * the reason both see `fo\rmat` as `format` (bash joins an escaped word) and
 * `rm  -rf` as one literal. Deliberately NOT `scanFold`: that one keeps
 * newlines, because the splitter turns them into separate segments.
 */
function segmentScanFold(raw: string): string {
  return raw.toLowerCase().replace(/\\/g, "").replace(/\s+/g, " ");
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
  const lower = segmentScanFold(segment);
  for (const entry of DANGEROUS_COMMAND_PATTERNS) {
    if (lower.includes(entry.pattern)) return entry;
  }
  // Lexical `format` command (ADR-0068: no substring matching).
  // Fed the SAME normalized segment as the substring scan: the backslash
  // strip exists to defeat escape attempts (`fo\rmat` → `format` in bash),
  // so the lexical gate must not be bypassed by the same escape
  // (`isLexicalFormatCommand(raw)` saw firstToken `rmat` and let it through).
  if (isLexicalFormatCommand(lower)) {
    return FORMAT_GATE_HIT;
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
 * substitution needles that the primary path no longer reads. Two production
 * readers: the degrade seam's degrade path, and the divergence report's
 * historical column, which has to keep measuring the old scanner.
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
 *   - The destructive rules of an `ok` parse are judged off the tree: command
 *     words, declared code operands, and the heredoc bodies the receiver rule
 *     keeps — after the root-find fold, which still owns `find /`. The lexical
 *     `format` gate still reads the text there (its carrier is the splitter,
 *     not a node); the bare-metachar branch is driven by the tree — on the
 *     parsed path the id fires only for a zero-command-node body gated by the
 *     pure-body scan (see `findDestructiveAfterParse`).
 *   - Each segment is independently normalized (lowercase, backslash strip,
 *     whitespace collapse) and scanned against `DANGEROUS_COMMAND_PATTERNS`.
 *     That scan is quote-blind, and it stays the whole answer wherever the parse
 *     cannot speak for the shape: unmodelled syntax and the degrade path.
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
    const substitution = substitutionHit(result);
    if (substitution !== null) return substitution;
    // `ask` is not this layer's channel: it falls through to the destructive
    // rules and the mode / category default, which is where an ask is emitted.
  }

  if (result.kind === "ok") return findDestructiveAfterParse(command, result);

  // An unmodelled node means the tree cannot speak for the shape at all, so this
  // arm keeps the text rules whole: narrowing them here would turn a
  // today-deny into an allow, which no arm of the parse verdict contract buys.
  return findTextDangerPattern(command);
}

/**
 * The substitution family's answer for a parse the tree can speak about: a hit
 * to deny with, or `null` to fall through. `analysis-fault` is a contradiction
 * inside this wall's own reading of a tree it was told is `ok`, so it reports
 * through the same `unparseable` id the verdict routing uses rather than
 * pretending the substitution roster answered.
 */
function substitutionHit(
  payload: SecurityParseOk | SecurityParseUnknownSyntax
): DangerousPatternHit | null {
  const analysis = analyzeSubstitutions(payload);
  if (analysis.verdict === "denied") return analysis.hit;
  if (analysis.verdict === "analysis-fault") {
    return { id: "unparseable", pattern: "verdict=analysis-fault" };
  }
  return null;
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

// --- Stage-2 destructive walls on the parsed tree (SC-S2-8 / SC-S2-9) -------
//
// These rules judge a command node by its command WORD (wrapper-folded, and
// un-quoted for the name test only), never by a substring of the whole command.
// That is what lets a dangerous literal sitting in an `echo`/`grep` operand or
// in quoted / comment / data-heredoc text stop denying (SC-S2-1) while a real
// destructive argv, an execution carrier's operand run, and a code-consuming
// name's code operand all still deny. Every literal read below is a literal the
// whole-command substring scan read, and it is read inside one node, so nothing
// here can deny a shape that scan let through. The fork bomb is the one entry
// read differently and it goes the other way: `SUBSTRING_ROSTER` drops it from
// these arms because the scan never denied a bomb sitting inside
// `bash -c '…'`, and only the structural rule (SC-S2-8) answers for it — the
// `(id, pattern)` pair that rule renders is the authorized move. The quote-blind
// text scan (`scanSegment`, `legacyFindDangerousPattern`) stays the
// parser-unavailable answer at full strength (SC-GATES-4) and the answer of
// every non-`ok` arm of the parse.

const SHELL_NAME_POWERSHELL = "powershell";
const SHELL_NAME_PWSH = "pwsh";
const SHELL_NAME_CMD = "cmd";

/**
 * Windows shells that eat a command string as another program's source. NOT
 * Stage-1's interpreter roster (that answers "does this consume generated
 * code?"); this trio answers "does this read its operand as a shell script".
 * The two lists are unioned only for the declared-code-operand test below, and
 * each keeps its own single definition (SC-S2-9).
 */
const SHELL_FAMILY_ROSTER: ReadonlySet<string> = Object.freeze(
  new Set([SHELL_NAME_POWERSHELL, SHELL_NAME_PWSH, SHELL_NAME_CMD])
);

/**
 * `builtin` runs its operand unchanged, so this family must see past it. It is
 * folded here and not in `FIND_WRAPPER_TOKENS` because that set is shared with
 * the root-find walk, whose answer for `cd / && builtin find .` would move with
 * it — a wall this stage does not own.
 */
const DESTRUCTIVE_EXTRA_WRAPPERS: ReadonlySet<string> = Object.freeze(
  new Set(["builtin"])
);

/**
 * The folded command word of one node, for EVERY arm of this family: the
 * command-word rule, the declared-code-operand rule, the heredoc receiver and
 * the sensitive path's blanking test. Folding in one arm and not another is a
 * bypass rather than a difference of opinion — `builtin bash -c 'rm -rf /'` is
 * the same command to bash as `bash -c 'rm -rf /'`, and an arm that reads the
 * first word only sees `builtin`, names nothing that eats code, and allows.
 */
function destructiveCommandAt(
  cmd: CommandFact
): { name: string; index: number } | undefined {
  return commandAt(cmd.argv.map(wordSource), DESTRUCTIVE_EXTRA_WRAPPERS);
}

/**
 * The same fold read one word at a time, for the walk that must stop at the
 * first word able to BE the command rather than skipping to it.
 */
function isDestructiveWrapper(name: string): boolean {
  return FIND_WRAPPER_TOKENS.has(name) || DESTRUCTIVE_EXTRA_WRAPPERS.has(name);
}

/** Command words whose OWN argv can carry a destructive roster literal. */
const DESTRUCTIVE_COMMAND_WORDS: ReadonlySet<string> = Object.freeze(
  new Set([
    "rm",
    "rmdir",
    "remove-item",
    "chmod",
    "find",
    "dd",
    "shutdown",
    "reboot",
    "del",
    "rd",
  ])
);

function wordSource(word: WordFact): string {
  return word.text;
}

/**
 * The scan form the roster rules read: the segment normalization (lowercase,
 * backslash fold, blank collapse) with one difference kept on purpose —
 * newlines are NOT collapsed, because the text scan splits them into separate
 * segments, so `rm -r<NL>f` is a literal the old scanner never joined and no
 * rule here may join either.
 */
function scanFold(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\\/g, "")
    .replace(/[ \t]+/g, " ")
    .trim();
}

/**
 * Raw word source, never `WordFact.value`: `value` erases the quote layer, and
 * a join over it can synthesize a roster literal (`rm "-rf"`) the text scan
 * never saw. Folded raw text keeps every join a substring of what that scan
 * reads, which is what makes "cannot newly deny" true rather than asserted.
 */
function rawFoldedWord(word: WordFact): string {
  return scanFold(wordSource(word));
}

/** The roster's scan form for the words a rule judges, joined in source order. */
function argvScanText(words: readonly WordFact[]): string {
  return words.map(rawFoldedWord).join(" ");
}

/**
 * The roster the parse-based arms read: every entry but the fork bomb. The bomb
 * is a structural rule (SC-S2-8) — `:(){ :|:& };:` means recursion only when a
 * `function_definition` pipes its own body back to itself — and the quote-blind
 * scan never matched it in an operand or a body, because there the words sit
 * inside a quoted string whose only command word is `bash` or `python3`, so the
 * metachar rule that used to catch it abstained. Matching it by substring here
 * would newly deny shapes the pre-migration wall let through, which no arm of
 * the floor licenses from this direction.
 */
const SUBSTRING_ROSTER: readonly DangerousPatternHit[] = Object.freeze(
  DANGEROUS_COMMAND_PATTERNS.filter(
    (entry) => entry.pattern !== FORK_BOMB_HIT.pattern
  )
);

/** The substring roster, run over text already in scan form. */
function rosterHit(text: string): DangerousPatternHit | null {
  for (const entry of SUBSTRING_ROSTER) {
    if (text.includes(entry.pattern)) return entry;
  }
  return null;
}

function isDestructiveWord(name: string): boolean {
  return name.startsWith("mkfs") || DESTRUCTIVE_COMMAND_WORDS.has(name);
}

/**
 * SC-S2-8's command-word rule for one node: reconstruct the node's argv text and
 * run the unchanged roster over it, but only when the command word names a
 * destructive program. A non-destructive command word (`echo`, `grep`) never
 * reaches the roster, which is exactly the operand-scope relaxation SC-S2-1's
 * third flip class asks for. `format` is absent on purpose — it is the lexical
 * gate of `lexicalFormatHit`, whose carrier is the segment, not the node.
 */
function commandWordDestructiveHit(
  cmd: CommandFact
): DangerousPatternHit | null {
  const at = destructiveCommandAt(cmd);
  if (at === undefined) return null;
  if (!isDestructiveWord(at.name)) return null;
  return rosterHit(argvScanText(cmd.argv.slice(at.index)));
}

/**
 * The two rosters unioned, for the one question they answer together: which
 * command names eat a string as another program's source. Computed here and
 * never by editing either list, so each keeps its own single owner and its own
 * narrower question.
 */
const CODE_CONSUMING_COMMAND_NAMES: ReadonlySet<string> = Object.freeze(
  new Set([...INTERPRETER_COMMAND_NAMES, ...SHELL_FAMILY_ROSTER])
);

/**
 * SC-S2-9's declared-code-operand arm: everything after a code-consuming name is
 * source that name hands on, so the WHOLE word run is judged. Selecting one
 * operand by a per-name flag map loses the payload whenever an unmapped word
 * comes first (`--login`, `build.sh`, `-MPOSIX`), and every loss is a deny
 * turned into an allow; the run contains each operand any selection could have
 * picked and stays inside the node's own text, so it cannot deny past the scan.
 */
function codeOperandDestructiveHit(
  cmd: CommandFact
): DangerousPatternHit | null {
  const at = destructiveCommandAt(cmd);
  if (at === undefined) return null;
  if (!CODE_CONSUMING_COMMAND_NAMES.has(at.name)) return null;
  return rosterHit(argvScanText(cmd.argv.slice(at.index + 1)));
}

/**
 * Names that run what they are handed somewhere other than in this shell: `ssh`
 * and `su` hand the operand to a shell on the far side or under the other uid,
 * `docker`/`podman`/`kubectl exec` spawn it, `watch`, `parallel` and `xargs`
 * build a command out of it. Their operand is not data in the sense of
 * SC-S2-1's third flip class — `grep rm -rf /x` discards the words, `ssh host
 * rm -rf /x` runs them — so the operand run is judged exactly as the quote-blind
 * scan judged it.
 */
const EXECUTION_CARRIER_NAMES: ReadonlySet<string> = Object.freeze(
  new Set([
    "ssh",
    "su",
    "docker",
    "podman",
    "kubectl",
    "watch",
    "parallel",
    "xargs",
  ])
);

/**
 * Every name that runs or stores exactly what it is handed without being an
 * interpreter: the four this shell does itself (`eval` re-executes its operand,
 * `trap` and `alias` store it for later, `env` execs it) plus the execution
 * carriers above. The question is "does this word execute or store what it is
 * handed?", which neither the interpreter roster (generated code) nor the
 * destructive words (their own argv) answers. Every shape it catches already
 * denied under the quote-blind scan, so the set holds the floor rather than
 * widening policy.
 */
const EXECUTES_OR_STORES_OPERAND_NAMES: ReadonlySet<string> = Object.freeze(
  new Set(["eval", "trap", "alias", "env", ...EXECUTION_CARRIER_NAMES])
);

/**
 * The one owner of "does this word run or store the text it is handed?", as the
 * union of the two rosters above. The heredoc receiver of both walls asks it
 * whole; the two operand arms ask one half each because they anchor on different
 * words (`destructiveCommandAt` folds wrappers, `handedOperandNameIndex` walks
 * them). Answering the receiver question three ways is how `docker exec -i c sh
 * <<'EOF'` came to be code to one wall and data to the other.
 */
function runsWhatItIsHanded(name: string): boolean {
  return (
    CODE_CONSUMING_COMMAND_NAMES.has(name) ||
    EXECUTES_OR_STORES_OPERAND_NAMES.has(name)
  );
}

/**
 * SC-S2-9's positive inert-consumer roster. Membership is the ONE proof that a
 * command treats the text it is handed as data: every name here copies, prints,
 * compares, or lists its operand bytes and never interprets any of them as a
 * program (`echo`/`printf` write their operands to stdout, `cat`/`head` dump
 * file contents, `ls` lists, `test` compares, `grep` filters, `notify-send`
 * displays the literal as a notification body). Absence from this set is NOT
 * evidence of execution — `awk` (`system()` in its program operand) and
 * `chroot` (it execs its operand) sit outside precisely so their
 * security-relevant operands reach the Security review requirement instead of
 * either automatic class. One owner predicate, asked by both the destructive
 * and the sensitive-path wall, so a name cannot be data to one and code to the
 * other.
 */
const PROVEN_INERT_DATA_COMMAND_NAMES: ReadonlySet<string> = Object.freeze(
  new Set([
    "echo",
    "cat",
    "test",
    "head",
    "grep",
    "printf",
    "ls",
    "notify-send",
  ])
);

function provenInertDataConsumer(name: string): boolean {
  return PROVEN_INERT_DATA_COMMAND_NAMES.has(name);
}

/**
 * Names whose OWN argv the destructive arms already judge at full strength:
 * the destructive words (their argv is the deletion), the code consumers (the
 * declared-code-operand rule reads their operands), and the run-or-store names
 * (the handed-operand rule reads theirs). A node headed by one of these has no
 * ownership left to review — danger denied, absence of danger is enough.
 */
function operandOwnershipEstablished(name: string): boolean {
  return (
    isDestructiveWord(name) ||
    runsWhatItIsHanded(name) ||
    provenInertDataConsumer(name)
  );
}

/**
 * The index of such a name when everything before it is a transparent wrapper
 * (`sudo env -S "…"`), stopping at the first word that could itself be the
 * command — an `echo env "…"` operand is data, not a name in command position.
 * `commandAt` cannot answer this: a value-taking wrapper flag (`env -S`) eats
 * the payload as its own argument and folds past it.
 */
function handedOperandNameIndex(argv: readonly WordFact[]): number | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    const name = nameOfWord(argv[i]);
    if (name === undefined) return undefined;
    if (EXECUTES_OR_STORES_OPERAND_NAMES.has(name)) return i;
    if (!isDestructiveWrapper(name)) return undefined;
  }
  return undefined;
}

function handedOperandDestructiveHit(
  cmd: CommandFact
): DangerousPatternHit | null {
  const at = handedOperandNameIndex(cmd.argv);
  if (at === undefined) return null;
  return rosterHit(argvScanText(cmd.argv.slice(at + 1)));
}

/**
 * The heredoc arm of the same judgment. A body the receiver rule collects is
 * text the shell or the interpreter actually consumes, so the roster's substring
 * rule reads it exactly as the whole-command scan used to. The Windows shells
 * count as code receivers for this wall too, which the frozen interpreter roster
 * does not answer: a quoted `powershell <<'EOF'` body is a script, and dropping
 * it would newly allow text the quote-blind scan always read. The quoted body of
 * a plain text command stays data and never reaches here — that span is the
 * relaxation. A collection this file cannot resolve at all is the substitution
 * walk's `analysis-fault`, reported ahead of this path, and a body it can read
 * but cannot attribute to a node is judged by `foldedReceiverBodies` rather than
 * dropped.
 */
function heredocBodyDestructiveHit(
  parse: SecurityParseOk
): DangerousPatternHit | null {
  const collected = collectHeredocBodies(
    parse.text,
    parse.commands,
    parse.heredocs,
    SHELL_FAMILY_ROSTER
  );
  if (!collected.ok) return null;
  const bodies = collected.bodies.map((body) => body.text);
  bodies.push(...foldedReceiverBodies(parse));
  for (const body of bodies) {
    const hit = rosterHit(scanFold(body));
    if (hit !== null) return hit;
  }
  return null;
}

/**
 * The quoted bodies the collector drops because it names the receiver by its
 * FIRST word and by the frozen interpreter roster only: `sudo bash <<'EOF'`
 * reads as `sudo`, so its body is called data, while `sudo bash -c "…"` folds.
 * This arm asks the same question both walls ask — `receiverRunsOrStoresBody` —
 * and may re-read a body the collector already took, which costs one rescan of
 * already-judged text and nothing else.
 *
 * A quoted body whose receiver the parse cannot attribute at all is not judged
 * here either: SC-S2-9 prices a missing or ambiguous receiver as the Security
 * review requirement (`receiver-unresolved`), never as data and never as a
 * confident deny. After the receiver-attribution repair this population is the
 * genuinely unattributable one — a redirect hoisted onto a compound statement.
 * A receiver index that addresses no node is the parse contradicting its own
 * text, and stays judged here (the fail-closed arm this file has always had).
 */
function foldedReceiverBodies(parse: SecurityParseOk): string[] {
  const bodies: string[] = [];
  for (const heredoc of parse.heredocs) {
    if (!heredoc.delimiterQuoted) continue;
    if (heredoc.receiverCommandIndex === null) continue;
    const body = spanText(parse.text, heredoc.bodySpan);
    if (body === undefined) continue;
    const receiver = findCommand(parse.commands, heredoc.receiverCommandIndex);
    if (receiver === undefined || receiverRunsOrStoresBody(receiver)) {
      bodies.push(body);
    }
  }
  return bodies;
}

/**
 * A here-string body is an operand the receiver reads and is in none of the
 * relaxation classes, so it is judged receiver-blind: relaxing it for `cat`
 * would be new policy, and it cannot newly deny because the reach is one
 * command node's own text. The node rather than the target word, because an
 * unquoted body is one word and the payload continues in the argv after it —
 * `sh <<< rm -rf /tmp/x` is a body of `rm` plus an argv of `-rf /tmp/x`.
 */
function hereStringDestructiveHit(
  parse: SecurityParseOk
): DangerousPatternHit | null {
  for (const redirect of parse.redirects) {
    if (redirect.op !== "<<<") continue;
    const owner = findCommand(parse.commands, redirect.ownerCommandIndex);
    const judged =
      owner === undefined
        ? rawFoldedWord(redirect.target)
        : scanFold(commandText(parse.text, owner));
    const hit = rosterHit(judged);
    if (hit !== null) return hit;
  }
  return null;
}

/**
 * An escape inside a word is bash's own join, not data: `r\m` names the same
 * program as `rm` wherever it sits. So a node that carries one is judged over
 * its OWN span text — the same normalized substring rule the segment scan used
 * — because which word the author meant the escape to hide cannot be read off
 * argv once the command word is a non-destructive one. The reach is one command
 * node's text, never the whole command, so an escape sitting in a comment or in
 * a quoted data body stays outside this rule.
 */
function escapedWordDestructiveHit(
  parse: SecurityParseOk,
  cmd: CommandFact
): DangerousPatternHit | null {
  if (cmd.argv.some((word) => wordSource(word).includes("\\")) === false) {
    return null;
  }
  return rosterHit(scanFold(commandText(parse.text, cmd)));
}

/**
 * SC-S2-8's fork bomb as a structural rule: a function whose OWN name is the
 * no-op `:` and whose body backgrounds a pipeline of that same name. Today it
 * reaches `bare-metachar` only because the quote-blind splitter finds no command
 * word in `:(){`; on a real parse the body has command nodes and its `|` / `&`
 * are well-formed, so Stage-3's "zero command nodes" rule would otherwise let it
 * through. It renders the roster's own literal under `destructive-disk` — the
 * single authorized `(id, pattern)` move (SC-GATES-6), gated on Stage 0 modelling
 * `function_definition` (its OQ3, answered yes).
 */
function forkBombStructuralHit(
  parse: SecurityParseOk
): DangerousPatternHit | null {
  // The condition is observable, not assumed: unobserved, this family says
  // nothing about the shape at all.
  if ((parse.nodeTypes["function_definition"] ?? 0) === 0) return null;
  return bombRecursion(parse);
}

/**
 * The bomb's own shape: its body is a `|`-pipeline whose stages call the
 * function's own name, and the last stage is backgrounded. Read as pairs
 * because the recursion is between SIBLINGS, and the text between them is the
 * only thing that says `|` rather than `;`.
 */
function bombRecursion(parse: SecurityParseOk): DangerousPatternHit | null {
  const text = parse.text;
  const stages = parse.commands.filter(
    (command) => command.depth > 0 && nameOfWord(command.argv[0]) === ":"
  );
  for (let i = 1; i < stages.length; i += 1) {
    const previous = stages[i - 1]!;
    const stage = stages[i]!;
    if (!isBombPipelineStage(text, previous, stage)) continue;
    if (!isColonNamedDefinition(text.slice(0, previous.span.start))) continue;
    return FORK_BOMB_HIT;
  }
  return null;
}

/** Two adjacent `:` stages wired as `… : | : …&` — one link of the pipeline. */
function isBombPipelineStage(
  text: string,
  previous: CommandFact,
  stage: CommandFact
): boolean {
  if (stage.depth !== previous.depth) return false;
  if (!hasSpan(previous.span) || !hasSpan(stage.span)) return false;
  if (text.slice(previous.span.end, stage.span.start) !== "|") return false;
  return text[stage.span.end] === "&";
}

/**
 * The definition's name is not a parse fact, so it is read back from the source
 * its body points at: `:(){` is what makes the piped stages recursion, and a body
 * under any other name (`x(){ :|:& };`) is a no-op that never re-enters itself.
 */
function isColonNamedDefinition(head: string): boolean {
  return /(?:^|[;|&\s])\s*:\s*\(\s*\)\s*\{\s*$/.test(head);
}

/**
 * The names whose operands SC-S2-8 re-parses as shell code: `eval` re-executes
 * its operand in this shell and the shell names read a `-c` operand as a
 * script. Non-shell interpreters (python / node / perl / …) stay out — their
 * operand is not shell code, and the two shapes the floor authorizes as new
 * denies name `eval` and a shell `-c` only.
 */
const SHELL_CODE_OPERAND_NAMES: ReadonlySet<string> = Object.freeze(
  new Set([
    "eval",
    "bash",
    "sh",
    "zsh",
    "dash",
    "ksh",
    ...SHELL_FAMILY_ROSTER,
  ])
);

/**
 * SC-S2-8's recursion into code-bearing regions: the bomb text reaches the
 * wall as the DECODED value of an eval / shell-`-c` operand, where no
 * substring arm may read it (the `SUBSTRING_ROSTER` exclusion) and the outer
 * tree's structural gate cannot see it either (the region's `;` and `|` sit
 * inside one quoted word of the outer argv). Each such operand is re-parsed
 * and the structural rule run on THAT tree, descending through further code
 * operands up to `MAX_SUBSTITUTION_LEVEL` regions deep. A region the parser
 * cannot read as `ok` says nothing here: SC-S2-8 licenses only the CONFIRMED
 * structure as a new deny, and the outer command's own verdicts were already
 * routed by the caller.
 */
/**
 * The bomb rule run on ONE code operand re-parsed as shell code: `null` when
 * the region is empty, parses as nothing (`not ok` — SC-S2-8 licenses only
 * the CONFIRMED structure as a new deny, and the outer command's own verdicts
 * were already routed by the caller), or holds neither a fork bomb here nor
 * one in a region nested further down.
 */
function codeOperandBombHit(
  operand: WordFact,
  level: number
): DangerousPatternHit | null {
  const source = operand.value ?? wordSource(operand);
  if (source.length === 0) return null;
  const inner = parseForSecurity(source);
  if (inner.kind !== "ok") return null;
  const bomb = forkBombStructuralHit(inner);
  if (bomb !== null) return bomb;
  return nestedCodeBombHit(inner, level + 1);
}

function nestedCodeBombHit(
  parse: SecurityParseOk,
  level: number
): DangerousPatternHit | null {
  if (level > MAX_SUBSTITUTION_LEVEL) return null;
  for (const cmd of parse.commands) {
    const at = destructiveCommandAt(cmd);
    if (at === undefined || !SHELL_CODE_OPERAND_NAMES.has(at.name)) continue;
    for (const word of cmd.argv.slice(at.index + 1)) {
      const hit = codeOperandBombHit(word, level);
      if (hit !== null) return hit;
    }
  }
  return null;
}

/**
 * The destructive judgment on an `ok` tree: every command node in source order,
 * command-word rule then declared-code-operand rule then handed-operand rule
 * then the escape rule; then the here-string spans, the heredoc bodies the
 * receiver rule keeps, and the structural fork-bomb rule run on the re-parsed
 * bodies of eval / shell-`-c` code operands. The bomb's recognition at the
 * OUTER level is NOT one of these arms — the call site runs it there only past
 * the zero-command / pure-body gate, so an argv rule that already denied a
 * shape keeps its own id and the nested arm adds no move this stage does not
 * own. Precedence with the root-find fold (which owns `find /`) is preserved
 * at the call site, which runs the fold first.
 */
export function findDestructiveOnParse(
  parse: SecurityParseOk
): DangerousPatternHit | null {
  for (const cmd of parse.commands) {
    const wordHit = commandWordDestructiveHit(cmd);
    if (wordHit !== null) return wordHit;
    const codeHit = codeOperandDestructiveHit(cmd);
    if (codeHit !== null) return codeHit;
    const handedHit = handedOperandDestructiveHit(cmd);
    if (handedHit !== null) return handedHit;
    const escapeHit = escapedWordDestructiveHit(parse, cmd);
    if (escapeHit !== null) return escapeHit;
  }
  const hereStringHit = hereStringDestructiveHit(parse);
  if (hereStringHit !== null) return hereStringHit;
  const bodyHit = heredocBodyDestructiveHit(parse);
  if (bodyHit !== null) return bodyHit;
  return nestedCodeBombHit(parse, 1);
}

/**
 * The `format` gate's deny plus which surface owns reporting it: the gate fires
 * on a chunk the splitter produced, so a command can carry BOTH a `format` deny
 * and a destructive literal, and the pair is ordered, not ambiguous.
 */
interface FormatClaim {
  readonly hit: DangerousPatternHit;
  /** `"tree"` when an earlier chunk's literal is what the scan answered first. */
  readonly firstClaim: "format" | "tree";
}

/**
 * ADR-0068's lexical `format` gate, still read over the splitter's segments.
 * Its carrier is the segment and not the command node: the gate fires on a chunk
 * the quote-blind splitter starts with the word `format` and nowhere else, so an
 * argv reading of it denies shapes the text scan never reached — measured on
 * `if true; then format C:; fi`, `( format C: )`, `while :; do format C:; done`,
 * `! format C:`, `x=1 format C:` — eleven allow→deny rows no arm of this plan
 * licenses. It stays a text rule until the stage that retires the splitter makes
 * the question a structural one.
 *
 * `firstClaim` is the same gate's precedence, also taken from the text path: an
 * EARLIER chunk carrying a roster literal is one the scan answered before it ever
 * reached `format`, so the tree gets first claim on it and `format` speaks only if
 * the tree finds nothing. That nothing is this stage's licensed relaxation (the
 * literal sat in inert text), and dropping the `format` deny along with it would
 * be a new allow rather than a re-labelling.
 */
function lexicalFormatHit(command: string): FormatClaim | null {
  let seenEarlierRoster = false;
  for (const segment of splitForDangerousScan(command)) {
    const folded = segmentScanFold(segment);
    if (isLexicalFormatCommand(folded)) {
      // The gate has always shared one loop with the substring roster, and that
      // roster reads the segment first, so a destructive literal inside the SAME
      // chunk keeps reporting its own id (`format rm -rf /tmp/x` is `rm -rf`
      // today). Here it can only choose which deny to name, never create one.
      return {
        hit: rosterHit(folded) ?? FORMAT_GATE_HIT,
        firstClaim: seenEarlierRoster ? "tree" : "format",
      };
    }
    if (rosterHit(folded) !== null) seenEarlierRoster = true;
  }
  return null;
}

/**
 * The destructive judgment of the parsed path, in the precedence the text path
 * has always used: the ordered root-find fold keeps first claim, because it owns
 * `find / -delete` while the command-word rule owns `find /tmp -delete`; then the
 * tree answers for every destructive id. What stays on the text here is the
 * lexical `format` gate — its carrier is the splitter rather than the tree —
 * and the bare-metachar branch's fallback scan, which Stage 3 re-based on the
 * tree (`bareBranchAfterParse`).
 */
function findDestructiveAfterParse(
  command: string,
  parse: SecurityParseOk
): DangerousPatternHit | null {
  const walkHit = matchRootFindWalkOnParse(parse);
  if (walkHit !== null) return walkHit;
  const format = lexicalFormatHit(command);
  if (format !== null && format.firstClaim === "format") return format.hit;
  const astHit = findDestructiveOnParse(parse);
  if (astHit !== null) return astHit;
  if (format !== null) return format.hit;
  return bareBranchAfterParse(command, parse);
}

/**
 * The bare-metachar fall-through of the parsed path, Stage 3's AST-ification.
 * The bare-metachar id fires only where the `ok` parse yields ZERO command
 * nodes — the structural reading of "no command has started". Two text facts
 * stay, each for its own reason: the pure-body scan remains the shape-test
 * for the whole fall-through, because the corpus disagreement
 * `FOO=1 <<'EOF'…` (zero command nodes, a command word in the text) shows
 * the tree fact alone would newly deny it bare `<` — the text behavior wins;
 * and the fork bomb keeps the pure-body gate alone, because its tree HAS
 * command nodes (SC-S2-8's note) and the pure-body scan is the only fact that
 * separates the bare bomb from the ledger-pinned allow `ls; :(){… };:`, whose
 * `ls` word is what stands between them. Where the tree sees a command the
 * text scan called pure (`> /dev/null rm`), only the bare id retires; a
 * per-segment roster deny the same fall-through reports (`2> rm -rf` →
 * destructive-rm) keeps its full strength — this stage moves the bare
 * branch, not the roster.
 */
function bareBranchAfterParse(
  command: string,
  parse: SecurityParseOk
): DangerousPatternHit | null {
  if (!isPureMetacharBody(command)) return null;
  const bomb = forkBombStructuralHit(parse);
  if (bomb !== null) return bomb;
  const textHit = findTextDangerPattern(command);
  const bareNeedsZeroNodes =
    parse.commands.length > 0 && textHit?.id === "bare-metachar";
  return bareNeedsZeroNodes ? null : textHit;
}

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

/** The receiver rule's answer: the bodies worth reading, or why none can be. */
type HeredocCollection =
  | {
      readonly ok: true;
      readonly bodies: readonly HeredocBody[];
      readonly asks: readonly SubstitutionAsk[];
    }
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

/**
 * A span's own bounds, once they are numbers in the right order. Says nothing
 * about whether the text is long enough to hold them — that is `spanText`.
 */
function spanRange(
  span: FactSpan | undefined
): { start: number; end: number } | undefined {
  if (!hasSpan(span)) return undefined;
  const { start, end } = span;
  return start >= 0 && end >= start ? { start, end } : undefined;
}

/** The text a span addresses, or `undefined` when it addresses none of `text`. */
function spanText(
  text: string,
  span: FactSpan | undefined
): string | undefined {
  const range = spanRange(span);
  if (range === undefined || range.end > text.length) return undefined;
  return text.slice(range.start, range.end);
}

/** The node an index addresses, when this parse carries one at that index. */
function findCommand(
  commands: readonly CommandFact[],
  index: number | null | undefined
): CommandFact | undefined {
  if (index === null || index === undefined) return undefined;
  return commands.find((command) => command.index === index);
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

const NO_EXTRA_CODE_RECEIVERS: ReadonlySet<string> = Object.freeze(
  new Set<string>()
);

/**
 * What one `heredocs[]` fact turned out to be: nothing this file can read
 * (`fault`, which fails the whole collection), a declared `null` receiver
 * (`ask`), a body worth judging, or `data` — the quoted body of a text
 * receiver, which no walk collects and which IS this stage's relaxation.
 */
type HeredocEntry =
  | { state: "fault"; reason: string }
  | { state: "ask" }
  | { state: "data" }
  | { state: "body"; body: HeredocBody };

/**
 * The text of one fact's `bodySpan`, or the fault saying it addresses none. The
 * validity check is `spanText`'s and nobody else's: the folded-receiver arm
 * reads the same predicate, so a body one path calls valid cannot be the fault
 * the other path reports.
 */
function heredocBodyText(
  text: string,
  bodySpan: HeredocFact["bodySpan"]
): { body: string } | { state: "fault"; reason: string } {
  const body = spanText(text, bodySpan);
  if (body === undefined) {
    return {
      state: "fault",
      reason: "a heredocs[] bodySpan names nothing in the parsed text",
    };
  }
  return { body };
}

/** One fact's receiver, resolved to its command word. */
function heredocReceiver(
  commands: readonly CommandFact[],
  receiverIndex: number | null
): { name: string } | HeredocEntry {
  if (receiverIndex === null) return { state: "ask" };
  const receiver = findCommand(commands, receiverIndex);
  if (receiver === undefined) {
    return {
      state: "fault",
      reason: `receiverCommandIndex ${String(receiverIndex)} names no command`,
    };
  }
  const name = nameOfWord(receiver.argv[0]);
  if (name === undefined) {
    return {
      state: "fault",
      reason: `the receiver command ${String(receiverIndex)} carries no command word`,
    };
  }
  return { name };
}

/**
 * Whether a receiver eats its body as code. The frozen interpreter roster
 * answers for both walks; `extraCodeReceivers` is the caller's wider reading of
 * the same question — the destructive path counts the shells too, the
 * substitution walk asks the frozen roster and nothing else.
 */
function isCodeReceiver(
  name: string,
  extraCodeReceivers: ReadonlySet<string>
): boolean {
  return INTERPRETER_COMMAND_NAMES.has(name) || extraCodeReceivers.has(name);
}

/** One fact, classified. Every fault this collector can return is decided here. */
function resolveHeredocEntry(
  text: string,
  commands: readonly CommandFact[],
  heredoc: HeredocFact,
  extraCodeReceivers: ReadonlySet<string>
): HeredocEntry {
  if (heredoc === null || typeof heredoc !== "object") {
    return { state: "fault", reason: "a heredocs[] entry is not a body fact" };
  }
  const span = heredocBodyText(text, heredoc.bodySpan);
  if ("state" in span) return span;
  if (typeof heredoc.delimiterQuoted !== "boolean") {
    return {
      state: "fault",
      reason: "a heredocs[] delimiter is neither quoted nor not",
    };
  }
  const receiver = heredocReceiver(commands, heredoc.receiverCommandIndex);
  if ("state" in receiver) {
    // A declared-`null` receiver cannot make an UNQUOTED body inert: bash
    // expands that body whoever reads it, so it stays live code exactly as the
    // quote-blind scan read it. A receiver naming no command is the parse
    // contradicting itself and stays a fault.
    if (receiver.state === "ask" && !heredoc.delimiterQuoted) {
      return { state: "body", body: { text: span.body, isCode: true } };
    }
    return receiver;
  }
  const isCode = isCodeReceiver(receiver.name, extraCodeReceivers);
  if (isCode || !heredoc.delimiterQuoted) {
    return { state: "body", body: { text: span.body, isCode } };
  }
  return { state: "data" };
}

/**
 * The receiver, not the delimiter, decides what a heredoc body IS; the receiver
 * rule itself belongs to `receiverRunsOrStoresBody`, the one question both
 * walls ask. This collector is where the substitution walk applies its narrow
 * frozen-roster reading, widened per caller by `extraCodeReceivers` — the
 * destructive wall completes that reading with `foldedReceiverBodies`, so
 * neither this function nor that one owns the rule alone. An interpreter
 * executes its body whatever the quoting, and an unquoted body is live for any
 * receiver because bash expands it. A quoted body of a text command is data, so
 * it is collected by neither walk. A `null` receiver is a declared arm of the
 * field's type — the body is quoted and unattributable, so it comes back as an
 * ask rather than being guessed at; unquoted, the receiver's identity is
 * irrelevant and the body stays live code.
 */
function collectHeredocBodies(
  text: string,
  commands: readonly CommandFact[],
  heredocs: readonly HeredocFact[],
  extraCodeReceivers: ReadonlySet<string> = NO_EXTRA_CODE_RECEIVERS
): HeredocCollection {
  const bodies: HeredocBody[] = [];
  const asks: SubstitutionAsk[] = [];
  for (const heredoc of heredocs) {
    const entry = resolveHeredocEntry(
      text,
      commands,
      heredoc,
      extraCodeReceivers
    );
    if (entry.state === "fault") return { ok: false, reason: entry.reason };
    if (entry.state === "ask") {
      asks.push({
        kind: "receiver-unresolvable",
        detail: "receiver-unresolvable=heredoc",
      });
      continue;
    }
    if (entry.state === "body") bodies.push(entry.body);
  }
  return { ok: true, bodies, asks };
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
  const collected = collectHeredocBodies(
    text,
    payload.commands,
    payload.heredocs
  );
  if (!collected.ok) return { ok: false, reason: collected.reason };
  asks.push(...collected.asks);
  const bodies = collected.bodies;

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
function expansionBucketOf(name: string): "secret" | "whitelist" | "unknown" {
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
    // SC-S2-9's ordering rule: a CONFIRMED inner deny outranks any outer
    // uncertainty, so the cap inspects the deeper regions for denials before
    // it abstains. The descent collects no asks of its own (the budget's ask
    // is the one pushed below) and terminates on the same `visited` set plus
    // the strict substring shrink the normal walk relies on.
    const deep = denyOnlySites(prepared, nested, visited);
    if (deep.kind !== "clean") return deep;
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
 * The deny-only twin of `walkSites`: run at the substitution-depth cap so a
 * confirmed denial below the budget still reaches the deny tier. It reads the
 * combo wall and each inner command's own text exactly as `walkSite` does and
 * recurses without ever consulting the depth budget — bounded because every
 * step marks a new index in `visited` and the site set is finite.
 */
function denyOnlySites(
  prepared: PreparedParse,
  sites: readonly SubstitutionFact[],
  visited: Set<number>
): WalkStep {
  for (const site of sites) {
    const combo = comboHitFor(prepared, site);
    if (combo !== null) return { kind: "hit", hit: combo };
    const inner = site.innerCommandIndex;
    if (inner === null) continue;
    const command = prepared.byIndex.get(inner);
    if (command === undefined) {
      return {
        kind: "fault",
        reason: `innerCommandIndex ${String(inner)} vanished from the parse`,
      };
    }
    if (visited.has(inner)) continue;
    visited.add(inner);
    const own = scanCommandText(commandText(prepared.text, command));
    if (own !== null) {
      return {
        kind: "hit",
        hit: {
          id: "command-substitution",
          pattern: `subst=${String(site.kind)}→${own.id}`,
        },
      };
    }
    const deeper = denyOnlySites(
      prepared,
      prepared.children.get(inner) ?? [],
      visited
    );
    if (deeper.kind !== "clean") return deeper;
  }
  return CLEAN_STEP;
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
      // Same ordering as the site cap: the skipped region is still searched
      // for a CONFIRMED denial before the walk abstains.
      const deep = denyOnlyBody(body);
      if (deep.kind !== "clean") return deep;
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
 * The deny-only reading of a body the depth budget skips: its destructive
 * argv rules and its substitution family run for a confirmed denial (and an
 * analysis contradiction stays a fault), while every ask-shaped verdict —
 * unknown syntax, a further exhausted budget — keeps today's ordinary ask
 * flow rather than being re-priced here.
 */
function denyOnlyBody(body: HeredocBody): WalkStep {
  const parsed = parseForSecurity(body.text);
  if (isHardDenyVerdict(parsed)) {
    if (!body.isCode) return CLEAN_STEP;
    const routed = routeParseVerdict(parsed);
    return routed === null ? CLEAN_STEP : { kind: "hit", hit: routed };
  }
  if (parsed.kind !== "ok") return CLEAN_STEP;
  const destructive = findDestructiveOnParse(parsed);
  if (destructive !== null) return { kind: "hit", hit: destructive };
  const analysis = analyzeSubstitutions(parsed);
  if (analysis.verdict === "denied") return { kind: "hit", hit: analysis.hit };
  if (analysis.verdict === "analysis-fault") {
    return { kind: "fault", reason: analysis.reason };
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
 * The one receiver rule both walls ask: whether the receiver of a heredoc body
 * runs OR stores that body (`trap`/`alias` only store). Read off the folded
 * command word through `runsWhatItIsHanded`, so `sudo bash <<'EOF'` and
 * `docker exec -i c sh <<'EOF'` answer the same way their `-c` spellings do.
 */
function receiverRunsOrStoresBody(receiver: CommandFact): boolean {
  const at = destructiveCommandAt(receiver);
  return at !== undefined && runsWhatItIsHanded(at.name);
}

/**
 * Whether the sensitive-path wall excises one inert span from its DENY
 * judgment. A comment never carries a live path; `single-quoted` text always
 * does (those quotes are shell hygiene around an `argv` operand, and a
 * sensitive path inside one is a real path — the operand exclusion). A quoted
 * heredoc body is decided by the one receiver rule both walls ask:
 * `receiverRunsOrStoresBody` keeps it executable (judged, deny confirmable),
 * `provenInertDataConsumer` proves it data, and a receiver that is missing,
 * ambiguous, or named but unclassified is excised too — because its match is
 * the Security review requirement's to price (SC-S2-7's "review, not a
 * confident allow or deny"), not this wall's to decide either way. The
 * contradiction arms — an owner index addressing no node, a receiver with no
 * command word, an unquoted body bash expands — stay judged whole.
 */
function spanExcisedFromSensitiveDeny(
  span: InertFact,
  parse: SecurityParseOk
): boolean {
  if (span.why === "single-quoted") return false;
  if (span.why === "comment") return true;
  if (span.delimiterQuoted !== true) return false;
  if (span.ownerCommandIndex === undefined) return true;
  const receiver = findCommand(parse.commands, span.ownerCommandIndex);
  if (receiver === undefined) return false;
  if (receiverRunsOrStoresBody(receiver)) return false;
  return destructiveCommandAt(receiver) !== undefined;
}

/**
 * Whether this parse can be trusted to blank ANYTHING: every span must address
 * real text, and a heredoc must either name no owner or name a node that exists.
 * A span out of range, reversed or non-integer, or an owner index addressing no
 * node, is the parse contradicting its own text, and then excision is abandoned
 * for the whole command — the fail-toward-deny arm of this wall.
 */
function spansAreTrustworthy(parse: SecurityParseOk, command: string): boolean {
  for (const span of parse.inert) {
    const range = spanRange(span.span);
    if (range === undefined || range.end > command.length) return false;
    if (span.why !== "heredoc-body" || span.ownerCommandIndex === undefined) {
      continue;
    }
    if (findCommand(parse.commands, span.ownerCommandIndex) === undefined) {
      return false;
    }
  }
  return true;
}

/**
 * `command` with each data span replaced by spaces of the SAME byte count.
 * Blanking, never trimming: nothing on either side becomes adjacent, no word is
 * re-anchored, and the roster's `$`-anchored arms keep matching end-of-text and
 * only there. Length-preserving writes also keep every later span's offsets
 * valid whatever the order the spans are applied. Any verdict other than `ok`
 * (unknown-syntax, malformed, aborted, over-cap, vetoed, parser-unavailable)
 * scans raw at full strength — the degrade path keeps today's answer.
 */
function scanTextForSensitivePath(command: string): string {
  const parse = parseForSecurity(command);
  if (parse.kind !== "ok") return command;
  if (!spansAreTrustworthy(parse, command)) return command;
  let scanned = command;
  for (const span of parse.inert) {
    if (!spanExcisedFromSensitiveDeny(span, parse)) continue;
    const range = spanRange(span.span);
    if (range === undefined) continue;
    scanned = `${scanned.slice(0, range.start)}${" ".repeat(
      range.end - range.start
    )}${scanned.slice(range.end)}`;
  }
  return scanned;
}

/**
 * The frozen fragment roster run as one pass over `text`: substring arms match
 * literally, `\\`-prefixed arms carry their own regex. Answers the matched
 * fragment (for the review requirement's detail) or `null`.
 */
function sensitiveFragmentHit(text: string): string | null {
  for (const fragment of SENSITIVE_PATH_FRAGMENTS) {
    if (fragment.startsWith("\\")) {
      if (new RegExp(fragment).test(text)) return fragment;
    } else if (text.includes(fragment)) {
      return fragment;
    }
  }
  return null;
}

/**
 * Scan a command string for sensitive path fragments (`.ssh/`, `/etc/passwd`,
 * `/etc/shadow`, `.env`, `.pem`, etc.). This mirrors `matchSensitivePath` for
 * path-bearing tools, applied to the `command` field of execute tools so the
 * redirect exemption cannot be abused to write to a sensitive location.
 *
 * The roster itself runs unchanged; only the text it runs over is quote-aware —
 * comment text, the quoted-delimiter heredoc bodies of receivers positively
 * proven inert under SC-S2-9, and the quoted bodies whose receiver is missing,
 * ambiguous, or unclassified (excised from THIS wall's deny because their
 * match is answered by the Security review requirement, never by a confident
 * allow or deny) are blanked first, everything else (operands, redirect
 * targets, receiver code) is judged whole.
 *
 * Exported so `src/harness/aci/tools/bash.ts` (the handler-level gate) applies
 * the same check as the hard-wall — otherwise a redirect like `>> /etc/shadow`
 * would pass `isDangerousCommand` at the handler and only be stopped by
 * bwrap's ro-bind, not by policy (axis2 skeptic finding).
 */
export function commandContainsSensitivePath(command: string): boolean {
  const scanned = scanTextForSensitivePath(command);
  return sensitiveFragmentHit(scanned) !== null;
}

// --- SC-S2-9 / ADR-0127: the Security review requirement scanner -----------
//
// The deny tier is decided; this section prices what the parse could not
// establish. It runs AFTER the hard walls (policy's order), so anything it
// reports has already escaped every confirmed-deny arm — including the
// deny-only descents this file's substitution walk makes at its depth caps,
// which is what lets a confirmed inner deny outrank the review reported here.
// It never denies and never allows: it answers `clean` (ordinary flow) or a
// typed requirement with the unresolved source span, or a typed input/failure
// verdict for shapes it cannot even ask the question about.

/** The scan's full answer set. `invalid` and `fault` end in typed denies. */
export type SecurityReviewScan =
  | { readonly verdict: "clean" }
  | { readonly verdict: "review"; readonly requirement: SecurityReviewRequirement }
  | { readonly verdict: "invalid"; readonly reason: string }
  | { readonly verdict: "fault"; readonly reason: string };

/**
 * Thrown by the scanner's arms when the INPUT to the attribution question is
 * broken (no command word where one is required, a fact span addressing no
 * text). Kept distinct from an ordinary throw so the entry can route it to
 * `invalid` while anything unexpected stays `fault` — the C2 input-and-failure
 * contract's two typed denials.
 */
class ReviewInputInvalid extends Error {}

function reviewRequirement(
  cause: SecurityReviewCause,
  span: { start: number; end: number },
  detail: string
): SecurityReviewRequirement {
  return { cause, span: { start: span.start, end: span.end }, detail };
}

/** The roster and the fragment table, over one piece of raw text. */
function securityRelevantPattern(text: string): string | null {
  const roster = rosterHit(scanFold(text));
  if (roster !== null) return roster.pattern;
  return sensitiveFragmentHit(text);
}

/**
 * A command node whose head word has no positive classification: neither
 * proven inert (data) nor judged by a deny arm that reads its operands whole
 * (destructive argv, declared code, run-or-store). `chroot` and `awk` land
 * here — `awk` on purpose, because its program operand can call `system()`
 * and nothing in this file establishes whether it does.
 */
function commandNodeReview(
  cmd: CommandFact
): SecurityReviewRequirement | null {
  const at = destructiveCommandAt(cmd);
  const name = at === undefined ? undefined : at.name;
  if (name !== undefined && operandOwnershipEstablished(name)) return null;
  const operands = cmd.argv.slice(at === undefined ? 0 : at.index + 1);
  const pattern = securityRelevantPattern(argvScanText(operands));
  if (pattern === null) return null;
  if (name === undefined) {
    throw new ReviewInputInvalid(
      "a security-relevant command node carries no command word"
    );
  }
  const span = spanRange(cmd.span);
  if (span === undefined) {
    throw new ReviewInputInvalid(
      `the command \`${name}\` carries a span addressing no text`
    );
  }
  return reviewRequirement(
    "execution-unresolved",
    span,
    `command \`${name}\` is not proven to treat its operands as data and its operands carry \`${pattern}\``
  );
}

/**
 * A quoted heredoc body judged by the receiver rule both walls ask: code
 * receivers are the deny tier's (reached or missed there, never re-priced
 * here), proven-inert receivers are data, and everything the parse could not
 * attribute — a missing receiver, an index that names no executable
 * classification, a named-but-unclassified word — is a requirement, never a
 * price of data.
 */
/**
 * The receiver arms of the heredoc-body judgment, once a receiver index
 * exists: a receiver the tree cannot name is the deny tier's contradiction
 * (this scan says nothing after it has spoken), a receiver that runs or
 * stores the body is the deny tier's price, a proven-inert consumer is data,
 * and everything else is a `data-ownership-unresolved` requirement.
 */
function heredocReceiverReview(
  parse: SecurityParseOk,
  receiverIndex: number,
  span: { start: number; end: number },
  pattern: string
): SecurityReviewRequirement | null {
  const receiver = findCommand(parse.commands, receiverIndex);
  if (receiver === undefined) return null;
  if (receiverRunsOrStoresBody(receiver)) return null;
  const name = destructiveCommandAt(receiver)?.name;
  if (name === undefined) {
    throw new ReviewInputInvalid(
      "the receiver of a security-relevant heredoc carries no command word"
    );
  }
  if (provenInertDataConsumer(name)) return null;
  return reviewRequirement(
    "data-ownership-unresolved",
    span,
    `command \`${name}\` receives the quoted body, neither runs nor stores it, and is not proven to treat it as data; the body carries \`${pattern}\``
  );
}

function heredocBodyReview(
  parse: SecurityParseOk,
  heredoc: HeredocFact
): SecurityReviewRequirement | null {
  if (!heredoc.delimiterQuoted) return null;
  const body = spanText(parse.text, heredoc.bodySpan);
  if (body === undefined) {
    throw new ReviewInputInvalid(
      "a heredocs[] bodySpan names nothing in the parsed text"
    );
  }
  const pattern = securityRelevantPattern(body);
  if (pattern === null) return null;
  const span = spanRange(heredoc.bodySpan);
  if (span === undefined) {
    throw new ReviewInputInvalid(
      "a security-relevant heredoc body carries a span addressing no text"
    );
  }
  if (heredoc.receiverCommandIndex === null) {
    return reviewRequirement(
      "receiver-unresolved",
      span,
      `a quoted heredoc body carries \`${pattern}\` and no command owns the redirect`
    );
  }
  return heredocReceiverReview(parse, heredoc.receiverCommandIndex, span, pattern);
}

/**
 * The unattached-substitution arm of the flat scan: a substitution site the
 * parse attaches to no command node is an established-until-contradicted
 * region, and security-relevant text inside one takes the budget's own
 * exhaustion as its cause.
 */
function unattachedSubstitutionReview(
  parse: SecurityParseOk
): SecurityReviewScan | null {
  for (const site of parse.substitutions) {
    if (site.innerCommandIndex !== null) continue;
    const text = spanText(parse.text, site.span);
    if (text === undefined) {
      throw new ReviewInputInvalid(
        "a substitution site carries a span addressing no text"
      );
    }
    const pattern = securityRelevantPattern(text);
    if (pattern === null) continue;
    const span = spanRange(site.span);
    if (span === undefined) {
      throw new ReviewInputInvalid(
        "a security-relevant substitution site carries a span addressing no text"
      );
    }
    return {
      verdict: "review",
      requirement: reviewRequirement(
        "bounded-analysis-exhausted",
        span,
        `a substitution site the parse attaches to no command node carries \`${pattern}\``
      ),
    };
  }
  return null;
}

/**
 * The one fault route shared by every entry of the review layer: an
 * `ReviewInputInvalid` is the scan saying the INPUT broke its promise
 * (`invalid`), anything else that throws is the analysis itself breaking
 * (`fault`) — the caller's contract is that neither ever escapes as a throw.
 */
function routeReviewFault(fault: unknown): SecurityReviewScan {
  if (fault instanceof ReviewInputInvalid) {
    return { verdict: "invalid", reason: fault.message };
  }
  const name = fault instanceof Error ? fault.name || "Error" : typeof fault;
  return {
    verdict: "fault",
    reason: `attribution analysis threw (${String(name)})`,
  };
}

/**
 * The flat facts of one `ok` parse decide every ownership question this stage
 * can ask without recursing: `shell-parse.ts` publishes the whole tree —
 * nested commands and bodies included — in `commands[]` / `heredocs[]` /
 * `substitutions[]`, so no re-parse is owed to reach them. What no flat fact
 * reaches is the CONTENT of a substitution site the parse attached to no
 * command node: security-relevant text there is an established-until-
 * contradicted region, and the budget's own exhaustion names the cause.
 */
export function securityReviewForParse(
  parse: SecurityParseOk
): SecurityReviewScan {
  try {
    for (const cmd of parse.commands) {
      const requirement = commandNodeReview(cmd);
      if (requirement !== null) return { verdict: "review", requirement };
    }
    for (const heredoc of parse.heredocs) {
      const requirement = heredocBodyReview(parse, heredoc);
      if (requirement !== null) return { verdict: "review", requirement };
    }
    const substitution = unattachedSubstitutionReview(parse);
    if (substitution !== null) return substitution;
    return { verdict: "clean" };
  } catch (fault) {
    return routeReviewFault(fault);
  }
}

/**
 * The string-level entry of the review layer, on the same totality promise as
 * the substitution walk: it never throws. Only an `ok` tree is scanned — a
 * hard-deny verdict stays the deny tier's (`aborted` and its siblings keep
 * their typed denies above), `unknown-syntax` and the degrade path keep the
 * mode flow ADR-0124 assigned them, and the empty command asks nothing of
 * nobody.
 */
export function analyzeSecurityReview(
  command: unknown
): SecurityReviewScan {
  if (typeof command !== "string") {
    return {
      verdict: "invalid",
      reason: "the command under security review is not a string",
    };
  }
  if (command.length === 0) return { verdict: "clean" };
  try {
    const result = parseForSecurity(command);
    if (result.kind !== "ok") return { verdict: "clean" };
    return securityReviewForParse(result);
  } catch (fault) {
    return routeReviewFault(fault);
  }
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
