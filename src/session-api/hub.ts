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
  type TraceService,
} from "../harness/index.js";
import {
  evaluateCompactTrigger,
  getAutoCompactThreshold,
  type CompactReason,
  type CompactTriggerDecision,
} from "../harness/compress/index.js";
import {
  runVerifyLoop,
  type VerifyConfig,
  type VerifyLoopOutcome,
} from "../harness/verify/index.js";
import { createRunClassifierFromManager } from "../harness/verify/run-classifier-adapter.js";
import {
  buildHarnessEngine,
  createAdapterFromEnv,
} from "../harness/build-engine.js";
import { drainPendingSubagents } from "../harness/subagent/host-drain.js";
import type {
  SubAgentManager,
  SubagentInfo,
} from "../harness/subagent/manager.js";
import { getVersion } from "../cli/usage.js"; // SC-W 6/7: agentVersion 注入(与 session-api/http.ts 同向 import,无循环)
import type { AskUser } from "../harness/permission/types.js";
import type {
  ServeAskUserHandle,
  PendingAskView,
} from "../harness/permission/ask-user.js";
import type { SessionGrants } from "../harness/permission/session-grants.js";
import type { PermissionModeContext } from "../harness/permission/modes.js";
import { createViolationCounter } from "../harness/sandbox/violation-handling.js";
import { wrapWithViolationHook } from "../harness/sandbox/violation-executor.js";
import {
  createOutputMask,
  currentSecretValues,
} from "../harness/sandbox/index.js";
import { loadIknowEnv, type IknowEnv, type LlmEnv } from "../config/env.js";
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
import { LLM_API_KEY_MISSING_MESSAGE } from "../config/messages.js";
import { MaxTurnsExceeded } from "../harness/errors.js";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { resolveSessionTodoDir } from "../harness/aci/tools/todo-write.js";
import type { AciCatalog } from "../harness/aci/types.js";
import type { SkillCatalog } from "../harness/skill/catalog.js";
import { createSkillBody } from "../harness/skill/body.js";
import type { McpManager } from "../harness/mcp/manager.js";
import { loadMcpConfig } from "../harness/mcp/config.js";
import { SessionStore, type SessionListEntry } from "./store/index.js";
import type { SessionStoreError } from "./store/index.js";
import type { SessionFileV1 } from "./store/index.js";
import {
  appendCheckpoint,
  rewindFile,
  CURRENT_SCHEMA_VERSION,
  extractTitle,
  pinGoal,
  shouldPersistCheckpoint,
  toInterruptReason,
  validateGoalText,
} from "./store/index.js";
import type { GoalStatus } from "./store/index.js";
import { applyTransition, assertValidTransition } from "./goal/index.js";
import {
  applyGoalAutoContinue,
  applyGoalAutoError,
  parseGoalPinInput,
  reportGoalAutoStoreLoadErr,
  runAutoLoopSteps,
} from "./goal-auto.js";
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
  SessionSummary,
  SkillSummaryDto,
  TurnDto,
  VerifyAnswerView,
} from "./contract.js";
import { MAX_MESSAGE_CHARS } from "./contract.js";
import {
  extractRecentUserTasks,
  isTurnQuery,
  messageText,
  projectThinkingView,
  projectToolCalls,
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
 * 全部 createAdapterFromEnv 入参：model / apiKey / baseUrl / maxOutputTokens /
 * temperature / stream + thinking 控制器 thinking / thinkingEffort。fallback
 * 与 adapter 无关但反映配置变更，也纳入比较（数组逐元素、顺序敏感）。
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
  if (a.fallback.length !== b.fallback.length) return false;
  for (let i = 0; i < a.fallback.length; i++) {
    if (a.fallback[i] !== b.fallback[i]) return false;
  }
  return true;
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
  readonly compactAction: CompactTriggerDecision["action"] | undefined;
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
 */
export function projectMessagesToTurns(
  messages: ReadonlyArray<AnthropicNativeMessage>
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
    turns.push({
      query,
      answer: {
        finalText,
        stopReason: "completed",
        turnCount: turnIndex,
        ...(thinking !== undefined ? { thinking } : {}),
        ...(toolCalls !== undefined ? { toolCalls } : {}),
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
   * review-fix (M1 / H1): per-root state anchor。serve 入口解析后
   * 透传 —— 让 hub 的 buildHarnessEngine 走 entry-resolved workspaceRoot,
   * 保证 serve 与 CLI flag 路径同形态(seed 落 `<workspaceRoot>/.iknow`,
   * bash fence 保护 `<workspaceRoot>/.iknow`)。缺席 → build-engine
   * 走 cwd fallback(legacy 默认)。
   */
  readonly workspaceRoot?: string;
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
   * serve-workspace T2 测试缝：按根装配 engine，避免单测走真实 LLM。
   * 生产省略 → `buildHarnessEngine` 且 cwd/workspaceRoot/sandboxRoot 三等。
   */
  readonly buildEngine?: (root: string) => Promise<{
    deps: LoopEngineDeps;
    shutdown?: () => Promise<void>;
    subagentManager?: SubAgentManager;
  }>;
  /**
   * serve-workspace T3: recents/trust 名单的 home 根（落
   * `<recentsHome>/.iknow/workspaces.json`）。生产 serve.ts 传 `homedir()`；
   * 缺席 → bindWorkspace 保持 T2 语义（无 trust gate、不落 recents）。
   */
  readonly recentsHome?: string;
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
  private cachedDeps: LoopEngineDeps | undefined;
  private readonly defaults: {
    jsonMode: boolean;
  };
  /** JSONL trace output path; when set, postMessage creates a per-session trace. */
  private readonly traceOut: string | undefined;
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
  /** review-fix (M1 / H1): per-root state anchor 缓存；serve 入口解析后透传。 */
  private readonly workspaceRoot: string | undefined;
  /** #128 T8: 验证闭环配置（settings.verify 段；缺席 = 透明关闭）。 */
  private readonly verifyConfig: VerifyConfig | undefined;
  /** #356 High#4: built.shutdown 缓存（组合句柄；ensureDeps 懒取，hub.shutdown 触发）。 */
  private cachedShutdown: (() => Promise<void>) | undefined;
  /** TUI TuiExtensions 同源：lazy ensureDeps 后才有；deps 注入测试路径保持缺席。 */
  private skillCatalog: SkillCatalog | undefined;
  private mcpManager: McpManager | undefined;
  private aciCatalog: AciCatalog | undefined;
  private mcpHome: string | undefined;
  private mcpCwd: string | undefined;
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
  /** serve-workspace T2: test seam; production omits → buildHarnessEngine. */
  private readonly buildEngine:
    | ((root: string) => Promise<{
        deps: LoopEngineDeps;
        shutdown?: () => Promise<void>;
        subagentManager?: SubAgentManager;
      }>)
    | undefined;
  /** serve picker bind (T2); session file workspaceRoot is the engine Map key. */
  private boundRoot: string | undefined;
  /** serve-workspace T3: recents/trust roster home (absent → T2 behavior). */
  private readonly recentsHome: string | undefined;
  /** Per-root BuiltEngine cache (same root shared across sessions). */
  private readonly engineByRoot = new Map<
    string,
    {
      deps: LoopEngineDeps;
      shutdown?: () => Promise<void>;
      subagentManager?: SubAgentManager;
    }
  >();
  /** Per-conversation serialization (spec A15). */
  private readonly inflight = new Map<string, Promise<void>>();

  constructor(opts: SessionHubOptions) {
    if (!opts.askUser && !opts.deps) {
      throw new Error(
        "ask_inlet_missing: SessionHub requires AskUser or pre-built deps (#162 / SC18)"
      );
    }
    this.store = opts.store;
    this.injectedDeps = opts.deps;
    this.cachedDeps = opts.deps;
    this.buildEngine = opts.buildEngine;
    this.traceOut = opts.traceOut;
    this.askUser = opts.askUser;
    this.askHandle = opts.askHandle;
    this.sessionGrants = opts.sessionGrants;
    this.permissionMode = opts.permissionMode;
    this.overrideEnv = opts.overrideEnv;
    this.sandboxRoot = opts.sandboxRoot;
    this.surface = opts.surface;
    this.subagentManager = opts.subagentManager;
    // review-fix (M1 / H1): per-root state anchor 缓存。
    this.workspaceRoot = opts.workspaceRoot;
    this.recentsHome = opts.recentsHome;
    this.verifyConfig = opts.verifyConfig;
    this.envProvider = opts.envProvider;
    this.onEnvChange = opts.onEnvChange;
    this.defaults = {
      jsonMode: opts.defaultJsonMode ?? false,
    };
  }

  // -- public API --------------------------------------------------------------

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
    return this.subagentManager?.listSubagents() ?? [];
  }

  /**
   * #356 High#4 (SC12/SC3):serve 长程入口的清理句柄 —— 转发 ensureDeps 缓存
   * 的 built.shutdown（组合句柄 mcpManager first → subagentManager second）。
   * cli.ts runServe 用 registerShutdown(hub) 把本方法挂到 SIGINT/SIGTERM,
   * 进程退出前关闭 MCP 后台连接 + SIGTERM subagent stdio 子进程(SC11/SC16)。
   * ask/deps-injected 形态无 built → 缓存缺席 → no-op(行为零变化)。
   */
  async shutdown(): Promise<void> {
    await this.cachedShutdown?.();
    for (const entry of this.engineByRoot.values()) {
      await entry.shutdown?.();
    }
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
    const id = randomUUID();
    const now = new Date().toISOString();
    const root = this.boundRoot;
    const file: SessionFileV1 = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      conversation_id: id,
      messages: [],
      jsonMode: req?.json_mode ?? this.defaults.jsonMode,
      turnCount: 0,
      updatedAt: now,
      title: "",
      cwd: root ?? process.cwd(),
      sanitized_at: now,
      checkpoints: [],
      ...(root !== undefined ? { workspaceRoot: root } : {}),
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
      turns: projectMessagesToTurns(file.messages),
    };
  }

  async postMessage(opts: {
    readonly conversationId: string;
    readonly text: string;
    readonly signal?: AbortSignal;
    readonly thinking?: ThinkingOverride;
    readonly onStream?: (event: HarnessStreamEvent) => void;
  }): Promise<PostMessageResponse> {
    const { conversationId, text } = opts;
    // #408 T3: leading `## GOAL:` re-pins the session goal. Detect BEFORE
    // validateText so the goal text (not the raw directive) is what gets
    // validated and run. `null` = no directive → whole text is the query.
    // `""` = empty directive → stripped to empty → validateText rejects
    // below (goal unchanged, since we only persist after run succeeds).
    const goalDirective = parseGoalCommand(text);
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
    this.validateText(query);
    return this.serialize({
      conversationId,
      work: async () => {
        let session = await this.store.load(conversationId);
        if (this.surface === "serve" && session.workspaceRoot === undefined) {
          throw new ValidationError(
            "workspace is unbound; select a workspace before sending",
            { field: "workspaceRoot" }
          );
        }
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
        const baseDeps = await this.ensureDeps(session.workspaceRoot);
        // T2: per-turn override — rebuild deps with a one-shot adapter only;
        // executor / registry / maxTurns / timeoutMs are reused from the
        // cached deps. When absent, the cached path is unchanged.
        const deps =
          opts.thinking !== undefined
            ? withThinkingOverride({
                deps: baseDeps,
                override: opts.thinking,
                env: this.overrideEnv,
              })
            : baseDeps;
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
              const drained = await drainPendingSubagents(this.subagentManager);
              const drainedMsg: AnthropicNativeMessage = {
                role: "user",
                content: [{ type: "text", text: drained }],
              };
              const priorMessages = drained
                ? [...session.messages, drainedMsg]
                : session.messages;
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
              const runOutcome = this.verifyConfig
                ? await runVerifyLoop({
                    runFn: (text, o) =>
                      run(text, runDeps, o?.signal, {
                        priorMessages: o?.priorMessages ?? priorMessages,
                        onStream: o?.onStream ?? wrappedOnStream,
                      }),
                    // ADR-0024: two modules, not `goal.text ?? query`. Non-empty
                    // goal → auto (userText = goal.text); else HITL (userText =
                    // query). taskFocus never entered verify input (#473) and
                    // is gone with #605 T2's retirement.
                    completionMode:
                      session.goal !== undefined && session.goal.text.length > 0
                        ? "auto"
                        : "hitl",
                    userText:
                      session.goal !== undefined && session.goal.text.length > 0
                        ? session.goal.text
                        : query,
                    config: this.verifyConfig,
                    sessionId: conversationId,
                    signal: opts.signal,
                    trace: runDeps.trace,
                    cwd: session.workspaceRoot ?? process.cwd(),
                    // #128 SC1 生产装配: subagentManager 在场 → 启用分类器填空
                    // (command 缺失/空串时分类器接管, spec Objective);缺席
                    // (ask 形态) → undefined, verify-loop 自然走透明关闭向后兼容。
                    runClassifier:
                      this.subagentManager === undefined
                        ? undefined
                        : createRunClassifierFromManager({
                            manager: this.subagentManager,
                            ...(this.verifyConfig.classifierModel !== undefined
                              ? {
                                  classifierModel:
                                    this.verifyConfig.classifierModel,
                                }
                              : {}),
                          }),
                  })
                : await run(query, runDeps, opts.signal, {
                    priorMessages,
                    onStream: wrappedOnStream,
                  });
              const result = runOutcome.result;
              // #408 T5: capture the terminal outcome for post-run write-back.
              verifyOutcome =
                "outcome" in runOutcome ? runOutcome.outcome : undefined;
              verifyRecords = "records" in runOutcome ? runOutcome.records : [];
              // #128 M3: verify 最终判定 (failed / unstable / escalated) surface 到
              // DTO, 避免"模型声称完成但验证没过"仍显示 completed (SC2/SC6 交付面)。
              // 仅 verify 分支有 outcome/rounds; 裸 run 分支无 (字段缺席)。
              verifyView =
                "outcome" in runOutcome &&
                (runOutcome.outcome === "failed" ||
                  runOutcome.outcome === "unstable" ||
                  runOutcome.outcome === "escalated")
                  ? { outcome: runOutcome.outcome, rounds: runOutcome.rounds }
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
              this.applyHubAutoContinue({
                conversationId,
                result: s.finalResult,
                priorCount: s.priorCount,
                ...(s.verifyOutcome !== undefined
                  ? { verifyOutcome: s.verifyOutcome }
                  : {}),
                records: s.verifyRecords,
              }),
            buildStop: async (s) => ({
              session: this.summarize({
                file: await this.store.load(conversationId),
              }),
              turn: this.toTurnDto({
                query,
                result: s.finalResult,
                turnMessages: s.finalResult.messages.slice(s.priorCount),
                // B1: rendered interrupted is decided against the SAME priorMessages
                // as conditionalSave — byte-identical shouldPersistCheckpoint verdict
                // (saved 只在 cancelled 时消费;completed 等 stopReason 不读它)。
                priorMessages: session.messages,
                ...(capturedStopSummary !== undefined &&
                capturedStopSummary.length > 0
                  ? { stopSummary: capturedStopSummary }
                  : {}),
                // #128 M3: 验证最终判定 (failed/unstable/escalated) surface 到 DTO。
                ...(s.verifyView !== undefined ? { verify: s.verifyView } : {}),
              }),
            }),
            reloadSession: async () => {
              // Hub refreshes session state between auto-loop iterations.
              // (Chat passes a no-op since its session lives in `ctx.state`.)
              session = await this.store.load(conversationId);
            },
          });
        } catch (err) {
          await this.applyHubAutoError(conversationId, err);
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
      },
    });
  }

  async resetSession(
    conversationId: string,
    _opts?: { new_id?: boolean }
  ): Promise<ResetSessionResponse> {
    return this.serialize({
      conversationId,
      work: async () => {
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
   * `{ compacted: false, cancelled: true }`(additive 字段,与"未达阈值"
   * 的 compacted=false 区分)。host observer 与 adapter 错误均经
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

        // plan compress-trigger-gate T2: 走 `evaluateCompactTrigger` 统一判据。
        // `cachedDeps.compress` 缺席(ask / oneshot 等无 harness 装配)→ 跳过
        // 判据层,fallback 到既有 splitForCompaction 行为(向后兼容)。
        const compressCfg = this.cachedDeps?.compress;
        let compactAction: CompactTriggerDecision["action"] | undefined;
        if (compressCfg !== undefined) {
          const threshold = getAutoCompactThreshold(
            compressCfg.contextWindow,
            compressCfg.thresholdTokens
          );
          compactAction = evaluateCompactTrigger(before, {
            contextWindow: compressCfg.contextWindow,
            threshold,
          }).action;
        }

        // 1) token 未达阈值 → 直接 noop 返回(reason 来自判据),不调 splitForCompaction。
        if (compactAction === "noop") {
          return {
            session: this.summarize({ file: session }),
            turns: projectMessagesToTurns(before),
            compacted: false,
            reason: "below_token_threshold",
            beforeCount: before.length,
            afterCount: before.length,
          };
        }

        // 2) 决定 dropped / kept:
        //    - compact_via_window → splitForCompaction 的窗口守门结果;
        //    - compact_via_full_summary → 整段视为 dropped,kept = [];
        //    - compressCfg 缺席 → 走既有 splitForCompaction(无判据)。
        let split: {
          readonly dropped: ReadonlyArray<AnthropicNativeMessage>;
          readonly kept: ReadonlyArray<AnthropicNativeMessage>;
        };
        if (compactAction === "compact_via_full_summary") {
          split = { dropped: before, kept: [] };
        } else {
          const windowSplit = splitForCompaction(before);
          if (windowSplit === undefined) {
            // 判据与 splitForCompaction 一致:此分支不可达(windowed 必 kept>0)。
            // 防御兜底:无 dropped 前缀 → 视为消息条数过少,no-op 返回。
            return {
              session: this.summarize({ file: session }),
              turns: projectMessagesToTurns(before),
              compacted: false,
              reason: REASON_NO_COMPRESS,
              beforeCount: before.length,
              afterCount: before.length,
            };
          }
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
              // bump updatedAt;cancelled:true 区分"未达压缩阈值"的
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
          compactAction,
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
   * 回退会话到 keepTurns（TUI hub-bridge.rewindSession 的 HTTP 同源落点）。
   * 走 serialize 队列，与 compact/postMessage 同互斥。
   */
  async rewindSession(
    conversationId: string,
    keepTurns: number
  ): Promise<RewindSessionResponse> {
    return this.serialize({
      conversationId,
      work: async () => {
        const session = await this.store.load(conversationId);
        const rewound = rewindFile(session, keepTurns);
        const updated: SessionFileV1 = {
          ...rewound,
          updatedAt: new Date().toISOString(),
          schemaVersion: CURRENT_SCHEMA_VERSION,
        };
        await this.store.save({ id: conversationId, file: updated });
        return {
          session: this.summarize({ file: updated }),
          turns: projectMessagesToTurns(updated.messages),
          keepTurns: updated.turnCount,
        };
      },
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
    await this.ensureDeps();
    if (this.mcpManager) {
      const home = this.mcpHome ?? homedir();
      const cwd = this.mcpCwd ?? process.cwd();
      const cfg = await loadMcpConfig({ home, cwd });
      await this.mcpManager.reload(cfg.servers);
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
      // T2 每会话独立文件: violation 与 JsonlTraceService 同域, 写
      // <traceOut>/<conversationId>.jsonl (不再 append 到 traceOut 文件本身)。
      // mkdir recursive 与 JsonlTraceService 构造一致兜底。
      mkdirSync(this.traceOut, { recursive: true });
      const line = JSON.stringify({
        conversation_id: conversationId,
        record_type: "violation",
        ts: new Date().toISOString(),
        detail: safeParse(reason),
      });
      appendFileSync(
        join(this.traceOut, `${conversationId}.jsonl`),
        line + "\n",
        "utf8"
      );
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
    if (query.length > MAX_MESSAGE_CHARS) {
      throw new ValidationError(
        `message text exceeds max length ${MAX_MESSAGE_CHARS}`,
        { field: "text", max: MAX_MESSAGE_CHARS, length: query.length }
      );
    }
  }

  /** #458 T5/T12: per-postMessage trace service (undefined when traceOut is
   *  not configured). Hoisted at the start of serialize's work so the pin /
   *  seed / writeback 发射点 and runDeps share one instance. */
  private createTrace(conversationId: string): TraceService | undefined {
    if (!this.traceOut) return undefined;
    return createJsonlTraceService({
      filePath: this.traceOut,
      conversationId,
    });
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
    if (!shouldPersistCheckpoint(result, priorMessages)) return false;
    const now = new Date().toISOString();
    const turnCount = session.turnCount + result.turnCount;
    const interruptReason = toInterruptReason(result.stopReason);
    // appendCheckpoint compares record.messagesCount to session.messages.length
    // for its delta=0 guard, so it must receive the session BEFORE new messages
    // are merged in (otherwise delta = 0 would always be false and the guard
    // never fires). Compute the checkpointed session first, then merge the
    // post-run messages / turnCount / metadata on top.
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
    const updated: SessionFileV1 = {
      ...withCheckpoint,
      messages: result.messages,
      turnCount,
      updatedAt: now,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      title: extractTitle(result.messages),
    };
    await this.store.save({ id: conversationId, file: updated });
    return true;
  }

  /**
   * Per-root engine cache. Session file `workspaceRoot` is the Map key
   * (picker `boundRoot` is only the fallback when listSkills etc. have no
   * session). Production assembly sets cwd/workspaceRoot/sandboxRoot equal.
   */
  private async getOrBuildEngine(root: string): Promise<{
    deps: LoopEngineDeps;
    shutdown?: () => Promise<void>;
    subagentManager?: SubAgentManager;
  }> {
    const hit = this.engineByRoot.get(root);
    if (hit) return hit;
    const built = this.buildEngine
      ? await this.buildEngine(root)
      : await this.buildProductionEngine(root);
    const entry = {
      deps: built.deps,
      shutdown: built.shutdown,
      subagentManager: built.subagentManager,
    };
    this.engineByRoot.set(root, entry);
    this.subagentManager = this.subagentManager ?? built.subagentManager;
    return entry;
  }

  private async buildProductionEngine(root: string): Promise<{
    deps: LoopEngineDeps;
    shutdown?: () => Promise<void>;
    subagentManager?: SubAgentManager;
  }> {
    if (!this.askUser) {
      throw new Error(
        "ask_inlet_missing: SessionHub lazy deps require AskUser (#162)"
      );
    }
    const env = this.envProvider ? this.envProvider() : loadIknowEnv();
    const built = await buildHarnessEngine({
      env,
      askUser: this.askUser,
      cwd: root,
      sandboxRoot: root,
      workspaceRoot: root,
      ...(this.surface ? { surface: this.surface } : {}),
      ...(this.sessionGrants ? { session: this.sessionGrants } : {}),
      ...(this.permissionMode ? { permissionMode: this.permissionMode } : {}),
      todoDir: resolveSessionTodoDir({ surface: "serve" }),
      ...(this.traceOut !== undefined
        ? {
            subagentTrace: createJsonlTraceService({
              filePath: this.traceOut,
              conversationId: "subagent",
            }),
          }
        : {}),
    });
    this.skillCatalog = built.skillCatalog;
    this.mcpManager = built.mcpManager;
    this.aciCatalog = built.catalog;
    this.mcpHome = homedir();
    this.mcpCwd = root;
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
      return this.cachedDeps ?? this.injectedDeps;
    }
    const mapRoot = sessionRoot ?? this.boundRoot;
    if (mapRoot !== undefined) {
      return (await this.getOrBuildEngine(mapRoot)).deps;
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
    // #440 T1-fix:serve 入口注入 todoDir 让 todo_write 在主 loop 在场
    // (per-conversationId resolution 是后续 ticket — serve 的 cachedDeps
    // 跨所有会话共享,per-conversationId 需 engine 重建,代价太高)。
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
      ...(this.surface ? { surface: this.surface } : {}),
      ...(this.sessionGrants ? { session: this.sessionGrants } : {}),
      ...(this.permissionMode ? { permissionMode: this.permissionMode } : {}),
      // review-fix (M1 / H1): serve entry 已解析的 workspaceRoot 透传 —
      // 让 build-engine 的 bash fence 对齐 serve 的 identity seed / dataDir
      // (同一 per-root 锚点,不落回 sandboxRoot|cwd)。
      ...(this.workspaceRoot ? { workspaceRoot: this.workspaceRoot } : {}),
      todoDir: resolveSessionTodoDir({ surface: "serve" }),
      ...(this.traceOut !== undefined
        ? {
            subagentTrace: createJsonlTraceService({
              filePath: this.traceOut,
              conversationId: "subagent",
            }),
          }
        : {}),
    });
    this.cachedDeps = built.deps;
    this.skillCatalog = built.skillCatalog;
    this.mcpManager = built.mcpManager;
    this.aciCatalog = built.catalog;
    this.mcpHome = homedir();
    this.mcpCwd = process.cwd();
    // #356 T7: serve 懒取 subagent manager — buildHarnessEngine 在 surface !==
    // "ask" 时自建;constructor 注入优先 (测试缝),未注入则取 built 的。
    this.subagentManager = this.subagentManager ?? built.subagentManager;
    // #356 High#4 (SC12/SC3):缓存 built.shutdown(组合句柄 mcpManager first →
    // subagentManager second)。serve 入口退出前经 hub.shutdown() 触发 —
    // cli.ts runServe 挂 registerShutdown(hub),进程退出时清理 MCP 连接 +
    // subagent stdio 子进程(SC11/SC16)。测试注入 deps 路径无 built →
    // shutdown 缺席 → hub.shutdown() no-op。
    this.cachedShutdown = this.cachedShutdown ?? built.shutdown;
    return this.cachedDeps;
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
