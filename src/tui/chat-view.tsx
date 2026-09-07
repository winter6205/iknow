/** @jsxImportSource @opentui/react */
/**
 * src/tui/chat-view.tsx
 *
 * #343 T6-B：会话视图（OpenTUI 全内容滚动版，替代 T3 简化壳 + 终结 T5 ink
 * 行级窗口路径）。
 *
 * 滚动纪律（spec SC3 + D3 裁决，沿用 T3）：
 *  - 整体交给内建 `<scrollbox stickyScroll stickyStart="bottom">`——
 *    布局位置由 scrollbox 实测（scrollTop / scrollHeight / viewport.height，
 *    经 ChatViewHandle.scrollbox ref 直查），本文件不产任何行账 / 行窗口
 *    数学，也不估算消息行数（禁行计数零复发，archive 行级窗口全删除）。
 *  - sticky 智能模式：追加内容默认贴底跟随；用户上滚后停止跟随，滚回底部
 *    ±1 行容差后自动恢复。
 *  - 强制滚底通道：ChatViewHandle.scrollToBottom()。
 *
 * 渲染内容（scrollbox 内全部内容，水平整宽，垂直自滚）：
 *  - banner 段（若提供 props.bannerLines）：首段，方案 B — 与消息共享 scroll
 *    space；用户上滚能翻回 banner（不复位 collapse，2026-08-08 裁定）。
 *    眼睛段用 eyeGradientCells 逐 cell 上色（e2 黄昏魔法石渐变：#1a1d6e →
 *    #ffafaf，c 权重 0.6 / r 权重 0.4），info 栏（Version/Cwd/Data dir）取
 *    bannerLines 行尾段；窄终端（bannerLines.length === 1）保持单行降级；
 *  - **视口挂载**（`transcript-viewport.ts`）：session 全量仍在
 *    `session.messages`；OpenTUI 树只挂视口+overscan 内的消息，spacer 撑住
 *    `scrollHeight`。禁止固定条数尾窗 / 行账。Live tail 不进虚拟化集合。
 *    方案 B banner 仍是滚动区首段（可随上翻回到眼睛）。
 *    视口窗口的 scrollTop 来自 `verticalScrollBar` 的 `change` 事件
 *    （赋值 scrollTop 会间接 emit）；禁止 patch setter / rAF 轮询。
 *  - 每条 **已 mount** 消息 → `MessageBlocks`（user → ❯ accent / assistant
 *    → Markdown + thinking 折叠 + tool_use 摘要 + statusMap 状态染色）。
 *    **T7 消息间距 + 底色**：消息间 1 行节奏由 MessageBlocks 根节点
 *    `marginTop` prop 提供（`visibleIndex===0?0:1`，首条无顶部 margin，避免
 *    进入会话时第一行无谓下推造成的间距抖动）。2026-08-22 起 margin 随
 *    MessageBlocks 存亡：折叠后渲染为 null 的消息不再残留 wrapper 幻影
 *    间距。userBg/assistantBg 底色块由 MessageBlocks 内部实现
 *    （paddingX={1} 水平缩进 + paddingY=0 底色贴内容）。
 *  - tail（流式 thinking / draft 面板 + liveToolRuns + legacy liveToolLines
 *    + askLine + spinner）。尾部按真实事件顺序插入：`liveTailSlots` 按
 *    `draftEpoch` 把工具组与草稿段交错 —— 工具 → 文本 → 工具 → 文本
 *    与历史 content 块顺序一致（不再整 turn 合并成一份草稿）。
 *
 * 工具输出展开位置的区分（T3，plans/tui-render-optimization.md）：
 *  - **历史消息里的 preview**：`MessageBlocks.ToolPreviewRows` → 内嵌
 *    `CompletedToolPreviewView`（同源 `completedToolPreview` + 行截断，
 *    主消息流只显截断预览行）；
 *  - **live tail**：`liveToolRuns.map(liveToolPreviewBox)` 保持展开（运行中
 *    工具逐条展开预览行，与「截断历史 preview」是两件事——live 行是尾部
 *    临时面板，不占用历史消息流）。
 *
 * 流式并发防御（spec SC8）：`draftSegments` 与 `thinkingDraftMasked` 经
 * useDeferredValue — 高频更新降级低优先级，与 app 层 startTransition 构成
 * 双向防御。T3 已实现，T6-B 沿用。
 *
 * 禁（与 archive 行级窗口正交）：
 *  - 行计数 / 行窗口数学；
 *  - markdown-lines / message-rows / row-window / chat-flow（已归档行账模块）；
 *  - 镜像渲染树（同一组件既走 MessageBlocks 又走 Clipped 路径）；
 *  - selection / onWindow / HighlightedLine（OpenTUI renderer 处理选区）。
 *
 * ChatViewHandle 保留：scrollToBottom + scrollbox ref 直查。
 *
 * ⚠️ T6-C 再做 app.tsx 接线；本组件在此阶段已具备完整渲染能力，
 * 仅由测试与下游装配消费。
 */
import {
  forwardRef,
  useDeferredValue,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ScrollBoxRenderable } from "@opentui/core";
