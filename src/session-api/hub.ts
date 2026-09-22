/**
 * In-process multi-conversation host over harness foundation runtime.
 * Flow: load → run(priorMessages) → conditional save → wire projection.
 * Messages single-source is the session file; hub holds no messages copy.
 * Per-session JSONL trace when traceOut is configured (ADR-0003).
 *
 * askUser is required at engine construction. Hub accepts `askUser`
 * via SessionHubOptions (tests inject createNoAskUser()); production callers
 * (serve.ts) supply the SPA-channel implementation or a v0 stub.
 */
import { randomUUID } from "node:crypto";
import {
  run,
  createJsonlTraceService,
  compactMessages,
  runFullCompact,
  buildCompactedMessages,
  splitForCompaction,
  type AnthropicNativeMessage,
  type HarnessStreamEvent,
  type LoopEngineDeps,
  type RunResult,
  type TokenUsage,
} from "../harness/index.js";
import type { TraceServiceWithHealth } from "../harness/trace/jsonl.js";
import { type CompactReason } from "../harness/compress/index.js";
import {
  runVerifyLoop,
  type VerifyConfig,
  type VerifyLoopOutcome,
} from "../harness/verify/index.js";
import { createRunClassifierFromManager } from "../harness/verify/run-classifier-adapter.js";
import {
  buildHarnessEngine,
  createAdapterFromEnv,
  type EngineBundle,
} from "../harness/build-engine.js";
import {
  renderTranscript,
  hasSuccessfulMemorySave,
} from "../harness/auto-memory-wire.js";
import {
  applyHostPrefetch,
  notifyAutoMemory,
  recoverInjectedMemoryIds,
  recordInjectedMemoryIds,
  type AutoMemoryHook,
  type OverlayPrefetchFn,
} from "../harness/memory/index.js";
import { drainPendingSubagents } from "../harness/subagent/host-drain.js";
import { stampHostInjected } from "../harness/model-adapter/outbound-projection.js";
import {
  createSubagentWake,
  queryableSubagentTaskIds,
  toSubagentWakeError,
  type SubagentWake,
} from "../harness/subagent/host-wake.js";
import type {
  SubAgentManager,
  SubagentInfo,
} from "../harness/subagent/manager.js";
import {
  createSubagentManagerRegistry,
  type SubagentManagerReadView,
  type SubagentManagerRegistry,
} from "../harness/subagent/manager-registry.js";
import type { SubAgentTerminalSubscriber } from "../harness/subagent/mailbox.js";
import { getVersion } from "../cli/usage.js"; // agentVersion injection (same import direction as session-api/http.ts, no cycle)
import {
  createTaskWorktreeProvisioner,
  mainCheckoutOf,
  type TaskWorktreeProvisioner,
} from "./worktree-rebind.js";
import type { ProjectDepProvisioner } from "./worktree-deps.js";
import type {
  TaskWorktreeInfo,
  WorktreeGateReader,
  WorktreeProvisionContext,
  WorktreeRemoval,
  WorktreeRemoveContext,
} from "../harness/isolation/worktree-gate.js";
import { createWorktreeHostProvision } from "../harness/isolation/worktree-host.js";
import type { AskUser } from "../harness/permission/types.js";
import type {
  ServeAskUserHandle,
  PendingAskView,
} from "../harness/permission/ask-user.js";
import type { SessionGrants } from "../harness/permission/session-grants.js";
import type { PermissionModeContext } from "../harness/permission/modes.js";
import type { GraphAssembly } from "../harness/graph/assembly.js";
import type { GraphModeContext } from "../harness/graph/mode.js";
import type {
  FsIsolationMode,
  FsModeContext,
} from "../harness/sandbox/fs-mode.js";
import type { YoloContext } from "../harness/sandbox/yolo.js";
import type { LiveGraphLedgerHost } from "../harness/graph/ledger.js";
import { resolveSessionFenceTmp } from "../harness/sandbox/fence-tmp.js";
import { createViolationCounter } from "../harness/sandbox/violation-handling.js";
import { wrapWithViolationHook } from "../harness/sandbox/violation-executor.js";
import {
  createOutputMask,
  currentSecretValues,
} from "../harness/sandbox/index.js";
import { loadIknowEnv, type IknowEnv, type LlmEnv } from "../config/env.js";
import type { IknowSettings } from "../config/settings.js";
import {
  MAX_WORKSPACE_ROOT_CHARS,
  resolveWorkspaceRoot,
  type WorkspaceRootError,
} from "../config/workspace-root.js";
import {
  loadWorkspacesRecents,
  upsertWorkspaceRecent,
} from "../config/workspaces-recents.js";
import { ValidationError, NotFoundError } from "../shared/errors.js";
import {
  MEMORY_DIR_NAME,
  TASKS_DIR_NAME,
} from "../shared/session-tree-names.js";
import { LLM_API_KEY_MISSING_MESSAGE } from "../config/messages.js";
import {
  MaxTurnsExceeded,
  McpLifecycleError,
  errorMessage,
  withApiError,
} from "../harness/errors.js";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { AciCatalog } from "../harness/aci/types.js";
import {
  loadableOf as loadableOfShared,
  type SkillCatalog,
  type SkillEntry,
} from "../harness/skill/catalog.js";
import {
  SkillRescanError,
  type SkillRescanner,
} from "../harness/skill/rescan.js";
import { createSkillBody, exceedsUserInputCap } from "../harness/skill/body.js";
import type { McpManager } from "../harness/mcp/manager.js";
import { loadMcpConfig } from "../harness/mcp/config.js";
import { resolveMcpRoots, type McpRoots } from "../harness/mcp/roots.js";
import { SessionStore, type SessionListEntry } from "./store/index.js";
import type { SessionStoreError } from "./store/index.js";
import type { SessionFileV1 } from "./store/index.js";
import { resolveConversationTraceFilePath } from "./store/index.js";
import { readWorkerInFlightToolName } from "./store/index.js";
import {
  appendCheckpoint,
  CURRENT_SCHEMA_VERSION,
  decideCheckpointPersist,
  extractTitle,
  pinGoal,
  shouldPersistCheckpoint,
  toInterruptReason,
  validateGoalText,
} from "./store/index.js";
// Deep import: internal persist-rule helper, deliberately not on the store barrel.
import { persistedLastUsage } from "./store/schema.js";
import { recognize } from "../harness/secret-roundtrip/index.js";
import type { GoalStatus } from "./store/index.js";
import { applyTransition, assertValidTransition } from "./goal/index.js";
import {
  applyGoalAutoContinue,
  applyGoalAutoError,
  parseGoalPinInput,
  reportGoalAutoStoreLoadErr,
  runAutoLoopSteps,
} from "./goal-auto.js";
import {
  continuePredicateError,
  evaluateContinuePending,
  mapSkipAppendToContinueError,
  stripTrailingInterrupt,
} from "./continue-pending.js";
import type {
  ApiErrorBody,
  CompactCallerOpts,
  CompactSessionResponse,
  CreateSessionRequest,
  CreateSessionResponse,
  GetSessionResponse,
  McpServerStatusDto,
  McpToolDto,
  PostMessageResponse,
  ResetSessionResponse,
  RewindSessionResponse,
  RewindTargetsResponse,
  SessionSummary,
  SkillSummaryDto,
  TurnDto,
  VerifyAnswerView,
} from "./contract.js";
import { MAX_MESSAGE_CHARS } from "./contract.js";
import { projectVerifyHumanView } from "./verify-human-view.js";
import {
  extractRecentUserTasks,
  isTurnQuery,
  messageText,
  projectThinkingView,
  projectToolCalls,
  sumAssistantThinkingMsInRange,
  TASK_EXCERPT_PREFIX,
} from "./turn-projection.js";
import {
  collectTitleSource,
  sanitizeSessionTitle,
  type TitleGenerator,
} from "./title-generation.js";
import type { WorkspaceResponse } from "./contract.js";
import {
  withThinkingOverride,
  type ThinkingOverride,
} from "./thinking-override.js";

/** Best-effort JSON parse: returns the parsed value or the raw string. */
function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

/**
 * Validate the root at the session-creation boundary as well as at the
 * entrypoint.  `SessionHub` is also constructed directly by tests and host
 * adapters, so trusting the constructor option here would allow malformed
 * roots to reach `SessionStore.save()` and would turn a create validation
 * failure into a disk-write failure.
 */
function requireCreateWorkspaceRoot(root: unknown): string {
  if (typeof root !== "string" || root.length === 0) {
    throw new ValidationError(
      "workspace root is required to create a session",
      { field: "workspaceRoot" }
    );
  }
  if (root.length > MAX_WORKSPACE_ROOT_CHARS) {
    throw new ValidationError("workspace root exceeds the maximum length", {
      field: "workspaceRoot",
    });
  }
  try {
    return resolveWorkspaceRoot({ explicit: root });
  } catch {
    throw new ValidationError(
      "workspace root must be an absolute existing directory",
      { field: "workspaceRoot" }
    );
  }
}

/**
 * Validate the root loaded from a session before any execution work.
 *
 * Session files are intentionally Postel on load so legacy sessions remain
 * inspectable. They are not executable, however: an absent root is unbound
 * and a present root must still be an absolute existing workspace. Never
 * substitute cwd here.
 */
function requireBoundRoot(root: unknown): string {
  if (typeof root !== "string" || root.trim().length === 0) {
    throw new ValidationError(
      "workspace is unbound; bind a workspace before executing this session",
      { field: "workspaceRoot" }
    );
  }
  if (root.length > MAX_WORKSPACE_ROOT_CHARS) {
    throw new ValidationError("workspace root exceeds the maximum length", {
      field: "workspaceRoot",
    });
  }
  try {
    return resolveWorkspaceRoot({ explicit: root });
  } catch {
    throw new ValidationError(
      "workspace root is invalid; bind an existing absolute directory",
      { field: "workspaceRoot" }
    );
  }
}

/**
 * Detect a goal re-pin directive at the very start of a message.
 *
 * Matches only a **leading** `## GOAL:` marker (after trim). Returns the
 * trimmed goal text, or null when the marker is absent / mid-message. A
 * marker with no text (`## GOAL:` or `## GOAL:   `) returns `""` — the
 * caller treats an empty result as a no-op (goal unchanged, no model run).
 *
 * Why leading-only: a mid-message `hello ## GOAL: x` is the user talking
 * *about* the directive, not issuing it — the whole message stays a query.
 */
export function parseGoalCommand(text: string): string | null {
  const trimmed = text.trim();
  const marker = "## GOAL:";
  if (!trimmed.startsWith(marker)) return null;
  return trimmed.slice(marker.length).trim();
}

/**
 * Key-field value comparison for hot-reload rebuild dedup.
 *
 * EnvLoader.get() returns a **new object** on every reload (loadIknowEnv
 * builds a fresh one each time), so identity comparison is useless.
 * "settings file touched but content unchanged" must be decided by value
 * across all createAdapterFromEnv inputs: model / apiKey / baseUrl /
 * headers / maxOutputTokens / temperature / stream + thinking controller's
 * thinking / thinkingEffort. fallback is unrelated to the adapter but
 * reflects config changes, so it is compared too (element-wise,
 * order-sensitive).
 */
function sameHotReloadKeyFields(a: LlmEnv, b: LlmEnv): boolean {
  if (a.model !== b.model) return false;
  if (a.apiKey !== b.apiKey) return false;
  if (a.baseUrl !== b.baseUrl) return false;
  if (a.maxOutputTokens !== b.maxOutputTokens) return false;
  if (a.temperature !== b.temperature) return false;
  if (a.stream !== b.stream) return false;
  if (a.thinking !== b.thinking) return false;
  if (a.thinkingEffort !== b.thinkingEffort) return false;
  if (!sameHotReloadHeaders(a.headers, b.headers)) return false;
  return sameStringArray(a.fallback, b.fallback);
}

/**
 * Per-key headers comparison: headers are a createAdapterFromEnv input, so
 * skipping them would let "provider.headers edited only" read as
 * touched-but-unchanged → no adapter rebuild → new headers never reach the
 * wire.
 *
 * Absence ⇔ key missing (the env layer guarantees "key exists only when a
 * value exists" — see the LlmEnv.headers note), so `undefined` equals only
 * `undefined` and never any map; the key set and every value are compared
 * (order-insensitive).
 */
function sameHotReloadHeaders(
  a: Readonly<Record<string, string>> | undefined,
  b: Readonly<Record<string, string>> | undefined
): boolean {
  if (a === undefined || b === undefined) return a === b;
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) return false;
  return aKeys.every((key) => a[key] === b[key]);
}

/** Element-wise, order-sensitive string-array comparison. */
function sameStringArray(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((value, i) => value === b[i]);
}

// -- error mapping (pure function; http.ts consumes) ---------------------------

/**
 * Status + message per SessionStoreError kind. Data table replaces the prior
 * 6-case switch so mapStoreError stays a flat lookup.
 * retryable is implicit via 5xx status (not in wire).
 */
type StoreErrorEntry = {
  status: number;
  message: (err: SessionStoreError) => string;
};

/**
 * Reason SSOT for compaction failure: the three failure branches (signal
 * aborted / placeholder fallback also ineffective / defensive catch-all)
 * converge on one literal to avoid divergent-change drift.
 */
const REASON_NO_COMPRESS: CompactReason = "messages_too_few";

/**
 * Reason-decision SSOT. Windowed compaction success → "windowed"; LLM
 * summary success → "full_summary" regardless of the triggering action,
 * because nextMessages really is SUMMARY_PREAMBLE + summary — the user
 * should see "summary" wording, not "trimmed early turns" wording.
 */
function compactReasonFor(args: {
  readonly useCompactMessages: boolean;
}): CompactReason {
  if (!args.useCompactMessages) return "full_summary";
  return "windowed";
}

const STORE_ERROR_MAP: Record<SessionStoreError["kind"], StoreErrorEntry> = {
  not_found: {
    status: 404,
    message: (e) => `session not found: ${e.conversation_id}`,
  },
  parse_failed: {
    status: 422,
    message: (e) => `session file is not valid JSON: ${e.conversation_id}`,
  },
  schema_invalid: {
    status: 422,
    // schema_invalid carries `field`; narrow via `in` since the param is the
    // full union (the entry is only invoked for its own kind at runtime).
    message: (e) =>
      `session file schema invalid at field: ${"field" in e ? e.field : e.conversation_id}`,
  },
  write_failed: {
    status: 500,
    message: (e) => `failed to write session file: ${e.conversation_id}`,
  },
  concurrent_write: {
    status: 409,
    message: (e) => `concurrent write conflict: ${e.conversation_id}`,
  },
  io_error: {
    status: 500,
    message: (e) => `IO error on session file: ${e.conversation_id}`,
  },
};

/**
 * Map typed SessionStoreError → HTTP status + wire ApiErrorBody.
 */
export function mapStoreError(err: SessionStoreError): {
  status: number;
  body: ApiErrorBody;
} {
  const entry = STORE_ERROR_MAP[err.kind];
  return {
    status: entry.status,
    body: {
      error: {
        kind: err.kind,
        message: entry.message(err),
        conversation_id: err.conversation_id,
      },
    },
  };
}

/** Plain-object SessionStoreError guard (store never throws Error subclasses). */
function isSessionStoreError(err: unknown): err is SessionStoreError {
  if (typeof err !== "object" || err === null) return false;
  if (err instanceof Error) return false;
  const k = (err as { kind?: unknown }).kind;
  return typeof k === "string" && k in STORE_ERROR_MAP;
}

/**
 * Log-and-continue rendering (ADR-0113): typed store errors are identified
 * by `kind` first — routing a plain object through `instanceof Error` would
 * render "[object Object]" and hide kind/context entirely; only non-store
 * errors fall back to Error text.
 */
function describeTitleError(err: unknown): string {
  if (isSessionStoreError(err)) return `${err.kind}: ${err.conversation_id}`;
  return err instanceof Error ? err.message : String(err);
}

/**
 * Absence/presence shell for optional opts fields: emits `{ [key]: value }`
 * only when the value is present, `{}` when absent. Replaces
 * `...(x ? { k: x } : {})` — both branches of that form count toward
 * complexity metrics, while host-side destructuring semantics stay the same
 * (absent = key does not appear).
 *
 * `=== undefined` is the only test: null / false / 0 all count as present.
 */
function presentFields<V>(
  key: string,
  value: V | undefined
): { readonly [k: string]: V } {
  if (value === undefined) return {};
  return { [key]: value };
}

/**
 * Presence shell for non-empty text fields — both `undefined` and `""`
 * count as absent.
 *
 * Kept separate from `presentFields` instead of merging into one loose
 * "falsy means absent" variant: whether `""` is absent or a legal value is
 * the **caller's contract** (`stopSummary` treats it as absent); merging
 * would let another caller silently drop legal `false` / `0` values.
 */
function presentText<V extends string>(
  key: string,
  value: V | undefined
): { readonly [k: string]: V } {
  if (value === undefined || value === "") return {};
  return { [key]: value };
}

/**
 * Auto-loop persist is best-effort. Typed load faults skip persist without
 * changing continue/stop behavior; unknown throws rethrow (store contract).
 *
 * Render contract: typed kinds other than `not_found` are echoed to stderr as
 * `${kind}: ${conversation_id}` — mirrors chat's `skipChatAutoOnLoadError`.
 */
function skipAutoPersistOnLoadError(
  err: unknown,
  conversationId: string
): void {
  if (!isSessionStoreError(err)) {
    throw err;
  }
  reportGoalAutoStoreLoadErr(err, conversationId);
}

// -- verify outcome → goal status ---------------------------------------------

/**
 * Verify-loop terminal outcome → goal status write-back target.
 *
 * `undefined` = no status change (trace record only, via recordGoal).
 * Mimics STORE_ERROR_MAP's data-table shape.
 *
 * - `passed`     → "achieved"
 * - `aborted`    → "aborted"
 * - `escalated`  → "aborted"
 * - `failed`     → "active"   (result stays active; trace record only)
 * - `unstable`   → "active"   (result stays active; trace record only)
 * - `disabled`   → undefined  (no status change; trace record only)
 */
const OUTCOME_TO_STATUS: Record<VerifyLoopOutcome, GoalStatus | undefined> = {
  passed: "achieved",
  aborted: "aborted",
  escalated: "aborted",
  failed: "active",
  unstable: "active",
  disabled: undefined,
} as const;

// -- history projection (getSession turns) -------------------------------------
// Text joining (messageText) and turn-boundary detection (isTurnQuery)
// converge in turn-projection.ts (store/checkpoint.ts share the same SSOT).

/**
 * Project raw AnthropicNativeMessage[] → display-form TurnDto[] for wire.
 * Pairs each user message with its subsequent assistant message.
 * Projection is non-authoritative: stopReason/turnCount are lossy.
 *
 * Also projects thinking/toolCalls per turn (messages between this user
 * query and the next real query message, per `isTurnQuery`). Output is
 * secret-masked.
 *
 * Wire surface: `thinkingMs` is a parallel array aligned 1:1 with `messages`
 * (SessionFileV1.thinkingMs). Sum the thinkingMs values of every assistant
 * message inside each turn slice; when sum > 0 attach it to the
 * TurnAnswerDto `thinkingMs` (ms) field. Absent = legacy session /
 * non-assistant turn / sum = 0 — same byte-stable pattern as
 * thinking/toolCalls/lastUsage.
 */
/**
 * Subagent record placement on the serve path: the hub engine is shared
 * across conversations (not rebuilt per conversationId — see the cachedDeps
 * note), so assembly time cannot know a single session's conversationId.
 * Two-stage seam instead: assembly passes `projectDir`
 * (`<baseDir>/projects/<slug>`), and the manager derives the
 * per-conversation leaf `<projectDir>/<convId>/subagents/` from
 * `def.conversationId` at spawn time (same shape as todo-write's
 * `resolveConversationTodoPath`). On session deletion, `SessionStore.delete`
 * removes the whole `<convId>/` folder, subagent records included — no
 * orphans at the project level; the old flat project-level layout is
 * retired.
 */

export function projectMessagesToTurns(
  messages: ReadonlyArray<AnthropicNativeMessage>,
  thinkingMs?: ReadonlyArray<number | null>,
  /** #1079 reopen replay: the session file's persisted usage snapshot.
   *  Attached to the LAST projected turn's answer only (the snapshot is by
   *  definition that turn's reading; earlier turns' usage is unknowable from
   *  a single ledger). Absent/null → no key anywhere (byte-stable pattern as
   *  thinking/toolCalls/lastUsage). */
  lastUsage?: TokenUsage | null
): TurnDto[] {
  const mask = createOutputMask(currentSecretValues()).mask;
  const turns: TurnDto[] = [];
  let turnIndex = 0;
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    // Skip tool_result continuations and subagent drain messages (neither is
    // a real user query — drain is a host-injected result summary).
    if (!isTurnQuery(msg)) continue;
    const query = messageText(msg);
    // Turn slice: from this query until the next real query message.
    const end = findTurnSliceEnd(messages, i);
    const turnMessages = messages.slice(i, end);
    const finalText = findFinalTextInSlice(turnMessages);
    turnIndex++;
    const thinking = projectThinkingView(turnMessages, mask);
    const toolCalls = projectToolCalls(turnMessages, mask);
    const turnThinkingMs = sumAssistantThinkingMsInRange({
      messages: turnMessages,
      thinkingMs,
      startIndex: i,
    });
    turns.push({
      query,
      answer: {
        finalText,
        stopReason: "completed",
        turnCount: turnIndex,
        ...(thinking !== undefined ? { thinking } : {}),
        ...(toolCalls !== undefined ? { toolCalls } : {}),
        ...(turnThinkingMs > 0 ? { thinkingMs: turnThinkingMs } : {}),
      },
    });
  }
  if (lastUsage != null && turns.length > 0) {
    const lastIndex = turns.length - 1;
    const last = turns[lastIndex]!;
    turns[lastIndex] = {
      query: last.query,
      answer: { ...last.answer, lastUsage },
    };
  }
  return turns;
}

