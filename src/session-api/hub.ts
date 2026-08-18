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
  type AnthropicContentBlock,
  type AnthropicNativeMessage,
  type HarnessStreamEvent,
  type LoopEngineDeps,
  type RunResult,
  type TraceService,
} from "../harness/index.js";
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
import { ValidationError } from "../shared/errors.js";
import { LLM_API_KEY_MISSING_MESSAGE } from "../config/messages.js";
import { MaxTurnsExceeded } from "../harness/errors.js";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { resolveSessionTodoDir } from "../harness/aci/tools/todo-write.js";
import { SessionStore, type SessionListEntry } from "./store/index.js";
import type { SessionStoreError } from "./store/index.js";
import type { SessionFileV1 } from "./store/index.js";
import {
  appendCheckpoint,
  CURRENT_SCHEMA_VERSION,
  extractGoal,
  extractTitle,
  pinGoal,
  seedTaskFocus,
  shouldPersistCheckpoint,
  toInterruptReason,
  validateGoalText,
} from "./store/index.js";
import type { GoalStatus, TaskFocusState } from "./store/index.js";
import { applyTransition, assertValidTransition } from "./goal/index.js";
import type {
  ApiErrorBody,
  CompactSessionResponse,
  CreateSessionRequest,
  CreateSessionResponse,
  GetSessionResponse,
  PostMessageResponse,
  ResetSessionResponse,
  SessionSummary,
  TurnDto,
  VerifyAnswerView,
} from "./contract.js";
import { MAX_MESSAGE_CHARS } from "./contract.js";
import { projectThinkingView, projectToolCalls } from "./turn-projection.js";
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

/** Extract joined text from text blocks of a native message. */
function textOf(msg: AnthropicNativeMessage): string {
  return msg.content
    .filter(
      (b): b is Extract<AnthropicContentBlock, { type: "text" }> =>
        b.type === "text"
    )
    .map((b) => b.text)
    .join(" ");
}

/**
 * Project raw AnthropicNativeMessage[] → display-form TurnDto[] for wire.
 * Pairs each user message with its subsequent assistant message.
 * Projection is non-authoritative: stopReason/turnCount are lossy (裁决#11).
 *
 * T1: also projects thinking/toolCalls per turn (messages between this user
 * query and the next non-tool_result user message). Mask = SC20 boundary.
 */
