/**
 * In-process multi-conversation host over harness foundation runtime.
 * 022 T4: load → run(priorMessages) → conditional save → wire projection.
 * Messages single-source is the session file; hub holds no messages copy.
 * 064 T5: per-session JSONL trace when traceOut is configured (ADR-0003 D4).
 *
 * 162: askUser is required at engine construction. Hub accepts `askUser`
 * via SessionHubOptions (tests inject createNoAskUser()); production callers
 * (serve.ts) supply the SPA-channel implementation or a v0 stub.
 */
import { randomUUID } from "node:crypto";
import {
  run,
  createJsonlTraceService,
  compactMessages,
  runFullCompact,
  splitForCompaction,
  type AnthropicNativeMessage,
  type HarnessStreamEvent,
  type LoopEngineDeps,
  type RunResult,
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
import { getVersion } from "../cli/usage.js"; // SC-W 6/7: agentVersion 注入(与 session-api/http.ts 同向 import,无循环)
import {
  createTaskWorktreeProvisioner,
  mainCheckoutOf,
  type TaskWorktreeProvisioner,
} from "./worktree-rebind.js";
import type {
  TaskWorktreeInfo,
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
import { TASKS_DIR_NAME } from "../shared/session-tree-names.js";
import { LLM_API_KEY_MISSING_MESSAGE } from "../config/messages.js";
import {
  MaxTurnsExceeded,
  McpLifecycleError,
  errorMessage,
} from "../harness/errors.js";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { AciCatalog } from "../harness/aci/types.js";
import type { SkillCatalog } from "../harness/skill/catalog.js";
import { createSkillBody, exceedsUserInputCap } from "../harness/skill/body.js";
import type { McpManager } from "../harness/mcp/manager.js";
import { loadMcpConfig } from "../harness/mcp/config.js";
import { resolveMcpRoots, type McpRoots } from "../harness/mcp/roots.js";
import { SessionStore, type SessionListEntry } from "./store/index.js";
import type { SessionStoreError } from "./store/index.js";
import type { SessionFileV1 } from "./store/index.js";
import { resolveConversationTraceFilePath } from "./store/index.js";
import {
  appendCheckpoint,
  CURRENT_SCHEMA_VERSION,
  extractTitle,
  pinGoal,
  shouldPersistCheckpoint,
  toInterruptReason,
  validateGoalText,
} from "./store/index.js";
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
 * #408 T3: detect a goal re-pin directive at the very start of a message.
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
 * settings-hot-reload（reviewer major）:热重建去重的关键字段值比较。
 *
 * EnvLoader.get() 每次 reload 都返回**新对象**（loadIknowEnv 每次全新构造），
 * 对象身份比较不可用。判定「settings 文件 touch 但内容没变」必须以字段值比较：
 * 全部 createAdapterFromEnv 入参：model / apiKey / baseUrl / headers /
 * maxOutputTokens / temperature / stream + thinking 控制器 thinking /
 * thinkingEffort。fallback 与 adapter 无关但反映配置变更，也纳入比较
 * （数组逐元素、顺序敏感）。
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
 * headers 逐键比较（两轴 review Medium：headers 已是 createAdapterFromEnv
 * 入参，漏比较会让「只改 provider.headers」被判成 touch 未变内容 → adapter
 * 不重建 → 新头不上 wire）。
 *
 * 缺席 ⇔ 无键（env 层保证「有值才有该键」，见 LlmEnv.headers 注释），故
 * `undefined` 与 `undefined` 相等、`undefined` 与任何映射不等；键集合与每个
 * 键的值都比较（顺序无关）。
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

/** 字符串数组逐元素、顺序敏感比较（fallback 与 headers 同一判定形态）。 */
function sameStringArray(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((value, i) => value === b[i]);
}

// -- error mapping (裁决#10: pure function, http.ts T5 consumes) ---------------

/**
 * Status + message per SessionStoreError kind. Data table replaces the prior
 * 6-case switch so mapStoreError stays a flat lookup (SC24 >60 hard-split gate).
 * retryable is implicit via 5xx status (D1.2: not in wire).
 */
type StoreErrorEntry = {
  status: number;
  message: (err: SessionStoreError) => string;
};

/**
 * plan compress-trigger-gate T2 review fix:压缩失败的 reason SSOT。三处失败分支
 * (signal_aborted / 占位 fallback 也无效 / 防御兜底)收敛到一字面量,避免
 * divergent-change drift。
 */
const REASON_NO_COMPRESS: CompactReason = "messages_too_few";

/**
 * plan compress-trigger-gate T2 review fix:reason 决定 SSOT。窗口压缩成功 →
 * "windowed";LLM 摘要成功 → "full_summary"(无论判据 action,因 nextMessages
 * 实际是 SUMMARY_PREAMBLE + 摘要,用户应看到"摘要"文案,而不是"裁早期"文案)。
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
 * 可选 opts 字段的缺席/在场壳（tui/deps.ts:presentFields 同款，memory-toggle-live
 * S5 整改的既有先例）：值在场才产出 `{ [key]: value }`，缺席产出空对象。
 * 取代 `...(x ? { k: x } : {})` —— 后者两个分支都进 complexity 计数，而
 * 宿主侧解构语义不变（缺席 = key 不出现）。
 *
 * `=== undefined` 是唯一判据：null / false / 0 都算「值在场」。
 */
function presentFields<V>(
  key: string,
  value: V | undefined
): { readonly [k: string]: V } {
  if (value === undefined) return {};
  return { [key]: value };
}

/**
 * 非空文本字段的在场壳 —— `undefined` 与 `""` 都算缺席。
 *
 * 与 `presentFields` 分开而不是合并成一个「falsy 即缺席」的松散版：`""`
 * 是缺席还是合法值属于**调用方的契约**（`stopSummary` 是前者），合并会
 * 让另一个调用方把 `false` / `0` 这类合法值悄悄丢掉。
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
 * changing T3 continue/stop; unknown throws rethrow (store contract).
 *
 * Render contract: typed kinds other than `not_found` are echoed to stderr as
 * `${kind}: ${conversation_id}` — mirrors chat's `skipChatAutoOnLoadError`
 * (code-quality.md typed-error catch 契约; chat-session.ts:961-967).
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

// -- verify outcome → goal status (#458 T5 SC8) ------------------------------

/**
 * Verify-loop terminal outcome → goal status write-back target.
 *
 * `undefined` = no status change (only trace 留痕 via recordGoal).
 * Mimics STORE_ERROR_MAP's data-table shape (ACR #4 thin wiring).
 *
 * - `passed`     → "achieved"
 * - `aborted`    → "aborted"
 * - `escalated`  → "aborted"  (NEW in #458 SC8; pre-#458 kept active)
 * - `failed`     → "active"   (result stays active; trace 留痕)
 * - `unstable`   → "active"   (result stays active; trace 留痕)
 * - `disabled`   → undefined  (no status change; trace 留痕)
 */
const OUTCOME_TO_STATUS: Record<VerifyLoopOutcome, GoalStatus | undefined> = {
  passed: "achieved",
  aborted: "aborted",
  escalated: "aborted",
  failed: "active",
  unstable: "active",
  disabled: undefined,
} as const;

// -- history projection (裁决#11: getSession turns) -----------------------------
// 文本拼接 messageText 与 turn 边界判定 isTurnQuery 收敛在 turn-projection.ts
//（store/checkpoint.ts 共用同一 SSOT）。

/**
 * Project raw AnthropicNativeMessage[] → display-form TurnDto[] for wire.
 * Pairs each user message with its subsequent assistant message.
 * Projection is non-authoritative: stopReason/turnCount are lossy (裁决#11).
 *
 * T1: also projects thinking/toolCalls per turn (messages between this user
 * query and the next real query message, per `isTurnQuery`). Mask = SC20
 * boundary.
 *
 * D2 (tui-display-consistency) wire surface: `thinkingMs` 是与 `messages`
 * 一一对应的并行数组 (SessionFileV1.thinkingMs). 求和每个 turn slice 内
 * 所有 assistant 消息对应的 thinkingMs 值; sum > 0 时挂到 TurnAnswerDto
 * `thinkingMs` (ms) 字段. 缺席 = 旧会话 / 非 assistant turn / sum = 0,
 * 与 thinking/toolCalls/lastUsage 同 byte-stable 模式.
 */
/**
 * review-fix (M5):serve 路径子代理记录落点 —— hub engine 跨会话共享
 * (不重建 per-conversationId,见 cachedDeps 注释),装配期拿不到单会话
 * conversationId。改走两段式缝:装配期传 `projectDir`
 * (`<baseDir>/projects/<slug>`),manager 在 spawn 期按 `def.conversationId`
 * 派生 per-conversation 叶子 `<projectDir>/<convId>/subagents/`
 * (与 todo-write 的 `resolveConversationTodoPath` 同构)。会话删除时
 * `SessionStore.delete` 整删 `<convId>/` 文件夹,子代理记录同灭,
 * 不在项目层留孤儿 —— 旧的项目层平铺形状(假注释「spec SC8 操作员补丁
 * 接受」)已退役。
 */

export function projectMessagesToTurns(
  messages: ReadonlyArray<AnthropicNativeMessage>,
  thinkingMs?: ReadonlyArray<number | null>
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
  return turns;
}

/**
 * End index of the turn slice that starts at `messages[i]` (the query): the
 * index of the next real query message (per `isTurnQuery`), or
 * `messages.length` when the turn runs to the end of history. Pulled out to
 * keep `projectMessagesToTurns` ≤10 cyclomatic and the slice-bounds logic in
 * one place (M2 / ACR complexity anti-drift).
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
   * JsonlTraceService bound to session.conversation_id (ADR-0003 D4).
   * Per-session instance -> cachedDeps does not cache the trace. */
  traceOut?: string;
  /** askUser inlet (#162). Required when not injecting `deps`; the
   * construction-time check below throws otherwise (#162 / SC18).
   * Tests injecting `deps` are unaffected. */
  askUser?: AskUser;
  /** Full serve AskUser handle (ask + resolveAsk + pendingAll). When provided,
   * the web SPA can list + resolve pending permission requests. */
  askHandle?: ServeAskUserHandle;
  /** Session allow-list source. "always-allow" decisions from the web UI land
   * here so subsequent identical tool calls are not re-confirmed. Memory-only. */
  sessionGrants?: SessionGrants;
  /** W2: permission mode context (default / plan / full_auto). Absent →
   *  buildHarnessEngine defaults to "default". */
  permissionMode?: PermissionModeContext;
  /**
   * D-α T3 / ADR-0030: graph 编排 overlay 的会话 holder（serve / TUI 与 CLI
   * 共用同一形态）。透传给 buildHarnessEngine —— `run_graph` 与编排段按
   * 每条 postMessage 拍下的快照 gate。缺席 = 本入口未接 overlay。
   */
  graphMode?: GraphModeContext;
  /**
   * ADR-0092 / SC13: filesystem isolation 档 holder（serve / TUI 与 CLI 共用
   * 同一形态）。透传给 buildHarnessEngine —— bash 工厂 per-call 读
   * （`BuildEngineOpts.fsMode`）。缺席 = 本入口未接 fs 档（引擎按全局档）。
   */
  fsMode?: FsModeContext;
  /**
   * D-α T5:已建好 engine 的 host（TUI 在 run.tsx 就装配完）把
   * `BuiltEngine.graphAssembly` 直接交进来 —— 这类 host 走注入 deps 路径，
   * hub 自己不 build，拿不到快照句柄。缺席 = 未接 overlay（行为零变化）。
   */
  graphAssembly?: GraphAssembly;
  /**
   * live-graph-phase1 T1 / ADR-0047 / ADR-0051:活图账本 host。hub 跨多
   * 会话持有同一份账本 host,按 `ctx.conversationId` 解析。`resetSession`
   * 销毁单会话账本；`shutdown` 销毁全部。缺省 = `run_graph` handler 不
   * 建账（与 graphAssembly 缺省同形态）。
   */
  liveGraphLedger?: LiveGraphLedgerHost;
  /** T2: env source for per-turn thinking override (test seam; production
   * omits it → withThinkingOverride falls back to loadIknowEnv()). */
  overrideEnv?: { readonly llm: LlmEnv };
  /**
   * Sandbox root for fs-tool access (code-review 2026-08-05). When omitted,
   * `buildHarnessEngine` defaults to `process.cwd()` — see that module's
   * sandboxRoot note (CLI: project root; serve: server-launch dir, which
   * is NOT equivalent to user project root). Production callers should pass
   * an explicit sandboxRoot when the server's cwd is not the intended
   * workspace; CLI flag wiring is tracked in the backlog.
   */
  sandboxRoot?: string;
  /**
   * #196 IKNOW T5:入口 surface — 决定 BOOTSTRAP 是否激活。serve 路径固定传
   * "serve"（skip BOOTSTRAP，spec A12 矩阵）；测试可省略 → 默认 "chat"。
   */
  surface?: "chat" | "tui" | "ask" | "serve";
  /**
   * #356 T7:subagent manager — host drain 消费面。serve 入口经
   * buildHarnessEngine 自建 (surface !== "ask");hub 构造时未注入时,
   * ensureDeps() 后从 built.subagentManager 懒取。未配置 (ask 形态) →
   * 无 drain,行为零变化。
   */
  readonly subagentManager?: SubAgentManager;
  /**
   * auto-memory T4 / ADR-0031 D1:自动记忆 host 钩子。serve 入口经
   * `buildHarnessEngine` 自建(memory 层在场且非 ask);
   * 构造时未注入则 `ensureDeps()` 后从 `built.autoMemory` 懒取。缺席
   * (memory 层关 / ask / 注入 deps 的测试)→ 不调; 两个开关全关时钩子仍在场,只跑零 LLM 机械段。
   */
  readonly autoMemory?: AutoMemoryHook;
  /**
   * auto-memory low-trust read: per-turn prefetch overlay. Shares the
   * memory-layer / non-`ask` gate with autoMemory, but the handle also
   * requires `autoExtract` at assembly (TUI may instead hold it with live
   * flags and re-check `memoryFlags.autoExtract` each turn). Host prepends
   * onto the user payload; never deps.system.
   * T1: hosts pass `excludeIds` (session-level dedup) via the second arg.
   */
  readonly overlayMemoryPrefetch?: OverlayPrefetchFn;
  /**
   * review-fix (M1 / H1): per-root state anchor。serve 入口解析后
   * 透传 —— 让 hub 的 buildHarnessEngine 走 entry-resolved workspaceRoot,
   * 保证 serve 与 CLI flag 路径同形态(per-root 状态锚 = 记忆库 / skill
   * seam / 项目 `AGENTS.md` 发现)。seed 落 `~/.iknow`(#196 T5,与
   * workspaceRoot 无关);会话池 / tasks 落点见 ADR-0087 / ADR-0088。
   * 缺席 → build-engine 走 cwd fallback(legacy 默认)。
   */
  readonly workspaceRoot?: string;
  /**
   * T6 / worktree-mcp-rebind-lifecycle:稳定主 checkout / bind root。
   * 首次装配捕获后跨 rebind 不变；`buildProductionEngine` 透传给
   * `buildHarnessEngine.productRoot`，由此派生 `mcpConfigRoot`。缺席 →
   * 回退 `workspaceRoot` / 当前装配 root（T6 前单根形态）。
   */
  readonly productRoot?: string;
  /**
   * Review round 3 (ADR-0037 §4): 项目身份根 —— 宿主启动时钉一次，跨 rebind
   * 不变。`buildProductionEngine` 透传给 `buildHarnessEngine`。
   *
   * 缺席回退链是 `boundRoot`（picker / `--workspace-root` 绑定的那个路径）再到
   * `mainCheckoutOf(root)`：`bindWorkspace` 只校验绝对且存在，**不**要求是仓根，
   * 所以绑到 `/repo/packages/app` 完全合法；改绑后拿 `root` 现算会让身份与记忆
   * 库命名空间从子目录跳到仓根。
   */
  readonly projectIdentityRoot?: string;
  /**
   * #128 T8:验证闭环配置 (settings.verify 段经 serve.ts 构造传入)。
   * 缺席 = 透明关闭, postMessage 走原 run 路径逐字节不变 (SC7);
   * 配置时每轮 run 被 runVerifyLoop 包裹 (仅 StopReason=completed 触发
   * 验证; trace 仅 traceOut 配置时注入, 否则 VerificationRecord 不落盘)。
   */
  readonly verifyConfig?: VerifyConfig;
  /**
   * settings-hot-reload（T3）:env 源 — 构造 opts 可选。传入后 ensureDeps /
   * reloadFromEnv 用它拿 env（替代内部 loadIknowEnv()）。T2 EnvLoader.get 是
   * 天然实现。缺省 → 行为零变化（仍内部 loadIknowEnv）。向后兼容：既有
   * overrideEnv / deps 注入路径均不受影响。
   */
  readonly envProvider?: () => IknowEnv;
  /** settings-hot-reload（T3）:env 变化回调 — 构造 opts 可选。hub 在
   *  reloadFromEnv 成功替换 adapter 后调用一次（新 env 为参数）。首次
   *  ensureDeps 不算「变化」→ 不触发。T4 用它驱动 TUI 显示层刷新。 */
  readonly onEnvChange?: (env: IknowEnv) => void;
  /**
   * Review High-1 (2026-08-29): root the constructor-injected `deps` were
   * built at (TUI). Declared → ensureDeps falls through to per-root engine
   * rebuild when a session's root left this root (worktree rebind). Absent →
   * injected deps short-circuit exactly as today.
   */
  readonly injectedEngineRoot?: string;
  /**
   * Review High-2 (2026-08-29 / hard req 9): settings object assembled at the
   * startup load point (serve.ts). Reused for EVERY engine this hub builds —
   * rebind-rebuilt worktree-rooted engines included — so project settings
   * never silently reload (they are absent inside the gitignored worktree).
   * Absent → build-engine's own default load (behavior unchanged for
   * tests / non-rebinding hosts).
   */
  readonly settings?: IknowSettings;
  /**
   * serve-workspace T2 测试缝：按根装配 engine，避免单测走真实 LLM。
   * 生产省略 → `buildHarnessEngine` 且 cwd/workspaceRoot/sandboxRoot 三等。
   *
   * T11: 返回 bundle 在 `EngineBundle` 之上扩展 `mcpRoots?` / `mcpManager?` /
   * `catalog?` —— hub 的 per-root MCP face 切换需要这三字段;其余字段由
   * `EngineBundle` SSOT 锁定。
   */
  readonly buildEngine?: (root: string) => Promise<
    EngineBundle & {
      /** T6/T7：生产装配透出的双根；reload 事务只消费 active engine 的这份。 */
      mcpRoots?: McpRoots;
      /** T7：per-engine MCP manager；激活时收口旧 face 再公开。 */
      mcpManager?: McpManager;
      /** T7：与 mcpManager 同源的 ACI catalog（listMcpTools 可见面）。 */
      catalog?: AciCatalog;
    }
  >;
  /**
   * serve-workspace T3: recents/trust 名单的 home 根（落
   * `<recentsHome>/.iknow/workspaces.json`）。生产 serve.ts 传 `homedir()`；
   * 缺席 → bindWorkspace 保持 T2 语义（无 trust gate、不落 recents）。
   */
  readonly recentsHome?: string;
  /**
   * T3 / plans/worktree-exclusive-lock.md / ADR-0070 —
   * `isolation.worktreeExclusive` 装配期解析结果。**只在启动加载点解析一次**
   * （ADR-0037 §5 硬要求 9 / `resolveWorktreeExclusive` 单读点同款形状）：
   * 该值在 hub 构造时透传给 `createTaskWorktreeProvisioner`，后者闭包冻结
   * 贯穿本 engine 寿命，rebind 不重读。
   *
   * OFF 档（缺席 / 非 `true`）→ provisioner 完全跳过占用检查，enter 行为
   * 与今日逐字节一致（SC2）。生产 caller（serve.ts）从 `startupSettings`
   * 一次解析后传入。
   */
  readonly worktreeExclusive?: boolean;
};

/**
 * Per-root BuiltEngine cache entry (Map value + activateMcpFace 输入).
 * T11: 在 `EngineBundle` SSOT 之上扩展 `mcpRoots?` / `mcpManager?` / `catalog?`。
 */
type HubEngineEntry = EngineBundle & {
  mcpRoots?: McpRoots;
  mcpManager?: McpManager;
  catalog?: AciCatalog;
};

// -- stop-reason persistence decision (T1: replaced DROP_REASONS set) ---------
//
// The previous design used a static DROP_REASONS set to skip certain stop
// reasons (cancelled / protocolError / emptyFinalResponse). T1 replaces that
// with `shouldPersistCheckpoint(result, priorMessages)` from
// ./store/checkpoint.ts. Nuance preserved:
//   - `cancelled` WITH delta>0 now persists (the user query landed; record a
//     checkpoint so the interrupted turn is recoverable / rewind-able).
//   - `protocolError` / `emptyFinalResponse` never persist (维持 #120 裁决).
//   - every other stopReason (completed / maxTurns / timeout / nonSuccessStop)
//     persists as-is.

// -- SessionHub ----------------------------------------------------------------

export class SessionHub {
  private readonly store: SessionStore;
  /** ADR-0037 T3:task worktree 建树 + 仅本会话根改绑的 host 缝。 */
  private readonly worktreeProvisioner: TaskWorktreeProvisioner;
  /** T3: roots returned by provision but not yet persisted with the turn. */
  private readonly dirtyWorktreeRoots = new Map<string, string>();
  private cachedDeps: LoopEngineDeps | undefined;
  private readonly defaults: {
    jsonMode: boolean;
  };
  /** JSONL trace output path; when set, postMessage creates a per-session trace. */
  private readonly traceOut: string | undefined;
  /** All JSONL services created by this hub, including the shared subagent trace. */
  private readonly traceServices = new Set<TraceServiceWithHealth>();
  /** askUser inlet (#162); required unless deps are pre-built. */
  private readonly askUser: AskUser | undefined;
  /** Full serve AskUser handle (when provided, SPA can list + resolve asks). */
  private readonly askHandle: ServeAskUserHandle | undefined;
  /** Session allow-list source ("always-allow" from web UI lands here). */
  private readonly sessionGrants: SessionGrants | undefined;
  private readonly permissionMode: PermissionModeContext | undefined;
  /** T2: env source for the per-turn thinking override (test seam). */
  private readonly overrideEnv: { readonly llm: LlmEnv } | undefined;
  /** Sandbox root for fs-tool access (code-review 2026-08-05). Undefined
   *  → `buildHarnessEngine` defaults to `process.cwd()`. Production callers
   *  in serve mode should pass an explicit root (CLI flag wiring tracked). */
  private readonly sandboxRoot: string | undefined;
  /** #196 IKNOW T5: 入口 surface；默认 "chat"（tests 兼容）。serve 路径
   *  由 serve.ts 显式传 "serve"。 */
  private readonly surface: "chat" | "tui" | "ask" | "serve" | undefined;
  /** #356 T7: subagent manager（host drain 消费面；懒取见 ensureDeps）。 */
  private subagentManager: SubAgentManager | undefined;
  /** T1: all per-root managers remain in the host read aggregation surface. */
  private readonly subagentManagers: SubagentManagerRegistry;
  /** T4: serve-only terminal wake subscription; TUI owns its UI-aware wake. */
  private subagentWake: SubagentWake | undefined;
  /** Coarse serve target: the most recently addressed conversation. */
  private lastConversationId: string | undefined;
  /** review-fix (M1 / H1): per-root state anchor 缓存；serve 入口解析后透传。 */
  private readonly workspaceRoot: string | undefined;
  /**
   * T6:稳定 productRoot（启动 bind root）。跨 per-root 重建不变；
   * `buildProductionEngine` / reload 只消费它派生的 mcpConfigRoot。
   */
  private readonly productRoot: string | undefined;
  private readonly projectIdentityRoot: string | undefined;
  /** #128 T8: 验证闭环配置（settings.verify 段；缺席 = 透明关闭）。 */
  private readonly verifyConfig: VerifyConfig | undefined;
  /** #356 High#4: built.shutdown 缓存（组合句柄；ensureDeps 懒取，hub.shutdown 触发）。 */
  private cachedShutdown: (() => Promise<void>) | undefined;
  /** TUI TuiExtensions 同源：lazy ensureDeps 后才有；deps 注入测试路径保持缺席。 */
  private skillCatalog: SkillCatalog | undefined;
  private mcpManager: McpManager | undefined;
  private aciCatalog: AciCatalog | undefined;
  private mcpHome: string | undefined;
  /**
   * T7：当前对外可见的 active engine 双根（per-engine，非含糊单 cwd）。
   * reload 只读这份；切 engine 时由 activateMcpFace 更新。
   */
  private activeMcpRoots: McpRoots | undefined;
  /**
   * T7：MCP reload 串行链。并发 reloadMcp coalesce 到同一队列，
   * 每个 promise 都有明确成功/失败终点（不悬挂）。
   */
  private mcpReloadChain: Promise<unknown> = Promise.resolve();
  /**
   * settings-hot-reload（T3）:env 源（缺省 → ensureDeps 内部 loadIknowEnv）。
   * reloadFromEnv 用它拿新 env 重建 adapter；onEnvChange 在成功替换后触发。
   */
  private readonly envProvider: (() => IknowEnv) | undefined;
  /** settings-hot-reload（T3）:env 变化回调（reloadFromEnv 成功后触发一次）。 */
  private readonly onEnvChange: ((env: IknowEnv) => void) | undefined;
  /**
   * settings-hot-reload（reviewer major）:上次 reloadFromEnv 重建 adapter 时用的
   * env 快照（关键字段值比较去重基准）。EnvLoader.get() 每次返回新对象，对象身份
   * 比较不可用，必须以它做「touch 未变内容」判定。首次成功重建后赋值。
   */
  private lastReloadedEnv: IknowEnv | undefined;
  /** Constructor-injected deps (tests). Distinct from lazy/Map cache. */
  private readonly injectedDeps: LoopEngineDeps | undefined;
  /**
   * Review High-1 (2026-08-29): the root the injected deps were built at.
   * Injected-deps hosts that support isolation (TUI) declare it so ensureDeps
   * can detect a session root that LEFT the injected engine's root (rebind)
   * and fall through to per-root engine rebuild — without it, a rebound
   * session would stay on the stale engine and its mutates would be blocked
   * forever. Absent (tests / ask) → injected branch behaves exactly as today.
   */
  private readonly injectedEngineRoot: string | undefined;
  /**
   * Review High-2 (2026-08-29 / hard req 9): the settings object assembled at
   * the startup load point. Every engine this hub builds (main-root production
   * path, fallback path, rebind-rebuilt worktree-rooted engines) reuses THIS
   * object via buildHarnessEngine's `settings` opt — `.iknow/` is gitignored
   * so a worktree-rooted `loadIknowSettings({cwd})` would silently drop
   * project settings. Absent → build-engine keeps its own default load
   * (tests / hosts that never rebind are unchanged).
   */
  private readonly startupSettings: IknowSettings | undefined;
  /** serve-workspace T2: test seam; production omits → buildHarnessEngine.
   * T11: 返回 bundle 形状由 `EngineBundle` SSOT 锁定,在其上扩展
   * `mcpRoots?` / `mcpManager?` / `catalog?`(hub per-root MCP face 切换)。 */
  private readonly buildEngine:
    | ((root: string) => Promise<
        EngineBundle & {
          mcpRoots?: McpRoots;
          mcpManager?: McpManager;
          catalog?: AciCatalog;
        }
      >)
    | undefined;
  /** serve picker bind (T2); session file workspaceRoot is the engine Map key. */
  private boundRoot: string | undefined;
  /**
   * T7：最近一次 activate 的 engine root。listMcp / reload 走 ensureDeps 时
   * 优先用它，避免 bindRoot（主 checkout）把已激活的 worktree face 抢回去。
   */
  private activeEngineRoot: string | undefined;
  /** D-α T3 / ADR-0030: graph 编排 overlay holder（serve / TUI 注入；缺席 =
   *  本入口未接 overlay → run_graph 与编排段都不存在）。 */
  private readonly graphMode: GraphModeContext | undefined;
  /** ADR-0092 / SC13: fs isolation 档 holder（serve / TUI 注入；缺席 = 本
   *  入口未接 fs 档 → 引擎按全局档缺省）。 */
  private readonly fsMode: FsModeContext | undefined;
  /** D-α T5: 注入 deps 的 host（TUI）自带的装配快照句柄（构造 opts 传入）。 */
  private readonly injectedGraphAssembly: GraphAssembly | undefined;
  /** D-α T3: 最近一次 ensureDeps 返回的那台 engine 的装配快照。postMessage
   *  紧接 ensureDeps 调 beginRound() —— 两者在同一串行槽位里，per-root
   *  多引擎时也不会拍错那一台。缺席 = 该 engine 未接 overlay。 */
  private activeGraphAssembly: GraphAssembly | undefined;
  /**
   * live-graph-phase1 T1 / ADR-0047 / ADR-0051:活图账本 host —— 多会话
   * 共享同一 host，按 `ctx.conversationId` 解析。`resetSession` 销毁单会
   * 话账本；`shutdown` 销毁全部。缺席 → `run_graph` handler 不建账
   * （与 graphAssembly 缺席同形态）。
   */
  private readonly liveGraphLedger: LiveGraphLedgerHost | undefined;
  /** serve-workspace T3: recents/trust roster home (absent → T2 behavior). */
  private readonly recentsHome: string | undefined;
  /** Per-root BuiltEngine cache (same root shared across sessions). */
  private readonly engineByRoot = new Map<string, HubEngineEntry>();
  /** Per-conversation serialization (spec A15). */
  private readonly inflight = new Map<string, Promise<void>>();
  /** Actual active work count; `inflight` retains resolved chain sentinels. */
  private readonly activeTurnCounts = new Map<string, number>();
  /**
   * auto-memory T1: session-level prefetch dedup — per-conversation sets of
   * already-injected memory ids. Host-side state only (never loop-engine).
   * Lazily recovered from the loaded history on first attach (empty set is
   * cached too), then grown by the ids each turn actually injects.
   */
  private readonly prefetchInjectedIds = new Map<string, Set<string>>();
  /** auto-memory T4: host 钩子（默认缺席 = 自动记忆关）。 */
  private autoMemory: AutoMemoryHook | undefined;
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
    // review-fix (M1 / H1): per-root state anchor 缓存。
    this.workspaceRoot = opts.workspaceRoot;
    // T6:稳定 productRoot（缺席 → workspaceRoot，保持单根形态可编译可跑）。
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
    // ADR-0037 T3:worktree isolation host 缝 —— 建树 + 仅本会话根改绑。
    // 开关本体由 build-engine 在启动加载点读取（硬要求 9）；hub 只在
    // buildProductionEngine / ensureDeps 兜底路径注入 provision 缝。T4:
    // 会话已在本会话 task worktree 的 passthrough / 外来根 fail-closed
    // 都由 provision 按会话锚定，hub 不传 conversation-agnostic 标记。
    // Root persistence belongs to this Hub's dirty-root conditional-save
    // protocol. The provisioner only creates/returns the task worktree here.
    //
    // T3 / plans/worktree-exclusive-lock.md / ADR-0070：把装配期冻结的
    // `worktreeExclusive` 值透传到 provisioner 闭包——后者 `enter()` 据此
    // 走 ON 档占用检查（typed worktree_claimed）或 OFF 档零回归路径（SC2）。
    // 透传是单点：buildHarnessEngine 在 build-engine.ts:586 resolve 后透到
    // BuiltEngine.worktreeExclusive（build-engine.ts:409），本 hub opts 取
    // 这个 boolean 后直接喂给 provisioner。listSessions 由 hub 的 store
    // 直接绑——store 是 SessionStore 实例，自带 list() 方法（spec 输入五类
    // 表入口）。**不**新增任何写盘路径（SC7 审查项：list 是只读）。
    this.worktreeProvisioner = createTaskWorktreeProvisioner({
      ...(this.projectIdentityRoot !== undefined
        ? { projectIdentityRoot: this.projectIdentityRoot }
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
   * T7 adoption anchor: the conversation's PERSISTED workspaceRoot is loaded
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

  /** Best-effort persisted workspaceRoot read for the T7 adoption anchor. */
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
   * T7 Hub-visible enter seam (serve/chat harness hosts; TUI wires
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
   * T8 Hub-visible exit seam (serve/chat harness hosts; TUI wires
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
   * #358 T7: Session API GET /sessions/:id/subagents 数据源。先经 store.load
   * 做会话存在性门 —— 未知会话 → 抛 typed not_found(由 http 层 sendError
   * 收编成 404, 不在 hub 裸抛);manager 缺席(ask 形态) → 200 空列表。
   * 只读投影, 无写路径。
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
   * Slice D / SC14: host-initiated hard kill of one worker (TUI Ctrl+X on a
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
   * #356 High#4 (SC12/SC3):serve 长程入口的清理句柄 —— 转发 ensureDeps 缓存
   * 的 built.shutdown（组合句柄 mcpManager first → subagentManager second）。
   * cli.ts runServe 用 registerShutdown(hub) 把本方法挂到 SIGINT/SIGTERM,
   * 进程退出前关闭 MCP 后台连接 + SIGTERM subagent stdio 子进程(SC11/SC16)。
   * ask/deps-injected 形态无 built → 缓存缺席 → no-op(行为零变化)。
   */
  async shutdown(): Promise<void> {
    this.subagentWake?.dispose();
    // live-graph-phase1 T1 / ADR-0051:会话结束（hub 释放）销毁全部活图账本
    // —— 无账本泄漏到后续新会话（SC3 后半句）。
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
   * SC10 / spec tui-model-command：per-turn thinking override 重建 adapter 时
   * 用的 env —— **最新值优先**。
   *
   * `overrideEnv` 是 bridge 构造期的启动快照（run.tsx 透传），一次赋值后再不
   * 刷新；`/model` 切换只经 `envProvider`（EnvLoader.get）反映。override 分支
   * 用快照会让带 thinking 的轮次悄悄退回切换前的 baseUrl/apiKey/model
   * （headers 同理），与「新 turn 走新 provider/model」的验收相悖。
   * envProvider 缺席（只传 overrideEnv 的测试缝）→ 保持快照语义。
   *
   * 只在 override 分支被调用：无 thinking 的轮次不因本方法多读一次 env。
   */
  private overrideEnvForTurn(): { readonly llm: LlmEnv } | undefined {
    return this.envProvider ? this.envProvider() : this.overrideEnv;
  }

  /**
   * settings-hot-reload（T3）:env 源热重建 —— 用最新 env（envProvider()）走
   * createAdapterFromEnv 重建 adapter 替换 `cachedDeps.adapter`。**不重跑**
   * buildHarnessEngine 整条装配链（MCP / subagent / skill 都跳过，见
   * plans/settings-hot-reload.md 决策 4）。registry / executor / maxTurns /
   * timeoutMs 等字段复用旧 cachedDeps。
   *
   * 语义：
   *   - env 关键字段（model / apiKey / fallback / thinking / thinkingEffort）
   *     与上次重建时**值相同** → 视为「touch 未变内容」，跳过 adapter 重建且
   *     不触发 onEnvChange（reviewer major：settings 文件 touch 但内容没变 →
   *     不重建 adapter、不通知显示层）。注意 EnvLoader.get() 每次返回**新对象**，
   *     对象身份比较不可用，必须做关键字段值比较。
   *   - 成功（值变化）→ 替换 adapter，且以新 env 触发 onEnvChange（若注册）一次。
   *   - envProvider 未注入 / cachedDeps 尚未构建（首次 postMessage 前）→
   *     no-op（行为零变化）。
   *   - apiKey 缺失 / 解析失败（settings `${VAR}` 解析不到 → apiKey=undefined）
   *     → 抛 ValidationError（对齐 buildHarnessEngine 守卫），cachedDeps 保持
   *     旧 adapter（reviewer major：降级保留旧 env，不在 SDK 层才炸）。
   *   - envProvider() 抛错（坏 JSON / model 缺失）→ 抛错且 cachedDeps 不动，
   *     不崩进程 —— 由调用方（T4 EnvLoader.subscribe 链路）负责降级通知。
   */
  async reloadFromEnv(): Promise<void> {
    if (!this.envProvider) return;
    if (!this.cachedDeps && this.engineByRoot.size === 0) return;
    const env = this.envProvider();
    if (!env.llm.apiKey) {
      throw new ValidationError(LLM_API_KEY_MISSING_MESSAGE);
    }
    // 关键字段值比较去重（model / apiKey / fallback / thinking / thinkingEffort）。
    // 任一变化 → 重建 + 通知；全同 → 跳过（touch 未变内容不触发）。
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
   * trust roster requires `{ confirmTrust: true }` (rule 3: 新绝对路径 →
   * 确认信任；recents 已信任). On trust, the root is upserted into
   * `<recentsHome>/.iknow/workspaces.json` (home). When `recentsHome` is
   * absent (tests / legacy) T2 behavior is preserved.
   *
   * Errors (plan T3 ACR verdict):
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
      turns: projectMessagesToTurns(file.messages, file.thinkingMs),
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
          // #458 T5/T12: pin 发射点 — 文本截 200 防 jsonl 行膨胀;
          // 状态机转移由 hub 唯一持有, trace 仅记录生命周期事件。
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
        // D-α T3 / ADR-0030:round 边界 —— 一条 postMessage = 一次 run()。
        // 在这里拍 graph 装配快照（紧接 ensureDeps，同一串行槽位内，拍的
        // 一定是本次要用的那台 engine），overlay 翻键因此「下一条消息才
        // 生效」，与 chat 的「下一条查询行」同语义。
        this.activeGraphAssembly?.beginRound();
        // T2: per-turn override — rebuild deps with a one-shot adapter only;
        // executor / registry / maxTurns / timeoutMs are reused from the
        // cached deps. When absent, the cached path is unchanged.
        // SC10：override 分支经 overrideEnvForTurn 取**最新** env（切换后的
        // provider/model 下一轮生效；构造期快照只作 envProvider 缺席时的缝）。
        const deps =
          opts.thinking !== undefined
            ? withThinkingOverride({
                deps: baseDeps,
                override: opts.thinking,
                env: this.overrideEnvForTurn(),
              })
            : baseDeps;
        // #622 T5: 懒提交 user query。engine 自己不 commit query（只 commit
        // assistant / tool_result），若链上缺 query，投影与链永远差一条，
        // 每次 post-turn save 都被迫走 re-root fork（rewind 后新链也无法
        // parent 在 rewind 锚点上）。改为把 query 前缀进本 postMessage 的
        // 第一次 engine commit：链与投影对齐（save 走 identical /
        // extension），且零进展 turn（protocolError / emptyFinalResponse
        // 在首次 commit 前停止）永不落 query —— 维持 #120 丢弃裁决。
        // queryMessage 必须与 engine 的构造逐字节一致（secrets 占位符替换
        // + adapter.encodeUserText，loop-engine.ts run() 同款逻辑），否则
        // save 的 LCP 对齐会在 query 处分叉。
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
        // T6: wrap the executor with the violation kill-session hook. Serve is
        // long-running and multi-conversation, so on kill we (a) write the
        // violation event to the JSONL trace and (b) report `protocolError`
        // as the turn stop reason — we do NOT touch process.exitCode.
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
        // in cachedDeps) because conversationId differs per session (ADR-0003 D4).
        // T2: traceOut 是目录, JsonlTraceService 写 <traceOut>/<conversationId>.jsonl。
        // SC-W 6/7 (v2 spec):serve 路径注入 agentVersion。runDeps 只在
        // traceOut 配置时落 session 根记录(与既有 trace 注入同条件);
        // agentVersion 恒定注入,loop-engine 要求 trace 与 agentVersion
        // 同时存在才写,故未配 traceOut 时无副作用。
        const runDeps: LoopEngineDeps = {
          ...deps,
          executor: wrappedExecutor,
          agentVersion: getVersion(),
          // #502 T5 / ADR-0021 D1.4:per-postMessage conversationId 注入 deps。
          // serve cachedDeps 跨会话共享（hub.ts:1287 注），此处 per-run 注入会话
          // 锚点，bash_output / bash_stop 的 scope 过滤才能按会话闭环。
          conversationId,
          // #620 T3 (spec session-jsonl-resume D4):turn 内 commit 钩子 ——
          // assistant / 每个 tool_result 进权威历史后立刻 append 到会话
          // JSONL log（边跑边写，崩溃可续）。
          // 队列纪律（spec concurrent 决策）:本闭包由 run() 在 postMessage
          // 的 serialize work 槽位内同步触发,已在同会话串行队列里 —— 绝不
          // 能再经 this.serialize 包裹（内层槽位排队等外层释放,外层正等
          // run() 返回 → 自等死锁）。不绕开,也不重入。
          commitMessages: (messages, thinkingMs) => {
            // T5: 首次 commit 带上 query 前缀（含 host drain 的子代理浓缩
            // 消息，若本轮有）；之后逐次 commit 原样透传。
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
          // #604 T1 (SC1-SC5): compact 边界渲染缝 — 把会话里最近合格用户
          // 任务原话(纯函数 over session.messages,现抽现贴)注入为
          // boundaryAttachment 闭包;compact 触发时在 placeholder 后追加一条
          // user 消息。约束:
          //   - 自动模式(goal.text 非空)→ return undefined,绝不贴(spec: 自
          //     动模式不贴任务摘录);
          //   - 0 句合格 → renderRecentUserTasksBoundary return undefined,
          //     闭包产出 undefined,helper 早退(行为 byte-stable,不影响停止
          //     语义 ADR-0011);
          //   - 不读 session.taskFocus (#605 T2 已退休; 渲染源是
          //     session.messages 内的合格用户任务原话);
          //   - renderRecentUserTasksBoundary 是 hub 内私有 closure — harness
          //     域独立原则,harness 不 import session-api,零反向依赖。
          ...(!(session.goal !== undefined && session.goal.text.length > 0)
            ? {
                boundaryAttachment: () =>
                  this.renderRecentUserTasksBoundary(session.messages),
              }
            : {}),
        };
        // plan T6 / ADR-0011:异常停前 loop-engine 通过 onStream emit
        // stop_summary。包一层 wrapper 捕获 stop_summary 文本(无条件 — 即使
        // 宿主没传 onStream,DTO 也要带 stopSummary;byte-stable 有则进、无则缺)
        // 并**原样转发**给宿主 onStream(TUI 用它做 notice 呈现,见 app.tsx)。
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
              // #356 T7 (SC7):host drain — serve 入口每轮 run() 前,把 manager 内
              // completed 子代理结果浓缩成 user message,拼入 priorMessages 末尾。
              // 空 manager / 无 completed → priorMessages 不变 (行为零变化)。
              const drained = await drainPendingSubagents(
                this.subagentManagers,
                {
                  conversationId,
                }
              );
              const drainedMsg: AnthropicNativeMessage = {
                role: "user",
                content: [{ type: "text", text: drained }],
              };
              const priorMessages = drained
                ? [...session.messages, drainedMsg]
                : session.messages;
              // T5: query 提交前缀与本轮实际进 engine 的 user 消息对齐
              // （drain 浓缩消息在内存历史里先于 query，链上也须同序）。
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
              // #128 T8:verifyConfig 非 undefined (含 command 空串) 时 run 被
              // runVerifyLoop 包裹 (advisor 形态, 引擎零改动);缺席 → 原 run 调用
              // 逐字节不变 (仅未接线路径)。
              // runVerifyLoop 的 runFn 透传 onStream → wrappedOnStream 语义保持;
              // trace 仅在 traceOut 配置时注入 (records 落盘, T7 已处理可选)。
              // 注意: runVerifyLoop 的首轮 runFn 不带 priorMessages / onStream,
              // 闭包必须兜底 hub 侧的 priorMessages 与 wrappedOnStream。
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
                      // ADR-0092 Amendment / SC11–SC13:verify 命令的围栏与
                      // bash 工具同档 —— snapshot 在本次调用现读(翻档下一次
                      // 调用生效,不重建引擎);缺席 → verify-loop 全局档
                      // baseline,且 key 不出现。
                      ...presentFields("fsMode", this.fsModeSnapshot()),
                      // homeRoot 取本进程 homedir() —— 本调用点独立于
                      // build-engine,缺省语义 = 那边的 `opts.userHome ??
                      // homedir()` 的后者。
                      //
                      // 已知限制(有意的同源假设,不是巧合):两处仅在
                      // 「宿主不注入 userHome」时同源。生产三入口(serve /
                      // chat / TUI)都不注入(session-api/serve.ts、cli 的
                      // buildHarnessEngine 调用点、tui/run.tsx 的 depsOpts),
                      // 故今天两处 home ro-bind 源端一致。
                      //
                      // 漂移条件:userHome 是 TUI deps 的测试缝
                      // (src/tui/deps.ts)。一旦某个宿主把这同一个值也注入
                      // 引擎装配,而本调用点仍取真实 homedir(),工作区档下
                      // bash 的 home ro-bind 会指向注入 home、verify 指向真
                      // home —— 两条执行面的 home 可见面分裂。
                      //
                      // 为何不在此收口:hub 拿不到引擎 home ——
                      // SessionHubOptions 没有 userHome(既有 recentsHome /
                      // mcpHome 分别是信任名单根与 MCP 配置根,不是引擎
                      // home 缝,不能挪用)。真收口要把同一值经 hub-bridge /
                      // run.tsx 透传进来,那是 TUI 接线所有权(另有任务在
                      // 改这两个文件);且当前无生产 caller 注入,先加 option
                      // 只会是零调用者的死面。接 TUI 的 userHome 缝到 hub
                      // 路径时,请一并给 SessionHubOptions 加 home 并改本行为
                      // 现读(或经 fsModeSnapshot 同款 per-call helper 收口),
                      // 而不是继续靠「生产恰好不注入」。
                      homeRoot: homedir(),
                      // ADR-0092 / SC12:会话 tmp 宿主真路径 —— `$TMPDIR`
                      // 与工作区档 `--bind <tmpRoot>` 同源。经 bash 工具面
                      // **同一个** helper 解析(不在此独立推导第三份):
                      // `<projectDir>/<sanitized convId>/fence-tmp`,与
                      // registry 的 bash `projectDir: opts.todoDir` 同池同叶。
                      // 缺 projectDir / conversationId → undefined,verify-loop
                      // 回退进程 tmpdir()(fallback 不是目标态,见 VerifyLoopOptions.tmpDir)。
                      ...presentFields(
                        "tmpDir",
                        resolveSessionFenceTmp({
                          projectDir: this.store.getProjectDir(),
                          conversationId,
                        })
                      ),
                      // #128 SC1 生产装配: subagentManager 在场 → 启用分类器填空
                      // (command 缺失/空串时分类器接管, spec Objective);缺席
                      // (ask 形态) → undefined, verify-loop 自然走透明关闭向后兼容。
                      runClassifier:
                        this.subagentManager === undefined
                          ? undefined
                          : createRunClassifierFromManager({
                              manager: this.subagentManager,
                              ...(this.verifyConfig.classifierModel !==
                              undefined
                                ? {
                                    classifierModel:
                                      this.verifyConfig.classifierModel,
                                  }
                                : {}),
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
                      });
                    })();
              const result = runOutcome.result;
              // #408 T5: capture the terminal outcome for post-run write-back.
              verifyOutcome =
                "outcome" in runOutcome ? runOutcome.outcome : undefined;
              verifyRecords = "records" in runOutcome ? runOutcome.records : [];
              // #128 M3: verify 最终判定 (failed / unstable / escalated / passed)
              // surface 到 DTO。T3: HITL + INSUFFICIENT + skip 完成向判官
              // 不上 passed 绿勾; SUFFICIENT 短路仍上 wire。abort/disabled 缺席。
              verifyView =
                "outcome" in runOutcome
                  ? projectVerifyHumanView({
                      outcome: runOutcome.outcome,
                      rounds: runOutcome.rounds,
                      records: runOutcome.records,
                    })
                  : undefined;
              // Violation kill → surface protocolError so the SPA client can
              // attribute the stop; shouldPersistCheckpoint still drops
              // protocolError context on save (mirrors the chat-session drop
              // semantics, 维持 #120 裁决).
              finalResult = killed
                ? { ...result, stopReason: "protocolError" }
                : result;
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
              // auto-memory T4 / ADR-0031 D1:每轮把结果交给钩子,由钩子决定
              // completed 闸 + N 轮闸。钩子缺席(默认 OFF / ask / 注入 deps 的
              // 测试)→ 整句 no-op,行为逐字节不变。
              this.notifyAutoMemory(
                s.finalResult,
                s.priorCount,
                boundRoot,
                conversationId
              );
              // #458 T5 (SC8): goal.status write-back on verify-loop terminal
              // outcome. The hub is the only writer of goal.status. Target status
              // is looked up from OUTCOME_TO_STATUS; applyTransition runs only
              // when target is a valid forward edge from current status
              // (T3 assertValidTransition rejects self-transitions, so
              // active→active / achieved→achieved are no-ops and the goal stays
              // put). recordGoal fires for every outcome with a goal present
              // (write-back trace 留痕 even when no status change). Placed
              // AFTER conditionalSave so a T2-seeded goal on this same turn is
              // promoted in the same persistence round.
              if (s.verifyOutcome !== undefined && saved) {
                const justSaved = await this.store.load(conversationId);
                if (justSaved.goal !== undefined) {
                  const target = OUTCOME_TO_STATUS[s.verifyOutcome];
                  const now = new Date().toISOString();
                  // T3 assertValidTransition 守门: OUTCOME_TO_STATUS 的 target 值域
                  // 含 "active"（failed/unstable 保持态），对已处于 achieved/aborted
                  // 的 goal 属非法反向边（achieved→active 不在白名单）——守卫拦截，
                  // goal 不变，仅 recordGoal trace 留痕（与 failed/unstable 行为对齐）。
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
                  // T12 writeback 发射点: status ?? "active" 覆盖 disabled(无
                  // target) 与 failed/unstable/自转移/非法反向边场景。
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
              // summary + per-turn thinkingMs sum. 同一 `loadedFile.thinkingMs`
              // 是 store 落盘后与 loadedFile.messages 对齐的并行数组,起点
              // s.priorCount (= session.messages.length) 即本轮新增起点。
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
                  // as conditionalSave — byte-identical shouldPersistCheckpoint verdict
                  // (saved 只在 cancelled 时消费;completed 等 stopReason 不读它)。
                  priorMessages: session.messages,
                  ...presentText("stopSummary", capturedStopSummary),
                  // #128 M3: 验证最终判定 (failed/unstable/escalated) surface 到 DTO。
                  ...(s.verifyView !== undefined
                    ? { verify: s.verifyView }
                    : {}),
                  // D2 wire surface: 本回合 assistant 思考时长 (ms)。
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
            // ADR-0011:不 save — run 前 session 已在盘上,throw 路径不产出
            // 可落盘的新 messages,故不调 conditionalSave(否则会写空 messages
            // 把已被 disk-SSOT 守门的不变式擦掉)。turnCount 透传 err.turnsRan
            // (已跑轮数);finalText 用空串(没有 completed 文本)。摘要若有则
            // 附 TurnAnswerDto.stopSummary(additive, byte-stable)。
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
        // live-graph-phase1 T1 / ADR-0051:reset 销毁活图账本 —— 之后同一
        // 会话再 run_graph 可重用旧 id 并真正 spawn（SC3）。账本缺席 → no-op。
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
   * 手动压缩会话（TUI /compact、web 压缩按钮共用落点）。
   * 与 resetSession 同模式走 serialize 队列：load → compact → save。
   *
   * #467 step 2: 优先尝试 LLM 结构化摘要(`runFullCompact` best-effort)。
   * `cachedDeps` 缺席(ask / worker / oneshot 等无 harness 装配)或 adapter
   * 不可用 → 跳过 LLM 路径,走 `compactMessages` 纯截断路径。LLM 摘要失败
   * (empty_response / timeout / adapter_failed)同样回退 placeholder。
   * title 字段由 `extractTitle` 取首条 user 文本派生(#467 改名,原
   * `summary`;两条路径的 messages[0] 都是 user 文本消息,派生语义一致)。
   *
   * 幂等 no-op: 消息条数未减少(已低于压缩窗口或本就 ≤ keepRecent 或
   * 无 dropped 前缀)时不落盘、不 bump updatedAt,返回 compacted=false。
   * 实际压缩 → 落盘并重算 title。
   *
   * #548:`opts.signal` / `opts.onStream` 透传到 `runFullCompact`,让宿主
   * 看到压缩期间的全套事件(compaction_started / completed / failed /
   * cancelled + compaction_text_delta)并支持中途取消。**取消语义对齐
   * Claude Code**:opts.signal abort → `signal_aborted` outcome → 不走
   * fallback 截断、会话保持原样、不 bump updatedAt,返回
   * `{ compacted: false, cancelled: true }`(additive 字段,与"无可压缩
   * 上下文"的 compacted=false 区分)。host observer 与 adapter 错误均经
   * runFullCompact safeEmitStream 吞咽,本函数不另行暴露。
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

        // plan manual-compact-trigger T1: 手动 /compact 视作已过
        // `evaluateCompactTrigger` 的 token 门(spec 672 Boundaries Out)。
        // 执行体仍复用既有 runFullCompact / compactMessages 回退,与 proactive
        // auto-compact 已开火之后共用同一对 dropped/kept 决策:
        //   - empty → 幂等 noop(reason=messages_too_few),不落盘、不 bump updatedAt;
        //   - 不可压缩(消息数 ≤ keepRecent,无 dropped 前缀)→ full_summary 支
        //     (整段视为 dropped,kept=[]),与 auto 开火后行为相同;
        //   - 有 dropped 前缀 → windowed 支。
        // proactive 阈值公式 / getAutoCompactThreshold / IKNOW_AUTO_COMPACT_THRESHOLD_TOKENS
        // / estimateMessagesTokens / DEFAULT_KEEP_RECENT 全部不动 — 仅 hub 手动
        // 入口跳过 token 判据;loop-engine 仍走 evaluateCompactTrigger。
        let split: {
          readonly dropped: ReadonlyArray<AnthropicNativeMessage>;
          readonly kept: ReadonlyArray<AnthropicNativeMessage>;
        };
        if (before.length === 0) {
          // 空会话:幂等 noop,reason 字面沿用 messages_too_few
          // (plan Harvest Open 折进本票:below_token_threshold 仅保留给 auto 路径)。
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
          // 非空但消息数 ≤ keepRecent,无 dropped 前缀 → full_summary 支
          // (与 auto 路径 evaluateCompactTrigger 返 compact_via_full_summary 同效)。
          split = { dropped: before, kept: [] };
        } else {
          split = windowSplit;
        }

        // #467 step 2: 优先 LLM 结构化摘要(best-effort,失败回退 placeholder)。
        // cachedDeps 缺席(ask / oneshot 等无 harness 装配)→ adapter 不可用,
        // 跳过 LLM 路径,直接 placeholder。
        // #548:opts.signal / opts.onStream 透传到 runFullCompact — 宿主可看
        // 到 compaction_started/completed/failed/cancelled + compaction_text_delta
        // 全套事件并支持中途取消。signal_aborted outcome 走 keep-state
        // 路径(不 fallback 截断、不落盘、cancelled:true)对齐 Claude Code。
        let nextMessages: ReadonlyArray<AnthropicNativeMessage> | undefined;
        let cancelled = false;
        if (this.cachedDeps?.adapter !== undefined) {
          try {
            const outcome = await runFullCompact({
              adapter: this.cachedDeps.adapter,
              dropped: split.dropped,
              ...(opts?.signal !== undefined ? { signal: opts.signal } : {}),
              ...(opts?.onStream !== undefined
                ? { onStream: opts.onStream }
                : {}),
            });
            if (outcome.kind === "summarized") {
              const preamble =
                "This session is being continued from a previous " +
                "conversation that ran out of context. The summary below " +
                "covers the earlier portion of the conversation.\n\n" +
                "Summary:\n";
              nextMessages = [
                {
                  role: "user",
                  content: [{ type: "text", text: preamble + outcome.text }],
                },
                ...split.kept,
              ];
            } else if (outcome.kind === "signal_aborted") {
              // Claude Code 取消语义:会话保持原样,不 fallback 截断、不
              // bump updatedAt;cancelled:true 区分"无可压缩上下文"的
              // compacted=false(web/TUI 渲染区分)。
              cancelled = true;
            }
          } catch {
            // runFullCompact 自身已收敛所有错误到 FullCompactOutcome;
            // 此处 catch 是防御性兜底,任何意外抛出都视作失败 → placeholder。
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

        // 回退 / LLM 跳过 → 纯截断 + boundary placeholder。
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
          // 用首条 user 文本派生 session title 字段(#467 改名,原 summary;
          // 便于会话列表快速展示):
          //   - 摘要轮:messages[0] = SUMMARY_PREAMBLE + 摘要内容 user 消息,
          //     extractTitle(compacted) 会拿到 preamble 前缀,而不是用户原话。
          //   - placeholder 路径:messages[0] = "[compaction boundary ...]" user 消息。
          // 用 pre-compact 的 `before` 派生,标题保留原会话首条 user 意图(对齐
          // 旧 placeholder 时代的行为),而不是被 preamble / placeholder 污染
          // (#467 review-fix Medium:之前用 compacted,标题退化为通用 preamble)。
          title: extractTitle(before),
        };
        await this.store.save({ id: conversationId, file: updated });
        // reason:LLM 摘要成功 → 'full_summary'(无论判据 action,因 nextMessages
        // 实际是 SUMMARY_PREAMBLE + 摘要);placeholder fallback → 'windowed'。
        // SSOT:helper 把 4 取值决策收敛到一处,避免 3 处 inline 字面量 drift。
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
   * continue_pending T2 (#688): reload → predicate → skip-append run.
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
      const { result } = await run("", runDeps, opts?.signal, {
        priorMessages: session.messages,
        appendUserText: false,
        onStream: wrappedOnStream,
      });
      await this.conditionalSave({
        conversationId,
        session,
        result,
        priorMessages: session.messages,
      });
      const loaded = await this.store.load(conversationId);
      const turnMs = result.messages.slice(session.messages.length);
      // D2 (tui-display-consistency): per-turn thinkingMs from disk-SSOT
      // parallel array. continue_pending 路径直接读到 loadedFile.thinkingMs
      // (本轮新增 = session.messages.length 起点);与 buildStop 路径同模式。
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
   * 回退会话：把持久化 head 指到 `head`（null = 空 transcript）。
   * 走 serialize 队列。#624 起入参是事件 id，不再是 keepTurns。
   * legacy .json-only 先 load+save 迁 JSONL 再重试。
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

  /** GET /api/v1/skills — catalog 缺席（测试注入 deps）→ 空清单。 */
  async listSkills(): Promise<readonly SkillSummaryDto[]> {
    await this.ensureDeps();
    return (
      this.skillCatalog?.available().map((entry) => ({
        name: entry.name,
        description: entry.description ?? "",
      })) ?? []
    );
  }

  async loadSkillBody(name: string): Promise<{ name: string; body: string }> {
    await this.ensureDeps();
    const entry = this.skillCatalog?.get(name);
    if (entry === undefined || entry.disabled) {
      throw new NotFoundError(`skill not found: ${name}`);
    }
    // ADR-0079 — skill 正文不再挂写根 trailer（与 #337 SC6 逐字节一致）。
    // 写处境披露的权威路径在 worker prior + chat-session rebind 一次性
    // 通知，共用 writeRootSegment helper；hub 侧不消费 liveTaskRoot /
    // isolationOn（改绑通知走 chat-session，不经 hub）。
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
    // T7:串行化 / coalesce——每个调用方 promise 都有 typed 成功或失败终点。
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
   * T7 active-root reload 事务：先校验 active engine 的 mcpRoots，再加载
   * config / 调 manager.reload。失败路径不得让旧+新 manager 同时成为对外
   * 成功面；坏根在 shutdown 好 manager 之前拒绝。
   */
  private async reloadMcpTransaction(): Promise<readonly McpServerStatusDto[]> {
    // 已有可见 face 时不再 ensureDeps：避免 cache-hit activate 覆盖本事务
    // 要校验的 active mcpRoots，也缩小 rebind∩reload 窗口。
    if (!this.mcpManager || this.activeMcpRoots === undefined) {
      await this.ensureDeps();
    }
    const manager = this.mcpManager;
    if (!manager) {
      return this.listMcpServers();
    }

    // Root 校验必须先于 manager.reload（后者会 shutdown 旧 slots）。
    let validated: McpRoots;
    try {
      const roots = this.activeMcpRoots;
      if (roots === undefined) {
        throw new McpLifecycleError(
          "missing_cwd",
          "active engine mcpRoots are required for MCP reload"
        );
      }
      // mcpConfigRoot 合同上等于稳定 productRoot；用 resolver 再验一次。
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
      // T3 (ADR-0071 Decision 4):
      // violation 与主会话 trace 同域,锚在 `<projectDir>/<convId>/trace.jsonl`。
      // 派生复用 `resolveConversationTraceFilePath`,与 `createTrace` 同源 →
      // 同一会话的两条写入路径不会漂到不同文件。
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
    // 机器装配的 skill-load 消息跳过用户输入长度上限（与模型侧 tool result
    // 通道无字符上限对称 —— 都是机器装配而非手打用户文本）。78KB SKILL.md
    // 一次性加载会撞 8000 上限；不豁免则 skill-load slash 路径不可用。
    // 三处共用组合守卫 `exceedsUserInputCap`：hub.validateText / chat-session
    // processChatLine / 同侧谓词单测。
    if (exceedsUserInputCap(text, MAX_MESSAGE_CHARS)) {
      throw new ValidationError(
        `message text exceeds max length ${MAX_MESSAGE_CHARS}`,
        { field: "text", max: MAX_MESSAGE_CHARS, length: query.length }
      );
    }
  }

  /** #458 T5/T12: per-postMessage trace service (undefined when traceOut is
   *  not configured). Hoisted at the start of serialize's work so the pin /
   *  seed / writeback 发射点 and runDeps share one instance. */
  private createTrace(
    conversationId: string
  ): TraceServiceWithHealth | undefined {
    if (!this.traceOut) return undefined;
    // T3 (ADR-0071 Decision 4):
    // 主会话 + violation 共用同一 `resolveConversationTraceFilePath` 派生,
    // 确保两条写入路径落 `<projectDir>/<conversationId>/trace.jsonl`。
    //
    // T5 (ADR-0071 / SC8 + L2): 子代理聚合流
    // (`createTrace("subagent")` 字面 conversationId 假 scope, `<traceOut>/subagent.jsonl`)
    // 已退役 —— 子代理 lifecycle / content trace 由 manager 经
    // review-fix (M5) `projectDir` 两段式缝派生 per-agent
    // `<projectDir>/<convId>/subagents/agent-<taskId>.jsonl`,见
    // buildProductionEngine / rebuildEngine 路径的 projectDir 注入。
    // 本函数调用点不再传 conversationId="subagent"
    // —— 残留调用(若有)会让 ajv 接受 `conversationId:"subagent"`,但
    // 写入路径已不存在,无副作用,仅 spec 一致性提示。
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

  /** #604 T1 (SC1-SC5):compact 边界渲染 — 把 session.messages 内最近 ≤3 句
   *  合格用户任务原话渲染为单段文本,由 runDeps.boundaryAttachment 闭包
   *  注入 loop-engine,compact 触发时追加为一条 user 消息(放在 boundary
   *  placeholder 之后)。
   *
   *  约束:
   *    - 0 句合格 → return undefined,helper 早退(行为 byte-stable,等价
   *      旧 taskFocus undefined → 字段缺席的语义；#605 T2 已退休该字段)。
   *    - 自动模式不再由本函数拦截 — 由 boundaryAttachment 闭包上游在
   *      `session.goal.text.length > 0` 时整段不注入闭包;此处只管 messages。
   *    - 单句上限不限(spec 旧 240 cap 不再现)— 直接整句进入摘录。
   *    - 渲染形态:`<prefix> — N\n1. t1\n2. t2\n…`(数字编号,chronological,
   *      最新交代在末尾,与 extractRecentUserTasks 输出顺序一致)。
   *    - 纯字符串派生,零 IO / 零 LLM 调用;消息结构由 turn-projection.ts
   *      `extractRecentUserTasks` 守门。
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

  /** #458 T5/T12: `/goal clear` 占位 helper (T6 slash + chat-session 调用)。
   *  Clears the pinned goal (SC: goal 一并清空), records the trace clear event,
   *  and persists atomically through the same serialize queue. */
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
   * #620 T3:commit 钩子的 store 落点(仅在 postMessage serialize 槽位内被
   * 调,见 runDeps 处注释 —— 直调 store,不重入队列)。直追 appendEvents;
   * typed store 失败(legacy .json-only 会话升级后首跑 → write_failed;
   * 文件被外部删除 → not_found 等)→ 以当前 session 全量 save 一次
   * bootstrap(save 权威 JSONL 形态;legacy 即 T2 migrate-on-save 语义的提前
   * 触发)后重试一次。非 typed 异常原样上抛;bootstrap / 重试仍败也上抛
   * —— 不静默吞咽(loop-engine 包 MessageCommitError 中止本次 run)。
   */
  private async appendSessionEvents(opts: {
    readonly conversationId: string;
    readonly session: SessionFileV1;
    readonly events: ReadonlyArray<AnthropicNativeMessage>;
    /** D2 (tui-display-consistency):assistant commit 携带的思考时长(ms)。
     *  tool_result / 其它批次 = undefined,appendEvents 不挂 key。 */
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

  /** 裁决#8 + T1: save condition based on stopReason and progress delta.
   *  `priorMessages` = session.messages BEFORE this run (postMessage already
   *  holds it); shouldPersistCheckpoint decides whether to save. Interrupting
   *  stops (cancelled with delta>0) also append a checkpoint record so the
   *  interrupted turn is recoverable / rewind-able.
   *
   *  B1: 返回值 = true 实际落盘 / false 未落盘(shouldPersistCheckpoint 拒绝
   *  或 store.save 抛错)。错误处理语义与改前一致 —— save 失败向上传播,
   *  由 postMessage 的 serialize 队列收口,不在此处 warn。*/
  private async conditionalSave(opts: {
    readonly conversationId: string;
    readonly session: SessionFileV1;
    readonly result: RunResult;
    readonly priorMessages: ReadonlyArray<AnthropicNativeMessage>;
  }): Promise<boolean> {
    const { conversationId, session, result, priorMessages } = opts;
    const shouldPersist = shouldPersistCheckpoint(result, priorMessages);
    const dirtyRoot = this.dirtyWorktreeRoots.get(conversationId);
    if (!shouldPersist && dirtyRoot === undefined) return false;
    const now = new Date().toISOString();
    const updated = shouldPersist
      ? (() => {
          const turnCount = session.turnCount + result.turnCount;
          const interruptReason = toInterruptReason(result.stopReason);
          // appendCheckpoint compares record.messagesCount to
          // session.messages.length for its delta=0 guard, so it must receive
          // the session BEFORE new messages are merged in.
          const withCheckpoint =
            interruptReason === null
              ? session
              : appendCheckpoint(session, {
                  turnIndex: turnCount,
                  messagesCount: result.messages.length,
                  interruptedAt: now,
                  interruptReason,
                  ...(result.lastUsage !== null
                    ? { lastUsage: result.lastUsage }
                    : {}),
                });
          return {
            ...withCheckpoint,
            messages: result.messages,
            turnCount,
            updatedAt: now,
            schemaVersion: CURRENT_SCHEMA_VERSION,
            title: extractTitle(result.messages),
          };
        })()
      : session;
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
   * T7：切换对外可见的 MCP face。旧 manager 先 shutdown（或保持为唯一失败面），
   * 再公开新 manager / roots / catalog——禁止旧+新同时成功。
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
    };
    this.engineByRoot.set(root, entry);
    this.activeEngineRoot = root;
    await this.activateMcpFace(entry);
    this.activateSubagentManager(entry.subagentManager);
    this.autoMemory = this.autoMemory ?? built.autoMemory;
    this.overlayMemoryPrefetch =
      this.overlayMemoryPrefetch ?? built.overlayMemoryPrefetch;
    return entry;
  }

  /**
   * fs 档 holder 当前快照（holder 缺席 → undefined）。**每次调用现读**：
   * 翻档只影响之后的调用，不重建引擎（ADR-0092 SC11–SC13）。
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
    }
  > {
    if (!this.askUser) {
      throw new Error(
        "ask_inlet_missing: SessionHub lazy deps require AskUser (#162)"
      );
    }
    const env = this.envProvider ? this.envProvider() : loadIknowEnv();
    // T6:productRoot 稳定；workspaceRoot/cwd/sandboxRoot 跟随当前 task root。
    // 末档从 `root` 改为 `mainCheckoutOf(root)`（T6 / ADR-0037 §4）：宿主没显式
    // 传两个根时（serve 默认、TUI 之外的调用方），改绑后 root 就是 task 树，
    // 直接当 productRoot 会把项目身份与 per-root 状态一起搬到裸树上。树是
    // `<main>/.iknow/worktrees/<conv>`，主 checkout 由同一命名 SSOT 派生，
    // 重启后恢复到树上的会话同样得到主仓。
    const productRoot =
      this.productRoot ?? this.workspaceRoot ?? mainCheckoutOf(root);
    // Review round 3:项目身份根与 productRoot 分开 —— 后者服务 mcpConfigRoot /
    // 状态锚，取自宿主的 workspaceRoot；身份要的是操作员绑定的那个项目。
    // `bindWorkspace` 不要求绑定路径是仓根（只校验绝对且存在），所以
    // `boundRoot` 可能是 `/repo/packages/app`；拿 `root` 现算会在改绑后跳到仓根。
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
      // Review High-2 (hard req 9): reuse the startup settings object — a
      // worktree-rooted loadIknowSettings({cwd}) would silently drop project
      // settings (`.iknow/` is gitignored inside the worktree).
      ...(this.startupSettings ? { settings: this.startupSettings } : {}),
      // ADR-0037 T3:mutate 门禁 host 缝 —— 开关读取在 build-engine 启动加载点;
      // provision 负责建树 + 仅本会话根改绑。T4:passthrough 不经
      // conversation-agnostic 的 initiallyBound —— 会话已在本会话自己的 task
      // worktree 时由 provision 幂等放行（返回同根），别会话的树 / 无关
      // worktree 由 provision fail-closed（typed foreign_worktree）。
      worktreeIsolation: {
        // 纯透传走共享 SSOT worktree-host.ts（PR #869/#881 与 2026-09-05
        // TUI 缝两次手工解构丢 name 之后的一致性收敛：入口禁止手写
        // 逐字段解构 wrapper）。
        ...createWorktreeHostProvision({
          provisionWorktree: (ctx) => this.provisionWorktree(ctx),
        }),
        // T7:enter-worktree 工具缝 —— 会话显式进入本仓已存在的 task
        // worktree（含他人树）；授权锚 = 持久化的 session.workspaceRoot。
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
        // T8:exit-worktree 工具缝 —— 会话回到主仓根，树保留不删。
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
      // D-α T3 / ADR-0030:overlay holder 透传 —— serve / TUI 的 `/graph` 与
      // Shift+Tab 翻的是同一个它（SC3 三入口同 holder）。
      ...(this.graphMode ? { graphMode: this.graphMode } : {}),
      // ADR-0092 / SC13:fs isolation holder 透传 —— `/config` 翻的是同一个
      // 它（bash 工厂 per-call 读）。holder 缺席 → key 不出现（引擎侧
      // `opts.fsMode?.get() ?? "global"` 与静态字符串默认同解析）。
      ...presentFields("fsMode", this.fsMode),
      // #950 T2 / session-folder-consolidation / ADR-0071 Decision 2:
      // todos 落「会话文件夹」—— `todoDir` 改为「会话项目目录」
      // (由 SessionStore.getProjectDir() 暴露的 read-only 投影)。三入口
      // (cli / serve / TUI) 共享同一对 `(baseDir, projectIdentityRoot)` →
      // 同一会话解析到同一 projectDir(`<surface>` 分裂消除)。
      todoDir: this.store.getProjectDir(),
      // ADR-0088:后台任务登记根 = 同一项目树的兄弟 `tasks/`。store 的
      // projectDir 已是 `<poolRoot>/projects/<slug>`(ADR-0071 公式),故
      // 任务登记与会话文件夹同 slug,不锚 workspaceRoot。
      tasksDir: join(this.store.getProjectDir(), TASKS_DIR_NAME),
      // review-fix (M5): 两段式缝 —— 装配期只传 projectDir
      // (`<baseDir>/projects/<slug>`),manager spawn 期按 def.conversationId
      // 派生 per-conversation 叶子 `<projectDir>/<convId>/subagents/`
      // (与 todoDir 的 resolveConversationTodoPath 同构)。会话删除时
      // SessionStore.delete 整删 `<convId>/` 文件夹,子代理记录同灭,
      // 不在项目层留孤儿。旧的项目层平铺 `<projectDir>/subagents/`
      // (`resolveSubagentTraceDirShared`)已退役。
      // `createTrace("subagent")` (conversationId 聚合单文件) 已退役。
      projectDir: this.store.getProjectDir(),
      // live-graph-phase1 T1:账本 host 透传 —— 按 ctx.conversationId 解析会话
      // 账本；resetSession / shutdown 销毁。
      ...(this.liveGraphLedger
        ? { liveGraphLedger: this.liveGraphLedger }
        : {}),
      ...(this.traceOut !== undefined
        ? { subagentDiagnosticsDir: this.traceOut }
        : {}),
    });
    this.mcpHome = homedir();
    // T7:mcpManager / catalog / mcpRoots 由 getOrBuildEngine → activateMcpFace
    // 统一切换，避免此处抢先覆盖导致旧 manager 未收口。
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
      // 注入 deps 的 host 自己 build 了 engine（TUI），快照句柄经构造 opts
      // 进来;纯测试注入路径没有 engine → undefined,行为零变化。
      // Review High-1 (2026-08-29):host 声明 injectedEngineRoot 且会话根已
      // 离开该根（worktree rebind）→ 落到 per-root 引擎重建（buildEngine 缝
      // / 生产装配），与 hub.ts 两条装配路径行为一致；未声明 → 短路语义与
      // 今日逐字节一致。
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
      // D-α T3:per-root 多引擎时,活跃快照跟着本次解析到的那台走。
      // T7:优先 activeEngineRoot，避免 MCP list/reload 被 bindRoot 抢回主仓 face。
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
    // settings-hot-reload（T3）:envProvider 注入后用它拿 env（替代内部
    // loadIknowEnv()）。缺省 → 既有行为零变化（仍内部 loadIknowEnv）。
    const env = this.envProvider ? this.envProvider() : loadIknowEnv();
    // Delegate validation and assembly to the SSOT. `buildHarnessEngine`
    // validates apiKey/askUser through the shared fail-loud path, preserving
    // the same ValidationError → HTTP 400 mapping for serve callers.
    // The returned `engine` is built once (code-review 2026-08-05) and
    // discarded — serve only consumes `deps`, and the cost is a single
    // `createLoopEngine` allocation, not a per-message re-construction.
    // #440 T1-fix + #950 T2:serve 入口注入 session-folder todoDir
    // (`this.store.getProjectDir()`),per-conversationId 解析在调用期由
    // todo-write.ts:resolveConversationTodoPath 派生 —— 不再需要 per-session
    // engine 重建(cachedDeps 共享的只是「根」,叶子按 ctx.conversationId 分)。
    // review-fix (Fix 1): subagent 生命周期事件落盘（spec SC1 生产装配）——
    // hub 的 subagentManager 是单例共享（surface!=="ask" 在 build-engine.ts:307-320
    // 自建一次）, 所有 serve 会话的 subagent 事件聚合到 <traceOut>/subagent.jsonl
    // (conversationId="subagent")；reader 侧按 per-record task_id 过滤。
    // 仅当 this.traceOut 配置（serve.ts 总会传 resolveTracePath 解析值）才注入；
    // 缺席 → manager 走 build-engine 默认 NoopTraceService (byte-stable)。
    const built = await buildHarnessEngine({
      env,
      askUser: this.askUser,
      ...(this.sandboxRoot ? { sandboxRoot: this.sandboxRoot } : {}),
      // Review High-2 (hard req 9): fallback path reuses the startup settings
      // object too (rebind-rebuilt engines must not reload settings).
      ...(this.startupSettings ? { settings: this.startupSettings } : {}),
      // ADR-0037 T3:未 bind 根的兜底路径同样接 isolation host 缝
      // （repoRoot = sandboxRoot ?? process.cwd();session workspaceRoot 缺席
      // 的会话在 rebind 后下一回合走 per-root 引擎路径）。T4:同上——
      // passthrough 由 provision 按会话锚定，不设 initiallyBound。
      worktreeIsolation: {
        // 纯透传走共享 SSOT worktree-host.ts（PR #869/#881 与 2026-09-05
        // TUI 缝两次手工解构丢 name 之后的一致性收敛：入口禁止手写
        // 逐字段解构 wrapper）。
        ...createWorktreeHostProvision({
          provisionWorktree: (ctx) => this.provisionWorktree(ctx),
        }),
        // T7:enter-worktree 工具缝 —— 会话显式进入本仓已存在的 task
        // worktree（含他人树）；授权锚 = 持久化的 session.workspaceRoot。
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
        // T8:exit-worktree 工具缝 —— 会话回到主仓根，树保留不删。
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
      // D-α T3 / ADR-0030:overlay holder 透传 —— serve / TUI 的 `/graph` 与
      // Shift+Tab 翻的是同一个它（SC3 三入口同 holder）。
      ...(this.graphMode ? { graphMode: this.graphMode } : {}),
      // ADR-0092 / SC13:fs isolation holder 透传 —— `/config` 翻的是同一个
      // 它（bash 工厂 per-call 读）。holder 缺席 → key 不出现（引擎侧
      // `opts.fsMode?.get() ?? "global"` 与静态字符串默认同解析）。
      ...presentFields("fsMode", this.fsMode),
      // live-graph-phase1 T1:账本 host 透传 —— 同 production 路径形态。
      ...(this.liveGraphLedger
        ? { liveGraphLedger: this.liveGraphLedger }
        : {}),
      // review-fix (M1 / H1): serve entry 已解析的 workspaceRoot 透传 —
      // 让 build-engine 的 bash fence 对齐 serve 的 identity seed / dataDir
      // (同一 per-root 锚点,不落回 sandboxRoot|cwd)。
      ...(this.workspaceRoot ? { workspaceRoot: this.workspaceRoot } : {}),
      // T6:稳定 productRoot（缺席时 build-engine 桥接为 workspaceRoot）。
      ...(this.productRoot ? { productRoot: this.productRoot } : {}),
      // #950 T2 / session-folder-consolidation / ADR-0071 Decision 2:
      // todos 落「会话文件夹」—— `todoDir` 取 store 投影的 projectDir,与
      // 上面 `buildProductionEngine` 路径同源(`<surface>` 分裂消除)。
      todoDir: this.store.getProjectDir(),
      // ADR-0088:同 `buildProductionEngine` 路径 —— 登记根 = 项目树兄弟
      // `tasks/`(store 投影同一 slug)。
      tasksDir: join(this.store.getProjectDir(), TASKS_DIR_NAME),
      // review-fix (M5): 同 buildProductionEngine 路径 —— 两段式缝,装配期
      // 传 projectDir,manager spawn 期按 def.conversationId 派生
      // per-conversation 叶子(见 resolveSubagentTraceDirShared 退役注释)。
      projectDir: this.store.getProjectDir(),
      ...(this.traceOut !== undefined
        ? { subagentDiagnosticsDir: this.traceOut }
        : {}),
    });
    this.cachedDeps = built.deps;
    // D-α T3:单引擎（未 bind 根）路径的活跃快照。
    this.activeGraphAssembly = built.graphAssembly;
    this.skillCatalog = built.skillCatalog;
    this.mcpHome = homedir();
    await this.activateMcpFace({
      ...(built.mcpManager ? { mcpManager: built.mcpManager } : {}),
      ...(built.mcpRoots ? { mcpRoots: built.mcpRoots } : {}),
      ...(built.catalog ? { catalog: built.catalog } : {}),
    });
    // #356 T7: serve 懒取 subagent manager — buildHarnessEngine 在 surface !==
    // "ask" 时自建;每次装配的 manager 都进入永久聚合面，active manager
    // 则只服务 spawn / verify classifier。
    this.activateSubagentManager(built.subagentManager);
    // auto-memory T4:与 subagentManager 同形态懒取(构造注入优先)。
    this.autoMemory = this.autoMemory ?? built.autoMemory;
    this.overlayMemoryPrefetch =
      this.overlayMemoryPrefetch ?? built.overlayMemoryPrefetch;
    // #356 High#4 (SC12/SC3):缓存 built.shutdown(组合句柄 mcpManager first →
    // subagentManager second)。serve 入口退出前经 hub.shutdown() 触发 —
    // cli.ts runServe 挂 registerShutdown(hub),进程退出时清理 MCP 连接 +
    // subagent stdio 子进程(SC11/SC16)。测试注入 deps 路径无 built →
    // shutdown 缺席 → hub.shutdown() no-op。
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
   * auto-memory T4 / ADR-0031 D5: hand a finished turn to the auto-memory
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
    /** T6: best-effort 收尾摘要文本(异常停时由 postMessage 捕获)。 */
    readonly stopSummary?: string;
    /** B1: run 前 session.messages —— 与 conditionalSave 同源,供 cancelled
     * 判定 shouldPersistCheckpoint(delta>0 → interrupted=true)。非 cancelled
     * 不消费;缺席(catch 分支等)时 cancelled 缺省判定 false。 */
    readonly priorMessages?: ReadonlyArray<AnthropicNativeMessage>;
    /** #128 M3: verify 最终判定视图 (failed/unstable/escalated)。缺席 = 无 verify
     * 或判定为 passed/disabled/aborted (byte-stable)。 */
    readonly verify?: VerifyAnswerView;
    /** D2 (tui-display-consistency) wire surface: 本回合 assistant 思考时长
     * (ms)。postMessage / continuePending 路径在 commitMessages 拿到
     * turnResult.thinkingMs 后写入; > 0 时挂到 TurnAnswerDto `thinkingMs`
     * 字段。缺席 = 旧会话 / 无思考 / 边界非法 (byte-stable, 与
     // thinking/toolCalls/lastUsage 同模式)。 */
    readonly thinkingMs?: number;
  }): TurnDto {
    const { query, result } = opts;
    // SC20: serve SPA output boundary — mask known secret values in the
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
        // 上下文用量显示：result.lastUsage 非 null 时透传；null → 字段缺席
        // (byte-stable；与 thinking/toolCalls 同模式；ADR-0008 D5)。
        ...(result.lastUsage !== null ? { lastUsage: result.lastUsage } : {}),
        // T6: 收尾摘要仅在异常停时挂上;completed 永不 emit stop_summary,
        // 即使宿主传了 stopSummary 也不会误附(byte-stable,正常停缺席)。
        ...(opts.stopSummary !== undefined &&
        opts.stopSummary.length > 0 &&
        result.stopReason !== "completed"
          ? { stopSummary: opts.stopSummary }
          : {}),
        // B1: 打断反馈 —— 仅 cancelled 时带上 interrupted(布尔:true=已保存
        // checkpoint / false=无新内容未落盘)。其它 stopReason 字段缺席
        // (byte-stable,与 thinking/toolCalls/lastUsage 同模式)。
        ...(result.stopReason === "cancelled"
          ? {
              interrupted: shouldPersistCheckpoint(
                result,
                opts.priorMessages ?? []
              ),
            }
          : {}),
        // #128 M3: verify 最终判定 (failed/unstable/escalated) surface。
        // 仅 verify 配置且判定非 passed/disabled/aborted 时存在 (byte-stable)。
        ...(opts.verify !== undefined ? { verify: opts.verify } : {}),
        // D2 (tui-display-consistency): thinkingMs (ms) 透传。> 0 才挂,
        // 缺席 = 旧会话 / 无思考回合 / 边界非法 (byte-stable)。
        ...(opts.thinkingMs !== undefined && opts.thinkingMs > 0
          ? { thinkingMs: opts.thinkingMs }
          : {}),
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