/**
 * End index of the turn slice that starts at `messages[i]` (the query): the
 * index of the next real query message (per `isTurnQuery`), or
 * `messages.length` when the turn runs to the end of history. Pulled out to
 * keep `projectMessagesToTurns` ≤10 cyclomatic and the slice-bounds logic in
 * one place.
 */
function findTurnSliceEnd(
  messages: ReadonlyArray<AnthropicNativeMessage>,
  i: number
): number {
  for (let j = i + 1; j < messages.length; j++) {
    if (isTurnQuery(messages[j]!)) {
      return j;
    }
  }
  return messages.length;
}

/**
 * first assistant message within the slice whose text blocks are non-empty
 * — empty assistant replies (e.g. tool-call-only turns) project as "" so
 * the wire keeps the field but the display path can still render the
 * thinking/toolCalls trail.
 */
function findFinalTextInSlice(
  turnMessages: ReadonlyArray<AnthropicNativeMessage>
): string {
  for (const m of turnMessages) {
    if (m.role !== "assistant") continue;
    const t = messageText(m);
    if (t) return t;
  }
  return "";
}

// -- hub options ---------------------------------------------------------------

export type SessionHubOptions = {
  /** Filesystem-backed session store (required). */
  store: SessionStore;
  /** Injected harness deps (tests). When omitted, lazily constructed once. */
  deps?: LoopEngineDeps;
  defaultJsonMode?: boolean;
  /** JSONL trace file path; when set, postMessage creates a per-session
   * JsonlTraceService bound to session.conversation_id (ADR-0003).
   * Per-session instance -> cachedDeps does not cache the trace. */
  traceOut?: string;
  /** askUser inlet. Required when not injecting `deps`; the
   * construction-time check below throws otherwise.
   * Tests injecting `deps` are unaffected. */
  askUser?: AskUser;
  /** Full serve AskUser handle (ask + resolveAsk + pendingAll). When provided,
   * the web SPA can list + resolve pending permission requests. */
  askHandle?: ServeAskUserHandle;
  /** Session allow-list source. "always-allow" decisions from the web UI land
   * here so subsequent identical tool calls are not re-confirmed. Memory-only. */
  sessionGrants?: SessionGrants;
  /** Permission mode context (default / plan / full_auto). Absent →
   *  buildHarnessEngine defaults to "default". */
  permissionMode?: PermissionModeContext;
  /**
   * ADR-0030: session holder for the graph-orchestration overlay (serve /
   * TUI and CLI share one shape). Passed through to buildHarnessEngine —
   * `run_graph` and the orchestration segment gate on the snapshot taken
   * per postMessage. Absent = this entrypoint has no overlay wired.
   */
  graphMode?: GraphModeContext;
  /**
   * ADR-0092: filesystem isolation mode holder (serve / TUI and CLI share
   * the same shape). Passed through to buildHarnessEngine — the bash
   * factory reads it per call (`BuildEngineOpts.fsMode`). Absent = this
   * entrypoint has no fs mode wired (engine follows the global mode).
   */
  fsMode?: FsModeContext;
  /**
   * ADR-0119 / specs/yolo-mode.md: yolo no-sandbox holder (the same instance as
   * the TUI / serve bash face). Passed through to `runVerifyLoop` — the verify
   * command's fence must match the bash tool, otherwise verify still runs inside
   * the fence in a yolo session (spec §6 four-route parity). Absent = this entry
   * did not wire the yolo axis → the verify face treats it as non-yolo
   * (fail-closed keeps the fence).
   */
  yolo?: YoloContext;
  /**
   * Hosts that already built the engine (TUI assembles it in run.tsx) hand
   * `BuiltEngine.graphAssembly` in directly — such hosts use the injected
   * deps path, so the hub itself never builds and cannot get the snapshot
   * handle. Absent = overlay not wired (zero behavior change).
   */
  graphAssembly?: GraphAssembly;
  /**
   * ADR-0047: live-graph ledger host. The hub holds one shared ledger host
   * across conversations, resolved by `ctx.conversationId`. `resetSession`
   * destroys a single session's ledger; `shutdown` destroys all.
   * Default = the `run_graph` handler keeps no ledger (same shape as the
   * graphAssembly default).
   */
  liveGraphLedger?: LiveGraphLedgerHost;
  /** Env source for per-turn thinking override (test seam; production
   * omits it → withThinkingOverride falls back to loadIknowEnv()). */
  overrideEnv?: { readonly llm: LlmEnv };
  /**
   * Sandbox root for fs-tool access. When omitted,
   * `buildHarnessEngine` defaults to `process.cwd()` — see that module's
   * sandboxRoot note (CLI: project root; serve: server-launch dir, which
   * is NOT equivalent to user project root). Production callers should pass
   * an explicit sandboxRoot when the server's cwd is not the intended
   * workspace; CLI flag wiring is tracked in the backlog.
   */
  sandboxRoot?: string;
  /**
   * Entry surface — decides whether BOOTSTRAP is active. The serve path
   * always passes "serve" (skipping BOOTSTRAP); tests may omit → default "chat".
   */
  surface?: "chat" | "tui" | "ask" | "serve";
  /**
   * Subagent manager — host drain consumption surface. The serve entrypoint
   * builds one via buildHarnessEngine (surface !== "ask"); if not injected
   * at hub construction, it is lazily taken from built.subagentManager
   * after ensureDeps(). Unconfigured (ask form) → no drain, zero behavior
   * change.
   */
  readonly subagentManager?: SubAgentManager;
  /**
   * ADR-0031: auto-memory host hook. The serve entrypoint builds one via
   * `buildHarnessEngine` (memory layer present and non-ask); if not
   * injected at construction, it is lazily taken from `built.autoMemory`
   * after `ensureDeps()`. Absent (memory layer off / ask / tests injecting
   * deps) → never called; with both memory switches off the hook is still
   * present and runs only the zero-LLM mechanical segment.
   */
  readonly autoMemory?: AutoMemoryHook;
  /**
   * auto-memory low-trust read: per-turn prefetch overlay. Shares the
   * memory-layer / non-`ask` gate with autoMemory, but the handle also
   * requires `autoExtract` at assembly (TUI may instead hold it with live
   * flags and re-check `memoryFlags.autoExtract` each turn). Host prepends
   * onto the user payload; never deps.system.
   * Hosts pass `excludeIds` (session-level dedup) via the second arg.
   */
  readonly overlayMemoryPrefetch?: OverlayPrefetchFn;
  /**
   * Per-root state anchor. Resolved by the serve entrypoint and passed
   * through — so the hub's buildHarnessEngine uses the entry-resolved
   * workspaceRoot, keeping serve and the CLI flag path in the same shape
   * (per-root state anchor = memory library / skill seam / project
   * `AGENTS.md` discovery). Seed files land in `~/.iknow` regardless of
   * workspaceRoot; session-pool / tasks locations per ADR-0087 / ADR-0088.
   * Absent → build-engine falls back to cwd (legacy default).
   */
  readonly workspaceRoot?: string;
  /**
   * Stable main checkout / bind root. Captured at first assembly and
   * unchanged across rebinds; `buildProductionEngine` passes it to
   * `buildHarnessEngine.productRoot`, from which `mcpConfigRoot` derives.
   * Absent → fall back to `workspaceRoot` / current assembly root.
   */
  readonly productRoot?: string;
  /**
   * ADR-0037: project identity root — pinned once at host startup,
   * unchanged across rebinds. `buildProductionEngine` passes it to
   * `buildHarnessEngine`.
   *
   * Absent fallback chain: `boundRoot` (the path bound via picker /
   * `--workspace-root`) then `mainCheckoutOf(root)`. `bindWorkspace` only
   * checks absolute-and-existing, it does **not** require a repo root, so
   * binding `/repo/packages/app` is perfectly legal; recomputing from `root`
   * after a rebind would jump the identity and memory-library namespace from
   * the subdirectory to the repo root.
   */
  readonly projectIdentityRoot?: string;
  /**
   * Verify-loop config (settings.verify section, passed in via serve.ts
   * construction). Absent = transparently disabled: postMessage takes the
   * original run path byte-for-byte unchanged; when configured, every run
   * is wrapped by runVerifyLoop (verification triggers only on
   * StopReason=completed; trace is injected only when traceOut is
   * configured, otherwise VerificationRecord is not persisted).
   */
  readonly verifyConfig?: VerifyConfig;
  /**
   * settings-hot-reload: env source — optional constructor opt. Once
   * provided, ensureDeps / reloadFromEnv read env through it (replacing the
   * internal loadIknowEnv()). Absent → zero behavior change (still internal
   * loadIknowEnv). Existing overrideEnv / deps injection paths unaffected.
   */
  readonly envProvider?: () => IknowEnv;
  /** settings-hot-reload: env-change callback — optional constructor opt.
   *  The hub calls it once after reloadFromEnv successfully replaces the
   *  adapter (new env as argument). The first ensureDeps is not a "change"
   *  → not triggered. Drives TUI display-layer refresh. */
  readonly onEnvChange?: (env: IknowEnv) => void;
  /**
   * Root the constructor-injected `deps` were built at (TUI). Declared →
   * ensureDeps falls through to per-root engine rebuild when a session's
   * root left this root (worktree rebind). Absent → injected deps
   * short-circuit exactly as before.
   */
  readonly injectedEngineRoot?: string;
  /**
   * Settings object assembled at the startup load point (serve.ts). Reused
   * for EVERY engine this hub builds — rebind-rebuilt worktree-rooted
   * engines included — so project settings never silently reload (they are
   * absent inside the gitignored worktree). Absent → build-engine's own
   * default load (behavior unchanged for tests / non-rebinding hosts).
   */
  readonly settings?: IknowSettings;
  /**
   * serve-workspace test seam: assemble the engine per root so unit tests
   * avoid a real LLM. Production omits it → `buildHarnessEngine` with
   * cwd/workspaceRoot/sandboxRoot all equal. The returned bundle extends
   * `EngineBundle` with `mcpRoots?` / `mcpManager?` / `catalog?` — the
   * hub's per-root MCP face switch needs these three; remaining fields are
   * locked by the `EngineBundle` SSOT.
   */
  readonly buildEngine?: (root: string) => Promise<
    EngineBundle & {
      /** Dual roots surfaced by production assembly; the reload
       *  transaction consumes only the active engine's copy. */
      mcpRoots?: McpRoots;
      /** Per-engine MCP manager; on activation, close the old face
       *  before publishing. */
      mcpManager?: McpManager;
      /** ACI catalog sharing the same source as mcpManager
       *  (listMcpTools visible surface). */
      catalog?: AciCatalog;
      /**
       * Assembly-time skill catalog + rescan seam (hot-on-slash side).
       * Production `buildHarnessEngine`'s `BuiltEngine` carries both; the
       * test seam may omit them (absent → listSkills falls back to the
       * cached catalog / empty list, old behavior byte-for-byte unchanged).
       */
      skillCatalog?: SkillCatalog;
      skillRescanner?: SkillRescanner;
      /**
       * Surfacing seam for the `BuiltEngine.worktreeOnMutate` live holder.
       * Present in production `buildHarnessEngine`; the test injection seam
       * may omit it (absent → verify call sites emit no such key and the
       * fence uses the V1 baseline, byte-for-byte unchanged).
       */
      worktreeOnMutate?: WorktreeGateReader;
    }
  >;
  /**
   * Home root for the recents/trust roster (stored at
   * `<recentsHome>/.iknow/workspaces.json`). Production serve.ts passes
   * `homedir()`; absent → bindWorkspace keeps its original semantics (no
   * trust gate, no recents persistence).
   */
  readonly recentsHome?: string;
  /**
   * ADR-0037 / ADR-0070 — assembly-time resolution of
   * `isolation.worktreeExclusive`. **Resolved exactly once at the startup
   * load point** (single-read-point shape, as in
   * `resolveWorktreeExclusive`): the value is passed to
   * `createTaskWorktreeProvisioner` at hub construction, whose closure
   * freezes it for this engine's lifetime — rebinds never re-read it.
   *
   * OFF (absent / not `true`) → the provisioner skips occupancy checks
   * entirely and `enter` keeps the zero-regression path. Production callers
   * (serve.ts) resolve once from `startupSettings` and pass in.
   */
  readonly worktreeExclusive?: boolean;
  /**
   * Post-tree-build project dependency installation seam. The hub passes it
   * to `createTaskWorktreeProvisioner`, which calls it on both the
   * `provision` (after tree build) and `enter` (idempotent ensure) paths;
   * the result enters the tool receipt as one text line.
   *
   * Omitted in production → provisioner's built-in default (lockfile-driven,
   * fail-open, async); tests inject scripted implementations so no case
   * really shells out to an installer.
   */
  readonly projectDepProvisioner?: ProjectDepProvisioner;
  /**
   * ADR-0113: lite title generator (optional). The host injects it
   * (`buildLiteTitleGenerator`) when `env.llm.liteModel` is present; the
   * hub fires it fire-and-forget on the first `StopReason=completed` after
   * substantial user text; the sanitized result is persisted through the
   * serialize queue's `appendTitle`. Absent → never triggered, hub behavior
   * byte-for-byte unchanged (lite absent = enhancement absent, no
   * fail-fast).
   */
  readonly titleGenerator?: TitleGenerator;
};

/**
 * Per-root BuiltEngine cache entry (Map value + activateMcpFace input).
 * Extends the `EngineBundle` SSOT with `mcpRoots?` / `mcpManager?` / `catalog?`.
 */
type HubEngineEntry = EngineBundle & {
  mcpRoots?: McpRoots;
  mcpManager?: McpManager;
  catalog?: AciCatalog;
  /** Assembly-time skill catalog + rescan seam (see buildEngine). */
  skillCatalog?: SkillCatalog;
  skillRescanner?: SkillRescanner;
  /** worktree-on-mutate live holder (see the buildEngine seam). */
  worktreeOnMutate?: WorktreeGateReader;
};

// -- stop-reason persistence decision (decideCheckpointPersist) --------------
//
// The previous design used a static DROP_REASONS set to skip certain stop
// reasons (cancelled / protocolError / emptyFinalResponse); that became a
// boolean `shouldPersistCheckpoint`, later raised to the tri-state
// `decideCheckpointPersist(result, priorMessages)` in ./store/checkpoint.ts:
//   - `cancelled` WITH delta>0 persists the full result (the user query
//     landed; record a checkpoint so the interrupted turn is recoverable /
//     rewind-able).
//   - `protocolError` / `emptyFinalResponse` persist ONLY the genuine user
//     query from this run's delta (partial_user_only); the failed assistant
//     turn never reaches disk. Zero user delta (e.g. /continue) → no save.
//   - every other stopReason (completed / maxTurns / timeout / nonSuccessStop)
//     persists the full result as-is.

// -- SessionHub ----------------------------------------------------------------

/**
 * Loadable-skills surface (entries without description included, disabled
 * ones too) — the algorithm's SSOT converges in harness `loadableOf`; this
 * wrapper only covers the hub's `catalog === undefined` state (tests
 * injecting deps). **No longer** uses `available()` (a deprecated alias of
 * the model index).
 */
function loadableOf(
  catalog: SkillCatalog | undefined
): ReadonlyArray<SkillEntry> | undefined {
  if (catalog === undefined) return undefined;
  return loadableOfShared(catalog);
}

/**
 * Loadable entries → `SkillSummaryDto`: entries without a description keep
 * it undefined (never coerced to "") — the DTO allows absence so hosts
 * render "no description" rather than an empty one. Shared by the two
 * `listSkills` exits (current rescan surface / cached surface) so the two
 * projection paths cannot drift.
 */
function toSkillSummaries(
  entries: ReadonlyArray<SkillEntry>
): readonly SkillSummaryDto[] {
  return entries.map((entry) => ({
    name: entry.name,
    ...(entry.description !== undefined
      ? { description: entry.description }
      : {}),
  }));
}

/**
 * Projection of the assembly result's skill face (catalog + rescan seam)
 * onto `HubEngineEntry`'s optional fields; absent values emit no key (a
 * test-injected buildEngine usually returns only deps → old behavior
 * byte-for-byte unchanged). Both assembly paths (per-root and fallback
 * lazy) publish from the same source — previously the per-root path
 * dropped the skill face wholesale, so after serve bound a root,
 * `listSkills` was always empty with no rescan seam and stayed
 * user-invisible.
 */
function skillFaceOf(built: {
  readonly skillCatalog?: SkillCatalog;
  readonly skillRescanner?: SkillRescanner;
}): Pick<HubEngineEntry, "skillCatalog" | "skillRescanner"> {
  return {
    ...(built.skillCatalog ? { skillCatalog: built.skillCatalog } : {}),
    ...(built.skillRescanner ? { skillRescanner: built.skillRescanner } : {}),
  };
}

