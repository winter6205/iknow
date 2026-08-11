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
  type RunResult,
} from "../harness/index.js";
import { formatRunHuman, formatRunJson, formatStatusLine } from "./format.js";
import {
  applySlashCommand,
  parseChatLine,
  type CliChatState,
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
  createViolationCounter,
  wireKillSessionNotification,
} from "../harness/sandbox/violation-handling.js";
import { writeIknowState } from "../harness/identity/index.js";
import { createStreamDraft } from "./stream-draft.js";
import {
  parsePermissionMode,
  modeLabel,
  applyShiftTabModeFlip,
  type PermissionMode,
  type PermissionModeContext,
} from "../harness/permission/modes.js";
import {
  SessionStore,
  type SessionStoreError,
  type SessionFileV1,
  CURRENT_SCHEMA_VERSION,
  extractSummary,
  appendCheckpoint,
  shouldPersistCheckpoint,
  toInterruptReason,
} from "../session-api/store/index.js";
import { resolveServeDataDir } from "../session-api/serve.js";
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
};

export type ChatLineContext = {
  deps: LoopEngineDeps;
  state: CliChatState;
  /** #152 T5:thinking 可见开关(与 ChatSessionOpts.showThinking 同源)。 */
  showThinking?: boolean;
  /** W2: 权限模式上下文(由 runChatSession 透传,/permissions 翻它)。 */
  permissionMode?: PermissionModeContext;
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
    });
  }

  const query = parsedLine.text;
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
  // T2: prior 快照(run 前 state.messages 引用;append-only 冻结已保证该引用
  // 不会就地变更,run 后若 host 整体替换 messages 也不会影响 prior)。throw
  // 路径用同一 prior 引用(protocolError/emptyFinalResponse 不替换;MaxTurnsExceeded
  // catch 也不替换 — 抛异常路径不进此处 if-块,见 catch 分支)。
  const prior = ctx.state.messages;
  try {
    const { result, trace } = await runHarness(
      query,
      ctx.deps,
      ctx.abortController?.signal,
      {
        priorMessages: prior,
        // #179 T6 (D3):观察者回调透传;undefined = 非流式行为零变化(pipe/ask)。
        // T6:wrap 后仅转发非 stop_summary 事件(摘要单独捕获,见上)。
        onStream: wrappedOnStream,
      }
    );
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
        result,
        priorMessages: prior,
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
      result.stopReason !== "protocolError" &&
      result.stopReason !== "emptyFinalResponse"
    ) {
      ctx.state.messages = Object.freeze([...result.messages]);
    }
    const human = !ctx.state.jsonMode;
    const output = human
      ? formatRunHuman({
          result,
          trace,
          showThinking: ctx.showThinking,
        })
      : formatRunJson({ result, trace });
    return {
      quit: false,
      output,
      // #195:status line for the streaming chat host(non-streamed / pipe /
      // json paths ignore it — they consume `output` unchanged).
      statusLine: human
        ? formatStatusLine({ result, trace, showThinking: ctx.showThinking })
        : undefined,
      ranQuery: true,
    };
  } catch (err) {
    if (err instanceof MaxTurnsExceeded) {
      // plan T3 + T6 / ADR-0011:maxTurns 超限是强制感知信号 — 接住 throw,
      // 呈现「已达上限」stderr + 收尾摘要(若有)。摘要经上面的 wrapper 捕获
      // (loop-engine 在重抛前 emit stop_summary)。
      const notice = maxTurnsNotice(err, stopSummary);
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

async function processSlash(opts: {
  readonly command: string;
  readonly args: string[];
  readonly ctx: ChatLineContext;
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

    case "profile": {
      // #196 首启完成钩子:用户已在外侧填好 ~/.iknow/user.md,输入
      // /profile done 翻 bootstrap_seeded。writeIknowState 是 async,
      // 落点在 host 的 processSlash;写失败走 typed IknowIdentityError →
      // 错误文案(不静默)。
      if ((effect.args[0] ?? "").toLowerCase() !== "done") {
        return {
          quit: false,
          output: "",
          stderr:
            "Usage: /profile done（已在外侧填好 ~/.iknow/user.md 后执行）",
        };
      }
      try {
        await writeIknowState({ bootstrap_seeded: true });
      } catch (err) {
        return {
          quit: false,
          output: "",
          stderr: `首启完成标记失败：${formatChatError(err)}`,
        };
      }
      return {
        quit: false,
        output: "首启引导已完成，下次会话直接进入工作。",
      };
    }

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
  }
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
        summary: "",
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
      summary: extractSummary(result.messages),
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
  // T2: REPL 级 conversationId(随机 UUID,固定一次)。`randomUUID` 与 cli.ts
  // ask 入口同源,确保 token 形态一致。T4 --resume 会复用此字段锚定同一文件。
  const conversationId = randomUUID();
  const state: CliChatState = {
    messages: Object.freeze([]),
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
  const wrappedDeps: LoopEngineDeps = { ...opts.deps, executor };

  // T2: REPL 级 AbortController + SessionStore 注入 ctx;ask/pipe 入口仍
  // 共享同一 ctx,缺省情况下 signal/store 不会走持久化路径(向 ask 开放零变化)。
  // store 默认池 = ~/.iknow,与 serve/TUI 同池(#120 Q6 精神);tests / ask
  // 入口传 opts.deps 不带 store 路径,持久化天然跳过。
  const abortController = new AbortController();
  const checkpointStore = new SessionStore(resolveServeDataDir());

  const ctx: ChatLineContext = {
    deps: wrappedDeps,
    state,
    showThinking: opts.showThinking,
    permissionMode: opts.permissionMode,
    abortController,
    checkpointStore,
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
      writeErr("\n再次 Ctrl+C 退出，或输入 /quit");
      // T2: busy 时第一次 Ctrl+C 打断 in-flight turn。controller.signal 由
      // processChatLine 透传到 run(),signal.abort → run 以 stopReason
      // "cancelled" resolve → post-run 路径落 checkpoint(recoverable)。
      // 空闲时不 abort(避免污染下一次 turn),直接重绘 prompt。
      if (busy) {
        ctx.abortController?.abort();
      } else if (!closed) {
        rl.prompt(true);
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
    }
  };

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
    applyShiftTabModeFlip({
      key,
      ctx: opts.ctx.permissionMode,
      onFlip: (next) => {
        writeErr(`\n权限模式: ${modeLabel(next)}`);
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
