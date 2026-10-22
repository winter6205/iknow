/**
 * Pure CLI argument parsing (no I/O).
 */

import {
  isYoloRejectedCommand,
  rejectYoloForCommand,
  type YoloNonTuiEntryError,
} from "../harness/sandbox/yolo.js";
import {
  EVAL_STATE_FLAG,
  EVAL_STATE_RESUME_FLAG,
  isEvalStateEntry,
  rejectEvalStateConflict,
  rejectEvalStateEntry,
  type EvalStateFlagConflictError,
  type EvalStateUnsupportedEntryError,
} from "../harness/sandbox/eval-state.js";

/** The `--yolo` literal (valueless boolean flag). */
const YOLO_FLAG = "--yolo";

/**
 * ADR-0141: the `--no-sandbox` literal (valueless boolean flag). A second named
 * preset entry, not a variant spelling of `--yolo` — it declares one fewer axis
 * and therefore survives a permission change (spec §6).
 */
const NO_SANDBOX_FLAG = "--no-sandbox";

/**
 * The head tokens the dispatch at the bottom of `parseArgs` recognizes. Mirrors
 * that chain: a token at positional 0 that is not here is already the first word
 * of a bare `oneshot` query.
 *
 * The eval-state span reading depends on this table too (`splitEvalStateTokens`),
 * which is a name dependency and not a structural one — disclosed rather than
 * removed, because the table is not an open-ended flag set: it is the closed
 * dispatch vocabulary, and every entry is a head the chain below must match
 * anyway. A head added to the dispatch without an entry here would shift the
 * span. Pre-existing; this change did not introduce it.
 */
const SUBCOMMAND_HEADS: ReadonlySet<string> = new Set([
  "chat",
  "serve",
  "trace",
  "tui",
  "ask",
  "help",
]);

/**
 * The `--eval-state=<bool>` spelling of the posture flag.
 *
 * Accepted so the flag is never a token the parser does not recognize: an
 * unrecognized `--eval-state=true` used to fall through into the query, so the
 * run stayed fenced *and* the prompt carried garbage — a silent ignore, which is
 * the exact failure ADR-0130 §1's fail-loud rule exists to prevent. Recognized
 * here it goes through the same option-position rule and the same entry gate as
 * the bare spelling, so `tui --eval-state=true` refuses identically.
 */
function evalStateSpelling(token: string): boolean | undefined {
  if (token === EVAL_STATE_FLAG) return true;
  if (!token.startsWith(`${EVAL_STATE_FLAG}=`)) return undefined;
  switch (token.slice(EVAL_STATE_FLAG.length + 1)) {
    case "true":
      return true;
    case "false":
      return false;
    default:
      return undefined;
  }
}

/**
 * Read a value-taking flag's slot, applying the one rule every slot shares: a
 * posture flag is never a legal value.
 *
 * The rule lives here rather than in a list of which flags have slots, so a
 * value-taking flag added later gets it by calling this — there is no registry
 * to update and no second site to forget. `--resume` is the one caller that
 * does not: ADR-0130 already has a typed conflict refusal for a posture in the
 * resume slot, so that slot reports instead of throwing (see `readResumeSlot`).
 *
 * The test is on the **spelling**, so `--eval-state=false` is refused in a slot
 * too, and that is deliberate rather than an oversight to fix later: the `=false`
 * form is a spelling *of the posture flag* (ADR-0130 §6), not a value, and taking
 * it as a data root would make one token mean a posture and a path at the same
 * time. Whether the request means "not in eval state" is the parser's call to
 * make in a flag position; inside a value slot the only defensible reading is
 * "that was not a value".
 */
function slotValue(
  flag: string,
  argv: ReadonlyArray<string>,
  index: number,
  missing: string
): string {
  const raw = argv[index];
  if (raw === undefined) {
    throw new Error(missing);
  }
  if (evalStateSpelling(raw) !== undefined) {
    throw new Error(`Invalid ${flag}: ${raw}`);
  }
  return raw;
}

/**
 * What the `--resume` value slot contributes to the request, decided once here
 * instead of by a conditional assignment inside `parseArgs`'s scan loop.
 *
 * A slot holding the posture is a request carrying the posture into a resumed
 * session, not a session name. It must not become the id, and it must not open the
 * posture either (the posture is read from option positions only) — so the
 * conflict gate reports it as the incoherent request it is, rather than this slot
 * throwing. That makes `--resume` the one value slot that *reports* instead of
 * refusing like `slotValue` does, because ADR-0130 already has a typed refusal
 * for exactly this pair; it never opens a run (`enterEvalState` is unreachable
 * behind it).
 *
 * The test is on the spelling rather than on the bare literal because each
 * `=`-form is a token that names the posture flag, whatever it then says: matching
 * only the literal let `--resume --eval-state=true` resume a session whose id was
 * the string `--eval-state=true`. It also covers `=false`, which is a different
 * request from `=true` (non-posture) but the same kind of token, and is refused
 * here for the same reason.
 *
 * Both keys are always present, so the loop assigns both unconditionally and
 * reads no branch to do it: the decision is a property of the raw token, not of
 * anything the loop knows.
 */
