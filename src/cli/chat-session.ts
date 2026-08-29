/**
 * Product chat session: TTY REPL + non-interactive pipe path.
 * Core line handling is exported for unit tests (no real TTY required).
 */
import * as readline from "node:readline";
import {
  run as runHarness,
  type AnthropicNativeMessage,
  type HarnessStreamEvent,
  type LoopEngineDeps,
  type LoopTrace,
  type RunResult,
} from "../harness/index.js";
import { runVerifyLoop, type VerifyConfig } from "../harness/verify/index.js";
import { createRunClassifierFromManager } from "../harness/verify/run-classifier-adapter.js";
import {
  formatRunHuman,
  formatRunJson,
  formatStatusLine,
  formatVerifyReport,
} from "./format.js";
import {
  applySlashCommand,
  parseChatLine,
  type CliChatState,
  type SlashEffect,
} from "./slash.js";
import type { SessionContext } from "../shared/schema.js";
import { isIknowError } from "../shared/errors.js";
import { MaxTurnsExceeded } from "../harness/errors.js";
import { maxTurnsNotice } from "./max-turns.js";
import {
  clearErrLine,
  isInteractive,
  writeErr,
  writeOut,
} from "./session-io.js";
import { wrapWithViolationHook } from "../harness/sandbox/violation-executor.js";
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
import type { SubAgentManager } from "../harness/subagent/manager.js";
import { drainPendingSubagents } from "../harness/subagent/host-drain.js";
import {
  createSubagentWake,
  queryableSubagentTaskIds,
  toSubagentWakeError,
  type SubagentWake,
  type SubagentWakeError,
} from "../harness/subagent/host-wake.js";
import {
  createViolationCounter,
  wireKillSessionNotification,
} from "../harness/sandbox/violation-handling.js";
import { createStreamDraft } from "./stream-draft.js";
import {
  parsePermissionMode,
  type PermissionMode,
  type PermissionModeContext,
} from "../harness/permission/modes.js";
import {
  agentModeLabel,
  applyGraphCommand,
  applyShiftTabAgentModeFlip,
  type GraphModeContext,
} from "../harness/graph/mode.js";
import type { GraphAssembly } from "../harness/graph/assembly.js";
import {
  SessionStore,
  type SessionStoreError,
  type SessionFileV1,
  CURRENT_SCHEMA_VERSION,
  extractTitle,
  appendCheckpoint,
  pinGoal,
  shouldPersistCheckpoint,
  toInterruptReason,
  validateGoalText,
  type GoalState,
} from "../session-api/store/index.js";
import { resolveServeDataDir } from "../session-api/serve.js";
import {
  applyGoalAutoContinue,
  applyGoalAutoError,
  reportGoalAutoStoreLoadErr,
  runAutoLoopSteps,
} from "../session-api/goal-auto.js";
import {
  continuePredicateError,
  evaluateContinuePending,
  mapSkipAppendToContinueError,
  matchesContinuePendingNlLine,
  shouldTriggerContinueFromNl,
} from "../session-api/continue-pending.js";
import { MAX_MESSAGE_CHARS } from "../session-api/contract.js";
import { randomUUID } from "node:crypto";

/** Visual separator after a completed answer on TTY only. */
const TTY_ANSWER_SEP = "────────";

export type ChatSessionOpts = {
  deps: LoopEngineDeps;
  session: SessionContext;
  jsonMode: boolean;
  /**
   * Quiet pipe mode: no turn markers on stderr.
   * Default: true when `IKNOW_CHAT_QUIET=1`, else false.
   * Interactive TTY ignores this (still uses prompt + optional 思考中).
   */
  quiet?: boolean;
  /**
   * #152 T5:thinking 可见开关(env flag 落点)。默认 false。
   * 来源 `IKNOW_CHAT_SHOW_THINKING=on|off`(env.ts SSOT)。开启时人类投影
   * 在答案文本前展示 thinking;`projection.texts` / `finalText` / LoopTrace /
   * session-store 均不受影响。
   */
  showThinking?: boolean;
  /**
   * W2: 权限模式上下文。`/permissions` 斜杠命令通过它就地翻 mode,
   * 不重建引擎。ask/serve 不传。
   */
  permissionMode?: PermissionModeContext;
  /**
   * D-α / ADR-0030: graph 编排 overlay 的会话 holder。Shift+Tab 三态轮与
   * `/graph on|off` 改的是同一个它；装配层读它决定下一次 run() 是否露出
   * `run_graph`。ask 不传（无 overlay）。
   */
  graphMode?: GraphModeContext;
  /**
   * D-α T3: graph 装配快照（`BuiltEngine.graphAssembly`）。chat 的一个
   * round = 一条用户查询行；host 在跑 run() 之前拍一次快照，翻键因此
   * 「下一次 run() 才生效」。缺席 = 未接 overlay（工具与编排段都不存在）。
   */
  graphAssembly?: GraphAssembly;
  /**
   * T4: `--resume <id>` 锚定既有 conversationId 续跑。设置时 runChatSession
   * 以该 id 作为 conversationId(写回同一 checkpoint 文件),并尝试从
   * SessionStore 加载既有 messages 作为初始历史;load 失败(typed)则保留
   * 该 id 作为锚点继续,但 messages 从空开始。undefined = 每次新开随机
   * UUID,行为与 T2 完全相同。
   */
  resumeId?: string;
  /**
   * #356 T7:host drain — chat 入口每轮 runHarness 之前,调
   * `drainPendingSubagents(subagentManager)` 把 completed 浓缩 envelope
   * 拼入 next turn 的 priorMessages。ask 入口无 manager → 不传。
   */
  readonly subagentManager?: SubAgentManager;
  /**
   * #128 T8:验证闭环配置 (settings.verify 段经 cli.ts 构造)。
   * command 缺失 (含 verify 段完全缺失) → `{ command: "" }` 仍非 undefined ——
   * subagentManager 在场时 runClassifier 接管 (每轮 completed 后 spawn 判官,
   * spec #128 Objective); 未装配 subagentManager (ask 形态) → verify-loop
   * 透明关闭向后兼容 (SC7)。command 已配 → 每轮 run 被 runVerifyLoop 包裹。
   */
  readonly verifyConfig?: VerifyConfig;
  /**
   * auto-memory T4 / ADR-0031 D1:自动记忆 host 钩子(`BuiltEngine.autoMemory`)。
   * 缺席(默认 OFF / ask 表面)→ 不调,行为逐字节不变。
   */
  readonly autoMemory?: AutoMemoryHook;
  /**
   * auto-memory low-trust read: prepend scored bodies onto the user turn.
   * Absent (default OFF / ask) → query is passed through unchanged. T1:
   * hosts pass `excludeIds` (session-level dedup) via the second argument.
   */
  readonly overlayMemoryPrefetch?: OverlayPrefetchFn;
};

export type ChatLineContext = {
  deps: LoopEngineDeps;
  state: CliChatState;
  /** #152 T5:thinking 可见开关(与 ChatSessionOpts.showThinking 同源)。 */
  showThinking?: boolean;
  /** W2: 权限模式上下文(由 runChatSession 透传,/permissions 翻它)。 */
  permissionMode?: PermissionModeContext;
  /** D-α: graph 编排 overlay holder(由 runChatSession 透传,/graph 与
   *  Shift+Tab 翻它)。 */
  graphMode?: GraphModeContext;
  /** D-α T3: graph 装配快照(由 runChatSession 透传;查询行开跑前拍一次)。 */
  graphAssembly?: GraphAssembly;
  /**
   * T2: REPL 级 AbortController。run() 的 signal 由此接线 —— SIGINT 第一次
   * busy 时 abort() 打断 in-flight,run 以 stopReason "cancelled" resolve。
   * 缺省(pipe / tests)→ signal=undefined,行为零变化。
   */
  abortController?: AbortController;
  /**
   * T2: checkpoint 落盘的 SessionStore(默认 ~/.iknow 池,与 serve/TUI 同池
   * — #120 Q6 精神)。与 `state.conversationId` 同时存在时,post-run 走
   * shouldPersistCheckpoint → appendCheckpoint → 原子写。缺省(ask/tests)→
   * 跳过持久化,行为零变化。
   */
  checkpointStore?: SessionStore;
  /**
   * #356 T7:同 ChatSessionOpts.subagentManager,runChatSession 透传。
   * 缺席(undefined)= 不调 drain,行为零变化。
   */
  readonly subagentManager?: SubAgentManager;
  /**
   * #128 T8:同 ChatSessionOpts.verifyConfig,runChatSession 透传。
   * 缺席(undefined)= 不包裹 run,行为逐字节不变 (仅测试/装配未接线路径)。
   */
  readonly verifyConfig?: VerifyConfig;
  /**
   * auto-memory T4:同 ChatSessionOpts.autoMemory,runChatSession 透传。
   * 缺席 = 不调钩子,行为零变化。
   */
  readonly autoMemory?: AutoMemoryHook;
  /**
   * auto-memory low-trust read: same ChatSessionOpts field, runChatSession 透传.
   * T1: hosts pass `excludeIds` (session-level dedup) via the second argument.
   */
  readonly overlayMemoryPrefetch?: OverlayPrefetchFn;
  /**
   * auto-memory T1: session-level prefetch dedup state — per-conversation
   * sets of already-injected memory ids. Allocated lazily by processChatLine
   * (runChatSession 的 ctx 存活整个 REPL,天然 per-conversation);测试可省略。
   */
  prefetchInjectedIds?: Map<string, Set<string>>;
  /**
   * T3 (#689): CLI _client_ idle/busy-guard for continue. Shared mutable box
   * so a concurrent processChatLine can refuse continue without aborting the
   * in-flight turn (EXIT busy_stop_first).
   */
  clientBusy?: { value: boolean };
};

