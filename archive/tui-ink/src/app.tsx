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
 *  - 鼠标滚轮（DECSET 1000/1006 SGR）同样驱动 `chatScroll`，与 PgUp/PgDn 同一条
 *    滚动状态；auto-follow 在 turn 完成 / new 会话触发。
 */
import { startTransition, useEffect, useMemo, useRef, useState } from "react";
import type { HarnessStreamEvent } from "../harness/stream.js";
import type { TokenUsage } from "../harness/model-adapter/types.js";
import type { ReactElement } from "react";
import {
  Box,
  Text,
  useApp,
  useInput,
  useStdin,
  useStdout,
  useWindowSize,
} from "ink";
import type { TuiBridge } from "./hub-bridge.js";
import type { TuiAskUserBridge, TuiPendingAsk } from "./ask-user.js";
import type { SessionGrants } from "../harness/permission/session-grants.js";
import {
  ModalHost,
  PERMISSION_ANSWERS,
  permissionModalRows,
  reduceModalKey,
  type PermissionAnswer,
} from "./modal.js";
import {
  DRAFT_SESSION_ID,
  attachSession,
  canInterrupt,
  createDraftSession,
  sessionCompacted,
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
import {
  activeToolNameOf,
  liveToolReduce,
  type LiveToolRun,
} from "./live-tool-state.js";
import { ChatView, flatContentLines } from "./chat-view.js";
import type { StreamDraft } from "../cli/stream-draft.js";
import { createStreamDraft } from "../cli/stream-draft.js";
import { ListView, relativeTime, type TuiListEntry } from "./list-view.js";
import { ContextBar } from "./context-bar.js";
import { PromptInput, useTick } from "./components.js";
import { renderBanner } from "./banner.js";
import { wrapTextVisual } from "./text.js";
import { tuiPalette } from "./theme.js";
import { VERSION } from "./version.js";
import {
  createPermissionModeContext,
  modeLabel,
  applyShiftTabModeFlip,
  type PermissionModeContext,
} from "../harness/permission/index.js";
import { writeIknowState } from "../harness/identity/index.js";
import {
  enableSgrMouseReport,
  isSgrMouseSequence,
  parseMouseAllEvents,
  parseMouseEvents,
  disableMouseReport,
  wheelScrollStep,
} from "./mouse.js";
import { copyToClipboard, type CopyResult } from "./clipboard.js";
import type { Selection, ContentWindow } from "./selection.js";
import {
  extractSelectionText,
  isEmpty,
  normalize,
  terminalToCellPos,
} from "./selection.js";

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

/**
 * W2 扩展：TuiAppProps.permissionMode 缺省时的 fallback context。
 * 模块私有 — 仅本文件内 TuiApp fallback 用；product 路径（run.tsx →
 * TuiApp）必须显式创建并透传，使 Shift+Tab 翻它能被真实观察。tests/tui
 * 历史 mount 不传 prop 也走 fallback（行为等价 default）。
 *
 * 不导出：避免跨 mount 共享可变单例（一个 mount 的 Shift+Tab 翻到全
 * 局、影响另一 mount 的"看到"的 mode）。
 */
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
  /**
   * W2 扩展：TUI 持一个可变 PermissionModeContext —— Shift+Tab 在这里就地
   * 翻 mode(不动 ask 桥接 / 不重建 engine)。run.tsx 创建并透传。
   *
   * 可选：测试套件历史 mount 不传（保留旧断言）；缺省时内部 fallback
   * 到静态 default context，Shift+Tab 翻它无 observer 收益但零回归。
   * product 路径（run.tsx → TuiApp）必须显式传。
   */
  readonly permissionMode?: PermissionModeContext;
  /**
   * #279 项3：权限 modal「总是允许」的落点 —— 会话级授权登记表（session
   * 层规则最高优先，后续同工具调用不再触发 ask）。run.tsx 创建并同时注入
   * buildTuiDeps（policy session 源）与 TuiApp；测试 mount 可缺省（缺省时
   * 「总是允许」等价「本次允许」，零回归）。
   */
  readonly sessionGrants?: SessionGrants;
}

interface Notice {
  readonly lines: ReadonlyArray<string>;
}

/** notice 实际占用的终端行数（viewport 行账 SSOT，可单测）。
 *  ink 按视觉宽度折行：一行长文案在窄终端折成多行，只数 `lines.length`
 *  会低估 → viewport 预算漏 → 整帧高于终端上卷（#268 banner 截断同根因，
 *  2026-08-08 由长 notice 再次触发后收敛到这里）。 */
export function noticeRenderRows(
  lines: ReadonlyArray<string> | undefined,
  cols: number
): number {
  return lines?.reduce((n, l) => n + wrapTextVisual(l, cols).length, 0) ?? 0;
}

