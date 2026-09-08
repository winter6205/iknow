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
import {
  BACKGROUND_OPERATION_NOTICE,
  BLOCK_OPERATION_NOTICE,
} from "../harness/aci/aci-executor.js";
import type { CompactReason } from "../harness/compress/index.js";
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
  slashHasArg,
  slashPrefix,
  slashRemainder,
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
import {
  MemoryPicker,
  applyMemoryPreviewToggle,
  committedMemoryPatch,
  memoryPickerRows,
  reduceMemoryPickerKey,
  seedMemoryPreview,
  type CommittedMemoryPatch,
} from "./memory-picker.js";
import { computeThinkingOverride, formatEffortLabel } from "./thinking-gate.js";
import {
  continueExitFromError,
  continueNoticeFor,
  isContinueValidationError,
  pendingFromLoadedSession,
  tuiContinueBusy,
} from "./continue-notice.js";
import { shouldTriggerContinueFromNl } from "../session-api/continue-pending.js";
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
// plans/tui-chrome-interaction.md T7：chrome-focus reducer 接线 ——
// `reduceChromeFocus` 拥有 input/subagent(row)/graph 三环焦点（src/tui/
// chrome-focus.ts），reducer 是纯函数，本文件只做组合（T7 验收：wiring
// 只做组合，不长成 god-handler）。`graphChromeFocus`（graph-chrome.ts 旧
// 二态 reducer）只保留 openView 视图层（full-screen GraphGroupView 的
// Open/Close 仍是它的职责；不与三环焦点切换混）。
import { type ChromeFocus, reduceChromeFocus } from "./chrome-focus.js";
import { SubagentIdentityStrip } from "./subagent-identity-strip.js";
// #647 T3 / ADR-0028:agent 现势显示(与 ContextBar 的 context usage 显示是
// 两回事,命名刻意区分)—— 只读 agent_status 流事件的最新一份快照。
import {
  AgentStatusPanel,
  agentStatusFromEvent,
  agentStatusLines,
} from "./agent-status-line.js";
import type { GraphProgressSnapshot } from "../harness/graph/progress.js";
import {
  GraphChromePanel,
  graphChromeRows,
  graphProgressFromEvent,
  reduceGraphChromeFocus,
  type GraphChromeFocus,
} from "./graph-chrome.js";
import { GraphGroupView } from "./graph-group-view.js";
import {
  applyGraphViewKey,
  graphGroupRows,
  selectableNodeIds,
} from "./graph-group.js";
import {
  agentStatusFromMessages,
  type AgentStatusSnapshot,
} from "../harness/agent-status.js";
// #653 G1 T5:环境现势独立 slot —— 与 ADR-0028 状态栏同 chrome 区、并列、
// 平行独立流。EnvironmentPane 不读 ADR-0028 状态栏的事件 / 快照 / 账本
// 读取器(grep 守卫钉死,见 tests/tui/environment-pane.test.tsx)。
import {
  envSnapshotFromEvent,
  worktreeIsolationLines,
} from "./environment-pane.js";
import type { EnvSnapshot } from "../harness/env-snapshot.js";
// #653 包1 T3:TUI verify 闭环终态人读 banner(HITL + auto 双模式 passed /
// failed / unstable / escalated)。wire 已透到 bridge.TuiPostResult.verify;
// 投影 + 渲染壳见 verify-banner.tsx(纯函数可单测)。
import {
  projectVerifyBanner,
  VerifyBannerStrip,
  verifyFromWire,
  type VerifySlot,
} from "./verify-banner.js";
import {
  INPUT_MAX_LINES as MAX_INPUT_LINES,
  inputVisibleLineCount,
  inputWrapLineCount,
  PromptInput,
  type PromptInputHandle,
} from "./prompt-input.js";
// T8 — chromeReserveRows 行账封顶由 INPUT_MAX_LINES（prompt-input SSOT）
// 统一收口，避免 app.tsx 与 prompt-input.tsx 各自持有 "8" 常量导致飘移。
// app 侧本地别名为 MAX_INPUT_LINES（保留原引用语义）+ 重新导出，保证
// 外部 import 表面（tests/tui/*）稳定。
import { renderBannerLines, VERSION } from "./banner.js";
import { copyToClipboard, type CopyResult } from "./clipboard.js";
import {
  isSubagentTool,
  summarizeToolCall,
  formatLiveToolEvent,
} from "./tool-summary.js";
import {
  SubagentPanel,
  FAILED_VISIBLE_WINDOW_S,
  DONE_FADE_WINDOW_S,
} from "./subagent-panel.js";
import type { SubagentInfo } from "../harness/subagent/manager.js";
import { formatRunDuration } from "./run-stats.js";
import { tuiPalette } from "./theme.js";
import { createPermissionModeContext } from "../harness/permission/index.js";
import {
  agentModeLabel,
  applyGraphCommand,
  applyShiftTabAgentModeFlip,
  splitGraphArgs,
  type GraphModeContext,
} from "../harness/graph/mode.js";
import { buildSkillLoadText, createSkillBody } from "../harness/skill/body.js";
import { writeSituation } from "../harness/isolation/write-situation.js";
import type { SkillCatalog } from "../harness/skill/catalog.js";
import type { LiveTaskRoot } from "../harness/session-roots.js";
import {
  createSubagentWake,
  toSubagentWakeError,
  type SubagentWake,
} from "../harness/subagent/host-wake.js";
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
/**
 * plan compress-trigger-gate T4 + review-fix:把 /compact notice 文案决策抽成
 * module-level 纯函数,便于 bun:test 单测覆盖 4 reason 分支(避免 mount
 * 整 TUI 渲染链路 + frozen bridge mock)。函数式 + exhaustiveness 检查
 * (sealed CompactReason union):future 新增 reason 时 TS 编译失败。
 */