interface ResumeSlot {
  /** The conversation id to carry, or `undefined` when the slot is not an id. */
  readonly resumeId: string | undefined;
  /** Whether the slot asked for the posture (independent of the id above). */
  readonly evalStateRequested: boolean;
}

function readResumeSlot(raw: string): ResumeSlot {
  return evalStateSpelling(raw) !== undefined
    ? { resumeId: undefined, evalStateRequested: true }
    : { resumeId: raw, evalStateRequested: false };
}

/**
 * Whether the posture was asked for at all, from the two places it can be asked
 * for: an option position (`splitEvalStateTokens`) and the `--resume` value slot
 * (`readResumeSlot`).
 *
 * A named helper rather than an `||` in the middle of `parseArgs`, for the same
 * reason `evalStateSpread` exists in `cli.ts`: the parser must not grow
 * branching for an optional posture. One decision, one named place.
 */
function evalStateRequested(
  evalState: boolean | undefined,
  fromResumeSlot: boolean
): boolean {
  return evalState === true || fromResumeSlot;
}

/**
 * Split the positional stream into "options the operator typed" and "the words
 * the operator asked the model", and read `--eval-state` off the first part.
 *
 * ADR-0130 §1 is fail-loud, but only about *flags*: a token that is not a flag
 * is the operator's query text, and entering eval state from it would silently
 * retire the fence **and** delete a word from the question. So the posture is
 * read from option positions only, and an option position is where the operator's
 * own words do not sit:
 *
 *   - `iknow ask --eval-state "<task>"` — the flag precedes the query, so it is
 *     an option (the published ADR-0130 shape).
 *   - `iknow ask "<task>" --eval-state` — the flag follows the query, so it is
 *     an option (the post-query shape).
 *   - `iknow ask grep --eval-state in src/config` — the flag sits **between**
 *     two of the operator's words. It is one of their words: it stays in the
 *     query and never opens the posture.
 *
 * An option therefore lives outside the span of the operator's own words: before
 * the first of them or after the last. Only `--eval-state` is read this way;
 * `--yolo` keeps its raw-argv reading (unchanged, pre-existing behavior).
 *
 * The span is the whole of `rest`, and for the scan-loop caller it needs no table
 * of flag names to be found: the scan loop is the single place a token is
 * consumed as a flag, and every token it consumes — a valueless flag matched in
 * the chain, or a value read with `argv[++i]` — lands nowhere but `rest`'s
 * complement. So for that caller every token in `rest` is already the operator's
 * own stream, and the only candidate option among them is the posture flag.
 *
 * The display-path caller does **not** get that by construction: it passes raw
 * argv, so a valueless flag the loop would have consumed is still sitting there
 * and would read as an operator word, widening the span so far that the posture
 * flag falls inside it and is dropped as free text. That caller's span question
 * is answered positionally instead — a display path starts nothing and takes no
 * query, so there is no operator word anywhere in its argv and every token is an
 * option position. `wordless` states that, and needs no flag names to say it.
 *
 * A `--eval-state` in a value-taking flag's slot never reaches this function at
 * all — the loop consumes that slot with `argv[++i]`, and `slotValue` refuses a
 * posture in it — so a value can neither open the posture nor be stripped.
 */
function splitEvalStateTokens(
  rest: ReadonlyArray<string>,
  wordless = false
): {
  readonly evalState: boolean | undefined;
  readonly positional: string[];
} {
  // Subcommand heads are the parser's own tokens, not the operator's words: a
  // head occupies positional 0, and `ask` takes its query from positional 1 on.
  const firstWordSlot =
    rest[0] !== undefined && SUBCOMMAND_HEADS.has(rest[0]) ? 1 : 0;
  /** A token of the operator's own: past the head, and not a posture spelling. */
  const isOperatorWord = (token: string | undefined, index: number): boolean =>
    !wordless &&
    token !== undefined &&
    !(index < firstWordSlot && SUBCOMMAND_HEADS.has(token)) &&
    evalStateSpelling(token) === undefined;
  const firstWord = rest.findIndex((token, index) =>
    isOperatorWord(token, index)
  );
  let lastWord = -1;
  for (let i = rest.length - 1; i >= 0; i--) {
    if (isOperatorWord(rest[i], i)) {
      lastWord = i;
      break;
    }
  }
  // No operator words at all (e.g. a bare `iknow --eval-state`): every token is
  // an option, so the whole stream is option positions.
  const isOptionPosition = (index: number): boolean =>
    firstWord === -1 || index < firstWord || index > lastWord;

  let evalState: boolean | undefined;
  const positional = rest.filter((token, index) => {
    const spelling = evalStateSpelling(token);
    if (spelling === undefined) return true;
    // A flag spelling inside the operator's own words is one of their words: it
    // stays in the query and never opens the posture.
    if (!isOptionPosition(index)) return true;
    // `=false` is the named non-posture spelling: the token is still a flag, so
    // it leaves the query, but it reports the same `undefined` the absent flag
    // does (`undefined` is this parser's "not in eval state", not a third state).
    if (spelling === true) evalState = true;
    return false;
  });
  return { evalState, positional };
}

/** Either eval-state typed refusal; both carry `kind` + `command` + `message`. */
export type EvalStateRejection =
  EvalStateUnsupportedEntryError | EvalStateFlagConflictError;

