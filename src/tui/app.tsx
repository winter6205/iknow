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
import { summarizeTransportCause } from "../harness/errors.js";
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
  type ModalKeyEvent,
  type PermissionAnswer,
} from "./modal.js";
import { abortForegroundTurnOnQuit } from "./quit-abort.js";
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
  type SkillEntryLike,
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
  COMPACT_HOLD_MS,
  CompactProgress,
  compactProgressRows,
  reduceCompactionEvent,
  settleCompactPanel,
  startCompactPanel,
  type CompactProgressState,
  type CompactProgressSource,
  type CompactTerminalKind,
} from "./compact-progress.js";
import {
  MemoryPicker,
  applyMemoryPreviewToggle,
  committedMemoryPatch,
  memoryPickerRows,
  reduceMemoryPickerKey,
  seedMemoryPreview,
  type CommittedMemoryPatch,
} from "./memory-picker.js";
import {
  ModelPicker,
  findEntryByRouteId,
  modelPickerEntries,
  modelPickerRows,
  modelRouteId,
  reduceModelPickerKey,
  type ModelPickerEntry,
  type ModelPickerState,
} from "./model-picker.js";
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
import {
  EMPTY_ENV_DISPLAY_STORE,
  type EnvDisplayStore,
} from "./env-display-store.js";
// plans/tui-chrome-interaction.md T7：chrome-focus reducer 接线 ——
// `reduceChromeFocus` 拥有 input/subagent(row)/graph 三环焦点（src/tui/
// chrome-focus.ts），reducer 是纯函数，本文件只做组合（T7 验收：wiring
// 只做组合，不长成 god-handler）。`graphChromeFocus`（graph-chrome.ts 旧
// 二态 reducer）只保留 openView 视图层（full-screen GraphGroupView 的
// Open/Close 仍是它的职责；不与三环焦点切换混）。
import { type ChromeFocus, reduceChromeFocus } from "./chrome-focus.js";
import { SubagentIdentityStrip } from "./subagent-identity-strip.js";
// Slice D / SC14: Ctrl+X 强杀聚焦子代理 —— 纯分派模块（行序与面板同源）。
import { dispatchKillFocusedSubagent } from "./subagent-kill.js";
// Slice D / SC14: 两行投影行账（chrome 预算入账，SSOT 与 strip 渲染同源）。
import {
  isLiveSubagent,
  subagentMessageRowCount,
} from "./subagent-message-lines.js";
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
  resolveWorktreeChromeRoot,
  sessionLocationLines,
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
import {
  applyFsModeCommand,
  parseConfigCommand,
  splitConfigArgs,
  type FsIsolationMode,
  type FsModeContext,
} from "../harness/sandbox/fs-mode.js";
import { buildSkillLoadText, createSkillBody } from "../harness/skill/body.js";
import { stripNamespace } from "../harness/skill/catalog.js";
import type { SkillCatalog } from "../harness/skill/catalog.js";
import type { IknowSettingsLlmProvider } from "../config/settings.js";
import {
  formatLlmProviderConfigError,
  isLlmProviderConfigError,
} from "../config/env.js";
import { persistModelFailNotice } from "./persist-model-failure.js";
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
 * /compact 入口护栏文案 SSOT（纯函数，可单测 —— Spec review Medium#3：
 * 五条 guard 原先内联在 switch 分支里，只有 draft 一条被 app 级测试间接覆盖）。
 *
 * 五条 guard 覆盖的手动路径前置条件：
 *  - busy：turn 在跑，压缩要排队（runState 门）；
 *  - in_flight：同一时刻只允许一条 /compact（compactingControllerRef 同步门）；
 *  - draft：会话尚未建档，没有可压缩的东西；
 *  - cancelled：promise 结果 cancelled（pre-abort 早返回 / 事件标记）；
 *  - failed：compactSession 抛出（describeError 注入）。
 */
export type CompactGuard = "busy" | "in_flight" | "draft";

export function compactGuardNoticeFor(guard: CompactGuard): string {
  switch (guard) {
    case "busy":
      return "Session is running; compact after this turn ends.";
    case "in_flight":
      return "Compaction already in progress; press Esc to cancel.";
    case "draft":
      return "Empty session — nothing to compact yet.";
    default: {
      const _exhaustive: never = guard;
      throw new Error(`unknown compact guard: ${String(_exhaustive)}`);
    }
  }
}

/** 压缩成功取消（promise 结果 cancelled）的 notice 文案。 */
export function compactCancelledNotice(): string {
  return "Compaction cancelled — session unchanged.";
}

/** 压缩抛错的 notice 前缀（错误体由 describeError 兜底，非纯函数部分）。 */
export function compactFailedNoticePrefix(): string {
  return "Compaction failed: ";
}

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
        return ["Context compacted (kept tail, trimmed early messages)."];
      case "full_summary":
        return ["Context compacted (structured summary + kept tail)."];
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
      return ["Nothing to compact — session unchanged."];
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
 *   - compact 进度面板 + 自身 marginBottom=1（compactRows 同上款约定）
 *   - 子代理状态面板（ContextBar 之下第二站，不计入 chrome 行账，避免把输入框往上顶）
 *   - 后台运行标记行（存在 running-bg 时）
 */
/**
 * 面板型槽位的统一入账：缺省 0，行数 > 0 → rows + 1（自身 marginBottom=1），
 * 否则 0。notice / modal / picker / compact 四槽同款约定 —— 四处各写一遍
 * `?? 0` + 三元必然漂移，也把 chromeReserveRows 的复杂度顶到硬门之上。
 */
function panelSlotRows(rows: number | undefined): number {
  const n = rows ?? 0;
  return n > 0 ? n + 1 : 0;
}

/**
 * 零默认槽位求和（缺省 / 显式 0 都按 0 计）。`chromeReserveRows` 的尾部槽
 * 位已有 6 个，逐项写 `(x ?? 0)` 会把这一个组合函数推过 S5 复杂度硬门；
 * 折叠进本 helper 让新增槽位只增一行调用，不再逐个加分支。
 */
function zeroDefaultRows(rows: ReadonlyArray<number | undefined>): number {
  let total = 0;
  for (const n of rows) total += n ?? 0;
  return total;
}

/**
 * /model 面板条目投影：实现下沉到 model-picker.tsx 并从本文件再导出。
 * app 与 context-bar 都消费这份「注册表 → 条目」投影，任一方持有实现都会
 * 逼另一方反向 import 成环 —— 投影族（展平 / 路由判定 / 显示名）因此全部
 * 落在两者的共同下游叶子模块。再导出保持既有调用点
 * （app 内部 + tests/tui/model-command.test.tsx）import 路径不变。
 */
export { modelPickerEntries } from "./model-picker.js";

/** 当前 model 串在条目列表中的下标（找不到 / 空列表 → 0）。 */
export function modelFocusIndexFor(
  entries: ReadonlyArray<ModelPickerEntry>,
  model: string | undefined
): number {
  if (model === undefined) return 0;
  const entry = findEntryByRouteId(entries, model);
  return entry === undefined ? 0 : entries.indexOf(entry);
}

/**
 * picker 行账（chrome 预算槽）：非 chat 视图 / 面板未开 → 0；打开 → 按当前
 * 注册表条目数取 `modelPickerRows`。三元从 TuiApp 内联折进 helper，新增面板
 * 只加一行调用、不给组件加分支（与 `modelPickerEntries` 同款动机）。
 * **不含 marginBottom=1**（由 chromeReserveRows 的 +1 入账，见 modelPickerRows）。
 */
export function modelPickerRowsFor(
  open: boolean,
  view: TuiView,
  providers: ReadonlyArray<IknowSettingsLlmProvider> | undefined
): number {
  if (!open || view !== "chat") return 0;
  return modelPickerRows(modelPickerEntries(providers).length);
}

/**
 * 面板渲染态（`ModelPickerState | null`）：非 chat / 未打开 → null（组件不
 * 渲染）。构造与判别折进 helper，避免组件内联三元+对象字面量各占一个分支。
 */
export function modelPickerStateFor(
  open: boolean,
  view: TuiView,
  providers: ReadonlyArray<IknowSettingsLlmProvider> | undefined,
  focusedIndex: number
): ModelPickerState | null {
  if (!open || view !== "chat") return null;
  return { entries: modelPickerEntries(providers), focusedIndex };
}