export type ProcessChatLineResult = {
  quit: boolean;
  /** Material for stdout (answers, slash info/help/reset). */
  output: string;
  /**
   * #195: status line extracted from `formatRunHuman` (human projection only;
   * `undefined` for JSON projection or slash commands). The streaming chat
   * host uses this when the answer text has already been streamed to stdout
   * as the final output — emitting it avoids re-rendering the answer.
   */
  statusLine?: string;
  /** Material for stderr (errors). */
  stderr?: string;
  /** True when this line was a user query that ran the agent. */
  ranQuery?: boolean;
  /** T6: a silent subagent handoff failed; no completion was fabricated. */
  wakeFailure?: SubagentWakeError;
};

export interface ProcessChatLineOpts {
  readonly line: string;
  readonly ctx: ChatLineContext;
  /**
   * #179 T6 (#147 D3):流式事件观察者回调,原样透传给 run() opts。
   * 交互 REPL 用它做增量预览(spinner 接缝);pipe/ask 不接(undefined 透传,
   * 行为零变化)。回调异常在 loop 引擎层吞咽(观察者不破坏回合)。
   */
  readonly onStream?: (event: HarnessStreamEvent) => void;
}

/**
 * #449 B8 (SC5, 修订 per #473): chat 端 verify-loop task 公式的纯读盘 +
 * helper。`goal.text ?? query` (empty-goal-skip 同纪律)。
 *
 * 历史: taskFocus 段曾在 #473 从 verify 输入中移除(#605 T2 已将整段
 * session.taskFocus 字段及 seed 生命周期彻底退休), 仅 goal 字段驱动。
 *
 * 失败语义 (plan T1 named EXIT):
 * - store 缺席 / conversationId === null → HITL; userText = query。
 *   不把 query 当完成向判官 task。
 * - store.load 成功且 goal.text 非空 → auto; userText = goal.text。
 * - store.load 成功且无 goal / 空 goal.text → HITL; userText = query。
 * - store.load 抛任何错误 (含 not_found) → HITL; userText = query。
 *   禁止 fail-open 把 query 当判官 task。
 */
async function resolveVerifyDispatch(
  store: SessionStore | undefined,
  conversationId: string | null,
  query: string
): Promise<{
  readonly userText: string;
  readonly completionMode: "hitl" | "auto";
}> {
  if (store === undefined || conversationId === null) {
    return { userText: query, completionMode: "hitl" };
  }
  try {
    const session = await store.load(conversationId);
    if (session.goal !== undefined && session.goal.text.length > 0) {
      return { userText: session.goal.text, completionMode: "auto" };
    }
    return { userText: query, completionMode: "hitl" };
  } catch (err) {
    // EXIT: load throw → HITL, userText=query; never fail-open query as judge task.
    skipChatAutoOnLoadError(err, conversationId);
    return { userText: query, completionMode: "hitl" };
  }
}

function busyBox(ctx: ChatLineContext): { value: boolean } {
  if (ctx.clientBusy === undefined) {
    ctx.clientBusy = { value: false };
  }
  return ctx.clientBusy;
}

function isClientBusy(ctx: ChatLineContext): boolean {
  return ctx.clientBusy?.value === true;
}

function busyStopFirstResult(): ProcessChatLineResult {
  return {
    quit: false,
    output: "",
    stderr: "busy_stop_first: a turn is already in progress; not aborting",
  };
}

function continueFailResult(stderr: string): ProcessChatLineResult {
  return { quit: false, output: "", stderr };
}

type ContinueLoaded =
  | {
      ok: true;
      messages: ReadonlyArray<AnthropicNativeMessage>;
      goal?: GoalState;
    }
  | { ok: false; result: ProcessChatLineResult };

/** store.load when conversationId is set; freeze-of-state is the no-disk test stand-in. */
async function loadContinueTranscript(
  ctx: ChatLineContext
): Promise<ContinueLoaded> {
  const store = ctx.checkpointStore;
  const conversationId = ctx.state.conversationId;
  if (store === undefined || conversationId === null) {
    return { ok: true, messages: ctx.state.messages };
  }
  try {
    const file = await store.load(conversationId);
    return {
      ok: true,
      messages: file.messages,
      ...(file.goal !== undefined ? { goal: file.goal } : {}),
    };
  } catch (err) {
    if (!isSessionStoreErrorKind(err)) throw err;
    // Missing disk file = empty transcript (fresh conversation; same as /goal).
    if ((err as SessionStoreError).kind === "not_found") {
      return { ok: true, messages: [] };
    }
    return {
      ok: false,
      result: continueFailResult(typedGoalError(err, conversationId)),
    };
  }
}

type ContinuePrep =
  | { kind: "busy" }
  | { kind: "exit"; result: ProcessChatLineResult }
  | { kind: "run"; prior: ReadonlyArray<AnthropicNativeMessage> }
  | { kind: "skip" };

async function prepareContinue(opts: {
  readonly ctx: ChatLineContext;
  readonly mode: "slash" | "nl";
  readonly line: string;
}): Promise<ContinuePrep> {
  // Slash: busy-first (do not start a second continue). NL: load+predicate
  // first so a table line that is not pending skip-appends as a normal query
  // even while another turn is in-flight.
  if (opts.mode === "slash" && isClientBusy(opts.ctx)) {
    return { kind: "busy" };
  }
  const loaded = await loadContinueTranscript(opts.ctx);
  if (!loaded.ok) return { kind: "exit", result: loaded.result };
  const verdict = evaluateContinuePending({
    messages: loaded.messages,
    ...(loaded.goal !== undefined ? { goal: loaded.goal } : {}),
  });
  if (opts.mode === "nl") {
    if (
      !shouldTriggerContinueFromNl({
        line: opts.line,
        pending: verdict.ok,
      })
    ) {
      return { kind: "skip" };
    }
    if (isClientBusy(opts.ctx)) return { kind: "busy" };
  } else if (!verdict.ok) {
    return {
      kind: "exit",
      result: continueFailResult(continuePredicateError(verdict.exit).message),
    };
  }
  return { kind: "run", prior: loaded.messages };
}

async function executeSkipAppendTurn(opts: {
  readonly ctx: ChatLineContext;
  readonly priorMessages: ReadonlyArray<AnthropicNativeMessage>;
  readonly onStream?: (event: HarnessStreamEvent) => void;
}): Promise<ProcessChatLineResult> {
  const { ctx, priorMessages } = opts;
  const box = busyBox(ctx);
  box.value = true;
  let stopSummary: string | undefined;
  const wrappedOnStream =
    opts.onStream === undefined
      ? undefined
      : (event: HarnessStreamEvent): void => {
          if (event.type === "stop_summary") stopSummary = event.text;
          else opts.onStream!(event);
        };
  try {
    return await runSkipAppendAndPresent({
      ctx,
      priorMessages,
      stopSummaryRef: {
        get: () => stopSummary,
      },
      ...(wrappedOnStream !== undefined ? { onStream: wrappedOnStream } : {}),
    });
  } finally {
    box.value = false;
  }
}

async function runSkipAppendAndPresent(opts: {
  readonly ctx: ChatLineContext;
  readonly priorMessages: ReadonlyArray<AnthropicNativeMessage>;
  readonly onStream?: (event: HarnessStreamEvent) => void;
  readonly stopSummaryRef: { get: () => string | undefined };
}): Promise<ProcessChatLineResult> {
  const { ctx, priorMessages } = opts;
  try {
    const { result, trace } = await runHarness(
      "",
      ctx.deps,
      ctx.abortController?.signal,
      {
        priorMessages,
        appendUserText: false,
        ...(opts.onStream !== undefined ? { onStream: opts.onStream } : {}),
      }
    );
    if (ctx.checkpointStore && ctx.state.conversationId !== null) {
      await persistChatSessionCheckpoint({
        store: ctx.checkpointStore,
        conversationId: ctx.state.conversationId,
        jsonMode: ctx.state.jsonMode,
        result,
        priorMessages,
      });
    }
    if (
      result.stopReason !== "protocolError" &&
      result.stopReason !== "emptyFinalResponse"
    ) {
      ctx.state.messages = Object.freeze([...result.messages]);
    }
    // auto-memory T4: `/continue` 也是一轮完成的 turn,与主路径同待遇。
    notifyAutoMemory({
      hook: ctx.autoMemory,
      stopReason: result.stopReason,
      transcript: renderTranscript(result.messages),
      sessionKey: ctx.state.conversationId ?? "chat",
      memorySaveSucceeded: hasSuccessfulMemorySave(
        result.messages.slice(priorMessages.length)
      ),
      onError: (error) =>
        writeErr(
          `[memory/auto] turn hook skipped: ${
            error instanceof Error ? error.message : String(error)
          }\n`
        ),
    });
    return presentChatTurn({
      ctx,
      result,
      trace,
      priorMessages,
    });
  } catch (err) {
    const mapped = mapSkipAppendToContinueError(err);
    if (mapped !== null) return continueFailResult(mapped.message);
    if (err instanceof MaxTurnsExceeded) {
      const notice = maxTurnsNotice(err, opts.stopSummaryRef.get());
      return {
        quit: false,
        output: notice.output,
        stderr: notice.stderr,
        ranQuery: true,
      };
    }
    return {
      quit: false,
      output: "",
      stderr: formatChatError(err),
      ranQuery: true,
    };
  }
}

/**
 * T4: consume a terminal subagent handoff without inventing a user input.
 * The drain is a prior user message for the model, but it never goes through
 * the readline/input-history path.
 */
