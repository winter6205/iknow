/**
 * Single-file path extractor for whitelisted read-only bash commands
 * (ADR-0084).
 *
 * `write_file`'s last-read ledger needs to record "successful bash reads",
 * but `bash.ts` treats the command as an opaque string handed to the
 * sandbox — no existing component returns the path that was read.
 * `validateReadonlyCommand` is the gate for read-only *mode* admission
 * (it only answers "may this run"), and `classifyCall`'s bash branch only
 * answers read/mutate (the physical ro-bind fence owns write decisions) —
 * neither returns a path, hence this dedicated small extractor.
 *
 * Decision (returns the path only when ALL hold, else `undefined`):
 *   1. the security parse is `ok` and carries exactly ONE depth-0 command
 *      unit, with no `;` / `&&` / `||` / `|` operator region around it —
 *      rules out pipes and chaining (SC-S4-1: the parse facts replace the
 *      old `splitShellSegments` text segmentation; substitution bodies are
 *      depth > 0 and never count as the unit);
 *   2. no redirection (`redirects[]`) and no command substitution
 *      (`substitutions[]`) on the parse — plus the retained word-text veto
 *      for `` ` `` / `$` / `<` / `>` inside operand words (see
 *      `hasRedirectOrSubstitution`);
 *   2b. every non-`ok` verdict (`unknown-syntax` / `malformed` / `aborted`
 *      / `over-cap` / `parser-unavailable`) and the pre-parse `vetoed` arm
 *      record NOTHING — `undefined`, no text fallback
 *      (`docs/shell-parse-non-ok-consumer-contracts.md`, SC-S4-1: a ledger
 *      record is an affordance, recording nothing is always the stricter
 *      side);
 *   3. first token in the whitelist: `cat` / `nl` / `bat` / `batcat` /
 *      `head` / `tail` / `sed -n 'X,Yp'` / `grep` / `egrep` / `fgrep` / `rg`;
 *   4. no "print-then-exit, never touches operands" flags (`--help` /
 *      `--version` family, see `NON_READ_FLAGS`) — these exit 0 without
 *      the file ever being opened;
 *   5. after operand parsing exactly ONE file operand remains (`grep` /
 *      `rg`'s first operand is the pattern; `sed`'s first operand after
 *      `-n` is the script — neither counts as a file);
 *   6. the operand has no glob metacharacters — `cat *.txt` expands to
 *      shell words, not "one file path"; recording it would add noise keys
 *      that never match.
 *
 * The direction is fail-closed: no unique extractable path → no recording.
 * A missed entry merely costs the model one extra read; a wrong entry lets
 * an unread non-empty file be overwritten — the two directions' costs are
 * asymmetric.
 *
 * The criteria are **shape** (whitelisted command + exactly one concrete
 * file operand + no short-circuit flag + no suppressing flag), not observed
 * output: the `head -n 0` / `head -c 0` / `tail -n 0` family exits 0 without
 * printing anything yet still records by shape. Zero-window values are not
 * parsed here — `-n` / `-c` signed semantics diverge across commands
 * (`head -n -0` prints the whole file, `tail -n -0` prints nothing), and a
 * blanket rejection would falsely deny shapes that genuinely read content
 * (`head -n 0 -c 5` prints 5 bytes).
 */

import { firstToken } from "../../permission/hard-walls.js";
import {
  parseForSecurity,
  segmentCutRegions,
  segmentRegionLeader,
  type CommandFact,
  type FactSpan,
  type SecurityParseOk,
} from "../../permission/shell-parse.js";

/** Whitelisted read-only commands. */
const READ_COMMANDS: ReadonlySet<string> = Object.freeze(
  new Set([
    "cat",
    "nl",
    "bat",
    "batcat",
    "head",
    "tail",
    "sed",
    "grep",
    "egrep",
    "fgrep",
    "rg",
  ])
);

/**
 * Per-command flags that "swallow the next token as a value". Only affects
 * operand placement: the value token is no longer mistaken for a file.
 * An incomplete table errs toward missed records (the value counts as a
 * second operand → more than one → no recording), never wrong records.
 */
const NL_ARG_FLAGS: ReadonlySet<string> = Object.freeze(
  new Set([
    "-b",
    "-d",
    "-f",
    "-h",
    "-i",
    "-l",
    "-n",
    "-s",
    "-v",
    "-w",
    "--body-numbering",
    "--section-delimiter",
    "--footer-numbering",
    "--header-numbering",
    "--page-increment",
    "--line-number-format",
    "--number-separator",
    "--starting-line-number",
    "--number-width",
  ])
);

/** bat / batcat are aliases of the same tool; identical flag tables. */
const BAT_ARG_FLAGS: ReadonlySet<string> = Object.freeze(
  new Set([
    "-l",
    "-m",
    "-r",
    "--language",
    "--theme",
    "--style",
    "--tabs",
    "--line-range",
    "--terminal-width",
    "--wrap",
    "--file-name",
    "--diff-context",
    "--map-syntax",
    "--pager",
    "--config-file",
    "--config",
    "--cache-dir",
  ])
);

/** head / tail share an identical flag table. */
const HEAD_TAIL_ARG_FLAGS: ReadonlySet<string> = Object.freeze(
  new Set(["-n", "-c", "--lines", "--bytes"])
);

/** egrep / fgrep are grep pattern aliases (-E / -F); use grep's table. */
const GREP_ARG_FLAGS: ReadonlySet<string> = Object.freeze(
  new Set([
    "-e",
    "-f",
    "-m",
    "-A",
    "-B",
    "-C",
    "-d",
    "-D",
    "--regexp",
    "--file",
    "--max-count",
    "--after-context",
    "--before-context",
    "--context",
    "--directories",
    "--devices",
    "--exclude-from",
    "--label",
  ])
);