/**
 * 输入框占位符的 picker 文案（判别顺序 = 面板互斥优先级：回退 > model >
 * memory > thinking）。任一 picker 打开 → 对应键位提示，否则 undefined（调用
 * 方落回默认文案 / ask 分支）。文案链折进本函数，组件只做取值（S5：分支体在
 * helper 内；文案 SSOT 在此，测试断言的中文串不散落在 JSX）。
 */
export function pickerPlaceholderFor(opts: {
  readonly rewindOpen: boolean;
  readonly modelPickerOpen: boolean;
  readonly memoryPickerOpen: boolean;
  readonly thinkingPickerOpen: null | "thinking" | "effort";
}): string | undefined {
  if (opts.rewindOpen) {
    return "回退选择器中（↑↓ 选择 · Enter 确认 · Esc 关闭）";
  }
  if (opts.modelPickerOpen) {
    return "模型选择中（↑↓ 选择 · Enter 切换 · Esc 关闭）";
  }
  if (opts.memoryPickerOpen) {
    return "记忆开关中（↑↓ 选择 · Space 切换 · Enter 固定 · Esc 保存退出）";
  }
  if (opts.thinkingPickerOpen === "thinking") {
    return "思考开关中（Space 切换 · Enter 固定 · Esc 保存退出）";
  }
  if (opts.thinkingPickerOpen === "effort") {
    return "思考强度中（←/→ 选档 · Tab 自动 · Enter 固定 · Esc 保存退出）";
  }
  return undefined;
}

/**
 * /help 的 skill 名入参：有 skill → 名字列表，无 → undefined（`helpLines`
 * 据此整段退场，不渲染空 skills 段）。判空折进 helper，`case "help"` 只留
 * 一行（S5：分支体在 helper 内）。
 */
export function skillNamesForHelp(
  skillList: ReadonlyArray<{ readonly name: string }>
): ReadonlyArray<string> | undefined {
  if (skillList.length === 0) return undefined;
  return skillList.map((entry) => entry.name);
}

/** /model 注册表为空时的 typed notice（测试断言的中文串 SSOT）。 */
export const MODEL_PICKER_EMPTY_NOTICE =
  "未配置 providers —— 在 ~/.iknow/settings.json 的 llm.providers 里登记（含 id / baseUrl / apiKeyEnv / models）。";

/**
 * /model 命令的落地：注册表空 / 缺席 → 走 onEmpty（typed notice，**不打开
 * 面板**）；非空 → onOpen(焦点初值 = 当前 model 对应条目，找不到 → 0)，调用
 * 方在 onOpen 内完成面板互斥（收起 thinking / memory）。判定从 handleSubmit
 * 的 case 分支体折进本函数，case 只留一行派发（S5：分支体在 helper 内）。
 */
export function openModelPickerCommand(opts: {
  readonly providers: ReadonlyArray<IknowSettingsLlmProvider> | undefined;
  readonly model: string | undefined;
  readonly onEmpty: (lines: ReadonlyArray<string>) => void;
  readonly onOpen: (focusIndex: number) => void;
}): void {
  const entries = modelPickerEntries(opts.providers);
  if (entries.length === 0) {
    opts.onEmpty([MODEL_PICKER_EMPTY_NOTICE]);
    return;
  }
  opts.onOpen(modelFocusIndexFor(entries, opts.model));
}

/**
 * /model 面板的键位落地（宿主 useKeyboard 的 `if (modelPickerOpen)` 分支体）。
 * 纯路由在 `reduceModelPickerKey`，本函数只把 action 接到回调上，保留面板
 * 交互语义（spec SC8）：
 *  - move → onMove（面板保持打开）；
 *  - fix（Enter）→ onSelect(路由 ID) + onClose（选定 + 持久化 + 关闭）；
 *  - commit（Esc）→ 仅 onClose（**不持久化**）；焦点移动不产生 staged 状态，
 *    故无回滚 —— 详见 model-picker.tsx 的 cancel 语义说明；
 *  - ignore → no-op。
 * 焦点条目缺失（条目被重载清空）仍关闭，与内联版本同语义。
 */
export function applyModelPickerKey(
  event: ModalKeyEvent,
  opts: {
    readonly entries: ReadonlyArray<ModelPickerEntry>;
    readonly focusedIndex: number;
    readonly onMove: (index: number) => void;
    readonly onSelect: (routeId: string) => void;
    readonly onClose: () => void;
  }
): void {
  const action = reduceModelPickerKey(event, {
    focusedIndex: opts.focusedIndex,
    entryCount: opts.entries.length,
  });
  switch (action.kind) {
    case "move":
      opts.onMove(action.index);
      break;
    case "fix": {
      const chosen = opts.entries[opts.focusedIndex];
      if (chosen !== undefined) opts.onSelect(modelRouteId(chosen));
      opts.onClose();
      break;
    }
    case "commit":
      opts.onClose();
      break;
    case "ignore":
      break;
  }
}

/**
 * Slice D / SC14：会话消息内两行投影的 chrome 行账（SSOT 派生自投影）。
 * 非 chat 视图不渲染该条 → 0；无 live 子代理 → 0（组件渲染 null）。
 * 抽成模块级函数而非 TuiApp 内联三元，避免给 TuiApp 增分支（S5 硬门）。
 */
function subagentRowBudget(
  view: TuiView,
  subagents: ReadonlyArray<SubagentInfo>
): number {
  return view === "chat" ? subagentMessageRowCount(subagents) : 0;
}

/**
 * `/graph` case 体：翻 graph holder（与 Shift+Tab 同源）并同步 chrome 状态。
 *
 * 抽到模块级：case 内的 `if (!holder)` 分支若留在 handleSubmit 内，会把后者
 * 顶过 S5 ratchet 的 HEAD 基线（既有超阈值函数只许不升）。
 */
function runGraphSlashCommand(
  props: Pick<TuiAppProps, "graphMode">,
  text: string,
  setGraphOn: (enabled: boolean) => void,
  setNotice: (notice: Notice) => void
): void {
  // D-α V1 / SC3：`/graph` 是 Shift+Tab 的非 TTY 对等物 —— 翻同一个
  // holder，解析与文案单点在 harness/graph/mode.ts（三入口同源）。
  const graphCtx = props.graphMode;
  if (!graphCtx) {
    setNotice({ lines: ["图模式未接线（本入口未注入 graph holder）。"] });
    return;
  }
  const res = applyGraphCommand(graphCtx, splitGraphArgs(slashRemainder(text)));
  setGraphOn(graphCtx.get().enabled);
  setNotice({ lines: [res.text] });
}

/**
 * `/config` case 体：翻 fs isolation holder（与 PermissionMode 正交 ——
 * Shift+Tab 不动它），切档成功才落盘。抽到模块级的理由同
 * `runGraphSlashCommand`。
 */