/**
 * Typed refusal for a TUI-only posture riding on a bare invocation that the
 * operator's own flags resolved to `chat` — the same discriminated-union face as
 * `YoloNonTuiEntryError` and `EvalStateFlagConflictError`.
 *
 * Nothing here was typed as a command: the bare route infers chat from `--json`
 * or `--resume`, so the posture and the anchor are two requests that cannot both
 * be honored. Discarding either one silently is the failure mode ADR-0119
 * §ruling 7 refuses to adopt, so the parser reports it. The message names the
 * rejected flag *and* the supported form of each request, because a refusal the
 * operator cannot act on is not a refusal.
 *
 * One type covers the family (a posture with no face on the resolved route) and
 * carries the flag as data, so a second TUI-only posture reuses it instead of
 * adding a case to the union.
 */
export interface TuiPostureConflictError {
  readonly kind: "tui_posture_conflict";
  readonly command: string;
  readonly flag: string;
  readonly message: string;
}

/**
 * Typed refusal for a chat anchor (`--json` / `--resume`) on the **explicit**
 * `tui` head — the mirror of `TuiPostureConflictError`, which covers a TUI
 * posture on an inferred chat route.
 *
 * A resumed or JSON-answering run is a chat-REPL request: the terminal UI has
 * neither an output format to switch to nor a flag-form resume (its resume is
 * the positional session id). Either flag therefore names two requests that
 * cannot both be honored, and dropping one quietly is the failure mode ADR-0119
 * §ruling 7 refuses to adopt. Like the posture conflict, the message names the
 * supported form of what was asked, because a refusal the operator cannot act on
 * is not a refusal.
 */
export interface TuiEntryRefusalError {
  readonly kind: "tui_entry_refusal";
  readonly command: string;
  readonly flag: string;
  readonly message: string;
}

/**
 * The entry-selecting anchor reports first: `--json` is the flag that picks an
 * entry at all, while `--resume` only says which conversation that entry
 * continues, so one refusal still leaves the operator one step from a command
 * that serves both requests.
 */
export function rejectTuiEntryRefusal(opts: {
  readonly flag: string;
  readonly resumeId?: string;
}): TuiEntryRefusalError {
  return {
    kind: "tui_entry_refusal",
    command: "tui",
    flag: opts.flag,
    message:
      `tui_entry_refusal: '${opts.flag}' has no face on the terminal UI, so ` +
      `honoring 'iknow tui' would silently discard it. ` +
      tuiEntrySupportedForm(opts),
  };
}

function tuiEntrySupportedForm(opts: {
  readonly flag: string;
  readonly resumeId?: string;
}): string {
  return opts.resumeId !== undefined
    ? `Run 'iknow tui ${opts.resumeId}' (the positional form) to resume in the ` +
        `terminal UI, or 'iknow chat --resume ${opts.resumeId}' for the chat REPL.`
    : `Run 'iknow chat ${opts.flag}' for the chat REPL, or 'iknow tui' without ` +
        `'${opts.flag}' for the terminal UI.`;
}

/**
 * Either face of "this flag and the terminal UI cannot both be honored": a TUI
 * posture on an inferred chat route, or a chat anchor on the explicit `tui`
 * head. One field carries the family and the host reads it at one point, so a
 * new anchor or posture adds a case here instead of a second field and a second
 * read that can drift.
 */
export type TuiEntryRejection = TuiPostureConflictError | TuiEntryRefusalError;

export function rejectTuiPostureConflict(opts: {
  readonly command: string;
  readonly flag: string;
  readonly anchor: string;
  readonly resumeId?: string;
}): TuiPostureConflictError {
  // ADR-0119's amendment: a refusal has to name the form the operator can run, so
  // the resume anchor carries its id instead of pointing at a command that would
  // start a new conversation.
  const chatForm =
    opts.resumeId !== undefined
      ? `iknow chat ${opts.anchor} ${opts.resumeId}`
      : `iknow chat ${opts.anchor}`;
  return {
    kind: "tui_posture_conflict",
    command: opts.command,
    flag: opts.flag,
    message:
      `tui_posture_conflict: '${opts.flag}' is a TUI posture and '${opts.anchor}' ` +
      `resolves this invocation to '${opts.command}', so honoring one request would ` +
      `silently discard the other. Run 'iknow tui ${opts.flag}' for the terminal UI, ` +
      `or '${chatForm}' (without '${opts.flag}') for the chat REPL.`,
  };
}

/**
 * `--json` and `--resume` anchor a run to the chat REPL, and the terminal UI
 * has no face for either: no output format to switch to, and a resume of its own
 * (the positional session id). On the `tui` head that is two requests that
 * cannot both be honored, so the parser refuses rather than starting a TUI that
 * quietly ignores one of them — the same fail-loud rule as the yolo and
 * eval-state gates, and the mirror of the posture conflict `bareInvocationRoute`
 * reports for an inferred chat route.
 */
function tuiEntryGate(request: {
  readonly json: boolean;
  readonly resumeId?: string;
}): { readonly tuiEntryRejection?: TuiEntryRefusalError } {
  if (request.json) {
    return { tuiEntryRejection: rejectTuiEntryRefusal({ flag: "--json" }) };
  }
  if (request.resumeId !== undefined) {
    return {
      tuiEntryRejection: rejectTuiEntryRefusal({
        flag: "--resume",
        resumeId: request.resumeId,
      }),
    };
  }
  return {};
}

