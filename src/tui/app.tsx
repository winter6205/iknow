/** @jsxImportSource @opentui/react */
/**
 * src/tui/app.tsx
 *
 * #343 T6-C：TUI 根组件端到端接线（OpenTUI 版）。在 T5 selection/copy
 * 接线基础上叠加状态机 / slash 路由 / hub-bridge 流式 / 权限 modal /
 * 退出语义。语义与 archive/tui-ink/src/app.tsx 一致（#146 交互契约
 * 全保留），只换渲染后端 + 键事件模型（ink useInput → OpenTUI useKeyboard
 * KeyEvent.name 投影）。
 *
 * 状态机纪律（specs/146-tui.md Q1/Q1a）：
 *  - 会话三态 idle / running-fg / running-bg，由 session-state.ts 纯
 *    函数驱动；turn 切走 → running-bg，Ctrl+C 仅打断 running-fg。
 *  - 视图二态 chat / list。
 *  - 消息 ReadonlyArray + Object.freeze 整体替换。
 *
 * 流式并发（spec SC8）：`useDeferredValue` 在 ChatView 内；app 层
 * `startTransition` 包裹 draft subscribe 回调 — 双向防御。
 *
 * 退出语义（spec OQ3）：存在 running-bg 会话时 /quit 需二次确认；
 * 确认后等全部 in-flight turn 落盘再 destroy 渲染器（不打断后台 turn）。
 *
 * 不产（spec SC3 删除清单正交）：
 *  - 行级滚动 / 行窗口数学（OpenTUI `<scrollbox stickyScroll>` 接管）；
 *  - markdown-lines / message-rows / row-window / chat-flow / selection
 *    / mouse / text 模块（OpenTUI 内置 selection + 渲染器坐标）。
 */
