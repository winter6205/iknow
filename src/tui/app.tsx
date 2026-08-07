/**
 * src/tui/app.tsx
 *
 * #146 TUI 根组件：ListView / ChatView 切换 + 全局状态栏 + slash 路由。
 * 状态机纪律（Q1/Q1a）：会话三态由 session-state.ts 纯函数驱动；
 * turn 后台继续执行 = postMessage Promise 不随视图切换取消，仅前台
 * AbortController 被 Ctrl+C 打断。
 *
 * 退出语义（spec OQ3 实施细化）：存在 running-bg 会话时 `/quit` 需二次确认；
 * 确认后等待全部 in-flight turn 落盘再退出（退出不打断后台 turn，Q1a）。
 *
 * 行级滚动（任务 A 行级重构）：
 *  - `chatScroll` 现为行数（>0 = 向上滚多少行），不再是消息计数；
 *  - 视口高度 = 终端 rows - banner - 状态栏 - 输入框 - 槽位，动态算；
 *  - PgUp = 视口一半向下滚，PgDn = 视口一半向上滚，Home = 顶，End = 0；
 *  - 鼠标滚轮不再由 app 截胡（跟随 upstream：移除 DECSET 1000/1006 捕获），
 *    交给终端原生 scrollback 翻历史；auto-follow 在 turn 完成 / new 会话触发。
 */
import { startTransition, useEffect, useMemo, useRef, useState } from "react";
import type { HarnessStreamEvent } from "../harness/stream.js";
import type { ReactElement } from "react";
import { Box, Text, useApp, useInput, useWindowSize } from "ink";
import type { TuiBridge } from "./hub-bridge.js";
import type { TuiAskUserBridge } from "./ask-user.js";
import {
  DRAFT_SESSION_ID,
  attachSession,
  canInterrupt,
  createDraftSession,
  sessionSummary,
  switchedAwayFrom,
  switchedTo,
  turnFinished,
  turnStarted,
  userMessageEchoed,
  type TuiSessionState,
  type TuiView,
} from "./session-state.js";
import {
  helpLines,
  parseTuiInput,
  slashComplete,
  slashSuggestions,
  type TuiSlashCommand,
} from "./slash.js";
import { formatLiveToolEvent, summarizeToolCall } from "./tool-summary.js";
import type { TuiToolEvent } from "./deps.js";
import { liveToolReduce, type LiveToolRun } from "./live-tool-state.js";
import { ChatView } from "./chat-view.js";
import type { StreamDraft } from "../cli/stream-draft.js";
import { createStreamDraft } from "../cli/stream-draft.js";
import { ListView, relativeTime, type TuiListEntry } from "./list-view.js";
import { PromptInput, useTick } from "./components.js";
import { renderBanner } from "./banner.js";
import { tuiPalette } from "./theme.js";
import { clipOneLine } from "./text.js";
import { VERSION } from "./version.js";
import { writeIknowState } from "../harness/identity/index.js";
import { isSgrMouseSequence } from "./mouse.js";

export interface TuiToolEventSink {
  readonly emit: (event: TuiToolEvent) => void;
  readonly subscribe: (cb: (event: TuiToolEvent) => void) => () => void;
}

export function createToolEventSink(): TuiToolEventSink {
  const subs = new Set<(event: TuiToolEvent) => void>();
  const sink: TuiToolEventSink = {
    emit: (event) => {
      for (const cb of subs) cb(event);
    },
    subscribe: (cb) => {
      subs.add(cb);
      return () => {
        subs.delete(cb);
      };
    },
  };
  return Object.freeze(sink);
}

export interface TuiAppProps {
  readonly bridge: TuiBridge;
  readonly askBridge: TuiAskUserBridge;
  readonly toolEventSink: TuiToolEventSink;
  /** `iknow tui <session-id>` resume 入口传入的已建档会话；缺省 = draft。 */
  readonly initialSession?: TuiSessionState;
  readonly cwd: string;
  readonly dataDir: string;
}

interface Notice {
  readonly lines: ReadonlyArray<string>;
}