export function projectMessagesToTurns(
  messages: ReadonlyArray<AnthropicNativeMessage>
): TurnDto[] {
  const mask = createOutputMask(currentSecretValues()).mask;
  const turns: TurnDto[] = [];
  let turnIndex = 0;
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    if (msg.role !== "user") continue;
    // Skip tool_result user messages (they are continuation, not queries).
    if (msg.content.some((b) => b.type === "tool_result")) continue;
    const query = textOf(msg);
    // Turn slice: from this query until the next non-tool_result user message.
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
 * index of the next non-tool_result user message, or `messages.length` when
 * the turn runs to the end of history. Pulled out to keep
 * `projectMessagesToTurns` ≤10 cyclomatic and the slice-bounds logic in one
 * place (M2 / ACR complexity anti-drift).
 */
function findTurnSliceEnd(
  messages: ReadonlyArray<AnthropicNativeMessage>,
  i: number
): number {
  for (let j = i + 1; j < messages.length; j++) {
    const next = messages[j]!;
    if (
      next.role === "user" &&
      !next.content.some((b) => b.type === "tool_result")
    ) {
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
    const t = textOf(m);
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
  /** Per-conversation serialization (spec A15). */
  private readonly inflight = new Map<string, Promise<void>>();

  constructor(opts: SessionHubOptions) {
    if (!opts.askUser && !opts.deps) {
      throw new Error(
        "ask_inlet_missing: SessionHub requires AskUser or pre-built deps (#162 / SC18)"
      );
    }
    this.store = opts.store;
    this.cachedDeps = opts.deps;
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
    if (!this.cachedDeps) return;
    const env = this.envProvider();
    if (!env.llm.apiKey) {
      throw new ValidationError(LLM_API_KEY_MISSING_MESSAGE);
    }
    // 关键字段值比较去重（model / apiKey / fallback / thinking / thinkingEffort）。
    // 任一变化 → 重建 + 通知；全同 → 跳过（touch 未变内容不触发）。
    const prev = this.lastReloadedEnv;
    if (prev && sameHotReloadKeyFields(prev.llm, env.llm)) return;
    const { adapter } = createAdapterFromEnv(env);
    this.cachedDeps = { ...this.cachedDeps, adapter };
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

  async createSession(
    req?: CreateSessionRequest
  ): Promise<CreateSessionResponse> {
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
      cwd: process.cwd(),
      sanitized_at: now,
      checkpoints: [],
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
    if (goalDirective !== null && goalDirective.length > 0) {
      const msg = validateGoalText(goalDirective);
      if (msg !== null) {
        throw new ValidationError(`${goalDirective} rejected: ${msg}`, {
          field: "goal_text",
        });
      }
    }
    const query = goalDirective !== null ? goalDirective : text.trim();
    this.validateText(query);
    return this.serialize({
      conversationId,
      work: async () => {
        let session = await this.store.load(conversationId);
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
        if (goalDirective !== null && goalDirective.length > 0) {
          const now = new Date().toISOString();
          const pinned: SessionFileV1 = {
            ...session,
            goal: pinGoal({
              current: session.goal,
              text: goalDirective,
              now,
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
            text: goalDirective.slice(0, 200),
            ts: now,
            conversationId,
          });
        }
        const priorCount = session.messages.length;
        const baseDeps = await this.ensureDeps();
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
          // #458 T7 (SC11):compact 边界渲染缝 — taskFocus 在场时注入
          // boundaryAttachment 闭包,compact 触发时在 placeholder 后追加
          // 一条 user 消息承载渲染文本;taskFocus 缺席 → 字段缺席,helper
          // 早退(行为 byte-stable,不影响停止语义 ADR-0011)。renderTaskFocusBoundary
          // 是 hub 内私有 closure — harness 域独立原则,harness 不 import
          // session-api,零反向依赖。
          ...(session.taskFocus !== undefined
            ? {
                // 抽 const 让闭包内引用窄化后的 focus,消除非空断言。
                boundaryAttachment: () => {
                  const focus = session.taskFocus;
                  return focus === undefined
                    ? undefined
                    : this.renderTaskFocusBoundary(focus);
                },
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
        let finalResult: RunResult;
        let verifyView: VerifyAnswerView | undefined;
        // #408 T5: verify-loop terminal outcome (only set when verifyConfig
        // is configured). Captured outside the try block so the post-run
        // write-back can read it.
        let verifyOutcome: VerifyLoopOutcome | undefined;
        try {
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
                // #408 T4 + #449 B8 (修订 per #473): verify-loop's task
                // field = `goal.text ?? query`. The taskFocus segment is
                // DELIBERATELY removed from the verify input (#473): taskFocus
                // is the stable focus anchor (seeded once, never switched by
                // plain queries per OQ2), so feeding it into every verify
                // round made a new task B re-verify the stale task A and
                // short-circuit PASS. Verify must run the pinned mission
                // (goal) or the CURRENT query — never the stable focus.
                // taskFocus keeps its compact-boundary rendering + /goal
                // status roles (data-side only, lifecycle unchanged).
                userText:
                  session.goal !== undefined && session.goal.text.length > 0
                    ? session.goal.text
                    : query,
                config: this.verifyConfig,
                sessionId: conversationId,
                signal: opts.signal,
                trace: runDeps.trace,
                cwd: process.cwd(),
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
        } catch (err) {
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
        // trace is destructured away → immediate GC (not logged/persisted/wired).
        const saved = await this.conditionalSave({
          conversationId,
          session,
          result: finalResult,
          // priorMessages = the file BEFORE this run; only the messages THIS
          // run appended count as progress for the cancelled-delta decision.
          priorMessages: session.messages,
          // #458 T5/T12: trace 透传 — seed 发射点使用; undefined 时无副作用。
          ...(trace !== undefined ? { trace } : {}),
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
        if (verifyOutcome !== undefined && saved) {
          const justSaved = await this.store.load(conversationId);
          if (justSaved.goal !== undefined) {
            const target = OUTCOME_TO_STATUS[verifyOutcome];
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
        return {
          session: this.summarize({
            file: await this.store.load(conversationId),
          }),
          turn: this.toTurnDto({
            query,
            result: finalResult,
            turnMessages: finalResult.messages.slice(priorCount),
            // B1: rendered interrupted is decided against the SAME priorMessages
            // as conditionalSave — byte-identical shouldPersistCheckpoint verdict
            // (saved 只在 cancelled 时消费;completed 等 stopReason 不读它)。
            priorMessages: session.messages,
            ...(capturedStopSummary !== undefined &&
            capturedStopSummary.length > 0
              ? { stopSummary: capturedStopSummary }
              : {}),
            // #128 M3: 验证最终判定 (failed/unstable/escalated) surface 到 DTO。
            ...(verifyView !== undefined ? { verify: verifyView } : {}),
          }),
        };
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
   */
  async compactSession(
    conversationId: string
  ): Promise<CompactSessionResponse> {
    return this.serialize({
      conversationId,
      work: async () => {
        const session = await this.store.load(conversationId);
        const before = session.messages;
        const split = splitForCompaction(before);
        if (split === undefined) {
          return {
            session: this.summarize({ file: session }),
            turns: projectMessagesToTurns(before),
            compacted: false,
            beforeCount: before.length,
            afterCount: before.length,
          };
        }

        // #467 step 2: 优先 LLM 结构化摘要(best-effort,失败回退 placeholder)。
        // cachedDeps 缺席(ask / oneshot 等无 harness 装配)→ adapter 不可用,
        // 跳过 LLM 路径,直接 placeholder。
        let nextMessages: ReadonlyArray<AnthropicNativeMessage> | undefined;
        if (this.cachedDeps?.adapter !== undefined) {
          try {
            const outcome = await runFullCompact({
              adapter: this.cachedDeps.adapter,
              dropped: split.dropped,
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
            }
          } catch {
            // runFullCompact 自身已收敛所有错误到 FullCompactOutcome;
            // 此处 catch 是防御性兜底,任何意外抛出都视作失败 → placeholder。
          }
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
          //   - 摘要轮:messages[0] = SUMMARY_PREAMBLE + 摘要内容 user 消息。
          //   - placeholder 路径:messages[0] = "[compaction boundary ...]" user 消息。
          // 两条路径都走 extractTitle 一致派生,语义对齐。
          title: extractTitle(compacted),
        };
        await this.store.save({ id: conversationId, file: updated });
        return {
          session: this.summarize({ file: updated }),
          turns: projectMessagesToTurns(compacted),
          compacted: true,
          beforeCount: before.length,
          afterCount: compacted.length,
        };
      },
    });
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

  /** #458 T7 (SC11):compact 边界渲染 — 把 TaskFocusState 渲染为单段文本,
   *  由 runDeps.boundaryAttachment 闭包注入 loop-engine,在 compact 触发时
   *  追加为一条 user 消息(放在 boundary placeholder 之后)。纯字符串派生,
   *  零 IO / 零 LLM 调用(v1 排除)。
   *
   *  输出形态:当前焦点截 240 + `\n---\n` + 最近 3 条历史各截 120,共 4 段;
   *  总长 cap 720 字符(防御 — 截断到 720 保证注入文本有界)。 */
  private renderTaskFocusBoundary(focus: TaskFocusState): string {
    const segments = [
      focus.text.slice(0, 240),
      ...(focus.history ?? []).slice(0, 3).map((h) => h.text.slice(0, 120)),
    ];
    const joined = segments.join("\n---\n");
    return joined.length > 720 ? joined.slice(0, 720) : joined;
  }

  /** #458 T5/T12: `/goal clear` 占位 helper (T6 slash + chat-session 调用)。
   *  Clears both the pinned goal and taskFocus (SC: goal/taskFocus 一并清空),
   *  records the trace clear event, and persists atomically through the same
   *  serialize queue. */
  async clearGoal(conversationId: string): Promise<void> {
    await this.serialize({
      conversationId,
      work: async () => {
        const session = await this.store.load(conversationId);
        const now = new Date().toISOString();
        const cleared: SessionFileV1 = {
          ...session,
          goal: undefined,
          taskFocus: undefined,
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
    /** #458 T5/T12: trace for the seed 发射点 — only emitted when this
     *  conditionalSave actually seeds a fresh taskFocus. Undefined when
     *  traceOut is not configured (optional chain in caller). */
    readonly trace?: TraceService;
  }): Promise<boolean> {
    const { conversationId, session, result, priorMessages, trace } = opts;
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
      // #458 T2/T5 (SC2): seed taskFocus from the first user message text
      // (full, trimmed) when taskFocus is still absent. `seedTaskFocus`
      // slices the primary entry to 500 chars and prepends the prior focus
      // (if any) to history. Seeded exactly once — subsequent turns keep
      // the existing taskFocus (a re-pin / seedTaskFocus switch is the only
      // overwrite). Only seeds when a user text block exists; a
      // tool_result-only first message yields "" and is treated as absent.
      // A user-pinned goal (source === "user_pin") never blocks the seed —
      // taskFocus is the deterministic task field, orthogonal to the pinned
      // goal.
      ...(withCheckpoint.taskFocus === undefined && extractGoal(result.messages)
        ? {
            taskFocus: seedTaskFocus({
              current: withCheckpoint.taskFocus,
              nextText: extractGoal(result.messages),
              now,
            }),
          }
        : {}),
    };
    await this.store.save({ id: conversationId, file: updated });
    // #458 T5/T12: seed 发射点 — 只在本次确实 seed 了 taskFocus 时落盘
    // (trace 仅在 traceOut 配置时存在)。textLen 不写明文, 防日志膨胀。
    const textLen = extractGoal(result.messages).length;
    if (withCheckpoint.taskFocus === undefined && textLen > 0) {
      await trace?.recordGoal({
        id: randomUUID(),
        sessionId: conversationId,
        action: "seed",
        textLen,
        ts: now,
        conversationId,
      });
    }
    return true;
  }

  /**
   * Lazy deps construction. Delegates to the shared harness assembly
   * (`src/harness/build-engine.ts`) so the serve path picks up the same ACI
   * 8-tool set as the CLI (bash / read_file / grep / glob / edit_file /
   * write_file / web_fetch / web_search). Without this delegation the
   * serve mode was stuck on the echo/get_time stubs and the web SPA could
   * not exercise the new tools.
   */
  private async ensureDeps(): Promise<LoopEngineDeps> {
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
