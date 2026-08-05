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
 */
import { useEffect, useMemo, useRef, useState } from "react";
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
import { formatLiveToolEvent } from "./tool-summary.js";
import type { TuiToolEvent } from "./deps.js";
import { ChatView } from "./chat-view.js";
import { ListView, relativeTime, type TuiListEntry } from "./list-view.js";
import { PromptInput, useTick } from "./components.js";
import { renderBanner } from "./banner.js";
import { tuiPalette } from "./theme.js";
import { clipOneLine } from "./text.js";
import { VERSION } from "./version.js";

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
  const { columns } = useWindowSize();
  const cols = Math.max(columns ?? 80, 40);

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
  const [pendingQuit, setPendingQuit] = useState(false);
  // 任务 A：聊天区域消息级滚动偏移（0 = 底/auto-follow，>0 = 向上滚）。
  // 新 turn 完成时重置为 0；PgUp/PgDn/Home/End 调整（与 PromptInput 的
  // ↑/↓ 不冲突，避键）。
  const [chatScroll, setChatScroll] = useState(0);

  const aborters = useRef(new Map<string, AbortController>());
  const inflightPromises = useRef(new Set<Promise<unknown>>());
  const [listEntries, setListEntries] = useState<ReadonlyArray<TuiListEntry>>(
    []
  );
  // 根 tick 仅轮询 askBridge.pending()（组件树外状态）：有 pending 时才
  // 挂载，idle 且无授权待决时不强制整树 10Hz 重渲染（spinner 自带 tick）。
  const askTick = askBridge.pending() !== undefined;
  useTick(askTick ? 100 : 0);

  // 工具事件订阅：按 conversationId 归并入 liveToolLines。
  useEffect(
    () =>
      toolEventSink.subscribe((event) => {
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
    setSessions((prev) =>
      prev[targetId]
        ? { ...prev, [targetId]: turnStarted(prev[targetId]!) }
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
    try {
      const resp = await bridge.postMessage({
        conversationId: targetId,
        text,
        signal: controller.signal,
      });
      stopReason = resp.stopReason;
    } catch (err) {
      stopReason = "protocolError";
      setNotice({ lines: [`turn 失败：${describeError(err)}`] });
    } finally {
      aborters.current.delete(targetId);
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
    }
  }

  // 全局键盘：Ctrl+C 打断前台 turn（Q1a：running-bg 不受影响）；
  // PgUp/PgDn/Home/End 调整聊天区域滚动偏移（任务 A，避开 PromptInput 的
  // ↑/↓ 防止键位竞争）。仅在 chat 视图下生效（list 视图由 ListView 独占）。
  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      if (canInterrupt(active)) {
        aborters.current.get(active.conversationId ?? "")?.abort();
      } else {
        setNotice({ lines: ["Ctrl+C：无前台运行中的 turn；/quit 退出。"] });
      }
      return;
    }
    if (view !== "chat") return;
    const total = active.messages.length;
    if (total === 0) return;
    if (key.pageUp) {
      // 单条消息级滚动：PgUp 向上滚 1 条
      setChatScroll((s) => Math.min(s + 1, total - 1));
    } else if (key.pageDown) {
      setChatScroll((s) => Math.max(0, s - 1));
    } else if (key.home) {
      // Home = 顶部（隐藏最新 total-1 条，保留最早 1 条）
      setChatScroll(Math.max(0, total - 1));
    } else if (key.end) {
      // End = 底部（auto-follow 重置）
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
          liveToolLines={
            active.conversationId
              ? (liveToolLines[active.conversationId] ?? [])
              : []
          }
          askLine={
            askPending
              ? `[ask] 允许 ${askPending.tool}？${
                  askPending.summaryHint ? ` ${askPending.summaryHint}` : ""
                } 输入 y/n`
              : undefined
          }
          scroll={chatScroll}
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