export function TuiApp(props: TuiAppProps): ReactElement {
  const { bridge, askBridge, toolEventSink } = props;
  const pal = tuiPalette;
  const { exit } = useApp();
  const { columns, rows: rawRows } = useWindowSize();
  const cols = Math.max(columns ?? 80, 40);
  const rows = Math.max(rawRows ?? 24, 10);

  const initial = props.initialSession ?? createDraftSession();
  const initialKey = initial.conversationId ?? DRAFT_SESSION_ID;
  const [sessions, setSessions] = useState<Record<string, TuiSessionState>>(
    () => ({ [initialKey]: initial })
  );
  const [activeKey, setActiveKey] = useState(initialKey);
  const [view, setView] = useState<TuiView>("chat");
  const [inputValue, setInputValue] = useState("");
  const [notice, setNotice] = useState<Notice | undefined>(undefined);
  const [liveToolLines, setLiveToolLines] = useState<
    Record<string, ReadonlyArray<string>>
  >({});
  // T4 (#175): 结构化工具调用实时状态 — 按 conversationId 持有 LiveToolRun[];
  // tool_call_start 追加 "running";postToolUse 按 tool_use_id 配对转 ok/failed;
  // 缺 tool_use_id 的 postToolUse 事件落回 liveToolLines(legacy 字符串行)。
  const [liveToolRuns, setLiveToolRuns] = useState<
    Record<string, ReadonlyArray<LiveToolRun>>
  >({});
  const [pendingQuit, setPendingQuit] = useState(false);
  // T6 (D5): thinking 折叠面板展开态 — 全局运行态,会话重启回退折叠(/thinking 切换)。
  const [thinkingExpanded, setThinkingExpanded] = useState(false);
  // 任务 A 行级：聊天区域行级滚动偏移（0 = 底/auto-follow，>0 = 向上滚多少
  // 物理行）。新 turn 完成 / new 会话 → 0；PgUp/PgDn/Home/End 调整
  // （与 PromptInput 的 ↑/↓ 不冲突，避键）；鼠标滚轮交由终端原生 scrollback。
  const [chatScroll, setChatScroll] = useState(0);

  // T4 (#175): 流式草稿单一实例（单会话 in-flight 即可；多会话并发时只有
  // fg 会话持 streamDraft，bg 由落盘后刷新获得终稿）。state ref 由 React 保证
  // 引用稳定 — 等价 useSyncExternalStore 的快照语义（getSnapshot 不能每调
  // 用返新值，避免无限 re-render；我们用 useState 持有 masked 字符串）。
  const [streamDraft, setStreamDraft] = useState<StreamDraft | null>(null);
  const [draftsMasked, setDraftsMasked] = useState<string>("");
  // T3 (#175): thinking 流式草稿 masked 文本(独立于 answer draft)。
  const [thinkingDraftMasked, setThinkingDraftMasked] = useState<string>("");
  // 当 streamDraft 切换时重订阅；listener 内现取 masked() 推 state。
  useEffect(() => {
    if (streamDraft === null) {
      setDraftsMasked("");
      setThinkingDraftMasked("");
      return undefined;
    }
    const unsubscribe = streamDraft.subscribe(() => {
      // T5 (#175): 订阅回调包 React.startTransition — 流式 high-frequency
      // 更新标记为低优先级 transition,React 可中断并让出主线程(输入框 /
      // 键盘保持响应),与前端的 50ms 批处理构成双端防御。
      startTransition(() => {
        setDraftsMasked(streamDraft.masked());
        // T3: thinking 与 answer 同源订阅,一次 notify 双推。
        setThinkingDraftMasked(streamDraft.thinkingMasked());
      });
    });
    // 立即同步一次初始值（subscribe 不回调，append 之前 draft 为空也无所谓）
    setDraftsMasked(streamDraft.masked());
    setThinkingDraftMasked(streamDraft.thinkingMasked());
    return unsubscribe;
  }, [streamDraft]);

  const aborters = useRef(new Map<string, AbortController>());
  const inflightPromises = useRef(new Set<Promise<unknown>>());
  const [listEntries, setListEntries] = useState<ReadonlyArray<TuiListEntry>>(
    []
  );
  // 根 tick 仅轮询 askBridge.pending()（组件树外状态）：有 pending 时才
  // 挂载，idle 且无授权待决时不强制整树 10Hz 重渲染（spinner 自带 tick）。
  const askTick = askBridge.pending() !== undefined;
  useTick(askTick ? 100 : 0);

  // 任务 A 行级：计算聊天区域可视行数（终端总行 - banner - 状态栏 - 输入框
  // - notice 槽 - 顶部分隔）。保守下界 3，避免负数 / 0 导致窗口错乱。
  // 注意：list 视图整屏占用，chat 视图才走这个分配。
  const bannerLineCount = useMemo(() => {
    if (view !== "chat") return 0;
    const sess = sessions[activeKey] ?? initial;
    if (sess.messages.length !== 0) return 0;
    return (
      renderBanner(
        { version: VERSION, cwd: props.cwd, dataDir: props.dataDir },
        { cols, short: false }
      ).length + 1
    ); // +1 = 顶部分隔
  }, [view, activeKey, sessions, initial, cols, props.cwd, props.dataDir]);

  const viewportRows = useMemo(() => {
    // 固定行扣减：banner / 状态栏（1） / 输入框（2：圆角线框 1 + hint 1 视情况）
    // / ask 槽（1）/ notice（按 lines）。滚动指示器（顶部 / fold）的行账由
    // ChatView 内部从 viewportRows 扣除（INDICATOR_ROWS，SSOT）——调用方
    // 传入的是聊天区域总预算，不再预扣指示行（旧实现预扣 1 但指示实测占
    // 2 行，是 #189 渲染漂移的 chrome 账目根因）。
    const noticeLines = notice?.lines.length ?? 0;
    const reserved = 1 + 2 + 1 + noticeLines; // 状态栏 + 输入 + ask + notice
    return Math.max(5, rows - bannerLineCount - reserved);
  }, [rows, bannerLineCount, notice]);

  // 工具事件订阅：T4 (#175) 优先按 tool_use_id 配对入结构化运行状态;
  // 缺 toolUseId 时落回 legacy 字符串行追加(向后兼容)。
  useEffect(
    () =>
      toolEventSink.subscribe((event) => {
        if (event.toolUseId !== undefined) {
          const { detail } = summarizeToolCall(event.toolName, event.input);
          setLiveToolRuns((prev) => ({
            ...prev,
            [event.conversationId]: liveToolReduce(
              prev[event.conversationId] ?? [],
              {
                kind: "post_tool_use",
                id: event.toolUseId!,
                name: event.toolName,
                input: event.input,
                ok: event.kind === "ok",
                detail,
                message: event.message,
              }
            ),
          }));
          return;
        }
        setLiveToolLines((prev) => ({
          ...prev,
          [event.conversationId]: [
            ...(prev[event.conversationId] ?? []),
            formatLiveToolEvent({
              toolName: event.toolName,
              input: event.input,
              kind: event.kind,
            }),
          ],
        }));
      }),
    [toolEventSink]
  );

  // 鼠标滚轮已不再由 app 截胡：跟随 upstream（`frontend/terminal` 无任何
  // DECSET 写入，ink 7.x `alternateScreen: false` 默认）让终端原生
  // scrollback 接管滚轮翻历史。键盘 PgUp/PgDn/Home/End 行级滚动保留，
  // 与 native scrollback 并存不冲突。

  const active = sessions[activeKey] ?? initial;
  const askPending = askBridge.pending();

  /** 输入框下方候选提示：仅在以 "/" 开头且候选非空时展示。派生而非 state，
   *  避免双源同步（inputValue 单一来源）。任务 B：候选列表传给 PromptInput
   *  内部维护 cursor + 渲染。 */
  const inputHintSuggestions: ReadonlyArray<TuiSlashCommand> = useMemo(() => {
    if (!inputValue.trim().startsWith("/")) return [];
    return slashSuggestions(inputValue);
  }, [inputValue]);

  /** 发一个 turn：lazy create → running-fg → postMessage → 落盘后刷新。 */
  async function sendTurn(text: string): Promise<void> {
    if (active.runState !== "idle") {
      setNotice({
        lines: ["当前会话正在运行；导航命令仍可用，消息请等本轮结束。"],
      });
      return;
    }
    // 任务 A 行级：用户发新消息 → 立即回到底部（auto-follow），否则新
    // 消息会落在视口上方，被 scroll 窗口截掉。
    setChatScroll(0);
    const startedKey = activeKey;
    let conversationId = active.conversationId;
    try {
      conversationId = await bridge.ensureSession(conversationId);
    } catch (err) {
      setNotice({ lines: [`建档失败：${describeError(err)}`] });
      return;
    }
    // draft → 建档后重新挂键。
    if (startedKey === DRAFT_SESSION_ID) {
      setSessions((prev) => {
        const draft = prev[DRAFT_SESSION_ID];
        if (!draft || conversationId === undefined) return prev;
        const next = {
          ...prev,
          [conversationId]: { ...draft, conversationId },
        };
        delete next[DRAFT_SESSION_ID];
        return next;
      });
      setActiveKey(conversationId);
    }
    const targetId = conversationId;
    if (targetId === undefined) return;
    // T2 (#175): 提交即即时回显用户消息 — turnStarted 后立刻把用户文本追加进
    // messages,任何 delta 到达前对话已可见。turn 结束/abort 后由落盘 messages
    // 原子替换(中间态自动消失)。
    setSessions((prev) =>
      prev[targetId]
        ? {
            ...prev,
            [targetId]: userMessageEchoed(turnStarted(prev[targetId]!), text),
          }
        : prev
    );
    const controller = new AbortController();
    aborters.current.set(targetId, controller);
    const promise = runTurnOnce(targetId, text, controller);
    inflightPromises.current.add(promise);
    void promise.finally(() => inflightPromises.current.delete(promise));
  }

  /** 单个 turn 的异步主体：postMessage → 落盘后从文件刷新（磁盘是 SSOT）。
   *  sendTurn 只做状态编排；turn 完成 / 失败的状态落点都在这里收敛。 */
  async function runTurnOnce(
    targetId: string,
    text: string,
    controller: AbortController
  ): Promise<void> {
    let stopReason: string | undefined;
    // T4: 构造草稿 + 装配 onStream；abort 时清空（cancelled 路径 + 异常路径都走）。
    const draft = createStreamDraft();
    setStreamDraft(draft);
    const onStream = (event: HarnessStreamEvent): void => {
      // T3 (#175): thinking_delta 进 thinking buffer; text_delta 进 answer buffer。
      draft.append(event);
      // T4 (#175): tool_call_start 追加结构化"运行中"条目(实时状态)。
      if (event.type === "tool_call_start") {
        setLiveToolRuns((prev) => ({
          ...prev,
          [targetId]: liveToolReduce(prev[targetId] ?? [], {
            kind: "tool_call_start",
            id: event.id,
            name: event.name,
          }),
        }));
      }
    };
    try {
      const resp = await bridge.postMessage({
        conversationId: targetId,
        text,
        signal: controller.signal,
        onStream,
      });
      stopReason = resp.stopReason;
    } catch (err) {
      stopReason = "protocolError";
      setNotice({ lines: [`turn 失败：${describeError(err)}`] });
    } finally {
      aborters.current.delete(targetId);
      // 草稿收尾：清缓冲 + 解绑 state（draftsMasked useEffect 会自动清空）。
      draft.reset();
      setStreamDraft(null);
    }
    // 落盘后从文件刷新（共享池纪律：磁盘是 SSOT）。cancelled 走
    // DROP_REASONS 不落盘 → 文件仍是 turn 前状态，UI 与磁盘一致。
    try {
      const file = await bridge.loadSessionFile(targetId);
      setSessions((prev) => {
        const current = prev[targetId];
        if (!current) return prev;
        return {
          ...prev,
          [targetId]: turnFinished(current, {
            conversationId: file.conversation_id,
            messages: file.messages,
            turnCount: file.turnCount,
            updatedAt: file.updatedAt,
            jsonMode: file.jsonMode,
            stopReason:
              (stopReason as TuiSessionState["lastStopReason"]) ?? "completed",
          }),
        };
      });
      setLiveToolLines((prev) => ({ ...prev, [targetId]: [] }));
      // T4: turn 结束清空结构化实时工具状态(落盘后终稿 tool_use blocks 接管)。
      setLiveToolRuns((prev) => ({ ...prev, [targetId]: [] }));
      // 任务 A：新 turn 完成 → 滚动重置为底部（auto-follow）
      setChatScroll(0);
      if (stopReason === "cancelled") {
        setNotice({ lines: ["已打断当前 turn（未落盘）。"] });
      }
    } catch (err) {
      // 刷新失败也要落回 idle：否则会话卡在 running-fg（aborter 已在
      // finally 移除 → Ctrl+C 无效，且「正在运行」护栏挡住后续发送）。
      // messages 保持 turn 前状态（磁盘 SSOT 未读回）；stopReason 记录
      // turn 本身的停止原因。
      setSessions((prev) => {
        const current = prev[targetId];
        if (!current) return prev;
        return {
          ...prev,
          [targetId]: turnFinished(current, {
            conversationId: current.conversationId ?? targetId,
            messages: current.messages,
            turnCount: current.turnCount,
            updatedAt: current.updatedAt,
            jsonMode: current.jsonMode,
            stopReason:
              (stopReason as TuiSessionState["lastStopReason"]) ?? "completed",
          }),
        };
      });
      setNotice({ lines: [`刷新会话失败：${describeError(err)}`] });
      // 任务 A：刷新失败也重置滚动（与成功路径保持一致 — turn 已结束）
      setChatScroll(0);
    }
  }

  function newSession(): void {
    const draft = createDraftSession();
    setSessions((prev) => ({ ...prev, [DRAFT_SESSION_ID]: draft }));
    setActiveKey(DRAFT_SESSION_ID);
    setView("chat");
    setNotice(undefined);
    setChatScroll(0);
  }

  async function openSessionAt(index: number): Promise<void> {
    if (index === 0) {
      newSession();
      return;
    }
    const entries = await safeList();
    const entry = entries[index - 1];
    if (!entry) return;
    const id = entry.conversation_id;
    const existing = sessions[id];
    if (!existing) {
      try {
        const file = await bridge.loadSessionFile(id);
        setSessions((prev) => ({ ...prev, [id]: attachSession(file) }));
      } catch (err) {
        setNotice({ lines: [`打开会话失败：${describeError(err)}`] });
        return;
      }
    }
    setSessions((prev) => {
      const next = { ...prev };
      const leaving = next[activeKey];
      if (leaving) next[activeKey] = switchedAwayFrom(leaving);
      const entering = next[id];
      if (entering) next[id] = switchedTo(entering);
      return next;
    });
    // #189 Commit 1：切会话前先重置行级滚动偏移（否则旧会话的 scroll 会
    // 残留，新会话内容落在视口上方被窗口截掉）。先 set 让其与 setActiveKey
    // 同批 React render。
    setChatScroll(0);
    setActiveKey(id);
    setView("chat");
    setNotice(undefined);
  }

  async function safeList(): Promise<ReadonlyArray<TuiListEntry>> {
    try {
      const raw = await bridge.listSessions();
      const entries = raw.map((e) => ({
        ...e,
        runningBg: sessions[e.conversation_id]?.runState === "running-bg",
      }));
      setListEntries(entries);
      return entries;
    } catch (err) {
      setNotice({ lines: [`读取会话列表失败：${describeError(err)}`] });
      return [];
    }
  }

  async function quit(): Promise<void> {
    const hasBg = Object.values(sessions).some(
      (s) => s.runState === "running-bg"
    );
    if (hasBg && !pendingQuit) {
      setPendingQuit(true);
      setNotice({
        lines: ["存在后台运行中的会话；再次 /quit 确认退出（将等待落盘）。"],
      });
      return;
    }
    // 等待全部 in-flight turn 落盘（退出不打断后台 turn，Q1a）。
    await Promise.allSettled([...inflightPromises.current]);
    exit();
  }

  async function handleSubmit(raw: string): Promise<void> {
    setInputValue("");
    const text = raw.trim();
    if (text.length === 0) return;
    // askUser 待决：y/n 优先于普通输入（权限确认高于对话）。
    if (askPending) {
      const lower = text.toLowerCase();
      if (lower === "y" || lower === "yes") {
        askBridge.resolveAsk(askPending.id, true);
        return;
      }
      if (lower === "n" || lower === "no") {
        askBridge.resolveAsk(askPending.id, false);
        return;
      }
    }
    const parsed = parseTuiInput(text);
    if (parsed.kind === "message") {
      setNotice(undefined);
      await sendTurn(parsed.text);
      return;
    }
    if (parsed.kind === "unknown") {
      setNotice({
        lines: [`未知命令：${parsed.raw}（/help 查看词表）`],
      });
      return;
    }
    switch (parsed.command) {
      case "sessions": {
        await safeList();
        setView("list");
        return;
      }
      case "new":
        newSession();
        return;
      case "quit":
      case "exit":
        await quit();
        return;
      case "help":
        setNotice({ lines: helpLines() });
        return;
      case "info": {
        setNotice({ lines: infoLines(active, activeKey) });
        return;
      }
      case "thinking": {
        // T6 (D5):切换 thinking 折叠面板展开态;running 态下也允许(不改
        // streaming 行为,只影响终稿渲染)。
        const next = !thinkingExpanded;
        setThinkingExpanded(next);
        setNotice({
          lines: [
            next
              ? "思考已展开（显示思考全文 + 加密占位）"
              : "思考已折叠（仅显示摘要行）/thinking 切换",
          ],
        });
        return;
      }
      case "profile": {
        // #196 首启完成钩子:用户已在外侧填好 ~/.iknow/user.md,执行
        // /profile done 翻 bootstrap_seeded。TUI 槽位是 async,直接 await
        // writeIknowState;写失败走 typed IknowIdentityError → notice。
        if (
          text
            .replace(/^\s*\/profile\s*/i, "")
            .trim()
            .toLowerCase() !== "done"
        ) {
          setNotice({
            lines: [
              "Usage: /profile done（已在外侧填好 ~/.iknow/user.md 后执行）",
            ],
          });
          return;
        }
        try {
          await writeIknowState({ bootstrap_seeded: true });
          setNotice({ lines: ["首启引导已完成，下次会话直接进入工作。"] });
        } catch (err) {
          setNotice({
            lines: [
              `首启完成标记失败：${err instanceof Error ? err.message : String(err)}`,
            ],
          });
        }
        return;
      }
    }
  }

  // 全局键盘：Ctrl+C 打断前台 turn（Q1a：running-bg 不受影响）；
  // PgUp/PgDn/Home/End 调整聊天区域**行级**滚动偏移（任务 A 行级重构）。
  // 步长 = viewportRows / 2（向下取整，最小 1）。ChatView 内部按
  // totalRows 兜底 clamp。仅在 chat 视图下生效（list 视图由 ListView 独占）。
  useInput((input, key) => {
    // 鼠标 SGR 序列守卫（保留，防御性）：app 已不做鼠标捕获，但若终端
    // 仍以 SGR 编码上报鼠标事件（ink useInput 前 slice(1) 剥 ESC，input
    // 是 "[<数字;数字;数字M/m" 形态），用 isSgrMouseSequence 丢弃，避免
    // 污染后续 Ctrl+C 等守卫与输入链。
    if (isSgrMouseSequence(input)) return;
    if (key.ctrl && input === "c") {
      if (canInterrupt(active)) {
        aborters.current.get(active.conversationId ?? "")?.abort();
      } else {
        setNotice({ lines: ["Ctrl+C：无前台运行中的 turn；/quit 退出。"] });
      }
      return;
    }
    if (view !== "chat") return;
    if (active.messages.length === 0) return;
    const step = Math.max(1, Math.floor(viewportRows / 2));
    if (key.pageUp) {
      setChatScroll((s) => s + step);
    } else if (key.pageDown) {
      setChatScroll((s) => Math.max(0, s - step));
    } else if (key.home) {
      // 顶：scroll 跳到一个大数，由 ChatView 兜底 clamp 到 totalRows
      setChatScroll(Number.MAX_SAFE_INTEGER);
    } else if (key.end) {
      // 底：auto-follow 重置
      setChatScroll(0);
    }
  });

  const bannerLines =
    view === "chat" && active.messages.length === 0
      ? renderBanner(
          { version: VERSION, cwd: props.cwd, dataDir: props.dataDir },
          { cols, short: false }
        )
      : [];

  const bgSession = Object.values(sessions).find(
    (s) => s.runState === "running-bg"
  );

  return (
    <Box flexDirection="column">
      {bannerLines.length > 0 && (
        <Box flexDirection="column">
          {bannerLines.map((line, i) => (
            <Text key={i}>{line}</Text>
          ))}
          <Text color={pal.border}>{"─".repeat(cols)}</Text>
        </Box>
      )}
      {view === "list" ? (
        <ListView
          entries={listEntries}
          cols={cols}
          onOpen={(i) => void openSessionAt(i)}
          onBack={() => setView("chat")}
        />
      ) : (
        <ChatView
          session={active}
          cols={cols}
          draftsMasked={draftsMasked}
          thinkingDraftMasked={thinkingDraftMasked}
          liveToolLines={
            active.conversationId
              ? (liveToolLines[active.conversationId] ?? [])
              : []
          }
          liveToolRuns={
            active.conversationId
              ? (liveToolRuns[active.conversationId] ?? [])
              : []
          }
          askLine={
            askPending
              ? `[ask] 允许 ${askPending.tool}？${
                  askPending.summaryHint ? ` ${askPending.summaryHint}` : ""
                } 输入 y/n`
              : undefined
          }
          scrollRows={chatScroll}
          viewportRows={viewportRows}
          thinkingExpanded={thinkingExpanded}
        />
      )}
      {notice && (
        <Box flexDirection="column" marginBottom={1}>
          {notice.lines.map((line, i) => (
            <Text key={i} color={pal.dim}>
              {line}
            </Text>
          ))}
        </Box>
      )}
      {/* 输入框仅聊天视图挂载：列表视图纯导航（Q4b），避免两个 useInput
          同时监听 stdin 产生键位竞争。 */}
      {view === "chat" && (
        <PromptInput
          value={inputValue}
          placeholder={askPending ? "y/n 确认工具授权" : "输入消息或 /help"}
          active={active.runState === "running-fg"}
          onChange={setInputValue}
          onSubmit={(v) => void handleSubmit(v)}
          onSelectHint={(cmd) => void handleSubmit(`/${cmd}`)}
          // 任务 B：Tab 仍走唯一匹配补全（slashComplete，行为不变以保留
          // 旧 e2e「Tab 多匹配不动作」语义）；候选选中用 Enter + onSelectHint
          // 触发。PromptInput 内部维护 cursor，路由 onSelectHint 而非
          // onSubmit(value)，避免 raw 文本解析绕开 cursor 选中。
          onTabComplete={(value) => slashComplete(value)}
          hintSuggestions={inputHintSuggestions}
        />
      )}
      <StatusBar
        cols={cols}
        active={active}
        bgSession={bgSession}
        sessionCount={Object.keys(sessions).length}
      />
    </Box>
  );
}