import { chatWheelScrollAccel } from "./wheel-scroll.js";
import { Markdown } from "./markdown.js";
import { MessageBlocks } from "./message-blocks.js";
import { MessageShell } from "./message-shell.js";
import { liveToolPreviewBox } from "./live-tool-preview.js";
import {
  isTuiHiddenUserMessage,
  type TuiSessionState,
} from "./session-state.js";
import { liveTailSlots, type LiveToolRun } from "./live-tool-state.js";
import { EYE_LINES, eyeGradientCells } from "./banner.js";
import { Spinner } from "./components.js";
import { tuiPalette } from "./theme.js";
import { toolResultStatusMap, toolResultTextMap } from "./tool-summary.js";
import { formatCrunched } from "./run-stats.js";
import { formatThinkingLive, thinkingPeekLines } from "./think-fold.js";
import {
  listenScrollBoxTop,
  selectViewportMountWindow,
} from "./transcript-viewport.js";
import {
  countNamedCalls,
  countToolUsesByName,
  formatTurnActivityFold,
  lastTurnQueryIndex,
  orderedTurnActivitySegments,
  shouldCollapseTurnToolRows,
  shouldShowRetractFold,
  shouldShowThinkingFold,
  shouldShowTurnActivityFold,
  mergeToolUseCounts,
  sliceTurnFrom,
  sumThinkingMsInRange,
  thinkingMsToSeconds,
  toolUseIdsOf,
} from "./turn-activity.js";
import { deriveSlot } from "./tool-settled.js";

export interface ChatViewHandle {
  /**
   * 强制滚底（用户发新消息 / turn 完成时 app 层调用）：scrollTop 直达
   * scrollHeight - viewport 底，sticky 状态随之复位，后续追加恢复跟随。
   */
  scrollToBottom(): void;
  /**
   * scrollbox renderable 直查入口（布局实测 SSOT）：scrollTop /
   * scrollHeight / viewport.height / scrollBy / scrollTo。未挂载时为 null。
   */
  readonly scrollbox: ScrollBoxRenderable | null;
}

export interface ChatViewProps {
  /** 会话状态机（T6-A 已迁入）。消息 + runState + 流式边界。 */
  readonly session: TuiSessionState;
  /** 滚动区宽度（终端列宽）。 */
  readonly cols: number;
  /** 滚动区高度预算（输入框 / 状态栏在 app 层另行固定挂载）。 */
  readonly rows: number;
  /**
   * turn 进行中逐条出现的工具事件文案（legacy formatLiveToolEvent 字符串行）。
   * liveToolRuns 已结构化时退化为尾部补充（与结构化共存，向后兼容）。
   */
  readonly liveToolLines: ReadonlyArray<string>;
  /**
   * T4 (#175)：结构化工具调用实时状态。运行中条目按 `[运行中] name` 渲染，
   * 已完成条目按统一 diff 预览。liveToolReduce 维护顺序；缺省 = 空数组。
   */
  readonly liveToolRuns?: ReadonlyArray<LiveToolRun>;
  /** 流式累积的 masked 助手文本（草稿）。running-fg 渲染于 spinner 之前。
   *  单段兼容：未传 draftSegments 时当作一段。 */
  readonly draftsMasked?: string;
  /** 按 seal 切开的草稿段。有值时优先于 draftsMasked，与 liveToolRuns
   *  的 draftEpoch 交错渲染。 */
  readonly draftSegments?: ReadonlyArray<string>;
  /** 流式 thinking 草稿 masked 文本。thinkingExpanded 决定折叠 / 展开。 */
  readonly thinkingDraftMasked?: string;
  /** 最近一次完成 turn 的运行秒数快照（app 层 runTurnOnce finally 写入
   *  crunchedOf === activeKey 时传）。在消息流末尾渲染 `Crunched for X`，
   *  会话结束后显示，运行中清空（app 层管理 crunchedOf 归属，ChatView 仅做
   *  条件渲染）。缺省 undefined → 不渲染。 */
  readonly crunchedSeconds?: number;
  /** askUser 待决提示（undefined = 无 pending ask）。 */
  readonly askLine?: string;
  /** thinking 折叠面板展开态（false = 隐藏 thinking 明文）。 */
  readonly thinkingExpanded?: boolean;
  /**
   * 方案 B：banner 作为滚动区首段内容（与消息共享 scroll space）。
   * 眼睛放得下时由 banner.ts 画 13 行完整眼；只有点阵本身放不下才单行。
   */
  readonly bannerLines?: ReadonlyArray<string>;
}