/** ChatView 之外的固定 chrome 行数（viewport 行账 SSOT，可单测）。
 *  2026-08-08 用户反馈「进消息后顶部 logo 又看不见」：旧预算只扣 4 行
 *  （输入 2 + ask 1 + headroom 1），实际 chrome 更高——输入框圆角线框是
 *  **3 行**（顶框 + 内容 + 底框），且 mode 指示行 / ContextBar 各 1 行未
 *  入账 → 帧高 > 终端行数 → 终端上卷把 banner 顶出屏幕（#268 同类回归）。
 *  收敛到这里：逐项入账，新增底部行必须同步本函数。 */
export function chromeReserveRows(opts: {
  /** notice 折行后行数（0 = 无 notice）。 */
  readonly noticeRows: number;
  /** 输入框下方 slash 候选行数（0 = 无候选）。 */
  readonly inputHintRows: number;
  /** 后台运行中标记行是否显示。 */
  readonly bgLine: boolean;
  /** #279 项3：活动 modal 盒子行数（selectModalRows 折行预测；0/缺省 = 无 modal）。 */
  readonly modalRows?: number;
}): number {
  const modalRows = opts.modalRows ?? 0;
  return (
    1 + // ChatView marginTop headroom（顶部留白 1 行）
    1 + // 权限 mode 指示行
    3 + // 输入框圆角线框：顶框线 + 内容行 + 底框线
    opts.inputHintRows +
    1 + // ContextBar 用量条
    1 + // ask 槽（ChatView tail，恒预留）
    // notice 本体 + 自身 marginBottom=1（notice 非末位子，margin 不折叠）
    (opts.noticeRows > 0 ? opts.noticeRows + 1 : 0) +
    // #279 项3：modal 本体 + 自身 marginBottom=1（盒子非末位，margin 不折叠）
    (modalRows > 0 ? modalRows + 1 : 0) +
    (opts.bgLine ? 1 : 0)
  );
}