/**
 * Read `--yolo` off argv — present → `true`, absent → `undefined` (= non-yolo).
 *
 * Deliberately **no** branch for it inside the scan loop: a valueless boolean
 * flag carries no loop semantics, it only affects which head branch the input
 * lands on. The loop collects positional tokens not consumed by value-taking
 * flags into `rest`, and the flag is stripped once at the end — so the argument
 * position semantics of value-taking flags (the token right after `--resume` is
 * its value) stay byte-identical to today.
 *
 * The reading comes from the **raw argv**, without checking whether the token sat
 * in a value-taking flag's argument slot. So a degenerate input like
 * `--resume --yolo` counts as "carrying `--yolo`" and is refused on a non-TUI
 * entry. That direction is the deliberate choice: misreading a dangerous flag
 * must bias towards refusal, never towards silently swallowing it as a resume id.
 */
function yoloFlagFromArgv(argv: ReadonlyArray<string>): boolean | undefined {
  return argv.includes(YOLO_FLAG) ? true : undefined;
}

/**
 * Read `--no-sandbox` off argv — present → `true`, absent → `undefined`.
 * Same raw-argv discipline as `--yolo`, including the deliberate bias towards
 * reading a dangerous posture flag even when it sits in another flag's value
 * slot.
 */
function noSandboxFlagFromArgv(
  argv: ReadonlyArray<string>
): boolean | undefined {
  return argv.includes(NO_SANDBOX_FLAG) ? true : undefined;
}

/**
 * ADR-0141: which preset flag this argv asked for, if any. `--yolo` wins when
 * both are typed — it is the stronger declaration (three axes, not two), so
 * naming the refusal after the weaker one would understate what was asked for.
 */
function presetAsked(
  yolo: boolean | undefined,
  noSandbox: boolean | undefined
): { readonly preset: "yolo" | "no-sandbox" } | undefined {
  if (yolo === true) return { preset: "yolo" };
  if (noSandbox === true) return { preset: "no-sandbox" };
  return undefined;
}

/**
 * The posture on a display path (`-h` / `-V`), which returns from inside the
 * scan loop before the positional stream is read.
 *
 * A display path starts nothing and takes no query, so the operator typed no
 * words at all: the whole argv is option positions, and that is what `wordless`
 * declares. A value-slot token can reach this reading when a display flag
 * precedes its flag (`-h --data-dir --eval-state` returns at `-h` with the slot
 * unconsumed); `wordless` makes it an option position either way, so the only
 * ordering the slot guard still decides is a value flag taken before the
 * display flag returns.
 */
function evalStateOnDisplayPath(
  argv: ReadonlyArray<string>
): boolean | undefined {
  return splitEvalStateTokens(argv, true).evalState;
}

/** The route a bare invocation takes, and what that route adds to the option bag. */
interface BareRoute {
  readonly command: CliCommand;
  readonly fields: {
    readonly implicitTuiLaunch: boolean;
    readonly tuiEntryRejection?: TuiEntryRejection;
  };
}

/**
 * Decide the route of a bare invocation (no subcommand head, no query text).
 *
 * Three faces, in this order, each with a reason the next one cannot absorb it:
 *
 *   - **Display path** (`help`). Without a TTY the operator has no terminal to
 *     drive, so the invocation prints usage. A bare `--eval-state` prints usage on
 *     *either* TTY state: the flag was read from an option position, nothing else
 *     was asked for, and a display path starts no session — so displaying the
 *     posture is **not** an eval-state execution, and under a TTY it must not open
 *     a session with the fence gone (ADR-0130's non-default clause). This is the
 *     same treatment `-h` / `-V` get, and the reason the old copy called a bare
 *     posture flag "a posture path" was wrong: it never enters anything.
 *   - **Chat route** (`chat`). `--json` and `--resume <id>` are chat's own anchors,
 *     so the legacy route and its observable behavior survive the new default. A
 *     TUI-only posture riding along is a second, incompatible request: it is
 *     refused, not dropped. `--yolo` keeps flowing through the chat gate, so
 *     `iknow --json --yolo` reports the yolo exception exactly as `iknow chat
 *     --yolo` does.
 *   - **TUI route** (`tui`). Everything else on a TTY starts the terminal UI,
 *     carrying whichever posture was asked for — no gate applies, because the TUI
 *     is `--yolo`'s legal home and `--auto-mode`'s only home.
 *
 * `implicitTuiLaunch` marks the last case **only when no posture was asked
 * for**: that is the one launch a machine without Bun can still serve through the
 * chat REPL. A launch that named a TUI-only posture would have to lose it to fall
 * back, so `runTui` fails loudly there instead.
 */
