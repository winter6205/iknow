/**
 * Loop Engine: stepwise state machine driving model turns and tool
 * execution; interface shapes are pinned by spec.
 *
 * Boundaries:
 *   - No mutable instance fields; state is threaded through, messages are
 *     appended immutably;
 *   - Atomic turn commit: an AssistantTurnResult delivered by the Adapter
 *     is appended to messages only as a whole turn; tool calls go to the
 *     Executor for serial execution;
 *   - ToolExecutionResult is encoded into native tool_result blocks via
 *     Model Adapter.encodeToolResults and appended as one user message;
 *   - Stop reasons: completed / maxTurns / nonSuccessStop / protocolError /
 *     emptyFinalResponse, plus cancelled (signal abort) and timeout
 *     (forced by clock);
 *   - run() returns a second surface besides the result:
 *     `{ result: RunResult; trace: LoopTrace }`.
 *   - Exceeding maxTurns throws `MaxTurnsExceeded` instead of stopping
 *     silently; after any exceptional stop one best-effort closing summary
 *     runs (ADR-0011), delivered as a `{ type: "stop_summary", text }`
 *     event without polluting the authoritative history.
 *   - SDK prompt-too-long (400) → `PromptTooLongError` → reactive compact
 *     (at most once per run), then the model call is retried once
 *     (ADR-0013).
 *
 * Loop Engine never reads, judges, or constructs vendor-native fields;
 * the Model Adapter is the only module allowed to handle native history.
 *
 * `step(state, deps)` is a real single-step transition. The spec signature
 * is sync, but `adapter.step` is async, so step returns
 * `Promise<Transition>` to keep the protocol contract honest; `run` reuses
 * the same step to avoid dual-track drift. Internally stepWithTrace yields
 * both a Transition and a TurnTrace; the public step() returns only the
 * Transition (frozen contract); run() accumulates traces and computes
 * totals once.
 */

import { randomUUID } from "node:crypto";
import {
  errorMessage,
  MaxTurnsExceeded,
  MessageCommitError,
  ProtocolError,
  PromptTooLongError,
  RuntimeStatePersistenceError,
  SkipAppendEmptyPriorError,
  SkipAppendWithTextError,
  TransportRetryExhaustedError,
  transportApiErrorOf,
  withApiError,
  type ApiErrorSummary,
} from "./errors.js";
import {
  isStalledToolLoop,
  isValidationStallLoop,
  LOOP_DETECTED_TEXT,
  toolLoopEventFromCall,
  VALIDATION_LOOP_DETECTED_TEXT,
  type ToolLoopEvent,
} from "./tool-loop-detect.js";
import type {
  AnthropicContentBlock,
  AnthropicNativeMessage,
  AssistantTurnResult,
  CountTokensInput,
  CountTokensResult,
  LoopState,
  RunResult,
  SdkDispatchEvidence,
  StopReason,
  SupplierStopDetail,
  TokenUsage,
  Transition,
} from "./model-adapter/types.js";
import type { ThinkingParams } from "./model-adapter/anthropic-adapter.js";
import type {
  Executor,
  Registry,
  ToolDef,
  ToolExecutionResult,
} from "./tools/types.js";
import { partitionConcurrencyWaves } from "./tools/concurrency-waves.js";
import type { CancelKind, LoopTrace, TurnTrace } from "./loop-trace.js";
import { computeTotals } from "./loop-trace.js";
import type {
  TraceErrorType,
  TraceService,
  TraceStatus,
  TraceError,
  ToolCallCause,
  ToolCallRecord,
  CleanupTraceEvidence,
} from "./trace/index.js";
import { safeTrace } from "./trace/index.js";
import type { HarnessStreamEvent } from "./stream.js";
import {
  safeEmitStream,
  TRANSPORT_RETRY_DETAIL_INVISIBLE_TIMEOUT,
} from "./stream.js";
import { splitStreamingMarkdown } from "../shared/streaming-block-freeze.js";
import type {
  RuntimeOperationFact,
  RuntimePersistenceSink,
  RuntimeSavedStateRequest,
} from "../shared/runtime-persistence.js";
import type { RaceTimers } from "./race-timers.js";
import { lastNonEmptyAssistant } from "./last-nonempty-assistant.js";
import {
  classifyFault,
  clockAbortReasonOf,
  type ClockAbortReason,
  type FaultClass,
  type FaultEvent,
} from "./fault-class.js";
import {
  backoffDelayMs,
  sleepWithAbort,
  TRANSPORT_MAX_ATTEMPTS,
} from "./model-adapter/with-transport-retry.js";
import { stampHostInjected } from "./model-adapter/outbound-projection.js";
import {
  observeModelIdle,
  resolveModelClocks,
  startRaceTimers,
} from "./race-timers.js";
import {
  buildCompactedMessages,
  buildCompactPrompt,
  compactMessages,
  estimateMessagesTokens,
  evaluateCompactTrigger,
  getAutoCompactThreshold,
  runFullCompact,
  splitForCompaction,
} from "./compress/index.js";
import type { FullCompactOutcome, CompactAdapter } from "./compress/index.js";
import { recognize } from "./secret-roundtrip/index.js";
import type { SecretRegistry } from "./secret-roundtrip/index.js";
import {
  AGENT_STATUS_IDLE_TOOL,
  computeAgentStatusSnapshot,
  pickPresentAgentStatusSlots,
} from "./agent-status.js";
import { extractLatestRealUserInstruction } from "./agent-status-instruction.js";
import { readEnvSnapshot } from "./env-snapshot.js";
import type { GraphAssembly } from "./graph/assembly.js";
import {
  type GraphModeChange,
  IKNOW_GRAPH_MODE_PRESENCE_NOTIFICATION,
  renderGraphModeChangeNotification,
} from "./graph/notification.js";

/**
 * Map an arbitrary reason string to TraceErrorType without `as` casts.
 * Known values pass through; anything else (including nonSuccessStop /
 * maxTurns / completed) falls back to "unknown".
 */
function toTraceErrorType(reason: string): TraceErrorType {
  switch (reason) {
    case "cancelled":
    case "timeout":
    case "protocolError":
    case "emptyFinalResponse":
    case "validation_failed":
    case "tool_not_found":
    case "execution_failed":
      return reason;
    default:
      return "unknown";
  }
}

/**
 * Map StopReason to TurnRecord.decision without `as` casts. maxTurns early
 * stops never record a turn, so that branch is unreachable; the
 * "nonSuccessStop" fallback keeps the mapping total.
 */
function toDecision(
  reason: string
): import("./trace/types.js").TurnRecord["decision"] {
  switch (reason) {
    case "completed":
    case "nonSuccessStop":
    case "protocolError":
    case "emptyFinalResponse":
    case "cancelled":
    case "timeout":
    case "fused":
      return reason === "fused" ? "nonSuccessStop" : reason;
    default:
      return "nonSuccessStop";
  }
}

/**
 * Derive a tool call's typed trace cause from the result the executor returned.
 *
 * The three sources are the result's own structured fields, never the message
 * text: ADR-0005's envelope tags a per-call deadline as `execution_failed` with
 * `message: "timeout"` and an outer cancel as `message: "cancelled"`, and the
 * spec forbids recognizing a failure class by substring-matching a model-facing
 * message. `computeToolStopFlags` already reads these two tags by strict
 * equality for control flow; this reads the same two facts for the trace, and
 * that agreement is the point — the row a reviewer reads and the stop the
 * engine took cannot disagree about why a call failed.
 *
 * `cleanup_unconfirmed` outranks the other two: an unconfirmed teardown is a
 * fault of its own that a reader must be able to filter on, and it does not
 * erase the timeout/cancel that caused it (both stay on the row — `cleanup`
 * still carries the evidence, and `error.message` still carries the envelope).
 *
 * Returns undefined when the result offered nothing to read. Absence is
 * meaningful — a policy denial and an ordinary execution failure are both
 * "no typed cause" — so this never defaults to a value.
 */
function toToolCallCause(result: {
  readonly kind: string;
  readonly message?: string;
  readonly cleanup?: { readonly state: string };
}): ToolCallCause | undefined {
  if (result.cleanup?.state === "unconfirmed") return "cleanup_unconfirmed";
  if (result.kind !== "execution_failed") return undefined;
  if (result.message === "timeout") return "timeout";
  if (result.message === "cancelled") return "cancelled";
  return undefined;
}

/**
 * The row's `error.message` for one failed result: the model-facing summary
 * when the result carries one, and otherwise the kind itself. `tool_not_found`
 * has no summary — its informative half is the tool name, which already rides
 * on `toolName` — so repeating its kind keeps the row readable rather than
 * dropping the field a consumer may filter on.
 */
function errorMessageFor(result: ToolExecutionResult): string {
  return result.kind === "execution_failed" ||
    result.kind === "validation_failed"
    ? result.message
    : result.kind;
}

/**
 * Build one tool-call trace row from the result the executor returned.
 *
 * Split out of the tool phase so the phase reads as "one row per result" and
 * the row's own shape — which failures keep the model's message, which carry a
 * typed cause, which carry teardown evidence — lives in one place next to
 * `toToolCallCause`, whose two tags it repeats. The caller keeps nothing of
 * that: it passes the result and the surrounding bookkeeping and records what
 * comes back.
 *
 * `cleanup` is read only off an `execution_failed` result because no other kind
 * produces one, so a verdict on a row is always a fact about a call that ran.
 */
function toolCallRecordFor(input: {
  readonly parentLlmCallId: string | undefined;
  readonly result: ToolExecutionResult;
  readonly toolName: string;
  readonly arguments: unknown;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly durationMs: number;
}): ToolCallRecord {
  const { result } = input;
  const ok = result.kind === "ok";
  const cause = toToolCallCause(result);
  const cleanup: CleanupTraceEvidence | undefined =
    result.kind === "execution_failed" ? result.cleanup : undefined;
  return {
    parentLlmCallId: input.parentLlmCallId,
    toolName: input.toolName,
    toolKind: result.kind,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    durationMs: input.durationMs,
    argumentsCaptured: true,
    arguments: input.arguments,
    resultCaptured: false,
    status: ok ? "ok" : "error",
    ...(ok
      ? {}
      : {
          error: {
            type: result.kind,
            message: errorMessageFor(result),
          },
        }),
    ...(cause !== undefined ? { cause } : {}),
    ...(cleanup !== undefined ? { cleanup } : {}),
  };
}

/**
 * The full Adapter interface Loop Engine needs: besides step, the adapter
 * must encode user text and tool results for the history append. Both the
 * Anthropic Adapter and the stub model implement this interface.
 */
export interface LoopAdapter {
  readonly step: (
    state: LoopState,
    request: {
      tools?: unknown;
      /** Resolved per turn from deps.system?.(); when undefined the system field is not sent. */
      system?: string;
      onStream?: (event: HarnessStreamEvent) => void;
      /** Best-effort observer of the final SDK request object,
       *  called once per attempt before dispatch. Evidence only — the engine
       *  appends to a local array and never lets it affect control flow. */
      onDispatch?: (evidence: SdkDispatchEvidence) => void;
    },
    signal?: AbortSignal // LoopAdapter is consumed directly by Loop Engine, so it must accept signal
  ) => Promise<AssistantTurnResult>;
  /**
   * ADR-0043: optional countTokens hook (overflow governance only).
   *
   * The real Anthropic adapter (`createRealAnthropicAdapter`) implements
   * this by proxying the SDK `client.messages.countTokens` measured token
   * count; stub / offline adapters do not (field absent → the assembly
   * layer skips the overflow session for this conversation and logs one
   * `console.warn` line; no throw and no retry on the first round — see
   * the skip semantics in `aci/tool-overflow.ts`).
   *
   * Two consumers read this hook: the assembly layer once at assembly time
   * (overflow governance), and loop-engine's #1079 call-beat probe before
   * every model call (only when the host carries onStream — see
   * `emitPreCallContextUsage`). Adapters without it are skipped on the beat
   * (one warn per adapter instance); the bar is never filled by estimation.
   */
  readonly countTokens?: (
    input: CountTokensInput
  ) => Promise<CountTokensResult>;
  /**
   * Actual call-mode declaration: true = this adapter uses the streaming
   * arm (SDK `.stream()`); false/undefined = non-streaming arm / offline
   * stand-in. loop-engine reads it only at trace `recordLlmCall` (it never
   * reads, judges, or constructs other vendor fields); the default keeps
   * stub-model / offline adapters at `stream: false` with zero changes.
   */
  readonly streamMode?: boolean;
  readonly encodeUserText: (userText: string) => AnthropicNativeMessage;
  readonly encodeToolResults: (
    results: ReadonlyArray<ToolExecutionResult>
  ) => AnthropicContentBlock[];
}

export interface LoopEngineDeps {
  readonly adapter: LoopAdapter;
  readonly executor: Executor;
  readonly registry: Registry;
  /** Effective thinking settings for this engine turn, forwarded to tools. */
  readonly parentThinking?: ThinkingParams;
  /**
   * ADR-0012: max loop turns per session (optional). `undefined`
   * (default) = unlimited (the loop never stops on turn count); when
   * configured and the cap is reached → throw MaxTurnsExceeded
   * (ADR-0011, see stepWithTrace).
   */
  readonly maxTurns: number | undefined;
  /**
   * Per-turn system-prompt assembler. string → passed through as
   * adapter.step request.system; undefined / field absent → injection is
   * skipped (zero behavior change, honoring the assembly contract).
   */
  readonly system?: () => Promise<string | undefined>;
  /** Primary timeout; runtime falls back to DEFAULT_TIMEOUT_MS (not hardcoded in the type layer) */
  readonly timeoutMs?: number;
  /** Model-side override; effective = modelTimeoutMs ?? timeoutMs ?? DEFAULT_TIMEOUT_MS */
  readonly modelTimeoutMs?: number;
  /**
   * Silence cap (ms) for a single model call, per the CONTEXT glossary
   * entry "model-call idle". Only effective on the streaming arm
   * (`adapter.streamMode === true`) — the non-streaming arm has no
   * increments to reset it, so a configured value is treated as absent
   * (pre-change single-clock behavior stays byte-identical). Absent /
   * <= 0 → disabled.
   */
  readonly modelIdleTimeoutMs?: number;
  /**
   * Hard wall cap (ms) for one model call on the streaming arm, measured
   * from the start of this step; when it fires, stop as `timeout` even if
   * increments are still arriving. Streaming arm only; absent → falls
   * back to `modelTimeoutMs ?? timeoutMs ?? DEFAULT_TIMEOUT_MS`.
   *
   * On the streaming arm it replaces `timeoutMs` as the wall clock:
   * `timeoutMs` counts "from process start", which was the source of
   * false kills this cap fixes; to tighten the wall clock on the streaming
   * arm, tune this field instead of `timeoutMs`.
   */
  readonly modelHardCapMs?: number;
  /**
   * Backoff (ms) before re-issuing the whole call after an invisible clock
   * fires (transport-continue-persist invariant 4 test seam). Absent → the
   * production exponential table (1s / 2s / 4s / 8s, capped at 16s). Only
   * tests shrink it; production assembly never passes it.
   *
   * Same "time seam" discipline as `withTransportRetry`'s `sleep`
   * injection: the backoff table itself is pinned directly by
   * transport-retry.test.ts; this seam only spares loop-level integration
   * cases from real second-long waits.
   */
  readonly transportRetryDelayMs?: (attempt: number) => number;
  /** Tool-side override; effective = toolTimeoutMs ?? timeoutMs ?? DEFAULT_TIMEOUT_MS */
  readonly toolTimeoutMs?: number;
  /**
   * Independent short timeout (ms) for the closing summary. Default
   * 15000. Summary failure / timeout → skipped; it must never block the
   * original stop reason. Tests may use small values for speed.
   */
  readonly summaryTimeoutMs?: number;
  /** 064 T4: optional TraceService injection; byte-identical when absent (criterion 5/17) */
  readonly trace?: TraceService;
  /**
   * Optional agent version (injected by the caller / CLI side via the
   * getVersion() value). A session L1 root record is written at the end of
   * run only when both `trace` and `agentVersion` are present (Loop Engine
   * does not import cli/usage.ts, avoiding a write-side ← cli reverse
   * dependency). Field absent → no session record, byte-identical
   * behavior (existing tests untouched).
   */
  readonly agentVersion?: string;
  /**
   * Injection seam: the assembly layer provides "the tool set that should
   * enter the prompt for the current turn". Read via
   * deps.promptTools?.() before every model call; returns
   * ReadonlyArray<ToolDef> (Foundation tool descriptors).
   * Defaults to deps.registry.list() (behavior-neutral).
   */
  readonly promptTools?: () => ReadonlyArray<ToolDef>;
  /**
   * Compaction config seam. Field absent = compaction disabled (zero
   * behavior change). contextWindow is the strategy budget window
   * (default 256000); thresholdTokens defaults to
   * `floor(0.95 × window)` (see harness/compress/threshold.ts, ADR-0100).
   */
  readonly compress?: {
    readonly contextWindow: number;
    readonly thresholdTokens: number | undefined;
  };
  /**
   * Per-engine secret registry. When present, run() replaces secret values
   * in user text with `<<<SECRET_N>>>` placeholders before encoding the
   * first user message. Absent → legacy byte-identical behavior (plaintext
   * into messages).
   */
  readonly secretRegistry?: SecretRegistry;
  /**
   * Secret handling mode. "block" disables recognition (the legacy
   * deny-only preToolUse guard handles secrets); default (undefined) =
   * "roundtrip" → recognition active when secretRegistry exists.
   */
  readonly secretsMode?: "roundtrip" | "block";
  /**
   * Compact boundary rendering seam. Optional closure — when compaction
   * triggers and it returns a non-empty string, `applyCompactAttachment`
   * appends one more user message after the boundary placeholder user
   * message carrying the rendered text (e.g. a recent-user-task digest).
   * Field absent → the helper early-returns, behavior identical to before
   * (stop semantics unchanged, ADR-0011). harness does not import
   * session-api; the rendered text comes from the caller (e.g. the hub's
   * `renderRecentUserTasksBoundary` private closure) via closure
   * injection, zero reverse dependency.
   *
   * History: the earlier version was driven by a taskFocus field
   * (`renderTaskFocusBoundary`); after taskFocus was retired, the render
   * source became the `extractRecentUserTasks` digest over
   * `session.messages`.
   */
  readonly boundaryAttachment?: () => string | undefined;
  /**
   * conversationId of the current session (pure bookkeeping + input
   *
   // (ADR-0021)
   * filter). Injected per-session by the surface layer (chat-session /
   * hub); loop-engine passes it through executor.executeAll's 4th
   * argument into tool ctx (bash-output / bash-stop compare
   * ctx.conversationId against the task's conversation_id). Field absent
   * = no filtering (ask / worker / oneshot assemblies see zero behavior
   * change).
   */
  readonly conversationId?: string;
  /**
   * Skill model-index entry seam (ADR-0098). When present, stepWithTrace
   * calls `computeSkillIndexDelta` once right before every model call
   * (first call + the retry after reactive-compact compaction): rescan
   * the live skill roots → `model index − index-entry ledger` → an
   * `<available_skills>` text containing only newly created rows, appended
   * to the tail of the current `messages` through the same
   * `pendingInjected.record` path as appendMcpReconnect /
   * appendAgentStatusBar; nothing new → zero append. The entry ledger is
   * persisted inside the delta producer before it returns; a persist
   * failure → no append (listed in the spec's input-contract exceptions).
   * Field absent = zero behavior change (ask / worker and existing tests
   * byte-identical; same optional-seam discipline as sibling seams).
   *
   * Ordering: after agentStatusBar / envSnapshot — the delta must be the
   * last model-visible message of the round.
   */
  readonly skillIndexDelta?: SkillIndexDeltaSeam;
  /**
   * In-turn commit hook (optional). The host (hub / chat-session) injects
   * a plain async closure that flushes messages already in the
   * authoritative history to disk immediately; loop-engine itself does
   * zero IO — it knows no store / file / session format, and the hook
   * only accepts AnthropicNativeMessage (no session-api types enter the
   * kernel).
   *
   * Call sites (strictly ordered within one run):
   *   (a) right after an assistant message is appended to the
   *       authoritative history — both pure-text endings and tool turns
   *       commit;
   *   (b) right after each tool result arrives — one user message
   *       carrying that result's encoded tool_result block (block-for-
   *       block identical to the batched authoritative append, since
   *       encodeToolResults maps element-wise).
   *
   * Field absent → zero commits, behavior exactly as before
   * (byte-identical). Failure semantics: a throwing hook is wrapped in
   * MessageCommitError and rethrown, aborting the run; no retry, no
   * swallowing, no change to stop semantics (see MessageCommitError in
   * errors.ts).
   *
   * The 2nd parameter `thinkingMs?: number` is the assistant turn's
   * persisted thinking duration (ms). Only the assistant commit site
   * passes `turnResult.thinkingMs` (adapter streaming arm: first
   * thinking_delta → first non-thinking increment); tool_result commit
   * sites pass undefined. `thinkingMs <= 0` or non-finite → field absent,
   * the store does not attach the key. number is not a session-api type,
   * so the kernel-dependency gate holds.
   */
  readonly commitMessages?: (
    messages: ReadonlyArray<AnthropicNativeMessage>,
    thinkingMs?: number
  ) => Promise<void>;
  /**
   * Runtime-state persistence seam (session saved-state plan B). When present,
   * the engine publishes a full saved state at each boundary the spec names
   * (accepted input, settled tool batch, compaction, settled terminal turn) and
   * appends a fact as each tool call returns, so a fresh process can recover
   * without re-deriving the turn from the transcript.
   *
   * Session-bound, like `commitMessages`: the host injects an
   * already-constructed sink in its per-run deps overlay, because the engine is
   * assembled without session identity. Every call site awaits it; a throwing
   * sink blocks the dependent execution instead of falling back (same rule as
   * `commitMessagesOrThrow`, and the reason the two are always paired).
   *
   * Field absent → zero persistence requests, behavior byte-identical to
   * before this seam existed.
   */
  readonly runtimePersistence?: RuntimePersistenceSink<AnthropicNativeMessage>;
  /**
   * Status-bar injection seam (ADR-0028). When present, stepWithTrace
   * appends the freshly computed current state (last_tool + unchecked
   * todo section) immutably as a user message to the tail of the current
   * `messages` right before every model call (first call +
   * reactive-compact retry); the old bar is kept — no splice, no write to
   * deps.system. Field absent = zero injection (ask / worker paths and
   * existing tests byte-identical). todoDir is the same session directory
   * used by the todo_write tool; the bar only reads files — snapshot
   * computation is in agent-status.ts (a read failure is treated as "no
   * todo section" and never throws into the model turn).
   */
  readonly agentStatus?: { readonly todoDir: string };
  /**
   * Environment-present state event seam (optional). When present, at the
   * same turn-boundary computation point right after
   * appendAgentStatusBar, stepWithTrace calls `readCwd()` to read the
   * live taskRoot and emits readEnvSnapshot's product as an
   * `env_snapshot` stream event via safeEmitStream (a stream parallel to
   * agent_status; host UI only, never into messages / verify / the
   * ADR-0028 bar). Field absent → zero IO, zero events (ask / worker /
   * existing stub assemblies byte-identical). readEnvSnapshot never
   * throws, and observer exceptions are swallowed by safeEmitStream,
   * leaving the model turn unaffected.
   *
   * env_snapshot must read the live taskRoot (ADR-0037) so that
   * post-rebind human-facing surfaces (TUI cwd / git summary) follow the
   * new worktree. `readCwd` is a live reader (LiveTaskRoot.read) injected
   * by the assembly layer, re-read on every env_snapshot computation —
   * not pinned at assembly time, otherwise display surfaces outside the
   * KV cache would stay on the pre-rebind root.
   *
   * Naming: the field is `readCwd` rather than `readTaskRoot` to keep the
   * env_snapshot data-stream cwd semantics (readEnvSnapshot takes cwd),
   * but its value actually comes from the live LiveTaskRoot — when
   * reading readEnvSnapshot internals, do not assume the cwd was pinned
   * at assembly time.
   */
  readonly envSnapshot?: EnvSnapshotSeam;
  /**
   * Graph-mode toggle injection seam. When present, stepWithTrace calls
   * it before every model call, just ahead of appendAgentStatusBar,
   * comparing this round's graphAssembly.enabled() against the previous
   * value held in `lastSeenEnabled`: on a flip, one single-line static
   * text (graph-on includes orchestration guidance, graph-off a shutdown
   * note) is appended immutably as a user message; same value → zero
   * append. Field absent = zero append (ask / worker / entries without
   * the overlay see zero behavior change, byte-identical).
   * `lastSeenEnabled` is a mutable reference living as long as deps; the
   * host naturally creates a fresh one when rebuilding the engine, so
   * nothing leaks across sessions.
   */
  readonly graphModeChange?: {
    readonly assembly: GraphAssembly;
    /** Graph state last seen by this deps (written by host/loop-engine; this seam only reads + writes it). */
    readonly lastSeenEnabled: { value: boolean | undefined };
  };
  /**
   * ADR-0081 — one short graph-mode presence line per `run()` seam.
   * When present, before the first model call of the run (including the
   * first check ahead of that run's reactive-compact retry), after
   * appendGraphModeChange and before appendMcpReconnect,
   * `assembly.enabled()` decides whether to append one short
   * `<graph_mode>` line (IKNOW_GRAPH_MODE_PRESENCE_NOTIFICATION, SSOT in
   * graph/notification.ts):
   *   - seam absent → zero append (ask / worker / entries without the
   *     overlay see zero behavior change);
   *   - `enabled() === false` → zero append (holder off / never opened);
   *   - appendGraphModeChange just pasted the long ON in this tick → zero
   *     append and no short line for the rest of the run (long ON and the
   *     short line never coexist in one tick);
   *   - `appendedThisRun` already set → zero append (later hops / compact
   *     retries in the same run);
   *   - otherwise → the presence line is appended immutably as a user
   *     message and recorded in pendingInjected (same shape as
   *     appendGraphModeChange).
   * `run()` resets `appendedThisRun`; the exported `step()` does not, so
   * consecutive steps over the same deps are hops of one run. The check
   * reads `assembly.enabled()` (round snapshot), never the holder, and
   * never writes lastSeenEnabled. Not into system / run_graph receipts /
   * the <agent_status> bar.
   */
  readonly graphModePresence?: {
    readonly assembly: GraphAssembly;
    /** Whether this run has settled the presence line (pasted, or suppressed by the long ON). Boxed at assembly time; reset by run(). */
    readonly appendedThisRun: { value: boolean };
  };
  /**
   * ADR-0043: MCP manual-reconnect append seam. When present,
   * stepWithTrace consumes `takePending()` right before every model call
   * to get reconnect events "recorded by the callback but not yet in the
   * transcript", and appends each event immutably as a user message with
   * a single-line static text (template pinned by
   * MCP_RECONNECT_NOTIFICATION_TEMPLATE); no pending → zero append.
   * Field absent = zero append (ask / worker / entries without the
   * manager see zero behavior change, byte-identical).
   *
   * Data flow: during build-engine assembly, `manager.onManualReconnect(cb)`
   * pushes events into `pending` (the callback fires on the success path
   * of TUI / CLI reconnect actions); loop-engine takes them at the next
   * step boundary and appends, after which events never repeat (take =
   * drain + clear, one-shot consumption). Schema changes themselves enter
   * tools via manager's registerExternal (the next promptTools naturally
   * includes them); this seam only informs the model that the new
   * server's tools are available.
   */
  readonly mcpReconnect?: {
    /** Drain all pending events (one-shot consumption; internal state cleared after return). */
    readonly takePending: () => ReadonlyArray<{
      readonly server: string;
      readonly tools: ReadonlyArray<string>;
    }>;
  };
  /**
   * Tool-loop detection. Default / true = enabled; false = disabled.
   */
  readonly detectToolLoop?: boolean;
}