export const ChatView = forwardRef<ChatViewHandle, ChatViewProps>(
  function ChatView(props, ref) {
    const sbRef = useRef<ScrollBoxRenderable | null>(null);
    const [scrollTop, setScrollTop] = useState(Number.MAX_SAFE_INTEGER);
    const [itemHeights, setItemHeights] = useState<ReadonlyArray<number>>([]);
    const conversationId = props.session.conversationId;
    const [heightSessionId, setHeightSessionId] = useState(conversationId);
    if (heightSessionId !== conversationId) {
      setHeightSessionId(conversationId);
      setItemHeights([]);
      setScrollTop(Number.MAX_SAFE_INTEGER);
    }
    useLayoutEffect(() => {
      const sb = sbRef.current;
      if (sb === null) return; // EXIT: unmounted scrollbox
      // Official OpenTUI path: slider change → scrollbar `change` { position }.
      // Do not patch scrollTop (Feature Envy) or rAF-poll (sticky still 0).
      return listenScrollBoxTop(sb, (next) => {
        setScrollTop((prev) => (prev === next ? prev : next));
      });
    }, []);
    useImperativeHandle(ref, () => ({
      scrollToBottom() {
        const sb = sbRef.current;
        if (sb === null) return; // EXIT: unmounted
        sb.scrollTop = Math.max(0, sb.scrollHeight - sb.viewport.height);
      },
      get scrollbox() {
        return sbRef.current;
      },
    }));
    // 并发防御：流式草稿高频更新走低优先级（SC8 — spec 同款）。
    const draftSegments = useMemo((): ReadonlyArray<string> => {
      if (props.draftSegments !== undefined) {
        return props.draftSegments;
      }
      if (props.draftsMasked !== undefined && props.draftsMasked.length > 0) {
        return [props.draftsMasked];
      }
      return [];
    }, [props.draftSegments, props.draftsMasked]);
    const deferredSegments = useDeferredValue(draftSegments);
    const deferredThinkingDrafts = useDeferredValue(
      props.thinkingDraftMasked ?? ""
    );
    // statusMap = tool_result 精确配对（与 T6 ToolSummaryRow 状态染色同一 SSOT）。
    // useMemo 稳定下游 props：messages 引用变化时才重算，避免每次 render 产新
    // Map 导致 MessageBlocks 引用 props 变化触发下游重渲染（解决间距抖动）。
    const statusMap = useMemo(
      () => toolResultStatusMap(props.session.messages),
      [props.session.messages]
    );
    // #693 T4 D4:resultTextMap = tool_use_id → tool_result 文本（历史结果预览
    // 数据源）。同源 useMemo 稳定（与 statusMap 同纪律）。
    const resultTextMap = useMemo(
      () => toolResultTextMap(props.session.messages),
      [props.session.messages]
    );
    const running = props.session.runState === "running-fg";
    const thinkingExpanded = props.thinkingExpanded === true;
    // 消息内容宽度留出滚动条 / 安全区余量（scrollbox 实测，不做行数估算）。
    const contentWidth = Math.max(1, props.cols - 2);
    const liveToolRuns = props.liveToolRuns ?? [];
    const renderLiveRuns = (runs: ReadonlyArray<LiveToolRun>) =>
      runs.map((run) => liveToolPreviewBox(run, contentWidth));
    const bannerLines = props.bannerLines ?? [];
    const pal = tuiPalette;
    // thinkingMs 与 session.messages 一一对应。visible 列表会丢掉
    // agent_status / drain 等隐藏 user 消息，下标比盘上短。所有
    // thinkingMs 查找必须映射回 sourceIndex，否则「思考了 N 秒」读到
    // null 槽，折叠行消失，hideThinking 又把消息框里的摘要掐掉。
    const visibleEntries = useMemo(
      () =>
        props.session.messages
          .map((message, sourceIndex) => ({ message, sourceIndex }))
          .filter(({ message }) => !isTuiHiddenUserMessage(message)),
      [props.session.messages]
    );
    const visibleMessages = useMemo(
      () => visibleEntries.map((entry) => entry.message),
      [visibleEntries]
    );
    const sourceIndexOfVisible = useMemo(
      () => visibleEntries.map((entry) => entry.sourceIndex),
      [visibleEntries]
    );
    const thinkingMsAtVisible = (visibleIndex: number): number =>
      sumThinkingMsInRange(props.session.thinkingMs, [
        sourceIndexOfVisible[visibleIndex] ?? visibleIndex,
      ]);
    const measuredViewport = sbRef.current?.viewport.height ?? 0;
    const viewportHeight = measuredViewport > 0 ? measuredViewport : props.rows;
    const mountWindow = useMemo(
      () =>
        selectViewportMountWindow(visibleMessages, {
          scrollTop,
          viewportHeight,
          heights: itemHeights,
        }),
      [visibleMessages, scrollTop, viewportHeight, itemHeights]
    );
    useLayoutEffect(() => {
      const sb = sbRef.current;
      if (sb === null) return; // EXIT: unmounted during measure
      let changed = false;
      const next = visibleMessages.map((_, i) => itemHeights[i] ?? 0);
      for (let i = mountWindow.startIndex; i < mountWindow.endIndex; i++) {
        const node = sb.getRenderable(`tmsg-${i}`);
        const h = node?.height;
        if (
          Number.isFinite(h) &&
          (h as number) > 0 &&
          next[i] !== (h as number)
        ) {
          next[i] = h as number;
          changed = true;
        }
      }
      if (changed) setItemHeights(next);
    }, [
      mountWindow.startIndex,
      mountWindow.endIndex,
      visibleMessages,
      itemHeights,
    ]);
    const lastQueryVisible = lastTurnQueryIndex(visibleMessages);
    // D3（spec specs/tui-tool-settled-appearance.md）：折叠计数只聚合成功且
    // retract 的件 —— resolver 从 statusMap（tool_use_id → 是否失败）派生每件
    // 的 slot；未配对（live running / cancelled）不进计数。
    const inFoldCountOf = (
      call: Readonly<{ readonly id: string; readonly name: string }>
    ): boolean =>
      statusMap.has(call.id) &&
      deriveSlot(call.name, {
        running: false,
        failed: statusMap.get(call.id) === true,
      }).inFoldCount;
    // D3 (tui-display-consistency):折叠作用于每一轮历史 —— 不再切片到
    // lastTurnSlice;`activitySegments` 从 0 起构建(0 = 首条 user query 之前的
    // assistant 起步;lastQueryVisible < 0 → 全历史)。
    const activitySegments = orderedTurnActivitySegments(visibleMessages, 0, {
      inFoldCountOf,
    });
    // last-turn live 计数(工具运行中状态接棒 / 合并最后一段折叠用)。
    // live 已完成件同样只聚合 slot.inFoldCount（retract 收）；keep / accent /
    // failed 件留在 tail 画独立标题行，不进计数。
    const lastTurnSlice = sliceTurnFrom(visibleMessages, lastQueryVisible);
    const historyToolCounts = countToolUsesByName(lastTurnSlice, {
      inFoldCountOf,
    });
    const liveCompletedCounts = countNamedCalls(
      liveToolRuns
        .filter((run) => run.status !== "running")
        .filter(
          (run) =>
            deriveSlot(run.name, {
              running: false,
              failed: run.status === "failed",
            }).inFoldCount
        )
        .map((run) => ({ id: run.id, name: run.name })),
      toolUseIdsOf(lastTurnSlice)
    );
    const turnToolCounts = mergeToolUseCounts(
      historyToolCounts,
      liveCompletedCounts
    );
    const turnToolTotal = turnToolCounts.reduce((n, e) => n + e.count, 0);
    // plans/tui-chrome-interaction.md T1:折叠按**已完成单元**判定,running
    // 不再一刀切压制整轮折叠;具体行渲染由 per-segment 闸门承担。本变量
    // 保留作为「当前 turn 折叠行是否启用」的 helper（只控 `foldDisplayLines`
    // 与 tail 折叠判定,不再卡整轮 foldLinesBySegmentIndex 的计算入口）。
    const showTurnFold = shouldShowTurnActivityFold({
      running,
      turnToolTotal,
    });
    // D3 (thinking-fold-placement):整 turn 折叠秒数归属 —— loop-engine 单
    // commit 点(loop-engine.ts:2016-2020)只把 thinkingMs 挂在 final assistant
    // 索引;非 final assistant 的 thinkingMs 全为 null。当折叠簇 anchor ≠
    // final 时,按 anchor 求和得 0,导致 final 的思考秒数漂到 per-message
    // ThinkingSummary 处与簇折叠行错位/重复。
    // 不变式:整 turn 的思考秒数在折叠行只出现一次、挂在与思考实际发生的
    // assistant 消息最近的簇 fold 行 —— 实现 = 末位 tool 簇在 anchor 自身
    // thinkingMs 为 0 时,fall back 到 final 的 thinkingMs(独占,不重复;
    // 前序簇继续走纯 anchor 求和,避免重复计数)。
    const lastAssistantMessageIndex = (() => {
      for (let i = visibleMessages.length - 1; i >= 0; i--) {
        const m = visibleMessages[i];
        if (m !== undefined && m.role === "assistant") return i;
      }
      return -1;
    })();
    const finalThinkingMs = thinkingMsAtVisible(lastAssistantMessageIndex);
    // 已被折叠行吸收过 thinkingMs 的 assistant messageIndex 集合 —— 同
    // messageIndex 上的后续 tools 簇(tool → text → tool)按 0 计,保证
    // 「思考了 N 秒」同一回合至多画一次(CONTEXT.md unit fold 收口)。
    const consumedThinkingMessageIndices = new Set<number>();
    // 每簇独立的折叠行（思考秒数 = thinkingMs[anchorMsgs] 求和 → 秒）。
    // plans T1:`if (showTurnFold)` 包裹删除 —— per-segment 闸门
    // `shouldShowRetractFold` / `shouldShowThinkingFold` 与 running 解耦,
    // 历史 retract folds 在 running turn 期间仍要渲染;整 turn 一律按
    // 已完成单元判定。空 entries + 0 秒数 → `formatTurnActivityFold` 返
    // 空数组,segMap 跳过写入,渲染层 fold 行天然不出。
    const foldLinesBySegmentIndex = new Map<number, ReadonlyArray<string>>();
    {
      const toolSegments = activitySegments.flatMap((segment, segmentIndex) =>
        segment.kind === "tools" ? [{ segment, segmentIndex }] : []
      );
      const lastSegmentIndex =
        toolSegments[toolSegments.length - 1]?.segmentIndex ?? -1;
      for (const [, { segment, segmentIndex }] of toolSegments.entries()) {
        // 最后一段折叠合并 live 已完成工具;其余段用纯历史计数。
        const entries =
          segmentIndex === lastSegmentIndex
            ? mergeToolUseCounts(segment.entries, liveCompletedCounts)
            : segment.entries;
        // 折叠簇思考秒数：thinkingMs[anchorMsgs] 求和 → 秒。
        // anchorMsgs = 该簇的 assistant messageIndex 序列(单消息簇 = 单元素)。
        // thinking-fold-placement:末位 tool 簇 anchor ≠ final 且 anchor 自身
        // thinkingMs 为 0 时,归入 final 的 thinkingMs(独占展示位置,避免
        // 漂到 per-message ThinkingSummary);前序簇继续按 anchor 求和(若有
        // 多个独立 thinkingMs 已在测试 2 验证「严格归属到 anchor」不变式)。
        // unit-fold 收口(CONTEXT.md):「思考了 N 秒」同一 assistant 回合
        // 至多一次 —— 同一 messageIndex 已被先前簇消耗过秒数时,本簇按 0
        // 计(折叠行只剩工具计数),秒数不重复画。
        let clusterMs = thinkingMsAtVisible(segment.messageIndex);
        if (
          clusterMs === 0 &&
          segmentIndex === lastSegmentIndex &&
          segment.messageIndex !== lastAssistantMessageIndex &&
          finalThinkingMs > 0
        ) {
          clusterMs = finalThinkingMs;
        }
        // unit-fold 收口:同一 assistant messageIndex 在多 tools 簇(tool
        // → text → tool)共享 thinkingMs,「思考了 N 秒」同一回合至多画
        // 一次。已被前面任一簇吸收过的 messageIndex 在本簇按 0 计,本簇
        // 只画工具计数。
        if (
          clusterMs > 0 &&
          consumedThinkingMessageIndices.has(segment.messageIndex)
        ) {
          clusterMs = 0;
        }
        const clusterSeconds = thinkingMsToSeconds(clusterMs);
        const segmentRetractTotal = entries.reduce((n, e) => n + e.count, 0);
        // plans T1:per-segment 闸门与 running 解耦 —— retract 完成即入
        // 折叠;thinkingMs 冻结即显示秒数。running 仅在 foldDisplayLines /
        // tail 折叠判定等整-turn 决策点参与,不在此处压制。
        if (
          !shouldShowRetractFold({
            running,
            segmentRetractTotal,
          }) &&
          !shouldShowThinkingFold({
            running,
            hasThinkingMs: clusterSeconds > 0,
          })
        ) {
          continue;
        }
        const lines = formatTurnActivityFold(clusterSeconds, entries);
        if (lines.length > 0) {
          foldLinesBySegmentIndex.set(segmentIndex, lines);
          // 簇实际用上秒数（>0）才登记消耗 —— 0 秒簇不会画「思考了 N 秒」,
          // 不抢后续簇的秒数位。
          if (clusterSeconds > 0) {
            consumedThinkingMessageIndices.add(segment.messageIndex);
          }
        }
      }
      // 无工具段但有已完成的 live 工具 / final thinkingMs > 0 → 把折叠行
      // 挂到最近的 text 段尾。thinking-fold-placement:扩展触发条件 —
      // final assistant 思考秒数(落盘 thinkingMs[final])在场时,即使无
      // live 已完成工具,也要把折叠行挂出,避免 final 的思考秒数丢失。
      // plans T1:fallback 路径同样与 running 解耦 —— final 的 thinkingMs
      // 冻结后,即便 turn 仍在 running,「思考了 N 秒」也要立刻可见。
      const fallbackTrigger =
        liveCompletedCounts.length > 0 || finalThinkingMs > 0;
      if (foldLinesBySegmentIndex.size === 0 && fallbackTrigger) {
        const lastText = activitySegments
          .map((segment, segmentIndex) => ({ segment, segmentIndex }))
          .reverse()
          .find(({ segment }) => segment.kind === "text");
        if (lastText !== undefined) {
          const clusterMs = thinkingMsAtVisible(lastText.segment.messageIndex);
          const clusterSeconds = thinkingMsToSeconds(clusterMs);
          const fallbackRetractTotal = liveCompletedCounts.reduce(
            (n, e) => n + e.count,
            0
          );
          if (
            !shouldShowRetractFold({
              running,
              segmentRetractTotal: fallbackRetractTotal,
            }) &&
            !shouldShowThinkingFold({
              running,
              hasThinkingMs: clusterSeconds > 0,
            })
          ) {
            // 闸门拒绝 → 不写 fallback 行,保留空 foldLinesBySegmentIndex。
          } else {
            const lines = formatTurnActivityFold(
              clusterSeconds,
              liveCompletedCounts
            );
            if (lines.length > 0) {
              foldLinesBySegmentIndex.set(lastText.segmentIndex, lines);
            }
          }
        }
      }
    }
    // plans T1:当前 turn 折叠行是否在场 —— 决定流式 thinking 面板是否
    // 让位给折叠行。任一折叠行 anchor 落在 current turn slice 内(消息
    // 下标 >= lastQueryVisible)即视为当前 turn 已有 fold 行,live 面板
    // 隐藏；否则面板保留（让用户继续看思考过程）。
    const currentTurnHasFold =
      lastQueryVisible >= 0 &&
      Array.from(foldLinesBySegmentIndex.keys()).some((segmentIndex) => {
        const seg = activitySegments[segmentIndex];
        return (
          seg !== undefined &&
          seg.kind === "tools" &&
          seg.messageIndex >= lastQueryVisible
        );
      });
    // thinking-fold-placement:折叠行已展示的 thinkingMs 值集合（ms）—— 按
    // 折叠行文案 `思考了 N 秒` 反推;per-message ThinkingSummary 仅在该值
    // 未被任何 fold 行覆盖时显示,避免重复 / 串位（fold 行 0-多次）。
    const shownThinkingMsValues = new Set<number>();
    {
      const re = /思考了\s+(\d+)\s+秒/;
      for (const lines of foldLinesBySegmentIndex.values()) {
        for (const line of lines) {
          const m = re.exec(line);
          if (m !== null) {
            const seconds = Number(m[1]);
            if (Number.isFinite(seconds) && seconds > 0) {
              shownThinkingMsValues.add(seconds * 1000);
            }
          }
        }
      }
    }
    // Keep the tail-collapse decision based on the fold that would be shown,
    // not on whether an historical message supplied an insertion point.
    const foldDisplayLines = showTurnFold
      ? formatTurnActivityFold(
          thinkingMsToSeconds(thinkingMsAtVisible(lastQueryVisible)),
          turnToolCounts
        )
      : [];
    // 折叠生效（idle 且计数行在场）→ tail 里已完成的 retract 件（已进折叠
    // 计数）离开尾巴；keep / accent / failed 件保留独立标题行（D3/D7：渲染
    // 只消费 slot，成功 retract 的标题与预览同假）。running 件始终在尾巴。
    const collapseToolRows = shouldCollapseTurnToolRows(
      running,
      foldDisplayLines.length,
      turnToolTotal
    );
    const tailSlots = liveTailSlots(
      collapseToolRows
        ? liveToolRuns.filter(
            (run) =>
              run.status === "running" ||
              !deriveSlot(run.name, {
                running: false,
                failed: run.status === "failed",
              }).inFoldCount
          )
        : liveToolRuns,
      deferredSegments
    );
    // #693 T1 D1：折叠行（思考了 N 秒 / bash × N）统一套壳，与
    // assistant 外壳共用 MessageShell —— 消除「折叠行裸挂左移一列」的
    // 不一致（spec D1）。壳内文本 wrapMode="none" 强制单行不折。
    const renderFoldLines = (segmentIndex: number, keyPrefix: string) => {
      const lines = foldLinesBySegmentIndex.get(segmentIndex) ?? [];
      if (lines.length === 0) return null;
      return (
        <MessageShell
          key={`${keyPrefix}-shell-${segmentIndex}`}
          cols={contentWidth}
        >
          {lines.map((line, foldIdx) => (
            <text
              key={`${keyPrefix}-${segmentIndex}-${foldIdx}`}
              fg={pal.dim}
              wrapMode="none"
              width={Math.max(1, contentWidth - 2)}
            >
              {line}
            </text>
          ))}
        </MessageShell>
      );
    };
    // e2 黄昏魔法石渐变（与 scripts/banner-gradient-preview/exotic-e2.ts 一致）：
    // 13×32 逐 cell 上色，对角线 t = cWeight·(c/31) + rWeight·(r/12)。
    const eyeGradient = eyeGradientCells({
      from: pal.logoInk,
      to: pal.logoGold,
      cWeight: 0.6,
      rWeight: 0.4,
    });
    // renderBannerLines 每行 = EYE_LINES[r] + GAP(3) + info 栏；info 栏从
    // bannerLines 行尾段切出（banner.ts 布局 SSOT，GAP 同值）。
    const EYE_W = [...(EYE_LINES[0] ?? "")].length;
    const BANNER_GAP = 3;
    return (
      <scrollbox
        ref={sbRef}
        width={props.cols}
        height={props.rows}
        stickyScroll={true}
        stickyStart="bottom"
        scrollAcceleration={chatWheelScrollAccel}
      >
        {/* banner 段（首段，与消息共享 scroll space）。#321 设计定案：圆角外框 +
            顶框内嵌 title `◆ iknow`（操作员要求靠左；与 PromptInput 同款
            borderStyle="rounded"，borderColor 用 pal.border 灰棕，不与眼形撞色）。
            e2 黄昏魔法石渐变：眼睛段逐 cell 上色（eyeGradientCells，对角线
            t = 0.6·(c/31) + 0.4·(r/12)，端点 pal.logoInk → pal.logoGold）；
            info 栏（Version/Cwd/Data dir）取 bannerLines 行尾段；窄终端
            （renderBannerLines 返回单行 short）保持单行降级。 */}
        {bannerLines.length > 0 && (
          <box
            flexDirection="column"
            borderStyle="rounded"
            borderColor={pal.border}
            title="◆ iknow"
            titleAlignment="left"
            paddingX={1}
          >
            {bannerLines.length === 1 ? (
              <text key="banner-short" fg={pal.logoInk} wrapMode="none">
                {bannerLines[0] === "" ? " " : bannerLines[0]}
              </text>
            ) : (
              eyeGradient.map((row, r) => {
                // 行尾段 = GAP 之后的 info 栏（banner.ts renderBannerLines 布局）。
                const infoPart = (bannerLines[r] ?? "").slice(
                  EYE_W + BANNER_GAP
                );
                return (
                  <text key={`banner-${r}`} wrapMode="none">
                    {row.map((seg, c) => (
                      <span key={`b-${r}-${c}`} fg={seg.hex}>
                        {seg.text}
                      </span>
                    ))}
                    <span fg={pal.logoInk}>
                      {infoPart === "" ? " " : infoPart}
                    </span>
                  </text>
                );
              })
            )}
          </box>
        )}
        {/* 视口挂载：只 map 视口+overscan 内的消息，spacer 撑住滚动高度。
            消息间 1 行节奏由 MessageBlocks 根节点 marginTop prop 提供
            （随消息存亡）；全量第一条 (visibleIndex===0) 不带顶部 margin。 */}
        {mountWindow.spacerBefore > 0 && (
          <box
            key="transcript-spacer-before"
            width={contentWidth}
            height={mountWindow.spacerBefore}
            flexShrink={0}
          />
        )}
        {mountWindow.mounted.map((message, i) => {
          const visibleIndex = mountWindow.startIndex + i;
          // D3 (tui-display-consistency):`thinkingMs` 来自落盘数据(挂在
          // session.thinkingMs 上,与 messages 一一对应);无 thinkingMs →
          // undefined → `MessageBlocks` 不显示「思考了 N 秒」折叠行。
          const messageThinkingMs = thinkingMsAtVisible(visibleIndex);
          const messageThinkingSeconds = thinkingMsToSeconds(messageThinkingMs);
          const messageSegments = activitySegments
            .map((segment, segmentIndex) => ({ segment, segmentIndex }))
            .filter(({ segment }) => segment.messageIndex === visibleIndex);
          const renderInContentOrder =
            message.role === "assistant" &&
            messageSegments.length > 1 &&
            messageSegments.some(({ segmentIndex }) =>
              foldLinesBySegmentIndex.has(segmentIndex)
            );
          // D3:`inLastTurn` 闸已删除。任何已完成工具轮次都折叠（包含历史轮次）。
          // hideThinking 改为按 thinkingMs 是否已被 fold 行吸收：
          // thinking-fold-placement —— 折叠行已替代「思考了 N 秒」摘要时
          // 才隐藏 per-message ThinkingSummary,避免重复;若本消息的
          // thinkingMs 值未被任何 fold 行覆盖,仍保留 per-message 摘要
          // (测试 2:asst-1 的 12s 与 final 的 25s 各自唯一展示)。
          const thisMessageHasFoldLine = messageSegments.some(
            ({ segmentIndex }) => foldLinesBySegmentIndex.has(segmentIndex)
          );
          const hideThinkingForThisMessage =
            (thisMessageHasFoldLine ||
              (messageThinkingMs > 0 &&
                shownThinkingMsValues.has(messageThinkingMs))) &&
            !thinkingExpanded;
          return (
            <box
              id={`tmsg-${visibleIndex}`}
              key={visibleIndex}
              width={contentWidth}
              flexShrink={0}
            >
              {renderInContentOrder ? (
                messageSegments.map(({ segment, segmentIndex }, partIndex) => {
                  const blockIndex = segment.contentBlockIndex;
                  const nextSegment = messageSegments[partIndex + 1]?.segment;
                  const endIndex =
                    nextSegment?.messageIndex === visibleIndex
                      ? nextSegment.contentBlockIndex
                      : message.content.length;
                  const activityBlocks =
                    segment.kind === "text"
                      ? [message.content[blockIndex]].filter(
                          (block) => block !== undefined
                        )
                      : message.content
                          .slice(blockIndex, endIndex)
                          .filter((block) => block.type === "tool_use");
                  const thinkingBlocks =
                    partIndex === 0
                      ? message.content.filter(
                          (block) =>
                            block.type === "thinking" ||
                            block.type === "redacted_thinking"
                        )
                      : [];
                  const segmentMessage = {
                    ...message,
                    content: [...thinkingBlocks, ...activityBlocks],
                  };
                  // 该簇是否已有折叠行 → 决定本段是否隐藏 thinking 与
                  // tool_use 摘要(折叠行已在 MessageShell 内替代二者)。
                  // 按 shownThinkingMsValues 反推:fold 行已展示的 ms 值,
                  // per-message 不再画 ThinkingSummary,避免重复。
                  const segmentHasFold =
                    foldLinesBySegmentIndex.has(segmentIndex);
                  const hideSegmentThinking =
                    (segmentHasFold ||
                      (messageThinkingMs > 0 &&
                        shownThinkingMsValues.has(messageThinkingMs))) &&
                    !thinkingExpanded;
                  return (
                    <box
                      key={`turn-segment-${visibleIndex}-${segmentIndex}`}
                      flexDirection="column"
                    >
                      <MessageBlocks
                        message={segmentMessage}
                        cols={contentWidth}
                        statusMap={statusMap}
                        resultTextMap={resultTextMap}
                        thinkingExpanded={thinkingExpanded}
                        thinkingSeconds={
                          partIndex === 0 ? messageThinkingSeconds : undefined
                        }
                        hideThinking={hideSegmentThinking}
                        marginTop={
                          partIndex === 0 && visibleIndex !== 0 ? 1 : 0
                        }
                      />
                      {renderFoldLines(segmentIndex, "turn-fold")}
                    </box>
                  );
                })
              ) : (
                <>
                  <MessageBlocks
                    message={message}
                    cols={contentWidth}
                    statusMap={statusMap}
                    resultTextMap={resultTextMap}
                    thinkingExpanded={thinkingExpanded}
                    thinkingSeconds={messageThinkingSeconds}
                    hideThinking={hideThinkingForThisMessage}
                    marginTop={visibleIndex === 0 ? 0 : 1}
                  />
                  {messageSegments.flatMap(({ segmentIndex }) =>
                    renderFoldLines(segmentIndex, "turn-fold")
                  )}
                </>
              )}
            </box>
          );
        })}
        {mountWindow.spacerAfter > 0 && (
          <box
            key="transcript-spacer-after"
            width={contentWidth}
            height={mountWindow.spacerAfter}
            flexShrink={0}
          />
        )}
        {/* crunched 留存行：消息流末尾（末条消息之后、live tail 之前）。
            最近一次完成 turn 的运行时长（app 层 finally 快照传
            crunchedSeconds）；>0 才渲染（sub-second 回合不显 `0s`），
            缺省 undefined / 0 → 无输出。与 [思考] 折叠行同款 dim 视觉。 */}
        {(props.crunchedSeconds ?? 0) > 0 && (
          <text fg={pal.dim} wrapMode="none">
            {formatCrunched(props.crunchedSeconds ?? 0)}
          </text>
        )}
        {/* 流式尾部：工具组与草稿段按 draftEpoch 交错（主流 agent 顺序：
            工具 → 文本 → 工具 → 文本）。liveToolLines 仍挂在末尾（legacy）。
            #tui-render-overhaul T4:多块时相邻 slot 间补 1 行节奏（与
            MessageBlocks 内部块间距同步），首块不补顶 margin —— 锚在历史
            折叠行 / 草稿段末尾的尾巴接续位置自然衔接。 */}
        {tailSlots.map((slot, i) => {
          const slotGap = i === 0 ? 0 : 1;
          return slot.kind === "tools" ? (
            <box
              key={`live-tools-${i}`}
              flexDirection="column"
              width={contentWidth}
              marginTop={slotGap}
            >
              {renderLiveRuns(slot.runs)}
            </box>
          ) : (
            running && (
              <MessageShell
                key={`live-draft-${i}`}
                cols={contentWidth}
                marginTop={slotGap}
              >
                <Markdown
                  text={slot.text}
                  width={Math.max(1, contentWidth - 2)}
                  streaming
                />
              </MessageShell>
            )
          );
        })}
        {/* 流式 thinking 面板：跟在已返回的 live 正文 / 工具后面，而不是
            钉在 live 区顶部。思考 → 正文 时 stream-draft 会清 buffer 收起
            本面板；下一轮 thinking_delta 再出现在这段正文下面。
            折叠态 = 静态 `思考中…` + 正文末 ≤3 行预览；展开态走 Markdown。
            plans T1:`showTurnFold` 不再作为隐藏闸门 —— 历史 folds 在 running
            期也会在场。改为「当前 turn 折叠行是否在场」(`currentTurnHasFold`)
            才隐藏 live 面板：fold 行不存在 + draft 仍在流 → 面板保留;
            current turn 已有折叠行 → 面板让位给折叠行。 */}
        {running &&
          deferredThinkingDrafts.length > 0 &&
          !currentTurnHasFold &&
          !shouldShowThinkingFold({
            running,
            hasThinkingMs: finalThinkingMs > 0,
          }) && (
            <box flexDirection="column" width={contentWidth}>
              {thinkingExpanded ? (
                <box width={contentWidth}>
                  <Markdown
                    text={deferredThinkingDrafts}
                    width={contentWidth}
                    streaming
                  />
                </box>
              ) : (
                <>
                  <text fg={pal.dim} wrapMode="none">
                    {formatThinkingLive()}
                  </text>
                  {thinkingPeekLines(deferredThinkingDrafts).map((line, i) => (
                    <text key={`think-peek-${i}`} fg={pal.dim} wrapMode="none">
                      {line}
                    </text>
                  ))}
                </>
              )}
            </box>
          )}
        {props.liveToolLines.length > 0 && (
          <box flexDirection="column" width={contentWidth}>
            {props.liveToolLines.map((line, i) => (
              <text key={`legacy-${i}`} fg={pal.dim} wrapMode="none">
                {line === "" ? " " : line}
              </text>
            ))}
          </box>
        )}
        {props.askLine !== undefined && (
          <text fg={pal.running} wrapMode="word" width={contentWidth}>
            {props.askLine}
          </text>
        )}
        {running && <Spinner />}
      </scrollbox>
    );
  }
);