export function TuiApp(props: TuiAppProps): ReactElement {
  const { bridge, askBridge, toolEventSink } = props;
  // W2 扩展：permissionMode 缺省 → 内部 default context（测试兼容；
  // product 路径由 run.tsx 显式创建并透传）。
  const permissionMode = props.permissionMode ?? defaultPermissionModeContext;
  const pal = tuiPalette;
  const { exit } = useApp();
  const { stdout } = useStdout();
  const { stdin } = useStdin();
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
  // #279 项5：输入历史（内存态，会话内有效不落盘）。提交追加在 onSubmit
  // 包装里做（连续重复去重）；PromptInput 仅在 hint 不可见时用 ↑/↓ 召回。
  const [inputHistory, setInputHistory] = useState<ReadonlyArray<string>>([]);
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
  // W2 扩展：权限模式镜像（仅用于驱动模式指示 row re-render）。
  // 真值由 permissionMode context 持有；handler 翻 mode 时同步 setState。
  // 不走轮询：TUI 当前无其它改 mode 路径（/permissions 在 TUI 词表里没有），
  // 单一触发源（Shift+Tab）直接 set，省一个常驻 tick。
  const [permMode, setPermMode] = useState(() => permissionMode.get());
  // #279 项3：权限 modal 槽状态。dismissed = Esc 收起后退回旧的「输入框 y/n」
  // 路径（向后兼容）；permissionIndex = ↑↓/Enter 导航的选中项。新 ask id 到来
  // 时 render-body 复位（见 askPending 后的 lastAskIdRef 守卫）——hooks 声明
  // 必须在 viewportRows useMemo 之前（modal 行数入账依赖 dismissed）。
  const [askModalDismissed, setAskModalDismissed] = useState(false);
  const [permissionIndex, setPermissionIndex] = useState(0);
  // #238 鼠标拖选选区（未 normalize）：null = 无活动选区。drag 期间不断
  // 更新；mouseup 时若非空 → 调 copyToClipboard，并清空。滚动 / 切会话 / new
  // 会话 → 一律清空，避免 stale 状态。
  const [selection, setSelection] = useState<Selection | null>(null);
  // #238 selection 镜像 ref：mouseup stale 闭包路径读最新值；clearSelection
  // 双清（state + ref），避免 setState updater 内做副作用。
  const selectionRef = useRef<Selection | null>(null);
  // #238 键盘逃生口：最近一次非空选区（mouseup 自动复制后保留，供 Ctrl+Y
  // 重新复制）。mouseup 不写这里（自动复制已发生）；Ctrl+Y 读它。
  const lastSelectionRef = useRef<Selection | null>(null);
  selectionRef.current = selection;

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
  // view 进 ref 让 mouse listener 跨视图切换不丢事件：不把 view 写进 effect deps，
  // 避免 view 切换瞬间 unregister/register 丢滚轮。
  const viewRef = useRef<TuiView>("chat");
  viewRef.current = view;
  const [listEntries, setListEntries] = useState<ReadonlyArray<TuiListEntry>>(
    []
  );
  // #279 项3：pending 变化推送（subscribe）——enqueue/settle 即时 re-render，
  // modal 挂/摘不再依赖「恰好的」re-render（idle 直发 ask 也能立刻见 modal）。
  // pending 本体存 state（而非版本号）：viewportRows useMemo 需要它做依赖——
  // 只 bump 版本计数器时 render-body 复位值不变、React bail，memo 返回不含
  // modalRows 的旧缓存而 ModalHost 已渲盒子 → 整帧溢出 modalRows+1。
  const [askPending, setAskPending] = useState<TuiPendingAsk | undefined>(
    askBridge.pending()
  );
  useEffect(() => {
    setAskPending(askBridge.pending());
    return askBridge.subscribe(() => setAskPending(askBridge.pending()));
  }, [askBridge]);
  // 根 tick 仅轮询 pending（超时 settle 兜底）：有 pending 时才挂载，idle
  // 且无授权待决时不强制整树 10Hz 重渲染（spinner 自带 tick）。
  // subscribe 已推送变更，tick 仅作超时 settle 等边缘场景的兜底。
  const askTick = askPending !== undefined;
  useTick(askTick ? 100 : 0);

  // 方案 B + 完整眼常驻（2026-08-08 用户二次裁定「不坍塌，完整历史」）：
  // banner 与消息同处一个滚动区——默认锚底看最新消息，PgUp/Home 上滚可见
  // 完整眼。帧高溢出（曾把 banner 顶出屏幕的根因）已由 chromeReserveRows
  // 行账修复 + 帧高守卫测试兜底，不再需要塌单行回避。
  // 窄终端（cols < BANNER_MIN_COLS）完整眼本来就放不下 → 退单行 short。
  // 底部输入框 + 状态栏固定（ChatView 之外）始终在底部。
  const bannerLines = useMemo(() => {
    if (view !== "chat") return [];
    const full = renderBanner(
      { version: VERSION, cwd: props.cwd, dataDir: props.dataDir },
      { cols, short: false }
    );
    if (full.length === 0) {
      // 窄终端：完整眼放不下 → 单行 short（任意 ≥15 列都能放下）
      return renderBanner(
        { version: VERSION, cwd: props.cwd, dataDir: props.dataDir },
        { cols, short: true }
      );
    }
    // 完整眼 + 顶部分隔
    return [...full, `\x1b[38;5;244m${"─".repeat(cols)}\x1b[0m`];
  }, [view, cols, props.cwd, props.dataDir]);

  const viewportRows = useMemo(() => {
    // 固定 chrome 逐行入账（chromeReserveRows SSOT）：输入框 3 行 + mode
    // 指示行 + ContextBar + headroom + ask 槽（+ notice 折行行数及其尾
    // margin + 输入候选行 + 后台运行标记）。状态栏已于用户 2026-08-07
    // 反馈移除（空闲/版本号/运行态全部不需要——版本号 banner 已有，运行态
    // ContextBar 脉动承担）。滚动指示器的行账由 ChatView 内部从 viewportRows
    // 扣除（INDICATOR_ROWS，SSOT）。
    //
    // 方案 B（最终定稿）：banner 已归入 ChatView 内部 row window 作为第一段
    // content，**不再从 viewport 扣减**——否则空会话完整 banner（≈16 行）会
    // 双重扣账把视口压扁，矮终端 banner 顶部被窗口裁掉、滚不回去。
    // 消息区高度 = 终端总行 - 固定 chrome；banner 和消息共享这个视口并一起
    // 滚动（用户 2026-08-07 复看：「下面对话框要固定，消息跟图标可以向上
    // 滚动」）。ChatView 内部对 banner/message 的行窗口做 clamp 兜底。
    // notice 行账按**视觉宽度折行后**的实际行数计（noticeRenderRows SSOT；
    // 只数 lines.length 会在窄终端低估 → 整帧溢出，正是 #268 banner 截断的
    // 同类回归）。
    const noticeLines = noticeRenderRows(notice?.lines, cols);
    const hintRows = inputValue.trim().startsWith("/")
      ? slashSuggestions(inputValue).length
      : 0;
    const bgLine = Object.values(sessions).some(
      (s) => s.runState === "running-bg"
    );
    // #279 项3：权限 modal 活动时盒子行数入账（selectModalRows 视觉宽度折行
    // 预测 SSOT）——漏账会让整帧高于终端行数、上卷顶走 banner（#268 同类回归）。
    // 读 askPending state（subscribe 回调写入）而非直调 askBridge.pending()：
    // state 入 deps，ask 到达/结束时 memo 才会重算把 modalRows 入账。
    const modalAsk =
      view === "chat" && !askModalDismissed ? askPending : undefined;
    const modalRows =
      modalAsk !== undefined ? permissionModalRows(modalAsk, cols) : 0;
    const reserved = chromeReserveRows({
      noticeRows: noticeLines,
      inputHintRows: hintRows,
      bgLine,
      modalRows,
    });
    return Math.max(5, rows - reserved);
  }, [
    rows,
    notice,
    cols,
    inputValue,
    sessions,
    view,
    askModalDismissed,
    askPending,
  ]);
  // 滚轮 listener 的闭包捕获 mount 时的旧 viewportRows（effect deps 只有
  // [stdin, stdout]），不随 resize 更新。用 ref 镜像最新值，滚轮步长才能跟随
  // 当前视口（与 PgUp/PgDn 的 useMemo 内 step 保持一致）。
  const viewportRowsRef = useRef(viewportRows);
  viewportRowsRef.current = viewportRows;

  // 会话列表视图的视口行数预算：ListView 只渲染「搜索框 + 表头 + 行」，
  // 底部 notice 盒子（若有）由 app 挂在 ListView 之下，故从终端总行扣
  // notice 折行行数 + 底部余量，避免列表 + notice 合帧溢出（#268 同类回归）。
  // 列表视图无输入框 / mode 行 / ContextBar，故只扣 notice 与 headroom。
  const listViewRows = useMemo(() => {
    const noticeLines = noticeRenderRows(notice?.lines, cols);
    return Math.max(5, rows - 2 - noticeLines);
  }, [rows, notice, cols]);

  // 工具事件订阅：T4 (#175) 优先按 tool_use_id 配对入结构化运行状态;
  // 缺 toolUseId 时落回 legacy 字符串行追加(向后兼容)。detail 按 cols 收口
  // （窄终端单行不折，行账不漂移 — tool-summary.ts）。
  useEffect(
    () =>
      toolEventSink.subscribe((event) => {
        if (event.toolUseId !== undefined) {
          const { detail } = summarizeToolCall(
            event.toolName,
            event.input,
            cols
          );
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
                // T4 (#298): 透传观测 side-channel — deps.ts:139 已把
                // result.meta 落入 event.payload,此处补上消费点,否则
                // liveToolReduce 写 oldContent/newContent = undefined,
                // live-tool-preview.tsx:37-40 落回 intent-diff 兜底。
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
            formatLiveToolEvent({
              toolName: event.toolName,
              input: event.input,
              kind: event.kind,
              // cols 收口 detail（窄终端单行不折）；显式 override 跳过内部重算。
              detail: summarizeToolCall(event.toolName, event.input, cols)
                .detail,
            }),
          ],
        }));
      }),
    [toolEventSink, cols]
  );

  // 鼠标支持（朴素滚动 + #238 拖选）：ink 渲染到 normal buffer，原生 scrollback
  // 全是中间帧垃圾，滚轮翻历史不可用。挂载时 DECSET 1000/1006 启用 SGR 滚轮
  // 报告 + 1002h（drag 模式）启用拖动上报；stdin.data 监听 parseMouseAllEvents。
  // 滚轮 → setChatScroll（与 PgUp/PgDn 同一条滚动状态）；左键按下/拖动/释放 →
  // 更新选区，释放时非空选区 → copyToClipboard + 清空。卸载时写 DECRST 关闭
  // 序列（必须！否则残留 mouse 报告模式污染终端）。mouse listener 走
  // stdin.on('data')：实测 pty + ink setRawMode 后 'data' 事件仍正常触发（ink
  // 用 'readable' 流式读取，不消费 data 事件），与 ink useInput 并行不冲突。
  const contentWindowRef = useRef<ContentWindow | null>(null);
  const dragActiveRef = useRef(false);
  // #238 选区在视图非 chat / 滚动 / 切会话时清空（state + ref 双清，ref 供
  // mouseup stale 闭包读最新值；lastSelectionRef 同清，避免 Ctrl+Y 跨会话
  // 复活旧选区）。
  const clearSelection = (): void => {
    selectionRef.current = null;
    lastSelectionRef.current = null;
    setSelection(null);
  };
  useEffect(() => {
    const disable = enableSgrMouseReport(stdout);
    const onData = (chunk: Buffer | string): void => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      // 滚轮：独立路径（不参与选区）。与 PgUp/PgDn 同一条滚动状态：
      // 步长 = max(1, floor(viewportRows / 2))，wheel-up 累加、wheel-down 累减；
      // ChatView 内部把 scroll clamp 到 [0, maxScroll]，到顶/底自然 no-op。
      // 注：旧 commit 88f4ac5 改成 clamp 到顶/底（用户 2026-08-08 反馈：「滚
      // 上去只能看到第一页，滚下来只能看到当前页，中间完全看不到」——典型
      // 跳态），本 fix 恢复渐进滚动。
      const { wheelUp, wheelDown } = parseMouseEvents(text);
      if (wheelUp > 0 || wheelDown > 0) {
        if (viewRef.current !== "chat") return;
        clearSelection();
        const step = wheelScrollStep(viewportRowsRef.current);
        if (wheelUp > 0) {
          setChatScroll((s) => s + wheelUp * step);
        }
        if (wheelDown > 0) {
          setChatScroll((s) => Math.max(0, s - wheelDown * step));
        }
        return;
      }
      // 视图过滤放 listener 内（不进 deps）：跨视图切换不丢事件。
      if (viewRef.current !== "chat") return;
      const win = contentWindowRef.current;
      if (win === null) return;
      for (const ev of parseMouseAllEvents(text)) {
        if (ev.button === 0 && ev.pressed) {
          // 左键按下 → 选区起点（清除之前选区）
          const pos = terminalToCellPos(ev.x, ev.y, win);
          if (pos === null) continue;
          dragActiveRef.current = true;
          setSelection({ anchor: pos, active: pos });
        } else if (ev.button === 3 && !ev.pressed) {
          // 释放（任意键）→ 若本帧有过 drag 才复制；裸 release（无 press）
          // 不消费已存选区（防止 Ctrl+Y 之间杂散 release 误复制）。
          const wasDragging = dragActiveRef.current;
          dragActiveRef.current = false;
          if (!wasDragging) continue;
          // side effect（复制+notice）放 setSelection 之外：updater 必须纯
          //（StrictMode 下会双调用）。
          const prev = selectionRef.current;
          setSelection(null);
          if (prev !== null && !isEmpty(prev)) {
            lastSelectionRef.current = prev; // Ctrl+Y 逃生口
            void doCopySelection(prev);
          }
        } else if (ev.button === 32 && ev.pressed) {
          // 左键拖动 → 扩展选区 active
          if (!dragActiveRef.current) continue;
          const pos = terminalToCellPos(ev.x, ev.y, win);
          if (pos === null) continue;
          setSelection((prev) =>
            prev === null
              ? { anchor: pos, active: pos }
              : { ...prev, active: pos }
          );
        }
      }
    };
    stdin?.on("data", onData);
    return () => {
      stdin?.off("data", onData);
      dragActiveRef.current = false;
      disable();
    };
  }, [stdin, stdout]);

  const active = sessions[activeKey] ?? initial;

  // #279 项3：新 ask id 到来 → render-body 复位 modal 状态（React 允许渲染期
  // setState 并立即重渲染本组件，不会出现一帧陈旧 modal；ask 结束 id 变
  // undefined 时只更新 ref，不动状态）。
  const askId = askPending?.id;
  const lastAskIdRef = useRef<string | undefined>(undefined);
  if (askId !== lastAskIdRef.current) {
    lastAskIdRef.current = askId;
    if (askId !== undefined) {
      setAskModalDismissed(false);
      setPermissionIndex(0);
    }
  }
  // modal 活跃 = chat 视图 + 有 pending ask + 未被 Esc 收起。活跃时输入框
  // 让出键位（disabled），y/a/n / ↑↓+Enter / Esc 全走 modal 键路由。
  const askModalActive =
    view === "chat" && askPending !== undefined && !askModalDismissed;

  /** #279 项3：权限 modal 应答落点。once/always → 放行；always 追加 session
   *  层 allow 规则（后续同工具不再 ask）；reject → 拒绝。resolveAsk 返回
   *  false（60s 超时已先 settle 的竞态）时不做任何副作用——授权/提示不能
   *  落在一个并未真正放行的 ask 上。 */
  function resolvePermissionAsk(
    pending: TuiPendingAsk,
    answer: PermissionAnswer
  ): void {
    const settled = askBridge.resolveAsk(pending.id, answer !== "reject");
    if (!settled) return;
    if (answer === "always") {
      const tool = pending.tool;
      props.sessionGrants?.add({
        // Map.set 同 id 覆盖 → 重复授权天然去重。
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

  // #279 项 4：活动工具名派生（无新 state）—— 当前会话 liveToolRuns 末尾
  // running 条目即当前工具；无运行中 → undefined（ContextBar 不渲染指示器）。
  const activeToolName = active.conversationId
    ? activeToolNameOf(liveToolRuns[active.conversationId] ?? [])
    : undefined;

  // #238 stale-closure 修复：stdin 的 mouse listener 用 useEffect + 稳定 deps
  // 注册一次（不随每次 render 重绑，避免丢事件），但它捕获首帧闭包。mouseup
  // 复制路径必须读到「当前」live state（流式 turn / 工具事件 / 切会话后都会变），
  // 故把复制需要的 live 值镜像进 ref（每 render 更新 current），doCopySelection
  // 读 ref 而非闭包。view/contentWindow 已是 ref 模式，这里补齐其余字段。
  const bannerLinesRef = useRef<ReadonlyArray<string>>([]);
  const activeRef = useRef(active);
  const colsRef = useRef(cols);
  const liveToolLinesRef = useRef(liveToolLines);
  const liveToolRunsRef = useRef(liveToolRuns);
  const askPendingRef = useRef(askPending);
  const draftsMaskedRef = useRef(draftsMasked);
  const thinkingDraftMaskedRef = useRef(thinkingDraftMasked);
  const thinkingExpandedRef = useRef(thinkingExpanded);
  const dataDirRef = useRef(props.dataDir);
  bannerLinesRef.current = bannerLines;
  activeRef.current = active;
  colsRef.current = cols;
  liveToolLinesRef.current = liveToolLines;
  liveToolRunsRef.current = liveToolRuns;
  askPendingRef.current = askPending;
  draftsMaskedRef.current = draftsMasked;
  thinkingDraftMaskedRef.current = thinkingDraftMasked;
  thinkingExpandedRef.current = thinkingExpanded;
  dataDirRef.current = props.dataDir;
  selectionRef.current = selection;

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
    // T4: 桥接回执的 lastUsage（成功才抄入；cancelled/异常路径保持 null）。
    let lastUsage: TokenUsage | null = null;
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
      // plan T6 / ADR-0011:loop-engine 在异常停前 emit stop_summary。bridge
      // 永远不看到抛出的 MaxTurnsExceeded(hub 侧 catch),但它把 stop_summary
      // 事件原样转发给 host;此处把它落到 notice,作为"已达上限 + 收尾摘要"
      // 的用户面呈现(stopReason="maxTurns" 由 turnFinished 单独挂上,session
      // 文件不被 touch;notice 保留到下一次 sendTurn setNotice(undefined))。
      if (event.type === "stop_summary") {
        setNotice({ lines: [event.text] });
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
      lastUsage = resp.lastUsage;
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
            // T4: 透传 lastUsage 给 ContextBar /info 用；wire 缺席等价 null。
            lastUsage,
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
      // turn 本身的停止原因。lastUsage 已抄入 → 仍透传（turn 已跑过，
      // 不因刷新失败抹除）。
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
    clearSelection();
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
    clearSelection();
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

  /** #238：根据当前 ChatView 内容行，把选区文本提取并复制。
   *  读 *Ref.current 而非闭包变量：mouseup 是 useEffect 注册的 stale 闭包
   *  路径，必须读到最新 live state（流式 turn / 工具事件 / 切会话都更新）。 */
  async function doCopySelection(sel: Selection): Promise<void> {
    const sess = activeRef.current;
    const pending = askPendingRef.current;
    const lines = flatContentLines({
      bannerLines: bannerLinesRef.current,
      session: sess,
      cols: colsRef.current,
      liveToolLines: sess.conversationId
        ? (liveToolLinesRef.current[sess.conversationId] ?? [])
        : [],
      liveToolRuns: sess.conversationId
        ? (liveToolRunsRef.current[sess.conversationId] ?? [])
        : [],
      askLine: pending
        ? `[ask] 允许 ${pending.tool}？${
            pending.summaryHint ? ` ${pending.summaryHint}` : ""
          } 输入 y/n`
        : undefined,
      draftsMasked: draftsMaskedRef.current,
      thinkingDraftMasked: thinkingDraftMaskedRef.current,
      thinkingExpanded: thinkingExpandedRef.current,
    });
    const text = extractSelectionText(normalize(sel), lines);
    if (text.length === 0) {
      setNotice({ lines: ["选中区域为空。"] });
      return;
    }
    let result: CopyResult;
    try {
      result = await copyToClipboard(text, { dataDir: dataDirRef.current });
    } catch (err) {
      // copyToClipboard 内部不 throw（返回 typed kind），但 spawn/writeFile
      // 的意外异常仍防御性兜底，避免 void 调用产生 unhandled rejection。
      setNotice({
        lines: [
          `复制失败：${err instanceof Error ? err.message : String(err)}`,
        ],
      });
      return;
    }
    if (result.kind === "ok") {
      setNotice({
        lines: [`已复制（${result.method}，${text.length} 字）。`],
      });
    } else if (result.kind === "fallback") {
      setNotice({
        lines: [
          `剪贴板命令不可用，文本已写入 ${result.path}（${result.bytes} bytes）。`,
        ],
      });
    } else if (result.kind === "error") {
      setNotice({
        lines: [`复制失败：${result.message}`],
      });
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
    // 防御性：同步写 DECRST 关 mouse 序列，不依赖 React effect cleanup（真实
    // 终端残留 mouse 报告模式会污染粘贴/选择/红点定位）。SSOT 在 mouse.ts
    // （1000l/1006l/1002l 全关），避免漏关 drag mode。
    disableMouseReport(stdout);
    exit();
  }

  /** T6 (D5)：/thinking 斜杠命令切换 thinking 折叠面板展开态。
   *  注意语义分工（用户 2026-08-08 澄清）：切换只归 /thinking；
   *  Ctrl+O 是「展示思考」（只展开，见 useInput 分支）。
   *  running 态下也允许（不改 streaming 行为，只影响终稿渲染）。 */
  function toggleThinking(): void {
    setThinkingExpanded((prev) => !prev);
    // 不再 setNotice：长 notice 在窄终端折行会超出行账（#268 viewport 预算），
    // 键位提示改挂折叠摘要行右侧「(Ctrl+O)」（message-rows / message-blocks）。
  }

  async function handleSubmit(raw: string): Promise<void> {
    setInputValue("");
    const text = raw.trim();
    if (text.length === 0) return;
    // askUser 待决：y/n/a 优先于普通输入（权限确认高于对话）。modal 收起
    // （Esc）后的兼容路径——与 modal 键路由同一 resolvePermissionAsk 落点。
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
      // #279 项5（review 修复：历史污染）：入历史移到路由后——仅真实消息
      // 进召回列表（y/n 回复、slash 命令、未知命令已在上方分支排除）；
      // 且 busy guard 拒绝的消息不入库（与 sendTurn 内守卫同条件）。
      // 连续重复去重：召回后原样再提交只保留一条。
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
          lines: infoLines(active, activeKey, bridge.contextWindow),
        });
        return;
      }
      case "thinking": {
        // T6 (D5):切换 thinking 折叠面板展开态（与 Ctrl+O 同 helper）。
        toggleThinking();
        return;
      }
      case "compact": {
        // 手动压缩当前会话上下文。与 sendTurn 同护栏：running 中拒绝；
        // draft（未建档）无盘上消息 → 提示先发消息。压缩后从磁盘刷新
        // （磁盘是 SSOT），保留 lastUsage 读数。
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
          const compacted = await bridge.compactSession(targetId);
          const file = await bridge.loadSessionFile(targetId);
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
    // W2 扩展：Shift+Tab 切换权限模式（default ↔ full_auto；plan 走
    // /permissions 命令不进循环）。ink 在 pty 收到 CSI `Z`（`\x1b[Z`）
    // 时把 key.tab && key.shift 一起置位。注意：不放在 view === "chat"
    // 守卫后——list 视图也允许切 mode（与 Ctrl+Y / Ctrl+C 同层）。
    // PromptInput 让出 shift+tab（见 `PromptInput` 让出分支 `if
    // (key.tab && key.shift) return`）→ ink useInput 广播给本 handler。
    // 守卫 + mode-flip 副作用走共享 helper `applyShiftTabModeFlip`
    // （chat-session.ts 同款），避免双份实现 lockstep。
    if (
      applyShiftTabModeFlip({
        key: {
          name: key.tab ? "tab" : undefined,
          shift: key.shift,
          ctrl: key.ctrl,
          meta: key.meta,
        },
        ctx: permissionMode,
        onFlip: (next) => {
          // 不弹 notice：模式状态由输入框上方左对齐的模式指示行持续承载
          // （2026-08-09 用户反馈：切换时弹出提示属多余，常驻指示即可）。
          setPermMode(next);
        },
      })
    ) {
      return;
    }
    if (key.ctrl && input === "y") {
      // Ctrl+Y：键盘逃生口。当前有选区（drag 进行中）→ 直接复制；否则用
      // 最近一次非空选区（mouseup 自动复制后保留）实现"重新复制"。
      const active = selection ?? lastSelectionRef.current;
      if (active === null) {
        setNotice({ lines: ["无选区：先按住鼠标左键拖选文本。"] });
      } else {
        void doCopySelection(active);
      }
      return;
    }
    if (key.ctrl && input === "c") {
      if (canInterrupt(active)) {
        aborters.current.get(active.conversationId ?? "")?.abort();
      } else {
        setNotice({ lines: ["Ctrl+C：无前台运行中的 turn；/quit 退出。"] });
      }
      return;
    }
    if (view !== "chat") return;
    // #279 项3：权限 modal 活跃时独占键位（PromptInput 已 disabled 让出）：
    // y/a/n 直选、↑↓+Enter 导航确认、Esc 收起退回输入框 y/n 兼容路径；
    // 其余键全吞（openharness permission modal 同语义，防误滚动/误输入）。
    // Ctrl+C / Ctrl+Y / Shift+Tab 在本分支之前已处理，不受影响。
    if (askModalActive && askPending !== undefined) {
      const action = reduceModalKey(
        {
          input,
          key: {
            upArrow: key.upArrow,
            downArrow: key.downArrow,
            return: key.return,
            escape: key.escape,
            ctrl: key.ctrl,
            meta: key.meta,
          },
        },
        { options: PERMISSION_ANSWERS, selectedIndex: permissionIndex }
      );
      switch (action.type) {
        case "move":
          setPermissionIndex(action.index);
          break;
        case "select":
          resolvePermissionAsk(askPending, action.value as PermissionAnswer);
          break;
        case "dismiss":
          // Esc：收起 modal，ask 提示行回 ChatView tail，输入框 y/n 兜底。
          setAskModalDismissed(true);
          break;
        case "ignore":
          break;
      }
      return;
    }
    // Ctrl+O：展示思考（只展开，不折叠；用户 2026-08-08 澄清语义——折叠/
    // 切换归 /thinking）。已展开时保持 no-op。PromptInput 对 ctrl 组合键
    // 早返回让出（components.tsx `key.ctrl → return`），不吞键。
    if (key.ctrl && input === "o") {
      setThinkingExpanded(true);
      return;
    }
    // 方案 B：banner + 消息共用 row window，空会话也可滚动（矮终端 banner
    // 超视口时 PgUp 能翻回 banner 顶部；高终端 maxScroll=0 自动 no-op）。
    // 不设 messages.length===0 守卫——banner 就是可滚动内容。
    const step = Math.max(1, Math.floor(viewportRows / 2));
    if (key.pageUp) {
      clearSelection();
      setChatScroll((s) => s + step);
    } else if (key.pageDown) {
      clearSelection();
      setChatScroll((s) => Math.max(0, s - step));
    } else if (key.home) {
      // 顶：scroll 跳到一个大数，由 ChatView 兜底 clamp 到 totalRows
      clearSelection();
      setChatScroll(Number.MAX_SAFE_INTEGER);
    } else if (key.end) {
      // 底：auto-follow 重置
      clearSelection();
      setChatScroll(0);
    }
  });

  const bgSession = Object.values(sessions).find(
    (s) => s.runState === "running-bg"
  );

  return (
    <Box flexDirection="column">
      {view === "list" ? (
        <ListView
          entries={listEntries}
          cols={cols}
          rows={listViewRows}
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
            // #279 项3：modal 活跃时提示由 modal 承载（避免双份渲染）；
            // Esc 收起后退回 ChatView tail 文本行（旧路径，输入框 y/n 兜底）。
            askPending !== undefined && !askModalActive
              ? `[ask] 允许 ${askPending.tool}？${
                  askPending.summaryHint ? ` ${askPending.summaryHint}` : ""
                } 输入 y/a/n（a=总是允许）`
              : undefined
          }
          scrollRows={chatScroll}
          viewportRows={viewportRows}
          thinkingExpanded={thinkingExpanded}
          bannerLines={bannerLines}
          selection={selection ?? undefined}
          onWindow={(w) => {
            contentWindowRef.current = w;
          }}
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
      {/* #279 项3：modal 渲染槽（ModalHost 分派）——权限 ask 待决且未收起时
          渲染 y/a/n 确认盒子，位于输入框上方。行数由 viewportRows 的
          chromeReserveRows modalRows 入账（行账 SSOT），窄终端不溢出。 */}
      {view === "chat" && (
        <ModalHost
          modal={
            askModalActive && askPending !== undefined
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
      {/* W2 扩展：权限模式指示行（仅聊天视图；list 视图顶部已有表头不重复）。
          左对齐；颜色按模式区分：full_auto 金黄（running），其余 dim。
          2026-08-09 用户反馈：右上方 → 左上方，且切换不再弹提示（本行即常驻
          指示）。窄列（cols < 40）降级为简短形态。Shift+Tab 切换后 permMode
          state 驱动 re-render。 */}
      {view === "chat" && (
        <Box>
          <Text color={permMode === "full_auto" ? pal.running : pal.dim}>
            {cols < 40
              ? `[${permMode === "full_auto" ? "auto" : "def"}]`
              : `mode: ${modeLabel(permMode)}`}
          </Text>
        </Box>
      )}
      {/* 输入框仅聊天视图挂载：列表视图纯导航（Q4b），避免两个 useInput
          同时监听 stdin 产生键位竞争。 */}
      {view === "chat" && (
        <PromptInput
          value={inputValue}
          placeholder={
            askPending
              ? askModalActive
                ? "modal 键位接管中（Esc 退回输入）"
                : "y/a/n 确认工具授权（a=总是允许）"
              : "输入消息或 /help"
          }
          active={active.runState === "running-fg"}
          disabled={askModalActive}
          onChange={setInputValue}
          onSubmit={(v) => void handleSubmit(v)}
          onSelectHint={(cmd) => void handleSubmit(`/${cmd}`)}
          // 任务 B：Tab 仍走唯一匹配补全（slashComplete，行为不变以保留
          // 旧 e2e「Tab 多匹配不动作」语义）；候选选中用 Enter + onSelectHint
          // 触发。PromptInput 内部维护 cursor，路由 onSelectHint 而非
          // onSubmit(value)，避免 raw 文本解析绕开 cursor 选中。
          onTabComplete={(value) => slashComplete(value)}
          hintSuggestions={inputHintSuggestions}
          history={inputHistory}
        />
      )}
      {/* ContextBar 仅聊天视图挂载（T4）：上下文用量条，输入框正下方
          **右对齐**，紧贴输入框右下角（用户 2026-08-08 反馈：离输入框更近）。
          list 视图不挂。 */}
      {view === "chat" && (
        <Box alignItems="flex-end">
          <ContextBar
            lastUsage={active.lastUsage}
            contextWindow={bridge.contextWindow}
            running={active.runState === "running-fg"}
            cols={cols}
            activeToolName={activeToolName}
          />
        </Box>
      )}
      {/* 后台会话运行标记（SC5）：存在 running-bg 会话时单行 dim 提示。原
          StatusBar 的空闲/版本号/运行态已按用户 2026-08-07 反馈移除（版本号
          banner 已有，前台运行态由 ContextBar 脉动承担），仅保留这一条信息
          承载 —— 后台 turn 在 UI 别处无显示。 */}
      {bgSession && (
        <Box>
          <Text color={pal.dim}>后台运行中</Text>
        </Box>
      )}
    </Box>
  );
}

function infoLines(
  session: TuiSessionState,
  key: string,
  contextWindow: number
): ReadonlyArray<string> {
  const lu = session.lastUsage;
  // T4: token 明细（CLI `tokens in/out` 同语义 + cache read + window）。
  // lastUsage === null → tokens: —（无成功调用）。
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

function describeError(err: unknown): string {
  if (typeof err === "object" && err !== null && "kind" in err) {
    const kind = String((err as { kind: unknown }).kind);
    return `会话存储错误 [${kind}]`;
  }
  return err instanceof Error ? err.message : String(err);
}