/**
 * Freeze a message and its content blocks. Blocks are flat objects
 * ({type, text}/{type,id,name,input}/...); a shallow
 * `Object.freeze({ ...b })` of each block's own enumerable properties
 * suffices (input is an immutable snapshot given by the model and must
 * not be mutated by the loop).
 */
function freezeMessage(msg: AnthropicNativeMessage): AnthropicNativeMessage {
  return Object.freeze({
    role: msg.role,
    content: Object.freeze(msg.content.map((b) => Object.freeze({ ...b }))),
    // ADR-0112: the host-provenance stamp survives freezing (compact
    // re-freeze clones and priorMessages continuation all pass through
    // this seam; losing the stamp would make an already-stamped host
    // frame get re-translated on the next outbound call, drifting the KV
    // prefix).
    ...(msg.hostInjected === true ? { hostInjected: true } : {}),
  });
}

/**
 * Invoke the host-injected commit hook; hook absent = zero-IO early return
 * (behavior unchanged). Hook failures are uniformly wrapped in
 * MessageCommitError and rethrown (named failure, never silent).
 *
 * The 2nd parameter `thinkingMs` is passed through to the host hook;
 * absent (undefined) → the host hook attaches no key, keeping the
 * existing byte-identical behavior. tool_result commit sites pass
 * undefined; assistant commit sites pass `turnResult.thinkingMs` (possibly
 * undefined: non-stream / no thinking / invalid boundary).
 */
async function commitMessagesOrThrow(
  deps: LoopEngineDeps,
  messages: ReadonlyArray<AnthropicNativeMessage>,
  thinkingMs?: number
): Promise<void> {
  if (deps.commitMessages === undefined) return;
  try {
    await deps.commitMessages(messages, thinkingMs);
  } catch (err) {
    throw new MessageCommitError(err);
  }
}

// ---------------------------------------------------------------------------
// Runtime-state persistence (session saved-state plan B)
// ---------------------------------------------------------------------------
//
// The neutral port is the engine's only seam for session state: the engine
// decides *what* a boundary means and hands over the exact context or fact, the
// host owns storage. Absent port → every helper below is a no-op, so an
// unwired run keeps exactly its prior behavior.
//
// Failure policy mirrors the commit hook: a rejected write is wrapped and
// rethrown, never retried and never swallowed, because each of these writes is
// what makes a durable boundary durable. A swallowed rejection would let the
// run continue as if the state were saved. `boundary` names the write that
// failed (a saved-state boundary, or an operation fact kind) so a caller can
// tell which one lost — the commit chain and the runtime-state chain are
// independent seams and must not be confused when a run aborts.

/**
 * Run-scoped box for the frozen prompt prefix (plan B2: a reopened session must
 * not need current settings to re-assemble its context).
 *
 * Two writers, one box. Every model request overwrites it with the exact
 * `system` it is about to send, so a publication that follows a request carries
 * that request's bytes rather than a re-derivation. A run's first publication
 * precedes any request, so it seeds the box from the same per-turn seam
 * instead — once per run, shared by every boundary, so two publications of one
 * run cannot disagree about the prefix their context was assembled against.
 */
interface FrozenSystemPrefix {
  /**
   * False until the seam has been resolved once. `resolved` is what separates
   * "this run has not asked yet" from "asked, and the answer was no prefix":
   * without it a seam that yields nothing would be re-resolved at every
   * boundary.
   */
  resolved: boolean;
  prefix: string | undefined;
}

function createFrozenSystemPrefix(): FrozenSystemPrefix {
  return { resolved: false, prefix: undefined };
}

/**
 * Publish one full saved state, attaching the run's frozen prompt prefix.
 *
 * The assembly field is attached here rather than at each site so that "every
 * boundary carries the prefix" is structural, not per-call-site discipline.
 * Absent prefix → no `assembly` key at all, mirroring the request itself (a
 * run that sends no `system` has no frozen prefix to publish). A rejecting
 * `deps.system` aborts the run here exactly as it does at the request path: the
 * state is not published with a prefix nobody could resolve. No-op without the
 * port, and then also without resolving the seam — an unwired run must not pay
 * for an assembly it never reports.
 */
async function publishSavedStateOrThrow(
  deps: LoopEngineDeps,
  frozen: FrozenSystemPrefix,
  request: Omit<RuntimeSavedStateRequest<AnthropicNativeMessage>, "assembly">
): Promise<void> {
  const sink = deps.runtimePersistence;
  if (sink === undefined) return;
  if (!frozen.resolved) {
    frozen.prefix = await deps.system?.();
    frozen.resolved = true;
  }
  try {
    await sink.publishSavedState(
      frozen.prefix === undefined
        ? request
        : { ...request, assembly: { systemPrefix: frozen.prefix } }
    );
  } catch (err) {
    throw new RuntimeStatePersistenceError(request.boundary, err);
  }
}

/** Append one operation fact; no-op without the port. */
async function appendOperationFactOrThrow(
  deps: LoopEngineDeps,
  fact: RuntimeOperationFact<AnthropicNativeMessage>
): Promise<void> {
  const sink = deps.runtimePersistence;
  if (sink === undefined) return;
  try {
    await sink.appendOperationFact(fact);
  } catch (err) {
    throw new RuntimeStatePersistenceError(fact.kind, err);
  }
}

/**
 * Whether a result is a *settled* operation. `background: true` is the
 * ADR-0134 detached-handler receipt — the caller already got a failure while
 * the handler kept running, so the operation is outstanding and must not be
 * recorded as settled anywhere. Every other result, a returned tool error
 * included, is a settled receipt.
 */
function isSettledToolResult(result: ToolExecutionResult): boolean {
  return !(result.kind === "execution_failed" && result.background === true);
}

/**
 * Whether an assistant turn's tool batch has a settled end: every call it made
 * produced a result, and none of those results belongs to an operation that is
 * still running. The call-count half matters because the batch boundary is a
 * claim about the context — a result array shorter than the batch means some
 * call never entered the merged message, and claiming otherwise would hand a
 * recovery reader a batch it cannot assemble.
 */
function isBatchSettled(opts: {
  readonly results: ReadonlyArray<ToolExecutionResult>;
  readonly callCount: number;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
}): boolean {
  return (
    opts.results.length === opts.callCount &&
    !opts.timedOut &&
    !opts.cancelled &&
    opts.results.every(isSettledToolResult)
  );
}

/**
 * Append the durable fact for one settled result of a wave.
 *
 * WHY a separate seam, at settlement instead of in the prefix flush: the fact
 * carries `batchPosition`, so reconstruction restores protocol order without
 * waiting for the commit prefix — that is what makes a result durable while an
 * earlier call of the same wave is still blocked. A still-running operation has
 * no settled outcome and gets no fact. A rejected write rejects the settling
 * call itself and leaves the prefix counters untouched, so no half-drained
 * prefix is left behind.
 *
 * Position and size are the BATCH's, never the wave's: the wave is one
 * concurrency split of the batch, so a wave-local index would give every wave a
 * second call at position 0 and a reader would have no order to restore.
 */
async function appendSettledResultFactOrThrow(
  // WHY the name: the argument is the wave's execution context, not the wave
  // itself — `ctx.batchOffset` / `ctx.batchSize` are where this wave's calls sit
  // inside the whole batch. Naming it `wave` made `wave.wave` read like a typo
  // at every use site.
  ctx: {
    readonly deps: LoopEngineDeps;
    readonly turnId: string;
    /** Calls of this batch that precede the wave. */
    readonly batchOffset: number;
    /** Calls in the whole batch, not in this wave. */
    readonly batchSize: number;
  },
  result: ToolExecutionResult,
  indexInWave: number
): Promise<void> {
  if (!isSettledToolResult(result)) return;
  await appendOperationFactOrThrow(ctx.deps, {
    kind: "tool_result",
    toolUseId: result.toolUseId,
    turnId: ctx.turnId,
    batchPosition: ctx.batchOffset + indexInWave,
    batchSize: ctx.batchSize,
    resultMessage: {
      role: "user",
      content: ctx.deps.adapter.encodeToolResults([result]),
    },
  });
}

/**
 * Publish the accepted input, at most once per run (the latch box is the
 * caller's run-scoped mutable state, so the loop body keeps no second copy).
 * turnId is honestly null: the id is minted at dispatch, and this boundary
 * sits before the first dispatch. The box is also what seeds the run's frozen
 * prefix — no request has been sent yet, so the seam is the only honest source
 * for the prefix this boundary is about to be followed by.
 *
 * WHY the "did this run append user text" rule lives here: a run that appended
 * none (a silent host wake) has no accepted input to publish, and the latch must
 * not be consumed by a boundary that never had one. Keeping the rule with the
 * publisher means the loop body carries no branch that has to stay in step with
 * the latch.
 */
async function publishAcceptedInputOnceOrThrow(
  deps: LoopEngineDeps,
  latch: { published: boolean },
  frozen: FrozenSystemPrefix,
  messages: ReadonlyArray<AnthropicNativeMessage>,
  acceptedUserText: boolean
): Promise<void> {
  if (!acceptedUserText) return;
  if (latch.published) return;
  await publishSavedStateOrThrow(deps, frozen, {
    boundary: "accepted_input",
    turnId: null,
    messages,
  });
  latch.published = true;
}

/**
 * Run-scoped pending buffer for injected messages (save-fork fix).
 *
 * appendGraphModeChange / appendMcpReconnect / appendAgentStatusBar append
 * user injection messages immutably into the in-memory authoritative
 * history, but never pass through commitMessagesOrThrow to the JSONL
 * chain. After run ends, the host's closing save (hub / chat) aligns the
 * in-memory projection (which contains injected messages) with the pure
 * commit chain via LCP; the first injected message breaks jsonDeepEqual →
 * planSessionSave reports a fork, parent falls back and the real prefix is
 * orphaned, so the next run replays the whole round from the query.
 *
 * This buffer makes injected messages flush with the next assistant /
 * tool_result commit batch (same shape as the existing loop-detected
 * envelope), restoring the invariant:
 *   "in-memory authoritative history − seed query" == "on-disk commit
 *    chain − the host's lazily-committed query prefix".
 * Stop-path handling:
 *   - cancelled: run()'s closing flushes pending + system interrupt
 *     together after appendSystemInterrupt (the closing save's projection
 *     aligns with the chain, no fork);
 *   - protocolError / emptyFinalResponse: pending is discarded (the turn
 *     never enters history; save reports prefix/extension, adding no new
 *     fork surface);
 *   - timeout / fused / nonSuccessStop: pending has already flushed with
 *     the last tool_result / assistant commit; nothing remains.
 *   - compact (reactive / proactive): after rebuilding history, pending
 *     is cleared — the compaction product and the old chain are not
 *     LCP-alignable anyway (existing fork-copy semantics), and flushing
 *     old pending would write messages that may no longer be in memory.
 * When the hook is absent (commitMessages undefined) the buffer still
 * accumulates/clears normally — flush is a no-op, zero-IO semantics
 * unchanged.
 */
function createPendingInjected() {
  let pending: AnthropicNativeMessage[] = [];
  return {
    /** Called at injection points: buffer the message and return it for appendMessage to add to the authoritative history. */
    record(msg: AnthropicNativeMessage): AnthropicNativeMessage {
      pending.push(msg);
      return msg;
    },
    /** Called at commit points: return all pending and clear (flush-on-take, order preserved). */
    take(): AnthropicNativeMessage[] {
      if (pending.length === 0) return [];
      const flushed = pending;
      pending = [];
      return flushed;
    },
  };
}

type PendingInjected = ReturnType<typeof createPendingInjected>;

/**
 * Transport shape of the skill model-index entry seam (ADR-0098).
 * loop-engine only knows "get a delta once, paste it if non-empty" and
 * knows nothing of rescan / ledger / rendering — all of that lives in
 * `harness/skill/index-delta.ts` (the seam's producer).
 *
 * Why a closure instead of a `(rescanner, ledger)` pair: the host (three
 * entry points + tests) already builds rescanner / ledger at assembly
 * time; wrapping them in a closure keeps loop-engine free of any
 * `harness/skill/*` import — same "host injects a pure closure, engine
 * has no reverse dependency" discipline as `boundaryAttachment` /
 * `agentStatus` (no session-api / skill-subsystem types enter the
 * kernel).
 *
 * Failure semantics: when `delta()` throws a typed error
 * (`SkillRescanError` / `SkillIndexLedgerError` / anything future),
 * loop-engine swallows it and logs one `console.warn` line — no
 * injection, no aborted turn. The spec's input-contract exception wants
 * "never paste a partial delta, never touch the frozen table, keep the
 * entry ledger", and a single index-scan failure must not abort the turn
 * (same degradation shape as existing contracts: bar read failure → no
 * todo section, model turn unaffected). On persist failure
 * `computeSkillIndexDelta` already guarantees it returns no text, so
 * "swallow" here equals "do not treat the messages append as entered".
 *
 * Session anchor (a call parameter, not an assembly parameter): the
 * shape copies `agentStatus` — the host (especially serve) cannot know
 * conversationId at assembly time, so the per-session leaf is decided at
 * call time. The host forwards the `deps.conversationId` it received to
 * the seam; `undefined` (ask / worker / unanchored assembly) → the seam
 * returns an empty delta (no session anchor = no persistable entry
 * ledger).
 */
export interface SkillIndexDeltaSeam {
  /**
   * Fetch this round's delta. Empty text = nothing new = zero append.
   * Throw = skip this round (swallowed).
   */
  delta(conversationId: string | undefined): Promise<{
    readonly added: readonly string[];
    readonly text: string;
  }>;
}

function appendMessage(opts: {
  readonly state: LoopState;
  readonly msg: AnthropicNativeMessage;
}): LoopState {
  return {
    messages: Object.freeze([...opts.state.messages, freezeMessage(opts.msg)]),
    turnCount: opts.state.turnCount,
  };
}

/**
 * Same-real-user-message test for reconcile: object identity, OR a
 * re-freeze clone from reactive/proactive compact. `freezeMessage` clones
 * per message, so after compaction the kept tail's references change
 * while content does not; a pure reference compare would misread the
 * clone as a new message and re-mark the same instruction, violating
 * "marking appears only once for that jump". Within a single run the real
 * user message is appended exactly once at run() entry, and all later
 * user messages are host-injected (dropped by the extractor's roster),
 * so "same role + block-for-block same content" is equivalent to identity
 * on the settling surface — no second look-alike real message can
 * confuse it.
 */
function isSameRealUserMessage(
  a: AnthropicNativeMessage,
  b: AnthropicNativeMessage | undefined
): boolean {
  if (b === undefined) return false;
  if (a === b) return true;
  if (a.role !== b.role || a.content.length !== b.content.length) return false;
  for (let i = 0; i < a.content.length; i++) {
    const ca = a.content[i]!;
    const cb = b.content[i]!;
    if (ca.type !== cb.type) return false;
    if (ca.type === "text" && cb.type === "text" && ca.text !== cb.text) {
      return false;
    }
  }
  return true;
}

/**
 * ADR-0028: append the current status bar immutably as a user message at
 * the tail of `messages` (encoded via adapter.encodeUserText, the same
 * seam as the first user text). `deps.agentStatus` absent → return state
 * unchanged (zero injection); present → compute the snapshot fresh (todos
 * read failure is treated as "no todo section", see agent-status.ts) and
 * return the new state after appending. Never throws: read failure has
 * already converged to "no todo section", the model turn is unaffected.
 *
 * At the same computation point (one and the same snapshot object), an
 * `agent_status` stream event is emitted via safeEmitStream — the TUI's
 * read-only latest-state surface; the event fields are the bar's data
 * fields, so the two cannot diverge (single source of truth). Observer
 * exceptions are swallowed by safeEmitStream and never flow back into the
 * model turn. deps.agentStatus absent → no bar and no event (ask /
 * worker).
 *
 * Injection messages are also recorded into the pending buffer — they
 * flush to disk with the next assistant / tool_result commit batch,
 * eliminating the save-fork.
 *
 * Instruction echo: at the same computation point, the extractor
 * (`extractLatestRealUserInstruction`) reads the latest real user
 * instruction's first line from `state.messages`, which enters the bar's
 * `instruction:` line and the `agent_status` event with the same snapshot
 * (same source; verbatim echo, not a summary). No real user message → the
 * section is absent entirely. Extraction is pure reads and never throws;
 * append-only / pendingInjected discipline is unchanged.
 *
 * Reconcile settles once per run through the run-scoped box
 * `reconcileRef` — the extracted real user message differs from the
 * settled reference → this bar is marked and the box is updated; same
 * (including compact re-freeze clones, see `isSameRealUserMessage`) →
 * this bar carries `reconcile: false` (line absent, event key present).
 * Nothing to judge → the field slot is absent entirely and the box is not
 * cleared (cold start `stamped = undefined` is legitimate). Both call
 * sites (normal step and reactive-compact retry) share the same box and
 * settle identically.
 */
