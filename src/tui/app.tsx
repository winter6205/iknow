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
 * T8 多行输入：输入框行账从固定 3 → 动态（chromeReserveRows 新增
 * `inputRows`，按 inputValue 逻辑行数封顶 MAX_INPUT_LINES=8）；内容行数增
 * → viewportRows 减 → ChatView 高度预算联动，历史消息不丢仅可视区变矮。
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
import type { MouseEvent, Selection } from "@opentui/core";
import {
  useKeyboard,
  usePaste,
  useRenderer,
  useSelectionHandler,
  useTerminalDimensions,
} from "@opentui/react";
import type { HarnessStreamEvent } from "../harness/stream.js";
import type {
  AnthropicNativeMessage,
  TokenUsage,
} from "../harness/model-adapter/types.js";
import type { TuiToolEvent, TuiMcpViewExt } from "./deps.js";
import type { McpServerStatus } from "../harness/mcp/manager.js";
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
  appendInputHistory,
  attachSession,
  canInterrupt,
  createDraftSession,
  seedInputHistory,
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
  parseSkillLoad,
  parseTuiInput,
  slashComplete,
  slashCompleteFromCandidates,
  slashPrefix,
  slashSuggestions,
  type SlashCandidate,
} from "./slash.js";
import { activeToolNameOf, liveToolReduce } from "./live-tool-state.js";
import type { LiveToolRun } from "./live-tool-state.js";
import {
  ADJUSTABLE_EFFORT_LEVELS,
  effortHasArg,
  parseEffortLevel,
} from "./slash.js";
import {
  ThinkingPicker,
  committedThinkingPatch,
  effortToDisplayIndex,
  indexToEffort,
  reduceThinkingSwitchKey,
  reduceThinkingEffortKey,
  thinkingPickerRows,
  type CommittedThinkingPatch,
  type ThinkingPickerState,
} from "./thinking-picker.js";
import { computeThinkingOverride, formatEffortLabel } from "./thinking-gate.js";
import type {
  ThinkingEffortWire,
  WireThinkingOverride,
} from "../session-api/contract.js";
import { ChatView } from "./chat-view.js";
import type { StreamDraft } from "../cli/stream-draft.js";
import { createStreamDraft } from "../cli/stream-draft.js";
import { ListView, relativeTime, type TuiListEntry } from "./list-view.js";
import { McpView, type McpToolEntry } from "./mcp-view.js";
import { ContextBar } from "./context-bar.js";
import {
  INPUT_MAX_LINES as MAX_INPUT_LINES,
  inputVisibleLineCount,
  inputWrapLineCount,
  PromptInput,
} from "./prompt-input.js";
// T8 — chromeReserveRows 行账封顶由 INPUT_MAX_LINES（prompt-input SSOT）
// 统一收口，避免 app.tsx 与 prompt-input.tsx 各自持有 "8" 常量导致飘移。
// app 侧本地别名为 MAX_INPUT_LINES（保留原引用语义）+ 重新导出，保证
// 外部 import 表面（tests/tui/*）稳定。
import { renderBannerLines, VERSION } from "./banner.js";
import { copyToClipboard, type CopyResult } from "./clipboard.js";
import {
  isSubagentTool,
  SUBAGENT_TOOL_LABEL,
  subagentDisplayMark,
  summarizeToolCall,
  formatLiveToolEvent,
} from "./tool-summary.js";
import {
  SubagentPanel,
  projectSubagentLines,
  FAILED_VISIBLE_WINDOW_S,
  DONE_FADE_WINDOW_S,
} from "./subagent-panel.js";
import type { SubagentInfo } from "../harness/subagent/manager.js";
import { formatRunDuration } from "./run-stats.js";
import { tuiPalette } from "./theme.js";
import {
  applyShiftTabModeFlip,
  createPermissionModeContext,
  modeLabel,
} from "../harness/permission/index.js";
import { createSkillBody } from "../harness/skill/body.js";
import type { SkillCatalog } from "../harness/skill/catalog.js";
import { extractTitle } from "../session-api/store/schema.js";

/** T8/T9：chromeReserveRows 行账封顶常量与可见行数计算函数的本地重导出
 *  （SSOT 实际定义在 prompt-input.tsx，避免两模块各持 "8" 常量飘移）。
 *  T9 加 inputWrapLineCount（wrap-aware 视觉折行行数）—— 修长文本无 `\n`
 *  时输入框高度不增长的回归（2026-08-14 用户反馈「输入多少都是一行」）。 */
export { inputVisibleLineCount, inputWrapLineCount, MAX_INPUT_LINES };

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
 *   - 输入框圆角线框（inputRows 内容行 + 2 边框行；T8 起动态，
 *     输入行数增 → 视图预算随之减，不挤掉历史消息）
 *   - ContextBar 用量条 1 行
 *   - ask 槽 1 行（ChatView tail 恒预留）
 *   - slash 候选行（inputValue.trim().startsWith("/") ? … : 0）
 *   - notice 本体 + 自身 marginBottom=1
 *   - modal 本体 + 自身 marginBottom=1
 *   - thinking-picker 面板 + 自身 marginBottom=1（pickerRows 同 modalRows 约定）
 *   - 子代理状态面板（动态 0-4 行，panelRows；ContextBar 下方，见 subagent-panel.tsx）
 *   - 后台运行标记行（存在 running-bg 时）
 */