export async function runChatSubagentWake(opts: {
  readonly ctx: ChatLineContext;
  readonly onStream?: (event: HarnessStreamEvent) => void;
}): Promise<ProcessChatLineResult> {
  const { ctx } = opts;
  const drained = await drainPendingSubagents(ctx.subagentManager);
  if (drained.length === 0) return { quit: false, output: "" };
  const box = busyBox(ctx);
  if (box.value) return { quit: false, output: "" };
  box.value = true;
  ctx.graphAssembly?.beginRound();
  const priorMessages = Object.freeze([
    ...ctx.state.messages,
    Object.freeze({
      role: "user" as const,
      content: Object.freeze([
        Object.freeze({ type: "text" as const, text: drained }),
      ]),
    }),
  ]);
  try {
    const { result, trace } = await runHarness(
      "",
      ctx.deps,
      ctx.abortController?.signal,
      {
        priorMessages,
        appendUserText: false,
        ...(opts.onStream !== undefined ? { onStream: opts.onStream } : {}),
      }
    );
    if (ctx.checkpointStore && ctx.state.conversationId !== null) {
      await persistChatSessionCheckpoint({
        store: ctx.checkpointStore,
        conversationId: ctx.state.conversationId,
        jsonMode: ctx.state.jsonMode,
        result,
        priorMessages: ctx.state.messages,
      });
    }
    if (
      result.stopReason !== "protocolError" &&
      result.stopReason !== "emptyFinalResponse"
    ) {
      ctx.state.messages = Object.freeze([...result.messages]);
    }
    return presentChatTurn({
      ctx,
      result,
      trace,
      priorMessages,
    });
  } catch (err) {
    const wakeError = toSubagentWakeError(err, {
      taskIds: queryableSubagentTaskIds(ctx.subagentManager),
      queryable: ctx.subagentManager !== undefined,
    });
    return {
      quit: false,
      output: "",
      stderr: formatChatError(wakeError),
      ranQuery: false,
      wakeFailure: wakeError,
    };
  } finally {
    box.value = false;
  }
}

function presentChatTurn(opts: {
  readonly ctx: ChatLineContext;
  readonly result: RunResult;
  readonly trace: LoopTrace;
  readonly priorMessages: ReadonlyArray<AnthropicNativeMessage>;
}): ProcessChatLineResult {
  const { ctx, result, trace, priorMessages } = opts;
  const interruptNote =
    result.stopReason === "cancelled"
      ? shouldPersistCheckpoint(result, priorMessages)
        ? "已保存"
        : "未落checkpoint"
      : undefined;
  const human = !ctx.state.jsonMode;
  const output = human
    ? formatRunHuman({
        result,
        trace,
        showThinking: ctx.showThinking,
        interruptNote,
      })
    : formatRunJson({ result, trace });
  const statusLine = human
    ? formatStatusLine({
        result,
        trace,
        showThinking: ctx.showThinking,
        interruptNote,
      })
    : undefined;
  return {
    quit: false,
    output,
    ...(statusLine !== undefined ? { statusLine } : {}),
    ranQuery: true,
  };
}

async function dispatchPreparedContinue(
  prep: ContinuePrep,
  ctx: ChatLineContext,
  onStream?: (event: HarnessStreamEvent) => void
): Promise<ProcessChatLineResult | undefined> {
  if (prep.kind === "busy") return busyStopFirstResult();
  if (prep.kind === "exit") return prep.result;
  if (prep.kind === "skip") return undefined;
  return executeSkipAppendTurn({
    ctx,
    priorMessages: prep.prior,
    ...(onStream !== undefined ? { onStream } : {}),
  });
}

async function runSlashContinue(opts: {
  readonly ctx: ChatLineContext;
  readonly onStream?: (event: HarnessStreamEvent) => void;
}): Promise<ProcessChatLineResult> {
  const prep = await prepareContinue({
    ctx: opts.ctx,
    mode: "slash",
    line: "/continue",
  });
  const result = await dispatchPreparedContinue(prep, opts.ctx, opts.onStream);
  return (
    result ??
    continueFailResult("nothing_pending: cannot continue this session")
  );
}

async function maybeContinueFromPendingNl(opts: {
  readonly line: string;
  readonly ctx: ChatLineContext;
  readonly onStream?: (event: HarnessStreamEvent) => void;
}): Promise<ProcessChatLineResult | undefined> {
  if (!matchesContinuePendingNlLine(opts.line)) return undefined;
  const prep = await prepareContinue({
    ctx: opts.ctx,
    mode: "nl",
    line: opts.line,
  });
  return dispatchPreparedContinue(prep, opts.ctx, opts.onStream);
}

/**
 * Pure-ish one-line handler for tests and both I/O paths.
 * Mutates ctx (state) as needed.
 */
export async function processChatLine(
  opts: ProcessChatLineOpts
): Promise<ProcessChatLineResult> {
  const { line, ctx } = opts;
  const parsedLine = parseChatLine(line);

  if (parsedLine.kind === "empty") {
    return { quit: false, output: "" };
  }

  if (parsedLine.kind === "slash") {
    return processSlash({
      command: parsedLine.command,
      args: parsedLine.args,
      ctx,
      ...(opts.onStream !== undefined ? { onStream: opts.onStream } : {}),
    });
  }

  const query = parsedLine.text;

  const fromNl = await maybeContinueFromPendingNl({
    line: query,
    ctx,
    ...(opts.onStream !== undefined ? { onStream: opts.onStream } : {}),
  });
  if (fromNl !== undefined) return fromNl;

  if (query.length > MAX_MESSAGE_CHARS) {
    return {
      quit: false,
      output: "",
      stderr: `message text exceeds max length ${MAX_MESSAGE_CHARS}`,
    };
  }

  const box = busyBox(ctx);
  box.value = true;
  try {
    return await runChatQueryLine(opts);
  } finally {
    box.value = false;
  }
}

/**
 * auto-memory T1: per-conversation injected-id set for the chat path, lazily
 * recovered from ctx.state.messages on first attach — the same messages that
 * seedResumeMessages seeded on `--resume` (cold start from checkpoint /
 * session JSONL). Empty set is cached too; recovery failure degrades to an
 * empty set (log-and-continue inside recoverInjectedMemoryIds).
 */
function chatPrefetchExcludeIds(ctx: ChatLineContext): Set<string> {
  const conversationId = ctx.state.conversationId ?? "chat";
  if (ctx.prefetchInjectedIds === undefined) {
    ctx.prefetchInjectedIds = new Map<string, Set<string>>();
  }
  const cached = ctx.prefetchInjectedIds.get(conversationId);
  if (cached !== undefined) return cached;
  const recovered = recoverInjectedMemoryIds(ctx.state.messages);
  ctx.prefetchInjectedIds.set(conversationId, recovered);
  return recovered;
}