async function appendAgentStatusBar(
  state: LoopState,
  deps: LoopEngineDeps,
  lastTool: string,
  reconcileRef: { stamped: AnthropicNativeMessage | undefined },
  pendingInjected: PendingInjected,
  onStream?: (event: HarnessStreamEvent) => void
): Promise<LoopState> {
  if (deps.agentStatus === undefined) return state;
  const extracted = extractLatestRealUserInstruction(state.messages);
  let reconcile: boolean | undefined;
  if (extracted !== null) {
    const settled = isSameRealUserMessage(
      extracted.message,
      reconcileRef.stamped
    );
    reconcile = !settled;
    if (!settled) reconcileRef.stamped = extracted.message;
  }
  const snapshot = await computeAgentStatusSnapshot({
    lastTool,
    todoDir: deps.agentStatus.todoDir,
    // Per-conversation projection: read THIS session's ledger (same SSOT the
    // todo_write writer resolves through). deps.conversationId is injected
    // per-session by the surface layer (#502 T5); absent (ask / worker) →
    // legacy shared-root read.
    conversationId: deps.conversationId,
    instruction: extracted?.instruction ?? null,
    ...(reconcile !== undefined ? { reconcile } : {}),
  });
  safeEmitStream(onStream, {
    type: "agent_status",
    lastTool: snapshot.lastTool,
    openTodoLines: snapshot.openTodoLines,
    // Conditional presence: projection rule = pickPresentAgentStatusSlots
    // SSOT (same source as snapshot assembly and TUI event mapping; absent
    // → key does not appear, matching the bar text's "don't advertise
    // empty slots" shape).
    ...pickPresentAgentStatusSlots(snapshot),
  });
  // ADR-0112: stamp the non-model-visible provenance when the host-
  // injected message commits; stamped frames pass through the outbound
  // projection.
  const msg = stampHostInjected(deps.adapter.encodeUserText(snapshot.text));
  pendingInjected.record(msg);
  return appendMessage({ state, msg });
}

/**
 * Emitted at the same turn-boundary computation point after
 * appendAgentStatusBar: the environment snapshot goes out as an
 * `env_snapshot` stream event via safeEmitStream — a stream independent
 * of and parallel to `agent_status` (human-facing chrome data for the
 * TUI EnvironmentPane; for humans, not the model). It does not reuse the
 * agent_status event or snapshot structure, does not append any message
 * (state returned unchanged), and never enters messages / verify / the
 * ADR-0028 bar.
 *
 * deps.envSnapshot absent → zero-IO early return (ask / worker / existing
 * assemblies see zero behavior change). readEnvSnapshot never throws (git
 * failure → all git fields null, cwd retained, degraded exit); observer
 * exceptions are swallowed by safeEmitStream, the model turn is
 * unaffected.
 */
async function appendEnvSnapshot(
  state: LoopState,
  deps: LoopEngineDeps,
  onStream?: (event: HarnessStreamEvent) => void
): Promise<LoopState> {
  if (deps.envSnapshot === undefined) return state;
  // Re-read the live taskRoot before every model call instead of using an
  // assembly-time snapshot — so post-rebind the human-facing surfaces of
  // the next tool-call wave (TUI cwd / git summary) follow the live root,
  // while the system prompt stays pinned on the stable root and the KV
  // cache prefix bytes are unchanged.
  const snapshot = await readEnvSnapshot({ cwd: deps.envSnapshot.readCwd() });
  safeEmitStream(onStream, { type: "env_snapshot", snapshot });
  return state;
}

/**
 * Graph-mode toggle append seam. Compare this round's
 * graphAssembly.enabled() with the previous value in
 * `lastSeenEnabled.value`: flip → encodeUserText + appendMessage +
 * safeEmitStream emitting a `graph_mode_changed` stream event; same value
 * → zero append, state returned unchanged.
 *
 * Shape mirrors appendAgentStatusBar (seam absent → zero injection,
 * byte-identical behavior):
 *   - deps.graphModeChange absent → return state (ask / worker / entries
 *     without the overlay see zero behavior change);
 *   - seam present → called each step; multiple flips within one round
 *     are detected correctly;
 *   - the update write is done by this function; `lastSeenEnabled` shares
 *     deps' lifetime (the host naturally creates a fresh one on engine
 *     rebuild, so nothing leaks across sessions);
 *   - toggle text = SSOT (renderGraphModeChangeNotification): graph-on
 *     includes orchestration guidance, graph-off a shutdown hint —
 *     content consolidated into IKNOW_GRAPH_ORCHESTRATION_TEXT.
 *
 * Ordering: called before appendAgentStatusBar so the status bar comes
 * after the graph toggle notice (the later-injected message sits at the
 * tail; the model sees write order = read order).
 *
 * Return `{ state, appendedLongOn }`: `appendedLongOn === true` iff this
 * tick actually pasted the long ON notice while flipping into on
 * (IKNOW_GRAPH_MODE_ON_NOTIFICATION), used by the subsequent
 * appendGraphModePresence in the same segment as a dedupe signal — long
 * ON and the short presence line never coexist in one tick. All other
 * paths (off flip / same value / seam absent / initial observation) yield
 * false.
 *
 * Toggle notices are also recorded into the pending buffer and flush with
 * the next commit batch.
 */
async function appendGraphModeChange(
  state: LoopState,
  deps: LoopEngineDeps,
  pendingInjected: PendingInjected,
  onStream?: (event: HarnessStreamEvent) => void
): Promise<{ state: LoopState; appendedLongOn: boolean }> {
  const seam = deps.graphModeChange;
  if (seam === undefined) return { state, appendedLongOn: false };
  const next = seam.assembly.enabled();
  const last = seam.lastSeenEnabled.value;
  // First observation (last = undefined): only record the initial value,
  // no append — the first round of a new session / new deps has no flip to
  // speak of, and a graph-off start must not inject an off notice.
  if (last === undefined) {
    seam.lastSeenEnabled.value = next;
    return { state, appendedLongOn: false };
  }
  if (last === next) return { state, appendedLongOn: false };
  const change: GraphModeChange = next ? "on" : "off";
  const text = renderGraphModeChangeNotification(change);
  seam.lastSeenEnabled.value = next;
  safeEmitStream(onStream, {
    type: "graph_mode_changed",
    enabled: next,
  });
  const msg = stampHostInjected(deps.adapter.encodeUserText(text));
  pendingInjected.record(msg);
  return {
    state: appendMessage({ state, msg }),
    appendedLongOn: change === "on",
  };
}

/**
 * ADR-0081 — one short graph-mode presence line per `run()` seam.
 *
 * Ordering: called after appendGraphModeChange and before
 * appendMcpReconnect.
 *
 * Decision:
 *   1. deps.graphModePresence absent → zero append;
 *   2. graphModeChange absent (assembly mismatch) → zero append;
 *   3. `appendedThisRun` already settled → zero append (later hops /
 *      compact retries in the same run);
 *   4. `appendedLongOn === true` → settle the latch, zero append (long ON
 *      and short line never coexist);
 *   5. `assembly.enabled() === false` → zero append and no settle (while
 *      off, the next hop may still decide on the fresh snapshot after
 *      beginRound);
 *   6. otherwise → paste the short line and settle the latch.
 */
function resetGraphPresenceLatch(deps: LoopEngineDeps): void {
  const seam = deps.graphModePresence;
  if (seam === undefined) return;
  seam.appendedThisRun.value = false;
}

async function appendGraphModePresence(
  state: LoopState,
  deps: LoopEngineDeps,
  pendingInjected: PendingInjected,
  appendedLongOn: boolean
): Promise<LoopState> {
  const seam = deps.graphModePresence;
  if (seam === undefined) return state;
  // Conservative guard: presence present while change absent = assembly
  // mismatch (build-engine always wires both seams through the same gate
  // from the same source); then zero injection rather than letting
  // presence act independently of change's flip semantics (same
  // conservative stance as "overlay absent = zero injection").
  if (deps.graphModeChange === undefined) return state;
  const latch = seam.appendedThisRun;
  if (latch.value) return state;
  if (appendedLongOn) {
    latch.value = true;
    return state;
  }
  if (!seam.assembly.enabled()) return state;
  latch.value = true;
  const msg = stampHostInjected(
    deps.adapter.encodeUserText(IKNOW_GRAPH_MODE_PRESENCE_NOTIFICATION)
  );
  pendingInjected.record(msg);
  return appendMessage({ state, msg });
}

/**
 * Orchestration convergence for the two graph seams:
 * appendGraphModeChange → appendGraphModePresence are paired in a fixed
 * order (change first; presence takes appendedLongOn as the dedupe
 * signal). The first call and the reactive-compact retry share this
 * helper to remove verbatim duplication; the ordering semantics (before
 * mcpReconnect / agentStatusBar) stay with the callers.
 */
async function appendGraphSeams(
  state: LoopState,
  deps: LoopEngineDeps,
  pendingInjected: PendingInjected,
  onStream?: (event: HarnessStreamEvent) => void
): Promise<{ state: LoopState; appendedLongOn: boolean }> {
  const changed = await appendGraphModeChange(
    state,
    deps,
    pendingInjected,
    onStream
  );
  const next = await appendGraphModePresence(
    changed.state,
    deps,
    pendingInjected,
    changed.appendedLongOn
  );
  return { state: next, appendedLongOn: changed.appendedLongOn };
}

/**
 * ADR-0043: MCP manual-reconnect notification template (SSOT).
 *
 * Single-line static text: `<server>` + the tool-name list are filled in
 * by appendMcpReconnect at call time; this constant pins the wording
 * skeleton, and tests reference the constant rather than the literal.
 * Same shape as graph_mode_change: immutable user-message append,
 * first-class in the transcript, and the KV cache is only affected by
 * tail appends to messages (the tools/system prefix stays put).
 */
export const MCP_RECONNECT_NOTIFICATION_TEMPLATE =
  "MCP server '<server>' reconnected manually — its tools are now available: <tools>. Schemas were not loaded; call tool_search before invoking any of them.";

/**
 * ADR-0043: MCP manual-reconnect append seam. Consumes the pending events
 * from `deps.mcpReconnect.takePending()`, appending each as a single-line
 * text (MCP_RECONNECT_NOTIFICATION_TEMPLATE with `<server>` / `<tools>`
 * filled in) immutably as a user message.
 *
 * Shape mirrors appendGraphModeChange (seam absent → zero injection,
 * byte-identical):
 *   - deps.mcpReconnect absent → return state (ask / worker / no
 *     manager);
 *   - takePending() empty → zero append, state unchanged;
 *   - multiple pending events are appended one by one in record order
 *     (one event per reconnect);
 *   - message ordering: after the graph toggle notice, before the status
 *     bar — same decision segment as graphModeChange (environment-level
 *     events precede the per-turn status bar).
 *
 * Ordering: parallel to appendGraphModeChange, called before
 * appendAgentStatusBar so the status bar lands after the reconnect notice
 * (model read order = reconnect notice → status bar).
 *
 * Reconnect notices are also recorded into the pending buffer and flush
 * with the next commit batch.
 */
function appendMcpReconnect(
  state: LoopState,
  deps: LoopEngineDeps,
  pendingInjected: PendingInjected
): LoopState {
  const seam = deps.mcpReconnect;
  if (seam === undefined) return state;
  const pending = seam.takePending();
  if (pending.length === 0) return state;
  let next = state;
  for (const event of pending) {
    const text = MCP_RECONNECT_NOTIFICATION_TEMPLATE.replace(
      "<server>",
      event.server
    ).replace("<tools>", event.tools.join(", "));
    const msg = stampHostInjected(deps.adapter.encodeUserText(text));
    pendingInjected.record(msg);
    next = appendMessage({ state: next, msg });
  }
  return next;
}

/**
 * Skill model-index delta append seam (ADR-0098). Right before every
 * model call, take one delta from `deps.skillIndexDelta`; if non-empty,
 * append it immutably as a user message at the tail of the current
 * `messages` (the delta must be the round's last message — this round's
 * user text / skill-load envelopes / graph notices / reconnect notices /
 * status bar all precede it).
 *
 * Shape mirrors appendMcpReconnect (seam absent → zero injection,
 * byte-identical):
 *   - `deps.skillIndexDelta` absent → return state (ask / worker /
 *     existing assemblies);
 *   - `delta()` returns empty text → zero append ("nothing new, no
 *     paste");
 *   - `delta()` throws → swallow + console.warn (the turn is not aborted;
 *     "never paste a partial delta, keep the entry ledger" is guaranteed
 *     by the producer — on persist failure it returns no text).
 *
 * The entry ledger is not written from here: persistence happens inside
 * `computeSkillIndexDelta` before it returns (persist failure → the
 * messages append must not be treated as an entry).
 *
 * The injected message is also recorded into the pending buffer and flush
 * with the next commit batch — with a dual write to the ledger and
 * messages, persisting without committing would make save report a fork.
 */
async function appendSkillIndexDelta(
  state: LoopState,
  deps: LoopEngineDeps,
  pendingInjected: PendingInjected
): Promise<LoopState> {
  const seam = deps.skillIndexDelta;
  if (seam === undefined) return state;
  let text: string;
  try {
    // Session anchor read fresh from deps (same tick as
    // appendAgentStatusBar); serve's per-run runDeps inject it before the call.
    const delta = await seam.delta(deps.conversationId);
    if (delta.added.length === 0 || delta.text.length === 0) return state;
    text = delta.text;
  } catch (err) {
    // EXIT: typed error (rescan_failed / write_failed) → skip this round;
    // frozen table untouched; entry history persists.
    // Render with `errorMessage` (errors.ts single point) — the code-quality
    // typed-error catch contract forbids `instanceof Error ? … : String(…)`:
    // plain objects stringify to `[object Object]`, losing kind/context.
    console.warn(
      `[loop-engine] skill index delta skipped: ${errorMessage(err)}`
    );
    return state;
  }
  const msg = stampHostInjected(deps.adapter.encodeUserText(text));
  pendingInjected.record(msg);
  return appendMessage({ state, msg });
}

/** Ctrl+C / signal abort trigger this fixed system interrupt text.
 *  First-class in the Transcript: appended to the tail of
 *  LoopState.messages, surfacing with persistence / rendering / rewind;
 *  stripped at the provider boundary (buildMessageParams filter) and
 *  never entering the SDK wire body. A system entry is not a turn:
 *  splitTurns slices by `role === "user"` and non-tool_result, so system
 *  items naturally fall between adjacent turns. */
const SYSTEM_INTERRUPT_TEXT = "Interrupted by user.";

/** Append the system interrupt message immutably to the tail of the
 *  authoritative history; same freezing discipline as appendMessage, so
 *  the append-only invariant holds. */
function appendSystemInterrupt(state: LoopState): LoopState {
  return {
    messages: Object.freeze([
      ...state.messages,
      freezeMessage({
        role: "system",
        content: [{ type: "text", text: SYSTEM_INTERRUPT_TEXT }],
      }),
    ]),
    turnCount: state.turnCount,
  };
}

/**
 * ADR-0112: adapter view for runFullCompact. The compress bounded context
 * knows nothing of provenance stamps; stamping is the host committer's
 * duty (loop-engine): the compact request prompt is host-injected and
 * must carry the stamp, otherwise the outbound projection would translate
 * it as untrusted. This view is the only stamping seam for compact
 * requests (trace's inputMessages is also built through this view's
 * encodeUserText, so callers no longer stamp by hand).
 */
function makeCompactAdapterView(deps: LoopEngineDeps): CompactAdapter {
  const view: CompactAdapter = {
    step: (state, request, signal) => deps.adapter.step(state, request, signal),
    encodeUserText: (compactPromptText) =>
      stampHostInjected(deps.adapter.encodeUserText(compactPromptText)),
  };
  return Object.freeze(view);
}

/**
 * ADR-0108: model in-flight observation window buffer. `text` accumulates
 * the same bytes as the wall-side draft's text_delta; `modelInFlight`
 * marks whether this step's output is still undelivered (text of already-
 * delivered turns stays in the buffer but is not in flight, so closeout
 * must not keep it twice). Single declaration point shared by closeout /
 * window open / window close / stepWithTrace assembly surfaces.
 */
type ModelStreamWindow = { text: string; modelInFlight: boolean };

/**
 * ADR-0108 in-flight closeout keep (the same freeze knife as the wall):
 * when the model is cancelled / timed out mid-flight, the already-pinned
 * streaming prefix prefixRaw enters the authoritative history as this
 * turn's assistant message; tailRaw (still-growing block) is discarded;
 * without a prefix no assistant is written, but user + interrupt are still
 * written. Ordering invariant: split → (with prefix) assistant commits
 * with the batch (flushing pending injections along the way) →
 * (cancelled) interrupt appends and commits separately. A failed assistant
 * commit throws MessageCommitError immediately — never continue writing
 * the interrupt over a false history whose "prefix never entered".
 * Tool-side stops have modelInFlight=false — the assistant already
 * appended through the normal path, so this function passes straight
 * through.
 */
async function closeoutInFlightStop(opts: {
  readonly deps: LoopEngineDeps;
  readonly reason: StopReason;
  readonly finalState: LoopState;
  readonly modelStreamRef: ModelStreamWindow;
  readonly pendingInjected: PendingInjected;
}): Promise<LoopState> {
  const { deps, reason, finalState, modelStreamRef, pendingInjected } = opts;
  // ADR-0108: timeout and cancelled use the same keep knife (ADR-0091's
  // clock abort only reassigns the stop reason, it does not change keep
  // semantics); the interrupt wording still belongs to cancelled only.
  const keptPrefix =
    (reason === "cancelled" || reason === "timeout") &&
    modelStreamRef.modelInFlight
      ? splitStreamingMarkdown(modelStreamRef.text).prefixRaw
      : "";
  let keptState = finalState;
  if (keptPrefix !== "") {
    const keptMsg: AnthropicNativeMessage = {
      role: "assistant",
      content: [{ type: "text", text: keptPrefix }],
    };
    keptState = appendMessage({ state: finalState, msg: keptMsg });
    await commitMessagesOrThrow(deps, [...pendingInjected.take(), keptMsg]);
  }
  if (reason !== "cancelled") return keptState;
  // cancelled appends the system interrupt message to the tail of the
  // authoritative history (transcript first-class citizen). timeout is not
  // on this surface: clock abort ≠ user interrupt, so the fixed text
  // "Interrupted by user." does not apply (ADR-0091).
  const interrupted = appendSystemInterrupt(keptState);
  const interruptMsg: AnthropicNativeMessage = {
    role: "system",
    content: [{ type: "text", text: SYSTEM_INTERRUPT_TEXT }],
  };
  // cancelled's closing flushes leftover pending injections together with
  // the interrupt (when a keep prefix exists, pending has already flushed
  // with the assistant batch, so the interrupt forms its own batch) —
  // without the flush, the host's closing save would fork on an LCP
  // mismatch here. A no-op when there is no commitMessages hook.
  await commitMessagesOrThrow(
    deps,
    keptPrefix === ""
      ? [...pendingInjected.take(), interruptMsg]
      : [interruptMsg]
  );
  return interrupted;
}

/**
 * Unifies compaction + boundary-rendering across the two compact call
 * sites (reactive / proactive). The original placeholder path is kept and
 * now layered with the LLM structured-summary fast path:
 *
 *   1. `splitForCompaction(state.messages, DEFAULT_KEEP_RECENT)` reuses
 *      window.ts's tool-pair guard to split dropped / kept; nothing
 *      droppable → return state (same early return as the old
 *      `compacted === state.messages`);
 *   2. best-effort `runFullCompact` runs one LLM summary round over
 *      dropped (no tools → pure text; adapter refusal / timeout / empty
 *      response → various outcomes);
 *   3. `summarized` → `buildCompactedMessages`:
 *      [summary user message, (optional boundaryAttr), ...kept];
 *   4. `signal_aborted` (Claude Code-like semantics: cancelling during
 *      compaction keeps the session as-is, no fallback truncation —
 *      different from timeout / adapter_failed) → return state unchanged;
 *   5. all other outcomes → fall back to the existing `compactMessages` +
 *      boundary placeholder path (a summary failure must never block the
 *      main loop).
 *
 * Stop-semantics guard unchanged: boundaryAttachment absent → the summary
 * path inserts no attachment; the fallback path is byte-identical to
 * before; normal (non-compact) turns never invoke this helper.
 *
 * `opts.signal` / `opts.onStream` pass the run-level cancel signal and
 * stream observer through to `runFullCompact` — the reactive site passes
 * `opts.signal` (user cancels during the pre-retry compaction after
 * PromptTooLongError → keep as-is → end as protocolError); the proactive
 * site passes `opts?.onStream` (the host receives compaction_started /
 * completed / failed plus compaction_text_delta, remapped by full-compact
 * innerOnStream to guard against render pollution). Absent → zero
 * behavior change (old `signal: undefined` semantics).
 */