function bareInvocationRoute(request: {
  readonly interactive: boolean;
  readonly json: boolean;
  readonly yolo: boolean | undefined;
  readonly autoMode: boolean;
  readonly evalState: boolean | undefined;
  readonly resumeId: string | undefined;
}): BareRoute {
  if (!request.interactive || request.evalState === true) {
    return { command: "help", fields: { implicitTuiLaunch: false } };
  }
  if (request.json || request.resumeId !== undefined) {
    return {
      command: "chat",
      fields: request.autoMode
        ? {
            implicitTuiLaunch: false,
            tuiEntryRejection: rejectTuiPostureConflict({
              command: "chat",
              flag: "--auto-mode",
              anchor: request.json ? "--json" : "--resume",
              resumeId: request.json ? undefined : request.resumeId,
            }),
          }
        : { implicitTuiLaunch: false },
    };
  }
  return {
    command: "tui",
    fields: { implicitTuiLaunch: request.yolo !== true && !request.autoMode },
  };
}

export type CliCommand =
  | "chat"
  | "ask"
  | "oneshot"
  | "help"
  | "serve"
  | "trace"
  | "tui"
  /**
   * Subagent worker headless re-entry (double-underscore prefix separates it
   * from product forms). Not exposed in printUsage / getVersion public
   * paths; triggered only by the parent agent via child_process.spawn, never
   * called directly by the operator. The early flag `--subagent-worker` is
   * detected at the very top of the parseArgs for-loop: on a hit we return
   * baseParsed immediately, skipping every product branch.
   */
  | "__subagent_worker__";

export type ParsedCli = {
  command: CliCommand;
  query: string;
  json: boolean;
  /**
   * ask/oneshot with empty query text.
   * Host should print usage and exit 1 (no default demo query).
   */
  missingQuery: boolean;
  /**
   * True when argv was `-V` / `--version` (host prints version only).
   */
  versionOnly: boolean;
  /**
   * HTTP listen port for `serve` (default 8787 when command is serve).
   */
  port: number;
  /**
   * HTTP bind host for `serve` (default 127.0.0.1).
   */
  host: string;
  /**
   * Trace read cap (bytes) for the `trace` subcommand (--max-bytes flag).
   * Defaults to 8 MiB (MAX_TRACE_BYTES) in the reader when unset.
   */
  maxBytes?: number;
  /**
   * Trace output directory for ask/serve/tui (--trace-out flag).
   * Resolution: flag > IKNOW_TRACE_OUT env > "./trace/" (ADR-0003).
   * Directory semantics: actual writes go to
   * <traceOut>/<conversationId>.jsonl.
   */
  traceOut?: string;
  /**
   * Session pool root for serve (--data-dir flag).
   * Undefined -> serve defaults to ~/.iknow.
   */
  dataDir?: string;
  /**
   * Workspace root for per-root state (--workspace-root flag).
   * Resolved by `resolveWorkspaceRoot({explicit, cwd, env})` in the
   * build-engine / tui-deps layer. CLI here only stores the raw flag
   * value; resolver applies priority chain + validation.
   */
  workspaceRoot?: string;
  /**
   * Optional positional parameter for `tui [session-id]` — resume that
   * session directly.
   */
  sessionId?: string;
  /**
   * Max loop turns for a single run (optional positive integer).
   * `undefined` (default) = unlimited; explicit values are interpreted by
   * the host (loop-engine etc.). Missing value / non-integer / < 1 throws.
   */
  maxTurns?: number;
  /**
   * `--no-open` disables the auto browser-open after `iknow trace` starts
   * (CI/headless). Default false = auto-open.
   */
  noOpen: boolean;
  /**
   * ADR-0020: `iknow trace --separate` escape hatch — keeps the
   * standalone-process mode (default port 24881). Default false = probe
   * `iknow serve` and point at the same-process /trace panel.
   */
  separate: boolean;
  /**
   * `iknow chat --resume <id>` anchors an existing conversationId to
   * continue. Parsing stays command-agnostic (ask/serve/tui may each decide
   * to consume it later); only the chat entry consumes it for now.
   * `undefined` (default) = new session (random UUID).
   */
  resumeId?: string;
  /**
   * `iknow tui --auto-mode`: launch in full_auto permission mode (skip
   * tool-ask prompts). Default false. Only the tui entry consumes it; other
   * commands keep the parsed field but never read it.
   */
  autoMode: boolean;
  /**
   * ADR-0119 / spec yolo-mode: startup switch for no-sandbox mode (the fence
   * retires wholesale). Default undefined = non-yolo (argv byte-identical to
   * today's). Reachable only through the tui entry: when one of the five non-TUI
   * public commands carries it, yoloRejection is filled instead and the host
   * prints then exits non-zero.
   */
  yolo?: boolean;
  /**
   * ADR-0141: the second named preset entry. Default undefined = no preset
   * declared (argv byte-identical to the `--yolo`-only shape). Carried by the
   * `tui` entry only; the five non-TUI session entries carry the typed refusal
   * in `yoloRejection` instead and the host starts nothing.
   */
  noSandbox?: boolean;
  /**
   * ADR-0119 ruling 7: the typed refusal for a non-TUI entry carrying --yolo
   * (discriminated union). Absent = not carried, or a legal entry was hit. The
   * host writes the message to stderr and exits 1, starting no service /
   * session. The union is a plain object, so the
   * `err instanceof Error ? err.message : String(err)` collapse is forbidden —
   * it would print `[object Object]` and hide kind / command entirely
   * (.claude/rules/code-quality.md typed-error catch contract).
   */
  yoloRejection?: YoloNonTuiEntryError;
  /**
   * ADR-0130 eval state: startup switch for the headless, named, unsandboxed
   * benchmark posture. Default undefined = the fenced shape (argv byte-identical
   * to today). Accepted only by the two one-shot entries (`ask` / `oneshot`);
   * the flag is never persisted, never a settings value and never a default.
   */
  evalState?: boolean;
  /**
   * ADR-0130: the typed refusal (discriminated union) when the request cannot be
   * coherent — `--eval-state` on an entry that does not take it, or combined with
   * `--resume` (a per-invocation posture cannot carry a resumed session). Same
   * rendering discipline as `yoloRejection`: plain object, so the host writes
   * `${kind}: ...` from `.message` — never `String(err)`.
   */
  evalStateRejection?: EvalStateRejection;
  /**
   * The typed refusal (same discriminated-union face as the two above) when a
   * flag and the terminal UI cannot both be honored: a bare TTY invocation that
   * asks for a TUI-only posture **and** for chat through its own flags
   * (`--json` / `--resume`), or a chat anchor on the explicit `tui` head. The
   * parser decides; the host renders. `baseParsed` keeps the three refusal fields
   * mutually exclusive, so a result never carries two of them.
   */
  tuiEntryRejection?: TuiEntryRejection;
  /**
   * True only when the TUI route came from a bare TTY invocation carrying no
   * TUI-only posture. It records the **launch origin**, which the host needs at
   * exactly one point: with Bun missing, an ordinary bare launch can still be
   * served by the chat REPL, while a launch that named the TUI explicitly must
   * fail non-zero rather than start a session without that posture. Always
   * present (never an absent key), because a host should not have to guess what a
   * missing field meant.
   */
  implicitTuiLaunch: boolean;
};

