import type { HardRuleSpec } from "./types.js";
import type {
  SecurityReviewCause,
  SecurityReviewRequirement,
} from "./security-review.js";
import { VIOLATION_PREFIXES } from "./prefixes.js";
import {
  ALLOWED_COMMAND_TOKENS,
  INTERPRETER_COMMAND_NAMES,
} from "./command-roster.js";
import { splitShellSegments } from "./text-segments.js";
import {
  isContainedFileTarget,
  isDeterminedPathWord,
  isNonDirectoryTarget,
  type CleanupRootSnapshot,
  type CleanupScope,
} from "./cleanup-roots.js";
import { isAbsolute, join, resolve } from "node:path";

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

// Exported read-only (frozen) so the protected-target inventory test surface
// can assert roster-name coverage against resolved targets; the roster itself
// is seeded by, and edited only in, this file.
export const SENSITIVE_PATH_FRAGMENTS: readonly string[] = Object.freeze([
  ".ssh/",
  ".ssh\\\\",
  "\\.ssh$",
  ".aws/",
  "\\.aws$",
  ".gnupg/",
  "\\.gnupg$",
  ".config/gh/",
  "\\.config/gh$",
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

/**
 * Allowlist-first gate (SC-S4-2 re-home): the answer comes from the parse on
 * the `ok` path and from the internal text-segments seam (`text-segments.ts`,
 * the un-exported splitter) on every non-`ok` verdict — the degrade fold kept
 * verbatim, so `unknown-syntax` / `malformed` / `aborted` / `over-cap` /
 * `vetoed` / `parser-unavailable` answer exactly as they did before this PR
 * (docs/shell-parse-non-ok-consumer-contracts.md).
 *
 * The `ok` path carries both facts the old segment fold decided:
 *   - membership: every depth-0 command unit's first argv word must be an
 *     `ALLOWED_COMMAND_TOKENS` name (a projection of `./command-roster.js`,
 *     SC-S4-4 — the membership is the table's own);
 *   - the second syntactic fact (SC-S4-2's keep): no bare newline / carriage
 *     return anywhere outside quoted spans and heredoc bodies, which is what
 *     pins `echo a\nrm -rf /` → `false`, `echo a\nls` → `false` and
 *     `echo a\rb` → `false` even when every command word is allowlisted.
 *
 * Each unit then rides the same quote-blind character checks the fold applied
 * per segment (`isSegmentAllowed`: redirect exemption, then the backtick /
 * paren / line-break metachars) over the raw text between fact boundaries —
 * so punctuation sitting inside quoted or commented DATA still refuses, and
 * the only answers that move are the four inert-punctuation divergences the
 * parity battery pins (`shell-parse-segmentation-parity.test.ts`).
 */
export function isAllowedCommand(command: string): boolean {
  if (command.length === 0) return false;
  const parsed = parseForSecurity(command);
  if (parsed.kind === "ok") {
    return isAllowedFromParse(parsed);
  }
  return isAllowedFromTextFold(command);
}

function isAllowedFromTextFold(command: string): boolean {
  const segments = splitShellSegments(command);
  if (segments.length === 0) return false;
  for (const segment of segments) {
    if (!isSegmentAllowed(segment)) return false;
  }
  return true;
}

function isAllowedFromParse(parsed: SecurityParseOk): boolean {
  // SC-S4-2's second syntactic fact: the grammar consumes a bare line break
  // without a token, so the refusal rides the derived offsets, not a cut.
  if (parsed.bareNewlineOffsets.length > 0) return false;
  if (parsed.bareCarriageReturnOffsets.length > 0) return false;
  const units = parseBoundedUnits(parsed);
  // Separator noise with no command text at all (`;`, `|`) — the same shapes
  // the text fold answered `false` for through its empty-segment guard.
  if (units.length === 0) return false;
  for (const node of parsed.commands) {
    if (node.depth !== 0) continue;
    const first = node.argv[0];
    if (first === undefined) return false;
    if (!ALLOWED_COMMAND_TOKENS.has(firstToken(first.text))) return false;
  }
  for (const unit of units) {
    if (!isSegmentAllowed(unit)) return false;
  }
  return true;
}

/**
 * The depth-0 command units as raw text: the command string cut at every
 * list-operator boundary the parse surfaced (`;`, `&&`, `||`, `|`, `|&`, the
 * terminating `&`), empty pieces dropped — the quote-aware replacement for the
 * boundaries the text fold computed blind, so a separator inside a quoted
 * word, a heredoc body, or a comment is no longer a cut. Line breaks are NOT
 * cuts here; `bareNewlineOffsets` / `bareCarriageReturnOffsets` answer them
 * above, exactly as `isSegmentAllowed`'s metachar list answered them for the
 * fold.
 */
function parseBoundedUnits(parsed: SecurityParseOk): string[] {
  const bounds = [...parsed.operators].sort((a, b) => a.span.start - b.span.start);
  const units: string[] = [];
  let from = 0;
  for (const op of bounds) {
    if (op.span.start < from) continue;
    units.push(parsed.text.slice(from, op.span.start));
    from = op.span.end;
  }
  units.push(parsed.text.slice(from));
  return units
    .map((unit) => unit.trim())
    .filter((unit) => unit.length > 0);
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
 * Every predicate `find` accepts that only READS the tree, and how many
 * following tokens each one consumes. This roster is the positive half of the
 * read-only root-search exception (spec SC6): a `find` rooted at the
 * filesystem root clears the root-find wall when its whole expression is spelled
 * from this list.
 *
 * The direction is the point. The question is never "does this command contain
 * something dangerous" but "is every predicate here one that only reads", and
 * anything the roster does not name withholds the allowance. A list of known
 * mutating flags would have the opposite failure: every predicate a future
 * findutils release adds, and every spelling nobody enumerated, would be
 * admitted by default. Here each entry is a promise a human makes after
 * reading what the flag does, so growth is a deliberate act.
 *
 * Every name below was run against GNU findutils 4.10 and accepted, with no
 * filesystem effect; the mutating spellings that the same binary accepts are
 * `-delete`, `-exec`, `-execdir`, `-ok`, `-okdir`, `-fprint`, `-fprint0`,
 * `-fprintf` and `-fls`, none of which appears here. That binary also accepts
 * NO abbreviation of a predicate — `-del`, `-execu`, `-fpri` and `-fl` are all
 * `unknown predicate` — which is what makes exact-name matching sufficient
 * rather than merely convenient. `root-find-predicate-roster.test.ts` re-runs
 * both halves against the real binary so a change here that outruns findutils
 * fails instead of drifting.
 */
const READ_ONLY_FIND_PREDICATES: ReadonlyMap<string, number> = new Map([
  // Name / pattern / path matching
  ["-name", 1],
  ["-iname", 1],
  ["-path", 1],
  ["-wholename", 1],
  ["-iwholename", 1],
  ["-regex", 1],
  ["-iregex", 1],
  ["-regextype", 1],
  ["-lname", 1],
  // File type and metadata
  ["-type", 1],
  ["-xtype", 1],
  ["-size", 1],
  ["-empty", 0],
  ["-samefile", 1],
  ["-inum", 1],
  ["-links", 1],
  ["-perm", 1],
  // Time comparison (all spelling forms find accepts)
  ["-mtime", 1],
  ["-atime", 1],
  ["-ctime", 1],
  ["-amin", 1],
  ["-cmin", 1],
  ["-newer", 1],
  ["-anewer", 1],
  ["-cnewer", 1],
  ["-used", 1],
  ["-newermt", 1],
  // Ownership
  ["-user", 1],
  ["-group", 1],
  ["-uid", 1],
  ["-gid", 1],
  ["-nouser", 0],
  ["-nogroup", 0],
  // Filesystem shape and traversal control
  ["-fstype", 1],
  ["-xdev", 0],
  ["-prune", 0],
  ["-quit", 0],
  ["-maxdepth", 1],
  ["-mindepth", 1],
  ["-follow", 0],
  ["-depth", 0],
  ["-noleaf", 0],
  ["-ignore_readdir_race", 0],
  // Permissions as a test, never as a change
  ["-readable", 0],
  ["-writable", 0],
  ["-executable", 0],
  // Output actions: they write to the tool's OWN stdout, never to a file
  ["-print", 0],
  ["-print0", 0],
  ["-printf", 1],
  ["-ls", 0],
  // Constants, so a pure predicate expression is expressible
  ["-true", 0],
  ["-false", 0],
]);

/**
 * `find`'s expression operators. They arrange predicates; they never carry one
 * of their own, so admitting them cannot admit an unexamined action. `-a` is
 * the explicit `AND`; the bare `,` is `OR` and the single `;` would be `AND`.
 */
const FIND_EXPRESSION_OPERATORS: ReadonlySet<string> = Object.freeze(
  new Set(["-a", "-and", "-o", "-or", "!", "(", ")", ",", ";"])
);

/**
 * Whether one `find` token run expresses READ-ONLY TRAVERSAL: every predicate it
 * names is in `READ_ONLY_FIND_PREDICATES`, and the expression's structure is
 * only operators this file has read.
 *
 * Consumed as a real grammar walk rather than a token scan, because arity is
 * load-bearing in both directions. A flag that takes a value must have that
 * value SKIPPED (`-name` consumes `-delete`, so `find / -name -delete` is a
 * search for a file literally called `-delete`, and treating the flag as an
 * action would deny a harmless command); and a value-taking predicate whose
 * value is MISSING is a command find itself rejects, so the run is judged on
 * the flags it did name.
 *
 * The one structural thing that ends the walk early is the terminator of an
 * execution action. `find / -exec rm {} \;` carries the whole payload of the
 * action after `-exec`, and `;` / `+` are ordinary tokens to every other
 * reader, so scanning the run to its end would grade `rm` as if it were a
 * predicate. The walk therefore stops as soon as it meets one, and the answer
 * is the same either way here — `-exec` is not in the roster — but the stop
 * keeps the reading honest for a command that spells the action's own name as
 * one of its arguments.
 */
function isReadOnlyFindExpression(
  tokens: ReadonlyArray<string>,
  at: number
): boolean {
  let i = at + 1;
  // Global options (`-L`, `--`, `-D tree`, `-O2`) may precede the search roots.
  while (i < tokens.length) {
    const skip = findGlobalOptionArity(tokens[i]!);
    if (skip === undefined) break;
    i += skip + 1;
  }
  // Then the search roots, up to the same "paths must precede expression"
  // boundary `commandOperands` stops at.
  while (i < tokens.length && !tokens[i]!.startsWith("-")) i += 1;
  for (; i < tokens.length; i += 1) {
    const token = stripQuoteLayer(tokens[i]!.replace(/\\/g, ""));
    // Operators are tested BEFORE the predicate roster, because three of them
    // (`-a`, `-o`, `-and`/`-or`) are themselves spelled with a leading dash and
    // would otherwise be read as an unrecognised predicate.
    if (FIND_EXPRESSION_OPERATORS.has(token)) continue;
    if (!token.startsWith("-")) {
      // A non-flag token that is not an operator is an execution terminator
      // (`;` / `+`) or a value some preceding predicate failed to consume.
      // Both withhold the allowance, which is what keeps
      // `find / -exec rm {} \;` from being graded as if `rm` were a predicate.
      return false;
    }
    const arity = READ_ONLY_FIND_PREDICATES.get(token);
    if (arity === undefined) return false;
    i += arity;
  }
  return true;
}

/**
 * Whether a read-only root search feeds a command that this same wall would
 * deny for a destructive operand — the `find / -name '*.log' | xargs -0 rm -f`
 * shape.
 *
 * The search's own expression really is read-only, so the expression test alone
 * clears the wall and the `rm` would reach spawn. It is here because the
 * allowance is a statement about the COMMAND's intent, not the search's: a walk
 * whose whole purpose is to hand a whole-machine listing to something that
 * deletes is not read-only traversal, whatever the search half of it does.
 *
 * It reads the receiving run's own command word through the SAME two predicates
 * the destructive arms use (`isDestructiveWord` for a run that IS the destructive
 * command, `runsWhatItIsHanded` for one that hands its operand on), so it cannot
 * disagree with them about what a destructive command is. The direction is
 * fail-closed: a downstream run this wall cannot read keeps the deny.
 */
function rootSearchFeedsDestructiveConsumer(
  runs: ReadonlyArray<RootFindRun>,
  from: number
): boolean {
  for (let i = from; i < runs.length; i += 1) {
    const tokens = runs[i]!.tokens;
    if (tokens.length === 0) continue;
    const at = commandAt(tokens, DESTRUCTIVE_EXTRA_WRAPPERS);
    // EXIT: an empty run carries nothing. A run this wall cannot read keeps
    // the deny: the whole point of the check is that what the search hands over
    // is not something the search itself can describe.
    if (at === undefined) return true;
    const name = at.name;
    if (isDestructiveWord(name)) {
      // The run's own command word is destructive, so the listing this search
      // produced becomes its argv. That is enough on its own: whether `rm` is
      // spelled here directly or reached through `xargs`, the search supplied
      // the operands. The name test rather than a roster match is what catches
      // the `xargs` spelling, whose flags are the file list the search produced
      // and are therefore not tokens of this run at all.
      return true;
    }
    if (!runsWhatItIsHanded(name)) continue;
    // The run hands its operand on — `xargs sh -c '…'` is the shape — and a
    // destructive name anywhere in what it hands on is enough.
    const rest = tokens.slice(at.index + 1);
    if (rest.some((token) => isDestructiveWord(commandWord(stripQuoteLayer(token))))) {
      return true;
    }
  }
  return false;
}



/**
 * True when a `find` command's token run walks the whole machine. This is the
 * FACT the wall is about — the search's repository is the filesystem root — and
 * it deliberately does not carry the read-only carve-out, because the fold asks
 * that question separately: whether the walk is denied is a decision made of
 * this fact plus the walk's own expression (see `isReadOnlyFindRootWalk` and
 * the fold).
 *
 * Roots that are NOT this wall: `.` / `..` / relative paths / `/tmp` and any
 * other non-root absolute path — scoping the tree is the reader's job
 * (ADR-0068).
 *
 * Whole-command form: `cd / && find .` is the same whole-machine walk with the
 * root hidden in the `cd`, so the caller passes the `cd`-aware decision in. A
 * `cd /` followed by a NON-`find` command is out of this wall's scope (the
 * walk's repository is what is hard-walled, not `cd` itself).
 *
 * Bare `find` with no path operand walks the shell cwd (GNU find; the
 * options-first spelling `find -name x` included), so it is denied exactly
 * when that cwd is the filesystem root.
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
 * The read-only carve-out, as its own predicate (spec SC6 / Assumption 4 "Root
 * search" / ADR-0134 "Read-only root traversal reaches normal permission checks
 * and this common execution contract").
 *
 * It answers two questions the root fact alone cannot, which is why the split
 * exists at all:
 *
 *   - a MUTATING root search keeps the deny. `-delete` removes every match,
 *     `-exec` / `-execdir` / `-ok` / `-okdir` run a program over the whole
 *     machine, and the `-fprint` family writes a file from a whole-machine walk.
 *     None of these is a search; each is a decision about the tree.
 *   - a READ-ONLY root search clears the wall and continues through ordinary
 *     permission checks, exactly like `find /tmp`. The reason the 2026-09-14
 *     incident (a `find /` running ~232 s until the host cancelled it) is no
 *     longer this wall's to prevent is that the walk is no longer unbounded: it
 *     reaches the SAME Bash execution deadline as every other foreground call
 *     (ADR-0134 — 10 s by default, a validated `timeout_ms` otherwise, enforced
 *     in the process plane, with no root-search-specific cap). The fence still
 *     applies, the sensitive-path wall still applies, and a walk that overruns
 *     ends as a per-call `execution_failed` / `message: "timeout"` rather than
 *     as a runaway process. Scoping the tree remains the reader's job; what
 *     changed is that an unbounded walk is no longer the alternative.
 */
function isReadOnlyFindRootWalk(
  tokens: ReadonlyArray<string>,
  cwd: string | undefined,
  wordsIncomplete: boolean
): boolean {
  const command = commandAt(tokens);
  if (command === undefined || command.name !== "find") return false;
  if (!isRootFindTokens(tokens, cwd, wordsIncomplete)) return false;
  // The bare walk is a whole-machine search like any other, and the same
  // expression decides whether its root is what denies it: `cd / && find -name
  // x` and `cd / && find -delete` part ways here exactly as their
  // explicit-root twins do.
  return isReadOnlyFindExpression(tokens, command.index);
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
  const ordered = [...runs];
  let state: CwdState = { cwd: undefined, oldpwd: undefined };
  for (const [index, run] of ordered.entries()) {
    const moved = applyCd(run.tokens, state);
    if (moved !== null) state = moved;
    if (!isRootFindTokens(run.tokens, state.cwd, run.wordsIncomplete)) {
      continue;
    }
    // A read-only walk is not denied for its root (spec SC6) — but it is still
    // denied when the same command hands that walk's listing to a destructive
    // consumer. The intent being denied there is the `rm`, and the search is
    // how it gets its operands, so `find / -name '*.log' | xargs -0 rm -f` is
    // the same mutation as the `-delete` it replaced.
    if (
      isReadOnlyFindRootWalk(run.tokens, state.cwd, run.wordsIncomplete) &&
      !rootSearchFeedsDestructiveConsumer(ordered, index + 1)
    ) {
      continue;
    }
    // EXIT: reject on the first root-walk find — the whole-machine walk is the
    // intent being denied, so no later segment can rescue the command.
    return { id: "root-find-walk", pattern: "find" };
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
 * The human-facing reason of ADR-0124's over-cap state, of the pre-parse veto,
 * and of `malformed` is carried into the deny so the operator sees the class,
 * not only a structural token. `malformed` used to render its `verdict=` alone
 * and dropped the parse layer's own reason, which named the actual problem (an
 * incomplete syntax such as an unclosed quote) and gave the operator nothing
 * to act on; `aborted` still renders its token alone because its reason is the
 * analysis budget's, not a statement about the input.
 */
function routeParseVerdict(
  result: SecurityParseResult
): DangerousPatternHit | null {
  switch (result.kind) {
    case "malformed":
      return { id: "unparseable", pattern: `verdict=malformed ${result.reason}` };
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
 *
 * ADR-0132/ADR-0133 layer the bounded cleanup exceptions ON TOP of this
 * verdict rather than inside it, so this function keeps answering for the
 * command alone and `findDangerousPattern` is the one that consults the
 * host's root context. Every arm below is therefore unchanged in reach: a
 * cleanup exception can only REMOVE a `destructive-rm` finding, never add one
 * and never touch another id.
 */
function findDangerousPatternUnscoped(
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

// `INTERPRETER_COMMAND_NAMES` (ADR-0125 Assumption 7's closed interpreter
// roster) moved to `./command-roster.js` with Stage 4b (SC-S4-4): the roster
// consolidation this literal's own comment deferred to the sibling spec's
// Stage 2-4 criterion is that module; both readers below import the name.

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

// --- ADR-0132 / ADR-0133: the bounded cleanup exceptions ----------------
//
// Two exceptions, both scoped to ONE arm of ONE wall: the `destructive-rm`
// finding, on a `rm` whose every target is a finite explicit non-directory
// file established inside one host-owned root. Neither is an allow — both only
// remove the hard-wall finding, so the command then continues through the
// ordinary mode / category handling the rest of the flow applies.
//
// They are ONE function for one reason (ADR-0133's shared-verdict clause): the
// permission wall and the Bash handler must be able to disagree about nothing.
// Two arms, one answer each, no second classification to drift.
/** The variable name whose expansion is trusted, and only when a scratch root exists. */
const TRUSTED_SCRATCH_ENV_NAME = "TMPDIR";

/** `rm` flags that ask for a tree walk. `-d` does not: it needs `-r` to reach a dir. */
const RECURSIVE_RM_FLAGS = new Set(["r", "R", "recursive"]);

/** What an admitted cleanup was established inside, and by which rule. */
export type BoundedCleanupException = {
  readonly scope: CleanupScope;
  /** The root the targets were proven to sit under. */
  readonly root: string;
  /** Every resolved target, in source order — the all-target evidence. */
  readonly targets: readonly string[];
};

/** The `$TMPDIR` / `${TMPDIR}` prefix of an operand, consumed, or `null`. */
function consumeScratchEnvPrefix(word: string): string | null {
  for (const form of [`$${TRUSTED_SCRATCH_ENV_NAME}/`, `$${TRUSTED_SCRATCH_ENV_NAME}`]) {
    if (word.startsWith(form)) return word.slice(form.length);
  }
  const braced = `\${${TRUSTED_SCRATCH_ENV_NAME}}`;
  if (word === braced) return "";
  if (word.startsWith(`${braced}/`)) return word.slice(braced.length + 1);
  return null;
}

/** Strip one layer of matching double quotes; single quotes are NOT strippable
 *  for expansion purposes (bash does not expand inside them), so they fall
 *  through as literal text and fail containment instead. */
function undoubleQuoted(word: string): string | null {
  if (word.length < 2) return null;
  if (!word.startsWith('"') || !word.endsWith('"')) return null;
  return word.slice(1, -1);
}

/**
 * Whether `word` is a `rm` flag that does not ask for recursion.
 *
 * Clustered short flags are decomposed: `-rf` is two flags, and reading it as
 * one name would never match a roster of whole names, so a recursive `rm` would
 * be classified as a bounded cleanup. `--recursive` is the long form; `--` is
 * the end-of-options marker, which carries no semantics and ends flag reading.
 */
function isNonRecursiveRmFlag(word: string, isAfterTerminator: boolean) {
  if (isAfterTerminator) return false;
  if (word === "--") return true;
  if (!word.startsWith("-") || word === "-") return false;
  if (word.startsWith("--")) return !RECURSIVE_RM_FLAGS.has(word.slice(2));
  for (const letter of word.slice(1)) {
    if (letter === "r" || letter === "R") return false;
  }
  return true;
}

/**
 * One operand, resolved against the snapshot: which root (if any) it is
 * established inside. `null` means the operand is not a determined path inside
 * any offered root, and the whole command therefore gets no exception.
 *
 * `$TMPDIR` is expanded to the snapshot's own scratch root, so the trusted
 * expansion and its equivalent absolute spelling are answered by the same
 * root — never by two independent facts that could drift.
 */
function cleanupTargetRoot(
  word: string,
  quoteKind: WordFact["quoteKind"],
  roots: CleanupRootSnapshot,
  base: string | undefined
): { readonly root: string; readonly target: string } | null {
  const literal = quoteKind === "double" ? undoubleQuoted(word) : word;
  if (literal === null) return null;
  if (literal.includes("$") || literal.includes("`")) {
    return scratchExpansionTarget(literal, roots);
  }
  if (!isDeterminedPathWord(literal)) return null;
  if (!isAbsolute(literal) && base === undefined) return null;
  return containedTargetRoot(
    isAbsolute(literal) ? literal : resolve(base as string, literal),
    roots,
    base
  );
}

/**
 * A determined path, against the offered roots in offer order. A root that
 * does not contain the target as a non-directory file is skipped, and a target
 * no offered root establishes ends the walk with `null` — the operand gets no
 * exception, and with it the whole command.
 */
function containedTargetRoot(
  target: string,
  roots: CleanupRootSnapshot,
  base: string | undefined
): { readonly root: string; readonly target: string } | null {
  for (const root of [roots.scratchRoot, roots.taskRoot]) {
    if (root === undefined) continue;
    if (!isContainedFileTarget(target, root, base ?? "/")) continue;
    if (!isNonDirectoryTarget(target, base ?? "/")) continue;
    return { root, target };
  }
  return null;
}

/**
 * An operand that names a shell expansion, resolved against the snapshot's own
 * scratch root only. `null` for every case where the expansion cannot be
 * pinned to a determined file inside that root — which is the only root an
 * expansion is ever allowed to reach, so the arms are `null` rather than a
 * walk over the offered roots.
 */
function scratchExpansionTarget(
  literal: string,
  roots: CleanupRootSnapshot
): { readonly root: string; readonly target: string } | null {
  if (roots.scratchRoot === undefined) return null;
  const rest = consumeScratchEnvPrefix(literal);
  // An expansion is only ever the FIRST path segment: `$TMPDIR` names the
  // root, never a suffix, and any second variable stays unresolved. The
  // substituted remainder is then held to the same determination rule as a
  // plain operand, or `$TMPDIR/*.cjs` would inherit the exception.
  if (rest === null || !isDeterminedPathWord(rest)) return null;
  const target = join(roots.scratchRoot, rest);
  if (!isContainedFileTarget(target, roots.scratchRoot, "/")) return null;
  if (!isNonDirectoryTarget(target, "/")) return null;
  return { root: roots.scratchRoot, target };
}

/** The single-command `rm -f <files…>` shape both exceptions require. */
function cleanupRmCommand(parse: SecurityParseOk): CommandFact | null {
  if (parse.commands.length !== 1) return null;
  const cmd = parse.commands[0]!;
  if (cmd.depth !== 0) return null;
  // The command word must BE `rm`: a wrapper fold (`sudo`, `builtin`, `env`)
  // changes the uid or the option parsing, and neither exception establishes
  // authority over the wrapper's own effect.
  const first = cmd.argv[0];
  if (first === undefined || first.value !== "rm") return null;
  return cmd;
}

/**
 * The directory a RELATIVE operand resolves against: the call's working
 * directory, which is the `taskRoot` the Bash handler runs in.
 *
 * Never the scratch root. A scratch path reaches a command as an ABSOLUTE
 * path or through `$TMPDIR` (ADR-0092 never binds it into the guest as a cwd),
 * so making it the resolution base would fabricate containment: a relative
 * operand that does not exist would resolve under the scratch and read as
 * "inside the identity's own scratch", which is exactly the authority this
 * wall must not invent. With no `taskRoot` there is no working directory to
 * resolve against, and relative operands get no exception.
 */
function cleanupBase(roots: CleanupRootSnapshot): string | undefined {
  return roots.taskRoot;
}

/**
 * Whether `command` is a bounded cleanup this host's roots cover, as ADR-0132 /
 * ADR-0133 define one. `null` for everything else — and `null` is the whole
 * fail-toward-deny contract: no parse, a second command, a recursive form, a
 * glob, an unresolved variable, a directory, another identity's scratch, a
 * mixed-target command, an escaping symlink, or a protected target all keep
 * the existing verdict.
 */
export function classifyBoundedCleanupException(
  command: string,
  roots: CleanupRootSnapshot
): BoundedCleanupException | null {
  if (roots.scratchRoot === undefined && roots.taskRoot === undefined) return null;
  if (command.length === 0) return null;
  const parse = parseForSecurity(command);
  if (parse.kind !== "ok") return null;
  const cmd = cleanupRmCommand(parse);
  if (cmd === null) return null;
  // Protected targets are not this arm's business at all: the sensitive wall
  // owns them, and ADR-0132/0133 grant no authority over them.
  if (classifySensitivePathEvidence(command).class === "confirmed") return null;

  const established = establishedCleanupTargets(cmd, roots);
  if (established === null) return null;
  if (established.length === 0) return null;
  return {
    scope: established[0]!.root === roots.scratchRoot ? "identity-scratch" : "task-root",
    root: established[0]!.root,
    targets: established.map((entry) => entry.target),
  };
}

/**
 * The `rm` operand walk: every non-flag word resolved against the snapshot, or
 * `null` when any of them fails. The empty list is a distinct answer from
 * `null` — a command with no operand established establishes nothing, and the
 * caller refuses both — so the walk never collapses the two.
 *
 * All-target is why a single unresolved operand ends the whole command's
 * claim, and why a second operand landing in a different root than the first
 * does the same: the exception this returns removes a deny, so it may only
 * describe a command whose every operand is inside ONE root.
 */
function establishedCleanupTargets(
  cmd: CommandFact,
  roots: CleanupRootSnapshot
): { readonly root: string; readonly target: string }[] | null {
  const base = cleanupBase(roots);
  const established: { root: string; target: string }[] = [];
  let terminatorSeen = false;
  for (const word of cmd.argv.slice(1)) {
    const text = wordSource(word);
    if (!terminatorSeen && isNonRecursiveRmFlag(text, terminatorSeen)) {
      if (text === "--") terminatorSeen = true;
      continue;
    }
    const resolved = cleanupTargetRoot(text, word.quoteKind, roots, base);
    if (resolved === null) return null;
    if (established.length > 0 && established[0]!.root !== resolved.root) return null;
    established.push(resolved);
  }
  return established;
}

/**
 * The destructive judgment with the cleanup exceptions applied: the
 * `destructive-rm` finding this host's roots establish as a bounded cleanup is
 * not a finding, and nothing else is. Absent roots leave the answer byte-identical.
 */
export function findDangerousPattern(
  command: string,
  roots?: CleanupRootSnapshot
): DangerousPatternHit | null {
  const hit = findDangerousPatternUnscoped(command);
  if (hit?.id !== "destructive-rm") return hit;
  if (roots === undefined) return hit;
  return classifyBoundedCleanupException(command, roots) === null ? hit : null;
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
 * Per-segment allowlist check — the quote-blind character semantics shared by
 * the two `isAllowedCommand` arms: run per fact-bounded unit on the `ok` path
 * and per text-fold segment on the degrade path. Strips redirection tokens
 * (>, >>, <, 2>, file paths after them) before token inspection so the
 * redirect exemption is enforced at the unit boundary. Subshell /
 * command-substitution parens are still rejected because they are matched by
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
  /**
   * ADR-0132/ADR-0133's per-call host root context. `HardRuleSpec.match`'s
   * declared shape is narrower (`{tool, input}`) and stays that way: an
   * optional extra member is assignable from every value the declared shape
   * allows, so `policy.ts` may pass it and a legacy caller that does not is
   * answered as "no cleanup scope" — today's verdict, unchanged.
   */
  readonly roots?: CleanupRootSnapshot;
}): string | null {
  if (input.tool !== "bash" && input.tool !== "execute") return null;
  const command = (input.input as { command?: unknown } | null | undefined)
    ?.command;
  if (typeof command !== "string") return null;
  const hit = findDangerousPattern(command, input.roots);
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
  // The verdict is the SHARED classification's, not a second opinion computed
  // here (ADR-0131): the Bash handler reads the same result, so a permission-
  // admitted command can never be rejected by a broader duplicate of this rule.
  const evidence = classifySensitivePathEvidence(command);
  if (evidence.class === "confirmed") {
    return `dangerous command: sensitive path targeted by command (matched \`${evidence.fragment}\` at the ${evidence.site})`;
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
  readonly roots?: CleanupRootSnapshot;
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
  readonly roots?: CleanupRootSnapshot;
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
 * The verdict is `classifySensitivePathEvidence(command).class === "confirmed"`,
 * so the permission wall and the Bash handler read ONE result (ADR-0131): a
 * fragment match is a candidate, and only a site the parser established as a
 * path target may deny non-overridably. The boolean arm answers exactly that
 * question, because a caller that can act on the finding can act on the match
 * — `unresolved` and `non_path` are not this wall's to answer.
 *
 * Exported so `src/harness/aci/tools/bash.ts` (the handler-level gate) applies
 * the same check as the hard-wall — otherwise a redirect like `>> /etc/shadow`
 * would pass `isDangerousCommand` at the handler and only be stopped by
 * bwrap's ro-bind, not by policy (axis2 skeptic finding).
 */
export function commandContainsSensitivePath(command: string): boolean {
  return classifySensitivePathEvidence(command).class === "confirmed";
}

// --- ADR-0131: sensitive-path evidence classification --------------------
//
// A `SENSITIVE_PATH_FRAGMENTS` match is a CANDIDATE, not a verdict. The
// reported false denial (issue #1170) came from treating one as a verdict:
// `node -e 'process.env.NODE_OPTIONS'` matches `\.env\.` and touched no
// filesystem. The three answers below are grounded in WHERE the match landed
// and in WHAT the parser established at that site — never in the shape of the
// matched text. A narrowing exception keyed on the fragment's spelling is the
// remedy ADR-0131 rejected (`.env.`), so nothing here may be licensed by "the
// string looks like code".
//
//   confirmed  the match is at a site the parse established as a path
//              TARGET: an argv operand, a redirect target, a heredoc body a
//              code receiver runs, or a recursively parsed nested shell's
//              operand. Non-overridable hard deny.
//   non_path   the match is inside a code/data region and the token carrying
//              it was not established as a path target. The positive evidence
//              is that the token IS a name — a bare identifier or a
//              property-access chain member — so the `env` in
//              `process.env.NODE_OPTIONS` is a name, not a file. The absence
//              of a path target is NOT sufficient on its own: a token this
//              parse cannot read as a name is `unresolved`, because the one
//              thing that must never decide this is whether the foreign
//              source left a whitespace word boundary in front of the
//              fragment. No finding from this wall.
//   unresolved the match is inside a code/data region and the token IS
//              path-shaped, but the program that consumes it is not proven to
//              treat it as data. ADR-0127's per-call review prices it; with
//              no interactive route the existing typed deny answers, and
//              reviewer unavailability is never a confirmed violation.

/**
 * Where in the command text a finding sits, in half-open character offsets.
 *
 * Named because both evidence classes carry one and both are handed straight to
 * a human: `SecurityReviewRequirement.span` is the region ADR-0127 asks an
 * operator to adjudicate, so a span that does not address the region in
 * question is a fabricated fact about where the problem is. Structural
 * compatibility with the parser's own `FactSpan` is deliberate — the parse
 * grounded arms hand its spans over unchanged, so a cast is never needed to
 * move a parse span into this field.
 */
export interface EvidenceSpan {
  readonly start: number;
  readonly end: number;
}

/** The three ADR-0131 evidence classes, and the one shared result shape. */
export type SensitivePathEvidence =
  | {
      readonly class: "confirmed";
      /** The roster entry that matched — what the deny names to the operator. */
      readonly fragment: string;
      /** Where the match was established, in command-text offsets. */
      readonly span: EvidenceSpan;
      /** What kind of site carried it, for the diagnostic. */
      readonly site: SensitivePathSite;
    }
  | {
      readonly class: "non_path";
      /** Absent when no roster entry matched at all (the common case). */
      readonly fragment?: string;
    }
  | {
      readonly class: "unresolved";
      readonly fragment: string;
      readonly span: EvidenceSpan;
      readonly site: SensitivePathSite;
    };

/** The parse-established sites this classification distinguishes. */
export type SensitivePathSite =
  | "argv-operand"
  | "redirect-target"
  | "code-region"
  | "heredoc-body";

/** No roster entry matched: this wall has nothing to classify. */
const NO_MATCH: SensitivePathEvidence = Object.freeze({ class: "non_path" });

/**
 * The first roster entry matching inside `text`, with where it matched.
 *
 * `offset` is the position `text` occupies in the whole command, so the
 * returned `span` is already in command-text coordinates. The offsets are the
 * point of the return value: they are what a `confirmed` arm and the
 * `unresolved` fallback both hand to a human-readable requirement, and
 * discarding them in favor of the enclosing command is what made the ADR-0127
 * prompt point at the interpreter instead of at the path.
 */
function sensitiveFragmentAt(
  text: string,
  offset: number
): { fragment: string; span: EvidenceSpan } | null {
  for (const fragment of SENSITIVE_PATH_FRAGMENTS) {
    const at = fragment.startsWith("\\")
      ? new RegExp(fragment).exec(text)
      : (() => {
          const index = text.indexOf(fragment);
          return index < 0
            ? null
            : { index, "0": fragment } as unknown as RegExpExecArray;
        })();
    if (at === null) continue;
    const start = offset + at.index;
    return { fragment, span: { start, end: start + fragment.length } };
  }
  return null;
}

/**
 * The site's kind for one word, from the parse: an argv position past the
 * command word is an OPERAND the shell will hand to that program, whatever the
 * word's spelling. Position 0 is the command word itself, which names what
 * runs rather than naming a file.
 */
function argvSiteKind(index: number): SensitivePathSite {
  return index === 0 ? "code-region" : "argv-operand";
}

/**
 * The code region of one command node: every operand a code-consuming receiver
 * is handed as source. This is the only region whose matches are re-parsed
 * before judgment — a program's own source is the one place a roster fragment
 * can appear without the shell ever being told to open that file.
 */
function codeRegionWords(cmd: CommandFact): readonly WordFact[] {
  const at = destructiveCommandAt(cmd);
  if (at === undefined) return [];
  if (!CODE_CONSUMING_COMMAND_NAMES.has(at.name)) return [];
  return cmd.argv.slice(at.index + 1);
}

/**
 * The POSIX-ish shell names among the code consumers. Their operand is a
 * script THIS parse can read, so an inner match in command position is a
 * command name and the inner parse is authoritative about it; a `node` /
 * `python3` operand is source in a grammar this file does not model.
 */
const SHELL_FAMILY_NAMES: ReadonlySet<string> = Object.freeze(
  new Set(["bash", "dash", "ksh", "sh", "zsh"])
);

/**
 * A bare identifier: the only token shape that can carry positive evidence of
 * being a name rather than a value, and so the only shape the command-position
 * arm will read. Deliberately plain ASCII and deliberately whole-token — a
 * dotted property-access chain is matched segment by segment below, not by
 * letting `process.env.NODE_OPTIONS` through as one identifier.
 */
const BARE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Whether `word` is POSITIVELY established as a name: a run of bare-identifier
 * segments joined by dots, i.e. an identifier or a property-access chain member
 * such as `process.env.HOME`. This is the evidence ADR-0131 requires for
 * `non_path` — not "the parse happened to leave a word boundary in front of
 * the fragment", and not "no slash was seen".
 *
 * Why whole-token, and why the chain is walked segment by segment: the earlier
 * rule took the inner parse's COMMAND POSITION as its evidence, and command
 * position is decided by whitespace. That made the verdict a function of the
 * foreign source's formatting rather than of what the token is:
 *
 *     perl -e 'open(F,"/etc/shadow")'   -> command position -> non_path
 *     perl -e 'open(F, "/etc/shadow")'  -> operand         -> confirmed
 *
 * Two commands that read the same file, one space apart, with opposite
 * verdicts — a `deny -> allow` on a real read. Requiring the whole token to be
 * a run of names closes the path-shaped family from this side: a roster entry
 * that reads as a path (`/etc/shadow`, `.ssh/id_rsa`, `/etc/passwd`) contains a
 * character a bare-identifier segment cannot hold, so no such match can be
 * spelled this way.
 *
 * This is only the FIRST of the two conditions, and on its own it is not
 * enough: `id_rsa` is a valid bare identifier, so `node -e 'id_rsa'` cleared
 * this test while naming a real key. See `matchIsInteriorToToken`.
 */
function isEstablishedIdentifier(word: string): boolean {
  if (word.length === 0) return false;
  return word.split(".").every((segment) => BARE_IDENTIFIER.test(segment));
}

/**
 * Whether the roster match on `word` is INTERIOR — something follows it inside
 * the same token — which is what makes the token a property-access chain
 * MEMBER rather than the sensitive name itself.
 *
 * The two conditions together are the whole of the `non_path` evidence, and
 * each rules out a real `deny -> allow`:
 *
 *   process.env.HOME   `\.env\.` matches `env.` and `HOME` follows -> interior
 *                      -> a member of a chain -> exempt
 *   id_rsa             the fragment is the ENTIRE token        -> not interior
 *                      -> it is the sensitive name itself     -> not exempt
 *   a.b.id_rsa         the fragment ends the token            -> not interior
 *   fs.readFileSync(id_rsa)   likewise, and that one really does read the key
 *
 * Framing it as "does anything follow the match" rather than as a list of
 * exempt spellings is deliberate: the roster is frozen by the spec, and any
 * criterion keyed on which fragment matched would be a shape whitelist — the
 * remedy ADR-0131 rejected and the one that produced the bypass. A token that
 * IS the sensitive name is not inert content whatever its letters are, so it
 * goes to ADR-0127's review like every other unproven case.
 */
function matchIsInteriorToToken(word: string, fragment: string): boolean {
  const end = rosterMatchEndAt(word, fragment);
  if (end === null) return false;
  return end < word.length;
}

/**
 * Where the roster entry `fragment` stops matching inside `text`, or `null` when
 * it did not match. Measured from the MATCHED TEXT, not the pattern: a regex
 * arm's pattern is longer than what it matches (`\.env\.` is six characters and
 * matches `.env.`, five), so the pattern's length cannot answer "is anything
 * left in this token". Kept separate from `sensitiveFragmentAt` rather than
 * folded into it, because that function's `end` is a diagnostic span the deny
 * reason quotes and widening its meaning would move every reported offset.
 */
function rosterMatchEndAt(text: string, fragment: string): number | null {
  if (fragment.startsWith("\\")) {
    const at = new RegExp(fragment).exec(text);
    return at === null ? null : at.index + at[0].length;
  }
  const index = text.indexOf(fragment);
  return index < 0 ? null : index + fragment.length;
}

/**
 * The evidence for one match inside a code region, decided by the role the
 * INNER parse gives the token that carries it.
 *
 * `sh -c 'cat /etc/passwd'` and `node -e 'process.env.NODE_OPTIONS'` are the
 * same outer shape — one quoted operand of an interpreter — and the shell
 * parse establishes no difference between them. So the role that separates them
 * is not "does it look like a path" (the shape heuristic ADR-0131 rejects, and
 * the one `node -e 'fs.readFileSync("/etc/shadow")'` walks straight through)
 * but:
 *
 *   - the token is an inner OPERAND — the inner program was TOLD to open that
 *     file. Established, therefore `confirmed` (a recursively parsed nested
 *     shell keeps denying, as the spec requires).
 *   - the token sits in inner COMMAND POSITION, the receiver is one whose
 *     source this file cannot read (`node`, `python3`, `perl`, … are not shell
 *     grammars), AND the token is a name by positive evidence
 *     (`isEstablishedIdentifier`). Only then is it a property-access member
 *     rather than something the foreign source carries as a value.
 *   - anything else — a match the inner parse could not place, an inner
 *     verdict that is not `ok`, a receiver this file cannot classify, a
 *     command-position token that is not a name — is `unresolved`, which
 *     ADR-0127 prices and which may never become an allow.
 */
/**
 * The command-position verdict for one matched token, or `null` to leave it
 * `unresolved`.
 *
 * Four facts have to agree before a match may produce NO finding, and each one
 * rules out a real `deny -> allow`:
 *
 *   - the receiver is a shell this parse can read. Then the inner parse read
 *     the token as a COMMAND NAME, which cannot name a file, and the arm stops
 *     here rather than pricing a modelled shape as unresolved.
 *   - the token is unquoted. A quoted one is a string literal the foreign
 *     source carries (`fs.readFileSync("/etc/shadow")`).
 *   - the token IS a name (`isEstablishedIdentifier`). The quote state alone
 *     cannot decide it, because the foreign source's quoting is exactly what
 *     this parse cannot read — and command position, the thing that used to
 *     stand in for "a name", is decided by WHITESPACE, which is formatting and
 *     not evidence.
 *   - the match is INTERIOR to the token (`matchIsInteriorToToken`), so the
 *     token is a chain member and not the sensitive name itself.
 *
 * Anything else is `unresolved`: a `deny -> allow` on a real read is far worse
 * than a review that asks one question too many.
 */
function commandPositionVerdict(
  word: WordFact,
  hit: { fragment: string },
  isShell: boolean
): SensitivePathEvidence | null {
  if (isShell) return null;
  if (word.quoteKind !== "none") return null;
  if (!isEstablishedIdentifier(word.text)) return null;
  if (!matchIsInteriorToToken(word.text, hit.fragment)) return null;
  return { class: "non_path", fragment: hit.fragment };
}

function codeRegionEvidence(
  raw: string,
  base: number,
  receiver: string
): SensitivePathEvidence | null {
  // A receiver that eats a SHELL script is one this parse can read: its inner
  // parse is authoritative, so a match in command position there is a command
  // name (`sh -c 'id_rsa'`), not a property-access chain, and asking ADR-0127
  // about it would price a modelled shape as unresolved.
  if (!CODE_CONSUMING_COMMAND_NAMES.has(receiver)) return null;
  const isShell = SHELL_FAMILY_NAMES.has(receiver);
  // The inner parse reads the word's PAYLOAD: the shell's own quote layer is
  // hygiene around the operand, not part of the source the receiver executes.
  const text = stripQuoteLayer(raw);
  const inner = parseForSecurity(text);
  if (inner.kind !== "ok") return null;
  for (const node of inner.commands) {
    for (let i = 1; i < node.argv.length; i++) {
      const word = node.argv[i]!;
      const hit = sensitiveFragmentAt(word.text, 0);
      if (hit === null) continue;
      return {
        class: "confirmed",
        fragment: hit.fragment,
        span: { start: base, end: base + text.length },
        site: "code-region",
      };
    }
  }
  for (const node of inner.commands) {
    const word = node.argv[0];
    if (word === undefined) continue;
    const hit = sensitiveFragmentAt(word.text, 0);
    if (hit === null) continue;
    const verdict = commandPositionVerdict(word, hit, isShell);
    if (verdict !== null) return verdict;
  }
  return null;
}

/**
 * The whole command's classification, the ONE result the permission wall and
 * the Bash handler both read.
 *
 * A non-`ok` parse keeps ADR-0124's answer for it and adds none of its own.
 * That means the raw text at FULL strength: the degrade path
 * (`parser-unavailable`) has no `ok` payload to classify, and ADR-0124 §4
 * assigns it the legacy text scan, so a fragment there is `confirmed` exactly
 * as it was before this classification existed. The three hard-deny verdicts
 * (`malformed` / `over-cap` / `vetoed`) have already denied upstream in
 * `findDangerousPattern`, and `unknown-syntax` keeps its ask, so neither gains
 * or loses anything here — the wall must not add a second, differently-timed
 * answer on top of a verdict that already has one.
 */
export function classifySensitivePathEvidence(
  command: string
): SensitivePathEvidence {
  const parse = parseForSecurity(command);
  if (parse.kind !== "ok") {
    const hit = sensitiveFragmentHit(command);
    return hit === null
      ? NO_MATCH
      : {
          class: "confirmed",
          fragment: hit,
          span: { start: 0, end: command.length },
          site: "code-region",
        };
  }
  const overall = sensitiveFragmentAt(scanTextForSensitivePath(command), 0);
  if (overall === null) return NO_MATCH;
  const evidence = classifyOnParse(parse);
  // The fallback names the match's OWN offsets, not the whole command. This
  // span becomes `SecurityReviewRequirement.span` — the region ADR-0127 asks an
  // operator to adjudicate — so covering the interpreter, its flags and its
  // quoting instead of the path-shaped token would ask the reviewer about text
  // that is not in question. `scanTextForSensitivePath` is length-preserving
  // (inert spans are blanked with the same number of spaces), so the offsets
  // read off the scanned text address the original command unchanged.
  return (
    evidence ?? {
      class: "unresolved",
      fragment: overall.fragment,
      span: overall.span,
      site: "code-region",
    }
  );
}

/**
 * The parse-grounded classification over an `ok` tree, in the one order the
 * evidence licenses: a site the parser established as a path TARGET is
 * confirmed wherever it sits, and only a match with no such establishment is
 * then split between `non_path` and `unresolved`.
 */
function classifyOnParse(parse: SecurityParseOk): SensitivePathEvidence | null {
  return (
    establishedTargetEvidence(parse) ??
    heredocBodyEvidence(parse) ??
    inertSpanEvidence(parse) ??
    unattributedGapEvidence(parse) ??
    untrustworthySpanEvidence(parse)
  );
}

/**
 * Arm 1. Established path targets. A redirect target and an argv operand past the
 * command word are what the shell actually opens — a token the consumer's
 * ownership cannot establish is still a target, because the shell opens it
 * regardless of what the program would have done with it. These deny in
 * any mode, and this is the arm `awk '{ print }' /etc/passwd` lands in.
 */
function establishedTargetEvidence(
  parse: SecurityParseOk
): SensitivePathEvidence | null {
  for (const redirect of parse.redirects) {
    const hit = sensitiveFragmentAt(redirect.target.text, 0);
    if (hit === null) continue;
    return {
      class: "confirmed",
      fragment: hit.fragment,
      span: { ...redirect.target.span },
      site: "redirect-target",
    };
  }
  for (const node of parse.commands) {
    // A node that IS a code region is entirely owned by it — see
    // `codeRegionEvidenceIn` for why its words never reach the argv arm.
    const code = codeRegionWords(node);
    if (code.length > 0) {
      const hit = codeRegionEvidenceIn(node, code);
      if (hit !== null) return hit;
      continue;
    }
    const operand = argvOperandEvidence(node);
    if (operand !== null) return operand;
  }
  return null;
}

/**
 * One command node's code region, or `null` when no operand of it matched.
 *
 * A node whose operands are the SOURCE a code-consuming receiver runs owns a
 * code region, and every one of its operands is judged by that region's rule
 * below rather than as a plain operand. The caller skips the argv-operand arm
 * for such a node either way — a receiver this file cannot classify, and a
 * region with no match at all, both leave the node to the next node — so a
 * code word the region declined to confirm is never re-priced as a target the
 * consumer merely received.
 */
function codeRegionEvidenceIn(
  node: CommandFact,
  code: readonly WordFact[]
): SensitivePathEvidence | null {
  const receiver = destructiveCommandAt(node)?.name;
  if (receiver === undefined) return null;
  for (const word of code) {
    const hit = sensitiveFragmentAt(word.text, 0);
    if (hit === null) continue;
    return (
      codeRegionEvidence(word.text, word.span.start, receiver) ?? {
        class: "unresolved",
        fragment: hit.fragment,
        span: { ...word.span },
        site: "code-region",
      }
    );
  }
  return null;
}

/** One command node's first sensitive argv operand, or `null` for none. */
function argvOperandEvidence(
  node: CommandFact
): SensitivePathEvidence | null {
  for (let i = 1; i < node.argv.length; i++) {
    const word = node.argv[i]!;
    const hit = sensitiveFragmentAt(word.text, 0);
    if (hit === null) continue;
    return {
      class: "confirmed",
      fragment: hit.fragment,
      span: { ...word.span },
      site: argvSiteKind(i),
    };
  }
  return null;
}

/**
 * Arm 2. A heredoc body the receiver rule keeps executable is source the receiver
 * RUNS, so a match in it is an established target. Bodies excised by
 * `scanTextForSensitivePath` (comments, proven-inert consumers, and the
 * unclassified receivers whose match is the review's) never reach here.
 */
function heredocBodyEvidence(
  parse: SecurityParseOk
): SensitivePathEvidence | null {
  for (const heredoc of parse.heredocs) {
    if (!heredoc.delimiterQuoted) continue;
    if (heredoc.receiverCommandIndex === null) continue;
    const receiver = findCommand(parse.commands, heredoc.receiverCommandIndex);
    if (receiver === undefined || !receiverRunsOrStoresBody(receiver)) continue;
    const text = spanText(parse.text, heredoc.bodySpan);
    if (text === undefined) continue;
    const hit = sensitiveFragmentAt(text, 0);
    if (hit === null) continue;
    return {
      class: "confirmed",
      fragment: hit.fragment,
      span: { ...heredoc.bodySpan },
      site: "heredoc-body",
    };
  }
  return null;
}

/**
 * Arm 3. A match the argv view does not carry at all — an assignment value
 * (`FOO='id_rsa' printenv`), a `for` list word — is decided by the SAME
 * excision judgment `scanTextForSensitivePath` already applies to it, so
 * the two never answer differently about one span. An excised span (a
 * comment, a proven-inert receiver's quoted body) is data and produces no
 * finding; a span the parse kept is a live target the consumer inherits.
 * A span an argv word already covers is NOT re-read here: arms 1 and 2
 * own every argv word, and a code operand they declined to confirm must
 * not be re-priced as a target by this arm.
 */
function inertSpanEvidence(
  parse: SecurityParseOk
): SensitivePathEvidence | null {
  const argvCovered = argvSpans(parse);
  for (const span of parse.inert) {
    if (isCoveredBy(argvCovered, span.span)) continue;
    const text = spanText(parse.text, span.span);
    if (text === undefined) continue;
    const hit = sensitiveFragmentAt(text, 0);
    if (hit === null) continue;
    return spanExcisedFromSensitiveDeny(span, parse)
      ? { class: "non_path", fragment: hit.fragment }
      : {
          class: "confirmed",
          fragment: hit.fragment,
          span: { ...span.span },
          site: "code-region",
        };
  }
  return null;
}

/** Every span the parse attributes to an argv word or a redirect target. */
function argvSpans(parse: SecurityParseOk): FactSpan[] {
  const argvCovered: FactSpan[] = [];
  for (const node of parse.commands) {
    for (const word of node.argv) argvCovered.push(word.span);
  }
  for (const redirect of parse.redirects) argvCovered.push(redirect.target.span);
  return argvCovered;
}

/** Whether `span` sits inside one of the spans the argv view already carries. */
function isCoveredBy(covered: FactSpan[], span: FactSpan): boolean {
  return covered.some(
    (other) => other.start <= span.start && other.end >= span.end
  );
}

/**
 * Arm 3b. A match in text the argv view does not carry as a word and the parse
 * does not mark inert — a `for` list word, an `export` assignment
 * value, a `case` pattern. The parse MODELLED this region (it is `ok`,
 * not `unknown-syntax`), so the match is a live token of a modelled
 * command rather than a comment or an unparsed body, and the shell will
 * expand it. Fail toward the target: this is the residual of the command
 * text that no earlier arm could attribute, and today's wall denied it.
 */
function unattributedGapEvidence(
  parse: SecurityParseOk
): SensitivePathEvidence | null {
  const attributed: FactSpan[] = argvSpans(parse);
  for (const span of parse.inert) attributed.push(span.span);
  for (const heredoc of parse.heredocs) attributed.push(heredoc.bodySpan);
  let cursor = 0;
  const gaps: FactSpan[] = [];
  for (const span of [...attributed].sort((a, b) => a.start - b.start)) {
    if (span.start > cursor) gaps.push({ start: cursor, end: span.start });
    cursor = Math.max(cursor, span.end);
  }
  if (cursor < parse.text.length) gaps.push({ start: cursor, end: parse.text.length });
  for (const gap of gaps) {
    const text = spanText(parse.text, gap);
    if (text === undefined) continue;
    const hit = sensitiveFragmentAt(text, 0);
    if (hit === null) continue;
    return {
      class: "confirmed",
      fragment: hit.fragment,
      span: gap,
      site: "code-region",
    };
  }
  return null;
}

/**
 * Arm 4. A match the parse could not place anywhere: the fail-toward-deny arm.
 * A parse whose own spans contradict its text is the one this wall has
 * always refused to interpret, and that judgment does not change here.
 */
function untrustworthySpanEvidence(
  parse: SecurityParseOk
): SensitivePathEvidence | null {
  if (spansAreTrustworthy(parse, parse.text)) return null;
  const fragment = sensitiveFragmentHit(parse.text);
  if (fragment === null) return null;
  return {
    class: "confirmed",
    fragment,
    span: { start: 0, end: parse.text.length },
    site: "code-region",
  };
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
    // ADR-0131: the `unresolved` class this scan's own siblings above cannot
    // see. A code-consuming receiver (`node`, `python3`) is on the ownership-
    // established roster, so `commandNodeReview` prices its OPERANDS and finds
    // nothing to price — but the sensitive wall classified a match inside that
    // receiver's source as unresolved, and that question belongs to the review.
    // The classification runs first so the two tiers cannot disagree: a
    // `confirmed` match has already denied above this layer, and a `non_path`
    // one asks nothing of anybody.
    const evidence = classifySensitivePathEvidence(command);
    if (evidence.class === "unresolved") {
      return {
        verdict: "review",
        requirement: reviewRequirement(
          "data-ownership-unresolved",
          evidence.span,
          `a security-relevant match \`${evidence.fragment}\` sits in a ${evidence.site} the receiver is not proven to consume as a file`
        ),
      };
    }
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