import {
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import { decodePasteBytes, MouseButton } from "@opentui/core";
import type { MouseEvent } from "@opentui/core";
import {
  useKeyboard,
  usePaste,
  useRenderer,
  useTerminalDimensions,
} from "@opentui/react";
import type { HarnessStreamEvent } from "../harness/stream.js";
import type {
  AnthropicNativeMessage,
  TokenUsage,
} from "../harness/model-adapter/types.js";
import type { TuiToolEvent } from "./deps.js";
import { isDoubleEsc, type TuiBridge } from "./hub-bridge.js";
import type { TuiAskUserBridge, TuiPendingAsk } from "./ask-user.js";
import type { SessionGrants } from "../harness/permission/session-grants.js";
import type { PermissionModeContext } from "../harness/permission/modes.js";
import {
  modalKeyEventOf,
  ModalHost,
  PERMISSION_ANSWERS,
  permissionModalRows,
  reduceModalKey,
  wrapModalLines,
  type PermissionAnswer,
} from "./modal.js";
import {
  DRAFT_SESSION_ID,
  attachSession,
  canInterrupt,
  createDraftSession,
  sessionCompacted,
  sessionRewound,
  switchedAwayFrom,
  switchedTo,
  turnFinished,
  turnStarted,
  userMessageEchoed,
  type TuiSessionState,
  type TuiView,
} from "./session-state.js";
import {
  buildRewindTargets,
  reduceRewindKey,
  rewindModalRows,
  rewindPickerContent,
  type RewindTarget,
} from "./rewind-picker.js";
import {
  helpLines,
  parseTuiInput,
  slashComplete,
  slashCompleteFromList,
  slashSuggestions,
  type TuiSlashCommand,
} from "./slash.js";
import { activeToolNameOf, liveToolReduce } from "./live-tool-state.js";
import type { LiveToolRun } from "./live-tool-state.js";
import { ChatView } from "./chat-view.js";
import type { StreamDraft } from "../cli/stream-draft.js";
import { createStreamDraft } from "../cli/stream-draft.js";
import { ListView, relativeTime, type TuiListEntry } from "./list-view.js";
import { ContextBar } from "./context-bar.js";
import { PromptInput } from "./prompt-input.js";
import { renderBannerLines, VERSION } from "./banner.js";
import { copyToClipboard, type CopyResult } from "./clipboard.js";
import { summarizeToolCall } from "./tool-summary.js";
import { tuiPalette } from "./theme.js";
import {
  applyShiftTabModeFlip,
  createPermissionModeContext,
  modeLabel,
} from "../harness/permission/index.js";
import { extractSummary } from "../session-api/store/schema.js";

/**
 * notice 文本按视觉宽度折行后行数（行账 SSOT，纯函数可单测）。
 *
 * OpenTUI 版没有 archive 自带的 `wrapTextVisual` — 用 modal.tsx 已就位的
 * `wrapModalLines`（wrap-ansi + {trim:false, hard:true}）复用。空数组/不含
 * 元素 → 0 行。
 */
export function noticeRenderRows(
  lines: ReadonlyArray<string> | undefined,
  cols: number
): number {
  if (lines === undefined || lines.length === 0) return 0;
  // notice 渲染盒内文宽 = cols - 2（容器边距各 1），与 ListView 实测对齐。
  const inner = Math.max(0, cols - 2);
  let rows = 0;
  for (const line of lines) {
    if (line.length === 0) {
      rows += 1;
      continue;
    }
    rows += wrapModalLines(line, inner).length;
  }
  return rows;
}

/**
 * 底部 chrome 行账（SSOT，可单测）。逐项入账，新增底部行必须同步本函数：
 *
 *   - ChatView marginTop headroom（顶部留白 1 行）
 *   - 权限 mode 指示行 1 行
 *   - 输入框圆角线框 3 行（顶框线 + 内容行 + 底框线）
 *   - ContextBar 用量条 1 行
 *   - ask 槽 1 行（ChatView tail 恒预留）
 *   - slash 候选行（inputValue.trim().startsWith("/") ? … : 0）
 *   - notice 本体 + 自身 marginBottom=1
 *   - modal 本体 + 自身 marginBottom=1
 *   - 后台运行标记行（存在 running-bg 时）
 */
export function chromeReserveRows(opts: {
  readonly noticeRows: number;
  readonly inputHintRows: number;
  readonly bgLine: boolean;
  readonly modalRows?: number;
}): number {
  const modalRows = opts.modalRows ?? 0;
  const noticeTotal = opts.noticeRows > 0 ? opts.noticeRows + 1 : 0;
  const modalTotal = modalRows > 0 ? modalRows + 1 : 0;
  return (
    1 + // top headroom
    1 + // mode指示行
    3 + // 输入框圆角线框
    opts.inputHintRows +
    1 + // ContextBar
    1 + // ask 槽
    noticeTotal +
    modalTotal +
    (opts.bgLine ? 1 : 0)
  );
}

/** #146 TUI 工具事件 sink（从 archive 迁入）：postToolUse 投影订阅。 */
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

/** W2 扩展：TuiAppProps.permissionMode 缺省 fallback（测试兼容；
 *  product 路径由 run.tsx 显式传）。模块私有，避免跨 mount 共享可变单例。 */
const defaultPermissionModeContext: PermissionModeContext =
  createPermissionModeContext("default");

export interface TuiAppProps {
  readonly bridge: TuiBridge;
  readonly askBridge: TuiAskUserBridge;
  readonly toolEventSink: TuiToolEventSink;
  /** `iknow tui <session-id>` resume 入口传入的已建档会话；缺省 = draft。 */
  readonly initialSession?: TuiSessionState;
  readonly cwd: string;
  readonly dataDir: string;
  readonly permissionMode?: PermissionModeContext;
  /** #279 项3：权限 modal「总是允许」落点 — session 层授权登记表。 */
  readonly sessionGrants?: SessionGrants;
  /** 测试注入口：可选初始视图（缺省 chat）。 */
  readonly initialView?: TuiView;
  /** 测试 / mock 注入口：触发 renderer.destroy 的回调；缺省 = no-op。 */
  readonly onQuit?: () => void;
}

interface Notice {
  readonly lines: ReadonlyArray<string>;
}

export function TuiApp(props: TuiAppProps): ReactNode {
  const pal = tuiPalette;
  const permissionMode = props.permissionMode ?? defaultPermissionModeContext;
  const renderer = useRenderer();
  const { width, height } = useTerminalDimensions();
  const cols = Math.max(width ?? 80, 40);
  const rows = Math.max(height ?? 24, 10);

  // ── 状态机核心 ─────────────────────────────────────────────────
  const initial = props.initialSession ?? createDraftSession();
  const initialKey = initial.conversationId ?? DRAFT_SESSION_ID;
  const [sessions, setSessions] = useState<Record<string, TuiSessionState>>(
    () => ({ [initialKey]: initial })
  );
  const [activeKey, setActiveKey] = useState(initialKey);
  const [view, setView] = useState<TuiView>(props.initialView ?? "chat");
  const [inputValue, setInputValue] = useState("");
  // #279 项5：命令历史（内存态，会话内有效不落盘）；prompt-input 不持有。
  const [inputHistory, setInputHistory] = useState<ReadonlyArray<string>>([]);
  const [notice, setNotice] = useState<Notice | undefined>(undefined);
  const [liveToolLines, setLiveToolLines] = useState<
    Record<string, ReadonlyArray<string>>
  >({});
  // T4 (#175): 结构化工具调用实时状态。
  const [liveToolRuns, setLiveToolRuns] = useState<
    Record<string, ReadonlyArray<LiveToolRun>>
  >({});
  // T6 (D5): thinking 折叠面板展开态；/thinking 切换，Ctrl+O 只展开。
  const [thinkingExpanded, setThinkingExpanded] = useState(false);
  // W2 扩展：权限模式镜像（仅驱动模式指示行 re-render）。
  const [permMode, setPermMode] = useState(() => permissionMode.get());
  // #279 项3：权限 modal 槽状态（dismissed = Esc 收起后退回输入框 y/n 兜底）。
  const [askModalDismissed, setAskModalDismissed] = useState(false);
  const [permissionIndex, setPermissionIndex] = useState(0);
  const [pendingQuit, setPendingQuit] = useState(false);
  // T6 (checkpoint-rewind)：L3 回退 picker 状态（/rewind 与双 Esc 共用）。
  // 激活态直接持有会话文件投影后的锚点目标（选择时一次性 load，减少闭包
  // 与异步竞态）；selectedIndex / confirming 由宿主持有（纯渲染无内部状态，
  // 与权限 modal 同纪律）。active 会话切走即关闭（newSession / openSessionAt
  // 清态），避免 picker 悬在错误会话上。
  const [rewindTargets, setRewindTargets] = useState<
    ReadonlyArray<RewindTarget> | undefined
  >(undefined);
  const [rewindIndex, setRewindIndex] = useState(0);
  const [rewindConfirming, setRewindConfirming] = useState(false);
  const lastEscAtRef = useRef<number | undefined>(undefined);

  // ── 流式草稿（单会话 in-flight 时挂，bg 由落盘刷新获得终稿）─────
  const [streamDraft, setStreamDraft] = useState<StreamDraft | null>(null);
  const [draftsMasked, setDraftsMasked] = useState<string>("");
  const [thinkingDraftMasked, setThinkingDraftMasked] = useState<string>("");
  useEffect(() => {
    if (streamDraft === null) {
      setDraftsMasked("");
      setThinkingDraftMasked("");
      return undefined;
    }
    const unsubscribe = streamDraft.subscribe(() => {
      // SC8 双向防御：流式 high-frequency 更新标记为低优先级 transition。
      startTransition(() => {
        setDraftsMasked(streamDraft.masked());
        setThinkingDraftMasked(streamDraft.thinkingMasked());
      });
    });
    setDraftsMasked(streamDraft.masked());
    setThinkingDraftMasked(streamDraft.thinkingMasked());
    return unsubscribe;
  }, [streamDraft]);

  // ── 退出 / 打断 / inflight 簿记 ────────────────────────────────
  const aborters = useRef(new Map<string, AbortController>());
  const inflightPromises = useRef(new Set<Promise<unknown>>());
  const viewRef = useRef<TuiView>(view);
  viewRef.current = view;

  // ── askPending 订阅（权限 modal 挂/摘） ────────────────────────
  const [askPending, setAskPending] = useState<TuiPendingAsk | undefined>(
    props.askBridge.pending()
  );
  useEffect(() => {
    setAskPending(props.askBridge.pending());
    return props.askBridge.subscribe(() =>
      setAskPending(props.askBridge.pending())
    );
  }, [props.askBridge]);

  // ── session-state 镜像 ref（鼠标 / 流式 stale 闭包读取） ────────
  const dataDirRef = useRef(props.dataDir);
  useEffect(() => {
    dataDirRef.current = props.dataDir;
  }, [props.dataDir]);
  // 复制通道：T5 优先 OSC52，失败退回原生 fallback 链。
  const doCopy = useCallback(
    async (text: string): Promise<CopyResult> => {
      if (text.length === 0) return { kind: "empty" };
      let oscOk = false;
      try {
        oscOk = renderer.copyToClipboardOSC52(text);
      } catch {
        oscOk = false;
      }
      if (oscOk) return { kind: "ok", method: "pbcopy" };
      return copyToClipboard(text, { dataDir: dataDirRef.current });
    },
    [renderer]
  );

  /** 根据复制结果设置 notice（右键复制复用）。 */
  function setNoticeFromCopyResult(text: string, result: CopyResult): void {
    if (result.kind === "ok") {
      setNotice({ lines: [`已复制（${result.method}，${text.length} 字）。`] });
    } else if (result.kind === "fallback") {
      setNotice({
        lines: [
          `剪贴板命令不可用，文本已写入 ${result.path}（${result.bytes} bytes）。`,
        ],
      });
    } else if (result.kind === "error") {
      setNotice({ lines: [`复制失败：${result.message}`] });
    }
  }

  /** 右键 down 时保留当前选区，避免 OpenTUI 在 down 阶段清掉选区。 */
  const handleMouseDown = useCallback((e: MouseEvent) => {
    if (e.button === MouseButton.RIGHT) {
      e.preventDefault();
    }
  }, []);

  /** 右键 up 时复制当前选区并清掉高亮。 */
  const handleMouseUp = useCallback(
    (e: MouseEvent) => {
      if (e.button !== MouseButton.RIGHT) return;
      const sel = renderer.getSelection();
      if (sel === null) {
        setNotice({ lines: ["无选区：先按住鼠标左键拖选文本。"] });
        return;
      }
      const text = sel.getSelectedText() ?? "";
      if (text.length === 0) {
        setNotice({ lines: ["选中区域为空。"] });
      } else {
        void doCopy(text).then((result) =>
          setNoticeFromCopyResult(text, result)
        );
      }
      renderer.clearSelection();
    },
    [renderer, doCopy]
  );

  usePaste((event) => {
    const text = decodePasteBytes(event.bytes) ?? "";
    if (text.length > 0) {
      setInputValue((prev) => prev + text);
    }
  });

  // ── 工具事件订阅（T4 结构化 + legacy 字符串行回退） ─────────────
  useEffect(
    () =>
      props.toolEventSink.subscribe((event) => {
        if (event.toolUseId !== undefined) {
          const { detail } = summarizeToolCall(
            event.toolName,
            event.input,
            cols
          );
          const toolUseId = event.toolUseId;
          setLiveToolRuns((prev) => ({
            ...prev,
            [event.conversationId]: liveToolReduce(
              prev[event.conversationId] ?? [],
              {
                kind: "post_tool_use",
                id: toolUseId,
                name: event.toolName,
                input: event.input,
                ok: event.kind === "ok",
                detail,
                message: event.message,
                oldContent: event.payload?.oldContent,
                newContent: event.payload?.newContent,
              }
            ),
          }));
          return;
        }
        setLiveToolLines((prev) => ({
          ...prev,
          [event.conversationId]: [
            ...(prev[event.conversationId] ?? []),
            summarizeToolCall(event.toolName, event.input, cols).detail +
              ` [${event.kind}]`,
          ],
        }));
      }),
    [props.toolEventSink, cols]
  );

  // ── 派生：active 会话 + 输入候选 + permissionIndex/active ──────
  const active = sessions[activeKey] ?? initial;
  const inputHintSuggestions = useMemo<ReadonlyArray<TuiSlashCommand>>(() => {
    if (!inputValue.trim().startsWith("/")) return [];
    return slashSuggestions(inputValue);
  }, [inputValue]);
  // 新 ask id 到来 → render-body 复位 modal 状态。
  const askId = askPending?.id;
  const lastAskIdRef = useRef<string | undefined>(undefined);
  if (askId !== lastAskIdRef.current) {
    lastAskIdRef.current = askId;
    if (askId !== undefined) {
      setAskModalDismissed(false);
      setPermissionIndex(0);
    }
  }
  const askModalActive =
    view === "chat" && askPending !== undefined && !askModalDismissed;
  const activeToolName = active.conversationId
    ? activeToolNameOf(liveToolRuns[active.conversationId] ?? [])
    : undefined;

  // ── 权限 modal 应答落点 ──────────────────────────────────────────
  function resolvePermissionAsk(
    pending: TuiPendingAsk,
    answer: PermissionAnswer
  ): void {
    const settled = props.askBridge.resolveAsk(pending.id, answer !== "reject");
    if (!settled) return;
    if (answer === "always") {
      const tool = pending.tool;
      props.sessionGrants?.add({
        id: `tui-always-${tool}`,
        match: ({ tool: t }) => t === tool,
        decision: "allow",
        reason: `TUI 用户在权限确认 modal 选择「总是允许」（${tool}）`,
      });
      setNotice({
        lines: [
          props.sessionGrants !== undefined
            ? `已允许 ${tool}（本会话总是允许）`
            : `已允许 ${tool}`,
        ],
      });
      return;
    }
    if (answer === "reject") {
      setNotice({ lines: [`已拒绝 ${pending.tool}`] });
    }
  }

  // ── 视图 chrome（banner 随消息共享 scroll space） ──────────────
  // spec #321 方案 B：banner 作为 scrollbox 第一段内容，与消息共享滚动
  // 空间（用户上滚能翻回 banner）。眼字形两色分段信息在纯文本里丢失
  // （统一单色 logoInk；可接受降级，见 banner.ts renderBannerLines 头注）。
  const bannerLines = useMemo<ReadonlyArray<string>>(
    () =>
      renderBannerLines(
        { version: VERSION, cwd: props.cwd, dataDir: props.dataDir },
        cols
      ),
    [cols, props.cwd, props.dataDir]
  );

  // ── /sessions 列表加载 ───────────────────────────────────────────
  const [listEntries, setListEntries] = useState<ReadonlyArray<TuiListEntry>>(
    []
  );
  async function safeList(): Promise<ReadonlyArray<TuiListEntry>> {
    try {
      const raw = await props.bridge.listSessions();
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

  // ── 会话切换 / 新建 ────────────────────────────────────────────
  function newSession(): void {
    const draft = createDraftSession();
    setSessions((prev) => ({ ...prev, [DRAFT_SESSION_ID]: draft }));
    setActiveKey(DRAFT_SESSION_ID);
    setView("chat");
    setNotice(undefined);
    setRewindTargets(undefined);
    setRewindConfirming(false);
    setRewindIndex(0);
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
        const file = await props.bridge.loadSessionFile(id);
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
    setRewindTargets(undefined);
    setRewindConfirming(false);
    setRewindIndex(0);
  }

  // ── turn 发送 ───────────────────────────────────────────────────
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
      conversationId = await props.bridge.ensureSession(conversationId);
    } catch (err) {
      setNotice({ lines: [`建档失败：${describeError(err)}`] });
      return;
    }
    if (startedKey === DRAFT_SESSION_ID && conversationId !== undefined) {
      setSessions((prev) => {
        const draft = prev[DRAFT_SESSION_ID];
        if (!draft) return prev;
        const next = {
          ...prev,
          [conversationId as string]: { ...draft, conversationId },
        };
        delete next[DRAFT_SESSION_ID];
        return next;
      });
      setActiveKey(conversationId);
    }
    const targetId = conversationId;
    if (targetId === undefined) return;
    setSessions((prev) => {
      const current = prev[targetId];
      if (!current) return prev;
      return {
        ...prev,
        [targetId]: userMessageEchoed(turnStarted(current), text),
      };
    });
    const controller = new AbortController();
    aborters.current.set(targetId, controller);
    const promise = runTurnOnce(targetId, text, controller);
    inflightPromises.current.add(promise);
    void promise.finally(() => inflightPromises.current.delete(promise));
  }

  async function runTurnOnce(
    targetId: string,
    text: string,
    controller: AbortController
  ): Promise<void> {
    let stopReason: string | undefined;
    let lastUsage: TokenUsage | null = null;
    const draft = createStreamDraft();
    setStreamDraft(draft);
    const onStream = (event: HarnessStreamEvent): void => {
      draft.append(event);
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
      if (event.type === "stop_summary") {
        setNotice({ lines: [event.text] });
      }
    };
    try {
      const resp = await props.bridge.postMessage({
        conversationId: targetId,
        text,
        signal: controller.signal,
        onStream,
      });
      stopReason = resp.stopReason;
      lastUsage = resp.lastUsage;
    } catch (err) {
      stopReason = "protocolError";
      setNotice({ lines: [`turn 失败：${describeError(err)}`] });
    } finally {
      aborters.current.delete(targetId);
      draft.reset();
      setStreamDraft(null);
    }
    try {
      const file = await props.bridge.loadSessionFile(targetId);
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
            lastUsage,
          }),
        };
      });
      setLiveToolLines((prev) => ({ ...prev, [targetId]: [] }));
      setLiveToolRuns((prev) => ({ ...prev, [targetId]: [] }));
      if (stopReason === "cancelled") {
        setNotice({ lines: ["已打断当前 turn（未落盘）。"] });
      }
    } catch (err) {
      // 刷新失败也要落回 idle，否则会话卡在 running-fg。
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
            lastUsage,
          }),
        };
      });
      setNotice({ lines: [`刷新会话失败：${describeError(err)}`] });
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
    await Promise.allSettled([...inflightPromises.current]);
    props.onQuit?.();
    if (!renderer.isDestroyed) renderer.destroy();
  }

  function toggleThinking(): void {
    setThinkingExpanded((prev) => !prev);
  }

  /** T6：打开 L3 回退锚点选择器（/rewind 与双 Esc 共用路径）。
   *  一次 load 会话文件 → 投影锚点 → 激活 picker。失败经 describeError 只透
   *  typed kind。调用方已保证 idle + 非 draft。 */
  async function openRewindPicker(targetId: string): Promise<void> {
    try {
      const file = await props.bridge.loadSessionFile(targetId);
      const targets = buildRewindTargets(file);
      if (targets.length === 0) {
        // L0 空态：无完成 turn / 空会话 → notice，零 store IO（load 已发生，
        // 但无任何截断落盘）。对标 baseline §2 "Nothing to rewind to yet."。
        setNotice({
          lines: ["Nothing to rewind to yet."],
        });
        return;
      }
      setRewindTargets(targets);
      setRewindIndex(0);
      setRewindConfirming(false);
    } catch (err) {
      setNotice({ lines: [`读取会话失败：${describeError(err)}`] });
    }
  }

  /** T6：确认后执行回退（盘上截断 + UI 状态反射）。
   *  anchorTextForInput = 回退锚点用户消息完整文本（不截断），回退后填回
   *   输入框 — 与 baseline §2 的「清空输入框」有意分歧，用户实测要求回退后
   *   能直接修改并重发（spec §Divergence 已记录）。
   *  userMessageTextForNotice = 截 80 展示用版，用于 notice「已回退到 ［消息］ 之前」。 */
  async function executeRewind(
    targetId: string,
    keepTurns: number,
    anchorTextForInput: string,
    userMessageTextForNotice: string
  ): Promise<void> {
    setRewindTargets(undefined);
    setRewindConfirming(false);
    try {
      await props.bridge.rewindSession(targetId, keepTurns);
      const fresh = await props.bridge.loadSessionFile(targetId);
      setSessions((prev) => {
        const current = prev[targetId];
        if (!current) return prev;
        return {
          ...prev,
          [targetId]: sessionRewound(current, {
            messages: fresh.messages,
            turnCount: fresh.turnCount,
            updatedAt: fresh.updatedAt,
            jsonMode: fresh.jsonMode,
          }),
        };
      });
      setNotice({
        lines: [
          `已回退到 ［${userMessageTextForNotice || "(无文本)"}］ 之前。`,
        ],
      });
      // 输入框填回锚点消息全文 —— 用户可修改并重发（与 Claude Code baseline §2
      // 「回退后清空输入框」的有意分歧，spec §Divergence 已记录）。
      setInputValue(anchorTextForInput);
    } catch (err) {
      setNotice({ lines: [`回退失败：${describeError(err)}`] });
    }
  }

  // ── submit 路由 ────────────────────────────────────────────────
  async function handleSubmit(raw: string): Promise<void> {
    setInputValue("");
    const text = raw.trim();
    if (text.length === 0) return;
    // askPending 时 y/n/a 直达（modal 已让键位 → 输入框兜底）。
    if (askPending) {
      const lower = text.toLowerCase();
      if (lower === "y" || lower === "yes") {
        resolvePermissionAsk(askPending, "once");
        return;
      }
      if (lower === "a" || lower === "always") {
        resolvePermissionAsk(askPending, "always");
        return;
      }
      if (lower === "n" || lower === "no") {
        resolvePermissionAsk(askPending, "reject");
        return;
      }
    }
    const parsed = parseTuiInput(text);
    if (parsed.kind === "message") {
      // 真实消息进历史（避免 y/n / slash / busy-guard 消息污染）。
      if (!askPending && active.runState === "idle" && parsed.text.length > 0) {
        setInputHistory((h) =>
          h[h.length - 1] === parsed.text ? h : [...h, parsed.text]
        );
      }
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
        setNotice({
          lines: infoLines(active, activeKey, props.bridge.contextWindow),
        });
        return;
      }
      case "thinking":
        toggleThinking();
        return;
      case "compact": {
        if (active.runState !== "idle") {
          setNotice({
            lines: ["当前会话正在运行；压缩等本轮结束后再执行。"],
          });
          return;
        }
        const targetId = active.conversationId;
        if (targetId === undefined) {
          setNotice({ lines: ["当前是空会话，还没有可压缩的上下文。"] });
          return;
        }
        try {
          const compacted = await props.bridge.compactSession(targetId);
          const file = await props.bridge.loadSessionFile(targetId);
          setSessions((prev) => {
            const current = prev[targetId];
            if (!current) return prev;
            return {
              ...prev,
              [targetId]: sessionCompacted(current, {
                messages: file.messages,
                turnCount: file.turnCount,
                updatedAt: file.updatedAt,
                jsonMode: file.jsonMode,
              }),
            };
          });
          setNotice({
            lines: compacted
              ? ["已压缩上下文（保留尾部，裁剪早期消息）。"]
              : ["上下文未达压缩阈值，无需压缩。"],
          });
        } catch (err) {
          setNotice({ lines: [`压缩失败：${describeError(err)}`] });
        }
        return;
      }
      case "rewind": {
        if (active.runState !== "idle") {
          setNotice({
            lines: ["当前会话正在运行；回退等本轮结束后再执行。"],
          });
          return;
        }
        const targetId = active.conversationId;
        if (targetId === undefined) {
          setNotice({ lines: ["当前是空会话，还没有可回退的点。"] });
          return;
        }
        await openRewindPicker(targetId);
        return;
      }
    }
  }

  // ── 全局键位（Ctrl+C / Shift+Tab / Ctrl+O / modal） ────
  useKeyboard((e) => {
    if (e.eventType !== "press") return;

    // Shift+Tab 切 permission mode（让 app 层处理 — spec W2 扩展）。
    if (
      applyShiftTabModeFlip({
        key: {
          name: e.name,
          shift: e.shift,
          ctrl: e.ctrl,
          meta: e.meta,
        },
        ctx: permissionMode,
        onFlip: (next) => {
          setPermMode(next);
        },
      })
    ) {
      return;
    }
    // Ctrl+C：打断 running-fg；否则提示。
    if (e.ctrl && e.name === "c") {
      if (canInterrupt(active)) {
        const id = active.conversationId;
        if (id !== undefined) {
          aborters.current.get(id)?.abort();
        }
      } else {
        setNotice({
          lines: ["Ctrl+C：无前台运行中的 turn；/quit 退出。"],
        });
      }
      return;
    }
    if (view !== "chat") return;
    // Ctrl+O：切换思考面板（展开/折叠）。toggleThinking 翻转 state —
    // /thinking 仍然可独立切换。
    if (e.ctrl && e.name === "o") {
      toggleThinking();
      return;
    }
    // T6 rewind picker 活跃时独占键位（Esc 走 cancel；↑/↓ 移动；Enter 在
    // 选择态进入确认行 / 确认态执行）。reducer 路由见 rewind-picker 纯函数。
    if (rewindTargets !== undefined) {
      const action = reduceRewindKey(modalKeyEventOf(e), {
        targets: rewindTargets,
        selectedIndex: rewindIndex,
        confirming: rewindConfirming,
      });
      switch (action.type) {
        case "move":
          setRewindIndex(action.index);
          break;
        case "confirm":
          setRewindConfirming(true);
          break;
        case "execute": {
          const targetId = active.conversationId;
          // 确认态 Enter 时 reducer 只产 execute 不产 move，此处索引安全。
          const t = rewindTargets[rewindIndex];
          if (targetId !== undefined) {
            void executeRewind(
              targetId,
              action.keepTurns,
              t?.fullText ?? "",
              t?.userMessageText ?? ""
            );
          }
          break;
        }
        case "cancel":
          setRewindTargets(undefined);
          setRewindIndex(0);
          setRewindConfirming(false);
          setNotice(undefined);
          break;
        case "ignore":
          break;
      }
      return;
    }
    // T6 双 Esc：running-fg 第一下 Esc 打断 in-flight turn（对标 baseline
    // §1：先打断，第二下 idle 才开 picker），等效 Ctrl+C 分支；idle 首次 Esc
    // 只记时间戳不动作；间隔 ≤ REWIND_DOUBLE_ESC_WINDOW_MS → 打开 L3 picker。
    // askModalActive 时下方块处理 Esc dismiss，re-path 不拦截（避免吞掉
    // dismiss）。
    if (e.name === "escape" && !askModalActive) {
      const nowMs = Date.now();
      const last = lastEscAtRef.current;
      if (canInterrupt(active)) {
        const id = active.conversationId;
        if (id !== undefined) {
          aborters.current.get(id)?.abort();
        }
        lastEscAtRef.current = nowMs;
        return;
      }
      if (last !== undefined && isDoubleEsc(last, nowMs)) {
        lastEscAtRef.current = undefined;
        const targetId = active.conversationId;
        if (targetId !== undefined) {
          void openRewindPicker(targetId);
        } else {
          setNotice({
            lines: ["当前是空会话，还没有可回退的点。"],
          });
        }
      } else {
        lastEscAtRef.current = nowMs;
      }
      return;
    }
    // modal 活跃时独占键位。
    if (askModalActive && askPending !== undefined) {
      const action = reduceModalKey(modalKeyEventOf(e), {
        options: PERMISSION_ANSWERS,
        selectedIndex: permissionIndex,
      });
      switch (action.type) {
        case "move":
          setPermissionIndex(action.index);
          break;
        case "select":
          resolvePermissionAsk(askPending, action.value as PermissionAnswer);
          break;
        case "dismiss":
          setAskModalDismissed(true);
          break;
        case "ignore":
          break;
      }
    }
  });

  // ── 渲染视图 ────────────────────────────────────────────────────
  // 视口高度（行级滚动废除；scrollbox 内置 stickyScroll；ChatView 内部
  // 自管布局高度）。banner 与消息同处 scrollbox — 不再单独扣减 banner。
  // chrome 逐项入账（chromeReserveRows SSOT）：输入框 3 行 + mode 指示 1 行
  // + ContextBar 1 行 + ask 槽 1 行 + headroom 1 行 + slash 候选行 + notice
  // 折行 + modal 折行 + bgLine。
  const hintRows = inputValue.trim().startsWith("/")
    ? slashSuggestions(inputValue).length
    : 0;
  const bgSession = Object.values(sessions).find(
    (s) => s.runState === "running-bg"
  );
  const bgLine = bgSession !== undefined;
  const modalAsk =
    view === "chat" && askModalDismissed === false ? askPending : undefined;
  const modalRowsForBudget =
    modalAsk !== undefined
      ? permissionModalRows(modalAsk, cols)
      : rewindTargets !== undefined
        ? rewindModalRows(rewindTargets, cols, rewindIndex, rewindConfirming)
        : 0;
  const viewportRows = Math.max(
    5,
    rows -
      chromeReserveRows({
        noticeRows: noticeRenderRows(notice?.lines, cols),
        inputHintRows: hintRows,
        bgLine,
        modalRows: modalRowsForBudget,
      })
  );
  // 列表视图（ListView 路径）：底部仅 notice 占用，与 headroom 2 行。
  const listViewRows = Math.max(
    5,
    rows - 2 - noticeRenderRows(notice?.lines, cols)
  );

  return (
    <box
      flexDirection="column"
      width="100%"
      height="100%"
      onMouseDown={handleMouseDown}
      onMouseUp={handleMouseUp}
    >
      {view === "list" ? (
        <ListView
          entries={listEntries}
          cols={cols}
          rows={listViewRows}
          onOpen={(i) => void openSessionAt(i)}
          onBack={() => setView("chat")}
        />
      ) : (
        <>
          <ChatView
            session={active}
            cols={cols}
            rows={viewportRows}
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
              askPending !== undefined && !askModalActive
                ? `[ask] 允许 ${askPending.tool}？${
                    askPending.summaryHint ? ` ${askPending.summaryHint}` : ""
                  } 输入 y/a/n（a=总是允许）`
                : undefined
            }
            thinkingExpanded={thinkingExpanded}
            bannerLines={bannerLines}
          />
        </>
      )}
      {notice !== undefined && (
        <box flexDirection="column" marginBottom={1}>
          {notice.lines.map((line, i) => (
            <text key={`notice-${i}`} fg={pal.dim}>
              {line}
            </text>
          ))}
        </box>
      )}
      {view === "chat" && (
        <ModalHost
          modal={
            rewindTargets !== undefined
              ? {
                  kind: "select",
                  ...rewindPickerContent(
                    rewindTargets,
                    rewindIndex,
                    rewindConfirming
                  ),
                  selectedIndex: rewindConfirming ? 0 : rewindIndex,
                }
              : askModalActive && askPending !== undefined
                ? {
                    kind: "permission",
                    tool: askPending.tool,
                    summaryHint: askPending.summaryHint,
                    selectedIndex: permissionIndex,
                  }
                : undefined
          }
          cols={cols}
        />
      )}
      {view === "chat" && (
        <box>
          <text fg={permMode === "full_auto" ? pal.running : pal.dim}>
            {cols < 40
              ? `[${permMode === "full_auto" ? "auto" : "def"}]`
              : `mode: ${modeLabel(permMode)}`}
          </text>
        </box>
      )}
      {view === "chat" && (
        <PromptInput
          value={inputValue}
          placeholder={
            rewindTargets !== undefined
              ? "回退选择器中（↑↓ 选择 · Enter 确认 · Esc 关闭）"
              : askPending
                ? askModalActive
                  ? "modal 键位接管中（Esc 退回输入）"
                  : "y/a/n 确认工具授权（a=总是允许）"
                : "输入消息或 /help"
          }
          active={active.runState === "running-fg"}
          disabled={askModalActive || rewindTargets !== undefined}
          onChange={setInputValue}
          onSubmit={(v) => void handleSubmit(v)}
          onSelectHint={(cmd) => void handleSubmit(`/${cmd}`)}
          onTabComplete={(value, cursor) => {
            // 多匹配（suggestions > 1）→ null 不动作；唯一匹配 → 补全串；
            // 当 cursor 越过 0 时按 selected hint 补全（任务 B 兼容）。
            if (inputHintSuggestions.length === 1 && cursor === 0) {
              return slashCompleteFromList(inputHintSuggestions, 0);
            }
            return slashComplete(value);
          }}
          hintSuggestions={inputHintSuggestions}
          history={inputHistory}
        />
      )}
      {view === "chat" && (
        <box flexDirection="row" justifyContent="flex-start">
          <ContextBar
            lastUsage={active.lastUsage}
            contextWindow={props.bridge.contextWindow}
            running={active.runState === "running-fg"}
            cols={cols}
            activeToolName={activeToolName}
          />
        </box>
      )}
      {bgSession !== undefined && (
        <box>
          <text fg={pal.dim}>{bgStatusLine(bgSession.messages)}</text>
        </box>
      )}
    </box>
  );
}