async function runChatQueryLine(
  opts: ProcessChatLineOpts
): Promise<ProcessChatLineResult> {
  const { ctx } = opts;
  const parsedLine = parseChatLine(opts.line);
  if (parsedLine.kind !== "query") {
    return { quit: false, output: "" };
  }
  const query = parsedLine.text;

  // D-α T3 / ADR-0030:round 边界 —— 一条用户查询行 = 一次 run()。这里拍
  // graph 装配快照,之后本行内的所有 run()(含 verify / auto-loop 的多轮)
  // 共用同一工具面。Shift+Tab 与 `/graph` 在这之后翻,要等下一行才生效。
  ctx.graphAssembly?.beginRound();

  // plan T1: HITL vs /goal auto 分派。仅 verifyConfig 在场时读盘;
  // 缺席分支直接走 runHarness(query, ...),不引入额外 IO。
  const verifyDispatch =
    ctx.verifyConfig === undefined
      ? undefined
      : await resolveVerifyDispatch(
          ctx.checkpointStore,
          ctx.state.conversationId,
          query
        );
  // plan T6:stop_summary 事件观察 — 经 wrapper 包一层,捕获异常停的收尾
  // 摘要文本。host 的 onStream(若有)只接到 text_delta / tool_call_start 等
  // 业务事件,避免预览 sink 双打印。摘要由 loop-engine run() 在返回/重抛前
  // emit,故摘要轮不计 maxTurns。变量提到 try 外:catch 块也要读它。
  let stopSummary: string | undefined;
  const wrappedOnStream:
    | ((event: import("../harness/index.js").HarnessStreamEvent) => void)
    | undefined =
    opts.onStream === undefined
      ? undefined
      : (event) => {
          if (event.type === "stop_summary") stopSummary = event.text;
          else opts.onStream!(event);
        };
  const outputs: string[] = [];
  let lastStatusLine: string | undefined;
  // auto-memory T1: session-level prefetch dedup — exclude ids already
  // injected in this conversation (lazy resume recovery from ctx.state.messages
  // on first attach) and record what this turn actually injects (overlay-
  // bearing attach results only; identity fallbacks add nothing).
  const prefetchExcludeIds = chatPrefetchExcludeIds(ctx);
  const attachPrefetch = (text: string): Promise<string> =>
    applyHostPrefetch(text, ctx.overlayMemoryPrefetch, {
      excludeIds: prefetchExcludeIds,
    }).then((effective) => {
      recordInjectedMemoryIds(prefetchExcludeIds, effective);
      return effective;
    });
  // F4: shared /goal auto-loop skeleton. Chat's `reloadSession` is a no-op
  // (in-memory ctx.state.messages already mutated inside `run`); hub reloads
  // via store.load. Each host controls its own error semantics (chat converts
  // to error result; hub rethrows).
  try {
    return await runAutoLoopSteps({
      run: async () => {
        // #356 T7 (SC7):host drain — 把 manager 内 completed 子代理结果浓缩成
        // user message,拼入本次 run 的 priorMessages 末尾。空 manager / 无
        // completed → priorMessages 不变 (行为零变化)。
        const drained = await drainPendingSubagents(ctx.subagentManager);
        const priorMessages = drained
          ? Object.freeze([
              ...ctx.state.messages,
              Object.freeze({
                role: "user" as const,
                content: Object.freeze([
                  Object.freeze({ type: "text" as const, text: drained }),
                ]),
              }),
            ])
          : ctx.state.messages;
        // #128 T8:verifyConfig 非 undefined (含 command 空串) 时 run 被
        // runVerifyLoop 包裹 (advisor 形态, 引擎零改动);缺席 → 原 runHarness
        // 调用逐字节不变 (仅未接线路径)。runVerifyLoop 的 runFn 透传 onStream →
        // wrappedOnStream 捕获 stop_summary 的既有语义保持;trace 未注入 (chat 无
        // trace service), VerificationRecord 不落盘 (T7 已处理 trace 可选)。
        // 注意: runVerifyLoop 的首轮 runFn 不带 priorMessages / onStream,
        // 闭包必须兜底 chat 侧的 priorMessages 与 wrappedOnStream, 否则多轮
        // 历史丢失 + 流式预览失效。
        const runOutcome =
          verifyDispatch !== undefined && ctx.verifyConfig !== undefined
            ? await runVerifyLoop({
                runFn: (text, o) =>
                  attachPrefetch(text).then(
                    (effective) =>
                      runHarness(effective, ctx.deps, o?.signal, {
                        priorMessages: o?.priorMessages ?? priorMessages,
                        onStream: o?.onStream ?? wrappedOnStream,
                      })
                  ),
                userText: verifyDispatch.userText,
                completionMode: verifyDispatch.completionMode,
                config: ctx.verifyConfig,
                sessionId: ctx.state.conversationId ?? "chat",
                signal: ctx.abortController?.signal,
                cwd: process.cwd(),
                // #128 SC1 生产装配: subagentManager 在场 → 启用分类器填空
                // (command 缺失/空串时分类器接管, spec Objective); 缺席 (ask 形态)
                // → undefined, verify-loop 自然走透明关闭向后兼容 (SC7)。
                runClassifier:
                  ctx.subagentManager === undefined
                    ? undefined
                    : createRunClassifierFromManager({
                        manager: ctx.subagentManager,
                        ...(ctx.verifyConfig.classifierModel !== undefined
                          ? {
                              classifierModel: ctx.verifyConfig.classifierModel,
                            }
                          : {}),
                      }),
              })
            : await attachPrefetch(query).then(
                (effective) =>
                  runHarness(effective, ctx.deps, ctx.abortController?.signal, {
                    priorMessages,
                    onStream: wrappedOnStream,
                  })
              );
        const { result, trace } = runOutcome;
        // B1: Ctrl+C 打断反馈 —— 仅 cancelled 时提示 checkpoint 是否已保存。
        // 与下方 persistChatSessionCheckpoint 同源判定(shouldPersistCheckpoint),
        // 保证「状态行文案」与「实际落盘」一致;非 cancelled → undefined(无前缀)。
        const interruptNote =
          result.stopReason === "cancelled"
            ? shouldPersistCheckpoint(result, priorMessages)
              ? "已保存"
              : "未落checkpoint"
            : undefined;
        const human = !ctx.state.jsonMode;
        // #128 M3: verify 最终判定 (failed/unstable/escalated) surface 到 chat 输出,
        // 避免"模型声称完成但验证没过"仍显示正常完成 (SC2/SC6 交付面)。
        // 仅 verify 分支有 outcome/rounds; 裸 run 分支无 (无报告, 行为不变)。
        const verifyReport =
          "outcome" in runOutcome &&
          (runOutcome.outcome === "failed" ||
            runOutcome.outcome === "unstable" ||
            runOutcome.outcome === "escalated")
            ? formatVerifyReport(runOutcome.outcome, runOutcome.rounds)
            : undefined;
        const baseOutput = human
          ? formatRunHuman({
              result,
              trace,
              showThinking: ctx.showThinking,
              interruptNote,
            })
          : formatRunJson({ result, trace });
        const output =
          verifyReport !== undefined
            ? `${baseOutput}\n${verifyReport}`
            : baseOutput;
        outputs.push(output);
        lastStatusLine = human
          ? formatStatusLine({
              result,
              trace,
              showThinking: ctx.showThinking,
              interruptNote,
            })
          : undefined;
        return { result, runOutcome, priorMessages };
      },
      persist: async (s) => {
        // T2: post-run checkpoint 落盘(mirrors hub.ts conditionalSave)。Ask/serve/
        // tests 没接 checkpointStore → 跳过,行为零变化(pipe / ask 一支不动)。
        // run resolve 后才落盘 —— throw 路径(下文 catch)不进此处,刻意保持 #120
        // 裁决("MaxTurnsExceeded 不 save"由 catch 分支自然实现:run 没 resolve 即
        // 没有可用的 turnCount / messages,appendCheckpoint 也不可能产生 delta>0)。
        if (ctx.checkpointStore && ctx.state.conversationId !== null) {
          await persistChatSessionCheckpoint({
            store: ctx.checkpointStore,
            conversationId: ctx.state.conversationId,
            jsonMode: ctx.state.jsonMode,
            result: s.result,
            priorMessages: s.priorMessages,
          });
        }
        // Continue the conversation next turn on cancelled/timeout/nonSuccessStop
        // (all append an assistant message). maxTurns no longer returns here —
        // plan T3 / ADR-0011 upgraded it to `throw MaxTurnsExceeded`, caught below
        // (T6) without appending anything. protocolError and emptyFinalResponse
        // return finalState with NO assistant message appended, so continuing on
        // them would feed a dangling user message to the model next turn and
        // poison the loop — drop context on those two. CliChatState owned by host
        // replaces and freezes the shallow copy so history remains append-only
        // (harness returns ReadonlyArray).
        if (
          s.result.stopReason !== "protocolError" &&
          s.result.stopReason !== "emptyFinalResponse"
        ) {
          ctx.state.messages = Object.freeze([...s.result.messages]);
        }
        // auto-memory T4 / ADR-0031 D1:每轮把结果交给钩子,由钩子决定
        // completed 闸 + N 轮闸。钩子缺席(默认 OFF / ask)→ 整句 no-op。
        notifyAutoMemory({
          hook: ctx.autoMemory,
          stopReason: s.result.stopReason,
          transcript: renderTranscript(s.result.messages),
          sessionKey: ctx.state.conversationId ?? "chat",
          memorySaveSucceeded: hasSuccessfulMemorySave(
            s.result.messages.slice(s.priorMessages.length)
          ),
          onError: (error) =>
            writeErr(
              `[memory/auto] turn hook skipped: ${
                error instanceof Error ? error.message : String(error)
              }\n`
            ),
        });
      },
      decideContinue: async (s) =>
        applyChatAutoContinue({
          ctx,
          result: s.result,
          runOutcome: s.runOutcome,
          priorCount: s.priorMessages.length,
        }),
      buildStop: async () => ({
        quit: false,
        output: outputs.join("\n"),
        ...(lastStatusLine !== undefined ? { statusLine: lastStatusLine } : {}),
        ranQuery: true,
      }),
      reloadSession: async () => {
        // Chat keeps session state in-memory (ctx.state.messages mutated above);
        // reload is a no-op here. Hub passes `() => store.load(id)`.
      },
    });
  } catch (err) {
    await applyChatAutoError(ctx, err);
    if (err instanceof MaxTurnsExceeded) {
      // plan T3 + T6 / ADR-0011:maxTurns 超限是强制感知信号 — 接住 throw,
      // 呈现「已达上限」stderr + 收尾摘要(若有)。摘要经上面的 wrapper 捕获
      // (loop-engine 在重抛前 emit stop_summary)。
      const notice = maxTurnsNotice(err, stopSummary);
      return {
        quit: false,
        output:
          outputs.length > 0
            ? `${outputs.join("\n")}\n${notice.output}`
            : notice.output,
        stderr: notice.stderr,
        ranQuery: true,
      };
    }
    return {
      quit: false,
      output: outputs.join("\n"),
      stderr: formatChatError(err),
      ranQuery: true,
    };
  }
}

async function applyChatAutoContinue(opts: {
  readonly ctx: ChatLineContext;
  readonly result: RunResult;
  readonly runOutcome: {
    readonly result: RunResult;
    readonly outcome?: string;
    readonly records?: ReadonlyArray<{
      readonly reason?: string;
      readonly missing?: readonly string[];
    }>;
  };
  readonly priorCount: number;
}): Promise<boolean> {
  const { ctx, result, runOutcome, priorCount } = opts;
  const store = ctx.checkpointStore;
  const conversationId = ctx.state.conversationId;
  if (store === undefined || conversationId === null) return false;
  if (ctx.verifyConfig === undefined) return false;
  return applyGoalAutoContinue({
    store,
    conversationId,
    summary: {
      result,
      priorCount,
      records: runOutcome.records ?? [],
      ...(runOutcome.outcome !== undefined
        ? { verifyOutcome: runOutcome.outcome }
        : {}),
    },
    onLoadError: (err) => skipChatAutoOnLoadError(err, conversationId),
  });
}

async function applyChatAutoError(
  ctx: ChatLineContext,
  err: unknown
): Promise<void> {
  const store = ctx.checkpointStore;
  const conversationId = ctx.state.conversationId;
  if (store === undefined || conversationId === null) return;
  await applyGoalAutoError({
    store,
    conversationId,
    err,
    onLoadError: (loadErr) => skipChatAutoOnLoadError(loadErr, conversationId),
  });
}