function runConfigSlashCommand(
  props: Pick<TuiAppProps, "fsMode" | "onPersistFsMode">,
  text: string,
  setNotice: (notice: Notice) => void
): void {
  // ADR-0092 / SC13：解析与文案单点在 harness/sandbox/fs-mode.ts（三入口同源）。
  const fsCtx = props.fsMode;
  if (!fsCtx) {
    setNotice({ lines: ["文件系统隔离档未接线（本入口未注入 fs holder）。"] });
    return;
  }
  const args = splitConfigArgs(slashRemainder(text));
  // app 侧只解析一次，同一份结果同时驱动 notice 与落盘判定。`applyFsModeCommand`
  // 内部还会为「改 holder」再解析一次 —— 那是命令 SSOT 的一部分，要合并得让
  // fs-mode.ts 把 kind 透出返回值（不在本入口的改动范围）。
  const cmd = parseConfigCommand(args);
  const res = applyFsModeCommand(fsCtx, args);
  setNotice({ lines: [res.text] });
  // 切档成功才落盘（usage / status 不该写文件）。fire-and-forget：
  // 失败不抛（UI 兜底），成功不阻塞输入。
  if (res.ok && cmd.kind === "set") {
    void props.onPersistFsMode?.(fsCtx.get()).catch((err: unknown) => {
      setNotice({ lines: [`文件系统隔离档保存失败：${describeError(err)}`] });
    });
  }
}

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
  /**
   * Slice D / SC14：会话消息内子代理两行投影的实际行数
   * （`subagentMessageRowCount(subagents)`，每 live 子代理 2 行）。产品路径
   * 必须入账：该条画在输入框上方，行数随 live 子代理数增长；不入账时
   * chrome 总高超出 rows，Yoga 会把两行块压成一行（文本重叠，实测
   * tests/tui/subagent-kill-key.test.tsx）。缺省 0 → 无 live 不占行。
   */
  readonly subagentRows?: number;
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
  /** compact 进度面板行数（compactProgressRows()，6 行）。缺省 0 → 无面板
   *   不占行（旧调用 / 无压缩路径零影响）。 */
  readonly compactRows?: number;
}): number {
  const inputContentRows = Math.max(
    1,
    Math.min(opts.inputRows ?? 1, MAX_INPUT_LINES)
  );
  // 尾部纯增槽位（含 marginBottom 已由各自 +1 表达的项）逐项求和。
  const tailRows =
    panelSlotRows(opts.noticeRows) + // notice + marginBottom
    panelSlotRows(opts.modalRows) +
    panelSlotRows(opts.pickerRows) +
    panelSlotRows(opts.compactRows) + // compact 进度面板 + marginBottom
    // 零默认槽位（缺省 0 = 不占行）求和：逐项 `?? 0` 会把本函数复杂度推过
    // S5 硬门，故共用一个折叠 helper（与 panelSlotRows 同款动机）。
    zeroDefaultRows([
      opts.panelRows,
      opts.subagentRows,
      opts.agentStatusRows,
      opts.envPaneRows,
      opts.verifyRows,
      opts.graphRows,
    ]) +
    (opts.bgLine ? 1 : 0); // 后台运行标记行
  return (
    1 + // top headroom
    1 + // mode指示行
    inputContentRows + // 输入框内容行
    2 + // 输入框圆角边框（顶/底框线）
    opts.inputHintRows +
    1 + // ContextBar
    1 + // ask 槽
    tailRows
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
  /**
   * ADR-0092 / SC13：filesystem isolation 档的会话 holder。`/config` 就地翻
   * 它；引擎（build-engine → bash 工厂）per-call 读同一 holder。缺席 →
   * `/config` 提示未接线（测试 / fixture 兼容；产品路径由 run.tsx 注入）。
   *
   * **与 PermissionMode 正交**：Shift+Tab 的三态轮不动本 holder（授权轴 ≠
   * FS 档轴）。
   */
  readonly fsMode?: FsModeContext;
  /**
   * ADR-0092 / SC13：`/config` 切换后的落盘回调（fire-and-forget）。
   * 产品路径由 run.tsx 注入 `persistFsModeChanges(resolveThinkingSettingsPath(), …)`
   * 的闭包；测试可注入 spy。失败不抛（UI 兜底 setNotice）；成功路径不
   * 阻塞输入。
   */
  readonly onPersistFsMode?: (mode: FsIsolationMode) => Promise<void>;
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
   *  engine `isolationEnabled` 单一读取点的透出）。ADR-0079 后 slash 装配
   *  skill 正文不再消费 `isolationOn`（正文不再挂写根 trailer）；字段保留
   *  以维持 TuiAppProps 装配面兼容 build-engine 透传，未来若有其它渲染面
   *  需要隔离档可继续使用。 */
  readonly isolationOn?: boolean;
  /** #361 Phase D：MCP 看板扩展面（TuiMcpViewExt 最小依赖）。缺省 =
   *  undefined → /mcp 切 view 时提示「MCP 未装配」。产品路径由 run.tsx 经
   *  TuiExtensions 注入；fixture / 测试可选 stub。 */
  readonly mcp?: TuiMcpViewExt;
  /**
   * env 派生显示快照（当前模型路由串 + thinking 基线）的订阅口。product
   * 路径由 run.tsx 装配并传入（`env.llm` 投影的单一发布口）。
   *
   * 未接线（fixture / 大批直挂 TuiApp 的测试）→ 用模块级惰性空 store：读值
   * 恒 undefined（/info 不打 `Model:` 行、ContextBar 不渲染 model 段），
   * 订阅永不触发 —— 与「env 从未变化」等价，行为与旧缺省 prop 一致。
   */
  readonly envDisplay?: EnvDisplayStore;
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
  /**
   * memory-toggle-live: memory_layer system 快照失效句柄（build-engine
   * invalidateMemorySystem 经 deps 透传）。/memory commit 时调用，翻转在
   * 下一轮生效。缺省（测试 / 旧宿主）→ 不调用。
   */
  readonly invalidateMemorySystem?: () => void;
  /**
   * ADR-0093 / specs/tui-model-command.md：provider 注册表（settings
   * `llm.providers` 的启动快照）。`/model` 面板的数据源 —— 展开为
   * provider × models 的扁平条目。缺省 / 空数组 → `/model` 走 notice
   * 「未配置 providers」，不打开面板（测试 / fixture 兼容，行为与今日一致）。
   */
  readonly providers?: ReadonlyArray<IknowSettingsLlmProvider>;
  /**
   * ADR-0093 / spec SC5：`/model` 面板 Enter 选定后的持久化通道。宿主写回
   * settings.json 后必须**显式刷新 env 并重建 adapter**（self-write 哨兵会吞掉
   * 自身写回触发的 watcher 事件，故 reloadFromEnv 不会被自动触发）。返回
   * `{ ok: false; reason }` 或抛错 → app 以 notice 呈现；成功不发 notice
   * （写回是后台行为）。缺省 undefined → 选定后只关闭面板（纯 UI，测试兼容）。
   */
  readonly onPersistModel?: (patch: { readonly model: string }) => Promise<
    | { ok: true }
    | {
        ok: false;
        reason: string;
        stage?: "write" | "reload";
      }
  >;
  /**
   * T2 (#transport-continue-persist): 流式臂上「连续多久没 onStream 事件
   * → 把 notice 改成「仍在等待」」的阈值（毫秒）。缺省 = 20_000（spec
   * invariant 3：~20s 静默只更新 sticky notice copy，**不**自动消失）。
   * 测试可注入小值避开真实 20s 睡眠。注：这是 UI 反馈节流，**不**等同于
   * harness 侧 idle / hardCap（harness 仍按 settings.llm.idleTimeoutMs
   * 默认 300_000 ~ 5 min 决策 fault class）。
   */
  readonly streamingSilenceNoticeMs?: number;
}

interface Notice {
  readonly lines: ReadonlyArray<string>;
}

/**
 * T2 (#transport-continue-persist) UI 反馈节流:流式臂连续无 onStream 事件
 * 多久 → 改 notice 文案为「仍在等待模型输出」(spec invariant 3)。~20s
 * 只是 UI 反馈阈值,**不**影响 harness 侧 idle / hardCap 决策 —— 后者
 * 走 settings.llm.idleTimeoutMs(env > settings > 默认 300_000,见 env.ts)。
 * 改文案而非新增 notice;notice box 仍是 sticky(无 TTL 自动消失,与
 * spec invariant 3 / SC5 同款)。
 */
const DEFAULT_STREAMING_SILENCE_NOTICE_MS = 20_000;

/**
 * 静默阈值解析（S5：`??` 若写在 `runTurnOnce` 内会计入它的圈复杂度，
 * 把已顶到 23 的函数再 +1 —— 解析下沉到本叶子函数）。
 */
function resolveStreamingSilenceNoticeMs(override: number | undefined): number {
  return override ?? DEFAULT_STREAMING_SILENCE_NOTICE_MS;
}

/** 流式静默时把现有 notice 改写为单行「仍在等待」文案(spec 不变式 3)。 */
const STREAMING_SILENCE_NOTICE_LINE =
  "⠿ 仍在等待模型输出（~20s 无新流字节）；如长时间未恢复，建议检查网络连接。";

// spec tui-skill-slash-catalog（skill bare alias）：slash 匹配认 catalog 的
// 唯一裸名别名，展示/加载仍用规范名。别名不新增 catalog 接口 —— 只用公开的
// `available()` / `get()` 推导（invariant 1：不在此处重写 `:` 拆名规则）。
// S5 门：放在 TuiApp 之外，避免 god component 的复杂度随投影逻辑再涨。
//
// 唯一性判据必须与 slash 的匹配语义同一 case-folding：`slash.ts` 的
// `skillHeadLowers` 把首 token 折成小写后做**精确命中**，而 catalog 的裸名
// 索引是大小写敏感的裸 Map。只认 `catalog.get(bare) === entry` 会让裸名仅在
// 大小写上不同的两条（`plugA:Shared` / `plugB:shared`）各拿一个别名，同一
// `/shared` 与 `/Shared` 落到不同条目 —— 歧义。故：
//   1. 候选裸名先过 catalog 侧登记语义：`catalog.get(bare) === entry` ——
//      `get` **先查 canonical index**，所以「裸名被另一条 skill 的规范名占
//      着」的形态（`Echo` 与 `plug:echo`）在此被挡下；
//   2. 候选裸名 + 全部规范名一起按小写折叠进占用表；某个折叠 token 的占用者
//      不唯一（占用者恒是规范名，两条候选裸名只在大小写上不同即此形态）→
//      整组不发别名（宁可不可用，不可歧义）。占用者以**名字**去重，故某条
//      自己的规范名折成自己的裸名时仍算唯一，不会被误伤。
export function toSlashEntries(
  catalog: SkillCatalog
): ReadonlyArray<SkillEntryLike> {
  const entries = catalog.available();
  const bares = entries.map((entry) => {
    if (entry.namespace === undefined) return undefined;
    const bare = stripNamespace(entry.name, entry.namespace);
    return bare !== undefined && catalog.get(bare) === entry ? bare : undefined;
  });
  const claimants = new Map<string, ReadonlyArray<string>>();
  const claim = (name: string, owner: string): void => {
    const key = name.toLowerCase();
    const owners = claimants.get(key) ?? [];
    claimants.set(key, owners.includes(owner) ? owners : [...owners, owner]);
  };
  for (const entry of entries) claim(entry.name, entry.name);
  entries.forEach((entry, i) => {
    const bare = bares[i];
    if (bare !== undefined) claim(bare, entry.name);
  });
  return entries.map((entry, i) => {
    const bare = bares[i];
    const owners =
      bare === undefined ? undefined : claimants.get(bare.toLowerCase());
    if (owners?.length !== 1 || owners[0] !== entry.name) {
      return { name: entry.name, description: entry.description };
    }
    return {
      name: entry.name,
      description: entry.description,
      aliases: [bare!],
    };
  });
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
  // env 派生显示快照的读取口：未接线 → 模块级惰性空 store（读值恒空）。
  const envDisplay = props.envDisplay ?? EMPTY_ENV_DISPLAY_STORE;
  // thinking 控制臂开关（/thinking 切换，与折叠态解耦）。初始基线 =
  // env defaultThinking.mode === "adaptive"；用户 /effort 也会 setEnabled(true)。
  const [thinkingEnabled, setThinkingEnabled] = useState<boolean>(
    () => envDisplay.get().defaultThinking?.mode === "adaptive"
  );
  // thinking 档位（/effort 设置；"" 表示未指定 → 不附加 effort）。初始 =
  // env defaultThinking.effort。
  const [thinkingEffort, setThinkingEffort] = useState<ThinkingEffortWire>(
    () => envDisplay.get().defaultThinking?.effort ?? ""
  );
  // 用户是否**亲手**改过 thinking / effort（ref 而非 state：只影响「env 新
  // 基线要不要覆盖」的判定，本身不驱动渲染）。一旦置位即本会话不再复位 ——
  // /model 切换同样**不**复位它们，这正是 #1021 要修的行为（旧实现每次 env
  // 变化都把这两个 state 拖回新基线，用户手改的覆盖被静默丢弃）。
  const thinkingTouchedRef = useRef(false);
  const effortTouchedRef = useRef(false);
  // env 新基线到达 → 只回填用户**没碰过**的字段。未碰过的字段写入相同值会被
  // React 判为无变化（bailout）不重渲染 —— 于是「只换模型」的 publish 是零
  // 渲染事件，只有 /thinking /effort 留下的覆盖需要显式让位给新基线时才渲染。
  // 语义取舍（有意为之）：用户一旦碰过某字段，本会话后续的 env 基线变化都不
  // 再改写它 —— 显示层与 per-turn override 因此始终一致（override 相对基线
  // 计算，而基线取自 store；若这里被拽回新基线，用户的手改会被静默吞掉）。
  useEffect(() => {
    const unsubscribe = envDisplay.subscribe(() => {
      const snap = envDisplay.get();
      if (!thinkingTouchedRef.current) {
        setThinkingEnabled(snap.defaultThinking?.mode === "adaptive");
      }
      if (!effortTouchedRef.current) {
        setThinkingEffort(snap.defaultThinking?.effort ?? "");
      }
    });
    return unsubscribe;
  }, [envDisplay]);
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
  // /model 面板（spec SC8）：open = 面板可见；focusIndex = 焦点条目下标（面板内
  // 唯一的暂存态）。**焦点移动不产生 staged 状态** —— 没有「未提交的模型选择」
  // 这种东西（唯一的写操作是 Enter），故 Esc 既非保存退出也非放弃修改，见
  // model-picker.tsx 的 cancel 语义说明。
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [modelFocusIndex, setModelFocusIndex] = useState(0);
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
  // compact 进度面板(per-conversation keyed,与 liveToolRuns / agentStatuses
  // 同款归属纪律:事件按到达时的会话分键,渲染只取 active 会话的条目)。
  // 手动 /compact 与 turn 内 auto-compact 共用同一 reduce —— auto 路径此前
  // 对用户完全静默,本面板是它的第一处可见化。
  const [compactPanels, setCompactPanels] = useState<
    Record<string, CompactProgressState>
  >({});
  // 终态停留 timer(conversationId → handle):终态后 HOLD_MS 卸载面板,
  // 让 100% / 失败色可见。新压缩开始 / 卸载时清 pending,防迟到 timer 打到
  // 新面板。
  const compactTimersRef = useRef(
    new Map<string, ReturnType<typeof setTimeout>>()
  );
  /** 清 pending timer(ref 簿记与 clearTimeout 成对,避免漏清)。 */
  function clearCompactTimer(conversationId: string): void {
    const timer = compactTimersRef.current.get(conversationId);
    if (timer !== undefined) {
      clearTimeout(timer);
      compactTimersRef.current.delete(conversationId);
    }
  }
  /** 立即移除面板 + 清 pending timer(no-op / turn finally 清扫用)。 */
  function clearCompactPanel(conversationId: string): void {
    clearCompactTimer(conversationId);
    setCompactPanels((prev) => {
      if (!(conversationId in prev)) return prev;
      const { [conversationId]: _dropped, ...rest } = prev;
      return rest;
    });
  }
  /**
   * 武装 HOLD_MS 卸载 timer(幂等:已武装则不重置 —— 首个终态信号开始计时,
   * 后续重复 settle 不延长停留窗口)。
   *
   * 两条路径都必须武装,且入口不同(turn 路径没有 promise 结果可依赖 ——
   * 压缩发生在 run 内部,终态信号只能来自事件):漏了任何一条,面板就会带着
   * `✓ done` 永久挂在屏上并持续顶着 chrome 行账(Spec review High)。
   */
  function armCompactHoldTimer(conversationId: string): void {
    if (compactTimersRef.current.has(conversationId)) return;
    const timer = setTimeout(() => {
      compactTimersRef.current.delete(conversationId);
      setCompactPanels((prev) => {
        if (!(conversationId in prev)) return prev;
        const { [conversationId]: _dropped, ...rest } = prev;
        return rest;
      });
    }, COMPACT_HOLD_MS);
    compactTimersRef.current.set(conversationId, timer);
  }
  /**
   * 统一终态入口(promise 结果是终态权威,plan D3.5):设终态 + 武装 HOLD_MS
   * 卸载 timer。面板已不在(no-op 已清 / 未曾建立)→ setState no-op;timer 仍
   * 武装但到点是 no-op,无副作用。
   */
  function settleCompactPanelFor(
    conversationId: string,
    kind: CompactTerminalKind
  ): void {
    setCompactPanels((prev) => {
      const current = prev[conversationId];
      if (current === undefined) return prev;
      const next = settleCompactPanel(current, kind, Date.now());
      if (next === current) return prev;
      return { ...prev, [conversationId]: next };
    });
    armCompactHoldTimer(conversationId);
  }
  /**
   * 压缩事件统一投递入口（turn / manual 两条路径共用，plan D3）。
   *
   * 职责三件（顺序敏感）：
   *  1. `compaction_started` → 先清该会话 pending hold timer：新 run 开始，
   *     上一次的卸载 timer 若还在飞，到点会删掉**本次**的新面板（纪律见
   *     compactTimersRef 注释）；
   *  2. reduce 落 state（identity 守卫：非压缩事件 / 未变 → 不触发 re-render）；
   *  3. 终态事件 → 武装 HOLD_MS 卸载 timer。
   *
   * 第 3 件是 Spec review High 的修复点：turn 路径的终态**只能**来自事件
   * （压缩跑在 run 内部，没有 promise 结果可依赖），漏武装即 `✓ done` 面板
   * 永久挂屏 + 持续顶着 chrome 行账。manual 路径重复武装是幂等 no-op。
   */
  function applyCompactEvent(
    conversationId: string,
    event: HarnessStreamEvent,
    source: CompactProgressSource
  ): void {
    if (event.type === "compaction_started") {
      clearCompactTimer(conversationId);
    }
    setCompactPanels((prev) => {
      const next = reduceCompactionEvent(prev[conversationId], event, {
        source,
        nowMs: Date.now(),
      });
      if (next === prev[conversationId]) return prev;
      if (next === undefined) {
        const { [conversationId]: _dropped, ...rest } = prev;
        return rest;
      }
      return { ...prev, [conversationId]: next };
    });
    if (
      event.type === "compaction_completed" ||
      event.type === "compaction_failed" ||
      event.type === "compaction_cancelled"
    ) {
      armCompactHoldTimer(conversationId);
    }
  }
  /**
   * 非终态兜底清扫（plan D3.5 的「finally 强扫」语义，turn / manual 两条路径
   * 共用）：面板仍非终态 → 立即移除，不留 95% 伪在途态。
   *
   * 为什么必须两条路径都扫：promise 结果是终态权威，但前提是每条路径都
   * settle 过。turn 路径的终止点（finally）与 manual 的终止点（catch/finally）
   * 都可能出现「没走到任何 settle 分支」的未来改动 —— 而 hold timer 只在
   * settle 时才起，漏 settle 即**永久残留**。故在两侧终止点各扫一次，把
   * 「漏 settle」从「永久残留」降级为「面板立即消失」。
   */
  function sweepCompactPanel(conversationId: string): void {
    setCompactPanels((prev) => {
      const current = prev[conversationId];
      if (current === undefined || current.terminal !== null) return prev;
      const { [conversationId]: _dropped, ...rest } = prev;
      return rest;
    });
  }
  // 卸载清 pending timer(防 setState-after-unmount)。
  useEffect(() => {
    const timers = compactTimersRef.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);
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
  const hasLiveSubagent = subagents.some(isLiveSubagent);
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
  const skillList = useMemo(() => toSlashEntries(skillCatalog), [skillCatalog]);
  // 活 taskRoot cell（specs/skill-load-write-root.md）：slash 装配以外的
  // chrome 渲染面（sessionLocationLines 经 resolveWorktreeChromeRoot）也
  // 消费。ADR-0079 后 slash 装配不再读此 cell（正文不再挂写根 trailer），
  // 但 cell 仍由 props 透传至此供 chrome 渲染。
  const liveTaskRoot = props.liveTaskRoot;
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
  const liveSubagentCount = subagents.filter(isLiveSubagent).length;
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
    setModelPickerOpen(false);
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
    setModelPickerOpen(false);
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
    /** ADR-0094 SC4-SC5: transport 失败时的网关侧摘要;undefined = 非 transport 失败。 */
    let apiError:
      { readonly status?: number; readonly message: string } | undefined;
    let uncancellableOperationNotice: string | undefined;
    // transport_retry 过程性 notice 追踪 —— completed/maxTurns 收尾时只清
    // 本轮 retry 落下的 notice,不碰 stop_summary 等其他 notice 来源。
    let retryNoticeShown = false;
    // Predicate / continue ValidationError is not a turn: keep EXIT notice,
    // restore idle, do not reload (reload overwrite → 刷新会话失败).
    let skipTurnRefresh = false;
    // T2 (#transport-continue-persist) UI 反馈节流:流式静默 ~20s 后把
    // notice 文案改成「仍在等待」。注意:这是 UI 反馈,不影响 harness idle
    // 决策(harness 仍按 settings.llm.idleTimeoutMs 走)。闭包变量,不进
    // React state —— setTimeout handle 跨 render 无意义,且每次 onStream
    // 触发都要重置,React 状态语义不对。
    const silenceThresholdMs = resolveStreamingSilenceNoticeMs(
      props.streamingSilenceNoticeMs
    );
    let silenceTimerId: ReturnType<typeof setTimeout> | undefined;
    let silenceNoticeShown = false;
    const clearSilenceTimer = (): void => {
      if (silenceTimerId !== undefined) {
        clearTimeout(silenceTimerId);
        silenceTimerId = undefined;
      }
    };
    const armSilenceTimer = (): void => {
      clearSilenceTimer();
      silenceNoticeShown = false;
      if (silenceThresholdMs <= 0) return;
      silenceTimerId = setTimeout(() => {
        silenceTimerId = undefined;
        // 每次静默 episode 仅触发一次更新(sticky notice 已设过同样文案
        // → 同一回合内再 fire 只是覆盖同一字符串,避免 timer churn 与
        // setState 噪音);流式字节恢复时 onStream 重置 silenceNoticeShown
        // → 下一次 silence 可重新落 notice。
        if (silenceNoticeShown) return;
        silenceNoticeShown = true;
        setNotice({ lines: [STREAMING_SILENCE_NOTICE_LINE] });
      }, silenceThresholdMs);
    };
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
      // T2 (#transport-continue-persist): 任何 onStream 事件(增量 / 工具 /
      // 状态快照,凡是流式臂产出的事件)都视作「流式字节到达」→ 重置静默
      // 计时器与 silenceNoticeShown。下一次 silence episode 仍能重新触发
      // 一次 notice 改写(不 spam,见 armSilenceTimer 注释)。
      armSilenceTimer();
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
      // #467 压缩事件:auto-compact(proactive/reactive)此前对用户完全静默,
      // 本面板是它的第一处可见化。与手动路径共用 applyCompactEvent(同一
      // reduce + 同一终态 timer 武装),identity 守卫(非压缩事件返回同一引用)
      // → 不新建对象、不触发 re-render。
      if (event.type.startsWith("compaction_")) {
        applyCompactEvent(targetId, event, "turn");
      }
    };
    try {
      // T2 (#transport-continue-persist): 回合发起即启动静默计时器 —— 即使
      // 第一个流式字节 20s+ 还没到,UI 也应进入「仍在等待」反馈路径(典型
      // 场景:流建立中,首个 text_delta 卡在 backpressure / TLS handshake)。
      // armSilenceTimer() 内部已重置 silenceNoticeShown → 下一次 onStream
      // 不会被既有「仍在等待」streak 吞掉(同一回合内重置文案无害)。
      armSilenceTimer();
      // thinking override gate：仅当用户实际改了状态才透传（初始化即 env
      // 默认 → 不透传，走 stub-model 测试的 cached deps 路径；用户 /thinking
      // /effort 改了 → 透传 per-turn override）。决策逻辑见 thinking-gate.ts
      // computeThinkingOverride（纯函数，已单测）。
      //
      // 基线在**回合发起时**从 store 现读，不用渲染期快照：hub 已按新 env 重建
      // 了 adapter，若这里还按过期基线比对，会相对真实默认值发出错误的
      // per-turn override（把 adapter 刚拿到的基线又覆盖回去）。
      const thinkingOverride: WireThinkingOverride | undefined =
        computeThinkingOverride(
          envDisplay.get().defaultThinking,
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
      // ADR-0094 SC4-SC5: 透传 transport 摘要给 notice 渲染分支;undefined →
      // 走原通用文案。protocolError 命中时供「API error (status): message」用。
      apiError = resp.apiError;
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
      // ADR-0094 SC4-SC5: 4xx 等非瞬态供应商失败不走 TransportRetryExhausted
      // 正常返回路径，而是从 run() reject 抛到这里。带 HTTP status 的提炼结果
      // 才渲染「API error (status): 原文」，与正常返回路径同一文案面；无
      // status（hub 本地校验 ValidationError / NotFoundError 等）不冒充
      // API error → 沿用既有 describeError 文案。
      const thrownApiError = transportApiErrorFromThrow(err);
      if (thrownApiError !== undefined) {
        apiError = thrownApiError;
      }
      const outcome = turnFailureOutcome({ mode, err, thrownApiError });
      if (outcome.stopReason !== undefined) {
        stopReason = outcome.stopReason;
      }
      if (outcome.skipTurnRefresh) {
        skipTurnRefresh = true;
      }
      setNotice({ lines: [...outcome.noticeLines] });
    } finally {
      aborters.current.delete(targetId);
      // T2 (#transport-continue-persist): turn 结束(成功 / cancelled /
      // throw)清掉静默计时器,避免 stuck 在「仍在等待」timer 后续误触 setNotice
      // 与 React 重渲染。**不**清 notice 文案:sticky 纪律(spec SC5)由 turn
      // 收尾的 setNotice(undefined / 异常 stopReason)分支决定,本 finally 不
      // 接管。
      clearSilenceTimer();
      // compact 面板兜底清扫(plan D3.5):turn 结束仍非终态 = 缺终态事件
      // (reactive compact 早返回 / 事件被吞咽)→ 立即清除,不留 95% 伪在途
      // 面板。已终态 → 交给 HOLD_MS timer 自然卸载(不抢它的停留时间)。
      // 与 manual 路径共用 sweepCompactPanel(同一契约,两处终止点各扫一次)。
      sweepCompactPanel(targetId);
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
        // ADR-0094 SC4-SC5: protocolError + apiError 走专用文案(API error
        // (status): message),让网关侧信息透出;其它异常停沿用通用文案
        // （单点 = abnormalStopNoticeLines）。
        setNotice({ lines: abnormalStopNoticeLines(stopReason, apiError) });
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
    // SC12 / plan task 7：先 abort 当前前台 turn 再收尾 —— 前景
    // spawn_subagent(wait:true) 的 inflight promise 会一直等到子代理 per-task
    // 墙钟（缺省 7200s），不 abort 就等于退出挂起。后台会话不动（同一次
    // /quit 的二次确认分支仍负责等它们落盘）。链路见 quit-abort.ts 头注。
    abortForegroundTurnOnQuit({ session: active, aborters: aborters.current });
    await Promise.allSettled([...inflightPromises.current]);
    props.onQuit?.(active.conversationId);
    if (!renderer.isDestroyed) renderer.destroy();
  }

  /** Ctrl+O：折叠态翻转（thinkingExpanded），语义与 /thinking 开关无关。 */
  function toggleThinkingFold(): void {
    setThinkingExpanded((prev) => !prev);
  }

  /**
   * Ctrl+C 打断分支体：running-fg → abort 该会话前台 turn（canInterrupt
   * 是唯一判据，与 /quit / Esc 同源）；否则只出提示，不伪造打断。
   */
  function interruptForegroundTurn(): void {
    if (canInterrupt(active)) {
      const id = active.conversationId;
      const controller =
        id === undefined ? undefined : aborters.current.get(id);
      if (controller !== undefined) {
        controller.abort();
      }
      return;
    }
    setNotice({
      lines: ["Ctrl+C：无前台运行中的 turn；/quit 退出。"],
    });
  }

  /**
   * Ctrl+X 分支体（spec Slice D / SC14–SC15）：强杀 chrome-focus 聚焦的
   * live 子代理。无聚焦 / 陈旧行（子代理刚终态、clamp 尚未跑）→ 纯函数回
   * `kind:"none"` → 空操作，不抛错、不伪造 taskId。行→taskId 映射与
   * SubagentPanel 的 focusedRow 同为 live 行序（见 subagent-kill.ts 头注）。
   */
  function killFocusedSubagent(): void {
    const kill = dispatchKillFocusedSubagent(chromeFocus, subagents);
    if (kill.kind !== "kill") return;
    const aborted = props.bridge.abortSubagentTask(kill.taskId);
    setNotice({
      lines: [
        aborted
          ? `已强杀子代理 ${kill.role ?? kill.taskId}。`
          : `子代理 ${kill.role ?? kill.taskId} 已不在运行。`,
      ],
    });
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
          // ADR-0079 — skill 正文不再挂写根 trailer（与 #337 SC6 形态逐字节
          // 一致）。写处境披露由 worker prior + chat-session rebind 一次性
          // 通知承担，共用 writeRootSegment helper。slash 装配只走 entry +
          // dir 单形态；liveTaskRoot / isolationOn 在本组件仍由 chrome 渲染
          // （sessionLocationLines 经 resolveWorktreeChromeRoot）持有，本
          // 路径不再消费。
          const body = await createSkillBody({ entry, dir: entry.dir });
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
        setNotice({ lines: helpLines(skillNamesForHelp(skillList)) });
        return;
      case "info": {
        setNotice({
          lines: infoLines(
            active,
            activeKey,
            props.bridge.contextWindow,
            {
              enabled: thinkingEnabled,
              effort: thinkingEffort,
            },
            // 调用时读当前快照（不是渲染期捕获）—— env 变化只经 store 发布，
            // 本闭包不随 store 重渲染，读 props/state 会拿到过期值。
            envDisplay.get().model
          ),
        });
        return;
      }
      case "graph": {
        runGraphSlashCommand(props, text, setGraphOn, setNotice);
        return;
      }
      case "config": {
        runConfigSlashCommand(props, text, setNotice);
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
      case "model":
        // ADR-0093 / spec SC8：注册表空 / 缺席 → typed notice（不抛错、不打开
        // picker）；非空 → 打开，焦点初值 = 当前 model 对应条目（找不到 → 0）。
        // 判定在 openModelPickerCommand 内（S5：case 只做一行派发）。
        openModelPickerCommand({
          providers: props.providers,
          // 焦点 seed 取当前快照：picker 打开时用户看到的焦点行 = 此刻生效的
          // 模型（闭包不订阅 store，必须调用时读）。
          model: envDisplay.get().model,
          onEmpty: (lines) => setNotice({ lines }),
          onOpen: (focusIndex) => {
            // 面板互斥：model picker 打开即收起同族面板（与 /memory 同款）。
            setThinkingPickerOpen(null);
            setMemoryPickerOpen(false);
            setModelFocusIndex(focusIndex);
            setModelPickerOpen(true);
          },
        });
        return;
      case "compact": {
        if (active.runState !== "idle") {
          setNotice({
            lines: [compactGuardNoticeFor("busy")],
          });
          return;
        }
        // #548:防止压缩未结束前重复触发(压缩期间 runState 仍 idle,既有 gate
        // 拦不住;用 ref 作同步守护,React state 会有一帧 commit 滞后)。
        if (compactingControllerRef.current !== null) {
          setNotice({
            lines: [compactGuardNoticeFor("in_flight")],
          });
          return;
        }
        const targetId = active.conversationId;
        if (targetId === undefined) {
          setNotice({ lines: [compactGuardNoticeFor("draft")] });
          return;
        }
        // #548:创建专属 AbortController(Esc/Ctrl+C 通过 compactingControllerRef
        // 触发 abort) + observer(透传 compaction_* 进度事件 + compaction_text_delta,
        // 后者经 #550 wrapper 重映射后进入压缩预览)。进度呈现 = design-25 面板
        // (compact-progress.tsx,行账入 chromeReserveRows.compactRows);事件的
        // 归约走 reduceCompactionEvent 同一套纯函数(与 turn 内 auto-compact 共用)。
        const compactController = new AbortController();
        compactingControllerRef.current = compactController;
        // 面板先于任何事件出现(观察者要立刻看到"在压缩",不等第一个事件)。
        // 建面板前清该会话的 pending hold timer(Standards review Low):上一次
        // 压缩的终态 timer 若还在飞,到点会把**本次**的新面板删掉(纪律见
        // compactTimersRef 注释:新压缩开始清 pending)。
        clearCompactTimer(targetId);
        setCompactPanels((prev) => ({
          ...prev,
          [targetId]: startCompactPanel("manual", Date.now()),
        }));
        // #548:onStream 内的 compaction_cancelled 事件标记"中途取消"(bridge
        // 返回 compacted=false,与"无可压缩上下文"同形),promise resolve 后据此
        // 选择不同 notice 文案。闭包变量,无需 React state。
        // 注:pre-aborted signal(early-return at full-compact.ts:262)observer
        // 不触发 — response.cancelled 字段兜底(Low #1 修复),且 settle 由
        // promise 结果驱动(事件只是快路径,终态权威在下面)。
        let cancelledByUser = false;
        try {
          const compactResult = await props.bridge.compactSession(targetId, {
            signal: compactController.signal,
            onStream: (event) => {
              if (event.type === "compaction_cancelled") {
                cancelledByUser = true;
              }
              // 与 turn 路径同一入口(reduce + identity 守卫 + 终态 timer 武装)。
              applyCompactEvent(targetId, event, "manual");
            },
          });
          const compacted = compactResult.compacted;
          // Low #1 兜底:pre-aborted signal 路径 observer 不触发 → 用
          // response.cancelled 兜底。
          if (compactResult.cancelled) cancelledByUser = true;
          if (cancelledByUser) {
            // #548:Claude Code 取消语义 — 会话保持原样,不 sessionCompacted
            // 投影(updatedAt / messages 均不变),仅提示用户。
            settleCompactPanelFor(targetId, "cancelled");
            setNotice({
              lines: [compactCancelledNotice()],
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
            settleCompactPanelFor(targetId, "done");
            // 文案决策 SSOT:compactNoticeFor 纯函数(manual-compact-trigger
            // T2:no-op 支语义为「没有可压缩的上下文」,below_token_threshold
            // 在手动路径抛错)。
            setNotice({
              lines: compactNoticeFor(compactResult.reason, true),
            });
          } else {
            // no-op(compacted:false 且非 cancelled)= 压根没发生压缩 —— 立即
            // 清除面板,不显示伪造的 done(plan D3.5)。
            clearCompactPanel(targetId);
            setNotice({
              lines: compactNoticeFor(compactResult.reason, false),
            });
          }
        } catch (err) {
          settleCompactPanelFor(targetId, "failed");
          setNotice({
            lines: [`${compactFailedNoticePrefix()}${describeError(err)}`],
          });
        } finally {
          // 与 turn 路径对称的兜底清扫(plan D3.5 / Standards review Medium):
          // 上面四分支已覆盖 cancelled / compacted / no-op / catch,但若未来新增
          // 分支漏 settle,pending 面板会永久残留(hold timer 只随 settle 起)。
          // 已终态 → sweep 是 no-op,不抢 HOLD_MS 停留时间。
          sweepCompactPanel(targetId);
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
    // memory-toggle-live: 同一次 commit 让 memory_layer system 快照作废，
    // 翻转（含关闭）在下一轮生效 —— 快照不再困住旧开关态。
    props.invalidateMemorySystem?.();
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

  /**
   * /model 面板 Enter 选定的持久化接线（spec SC5 + SC10）。与 thinking /
   * memory 的 fire-and-forget 不同，这里**必须 await 宿主返回**：宿主要在写回
   * 之后显式刷新 env 并重建 adapter（self-write 哨兵会吞掉自身写回触发的
   * watcher 事件，reloadFromEnv 不会被自动触发），失败以 notice 呈现。
   * 面板已先关闭（选定动作已完成，写回是后台行为）。
   */
  function persistModelFromCommit(model: string): Promise<void> {
    const cb = props.onPersistModel;
    if (cb === undefined) return Promise.resolve();
    return cb({ model }).then(
      (res) => {
        if (!res.ok) {
          setNotice({
            lines: [persistModelFailNotice(res.stage, res.reason)],
          });
        }
      },
      (err) => {
        setNotice({
          lines: [persistModelFailNotice("write", describeError(err))],
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
    // Ctrl+C：打断 running-fg；否则提示。判键复用上方 isCtrlC（同一表达式，
    // 不重复计一个分支）。
    if (isCtrlC) {
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
      interruptForegroundTurn();
      return;
    }
    // Ctrl+X：强杀 chrome-focus 聚焦的 live 子代理（spec Slice D / SC14）。
    // 判键留在 handler（S5：handler 只做键位分派，分支体在 helper 内）。
    if (e.ctrl && e.name === "x") {
      killFocusedSubagent();
      return;
    }
    if (view !== "chat") return;
    // Ctrl+O：切换思考面板折叠态（展开/折叠）。toggleThinkingFold 只翻折叠，
    // 与 /thinking 的开关（thinkingEnabled）解耦。
    if (e.ctrl && e.name === "o") {
      toggleThinkingFold();
      return;
    }
    // /model 面板：活跃时独占键位（与 memory / thinking 面板同款插入点 ——
    // Ctrl 分支之后）。交互语义（spec SC8：↑/↓ 移焦点、Enter 选定 + 持久化 +
    // 关闭、Esc 直接关闭**不持久化**）与键路由在 applyModelPickerKey 内
    // （S5：handler 只做判键 + 派发，分支体在 helper 内）。
    if (modelPickerOpen) {
      applyModelPickerKey(modalKeyEventOf(e), {
        entries: modelPickerEntries(props.providers),
        focusedIndex: modelFocusIndex,
        onMove: setModelFocusIndex,
        onSelect: (routeId) => void persistModelFromCommit(routeId),
        onClose: () => setModelPickerOpen(false),
      });
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
          // 用户亲手改过 → 之后的 env 新基线不再改写本字段（见订阅 effect）。
          thinkingTouchedRef.current = true;
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
          // 一次 /effort 提交同时动了两个字段 → 两者都算「用户亲手改过」，
          // 后续 env 基线变化都不得再把它们拽回去。
          thinkingTouchedRef.current = true;
          effortTouchedRef.current = true;
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
  const pickerRowsForBudget: number =
    view === "chat" && thinkingPickerOpen !== null
      ? thinkingPickerRows(thinkingPickerOpen)
      : view === "chat" && memoryPickerOpen
        ? memoryPickerRows()
        : modelPickerRowsFor(modelPickerOpen, view, props.providers);
  // compact 进度面板:只取 active 会话的条目(与 crunchedOf / verifySlots 同款
  // 归属校验,切走会话不残留别的会话的压缩面板)。
  const activeCompact: CompactProgressState | undefined =
    active.conversationId !== undefined
      ? compactPanels[active.conversationId]
      : undefined;
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
  // /model 面板渲染态（与 pickerState 同款判别：open 时构造，否则 null）。
  const modelState: ModelPickerState | null = modelPickerStateFor(
    modelPickerOpen,
    view,
    props.providers,
    modelFocusIndex
  );
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
  // 环境现势事件仍收（harness 给人不给模型）。D7 / SC6:envPaneRows 槽位现渲染
  // **常驻**会话位置行（0/1 行）—— 主仓 / 非 task 路径照样画,绑任务树只把
  // 同一行路径换成树上根(活 taskRoot 优先),显隐不再由绑定决定。分支取
  // env_snapshot 的 gitBranch;快照尚未到（启动首拍）→ 只画路径段,不留 0 行。
  // 只读投影（sessionLocationLines）,零 git 操作。
  const envPaneRowBudget =
    view === "chat"
      ? sessionLocationLines({
          projectRoot: props.cwd,
          worktreeRoot:
            resolveWorktreeChromeRoot(
              active.workspaceRoot,
              liveTaskRoot?.read()
            ) ?? null,
          branch: envSnapshot?.gitBranch ?? null,
          cols,
        }).length
      : 0;
  // 位置行随快照重算（分支首拍由 env_snapshot 填上）。
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
        compactRows:
          view === "chat" && activeCompact !== undefined
            ? compactProgressRows()
            : 0,
        panelRows: 0,
        // Slice D / SC14：两行投影画在输入框上方 → 必须入账，否则 chrome
        // 溢出把每个 2 行块压成 1 行（行内文本重叠）。
        subagentRows: subagentRowBudget(view, subagents),
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
      {view === "chat" && activeCompact !== undefined && (
        <CompactProgress state={activeCompact} />
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
      {modelState !== null && <ModelPicker state={modelState} />}
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
      {/* plans/tui-chrome-interaction.md T7 + Slice D / SC14 —— 子代理身份条
          （immediately above the prompt）。每个 live 子代理两行（role 行 +
          dim taskPreview 行），live === 0 → 不渲染。行数**入 chrome 行账**
          （`subagentRowBudget` → `chromeReserveRows.subagentRows`，
          每 live 子代理 2 行）—— 不入账时两行块会被 Yoga 压成一行。
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
            // picker 文案（含 /model）折进 pickerPlaceholderFor；未开面板 →
            // undefined，落回 ask / 默认文案（S5：分支体在 helper 内）。
            pickerPlaceholderFor({
              rewindOpen: rewindTargets !== undefined,
              modelPickerOpen,
              memoryPickerOpen,
              thinkingPickerOpen,
            }) ??
            (askPending
              ? askModalActive
                ? "modal 键位接管中（Esc 退回输入）"
                : "y/a/n 确认工具授权（a=总是允许）"
              : "输入消息或 /help")
          }
          active={active.runState === "running-fg"}
          disabled={
            askModalActive ||
            rewindTargets !== undefined ||
            thinkingPickerOpen !== null ||
            memoryPickerOpen ||
            modelPickerOpen ||
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
      {/* chrome footer 顺序（prompt 之下，JSX 顺序 = 视觉顺序 —— 新增行必须
          插在 ContextBar 之后，不得插到 ContextBar 与 PromptInput 之间）：
            ContextBar（model + ctx，prompt 下第一行）→
            session location（路径 · 分支）→ subagent task list → graph。 */}
      {view === "chat" && (
        <box flexDirection="row" justifyContent="flex-start">
          <ContextBar
            lastUsage={active.lastUsage}
            contextWindow={props.bridge.contextWindow}
            running={active.runState === "running-fg"}
            cols={cols}
            activeToolName={activeToolLabel}
            // model 段由 ContextBar 直接订阅 envDisplay —— env 变化不进 React
            // 树，本组件不重渲染、也不必经 props 把模型名传导下去。providers
            // 是启动期常量注册表，仍走 props。
            envDisplay={envDisplay}
            providers={props.providers}
            effortLabel={
              thinkingEnabled ? formatEffortLabel(thinkingEffort) : "off"
            }
          />
        </box>
      )}
      {/* D7 / SC6: 会话位置行（ContextBar 之下、子代理之上；envPaneRows 槽位
          入账不变）—— 常驻 1 行 `路径 · 分支`，绑任务树时同一槽换成树上根。
          不进焦点环、不带 dirty/diff。 */}
      {view === "chat" &&
        sessionLocationLines({
          projectRoot: props.cwd,
          worktreeRoot:
            resolveWorktreeChromeRoot(
              active.workspaceRoot,
              liveTaskRoot?.read()
            ) ?? null,
          branch: envSnapshot?.gitBranch ?? null,
          cols,
        }).map((line, idx) => (
          <text key={idx} fg={line.fg} wrapMode="none">
            {line.text}
          </text>
        ))}
      {/* 子代理状态：路径行之下。不计入 chrome 行账（panelRows=0）。
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

export function infoLines(
  session: TuiSessionState,
  key: string,
  contextWindow: number,
  thinking: { readonly enabled: boolean; readonly effort: ThinkingEffortWire },
  /** 当前模型串（spec SC11：`Model: <provider>/<model>`）。**原样**透出：
   *  无 providers 段时也走同一行，不伪造 provider 前缀。 */
  model: string | undefined
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
  // spec SC11：`Model: <provider>/<model>` 一行。model 未接线（envDisplay 快照
  // 里没有模型路由串）→ 整行退场，不渲染 `Model: undefined`。
  const modelLine = model !== undefined ? [`Model: ${model}`] : [];
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
    ...modelLine,
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

/**
 * ADR-0094 SC4-SC5：viewport API error 单点文案构造。
 *
 * 输入 = `summarizeTransportCause` 的产出（`{ status?, message }`）。status
 * 在场 → 「⚠ API error (status): 原文」；缺席 → 「⚠ API error: 原文」。
 * 三处调用点（continue catch / 默认 catch / 正常返回 notice 分支）共用本
 * helper，禁止再内联重复三元。
 */
function apiErrorNoticeLine(summary: {
  readonly status?: number;
  readonly message: string;
}): string {
  return summary.status !== undefined
    ? `⚠ API error (${summary.status}): ${summary.message}`
    : `⚠ API error: ${summary.message}`;
}

/**
 * throw 路径的供应商失败判别：只有带 HTTP status 的提炼结果才视为供应商
 * /传输层错误（SDK APIError 形状）。hub 侧本地校验错误（ValidationError /
 * NotFoundError 等无 status 的 Error）→ undefined，沿用既有 describeError
 * 文案，不冒充 API error。
 */
function transportApiErrorFromThrow(
  err: unknown
): { readonly status: number; readonly message: string } | undefined {
  const summary = summarizeTransportCause(err);
  return summary !== undefined && summary.status !== undefined
    ? { status: summary.status, message: summary.message }
    : undefined;
}

/**
 * throw 路径整块收口（runTurnOnce catch 的复杂度单点）：按 mode 决定 notice
 * 行 / 停止因 / 是否跳过刷新。continue 的 EXIT / 校验错误不落 stopReason
 * （后续按 completed 投影，保持既有语义）。
 */
function turnFailureOutcome(opts: {
  readonly mode: "append" | "continue" | "wake";
  readonly err: unknown;
  readonly thrownApiError:
    { readonly status?: number; readonly message: string } | undefined;
}): {
  readonly stopReason?: string;
  readonly noticeLines: readonly string[];
  readonly skipTurnRefresh: boolean;
} {
  if (opts.mode === "continue") {
    const exit = continueExitFromError(opts.err);
    if (exit !== undefined) {
      return { noticeLines: continueNoticeFor(exit), skipTurnRefresh: true };
    }
    if (isContinueValidationError(opts.err)) {
      return { noticeLines: [opts.err.message], skipTurnRefresh: true };
    }
    return {
      stopReason: "protocolError",
      noticeLines: [
        opts.thrownApiError !== undefined
          ? apiErrorNoticeLine(opts.thrownApiError)
          : `续跑失败：${describeError(opts.err)}`,
      ],
      skipTurnRefresh: false,
    };
  }
  if (opts.mode === "wake") {
    return {
      stopReason: "protocolError",
      noticeLines: [toSubagentWakeError(opts.err).message],
      skipTurnRefresh: false,
    };
  }
  return {
    stopReason: "protocolError",
    noticeLines: [
      opts.thrownApiError !== undefined
        ? apiErrorNoticeLine(opts.thrownApiError)
        : `turn 失败：${describeError(opts.err)}`,
    ],
    skipTurnRefresh: false,
  };
}

/**
 * 异常 stopReason 分支的 notice 行：protocolError + apiError → API error
 * 专用文案；其余异常停 → 通用「turn 未成功结束」。
 */
function abnormalStopNoticeLines(
  stopReason: string,
  apiError: { readonly status?: number; readonly message: string } | undefined
): string[] {
  return stopReason === "protocolError" && apiError !== undefined
    ? [apiErrorNoticeLine(apiError)]
    : [`⚠ turn 未成功结束（${stopReason}）：可能是连接或模型故障，请重试`];
}

function describeError(err: unknown): string {
  // ADR-0093 / specs/tui-model-command.md SC4：provider 命中但 apiKeyEnv 未设
  // 是 typed **plain object**（非 Error）。必须先按判别联合识别，否则
  // `String(err)` 会打成 `[object Object]`，kind / providerId / apiKeyEnv 全
  // 不可见（code-quality.md typed-error catch 契约）。
  if (isLlmProviderConfigError(err)) {
    return formatLlmProviderConfigError(err);
  }
  if (typeof err === "object" && err !== null && "kind" in err) {
    const kind = String((err as { kind: unknown }).kind);
    return `会话存储错误 [${kind}]`;
  }
  return err instanceof Error ? err.message : String(err);
}