async function applyCompactAttachment(
  state: LoopState,
  deps: LoopEngineDeps,
  opts?: {
    readonly signal?: AbortSignal;
    readonly onStream?: (event: HarnessStreamEvent) => void;
  }
): Promise<LoopState> {
  const split = splitForCompaction(state.messages);
  if (split === undefined) return state;

  const startedAt = new Date().toISOString();
  const startMono = performance.now();
  const compactView = makeCompactAdapterView(deps);
  const inputMessages: ReadonlyArray<AnthropicNativeMessage> = Object.freeze([
    ...split.dropped,
    compactView.encodeUserText(buildCompactPrompt()),
  ]);
  const outcome = await runFullCompact({
    adapter: compactView,
    dropped: split.dropped,
    signal: opts?.signal,
    onStream: opts?.onStream,
  });
  const endedAt = new Date().toISOString();
  const durationMs = performance.now() - startMono;

  // Claude Code-like wait semantics: cancel mid-compaction (Esc/Ctrl+C) →
  // keep the session as-is, no fallback truncation (truncation would lose
  // messages on the summary-failure path, conflicting with the
  // "cancel = no change" semantics). The caller decides the follow-up
  // ending (reactive → protocolError; proactive → the next
  // stepWithTrace sees callerAbort and cancels).
  if (outcome.kind === "signal_aborted") {
    return state;
  }

  if (outcome.kind === "summarized") {
    const boundary = deps.boundaryAttachment?.();
    const composed = buildCompactedMessages({
      summaryText: outcome.text,
      kept: split.kept,
      boundaryText: boundary,
    });
    await recordCompactLlmCall({
      deps,
      startedAt,
      endedAt,
      durationMs,
      status: "ok",
      outcome,
      inputMessages,
    });
    return {
      ...state,
      // Continuing summary = host-injected commit: the first message
      // must carry the stamp, otherwise the outbound projection would
      // strip the COMPACT_SUMMARY official prefix as untrusted escaping.
      messages: Object.freeze(
        composed.map((m, i) =>
          freezeMessage(i === 0 ? stampHostInjected(m) : m)
        )
      ),
    };
  }

  // Summary failure / timeout / empty response / adapter refusal → fall
  // back to the old pure-truncation placeholder path.
  const compacted = compactMessages(state.messages);
  if (compacted === state.messages) return state;
  await recordCompactLlmCall({
    deps,
    startedAt,
    endedAt,
    durationMs,
    status: "error",
    outcome,
    inputMessages,
  });
  const boundary = deps.boundaryAttachment?.();
  const composed: ReadonlyArray<AnthropicNativeMessage> =
    boundary !== undefined && boundary.length > 0
      ? [
          compacted[0]!,
          { role: "user", content: [{ type: "text", text: boundary }] },
          ...compacted.slice(1),
        ]
      : compacted;
  return {
    ...state,
    messages: Object.freeze(composed.map((m) => freezeMessage(m))),
  };
}

/**
 * Full-summary degradation path for proactive auto-compact when tokens
 * already exceed the threshold but `splitForCompaction` has no window
 * (`messages.length <= DEFAULT_KEEP_RECENT`). The whole messages array is
 * treated as dropped (no kept tail) and `runFullCompact` runs one LLM
 * summary; on success, rebuild via `buildCompactedMessages`, hitting the
 * same `boundaryAttachment` injection point as windowed compaction.
 *
 * Semantic differences from `applyCompactAttachment`:
 *   - Input: the whole `state.messages` is treated as dropped (no
 *     `keepRecent` cut); `applyCompactAttachment` goes through
 *     `splitForCompaction` and keeps a 6-message kept tail.
 *   - Failure fallback: this path does NOT fall back to the
 *     `compactMessages` pure-truncation placeholder — treating all
 *     messages as dropped and then compacting equals wiping them, too
 *     aggressive (a summary failure must never block the main loop, but
 *     on the full-summary path we prefer to leave state untouched and let
 *     reactive handle PromptTooLongError, preserving the once-per-run
 *     contract). Failure / timeout / empty response / adapter refusal →
 *     return state unchanged; because the outer
 *     `compactedState.messages !== state.messages` check keeps
 *     `lastCompactTurn` from updating, the next step re-enters the gate
 *     and retries (no dead loop).
 *   - signal_aborted → state unchanged (Claude Code cancel semantics).
 *
 * `opts.signal` / `opts.onStream`: semantics identical to
 * `applyCompactAttachment` — the reactive site passes `opts.signal`
 * (user cancels during the pre-retry compaction after
 * PromptTooLongError → keep as-is → end as protocolError); the proactive
 * site passes `opts?.onStream` (host receives compaction_started /
 * completed / failed plus compaction_text_delta).
 */
async function applyFullCompactSummary(
  state: LoopState,
  deps: LoopEngineDeps,
  opts?: {
    readonly signal?: AbortSignal;
    readonly onStream?: (event: HarnessStreamEvent) => void;
  }
): Promise<LoopState> {
  if (state.messages.length === 0) return state;

  const startedAt = new Date().toISOString();
  const startMono = performance.now();
  const compactView = makeCompactAdapterView(deps);
  const inputMessages: ReadonlyArray<AnthropicNativeMessage> = Object.freeze([
    ...state.messages,
    compactView.encodeUserText(buildCompactPrompt()),
  ]);
  const outcome = await runFullCompact({
    adapter: compactView,
    dropped: state.messages,
    signal: opts?.signal,
    onStream: opts?.onStream,
  });
  const endedAt = new Date().toISOString();
  const durationMs = performance.now() - startMono;

  // Claude Code cancel semantics: mid-way signal abort → state unchanged
  // (same guard as applyCompactAttachment; see that helper's comment).
  if (outcome.kind === "signal_aborted") return state;

  if (outcome.kind === "summarized") {
    const boundary = deps.boundaryAttachment?.();
    const composed = buildCompactedMessages({
      summaryText: outcome.text,
      kept: [],
      boundaryText: boundary,
    });
    await recordCompactLlmCall({
      deps,
      startedAt,
      endedAt,
      durationMs,
      status: "ok",
      outcome,
      inputMessages,
    });
    return {
      ...state,
      // The full-summary degradation path shares the windowed branch's
      // contract: the continuing summary's first message = host-injected
      // commit, stamped before entering the authoritative history.
      messages: Object.freeze(
        composed.map((m, i) =>
          freezeMessage(i === 0 ? stampHostInjected(m) : m)
        )
      ),
    };
  }

  // Summary failure / timeout / empty response / adapter refusal → state
  // unchanged; let reactive handle PromptTooLongError (the once-per-run
  // contract is preserved). lastCompactTurn stays un-updated at the outer
  // level because `compactedState.messages === state.messages` → the next
  // round re-enters the gate; dead-loop defense is caught by
  // evaluateCompactTrigger itself (noop early return).
  await recordCompactLlmCall({
    deps,
    startedAt,
    endedAt,
    durationMs,
    status: "error",
    outcome,
    inputMessages,
  });
  return state;
}

/**
 * Trace persistence for the compact summary round (best-effort; failure
 * must not block). Mirrors epilogueSummary's recordLlmCall pattern: the
 * success path expands usage into the four token fields; the failure path
 * uses status "error" and error.message carrying outcome.kind (kind is
 * not in the TraceErrorType union, so it falls back to "unknown" with the
 * concrete kind kept in message for observers to distinguish). POSTEL
 * (ADR-0008): when usage is absent, the *_tokens keys are absent (not
 * zero).
 */
async function recordCompactLlmCall(opts: {
  readonly deps: LoopEngineDeps;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly durationMs: number;
  readonly status: "ok" | "error";
  readonly outcome: FullCompactOutcome;
  readonly inputMessages: ReadonlyArray<AnthropicNativeMessage>;
}): Promise<void> {
  if (opts.deps.trace === undefined) return;
  const streamMode = opts.deps.adapter.streamMode === true;
  const usage =
    opts.outcome.kind === "summarized" ? opts.outcome.usage : undefined;
  const error: TraceError | undefined =
    opts.status === "error"
      ? {
          type: "unknown",
          message: `compact_${opts.outcome.kind}${
            opts.outcome.kind === "adapter_failed"
              ? `: ${opts.outcome.message}`
              : ""
          }`,
        }
      : undefined;
  await safeTrace(() =>
    opts.deps.trace!.recordLlmCall({
      startedAt: opts.startedAt,
      endedAt: opts.endedAt,
      durationMs: opts.durationMs,
      ...(opts.status === "ok" ? { supplierStop: "success" } : {}),
      stream: streamMode,
      messagesCaptured: true,
      messages: opts.inputMessages,
      status: opts.status,
      ...(error !== undefined ? { error } : {}),
      ...(usage !== undefined ? usage : {}),
    })
  );
}

/**
 * Derive `result.finalText` from the authoritative history (called only
 * when `reason === "completed"`).
 *
 * Algorithm: scan messages backwards to the first assistant turn with
 * non-empty text and return its concatenated text blocks; skip empty-text
 * assistant turns (e.g. pure tool_use) and keep scanning; return null if
 * none.
 *
 * A subtle boundary difference exists vs `renderAssistantAnswer(
 * {showThinking:false})` in `src/cli/format.ts`: the latter stops at the
 * last assistant (no back-scan past empty text). The production path
 * `formatRunHuman` uses `result.finalText` (this function); the
 * divergence is only exposed by direct test calls of
 * `renderAssistantAnswer(false)` and is pinned for consistency by
 * invariant regression tests in `tests/cli/format.test.ts`.
 *
 * Exported so tests reference the same source of truth (the
 * `result.finalText` contract); not a general utility.
 */
export function deriveFinalText(
  messages: ReadonlyArray<AnthropicNativeMessage>
): string | null {
  return lastNonEmptyAssistant(messages)?.text ?? null;
}

/** Runtime fallback for timeouts. Only effective when both side-specific and primary timeout fields are absent; resolved per phase, never stored. */
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Epilogue (closing summary) constants, ADR-0011.
 *
 * The summary round is a pure-text single model call (no tools), best-
 * effort:
 *   - an independent short timeout so the summary never drags the
 *     original stop reason's return;
 *   - input = transcript tail within an ~8K token estimated window + the
 *     stop reason;
 *   - failure / timeout / signal already aborted → silently skipped; the
 *     original stop reason is never blocked.
 * The summary result is never appended into `_messages` (the append-only
 * authoritative history is unchanged).
 */
const SUMMARY_TIMEOUT_MS = 15_000;
const SUMMARY_TAIL_TOKEN_BUDGET = 8_000;
/** Message-count floor for the summary tail window (when the estimate exceeds the window, cut the tail by this many; named constant). */
const SUMMARY_TAIL_FALLBACK_MESSAGES = 20;
const SUMMARY_PROMPT = (reason: string): string =>
  `Briefly summarize in a few sentences what was done in this conversation and why it ended (stop reason: ${reason}). Keep it concise.`;

/**
 * ADR-0011: pure-text product of the best-effort closing summary model
 * call.
 *
 * The success path cares about exactly two things: `text` (the payload
 * delivered to the host's stop_summary event) and `usage` (the summary
 * round's token accounting, via trace `recordLlmCall` / `LlmCallRecord`,
 * status ok, Postel field presence — ADR-0008 does not diverge here).
 * failure / timeout / signal-abort → return null and the caller silently
 * skips, never blocking the original stop reason.
 */
interface SummaryOutcome {
  readonly text: string;
  readonly usage: TokenUsage | undefined;
  /** The input messages the model actually saw in the summary round (tail-truncated by truncateTailForSummary + the closing user prompt) */
  readonly inputMessages: ReadonlyArray<AnthropicNativeMessage>;
}

/**
 * ADR-0011: cut the history tail window used as summary input.
 *
 * Estimate an ~8K token tail window as the summary input (naturally
 * inside the window, avoiding the over-window reactive-compact fallback).
 * When the estimate exceeds the window → first cut by tail message count;
 * if an extreme history still exceeds after one cut → close in with
 * compactMessages (which preserves tool pairing).
 */
function truncateTailForSummary(
  messages: ReadonlyArray<AnthropicNativeMessage>
): ReadonlyArray<AnthropicNativeMessage> {
  let tail = messages;
  if (estimateMessagesTokens(tail) > SUMMARY_TAIL_TOKEN_BUDGET) {
    const from = Math.max(0, tail.length - SUMMARY_TAIL_FALLBACK_MESSAGES);
    tail = tail.slice(from);
    if (estimateMessagesTokens(tail) > SUMMARY_TAIL_TOKEN_BUDGET) {
      tail = compactMessages(tail);
    }
  }
  return tail;
}

/**
 * ADR-0011: summary model call with its own timeout.
 *
 * Builds an independent `{ messages, turnCount: 0 }` state (decoupled from
 * the main loop's turnCount — the summary round is not counted in
 * maxTurns and consumes no tool budget); calls `adapter.step` once (no
 * tools → pure text, no tool firing); `Promise.race` wraps an independent
 * ~15s timeout plus a catch-all.
 *
 * Internal AbortController: when the timeout fires it aborts the real
 * HTTP request (aligning with raceModel's timer → childAbort discipline),
 * merged with the run-level signal into a composite passed to
 * adapter.step — under concurrency, a run signal abort also cancels the
 * summary call synchronously. adapterP never rejects: the catch-all
 * converges failures to null, avoiding an unhandledRejection when the
 * race settles late (test doubles and the real SDK can both hit
 * this). Failure / timeout → null.
 */
async function runSummaryWithTimeout(opts: {
  readonly deps: LoopEngineDeps;
  readonly messages: ReadonlyArray<AnthropicNativeMessage>;
  readonly reason: string;
  readonly signal: AbortSignal | undefined;
}): Promise<SummaryOutcome | null> {
  const messages: ReadonlyArray<AnthropicNativeMessage> = Object.freeze([
    ...opts.messages.map(freezeMessage),
    freezeMessage(
      stampHostInjected(
        opts.deps.adapter.encodeUserText(SUMMARY_PROMPT(opts.reason))
      )
    ),
  ]);
  const summaryState: LoopState = Object.freeze({ messages, turnCount: 0 });
  const request = Object.freeze({});
  const summaryController = new AbortController();
  const compositeSignal = AbortSignal.any(
    opts.signal
      ? [opts.signal, summaryController.signal]
      : [summaryController.signal]
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  let adapterResolved = false;
  const adapterP = opts.deps.adapter
    .step(summaryState, request, compositeSignal)
    .then(
      (r): SummaryOutcome | null => {
        adapterResolved = true;
        if (timer !== undefined) clearTimeout(timer);
        const text = (r.projection.texts ?? []).join("\n").trim();
        return text.length > 0
          ? { text, usage: r.usage, inputMessages: messages }
          : null;
      },
      (): SummaryOutcome | null => {
        adapterResolved = true;
        return null;
      }
    );
  const timeoutP = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      summaryController.abort();
      resolve(null);
    }, opts.deps.summaryTimeoutMs ?? SUMMARY_TIMEOUT_MS);
  });
  try {
    return await Promise.race([adapterP, timeoutP]);
  } catch {
    // Catch-all: a summary failure must never block the original stop
    // reason (ADR-0011).
    return null;
  } finally {
    if (!adapterResolved && timer !== undefined) clearTimeout(timer);
  }
}

/**
 * ADR-0011: orchestration of the best-effort closing summary call.
 *
 * Signal already aborted (concurrency) → cancel immediately without
 * issuing a model call. Returns `SummaryOutcome` or `null`
 * (failure / timeout / signal-abort).
 */
async function tryRunSummary(opts: {
  readonly deps: LoopEngineDeps;
  readonly messages: ReadonlyArray<AnthropicNativeMessage>;
  readonly reason: string;
  readonly signal: AbortSignal | undefined;
}): Promise<SummaryOutcome | null> {
  if (opts.signal?.aborted) return null;
  const tail = truncateTailForSummary(opts.messages);
  return runSummaryWithTimeout({
    deps: opts.deps,
    messages: tail,
    reason: opts.reason,
    signal: opts.signal,
  });
}

/**
 * ADR-0011: run() closing — after an exceptional stop, run one closing
 * summary round and record trace.
 *
 * Handles only exceptional stops (`reason !== "completed"`: maxTurns /
 * protocolError / cancelled / timeout, etc.). The summary round:
 *   - is never appended to the authoritative history (append-only
 *     invariant);
 *   - counts neither maxTurns nor tool budget;
 *   - records usage into trace `LlmCallRecord` (status ok);
 *   - delivers the result to the host via a
 *     `{ type: "stop_summary", text }` event.
 *
 * Trace compatibility: run's existing recordLlmCall contract is "one
 * llm_call per successful model call, one turn per model phase". The
 * summary round adds exactly one independent `recordLlmCall` (status ok)
 * beyond that and no extra turn — to avoid breaking existing exact
 * `lines.length` assertions over the turn sequence (the maxTurns
 * assertion is served by the turn already recorded before this branch
 * throws).
 *
 * Exported for worker.ts: after run() returns cancelled with a
 * subagent-timeout abort, the worker runs this closing summary round
 * itself under a fresh, un-aborted signal (the in-process implementation
 * of the spec's "run one epilogueSummary round on the catch side"; when
 * the signal is already aborted run() skips it internally, so the worker
 * supplies it). The export is additive; logic unchanged.
 */
export async function epilogueSummary(opts: {
  readonly deps: LoopEngineDeps;
  readonly messages: ReadonlyArray<AnthropicNativeMessage>;
  readonly reason: string;
  readonly onStream?: (event: HarnessStreamEvent) => void;
  readonly signal: AbortSignal | undefined;
}): Promise<void> {
  if (opts.signal?.aborted) return;
  const startedAt = new Date().toISOString();
  const startMono = performance.now();
  const outcome = await tryRunSummary(opts);
  if (outcome === null || opts.signal?.aborted) return;
  const endedAt = new Date().toISOString();
  const durationMs = performance.now() - startMono;
  if (opts.deps.trace) {
    const streamMode = opts.deps.adapter.streamMode === true;
    await safeTrace(() =>
      opts.deps.trace!.recordLlmCall({
        startedAt,
        endedAt,
        durationMs,
        supplierStop: "success",
        stream: streamMode,
        // ADR-0014: the summary round captures the messages the model
        // actually saw. Uses outcome.inputMessages = the input after
        // tryRunSummary's truncateTailForSummary tail-cut plus the
        // closing user prompt (i.e., the messages the model really saw
        // this round), not opts.messages (the full pre-summary history,
        // which would misrepresent what the model saw). Trade-off:
        // putting all messages into trace would bloat jsonl; the
        // semantics of LlmCallRecord.messages is "the messages the model
        // actually saw" (an existing ADR-0003 field), and the summary
        // round satisfies the same semantics, so it is filled
        // consistently. Token accounting is still expressed through the
        // *_tokens fields.
        messagesCaptured: true,
        messages: outcome.inputMessages,
        // Like other rounds, no model field can be filled here (the
        // adapter does not expose it; see the ok-branch comment).
        status: "ok",
        ...(outcome.usage !== undefined ? outcome.usage : {}),
      })
    );
  }
  try {
    opts.onStream?.({ type: "stop_summary", text: outcome.text });
  } catch {
    // Observer exceptions must never break the original stop reason's
    // return.
  }
}

/** Structured winner source for raceModel, so SDK abort errors cannot override the original intent. */
export type RaceOutcomeSource =
  "adapter" | "timerTimeout" | "hostCancel" | "callerAbort";

/**
 * Transport-continue-persist: the `timerTimeout` arm must carry
 * `clockAbort` — the very `clock_abort` marker engraved into the abort
 * reason inside `onExpire` (`ClockAbortReason`). No re-reading of
 * `childSignal`, no field unpacking: the resend decision
 * (`classifyClockRetry`) consumes it directly, reading the same value the
 * translation layer reads.
 *
 * A discriminated union rather than an optional field: `onExpire` aborts
 * before settling, so the marker can never be absent on timerTimeout, and
 * the type should not leave room for "absent" (nor a seemingly reasonable
 * `?? "idle"` fallback). `visible === false` = the whole call may be
 * safely re-issued (invariant 1); `true` = output already appeared, no
 * re-issue, end via the existing timeout path.
 */
type RaceOutcomeOf<S extends RaceOutcomeSource> = {
  readonly result: AssistantTurnResult | undefined;
  readonly source: S;
};

/**
 * One member per source (rather than merging the three non-clock sources)
 * so the consumer can narrow by eliminating one at a time:
 * `runModelAttempt` first rules out adapter / callerAbort / hostCancel,
 * leaving necessarily timerTimeout at the end, whose `clockAbort` is
 * directly readable. Merging them into one member would block this
 * narrowing (eliminating "adapter" does not eliminate the member itself).
 *
 * The narrowing doubles as an exhaustiveness check: when a future source
 * is added, the last arm fails to compile because `clockAbort` is not
 * readable — it will never silently fall into an existing arm.
 */
export type RaceModelOutcome =
  | RaceOutcomeOf<"adapter">
  | RaceOutcomeOf<"hostCancel">
  | RaceOutcomeOf<"callerAbort">
  | (RaceOutcomeOf<"timerTimeout"> & {
      readonly clockAbort: ClockAbortReason;
    });

export interface RaceModelHandle {
  readonly outcome: Promise<RaceModelOutcome>;
  readonly childSignal: AbortSignal;
  readonly childAbort: () => void;
}

export interface RaceModelOpts {
  readonly adapter: LoopAdapter;
  readonly state: LoopState;
  readonly deps: LoopEngineDeps;
  readonly signal: AbortSignal | undefined;
  readonly timeoutMs: number;
  readonly onStream?: (event: HarnessStreamEvent) => void;
  /** runModelPhase resolves deps.system?.() per turn and passes it through; system is not sent when undefined. */
  readonly systemText?: string;
  /**
   * Silence cap (ms) on model output deltas. Absent / <= 0 → `timeoutMs`
   * remains the only clock (prior behavior). Expiry lands on `timerTimeout`,
   * same as `timeoutMs`. The streaming-arm gate is decided by
   * `resolveModelClocks` at stepWithTrace; this layer only takes a number.
   */
  readonly idleTimeoutMs?: number;
  /** Sink for the final-request evidence of every attempt of
   *  this call. Absent (no trace host) → no `onDispatch` is passed at all, so
   *  the adapter's absent-means-unchanged rule still holds. */
  readonly dispatchEvidence?: SdkDispatchEvidence[];
}