function StatusBar(props: {
  readonly cols: number;
  readonly active: TuiSessionState;
  readonly bgSession: TuiSessionState | undefined;
  readonly sessionCount: number;
}): ReactElement {
  const pal = tuiPalette;
  const state =
    props.active.runState === "idle"
      ? "空闲"
      : props.active.runState === "running-fg"
        ? "运行中"
        : "后台";
  const summary = sessionSummary(props.active.messages);
  return (
    <Box flexWrap="wrap">
      <Box marginRight={2}>
        <Text color={pal.dim}>
          {state} · {summary ? clipOneLine(summary, 24) : "新会话"}
        </Text>
      </Box>
      {props.bgSession && (
        <Box marginRight={2}>
          <Text color={pal.dim}>
            后台运行中 ·{" "}
            {clipOneLine(sessionSummary(props.bgSession.messages), 24)}
          </Text>
        </Box>
      )}
      <Box marginRight={2}>
        <Text color={pal.dim}>会话 {props.sessionCount}</Text>
      </Box>
      <Box>
        <Text color={pal.dim}>
          v{VERSION} · {props.active.conversationId ?? "draft"}
        </Text>
      </Box>
    </Box>
  );
}

function infoLines(
  session: TuiSessionState,
  key: string
): ReadonlyArray<string> {
  return [
    `conversation_id: ${session.conversationId ?? key}（${
      session.conversationId ? "已建档" : "draft，首条消息后建档"
    }）`,
    `turnCount: ${session.turnCount}`,
    `updatedAt: ${session.updatedAt ? relativeTime(session.updatedAt) : "—"}`,
    `jsonMode: ${session.jsonMode}`,
    `runState: ${session.runState}`,
  ];
}

function describeError(err: unknown): string {
  if (typeof err === "object" && err !== null && "kind" in err) {
    const kind = String((err as { kind: unknown }).kind);
    return `会话存储错误 [${kind}]`;
  }
  return err instanceof Error ? err.message : String(err);
}