const RG_ARG_FLAGS: ReadonlySet<string> = Object.freeze(
  new Set([
    "-e",
    "-f",
    "-m",
    "-A",
    "-B",
    "-C",
    "-g",
    "-t",
    "-T",
    "-j",
    "-M",
    "-r",
    // `-d` / `-E` are value-swallowing short flags the earlier table
    // missed (verified on vendored rg 15.1.0: `rg -d 1 a.txt` treats a.txt
    // as the pattern, not the file). Without swallowing the value, the
    // extractor would record the pattern-position token as "read".
    "-d",
    "-E",
    "--regexp",
    "--file",
    "--max-count",
    "--after-context",
    "--before-context",
    "--context",
    "--glob",
    "--type",
    "--type-not",
    "--threads",
    "--max-columns",
    "--context-separator",
    "--field-context-separator",
    "--field-match-separator",
    "--max-depth",
    "--max-filesize",
    "--encoding",
    "--engine",
    "--sort",
    "--colors",
    "--color",
    "--replace",
    "--pre",
    // `--pre-glob <GLOB>` swallows a value (verified on vendored rg
    // 15.1.0). Missing it from this table drops the value token into
    // operands → count skew → the whole command rejected (a miss-direction
    // false negative). Semantically it only filters which files pass
    // through `--pre`'s COMMAND, producing no fabricated view itself — so
    // it belongs in the value-swallowing table only, never the
    // suppressing table.
    "--pre-glob",
    "--hostname-bin",
  ])
);

const ARG_TAKING_FLAGS: Readonly<Record<string, ReadonlySet<string>>> =
  Object.freeze({
    cat: Object.freeze(new Set<string>()),
    nl: NL_ARG_FLAGS,
    bat: BAT_ARG_FLAGS,
    batcat: BAT_ARG_FLAGS,
    head: HEAD_TAIL_ARG_FLAGS,
    tail: HEAD_TAIL_ARG_FLAGS,
    sed: Object.freeze(
      new Set(["-e", "-f", "-i", "--expression", "--file", "--in-place"])
    ),
    grep: GREP_ARG_FLAGS,
    egrep: GREP_ARG_FLAGS,
    fgrep: GREP_ARG_FLAGS,
    rg: RG_ARG_FLAGS,
  });

/**
 * Blacklist of flags that "suppress file content output on first hit" or
 * "edit the file in place". A match rejects the whole command — exit 0 for
 * these still does not mean the model saw the current state:
 *   - grep family: `-q/--quiet/--silent` (silent), `-c/--count` (counts
 *     only), `-l/--files-with-matches` (names only), `--files-without-match`,
 *     `-o/--only-matching` (fragments only);
 *   - rg adds `--count-matches` / `--files` on top of the grep family;
 *   - sed: any `-i` / `--in-place` form — the in-place rewrite means the
 *     file content is no longer what was read (`sed -n -i.bak -e 1,2p f`
 *     really modifies disk).
 * Direction stays fail-closed: a miss costs one extra read; a wrong record
 * would let an unread non-empty file be overwritten — asymmetric costs.
 */
const GREP_CONTENT_SUPPRESSING_FLAGS: ReadonlySet<string> = Object.freeze(
  new Set([
    "-q",
    "--quiet",
    "--silent",
    "-c",
    "--count",
    "-l",
    "--files-with-matches",
    "--files-without-match",
    "-o",
    "--only-matching",
  ])
);

/**
 * `-L` semantics diverge per command, so it cannot join the shared set: in
 * the grep family it is `--files-without-match` (names only, content
 * suppressed), in rg it is `--follow` (follows symlinks, still prints
 * content). Mixing them would misjudge `rg -L needle f.ts` as "saw no
 * content" and miss the record.
 */
const GREP_ONLY_CONTENT_SUPPRESSING_FLAGS: ReadonlySet<string> = Object.freeze(
  new Set([...GREP_CONTENT_SUPPRESSING_FLAGS, "-L"])
);

const CONTENT_SUPPRESSING_FLAGS: Readonly<Record<string, ReadonlySet<string>>> =
  Object.freeze({
    grep: GREP_ONLY_CONTENT_SUPPRESSING_FLAGS,
    egrep: GREP_ONLY_CONTENT_SUPPRESSING_FLAGS,
    fgrep: GREP_ONLY_CONTENT_SUPPRESSING_FLAGS,
    rg: Object.freeze(
      new Set([
        ...GREP_CONTENT_SUPPRESSING_FLAGS,
        "--count-matches",
        "--files",
        // `-r` / `--replace` prints **post-substitution lines**, not the
        // disk original (verified on vendored rg 15.1.0: a file containing
        // `ZZMARK_ONLY_HERE` yields `INVENTED_ONLY_HERE` with `rg -r
        // INVENTED ZZMARK z.txt`) — the model sees a fabricated view,
        // worse than seeing nothing. Same class as `-o` (fragments only)
        // and `sed -i` (rewrite): read but not current state. Note `-r` is
        // "replace" only in rg; in the grep family it is recursive — the
        // per-command tables exist precisely to keep them from polluting
        // each other.
        "-r",
        "--replace",
        // `--pre COMMAND` makes rg search **COMMAND's output**, not the
        // file original (verified on vendored rg 15.1.0: `rg --pre rev PAT
        // a.txt` matches the reversed content; `=` form is identical).
        // `cat` as preprocessor happens to equal the original, but any
        // other command (rev / sed / script) yields a fabricated view —
        // same class as `-r`. The extractor rejects by **shape**, never
        // relying on one run happening to match. Exploitable end to end:
        // see model-invented text via `--pre` → file recorded → a later
        // `write_file` overwrites a never-really-read non-empty file.
        // `--pre-glob` is only `--pre`'s companion filter (selects which
        // files get preprocessed) and alone yields no fabricated view →
        // **not in this table**, handled as a value-swallowing flag only
        // (see RG_ARG_FLAGS); verified `rg --pre-glob '*.txt' PAT a.txt`
        // prints the disk original — a genuine read shape.
        "--pre",
      ])
    ),
    sed: Object.freeze(new Set(["-i", "--in-place"])),
  });