/**
 * One evidence sink per model step, allocated only when a trace host will
 * record it: a trace-less host passes no observer at all, so the adapter's
 * absent-means-unchanged rule (and the pre-evidence request bytes) hold.
 */
function newDispatchEvidenceSink(
  trace: LoopEngineDeps["trace"]
): SdkDispatchEvidence[] | undefined {
  return trace ? [] : undefined;
}

/** Postel: omitted when nothing was observed, so a reader cannot read "no
 *  governed invocation" as "evidence lost". */
function dispatchEvidenceField(sink: SdkDispatchEvidence[] | undefined): {
  dispatchEvidence?: SdkDispatchEvidence[];
} {
  return sink !== undefined && sink.length > 0
    ? { dispatchEvidence: sink }
    : {};
}

/**
 * Input to settle: two arms — a clock expiry must carry its own marker
 * (marker-absence is inexpressible on timerTimeout, so consumers need no
 * fallback); other sources keep the original result / err positional semantics.
 */
type RaceSettleSpec =
  | {
      readonly source: "adapter" | "hostCancel" | "callerAbort";
      readonly result?: AssistantTurnResult;
      readonly err?: unknown;
    }
  | { readonly source: "timerTimeout"; readonly clock: ClockAbortReason };

/** Settle is co-located in this helper: one first-wins decision point plus cleanup. */
function createRaceOutcome(opts: {
  readonly raceOpts: RaceModelOpts;
  readonly child: AbortController;
  readonly compositeSignal: AbortSignal;
  readonly setChildAbort: (abort: () => void) => void;
}): Promise<RaceModelOutcome> {
  return new Promise<RaceModelOutcome>((resolve, reject) => {
    let settled = false;
    let timers: RaceTimers | undefined;
    let abortListener: (() => void) | undefined;
    const settle = (spec: RaceSettleSpec): void => {
      if (settled) return; // drop any post-settle SDK error / abort
      settled = true;
      timers?.cancel();
      if (opts.raceOpts.signal && abortListener)
        opts.raceOpts.signal.removeEventListener("abort", abortListener);
      opts.child.abort();
      if (spec.source === "timerTimeout") {
        resolve(
          Object.freeze({
            result: undefined,
            source: spec.source,
            clockAbort: spec.clock,
          })
        );
      } else if (spec.err !== undefined) reject(spec.err);
      else resolve(Object.freeze({ result: spec.result, source: spec.source }));
    };
    opts.setChildAbort(() => settle({ source: "hostCancel" }));
    // Idle and hard-cap clocks are started by race-timers and both land on the
    // same timerTimeout on expiry (no new StopReason); arbitration happens only
    // at settle. Pre-expiry visibility travels as one marker via two paths —
    // the abort reason (`clock_abort`, so the translate layer does not mislabel
    // it user_cancel) and the outcome's `clockAbort` (so runModelPhase can
    // decide whether the whole call may be resent). Both paths carry the same
    // value (abort first, then settle).
    timers = startRaceTimers({
      hardCapMs: opts.raceOpts.timeoutMs,
      idleTimeoutMs: opts.raceOpts.idleTimeoutMs,
      onExpire: (source) => {
        const reason = clockAbortReasonOf(
          source,
          timers?.hadVisibleDelta === true
        );
        opts.child.abort(reason); // cancel the HTTP request first, then record the timer win
        settle({ source: "timerTimeout", clock: reason });
      },
    });
    // With idle present the observer is wrapped (record the delta, then forward
    // verbatim); otherwise the host callback passes through unchanged.
    // Forwarding / swallowing discipline: see observeModelIdle.
    const onStream = observeModelIdle(timers, opts.raceOpts.onStream);
    abortListener = (): void => settle({ source: "callerAbort" });
    if (opts.raceOpts.signal?.aborted) abortListener();
    else
      opts.raceOpts.signal?.addEventListener("abort", abortListener, {
        once: true,
      });
    opts.raceOpts.adapter
      .step(
        opts.raceOpts.state,
        {
          tools:
            opts.raceOpts.deps.promptTools?.() ??
            opts.raceOpts.deps.registry.list(),
          // system is attached only when defined; undefined → field omitted,
          // byte-identical to prior behavior.
          ...(opts.raceOpts.systemText !== undefined
            ? { system: opts.raceOpts.systemText }
            : {}),
          onStream,
          // Evidence only, and only when a trace host exists. Faults are
          // swallowed once, at the adapter's single observer boundary
          // (ADR-0136 D9), so a trace failure can never re-dispatch.
          ...(opts.raceOpts.dispatchEvidence !== undefined
            ? {
                onDispatch: (evidence: SdkDispatchEvidence): void => {
                  opts.raceOpts.dispatchEvidence!.push(evidence);
                },
              }
            : {}),
        },
        opts.compositeSignal
      )
      .then(
        (result) => settle({ source: "adapter", result }),
        (err) => settle({ source: "adapter", err })
      );
  });
}

/** Merge child with the caller signal so timer/host can both cancel the real HTTP. */
export function raceModel(opts: RaceModelOpts): RaceModelHandle {
  const child = new AbortController();
  const childSignal = AbortSignal.any(
    opts.signal ? [opts.signal, child.signal] : [child.signal]
  );
  let childAbort = (): void => undefined;
  const outcome = createRaceOutcome({
    raceOpts: opts,
    child,
    compositeSignal: childSignal,
    setChildAbort: (abort) => (childAbort = abort),
  });
  return Object.freeze({
    outcome,
    childSignal,
    childAbort: () => childAbort(),
  });
}

/**
 * Build one TurnTrace (strictly payload-free field set).
 *
 * The freezeMessage gate applied to messages extends to the trace: no field
 * may be mutated in place at runtime. The toolCalls array and each entry are frozen.
 */
function mkTurn(input: {
  readonly turnIndex: number;
  readonly supplierStop: TurnTrace["supplierStop"];
  readonly toolCalls: TurnTrace["toolCalls"];
  readonly durationMs: number;
  readonly cancelKind: CancelKind;
}): TurnTrace {
  return Object.freeze({
    turnIndex: input.turnIndex,
    supplierStop: input.supplierStop,
    toolCalls: Object.freeze(
      input.toolCalls.map((c) => Object.freeze({ ...c }))
    ),
    durationMs: input.durationMs,
    cancelKind: input.cancelKind,
  });
}

/**
 * reason drives the transition (frozen StopReason unchanged); cancelKind
 * independently drives trace metadata. Decoupling them lets hostCancel keep
 * the stopReason "timeout" control flow while the trace records the true source.
 */
function modelStop(opts: {
  readonly state: LoopState;
  readonly started: number;
  readonly reason: "cancelled" | "timeout" | "protocolError";
  readonly cancelKind: CancelKind;
  /** ADR-0094: gateway-side summary on transport failure; not attached otherwise. */
  readonly apiError?: ApiErrorSummary;
}): {
  kind: "stop";
  transition: Transition;
  turn: TurnTrace;
  apiError?: ApiErrorSummary;
} {
  return withApiError(
    {
      kind: "stop",
      transition: { kind: "stop", reason: opts.reason, finalState: opts.state },
      turn: mkTurn({
        turnIndex: opts.state.turnCount,
        supplierStop: "other",
        toolCalls: [],
        durationMs: performance.now() - opts.started,
        cancelKind: opts.cancelKind,
      }),
    },
    opts.apiError
  );
}

/**
 * Sole consumer of timerTimeout: decides whether the whole call may be resent.
 *
 * Both gates live here rather than in the retry loop body (the latter would
 * charge the branches to `runModelPhase`'s cyclomatic complexity — leaf-function
 * discipline, same as `resolveStreamingSilenceNoticeMs`):
 *   1. Resend only on the streaming arm (idle present). The non-streaming
 *      arm's single clock is a request wall-clock; its timeout semantics are
 *      out of scope here — byte-identical prior behavior is kept, so the
 *      blast radius does not swallow the non-streaming failure conclusion.
 *   2. Same FaultClass table as transport retries: clock expiry with zero
 *      deltas this attempt → `retry`; anything already streamed → `none`,
 *      falling back to the existing timeout stop (never invalidate content
 *      the model has already produced).
 *
 * `clock` = this expiry's `clock_abort` marker (produced by one `onExpire`
 * call, abort-then-settle, so always present on the timerTimeout path).
 * `attempt` is 1-based; the budget is shared with transport retries via
 * `TRANSPORT_MAX_ATTEMPTS`.
 */
function classifyClockRetry(
  clock: ClockAbortReason,
  attempt: number,
  idleEnabled: boolean
): FaultClass {
  if (!idleEnabled) return "none";
  const fault: FaultEvent = {
    kind: "clock_timeout",
    source: clock.source,
    visible: clock.visible,
  };
  if (classifyFault(fault) !== "retry") return "none";
  return attempt >= TRANSPORT_MAX_ATTEMPTS ? "none" : "retry";
}

/** The product of `modelStop` (the existing stop return shape). */
type StopResult = ReturnType<typeof modelStop>;

/**
 * Conclusion of one attempt. Three-way discriminated union; the `stop` field
 * inside splits further:
 *
 * - `ok`: adapter won, carrying the turn result.
 * - `clock_timeout`: timerTimeout — `clock` is required, i.e. exactly the
 *   `clock_abort` marker etched into the abort reason by `onExpire`. It is
 *   the sole signal that "this conclusion may still be discarded by a resend"
 *   (see `attemptVerdict`), replacing `?.` + `??` defaults: marker-absence is
 *   inexpressible in the type, so there is no need to re-read `childSignal`.
 * - `stop`: the existing callerAbort / hostCancel conclusion — terminal, nothing to discard.
 */
type ModelAttemptConclusion =
  | { readonly kind: "ok"; readonly result: AssistantTurnResult }
  | {
      readonly kind: "clock_timeout";
      readonly stop: StopResult;
      readonly clock: ClockAbortReason;
    }
  | { readonly kind: "stop"; readonly stop: StopResult };

async function runModelAttempt(opts: {
  readonly state: LoopState;
  readonly deps: LoopEngineDeps;
  readonly signal: AbortSignal | undefined;
  readonly started: number;
  readonly modelHardCapMs: number;
  readonly modelIdleTimeoutMs: number | undefined;
  readonly onStream?: (event: HarnessStreamEvent) => void;
  readonly systemText: string | undefined;
  readonly dispatchEvidence?: SdkDispatchEvidence[];
}): Promise<ModelAttemptConclusion> {
  const handle = raceModel({
    adapter: opts.deps.adapter,
    state: opts.state,
    deps: opts.deps,
    signal: opts.signal,
    timeoutMs: opts.modelHardCapMs,
    ...(opts.modelIdleTimeoutMs !== undefined
      ? { idleTimeoutMs: opts.modelIdleTimeoutMs }
      : {}),
    onStream: opts.onStream,
    systemText: opts.systemText,
    dispatchEvidence: opts.dispatchEvidence,
  });
  const outcome = await handle.outcome;
  const stopAt = (
    reason: "cancelled" | "timeout",
    cancelKind: CancelKind
  ): StopResult =>
    modelStop({
      state: opts.state,
      started: opts.started,
      reason,
      cancelKind,
    });
  if (outcome.source === "adapter") {
    return { kind: "ok", result: outcome.result! };
  }
  if (outcome.source === "callerAbort") {
    return { kind: "stop", stop: stopAt("cancelled", "callerAbort") };
  }
  if (outcome.source === "hostCancel") {
    // hostCancel keeps stopReason "timeout" to preserve control flow; the trace
    // records the true source independently via cancelKind.
    return { kind: "stop", stop: stopAt("timeout", "hostCancel") };
  }
  // Only timerTimeout remains once the three non-clock sources are excluded —
  // its expiry marker is a required field, read directly with no fallback
  // (see `RaceModelOutcome`). Land the existing timeout conclusion first;
  // whether it is truly resent is up to the caller via `attemptVerdict`
  // (a resend discards this stop).
  return {
    kind: "clock_timeout",
    stop: stopAt("timeout", "timerTimeout"),
    clock: outcome.clockAbort,
  };
}

/**
 * Resend verdict: folds one attempt's conclusion together with the attempt
 * ordinal and the idle switch, so the `runModelPhase` loop asks one question —
 * "should this be resent?".
 *
 * `"retry"` = the conclusion is timerTimeout and `classifyClockRetry` allows
 * it, i.e. a discardable transient failure; every other case returns the
 * existing `stop`, terminal as before.
 *
 * `ok` is not accepted: the caller dispatches on `attempt.kind` first (it
 * carries a turn result, a different shape); only the two stop arms live here.
 */
function attemptVerdict(
  attempt: Exclude<ModelAttemptConclusion, { kind: "ok" }>,
  clockAttempt: number,
  idleEnabled: boolean
): "retry" | StopResult {
  if (
    attempt.kind === "clock_timeout" &&
    classifyClockRetry(attempt.clock, clockAttempt, idleEnabled) === "retry"
  ) {
    return "retry";
  }
  return attempt.stop;
}

/**
 * Backoff wait before a resend; only called from the retry arm of `runModelPhase`.
 *
 * abort during backoff → `"cancelled"` (no further attempt is started); other
 * sleep errors propagate as-is, never swallowed. `"retrying"` = the wait
 * finished and the caller proceeds with the next attempt.
 */
async function awaitRetryBackoff(
  attempt: number,
  deps: LoopEngineDeps,
  signal: AbortSignal | undefined
): Promise<"retrying" | "cancelled"> {
  const delayMs =
    deps.transportRetryDelayMs?.(attempt) ?? backoffDelayMs(attempt);
  try {
    await sleepWithAbort(delayMs, signal);
  } catch (err) {
    if (signal?.aborted !== true) throw err;
    return "cancelled";
  }
  return "retrying";
}

/**
 * #1079 Track A call-beat measurement: before each model call, measure the
 * exact outgoing input occupancy (`system` + `tools` + `messages`, the same
 * values the request will carry) through the adapter's `countTokens` hook
 * and emit it as a `context_usage` / `pre_call` stream event. Discipline:
 *   - only a *measured* number is emitted; a missing / failing / invalid
 *     countTokens skips this beat silently — chars/N estimation is
 *     forbidden for the display path (ADR-0008 D6);
 *   - with no onStream consumer the measurement is not made at all (no
 *     per-call API cost for hosts that cannot see the reading);
 *   - an adapter without countTokens logs once per adapter instance (the
 *     fallback for such vendors is a provider-side message_start reading,
 *     which no in-repo adapter needs today).
 */
const noCountTokensWarned = new WeakSet<LoopAdapter>();

/** Run the adapter's countTokens against the exact outgoing request triple
 *  and gate the reading by the declared validity contract; null = no real
 *  measurement this beat (missing hook, failure, non-finite / non-positive). */
async function measurePreCallInputTokens(
  deps: LoopEngineDeps,
  state: LoopState,
  systemText: string | undefined
): Promise<number | null> {
  const countTokens = deps.adapter.countTokens;
  if (countTokens === undefined) return null;
  try {
    const tools = deps.promptTools?.() ?? deps.registry.list();
    const measured = await countTokens({
      ...(tools.length > 0 ? { tools } : {}),
      ...(systemText !== undefined ? { system: systemText } : {}),
      messages: state.messages,
    });
    // Same validity gate the countTokens contract declares: non-finite /
    // non-positive = failure, treated exactly like a throw (skip the beat).
    return Number.isFinite(measured.inputTokens) && measured.inputTokens > 0
      ? measured.inputTokens
      : null;
  } catch {
    // EXIT: countTokens threw (API failure / abort) → skip this beat; the
    // post_call correction or the next beat carries the next real reading.
    return null;
  }
}

async function emitPreCallContextUsage(opts: {
  readonly state: LoopState;
  readonly deps: LoopEngineDeps;
  readonly systemText: string | undefined;
  readonly hostStreamPresent: boolean;
  readonly onStream: ((event: HarnessStreamEvent) => void) | undefined;
}): Promise<void> {
  const onStream = opts.onStream;
  // runModelPhase's onStream is the in-flight-window wrapper (always a
  // function inside run()); the host-presence flag is the real gate.
  if (!opts.hostStreamPresent || onStream === undefined) return;
  if (opts.deps.adapter.countTokens === undefined) {
    if (!noCountTokensWarned.has(opts.deps.adapter)) {
      noCountTokensWarned.add(opts.deps.adapter);
      console.warn(
        "context-usage pre-call measurement skipped: adapter has no countTokens (beats without a real reading emit nothing)"
      );
    }
    return;
  }
  const inputTokens = await measurePreCallInputTokens(
    opts.deps,
    opts.state,
    opts.systemText
  );
  if (inputTokens === null) return;
  safeEmitStream(onStream, {
    type: "context_usage",
    phase: "pre_call",
    usage: {
      inputTokens,
      // A countTokens reading knows nothing about output / cache split;
      // 0 / null are "not generated yet / not measured", never estimates
      // (the display numerator adds these as 0).
      outputTokens: 0,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: null,
    },
  });
}

/** #1079 call-beat correction: the successful call's real API usage (sealed
 *  `AssistantTurnResult.usage` passthrough, no second ledger) goes out
 *  immediately — the host sees beat N's truth before beat N's tool loop ends.
 *  usage absent (stub / vendor withheld) → nothing emitted, the pre_call
 *  reading stands until the next real one. */
function emitPostCallContextUsage(
  onStream: ((event: HarnessStreamEvent) => void) | undefined,
  turnResult: AssistantTurnResult
): void {
  if (turnResult.usage === undefined) return;
  safeEmitStream(onStream, {
    type: "context_usage",
    phase: "post_call",
    usage: turnResult.usage,
  });
}

/** ADR-0118: separate one-time-warn slot for the gate probe; sharing the
 *  display path's `noCountTokensWarned` would let whichever seam warns first
 *  silence the other's contract. */
const noCountTokensWarnedAtGate = new WeakSet<LoopAdapter>();

/**
 * ADR-0118 proactive-gate measurement: this-beat `countTokens` over exactly
 * the message array the gate is about to evaluate. Deliberately *not* the
 * display triple (system/tools are assembled later inside `runModelPhase`),
 * so no sharing with `measurePreCallInputTokens`. null = no real measurement
 * this beat (hook absent / throw / non-finite / ≤0) — the gate then falls
 * through previous usage → estimate; absence never means
 * `below_token_threshold`.
 */
async function measureGateThisBeatOccupancy(
  deps: LoopEngineDeps,
  messages: ReadonlyArray<AnthropicNativeMessage>
): Promise<number | null> {
  const countTokens = deps.adapter.countTokens;
  if (countTokens === undefined) {
    if (!noCountTokensWarnedAtGate.has(deps.adapter)) {
      noCountTokensWarnedAtGate.add(deps.adapter);
      console.warn(
        "context-usage proactive gate skipped measurement: adapter has no countTokens (gate falls back to previous usage → estimate)"
      );
    }
    return null;
  }
  try {
    const measured = await countTokens({ messages });
    // Same validity gate as the display path: non-finite / non-positive =
    // no measurement this beat, never a fake below-threshold verdict.
    return Number.isFinite(measured.inputTokens) && measured.inputTokens > 0
      ? measured.inputTokens
      : null;
  } catch {
    // countTokens failure (API error / abort) must never break the loop turn.
    return null;
  }
}

/** Await the structured race outcome, keeping the SDK-first error catch contract. */
async function runModelPhase(opts: {
  readonly state: LoopState;
  readonly deps: LoopEngineDeps;
  readonly signal: AbortSignal | undefined;
  readonly started: number;
  /** Hard cap for this step (ms); non-streaming arm = the single-clock resolution. */
  readonly modelHardCapMs: number;
  /** Idle cap for this step (ms); undefined = hard-cap clock only. */
  readonly modelIdleTimeoutMs: number | undefined;
  readonly onStream?: (event: HarnessStreamEvent) => void;
  /** True only when the host passed its own onStream into stepWithTrace
   *  (runModelPhase's own onStream is the in-flight-window wrapper, which
   *  exists even for consumer-less hosts). Gates the pre-call usage probe:
   *  no consumer → no per-call countTokens cost. */
  readonly hostStreamPresent: boolean;
  /** ADR-0013: run-scoped reactive-compact attempted flag;
   *  true = already compacted and retried once this run, no second time. */
  readonly reactiveAttemptedRef: { attempted: boolean };
  /** Run-scoped frozen prompt prefix; the resolved `system` lands in it here. */
  readonly frozenSystemPrefix: FrozenSystemPrefix;
  /** Per-model-step evidence sink, shared by the transport
   *  retries inside this phase and by the reactive-compact retry round, so the
   *  row's entries stay in invocation order. */
  readonly dispatchEvidence?: SdkDispatchEvidence[];
}): Promise<
  | { kind: "ok"; result: AssistantTurnResult }
  | {
      kind: "stop";
      transition: Transition;
      turn: TurnTrace;
      apiError?: ApiErrorSummary;
    }
  | { kind: "reactive_compact_pending"; state: LoopState }