export type ParseArgsOptions = {
  readonly argv: string[];
  /** When true, a bare invocation (no query) starts the TUI instead of printing usage. */
  readonly interactive?: boolean;
};

/**
 * Parse process.argv.slice(2)-style argv into a structured CLI request.
 *
 * Defaults (the bare-invocation route is `bareInvocationRoute`'s):
 * - no positionals + interactive → tui (default mode, or the posture asked for)
 * - no positionals + !interactive → help
 * - no positionals + interactive + `--json` / `--resume <id>` → chat
 * - ask / bare query with empty text → missingQuery (caller exits 1)
 *
 * Early flag: `--subagent-worker` is checked at the very top of the
 * for-loop (before `-h` / `--version` / existing flag branches). A hit
 * returns `baseParsed({command:"__subagent_worker__",
 * fields:{...defaults}})` immediately, entering no product branch. The
 * parent process spawns the worker and feeds the envelope over stdin, so
 * the worker argv carries no chat/ask/serve/tui sub-command.
 */
export function parseArgs(opts: ParseArgsOptions): ParsedCli {
  const argv = opts.argv;
  const yolo = yoloFlagFromArgv(argv);
  const noSandbox = noSandboxFlagFromArgv(argv);
  const interactive = opts.interactive ?? false;
  let json = false;
  let port = 8787;
  let portSet = false;
  let host = "127.0.0.1";
  let traceOut: string | undefined;
  let dataDir: string | undefined;
  let workspaceRoot: string | undefined;
  let maxBytes: number | undefined;
  let maxTurns: number | undefined;
  let noOpen = false;
  let separate = false;
  let autoMode = false;
  let resumeId: string | undefined;
  /** `--resume` was handed the eval-state literal (see `readResumeSlot`). */
  let resumeIdSlotWasEvalState = false;
  const rest: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    // Early flag: checked at the top of the for-loop; a hit returns the
    // worker command immediately. Early-flag semantics override every later
    // argv item (even if chat/ask/serve/tui are also present, worker wins —
    // the operator never calls it directly, it exists only for
    // parent-process spawn). Not shown in printUsage / getVersion.
    if (a === "--subagent-worker") {
      return baseParsed({
        command: "__subagent_worker__",
        fields: {
          json: false,
          port: 8787,
          host: "127.0.0.1",
          traceOut: undefined,
          dataDir: undefined,
          workspaceRoot: undefined,
          maxBytes: undefined,
          maxTurns: undefined,
          noOpen: false,
          separate: false,
          autoMode: false,
          query: "",
          missingQuery: false,
          versionOnly: false,
        },
      });
    }
    if (a === "-h" || a === "--help") {
      return baseParsed({
        command: "help",
        fields: {
          json,
          port,
          host,
          traceOut,
          dataDir,
          workspaceRoot,
          maxBytes,
          maxTurns,
          noOpen,
          separate,
          autoMode,
          yolo,
          noSandbox,
          evalState: evalStateOnDisplayPath(argv),
          resumeId,
          query: "",
          missingQuery: false,
          versionOnly: false,
        },
      });
    }
    if (a === "--json") {
      json = true;
    } else if (a === "--port") {
      const raw = slotValue("--port", argv, ++i, "Missing value for --port");
      const n = Number(raw);
      // Port 0 is allowed → ephemeral (Node http.Server convention).
      if (!Number.isInteger(n) || n < 0 || n > 65535) {
        throw new Error(`Invalid --port: ${raw}`);
      }
      port = n;
      portSet = true;
    } else if (a === "--host") {
      host = slotValue("--host", argv, ++i, "Missing value for --host");
    } else if (a === "--trace-out") {
      traceOut = slotValue(
        "--trace-out",
        argv,
        ++i,
        "--trace-out requires a file path argument"
      );
    } else if (a === "--max-bytes") {
      const raw = slotValue(
        "--max-bytes",
        argv,
        ++i,
        "--max-bytes requires an integer argument"
      );
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1) {
        throw new Error(`Invalid --max-bytes: ${raw}`);
      }
      maxBytes = n;
    } else if (a === "--max-turns") {
      const raw = slotValue(
        "--max-turns",
        argv,
        ++i,
        "--max-turns requires an integer argument"
      );
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1) {
        throw new Error(`Invalid --max-turns: ${raw}`);
      }
      maxTurns = n;
    } else if (a === "--no-open") {
      // Boolean flag (no value): disables trace auto browser-open (CI/headless).
      noOpen = true;
    } else if (a === "--separate") {
      // Boolean flag (no value): trace keeps the standalone-process mode (ADR-0020).
      separate = true;
    } else if (a === "--auto-mode") {
      // TUI: start in full_auto (skip tool asks). Boolean flag, no value.
      autoMode = true;
    } else if (a === "--resume") {
      // Value flag — missing / empty / whitespace-only are rejected (mirrors --port style).
      const raw = argv[++i];
      if (raw === undefined) {
        throw new Error("--resume requires a conversation id argument");
      }
      // ADR-0130: the slot's reading is `readResumeSlot`'s (see it for why this
      // slot reports instead of throwing); the empty check stays here so it
      // fires for the literal too, before anything is assigned.
      if (raw.trim().length === 0) {
        throw new Error("--resume requires a non-empty conversation id");
      }
      const slot = readResumeSlot(raw);
      resumeId = slot.resumeId;
      resumeIdSlotWasEvalState = slot.evalStateRequested;
    } else if (a === "--data-dir") {
      dataDir = slotValue(
        "--data-dir",
        argv,
        ++i,
        "--data-dir requires a directory argument"
      );
    } else if (a === "--workspace-root") {
      workspaceRoot = slotValue(
        "--workspace-root",
        argv,
        ++i,
        "--workspace-root requires a directory argument"
      );
    } else if (a === "--version" || a === "-V") {
      return baseParsed({
        command: "help",
        fields: {
          json,
          port,
          host,
          traceOut,
          dataDir,
          workspaceRoot,
          maxBytes,
          maxTurns,
          noOpen,
          separate,
          autoMode,
          yolo,
          noSandbox,
          evalState: evalStateOnDisplayPath(argv),
          resumeId,
          query: "",
          missingQuery: false,
          versionOnly: true,
        },
      });
    } else {
      rest.push(a);
    }
  }

  // ADR-0130: `--eval-state` is read from **option positions only** (see
  // `splitEvalStateTokens`): an option never reaches the operator as query text,
  // and a word of theirs never reaches the fence-retiring posture. `--yolo` and
  // `--no-sandbox` are stripped wherever they sit — their raw-argv readings
  // above are unchanged.
  const { evalState, positional } = splitEvalStateTokens(
    rest.filter((a) => a !== YOLO_FLAG && a !== NO_SANDBOX_FLAG)
  );

  const flags = {
    json,
    port,
    host,
    traceOut,
    dataDir,
    workspaceRoot,
    maxBytes,
    maxTurns,
    noOpen,
    separate,
    autoMode,
    yolo,
    noSandbox,
    evalState,
    resumeId,
    versionOnly: false,
  };
  // ADR-0130 fail-loud, the other half: the literal in a `--resume` value slot is
  // an incoherent request, and the posture it asked for still has to be decided so
  // the conflict gate below can refuse it.
  const postureRequested = evalStateRequested(
    evalState,
    resumeIdSlotWasEvalState
  );
  const head = positional[0];

  /**
   * ADR-0119 ruling 7: `--yolo` reaches only the tui entry. A parse result that
   * lands on a **session** command carries the typed refusal (discriminated
   * union); the host reports it, exits non-zero and starts nothing. Display
   * paths (-h / -V / non-TTY bare invocation -> help) do not pass this gate —
   * they start no session and are the explicitly declared allowance (spec
   * `specs/yolo-mode.md` EXIT, including its bare-launch amendment).
   */
  // ADR-0141: the refusal covers BOTH preset flags. They share one typed error
  // shape and one command list because they share one home (the tui entry) —
  // the enumeration is the defense line, so extending it here is what keeps a
  // new preset from reaching a session entry by omission.
  const presetFlagAsked = presetAsked(yolo, noSandbox);
  const yoloGate = (
    command: string
  ): { readonly yoloRejection?: YoloNonTuiEntryError } =>
    presetFlagAsked !== undefined && isYoloRejectedCommand(command)
      ? {
          yoloRejection: rejectYoloForCommand(
            command,
            presetFlagAsked.preset
          ),
        }
      : {};

  /**
   * ADR-0130 §1: `--eval-state` is a **separate named face**, not a widened
   * `--yolo` enumeration. Two refusals, both typed, decided from the SSOT lists
   * in `sandbox/eval-state.ts` so the gate and the constants cannot drift:
   *   - an entry outside the two headless one-shot commands (the ADR's "named,
   *     non-default" clause — chat / serve / trace have sessions, tui already
   *     has its own yolo posture);
   *   - `--resume` on a legal entry: the posture is per-invocation and persists
   *     nothing, so a transcript cannot carry two of them. Silently dropping the
   *     flag would be the `--auto-mode` failure mode ADR-0119 §ruling 7 refuses to
   *     adopt. The entry check runs first, so an unsupported entry is reported as
   *     such even when it also carries `--resume`.
   *
   * Display paths (`-h` / `-V` / a bare flag with no subcommand) stay outside this
   * gate — they start nothing (same declared allowance as `yoloGate`).
   */
  const evalStateGate = (
    command: string
  ): { readonly evalStateRejection?: EvalStateRejection } => {
    if (postureRequested !== true) return {};
    if (!isEvalStateEntry(command)) {
      return { evalStateRejection: rejectEvalStateEntry(command) };
    }
    return resumeId !== undefined || resumeIdSlotWasEvalState
      ? {
          evalStateRejection: rejectEvalStateConflict(
            command,
            EVAL_STATE_RESUME_FLAG
          ),
        }
      : {};
  };

  if (head === "chat") {
    return baseParsed({
      command: "chat",
      fields: {
        ...flags,
        ...yoloGate("chat"),
        ...evalStateGate("chat"),
        query: "",
        missingQuery: false,
      },
    });
  }

  if (head === "serve") {
    return baseParsed({
      command: "serve",
      fields: {
        ...flags,
        ...yoloGate("serve"),
        ...evalStateGate("serve"),
        query: "",
        missingQuery: false,
      },
    });
  }

  if (head === "trace") {
    // ADR-0020: default mode probes `iknow serve` → default port 8787
    // (serve's port); `--separate` keeps the standalone default 24881.
    // Sentinel-based: only override when the user did not pass --port, so
    // `iknow trace --port 9999` is honored verbatim.
    const tracePort = portSet ? port : separate ? 24881 : 8787;
    return baseParsed({
      command: "trace",
      fields: {
        ...flags,
        ...yoloGate("trace"),
        ...evalStateGate("trace"),
        port: tracePort,
        query: "",
        missingQuery: false,
      },
    });
  }

  if (head === "tui") {
    const sessionId = positional[1];
    return baseParsed({
      command: "tui",
      fields: {
        ...flags,
        // ADR-0130: eval state has no tui face — the TUI reaches the same
        // posture through `--yolo` / `/yolo` already, and the mode-row marker is
        // the only place that posture is visible. A flag here would be a second,
        // less-observable door to one state.
        ...evalStateGate("tui"),
        ...tuiEntryGate({ json, resumeId }),
        query: "",
        missingQuery: false,
        sessionId: sessionId !== undefined ? sessionId : undefined,
      },
    });
  }

  if (head === "ask") {
    const query = positional.slice(1).join(" ").trim();
    return baseParsed({
      command: "ask",
      fields: {
        ...flags,
        ...yoloGate("ask"),
        ...evalStateGate("ask"),
        query,
        missingQuery: query.length === 0,
      },
    });
  }

  if (head === "help") {
    return baseParsed({
      command: "help",
      fields: {
        ...flags,
        query: "",
        missingQuery: false,
      },
    });
  }

  const query = positional.join(" ").trim();
  if (query.length === 0) {
    const route = bareInvocationRoute({
      interactive,
      json,
      yolo,
      autoMode,
      evalState,
      resumeId,
    });
    return baseParsed({
      command: route.command,
      fields: {
        ...flags,
        // The gates are the ones the resolved route's own head would pass, so an
        // inferred route cannot be more permissive than a typed one. The display
        // path passes none: it starts nothing (same allowance as `-h` / `-V`).
        ...(route.command === "help"
          ? {}
          : {
              ...yoloGate(route.command),
              ...evalStateGate(route.command),
            }),
        ...route.fields,
        query: "",
        missingQuery: false,
      },
    });
  }

  return baseParsed({
    command: "oneshot",
    fields: {
      ...flags,
      ...yoloGate("oneshot"),
      ...evalStateGate("oneshot"),
      query,
      missingQuery: false,
    },
  });
}

/**
 * One assembly point for every parse result. `implicitTuiLaunch` is filled here
 * rather than at each head: the field is required in the public shape, and only
 * the bare route can answer it true, so a head that never launches the TUI
 * implicitly cannot forget to say so.
 *
 * Refusal precedence is decided here as well, once — yolo, then the TUI entry
 * family, then eval state — so a request carrying two refused flags yields
 * exactly one filled field and the host's read order carries no meaning.
 */
function baseParsed(opts: {
  readonly command: CliCommand;
  readonly fields: Omit<ParsedCli, "command" | "implicitTuiLaunch"> & {
    readonly implicitTuiLaunch?: boolean;
  };
}): ParsedCli {
  const parsed: ParsedCli = {
    command: opts.command,
    implicitTuiLaunch: false,
    ...opts.fields,
  };
  if (parsed.yoloRejection !== undefined) {
    delete parsed.tuiEntryRejection;
    delete parsed.evalStateRejection;
  } else if (parsed.tuiEntryRejection !== undefined) {
    delete parsed.evalStateRejection;
  }
  return parsed;
}