export function compactNoticeFor(
  reason: CompactReason,
  compacted: boolean
): readonly string[] {
  if (compacted) {
    // compacted=true 路径:windowed → 保留尾部 + 裁早期;full_summary → 摘要前缀 + 保留尾部。
    switch (reason) {
      case "windowed":
        return ["已压缩上下文（保留尾部，裁剪早期消息）。"];
      case "full_summary":
        return ["已通过结构化摘要压缩上下文（保留尾部 + 摘要前缀）。"];
      case "below_token_threshold":
      case "messages_too_few":
        // 逻辑上 compacted=true 不该拿到这些 reason;列全满足 exhaustiveness。
        throw new Error(
          `unexpected no-op reason in compacted branch: ${reason}`
        );
      default: {
        const _exhaustive: never = reason;
        throw new Error(`unknown compact reason: ${String(_exhaustive)}`);
      }
    }
  }
  // compacted=false 路径:plan manual-compact-trigger T1/T2 — 手动
  // compactSession 不再返回 below_token_threshold(auto token 门仅属
  // proactive 路径),空会话幂等与压缩整体失败共用 messages_too_few,
  // 语义是「没有可压缩的上下文」而非「消息条数过少」。below_token_threshold
  // / 压缩成功 reason 在此分支出现均属契约破坏,抛错而非呈现 auto 阈值文案。
  switch (reason) {
    case "messages_too_few":
      return ["没有可压缩的上下文，会话保持原样。"];
    case "below_token_threshold":
    case "windowed":
    case "full_summary":
      throw new Error(`unexpected reason in manual noop branch: ${reason}`);
    default: {
      const _exhaustive: never = reason;
      throw new Error(`unknown compact reason: ${String(_exhaustive)}`);
    }
  }
}

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
 *   - agent 现势显示（未勾待办单行，agentStatusRows；mode 行上方）
 *   - ask 槽 1 行（ChatView tail 恒预留）
 *   - slash 候选行（inputValue.trim().startsWith("/") ? … : 0）
 *   - notice 本体 + 自身 marginBottom=1
 *   - modal 本体 + 自身 marginBottom=1
 *   - thinking-picker 面板 + 自身 marginBottom=1（pickerRows 同 modalRows 约定）
 *   - 子代理状态面板（ContextBar 下方，不计入 chrome 行账，避免把输入框往上顶）
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
  /** 子代理状态面板行数。产品路径恒 0：面板画在输入框下方，不挤 transcript /
   *   不把输入框往上顶。函数仍接受显式值（单测 / 旧调用兼容）。 */
  readonly panelRows?: number;
  /** agent 现势显示行数（agentStatusLines 实际产出，0-1）。缺省 0 →
   *   不占行（无快照 / 组件渲染 null / 旧行为兼容）。 */
  readonly agentStatusRows?: number;
  /** #653 G1 T5:环境现势独立 slot 行数（envSnapshotLines 实际产出，0-2）。
   *   缺省 0 → 不占行（无事件 / 组件渲染 null / 旧行为兼容）。 */
  readonly envPaneRows?: number;
  /** #458 包2 T3:verify 闭环终态 banner 行数（projectVerifyBanner 实际产出，
   *   0 或 1）。缺省 0 → 不占行（无 verify / slot=none → 组件渲染 null）。 */
  readonly verifyRows?: number;
  /** run_graph chrome 一行（0 或 1）。缺省 0 → 无快照不占行。 */
  readonly graphRows?: number;
}): number {
  const inputContentRows = Math.max(
    1,
    Math.min(opts.inputRows ?? 1, MAX_INPUT_LINES)
  );
  const modalRows = opts.modalRows ?? 0;
  const pickerRows = opts.pickerRows ?? 0;
  const panelRows = opts.panelRows ?? 0;
  const agentStatusRows = opts.agentStatusRows ?? 0;
  const envPaneRows = opts.envPaneRows ?? 0;
  const verifyRows = opts.verifyRows ?? 0;
  const graphRows = opts.graphRows ?? 0;
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
    agentStatusRows +
    envPaneRows +
    verifyRows +
    graphRows +
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
  /**
   * D-α V1 / ADR-0030：graph 编排 overlay 的会话 holder。Shift+Tab 三态轮的
   * 第三站与 `/graph on|off` 翻的是同一个它（SC3 三入口同 holder）。缺席 →
   * Shift+Tab 退化成既有两态 permission 轮，`/graph` 提示未接线（测试 /
   * fixture 兼容；产品路径由 run.tsx 注入）。
   */
  readonly graphMode?: GraphModeContext;
  /** #279 项3：权限 modal「总是允许」落点 — session 层授权登记表。 */
  readonly sessionGrants?: SessionGrants;
  /** 测试注入口：可选初始视图（缺省 chat）。 */
  readonly initialView?: TuiView;
  /** 测试 / mock 注入口：触发 renderer.destroy 的回调；缺省 = no-op。
   *  参数 = 退出时活跃会话的 conversationId（draft 未建档时 undefined），
   *  供宿主在终端恢复后打印 resume 提示。 */
  readonly onQuit?: (conversationId?: string) => void;
  /** #337 Phase C：skill 清单（slash 候选混显 + /skill-name 加载发送）。
   *  可选：缺省 = 空清单（兼容 fixture / 测试；产品路径由 run.tsx 经
   *  TuiExtensions.skillCatalog 注入）。 */
  readonly skillCatalog?: SkillCatalog;
  /** 活 taskRoot cell（specs/skill-load-write-root.md）：slash 装配 skill
   *  正文时调用时机读快照 —— 与 ACI skill() / hub loadSkillBody 同一装配口。
   *  缺省 = undefined → 无 trailer（兼容 fixture / 测试）。 */
  readonly liveTaskRoot?: LiveTaskRoot;
  /** T6 (plans/write-situation-disclosure.md)：worktree 隔离档（来自 build-
   *  engine `isolationEnabled` 单一读取点的透出）。slash 装配 skill 正文时
   * 与 `liveTaskRoot` 配对算 `writeSituation(isolationOn, currentRoot)`，
   * 传给 `createSkillBody` 双参形态（详见 body.ts SkillBodyOptions）。
   * 缺省 = undefined → 等价于隔离 OFF + liveTaskRoot 缺席 → 与改造前
   * byte-equal（旧形态 = writable_main + 无 trailer）。 */
  readonly isolationOn?: boolean;
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
  /**
   * /memory 面板 Esc 写回 settings.memory。可选：缺省 → 仅会话内预览
   * （测试兼容）。live flags 由宿主注入，Esc 时同步改盒内字段。
   */
  readonly onPersistMemory?: (
    patch: CommittedMemoryPatch
  ) => Promise<{ ok: true } | { ok: false; reason: string }>;
  readonly defaultMemory?: {
    readonly autoExtract?: boolean;
    readonly dream?: boolean;
  };
  readonly memoryFlags?: {
    autoExtract: boolean;
    dream: boolean;
  };
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
  // #647 T3 / ADR-0028:TUI 只读最新现势 —— 按会话 key 的最新快照
  // (conversationId → snapshot,liveToolRuns 同款 keyed 形态)。replace-on-event:
  // 事件到达时按「事件所属回合的 conversationId」整体替换该会话槽位,无历史、
  // 无第二份 todo 账本(数据唯一来源是 harness 注入 <agent_status> 栏同一
  // 计算点发出的同一份快照)。渲染只取 active 会话的槽位 → 切走不残留 A 的
  // 现势、切回仍在(end-of-round review Spec Medium 修复)。与 liveToolRuns
  // (in-flight 展示)分开,不混、不回流模型向任何字段。
  const [agentStatuses, setAgentStatuses] = useState<
    Record<string, AgentStatusSnapshot>
  >(() => {
    const id = initial.conversationId;
    if (id === undefined) return {};
    const snapshot = agentStatusFromMessages(initial.messages);
    return snapshot === null ? {} : { [id]: snapshot };
  });
  // #653 G1 T5:环境现势单 state 槽 —— 与 ADR-0028 状态栏平行的独立流。
  // env 不属于会话(全局共享):不按 conversationId 分键,事件到达即整体
  // 替换(replace-on-event,投影产完整独立快照);尚无事件 → null → 面板
  // 不渲染。数据只进本 UI,绝不回流模型向任何字段。
  const [envSnapshot, setEnvSnapshot] = useState<EnvSnapshot | null>(
    () => null
  );
  const [graphProgresses, setGraphProgresses] = useState<
    Record<string, GraphProgressSnapshot>
  >({});
  // plans/tui-chrome-interaction.md T7：chrome-focus 三态焦点（input /
  // subagent(row) / graph），reducer SSOT = reduceChromeFocus。`graphViewOpen`
  // 仍是独立状态（full-screen GraphGroupView 的 open/close，由 graph-chrome
  // 旧 reducer 的 openView 触发；与三环焦点切换正交）。
  const [chromeFocus, setChromeFocus] = useState<ChromeFocus>({
    kind: "input",
  });
  // 旧二态 `graphChromeFocus` 保留：仅用于 graph 全屏视图的 openView 决策
  // （graph chrome 自身的 onTabComplete 旧路径仍存在，详见下方 onLeaveToChrome
  // 改为 reduceChromeFocus）；后续清理时移除。
  const [graphChromeFocus, setGraphChromeFocus] =
    useState<GraphChromeFocus>("input");
  const [graphViewOpen, setGraphViewOpen] = useState(false);
  const [graphSelectedId, setGraphSelectedId] = useState<string | null>(null);
  const [graphNodeDetail, setGraphNodeDetail] = useState(false);
  // #458 包2 T3:verify 终态槽(conversationId → VerifySlot 判别联合)。
  // none = 缺 verify(合法态 → banner 静默);ok = 4 终态;unavailable =
  // wire 形状非法(degraded)。sendTurn 入口清槽(防上一回合判定残留到
  // 下一回合 running 阶段),runTurnOnce 收到 resp 后经 verifyFromWire
  // runtime 校验写入。resume 时 transcript 无 VerifyAnswerView → 槽空,
  // 不从 transcript 复刻第二份账本(与 agent-status 同纪律)。
  const [verifySlots, setVerifySlots] = useState<Record<string, VerifySlot>>(
    {}
  );
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
  const [memoryPickerOpen, setMemoryPickerOpen] = useState(false);
  const [memoryFocusIndex, setMemoryFocusIndex] = useState<0 | 1>(0);
  const [memoryCommitted, setMemoryCommitted] = useState(() =>
    seedMemoryPreview(props.defaultMemory)
  );
  const [memoryPreview, setMemoryPreview] = useState(() =>
    seedMemoryPreview(props.defaultMemory)
  );
  // 档位面板自适应态（/effort）：Space/Tab 切换；Esc 保存退出时 autoOn 优先写
  // ""=自适应（保持 auto，不降级到 concrete）。seed = 当前 thinkingEffort===""
  // → 自适应态（打开 /effort 无参时修复「当前 auto → Esc 静默降 medium」bug）。
  const [effortAutoOn, setEffortAutoOn] = useState<boolean>(
    () => thinkingEffort === ""
  );
  // W2 扩展：权限模式镜像（仅驱动模式指示行 re-render）。
  const [permMode, setPermMode] = useState(() => permissionMode.get());
  // D-α V1：graph overlay 镜像（同上，只驱动模式指示行；权威在 holder）。
  const [graphOn, setGraphOn] = useState(
    () => props.graphMode?.get().enabled ?? false
  );
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
  // paste buffer-first 单真相源：app 层 usePaste 经此句柄直接写原生 textarea
  // buffer（与 keypress 同源），不再走 React state 排队（竞态见
  // tests/tui/input-interleave-race.test.tsx 头注）。
  const promptInputRef = useRef<PromptInputHandle | null>(null);

  // ── 流式草稿（单会话 in-flight 时挂，bg 由落盘刷新获得终稿）─────
  const [streamDraft, setStreamDraft] = useState<StreamDraft | null>(null);
  const [draftSegments, setDraftSegments] = useState<ReadonlyArray<string>>([]);
  const [thinkingDraftMasked, setThinkingDraftMasked] = useState<string>("");
  // 最近一次 turn 的 thinking 最终秒数（turn 结束快照）。供历史消息末条
  // assistant 折叠行显示「思考了 N 秒」留存。**未按会话 key**：仅显示末条
  // assistant 的留存，且与 mode 行 Crunched 同 turn 写入（同 runTurnOnce
  // finally），非本 turn 不会读到；切换会话后末条 assistant 仍会带旧 turn
  // 的 thinking 秒数（已知限制，未做归属校验，与原实现一致）。
  // D3 (tui-display-consistency):整条 TUI 内存思考秒数副通道已删除 ——
  // 不再有 pin / freeze / ref / store-thunk 一组 in-memory 秒数变量。
  // 折叠行思考秒数改读 `session.thinkingMs`（落盘数据，由 `attachSession`
  // / `turnFinished` 携带；`streamDraft.thinkingSeconds()` 仍保留作流式
  // 期间「思考中…」实时读数，但不再冻结与回传）。
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
      setDraftSegments([]);
      setThinkingDraftMasked("");
      return undefined;
    }
    const unsubscribe = streamDraft.subscribe(() => {
      // SC8 双向防御：流式 high-frequency 更新标记为低优先级 transition。
      startTransition(() => {
        setDraftSegments(streamDraft.maskedSegments());
        setThinkingDraftMasked(streamDraft.thinkingMasked());
      });
    });
    setDraftSegments(streamDraft.maskedSegments());
    setThinkingDraftMasked(streamDraft.thinkingMasked());
    // D3:删除了 `setInterval` 冻结 tick —— 不再向 app 层回传冻结秒数;
    // 折叠行的「思考了 N 秒」由落盘 thinkingMs 接管（`MessageBlocks` 读
    // `session.thinkingMs[messageIndex]`）。
    return () => {
      unsubscribe();
    };
  }, [streamDraft]);

  // ── 退出 / 打断 / inflight 簿记 ────────────────────────────────
  const aborters = useRef(new Map<string, AbortController>());
  const inflightPromises = useRef(new Set<Promise<unknown>>());
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const activeKeyRef = useRef(activeKey);
  activeKeyRef.current = activeKey;
  const subagentWakeRef = useRef<SubagentWake | undefined>(undefined);
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
    // B01 fix + buffer-first 单真相源。preventDefault 阻断 textarea native
    // handlePaste（InternalKeyHandler.emitWithPriority 在 defaultPrevented
    // 时跳过 renderable listener）。同一 paste 事件若 path A 与 path B
    // 双驱动改 inputValue（外置语音输入一次吐多段时）：
    //  - path A functional updater (prev+text) 与 path B direct setInputValue
    //    (ta.plainText) 跨 React 18 commit 周期错位 → 中间段被吞；
    //  - useEffect[props.value] 反复 setText 重置 buffer（prompt-input.tsx:151）
    //    → 跨 commit 的 buffer 中途状态被 overwrite → 错位覆盖。
    // B01 原修复走 path A 单源（setInputValue(prev+text) 排队 commit）；
    // 但 keypress 路径是 buffer-first（原生 buffer 同步改 + 绝对值
    // onChange(ta.plainText)），paste 的 functional update 未 commit 时紧接的
    // keypress 绝对值 setState 仍会覆盖排队中的 paste 段 —— 语音输入
    // paste 与手动 keypress 交错时中间段被吞（input-interleave-race 测试）。
    // 现在改调 PromptInput.insertText：与 keypress 同为 buffer-first 单真相源
    // （写原生 buffer → content-changed 同步 emit → handleContentChange 绝对值
    // 回报），两条路径不再交错竞态。
    event.preventDefault();
    const text = decodePasteBytes(event.bytes) ?? "";
    if (text.length > 0) {
      promptInputRef.current?.insertText(text);
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
                stdout: event.payload?.stdout,
                stderr: event.payload?.stderr,
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
  // 挂载时先同步拉一次：idle 会话若已有 live 子代理（如上一 turn 遗留 /
  // 外部 spawn），初始帧就能渲染 identity strip / panel，而不是等下一个
  // tick 且 watch=false 永不启动。
  useEffect(() => {
    setSubagents(props.bridge.listSubagents());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.bridge]);
  useEffect(() => {
    if (active.runState !== "running-fg" && !subagentWatch) return;
    const tick = setInterval(() => {
      setSubagents(props.bridge.listSubagents());
    }, 1000);
    return () => clearInterval(tick);
  }, [active.runState, subagentWatch, props.bridge]);
  // plans T7：chrome-focus 焦点 clamp —— subagent 行数变化（live 子代理退出
  // / 新增 / 完成窗口过期）时，chromeFocus.kind === "subagent" 的 row 可能
  // 越界。Reducer 在 key press 时做 clamp，但本 effect 兜底无键位下的 stale
  // 状态：focus 越界 → 回 input（reducer 同款语义：subagent 环不可达）。
  // graph 焦点在 snapshot 消失时由上方 graphProgresses 的 nextGraph === null
  // 分支 setGraphChromeFocus("input") 兜底（T3 既有），此处不重复。
  // #337 Phase C：skillCatalog 可选（缺省 = 空清单）；available() = 非 disabled
  // + 有 description、名字序。slash 候选混显「静态命令 + skill」。
  const skillCatalog = props.skillCatalog ?? emptySkillCatalog;
  const skillList = useMemo(() => skillCatalog.available(), [skillCatalog]);
  // 活 taskRoot cell（specs/skill-load-write-root.md）：slash 装配读快照用。
  const liveTaskRoot = props.liveTaskRoot;
  // T6 (plans/write-situation-disclosure.md)：隔离档从 props 取出，与
  // liveTaskRoot 配对算 writeSituation(situation, root) 传给 createSkillBody。
  // 缺省 = undefined → 默认 false（隔离 OFF 形态，与改造前 byte-equal）。
  const isolationOn = props.isolationOn ?? false;
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
  // #647 T3:active 会话的现势快照(keyed by conversationId,与
  // activeToolName 同款派生口径)——draft 无 conversationId / 该会话尚无
  // 事件 → null,面板不渲染 → 切走不残留、切回复现。
  const agentStatus = active.conversationId
    ? (agentStatuses[active.conversationId] ?? null)
    : null;
  const graphProgress = active.conversationId
    ? (graphProgresses[active.conversationId] ?? null)
    : null;
  // #358 T7: 子代理工具对称 —— activeToolName 若是子代理工具（spawn_subagent /
  // plans/tui-chrome-interaction.md T7：ContextBar 不得有 `▣ 子代理` 后缀
  // （acceptance 钉死）。子代理工具（spawn_subagent / subagent_result）
  // activeToolName → undefined；子代理状态由 identity strip（prompt 正上方
  // `{role} running...`）+ SubagentPanel（输入框下方 task list）单独表达。
  // 普通工具 activeToolName 不变；缺 activeToolName 仍为 undefined。
  const activeToolLabel =
    activeToolName !== undefined && !isSubagentTool(activeToolName)
      ? activeToolName
      : undefined;
  // T7: chrome-focus reducer 输入 —— `liveSubagentCount` 是「当前 live
  // 子代理行数」（starting + running；与 projectSubagentLines 投影同源口径）。
  // 用于 reduceChromeFocus 的 subagentCount 与 SubagentPanel 的 focusedRow
  // 越界 clamp。
  const liveSubagentCount = subagents.filter(
    (s) => s.state === "starting" || s.state === "running"
  ).length;
  // plans T7：chrome-focus 焦点 clamp —— subagent 行数变化（live 子代理退出
  // / 新增 / 完成窗口过期）时，chromeFocus.kind === "subagent" 的 row 可能
  // 越界。Reducer 在 key press 时做 clamp，但本 effect 兜底无键位下的 stale
  // 状态：focus 越界 → 回 input（reducer 同款语义：subagent 环不可达）。
  // graph 焦点在 snapshot 消失时由上方 graphProgresses 的 nextGraph === null
  // 分支 setGraphChromeFocus("input") 兜底（T3 既有），此处不重复。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (chromeFocus.kind !== "subagent") return;
    if (chromeFocus.row < liveSubagentCount) return;
    setChromeFocus({ kind: "input" });
  }, [liveSubagentCount]);

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
    setMemoryPickerOpen(false);
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
        const statusSnapshot = agentStatusFromMessages(attached.messages);
        if (statusSnapshot !== null) {
          setAgentStatuses((prev) => ({ ...prev, [id]: statusSnapshot }));
        }
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
    setMemoryPickerOpen(false);
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
    // T3:清掉上一回合 verify 终态 —— 新 turn 进入 running 后 banner 不再
    // 显示旧判定(与 crunchedOf 入口清空同款 turn-boundary 纪律)。
    setVerifySlots((prev) => {
      if (!(targetId in prev)) return prev;
      const next = { ...prev };
      delete next[targetId];
      return next;
    });
    const promise = runTurnOnce(targetId, text, controller);
    inflightPromises.current.add(promise);
    void promise.finally(() => inflightPromises.current.delete(promise));
  }

  async function runContinueTurn(): Promise<void> {
    if (
      tuiContinueBusy({
        runState: active.runState,
        compacting: compactingControllerRef.current !== null,
      })
    ) {
      setNotice({ lines: continueNoticeFor("busy_stop_first") });
      return;
    }
    const targetId = active.conversationId;
    if (targetId === undefined) {
      setNotice({ lines: continueNoticeFor("nothing_pending") });
      return;
    }
    setNotice(undefined);
    setSessions((prev) => {
      const current = prev[targetId];
      if (!current) return prev;
      return { ...prev, [targetId]: turnStarted(current) };
    });
    const controller = new AbortController();
    aborters.current.set(targetId, controller);
    setVerifySlots((prev) => {
      if (!(targetId in prev)) return prev;
      const next = { ...prev };
      delete next[targetId];
      return next;
    });
    const promise = runTurnOnce(targetId, "", controller, "continue");
    inflightPromises.current.add(promise);
    void promise.finally(() => inflightPromises.current.delete(promise));
  }

  async function sessionPendingFromStore(): Promise<boolean> {
    const id = active.conversationId;
    if (id === undefined) return false;
    const file = await props.bridge.loadSessionFile(id);
    return pendingFromLoadedSession({
      messages: file.messages,
      ...(file.goal !== undefined ? { goal: file.goal } : {}),
    });
  }

  async function runTurnOnce(
    targetId: string,
    text: string,
    controller: AbortController,
    mode: "append" | "continue" | "wake" = "append"
  ): Promise<void> {
    let stopReason: string | undefined;
    let lastUsage: TokenUsage | null = null;
    let interrupted: boolean | undefined;
    let uncancellableOperationNotice: string | undefined;
    // transport_retry 过程性 notice 追踪 —— completed/maxTurns 收尾时只清
    // 本轮 retry 落下的 notice,不碰 stop_summary 等其他 notice 来源。
    let retryNoticeShown = false;
    // Predicate / continue ValidationError is not a turn: keep EXIT notice,
    // restore idle, do not reload (reload overwrite → 刷新会话失败).
    let skipTurnRefresh = false;
    const draft = createStreamDraft();
    setStreamDraft(draft);
    // 运行时长打点：turn 起始时刻（mode 行统计段「运行中」实时递增用）。
    // 注意与思考秒数区分：运行时长 = turn 起点 → turn 结束（含等待 / 工具），
    // 思考秒数由 stream-draft 首条 thinking_delta 惰性打点起算（纯思考时长，
    // 不含 turn 启动等待 —— 2026-08-14 语义修正，见 stream-draft.ts 注释）。
    const startedAt = Date.now();
    setRunStartedAt(startedAt);
    setRunElapsed(0);
    // D3:`thinkingFrozenRef.current = 0` / `setThinkingFrozenSeconds(0)` 已
    // 删除 —— 内存思考秒数副通道整条下线;折叠行从落盘 thinkingMs 读。
    // 清掉上次总结：新 turn 开始后流末尾不再显示旧总结（app 层 ↔ chat-view
    // 通过 crunchedOf 归属校验）。
    setCrunchedOf(null);
    // 草稿分段：tool_call_start 时 seal 当前文本段，把已 seal 段数打成
    // draftEpoch。ChatView 按 epoch 交错渲染，与历史 content 块顺序一致。
    // 判定只依赖本闭包事件顺序（#616），不经过 React state / ref 镜像。
    const onStream = (event: HarnessStreamEvent): void => {
      draft.append(event);
      if (event.type === "tool_call_start") {
        // 先 seal 再读 sealedCount：setState updater 延迟到 render 才执行，
        // 禁止在 updater 内重读（#616 同类陷阱）。
        draft.sealText();
        const draftEpoch = draft.sealedCount();
        setLiveToolRuns((prev) => ({
          ...prev,
          [targetId]: liveToolReduce(prev[targetId] ?? [], {
            kind: "tool_call_start",
            id: event.id,
            name: event.name,
            draftEpoch,
          }),
        }));
        // D3:删除了 `pinAndStoreThinkingSeconds(draft)` —— 工具起点不再
        // 钉住内存思考秒数;结束态思考秒数从落盘 thinkingMs 读取。
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
        if (
          event.text === BACKGROUND_OPERATION_NOTICE ||
          event.text === BLOCK_OPERATION_NOTICE
        ) {
          uncancellableOperationNotice = event.text;
        }
        setNotice({ lines: [event.text] });
      }
      if (event.type === "transport_retry") {
        // Bug（2026-09-07）:429/网络故障的重试进度可见化。落到 notice 同一
        // 渲染面;turn 结束后被异常 stopReason notice / cancel notice 覆盖。
        retryNoticeShown = true;
        setNotice({
          lines: [
            `⠿ 连接重试 ${event.attempt}/${event.maxAttempts}（${event.detail}），退避中…`,
          ],
        });
      }
      if (event.type === "agent_status") {
        // #647 T3 / ADR-0028:按本回合 conversationId(targetId —— 事件到达
        // 时的会话归属,与上方 liveToolRuns 同款闭包捕获)整体替换该会话的
        // 现势槽(agentStatusFromEvent 产完整独立快照,不依赖旧值 → 旧快照
        // 不可能残留/混合)。只进本 UI,绝不回流任何模型向字段。
        const nextAgentStatus = agentStatusFromEvent(event);
        if (nextAgentStatus !== null) {
          setAgentStatuses((prev) => ({
            ...prev,
            [targetId]: nextAgentStatus,
          }));
        }
      }
      if (event.type === "env_snapshot") {
        // #653 G1 T5:环境现势独立 slot —— 与 ADR-0028 投影平行独立流。
        // env 不属于会话,单 state 槽整体替换(envSnapshotFromEvent 产完整
        // 独立快照,不依赖旧值);只进本 UI,绝不回流任何模型向字段。
        const nextEnv = envSnapshotFromEvent(event);
        if (nextEnv !== null) {
          setEnvSnapshot(nextEnv);
        }
      }
      const nextGraph = graphProgressFromEvent(event);
      if (nextGraph !== undefined) {
        setGraphProgresses((prev) => {
          if (nextGraph === null) {
            const { [targetId]: _dropped, ...rest } = prev;
            return rest;
          }
          return { ...prev, [targetId]: nextGraph };
        });
        if (nextGraph === null) {
          setGraphChromeFocus("input");
          setGraphViewOpen(false);
          setGraphNodeDetail(false);
          setGraphSelectedId(null);
        }
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
      const resp =
        mode === "wake"
          ? await props.bridge.wakeFromSubagent(targetId)
          : mode === "continue"
            ? await props.bridge.continueSession(targetId, {
                signal: controller.signal,
                onStream,
              })
            : await props.bridge.postMessage({
                conversationId: targetId,
                text,
                signal: controller.signal,
                onStream,
                ...(thinkingOverride ? { thinking: thinkingOverride } : {}),
              });
      if (resp === undefined) {
        skipTurnRefresh = true;
        return;
      }
      stopReason = resp.stopReason;
      lastUsage = resp.lastUsage;
      // B1: 打断反馈 —— cancelled 时 bridge 透传 true/false;非 cancelled
      // (completed 等) → undefined,notice 分支只对 cancelled 生效。
      interrupted = resp.interrupted;
      // T3 (#458 包2):verify 终态入槽。verifyFromWire 做 runtime boundary
      // 校验(4 outcome + rounds 形状),非法 wire → unavailable(degraded 渲染,
      // 不抛错污染 React 栈);none → 从 map 摘除该会话键(banner 静默)。
      setVerifySlots((prev) => {
        const next = verifyFromWire(resp.verify);
        if (next.kind === "none") {
          if (!(targetId in prev)) return prev;
          const without = { ...prev };
          delete without[targetId];
          return without;
        }
        return { ...prev, [targetId]: next };
      });
    } catch (err) {
      if (mode === "continue") {
        const exit = continueExitFromError(err);
        if (exit !== undefined) {
          setNotice({ lines: continueNoticeFor(exit) });
          skipTurnRefresh = true;
        } else if (isContinueValidationError(err)) {
          setNotice({ lines: [err.message] });
          skipTurnRefresh = true;
        } else {
          stopReason = "protocolError";
          setNotice({ lines: [`续跑失败：${describeError(err)}`] });
        }
      } else if (mode === "wake") {
        const wakeError = toSubagentWakeError(err);
        stopReason = "protocolError";
        setNotice({ lines: [wakeError.message] });
      } else {
        stopReason = "protocolError";
        setNotice({ lines: [`turn 失败：${describeError(err)}`] });
      }
    } finally {
      aborters.current.delete(targetId);
      // 快照本次 turn 的 thinking 最终秒数（reset 会置 0，必须先取）。
      // D3:thinking 秒数整条内存副通道全部下线 ——
      // 折叠行的「思考了 N 秒」改读落盘 thinkingMs（commitMessages → store.appendEvents 写入;
      // turn 结束 → `loadSessionFile(targetId)` 重读 file → `turnFinished` 携 thinkingMs）;
      // turn 结束 + 流式面板消失 → 末条 assistant 折叠行秒数自动由 session.thinkingMs 接管。
      draft.reset();
      setStreamDraft(null);
      // 运行时长冻结：turn 结束精确值（含工具耗时尾段，tick 可能未覆盖）。
      // crunchedOf = 归属会话 id —— 只有当前 active 会话等于它时 ChatView
      // 才接收 crunchedSeconds（消息流末尾 Crunched 行），避免跨会话错配。
      const finalRunSeconds = Math.max(
        0,
        Math.floor((Date.now() - startedAt) / 1000)
      );
      setRunElapsed(finalRunSeconds);
      setRunStartedAt(null);
      if (!skipTurnRefresh) {
        setCrunchedOf(targetId);
        setCrunchedSeconds(finalRunSeconds);
      }
    }
    if (skipTurnRefresh) {
      setSessions((prev) => {
        const current = prev[targetId];
        if (!current) return prev;
        return {
          ...prev,
          [targetId]: Object.freeze({ ...current, runState: "idle" }),
        };
      });
      return;
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
            // ADR-0037 T5:改绑回合的落盘文件携带 task worktree 根 → 现势行
            // 当回合即更新;普通回合字段缺席 → turnFinished 保留既有值。
            workspaceRoot: file.workspaceRoot,
            // D3 (tui-display-consistency):从落盘文件携 thinkingMs 并行数组 → 折叠
            // 行「思考了 N 秒」从此处读取;旧的 in-memory 思考秒数副通道已删除。
            thinkingMs: file.thinkingMs,
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
            uncancellableOperationNotice !== undefined
              ? [uncancellableOperationNotice]
              : interrupted === true
                ? ["已打断，checkpoint 已保存"]
                : interrupted === false
                  ? ["已打断（无新内容，未落 checkpoint）"]
                  : ["已打断当前 turn"],
        });
      } else if (
        stopReason === "protocolError" ||
        stopReason === "timeout" ||
        stopReason === "nonSuccessStop" ||
        stopReason === "emptyFinalResponse" ||
        stopReason === "fused"
      ) {
        // Bug（2026-09-07）：429/网络类故障在 loop-engine 被压平成正常返回
        // （TransportRetryExhaustedError → protocolError，finalText 为空），
        // 此前只有 throw 路径与 cancelled 出 notice → 一轮静默结束。异常
        // stopReason 落同一 notice 渲染面，用户至少能看到 turn 未成功。
        // maxTurns 不并入：已有专属完成反馈（验证行）。
        setNotice({
          lines: [
            `⚠ turn 未成功结束（${stopReason}）：可能是连接或模型故障，请重试`,
          ],
        });
      } else if (retryNoticeShown) {
        // completed / maxTurns 收尾:只清本轮 transport_retry 落下的过程性
        // notice,避免成功回合残留「退避中…」;stop_summary 等 notice 不动
        // (它们在 maxTurns 收尾后仍需呈现,见 max-turns/stream-draft 测试)。
        setNotice(undefined);
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

  // T4: terminal worker notices wake only the active idle session. The
  // injected drain is sent through the bridge's silent path, so this effect
  // never appends a user bubble or input-history entry.
  useEffect(() => {
    const controller = createSubagentWake({
      manager: undefined,
      subscribe: props.bridge.subscribeSubagentTerminal,
      conversationId: () =>
        sessionsRef.current[activeKeyRef.current]?.conversationId,
      isIdle: () => {
        const current = sessionsRef.current[activeKeyRef.current];
        return (
          current?.runState === "idle" && current.conversationId !== undefined
        );
      },
      wake: async () => {
        const current = sessionsRef.current[activeKeyRef.current];
        const targetId = current?.conversationId;
        if (targetId === undefined || current.runState !== "idle") return;
        setSessions((prev) => {
          const latest = prev[activeKeyRef.current];
          if (!latest || latest.runState !== "idle") return prev;
          return {
            ...prev,
            [activeKeyRef.current]: turnStarted(latest),
          };
        });
        const abortController = new AbortController();
        aborters.current.set(targetId, abortController);
        const promise = runTurnOnce(targetId, "", abortController, "wake");
        inflightPromises.current.add(promise);
        void promise.finally(() => inflightPromises.current.delete(promise));
        await promise;
      },
      onError: (error) => {
        setNotice({ lines: [`后台唤醒失败：${describeError(error)}`] });
      },
    });
    subagentWakeRef.current = controller;
    controller.flush();
    return () => {
      controller.dispose();
      if (subagentWakeRef.current === controller) {
        subagentWakeRef.current = undefined;
      }
    };
  }, [props.bridge]);

  // A background turn can make the active session idle after a notice was
  // queued. Flush on the state transition rather than waiting for another
  // worker event.
  useEffect(() => {
    subagentWakeRef.current?.flush();
  }, [activeKey, active.runState]);

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
    props.onQuit?.(active.conversationId);
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
      const targets = await props.bridge.listRewindTargets(targetId);
      if (targets.length === 0) {
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

  /** 确认后移动 head；fillInput 时把锚点全文填回输入框。 */
  async function executeRewind(
    targetId: string,
    target: RewindTarget
  ): Promise<void> {
    setRewindTargets(undefined);
    setRewindConfirming(false);
    try {
      await props.bridge.rewindSession(targetId, target.head);
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
      const noticeText = target.userMessageText || "(无文本)";
      setNotice({
        lines: [`已回退到 ［${noticeText}］ 之前。`],
      });
      if (target.fillInput) setInputValue(target.fullText);
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
          // 写根 trailer（specs/skill-load-write-root.md）：调用时机读活
          // cell 快照；cell 缺席（fixture / 测试）→ 无 trailer。
          // T6 (write-situation-disclosure)：双参形态 —— `isolationOn`
          // 与 `taskRoot` 同进同出 → 按处境渲染。`writeSituation` 纯函数
          // 算三态,缺 isolationOn 时默认 false(= 隔离 OFF = writable_main,
          // 与改造前 byte-equal)。
          const taskRoot = liveTaskRoot?.read();
          const body = await createSkillBody({
            entry,
            dir: entry.dir,
            ...(taskRoot !== undefined
              ? {
                  taskRoot,
                  writeSituation: writeSituation(isolationOn, taskRoot),
                }
              : {}),
          });
          const sendText = buildSkillLoadText(
            skillLoad.name,
            body,
            skillLoad.remainder
          );
          // plans/tui-chrome-interaction.md Task 5：displayText 也走闭合
          // 信封形态（empty body + 同样 remainder），让 render 层
          // `projectSkillLoadUserText` 抽到同样的 `{name, remainder}` —— 运行
          // 中的 echo 与落盘后的 transcript 显示一致（chip-only 或 chip+
          // remainder），不再用中文「[加载技能 X]」占位。turn 完成后落盘权威
          // 消息原子替换（render 同样路径投影，正文永进 ❯ 气泡）。
          const displayText = buildSkillLoadText(
            skillLoad.name,
            "",
            skillLoad.remainder.length > 0 ? skillLoad.remainder : undefined
          );
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
      try {
        const pending = await sessionPendingFromStore();
        if (shouldTriggerContinueFromNl({ line: parsed.text, pending })) {
          await runContinueTurn();
          return;
        }
      } catch (err) {
        setNotice({ lines: [`读取会话失败：${describeError(err)}`] });
        return;
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
      case "graph": {
        // D-α V1 / SC3：`/graph` 是 Shift+Tab 的非 TTY 对等物 —— 翻同一个
        // holder，解析与文案单点在 harness/graph/mode.ts（三入口同源）。
        const graphCtx = props.graphMode;
        if (!graphCtx) {
          setNotice({ lines: ["图模式未接线（本入口未注入 graph holder）。"] });
          return;
        }
        const res = applyGraphCommand(
          graphCtx,
          splitGraphArgs(slashRemainder(text))
        );
        setGraphOn(graphCtx.get().enabled);
        setNotice({ lines: [res.text] });
        return;
      }
      case "thinking": {
        // design-25 picker（双面板版）：/thinking 打开纯开关面板（ON/OFF），
        // 不设 notice（面板本身即反馈）。seed 自当前 thinkingEnabled；Enter/
        // Space/Tab 翻转预览、Esc 保存退出写 thinkingEnabled。不碰 effort。
        setThinkingPickerOpen("thinking");
        setSwitchPreview(thinkingEnabled);
        setMemoryPickerOpen(false);
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
        setMemoryPickerOpen(false);
        return;
      }
      case "memory": {
        setThinkingPickerOpen(null);
        setMemoryPickerOpen(true);
        setMemoryFocusIndex(0);
        setMemoryPreview(memoryCommitted);
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
        // 返回 compacted=false,与"无可压缩上下文"同形),promise resolve 后据此
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
            // 文案决策 SSOT:compactNoticeFor 纯函数(manual-compact-trigger
            // T2:no-op 支语义为「没有可压缩的上下文」,below_token_threshold
            // 在手动路径抛错)。
            setNotice({
              lines: compactNoticeFor(compactResult.reason, true),
            });
          } else {
            setNotice({
              lines: compactNoticeFor(compactResult.reason, false),
            });
          }
        } catch (err) {
          setNotice({ lines: [`压缩失败：${describeError(err)}`] });
        } finally {
          compactingControllerRef.current = null;
        }
        return;
      }
      case "continue": {
        if (
          tuiContinueBusy({
            runState: active.runState,
            compacting: compactingControllerRef.current !== null,
          })
        ) {
          setNotice({ lines: continueNoticeFor("busy_stop_first") });
          return;
        }
        if (slashHasArg(text)) {
          setNotice({ lines: continueNoticeFor("usage") });
          return;
        }
        await runContinueTurn();
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

  function persistMemoryFromCommit(patch: CommittedMemoryPatch): void {
    if (props.memoryFlags !== undefined) {
      props.memoryFlags.autoExtract = patch.autoExtract;
      props.memoryFlags.dream = patch.dream;
    }
    if (props.onPersistMemory === undefined) return;
    void props.onPersistMemory(patch).then(
      (res) => {
        if (!res.ok) {
          setNotice({
            lines: [
              `记忆设置已生效（本次会话），但写回 settings.json 失败：${res.reason}`,
            ],
          });
        }
      },
      (err) => {
        setNotice({
          lines: [
            `记忆设置已生效（本次会话），但写回 settings.json 失败：${
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
    const isCtrlC = e.ctrl && e.name === "c";

    if (graphViewOpen && graphProgress !== null) {
      applyGraphViewKey(
        {
          key: e.name,
          selectedId: graphSelectedId,
          detail: graphNodeDetail,
          selectableIds: selectableNodeIds(
            graphGroupRows(graphProgress, graphSelectedId)
          ),
        },
        {
          closeDetail: () => setGraphNodeDetail(false),
          closeView: () => setGraphViewOpen(false),
          select: setGraphSelectedId,
          openDetail: () => setGraphNodeDetail(true),
        }
      );
      if (!isCtrlC) return;
    }

    const graphKey = reduceGraphChromeFocus({
      focus: graphChromeFocus,
      hasSnapshot: graphProgress !== null,
      key: e.name,
    });
    // plans/tui-chrome-interaction.md T7：graph 全屏 open/close 仍由
    // 旧 graphChromeFocus（input|graph 二态 reducer）的 openView 触发。
    // 三态 chromeFocus 取代的是 chrome 环间的 Down/Up 切换（input ↔
    // subagent(row) ↔ graph），由 reduceChromeFocus + PromptInput
    // onLeaveToChrome 接管（见下方）。
    // 双 reducer 同步：三环 chromeFocus 进 graph 时，二态
    // graphChromeFocus 必须跟着置 "graph"，否则 Enter 的 openView 判定
    // 读到旧值（Tab 进 graph 环 → Enter 全屏打不开）。
    if (chromeFocus.kind === "graph" && graphChromeFocus !== "graph") {
      setGraphChromeFocus("graph");
    }
    if (chromeFocus.kind === "graph") {
      // 旧 reducer 在 graph 环内只剩两个职责：Enter → openView（全屏视图）、
      // Escape → 退出环。Down/Up **不**在此处理（旧 reducer 会把
      // graphChromeFocus 拉回 input 后 unconditional return，三环 reducer
      // 的 graph→Up→subagent/input 转移变成死代码 + 焦点陷阱）——落到底部
      // 三环分支消费，离开 graph 时同步 graphChromeFocus。
      if (graphKey.openView === true) {
        const ids =
          graphProgress === null
            ? []
            : selectableNodeIds(graphGroupRows(graphProgress, null));
        setGraphSelectedId(ids[0] ?? null);
        setGraphNodeDetail(false);
        setGraphViewOpen(true);
        if (!isCtrlC) return;
      }
      if (e.name === "escape") {
        setChromeFocus({ kind: "input" });
        setGraphChromeFocus("input");
        if (!isCtrlC) return;
      }
      if (e.name !== "down" && e.name !== "up" && !isCtrlC) return;
    }

    // plans/tui-chrome-interaction.md T7：chrome-focus 三态 reducer 全局
    // Down/Up 键位 —— 当焦点不在 input（subagent 或 graph 环）时，Down/Up
    // 由 reducer 全局消费（PromptInput 此时 disabled，不接键）。输入框路径
    // 由 PromptInput 内部 onLeaveToChrome 接管（multiline 视觉末行 / 单行无
    // 历史时让出键位）—— 与本分支正交，不重复触发。
    //   - chromeFocus = input → PromptInput 自己处理 Down/Up（含 hint /
    //     multiline / history / onLeaveToChrome 路径）；本分支不进。
    //   - chromeFocus = subagent(row) → Down/Up 在 subagent 行间移动；Down
    //     越出 last 行 → graph（若有快照）；Up 在 row=0 → 回 input。
    //   - chromeFocus = graph → Up → 最后一个 subagent（若有）/input；Down
    //     在最末环 → 原地。
    // reducer 是纯函数，相同 input → 同样 output；用 !== identity 比对探测
    // 焦点变化。
    if (
      chromeFocus.kind !== "input" &&
      (e.name === "down" || e.name === "up") &&
      view === "chat"
    ) {
      const next = reduceChromeFocus({
        focus: chromeFocus,
        key: e.name,
        subagentCount: liveSubagentCount,
        hasSnapshot: graphProgress !== null,
      });
      if (next.focus !== chromeFocus) {
        setChromeFocus(next.focus);
        // 双 reducer 同步（离开方向）：三环焦点从 graph 退出时，旧二态
        // reducer 的 focus 也要回 input，否则下一次 Enter 的 openView 判定
        // 读到 stale "graph" 意外开全屏。
        if (
          chromeFocus.kind === "graph" &&
          next.focus.kind !== "graph" &&
          graphChromeFocus !== "input"
        ) {
          setGraphChromeFocus("input");
        }
      }
      // graph 全屏打开时不在此分支（已被上方 graphViewOpen 短路）；不打开
      // 时全屏不会响应 Down/Up，本分支 preventDefault 等价 no-op（事件已被
      // useKeyboard 消费，键不冒泡到其他 reducer）。
      return;
    }

    // Shift+Tab 切 agent mode（W2 权限轮 + D-α graph overlay 的三态轮；
    // graph holder 缺席时自动退化成既有两态 permission 轮）。
    if (
      applyShiftTabAgentModeFlip({
        key: {
          name: e.name,
          shift: e.shift,
          ctrl: e.ctrl,
          meta: e.meta,
        },
        permission: permissionMode,
        graph: props.graphMode,
        onFlip: (next) => {
          setPermMode(next.permission);
          setGraphOn(next.graph);
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
        const controller =
          id === undefined ? undefined : aborters.current.get(id);
        if (controller !== undefined) {
          controller.abort();
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
    if (memoryPickerOpen) {
      const action = reduceMemoryPickerKey(modalKeyEventOf(e), {
        focusedIndex: memoryFocusIndex,
      });
      switch (action.type) {
        case "move":
          setMemoryFocusIndex(action.index);
          break;
        case "toggle": {
          const row = memoryFocusIndex === 0 ? "autoExtract" : "dream";
          setMemoryPreview((prev) => applyMemoryPreviewToggle(prev, row));
          break;
        }
        case "fix":
          break;
        case "commit": {
          const patch = committedMemoryPatch(memoryPreview);
          setMemoryCommitted(patch);
          setMemoryPreview(patch);
          setMemoryPickerOpen(false);
          persistMemoryFromCommit(patch);
          break;
        }
        case "ignore":
          break;
      }
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
          if (targetId !== undefined && t !== undefined) {
            void executeRewind(targetId, t);
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
      : view === "chat" && memoryPickerOpen
        ? memoryPickerRows()
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
  // 子代理面板在输入框下方渲染，但不计入 chrome：计入会把 ChatView 变矮、
  // 输入框上移。终端装不下的行溢到屏幕下方。
  // agent 现势：mode 行上方未勾待办单行（0-1）。
  // 非 chat 视图 / 尚无快照 → 0（组件渲染 null）。
  const agentStatusRowBudget =
    view === "chat" ? agentStatusLines(agentStatus, cols).length : 0;
  // 环境现势事件仍收（harness 给人不给模型）。ADR-0037 T5:envPaneRows 槽位
  // 现渲染会话 worktree 隔离现势行（0-1 行）—— 会话根被 T3 改绑到 task
  // worktree 时显示绑定根;未绑定（开关 OFF / 尚未 mutate / 改绑失败）→
  // 0 行,与今日一致。只读投影（worktreeIsolationLines）,零 git 操作。
  const envPaneRowBudget =
    view === "chat"
      ? worktreeIsolationLines(active.workspaceRoot, cols).length
      : 0;
  void envSnapshot;
  // #458 包2 T3:verify 闭环终态 banner 行数投影 —— active 会话槽 + 模式
  // (hitl / auto),纯函数 projectVerifyBanner 实际行数(0 / 1)。
  // 仅 chat 视图入账;切走会话不渲染(与 crunchedOf 同款归属校验)。
  const verifyMode: "hitl" | "auto" =
    permMode === "full_auto" ? "auto" : "hitl";
  const verifySlot: VerifySlot | null =
    view === "chat" && active.conversationId !== undefined
      ? (verifySlots[active.conversationId] ?? { kind: "none" })
      : { kind: "none" };
  const verifyRowBudget =
    view === "chat"
      ? projectVerifyBanner(verifySlot, verifyMode, cols).length
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
        panelRows: 0,
        agentStatusRows: agentStatusRowBudget,
        envPaneRows: envPaneRowBudget,
        verifyRows: verifyRowBudget,
        graphRows: graphChromeRows(graphProgress),
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
      ) : graphViewOpen && graphProgress !== null ? (
        <GraphGroupView
          snapshot={graphProgress}
          selectedId={graphSelectedId}
          detail={graphNodeDetail}
          cols={cols}
          rows={rows}
        />
      ) : (
        <>
          <box height={viewportRows} flexShrink={0} flexGrow={0}>
            <ChatView
              session={active}
              cols={cols}
              rows={viewportRows}
              draftSegments={draftSegments}
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
          </box>
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
      {view === "chat" && memoryPickerOpen && (
        <MemoryPicker
          state={{
            focusedIndex: memoryFocusIndex,
            autoExtract: memoryPreview.autoExtract,
            dream: memoryPreview.dream,
          }}
        />
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
                    network: askPending.network,
                  }
                : undefined
          }
          cols={cols}
        />
      )}
      {view === "chat" && (
        <AgentStatusPanel snapshot={agentStatus} cols={cols} />
      )}
      {view === "chat" && (
        <box flexDirection="row">
          <text
            fg={graphOn || permMode === "full_auto" ? pal.running : pal.dim}
          >
            {cols < 40
              ? `[${graphOn ? "graph" : permMode === "full_auto" ? "auto" : "def"}]`
              : `mode: ${agentModeLabel({ permission: permMode, graph: graphOn })}`}
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
      {/* #458 包2 T3:verify 闭环终态 banner —— 滚动区外、mode 行与输入框
          之间。slot=none → 组件渲染 null(静默,无虚假提示);HITL 直显,
          full_auto 加 [auto] 前缀。行账经 chromeReserveRows.verifyRows 入账。 */}
      {view === "chat" && (
        <VerifyBannerStrip slot={verifySlot} mode={verifyMode} cols={cols} />
      )}
      {/* plans/tui-chrome-interaction.md T7 —— 子代理身份条（immediately
          above the prompt）。live 子代理 catalog id 用 `· ` 连接，无 task 文本。
          不入 chrome 行账（永远单行，按 cols 视觉宽度截断；live === 0 → 不渲染）。
          activeToolLabel 已剥除 `▣ 子代理`（dual render 移除）；identity strip
          + SubagentPanel 双轨表达 live 子代理状态。JSX 顺序 = 视觉顺序：
          本条必须在 <PromptInput> 之前。 */}
      {view === "chat" && (
        <SubagentIdentityStrip subagents={subagents} cols={cols} />
      )}
      {view === "chat" && (
        <PromptInput
          ref={promptInputRef}
          value={inputValue}
          cols={cols}
          maxLines={MAX_INPUT_LINES}
          placeholder={
            rewindTargets !== undefined
              ? "回退选择器中（↑↓ 选择 · Enter 确认 · Esc 关闭）"
              : memoryPickerOpen
                ? "记忆开关中（↑↓ 选择 · Space 切换 · Enter 固定 · Esc 保存退出）"
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
            thinkingPickerOpen !== null ||
            memoryPickerOpen ||
            // plans T7：input 失活条件由 chrome-focus 三态 reducer 接管
            // —— focus 在 subagent 或 graph 时禁用输入框。
            chromeFocus.kind !== "input" ||
            graphViewOpen
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
          onLeaveToChrome={() => {
            // plans/tui-chrome-interaction.md T7：使用三态 chrome-focus
            // reducer（input/subagent(row)/graph）替换旧二态 graphChromeFocus
            // —— reducer 由 PromptInput Down/Up 触发（「视觉末/首行 + onLeaveToChrome
            // 让出」），key 在 prompt-input 内部已被消费，因此 reducer 在此
            // 只按"离开 input"语义走：input → 第一个可达环（subagent 或 graph）。
            const next = reduceChromeFocus({
              focus: chromeFocus,
              key: "down",
              subagentCount: liveSubagentCount,
              hasSnapshot: graphProgress !== null,
            });
            // reducer 是纯函数，相同 input → 同样 output；用 !== 比较 identity
            // 即可探测焦点变化。
            if (next.focus !== chromeFocus) {
              setChromeFocus(next.focus);
            }
            // onLeaveToChrome 返回 true 表示 PromptInput 已让出键位（消费
            // 了 preventDefault），app 层不再二次处理。focus 不变（input 上
            // 无可达环）→ 返回 false，让 PromptInput 保留状态（与 T6 reducer
            // 同契约）。
            return next.focus !== chromeFocus;
          }}
        />
      )}
      {/* plans T7 验收钉死的 footer 顺序（prompt 之下）：
            subagent task list → ContextBar → worktree isolation line → graph。
          历史顺序为 worktree → ContextBar → graph → subagent（误读 envPaneRows
          槽位 + 无依据 graph 夹层）。T7 重排后：
          - SubagentPanel（chrome-focus subagent 环的可见段，prompt 之下第一站）；
          - ContextBar（model + ctx）；
          - worktree isolation line（worktreeIsolationLines，未绑定 → 0 行）；
          - GraphChromePanel（graph 环，chrome-focus 最末站）。 */}
      {/* 子代理状态：输入框之下第一站。不计入 chrome 行账（panelRows=0）。
          T7：传 focusedRow —— chrome-focus subagent(row) 焦点时该行展开 taskPreview
          （不再截断）+ 加 `> ` 前缀；其余行保持原截断。focusedRow 仅作用于 live 行
          （reducer 圈定的子集），SubagentPanel 内部按 liveIndex 投影。 */}
      {view === "chat" && (
        <SubagentPanel
          subagents={subagents}
          cols={cols}
          focusedRow={
            chromeFocus.kind === "subagent" ? chromeFocus.row : undefined
          }
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
      {/* ADR-0037 T5: 会话 worktree 隔离现势行（T7 重排：现在位于 ContextBar
          之下、graph 之上；envPaneRows 槽位入账不变）。未绑定 → worktreeIsolationLines
          返回空 → 不渲染。 */}
      {view === "chat" &&
        worktreeIsolationLines(active.workspaceRoot, cols).map((line, idx) => (
          <text key={idx} fg={line.fg} wrapMode="none">
            {line.text}
          </text>
        ))}
      {view === "chat" && (
        <GraphChromePanel
          snapshot={graphProgress}
          cols={cols}
          focused={chromeFocus.kind === "graph"}
        />
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