export function chromeReserveRows(opts: {
  readonly noticeRows: number;
  readonly inputHintRows: number;
  readonly bgLine: boolean;
  /** 输入框内容可见行数（textarea 逻辑行）。缺省 1 → 预算 3（等价旧固定值）；
   *   内部封顶 MAX_INPUT_LINES（行账 SSOT，防误传超大值挤爆视图）。 */
  readonly inputRows?: number;
  readonly modalRows?: number;
  readonly pickerRows?: number;
  /** 子代理状态面板行数（projectSubagentLines 实际产出，0-4）。缺省 0 →
   *   不占行（组件渲染 null / 旧行为兼容）。 */
  readonly panelRows?: number;
}): number {
  const inputContentRows = Math.max(
    1,
    Math.min(opts.inputRows ?? 1, MAX_INPUT_LINES)
  );
  const modalRows = opts.modalRows ?? 0;
  const pickerRows = opts.pickerRows ?? 0;
  const panelRows = opts.panelRows ?? 0;
  const noticeTotal = opts.noticeRows > 0 ? opts.noticeRows + 1 : 0;
  const modalTotal = modalRows > 0 ? modalRows + 1 : 0;
  const pickerTotal = pickerRows > 0 ? pickerRows + 1 : 0;
  return (
    1 + // top headroom
    1 + // mode指示行
    inputContentRows + // 输入框内容行
    2 + // 输入框圆角边框（顶/底框线）
    opts.inputHintRows +
    1 + // ContextBar
    1 + // ask 槽
    noticeTotal +
    modalTotal +
    pickerTotal +
    panelRows +
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

/** #337 Phase C：skillCatalog 缺省 fallback（空清单 — 兼容 fixture / 测试；
 *  product 路径由 run.tsx 经 TuiExtensions.skillCatalog 注入）。模块私有。 */
const emptySkillCatalog: SkillCatalog = Object.freeze({
  search: () => [],
  get: () => undefined,
  all: () => [],
  available: () => [],
  getBodyPath: () => undefined,
});

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
  /** #337 Phase C：skill 清单（slash 候选混显 + /skill-name 加载发送）。
   *  可选：缺省 = 空清单（兼容 fixture / 测试；产品路径由 run.tsx 经
   *  TuiExtensions.skillCatalog 注入）。 */
  readonly skillCatalog?: SkillCatalog;
  /** #361 Phase D：MCP 看板扩展面（TuiMcpViewExt 最小依赖）。缺省 =
   *  undefined → /mcp 切 view 时提示「MCP 未装配」。产品路径由 run.tsx 经
   *  TuiExtensions 注入；fixture / 测试可选 stub。 */
  readonly mcp?: TuiMcpViewExt;
  /** thinking 控制臂初始基线（env `thinking` + `thinkingEffort` 形状）。
   *  仅作为 TUI 内 thinkingEnabled / thinkingEffort state 的初始值；用户
   *  /thinking /effort 改动后经 bridge.postMessage 的 thinking override 透传
   *  （gate：仅当用户实际改了状态才透传）。缺省 → off + ""（与 env 默认一致）。 */
  readonly defaultThinking?: {
    readonly mode: "off" | "adaptive";
    readonly effort: ThinkingEffortWire;
  };
  /** 当前模型名（ContextBar 前置展示）。缺省 "" → 不渲染前缀 model 段
   *  （测试兼容）。product 路径由 run.tsx 传 env.llm.model。 */
  readonly model?: string;
  /**
   * settings-hot-reload（T4）:env 版本递增 counter。run.tsx 在 env reload
   * 成功后递增并重渲染本组件；本组件以 [envVersion] useEffect 把新的
   * model / defaultThinking 基线同步进内部 state（ContextBar model 显示 +
   * thinkingEnabled / thinkingEffort 基线），实现文件级热更新的显示层刷新。
   * 缺省 0 → 首次 mount 无副作用（基线由 props 初值决定，行为零变化）。
   */
  readonly envVersion?: number;
  /**
   * 反向持久化（T4，settings 双向通道）：/thinking /effort 面板 Esc 保存退出
   * 时把面板 commit 结果投影成可持久化 payload 交给宿主写回 settings.json
   * （fire-and-forget，不阻塞面板 state 更新）。返回 `{ ok: false; reason }`
   * 或抛错 → app 以 notice 呈现失败，in-memory override 已生效（本次会话）。
   * 成功不发 notice（写回是后台行为，面板 Esc 本身即反馈）。
   * 可选：缺省 undefined → 面板行为与 PR #413 完全一致（纯 in-memory override，
   * 测试 / fixture 兼容）。
   */
  readonly onPersistThinking?: (
    patch: CommittedThinkingPatch
  ) => Promise<{ ok: true } | { ok: false; reason: string }>;
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
  // #279 项5 + 会话恢复种子：输入历史（内存态不落盘）按 session key 隔离
  // （conversationId / DRAFT_SESSION_ID），initialSession 恢复时用
  // seedInputHistory 把已落盘 transcript 的 query user 消息投影为种子
  // （↑ 召回立即可用）；此后提交经 appendInputHistory 追加（空白跳过 +
  // 相邻去重，同引用短路）。openSessionAt 首次 attach 同样播种；已加载过
  // 的会话切回沿用既有历史（map 已有 key 不重播，保留本进程内追加项）。
  const [inputHistories, setInputHistories] = useState<
    Record<string, ReadonlyArray<string>>
  >(() => ({ [initialKey]: seedInputHistory(initial.messages) }));
  const inputHistory = inputHistories[activeKey] ?? [];
  const [notice, setNotice] = useState<Notice | undefined>(undefined);
  const [liveToolLines, setLiveToolLines] = useState<
    Record<string, ReadonlyArray<string>>
  >({});
  // T4 (#175): 结构化工具调用实时状态。
  const [liveToolRuns, setLiveToolRuns] = useState<
    Record<string, ReadonlyArray<LiveToolRun>>
  >({});
  // T6 (D5): thinking 折叠面板展开态；Ctrl+O 折叠/展开，/thinking 为开关（思考Enabled）。
  const [thinkingExpanded, setThinkingExpanded] = useState(false);
  // thinking 控制臂开关（/thinking 切换，与折叠态解耦）。初始基线 =
  // env defaultThinking.mode === "adaptive"；用户 /effort 也会 setEnabled(true)。
  const [thinkingEnabled, setThinkingEnabled] = useState<boolean>(
    () => props.defaultThinking?.mode === "adaptive"
  );
  // thinking 档位（/effort 设置；"" 表示未指定 → 不附加 effort）。初始 =
  // env defaultThinking.effort。
  const [thinkingEffort, setThinkingEffort] = useState<ThinkingEffortWire>(
    () => props.defaultThinking?.effort ?? ""
  );
  // settings-hot-reload（T4）:当前模型名（ContextBar 前置展示）。初始 = props.model；
  // env reload 后经 [envVersion] useEffect 同步（不直接改 props.model 以免
  // 跨 env 版本串态）。
  const [modelName, setModelName] = useState<string | undefined>(
    () => props.model
  );
  // settings-hot-reload（T4）:envVersion 变化 → 把新 env 的 model / thinking
  // 基线同步进内部 state（ContextBar model + thinkingEnabled / thinkingEffort
  // 基线刷新）。用户 /thinking /effort 的手动覆盖会被 env reload 复位到新基线
  // （计划决策：settings 是运行时配置的事实源，env 变化即覆盖）。
  const envVersion = props.envVersion ?? 0;
  useEffect(() => {
    setModelName(props.model);
    setThinkingEnabled(props.defaultThinking?.mode === "adaptive");
    setThinkingEffort(props.defaultThinking?.effort ?? "");
  }, [envVersion]); // eslint-disable-line react-hooks/exhaustive-deps
  // ── thinking-picker 面板态（/thinking /effort 打开；null = 未打开）────
  // design-25 picker（用户定案双面板版）：/thinking /effort 不再立即生效 +
  // notice，改为弹出浮层面板。Enter 固定（面板保持打开）、Esc 保存退出（写入
  // 真实 thinkingEnabled / thinkingEffort，无 cancel 路径）。面板内是未提交
  // 的暂存态（switchPreview / effortFocusIndex / effortFixedIndex），Esc 才写
  // 真实 state。
  const [thinkingPickerOpen, setThinkingPickerOpen] = useState<
    null | "thinking" | "effort"
  >(null);
  // 开关面板预览态（/thinking）：面板内未提交的开关值（Enter/Space/Tab 翻转，
  // Esc 保存退出才写 thinkingEnabled）。
  const [switchPreview, setSwitchPreview] = useState<boolean>(
    () => thinkingEnabled
  );
  // 档位面板聚焦档（/effort）：←/→ 移动的焦点游标（0..4，未提交）。
  const [effortFocusIndex, setEffortFocusIndex] = useState<number>(
    effortToDisplayIndex(thinkingEffort)
  );
  // 档位面板已固定档（/effort）：Enter 固定的面板内已提交档（0..4，Esc 保存
  // 退出才写 thinkingEffort）。
  const [effortFixedIndex, setEffortFixedIndex] = useState<number>(
    effortToDisplayIndex(thinkingEffort)
  );
  // 档位面板自适应态（/effort）：Space/Tab 切换；Esc 保存退出时 autoOn 优先写
  // ""=自适应（保持 auto，不降级到 concrete）。seed = 当前 thinkingEffort===""
  // → 自适应态（打开 /effort 无参时修复「当前 auto → Esc 静默降 medium」bug）。
  const [effortAutoOn, setEffortAutoOn] = useState<boolean>(
    () => thinkingEffort === ""
  );
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

  // #343 v3 follow-up: 终端（iTerm2 / WezTerm / kitty 等）在 mouse right-up 时
  // 会**自动**把"系统剪贴板当前内容"paste 到 stdin —— 这是 terminal-level
  // feature，不是 OpenTUI 事件。我们 right-up 触发复制（OSC52 写剪贴板）几乎
  // 与终端发起 paste 同时发生，时序上 paste 字节里的内容是 OSC52 **覆盖前**的
  // 旧系统剪贴板内容（不是当前选区），最终通过 usePaste 写进输入框 —— 表现
  // 为"右键复制 + 右键粘贴同时触发，粘贴的是上一次别处复制的内容"。应用层
  // 无能力阻止终端发字节，但可以：在 right-up 触发复制后 arm paste-swallow
  // 窗口（默认 250ms，覆盖 stdin→paste-event 的解析延迟）；usePaste 收到
  // PasteEvent 时若在 arm 窗口内 → event.preventDefault() 吞掉，不进
  // setInputValue。窗口外（用户主动 Cmd+V）保持原行为不变。
  const pasteArmedUntilRef = useRef<number>(0);

  // ── 流式草稿（单会话 in-flight 时挂，bg 由落盘刷新获得终稿）─────
  const [streamDraft, setStreamDraft] = useState<StreamDraft | null>(null);
  const [draftsMasked, setDraftsMasked] = useState<string>("");
  const [thinkingDraftMasked, setThinkingDraftMasked] = useState<string>("");
  // 最近一次 turn 的 thinking 最终秒数（turn 结束快照）。供历史消息末条
  // assistant 折叠行显示「思考了 N 秒」留存。**未按会话 key**：仅显示末条
  // assistant 的留存，且与 mode 行 Crunched 同 turn 写入（同 runTurnOnce
  // finally），非本 turn 不会读到；切换会话后末条 assistant 仍会带旧 turn
  // 的 thinking 秒数（已知限制，未做归属校验，与原实现一致）。
  const [lastThinkingSeconds, setLastThinkingSeconds] = useState(0);
  // thinking 冻结秒数（answer 开始时刻快照）：思考结束、进入 answer 输出后，
  // 折叠行从「思考中…」切「思考了 N 秒」。存 **ref** —— tick 是异步
  // interval，runTurnOnce 的 finally 读的是旧闭包（stale closure 会读到 0）；
  // ref 是可变引用，finally 永远读到最新冻结值。首次冻结后不再覆盖（防
  // answer 阶段虚涨），由 runTurnOnce 入口清 0。计时起点 = 首条
  // thinking_delta（惰性打点，stream-draft 内部），冻结值 = 纯思考时长
  // （2026-08-14 语义修正，不含 turn 启动等待时段）。
  const thinkingFrozenRef = useRef(0);
  // 渲染用镜像（ref 不触发重渲染，UI 需 state）。frozen>0 时 ChatView 显示
  // 「思考了 N 秒」，否则按静态「思考中…」（无实时秒数，PR 1 后）。
  const [thinkingFrozenSeconds, setThinkingFrozenSeconds] = useState(0);
  // 运行时长统计（mode 行右侧实时秒数）：turn 开始打点、运行中 1Hz 递增、
  // turn 结束冻结。runStartedAt 非空 = 运行中（mode 行显示 `· Xs`）；
  // 置 null = 结束（mode 行清空，统计移到消息流末尾 Crunched 行）。
  const [runStartedAt, setRunStartedAt] = useState<number | null>(null);
  const [runElapsed, setRunElapsed] = useState(0);
  // #358 T7: 子代理只读投影 (host = bridge.listSubagents)。初始空数组 —
  // 第一帧前不调用 bridge,watch 派生恒 false 不启表。
  const [subagents, setSubagents] = useState<ReadonlyArray<SubagentInfo>>([]);
  // 最近一次完成 turn 的会话归属 + 快照秒数。runTurnOnce 入口清空（运行中
  // 不显示上次总结），finally 写入；ChatView 仅在 `crunchedOf === activeKey`
  // 时接收 crunchedSeconds，避免跨会话错配（跟旧 runStatsOf 同款所有权校验）。
  const [crunchedOf, setCrunchedOf] = useState<string | null>(null);
  const [crunchedSeconds, setCrunchedSeconds] = useState(0);
  useEffect(() => {
    if (streamDraft === null) {
      setDraftsMasked("");
      setThinkingDraftMasked("");
      setThinkingFrozenSeconds(0);
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
    // tick 现仅负责 answer 开始时刻的冻结快照：thinking 进行中（thinkingRaw
    // 非空）→ answer 已开始（masked 非空）→ 冻结秒数一次（ref，不再覆盖，
    // 防 answer 阶段虚涨）。流式折叠行无实时秒数（PR 1 后 formatThinkingLive
    // 恒 `思考中…`），故不再有每秒递增的分支。
    const tick = setInterval(() => {
      if (
        streamDraft.thinkingRaw().length > 0 &&
        streamDraft.masked().length > 0 &&
        thinkingFrozenRef.current === 0
      ) {
        const frozen = streamDraft.thinkingSeconds();
        thinkingFrozenRef.current = frozen;
        setThinkingFrozenSeconds(frozen);
      }
    }, 1000);
    return () => {
      clearInterval(tick);
      unsubscribe();
    };
  }, [streamDraft]);

  // ── 退出 / 打断 / inflight 簿记 ────────────────────────────────
  const aborters = useRef(new Map<string, AbortController>());
  const inflightPromises = useRef(new Set<Promise<unknown>>());
  // #548:手动压缩专属 AbortController — 与 turn 的 `aborters` map 解耦
  // (turn 中断 ↔ 压缩中断两条独立通道)。同一时刻仅一个 /compact 路径在
  // 飞(活跃会话只有一个),所以 ref 单槽足够。Esc/Ctrl+C handler 在
  // `canInterrupt(active)` 兜底之前先看此 ref 是否非空,是 → 走压缩取消;
  // re-entry 护栏(防止 /compact 重复触发)同样看此 ref(同步源,无 React
  // commit 竞态;Standards review Low#4 修复)。
  const compactingControllerRef = useRef<AbortController | null>(null);
  const viewRef = useRef<TuiView>(view);
  viewRef.current = view;
  // #343 间歇性回归根因（v2 修复）：OpenTUI 在 mouse down 上若 defaultPrevented
  // 为 false 会自动 clearSelection()（chunk-bun-8fkgaxc6.js:9109）。当 right-down
  // 落在 (a) hitTest miss 区域或 (b) 子节点 stopPropagation 链路时，preventDefault
  // 错过回写——clearSelection 先把每个 touchedRenderable 的本地选区 reset，再把
  // currentSelection 置 null。handleMouseUp 再读 getSelection() → null → 报「无
  // 选区」。v1 (ref<Selection|null>) 抓 Selection 对象引用避开了 null 分支，但仍
  // 走「选中区域为空。」——因为 Selection 内部的 _selectedRenderables 还指向那
  // 些已被 reset 的 renderable，getSelectedText 返回 ""。
  // v2 改成值类型缓存：监听 OpenTUI 的 "selection" 事件（left-drag-RELEASE 时
  // emit，那时 finishSelection 刚走完 notifySelectablesOfSelectionChange、每条
  // touchedRenderable 的本地选区都还活着），那一刻就把 text 字符串抽出来塞进
  // ref。字符串是值类型，clearSelection 改不到。right-up 直接读字符串拷贝。
  const cachedSelectionTextRef = useRef<string>("");
  useSelectionHandler((selection: Selection) => {
    // OpenTUI 在 left-drag-RELEASE 时 emit "selection"，那时 finishSelection
    // 刚跑完 notifySelectablesOfSelectionChange，每条 touchedRenderable 的本
    // 地选区都还活着。立刻把 text 字符串抽出来塞进 ref —— 字符串是值类型，
    // 后续任何 clearSelection 都改不到。
    cachedSelectionTextRef.current = selection.getSelectedText();
  });

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
  // #343 修复：调用 OSC52 前必须先问 renderer.isOsc52Supported()——部分
  // 终端（出于安全策略）会忽略 OSC52 字节但 copyToClipboardOSC52 仍返回
  // true，导致「已复制」notice + 空剪贴板。先 gate 掉，避免盲信原生返回值。
  const doCopy = useCallback(
    async (text: string): Promise<CopyResult> => {
      if (text.length === 0) return { kind: "empty" };
      if (renderer.isOsc52Supported()) {
        let oscOk = false;
        try {
          oscOk = renderer.copyToClipboardOSC52(text);
        } catch {
          oscOk = false;
        }
        if (oscOk) return { kind: "ok", method: "pbcopy" };
      }
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

  /** 右键 down：补一道缓存 + 阻止 OpenTUI 在 down 阶段自动 clearSelection()。 */
  const handleMouseDown = useCallback(
    (e: MouseEvent) => {
      if (e.button === MouseButton.RIGHT) {
        // 双保险路径：
        //   1. 缓存：useSelectionHandler 已在 left-drag-RELEASE 那一刻把 text
        //      字符串塞进 cachedSelectionTextRef；这里再读一次 currentSelection
        //      把 text 写一遍 —— 兜底"selection 事件没 emit"或"currentSelection
        //      还没被清掉"的场景（比如现有测试直接给 currentSelection 赋值）。
        //   2. preventDefault：阻止 OpenTUI 默认行为（chunk-bun-8fkgaxc6.js:9109：
        //      !event?.defaultPrevented && down && currentSelection → clearSelection()）。
        const live = renderer.getSelection();
        if (live) {
          const text = live.getSelectedText();
          if (text.length > 0) cachedSelectionTextRef.current = text;
        }
        e.preventDefault();
      }
    },
    [renderer]
  );

  /** 右键 up 时复制缓存的选区文本（useSelectionHandler 已提前抽取）。 */
  const handleMouseUp = useCallback(
    (e: MouseEvent) => {
      if (e.button !== MouseButton.RIGHT) return;
      const text = cachedSelectionTextRef.current;
      cachedSelectionTextRef.current = "";
      if (text.length === 0) {
        // 缓存为空：要么没拖选过、要么上一次 emit 时 Selection.getSelectedText
        // 本身返回空（比如用户只点了一下没拖）。给具体提示区分两种情况。
        if (renderer.getSelection() === null) {
          setNotice({ lines: ["无选区：先按住鼠标左键拖选文本。"] });
        } else {
          setNotice({ lines: ["选中区域为空。"] });
        }
        return;
      }
      void doCopy(text).then((result) => setNoticeFromCopyResult(text, result));
      // arm paste-swallow 窗口：right-up 触发的"复制"几乎与终端的 paste-byte
      // 同步到达 stdin，应用层不能阻止终端发字节，但能在 usePaste 收到事件时
      // 吞掉。250ms 覆盖 stdin 解析→_internalKeyInput 派发→usePaste handler
      // 触发的全程；超过 250ms 用户主动 Cmd+V 不受影响。
      pasteArmedUntilRef.current = Date.now() + 250;
      renderer.clearSelection();
    },
    [renderer, doCopy]
  );

  usePaste((event) => {
    // v3 paste-swallow：right-up 触发的复制会在 250ms 内伴随终端发出的 paste
    // 字节（paste 的是 OSC52 覆盖前的旧系统剪贴板内容，不是当前选区）。在
    // arm 窗口内到达的 paste 一律吞掉，不进 setInputValue。窗口外（用户主动
    // Cmd+V / Shift+Insert）保持原行为不变。
    if (Date.now() < pasteArmedUntilRef.current) {
      // 显式 preventDefault 也喂给下游（即便没有 renderable listener 也保持
      // 语义清晰：这是我们主动拒绝的粘贴事件）。
      event.preventDefault();
      pasteArmedUntilRef.current = 0;
      return;
    }
    // B01 fix：单源化 paste 路径。preventDefault 阻断 textarea native
    // handlePaste（InternalKeyHandler.emitWithPriority 在 defaultPrevented
    // 时跳过 renderable listener）。同一 paste 事件若 path A 与 path B
    // 双驱动改 inputValue（外置语音输入一次吐多段时）：
    //  - path A functional updater (prev+text) 与 path B direct setInputValue
    //    (ta.plainText) 跨 React 18 commit 周期错位 → 中间段被吞；
    //  - useEffect[props.value] 反复 setText 重置 buffer（prompt-input.tsx:151）
    //    → 跨 commit 的 buffer 中途状态被 overwrite → 错位覆盖。
    // 现在 path A 单源 → setInputValue(prev+text) 顺序稳定 → render → effect
    // → ta.setText(props.value) 走程序写入路径，与 history/tab/rewind/submit
    // 同一口径，由 navValueRef 守卫拦截 textarea 回放不产生回环。
    event.preventDefault();
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
        // #358 T7: legacy 路径（无 toolUseId 的字符串事件）统一走
        // formatLiveToolEvent SSOT——spawn_subagent / subagent_result 借此命中
        // 子代理专属 glyph 分支（▣/✓/✗ + 子代理标签）；detail 空时输出
        // `${name} · ok`，替代旧实现 `name  [ok]` 的残缺模板（对齐
        // tool-summary.ts:341 字节规则）。传 cols 让 detail 按视觉宽度收口。
        setLiveToolLines((prev) => ({
          ...prev,
          [event.conversationId]: [
            ...(prev[event.conversationId] ?? []),
            formatLiveToolEvent({
              toolName: event.toolName,
              input: event.input,
              kind: event.kind,
              cols,
            }),
          ],
        }));
      }),
    [props.toolEventSink, cols]
  );

  // ── 派生：active 会话 + 输入候选 + permissionIndex/active ──────
  const active = sessions[activeKey] ?? initial;
  // 1Hz 运行时 tick：running-fg 且已打点 → 递增 runElapsed（与 thinking 秒数
  // tick 同纪律——只读 ref/state，不触发额外 setState 风暴）。
  useEffect(() => {
    if (active.runState !== "running-fg" || runStartedAt === null) return;
    const tick = setInterval(() => {
      setRunElapsed(Math.floor((Date.now() - runStartedAt) / 1000));
    }, 1000);
    return () => clearInterval(tick);
  }, [active.runState, runStartedAt]);
  // #358 T7: 子代理 watch 派生 — 轮询窗口 = running-fg OR 活跃子代理 OR
  // 终态保留窗口内（failed 走 FAILED_VISIBLE_WINDOW_S×1000，completed 走
  // DONE_FADE_WINDOW_S×1000 —— 均从 SubagentPanel 同源导入，避免双编码）。
  // 终态窗口过后 subagents 数组仍可能保留该条但 Date.parse 距 now > 窗口 →
  // hasRecentEndedSubagent=false → subagentWatch=false → effect cleanup 停表,
  // 不浪费 1Hz 轮询。
  const hasLiveSubagent = subagents.some(
    (s) => s.state === "starting" || s.state === "running"
  );
  const hasRecentEndedSubagent = subagents.some((s) => {
    if (s.endedAt === undefined) return false;
    const ageMs = Date.now() - Date.parse(s.endedAt);
    return s.state === "failed"
      ? ageMs < FAILED_VISIBLE_WINDOW_S * 1000
      : ageMs < DONE_FADE_WINDOW_S * 1000;
  });
  const subagentWatch = hasLiveSubagent || hasRecentEndedSubagent;
  // 1Hz 子代理轮询:running-fg 或 watch=true → 拉 bridge.listSubagents()。
  // 无 manager(ask surface)→ listSubagents 恒空数组,watch 恒 false,不启表;
  // running-bg 时若仍有活跃 / 未过期终态子代理（watch=true）也启表——
  // chat 视图下面板需要最新 subagents 投影（runElapsed/ageSec 每秒跳变），
  // list/mcp 视图下面板不渲染但轮询开销 1Hz 且仅 watch=true 时承担。
  useEffect(() => {
    if (active.runState !== "running-fg" && !subagentWatch) return;
    const tick = setInterval(() => {
      setSubagents(props.bridge.listSubagents());
    }, 1000);
    return () => clearInterval(tick);
  }, [active.runState, subagentWatch, props.bridge]);
  // #337 Phase C：skillCatalog 可选（缺省 = 空清单）；available() = 非 disabled
  // + 有 description、名字序。slash 候选混显「静态命令 + skill」。
  const skillCatalog = props.skillCatalog ?? emptySkillCatalog;
  const skillList = useMemo(() => skillCatalog.available(), [skillCatalog]);
  const inputHintSuggestions = useMemo<ReadonlyArray<SlashCandidate>>(() => {
    if (!inputValue.trim().startsWith("/")) return [];
    return slashSuggestions(inputValue, skillList);
  }, [inputValue, skillList]);
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
  // #358 T7: 子代理工具对称 —— activeToolName 若是子代理工具（spawn_subagent /
  // subagent_result，activeToolNameOf 派生）→ ContextBar 尾缀显示
  // `▣ 子代理`（subagentDisplayMark/SUBAGENT_TOOL_LABEL 与 tool-summary 同源，
  // 与 live-tool-preview 子代理形态一致）。
  const activeToolLabel =
    activeToolName !== undefined && isSubagentTool(activeToolName)
      ? `${subagentDisplayMark("running")} ${SUBAGENT_TOOL_LABEL}`
      : activeToolName;

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

  // ── #361 Phase D：/mcp 看板数据（首次进入拉一次，reload 后刷新）──────
  const [mcpStatuses, setMcpStatuses] = useState<readonly McpServerStatus[]>(
    () => props.mcp?.status() ?? []
  );
  const [mcpTools, setMcpTools] = useState<readonly McpToolEntry[]>(
    () => props.mcp?.listMcpTools?.() ?? []
  );
  async function enterMcpView(): Promise<void> {
    if (!props.mcp) {
      setNotice({ lines: ["MCP 未装配（buildTuiDeps 未注入 mcp 扩展）。"] });
      return;
    }
    // 看板首次进入拉一次最新（status + 全量工具），保留缓存避免重拉。
    setMcpStatuses(props.mcp.status());
    setMcpTools(props.mcp.listMcpTools?.() ?? []);
    setView("mcp");
  }
  async function reloadMcpView(): Promise<void> {
    const ext = props.mcp;
    if (!ext) return;
    try {
      await ext.reload();
    } catch (err) {
      setNotice({ lines: [`MCP 重载失败：${describeError(err)}`] });
    }
    // reload 后工具集变化（unregister + register）→ 刷新状态与工具列表。
    setMcpStatuses(ext.status());
    setMcpTools(ext.listMcpTools?.() ?? []);
  }
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
    // 新草稿从空输入历史起（不继承上一草稿的 ↑ 召回 —— 提交 remap 时 DRAFT
    // 键已复位为 []，这里与之一致，防 /new 泄漏上一草稿历史）。
    setInputHistories((prev) => ({ ...prev, [DRAFT_SESSION_ID]: [] }));
    setActiveKey(DRAFT_SESSION_ID);
    setView("chat");
    setNotice(undefined);
    setRewindTargets(undefined);
    setRewindConfirming(false);
    setRewindIndex(0);
    setThinkingPickerOpen(null);
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
        const attached = attachSession(file);
        setSessions((prev) => ({ ...prev, [id]: attached }));
        // 首次 attach 顺带播种输入历史（transcript 投影，↑ 召回立即可用）；
        // 已加载过的会话（existing 分支）map 已有 key 不重播——保留本进程内
        // 的追加项（重播会把 seed 复位、吞掉切走前未落盘的提交）。
        setInputHistories((prev) =>
          prev[id] === undefined
            ? { ...prev, [id]: seedInputHistory(attached.messages) }
            : prev
        );
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
    setThinkingPickerOpen(null);
  }

  // ── turn 发送 ───────────────────────────────────────────────────
  // #377 项 D（#337 Phase C 决定撤销）：echo 与发送文本可分离 —— displayText
  // 控制用户可见会话中的临时代理，text 仍原样经 run() 进模型历史。skill-load
  // 路径传 displayText 为「[加载技能 X] [remainder]」精简占位，避免技能正文
  // 泄漏进会话显示。turn 结束 turnFinished 用落盘权威消息原子替换中间态——
  // skill-load 会话仍会显示完整正文（落盘历史可见），这是用户接受的取舍：
  // 运行中可见精简占位，完成后与会话文件一致。
  async function sendTurn(text: string, displayText?: string): Promise<void> {
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
      // 输入历史随会话 remap 迁到新 key：提交 append 发生在 remap 前的
      // DRAFT_SESSION_ID 名下，不迁移则 ↑ 历史在首条消息建档瞬间清空。
      // DRAFT 键复位为 []（后续 /new 新草稿从空历史起，不继承上一草稿）。
      setInputHistories((prev) => {
        const draftHistory = prev[DRAFT_SESSION_ID];
        if (draftHistory === undefined) return prev;
        if (prev[conversationId as string] !== undefined) return prev;
        return {
          ...prev,
          [conversationId as string]: draftHistory,
          [DRAFT_SESSION_ID]: [],
        };
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
        [targetId]: userMessageEchoed(
          turnStarted(current),
          displayText ?? text
        ),
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
    let interrupted: boolean | undefined;
    const draft = createStreamDraft();
    setStreamDraft(draft);
    // 运行时长打点：turn 起始时刻（mode 行统计段「运行中」实时递增用）。
    // 注意与思考秒数区分：运行时长 = turn 起点 → turn 结束（含等待 / 工具），
    // 思考秒数由 stream-draft 首条 thinking_delta 惰性打点起算（纯思考时长，
    // 不含 turn 启动等待 —— 2026-08-14 语义修正，见 stream-draft.ts 注释）。
    const startedAt = Date.now();
    setRunStartedAt(startedAt);
    setRunElapsed(0);
    // 本 turn 独立 thinking 冻结会话：清 ref（tick 首次冻结时重写）。
    thinkingFrozenRef.current = 0;
    setThinkingFrozenSeconds(0);
    // 清掉上次总结：新 turn 开始后流末尾不再显示旧总结（app 层 ↔ chat-view
    // 通过 crunchedOf 归属校验）。
    setCrunchedOf(null);
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
      if (event.type === "tool_input_delta") {
        setLiveToolRuns((prev) => ({
          ...prev,
          [targetId]: liveToolReduce(prev[targetId] ?? [], {
            kind: "tool_input_delta",
            id: event.id,
            partialJson: event.partialJson,
          }),
        }));
      }
      if (event.type === "stop_summary") {
        setNotice({ lines: [event.text] });
      }
    };
    try {
      // thinking override gate：仅当用户实际改了状态才透传（初始化即 env
      // 默认 → 不透传，走 stub-model 测试的 cached deps 路径；用户 /thinking
      // /effort 改了 → 透传 per-turn override）。决策逻辑见 thinking-gate.ts
      // computeThinkingOverride（纯函数，已单测）。
      const thinkingOverride: WireThinkingOverride | undefined =
        computeThinkingOverride(
          props.defaultThinking,
          thinkingEnabled,
          thinkingEffort
        );
      const resp = await props.bridge.postMessage({
        conversationId: targetId,
        text,
        signal: controller.signal,
        onStream,
        ...(thinkingOverride ? { thinking: thinkingOverride } : {}),
      });
      stopReason = resp.stopReason;
      lastUsage = resp.lastUsage;
      // B1: 打断反馈 —— cancelled 时 bridge 透传 true/false;非 cancelled
      // (completed 等) → undefined,notice 分支只对 cancelled 生效。
      interrupted = resp.interrupted;
    } catch (err) {
      stopReason = "protocolError";
      setNotice({ lines: [`turn 失败：${describeError(err)}`] });
    } finally {
      aborters.current.delete(targetId);
      // 快照本次 turn 的 thinking 最终秒数（reset 会置 0，必须先取）。
      // 留存到历史消息 thinking 折叠行「思考了 N 秒」，thinking 结束后不消失。
      // 优先用 thinking 冻结值（ref —— 异步 finally 读最新值，无 stale closure；
      // answer 开始时刻，精确对应「思考结束」）；无冻结（turn 在 answer 前结束，
      // 如 abort）→ 回落 draft 现值。finalThinkingSeconds 恒写入（含 0）——
      // 防子秒 thinking 的 turn 继承上一 turn 残留秒数。
      const finalThinkingSeconds =
        thinkingFrozenRef.current > 0
          ? thinkingFrozenRef.current
          : draft.thinkingSeconds();
      draft.reset();
      setStreamDraft(null);
      thinkingFrozenRef.current = 0;
      setThinkingFrozenSeconds(0);
      setLastThinkingSeconds(finalThinkingSeconds);
      // 运行时长冻结：turn 结束精确值（含工具耗时尾段，tick 可能未覆盖）。
      // crunchedOf = 归属会话 id —— 只有当前 active 会话等于它时 ChatView
      // 才接收 crunchedSeconds（消息流末尾 Crunched 行），避免跨会话错配。
      const finalRunSeconds = Math.max(
        0,
        Math.floor((Date.now() - startedAt) / 1000)
      );
      setRunElapsed(finalRunSeconds);
      setRunStartedAt(null);
      setCrunchedOf(targetId);
      setCrunchedSeconds(finalRunSeconds);
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
        // B1: interrupted=true → checkpoint 已保存(delta>0);false → 无新内容
        // 未落 checkpoint(delta=0);undefined → 旧链路 / 未知,保留兜底文案。
        setNotice({
          lines:
            interrupted === true
              ? ["已打断，checkpoint 已保存"]
              : interrupted === false
                ? ["已打断（无新内容，未落 checkpoint）"]
                : ["已打断当前 turn"],
        });
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

  /** Ctrl+O：折叠态翻转（thinkingExpanded），语义与 /thinking 开关无关。 */
  function toggleThinkingFold(): void {
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
    // #337 Phase C：/skill-name [提示词] 精确命中 → 确定性 skill-load 发送
    // （静态命令优先：parseSkillLoad 命中词表返回 undefined，落回原分流）。
    if (skillList.length > 0) {
      const skillLoad = parseSkillLoad(text, skillList);
      if (skillLoad !== undefined) {
        const entry = skillCatalog.get(skillLoad.name);
        if (entry === undefined || entry.disabled) {
          setNotice({
            lines: [`技能 ${skillLoad.name} 不可用（已禁用或不存在）。`],
          });
          return;
        }
        try {
          const body = await createSkillBody({ entry, dir: entry.dir });
          const sendText = `[skill-load name="${skillLoad.name}"]\n${body}${
            skillLoad.remainder.length > 0 ? `\n\n${skillLoad.remainder}` : ""
          }`;
          // #377 项 D：发送文本含技能正文（进模型历史确定性生效），显示形态
          // 用精简占位 —— 用户会话中只见「[加载技能 X] [remainder]」，正文不
          // 泄漏。turn 完成后落盘权威消息原子替换（正文可见于会话文件）。
          const displayText = `[加载技能 ${skillLoad.name}]${
            skillLoad.remainder.length > 0 ? ` ${skillLoad.remainder}` : ""
          }`;
          setNotice(undefined);
          await sendTurn(sendText, displayText);
        } catch (err) {
          setNotice({ lines: [`加载技能失败：${describeError(err)}`] });
        }
        return;
      }
    }
    const parsed = parseTuiInput(text);
    if (parsed.kind === "message") {
      // 真实消息进历史（避免 y/n / slash / busy-guard 消息污染）；按当前
      // activeKey 落账（per-session 隔离，appendInputHistory 空白跳过 +
      // 相邻去重、无变化返回原引用）。
      if (!askPending && active.runState === "idle" && parsed.text.length > 0) {
        setInputHistories((prev) => ({
          ...prev,
          [activeKey]: appendInputHistory(prev[activeKey] ?? [], parsed.text),
        }));
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
      case "mcp": {
        await enterMcpView();
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
        setNotice({
          lines: helpLines(
            skillList.length > 0
              ? skillList.map((entry) => entry.name)
              : undefined
          ),
        });
        return;
      case "info": {
        setNotice({
          lines: infoLines(active, activeKey, props.bridge.contextWindow, {
            enabled: thinkingEnabled,
            effort: thinkingEffort,
          }),
        });
        return;
      }
      case "thinking": {
        // design-25 picker（双面板版）：/thinking 打开纯开关面板（ON/OFF），
        // 不设 notice（面板本身即反馈）。seed 自当前 thinkingEnabled；Enter/
        // Space/Tab 翻转预览、Esc 保存退出写 thinkingEnabled。不碰 effort。
        setThinkingPickerOpen("thinking");
        setSwitchPreview(thinkingEnabled);
        return;
      }
      case "effort": {
        const level = parseEffortLevel(text);
        // design-25 picker（双面板版）：/effort 打开纯档位面板。有合法档参 →
        // 打开并直接固定该档（Enter 预览亦可移档、再固定）；无参 → 打开面板
        // seed 当前已提交档（用户点名：/effort 无参也要打开面板）；仅当输入了
        // 非法 concrete 档（如 /effort auto）才走 notice 提示可用档位。
        if (level === undefined && effortHasArg(text)) {
          setNotice({
            lines: [
              `当前：${
                thinkingEnabled ? "自适应" : "off"
              }（档位：${formatEffortLabel(
                thinkingEffort
              )}）/ 可用：${ADJUSTABLE_EFFORT_LEVELS.join(
                " "
              )} / 用法：/effort <level>`,
            ],
          });
          return;
        }
        const seed = level ?? thinkingEffort; // 无参 → seed 当前已提交档
        setThinkingPickerOpen("effort");
        // auto 态 seed：无参且当前是自适应（thinkingEffort=""）→ autoOn=true
        // （面板灰显自适应态，Esc 保持 auto 写 ""）；显式档位 → autoOn=false。
        setEffortAutoOn(seed === "");
        setEffortFocusIndex(effortToDisplayIndex(seed));
        setEffortFixedIndex(effortToDisplayIndex(seed)); // /effort <level> 直接固定该档
        return;
      }
      case "compact": {
        if (active.runState !== "idle") {
          setNotice({
            lines: ["当前会话正在运行；压缩等本轮结束后再执行。"],
          });
          return;
        }
        // #548:防止压缩未结束前重复触发(压缩期间 runState 仍 idle,既有 gate
        // 拦不住;用 ref 作同步守护,React state 会有一帧 commit 滞后)。
        if (compactingControllerRef.current !== null) {
          setNotice({
            lines: ["压缩进行中；按 Esc 取消或等待完成。"],
          });
          return;
        }
        const targetId = active.conversationId;
        if (targetId === undefined) {
          setNotice({ lines: ["当前是空会话，还没有可压缩的上下文。"] });
          return;
        }
        // #548:创建专属 AbortController(Esc/Ctrl+C 通过 compactingControllerRef
        // 触发 abort) + observer(透传 compaction_* 进度事件 + compaction_text_delta,
        // 后者经 #550 wrapper 重映射后进入压缩预览,此处只展示 dropped 数与
        // 终态消息,文本预览留作后续 UI 加挂)。progress 期间 notice 实时
        // 刷新,终端事件由 promise resolve 后的最终 notice 接管。
        const compactController = new AbortController();
        compactingControllerRef.current = compactController;
        setNotice({ lines: ["正在压缩上下文…(按 Esc 取消)"] });
        // #548:onStream 内的 compaction_cancelled 事件标记"中途取消"(bridge
        // 返回 compacted=false,与"未达阈值"同形),promise resolve 后据此
        // 选择不同 notice 文案。闭包变量,无需 React state。
        // 注:pre-aborted signal(early-return at full-compact.ts:262)observer
        // 不触发 — response.cancelled 字段兜底(Low #1 修复)。
        let cancelledByUser = false;
        try {
          const compactResult = await props.bridge.compactSession(targetId, {
            signal: compactController.signal,
            onStream: (event) => {
              switch (event.type) {
                case "compaction_started":
                  setNotice({
                    lines: [
                      `正在压缩上下文（${event.droppedCount} 条）…(按 Esc 取消)`,
                    ],
                  });
                  return;
                case "compaction_cancelled":
                  cancelledByUser = true;
                  return;
                case "compaction_completed":
                case "compaction_failed":
                case "compaction_text_delta":
                  // 终态/失败细节由 promise resolve 后的最终 notice 接管;
                  // compaction_text_delta 留作 UI 加挂点(tracer bullet 仅接住,
                  // 不渲染,以免主面板污染)。
                  return;
                default:
                  return;
              }
            },
          });
          const compacted = compactResult.compacted;
          // Low #1 兜底:pre-aborted signal 路径 observer 不触发 → 用
          // response.cancelled 兜底。
          if (compactResult.cancelled) cancelledByUser = true;
          if (cancelledByUser) {
            // #548:Claude Code 取消语义 — 会话保持原样,不 sessionCompacted
            // 投影(updatedAt / messages 均不变),仅提示用户。
            setNotice({
              lines: ["压缩已取消，会话保持原样。"],
            });
          } else if (compacted) {
            // 实际裁剪完成 → 重读落盘文件 + sessionCompacted 投影。
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
              lines: ["已压缩上下文（保留尾部，裁剪早期消息）。"],
            });
          } else {
            setNotice({
              lines: ["上下文未达压缩阈值，无需压缩。"],
            });
          }
        } catch (err) {
          setNotice({ lines: [`压缩失败：${describeError(err)}`] });
        } finally {
          compactingControllerRef.current = null;
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

  // ── 反向持久化（T4，settings 双向通道） ────────────────────────────────
  /**
   * 把面板 commit 的 payload 交给 props.onPersistThinking 写回 settings.json。
   * fire-and-forget（不 await、不阻塞面板 state 更新 —— Esc 保存退出已生效）；
   * 失败（reject 或返回 { ok:false }）→ notice 呈现，in-memory override 保留
   * （本次会话仍有效）。成功静默（面板 Esc 本身即反馈，写回是后台行为）。
   * payload null（committedThinkingPatch 防御分支，当前 union 无此路径）→ no-op。
   */
  function persistThinkingFromCommit(
    patch: CommittedThinkingPatch | null
  ): void {
    if (patch === null || props.onPersistThinking === undefined) return;
    void props.onPersistThinking(patch).then(
      (res) => {
        if (!res.ok) {
          setNotice({
            lines: [
              `思考设置已生效（本次会话），但写回 settings.json 失败：${res.reason}`,
            ],
          });
        }
      },
      (err) => {
        setNotice({
          lines: [
            `思考设置已生效（本次会话），但写回 settings.json 失败：${
              err instanceof Error ? err.message : String(err)
            }`,
          ],
        });
      }
    );
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
      // #548:压缩进行中 → 走压缩取消通道(runState 仍 idle,既有
      // canInterrupt 拦不住);return 后不再进 turn/notice 分支。
      if (compactingControllerRef.current !== null) {
        compactingControllerRef.current.abort();
        return;
      }
      // #343 v3 follow-up：选区优先复制 —— 用户在拖选后按 Ctrl+C，意图是
      // 复制当前选区（与右键复制同源语义），而不是打断 turn。压缩取消保持
      // 最高优先级（用户主动 /compact 的明确意图），其他场景下有选区 →
      // 复制 + return（不打断 turn、不发"无前台运行"notice）；清 ref 走
      // handleMouseUp 同款尾清理。text 为空 → 走原打断/notice 路径。
      const selectedText = cachedSelectionTextRef.current;
      if (selectedText.length > 0) {
        cachedSelectionTextRef.current = "";
        void doCopy(selectedText).then((result) =>
          setNoticeFromCopyResult(selectedText, result)
        );
        return;
      }
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
    // Ctrl+O：切换思考面板折叠态（展开/折叠）。toggleThinkingFold 只翻折叠，
    // 与 /thinking 的开关（thinkingEnabled）解耦。
    if (e.ctrl && e.name === "o") {
      toggleThinkingFold();
      return;
    }
    // design-25 thinking-picker（双面板版）：picker 活跃时独占键位。优先级纪律
    // （spec §0）：Ctrl 组合（含 Ctrl+O/Ctrl+C）> picker > rewind > 双 Esc >
    // ask modal。本分支插在 Ctrl 分支之后、rewind 分支之前 —— ctrl/meta 组合由
    // reducer 判 ignore 不吞（Ctrl+C/O 照常到 app 层）。交互语义（SSOT）：
    // Enter 固定（面板保持打开，可继续调）、Esc 保存退出（写入真实 state，无
    // cancel 路径）。
    if (thinkingPickerOpen === "thinking") {
      const action = reduceThinkingSwitchKey(modalKeyEventOf(e));
      switch (action.type) {
        case "toggle":
          // Space/Tab：翻转面板内开关预览，面板保持打开。
          setSwitchPreview((prev) => !prev);
          break;
        case "fix":
          // Enter：固定当前预览（无翻转、面板保持打开）——「回车选定后固定而不
          // 是退出」。开关面板只有 ON/OFF 两态，fix 即确认当前预览值，无需改
          // switchPreview；写不写都在 Esc 时落盘。
          break;
        case "commit":
          // Esc：把面板内已固定值写真实 thinkingEnabled，然后关闭。
          setThinkingEnabled(switchPreview);
          setThinkingPickerOpen(null);
          // 反向持久化（T4）：fire-and-forget —— 不阻塞面板 state 更新，
          // 失败以 notice 呈现（in-memory override 已生效，本次会话仍有效）。
          void persistThinkingFromCommit(
            committedThinkingPatch({
              kind: "thinking",
              enabled: switchPreview,
            })
          );
          break;
        case "ignore":
          break;
      }
      return;
    }
    if (thinkingPickerOpen === "effort") {
      const action = reduceThinkingEffortKey(modalKeyEventOf(e), {
        focusedIndex: effortFocusIndex,
      });
      switch (action.type) {
        case "move":
          // ←/→：移动焦点游标，面板保持打开。
          setEffortFocusIndex(action.index);
          break;
        case "fix":
          // Enter：把焦点档固定为面板内已提交档，面板保持打开。
          setEffortFixedIndex(effortFocusIndex);
          break;
        case "toggleAuto":
          // Space/Tab：切换自适应 auto 态，面板保持打开。
          setEffortAutoOn((prev) => !prev);
          break;
        case "commit": {
          // Esc：autoOn → 写 ""=自适应（保持 auto，不降级）；否则写已固定 concrete
          // 档。均隐式开思考，然后关闭。
          setThinkingEffort(
            effortAutoOn ? "" : indexToEffort(effortFixedIndex)
          );
          setThinkingEnabled(true); // 隐式开思考（选档即开，spec §0 语义）
          setThinkingPickerOpen(null);
          // 反向持久化（T4）：fire-and-forget —— 不阻塞面板 state 更新，
          // 失败以 notice 呈现（in-memory override 已生效，本次会话仍有效）。
          void persistThinkingFromCommit(
            committedThinkingPatch({
              kind: "effort",
              focusedIndex: effortFocusIndex,
              currentIndex: effortFixedIndex,
              autoOn: effortAutoOn,
            })
          );
          break;
        }
        case "ignore":
          break;
      }
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
      // #548:压缩进行中 → 走压缩取消通道(等同 Ctrl+C 行为);
      // 此分支优先于 running-fg 打断,因为压缩期间 runState 仍 idle,
      // canInterrupt 会落进 double-Esc rewind picker 路径,语义错误。
      if (compactingControllerRef.current !== null) {
        compactingControllerRef.current.abort();
        return;
      }
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
    ? slashSuggestions(inputValue, skillList).length
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
  // design-25 thinking-picker 行账：picker 打开 → thinking 5 行 / effort 7 行
  // + marginBottom 1 并入 chrome 预算（与 modalRows 同款），否则 viewport 高度被挤。
  const pickerRowsForBudget =
    view === "chat" && thinkingPickerOpen !== null
      ? thinkingPickerRows(thinkingPickerOpen)
      : 0;
  // 面板判别联合（渲染槽 + 类型标注共用，SSOT）。
  const pickerState: ThinkingPickerState | null =
    view === "chat" && thinkingPickerOpen !== null
      ? thinkingPickerOpen === "thinking"
        ? { kind: "thinking", enabled: switchPreview }
        : {
            kind: "effort",
            focusedIndex: effortFocusIndex,
            currentIndex: effortFixedIndex,
            autoOn: effortAutoOn,
          }
      : null;
  // T9：输入框行账动态化 —— wrap-aware 视觉折行行数（修 2026-08-14 用户反馈
  // 「输入多少都是一行」：长文本无 `\n` 时按 cols 折行计视觉行数）。封顶由
  // chromeReserveRows 内部做（SSOT 防误传）；超出部分 textarea 内部滚动。
  const inputContentRows = inputWrapLineCount(inputValue, cols);
  // #358 T7: 子代理面板行数投影（ContextBar 下方，最多 4 行）——计入底部
  // chrome 行账，矮终端视口不裁切。非 chat 视图面板不渲染 → 0。
  const subagentPanelRows =
    view === "chat"
      ? projectSubagentLines(subagents, Date.now(), cols).length
      : 0;
  const viewportRows = Math.max(
    5,
    rows -
      chromeReserveRows({
        noticeRows: noticeRenderRows(notice?.lines, cols),
        inputHintRows: hintRows,
        bgLine,
        inputRows: inputContentRows,
        modalRows: modalRowsForBudget,
        pickerRows: pickerRowsForBudget,
        panelRows: subagentPanelRows,
      })
  );
  // 列表视图（ListView 路径）：底部仅 notice 占用，与 headroom 2 行。
  const listViewRows = Math.max(
    5,
    rows - 2 - noticeRenderRows(notice?.lines, cols)
  );
  // #361 Phase D：MCP 看板视图 — 输入框 / mode 行 / ContextBar 均不渲染
  // （view !== "chat"），底部仅 notice 占用 + 空行隔离，与列表同款预算。
  const mcpViewRows = Math.max(
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
      ) : view === "mcp" ? (
        <McpView
          statuses={mcpStatuses}
          tools={mcpTools}
          cols={cols}
          rows={mcpViewRows}
          onReload={reloadMcpView}
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
            lastThinkingSeconds={lastThinkingSeconds}
            thinkingFrozenSeconds={thinkingFrozenSeconds}
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
                ? `[ask]${askPending.network === true ? " [宿主网络]" : ""} 允许 ${askPending.tool}？${
                    askPending.summaryHint ? ` ${askPending.summaryHint}` : ""
                  } 输入 y/a/n（a=总是允许）`
                : undefined
            }
            thinkingExpanded={thinkingExpanded}
            bannerLines={bannerLines}
            crunchedSeconds={
              crunchedOf === activeKey ? crunchedSeconds : undefined
            }
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
      {pickerState !== null && <ThinkingPicker state={pickerState} />}
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
                    network: askPending.network,
                  }
                : undefined
          }
          cols={cols}
        />
      )}
      {view === "chat" && (
        <box flexDirection="row">
          <text fg={permMode === "full_auto" ? pal.running : pal.dim}>
            {cols < 40
              ? `[${permMode === "full_auto" ? "auto" : "def"}]`
              : `mode: ${modeLabel(permMode)}`}
          </text>
          {/* mode 右侧运行中实时显示秒数（`· Xs`，每秒跳）；结束后清空（mode
              行不残留，统计移到流末尾 `Crunched for X` 行）。实时 token 计算
              暂不做（#426 修订：先不上 token 数量计算）。 */}
          {cols >= 40 &&
            active.runState === "running-fg" &&
            runStartedAt !== null && (
              <text fg={pal.dim}>{` · ${formatRunDuration(runElapsed)}`}</text>
            )}
        </box>
      )}
      {view === "chat" && (
        <PromptInput
          value={inputValue}
          cols={cols}
          maxLines={MAX_INPUT_LINES}
          placeholder={
            rewindTargets !== undefined
              ? "回退选择器中（↑↓ 选择 · Enter 确认 · Esc 关闭）"
              : thinkingPickerOpen === "thinking"
                ? "思考开关中（Space 切换 · Enter 固定 · Esc 保存退出）"
                : thinkingPickerOpen === "effort"
                  ? "思考强度中（←/→ 选档 · Tab 自动 · Enter 固定 · Esc 保存退出）"
                  : askPending
                    ? askModalActive
                      ? "modal 键位接管中（Esc 退回输入）"
                      : "y/a/n 确认工具授权（a=总是允许）"
                    : "输入消息或 /help"
          }
          active={active.runState === "running-fg"}
          disabled={
            askModalActive ||
            rewindTargets !== undefined ||
            thinkingPickerOpen !== null
          }
          onChange={setInputValue}
          onSubmit={(v) => void handleSubmit(v)}
          onSelectHint={(candidate) => {
            // #337 Phase C：candidate 为 SlashCandidate 判别联合。
            // 静态命令 → 走 handleSubmit(`/${cmd}`) 原路由（含 /new 等）；
            // skill → 发送 skill-load。hint 可见时 Enter 走本回调而非 onSubmit
            // （PromptInput 语义），故要保留用户已输入的 remainder：若当前
            // inputValue 首 token 精确命中同 skill → 提整个 raw（含 remainder）；
            // 否则（部分输入如 /ec，或 hint 选中非当前 token 的 skill）→
            // 补全 `/name ` 形态发送。
            if (candidate.kind === "command") {
              // 保留用户已输入的 remainder：input 首 token 精确命中同 command
              // （如 /effort high → effort）→ 提整个 raw（含参数）；否则
              // （部分输入如 /q，或 hint 选中非当前 token 的 command）→
              // 补全 `/{cmd}` 形态发送。首 token 复用 slash.ts 的 slashPrefix
              // （reviewer Medium#3：Feature Envy 收敛）。
              const firstTok = slashPrefix(inputValue);
              if (firstTok === candidate.command) {
                void handleSubmit(inputValue);
              } else {
                void handleSubmit(`/${candidate.command}`);
              }
            } else {
              const load = parseSkillLoad(inputValue, skillList);
              if (load !== undefined && load.name === candidate.name) {
                void handleSubmit(inputValue);
              } else {
                void handleSubmit(`/${candidate.name}`);
              }
            }
          }}
          onTabComplete={(value, cursor) => {
            // 高亮非首候选（cursor > 0）→ 按 hint 选中项补全（原
            // length===1 && cursor===0 条件使「选中补全」恒不可达——修复死
            // 代码）；否则唯一匹配补全 / 多匹配最长公共前缀部分补全
            // （slashComplete 三态语义）。
            if (cursor > 0 && inputHintSuggestions.length > 0) {
              return slashCompleteFromCandidates(inputHintSuggestions, cursor);
            }
            return slashComplete(value, skillList);
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
            activeToolName={activeToolLabel}
            model={modelName}
            effortLabel={
              thinkingEnabled ? formatEffortLabel(thinkingEffort) : "off"
            }
          />
        </box>
      )}
      {/* #358 T7: 子代理状态面板（ContextBar 下方）。条件渲染 —
          无可见子代理行时返回 null（行数 0 → chromeReserveRows.panelRows=0）；
          非 null 时行数已计入 chromeReserveRows.panelRows（上面 subagentPanelRows
          派生），矮终端视口不裁切。 */}
      {view === "chat" && <SubagentPanel subagents={subagents} cols={cols} />}
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
  contextWindow: number,
  thinking: { readonly enabled: boolean; readonly effort: ThinkingEffortWire }
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
  // thinking 档位行：off / adaptive (auto) / adaptive (high) 等。effort 空串
  // 且 enabled → "auto"（未显式指定档位）；展示标签复用 formatEffortLabel
  // （reviewer Medium#2：消除 `|| "auto"` 重复）。
  const thinkingLine = thinking.enabled
    ? `thinking: adaptive (${formatEffortLabel(thinking.effort)})`
    : "thinking: off";
  return [
    `conversation_id: ${session.conversationId ?? key}（${
      session.conversationId ? "已建档" : "draft，首条消息后建档"
    }）`,
    `turnCount: ${session.turnCount}`,
    `updatedAt: ${session.updatedAt ? relativeTime(session.updatedAt) : "—"}`,
    `jsonMode: ${session.jsonMode}`,
    `runState: ${session.runState}`,
    ...tokenLines,
    thinkingLine,
  ];
}

/** 后台会话状态行（spec #146 SC5：`后台运行中 · <title>`）。
 *  纯函数可单测：title 为空时回退「后台运行中」（不加尾缀）。 */
export function bgStatusLine(
  messages: ReadonlyArray<AnthropicNativeMessage>
): string {
  const title = extractTitle(messages);
  return title.length > 0 ? `后台运行中 · ${title}` : "后台运行中";
}

function describeError(err: unknown): string {
  if (typeof err === "object" && err !== null && "kind" in err) {
    const kind = String((err as { kind: unknown }).kind);
    return `会话存储错误 [${kind}]`;
  }
  return err instanceof Error ? err.message : String(err);
}