> {
  try {
    // Resolve deps.system?.() once per turn; undefined → field omitted, the
    // adapter's conditional spread sends no system field → byte-zero change
    // to the KV cache prefix. Usage-bar pre_call uses this same string.
    const systemText = await opts.deps.system?.();
    // The request is the authority on the prefix this turn used: hand those
    // exact bytes to the run-scoped box, so every later publication reports
    // what the model was actually sent rather than a re-derivation.
    opts.frozenSystemPrefix.prefix = systemText;
    opts.frozenSystemPrefix.resolved = true;
    await emitPreCallContextUsage({
      state: opts.state,
      deps: opts.deps,
      systemText,
      hostStreamPresent: opts.hostStreamPresent,
      onStream: opts.onStream,
    });
    // When a clock expires with zero model-output deltas this attempt, resend
    // the whole call (bounded attempts, second-scale exponential backoff)
    // instead of judging the turn timed out — a stalled connection is not a
    // failed turn. Visibility and clock origin are carried out of the race by
    // the same `onExpire` (`RaceModelOutcome.clock`, the marker just etched
    // into the abort reason). This loop keeps only send / conclude /
    // backoff-resend; see `classifyClockRetry` and `awaitRetryBackoff`.
    let clockAttempt = 1;
    for (;;) {
      const attempt = await runModelAttempt({
        state: opts.state,
        deps: opts.deps,
        signal: opts.signal,
        started: opts.started,
        modelHardCapMs: opts.modelHardCapMs,
        modelIdleTimeoutMs: opts.modelIdleTimeoutMs,
        onStream: opts.onStream,
        systemText,
        dispatchEvidence: opts.dispatchEvidence,
      });
      if (attempt.kind === "ok") return attempt;
      const verdict = attemptVerdict(
        attempt,
        clockAttempt,
        opts.modelIdleTimeoutMs !== undefined
      );
      if (verdict !== "retry") return verdict;
      safeEmitStream(opts.onStream, {
        type: "transport_retry",
        attempt: clockAttempt,
        maxAttempts: TRANSPORT_MAX_ATTEMPTS,
        detail: TRANSPORT_RETRY_DETAIL_INVISIBLE_TIMEOUT,
      });
      if (
        (await awaitRetryBackoff(clockAttempt, opts.deps, opts.signal)) ===
        "cancelled"
      ) {
        return modelStop({
          state: opts.state,
          started: opts.started,
          reason: "cancelled",
          cancelKind: "callerAbort",
        });
      }
      clockAttempt += 1;
    }
  } catch (err) {
    // ADR-0013: reactive compact fallback — at most once per run.
    // PromptTooLongError extends ProtocolError, so it must be checked before
    // the ProtocolError branch; on success return reactive_compact_pending so
    // stepWithTrace reruns once with the compacted state.
    if (err instanceof PromptTooLongError) {
      if (
        opts.deps.compress !== undefined &&
        !opts.reactiveAttemptedRef.attempted
      ) {
        opts.reactiveAttemptedRef.attempted = true;
        const compactedState = await applyCompactAttachment(
          opts.state,
          opts.deps,
          { signal: opts.signal, onStream: opts.onStream }
        );
        // If the user cancels during reactive compaction, conclude as
        // cancelled regardless of the compaction outcome (a protocolError stop
        // here would only confuse the user).
        if (opts.signal?.aborted) {
          return modelStop({
            state: opts.state,
            started: opts.started,
            reason: "cancelled",
            cancelKind: "callerAbort",
          });
        }
        if (compactedState.messages !== opts.state.messages) {
          return {
            kind: "reactive_compact_pending",
            state: compactedState,
          };
        }
      }
      // compaction disabled / already attempted / still over window after
      // compaction → fall back to ProtocolError semantics (ADR-0013 defers
      // the over-limit conclusion to ADR-0012).
      return modelStop({
        state: opts.state,
        started: opts.started,
        reason: "protocolError",
        cancelKind: "none",
      });
    }
    if (
      err instanceof ProtocolError ||
      err instanceof TransportRetryExhaustedError
    ) {
      // ADR-0094: only TransportRetryExhaustedError carries a cause; attach it
      // to RunResult.apiError so the chat-flow viewport can render hints like
      // "API error (status): message"; a bare ProtocolError has no cause → not
      // attached, the generic notice is kept.
      return modelStop({
        state: opts.state,
        started: opts.started,
        reason: "protocolError",
        cancelKind: "none",
        apiError: transportApiErrorOf(err),
      });
    }
    throw err;
  }
}

/**
 * id→name view map over toolCallViews (built once, consumed in three places:
 * runToolPhase's trace writes, stepWithTrace's trace writes and status-bar
 * last_tool updates — sharing one construction removes duplication).
 */
function toolNameById(
  views: ReadonlyArray<{ readonly id: string; readonly name: string }>
): ReadonlyMap<string, string> {
  return new Map(views.map((c) => [c.id, c.name]));
}

/**
 * Pure map from the Executor's ToolExecutionResult sequence to the trace
 * toolCalls array. nameById is the toolUseId-indexed view map (built once
 * upstream); tool_not_found may self-report toolName, other kinds fall back
 * to "": unreachable for well-formed results, but kept for type totality.
 */
function toTraceToolCalls(opts: {
  readonly results: ReadonlyArray<ToolExecutionResult>;
  readonly nameById: ReadonlyMap<string, string>;
}): TurnTrace["toolCalls"] {
  return opts.results.map((r) => {
    const toolName =
      opts.nameById.get(r.toolUseId) ??
      (r.kind === "tool_not_found" ? r.toolName : "");
    const message =
      r.kind === "validation_failed" || r.kind === "execution_failed"
        ? r.message
        : undefined;
    return {
      toolUseId: r.toolUseId,
      toolName,
      kind: r.kind,
      ...(message !== undefined ? { message } : {}),
    };
  });
}

/**
 * Marker on signal.reason for turn/host clock aborts (ADR-0091). Strict
 * equality comparison only — no substring / prefix shortcuts: "timeout" is
 * both a per-call failure tag and a StopReason value, "timeout:…" is a
 * per-call failure prefix, "subagent-timeout" is a subagent per-task
 * lifetime. This value ("turn-timeout") differs from all three and uniquely
 * expresses the turn clock's abort reason; reusing a string would detach
 * computeToolStopFlags' strict equality from the per-call result tags /
 * StopReason union. Same shape as "subagent-timeout" in worker.ts.
 */
export const TURN_CLOCK_ABORT_REASON = "turn-timeout";

/**
 * Scan Executor results + signal to decide whether this tool phase triggers
 * cancelled / timeout.
 *
 * ADR-0091: a per-call tool timeout only fails that one tool_result (it stays
 * execution_failed + "timeout", ADR-0005 unchanged) and never escalates to a
 * turn timeout — so "timeout" tags inside results have no bearing on timedOut.
 * Turn timeout is recognized only from an outer-signal abort whose reason is
 * TURN_CLOCK_ABORT_REASON.
 *
 * Clock-abort authority: cancelled no longer absorbs every abort
 * unconditionally. The old shape `signal.aborted || tag==="cancelled"` would
 * read a clock abort as cancelled, making "timeout holds only when the signal
 * has aborted and cancelled did not preempt" permanently false (ADR-0091's
 * "cancelled did not preempt" presupposes a non-cancelled abort). So when
 * clockAbort holds, cancelled converges to false even if the executor
 * normalized a "cancelled" result tag from the same caller signal — that tag
 * is merely derived from the same abort and must not rewrite the turn's
 * attribution. Without clockAbort, cancelled keeps the old shape (plain abort
 * or "cancelled" tag).
 *
 * No producer today: the tool phase has no turn clock — only an abort with
 * reason exactly TURN_CLOCK_ABORT_REASON can land timedOut (same shape as
 * modelStop's hostCancel: production-unreachable, pinned by a test seam).
 */
export function computeToolStopFlags(opts: {
  readonly results: ReadonlyArray<ToolExecutionResult>;
  readonly signal: AbortSignal | undefined;
}): { timedOut: boolean; cancelled: boolean } {
  const clockAbort =
    opts.signal?.aborted === true &&
    opts.signal.reason === TURN_CLOCK_ABORT_REASON;
  const cancelled =
    !clockAbort &&
    (opts.signal?.aborted === true ||
      opts.results.some(
        (r) => r.kind === "execution_failed" && r.message === "cancelled"
      ));
  return { timedOut: clockAbort, cancelled };
}

type ToolCallView = { id: string; name: string; input: unknown };

/**
 * Commit in tool_use order as soon as the prefix has settled.
 * Later results may finish first but stay buffered until earlier slots fill.
 * executeAll still receives the whole wave; onSettled is the
 * commit seam so the loop does not wait for the slowest call before the
 * first result can hit disk.
 */
async function executeWaveAndCommit(opts: {
  readonly wave: ReadonlyArray<ToolCallView>;
  /** Calls of this batch that precede the wave (batch-level fact position). */
  readonly batchOffset: number;
  /** Calls in the whole batch (batch-level fact size). */
  readonly batchSize: number;
  readonly deps: LoopEngineDeps;
  readonly signal: AbortSignal | undefined;
  readonly toolTimeout: number;
  readonly results: ToolExecutionResult[];
  readonly blocks: AnthropicContentBlock[];
  /** This turn's trace turn id, passed through to ctx.turnId (spawn_subagent attribution). */
  readonly turnId: string;
  /** Injected messages flush in the batch of the first tool_result commit. */
  readonly pendingInjected: PendingInjected;
  readonly onStream?: (event: HarnessStreamEvent) => void;
  /**
   * Model-visible history snapshot for this turn (skill() second-call short
   * circuit). The append-only messages reference is passed at wave entry —
   * within a wave the assistant message is already in history
   * (runToolPhase's afterAssistantState) while tool_results are not yet
   * (see executeWaveAndCommit), so a same-wave repeat short circuit is
   * covered by the handler-side wave map, not by this snapshot.
   */
  readonly messages: ReadonlyArray<AnthropicNativeMessage>;
}): Promise<void> {
  const slots: Array<ToolExecutionResult | undefined> = Array.from(
    { length: opts.wave.length },
    () => undefined
  );
  let next = 0;
  // WHY: onSettled callbacks may re-enter flushPrefix concurrently, and the
  // worker transcript path has no hub serialize queue fallback → overlapping
  // commits would produce duplicate event ids. The latch makes re-entrant
  // calls return immediately; the holder's while loop rechecks slots[next]
  // each round and sweeps newly arrived slots, and any residue after the loop
  // exits is covered by the final flush once executeAll returns.
  let flushing = false;
  const flushPrefix = async (): Promise<void> => {
    if (flushing) return;
    flushing = true;
    try {
      while (next < slots.length && slots[next] !== undefined) {
        const result = slots[next]!;
        next += 1;
        opts.results.push(result);
        const encoded = opts.deps.adapter.encodeToolResults([result]);
        opts.blocks.push(...encoded);
        await commitMessagesOrThrow(opts.deps, [
          ...opts.pendingInjected.take(),
          { role: "user", content: encoded },
        ]);
      }
    } finally {
      flushing = false;
    }
  };
  const waveResults = await opts.deps.executor.executeAll(
    opts.wave,
    opts.signal,
    opts.toolTimeout,
    opts.deps.conversationId,
    async (result, index) => {
      slots[index] = result;
      await appendSettledResultFactOrThrow(opts, result, index);
      await flushPrefix();
    },
    opts.turnId,
    opts.onStream,
    opts.messages,
    opts.deps.parentThinking
  );
  for (let i = 0; i < waveResults.length; i++) {
    if (slots[i] === undefined) slots[i] = waveResults[i];
  }
  await flushPrefix();
}

/** Tool phase converges independently, keeping whole-turn append and stop precedence unchanged. */
async function runToolPhase(opts: {
  readonly afterAssistantState: LoopState;
  readonly entryTurnCount: number;
  readonly turnResult: AssistantTurnResult;
  readonly deps: LoopEngineDeps;
  readonly signal: AbortSignal | undefined;
  readonly started: number;
  /** This turn's trace turn id (see executeWaveAndCommit). */
  readonly turnId: string;
  /** Injected messages flush in the batch of the first tool_result commit. */
  readonly pendingInjected: PendingInjected;
  readonly onStream?: (event: HarnessStreamEvent) => void;
  /** Run-scoped frozen prompt prefix; see FrozenSystemPrefix. */
  readonly frozenSystemPrefix: FrozenSystemPrefix;
}): Promise<{
  transition: Transition;
  turn: TurnTrace;
  toolResults: ReadonlyArray<ToolExecutionResult>;
  toolCallViews: ReadonlyArray<{ id: string; name: string; input: unknown }>;
}> {
  const toolCallViews = opts.turnResult.projection.toolCalls.map((c) => ({
    id: c.id,
    name: c.name,
    input: c.input,
  }));
  const toolTimeout =
    opts.deps.toolTimeoutMs ?? opts.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const waves = partitionConcurrencyWaves(toolCallViews, (call) => {
    const def = opts.deps.registry.get(call.name);
    return (
      (def as { aci?: { isConcurrencySafe?: boolean } } | undefined)?.aci
        ?.isConcurrencySafe === true
    );
  });
  const results: ToolExecutionResult[] = [];
  const blocks: AnthropicContentBlock[] = [];
  // skill() second-call short circuit: the snapshot is
  // afterAssistantState.messages (includes this wave's assistant tool_use
  // message, excludes its tool_results — those append only after the whole
  // wave completes).
  // WHY the running offset: a wave is a concurrency split INSIDE the batch, so
  // a fact's position has to be its call's index in the whole batch and its size
  // the whole batch's call count. `partitionConcurrencyWaves` keeps the waves in
  // original order and covers every call exactly once, so the offset is just the
  // length of the waves already run.
  let batchOffset = 0;
  for (const wave of waves) {
    await executeWaveAndCommit({
      wave,
      batchOffset,
      batchSize: toolCallViews.length,
      deps: opts.deps,
      signal: opts.signal,
      toolTimeout,
      results,
      blocks,
      turnId: opts.turnId,
      pendingInjected: opts.pendingInjected,
      onStream: opts.onStream,
      messages: opts.afterAssistantState.messages,
    });
    batchOffset += wave.length;
  }
  const toolResultMsg: AnthropicNativeMessage = {
    role: "user",
    content: blocks,
  };
  const finalState = appendMessage({
    state: opts.afterAssistantState,
    msg: toolResultMsg,
  });
  const durationMs = performance.now() - opts.started;
  const nameById = toolNameById(toolCallViews);
  const toolCalls = toTraceToolCalls({ results, nameById });
  const { timedOut, cancelled } = computeToolStopFlags({
    results,
    signal: opts.signal,
  });
  // Full saved state for the batch: published only now, once every returned
  // call is inside `finalState.messages` (error results included), so the
  // boundary never claims a batch the context does not carry. A batch holding
  // an outstanding operation has no settled end at all — the post-assembly
  // branch returns a stop and skips this write, leaving its settled members
  // visible through the per-result facts alone.
  if (
    isBatchSettled({
      results,
      callCount: toolCallViews.length,
      timedOut,
      cancelled,
    })
  ) {
    await publishSavedStateOrThrow(opts.deps, opts.frozenSystemPrefix, {
      boundary: "tool_batch_settled",
      turnId: opts.turnId,
      messages: finalState.messages,
    });
  }
  const turn = mkTurn({
    turnIndex: opts.entryTurnCount,
    supplierStop: opts.turnResult.supplierStop,
    toolCalls,
    durationMs,
    // cancelled outranks timeout (consistent with the computeToolStopFlags doc).
    cancelKind: cancelled ? "callerAbort" : timedOut ? "timerTimeout" : "none",
  });
  if (cancelled) {
    return {
      transition: { kind: "stop", reason: "cancelled", finalState },
      turn,
      toolResults: results,
      toolCallViews,
    };
  }
  if (timedOut) {
    return {
      transition: { kind: "stop", reason: "timeout", finalState },
      turn,
      toolResults: results,
      toolCallViews,
    };
  }
  return {
    transition: { kind: "continue", nextState: finalState },
    turn,
    toolResults: results,
    toolCallViews,
  };
}

/**
 * ADR-0108: open a model-in-flight observation window — returns a wrapped
 * onStream (accumulates raw text_delta into ref, the same bytes as the
 * on-screen draft; other events forwarded verbatim), resets the buffer and
 * sets modelInFlight=true. The reactive-compact retry reopens the window with
 * the same helper (a half-finished output is not part of the retry round's
 * keep face). ref absent (public step) → no wrapping, forward as-is.
 */
function openModelInFlightWindow(
  ref: ModelStreamWindow | undefined,
  onStream: ((event: HarnessStreamEvent) => void) | undefined
): ((event: HarnessStreamEvent) => void) | undefined {
  if (ref === undefined) return onStream;
  ref.text = "";
  ref.modelInFlight = true;
  return (event) => {
    if (event.type === "text_delta") ref.text += event.text;
    safeEmitStream(onStream, event);
  };
}

/**
 * ADR-0108: the model delivered a full turn — leave the in-flight window.
 * Thereafter the assistant enters history through the normal append path;
 * tool in-flight and later stop reasons no longer enter the keep face (the
 * four-message-shape contract does not regress).
 */
function closeModelInFlightWindow(ref: ModelStreamWindow | undefined): void {
  if (ref !== undefined) ref.modelInFlight = false;
}

/**
 * Tool-loop fuses for one finished tool phase: the narrow validation-stall
 * fuse first, then the generic R=5 detector. Both share this single envelope
 * assembly so the stop stays structurally identical to the pre-existing fuse
 * path; undefined = nothing tripped. Each seam's text stays a literal argument
 * of `encodeUserText` — the roster-completeness lock enumerates injection
 * seams by that argument expression.
 */
async function fuseStalledPhase(opts: {
  readonly events: ReadonlyArray<ToolLoopEvent>;
  readonly deps: LoopEngineDeps;
  readonly pendingInjected: PendingInjected;
  readonly nextState: LoopState;
  readonly turn: TurnTrace;
  readonly modelUsage: TokenUsage | undefined;
}): Promise<
  | {
      transition: Transition;
      turn: TurnTrace;
      modelUsage: TokenUsage | undefined;
    }
  | undefined
> {
  const fusedStop = async (
    stamped: AnthropicNativeMessage
  ): Promise<{
    transition: Transition;
    turn: TurnTrace;
    modelUsage: TokenUsage | undefined;
  }> => {
    const envelope = freezeMessage(stamped);
    // The batch that persists the envelope itself also flushes pending
    // injections (bar etc.) first, keeping the order consistent with the
    // in-memory authoritative history.
    await commitMessagesOrThrow(opts.deps, [
      ...opts.pendingInjected.take(),
      envelope,
    ]);
    const fusedState = appendMessage({ state: opts.nextState, msg: envelope });
    return {
      transition: { kind: "stop", reason: "fused", finalState: fusedState },
      turn: opts.turn,
      modelUsage: opts.modelUsage,
    };
  };
  if (isValidationStallLoop(opts.events)) {
    return fusedStop(
      stampHostInjected(
        opts.deps.adapter.encodeUserText(VALIDATION_LOOP_DETECTED_TEXT)
      )
    );
  }
  if (isStalledToolLoop(opts.events)) {
    return fusedStop(
      stampHostInjected(opts.deps.adapter.encodeUserText(LOOP_DETECTED_TEXT))
    );
  }
  return undefined;
}

/**
 * ADR-0126: the adapter's normalized supplier stop projected as a failed
 * turn's diagnostic detail; a successful turn carries no detail.
 */
function supplierDetailOf(
  turnResult: AssistantTurnResult
): SupplierStopDetail | undefined {
  return turnResult.supplierStop === "success"
    ? undefined
    : turnResult.supplierStop;
}

/**
 * ADR-0126: the carriers of the detail (step result, RunResult) omit the key
 * when absent; one spread-shaped helper keeps that byte-stable shape at a
 * single site instead of a branch per call site.
 */
function supplierDetailField(detail: SupplierStopDetail | undefined): {
  supplierDetail?: SupplierStopDetail;
} {
  return detail === undefined ? {} : { supplierDetail: detail };
}

/**
 * ADR-0011: after an exceptional stop (anything but completed) run one
 * best-effort epilogue summary.
 * ADR-0126 amends: an output-limit truncation is exempt — the settled partial
 * turn is itself the record, so no summary round is requested.
 */
function needsEpilogueSummary(
  reason: StopReason,
  supplierDetail: SupplierStopDetail | undefined
): boolean {
  return reason !== "completed" && supplierDetail !== "truncation";
}

/**
 * ADR-0126: the notice closing a tool call the output-limit stop left
 * unexecuted. One exported constant so the live append and every replay of it
 * carry identical bytes; it states the call never ran, which is why it must
 * never borrow the process-closeout wording (an unknown outcome).
 */
export const OUTPUT_LIMIT_TOOL_RESULT_TEXT =
  "The tool was not executed because the model output limit was reached.";

/** The tool_result member the adapter's `encodeToolResults` emits (shared shape). */
type ToolResultBlock = Extract<AnthropicContentBlock, { type: "tool_result" }>;

/**
 * ADR-0126: one `is_error` tool_result per tool_use id the truncated response
 * returned. `encodeToolResults` prefixes its text with the failure kind, so
 * this verbatim notice cannot go through it; the blocks stay pinned to its shape.
 */
function encodeOutputLimitToolResults(
  toolUseIds: ReadonlyArray<string>
): ToolResultBlock[] {
  return toolUseIds.map((id) => ({
    type: "tool_result",
    tool_use_id: id,
    is_error: true,
    content: [{ type: "text", text: OUTPUT_LIMIT_TOOL_RESULT_TEXT }],
  }));
}

/**
 * One step's outcome: the transition plus this turn's trace row and the
 * per-turn optional carriers.
 */
type StepResult = {
  transition: Transition;
  turn: TurnTrace | null;
  /**
   * ADR-0008: usage of this step's successful model call (undefined = no
   * successful call, or that call's usage absent). run's lastUsage updates
   * only when !== undefined.
   */
  modelUsage: TokenUsage | undefined;
  /** ADR-0094: gateway-side summary attached to RunResult.apiError on modelStop paths.
   *  undefined = non-transport failure path, RunResult carries no apiError. */
  apiError?: ApiErrorSummary;
  /** ADR-0126: normalized supplier-stop detail behind a nonSuccessStop stop;
   *  absent for every other stop reason. */
  supplierDetail?: SupplierStopDetail;
};

/**
 * ADR-0126: the arms of a turn that ends with no tool phase — the plain finish
 * and the output-limit stop that already closed its own tool_uses — share this
 * one trace-and-return; only the final state differs. `durationMs` arrives
 * measured by the caller, so the closeout commit stays outside the timed span.
 */