export class SessionHub {
  private readonly store: SessionStore;
  /** ADR-0037: task-worktree build + this-session-only root rebind host seam. */
  private readonly worktreeProvisioner: TaskWorktreeProvisioner;
  /** Roots returned by provision but not yet persisted with the turn. */
  private readonly dirtyWorktreeRoots = new Map<string, string>();
  private cachedDeps: LoopEngineDeps | undefined;
  private readonly defaults: {
    jsonMode: boolean;
  };
  /** JSONL trace output path; when set, postMessage creates a per-session trace. */
  private readonly traceOut: string | undefined;
  /** All JSONL services created by this hub, including the shared subagent trace. */
  private readonly traceServices = new Set<TraceServiceWithHealth>();
  /** askUser inlet; required unless deps are pre-built. */
  private readonly askUser: AskUser | undefined;
  /** Full serve AskUser handle (when provided, SPA can list + resolve asks). */
  private readonly askHandle: ServeAskUserHandle | undefined;
  /** Session allow-list source ("always-allow" from web UI lands here). */
  private readonly sessionGrants: SessionGrants | undefined;
  private readonly permissionMode: PermissionModeContext | undefined;
  /** Env source for the per-turn thinking override (test seam). */
  private readonly overrideEnv: { readonly llm: LlmEnv } | undefined;
  /** Sandbox root for fs-tool access. Undefined
   *  → `buildHarnessEngine` defaults to `process.cwd()`. Production callers
   *  in serve mode should pass an explicit root (CLI flag wiring tracked). */
  private readonly sandboxRoot: string | undefined;
  /** Entry surface; default "chat" (test compat). The serve path
   *  explicitly passes "serve" from serve.ts. */
  private readonly surface: "chat" | "tui" | "ask" | "serve" | undefined;
  /** Subagent manager (host drain consumption surface; lazy acquisition see ensureDeps). */
  private subagentManager: SubAgentManager | undefined;
  /** All per-root managers remain in the host read aggregation surface. */
  private readonly subagentManagers: SubagentManagerRegistry;
  /** Serve-only terminal wake subscription; TUI owns its UI-aware wake. */
  private subagentWake: SubagentWake | undefined;
  /** Coarse serve target: the most recently addressed conversation. */
  private lastConversationId: string | undefined;
  /** Per-root state anchor cache; resolved by the serve entrypoint and passed through. */
  private readonly workspaceRoot: string | undefined;
  /**
   * Stable productRoot (startup bind root). Unchanged across per-root
   * rebuilds; `buildProductionEngine` / reload consume only the
   * mcpConfigRoot derived from it.
   */
  private readonly productRoot: string | undefined;
  private readonly projectIdentityRoot: string | undefined;
  /** Verify-loop config (settings.verify section; absent = transparently disabled). */
  private readonly verifyConfig: VerifyConfig | undefined;
  /** built.shutdown cache (composite handle; lazily taken in ensureDeps, triggered by hub.shutdown). */
  private cachedShutdown: (() => Promise<void>) | undefined;
  /** Same source as TUI TuiExtensions: only present after lazy ensureDeps; stays absent on the deps-injection test path. */
  private skillCatalog: SkillCatalog | undefined;
  /**
   * Assembly-time rescan seam (hot-on-slash side) — the **same** holder as
   * the engine's `deps.skillIndexDelta` (surfaced by build-engine as
   * `BuiltEngine.skillRescanner`). `listSkills` uses it to re-scan the
   * current skill roots, so a SKILL.md saved mid-session enters the
   * loadable surface without waiting for the next turn.
   *
   * Written in two places (same source as `skillCatalog`): the per-root
   * engine path (`getOrBuildEngine`) and the fallback lazy path
   * (`ensureDeps`); absent on ask / test-injected-deps paths → `listSkills`
   * falls back to the cached catalog (old behavior byte-for-byte unchanged).
   */
  private skillRescanner: SkillRescanner | undefined;
  /**
   * worktree-on-mutate live holder — the singleton surfaced by the engine
   * assembly face (`BuiltEngine.worktreeOnMutate`); the bash tool gate and
   * this hub's verify fence read the same instance, so both execution
   * surfaces decide identically on the UNBOUND_FENCE axis.
   * Lazy shape mirrors `skillRescanner` (written in both per-root
   * `getOrBuildEngine` and fallback lazy `ensureDeps`); hosts injecting
   * deps (TUI) skip hub assembly → absent → verify call sites emit no such
   * key (V1 baseline, byte-for-byte unchanged).
   */
  private worktreeOnMutate: WorktreeGateReader | undefined;
  private mcpManager: McpManager | undefined;
  private aciCatalog: AciCatalog | undefined;
  private mcpHome: string | undefined;
  /**
   * Dual roots of the currently externally-visible active engine
   * (per-engine, not an ambiguous single cwd). reload reads only this;
   * activateMcpFace updates it on engine switch.
   */
  private activeMcpRoots: McpRoots | undefined;
  /**
   * MCP reload serialization chain. Concurrent reloadMcp calls coalesce
   * into one queue; every promise has a definite success/failure endpoint
   * (no dangling).
   */
  private mcpReloadChain: Promise<unknown> = Promise.resolve();
  /**
   * settings-hot-reload: env source (default → ensureDeps' internal
   * loadIknowEnv). reloadFromEnv reads the new env through it to rebuild
   * the adapter; onEnvChange fires after a successful replacement.
   */
  private readonly envProvider: (() => IknowEnv) | undefined;
  /** settings-hot-reload: env-change callback (fires once after reloadFromEnv succeeds). */
  private readonly onEnvChange: ((env: IknowEnv) => void) | undefined;
  /**
   * settings-hot-reload: env snapshot used at the last successful adapter
   * rebuild in reloadFromEnv (baseline for key-field value comparison
   * dedup). EnvLoader.get() returns a new object each time, so identity
   * comparison is useless and this snapshot decides "touched but unchanged".
   * Assigned after the first successful rebuild.
   */
  private lastReloadedEnv: IknowEnv | undefined;
  /** Constructor-injected deps (tests). Distinct from lazy/Map cache. */
  private readonly injectedDeps: LoopEngineDeps | undefined;
  /**
   * The root the injected deps were built at. Injected-deps hosts that
   * support isolation (TUI) declare it so ensureDeps can detect a session
   * root that LEFT the injected engine's root (rebind) and fall through to
   * per-root engine rebuild — without it, a rebound session would stay on
   * the stale engine and its mutates would be blocked forever. Absent
   * (tests / ask) → injected branch behaves exactly as before.
   */
  private readonly injectedEngineRoot: string | undefined;
  /**
   * The settings object assembled at the startup load point (hard
   * requirement: single read point). Every engine this hub builds
   * (main-root production path, fallback path, rebind-rebuilt
   * worktree-rooted engines) reuses THIS object via buildHarnessEngine's
   * `settings` opt — `.iknow/` is gitignored so a worktree-rooted
   * `loadIknowSettings({cwd})` would silently drop project settings.
   * Absent → build-engine keeps its own default load (tests / hosts that
   * never rebind are unchanged).
   */
  private readonly startupSettings: IknowSettings | undefined;
  /** serve-workspace test seam; production omits → buildHarnessEngine.
   * The returned bundle shape is locked by the `EngineBundle` SSOT,
   * extended with `mcpRoots?` / `mcpManager?` / `catalog?` (hub per-root
   * MCP face switch). */
  private readonly buildEngine:
    | ((root: string) => Promise<
        EngineBundle & {
          mcpRoots?: McpRoots;
          mcpManager?: McpManager;
          catalog?: AciCatalog;
          /** Assembly-time skill face (catalog + rescan seam) surfaced. */
          skillCatalog?: SkillCatalog;
          skillRescanner?: SkillRescanner;
          /** worktree-on-mutate live holder (see the buildEngine seam). */
          worktreeOnMutate?: WorktreeGateReader;
        }
      >)
    | undefined;
  /** serve picker bind; session file workspaceRoot is the engine Map key. */
  private boundRoot: string | undefined;
  /**
   * Most recently activated engine root. listMcp / reload prefer it when
   * going through ensureDeps, so bindRoot (main checkout) does not snatch
   * back an already-activated worktree face.
   */
  private activeEngineRoot: string | undefined;
  /** ADR-0030: graph-orchestration overlay holder (injected by serve / TUI;
   *  absent = this entrypoint has no overlay → neither run_graph nor the
   *  orchestration segment exist). */
  private readonly graphMode: GraphModeContext | undefined;
  /** ADR-0092: fs isolation mode holder (injected by serve / TUI; absent =
   *  this entrypoint has no fs mode → engine follows the global default). */
  private readonly fsMode: FsModeContext | undefined;
  /** ADR-0119 / specs/yolo-mode.md: yolo no-sandbox holder (TUI injects; absent
   *  = this entrypoint did not wire the yolo axis → the verify face treats it as
   *  non-yolo, fail-closed keeps the fence). */
  private readonly yolo: YoloContext | undefined;
  /** Assembly snapshot handle carried by deps-injecting hosts (TUI),
   *  passed via constructor opts. */
  private readonly injectedGraphAssembly: GraphAssembly | undefined;
  /** Assembly snapshot of the engine returned by the most recent ensureDeps.
   *  postMessage calls beginRound() right after ensureDeps — both in the same
   *  serialized slot, so per-root multi-engine setups never snapshot the
   *  wrong one. Absent = that engine has no overlay wired. */
  private activeGraphAssembly: GraphAssembly | undefined;
  /**
   * ADR-0047: live-graph ledger host — shared across conversations,
   * resolved by `ctx.conversationId`. `resetSession` destroys a single
   * session's ledger; `shutdown` destroys all. Absent → the `run_graph`
   * handler keeps no ledger (same shape as the graphAssembly absence).
   */
  private readonly liveGraphLedger: LiveGraphLedgerHost | undefined;
  /** serve-workspace: recents/trust roster home (absent → roster-less behavior). */
  private readonly recentsHome: string | undefined;
  /** Per-root BuiltEngine cache (same root shared across sessions). */
  private readonly engineByRoot = new Map<string, HubEngineEntry>();
  /** Per-conversation serialization. */
  private readonly inflight = new Map<string, Promise<void>>();
  /** Actual active work count; `inflight` retains resolved chain sentinels. */
  private readonly activeTurnCounts = new Map<string, number>();
  /**
   * auto-memory: session-level prefetch dedup — per-conversation sets of
   * already-injected memory ids. Host-side state only (never loop-engine).
   * Lazily recovered from the loaded history on first attach (empty set is
   * cached too), then grown by the ids each turn actually injects.
   */
  private readonly prefetchInjectedIds = new Map<string, Set<string>>();
  /** auto-memory: host hook (default absent = auto-memory off). */
  private autoMemory: AutoMemoryHook | undefined;
  /** ADR-0113: lite title generator (absent = this entrypoint has no lite wired; never triggered). */
  private readonly titleGenerator: TitleGenerator | undefined;
  /**
   * ADR-0113: conversations that already triggered title generation in this
   * process — the first completed turn burns lite only once; the
   * cross-process shape is covered by the store.hasTitleEvent disk gate.
   */
  private readonly titleFiredConversations = new Set<string>();
  /** auto-memory low-trust read: per-turn user overlay (same gate as autoMemory). */
  private overlayMemoryPrefetch: OverlayPrefetchFn | undefined;

  constructor(opts: SessionHubOptions) {
    if (!opts.askUser && !opts.deps) {
      throw new Error(
        "ask_inlet_missing: SessionHub requires AskUser or pre-built deps (#162 / SC18)"
      );
    }
    this.store = opts.store;
    this.injectedDeps = opts.deps;
    this.cachedDeps = opts.deps;
    this.injectedEngineRoot = opts.injectedEngineRoot;
    this.startupSettings = opts.settings;
    this.buildEngine = opts.buildEngine;
    this.traceOut = opts.traceOut;
    this.askUser = opts.askUser;
    this.askHandle = opts.askHandle;
    this.sessionGrants = opts.sessionGrants;
    this.permissionMode = opts.permissionMode;
    this.graphMode = opts.graphMode;
    this.fsMode = opts.fsMode;
    this.yolo = opts.yolo;
    this.injectedGraphAssembly = opts.graphAssembly;
    this.liveGraphLedger = opts.liveGraphLedger;
    this.overrideEnv = opts.overrideEnv;
    this.sandboxRoot = opts.sandboxRoot;
    this.surface = opts.surface;
    this.subagentManagers = createSubagentManagerRegistry();
    this.subagentManager = opts.subagentManager;
    this.subagentManagers.register(this.subagentManager);
    if (this.surface === "serve") {
      this.attachSubagentWake(this.subagentManagers);
    }
    this.autoMemory = opts.autoMemory;
    this.overlayMemoryPrefetch = opts.overlayMemoryPrefetch;
    this.titleGenerator = opts.titleGenerator;
    // Per-root state anchor cache.
    this.workspaceRoot = opts.workspaceRoot;
    // Stable productRoot (absent → workspaceRoot, keeping the single-root shape compilable and runnable).
    this.productRoot = opts.productRoot ?? opts.workspaceRoot;
    this.projectIdentityRoot = opts.projectIdentityRoot;
    // An entry-resolved root is already a valid bind for hosts that assemble
    // the Hub with a root (serve/TUI). Picker-driven hosts can still call
    // bindWorkspace later to change it.
    this.boundRoot = opts.workspaceRoot;
    this.recentsHome = opts.recentsHome;
    this.verifyConfig = opts.verifyConfig;
    this.envProvider = opts.envProvider;
    this.onEnvChange = opts.onEnvChange;
    this.defaults = {
      jsonMode: opts.defaultJsonMode ?? false,
    };
    // ADR-0037: worktree isolation host seam — tree build + this-session-only
    // root rebind. The switch itself is read by build-engine at the startup
    // load point; the hub only injects the provision seam on the
    // buildProductionEngine / ensureDeps fallback paths. A session already on
    // its own task worktree passes through; a foreign root fails closed — all
    // anchored per-session by provision, so the hub passes no
    // conversation-agnostic flag.
    // Root persistence belongs to this Hub's dirty-root conditional-save
    // protocol. The provisioner only creates/returns the task worktree here.
    //
    // ADR-0070: pass the assembly-time-frozen `worktreeExclusive` value into
    // the provisioner closure — its `enter()` uses it to take either the ON
    // occupancy check (typed worktree_claimed) or the OFF zero-regression
    // path. The pass-through is single-point: buildHarnessEngine resolves the
    // value in build-engine and surfaces it on BuiltEngine.worktreeExclusive;
    // this hub's opts takes that boolean and feeds it straight to the
    // provisioner. listSessions binds directly to the hub's store
    // (SessionStore already exposes list()). Adds **no** new disk-write path
    // — listing stays read-only.
    this.worktreeProvisioner = createTaskWorktreeProvisioner({
      ...(this.projectIdentityRoot !== undefined
        ? { projectIdentityRoot: this.projectIdentityRoot }
        : {}),
      ...(opts.projectDepProvisioner !== undefined
        ? { projectDepProvisioner: opts.projectDepProvisioner }
        : {}),
      ...(opts.worktreeExclusive === true
        ? {
            worktreeExclusive: true,
            listSessions: () => this.store.list(),
          }
        : {}),
    });
  }

  // -- public API --------------------------------------------------------------

  /**
   * Hub-visible provision seam for harness hosts (including TUI). A
   * successful changed result is recorded for this conversation and is
   * persisted only by the next conditional save.
   *
   * Adoption anchor: the conversation's PERSISTED workspaceRoot is loaded
   * here and handed to the provisioner — a session durably anchored at the
   * engine's (task-worktree-shaped) root has explicitly entered it, so
   * provision adopts it even on another conversation's tree. An unknown
   * session contributes no anchor (fail-closed contract unchanged).
   */
  async provisionWorktree(ctx: WorktreeProvisionContext): Promise<string> {
    const anchorSessionRoot = await this.loadSessionWorkspaceRoot(
      ctx.conversationId
    );
    const provisionedRoot = await this.worktreeProvisioner.provision(
      ctx,
      anchorSessionRoot === undefined
        ? undefined
        : { sessionWorkspaceRoot: anchorSessionRoot }
    );
    if (ctx.conversationId !== undefined) {
      this.markWorktreeRootDirty({
        conversationId: ctx.conversationId,
        currentRoot: ctx.root,
        provisionedRoot,
      });
    }
    return provisionedRoot;
  }

  /** Best-effort persisted workspaceRoot read for the adoption anchor. */
  private async loadSessionWorkspaceRoot(
    conversationId: string | undefined
  ): Promise<string | undefined> {
    if (conversationId === undefined || conversationId.length === 0) {
      return undefined;
    }
    try {
      const file = await this.store.load(conversationId);
      return file.workspaceRoot;
    } catch {
      return undefined; // unknown session → no anchor, fail-closed downstream
    }
  }

  /**
   * Hub-visible enter seam (serve/chat harness hosts; TUI wires
   * provision-only): move this conversation onto an EXISTING task worktree
   * of this repository (owner = targetConversationId). The provisioner
   * validates the tree (exists /
   * linked / same repo) and rebinds in memory; the changed root is recorded
   * for this conversation and persisted only by the next conditional save —
   * the same dirty-root protocol the create path uses. The tree itself is
   * never created, moved, or checked out.
   */
  async enterWorktree(ctx: {
    conversationId?: string;
    root: string;
    targetConversationId: string;
  }): Promise<{ path: string; receipt: string }> {
    const entered = await this.worktreeProvisioner.enter(ctx);
    if (ctx.conversationId !== undefined) {
      this.markWorktreeRootDirty({
        conversationId: ctx.conversationId,
        currentRoot: ctx.root,
        provisionedRoot: entered.path,
      });
    }
    return entered;
  }

  /**
   * Hub-visible exit seam (serve/chat harness hosts; TUI wires
   * provision-only): move this conversation back to its main repo root from
   * the task worktree it is currently on. The provisioner derives the main
   * root from the tree
   * (restart-safe) and rebinds in memory; the changed root is recorded for
   * this conversation and persisted only by the next conditional save. The
   * task worktree is preserved — no `git worktree remove` anywhere.
   */
  async exitWorktree(ctx: {
    conversationId?: string;
    root: string;
  }): Promise<string> {
    const anchorSessionRoot = await this.loadSessionWorkspaceRoot(
      ctx.conversationId
    );
    const repoRoot = await this.worktreeProvisioner.exit({
      conversationId: ctx.conversationId,
      root: ctx.root,
      ...(anchorSessionRoot !== undefined
        ? { sessionWorkspaceRoot: anchorSessionRoot }
        : {}),
    });
    if (ctx.conversationId !== undefined) {
      this.markWorktreeRootDirty({
        conversationId: ctx.conversationId,
        currentRoot: ctx.root,
        provisionedRoot: repoRoot,
      });
    }
    return repoRoot;
  }

  /** Hub-visible read seam for listing this repository's task worktrees. */
  async listTaskWorktrees(ctx: {
    root: string;
    includeStale?: boolean;
  }): Promise<ReadonlyArray<TaskWorktreeInfo>> {
    return this.worktreeProvisioner.list(ctx);
  }

  /** Hub-visible write seam for explicit task-worktree removal. */
  async removeTaskWorktree(
    ctx: WorktreeRemoveContext
  ): Promise<WorktreeRemoval> {
    return this.worktreeProvisioner.remove(ctx);
  }

  private markWorktreeRootDirty(opts: {
    readonly conversationId: string;
    readonly currentRoot: string;
    readonly provisionedRoot: string;
  }): void {
    if (opts.provisionedRoot === opts.currentRoot) return;
    // Keep the first successful changed root until its save succeeds. This
    // prevents a concurrent provision result from replacing a retryable root.
    if (!this.dirtyWorktreeRoots.has(opts.conversationId)) {
      this.dirtyWorktreeRoots.set(opts.conversationId, opts.provisionedRoot);
    }
  }

  /**
   * Snapshot of pending ask requests (process-global; v0 serve hosts one
   * turn at a time). Returns an empty list when the full handle was not
   * wired (no SPA capability).
   */
  listPendingAsks(): ReadonlyArray<PendingAskView> {
    return this.askHandle?.pendingAll() ?? [];
  }

  /**
   * Data source for Session API GET /sessions/:id/subagents. store.load
   * gates on session existence — unknown session → typed not_found (the
   * http layer maps it to 404; never thrown raw here). Missing manager
   * (ask shape) → empty list. Read-only projection, no write path.
   */
  async listSubagentsForSession(
    conversationId: string
  ): Promise<ReadonlyArray<SubagentInfo>> {
    await this.store.load(conversationId);
    return this.subagentManagers.listSubagents(conversationId);
  }

  /** T1: TUI/host read-only terminal subscription scoped to one session. */
  subscribeSubagentTerminal(
    subscriber: SubAgentTerminalSubscriber,
    conversationId?: string
  ): () => void {
    return this.subagentManagers.subscribe(subscriber, conversationId);
  }

  /** T1: TUI/host read-only projection; omit scope only for a global view. */
  listSubagents(conversationId?: string): ReadonlyArray<SubagentInfo> {
    return this.subagentManagers.listSubagents(conversationId);
  }

  /**
   * Host-initiated hard kill of one worker (TUI Ctrl+X on a
   * chrome-focused subagent row). Settles that task's in-flight `waitFor`
   * with `SubAgentAbortError` first (the parent turn reads `cancelled`), then
   * signals the worker. Returns true only when the task was still live;
   * unknown / already-terminal ids and a missing manager (ask surface) are a
   * no-op → false, never a fabricated kill.
   *
   * Scope contract: the taskId is the identity. The registry fans out over
   * per-root managers and a taskId belongs to exactly one of them, so no
   * conversationId is needed.
   */
  abortSubagentTask(taskId: string): boolean {
    return this.subagentManagers.abortTask(taskId);
  }

  /**
   * Ctrl+C fan-out for this session's foreground subagents. The parent turn
   * is stopped by the app-layer aborter; this method stops every
   * foreground child of this session. Criterion: `SubagentInfo.foreground ===
   * true` (same population as parent-side in-band wait / judge / graph-node)
   * and live (starting|running).
   *
   * Why the manager's fresh projection instead of TUI React state: the app's
   * subagent list comes from 1 Hz polling and can be up to 1 s stale, so a
   * just-spawned child would be missed. Here we re-list at keypress time and
   * enumerate + abort in one pass, closing that window.
   *
   * Scope: filtered by conversationId, so `wait:false` background children
   * and other sessions' running-bg tasks are naturally excluded.
   *
   * Returns the taskIds actually aborted (races where abortTask returns false
   * are excluded) for attribution; no manager (ask shape) → empty array,
   * never throws.
   *
   * Known gap (separate slice, not fixed here): judge
   * (`verify/run-classifier-adapter.ts`) and graph-node
   * (`graph/node-executor.ts`) set `excludeFromHostDrain: true` but never set
   * `conversationId`, so they belong to the foreground population yet appear
   * on no session ledger and this scan cannot stop them. The ownership data
   * does not exist today; the fix is to give those defs a conversationId (or
   * add a session-independent foreground stop), out of scope here.
   */
  abortSessionForegroundWork(conversationId: string): ReadonlyArray<string> {
    const aborted: string[] = [];
    for (const info of this.subagentManagers.listSubagents(conversationId)) {
      if (info.foreground !== true) continue;
      if (info.state !== "starting" && info.state !== "running") continue;
      if (this.subagentManagers.abortTask(info.taskId)) {
        aborted.push(info.taskId);
      }
    }
    return aborted;
  }

  /**
   * Cleanup handle for the serve entrypoint — forwards the built.shutdown
   * cached by ensureDeps (composite handle: mcpManager first, then
   * subagentManager). cli.ts runServe registers it on SIGINT/SIGTERM so the
   * process closes MCP background connections and SIGTERMs subagent stdio
   * children before exit. ask/deps-injected shapes have no built → no-op.
   */
  async shutdown(): Promise<void> {
    this.subagentWake?.dispose();
    // Session end (hub release) destroys all live-graph ledgers so none
    // leak into later sessions.
    this.liveGraphLedger?.destroyAll();
    await this.cachedShutdown?.();
    for (const entry of this.engineByRoot.values()) {
      await entry.shutdown?.();
    }
  }

  /** Sum the live JSONL trace service write-failure counters for health. */
  getTraceWriteFailures(): number {
    let total = 0;
    for (const trace of this.traceServices) {
      total += trace.traceWriteFailures;
    }
    return total;
  }

