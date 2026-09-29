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
 *     an option (the harbor adapter's shape).
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

/**
 * Whether a bare invocation on a TTY defaults to `chat`. A bare `--yolo` (no
 * subcommand) does **not** fall to chat — it belongs with `-h` / `-V` as a pure
 * display path (the explicitly declared allowance in spec EXIT / the plan's
 * closing acceptance line). Otherwise the same input would fork into two
 * treatments depending on TTY, and under a TTY it would silently start a non-TUI
 * session — the mirror image of the "dangerous flag silently swallowed" the plan
 * rejected.
 *
 * ADR-0130: `--eval-state` retires the fence just as `--yolo` does, so a bare
 * invocation carrying it gets the same display-path treatment (the ADR's
 * "non-default" clause — a bare `iknow` on a TTY must never open a chat session
 * with the fence gone).
 */
function bareInvocationDefaultsToChat(
  requested: boolean | undefined,
  yolo: boolean | undefined,
  evalState: boolean | undefined
): boolean {
  return (requested ?? false) && yolo !== true && evalState !== true;
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
};

export type ParseArgsOptions = {
  readonly argv: string[];
  /** When true, bare invocation (no query) defaults to chat. */
  readonly interactive?: boolean;
};

/**
 * Parse process.argv.slice(2)-style argv into a structured CLI request.
 *
 * Defaults:
 * - no positionals + interactive → chat
 * - no positionals + !interactive → help
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
  // and a word of theirs never reaches the fence-retiring posture. `--yolo` is
  // stripped wherever it sits — its raw-argv reading above is unchanged.
  const { evalState, positional } = splitEvalStateTokens(
    rest.filter((a) => a !== YOLO_FLAG)
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
   * they start no session and are the explicitly declared allowance (spec EXIT /
   * the closing acceptance line of plans/yolo-mode.md).
   */
  const yoloGate = (
    command: string
  ): { readonly yoloRejection?: YoloNonTuiEntryError } =>
    yolo === true && isYoloRejectedCommand(command)
      ? { yoloRejection: rejectYoloForCommand(command) }
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
    if (bareInvocationDefaultsToChat(interactive, yolo, evalState)) {
      return baseParsed({
        command: "chat",
        fields: {
          ...flags,
          query: "",
          missingQuery: false,
        },
      });
    }
    return baseParsed({
      command: "help",
      fields: {
        ...flags,
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

function baseParsed(opts: {
  readonly command: CliCommand;
  readonly fields: Omit<ParsedCli, "command">;
}): ParsedCli {
  return { command: opts.command, ...opts.fields };
}