async function settleStopTurn(args: {
  readonly deps: LoopEngineDeps;
  readonly turnResult: AssistantTurnResult;
  readonly finalState: LoopState;
  readonly turnIndex: number;
  readonly turnId: string;
  readonly turnStartedAt: string;
  readonly durationMs: number;
  readonly llmCallId: string | undefined;
}): Promise<StepResult> {
  const reason =
    args.turnResult.supplierStop === "success" ? "completed" : "nonSuccessStop";
  if (args.deps.trace) {
    await safeTrace(() =>
      args.deps.trace!.recordTurn({
        id: args.turnId,
        turnIndex: args.turnIndex,
        startedAt: args.turnStartedAt,
        endedAt: new Date().toISOString(),
        durationMs: args.durationMs,
        llmCallIds: args.llmCallId ? [args.llmCallId] : [],
        toolCallIds: [],
        decision: reason,
        status: reason === "completed" ? "ok" : "error",
        error:
          reason === "completed"
            ? undefined
            : { type: toTraceErrorType("nonSuccessStop"), message: reason },
      })
    );
  }
  return {
    transition: { kind: "stop", reason, finalState: args.finalState },
    turn: mkTurn({
      turnIndex: args.turnIndex,
      supplierStop: args.turnResult.supplierStop,
      toolCalls: [],
      durationMs: args.durationMs,
      cancelKind: "none",
    }),
    modelUsage: args.turnResult.usage,
    ...supplierDetailField(supplierDetailOf(args.turnResult)),
  };
}

/**
 * stepWithTrace layers tracing on top of the original step logic:
 *   - records started = performance.now() at entry, computes durationMs at exit;
 *   - delegates adapter.step + timeout + abort + protocol errors to runModelPhase;
 *   - whole-turn cancel/timeout/protocol errors still yield stop(reason), and a
 *     placeholder TurnTrace is still recorded into the trace (paths that never
 *     enter history still log one failed attempt; tool-failure paths have
 *     already filled the toolCalls array);
 *   - turn returns null only in the maxTurns early-stop branch (no adapter call → no trace entry).
 *
 * The internal Transition shape matches the frozen contract (judgement union,
 * reason type auto-widens with StopReason).
 *
 * ADR-0011: maxTurns overflow is upgraded from silent-stop to
 * `throw MaxTurnsExceeded` (the surface must notice; turnsRan = turns already run).
 * `maxTurns` is `number | undefined` (ADR-0012): undefined = never triggers
 * (exploration is not killed by turn counting).
 */
async function stepWithTrace(opts: {
  readonly state: LoopState;
  readonly deps: LoopEngineDeps;
  readonly signal?: AbortSignal;
  readonly onStream?: (event: HarnessStreamEvent) => void;
  /** Whether the host itself consumes stream events. runModelPhase's own
   *  onStream is an in-flight-window wrapper that exists even for hosts that
   *  passed no callback, so `onStream !== undefined` cannot answer this;
   *  run() threads the caller's honest flag through. Gates per-call
   *  countTokens cost (#1079 pre_call probe): no host consumer → no probe. */
  readonly hostStreamPresent: boolean;
  /** ADR-0013: run-scoped reactive-compact attempted flag (carried across steps). */
  readonly reactiveAttemptedRef: { attempted: boolean };
  /**
   * ADR-0028: run-scoped mutable ref for the status bar's last_tool. run()
   * creates it and shares it across steps (one run = one user turn); public
   * step() creates a fresh one each call (single-step semantics). Initial
   * value AGENT_STATUS_IDLE_TOOL; after each tool batch it updates to the
   * last successful tool name in the batch (no success → keep old value).
   * Consumed only when deps.agentStatus is present (appendAgentStatusBar
   * reads lastTool); with the field absent, updates have zero observable effect.
   */
  readonly lastToolRef: { lastTool: string };
  /**
   * Run-scoped mutable ref for reconcile settlement — same shape as
   * `lastToolRef`: run() creates it and shares across steps, public step()
   * creates a fresh one (single-step semantics; cold start with
   * stamped=undefined is legal). Boxed content = the latest real user message
   * already settled with the status bar (messages frozen + appended
   * immutably; compact re-freeze clones are matched by
   * `isSameRealUserMessage`). Not persisted, not part of the deps assembly
   * surface; consumed only when deps.agentStatus is present.
   */
  readonly reconcileRef: { stamped: AnthropicNativeMessage | undefined };
  /** This run's tool-loop events (accumulated across steps; public step creates a fresh one). */
  readonly toolLoopRef: { events: ToolLoopEvent[]; nextPhase: number };
  /** Run-scoped pending buffer for injected messages (public step creates a fresh one). */
  readonly pendingInjected: PendingInjected;
  /**
   * ADR-0108: model in-flight streaming text buffer — the same bytes as the
   * on-screen draft (accumulated per text_delta), so run()'s closeout can
   * keep the prefix with the same freeze knife on cancelled / timeout. Passed
   * only by run(); public step() omits it = no accumulation, no wrapping
   * (single step has no closeout).
   */
  readonly modelStreamRef?: ModelStreamWindow;
  /**
   * Run-scoped frozen prompt prefix (see FrozenSystemPrefix). run() shares one
   * box across steps so every boundary of the run reports the same frozen
   * assembly; public step() creates a fresh one (single-step semantics).
   */
  readonly frozenSystemPrefix: FrozenSystemPrefix;
}): Promise<StepResult> {
  // ADR-0011 + ADR-0012: maxTurns overflow → throw.
  // undefined = unlimited, never triggers (long exploration is not killed by turn counting).
  if (
    opts.deps.maxTurns !== undefined &&
    opts.state.turnCount >= opts.deps.maxTurns
  ) {
    throw new MaxTurnsExceeded(opts.state.turnCount, "maxTurns");
  }

  const started = performance.now();
  const turnStartedAt = new Date().toISOString();
  // The turn's trace id is generated at turn entry, not inside recordTurn —
  // the tool phase needs it as ctx.turnId (spawn_subagent fills parentTurnId
  // from it), while recordTurn fires only at turn end. All four recordTurn
  // exits reuse this single id, keeping one row per turn.
  const turnId = randomUUID();
  const modelTimeout =
    opts.deps.modelTimeoutMs ?? opts.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // Streaming arm gets idle + hard-cap clocks; the non-streaming arm keeps
  // only the single clock above. The gate reads the adapter's self-reported
  // `streamMode` (the existing mode-declaration SSOT), no second switch.
  const modelClocks = resolveModelClocks({
    modelTimeoutMs: modelTimeout,
    streamingArm: opts.deps.adapter.streamMode === true,
    idleTimeoutMs: opts.deps.modelIdleTimeoutMs,
    hardCapMs: opts.deps.modelHardCapMs,
  });

  const llmStartedAt = new Date().toISOString();
  const llmStartMono = performance.now();

  // ADR-0013: runModelPhase's failure side can return reactive_compact_pending;
  // here the model call is retried once with the compacted state (at most once
  // per run, gated by reactiveAttemptedRef). The ref is already flipped to
  // attempted=true before the first reactive_compact_pending returns, so the
  // second runModelPhase call can no longer produce it (it lands in
  // modelStop(protocolError)) — the narrowing below only enumerates ok/stop.
  // `effectiveState` records what the model actually saw this step: after
  // reactive compaction it replaces opts.state so appendMessage / finalState
  // reflect the compacted authoritative history (append-only invariant + never
  // dragging messages the model no longer sees back into history).
  //
  // ADR-0028: before every model call, append the current status bar as a user
  // message at the tail of the then-current `messages` — once at the first
  // call and once at the reactive-compact retry (the bar lands after compact);
  // proactive compact happens at the top of the run() loop before
  // stepWithTrace, so the bar naturally follows it. Old bars are never deleted or rewritten.
  type OkOrStop =
    | { kind: "ok"; result: AssistantTurnResult }
    | {
        kind: "stop";
        transition: Transition;
        turn: TurnTrace;
        apiError?: ApiErrorSummary;
      };
  // ADR-0081: the two graph seams (change → presence) run before mcpReconnect
  // / agentStatusBar, guaranteeing the model-readable order "graph-shift
  // notice → brief presence → reconnect report → status bar"; presence emits at
  // most one sentence per run; seam absent → zero appends.
  const graphSeamState = await appendGraphSeams(
    opts.state,
    opts.deps,
    opts.pendingInjected,
    opts.onStream
  );
  // ADR-0043: MCP manual-reconnect append seam — same segment as
  // graphModeChange (environment-level events), consuming pending before the
  // status bar. Seam absent → zero appends.
  const mcpReconnectState = appendMcpReconnect(
    graphSeamState.state,
    opts.deps,
    opts.pendingInjected
  );
  const barState = await appendAgentStatusBar(
    mcpReconnectState,
    opts.deps,
    opts.lastToolRef.lastTool,
    opts.reconcileRef,
    opts.pendingInjected,
    opts.onStream
  );
  // Environment live-status snapshot — a parallel independent stream at the
  // same turn boundary as agent_status (bar first, environment second);
  // host UI only, never touches messages.
  const barStateWithEnv = await appendEnvSnapshot(
    barState,
    opts.deps,
    opts.onStream
  );
  // ADR-0098: skill-index entry delta — the **last** append to the tail of
  // messages this turn. Seam absent / nothing new / delta fetch failure →
  // zero appends.
  const deltaState = await appendSkillIndexDelta(
    barStateWithEnv,
    opts.deps,
    opts.pendingInjected
  );
  // ADR-0108: model in-flight observation window — reset the buffer at each
  // step entry; keep only targets this step's undelivered output, so
  // assistants already appended via the normal path in finished turns are
  // never written twice.
  const modelStreamRef = opts.modelStreamRef;
  const modelOnStream = openModelInFlightWindow(modelStreamRef, opts.onStream);
  // One evidence sink per model step, shared by the transport
  // retries and the reactive-compact retry round so entries stay in invocation
  // order (see newDispatchEvidenceSink).
  const dispatchEvidence = newDispatchEvidenceSink(opts.deps.trace);
  const firstPhase = await runModelPhase({
    state: deltaState,
    deps: opts.deps,
    signal: opts.signal,
    started,
    modelHardCapMs: modelClocks.hardCapMs,
    modelIdleTimeoutMs: modelClocks.idleTimeoutMs,
    hostStreamPresent: opts.hostStreamPresent,
    onStream: modelOnStream,
    reactiveAttemptedRef: opts.reactiveAttemptedRef,
    frozenSystemPrefix: opts.frozenSystemPrefix,
    dispatchEvidence,
  });
  // Non-reactive path: the last message the model saw is deltaState (with the injected delta).
  let effectiveState: LoopState = deltaState;
  const modelPhase: OkOrStop =
    firstPhase.kind === "reactive_compact_pending"
      ? await (async (): Promise<OkOrStop> => {
          // ADR-0081: the reactive-compact retry passes the two graph seams too
          // (change may still flip within the same run; presence emits nothing
          // once its latch has settled).
          const compactedWithGraphSeams = await appendGraphSeams(
            firstPhase.state,
            opts.deps,
            opts.pendingInjected,
            opts.onStream
          );
          // ADR-0043: the retry also consumes reconnect pending (a manual
          // reconnect may complete between the two model calls of this round).
          const compactedWithReconnect = appendMcpReconnect(
            compactedWithGraphSeams.state,
            opts.deps,
            opts.pendingInjected
          );
          // The bar appends after compact (at the tail of the compaction
          // product), so the retry request ends with the newest bar. Shares
          // the same reconcileRef box as the normal step call site — a
          // compact kept-tail re-freeze clone does not fake an entry, and
          // settlement behavior stays the same shape.
          const compactedWithBar = await appendAgentStatusBar(
            compactedWithReconnect,
            opts.deps,
            opts.lastToolRef.lastTool,
            opts.reconcileRef,
            opts.pendingInjected,
            opts.onStream
          );
          // The reactive-compact retry emits the environment snapshot at the same turn boundary.
          const compactedWithEnv = await appendEnvSnapshot(
            compactedWithBar,
            opts.deps,
            opts.onStream
          );
          // ADR-0098: the post-compact retry also passes the delta seam — but
          // its judgment reads only the on-disk history, so "the delta inside
          // messages got eaten by compact" does not make it re-attach
          // (producer `computeSkillIndexDelta` does not read messages).
          const compactedWithDelta = await appendSkillIndexDelta(
            compactedWithEnv,
            opts.deps,
            opts.pendingInjected
          );
          effectiveState = compactedWithDelta;
          // The retry below is the request that reads this array, so it is the
          // exact post-compaction context to publish — no re-compaction, and no
          // reset of the progress already folded into the product.
          await publishSavedStateOrThrow(opts.deps, opts.frozenSystemPrefix, {
            boundary: "compacted",
            turnId,
            messages: compactedWithDelta.messages,
          });
          // ADR-0108: the reactive retry is a brand-new model generation —
          // reopen the observation window (reset the buffer); the half-finished
          // output before the earlier PromptTooLongError is not part of the
          // retry round's keep face. The retried runModelPhase consumes this
          // call's return value instead of reusing the first wrapping closure:
          // both write to the same ref today, but relying on "the return
          // values happen to be identical" is an implicit stale-closure
          // contract that would silently misalign if the window ever became a
          // fresh box per open.
          const retryOnStream = openModelInFlightWindow(
            modelStreamRef,
            opts.onStream
          );
          const compressedAttempt = await runModelPhase({
            state: compactedWithDelta,
            deps: opts.deps,
            signal: opts.signal,
            started,
            modelHardCapMs: modelClocks.hardCapMs,
            modelIdleTimeoutMs: modelClocks.idleTimeoutMs,
            hostStreamPresent: opts.hostStreamPresent,
            onStream: retryOnStream,
            reactiveAttemptedRef: opts.reactiveAttemptedRef,
            frozenSystemPrefix: opts.frozenSystemPrefix,
            dispatchEvidence,
          });
          if (compressedAttempt.kind === "reactive_compact_pending") {
            // Invariant violated — reactive_compact is disabled or already
            // attempted; runModelPhase should not return reactive_compact_pending again.
            return {
              kind: "stop",
              transition: {
                kind: "stop",
                reason: "protocolError",
                finalState: compressedAttempt.state,
              },
              turn: mkTurn({
                turnIndex: opts.state.turnCount,
                supplierStop: "other",
                toolCalls: [],
                durationMs: performance.now() - started,
                cancelKind: "none",
              }),
            };
          }
          return compressedAttempt;
        })()
      : firstPhase;

  const llmEndedAt = new Date().toISOString();
  const llmDurationMs = performance.now() - llmStartMono;
  // The trace `stream` boolean flips with the actual mode. The mode is
  // declared by the adapter via read-only `streamMode` (see the LoopAdapter
  // comment); both recordLlmCall sites (ok / error) share this single truth
  // value, read once before instrumentation.
  const streamMode = opts.deps.adapter.streamMode === true;
  const evidenceField = dispatchEvidenceField(dispatchEvidence);
  let llmCallId: string | undefined;
  if (opts.deps.trace) {
    if (modelPhase.kind === "stop") {
      const t = modelPhase.transition;
      const reason = t.kind === "stop" ? t.reason : "unknown";
      llmCallId = await safeTrace(() =>
        opts.deps.trace!.recordLlmCall({
          startedAt: llmStartedAt,
          endedAt: llmEndedAt,
          durationMs: llmDurationMs,
          stream: streamMode,
          messagesCaptured: true,
          // ADR-0014: the error branch also captures what the model actually
          // saw (effectiveState.messages, same source as the ok branch —
          // including the post-reactive-compaction shape). error/status field
          // semantics unchanged (Postel); messages is the independent "what
          // did the model actually see" channel, filled regardless of error, aligned with the ok branch.
          messages: effectiveState.messages,
          // Error branch: the three model fields are wholly absent (Postel,
          // same shape as ADR-0008) — the adapter never exposes a model, so
          // there is nothing to fill on success or failure alike.
          status: "error",
          ...evidenceField,
          error: { type: toTraceErrorType(reason), message: reason },
        })
      );
    } else {
      // usage absent (error/stub paths): the whole record is not written — Postel
      // (ADR-0008)
      const usage = modelPhase.result.usage;
      // modelRequested/modelActual/provider are absent (Postel).
      // LoopAdapter/AssistantTurnResult do not expose model fields (see
      // AssistantTurnResult in model-adapter/types.ts: only
      // nativeMessage/projection/supplierStop/usage) — model is a private
      // detail of the adapter's internal opts.model, and the bounded-context
      // boundary forbids loop-engine from importing adapter construction
      // options. If the capability does not exist, do not declare the field (ADR-0003).
      llmCallId = await safeTrace(() =>
        opts.deps.trace!.recordLlmCall({
          startedAt: llmStartedAt,
          endedAt: llmEndedAt,
          durationMs: llmDurationMs,
          supplierStop: modelPhase.result.supplierStop,
          stream: streamMode,
          messagesCaptured: true,
          // ADR-0014: the ok branch captures what the model actually saw
          // (effectiveState.messages — the authoritative post-reactive-compaction
          // history; effectiveState records exactly the messages the model saw
          // this step). This is an existing ADR-0003 field, filled here from
          // now on. Trade-off: full messages in the trace inflate the jsonl,
          // but LlmCallRecord.messages means precisely "messages the model
          // actually saw", satisfying the ADR's acceptance discipline
          // (messages_captured:true + the messages array including the
          // coordinator-section proactive keywords).
          messages: effectiveState.messages,
          status: "ok",
          ...evidenceField,
          ...(usage !== undefined ? usage : {}),
        })
      );
    }
  }

  if (modelPhase.kind === "stop") {
    if (opts.deps.trace) {
      const t2 = modelPhase.transition;
      const reason = t2.kind === "stop" ? t2.reason : "unknown";
      await safeTrace(() =>
        opts.deps.trace!.recordTurn({
          id: turnId,
          turnIndex: opts.state.turnCount,
          startedAt: turnStartedAt,
          endedAt: new Date().toISOString(),
          durationMs: performance.now() - started,
          llmCallIds: llmCallId ? [llmCallId] : [],
          toolCallIds: [],
          decision: toDecision(reason),
          status: "error",
          error: { type: toTraceErrorType(reason), message: reason },
        })
      );
    }
    return withApiError(
      {
        transition: modelPhase.transition,
        turn: modelPhase.turn,
        modelUsage: undefined,
      },
      modelPhase.apiError
    );
  }
  const turnResult = modelPhase.result;
  // ADR-0108: the full turn has been delivered — close the in-flight window; later stop reasons no longer enter the keep face.
  closeModelInFlightWindow(modelStreamRef);
  emitPostCallContextUsage(opts.onStream, turnResult);

  if (
    turnResult.projection.toolCalls.length === 0 &&
    turnResult.isEmptyFinalResponse
  ) {
    const durationMs = performance.now() - started;
    if (opts.deps.trace) {
      await safeTrace(() =>
        opts.deps.trace!.recordTurn({
          id: turnId,
          turnIndex: opts.state.turnCount,
          startedAt: turnStartedAt,
          endedAt: new Date().toISOString(),
          durationMs,
          llmCallIds: llmCallId ? [llmCallId] : [],
          toolCallIds: [],
          decision: "emptyFinalResponse",
          status: "error",
          error: {
            type: "emptyFinalResponse",
            message: "emptyFinalResponse",
          },
        })
      );
    }
    return {
      transition: {
        kind: "stop",
        reason: "emptyFinalResponse",
        finalState: effectiveState,
      },
      turn: mkTurn({
        turnIndex: opts.state.turnCount,
        supplierStop: turnResult.supplierStop,
        toolCalls: [],
        durationMs,
        cancelKind: "none",
      }),
      modelUsage: turnResult.usage,
    };
  }

  const nextState = appendMessage({
    state: effectiveState,
    msg: turnResult.nativeMessage,
  });
  const afterAssistantState = {
    messages: nextState.messages,
    turnCount: effectiveState.turnCount + 1,
  };
  // As soon as the assistant message enters the authoritative history it is
  // committed to disk through the host hook (write-as-you-run); the plain-text
  // finish and tool turns share this commit point. The assistant commit also
  // carries turnResult.thinkingMs (measured by the streaming arm stepStreamArm;
  // non-streaming / boundary shapes → undefined).
  // The pending injected messages (bar / graph / mcp) are concatenated at the
  // batch head and the buffer clears on flush — the on-disk commit chain and
  // the in-memory authoritative history stay per-entry LCP aligned, save no longer forks.
  await commitMessagesOrThrow(
    opts.deps,
    [...opts.pendingInjected.take(), turnResult.nativeMessage],
    turnResult.thinkingMs
  );

  if (turnResult.projection.toolCalls.length === 0) {
    return settleStopTurn({
      deps: opts.deps,
      turnResult,
      finalState: afterAssistantState,
      turnIndex: opts.state.turnCount,
      turnId,
      turnStartedAt,
      durationMs: performance.now() - started,
      llmCallId,
    });
  }

  // ADR-0126: an output-limit stop settles here, so no tool returned in that
  // incomplete response can run.
  if (turnResult.supplierStop === "truncation") {
    const durationMs = performance.now() - started;
    // The returned tool_use ids are closed in the same host turn so the
    // transcript stays replayable: native assistant message → one synthetic
    // protocol message → this turn's terminal outcome.
    const closeoutMessage: AnthropicNativeMessage = {
      role: "user",
      content: encodeOutputLimitToolResults(
        turnResult.projection.toolCalls.map((call) => call.id)
      ),
    };
    await commitMessagesOrThrow(opts.deps, [closeoutMessage]);
    return settleStopTurn({
      deps: opts.deps,
      turnResult,
      finalState: appendMessage({
        state: afterAssistantState,
        msg: closeoutMessage,
      }),
      turnIndex: opts.state.turnCount,
      turnId,
      turnStartedAt,
      durationMs,
      llmCallId,
    });
  }

  const toolStartedAt = new Date().toISOString();
  const toolStartMono = performance.now();

  const toolPhase = await runToolPhase({
    afterAssistantState,
    entryTurnCount: opts.state.turnCount,
    turnResult,
    deps: opts.deps,
    signal: opts.signal,
    started,
    turnId,
    pendingInjected: opts.pendingInjected,
    onStream: opts.onStream,
    frozenSystemPrefix: opts.frozenSystemPrefix,
  });

  // ADR-0028: last_tool = the last successful tool name in the batch (kind === "ok").
  // Scanned in execution order (serial batches = call order); successes
  // overwrite, failures never update; no success in batch → keep old value.
  // Tool names resolve via toolCallViews' id→name map (same source as trace
  // writes). The next appendAgentStatusBar consumes this value.
  const nameById = toolNameById(toolPhase.toolCallViews);
  for (const result of toolPhase.toolResults) {
    if (result.kind !== "ok") continue;
    const name = nameById.get(result.toolUseId);
    if (name !== undefined) opts.lastToolRef.lastTool = name;
  }

  const toolEndedAt = new Date().toISOString();
  const toolDurationMs = performance.now() - toolStartMono;
  const toolCallIds: string[] = [];
  if (opts.deps.trace) {
    // tool_call persistence needs arguments (a trace-observability pain point:
    // asking "which tool_call wrote a file" in a 39MB trace otherwise means
    // grepping raw jsonl llm_call messages). input is resolved from the same
    // toolCallViews the loop-detector uses, guaranteeing the persisted input
    // is identical to the runtime input; results are not persisted to avoid
    // doubling trace size (they are already fully persisted inside llm_call
    // tool_result). The mask pipeline runs uniformly over the whole JSON line
    // in jsonl.ts writeLine (same as messages) — no write-side trimming or
    // switch, per the "don't trim at the write side" decision in types.ts.
    const inputById = new Map(
      toolPhase.toolCallViews.map((v) => [v.id, v.input] as const)
    );
    for (const result of toolPhase.toolResults) {
      const record = toolCallRecordFor({
        parentLlmCallId: llmCallId,
        result,
        toolName:
          nameById.get(result.toolUseId) ??
          (result.kind === "tool_not_found" ? result.toolName : ""),
        arguments: inputById.get(result.toolUseId),
        startedAt: toolStartedAt,
        endedAt: toolEndedAt,
        durationMs: toolDurationMs,
      });
      const toolCallId = await safeTrace(() =>
        opts.deps.trace!.recordToolCall(record)
      );
      if (toolCallId) toolCallIds.push(toolCallId);
    }
  }

  if (opts.deps.trace) {
    const toolTransition = toolPhase.transition;
    const isStop = toolTransition.kind === "stop";
    const decision = toDecision(isStop ? toolTransition.reason : "completed");
    await safeTrace(() =>
      opts.deps.trace!.recordTurn({
        id: turnId,
        turnIndex: opts.state.turnCount,
        startedAt: turnStartedAt,
        endedAt: new Date().toISOString(),
        durationMs: performance.now() - started,
        llmCallIds: llmCallId ? [llmCallId] : [],
        toolCallIds,
        decision,
        status: isStop ? "error" : "ok",
        error: isStop
          ? {
              type: toTraceErrorType(
                toolTransition.kind === "stop"
                  ? toolTransition.reason
                  : "unknown"
              ),
              message:
                toolTransition.kind === "stop" ? toolTransition.reason : "",
            }
          : undefined,
      })
    );
  }

  if (
    toolPhase.transition.kind === "continue" &&
    opts.deps.detectToolLoop !== false
  ) {
    const phaseId = opts.toolLoopRef.nextPhase;
    opts.toolLoopRef.nextPhase += 1;
    const byId = new Map(
      toolPhase.toolCallViews.map((v) => [v.id, v] as const)
    );
    for (const result of toolPhase.toolResults) {
      const view = byId.get(result.toolUseId);
      if (view === undefined) continue;
      opts.toolLoopRef.events.push(
        toolLoopEventFromCall(view.name, view.input, result, phaseId)
      );
    }
    const fused = await fuseStalledPhase({
      events: opts.toolLoopRef.events,
      deps: opts.deps,
      pendingInjected: opts.pendingInjected,
      nextState: toolPhase.transition.nextState,
      turn: toolPhase.turn,
      modelUsage: turnResult.usage,
    });
    if (fused !== undefined) return fused;
  }

  return {
    transition: toolPhase.transition,
    turn: toolPhase.turn,
    modelUsage: turnResult.usage,
  };
}