async function processSlash(opts: {
  readonly command: string;
  readonly args: string[];
  readonly ctx: ChatLineContext;
  readonly onStream?: (event: HarnessStreamEvent) => void;
}): Promise<ProcessChatLineResult> {
  const { command, args, ctx } = opts;
  const effect = applySlashCommand({
    command,
    args,
    ctx: { state: ctx.state },
  });

  switch (effect.type) {
    case "quit":
      return { quit: true, output: "" };

    case "help":
    case "info":
      return { quit: false, output: effect.text };

    case "error":
      return { quit: false, output: "", stderr: effect.text };

    case "reset":
      return { quit: false, output: effect.message };

    case "continue":
      return runSlashContinue({
        ctx,
        ...(opts.onStream !== undefined ? { onStream: opts.onStream } : {}),
      });

    case "permissions": {
      // W2: 权限模式查询/切换。无 ctx.permissionMode(ask/serve 不传)→
      // 显示 "not available"。空 args / "status" → 显示当前 mode;
      // 合法 mode → set;非法 → 错误文案。
      const modeCtx = ctx.permissionMode;
      const target = (effect.args[0] ?? "").toLowerCase();
      if (!modeCtx) {
        return {
          quit: false,
          output: "",
          stderr: "/permissions: 当前入口不提供权限模式上下文（ask/serve）",
        };
      }
      if (target === "" || target === "status" || target === "help") {
        const current = modeCtx.get();
        const hint =
          target === "help"
            ? "  · 用法: /permissions [default|plan|full_auto]"
            : "";
        return {
          quit: false,
          output: `权限模式: ${current}${hint}`,
        };
      }
      const parsed: PermissionMode | undefined = parsePermissionMode(target);
      if (parsed === undefined) {
        return {
          quit: false,
          output: "",
          stderr:
            "Usage: /permissions [default|plan|full_auto]（或空 / status 查看当前）",
        };
      }
      modeCtx.set(parsed);
      return {
        quit: false,
        output: `权限模式已切换: ${parsed}`,
      };
    }

    case "graph": {
      // D-α graph mode: 编排 overlay 查询/切换。语义与文案走
      // harness/graph/mode.ts 单点(TUI / serve 同源);chat 只决定文案落
      // stdout 还是 stderr。holder 缺席(ask 入口不装)→ 提示不可用。
      const graphCtx = ctx.graphMode;
      if (!graphCtx) {
        return {
          quit: false,
          output: "",
          stderr: "/graph: 当前入口不提供 graph 模式上下文（ask）",
        };
      }
      const result = applyGraphCommand(graphCtx, effect.args);
      return result.ok
        ? { quit: false, output: result.text }
        : { quit: false, output: "", stderr: result.text };
    }

    case "goal": {
      // #458 T6: /goal 三面 —— status / clear / pin(<text>)。
      // status / clear 走 typed-error catch 契约:not_found 是 fresh
      // conversation 的合法态(非错误,stderr 静默 + 友好 output),其它
      // typed 错误(parse_failed / schema_invalid / io_error / write_failed /
      // concurrent_write)渲染 `${kind}: ${conversation_id}`。pin 先经
      // validateGoalText 长度/空校验,非 null → stderr 错误不落盘。
      // recordGoal 由 hub.clearGoal 统一落(clear 分支)。
      const store = ctx.checkpointStore;
      const conversationId = ctx.state.conversationId;
      if (!store || !conversationId) {
        return {
          quit: false,
          output: "",
          stderr:
            "/goal: 当前入口不提供会话持久化上下文（ask / pipe 模式不支持）",
        };
      }
      if (effect.action === "status") {
        return goalStatus(store, conversationId);
      }
      if (effect.action === "clear") {
        return goalClear(store, conversationId);
      }
      const pinned = await goalPin(store, conversationId, effect);
      if (pinned.stderr !== undefined || ctx.verifyConfig === undefined) {
        return pinned;
      }
      const started = await processChatLine({
        line: effect.text,
        ctx,
        ...(opts.onStream !== undefined ? { onStream: opts.onStream } : {}),
      });
      const output =
        pinned.output.length > 0 && started.output.length > 0
          ? `${pinned.output}\n${started.output}`
          : pinned.output || started.output;
      return { ...started, output };
    }
  }
}

/** #458 T6: /goal status —— 回显当前 goal.text;not_found =
 *  fresh conversation 合法态「未设置 goal」。 */
async function goalStatus(
  store: SessionStore,
  conversationId: string
): Promise<ProcessChatLineResult> {
  let existing: SessionFileV1;
  try {
    existing = await store.load(conversationId);
  } catch (err) {
    if (
      isSessionStoreErrorKind(err) &&
      (err as SessionStoreError).kind === "not_found"
    ) {
      return { quit: false, output: "未设置 goal" };
    }
    return {
      quit: false,
      output: "",
      stderr: typedGoalError(err, conversationId),
    };
  }
  const goalText = existing.goal?.text;
  if (!goalText) {
    return { quit: false, output: "未设置 goal" };
  }
  return { quit: false, output: `goal: ${goalText}` };
}

/** #458 T6: /goal clear —— hub.clearGoal 语义的 chat 侧镜像(经 store 原子写
 *  goal 清空);not_found = fresh conversation 合法态「无 goal 可清」。
 *  注:CLI chat 入口不装配 SessionHub,recordGoal trace 发射点由 hub 统一落
 *  (T5),CLI 路径无 trace 副作用是既有事实。 */
async function goalClear(
  store: SessionStore,
  conversationId: string
): Promise<ProcessChatLineResult> {
  let existing: SessionFileV1;
  try {
    existing = await store.load(conversationId);
  } catch (err) {
    if (
      isSessionStoreErrorKind(err) &&
      (err as SessionStoreError).kind === "not_found"
    ) {
      return { quit: false, output: "无 goal 可清" };
    }
    return {
      quit: false,
      output: "",
      stderr: typedGoalError(err, conversationId),
    };
  }
  const now = new Date().toISOString();
  const cleared: SessionFileV1 = {
    ...existing,
    goal: undefined,
    updatedAt: now,
    schemaVersion: CURRENT_SCHEMA_VERSION,
  };
  try {
    await store.save({ id: conversationId, file: cleared });
  } catch (err) {
    return {
      quit: false,
      output: "",
      stderr: typedGoalError(err, conversationId),
    };
  }
  return { quit: false, output: "goal cleared" };
}

/** #458 T6: /goal pin —— validateGoalText 非 null → stderr 错误不落盘;
 *  合法 → pinGoal 原子写(#408 T3 路径同形态)。fresh conversation 也走
 *  not_found 合法态(从零 pin,构造最小 SessionFileV1)。 */
async function goalPin(
  store: SessionStore,
  conversationId: string,
  effect: Extract<SlashEffect, { type: "goal" }>
): Promise<ProcessChatLineResult> {
  const text = effect.text.trim();
  if (text.length === 0) {
    return {
      quit: false,
      output: "",
      stderr: "Usage: /goal <status|clear|text>",
    };
  }
  const invalid = validateGoalText(text);
  if (invalid !== null) {
    return { quit: false, output: "", stderr: `goal rejected: ${invalid}` };
  }
  const loaded = await loadGoalTarget(store, conversationId);
  if (!loaded.ok) return loaded.result;
  return savePinnedGoal(
    store,
    conversationId,
    loaded.file,
    text,
    effect.maxTurns
  );
}

/** load-or-fresh:not_found 是 fresh conversation 合法态 → 返回最小
 *  SessionFileV1(从零 pin);其它 typed 错误 → 返回 stderr 渲染结果。 */
async function loadGoalTarget(
  store: SessionStore,
  conversationId: string
): Promise<
  | { ok: true; file: SessionFileV1 }
  | { ok: false; result: ProcessChatLineResult }
> {
  try {
    return { ok: true, file: await store.load(conversationId) };
  } catch (err) {
    if (
      isSessionStoreErrorKind(err) &&
      (err as SessionStoreError).kind === "not_found"
    ) {
      return { ok: true, file: freshSessionFile(conversationId) };
    }
    return {
      ok: false,
      result: {
        quit: false,
        output: "",
        stderr: typedGoalError(err, conversationId),
      },
    };
  }
}

/** 最小合法 SessionFileV1(形状与 persistChatSessionCheckpoint 的重建一致)。 */
function freshSessionFile(conversationId: string): SessionFileV1 {
  const now = new Date().toISOString();
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    conversation_id: conversationId,
    messages: [],
    jsonMode: false,
    turnCount: 0,
    updatedAt: now,
    title: "",
    cwd: process.cwd(),
    sanitized_at: now,
    checkpoints: [],
  };
}

/** pinGoal + 原子写;save 失败 → typed-error 渲染,不 crash。 */
async function savePinnedGoal(
  store: SessionStore,
  conversationId: string,
  existing: SessionFileV1,
  text: string,
  maxTurns?: number
): Promise<ProcessChatLineResult> {
  const now = new Date().toISOString();
  const updated: SessionFileV1 = {
    ...existing,
    goal: pinGoal({
      current: existing.goal,
      text,
      now,
      ...(maxTurns !== undefined ? { maxTurns } : {}),
    }),
    updatedAt: now,
    schemaVersion: CURRENT_SCHEMA_VERSION,
  };
  try {
    await store.save({ id: conversationId, file: updated });
  } catch (err) {
    return {
      quit: false,
      output: "",
      stderr: typedGoalError(err, conversationId),
    };
  }
  return { quit: false, output: `goal pinned: ${text}` };
}

/** #458 T6: typed-error catch 契约 —— 渲染 `${kind}: ${conversation_id}`。
 *  只接受 SessionStore typed 错误(判别联合的 kind);未知 throw 是 store 契约
 *  外意外,原样重抛(防御性,不静默吞)。 */
function typedGoalError(err: unknown, conversationId: string): string {
  if (isSessionStoreErrorKind(err)) {
    const kind = (err as SessionStoreError).kind;
    return `${kind}: ${conversationId}`;
  }
  throw err;
}

function formatChatError(err: unknown): string {
  if (isIknowError(err)) {
    return `错误 [${err.code}]: ${err.message}`;
  }
  if (err instanceof Error) {
    return `错误: ${err.message}`;
  }
  return `错误: ${String(err)}`;
}