  /**
   * Env used when rebuilding the adapter for a per-turn thinking override —
   * latest value wins.
   *
   * `overrideEnv` is a startup snapshot captured at bridge construction and
   * never refreshed; `/model` switching only shows up via `envProvider`
   * (EnvLoader.get). Using the snapshot in the override branch would silently
   * revert baseUrl/apiKey/model (and headers) on thinking turns. When
   * envProvider is absent (test seams passing only overrideEnv), keep the
   * snapshot semantics.
   *
   * Called only from the override branch: turns without thinking never read
   * env an extra time because of this method.
   */
  private overrideEnvForTurn(): { readonly llm: LlmEnv } | undefined {
    return this.envProvider ? this.envProvider() : this.overrideEnv;
  }

  /**
   * Hot rebuild from env: recreate the adapter via createAdapterFromEnv with
   * the latest envProvider() value and replace `cachedDeps.adapter`. Does NOT
   * rerun the whole buildHarnessEngine assembly (MCP / subagent / skill are
   * skipped). registry / executor / maxTurns / timeoutMs reuse the old
   * cachedDeps.
   *
   * Semantics:
   *   - If the key env fields (model / apiKey / fallback / thinking /
   *     thinkingEffort) are value-identical to the last rebuild, treat it as
   *     "touched unchanged content": skip adapter rebuild and do not fire
   *     onEnvChange. EnvLoader.get() returns a new object each call, so
   *     identity comparison is useless — compare field values.
   *   - On change → replace adapter and fire onEnvChange (if registered)
   *     once with the new env.
   *   - envProvider not injected / cachedDeps not yet built → no-op.
   *   - Missing apiKey (settings `${VAR}` unresolved → apiKey=undefined) →
   *     throw ValidationError (aligned with the buildHarnessEngine guard);
   *     cachedDeps keeps the old adapter rather than degrading at the SDK
   *     layer.
   *   - envProvider() throws (bad JSON / missing model) → throw and leave
   *     cachedDeps untouched; the caller owns the degraded notification.
   */
  async reloadFromEnv(): Promise<void> {
    if (!this.envProvider) return;
    if (!this.cachedDeps && this.engineByRoot.size === 0) return;
    const env = this.envProvider();
    if (!env.llm.apiKey) {
      throw new ValidationError(LLM_API_KEY_MISSING_MESSAGE);
    }
    // Dedupe by key field values (model / apiKey / fallback / thinking /
    // thinkingEffort): any change → rebuild + notify; all equal → skip.
    const prev = this.lastReloadedEnv;
    if (prev && sameHotReloadKeyFields(prev.llm, env.llm)) return;
    const { adapter } = createAdapterFromEnv(env);
    if (this.cachedDeps) {
      this.cachedDeps = { ...this.cachedDeps, adapter };
    }
    for (const [root, entry] of this.engineByRoot) {
      this.engineByRoot.set(root, {
        ...entry,
        deps: { ...entry.deps, adapter },
      });
    }
    this.lastReloadedEnv = env;
    this.onEnvChange?.(env);
  }

  /**
   * Resolve a pending ask with one of three decisions.
   *
   *   - `allow-once`    → release the waiter as approved, no persist.
   *   - `deny`          → release the waiter as denied (matches fail-closed).
   *   - `always-allow`  → release the waiter as approved, AND add a
   *                        per-tool allow rule to the session grants so the
   *                        next identical tool call is auto-approved.
   *
   * Ordering: for `always-allow` the rule is added AFTER settle() succeeds;
   * if the ask already timed out, settle returns false and no rule is added
   * (defensive contract — no orphan rules from a UI click that lost the race).
   *
   * Returns true iff the ask was still pending at resolve time.
   */
  resolveAsk(
    id: string,
    decision: "allow-once" | "always-allow" | "deny"
  ): boolean {
    if (!this.askHandle) return false;
    // Capture the tool name BEFORE settle: settle() empties the pending Map,
    // so pendingAll() after it would find nothing.
    const tool =
      decision === "always-allow"
        ? this.askHandle.pendingAll().find((p) => p.id === id)?.tool
        : undefined;
    if (decision === "deny") return this.askHandle.resolveAsk(id, false);
    const approved = this.askHandle.resolveAsk(id, true);
    if (decision === "always-allow" && approved && tool && this.sessionGrants) {
      this.sessionGrants.add({
        id: `session-allow-${tool}`,
        match: ({ tool: t }) => t === tool,
        decision: "allow",
        reason: `always-allow from session: ${tool}`,
      });
    }
    return approved;
  }

  /**
   * Bind the serve picker root (ADR-0023). createSession writes this root
   * onto the session file so postMessage can key the engine Map.
   *
   * T3 trust gate: when `recentsHome` is wired, a root NOT in the recents/
   * trust roster requires `{ confirmTrust: true }` (a new absolute path must
   * be explicitly trusted; roots already in recents are trusted). On trust,
   * the root is upserted into `<recentsHome>/.iknow/workspaces.json` (home).
   * When `recentsHome` is absent (tests / legacy) the previous behavior is
   * preserved.
   *
   * Errors:
   *   - `WorkspaceRootError` (resolver: empty_explicit / non_absolute /
   *     not_found; overflow pre-check) — plain object, kind-only.
   *   - `ValidationError` field=path when confirmTrust is required and
   *     missing.
   *   - `WorkspacesRecentsError` from the recents IO layer (parse_failed /
   *     io_error / concurrent_write).
   */
  async bindWorkspace(
    absPath: string,
    opts?: { readonly confirmTrust?: boolean }
  ): Promise<string> {
    if (typeof absPath !== "string" || absPath.length === 0) {
      throw {
        kind: "empty_explicit",
        path: typeof absPath === "string" ? absPath : "",
      } satisfies WorkspaceRootError;
    }
    if (absPath.length > MAX_WORKSPACE_ROOT_CHARS) {
      throw {
        kind: "overflow",
        path: absPath,
      } satisfies WorkspaceRootError;
    }
    const resolved = resolveWorkspaceRoot({ explicit: absPath });
    if (this.recentsHome === undefined) {
      this.boundRoot = resolved;
      return resolved;
    }
    const recents = await loadWorkspacesRecents({ home: this.recentsHome });
    const trusted = recents.recents.some((r) => r.root === resolved);
    if (!trusted && opts?.confirmTrust !== true) {
      throw new ValidationError(
        "workspace root is not trusted; confirm trust to bind",
        { field: "path" }
      );
    }
    await upsertWorkspaceRecent({
      home: this.recentsHome,
      root: resolved,
      lastUsedAt: new Date().toISOString(),
    });
    this.boundRoot = resolved;
    return resolved;
  }

  /**
   * serve-workspace T3: picker state snapshot for GET /api/v1/workspace.
   * Synchronous — reads only the in-memory `boundRoot`.
   */
  getWorkspaceState(): WorkspaceResponse {
    if (this.boundRoot === undefined) return { bound: false };
    return { bound: true, root: this.boundRoot };
  }

  /**
   * serve-workspace T3: trusted roots (recents) for GET /api/v1/workspaces.
   * recentsHome absent (serve not wired with home recents) → NotFoundError so
   * http.ts maps it to 404 not_found — the "serve not assembled" semantics.
   */
  async listTrustedWorkspaces(): Promise<readonly string[]> {
    if (this.recentsHome === undefined) {
      throw new NotFoundError("workspaces recents not wired");
    }
    const file = await loadWorkspacesRecents({ home: this.recentsHome });
    return file.recents.map((r) => r.root);
  }