/**
 * Flags that "print then exit, **never touching the operands**" (help /
 * version / introspection output).
 *
 * This is a **different rejection reason** from `CONTENT_SUPPRESSING_FLAGS`
 * and stays separate in comments and implementation:
 *   - this table = "never read": the file was not opened, stdout holds only
 *     the tool's own text;
 *   - the suppressing table = "read but unseen": the file really was read,
 *     but output was cut by `-q` / `-c` / `-l`-style forms.
 * Merging them invites edits for the wrong reason ("`-c` is denied, so `-h`
 * should be too").
 *
 * **Per-command tables, never shared**: the same spelling means different
 * things — `grep -h` is `--no-filename` (**a normal read**), `rg -h` is
 * `--help`, `nl -h` is `--header-numbering` (swallows a value), uutils
 * `cat/head/tail -h` is `--help`. One shared table would necessarily hurt
 * one of them.
 *
 * Entries were verified on real machines where installed (uutils coreutils
 * 0.8.0 for cat / nl / head / tail, GNU grep 3.12, GNU sed 4.9, vendored
 * ripgrep 15.1.0); bat is not installed locally, so its entry is unverified
 * and listed from the CLI contract — fail-closed direction: a wrong call is
 * only a missed record, never letting an unread file pass the overwrite
 * gate.
 */
const NON_READ_FLAGS: Readonly<Record<string, ReadonlySet<string>>> =
  Object.freeze({
    // Verified uutils 0.8.0: `cat --help a.txt` / `-h` / `--version` / `-V`
    // all exit 0 printing only help/version text. Unambiguous long-flag
    // prefixes hold too (`cat --he a.txt`), covered by
    // `isDeniedLongPrefix`.
    cat: Object.freeze(new Set(["--help", "-h", "--version", "-V"])),
    // Verified uutils 0.8.0: `nl --help` / `--version` / `-V` exit 0 with
    // help/version on stdout. **`-h` excluded**: `nl -h` is
    // `--header-numbering` (swallows a value) and `nl -h n a.txt` really
    // prints the numbered file — listing it would reject a genuine read.
    nl: Object.freeze(new Set(["--help", "--version", "-V"])),
    // Verified uutils 0.8.0: `head -h` / `--help` / `-V` / `--version`
    // print no file content. **`-v` excluded**: `head -v` is verbose
    // ("==> a.txt <==" + full text), not help.
    head: Object.freeze(new Set(["--help", "-h", "--version", "-V"])),
    // tail shares head's table verbatim; verified `tail -v a.txt` prints
    // header + full text (so `-v` excluded), `tail -h/-V/--help/--version`
    // print no content (so listed).
    tail: Object.freeze(new Set(["--help", "-h", "--version", "-V"])),
    // bat / batcat not installed locally → **unverified**; introspection
    // flags listed from the CLI contract. Fail-closed: a wrong call only
    // misses a record.
    bat: Object.freeze(
      new Set([
        "--help",
        "-h",
        "--version",
        "-V",
        "--list-languages",
        "--list-themes",
      ])
    ),
    batcat: Object.freeze(
      new Set([
        "--help",
        "-h",
        "--version",
        "-V",
        "--list-languages",
        "--list-themes",
      ])
    ),
    // Verified GNU grep 3.12: `--help` / `--version` / `-V` print no match
    // lines. **`-h` excluded**: GNU grep's `-h` is `--no-filename` and
    // verified to print match lines identically — listing it would judge a
    // real read as unread. `grep --h PAT a.txt` is a valid `--help` prefix
    // (prints usage), covered by `isDeniedLongPrefix`.
    grep: Object.freeze(new Set(["--help", "--version", "-V"])),
    egrep: Object.freeze(new Set(["--help", "--version", "-V"])),
    fgrep: Object.freeze(new Set(["--help", "--version", "-V"])),
    // Verified GNU sed 4.9: `--help` / `--version` exit 0 with no file
    // content, **position-independent** (`sed -n 1,2p --help a.txt` prints
    // usage). `-h` / `-V` excluded: real `sed -h` / `sed -V` exit 1 (the
    // exit gate already rejects them upstream).
    sed: Object.freeze(new Set(["--help", "--version"])),
    // Verified vendored ripgrep 15.1.0: `--help` / `-h` / `--version` /
    // `-V` / `--type-list` / `--generate` exit 0 with no file content.
    // **`-v` excluded**: rg's `-v` is `--invert-match`, verified to still
    // print lines.
    rg: Object.freeze(
      new Set(["--help", "-h", "--version", "-V", "--type-list", "--generate"])
    ),
  });