/**
 * T4: `--resume <id>` 的消息 seed 辅助 —— runChatSession 在构造 state 之前
 * 调用,从 SessionStore 加载既有 messages 作为初始历史(processChatLine 的
 * `prior = ctx.state.messages` 自然看到该历史,首轮续跑无需额外接线)。
 *
 * 纯 IO(唯一 IO 是 `store.load`)+ 纯映射,无 Sidekiq、无 harness 依赖,
 * 便于单测。导出是因为测试要直接验证五种 typed 错误的边界处理。
 *
 * **失败语义**:SessionStore.load 只抛 typed SessionStoreError(not_found |
 * parse_failed | schema_invalid | io_error,见 session-store.ts:58)。所有
 * typed 错误均**非阻塞** —— 返回空 messages + 触发 warn 回调(stderr 一行);
 * 调用方保留 conversationId 锚点,使后续 checkpoint 仍写回同一 `<id>.jsonl`,
 * 而非碎片化成新 id。未知 throw(防御性 —— store 只抛 typed)→ 原样重抛。
 */
export async function seedResumeMessages(opts: {
  readonly store: SessionStore | undefined;
  readonly id: string | undefined;
}): Promise<{
  messages: ReadonlyArray<AnthropicNativeMessage>;
  /** 缺省 = 无失败需要通知(undefined 即不调用);存在时调用方应执行以落 stderr。 */
  warn?: () => void;
}> {
  if (opts.store === undefined || opts.id === undefined) {
    return { messages: [] };
  }
  try {
    const file = await opts.store.load(opts.id);
    return { messages: file.messages };
  } catch (err) {
    if (!isSessionStoreErrorKind(err)) {
      // 防御性:store 契约只抛 typed 错误,出现未知异常应当外暴而不是静默吞咽。
      throw err;
    }
    const kind = (err as SessionStoreError).kind;
    const id = opts.id;
    return {
      messages: [],
      warn: () =>
        writeErr(
          `恢复会话 ${id} 失败: [${kind}]，从空开始（仍锚定 ${id} 续写）`
        ),
    };
  }
}

/**
 * T2: chat REPL 的 post-run checkpoint 落盘 —— `src/session-api/hub.ts`
 * conditionalSave(#120 T1)的 chat 侧镜像。纯 IO(load/save 原子写),决策全权
 * 委托 T1 纯函数:
 *
 *   - `shouldPersistCheckpoint(result, priorMessages)` 决定本次 run 是否值得
 *     落盘(cancelled+delta>0 / timeout / completed 等 → true;protocolError /
 *     emptyFinalResponse / turn-0 空 cancelled → false 返回,不写文件)。
 *   - `toInterruptReason` 把 StopReason 映射为 checkpoint label(cancelled /
 *     timeout / protocolError / maxTurns;completed 等 → null,不 append 记录)。
 *   - `appendCheckpoint` 内建 delta=0/负值 no-op 守门(records.messagesCount >
 *     session.messages.length 才 append)。
 *
 * **累计 turnCount**:镜像 hub.ts:739 的 `session.turnCount + result.turnCount`
 * 约定 —— 若该 conversationId 已有盘上文件,新记录从既有 turnCount 继续编号,
 * T4 --resume 才能读到连续的快照序列。
 *
 * **错误处理**(ACR):所有失败复用 SessionStore 既有 typed kinds(write_failed /
 * not_found / parse_failed / schema_invalid),绝不新造 kind;失败经
 * `opts.warn?.(line)` 到 stderr 并 continue,绝不 crash REPL、绝不阻塞退出
 * (第二次 Ctrl+C 只 bounded-wait 1s)。
 *
 * 空 messages 的 turn-0 cancelled → shouldPersist 返回 false,本函数早退不写盘。
 */
export async function persistChatSessionCheckpoint(opts: {
  readonly store: SessionStore;
  readonly conversationId: string;
  readonly jsonMode: boolean;
  readonly result: RunResult;
  readonly priorMessages: ReadonlyArray<AnthropicNativeMessage>;
  /** 落盘失败 / 读坏文件时的 stderr 通知(缺省静默 — 观察者纪律)。 */
  readonly warn?: (line: string) => void;
}): Promise<void> {
  const { store, conversationId, jsonMode, result, priorMessages, warn } = opts;
  try {
    if (!shouldPersistCheckpoint(result, priorMessages)) return;
    let session: SessionFileV1;
    try {
      session = await store.load(conversationId);
    } catch (err) {
      // not_found → 首次落盘,以当前文件构造全新 v3 文件(#120 v2 字段齐备);
      // parse_failed / schema_invalid → 该 conversationId 的既有文件不可用,
      // 以当前进度重建(不可用文件不应阻断本次 turn 落盘)。
      session = {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        conversation_id: conversationId,
        messages: [],
        jsonMode,
        turnCount: 0,
        updatedAt: new Date().toISOString(),
        title: "",
        cwd: process.cwd(),
        sanitized_at: new Date().toISOString(),
        checkpoints: [],
      };
    }
    const now = new Date().toISOString();
    const turnCount = session.turnCount + result.turnCount;
    const interruptReason = toInterruptReason(result.stopReason);
    // appendCheckpoint 的 delta=0 守门比较 record.messagesCount 与
    // session.messages.length —— 必须在把 post-run messages 合入**之前**计算
    // (否则 delta=0 永远 false、守门永不触发;镜像 hub.ts:758-782 同序)。
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
    await store.save({ id: conversationId, file: updated });
  } catch (err) {
    // 失败即警告,绝不重抛 / 绝不 crash REPL。typed kind 原样透出供排查。
    const kind = isSessionStoreErrorKind(err)
      ? `[${(err as SessionStoreError).kind}]`
      : "";
    warn?.(
      `会话检查点写入失败 ${kind}（${err instanceof Error ? err.message : String(err)}），本次进度未持久化`
    );
  }
}

/* ---------------- turn 内 commit 钩子(T3) ---------------- */

/**
 * chat 路径的 turn 内 commit 钩子:把 harness 产出的消息即时 append 到会话
 * JSONL 日志。chat 路径无 serialize 队列,沿用裸 store IO 现状。
 *
 * 首个 commit 时 JSONL 可能不存在(新会话 run 前不预写文件,或 T1 前的
 * legacy .json-only 会话):此时先 bootstrap 建文件/迁出再 append。
 * bootstrap 历史来源:盘上可 load(legacy 迁移)→ 以盘为准;不可 load
 * (全新会话)→ 用 getPriors() 的内存消息(本轮 run 前的历史)。
 * 底层 store IO 失败以 typed store error 传播,不吞。
 */
export function createChatSessionCommitHook(opts: {
  readonly store: SessionStore;
  readonly conversationId: string;
  readonly jsonMode: boolean;
  readonly getPriors: () => ReadonlyArray<AnthropicNativeMessage>;
}): (messages: ReadonlyArray<AnthropicNativeMessage>) => Promise<void> {
  const { store, conversationId, jsonMode, getPriors } = opts;
  return async (messages) => {
    try {
      await store.appendEvents({ id: conversationId, events: [...messages] });
      return;
    } catch (err) {
      // 仅 typed store error(JSONL 缺失/legacy/损坏)走 bootstrap;其余原样抛。
      if (!isSessionStoreErrorKind(err)) throw err;
    }
    let base: SessionFileV1;
    let priors: ReadonlyArray<AnthropicNativeMessage>;
    try {
      base = await store.load(conversationId);
      // 盘上已有权威历史(legacy .json 迁移):以盘为准,不用 getPriors —
      // 否则空 priors 会把既有历史冲掉。
      priors = base.messages;
    } catch {
      // 与 persistChatSessionCheckpoint 的 not_found 分支同形态:v3 全新文件,
      // 历史取 getPriors(本轮 run 前的内存消息)。
      const now = new Date().toISOString();
      base = {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        conversation_id: conversationId,
        messages: [],
        jsonMode,
        turnCount: 0,
        updatedAt: now,
        title: "",
        cwd: process.cwd(),
        sanitized_at: now,
        checkpoints: [],
      };
      priors = getPriors();
    }
    await store.save({
      id: conversationId,
      file: {
        ...base,
        messages: [...priors],
        updatedAt: new Date().toISOString(),
      },
    });
    await store.appendEvents({ id: conversationId, events: [...messages] });
  };
}

/** Kind-guard + writeErr + EXIT for store.load in auto/HITL paths.
 *  Delegates to the shared `reportGoalAutoStoreLoadErr` so chat and hub render
 *  the same `${kind}: ${conversation_id}` form on the same channel. */
function skipChatAutoOnLoadError(err: unknown, conversationId: string): void {
  if (!isSessionStoreErrorKind(err)) {
    throw err;
  }
  reportGoalAutoStoreLoadErr(err, conversationId);
}

/** Narrow a throw to SessionStoreError (typed-kind member) vs other failures. */
function isSessionStoreErrorKind(err: unknown): boolean {
  if (err === null || typeof err !== "object") return false;
  const kind = (err as { kind?: unknown }).kind;
  return (
    kind === "write_failed" ||
    kind === "not_found" ||
    kind === "parse_failed" ||
    kind === "schema_invalid" ||
    kind === "io_error" ||
    kind === "concurrent_write"
  );
}

function resolveQuiet(optsQuiet: boolean | undefined): boolean {
  if (typeof optsQuiet === "boolean") {
    return optsQuiet;
  }
  return process.env.IKNOW_CHAT_QUIET === "1";
}