function infoLines(
  session: TuiSessionState,
  key: string,
  contextWindow: number
): ReadonlyArray<string> {
  const lu = session.lastUsage;
  const tokenLines =
    lu === null
      ? ["tokens: —"]
      : [
          `tokens in/out: ${lu.inputTokens}/${lu.outputTokens}`,
          `cache read: ${lu.cacheReadInputTokens}`,
          `window: ${contextWindow}`,
        ];
  return [
    `conversation_id: ${session.conversationId ?? key}（${
      session.conversationId ? "已建档" : "draft，首条消息后建档"
    }）`,
    `turnCount: ${session.turnCount}`,
    `updatedAt: ${session.updatedAt ? relativeTime(session.updatedAt) : "—"}`,
    `jsonMode: ${session.jsonMode}`,
    `runState: ${session.runState}`,
    ...tokenLines,
  ];
}

/** 后台会话状态行（spec #146 SC5：`后台运行中 · <summary>`）。
 *  纯函数可单测：summary 为空时回退「后台运行中」（不加尾缀）。 */
export function bgStatusLine(
  messages: ReadonlyArray<AnthropicNativeMessage>
): string {
  const summary = extractSummary(messages);
  return summary.length > 0 ? `后台运行中 · ${summary}` : "后台运行中";
}

function describeError(err: unknown): string {
  if (typeof err === "object" && err !== null && "kind" in err) {
    const kind = String((err as { kind: unknown }).kind);
    return `会话存储错误 [${kind}]`;
  }
  return err instanceof Error ? err.message : String(err);
}