/**
 * Per-command union of all "known flags" (value-swallowing ∪ suppressing ∪
 * non-read tables).
 *
 * **Used only for disambiguation, never as a deny set**: GNU getopt's rule
 * is "exact match first; unambiguous-prefix expansion only without an exact
 * match". Without this layer, `--type-list` (non-read table) would make
 * `--type` (a legitimate rg value-swallowing flag) count as a "prefix hit"
 * and reject the whole command — verified `rg --type ts PAT a.txt` is a
 * genuine read; falsely rejecting it creates exactly the "same semantics,
 * two spellings, two verdicts" second face this module exists to kill.
 *
 * The table is narrower than a real option table → prefix expansion fires
 * more easily → the stricter side is a missed record, not a wrong one.
 */
const KNOWN_FLAGS: Readonly<Record<string, ReadonlySet<string>>> =
  Object.freeze(buildKnownFlags());

function buildKnownFlags(): Record<string, ReadonlySet<string>> {
  const out: Record<string, ReadonlySet<string>> = {};
  for (const command of READ_COMMANDS) {
    out[command] = Object.freeze(
      new Set<string>([
        ...(ARG_TAKING_FLAGS[command] ?? []),
        ...(CONTENT_SUPPRESSING_FLAGS[command] ?? []),
        ...(NON_READ_FLAGS[command] ?? []),
      ])
    );
  }
  return out;
}

/** A recursive read spans multiple files / directories — not "read one
 *  specific file"; no recording. */
const RECURSIVE_FLAGS: ReadonlySet<string> = Object.freeze(
  new Set(["-r", "-R", "--recursive", "--dereference-recursive"])
);

/** Shape of `sed -n 'X,Yp'` scripts (line-range print). */
const SED_RANGE_SCRIPT = /^\d+(,\d+)?p$/;

/** Flags marking that `sed` runs in "quiet + explicit script" form. */
const SED_QUIET_FLAGS: ReadonlySet<string> = Object.freeze(
  new Set(["-n", "--quiet", "--silent"])
);