/**
 * #179 T6 + #195:TTY 流式最终输出接缝。
 *
 * 返回 `{ feed, textStreamed }`(替代 #195 前的裸回调),作为
 * `processChatLine` 的 `onStream`:
 *   - `feed` 把 harness 流式事件按"stdout 直出最终答案 / stderr 工具提示"
 *     分流路由:
 *     - `text_delta` → 经 `opts.writeOut` 写为 stdout 的**最终输出**(增量
 *       滚动);首个 delta 到来时先经 `opts.writeErr` 写 `\r\x1b[K` 清掉
 *       stderr 上的「思考中…」spinner(one-shot);同时翻转 `textStreamed`
 *       为 `true`(经 getter 暴露,host 据此决定回合结束只补状态行)。
 *     - `tool_call_start` → 经 `opts.writeErr` 输出工具名提示(状态行,
 *       永久留在屏幕);**不**翻转 `textStreamed`(纯提示,不承载答案)。
 *   - `textStreamed` 反映是否有答案文本已流式(stdout)过。
 *
 * #195 修复要点:答案文本只直出一次到 stdout(不再回写 stderr 预览再被
 * `formatRunHuman` 二次渲染 —— 多行答案双打印的根因)。`textStreamed`
 * 让 host 知道要不要在回合结束时跳过 `output` 的文本部分。
 *
 * 写入错误被吞咽(观察者不得反向破坏回合;D3 与 safeTrace 纪律)。
 * pipe / 非 TTY 路径不构造本 sink(零输出变化回归保护)。
 */
export interface StreamPreviewSink {
  readonly feed: (event: HarnessStreamEvent) => void;
  readonly textStreamed: boolean;
}

export function createStreamPreviewSink(opts: {
  /** 答案文本 → stdout 最终输出。交互 REPL 传 `process.stdout.write`。 */
  readonly writeOut: (chunk: string) => void;
  /** spinner 清除 + 工具提示 → stderr。交互 REPL 传 `process.stderr.write`。 */
  readonly writeErr: (chunk: string) => void;
}): StreamPreviewSink {
  let textStreamed = false;
  // T5 (#198): 流式草稿经 stream-draft 累积,stdout 写的是 `masked()` 增量
  // (SC20 遮蔽,不再裸写密钥)。`lastWrittenLen` 记录已写出位置,避免每次
  // append 重复写出已写内容。
  // 已知边界(D4 裁决):`masked()` 是"全量重 mask",不维护尾部余量 —— 跨
  // delta 截断的密钥片段(如 `sk-` 先到、`abc123` 后到)会在累积完成前以
  // 片段形式裸写出。SC20 完整密钥命中场景正常遮蔽。
  const streamDraft = createStreamDraft();
  let lastWrittenLen = 0;
  const feed = (event: HarnessStreamEvent): void => {
    try {
      if (event.type === "text_delta") {
        if (!textStreamed) {
          // 清掉「思考中…」spinner(one-shot);首个 delta 之后不再清除。
          opts.writeErr("\r\x1b[K");
        }
        streamDraft.append(event);
        const masked = streamDraft.masked();
        const slice = masked.slice(lastWrittenLen);
        if (slice.length > 0) {
          opts.writeOut(slice);
          lastWrittenLen = masked.length;
        }
        textStreamed = true;
        return;
      }
      if (event.type === "tool_call_start") {
        if (!textStreamed) {
          opts.writeErr("\r\x1b[K");
        }
        opts.writeErr(`\n调用工具:${event.name}\n`);
      }
    } catch {
      // 观察者写入失败不得影响回合交付(stderr/stdout 断流等;D3)。
    }
  };
  return {
    feed,
    get textStreamed() {
      return textStreamed;
    },
  };
}

/**
 * Run a product chat session (TTY REPL or non-interactive pipe).
 */
export async function runChatSession(opts: ChatSessionOpts): Promise<void> {
  // T2 + T4: REPL 级 conversationId。`--resume <id>` 锚定既有 checkpoint
  // 文件 id;缺省(undefined)= 新开会话随机 UUID(`randomUUID` 与 cli.ts ask
  // 入口同源,确保 token 形态一致)。
  const conversationId = opts.resumeId ?? randomUUID();

  // T2: REPL 级 AbortController + SessionStore 注入 ctx;ask/pipe 入口仍
  // 共享同一 ctx,缺省情况下 signal/store 不会走持久化路径(向 ask 开放零变化)。
  // store 默认池 = ~/.iknow,与 serve/TUI 同池(#120 Q6 精神);tests / ask
  // 入口传 opts.deps 不带 store 路径,持久化天然跳过。
  // **T4 顺序调整**:checkpointStore 提前到 state 构造之前 —— resume 路径要先
  // load 既有文件再 seed state.messages;依赖图(store 与 state)允许此顺序。
  const abortController = new AbortController();
  const checkpointStore = new SessionStore(resolveServeDataDir());

  // T4: resume 时从既有 checkpoint 文件加载初始消息历史(seed)。
  //   - `opts.resumeId === undefined` → 零 IO,空 messages,行为与 T2 完全一致。
  //   - load 成功 → messages 来自文件,首轮续跑 processChatLine 的 prior 直接
  //     看到历史,无需任何额外接线。
  //   - load 失败(typed)→ messages 空 + 一行 stderr 警告;**仍保留
  //     conversationId 锚点** —— 后续 turn 的 checkpoint 写回同一 `<id>.jsonl`,
  //     不会碎片化成新 id。未知异常(防御性)→ 原样重抛。
  const { messages: seeded, warn: resumeWarn } = await seedResumeMessages({
    store: opts.resumeId !== undefined ? checkpointStore : undefined,
    id: opts.resumeId,
  });
  resumeWarn?.();

  const state: CliChatState = {
    messages: Object.freeze([...seeded]),
    jsonMode: opts.jsonMode,
    session: opts.session,
    conversationId,
  };

  // T6: wrap the executor with the violation kill-session hook so tool
  // results get observed against the three-tier counter (#123 Q4). When the
  // counter escalates, wireKillSessionNotification writes the stderr line
  // and sets process.exitCode = 1; the REPL then closes after the current
  // turn (kill = exit the session, per spec §OQ4 "杀会话").
  const counter = createViolationCounter();
  const killRef: { fired: boolean } = { fired: false };
  const notify = wireKillSessionNotification({ sink: writeErr });
  const onKill = (reason: string): void => {
    killRef.fired = true;
    notify(reason);
  };
  const executor = wrapWithViolationHook({
    inner: opts.deps.executor,
    counter,
    onKill,
  });
  // #502 T5 / ADR-0021 D1.4:per-session conversationId 注入 deps（loop-engine
  // 经 executor.executeAll 第 4 参透传到 tool ctx.conversationId）。build-engine
  // 的 deps 跨会话共享,cachedDeps不变;此处在 REPL 级 wrappedDeps 闭包落 session
  // 锚点,scope 过滤才能在同 session 内闭环。
  const wrappedDeps: LoopEngineDeps = {
    ...opts.deps,
    executor,
    // CliChatState.conversationId:string | null;LoopEngineDeps.conversationId:
    // string | undefined —— null 用 ?? undefined 收敛到 undefined 缺省语义
    // （不过滤，与 ADR-0021 D1.4 backward-compat 路径对齐）。
    conversationId: state.conversationId ?? undefined,
    // #620 T3:turn 内 commit —— chat 路径无 serialize 队列,直调 store(沿用
    // 裸 store IO 现状)。getPriors 读 live state.messages(= 本轮 run 前的历史,
    // 与 hub bootstrap 的 session.messages 同语义;当前轮 user query 仍由收尾
    // checkpoint 落盘)。调用方已注入 commitMessages 时以调用方为准。
    commitMessages:
      opts.deps.commitMessages ??
      createChatSessionCommitHook({
        store: checkpointStore,
        conversationId,
        jsonMode: state.jsonMode,
        getPriors: () => state.messages,
      }),
  };

  const ctx: ChatLineContext = {
    deps: wrappedDeps,
    state,
    showThinking: opts.showThinking,
    permissionMode: opts.permissionMode,
    graphMode: opts.graphMode,
    graphAssembly: opts.graphAssembly,
    abortController,
    checkpointStore,
    subagentManager: opts.subagentManager,
    verifyConfig: opts.verifyConfig,
    autoMemory: opts.autoMemory,
    overlayMemoryPrefetch: opts.overlayMemoryPrefetch,
  };

  const interactive = isInteractive();

  if (interactive) {
    await runInteractive({ ctx, killRef });
  } else {
    await runPiped({ ctx, quiet: resolveQuiet(opts.quiet), killRef });
  }
}

function printBanner(): void {
  writeErr("iknow chat");
  writeErr("输入问题开始对话。/help 查看命令 · /quit 或 Ctrl+D 退出");
}