  async createSession(
    req?: CreateSessionRequest
  ): Promise<CreateSessionResponse> {
    const root = requireCreateWorkspaceRoot(this.boundRoot);
    const id = randomUUID();
    const now = new Date().toISOString();
    const file: SessionFileV1 = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      conversation_id: id,
      messages: [],
      jsonMode: req?.json_mode ?? this.defaults.jsonMode,
      turnCount: 0,
      updatedAt: now,
      title: "",
      cwd: root,
      sanitized_at: now,
      checkpoints: [],
      workspaceRoot: root,
    };
    await this.store.save({ id, file });
    return {
      session: this.summarize({ file }),
      turns: [],
    };
  }

  async getSession(conversationId: string): Promise<GetSessionResponse> {
    const file = await this.store.load(conversationId);
    return {
      session: this.summarize({ file }),
      // D2 (tui-display-consistency): pass file.thinkingMs parallel array so
      // projectMessagesToTurns can sum per-turn assistant thinkingMs.
      // #1079: pass file.lastUsage so the replay's last turn carries the
      // persisted usage reading (web UsageChip reopens non-0%).
      turns: projectMessagesToTurns(
        file.messages,
        file.thinkingMs,
        file.lastUsage
      ),
    };
  }

  async postMessage(opts: {
    readonly conversationId: string;
    readonly text: string;
    readonly signal?: AbortSignal;
    readonly thinking?: ThinkingOverride;
    readonly onStream?: (event: HarnessStreamEvent) => void;
    /** T4 internal host wake; not accepted by the HTTP adapter. */
    readonly silent?: boolean;
  }): Promise<PostMessageResponse> {
    const { conversationId, text } = opts;
    const silent = opts.silent === true;
    // #408 T3: leading `## GOAL:` re-pins the session goal. Detect BEFORE
    // validateText so the goal text (not the raw directive) is what gets
    // validated and run. `null` = no directive → whole text is the query.
    // `""` = empty directive → stripped to empty → validateText rejects
    // below (goal unchanged, since we only persist after run succeeds).
    const goalDirective = silent ? null : parseGoalCommand(text);
    // #458 T5: validate goal text length/non-empty BEFORE serialize so an
    // over-long `## GOAL: ...` never reaches the pin path / store. Empty
    // directive is skipped (goalDirective === "") and falls through to
    // validateText("") which rejects with "message text must be non-empty"
    // — preserves the existing empty-`## GOAL:` acceptance (#408 T3).
    let pinText: string | undefined;
    let pinMaxTurns: number | undefined;
    if (goalDirective !== null && goalDirective.length > 0) {
      const parsed = parseGoalPinInput(goalDirective);
      if (!parsed.ok) {
        throw new ValidationError(parsed.error, { field: "goal_text" });
      }
      pinText = parsed.text;
      pinMaxTurns = parsed.maxTurns;
      const msg = validateGoalText(parsed.text);
      if (msg !== null) {
        throw new ValidationError(`${parsed.text} rejected: ${msg}`, {
          field: "goal_text",
        });
      }
    }
    const query =
      pinText ?? (goalDirective !== null ? goalDirective : text.trim());
    if (!silent) this.validateText(query);
    this.lastConversationId = conversationId;
    const activeCount = this.activeTurnCounts.get(conversationId) ?? 0;
    this.activeTurnCounts.set(conversationId, activeCount + 1);
    const operation = this.serialize<PostMessageResponse>({
      conversationId,
      work: async () => {
        let session = await this.store.load(conversationId);
        // EXIT: reject-execute-before-engine — legacy/unbound sessions are
        // inspectable but must never reach trace, postMessage, or the engine.
        const boundRoot = requireBoundRoot(session.workspaceRoot);
        // #458 T5/T12: hoist the trace service so the `## GOAL:` pin block
        // (below) and runDeps share one TraceService instance for this
        // postMessage (avoid double construction; same file writer closure).
        const trace = this.createTrace(conversationId);
        // #408 T3: re-pin the session-level goal when the incoming text is a
        // `## GOAL: ...` directive. Persisted immediately so subsequent
        // verify-loop rounds in this turn see the new goal.text. The query
        // the model sees is the directive's text body (not the marker).
        // After pinning, `session` is reloaded so conditionalSave sees the
        // pinned goal and does NOT re-seed (else the T2 seed would overwrite
        // the T3 pin).
        if (pinText !== undefined) {
          const now = new Date().toISOString();
          const pinned: SessionFileV1 = {
            ...session,
            goal: pinGoal({
              current: session.goal,
              text: pinText,
              now,
              ...(pinMaxTurns !== undefined ? { maxTurns: pinMaxTurns } : {}),
            }),
            updatedAt: now,
            schemaVersion: CURRENT_SCHEMA_VERSION,
          };
          await this.store.save({ id: conversationId, file: pinned });
          session = await this.store.load(conversationId);
          // Goal pin emission point — text truncated to 200 chars to keep
          // jsonl lines bounded; the hub solely owns state-machine
          // transitions, the trace only records lifecycle events.
          await trace?.recordGoal({
            id: randomUUID(),
            sessionId: conversationId,
            action: "pin",
            text: pinText.slice(0, 200),
            ts: now,
            conversationId,
          });
        }
        const baseDeps = await this.ensureDeps(boundRoot);
        // Round boundary (ADR-0030): one postMessage = one run(). Take the
        // graph assembly snapshot right after ensureDeps, inside the same
        // serialized slot, so it is always the engine this turn will use;
        // overlay key flips therefore "take effect on the next message",
        // matching chat's "next query line" semantics.
        this.activeGraphAssembly?.beginRound();
        // T2: per-turn override — rebuild deps with a one-shot adapter only;
        // executor / registry / maxTurns / timeoutMs are reused from the
        // cached deps. When absent, the cached path is unchanged.
        // The override branch reads the latest env via overrideEnvForTurn
        // (switched provider/model takes effect next turn; the construction
        // snapshot is only a fallback when envProvider is absent).
        const deps =
          opts.thinking !== undefined
            ? withThinkingOverride({
                deps: baseDeps,
                override: opts.thinking,
                env: this.overrideEnvForTurn(),
              })
            : baseDeps;
        // Lazy commit of the user query: the engine itself never commits the
        // query (only assistant / tool_result), so if the chain lacks the
        // query, the projection and the chain always differ by one entry and
        // every post-turn save is forced through a re-root fork (even a new
        // chain after rewind cannot parent onto the rewind anchor). Instead,
        // prefix the query into this postMessage's first engine commit:
        // chain and projection align (save takes identical / extension).
        // Zero-progress turns (protocolError / emptyFinalResponse stopping
        // before the first commit) never fire this commit hook, but the
        // closing conditionalSave persists the turn's user query as
        // partial_user_only (dropping the failed assistant).
        // queryMessage must match the engine's construction byte-for-byte
        // (secret placeholder substitution + adapter.encodeUserText, same
        // logic as loop-engine.ts run()), otherwise the save's LCP alignment
        // forks at the query.
        let queryCommitPending = true;
        let queryCommitPrefix: ReadonlyArray<AnthropicNativeMessage> = [];
        const buildUserCommit = (userText: string): AnthropicNativeMessage => {
          let effective = userText;
          if (
            deps.secretsMode !== "block" &&
            deps.secretRegistry !== undefined
          ) {
            effective = recognize(userText, deps.secretRegistry).replaced;
          }
          return deps.adapter.encodeUserText(effective);
        };
        // T6: wrap the executor with the violation kill-session hook. Serve/TUI
        // is long-running, so on kill we write the violation event to the JSONL
        // trace and do NOT touch process.exitCode. hard_wall already failed the
        // tool; remapping stopReason to protocolError would drop the assistant
        // delta on persist and undo ADR-0108 interrupt keep.
        let killed = false;
        const counter = createViolationCounter();
        const onKill = (reason: string): void => {
          // Latch: the counter fires on every record past threshold; the trace
          // line is one-shot (mirrors wireKillSessionNotification's latch).
          if (killed) return;
          killed = true;
          this.recordViolationTrace(conversationId, reason);
        };
        const wrappedExecutor = wrapWithViolationHook({
          inner: deps.executor,
          counter,
          onKill,
        });
        // Per-session trace: new JsonlTraceService each postMessage (not cached
        // in cachedDeps) because conversationId differs per session (ADR-0003).
        // traceOut is a directory; JsonlTraceService writes
        // <traceOut>/<conversationId>.jsonl. The serve path injects
        // agentVersion: runDeps only lands the session root record when
        // traceOut is configured (same condition as existing trace
        // injection); agentVersion is injected unconditionally, and
        // loop-engine requires both trace and agentVersion to write it, so
        // an unset traceOut has no side effect.
        const runDeps: LoopEngineDeps = {
          ...deps,
          executor: wrappedExecutor,
          agentVersion: getVersion(),
          // Per-postMessage conversationId injection (ADR-0021): serve
          // cachedDeps is shared across sessions, so this per-run session
          // anchor lets bash_output / bash_stop scope filtering close the
          // loop per session.
          conversationId,
          // In-turn commit hook: as soon as an assistant or each tool_result
          // enters the authoritative history, append it to the session JSONL
          // log (write while running, resumable after crash).
          // Queue discipline: this closure is invoked synchronously by run()
          // inside the postMessage serialize slot — already in the per-session
          // serial queue — so it must never wrap itself in this.serialize
          // (the inner slot would wait for the outer one, which is waiting on
          // run() returning → self-deadlock). Neither bypass nor re-enter.
          commitMessages: (messages, thinkingMs) => {
            // The first commit carries the query prefix (including the
            // subagent digest messages from host drain, if this turn has
            // them); later commits pass through unchanged.
            const events = queryCommitPending
              ? [...queryCommitPrefix, ...messages]
              : messages;
            queryCommitPending = false;
            return this.appendSessionEvents({
              conversationId,
              session,
              events,
              ...(thinkingMs !== undefined ? { thinkingMs } : {}),
            });
          },
          ...(trace !== undefined ? { trace } : {}),
          // Compact-boundary rendering seam: inject a boundaryAttachment
          // closure that renders the session's most recent qualifying user
          // task quotes verbatim (a pure function over session.messages,
          // sampled at use time); on compact it appends one user message
          // after the placeholder. Constraints:
          //   - auto mode (goal.text non-empty) → return undefined, never
          //     attach (auto mode attaches no task excerpt);
          //   - zero qualifying sentences → renderRecentUserTasksBoundary
          //     returns undefined, the closure yields undefined, the helper
          //     early-exits (byte-stable behavior, stop semantics unaffected
          //     per ADR-0011);
          //   - does not read session.taskFocus (retired; the render source
          //     is qualifying user task quotes inside session.messages);
          //   - renderRecentUserTasksBoundary is a private hub closure —
          //     harness-domain independence: harness never imports
          //     session-api, zero reverse dependency.
          ...(!(session.goal !== undefined && session.goal.text.length > 0)
            ? {
                boundaryAttachment: () =>
                  this.renderRecentUserTasksBoundary(session.messages),
              }
            : {}),
        };
        // Before an abnormal stop, loop-engine emits stop_summary via
        // onStream (ADR-0011). Wrap it to capture the stop_summary text
        // unconditionally — even when the host passes no onStream, the DTO
        // must carry stopSummary; byte-stable: present goes in, absent stays
        // out — and forward it verbatim to the host onStream (the TUI uses
        // it for notice rendering, see app.tsx).
        let capturedStopSummary: string | undefined;
        const wrappedOnStream = (event: HarnessStreamEvent): void => {
          if (event.type === "stop_summary") {
            capturedStopSummary = event.text;
          }
          opts.onStream?.(event);
        };
        // auto-memory T1: session-level prefetch dedup. Lazily recover the
        // ids already injected into this conversation (first attach scans the
        // loaded history), exclude them from the overlay, then record the ids
        // this turn actually injects (overlay-bearing results only).
        const prefetchExcludeIds = this.prefetchInjectedIdsFor(
          conversationId,
          session.messages
        );
        const attachPrefetch = (text: string): Promise<string> =>
          applyHostPrefetch(
            text,
            this.overlayForSession(session.workspaceRoot),
            { excludeIds: prefetchExcludeIds }
          ).then((effective) => {
            this.recordPrefetchOverlayIds(conversationId, effective);
            return effective;
          });
        // F4: shared /goal auto-loop skeleton. Hub passes
        // `reloadSession = () => store.load(id)` (refresh session between
        // iterations); chat passes a no-op. Errors stay in host: hub rethrows
        // after MaxTurns handling, chat converts to error result.
        try {
          return await runAutoLoopSteps({
            run: async () => {
              // Host drain: before each run() at the serve entrypoint, digest
              // completed subagent results from the manager into a user
              // message and append it to priorMessages. Empty manager /
              // nothing completed → priorMessages unchanged (zero behavior
              // change).
              const drained = await drainPendingSubagents(
                this.subagentManagers,
                {
                  conversationId,
                }
              );
              // ADR-0112: the drained digest is a host-injected commit — stamp
              // its provenance so the outbound projection passes the "##
              // Sub-agent " prefix anchor through as an official frame.
              const drainedMsg: AnthropicNativeMessage = stampHostInjected({
                role: "user",
                content: [{ type: "text", text: drained }],
              });
              const priorMessages = drained
                ? [...session.messages, drainedMsg]
                : session.messages;
              // Keep the query commit prefix aligned with the user messages
              // actually entering the engine this round (the drained digest
              // precedes the query in in-memory history, so it must too in
              // the chain).
              queryCommitPrefix = [
                ...(drained ? [drainedMsg] : []),
                ...(query.length > 0 ? [buildUserCommit(query)] : []),
              ];
              // #408 T5: verify-loop terminal outcome (only set when verifyConfig
              // is configured). Captured here so the post-run write-back can
              // read it.
              let finalResult: RunResult;
              let verifyView: VerifyAnswerView | undefined;
              let verifyOutcome: VerifyLoopOutcome | undefined;
              let verifyRecords: ReadonlyArray<{
                readonly reason?: string;
                readonly missing?: readonly string[];
              }> = [];
              // When verifyConfig is present (even with an empty command), run
              // is wrapped by runVerifyLoop (advisor shape, engine untouched);
              // absent → the plain run call stays byte-identical (unwired
              // path only). runVerifyLoop's runFn forwards onStream so
              // wrappedOnStream semantics hold; trace is injected only when
              // traceOut is configured (records land on disk, optionality
              // already handled). Note: runVerifyLoop's first-round runFn
              // omits priorMessages / onStream, so the closure must fall back
              // to hub-side priorMessages and wrappedOnStream.
              const runOutcome =
                !silent && this.verifyConfig
                  ? await runVerifyLoop({
                      runFn: (text, o) =>
                        attachPrefetch(text).then((effective) => {
                          queryCommitPrefix = [
                            ...(drained ? [drainedMsg] : []),
                            buildUserCommit(effective),
                          ];
                          return run(effective, runDeps, o?.signal, {
                            priorMessages: o?.priorMessages ?? priorMessages,
                            onStream: o?.onStream ?? wrappedOnStream,
                            hostStreamPresent: opts.onStream !== undefined,
                          });
                        }),
                      // ADR-0024: two modules, not `goal.text ?? query`. Non-empty
                      // goal → auto (userText = goal.text); else HITL (userText =
                      // query). taskFocus never entered verify input (#473) and
                      // is gone with #605 T2's retirement.
                      completionMode:
                        session.goal !== undefined &&
                        session.goal.text.length > 0
                          ? "auto"
                          : "hitl",
                      userText:
                        session.goal !== undefined &&
                        session.goal.text.length > 0
                          ? session.goal.text
                          : query,
                      config: this.verifyConfig,
                      sessionId: conversationId,
                      signal: opts.signal,
                      trace: runDeps.trace,
                      cwd: boundRoot,
                      // ADR-0092 Amendment: verify commands share the bash
                      // tool's fence tier — the snapshot is read fresh per
                      // call (a tier flip takes effect next call, no engine
                      // rebuild); absent → verify-loop global-tier baseline
                      // and the key does not appear.
                      ...presentFields("fsMode", this.fsModeSnapshot()),
                      // ADR-0119 / specs/yolo-mode.md: pass the yolo holder to
                      // verify-loop (which rebuilds the runVerify closure each
                      // round and reads the holder once at assembly → a `/yolo`
                      // flip affects the next round's verify). Holder absent →
                      // the key does not appear and the verify face stays
                      // non-yolo (fail-closed keeps the fence). One deliberate
                      // difference from the fsMode line above: yolo's consumer
                      // (`makeDefaultRunVerify`) wants the holder itself (it
                      // takes the snapshot `get()` internally for vintage), so
                      // this passes `this.yolo`, not a snapshot boolean.
                      ...presentFields("yolo", this.yolo),
                      // homeRoot is this process's homedir() — this call site
                      // is independent of build-engine, whose default is the
                      // `opts.userHome ?? homedir()` fallback branch.
                      //
                      // Known limitation (a deliberate same-source
                      // assumption): the two sites agree only while the host
                      // injects no userHome. All three production entrypoints
                      // (serve / chat / TUI) do not inject one, so today both
                      // home ro-bind sources match.
                      //
                      // Drift condition: userHome exists as a TUI deps test
                      // seam (src/tui/deps.ts). If some host ever injects
                      // that value into engine assembly while this call site
                      // keeps real homedir(), then under the workspace tier
                      // bash's home ro-bind points at the injected home and
                      // verify's at the real home — the two execution faces
                      // diverge on home visibility.
                      //
                      // Why not converge here: the hub cannot reach the
                      // engine's home — SessionHubOptions has no userHome
                      // (recentsHome / mcpHome are the trust roster root and
                      // the MCP config root, not engine-home seams). A real
                      // fix threads the same value through hub-bridge /
                      // run.tsx, which is TUI wiring ownership, and no
                      // production caller injects it today. When connecting
                      // the TUI userHome seam to the hub path, also add a
                      // home option to SessionHubOptions and read it fresh
                      // here (or via an fsModeSnapshot-style per-call
                      // helper) instead of relying on "production happens not
                      // to inject".
                      homeRoot: homedir(),
                      // ADR-0092: real host path of the session tmp — the same
                      // source as the workspace tier's `--bind <tmpRoot>`.
                      // Resolved through the very same helper the bash tool
                      // surface uses (no third derivation here):
                      // `<projectDir>/<sanitized convId>/fence-tmp`, same pool
                      // and leaf as registry bash's `projectDir: opts.todoDir`.
                      // Missing projectDir / conversationId → undefined and
                      // verify-loop falls back to process tmpdir() (the
                      // fallback is not the target state, see
                      // VerifyLoopOptions.tmpDir).
                      ...presentFields(
                        "tmpDir",
                        resolveSessionFenceTmp({
                          projectDir: this.store.getProjectDir(),
                          conversationId,
                        })
                      ),
                      // The live worktree-on-mutate holder — the same lazily
                      // created singleton the engine assembly uses (what the
                      // bash gate reads). verify's fence and bash judge from
                      // one source on the UNBOUND_FENCE axis; the holder is
                      // passed via options and `makeDefaultRunVerify` reads
                      // get() once when building this verify loop
                      // (factory-time snapshot, same pattern as the fsMode
                      // value surface). Absent (injected-deps hosts / gate not
                      // assembled) → key omitted and verify-loop keeps the
                      // byte-identical V1 baseline.
                      ...presentFields(
                        "worktreeOnMutate",
                        this.worktreeOnMutate
                      ),
                      // Production assembly: subagentManager present → enable
                      // classifier fill-in (the classifier takes over when
                      // command is missing/empty); absent (ask shape) →
                      // undefined, so verify-loop transparently disables
                      // itself for backward compatibility.
                      runClassifier:
                        this.subagentManager === undefined
                          ? undefined
                          : createRunClassifierFromManager({
                              manager: this.subagentManager,
                            }),
                    })
                  : await (async () => {
                      const effective = silent
                        ? ""
                        : await attachPrefetch(query);
                      queryCommitPrefix = [
                        ...(drained ? [drainedMsg] : []),
                        ...(effective.length > 0
                          ? [buildUserCommit(effective)]
                          : []),
                      ];
                      return run(effective, runDeps, opts.signal, {
                        priorMessages,
                        onStream: wrappedOnStream,
                        hostStreamPresent: opts.onStream !== undefined,
                      });
                    })();
              const result = runOutcome.result;
              // #408 T5: capture the terminal outcome for post-run write-back.
              verifyOutcome =
                "outcome" in runOutcome ? runOutcome.outcome : undefined;
              verifyRecords = "records" in runOutcome ? runOutcome.records : [];
              // Surface the verify final verdict (failed / unstable /
              // escalated / passed) to the DTO. HITL + INSUFFICIENT + skip
              // completing toward the judge does not raise a passed checkmark;
              // the SUFFICIENT short circuit still goes on the wire.
              // abort/disabled stay absent.
              verifyView =
                "outcome" in runOutcome
                  ? projectVerifyHumanView({
                      outcome: runOutcome.outcome,
                      rounds: runOutcome.rounds,
                      records: runOutcome.records,
                    })
                  : undefined;
              // Violation kill is a trace latch only. Engine stopReason (and
              // therefore checkpoint persist) stays as run() returned it.
              finalResult = result;
              return {
                finalResult,
                verifyView,
                verifyOutcome,
                verifyRecords,
                priorCount: priorMessages.length,
              };
            },
            persist: async (s) => {
              const saved = await this.conditionalSave({
                conversationId,
                session,
                result: s.finalResult,
                // priorMessages = the file BEFORE this run; only the messages THIS
                // run appended count as progress for the cancelled-delta decision.
                priorMessages: session.messages,
              });
              void saved;
              // Each turn hands the result to the auto-memory hook, which owns
              // the completed gate and the N-turn gate. Hook absent (default
              // OFF / ask / injected-deps tests) → whole call is a no-op,
              // byte-identical behavior.
              this.notifyAutoMemory(
                s.finalResult,
                s.priorCount,
                boundRoot,
                conversationId
              );
              // ADR-0113: after the first completed turn with substantive user
              // text, fire-and-forget lite title generation (not awaited; the
              // main turn is never blocked by it).
              this.maybeFireTitleGeneration({
                conversationId,
                result: s.finalResult,
              });
              // Goal write-back on verify-loop terminal outcome. The hub is
              // the only writer of goal.status. Target status is looked up from
              // OUTCOME_TO_STATUS; applyTransition runs only when target is a
              // valid forward edge from current status
              // (assertValidTransition rejects self-transitions, so
              // active→active / achieved→achieved are no-ops and the goal stays
              // put). recordGoal fires for every outcome with a goal present
              // (a trace entry is kept even when no status change happens).
              // Placed AFTER conditionalSave so a goal seeded on this same turn
              // is promoted in the same persistence round.
              if (s.verifyOutcome !== undefined && saved) {
                const justSaved = await this.store.load(conversationId);
                if (justSaved.goal !== undefined) {
                  const target = OUTCOME_TO_STATUS[s.verifyOutcome];
                  const now = new Date().toISOString();
                  // assertValidTransition guards the edge set:
                  // OUTCOME_TO_STATUS targets include "active" (the
                  // failed/unstable keep-state), which is an illegal reverse
                  // edge for a goal already achieved/aborted (achieved→active
                  // is not whitelisted) — the guard blocks it, the goal is
                  // unchanged, and only the recordGoal trace remains (aligned
                  // with failed/unstable behavior).
                  const transition =
                    target === undefined
                      ? undefined
                      : assertValidTransition({
                          from: justSaved.goal.status,
                          to: target,
                        });
                  if (
                    target !== undefined &&
                    target !== justSaved.goal.status &&
                    transition !== undefined &&
                    transition.ok
                  ) {
                    const writeback: SessionFileV1 = {
                      ...justSaved,
                      goal: applyTransition(justSaved.goal, target, now),
                      updatedAt: now,
                      schemaVersion: CURRENT_SCHEMA_VERSION,
                    };
                    await this.store.save({
                      id: conversationId,
                      file: writeback,
                    });
                  }
                  // Write-back emission point: status ?? "active" covers the
                  // disabled (no target) case as well as failed/unstable,
                  // self-transitions and illegal reverse edges.
                  await runDeps.trace?.recordGoal({
                    id: randomUUID(),
                    sessionId: conversationId,
                    action: "writeback",
                    status: target ?? "active",
                    ts: now,
                    conversationId,
                  });
                }
              }
            },
            decideContinue: async (s) =>
              silent
                ? false
                : this.applyHubAutoContinue({
                    conversationId,
                    result: s.finalResult,
                    priorCount: s.priorCount,
                    ...(s.verifyOutcome !== undefined
                      ? { verifyOutcome: s.verifyOutcome }
                      : {}),
                    records: s.verifyRecords,
                  }),
            buildStop: async (s) => {
              // D2 (tui-display-consistency): load once, reuse for session
              // summary + per-turn thinkingMs sum. The same
              // `loadedFile.thinkingMs` is a parallel array aligned with
              // loadedFile.messages after the store save, so the start index
              // s.priorCount (= session.messages.length) marks this turn's
              // additions.
              const loadedFile = await this.store.load(conversationId);
              const turnMs = s.finalResult.messages.slice(s.priorCount);
              const turnThinkingMs = sumAssistantThinkingMsInRange({
                messages: turnMs,
                thinkingMs: loadedFile.thinkingMs,
                startIndex: s.priorCount,
              });
              return {
                session: this.summarize({ file: loadedFile }),
                turn: this.toTurnDto({
                  query,
                  result: s.finalResult,
                  turnMessages: turnMs,
                  // B1: rendered interrupted is decided against the SAME priorMessages
                  // as conditionalSave — byte-identical boolean verdict
                  // (saved is consumed only on cancelled; other stopReasons
                  // like completed do not read it).
                  priorMessages: session.messages,
                  ...presentText("stopSummary", capturedStopSummary),
                  // Surface the verify final verdict (failed/unstable/
                  // escalated) to the DTO.
                  ...(s.verifyView !== undefined
                    ? { verify: s.verifyView }
                    : {}),
                  // D2 wire surface: this turn's assistant thinking time (ms).
                  ...(turnThinkingMs > 0 ? { thinkingMs: turnThinkingMs } : {}),
                }),
              };
            },
            reloadSession: async () => {
              // Hub refreshes session state between auto-loop iterations.
              // (Chat passes a no-op since its session lives in `ctx.state`.)
              session = await this.store.load(conversationId);
            },
          });
        } catch (err) {
          if (!silent) await this.applyHubAutoError(conversationId, err);
          if (err instanceof MaxTurnsExceeded) {
            // ADR-0011: do not save — the session was already on disk before
            // run(), and the throw path produces no new persistable messages,
            // so conditionalSave is not called (it would write empty messages
            // and wipe the invariant the disk-SSOT guard protects). turnCount
            // passes through err.turnsRan (turns actually run); finalText is
            // empty (no completed text). If a summary exists, attach it as
            // TurnAnswerDto.stopSummary (additive, byte-stable).
            return {
              session: this.summarize({ file: session }),
              turn: {
                query,
                answer: {
                  finalText: "",
                  stopReason: "maxTurns",
                  turnCount: err.turnsRan,
                  ...presentText("stopSummary", capturedStopSummary),
                },
              },
            };
          }
          throw err;
        }
      },
    });
    void operation.then(
      () => this.releaseActiveTurn(conversationId),
      () => this.releaseActiveTurn(conversationId)
    );
    return operation;
  }

  /**
   * T4: run one silent parent turn for a terminal subagent handoff.
   * `undefined` means the manager has no host-visible terminal result; no
   * model call is made and no synthetic success is returned.
   */
  async wakeFromSubagent(opts: {
    readonly conversationId: string;
    readonly signal?: AbortSignal;
    readonly thinking?: ThinkingOverride;
    readonly onStream?: (event: HarnessStreamEvent) => void;
  }): Promise<PostMessageResponse | undefined> {
    const drained = await drainPendingSubagents(this.subagentManagers, {
      conversationId: opts.conversationId,
    });
    if (drained.length === 0) return undefined;
    const taskIds = queryableSubagentTaskIds(
      this.subagentManagers,
      opts.conversationId
    );
    try {
      return await this.postMessage({
        conversationId: opts.conversationId,
        text: "",
        signal: opts.signal,
        thinking: opts.thinking,
        onStream: opts.onStream,
        silent: true,
      });
    } catch (error) {
      throw toSubagentWakeError(error, {
        taskIds,
        queryable: this.subagentManager !== undefined,
      });
    }
  }

  async resetSession(
    conversationId: string,
    _opts?: { new_id?: boolean }
  ): Promise<ResetSessionResponse> {
    return this.serialize({
      conversationId,
      work: async () => {
        // Reset destroys the live-graph ledger, so a later run_graph in the
        // same session can reuse old ids and really spawn. No ledger → no-op.
        this.liveGraphLedger?.destroy(conversationId);
        const session = await this.store.load(conversationId);
        const reset: SessionFileV1 = {
          ...session,
          messages: [],
          turnCount: 0,
          updatedAt: new Date().toISOString(),
          schemaVersion: CURRENT_SCHEMA_VERSION,
          title: "",
          // Reset wipes conversation history; prior checkpoint records
          // reference turns that no longer exist (messagesCount would also
          // falsely satisfy `appendCheckpoint`'s delta<=0 no-op guard and
          // silently drop the next interrupt save). Clear defensively.
          checkpoints: [],
        };
        await this.store.save({ id: conversationId, file: reset });
        return {
          session: this.summarize({ file: reset }),
          turns: [],
        };
      },
    });
  }

  async listSessions(): Promise<SessionListEntry[]> {
    return this.store.list();
  }

  /**
   * Manual session compaction (shared landing point for TUI /compact and the
   * web compact button). Same serialize pattern as resetSession:
   * load → compact → save.
   *
   * Prefers the LLM structured summary (runFullCompact, best-effort). When
   * cachedDeps is absent (ask / worker / oneshot — no harness assembly) or
   * the adapter is unusable, skip the LLM path and use the pure truncation of
   * compactMessages. LLM summary failures (empty_response / timeout /
   * adapter_failed) also fall back to the placeholder. The title field is
   * derived from the first user text via extractTitle (both paths keep a user
   * text message at messages[0], so the derivation is consistent).
   *
   * Idempotent no-op: when the message count does not drop (already below the
   * compact window, or ≤ keepRecent, or no dropped prefix), nothing is saved
   * and updatedAt is not bumped; returns compacted=false. Actual compaction →
   * save + recompute title.
   *
   * `opts.signal` / `opts.onStream` are threaded into runFullCompact so the
   * host sees the full event set during compaction (compaction_started /
   * completed / failed / cancelled + compaction_text_delta) and can cancel
   * mid-flight. Cancellation matches Claude Code: aborting opts.signal yields
   * the signal_aborted outcome → no fallback truncation, session kept as-is,
   * updatedAt not bumped, returns { compacted: false, cancelled: true } (an
   * additive field, distinguishing it from "nothing to compact"). Host
   * observer and adapter errors are swallowed by runFullCompact's
   * safeEmitStream; this function does not re-expose them.
   */
  async compactSession(
    conversationId: string,
    opts?: CompactCallerOpts
  ): Promise<CompactSessionResponse> {
    return this.serialize({
      conversationId,
      work: async () => {
        const session = await this.store.load(conversationId);
        const before = session.messages;

        // Manual /compact is treated as having already passed
        // evaluateCompactTrigger's token gate. The body still reuses the
        // existing runFullCompact / compactMessages fallback, sharing the same
        // dropped/kept decision as proactive auto-compact after it fires:
        //   - empty → idempotent noop (reason=messages_too_few), no save, no
        //     updatedAt bump;
        //   - incompressible (messages ≤ keepRecent, no dropped prefix) →
        //     full_summary branch (the whole span counts as dropped, kept=[]),
        //     same behavior as after auto fires;
        //   - dropped prefix present → windowed branch.
        // The proactive threshold formula / getAutoCompactThreshold /
        // IKNOW_AUTO_COMPACT_THRESHOLD_TOKENS / estimateMessagesTokens /
        // DEFAULT_KEEP_RECENT are untouched — only the hub manual entry skips
        // the token criterion; loop-engine still runs evaluateCompactTrigger.
        let split: {
          readonly dropped: ReadonlyArray<AnthropicNativeMessage>;
          readonly kept: ReadonlyArray<AnthropicNativeMessage>;
        };
        if (before.length === 0) {
          // Empty session: idempotent noop; the reason literal stays
          // messages_too_few (below_token_threshold is reserved for the auto
          // path).
          return {
            session: this.summarize({ file: session }),
            turns: projectMessagesToTurns(before),
            compacted: false,
            reason: REASON_NO_COMPRESS,
            beforeCount: 0,
            afterCount: 0,
          };
        }
        const windowSplit = splitForCompaction(before);
        if (windowSplit === undefined) {
          // Non-empty but messages ≤ keepRecent with no dropped prefix →
          // full_summary branch (equivalent to evaluateCompactTrigger
          // returning compact_via_full_summary on the auto path).
          split = { dropped: before, kept: [] };
        } else {
          split = windowSplit;
        }

        // Prefer the LLM structured summary (best-effort, falls back to the
        // placeholder on failure). cachedDeps absent (ask / oneshot, no
        // harness assembly) → adapter unusable, skip LLM, placeholder direct.
        // opts.signal / opts.onStream thread into runFullCompact so the host
        // sees the full compaction event set and can cancel mid-flight; the
        // signal_aborted outcome takes the keep-state path (no fallback
        // truncation, no save, cancelled:true) to match Claude Code.
        let nextMessages: ReadonlyArray<AnthropicNativeMessage> | undefined;
        let cancelled = false;
        const hubAdapter = this.cachedDeps?.adapter;
        if (hubAdapter !== undefined) {
          try {
            const outcome = await runFullCompact({
              // ADR-0112: the compact request prompt is host-injected — encode
              // through the stamped view (same technique as loop-engine's
              // makeCompactAdapterView), otherwise this summary call's outbound
              // projection would translate away the official prompt.
              adapter: {
                step: (state, request, signal) =>
                  hubAdapter.step(state, request, signal),
                encodeUserText: (promptText) =>
                  stampHostInjected(hubAdapter.encodeUserText(promptText)),
              },
              dropped: split.dropped,
              ...(opts?.signal !== undefined ? { signal: opts.signal } : {}),
              ...(opts?.onStream !== undefined
                ? { onStream: opts.onStream }
                : {}),
            });
            if (outcome.kind === "summarized") {
              // The resume summary goes through the same buildCompactedMessages
              // assembly seam (preamble SSOT); the first message is a
              // host-injected commit, stamped before persisting.
              const composed = buildCompactedMessages({
                summaryText: outcome.text,
                kept: split.kept,
              });
              nextMessages = [
                stampHostInjected(composed[0]!),
                ...composed.slice(1),
              ];
            } else if (outcome.kind === "signal_aborted") {
              // Claude Code cancellation semantics: keep the session as-is,
              // no fallback truncation, no updatedAt bump; cancelled:true
              // distinguishes this from plain compacted=false ("nothing to
              // compact") for web/TUI rendering.
              cancelled = true;
            }
          } catch {
            // runFullCompact already converges all errors into
            // FullCompactOutcome; this catch is a defensive floor — any
            // unexpected throw is treated as failure → placeholder.
          }
        }

        if (cancelled) {
          return {
            session: this.summarize({ file: session }),
            turns: projectMessagesToTurns(before),
            compacted: false,
            cancelled: true,
            reason: REASON_NO_COMPRESS,
            beforeCount: before.length,
            afterCount: before.length,
          };
        }

        // Fallback / LLM skipped → pure truncation + boundary placeholder.
        const useCompactMessages = nextMessages === undefined;
        const compacted = useCompactMessages
          ? compactMessages(before)
          : nextMessages!;
        if (useCompactMessages && compacted.length >= before.length) {
          return {
            session: this.summarize({ file: session }),
            turns: projectMessagesToTurns(before),
            compacted: false,
            reason: REASON_NO_COMPRESS,
            beforeCount: before.length,
            afterCount: before.length,
          };
        }
        const updated: SessionFileV1 = {
          ...session,
          messages: compacted,
          turnCount: session.turnCount,
          updatedAt: new Date().toISOString(),
          schemaVersion: CURRENT_SCHEMA_VERSION,
          // Derive the session title from the first user text (for fast
          // session-list display):
          //   - summary turn: messages[0] = SUMMARY_PREAMBLE + summary user
          //     message, so extractTitle(compacted) would pick up the preamble
          //     prefix instead of the user's original words;
          //   - placeholder path: messages[0] = "[compaction boundary ...]"
          //     user message.
          // Deriving from the pre-compact `before` keeps the title at the
          // original first-user intent (matching placeholder-era behavior)
          // instead of being polluted by preamble / placeholder.
          title: extractTitle(before),
        };
        await this.store.save({ id: conversationId, file: updated });
        // reason: LLM summary succeeded → 'full_summary' (regardless of the
        // trigger's action, since nextMessages really is SUMMARY_PREAMBLE +
        // summary); placeholder fallback → 'windowed'. SSOT: the helper keeps
        // the 4-way decision in one place, avoiding inline-literal drift.
        const reason: CompactReason = compactReasonFor({
          useCompactMessages,
        });
        return {
          session: this.summarize({ file: updated }),
          turns: projectMessagesToTurns(compacted),
          compacted: true,
          reason,
          beforeCount: before.length,
          afterCount: compacted.length,
        };
      },
    });
  }

  /**
   * continue_pending: reload → predicate → skip-append run.
   * Same serialize queue as compactSession; HTTP has no busy_stop_first.
   * Does not run goal-auto. Success wire reuses PostMessageResponse.
   */
  async continueSession(
    conversationId: string,
    opts?: CompactCallerOpts
  ): Promise<PostMessageResponse> {
    return this.serialize({
      conversationId,
      work: () => this.runContinuePending(conversationId, opts),
    });
  }

  /** Load, gate unbound/predicate, skip-append run, map skip_append → ValidationError. */
  private async runContinuePending(
    conversationId: string,
    opts?: CompactCallerOpts
  ): Promise<PostMessageResponse> {
    const session = await this.store.load(conversationId);
    // EXIT: reject-execute-before-engine — continue has the same boundary
    // contract as postMessage on every host surface.
    const boundRoot = requireBoundRoot(session.workspaceRoot);
    const verdict = evaluateContinuePending({
      messages: session.messages,
      ...(session.goal !== undefined ? { goal: session.goal } : {}),
    });
    if (!verdict.ok) {
      throw continuePredicateError(verdict.exit);
    }
    const deps = await this.ensureDeps(boundRoot);
    const trace = this.createTrace(conversationId);
    const runDeps: LoopEngineDeps = {
      ...deps,
      agentVersion: getVersion(),
      conversationId,
      commitMessages: (messages, thinkingMs) =>
        this.appendSessionEvents({
          conversationId,
          session,
          events: messages,
          ...(thinkingMs !== undefined ? { thinkingMs } : {}),
        }),
      ...(trace !== undefined ? { trace } : {}),
    };
    let capturedStopSummary: string | undefined;
    const wrappedOnStream = (event: HarnessStreamEvent): void => {
      if (event.type === "stop_summary") {
        capturedStopSummary = event.text;
      }
      opts?.onStream?.(event);
    };
    try {
      // /continue: the model prior for THIS run omits
      // a trailing `Interrupted by user.` system message. Disk still contains
      // it — the persist predicate's prior is the ORIGINAL `session.messages`
      // so `conditionalSave` keeps the interrupt on disk, and the loaded file
      // round-trips back to `loaded.messages` for the TUI. View-only slice:
      // stripTrailingInterrupt does not mutate `session.messages`.
      const modelPrior = stripTrailingInterrupt(session.messages);
      const { result } = await run("", runDeps, opts?.signal, {
        priorMessages: modelPrior,
        appendUserText: false,
        onStream: wrappedOnStream,
        hostStreamPresent: opts?.onStream !== undefined,
      });
      await this.conditionalSave({
        conversationId,
        session,
        result,
        priorMessages: modelPrior,
        diskPrior: session.messages,
      });
      const loaded = await this.store.load(conversationId);
      // Slice the on-disk array (conditionalSave spliced this run's delta
      // after the ORIGINAL prior, keeping the interrupt). result.messages is
      // NOT usable here: it starts from the interrupt-stripped model prior,
      // so slicing it by session.messages.length would drop the first new
      // assistant message whenever a trailing interrupt was stripped.
      const turnMs = loaded.messages.slice(session.messages.length);
      // D2 (tui-display-consistency): per-turn thinkingMs from the disk-SSOT
      // parallel array. The continue_pending path reads
      // loadedFile.thinkingMs directly (this turn's additions start at
      // session.messages.length), same pattern as the buildStop path.
      const turnThinkingMs = sumAssistantThinkingMsInRange({
        messages: turnMs,
        thinkingMs: loaded.thinkingMs,
        startIndex: session.messages.length,
      });
      return {
        session: this.summarize({ file: loaded }),
        turn: this.toTurnDto({
          query: "",
          result,
          turnMessages: turnMs,
          priorMessages: session.messages,
          ...(capturedStopSummary !== undefined &&
          capturedStopSummary.length > 0
            ? { stopSummary: capturedStopSummary }
            : {}),
          ...(turnThinkingMs > 0 ? { thinkingMs: turnThinkingMs } : {}),
        }),
      };
    } catch (err) {
      const mapped = mapSkipAppendToContinueError(err);
      if (mapped !== null) throw mapped;
      if (err instanceof MaxTurnsExceeded) {
        return {
          session: this.summarize({ file: session }),
          turn: {
            query: "",
            answer: {
              finalText: "",
              stopReason: "maxTurns",
              turnCount: err.turnsRan,
              ...(capturedStopSummary !== undefined &&
              capturedStopSummary.length > 0
                ? { stopSummary: capturedStopSummary }
                : {}),
            },
          },
        };
      }
      throw err;
    }
  }

  /**
   * Rewind a session: point the persisted head at `head` (null = empty
   * transcript). Runs through the serialize queue. Input is an event id, no
   * longer keepTurns. Legacy .json-only sessions are load+save migrated to
   * JSONL first, then the rewind is retried.
   */
  async rewindSession(
    conversationId: string,
    head: string | null
  ): Promise<RewindSessionResponse> {
    return this.serialize({
      conversationId,
      work: async () => {
        let file: SessionFileV1;
        try {
          ({ file } = await this.store.rewindToHead({
            id: conversationId,
            head,
          }));
        } catch (err) {
          if (!isSessionStoreError(err) || err.kind !== "write_failed") {
            throw err;
          }
          const legacy = await this.store.load(conversationId);
          await this.store.save({ id: conversationId, file: legacy });
          ({ file } = await this.store.rewindToHead({
            id: conversationId,
            head,
          }));
        }
        return {
          session: this.summarize({ file }),
          turns: projectMessagesToTurns(file.messages),
          head: await this.store.readHead(conversationId),
        };
      },
    });
  }

  async listRewindTargets(
    conversationId: string
  ): Promise<RewindTargetsResponse> {
    return this.serialize({
      conversationId,
      work: async () => ({
        targets: await this.store.listRewindTargets(conversationId),
      }),
    });
  }

  /**
   * GET /api/v1/skills — the loadable-skill surface: includes entries without
   * a description and `disable-model-invocation` entries, because human-side
   * `/` must offer all of them as candidates. Catalog absent (test-injected
   * deps) → empty list.
   *
   * Slash candidates must contain freshly loadable entries at install/reload
   * time, without waiting for the next turn: the assembly-time cached catalog
   * is only a snapshot from then, so at call time we re-scan the current skill
   * roots through the rescan seam and take this beat's `loadable()`. Rescan
   * failure (typed `SkillRescanError`) → fall back to the cached catalog's
   * loadable surface — the human-side slash is a lenient surface and one IO
   * fault must not empty the candidates (deliberately opposite to the
   * model-side `computeSkillIndexDelta`, which must propagate; see the header
   * of rescan.ts). Seam absent (test-injected deps / ask) → cached catalog,
   * byte-identical old behavior.
   */
  async listSkills(): Promise<readonly SkillSummaryDto[]> {
    await this.ensureDeps();
    const catalog = await this.currentSkillCatalog();
    return toSkillSummaries(loadableOf(catalog) ?? []);
  }

  /**
   * The current loadable-skill surface, sampled at read time. Rescan seam
   * present → re-scan the current skill roots (the assembly-time cached
   * catalog is a snapshot: SKILL.md files landed mid-session or swapped plugin
   * roots are not in it); failure → fall back to the cached catalog — the
   * human side is a lenient surface: one IO fault neither empties the
   * candidates nor lets a visible name 404 on click (deliberately opposite to
   * model-side `computeSkillIndexDelta` propagating; see "who is the reader"
   * in the rescan.ts header). Seam absent (test-injected deps / ask) → cached
   * catalog, byte-identical old behavior.
   */
  private async currentSkillCatalog(): Promise<SkillCatalog | undefined> {
    if (this.skillRescanner !== undefined) {
      try {
        // Current surface (after plugin-root swaps / mid-session new SKILL.md).
        return await this.skillRescanner.rescan();
      } catch (err) {
        // EXIT: swallow only typed rescan failures — programming errors (not
        // SkillRescanError) keep propagating instead of silently degrading to
        // a stale catalog. Discrimination via `instanceof` (SkillRescanError
        // is a class; `kind` is also present for cross-process surfaces).
        if (!(err instanceof SkillRescanError)) throw err;
        // Rendering goes through `errorMessage` (the typed-error catch
        // contract forbids `instanceof Error ? … : String(…)`).
        const reason = errorMessage(err);
        console.warn(
          `[serve] skill rescan failed, falling back to cached catalog: ${reason}`
        );
      }
    }
    return this.skillCatalog;
  }

  /**
   * Load a skill body. `disable-model-invocation` gates only the model index
   * and `skill()`, NOT human-side slash reads from disk — only a `get` miss
   * counts as not-found.
   */
  async loadSkillBody(name: string): Promise<{ name: string; body: string }> {
    await this.ensureDeps();
    // The other half of "candidates are hot at once": a name that just entered
    // the candidate list must be clickable. Take the same current surface
    // (cached fallback on rescan failure), otherwise an entry just returned by
    // listSkills would 404 in loadSkillBody (visible candidates / unreachable
    // bodies split).
    const entry = (await this.currentSkillCatalog())?.get(name);
    if (entry === undefined) {
      throw new NotFoundError(`skill not found: ${name}`);
    }
    // ADR-0079 — skill bodies no longer carry the write-root trailer. The
    // authoritative path for write-location disclosure is worker prior +
    // chat-session one-shot rebind notification sharing the
    // writeRootSegment helper; the hub does not consume liveTaskRoot /
    // isolationOn (rebind notifications go through chat-session, not hub).
    const body = await createSkillBody({ entry, dir: entry.dir });
    return { name: entry.name, body };
  }

  async listMcpServers(): Promise<readonly McpServerStatusDto[]> {
    await this.ensureDeps();
    return (this.mcpManager?.status() ?? []).map((s) => ({
      name: s.name,
      state: s.state,
      source: s.source,
      ...(s.error !== undefined ? { error: s.error } : {}),
    }));
  }

  async reloadMcp(): Promise<readonly McpServerStatusDto[]> {
    // Serialize / coalesce: every caller's promise has a typed success or
    // failure terminus.
    const run = this.mcpReloadChain.then(
      () => this.reloadMcpTransaction(),
      () => this.reloadMcpTransaction()
    );
    this.mcpReloadChain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  /**
   * Active-root reload transaction: validate the active engine's mcpRoots
   * first, then load config / call manager.reload. Failure paths must not
   * leave old+new managers both serving as the outward success surface; bad
   * roots are rejected before the good manager is shut down.
   */
  private async reloadMcpTransaction(): Promise<readonly McpServerStatusDto[]> {
    // With a visible face already present, skip ensureDeps: it avoids
    // cache-hit activate overwriting the active mcpRoots this transaction
    // validates, and shrinks the rebind∩reload window.
    if (!this.mcpManager || this.activeMcpRoots === undefined) {
      await this.ensureDeps();
    }
    const manager = this.mcpManager;
    if (!manager) {
      return this.listMcpServers();
    }

    // Root validation must precede manager.reload (the latter shuts down old slots).
    let validated: McpRoots;
    try {
      const roots = this.activeMcpRoots;
      if (roots === undefined) {
        throw new McpLifecycleError(
          "missing_cwd",
          "active engine mcpRoots are required for MCP reload"
        );
      }
      // mcpConfigRoot is contractually the stable productRoot; re-verify via the resolver.
      validated = resolveMcpRoots({
        workspaceRoot: roots.workspaceRoot,
        productRoot: roots.mcpConfigRoot,
      });
      if (this.productRoot !== undefined) {
        const fromProduct = resolveMcpRoots({
          workspaceRoot: roots.workspaceRoot,
          productRoot: this.productRoot,
        });
        if (fromProduct.mcpConfigRoot !== validated.mcpConfigRoot) {
          throw new McpLifecycleError(
            "root_mismatch",
            "active mcpConfigRoot does not match hub productRoot"
          );
        }
      }
    } catch (err) {
      // EXIT: bad roots → reject before shutdown of good manager
      if (err instanceof McpLifecycleError) throw err;
      throw new McpLifecycleError("reload_failed", errorMessage(err), {
        cause: err,
      });
    }

    try {
      const home = this.mcpHome ?? homedir();
      const cfg = await loadMcpConfig({
        home,
        mcpConfigRoot: validated.mcpConfigRoot,
      });
      await manager.reload(cfg.servers);
    } catch (err) {
      // EXIT: reload failed → retain one coherent failed/old state; never report mixed success
      if (err instanceof McpLifecycleError) throw err;
      throw new McpLifecycleError("reload_failed", errorMessage(err), {
        cause: err,
      });
    }
    return this.listMcpServers();
  }

  async listMcpTools(): Promise<readonly McpToolDto[]> {
    await this.ensureDeps();
    if (!this.aciCatalog) return [];
    const out: McpToolDto[] = [];
    for (const def of this.aciCatalog.all()) {
      if (!def.name.startsWith("mcp__")) continue;
      out.push({
        server: mcpServerOfToolName(def.name),
        name: def.name,
        description: def.description,
      });
    }
    out.sort((a, b) => a.server.localeCompare(b.server));
    return out;
  }

  /**
   * T6: write a violation kill event to the JSONL trace (serve entry).
   * Best-effort — a trace write failure must not break the served turn; any
   * error is swallowed (mirrors JsonlTraceService warn-once semantics).
   * `reason` is already a JSON string produced by createKillSessionHook.
   */
  private recordViolationTrace(conversationId: string, reason: string): void {
    if (!this.traceOut) return;
    try {
      // ADR-0071: violations share the main-session trace domain,
      // anchored at `<projectDir>/<convId>/trace.jsonl`. Derivation reuses
      // `resolveConversationTraceFilePath`, same source as `createTrace` →
      // the two write paths of one session cannot drift to different files.
      const filePath = resolveConversationTraceFilePath({
        projectDir: this.store.getProjectDir(),
        conversationId,
      });
      mkdirSync(dirname(filePath), { recursive: true });
      const line = JSON.stringify({
        conversation_id: conversationId,
        record_type: "violation",
        ts: new Date().toISOString(),
        detail: safeParse(reason),
      });
      appendFileSync(filePath, line + "\n", "utf8");
    } catch {
      // Best-effort observability; never let trace I/O break the served turn.
    }
  }

  // -- private helpers ---------------------------------------------------------

  private validateText(text: string): void {
    const query = text.trim();
    if (!query) {
      throw new ValidationError("message text must be non-empty", {
        field: "text",
      });
    }
    // Machine-assembled skill-load messages skip the user-input length cap
    // (symmetric with the model-side tool-result channel having no char cap —
    // both are machine-assembled, not hand-typed user text). Loading a 78KB
    // SKILL.md at once would hit the 8000 cap; without the exemption the
    // skill-load slash path is unusable. The combined guard
    // `exceedsUserInputCap` is shared by hub.validateText, chat-session
    // processChatLine and the same-side predicate unit test.
    if (exceedsUserInputCap(text, MAX_MESSAGE_CHARS)) {
      throw new ValidationError(
        `message text exceeds max length ${MAX_MESSAGE_CHARS}`,
        { field: "text", max: MAX_MESSAGE_CHARS, length: query.length }
      );
    }
  }

  /** Per-postMessage trace service (undefined when traceOut is
   *  not configured). Hoisted at the start of serialize's work so the pin /
   *  seed / writeback emission points and runDeps share one instance. */
  private createTrace(
    conversationId: string
  ): TraceServiceWithHealth | undefined {
    if (!this.traceOut) return undefined;
    // ADR-0071: main session + violation share one
    // `resolveConversationTraceFilePath` derivation, ensuring both write
    // paths land in `<projectDir>/<conversationId>/trace.jsonl`.
    //
    // The subagent aggregation stream (`createTrace("subagent")` with a fake
    // literal-conversationId scope writing `<traceOut>/subagent.jsonl`) is
    // retired — subagent lifecycle / content trace is now derived per agent by
    // the manager through the two-segment `projectDir` seam as
    // `<projectDir>/<convId>/subagents/agent-<taskId>.jsonl`, see the
    // projectDir injection on the buildProductionEngine / rebuildEngine paths.
    // Call sites no longer pass conversationId="subagent" — a residual call
    // (if any) would still be accepted by ajv as `conversationId:"subagent"`,
    // but the write path no longer exists, so it is side-effect-free and only
    // a spec-consistency note.
    const trace = createJsonlTraceService({
      traceFilePath: resolveConversationTraceFilePath({
        projectDir: this.store.getProjectDir(),
        conversationId,
      }),
      conversationId,
    });
    this.traceServices.add(trace);
    return trace;
  }

  /** Compact-boundary rendering: render the latest ≤3 qualifying
   *  user task quotes from session.messages into one text block, injected
   *  into loop-engine via the runDeps.boundaryAttachment closure and appended
   *  as one user message when compact fires (after the boundary placeholder).
   *
   *  Constraints:
   *    - 0 qualifying sentences → return undefined, the helper early-exits
   *      (byte-stable behavior, equivalent to the old semantics of taskFocus
   *      undefined → field absent; that field is retired).
   *    - auto mode is no longer intercepted here — upstream the
   *      boundaryAttachment closure skips injection entirely when
   *      `session.goal.text.length > 0`; this function only handles messages.
   *    - no per-sentence cap (the old 240-char spec cap is gone) — full
   *      sentences enter the excerpt directly.
   *    - render shape: `<prefix> — N\n1. t1\n2. t2\n…` (numbered,
   *      chronological, newest last, matching extractRecentUserTasks' output
   *      order).
   *    - pure string derivation, zero IO / zero LLM calls; message structure
   *      is guarded by turn-projection.ts `extractRecentUserTasks`.
   */
  private renderRecentUserTasksBoundary(
    messages: ReadonlyArray<AnthropicNativeMessage>
  ): string | undefined {
    const tasks = extractRecentUserTasks(messages);
    if (tasks.length === 0) return undefined;
    const header = `${TASK_EXCERPT_PREFIX} — ${tasks.length}`;
    const body = tasks.map((t, i) => `${i + 1}. ${t}`).join("\n");
    return `${header}\n${body}`;
  }

  private async applyHubAutoContinue(opts: {
    readonly conversationId: string;
    readonly result: RunResult;
    readonly priorCount: number;
    readonly verifyOutcome?: VerifyLoopOutcome;
    readonly records: ReadonlyArray<{
      readonly reason?: string;
      readonly missing?: readonly string[];
    }>;
  }): Promise<boolean> {
    if (this.verifyConfig === undefined) return false;
    return applyGoalAutoContinue({
      store: this.store,
      conversationId: opts.conversationId,
      summary: {
        result: opts.result,
        priorCount: opts.priorCount,
        records: opts.records,
        ...(opts.verifyOutcome !== undefined
          ? { verifyOutcome: opts.verifyOutcome }
          : {}),
      },
      onLoadError: (loadErr) =>
        skipAutoPersistOnLoadError(loadErr, opts.conversationId),
    });
  }

  private async applyHubAutoError(
    conversationId: string,
    err: unknown
  ): Promise<void> {
    await applyGoalAutoError({
      store: this.store,
      conversationId,
      err,
      onLoadError: (loadErr) =>
        skipAutoPersistOnLoadError(loadErr, conversationId),
    });
  }

  /** `/goal clear` helper (called by the slash layer + chat-session).
   *  Clears the pinned goal (the goal goes away entirely), records the trace
   *  clear event, and persists atomically through the same serialize queue. */
  async clearGoal(conversationId: string): Promise<void> {
    await this.serialize({
      conversationId,
      work: async () => {
        const session = await this.store.load(conversationId);
        const now = new Date().toISOString();
        const cleared: SessionFileV1 = {
          ...session,
          goal: undefined,
          updatedAt: now,
          schemaVersion: CURRENT_SCHEMA_VERSION,
        };
        await this.store.save({ id: conversationId, file: cleared });
        await this.createTrace(conversationId)?.recordGoal({
          id: randomUUID(),
          sessionId: conversationId,
          action: "clear",
          status: "cleared",
          ts: now,
          conversationId,
        });
      },
    });
  }

  private attachSubagentWake(manager: SubagentManagerReadView): void {
    if (this.subagentWake !== undefined || this.surface !== "serve") return;
    this.subagentWake = createSubagentWake({
      manager,
      conversationId: () => this.lastConversationId,
      isIdle: () =>
        this.lastConversationId !== undefined &&
        !this.activeTurnCounts.has(this.lastConversationId),
      wake: async () => {
        const conversationId = this.lastConversationId;
        if (conversationId === undefined) return;
        await this.wakeFromSubagent({ conversationId });
      },
      onError: (error) => {
        console.warn("[serve] subagent wake failed", error);
      },
    });
  }

  private releaseActiveTurn(conversationId: string): void {
    const count = this.activeTurnCounts.get(conversationId);
    if (count === undefined || count <= 1) {
      this.activeTurnCounts.delete(conversationId);
      this.subagentWake?.flush();
      return;
    }
    this.activeTurnCounts.set(conversationId, count - 1);
    this.subagentWake?.flush();
  }

  /**
   * Serialize operations on the same conversation_id (spec A15).
   * Different ids run in parallel; same id chains sequentially.
   */
  private serialize<T>(opts: {
    readonly conversationId: string;
    readonly work: () => Promise<T>;
  }): Promise<T> {
    const { conversationId, work } = opts;
    const prev = this.inflight.get(conversationId) ?? Promise.resolve();
    const next = prev.then(() => work());
    // Swallow rejection in the chain sentinel so subsequent ops still run.
    this.inflight.set(
      conversationId,
      next.then(
        () => {},
        () => {}
      )
    );
    return next;
  }

  /**
   * Store landing point for the commit hook (only called inside postMessage's
   * serialize slot, see the runDeps comment — direct store calls, no queue
   * re-entry). Try appendEvents first; on a typed store failure (first run of
   * a legacy .json-only session after upgrade → write_failed; file deleted
   * externally → not_found, etc.) bootstrap once by saving the full current
   * session (save writes the authoritative JSONL form; for legacy sessions
   * this is an early trigger of migrate-on-save semantics), then retry once.
   * Non-typed exceptions propagate as-is; bootstrap/retry failures also
   * propagate — never swallowed silently (loop-engine wraps into
   * MessageCommitError and aborts the run).
   */
  private async appendSessionEvents(opts: {
    readonly conversationId: string;
    readonly session: SessionFileV1;
    readonly events: ReadonlyArray<AnthropicNativeMessage>;
    /** D2 (tui-display-consistency): thinking duration (ms) carried by an
     *  assistant commit. tool_result / other batches = undefined, and
     *  appendEvents omits the key. */
    readonly thinkingMs?: number;
  }): Promise<void> {
    try {
      await this.store.appendEvents({
        id: opts.conversationId,
        events: opts.events,
        ...(opts.thinkingMs !== undefined
          ? { thinkingMs: opts.thinkingMs }
          : {}),
      });
    } catch (err) {
      if (!isSessionStoreError(err)) throw err;
      await this.store.save({ id: opts.conversationId, file: opts.session });
      await this.store.appendEvents({
        id: opts.conversationId,
        events: opts.events,
        ...(opts.thinkingMs !== undefined
          ? { thinkingMs: opts.thinkingMs }
          : {}),
      });
    }
  }

  /** Save condition based on stopReason and progress delta.
   *  `priorMessages` = messages the model saw at the start of THIS run
   *  (delta = result.messages.length - priorMessages.length drives the
   *  cancelled-delta check and the appendCheckpoint messagesCount). Disk
   *  persistence uses `diskPrior` (defaults to priorMessages for the
   *  postMessage path; /continue sets it to session.messages so the trailing
   *  interrupt system message stays on disk even though the model prior
   *  omitted it).
   *
   *  decideCheckpointPersist picks one of three outcomes:
   *    "none"              — skip save entirely
   *    "full"              — save result.messages wholesale (completed /
   *                          maxTurns / timeout / nonSuccessStop /
   *                          cancelled-with-delta)
   *    "partial_user_only" — splice ONLY user-role messages from this run's
   *                          delta onto disk (spec:
   *                          protocolError / emptyFinalResponse keep the
   *                          user message, drop the failed assistant).
   *
   *  Interrupting stops (cancelled with delta>0) also append a checkpoint
   *  record so the interrupted turn is recoverable / rewind-able.
   *
   *  B1: return value = true when actually persisted / false when not
   *  (decideCheckpointPersist declined or store.save threw). Error-handling
   *  semantics unchanged — save failures propagate upward and are settled by
   *  postMessage's serialize queue; no warn here. */
  private async conditionalSave(opts: {
    readonly conversationId: string;
    readonly session: SessionFileV1;
    readonly result: RunResult;
    readonly priorMessages: ReadonlyArray<AnthropicNativeMessage>;
    /** /continue only: messages to splice the new delta onto for disk. When
     *  omitted, defaults to priorMessages (postMessage path — model prior ==
     *  disk prior). */
    readonly diskPrior?: ReadonlyArray<AnthropicNativeMessage>;
  }): Promise<boolean> {
    const { conversationId, session, result, priorMessages } = opts;
    const diskPrior = opts.diskPrior ?? priorMessages;
    const decision = decideCheckpointPersist(result, priorMessages);
    const dirtyRoot = this.dirtyWorktreeRoots.get(conversationId);
    if (decision.kind === "none" && dirtyRoot === undefined) return false;
    const now = new Date().toISOString();
    const updated =
      decision.kind === "none"
        ? session
        : (() => {
            const turnCount = session.turnCount + result.turnCount;
            const interruptReason = toInterruptReason(result.stopReason);
            // Resolve the messages we want on disk for this decision.
            // - "full": result.messages (or diskPrior + delta for /continue).
            // - "partial_user_only": diskPrior + genuine user queries from this
            //   run's delta (SSOT `isTurnQuery` — same predicate
            //   decideCheckpointPersist used to pick this outcome; a bare
            //   `role === "user"` check would also match tool_result-only
            //   continuation messages and orphan them). The failed assistant
            //   turn never reaches disk.
            const persistedMessages =
              decision.kind === "full"
                ? diskPrior === priorMessages
                  ? result.messages
                  : [
                      ...diskPrior,
                      ...result.messages.slice(priorMessages.length),
                    ]
                : decision.kind === "partial_user_only"
                  ? [
                      ...diskPrior,
                      ...result.messages
                        .slice(priorMessages.length)
                        .filter((m) => isTurnQuery(m)),
                    ]
                  : (session.messages as ReadonlyArray<AnthropicNativeMessage>);
            // appendCheckpoint compares record.messagesCount to
            // session.messages.length for its delta=0 guard, so it must
            // receive the session BEFORE new messages are merged in.
            const withCheckpoint =
              interruptReason === null
                ? session
                : appendCheckpoint(session, {
                    turnIndex: turnCount,
                    messagesCount: persistedMessages.length,
                    interruptedAt: now,
                    interruptReason,
                    ...persistedLastUsage(result.lastUsage),
                  });
            return {
              ...withCheckpoint,
              messages: persistedMessages,
              turnCount,
              updatedAt: now,
              schemaVersion: CURRENT_SCHEMA_VERSION,
              title: extractTitle(persistedMessages),
              // #1079: file-level usage snapshot for reopen replay (TUI attach
              // / web load must not fall back to 0%); covers every persisted
              // decision, interrupt stops included.
              ...persistedLastUsage(result.lastUsage),
            };
          })();
    await this.consumeDirtyRootOnSave(conversationId, async (root) => {
      // EXIT: report-save-failure-and-retain-dirty-root — SessionStore's
      // typed error propagates; consumeDirtyRootOnSave clears only after this
      // write resolves successfully.
      await this.store.save({
        id: conversationId,
        file:
          root === undefined ? updated : { ...updated, workspaceRoot: root },
      });
    });
    return true;
  }

  private async consumeDirtyRootOnSave(
    conversationId: string,
    save: (root: string | undefined) => Promise<void>
  ): Promise<void> {
    const dirtyRoot = this.dirtyWorktreeRoots.get(conversationId);
    await save(dirtyRoot);
    if (
      dirtyRoot !== undefined &&
      this.dirtyWorktreeRoots.get(conversationId) === dirtyRoot
    ) {
      this.dirtyWorktreeRoots.delete(conversationId);
    }
  }

  /**
   * ADR-0113: hub trigger point for lite title generation. The synchronous
   * part only checks the gates (generator present / first completed turn /
   * substantive user text); the LLM call and persistence ride an un-awaited
   * async tail — the postMessage main turn never waits on generation.
   */
  private maybeFireTitleGeneration(opts: {
    readonly conversationId: string;
    readonly result: RunResult;
  }): void {
    const generator = this.titleGenerator;
    // EXIT: lite absent (generator not injected) → never fire; hub behavior
    // byte-identical to today.
    if (generator === undefined) return;
    if (opts.result.stopReason !== "completed") return;
    // EXIT: this process already burned one lite title for this session →
    // the second completed turn does not re-fire (fire once per session).
    if (this.titleFiredConversations.has(opts.conversationId)) return;
    const source = collectTitleSource(
      opts.result.messages,
      opts.result.finalText ?? ""
    );
    // EXIT: greeting-only / too short with no assistant text → do not mark
    // fired this turn; re-evaluate on the next completed turn.
    if (source === undefined) return;
    this.titleFiredConversations.add(opts.conversationId);
    const conversationId = opts.conversationId;
    void (async () => {
      try {
        // Disk-gate pre-filter (cross-process shape): an existing title event
        // → don't even burn the lite call. This is a best-effort cost gate
        // outside the queue, not a correctness basis — the authoritative check
        // runs inside the serialize slot below (check and append in one slot).
        if (await this.store.hasTitleEvent(conversationId)) return;
        const raw = await generator(source);
        const title = sanitizeSessionTitle(raw ?? "");
        // EXIT: generation failed / timed out / empty → log-and-continue;
        // the header title keeps its extractTitle placeholder.
        if (title.length === 0) {
          console.warn(
            `[session-title] generation produced no title for ${conversationId}; placeholder kept`
          );
          return;
        }
        // appendTitle MUST go through the hub serialize queue (same posture
        // as appendEvents). This IIFE queues outside the current serialize
        // slot — enqueue only, never await, so it cannot reproduce the
        // "await the outer queue from inside a slot" deadlock that the
        // in-file warning describes. Check-then-act in one slot: the
        // authoritative hasTitleEvent check and appendTitle run sequentially
        // inside the same work callback — if another operation (save /
        // appendEvents / another title tail) enters this id's queue between
        // the pre-filter and the enqueue, its result is visible to the
        // in-slot check and cannot be reordered between check and append to
        // write a second title event.
        await this.serialize({
          conversationId,
          work: async () => {
            if (await this.store.hasTitleEvent(conversationId)) return;
            await this.store.appendTitle({
              id: conversationId,
              text: title,
            });
          },
        });
      } catch (err) {
        // EXIT: any unexpected failure (store typed error / generator throw)
        // → log-and-continue, placeholder kept.
        console.warn(
          `[session-title] generation skipped: ${describeTitleError(err)}`
        );
      }
    })();
  }

  /**
   * Switch the outward-visible skill face (slash side). Same shape as
   * `activateMcpFace` (the active face follows per-root engine switches), but
   * nothing is closed out — catalog / rescanner hold no resources, this is a
   * pure reference swap. The old engine's rescan seam is no longer visible
   * outward after replacement (other holders may still reference it, just not
   * through this hub).
   *
   * Absent fields do not overwrite (the old face stays): test-injected
   * `buildEngine` seams usually return only deps, keeping old behavior
   * byte-identical.
   */
  private activateSkillFace(entry: {
    readonly skillCatalog?: SkillCatalog;
    readonly skillRescanner?: SkillRescanner;
  }): void {
    if (entry.skillCatalog !== undefined) {
      this.skillCatalog = entry.skillCatalog;
    }
    if (entry.skillRescanner !== undefined) {
      this.skillRescanner = entry.skillRescanner;
    }
  }

  /**
   * Switch the outward-visible MCP face. The old manager is shut down first
   * (or kept as the sole failure surface), then the new manager / roots /
   * catalog are published — old+new must never both be "success".
   */
  private async activateMcpFace(entry: {
    readonly mcpManager?: McpManager;
    readonly mcpRoots?: McpRoots;
    readonly catalog?: AciCatalog;
  }): Promise<void> {
    const nextManager = entry.mcpManager;
    const prevManager = this.mcpManager;
    if (
      prevManager !== undefined &&
      nextManager !== undefined &&
      prevManager !== nextManager
    ) {
      await prevManager.shutdown();
    }
    if (entry.mcpRoots) {
      this.activeMcpRoots = entry.mcpRoots;
    }
    if (nextManager !== undefined) {
      this.mcpManager = nextManager;
    }
    if (entry.catalog !== undefined) {
      this.aciCatalog = entry.catalog;
    }
  }

  /**
   * Per-root engine cache. Session file `workspaceRoot` is the Map key
   * (picker `boundRoot` is only the fallback when listSkills etc. have no
   * session). Production assembly sets cwd/workspaceRoot/sandboxRoot equal.
   */
  private async getOrBuildEngine(root: string): Promise<HubEngineEntry> {
    const hit = this.engineByRoot.get(root);
    if (hit) {
      this.activeEngineRoot = root;
      this.activateSkillFace(hit);
      await this.activateMcpFace(hit);
      this.activateSubagentManager(hit.subagentManager);
      return hit;
    }
    const built = this.buildEngine
      ? await this.buildEngine(root)
      : await this.buildProductionEngine(root);
    const entry: HubEngineEntry = {
      deps: built.deps,
      shutdown: built.shutdown,
      subagentManager: built.subagentManager,
      graphAssembly: built.graphAssembly,
      autoMemory: built.autoMemory,
      overlayMemoryPrefetch: built.overlayMemoryPrefetch,
      ...(built.mcpRoots ? { mcpRoots: built.mcpRoots } : {}),
      ...(built.mcpManager ? { mcpManager: built.mcpManager } : {}),
      ...("catalog" in built && built.catalog
        ? { catalog: built.catalog }
        : {}),
      // Skill face (slash side): the per-root engine path used to drop the
      // skill surface (catalog only published on the fallback path) → after
      // serve binds a root, `listSkills` was always empty with no rescan seam.
      // An optional face beyond `EngineBundle`, passed through via structural
      // assignability.
      ...skillFaceOf(built),
      // The worktree gate holder is likewise an assembly face beyond
      // `EngineBundle`; absent (test injection seam) → key omitted.
      ...(built.worktreeOnMutate
        ? { worktreeOnMutate: built.worktreeOnMutate }
        : {}),
    };
    this.engineByRoot.set(root, entry);
    this.activeEngineRoot = root;
    this.activateSkillFace(entry);
    await this.activateMcpFace(entry);
    this.activateSubagentManager(entry.subagentManager);
    this.autoMemory = this.autoMemory ?? built.autoMemory;
    this.overlayMemoryPrefetch =
      this.overlayMemoryPrefetch ?? built.overlayMemoryPrefetch;
    // The holder is a global gate axis (not a per-root face), so the first
    // sighting anchors it; when the TUI host injects it via
    // `worktreeOnMutateHolder`, all engines already share one instance.
    this.worktreeOnMutate = this.worktreeOnMutate ?? built.worktreeOnMutate;
    return entry;
  }

  /**
   * Current snapshot of the fs-tier holder (holder absent → undefined). Read
   * fresh on every call: a tier flip only affects later calls and never
   * rebuilds engines (ADR-0092).
   */
  private fsModeSnapshot(): FsIsolationMode | undefined {
    if (this.fsMode === undefined) return undefined;
    return this.fsMode.get();
  }

  private activateSubagentManager(manager: SubAgentManager | undefined): void {
    this.subagentManager = manager;
    this.subagentManagers.register(manager);
  }

  private async buildProductionEngine(root: string): Promise<
    EngineBundle & {
      mcpRoots?: McpRoots;
      mcpManager?: McpManager;
      catalog?: AciCatalog;
      skillCatalog?: SkillCatalog;
      skillRescanner?: SkillRescanner;
      /** Full-view field of `BuiltEngine.worktreeOnMutate`. */
      worktreeOnMutate?: WorktreeGateReader;
    }
  > {
    if (!this.askUser) {
      throw new Error(
        "ask_inlet_missing: SessionHub lazy deps require AskUser (#162)"
      );
    }
    const env = this.envProvider ? this.envProvider() : loadIknowEnv();
    // productRoot is stable; workspaceRoot/cwd/sandboxRoot follow the current
    // task root. The last fallback changed from `root` to
    // `mainCheckoutOf(root)` (ADR-0037): when the host passes neither root
    // explicitly (serve default, callers beyond the TUI), after a rebind the
    // root IS the task tree, and using it directly as productRoot would move
    // project identity and per-root state onto the bare tree. Trees live at
    // `<main>/.iknow/worktrees/<conv>`; the main checkout is derived from the
    // same naming SSOT, so a session restored onto a tree after restart still
    // resolves to the main repo.
    const productRoot =
      this.productRoot ?? this.workspaceRoot ?? mainCheckoutOf(root);
    // The project identity root is separate from productRoot — the latter
    // serves mcpConfigRoot / state anchoring and comes from the host's
    // workspaceRoot, while identity wants the project the operator bound.
    // `bindWorkspace` does not require the bound path to be a repo root (only
    // absolute + existing), so `boundRoot` may be `/repo/packages/app`;
    // computing from `root` fresh would jump to the repo root after a rebind.
    const projectIdentityRoot =
      this.projectIdentityRoot ?? this.boundRoot ?? mainCheckoutOf(root);
    const built = await buildHarnessEngine({
      env,
      askUser: this.askUser,
      cwd: root,
      sandboxRoot: root,
      workspaceRoot: root,
      productRoot,
      projectIdentityRoot,
      // Reuse the startup settings object — a worktree-rooted
      // loadIknowSettings({cwd}) would silently drop project settings
      // (`.iknow/` is gitignored inside the worktree).
      ...(this.startupSettings ? { settings: this.startupSettings } : {}),
      // ADR-0037: mutate-gate host seam — the switch is read at the
      // build-engine startup load point; provision builds the tree and rebinds
      // only this session's root. Passthrough does not go through
      // conversation-agnostic `initiallyBound` — when the session already
      // lives in its own task worktree, provision lets it through idempotently
      // (returning the same root); another session's tree or an unrelated
      // worktree fails closed (typed foreign_worktree).
      worktreeIsolation: {
        // Pure pass-through lives in the shared SSOT worktree-host.ts
        // (consistency convergence after two manual per-field destructuring
        // wrappers dropped `name`): entry points must not hand-roll
        // field-by-field wrappers.
        ...createWorktreeHostProvision({
          provisionWorktree: (ctx) => this.provisionWorktree(ctx),
        }),
        // enter-worktree tool seam — a session explicitly enters an existing
        // task worktree of this repo (including another session's tree); the
        // authorization anchor is the persisted session.workspaceRoot.
        worktreeEnter: ({
          conversationId,
          root: sessionRoot,
          targetConversationId,
        }) =>
          this.enterWorktree({
            conversationId,
            root: sessionRoot,
            targetConversationId,
          }),
        // exit-worktree tool seam — the session returns to the main-repo
        // root; the tree is kept, not deleted.
        worktreeExit: ({ conversationId, root: sessionRoot }) =>
          this.exitWorktree({ conversationId, root: sessionRoot }),
        // task-worktree-lifecycle: read-only discovery and explicit cleanup
        // use the same host/provisioner SSOT and remain outside ROOT_FLIP.
        worktreeList: ({ root: sessionRoot, includeStale }) =>
          this.listTaskWorktrees({
            root: sessionRoot,
            ...(includeStale === true ? { includeStale: true } : {}),
          }),
        worktreeRemove: (request) => this.removeTaskWorktree(request),
      },
      ...(this.surface ? { surface: this.surface } : {}),
      ...(this.sessionGrants ? { session: this.sessionGrants } : {}),
      ...(this.permissionMode ? { permissionMode: this.permissionMode } : {}),
      // ADR-0030: overlay holder pass-through — serve / TUI `/graph` and
      // Shift+Tab flip the same instance (all entrypoints share one holder).
      ...(this.graphMode ? { graphMode: this.graphMode } : {}),
      // ADR-0092: fs isolation holder pass-through — `/config` flips the same
      // instance (the bash factory reads per call). Holder absent → key
      // omitted (engine-side `opts.fsMode?.get() ?? "global"` resolves the
      // same as a static string default).
      ...presentFields("fsMode", this.fsMode),
      // ADR-0071: todos land in the "session folder" — `todoDir`
      // is the "session project directory" (the read-only projection exposed
      // by SessionStore.getProjectDir()). All three entrypoints (cli / serve /
      // TUI) share the same `(baseDir, projectIdentityRoot)` pair → one
      // session resolves to one projectDir (the `<surface>` split is gone).
      todoDir: this.store.getProjectDir(),
      // ADR-0088: background-task registry root = sibling `tasks/` of the
      // same project tree. The store's projectDir is already
      // `<poolRoot>/projects/<slug>` (the ADR-0071 formula), so task registry
      // and session folder share one slug instead of anchoring workspaceRoot.
      tasksDir: join(this.store.getProjectDir(), TASKS_DIR_NAME),
      memoryDir: join(this.store.getProjectDir(), MEMORY_DIR_NAME),
      // Two-segment seam — at assembly time only projectDir is passed
      // (`<baseDir>/projects/<slug>`); the manager derives the
      // per-conversation leaf `<projectDir>/<convId>/subagents/` at spawn
      // time from def.conversationId (isomorphic to todoDir's
      // resolveConversationTodoPath). When a session is deleted,
      // SessionStore.delete removes the whole `<convId>/` folder, subagent
      // records included, leaving no project-level orphan. The old flat
      // project-level `<projectDir>/subagents/`
      // (`resolveSubagentTraceDirShared`) is retired, as is
      // `createTrace("subagent")` (the conversationId-aggregated single file).
      projectDir: this.store.getProjectDir(),
      // specs/subagent-card-title.md: the read-only subagent list also carries
      // the tool each live worker is executing now. That reading belongs to the
      // worker-ledger codec (this layer), so the hub injects the reader and
      // build-engine threads it to the manager as an opaque seam — the harness
      // never imports the store.
      subagentActivityReader: readWorkerInFlightToolName,
      // Live-graph ledger host pass-through — resolve the per-session ledger
      // by ctx.conversationId; destroyed on resetSession / shutdown.
      ...(this.liveGraphLedger
        ? { liveGraphLedger: this.liveGraphLedger }
        : {}),
      ...(this.traceOut !== undefined
        ? { subagentDiagnosticsDir: this.traceOut }
        : {}),
    });
    this.mcpHome = homedir();
    // mcpManager / catalog / mcpRoots are switched uniformly via
    // getOrBuildEngine → activateMcpFace, so an eager overwrite here cannot
    // leave the old manager unclosed.
    return built;
  }

  /**
   * Lazy deps construction. Delegates to the shared harness assembly
   * (`src/harness/build-engine.ts`) so the serve path picks up the same ACI
   * 8-tool set as the CLI (bash / read_file / grep / glob / edit_file /
   * write_file / web_fetch / web_search). Without this delegation the
   * serve mode was stuck on the echo/get_time stubs and the web SPA could
   * not exercise the new tools.
   */
  private async ensureDeps(sessionRoot?: string): Promise<LoopEngineDeps> {
    if (this.injectedDeps) {
      // Injected-deps hosts build the engine themselves (TUI); the snapshot
      // handle comes in via constructor opts. Pure test-injection paths have
      // no engine → undefined, zero behavior change.
      // When the host declares injectedEngineRoot and the session root has
      // left that root (worktree rebind), fall through to per-root engine
      // rebuild (buildEngine seam / production assembly) so behavior matches
      // hub.ts's two assembly paths; undeclared → short-circuit semantics
      // byte-identical to before.
      const mapRoot = sessionRoot ?? this.activeEngineRoot ?? this.boundRoot;
      if (
        mapRoot !== undefined &&
        this.injectedEngineRoot !== undefined &&
        mapRoot !== this.injectedEngineRoot
      ) {
        const entry = await this.getOrBuildEngine(mapRoot);
        this.activeGraphAssembly = entry.graphAssembly;
        return entry.deps;
      }
      this.activeGraphAssembly = this.injectedGraphAssembly;
      return this.cachedDeps ?? this.injectedDeps;
    }
    const mapRoot = sessionRoot ?? this.activeEngineRoot ?? this.boundRoot;
    if (mapRoot !== undefined) {
      // With per-root multi-engine, the active snapshot follows the engine
      // resolved this time. Prefer activeEngineRoot so MCP list/reload is not
      // pulled back to the main-repo face by bindRoot.
      const entry = await this.getOrBuildEngine(mapRoot);
      this.activeGraphAssembly = entry.graphAssembly;
      return entry.deps;
    }
    if (this.cachedDeps) return this.cachedDeps;
    if (!this.askUser) {
      throw new Error(
        "ask_inlet_missing: SessionHub lazy deps require AskUser (#162)"
      );
    }
    // After envProvider is injected, use it to obtain env (replacing the
    // internal loadIknowEnv()). Default → existing behavior zero change (still
    // internal loadIknowEnv).
    const env = this.envProvider ? this.envProvider() : loadIknowEnv();
    // Delegate validation and assembly to the SSOT. `buildHarnessEngine`
    // validates apiKey/askUser through the shared fail-loud path, preserving
    // the same ValidationError → HTTP 400 mapping for serve callers.
    // The returned `engine` is built once (code-review 2026-08-05) and
    // discarded — serve only consumes `deps`, and the cost is a single
    // `createLoopEngine` allocation, not a per-message re-construction.
    // The serve entry injects the session-folder todoDir
    // (`this.store.getProjectDir()`); per-conversationId resolution happens at
    // call time in todo-write.ts:resolveConversationTodoPath — no per-session
    // engine rebuild needed (what cachedDeps shares is only the "root"; the
    // leaf branches by ctx.conversationId).
    // Subagent lifecycle events land on disk (production assembly): the hub's
    // subagentManager is a shared singleton (build-engine.ts self-builds it
    // once when surface!=="ask"), aggregating all serve sessions' subagent
    // events into <traceOut>/subagent.jsonl (conversationId="subagent"); the
    // reader side filters per-record by task_id. Injected only when this
    // traceOut is configured (serve.ts always passes the resolveTracePath
    // result); absent → the manager uses build-engine's default
    // NoopTraceService (byte-stable).
    const built = await buildHarnessEngine({
      env,
      askUser: this.askUser,
      ...(this.sandboxRoot ? { sandboxRoot: this.sandboxRoot } : {}),
      // Review High-2 (hard req 9): fallback path reuses the startup settings
      // object too (rebind-rebuilt engines must not reload settings).
      ...(this.startupSettings ? { settings: this.startupSettings } : {}),
      // ADR-0037: the un-bound-root fallback path also wires the isolation
      // host seam (repoRoot = sandboxRoot ?? process.cwd(); sessions lacking a
      // workspaceRoot take the per-root engine path on the turn after a
      // rebind). As above: passthrough is anchored per session by provision,
      // no initiallyBound.
      worktreeIsolation: {
        // Pure pass-through lives in the shared SSOT worktree-host.ts
        // (consistency convergence after two manual per-field destructuring
        // wrappers dropped `name`): entry points must not hand-roll
        // field-by-field wrappers.
        ...createWorktreeHostProvision({
          provisionWorktree: (ctx) => this.provisionWorktree(ctx),
        }),
        // enter-worktree tool seam — a session explicitly enters an existing
        // task worktree of this repo (including another session's tree); the
        // authorization anchor is the persisted session.workspaceRoot.
        worktreeEnter: ({
          conversationId,
          root: sessionRoot,
          targetConversationId,
        }) =>
          this.enterWorktree({
            conversationId,
            root: sessionRoot,
            targetConversationId,
          }),
        // exit-worktree tool seam — the session returns to the main-repo
        // root; the tree is kept, not deleted.
        worktreeExit: ({ conversationId, root: sessionRoot }) =>
          this.exitWorktree({ conversationId, root: sessionRoot }),
        // task-worktree-lifecycle: read-only discovery and explicit cleanup.
        worktreeList: ({ root: sessionRoot, includeStale }) =>
          this.listTaskWorktrees({
            root: sessionRoot,
            ...(includeStale === true ? { includeStale: true } : {}),
          }),
        worktreeRemove: (request) => this.removeTaskWorktree(request),
      },
      ...(this.surface ? { surface: this.surface } : {}),
      ...(this.sessionGrants ? { session: this.sessionGrants } : {}),
      ...(this.permissionMode ? { permissionMode: this.permissionMode } : {}),
      // ADR-0030: overlay holder pass-through — serve / TUI `/graph` and
      // Shift+Tab flip the same instance (all entrypoints share one holder).
      ...(this.graphMode ? { graphMode: this.graphMode } : {}),
      // ADR-0092: fs isolation holder pass-through — `/config` flips the same
      // instance (the bash factory reads per call). Holder absent → key
      // omitted (engine-side `opts.fsMode?.get() ?? "global"` resolves the
      // same as a static string default).
      ...presentFields("fsMode", this.fsMode),
      // Live-graph ledger host pass-through — same shape as the production path.
      ...(this.liveGraphLedger
        ? { liveGraphLedger: this.liveGraphLedger }
        : {}),
      // Pass the workspaceRoot already resolved by the serve entry so
      // build-engine's bash fence aligns with serve's identity seed / dataDir
      // (the same per-root anchor, no fallback to sandboxRoot|cwd).
      ...(this.workspaceRoot ? { workspaceRoot: this.workspaceRoot } : {}),
      // Stable productRoot (absent → build-engine bridges it to workspaceRoot).
      ...(this.productRoot ? { productRoot: this.productRoot } : {}),
      // ADR-0071: todos land in the session folder — `todoDir`
      // takes the store-projected projectDir, same source as the
      // `buildProductionEngine` path above (the `<surface>` split is gone).
      todoDir: this.store.getProjectDir(),
      // ADR-0088: same as the `buildProductionEngine` path — registry root =
      // sibling `tasks/` of the project tree (same store-projected slug).
      tasksDir: join(this.store.getProjectDir(), TASKS_DIR_NAME),
      memoryDir: join(this.store.getProjectDir(), MEMORY_DIR_NAME),
      // Same as buildProductionEngine: two-segment seam — projectDir at
      // assembly time, per-conversation leaf derived by the manager at spawn
      // via def.conversationId (see the resolveSubagentTraceDirShared
      // retirement note).
      projectDir: this.store.getProjectDir(),
      // Same as the per-root path above: the activity projection reader is
      // injected from the layer that owns the worker-ledger codec.
      subagentActivityReader: readWorkerInFlightToolName,
      ...(this.traceOut !== undefined
        ? { subagentDiagnosticsDir: this.traceOut }
        : {}),
    });
    this.cachedDeps = built.deps;
    // Active snapshot for the single-engine (unbound root) path.
    this.activeGraphAssembly = built.graphAssembly;
    // Catalog and rescan seam are published together (catalog alone is not
    // enough — without the seam, `listSkills` forever reads the
    // assembly-time snapshot and the slash face never goes hot in-place).
    this.activateSkillFace(built);
    this.mcpHome = homedir();
    await this.activateMcpFace({
      ...(built.mcpManager ? { mcpManager: built.mcpManager } : {}),
      ...(built.mcpRoots ? { mcpRoots: built.mcpRoots } : {}),
      ...(built.catalog ? { catalog: built.catalog } : {}),
    });
    // Serve lazily takes the subagent manager — buildHarnessEngine
    // self-builds one when surface !== "ask"; every assembly's manager joins
    // the permanent aggregation face, while the active manager only serves
    // spawn / the verify classifier.
    this.activateSubagentManager(built.subagentManager);
    // Auto-memory: lazily taken like subagentManager (constructor injection wins).
    this.autoMemory = this.autoMemory ?? built.autoMemory;
    this.overlayMemoryPrefetch =
      this.overlayMemoryPrefetch ?? built.overlayMemoryPrefetch;
    // The fallback lazy path anchors the gate holder from the same source as
    // the per-root path.
    this.worktreeOnMutate = this.worktreeOnMutate ?? built.worktreeOnMutate;
    // Cache built.shutdown (composite handle: mcpManager first, then
    // subagentManager). The serve entry triggers it via hub.shutdown() before
    // exit — cli.ts runServe registers registerShutdown(hub), cleaning up MCP
    // connections and subagent stdio children at process exit. Test-injected
    // deps paths have no built → shutdown absent → hub.shutdown() is a no-op.
    this.cachedShutdown = this.cachedShutdown ?? built.shutdown;
    return this.cachedDeps;
  }

  private overlayForSession(
    sessionRoot: string | undefined
  ): OverlayPrefetchFn | undefined {
    const mapRoot = sessionRoot ?? this.boundRoot;
    if (mapRoot !== undefined) {
      const entry = this.engineByRoot.get(mapRoot);
      if (entry?.overlayMemoryPrefetch !== undefined) {
        return entry.overlayMemoryPrefetch;
      }
    }
    return this.overlayMemoryPrefetch;
  }

  /**
   * auto-memory T1: per-conversation injected-id set, lazily recovered on
   * first attach by scanning the already-loaded history (cold start from
   * checkpoint / session JSONL) for advisory blocks. The empty set is cached
   * too; recovery failure degrades to an empty set (log-and-continue inside
   * recoverInjectedMemoryIds) so the turn can never fail on resume parsing.
   */
  private prefetchInjectedIdsFor(
    conversationId: string,
    messages: ReadonlyArray<AnthropicNativeMessage>
  ): Set<string> {
    const cached = this.prefetchInjectedIds.get(conversationId);
    if (cached !== undefined) return cached;
    const recovered = recoverInjectedMemoryIds(messages);
    this.prefetchInjectedIds.set(conversationId, recovered);
    return recovered;
  }

  /**
   * auto-memory T1: merge the ids a finished attach actually injected.
   * Identity fallbacks (empty overlay / overlay fn throw → raw user text)
   * carry no advisory block and add nothing.
   */
  private recordPrefetchOverlayIds(
    conversationId: string,
    effectiveText: string
  ): void {
    let injected = this.prefetchInjectedIds.get(conversationId);
    if (injected === undefined) {
      injected = new Set<string>();
      this.prefetchInjectedIds.set(conversationId, injected);
    }
    recordInjectedMemoryIds(injected, effectiveText);
  }

  /**
   * ADR-0031: hand a finished turn to the auto-memory
   * hook. The hook owns the `completed` gate and the N-turn gate; the hub
   * only reports. A hook failure must never fail postMessage.
   */
  private notifyAutoMemory(
    result: RunResult,
    priorMessageCount: number,
    workspaceRoot?: string,
    conversationId?: string
  ): void {
    // EXIT: prefer the per-root hook for bound sessions; constructor injection
    // remains the fallback for injected-deps hosts without a per-root cache.
    const autoMemory =
      workspaceRoot === undefined
        ? this.autoMemory
        : (this.engineByRoot.get(workspaceRoot)?.autoMemory ?? this.autoMemory);
    const sessionKey =
      this.surface === "serve"
        ? conversationId
        : this.surface === "tui"
          ? "tui"
          : "chat";
    notifyAutoMemory({
      hook: autoMemory,
      stopReason: result.stopReason,
      transcript: renderTranscript(result.messages),
      sessionKey,
      memorySaveSucceeded: hasSuccessfulMemorySave(
        result.messages.slice(priorMessageCount)
      ),
      onError: (error) =>
        console.warn(
          `[memory/auto] turn hook skipped: ${
            error instanceof Error ? error.message : String(error)
          }`
        ),
    });
  }

  private summarize(opts: { readonly file: SessionFileV1 }): SessionSummary {
    const { file } = opts;
    return {
      conversation_id: file.conversation_id,
      json_mode: file.jsonMode,
      turn_count: file.turnCount,
      prior_count: 0,
    };
  }

  private toTurnDto(opts: {
    readonly query: string;
    readonly result: RunResult;
    /** T1: this run's own messages (priorMessages sliced away); used for
     * the per-turn thinking/toolCalls projection. */
    readonly turnMessages?: ReadonlyArray<AnthropicNativeMessage>;
    /** T6: best-effort closing summary text (captured by postMessage on abnormal stops). */
    readonly stopSummary?: string;
    /** B1: session.messages before the run — same source as conditionalSave,
     * used for the cancelled decision shouldPersistCheckpoint (delta>0 →
     * interrupted=true). Ignored for non-cancelled; absent (catch branches
     * etc.) → cancelled defaults to false. */
    readonly priorMessages?: ReadonlyArray<AnthropicNativeMessage>;
    /** Verify final verdict view (failed/unstable/escalated). Absent = no
     * verify, or the verdict is passed/disabled/aborted (byte-stable). */
    readonly verify?: VerifyAnswerView;
    /** D2 (tui-display-consistency) wire surface: this turn's assistant
     *  thinking time (ms). Written on the postMessage / continuePending paths
     *  once commitMessages receives turnResult.thinkingMs; attached to the
     *  TurnAnswerDto `thinkingMs` field when > 0. Absent = old session / no
     *  thinking / invalid bounds (byte-stable, same pattern as
     *  thinking/toolCalls/lastUsage). */
    readonly thinkingMs?: number;
  }): TurnDto {
    const { query, result } = opts;
    // Serve SPA output boundary — mask known secret values in the
    // final text before it leaves the hub. The mask is rebuilt per call so
    // it sees the env snapshot at serve-time (cheap; a few short regexes).
    const mask = createOutputMask(currentSecretValues()).mask;
    const rawFinalText = result.finalText ?? "";
    const maskedFinalText = mask(rawFinalText);
    const turnMessages = opts.turnMessages ?? result.messages;
    const thinking = projectThinkingView(turnMessages, mask);
    const toolCalls = projectToolCalls(turnMessages, mask);
    return {
      query,
      answer: {
        finalText: maskedFinalText,
        stopReason: result.stopReason,
        turnCount: result.turnCount,
        // T1: optional fields — omitted entirely when undefined (byte-stable
        // for turns without thinking or tool use).
        ...(thinking !== undefined ? { thinking } : {}),
        ...(toolCalls !== undefined ? { toolCalls } : {}),
        // Context-usage display: pass through result.lastUsage when non-null;
        // null → field absent (byte-stable; same pattern as
        // thinking/toolCalls; ADR-0008).
        ...(result.lastUsage !== null ? { lastUsage: result.lastUsage } : {}),
        // The closing summary attaches only on abnormal stops; completed never
        // emits stop_summary, so a host-provided stopSummary is never
        // mis-attached (byte-stable: absent on normal stops).
        ...(opts.stopSummary !== undefined &&
        opts.stopSummary.length > 0 &&
        result.stopReason !== "completed"
          ? { stopSummary: opts.stopSummary }
          : {}),
        // B1: interruption feedback — `interrupted` only on cancelled
        // (true = checkpoint saved / false = no new content, not persisted).
        // Other stopReasons omit the field (byte-stable, same pattern as
        // thinking/toolCalls/lastUsage).
        ...(result.stopReason === "cancelled"
          ? {
              interrupted: shouldPersistCheckpoint(
                result,
                opts.priorMessages ?? []
              ),
            }
          : {}),
        // Surface the verify final verdict (failed/unstable/escalated).
        // Present only when verify is configured and the verdict is not
        // passed/disabled/aborted (byte-stable).
        ...(opts.verify !== undefined ? { verify: opts.verify } : {}),
        // D2 (tui-display-consistency): pass through thinkingMs (ms). Attached
        // only when > 0; absent = old session / no thinking turn / invalid
        // bounds (byte-stable).
        ...(opts.thinkingMs !== undefined && opts.thinkingMs > 0
          ? { thinkingMs: opts.thinkingMs }
          : {}),
        // ADR-0094: pass through the gateway-side summary on transport
        // failure. undefined → field absent (byte-stable); the TUI renders
        // "API error (status): message" from it.
        ...withApiError({}, result.apiError),
      },
    };
  }
}

function mcpServerOfToolName(name: string): string {
  const body = name.startsWith("mcp__") ? name.slice("mcp__".length) : name;
  const sep = body.indexOf("__");
  if (sep === -1) return name;
  return body.slice(0, sep);
}