/** Glob metacharacters — operand is not a single concrete path. */
const GLOB_METACHARS = /[*?[{]/;

interface OperandWalk {
  readonly operands: ReadonlyArray<string>;
  readonly flags: ReadonlySet<string>;
  /**
   * Value-swallowing flags with their values (`-e 1,2p` → `{-e, 1,2p}`),
   * kept **in order, one entry per occurrence**. Values are not in
   * `operands`, so callers that audit values semantically (`sed`'s script
   * shape) read them from here. A list, not a map: repeated flags
   * (`sed -e d -e 1,2p`) are multiple script sources; collapsing to one
   * would misjudge "d then p" as a single `1,2p`.
   */
  readonly flagValues: ReadonlyArray<{
    readonly flag: string;
    readonly value: string;
  }>;
}

/** Accumulator for walkOperands: grows token by token during placement. */
interface OperandAccumulator {
  readonly command: string;
  readonly argFlags: ReadonlySet<string>;
  readonly flags: Set<string>;
  readonly flagValues: Array<{ flag: string; value: string }>;
  readonly operands: string[];
}

/**
 * Consume one token (`i` points at it), return the next index. Everything
 * after `--` is operands (GNU convention: option terminator).
 *
 * **Normalize before table lookups**: `--g` (rg's single-letter double-dash
 * alias) and `-g` are the same flag and must get the same placement verdict.
 * The original implementation looked up `ARG_TAKING_FLAGS` with the
 * **pre-normalization** raw token, so `rg --g '*.ts' PAT f`'s value token
 * was not swallowed into `flagValues` but landed in `operands` — the count
 * skew then happened to yield "exactly one", recording the pattern-position
 * token as read. Normalization lives in **one place**; no second face.
 */
function consumeOperandToken(
  tokens: ReadonlyArray<string>,
  i: number,
  acc: OperandAccumulator
): number {
  const token = tokens[i]!;
  if (token === "--") {
    acc.operands.push(...tokens.slice(i + 1));
    return tokens.length;
  }
  if (token.startsWith("-") && token.length > 1) {
    const norm = normalizeFlagToken(token, acc.command);
    acc.flags.add(norm.token);
    // `--flag=value` carries its own value; does not swallow the next token.
    if (acc.argFlags.has(norm.base) && norm.value === undefined) {
      const value = tokens[i + 1];
      if (value !== undefined) acc.flagValues.push({ flag: norm.token, value });
      return i + 2;
    }
    return i + 1;
  }
  acc.operands.push(token);
  return i + 1;
}

/**
 * Tokenize a segment (respecting quotes and backslash escapes) and place
 * operands per the command's flag table. Unclosed quote → `undefined`
 * (unreliable placement, miss the record).
 */
function walkOperands(
  segment: string,
  command: string
): OperandWalk | undefined {
  const tokens = tokenize(segment);
  if (tokens === undefined || tokens.length === 0) return undefined;
  const acc: OperandAccumulator = {
    command,
    argFlags: ARG_TAKING_FLAGS[command] ?? new Set<string>(),
    flags: new Set<string>(),
    flagValues: [],
    operands: [],
  };
  for (let i = 1; i < tokens.length;) {
    i = consumeOperandToken(tokens, i, acc);
  }
  return {
    operands: acc.operands,
    flags: acc.flags,
    flagValues: acc.flagValues,
  };
}

/** One step of the tokenize state machine at `segment[i]`; returns next index. */
interface TokenizeState {
  readonly tokens: string[];
  current: string;
  started: boolean;
  quote: "'" | '"' | null;
}

/**
 * Letter sequence of a combined short flag (`grep -rn` / `sed -ni`);
 * non-cluster form → `undefined`. Each letter in a cluster is an
 * independent flag, so checks must expand per letter rather than match the
 * whole string.
 */
function shortFlagCluster(flag: string): string | undefined {
  const match = /^-([a-zA-Z]{2,})$/.exec(flag);
  return match?.[1];
}

/**
 * GNU getopt accepts **unambiguous prefixes** of long flags: `grep --qui`
 * means `--quiet` (verified on GNU grep 3.12 / GNU sed 4.9). Exact-equality
 * checks alone would let `--qui` / `--cou` / `--files-with-match` /
 * `--in-pla` through, recording "saw no content" as read or an in-place
 * rewrite as a read.
 *
 * Deny only when **exactly one** blacklist entry starts with `base` —
 * isomorphic to GNU's "unambiguous": `--files-with-m` uniquely points at
 * `--files-with-matches` → deny; `--files-with` prefixes both matches /
 * without-match → GNU reports ambiguity and exits != 0 (never recorded
 * anyway), so no denial here; `--file` (a legitimate pattern-file flag)
 * survives via the same unambiguity rule. The check runs only within this
 * command's blacklist — narrower than GNU's full option table, so the
 * stricter side is a missed record (one extra read), never a wrong one.
 */
function isDeniedLongPrefix(base: string, deny: ReadonlySet<string>): boolean {
  if (!base.startsWith("--")) return false;
  let found = false;
  for (const entry of deny) {
    if (!entry.startsWith("--") || !entry.startsWith(base)) continue;
    if (found) return false;
    found = true;
  }
  return found;
}

/**
 * Syntactic normalization of flag tokens — the module's **only** place for
 * this.
 *
 * Two forms:
 *   1. ripgrep (clap) **single-letter double-dash aliases**: `--c` is `-c`,
 *      `--g` is `-g`, `--q` is `-q`. Verified on vendored rg 15.1.0: `rg --c`
 *      prints only counts, `--l` only filenames, `--q` empty stdout (all
 *      exit 0); for X ∈ {g,t,m,j,M,r,f,e,A,B,C,d,E,T}, `rg --X VALUE PAT f`
 *      and `rg -X VALUE PAT f` output byte-identically.
 *   2. `--flag=value` for all commands → `{base: "--flag", value: "value"}`.
 *
 * Rule 1 holds **for ripgrep only**: GNU grep 3.12 reports `--c` / `--l` as
 * ambiguous and GNU sed 4.9 reports `--c` as unrecognized (both exit != 0
 * on real machines, so bash's exit-0 gate never records them anyway) —
 * grafting short-flag semantics onto syntactically different GNU tools
 * would cause false rejections.
 *
 * The normalized form (not the raw token) is the **single comparison basis
 * shared by placement tables and deny sets**: the original implementation
 * normalized only on the blacklist side while `consumeOperandToken` looked
 * up raw tokens, so `rg --g '*.ts' PAT f`'s value was not swallowed and the
 * count skew recorded the pattern as a file. With one shared function, a
 * second face like "blacklist normalized, arity not" can no longer appear.
 *
 * Rule 1 is applied **uniformly per letter**, with no exceptions for
 * individual letters: verified `rg --h PAT a.txt` exits 0 and **prints
 * match lines** (not equivalent to `-h`'s short help), yet the uniform rule
 * normalizes it to `-h` and denies — that is the miss direction (one extra
 * read), not a wrong record. A per-letter exception table would degrade the
 * rule into enumeration where each omission becomes a wrong record (the
 * dangerous direction).
 */
function normalizeFlagToken(
  token: string,
  command: string
): { readonly token: string; readonly base: string; readonly value?: string } {
  const eq = token.startsWith("--") ? token.indexOf("=") : -1;
  const raw = eq > 0 ? token.slice(0, eq) : token;
  const value = eq > 0 ? token.slice(eq + 1) : undefined;
  const base = canonicalShortAlias(raw, command);
  return {
    token: value === undefined ? base : `${base}=${value}`,
    base,
    ...(value === undefined ? {} : { value }),
  };
}

/**
 * ripgrep single-letter double-dash alias → the short flag (`--g` → `-g`).
 * Non-single-letter forms (`--co`, which rg reports as unrecognized) are
 * returned unchanged — no over-generalization.
 */
function canonicalShortAlias(flag: string, command: string): string {
  if (command !== "rg") return flag;
  const match = /^--([a-zA-Z])$/.exec(flag);
  return match === null ? flag : `-${match[1]}`;
}

/**
 * Does this flag hit the deny set (covering alias normalization, combined
 * short-flag expansion, `--flag=value` tail-stripping, and unambiguous
 * long-flag prefixes)?
 *
 * `known` (the command's full known-flag union) is for disambiguation only:
 * GNU getopt prefers exact matches and expands prefixes only without one.
 * Without it, `--type` (a legal rg value-swallowing flag) would be falsely
 * denied via a `--type-list` prefix hit — verified `rg --type ts PAT
 * a.txt` prints file content, a genuine read shape.
 */
function matchesDeniedFlag(
  flag: string,
  deny: ReadonlySet<string>,
  command: string
): boolean {
  const norm = normalizeFlagToken(flag, command);
  if (deny.has(norm.base)) return true;
  // Exact hit on another known flag of this command → no prefix expansion
  // (GNU getopt's precedence).
  if (KNOWN_FLAGS[command]?.has(norm.base) === true) return false;
  // `--flag=value` and `--flag` both take the prefix-expansion path:
  // `sed --in-pla=.bak` really modifies disk.
  if (isDeniedLongPrefix(norm.base, deny)) return true;
  const cluster = shortFlagCluster(norm.base);
  if (cluster !== undefined) {
    return [...cluster].some((letter) => deny.has(`-${letter}`));
  }
  // Single-letter flag with attached value (`sed -i.bak`): the first letter
  // is the flag itself.
  return (
    !norm.base.startsWith("--") &&
    norm.base.length > 2 &&
    deny.has(norm.base.slice(0, 2))
  );
}

/** Did the command carry a "content-suppressing / in-place-edit" flag → read ≠ saw current state. */
function hasContentSuppressingFlag(
  command: string,
  flags: ReadonlySet<string>
): boolean {
  const deny = CONTENT_SUPPRESSING_FLAGS[command];
  if (deny === undefined) return false;
  for (const flag of flags) {
    if (matchesDeniedFlag(flag, deny, command)) return true;
  }
  return false;
}

/**
 * Did the command carry a "print-then-exit, operands never opened" flag
 * (help / version / introspection)?
 *
 * A **separate rejection reason** from `hasContentSuppressingFlag`: this
 * one answers "never read", that one "read but unseen". Checked in
 * `selectFileOperand` **before** the content-suppression test; comments and
 * rationales stay independent, never merged.
 */
function hasNonReadFlag(command: string, flags: ReadonlySet<string>): boolean {
  const deny = NON_READ_FLAGS[command];
  if (deny === undefined) return false;
  for (const flag of flags) {
    if (matchesDeniedFlag(flag, deny, command)) return true;
  }
  return false;
}

function stepQuoted(state: TokenizeState, segment: string, i: number): number {
  const ch = segment[i]!;
  if (ch === state.quote) {
    state.quote = null;
  } else {
    state.current += ch;
  }
  return i + 1;
}

function stepEscape(state: TokenizeState, segment: string, i: number): number {
  const next = segment[i + 1];
  if (next === undefined) return -1;
  state.current += next;
  state.started = true;
  return i + 2;
}

function stepSpace(state: TokenizeState): void {
  if (!state.started) return;
  state.tokens.push(state.current);
  state.current = "";
  state.started = false;
}

/**
 * Quote-aware whitespace split. In `sed -n '1,10p' f` the spaced script is
 * one token. Unclosed quote / dangling trailing backslash → `undefined`.
 */
function tokenize(segment: string): string[] | undefined {
  const state: TokenizeState = {
    tokens: [],
    current: "",
    started: false,
    quote: null,
  };
  for (let i = 0; i < segment.length;) {
    const ch = segment[i]!;
    if (state.quote !== null) {
      i = stepQuoted(state, segment, i);
      continue;
    }
    if (ch === "'" || ch === '"') {
      state.quote = ch;
      state.started = true;
      i += 1;
      continue;
    }
    if (ch === "\\") {
      i = stepEscape(state, segment, i);
      if (i < 0) return undefined;
      continue;
    }
    if (/\s/.test(ch)) {
      stepSpace(state);
      i += 1;
      continue;
    }
    state.current += ch;
    state.started = true;
    i += 1;
  }
  if (state.quote !== null) return undefined;
  if (state.started) state.tokens.push(state.current);
  return state.tokens;
}

/**
 * Does the unit carry redirection / command substitution in its WORD TEXT?
 * `<` `>` are always rejected (no redirection), as are `` ` `` and `$`
 * (command substitution / variable expansion — the path is no longer a
 * literal).
 *
 * This is the text-word arm of the veto; the operator arm is facts-driven
 * on the `ok` path (`soleReadSegment` reads `redirects[]` /
 * `substitutions[]` from the parse). The regex stays because a quote layer
 * hides metacharacters from the facts: `cat 'a<b'` and `cat $(echo a.ts)`
 * carry `<` / `$` inside the raw word text, and both must stay rejected as
 * today (`docs/shell-parse-non-ok-consumer-contracts.md`, SC-S4-1's
 * structural-_plus_-textual veto). The non-`ok` arms never reach this
 * function — they record nothing outright.
 */
function hasRedirectOrSubstitution(segment: string): boolean {
  return /[<>`$]/.test(segment);
}

/**
 * The single-unit segment the text pipeline may judge, derived from the
 * parse facts: exactly one depth-0 command, no redirect, no substitution,
 * no background operator, and no other non-blank text inside the unit's
 * operator-delimited region (a trailing comment, redirect, or `|&` that
 * the old segment carried as operand skew abstains here too). A unit led
 * by a non-argv word — a prefix assignment, a leading redirect — keeps
 * today's abstention (the same rule `commandTokenRun` carries in
 * hard-walls.ts): the splitter named that leading word and never judged
 * this command, so the ledger records nothing. The cut set and the
 * region-leader derivation are the shared `shell-parse` projection
 * (`segmentCutRegions` / `segmentRegionLeader`), also used by
 * `role-substitution.ts`.
 *
 * `undefined` = no single-unit read shape.
 */
function soleReadSegment(parse: SecurityParseOk): string | undefined {
  if (hasLedgerVetoFacts(parse)) return undefined;
  const unit = soleDepth0Command(parse);
  if (unit === undefined) return undefined;
  const region = cutRegionCovering(parse, unit.span);
  if (region === undefined) return undefined;
  // The leader claims are the unit's own: a depth-0 cut overlapping the
  // unit's span leaves no covering region (no such shape on an `ok` parse,
  // and an ambiguity must veto, not guess), and the leader checks carry the
  // before-blank and argv-leading abstentions.
  if (segmentRegionLeader(parse, region) === undefined) return undefined;
  if (parse.text.slice(unit.span.end, region.end).trim() !== "") {
    return undefined;
  }
  return parse.text.slice(unit.span.start, unit.span.end);
}

/** The facts vetoes: any redirect, substitution, heredoc, or background
 * operator ends the single-unit read shape. */
function hasLedgerVetoFacts(parse: SecurityParseOk): boolean {
  return (
    parse.redirects.length > 0 ||
    parse.substitutions.length > 0 ||
    parse.heredocs.length > 0 ||
    parse.operators.some((operator) => operator.kind === "background")
  );
}

/** The one depth-0 command, or `undefined` when zero or several exist. */
function soleDepth0Command(parse: SecurityParseOk): CommandFact | undefined {
  let sole: CommandFact | undefined;
  for (const command of parse.commands) {
    if (command.depth !== 0) continue;
    if (sole !== undefined) return undefined;
    sole = command;
  }
  return sole;
}

/** The segment-cut region that fully covers `span`, or `undefined` when a
 * cut falls inside the span. */
function cutRegionCovering(
  parse: SecurityParseOk,
  span: FactSpan
): FactSpan | undefined {
  for (const region of segmentCutRegions(parse)) {
    if (region.start <= span.start && span.end <= region.end) return region;
  }
  return undefined;
}

/**
 * Extract the literal "single file path read" from a bash command.
 * Not extractable → `undefined` (caller records nothing).
 */
export function extractSingleReadPath(command: string): string | undefined {
  const parse = parseForSecurity(command);
  // Non-`ok` arm: every rejection — `unknown-syntax`, `malformed`,
  // `aborted`, `over-cap`, `parser-unavailable`, and the pre-parse
  // `vetoed` — records nothing. No splitter fallback stands behind it
  // (SC-S4-1; docs/shell-parse-non-ok-consumer-contracts.md): reaching
  // this function from the ledger path at bash.ts, where no wall
  // pre-emption runs in front of it, is exactly why `malformed` and the
  // other verdicts are answered here and not inherited.
  if (parse.kind !== "ok") return undefined;
  const segment = soleReadSegment(parse);
  if (segment === undefined) return undefined;
  if (hasRedirectOrSubstitution(segment)) return undefined;
  const commandName = firstToken(segment);
  if (!READ_COMMANDS.has(commandName)) return undefined;
  const walk = walkOperands(segment, commandName);
  if (walk === undefined) return undefined;
  const operand = selectFileOperand(commandName, walk);
  if (operand === undefined) return undefined;
  if (GLOB_METACHARS.test(operand)) return undefined;
  return operand;
}

/**
 * Select the "file" operand from the remaining operands per command shape.
 * Returns only when exactly one is selected.
 *
 *   - `sed`: `-n` must be present; the script comes either from `-e` (then
 *     the remaining operands, exactly one, = the file) or as the first
 *     operand matching `X,Yp` (then the second operand = the file).
 *   - `grep` / `rg` family: the first operand is the pattern (unless `-e`
 *     already supplied it); exactly one remaining operand is the file; any
 *     recursive flag rejects outright.
 *   - everything else: exactly one remaining operand is the file.
 */
function selectFileOperand(
  command: string,
  walk: OperandWalk
): string | undefined {
  const { operands, flags } = walk;
  // Two independent rejection reasons, ordered "reject never-read first,
  // then reject read-but-unseen":
  //   1. non-read short-circuit (`cat --help f`): file never opened, stdout
  //      is only the tool's own text;
  //   2. content suppression / in-place edit (`grep -q` / `sed -i`): the
  //      file was read but output was cut or the file rewritten — neither
  //      is "saw the current state".
  if (hasNonReadFlag(command, flags)) return undefined;
  if (hasContentSuppressingFlag(command, flags)) return undefined;
  if (command === "sed") return selectSedFile(walk);
  if (isRecursiveRead(command, flags)) return undefined;
  if (isGrepFamily(command)) {
    const files = hasPatternSourceFlag(flags) ? operands : operands.slice(1);
    return files.length === 1 ? files[0] : undefined;
  }
  return operands.length === 1 ? operands[0] : undefined;
}

/** grep / egrep / fgrep / rg — the family whose first operand is the pattern. */
function isGrepFamily(command: string): boolean {
  return (
    command === "grep" ||
    command === "egrep" ||
    command === "fgrep" ||
    command === "rg"
  );
}

/**
 * `sed -n` script-source review: `-e` / `--expression` (including `=` forms)
 * and the positional script (`sed -n 1,2p f`) are several entry points of
 * one criterion — shared through this function so two regexes cannot drift
 * apart and leak one entry.
 *
 * `rangeOnly`: **every** script source is an `X,Yp` line-range print. Any
 * non-conforming source (verified GNU sed 4.9: `-n -e d` and `-n -e 's/e/E/'`
 * both exit 0 with empty stdout — a substitution without `p` prints nothing
 * in quiet mode) means "not the disk's current state", just an empty
 * exit-0 read. `-f` / `--file` (script file) likewise fails: the script
 * lives elsewhere on disk and this extractor does not follow it — verified
 * `sed -n -f delete.sed -e 1,2p f` exits 0 with empty stdout (`d` leaves
 * `p` nothing to print); checking only `-e`'s value would misrecord it.
 *
 * `fromFlag`: the script came from a flag → its value is not in operands,
 * so exactly one remaining operand is the file.
 */
interface SedScriptReview {
  readonly fromFlag: boolean;
  readonly rangeOnly: boolean;
}

/** Script from a flag (`-e`) or a script file (`-f`) — value not in operands. */
function isScriptSourceFlag(flag: string): boolean {
  return (
    flag === "-e" ||
    flag === "--expression" ||
    flag.startsWith("--expression=") ||
    flag === "-f" ||
    flag === "--file" ||
    flag.startsWith("--file=")
  );
}

/**
 * Does a value-swallowing flag prove the script is not a line-range print?
 *
 *   - `-f` / `--file` (script file): content lives elsewhere on disk,
 *     invisible to this extractor → fails the check;
 *   - `-e` / `--expression`: the value IS the script → test `SED_RANGE_SCRIPT`;
 *   - other value-swallowing flags (`-i` etc.): not script sources, out of
 *     this criterion.
 */
function scriptValueFailsRange(flag: string, value: string): boolean {
  if (flag === "-f" || flag === "--file") return true;
  if (flag !== "-e" && flag !== "--expression") return false;
  return !SED_RANGE_SCRIPT.test(value);
}

/** Does a `--flag=value` script source prove the script is not a line-range print? */
function inlineScriptFailsRange(flag: string): boolean {
  if (flag.startsWith("--file=")) return true;
  if (!flag.startsWith("--expression=")) return false;
  return !SED_RANGE_SCRIPT.test(flag.slice("--expression=".length));
}

function reviewSedScripts(walk: OperandWalk): SedScriptReview {
  let rangeOnly = true;
  for (const { flag, value } of walk.flagValues) {
    if (scriptValueFailsRange(flag, value)) rangeOnly = false;
  }
  for (const flag of walk.flags) {
    if (inlineScriptFailsRange(flag)) rangeOnly = false;
  }
  const fromFlag = [...walk.flags].some(isScriptSourceFlag);
  // Script not given by flags → positional operand[0] IS the script, same
  // shape criterion.
  if (!fromFlag) {
    const script = walk.operands[0];
    if (script === undefined || !SED_RANGE_SCRIPT.test(script)) {
      rangeOnly = false;
    }
  }
  return { fromFlag, rangeOnly };
}

function selectSedFile(walk: OperandWalk): string | undefined {
  const { operands, flags } = walk;
  const quiet = [...flags].some((flag) => SED_QUIET_FLAGS.has(flag));
  if (!quiet) return undefined;
  const scripts = reviewSedScripts(walk);
  if (!scripts.rangeOnly) return undefined;
  // Script from a flag → value not in operands, exactly one remaining
  // operand is the file; script from a positional operand → the second
  // operand is the file.
  const expected = scripts.fromFlag ? 1 : 2;
  if (operands.length !== expected) return undefined;
  return operands[operands.length - 1];
}

/**
 * The pattern was supplied by a flag (`-e` / `--regexp` / rg's `-f` /
 * `--file`) → the first positional operand is no longer the pattern but a
 * path.
 *
 * `-f` / `--file` (pattern from file) must be included: verified on vendored
 * rg 15.1.0, `rg -f pats.txt PAT a.txt` exits 2 with
 * `rg: PAT: No such file or directory` — after `-f`, positional arguments
 * are parsed **entirely** as paths; `rg -f pats.txt a.txt` exits 0 printing
 * a.txt (single-file read). The old implementation recognized only `-e`, so
 * it dropped the first positional as a pattern in `-f` scenarios and took
 * the second as the file — the count happened to yield "one" and recorded
 * wrongly.
 */
function hasPatternSourceFlag(flags: ReadonlySet<string>): boolean {
  for (const flag of flags) {
    if (
      flag === "-e" ||
      flag === "-f" ||
      flag === "--regexp" ||
      flag === "--file" ||
      flag.startsWith("--regexp=") ||
      flag.startsWith("--file=")
    ) {
      return true;
    }
  }
  return false;
}

/** grep / rg recursive reads span multiple files → not "read one file". */
function isRecursiveRead(command: string, flags: ReadonlySet<string>): boolean {
  if (!isGrepFamily(command)) return false;
  for (const flag of flags) {
    if (RECURSIVE_FLAGS.has(flag)) return true;
    // A combined short flag (`grep -rn`) containing r also means recursive.
    if (/^-[a-zA-Z]{2,}$/.test(flag) && flag.includes("r")) return true;
  }
  return false;
}

/**
 * The three deny tables + derived `KNOWN_FLAGS`, **test-only** structural
 * invariant assertions (drift lock).
 *
 * Invariant: every entry of every deny table must be in
 * `KNOWN_FLAGS[command]`. `KNOWN_FLAGS` is derived from
 * `[...ARG_TAKING_FLAGS, ...CONTENT_SUPPRESSING_FLAGS, ...NON_READ_FLAGS]`
 * so it holds today — the lock guards against **construction drift**: if a
 * fourth table is added, or a deny set is pulled out of the derivation,
 * `matchesDeniedFlag`'s "exact match precedes unambiguous prefix expansion"
 * loses that flag's disambiguation info and `--type` would be falsely
 * denied via `--type-list`'s prefix rule (or wrongly allowed). Tests walk
 * the three tables entry by entry so this coupling fires immediately on
 * change.
 *
 * Production code goes through `extractSingleReadPath` only — the
 * `__forTest` name prefix marks these constants as test surface.
 */
export const __forTestStructuralInvariant = Object.freeze({
  ARG_TAKING_FLAGS,
  CONTENT_SUPPRESSING_FLAGS,
  NON_READ_FLAGS,
  KNOWN_FLAGS,
});