async function runInteractive(opts: {
  readonly ctx: ChatLineContext;
  /** T6: set when the violation counter escalates; the REPL closes after
   *  the current turn completes (one-shot notification already emitted). */
  readonly killRef?: { fired: boolean };
}): Promise<void> {
  const { ctx, killRef } = opts;
  printBanner();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  let closed = false;
  let busy = false;
  let farewellPrinted = false;
  const sayGoodbye = (): void => {
    if (farewellPrinted) {
      return;
    }
    farewellPrinted = true;
    writeErr("再见。");
  };

  let sigintCount = 0;
  /** Coalesce same-tick dual delivery (process + readline) without timed debounce. */
  let sigintCoalesce = false;
  /** B1: 首次 Ctrl+C 空闲分支的提示 —— 明确「空闲不打断」语义,避免用户误以为
   *  当前 turn 被打断。busy 分支文案保持不变(见 onSigint)。 */
  const printIdleCtrlCNotice = (): void => {
    writeErr("\n当前无运行中的 turn（Ctrl+C 空闲时不打断）；/quit 退出");
  };
  const onSigint = (): void => {
    if (sigintCoalesce) {
      return;
    }
    sigintCoalesce = true;
    queueMicrotask(() => {
      sigintCoalesce = false;
    });

    sigintCount += 1;
    if (sigintCount === 1) {
      // T2: busy 时第一次 Ctrl+C 打断 in-flight turn。controller.signal 由
      // processChatLine 透传到 run(),signal.abort → run 以 stopReason
      // "cancelled" resolve → post-run 路径落 checkpoint(recoverable)。
      // 空闲时不 abort(避免污染下一次 turn),直接重绘 prompt。
      if (busy) {
        writeErr("\n再次 Ctrl+C 退出，或输入 /quit");
        ctx.abortController?.abort();
      } else if (!closed) {
        printIdleCtrlCNotice();
        rl.prompt(true);
      } else {
        // closed 兜底:仍提示退出路径(与改前「无条件打印」一致)。
        writeErr("\n再次 Ctrl+C 退出，或输入 /quit");
      }
      return;
    }
    // Second SIGINT: leave immediately even if a turn is mid-flight.
    farewellPrinted = true;
    writeErr("\n退出。");
    closed = true;
    process.off("SIGINT", onSigint);
    rl.removeListener("SIGINT", onSigint);
    try {
      rl.close();
    } catch {
      // EXIT: interface may already be closed
    }
    // T2: bounded 1s 等在飞的 turn(含 processChatLine 内已 await 的
    // persistChatSessionCheckpoint)完成,再 process.exit(130)。绝不在
    // 退出钩子上阻塞(save 失败由 persist 内部 warn+continue)。
    // 1s 上限 —— 即便 turn 卡住也强制退出,REPL 不挂。
    void Promise.race([
      chain.catch(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, 1000)),
    ]).then(() => process.exit(130));
  };
  // Node may deliver Ctrl+C to process and/or readline depending on platform.
  process.on("SIGINT", onSigint);
  rl.on("SIGINT", onSigint);

  const prompt = (): void => {
    if (closed) {
      return;
    }
    sigintCount = 0;
    rl.setPrompt("iknow> ");
    rl.prompt();
  };

  // Serialize turns: never start next line / prompt until previous finishes.
  let chain: Promise<void> = Promise.resolve();
  let wakeController: SubagentWake | undefined;

  const handle = async (line: string): Promise<void> => {
    busy = true;
    let showThinking = false;
    // #195:流式最终输出 sink(函数级作用域,供 try 内赋值、catch 兜底清行)。
    let preview: StreamPreviewSink | null = null;
    try {
      // Pause input so the next prompt cannot appear mid-turn.
      rl.pause();

      const looksLikeQuery =
        line.trim().length > 0 && !line.trim().startsWith("/");
      // 思考中 only when stderr is a TTY (never spam pipes / redirected logs).
      showThinking = looksLikeQuery && Boolean(process.stderr.isTTY);

      if (showThinking) {
        process.stderr.write("思考中…");
      }

      // #179 T6 + #195:流式最终输出(仅 stderr TTY 时;与「思考中…」同门槛)。
      // 答案文本经 feed 直出 stdout 作为最终输出;首个 delta 自动清 spinner。
      // textStreamed 供回合结束判断(见下方 #195 分支)。
      if (showThinking) {
        preview = createStreamPreviewSink({
          writeOut: (chunk) => process.stdout.write(chunk),
          writeErr: (chunk) => process.stderr.write(chunk),
        });
      }
      const onStream = preview ? preview.feed : undefined;

      let result: ProcessChatLineResult;
      try {
        result = await processChatLine({ line, ctx, onStream });
      } catch (err) {
        if (preview) {
          clearErrLine();
        }
        writeErr(formatChatError(err));
        if (killRef?.fired === true) {
          closed = true;
          rl.close();
          return;
        }
        if (!closed) {
          prompt();
          rl.resume();
        }
        return;
      }

      if (preview) {
        // Sink 自己管 spinner 清除(首个 delta 时);这里兜底无 delta 的回合
        // (空响应 / 异常等)。一次即可。
        clearErrLine();
      }

      if (result.stderr) {
        writeErr(result.stderr);
      }
      if (result.output) {
        // #195:已流式 → 答案文本已在 stdout,只补状态行 + 分隔符(避免双打印)。
        // 未流式(preview=null OR preview 但无 text_delta → 空响应 / 非流式
        // 臂)→ 整体写 `result.output`,保持 pipe / 非 TTY / ask 零变化。
        if (preview?.textStreamed && result.statusLine !== undefined) {
          writeOut(result.statusLine);
          writeOut(TTY_ANSWER_SEP);
        } else {
          writeOut(result.output);
          // Separator after agent answers only (TTY path).
          if (result.ranQuery) {
            writeOut(TTY_ANSWER_SEP);
          } else {
            writeOut("");
          }
        }
      }

      if (result.quit) {
        closed = true;
        rl.close();
        return;
      }

      // T6: violation escalation fired mid-turn → kill the session after
      // this turn completes (notification already written by onKill).
      if (killRef?.fired === true) {
        closed = true;
        rl.close();
        return;
      }

      // Prompt only after the full turn is done.
      if (!closed) {
        prompt();
        rl.resume();
      }
    } catch (err) {
      // EXIT: protect chain from rejections before/around processChatLine
      if (preview) {
        clearErrLine();
      }
      writeErr(formatChatError(err));
      if (!closed) {
        try {
          prompt();
          rl.resume();
        } catch {
          // EXIT: readline may already be closed
        }
      }
    } finally {
      busy = false;
      wakeController?.flush();
    }
  };

  wakeController = createSubagentWake({
    manager: ctx.subagentManager,
    isIdle: () => !busy && !closed,
    wake: async () => {
      busy = true;
      try {
        const wakeRun = chain.then(async () => {
          const result = await runChatSubagentWake({ ctx });
          if (result.stderr) writeErr(result.stderr);
          if (result.output) {
            writeOut(result.output);
            if (result.ranQuery) writeOut(TTY_ANSWER_SEP);
          }
        });
        chain = wakeRun.catch((error: unknown) => {
          const wakeError = toSubagentWakeError(error, {
            reason: "wakeFailed",
            taskIds: queryableSubagentTaskIds(ctx.subagentManager),
            queryable: ctx.subagentManager !== undefined,
          });
          writeErr(formatChatError(wakeError));
          // EXIT: keep the serialized wake chain usable after reporting this
          // undelivered wake; never turn the failure into a success summary.
        });
        await chain;
      } finally {
        busy = false;
      }
    },
    onError: (error) => writeErr(formatChatError(error)),
  });

  // W2 扩展：Shift+Tab 切换权限模式（default ↔ full_auto；plan 走
  // /permissions plan 命令不进循环）。REPL 用 readline：terminal:true 时
  // stdin 已 emit keypress，keypress 里 shift+tab = key.name==="tab" &&
  // key.shift。
  //
  // busy 期间（turn in-flight）readline 会调 `rl.pause()` 暂停 stdin，
  // 此时 keypress 不会送达 — 仅空闲期（prompt 等待输入时）按 Shift+Tab
  // 生效。busy-time 模式切换仅在 TUI 入口可达（ink useInput 不走
  // readline，不受 pause 影响）。这是已知边界、注释诚实记录。
  //
  // 守卫 `!key.ctrl && !key.meta`：避免误触（Ctrl+Tab / Meta+Tab 各有
  // 用途）。守卫 + flip 副作用走共享 helper `applyShiftTabModeFlip`
  // （modes.ts；TUI 也用它），避免双份实现。
  //
  // handler 捕获到命名常量以便 rl.close 时 off（不积攒）。
  const keypressHandler = (
    _ch: unknown,
    key?: { name?: string; shift?: boolean; ctrl?: boolean; meta?: boolean }
  ): void => {
    if (closed) return;
    // D-α / ADR-0030: 三态轮 Default → Auto → Graph → Default。graph holder
    // 缺席时退化成既有单轴 permission 轮（零行为变化）。
    applyShiftTabAgentModeFlip({
      key,
      permission: opts.ctx.permissionMode,
      graph: opts.ctx.graphMode,
      onFlip: (next) => {
        writeErr(`\n模式: ${agentModeLabel(next)}`);
        rl.prompt(true);
      },
    });
  };
  process.stdin.on("keypress", keypressHandler);

  await new Promise<void>((resolve) => {
    rl.on("line", (line) => {
      if (closed) {
        return;
      }
      chain = chain
        .then(() => handle(line))
        .catch((err) => {
          // EXIT: last-resort so unhandled rejections never kill the process
          writeErr(formatChatError(err));
          busy = false;
          if (!closed) {
            try {
              prompt();
              rl.resume();
            } catch {
              // EXIT: readline closed
            }
          }
        });
    });
    rl.on("close", () => {
      wakeController.dispose();
      process.off("SIGINT", onSigint);
      rl.removeListener("SIGINT", onSigint);
      // 卸载 Shift+Tab keypress 监听；与 SIGINT cleanup 同位（不积攒）。
      process.stdin.off("keypress", keypressHandler);
      // Normal /quit or EOF: wait for in-flight turn then farewell.
      // Forced second Ctrl+C uses process.exit(130) and never reaches here.
      void chain.finally(() => {
        sayGoodbye();
        resolve();
      });
    });
    prompt();
  });
}

async function runPiped(opts: {
  readonly ctx: ChatLineContext;
  readonly quiet: boolean;
  /** T6: violation escalation closes the pipe loop after the current turn. */
  readonly killRef?: { fired: boolean };
}): Promise<void> {
  const { ctx, quiet, killRef } = opts;
  // Do not force terminal:true — avoids prompt garble on pipes.
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
    crlfDelay: Infinity,
  });

  let turn = 0;
  for await (const line of rl) {
    // Empty lines: skip (no turn marker, no agent call).
    if (line.trim().length === 0) {
      continue;
    }

    turn += 1;
    if (!quiet) {
      writeErr(`── turn ${turn} ──`);
    }

    // Never print 思考中 on pipe (quiet product / script friendly).
    const result = await processChatLine({ line, ctx });

    if (result.stderr) {
      writeErr(result.stderr);
    }
    if (result.output) {
      writeOut(result.output);
      writeOut("");
    }
    if (result.quit) {
      break;
    }
    // T6: violation escalation fired mid-turn → stop reading further lines.
    if (killRef?.fired === true) {
      break;
    }
  }
}