/**
 * Single state-machine step. Calls the Adapter once from state + deps:
 *   1. turnCount already at maxTurns -> throw MaxTurnsExceeded (ADR-0011,
 *      replacing the old silent-stop), no Adapter call;
 *   2. call the Adapter; PromptTooLongError -> retry once with reactive
 *      compact (ADR-0013), still over / already tried -> stop protocolError;
 *      ProtocolError -> stop protocolError (the whole turn stays out of history);
 *   3. emptyFinalResponse -> stop emptyFinalResponse (turn not in history);
 *   4. plain-text finish -> stop completed (in history) or nonSuccessStop;
 *   5. tool calls -> execute tools, append encoded tool_results as one user
 *      message, produce continue nextState (turnCount + 1).
 *
 * signal is passed through to adapter.step; Adapter-thrown DOMException
 * AbortError and Promise.race timeouts are both converged into cancelled /
 * timeout. stepWithTrace is the only internal entry holding the trace;
 * public step() returns only Transition (frozen contract).
 *
 * adapter.step is itself async, so this step returns `Promise<Transition>`;
 * the sync signature in the original spec is honestly corrected to async to
 * avoid dual-implementation drift.
 */
export async function step(
  state: LoopState,
  deps: LoopEngineDeps,
  signal?: AbortSignal
): Promise<Transition> {
  // Single-step semantics: lastToolRef is created fresh per call (initial
  // idle, updated after the step's tool batch, never shared with run-scoped
  // state). pendingInjected likewise fresh per call (injections flush with this
  // step's commit, no cross-step residue). reconcileRef likewise fresh per
  // call (each single step cold-starts with stamped=undefined).
  const { transition } = await stepWithTrace({
    state,
    deps,
    signal,
    hostStreamPresent: false,
    reactiveAttemptedRef: { attempted: false },
    lastToolRef: { lastTool: AGENT_STATUS_IDLE_TOOL },
    reconcileRef: { stamped: undefined },
    toolLoopRef: { events: [], nextPhase: 0 },
    pendingInjected: createPendingInjected(),
    frozenSystemPrefix: createFrozenSystemPrefix(),
  });
  return transition;
}

/**
 * Full-round run: init -> repeated step -> stop closeout. All error paths are
 * owned by step to avoid dual-implementation drift.
 *
 * Return shape: `Promise<{ result: RunResult; trace: LoopTrace }>`.
 * RunResult shape unchanged; trace is accumulated immutably inside run
 * ([...prev, t]) and totals are computed once at the end.
 *
 * ADR-0011: on maxTurns overflow run throws MaxTurnsExceeded directly
 * (triggered at the stepWithTrace entry, before turnStartedAt / recordTurn;
 * surfaces do not rely on trace.turns, they infer turnCount from
 * throws.turnsRan), and the surface must catch it; exceptional stops
 * (protocolError / cancelled / timeout / nonSuccessStop) still return a stop
 * plus the epilogue summary event.
 */
export async function run(
  userText: string,
  deps: LoopEngineDeps,
  signal?: AbortSignal,
  opts?: {
    priorMessages?: ReadonlyArray<AnthropicNativeMessage>;
    onStream?: (event: HarnessStreamEvent) => void;
    appendUserText?: boolean;
    /** False when the caller only wraps onStream for its own bookkeeping and
     *  the actual host has no stream consumer. Defaults to
     *  `onStream !== undefined`. Gates the #1079 pre-call countTokens probe
     *  so wrapper-only hosts pay no per-call measurement cost. */
    hostStreamPresent?: boolean;
  }
): Promise<{ result: RunResult; trace: LoopTrace }> {
  // priorMessages continuation seam: history prefix frozen entry by entry, turnCount still starts at 0.
  // Recognition-layer entry — when secretsMode is not "block" and secretRegistry
  // is present, replace user text with placeholders before encoding. The
  // placeholder form never enters the registry (recognize only scans secret
  // shapes); placeholders from previous turns stay as-is across continuation.
  // appendUserText defaults to true = today's behavior; false = skip-append,
  // no encodeUserText and no recognize(userText).
  const hostStreamPresent =
    opts?.hostStreamPresent ?? opts?.onStream !== undefined;
  // Whether this run accepted new user input at all. The accepted-input
  // boundary exists for that acceptance only: a continuation run with
  // appendUserText:false appended nothing, so it has no input state to
  // publish and must not borrow one.
  const acceptedUserText = opts?.appendUserText !== false;
  let state: LoopState;
  if (acceptedUserText) {
    let effectiveUserText = userText;
    if (deps.secretsMode !== "block" && deps.secretRegistry !== undefined) {
      const { replaced } = recognize(userText, deps.secretRegistry);
      effectiveUserText = replaced;
    }
    state = {
      messages: Object.freeze([
        ...(opts?.priorMessages ?? []).map(freezeMessage),
        freezeMessage(deps.adapter.encodeUserText(effectiveUserText)),
      ]),
      turnCount: 0,
    };
  } else {
    if (userText !== "") {
      throw new SkipAppendWithTextError();
    }
    const prior = opts.priorMessages;
    if (prior === undefined || prior.length === 0) {
      throw new SkipAppendEmptyPriorError();
    }
    state = {
      messages: Object.freeze(prior.map(freezeMessage)),
      turnCount: 0,
    };
  }
  // ADR-0008: mutable ref for the usage of the last successful model call.
  // Initial null = no successful model call this run; updated only when a step
  // succeeds and usage is present.
  let lastUsage: TokenUsage | null = null;
  let turns: ReadonlyArray<TurnTrace> = [];
  // Start/end anchors for the run-level L1 root record (honest values: no
  // upfront estimation). endedAt / durationMs / status are only known when the
  // run closes, so the session record must be written at the very end — never
  // substitute estimates for real trace values.
  const sessionStartedAt = new Date().toISOString();
  const sessionStartMono = performance.now();
  // turnCount anchor for the proactive auto-compact check. Initial -1 =
  // "nothing compacted successfully yet this run" — the run() start
  // (turnCount=0) also enters the gate (a prior-continuation session over the
  // gate must not send over-gate context to the model first). The anchor only
  // forbids repeat scans that already succeeded on this turnCount, never the first step.
  // Closure variable, not part of LoopState.
  let lastCompactTurn: number = -1;
  // ADR-0013: reactive-compact attempted flag (at most once per run, closure variable).
  const reactiveAttemptedRef = { attempted: false };
  // accepted_input latch (at most once per run, closure variable): the loop
  // body repeats per step but the accepted input is a single event.
  const acceptedInputLatch = { published: false };
  // Frozen prompt prefix shared by every publication of this run (see
  // FrozenSystemPrefix). Discarded at run end; a resumed run re-seeds it.
  const frozenSystemPrefix = createFrozenSystemPrefix();
  // ADR-0028: status-bar last_tool run-scoped state — one run = one user
  // turn; initial idle (no tools run yet this turn), updated after each tool
  // batch to the last successful tool name; shared across steps, discarded at run end.
  const lastToolRef = { lastTool: AGENT_STATUS_IDLE_TOOL };
  // Reconcile settlement box — same shape as lastToolRef: one run = one
  // "new message entered" observation window; the first bar marks it, later
  // hops/steps no longer re-mark; discarded at run end (the next run boxes
  // fresh → a second wave marks again).
  const reconcileRef: { stamped: AnthropicNativeMessage | undefined } = {
    stamped: undefined,
  };
  const toolLoopRef = { events: [] as ToolLoopEvent[], nextPhase: 0 };
  // Run-scoped pending buffer for injected messages (see createPendingInjected).
  const pendingInjected = createPendingInjected();
  // ADR-0108: model in-flight streaming text buffer — stepWithTrace accumulates
  // text_delta inside the in-flight window (the same bytes as the on-screen
  // draft); the cancelled closeout keeps the pinned prefix in the authoritative
  // history with the same freeze knife.
  const modelStreamRef = { text: "", modelInFlight: false };
  // ADR-0081: each run() re-settles the brief presence (same deps do not carry an old latch across runs).
  resetGraphPresenceLatch(deps);
  while (true) {
    // compress seam absent (field omitted) → skip the check, zero behavior change (byte-identical).
    // Check before every step entry, including this run's first step
    // (turnCount=0; a prior-continuation session over the gate is not exempt);
    // the anchor only prevents repeat estimates that already succeeded on the
    // same turnCount.
    //
    // The proactive gate uses the unified criterion `evaluateCompactTrigger`
    // (token threshold + window gating + full-summary degradation, three
    // stages). The old `shouldAutoCompact` judged only the token threshold:
    // when tokens were over but messages ≤ DEFAULT_KEEP_RECENT,
    // `splitForCompaction` returned undefined → applyCompactAttachment left
    // state unchanged → lastCompactTurn never updated → infinite re-trigger.
    // New criterion:
    //   - compact_via_window → applyCompactAttachment's existing window path (behavior unchanged);
    //   - compact_via_full_summary → applyFullCompactSummary treats the whole
    //     span as dropped and runs an LLM summary, no kept tail; on success the
    //     messages reference changes → lastCompactTurn updates;
    //   - noop → tokens below threshold, skip (zero behavior change).
    if (deps.compress !== undefined && state.turnCount > lastCompactTurn) {
      const threshold = getAutoCompactThreshold(
        deps.compress.contextWindow,
        deps.compress.thresholdTokens
      );
      // ADR-0118: occupancy chain = this-beat measurement → previous usage →
      // estimate. The probe failing must never skip the gate evaluation.
      const thisBeat = await measureGateThisBeatOccupancy(deps, state.messages);
      const decision = evaluateCompactTrigger(state.messages, {
        contextWindow: deps.compress.contextWindow,
        threshold,
        thisBeatOccupancy: thisBeat,
        previousUsage: lastUsage,
      });
      if (decision.action !== "noop") {
        let compactedState: LoopState;
        if (decision.action === "compact_via_window") {
          // Existing window path: splitForCompaction → runFullCompact → buildCompactedMessages.
          // Behavior unchanged.
          compactedState = await applyCompactAttachment(state, deps, {
            signal,
            onStream: opts?.onStream,
          });
        } else {
          // compact_via_full_summary: tokens over but messages ≤ keepRecent;
          // the whole span is treated as dropped and sent through an LLM
          // summary, no kept tail.
          compactedState = await applyFullCompactSummary(state, deps, {
            signal,
            onStream: opts?.onStream,
          });
        }
        if (compactedState.messages !== state.messages) {
          // Immutable rebuild; no mutation, the original messages reference stays.
          // Freeze gate: like appendMessage, the compaction result must freeze
          // every message, otherwise mutable plain objects would enter the
          // authoritative history and violate the append-only invariant.
          state = compactedState;
          lastCompactTurn = state.turnCount;
          // The compaction product can never LCP-align with the old chain
          // (existing fork-copy semantics), and old pending injections can only
          // point at message positions that no longer exist — drop the buffer
          // so post-compaction injections flush with the new commit.
          pendingInjected.take();
          // The step about to run reads exactly this array, so publishing it
          // here is what lets a restart resume the compacted context instead
          // of re-deriving it. turnId is honestly null: a step boundary has no
          // dispatch in flight, and the engine mints the id at dispatch.
          await publishSavedStateOrThrow(deps, frozenSystemPrefix, {
            boundary: "compacted",
            turnId: null,
            messages: compactedState.messages,
          });
        }
      }
    }
    // WHY here and once: the accepted-input write must carry the context the
    // first request actually sees, so it lands after this iteration's
    // proactive compaction gate — and the loop body is re-entered per step,
    // while an accepted input is a once-per-run event. The publisher owns the
    // "only a run that appended user text" rule, so this call site has no
    // branch of its own to keep in step with the latch.
    await publishAcceptedInputOnceOrThrow(
      deps,
      acceptedInputLatch,
      frozenSystemPrefix,
      state.messages,
      acceptedUserText
    );
    let stepResult: StepResult;
    try {
      stepResult = await stepWithTrace({
        state,
        deps,
        signal,
        onStream: opts?.onStream,
        hostStreamPresent,
        reactiveAttemptedRef,
        lastToolRef,
        reconcileRef,
        toolLoopRef,
        pendingInjected,
        modelStreamRef,
        frozenSystemPrefix,
      });
    } catch (err) {
      if (err instanceof MaxTurnsExceeded) {
        // ADR-0011: maxTurns overflow takes the throw path (not the stop
        // branch); run one best-effort epilogue summary before rethrowing, then
        // rethrow as-is — the original stop cause still throws, and a summary
        // failure/timeout must never block the throw.
        await epilogueSummary({
          deps,
          messages: state.messages,
          reason: err.reason,
          onStream: opts?.onStream,
          signal,
        });
      }
      throw err;
    }
    const { transition, turn, modelUsage, apiError, supplierDetail } =
      stepResult;
    if (turn !== null) {
      // immutable append; no push / in-place mutation.
      turns = [...turns, turn];
    }
    // lastUsage updates only on a successful model call (usage present); failure / cancel / timeout paths never overwrite it.
    if (modelUsage !== undefined) {
      lastUsage = modelUsage;
    }
    if (transition.kind === "stop") {
      const { reason, finalState } = transition;
      // ADR-0108: the freeze-prefix keep for model in-flight cancelled, the
      // interrupt append, and the commit flush order all converge in
      // closeoutInFlightStop (see its docs); it completes before
      // epilogueSummary so the summary sees the full history.
      const keptState = await closeoutInFlightStop({
        deps,
        reason,
        finalState,
        modelStreamRef,
        pendingInjected,
      });
      const finalMessages = keptState.messages;
      const finalText =
        reason === "completed" ? deriveFinalText(finalMessages) : null;
      // ADR-0094: gateway-side summary on transport failure (threaded from the
      // stepWithTrace / modelStop catch branch); non-transport failure
      // (apiError undefined) → field absent (byte-stable, same wire-surface pattern as lastUsage).
      const result: RunResult = withApiError(
        {
          finalText,
          messages: finalMessages,
          turnCount: finalState.turnCount,
          stopReason: reason,
          lastUsage,
          ...supplierDetailField(supplierDetail),
        },
        apiError
      );
      // Terminal record for the settled turn: the final context plus the
      // observed stop reason, never a completeness verdict (ADR-0126 leaves
      // "was this turn known to be finished" to the host, which owns the
      // turn-outcome record; an absent record simply stays unknown). WHY here:
      // the messages are settled by closeout above, and maxTurns leaves through
      // the throw path, so no unsettled turn can reach this site. Whether an
      // operation is still outstanding after an interrupted stop is not
      // observable from the kernel — the detached-handler case surfaces in the
      // fact stream, and the reason travels as observed.
      await publishSavedStateOrThrow(deps, frozenSystemPrefix, {
        boundary: "terminal_turn",
        turnId: null,
        messages: finalMessages,
        terminal: {
          stopReason: reason,
          ...supplierDetailField(supplierDetail),
        },
      });
      // ADR-0011: after an exceptional stop run one best-effort epilogue
      // summary. It counts toward neither maxTurns nor the tool budget; on
      // failure just skip, never block the original stop cause.
      if (needsEpilogueSummary(reason, supplierDetail)) {
        await epilogueSummary({
          deps,
          messages: finalMessages,
          reason,
          onStream: opts?.onStream,
          signal,
        });
      }
      // At run end, write one session L1 root record (only when the caller
      // injected agentVersion and trace is enabled). status derives from
      // result.stopReason: completed → ok, everything else
      // (nonSuccessStop/protocolError/cancelled/...) → error. Instrumentation
      // goes through safeTrace; failure never interrupts business (@throws never).
      if (deps.trace && deps.agentVersion !== undefined) {
        const sessionEndedAt = new Date().toISOString();
        const sessionDurationMs = performance.now() - sessionStartMono;
        const sessionStatus: TraceStatus =
          reason === "completed" ? "ok" : "error";
        const sessionError: TraceError | undefined =
          reason === "completed"
            ? undefined
            : { type: toTraceErrorType(reason), message: reason };
        await safeTrace(() =>
          deps.trace!.recordSession({
            startedAt: sessionStartedAt,
            endedAt: sessionEndedAt,
            durationMs: sessionDurationMs,
            agentVersion: deps.agentVersion!,
            status: sessionStatus,
            ...(sessionError !== undefined ? { error: sessionError } : {}),
          })
        );
      }
      return {
        result,
        trace: { turns, totals: computeTotals(turns) },
      };
    }
    state = transition.nextState;
  }
}

// Re-export spec types for downstream consumers.
export type { Executor, Registry } from "./tools/types.js";
export type { LoopTrace, TurnTrace, Totals, CancelKind } from "./loop-trace.js";

/** envSnapshot seam shape alias — lets tests / external assembly code
 *  reference the same type instead of casting `unknown` to
 *  `LoopEngineDeps.envSnapshot`. */
export type EnvSnapshotSeam = { readonly readCwd: () => string };

/**
 * Factory: closes the dep bag into a runner / stepper object.
 * The returned `step` is the closure version (only state needed); `run` takes userText.
 *
 * The closure layer's run / step pass through the optional third signal
 * parameter; return shapes follow run / step extensions, and the closure type
 * signatures update in sync.
 */
export function createLoopEngine(deps: LoopEngineDeps): {
  readonly run: (
    userText: string,
    signal?: AbortSignal
  ) => Promise<{ result: RunResult; trace: LoopTrace }>;
  readonly step: (
    state: LoopState,
    signal?: AbortSignal
  ) => Promise<Transition>;
} {
  return Object.freeze({
    run: (userText: string, signal?: AbortSignal) =>
      run(userText, deps, signal),
    step: (state: LoopState, signal?: AbortSignal) => step(state, deps, signal),
  });
}
