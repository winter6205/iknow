/** @jsxImportSource @opentui/react */
/**
 * src/tui/chat-view.tsx
 *
 * #343 T6-B：会话视图（OpenTUI 全内容滚动版，替代 T3 简化壳 + 终结 T5 ink
 * 行级窗口路径）。#986：本文件归零到 S5 hard-gate error 0、嵌套 ≤4、
 * ChatView complexity ≤10 —— 把折叠派生抽到 `turn-fold-lines.ts`、banner
 * 抽到 `transcript-banner.tsx`、挂载消息行抽到 `message-row.tsx`、尾部抽
 * 到 `transcript-tail.tsx`；本文件保留 hooks + memo 派生 + scrollbox 装配。
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
 *  - banner 段（若提供 props.bannerLines）：首段，与消息共享 scroll space。
 *    实现由 `<TranscriptBanner>` 承担。
 *  - **视口挂载**（`transcript-viewport.ts`）：session 全量仍在
 *    `session.messages`；OpenTUI 树只挂视口+overscan 内的消息，spacer 撑住
 *    `scrollHeight`。禁止固定条数尾窗 / 行账。Live tail 不进虚拟化集合。
 *    视口窗口的 scrollTop 来自 `verticalScrollBar` 的 `change` 事件
 *    （赋值 scrollTop 会间接 emit）；禁止 patch setter / rAF 轮询。
 *  - 每条 **已 mount** 消息 → `<MessageRow>`（透传 visibleIndex /
 *    foldLinesBySegmentIndex / 派生 messageSegments）。
 *  - tail（流式 thinking / draft 面板 + liveToolRuns + legacy liveToolLines
 *    + askLine + spinner）：由 `<TranscriptTail>` 承担。
 *
 * 工具输出展开位置的区分（T3，plans/tui-render-optimization.md）：
 *  - **历史消息里的 preview**：在 `<MessageRow>` 内部走
 *    `MessageBlocks.ToolPreviewRows` → `CompletedToolPreviewView`；
 *  - **live tail**：`<TranscriptTail>` 走 `liveToolPreviewBox` 路径。
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
 */
import {
  forwardRef,
  useDeferredValue,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { ScrollBoxRenderable } from "@opentui/core";
import type { AnthropicNativeMessage } from "../harness/model-adapter/types.js";
import type { SubagentInfo } from "../harness/subagent/manager.js";
import { chatWheelScrollAccel } from "./wheel-scroll.js";
import {
  attachScrollbarHover,
  scrollbarThumbColor,
  scrollbarTrackColor,
} from "./scrollbar-style.js";
import {
  isTuiHiddenUserMessage,
  type TuiSessionState,
} from "./session-state.js";
import { liveTailSlots, type LiveToolRun } from "./live-tool-state.js";
import { liveToolRunsBox } from "./live-tool-preview.js";
import {
  subagentCardLinesMap,
  subagentCardsKey,
  type SubagentCardLines,
} from "./subagent-message-lines.js";
import { toolResultStatusMap, toolResultTextMap } from "./tool-summary.js";
import {
  listenScrollBoxTop,
  resolveScrollCommitStep,
  selectViewportMountWindow,
  shouldCommitScrollTop,
  type ViewportMountWindow,
} from "./transcript-viewport.js";
import { orderedTurnActivitySegments, toolUseIdsOf } from "./turn-activity.js";
import { isLiveNoise } from "./tool-settled.js";
import { TranscriptBanner } from "./transcript-banner.js";
import { MessageRow, messageSegmentsOfVisible } from "./message-row.js";
import {
  TranscriptTail,
  TailSpacer,
  type TailSlotDecision,
} from "./transcript-tail.js";
import {
  buildActivityBlockFoldLines,
  makeThinkingMsAtVisibleFromSource,
  type FoldLinesBySegmentIndex,
  type ShownThinkingMsValues,
  type ThinkingMsAtVisible,
} from "./turn-fold-lines.js";
import type { TurnActivitySegment } from "./turn-activity.js";

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
  /** specs/tui-subagent-transcript-live.md：子代理只读投影（app 层 1Hz 轮询
   *  的 `bridge.listSubagents()`）。本组件按 `toolUseId` join 到 spawn 卡；
   *  缺省 / 空 → 卡片与改前逐字节一致（历史卡单行摘要、live 卡既有形态）。 */
  readonly subagents?: ReadonlyArray<SubagentInfo>;
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
    const [scrollbarHovered, setScrollbarHovered] = useState(false);
    useScrollboxBindings({
      sbRef,
      setScrollbarHovered,
      setScrollTop,
      ref,
      // 会话切换时 itemHeights / scrollTop 重置（见上）——提交量化游标
      // 必须一起重置：旧会话的游标会让新会话首个亚阈值 change 被判为
      // 「未跨步长」而丢弃，新窗口停在旧位置。
      conversationId,
    });
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
    // specs/tui-subagent-transcript-live.md：卡级两行投影（toolUseId → 两行）。
    // 一次投影喂两个宿主（历史卡 MessageRow→MessageBlocks 与 live tail
    // liveToolRunsBox），四条消费规则同源不漂移。
    //
    // 依赖是**内容签名**（不是数组引用）：app 层 1Hz 轮询每次 setSubagents 都
    // 产新数组，用引用做依赖会每秒产新 Map → 下游 memo 化的历史消息块
    // （MessageBlocks 浅比较 subagentCards）每秒全量重建元素树。
    const subagentsKey = subagentCardsKey(props.subagents ?? []);
    const subagentCards = useMemo(
      () => subagentCardLinesMap(props.subagents ?? [], contentWidth),
      // eslint-disable-next-line react-hooks/exhaustive-deps -- 见上：签名即内容
      [subagentsKey, contentWidth]
    );
    // T3（plans/tui-tool-rhythm.md）：live 相邻 keep 卡之间空一行 ——
    // 卡间距收敛在 liveToolRunsBox 内（历史侧 MessageBlocks 各块自带节奏）。
    const renderLiveRuns = (runs: ReadonlyArray<LiveToolRun>) =>
      liveToolRunsBox(runs, contentWidth, subagentCards);
    const bannerLines = props.bannerLines ?? [];
    // visible 列表会丢掉 agent_status / drain 等隐藏 user 消息，下标比
    // 盘上短。所有 thinkingMs 查找必须映射回 sourceIndex，否则
    // `Thought for` 读到 null 槽，折叠行消失，hideThinking 又把消息框
    // 里的摘要掐掉。
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
    const thinkingMsAtVisible = useMemo(
      () =>
        makeThinkingMsAtVisibleFromSource(
          props.session.thinkingMs,
          sourceIndexOfVisible
        ),
      [props.session.thinkingMs, sourceIndexOfVisible]
    );
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
      measureMountedHeights(
        sbRef.current,
        visibleMessages,
        itemHeights,
        mountWindow.startIndex,
        mountWindow.endIndex,
        setItemHeights
      );
    }, [
      mountWindow.startIndex,
      mountWindow.endIndex,
      visibleMessages,
      itemHeights,
    ]);
    // D3（spec specs/tui-tool-settled-appearance.md）：折叠计数只聚合成功且
    // retract 的件 —— resolver 从 statusMap（tool_use_id → 是否失败）派生每件
    // 的 slot；未配对（live running / cancelled）不进计数。
    // `useMemo` 包裹：闭包每 render 都是新引用，下面 `activitySegments` 的
    // useMemo 依赖它，没稳定就每次 render 都重算。
    // 有意不复用 `deriveSlot(...).inFoldCount`（SSOT 分叉声明）：本 resolver
    // 消费的是**块计数口径** —— live-signal revision #3/#8 把「未配对 =
    // 仍 running 的 noise」也算入（history 里仍在跑的噪音要 calling），
    // 而 `deriveSlot` 是**卡片 slot 口径**（未配对 = running 卡）。两口径
    // 在未配对上不同是合同要求，不是漂移；`isLiveNoise` 是两边共享的
    // 类判定单源。
    const inFoldCountOf = useMemo(
      () =>
        (
          call: Readonly<{ readonly id: string; readonly name: string }>
        ): boolean => {
          // live-signal revision #3/#4：只数 live noise（spec Never「不另
          // 造第二套分类表」）。web_search / web_fetch 永不进 `calling`/
          // `called`：TOOL_SETTLED_CLASS 仍归 retract（计数口径不变），
          // 但 live signal 实卡路径不走块计数。
          if (isLiveNoise(call.name)) {
            if (!statusMap.has(call.id)) return true; // 未配对 = running
            return (
              statusMap.get(call.id) !== true // 失败横切
            );
          }
          return false;
        },
      [statusMap]
    );
    // D3 (tui-display-consistency):折叠作用于每一轮历史 —— 不再切片到
    // lastTurnSlice;`activitySegments` 从 0 起构建(0 = 首条 user query 之前的
    // assistant 起步;无 query → 全历史)。
    const activitySegments = useMemo(
      () => orderedTurnActivitySegments(visibleMessages, 0, { inFoldCountOf }),
      [visibleMessages, inFoldCountOf]
    );
    // plans/tui-live-activity-fold.md T3：**已画 foldLinesBySegmentIndex 是
    // 唯一折叠存在信号** —— 删除了整轮 `currentTurnHasFold` /
    // `currentTurnHasThinkingFold` 面板闸与 `foldDisplayLines.length` 折叠闸
    // （turn 级布尔会把当前 **open unit** 的思考面板与过程组一起吞掉）。
    //
    // T3/T5：tail 只剔除**已在历史里**的 tool_use id（同一条只画一次）；不再
    // 按「本轮已折叠」二次过滤 —— 那是与 reducer 直删叠加的双删。
    const turnLiveRuns = useMemo(() => {
      const historyToolUseIds = toolUseIdsOf(visibleMessages);
      return liveToolRuns.filter((run) => !historyToolUseIds.has(run.id));
    }, [liveToolRuns, visibleMessages]);
    // T7（specs/tui-activity-block.md / plans T7）：退役 `formatLiveActivitySummary`
    // / `splitLiveActivityRuns` 的生产调用面 —— 过程块（unanchoredBlocks）
    // 是进行中**收类**与 keep / 聚合 bash 的唯一时态（spec S4/S6）。idle
    // 落定仍走块计数（活动块 settled 态），unit fold 旧路径不再叠画。
    // T4–T7 (specs/tui-activity-block.md)：过程块 = 块标题 + 正文槽；块列表
    // 走 `deriveActivityBlocks` 派生，结果按 messageIndex 分组直接喂 MessageRow。
    // `visibleStart` 之前的历史 assistant 不参与活动投影；本切片以 visibleStart=0
    // 起算（与 activitySegments 同源）。
    //
    // T4 live-signal revision：思考正文活在 unanchored 活动块的正文槽里 —
    // — ThinkingPanel 组件已退役；liveThinking 闸恢复「draft 非空」语义。
    // 任意 tool running（含同一 burst 内后续工具）不再关思考 —— 锁句 7。
    // 抽到函数外：父组件 cc 由 11 → 9（避免触碰 s5 hard gate）。
    const liveThinking = liveThinkingFromDraft(
      running,
      props.thinkingDraftMasked
    );
    const activityBlockFoldLines = useMemo(
      () =>
        buildActivityBlockFoldLines({
          messages: visibleMessages,
          visibleStart: 0,
          visibleCount: visibleMessages.length,
          thinkingMsAtVisible,
          // 已进 transcript 的 tool_use 仍可能 running：必须把完整 liveRuns
          // 交给派生（resolveLiveRunning）。unanchored 追加在 derive 内排除
          // 历史 id，避免 calling 双画。tail 卡仍用 turnLiveRuns。
          liveRuns: liveToolRuns,
          liveThinking,
          inFoldCountOf,
        }),
      [
        visibleMessages,
        thinkingMsAtVisible,
        liveToolRuns,
        inFoldCountOf,
        liveThinking,
      ]
    );
    // 块覆盖的 ms 值集合（hideThinking 双门用）。T7：旧 `foldLinesBySegmentIndex`
    // 路径整体退役 —— hideThinking 的 `shownThinkingMsValues` 双门只剩块列表
    // 一路，不再需要并集。
    const mergedShownThinkingMsValues =
      activityBlockFoldLines.shownThinkingMsValues;
    // T4–T7：旧 `foldLinesBySegmentIndex`（unit fold 行）整体退役 —— 块列表
    // （`buildActivityBlockFoldLines`）是折叠的唯一来源；这里传空 map 让
    // ChatScrollbox 走「块列表 → MessageRow → renderBlockTitles」单一路径，
    // 不再画双行（`Thought for Ns · read_file × 1` 旧行 + `Thought for Ns` 新行）。
    const foldLinesBySegmentIndex: FoldLinesBySegmentIndex = useMemo(
      () => new Map(),
      []
    );
    // 细节槽 / 过程组：收类件进过程组计数，running 件占据唯一细节槽，其余逐条。
    // T4 live-signal：ThinkingPanel 已退役（思考活在 unanchored 块正文槽）。
    // 此处不再派生 `showThinkingPanel`，TranscriptTail 也不再接受该 prop。
    // T7（specs/tui-activity-block.md / plans T7）：过程块（unanchoredBlocks）
    // 取代旧 `live activity group` 双时态 —— `formatLiveActivitySummary` /
    // `splitLiveActivityRuns` 不再被生产代码调用；同批 retract 只在块 called
    // 计数出现一次。`liveTailSlots` 仍承担**逐条面**（draftEpoch 错开工具组
    // 与草稿段，详情见 transcript-tail.tsx）。
    const tailSlots = useMemo(
      () => liveTailSlots(turnLiveRuns, deferredSegments),
      [turnLiveRuns, deferredSegments]
    );
    return (
      <ChatScrollbox
        sbRef={sbRef}
        cols={props.cols}
        rows={props.rows}
        scrollbarHovered={scrollbarHovered}
        bannerLines={bannerLines}
        mountWindow={mountWindow}
        contentWidth={contentWidth}
        activitySegments={activitySegments}
        foldLinesBySegmentIndex={foldLinesBySegmentIndex}
        blockTitlesByMessage={activityBlockFoldLines.foldLineMapByMessage}
        slotPreviewsByMessage={activityBlockFoldLines.slotPreviewsByMessage}
        shownThinkingMsValues={mergedShownThinkingMsValues}
        statusMap={statusMap}
        resultTextMap={resultTextMap}
        subagentCards={subagentCards}
        thinkingExpanded={thinkingExpanded}
        thinkingMsAtVisible={thinkingMsAtVisible}
        running={running}
        tailSlots={tailSlots}
        renderLiveRuns={renderLiveRuns}
        deferredThinkingDrafts={deferredThinkingDrafts}
        liveToolLines={props.liveToolLines}
        askLine={props.askLine}
        crunchedSeconds={props.crunchedSeconds ?? 0}
        unanchoredBlocks={activityBlockFoldLines.unanchoredBlocks}
      />
    );
  }
);

/**
 * 视口挂载行高度量测（#986 — 从 ChatView 抽出）。每条挂载消息根节点的
 * DOM id 是 `tmsg-${i}`（`MessageRow` 内 id 契约）；本函数按可见下标
 * 通过 `scrollbox.getRenderable` 读真实高度，写回 itemHeights。变更才
 * 触发 setState，避免无谓重渲染。
 */
function measureMountedHeights(
  sb: ScrollBoxRenderable | null,
  visibleMessages: ReadonlyArray<AnthropicNativeMessage>,
  prevHeights: ReadonlyArray<number>,
  startIndex: number,
  endIndex: number,
  setHeights: (next: ReadonlyArray<number>) => void
): void {
  if (sb === null) return; // EXIT: unmounted during measure
  let changed = false;
  const next = visibleMessages.map((_, i) => prevHeights[i] ?? 0);
  for (let i = startIndex; i < endIndex; i++) {
    const node = sb.getRenderable(`tmsg-${i}`);
    const h = node?.height;
    if (Number.isFinite(h) && (h as number) > 0 && next[i] !== (h as number)) {
      next[i] = h as number;
      changed = true;
    }
  }
  if (changed) setHeights(next);
}

/**
 * scrollbox 元素 + ref 绑定（#986 — 从 ChatView 抽出）。两个
 * `useLayoutEffect`（scrollTop 追踪 + scrollbar hover 绑定）与
 * `useImperativeHandle`（ChatViewHandle 暴露 scrollToBottom +
 * scrollbox 直查）。承载 invariant：scrollbox 元素与 ref 绑定由
 * ChatView 顶层无条件调用，不得挪到 render helper。
 */
function useScrollboxBindings(args: {
  readonly sbRef: { current: ScrollBoxRenderable | null };
  readonly setScrollbarHovered: (hovered: boolean) => void;
  readonly setScrollTop: (next: number | ((prev: number) => number)) => void;
  readonly ref: React.Ref<ChatViewHandle>;
  /** 当前会话 id；变化 = 换会话 → 重订阅并复位量化游标（见调用处）。 */
  readonly conversationId: string | undefined;
}): void {
  const { sbRef, setScrollbarHovered, setScrollTop, ref, conversationId } =
    args;
  useLayoutEffect(() => {
    const sb = sbRef.current;
    if (sb === null) return; // EXIT: unmounted scrollbox
    // Official OpenTUI path: slider change → scrollbar `change` { position }.
    // Do not patch scrollTop (Feature Envy) or rAF-poll (sticky still 0).
    //
    // Quantized commits (spec invariant 8): every `change` used to call
    // `setScrollTop`, re-rendering the whole ChatView (markdown included) per
    // pixel. Two details matter here:
    //  - the gate is evaluated BEFORE the call — a same-value updater still
    //    schedules a React render, so skipping the *call* is what skips work;
    //  - the step is resolved per change, not once at effect time, because
    //    `sb.viewport.height` is still 0 while this layout effect runs (the
    //    box has not been laid out yet) and the effect does not re-run when
    //    it settles. Resolving from 0 would pin the step at its 1-row floor.
    // Crossing the step, hitting bottom, or hitting top still commits.
    // `resolveScrollCommitStep` keeps step <= overscan, so a skipped change
    // can never unmount what the viewport shows.
    //
    // `committed` lives for one subscription. The effect re-runs on
    // `conversationId` change, so the cursor starts fresh (null → always
    // commit) for the first change after a session switch — the same reset the
    // render body applies to itemHeights / scrollTop.
    let committed: number | null = null; // null = nothing committed yet → always commit
    const stopTracking = listenScrollBoxTop(sb, (next) => {
      const maxScrollTop = Math.max(0, sb.scrollHeight - sb.viewport.height);
      const step = resolveScrollCommitStep(
        sb.viewport.height > 0 ? sb.viewport.height : sb.height
      );
      const base = committed ?? Number.NaN;
      if (!shouldCommitScrollTop(base, next, { step, maxScrollTop })) {
        return; // quantized: no React state update for this change
      }
      committed = next;
      setScrollTop((prev) => (prev === next ? prev : next));
    });
    // hover 槽挂在 scrollbar renderable 上（Slider 自身只接 down/drag/up）。
    const stopHover = attachScrollbarHover(
      sb.verticalScrollBar,
      setScrollbarHovered
    );
    return () => {
      stopTracking();
      stopHover();
    };
  }, [sbRef, setScrollTop, setScrollbarHovered, conversationId]);
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
}

/**
 * `<scrollbox>` 渲染（#986 — 从 ChatView 抽出）。所有分支（banner /
 * spacerBefore / mounted map / TranscriptTail）与 props 透传集中到本组件，
 * ChatView 顶层只剩 hook 装配 + memo 派生，complexity 落回 ≤10。
 *
 * props 全是 ChatView 已派生 / useMemo 稳定的引用（statusMap /
 * resultTextMap / visibleMessages / foldLinesBySegmentIndex 等），本组件
 * 只挂 JSX，不再派生。
 */
function ChatScrollbox(props: {
  readonly sbRef: { current: ScrollBoxRenderable | null };
  readonly cols: number;
  readonly rows: number;
  readonly scrollbarHovered: boolean;
  readonly bannerLines: ReadonlyArray<string>;
  readonly mountWindow: ViewportMountWindow<AnthropicNativeMessage>;
  readonly contentWidth: number;
  readonly activitySegments: ReadonlyArray<TurnActivitySegment>;
  readonly foldLinesBySegmentIndex: FoldLinesBySegmentIndex;
  /** T4–T7：活动块标题按 messageIndex 分组。MessageRow 据此在 message 末尾
   *  渲染块标题（取代旧 unit fold 行的位置 —— 跨消息不合并合同）。 */
  readonly blockTitlesByMessage: ReadonlyMap<number, ReadonlyArray<string>>;
  /** T5（spec S2–S4）：messageIndex → 块预览文本数组（null = 跳过）。每条
   *  预览文本对应一个块；与 blockTitlesByMessage 同序，按 contentBlockIndex
   *  升序。settled 块（slot.kind === "none"）→ null；running 安静工具 →
   *  `formatRunningToolLine` 的文本。 */
  readonly slotPreviewsByMessage: ReadonlyMap<
    number,
    ReadonlyArray<string | null>
  >;
  readonly shownThinkingMsValues: ShownThinkingMsValues;
  readonly statusMap: ReadonlyMap<string, boolean>;
  readonly resultTextMap: ReadonlyMap<string, string>;
  /** specs/tui-subagent-transcript-live.md：toolUseId → 子代理卡两行投影
   *  （ChatView 单次 `subagentCardLinesMap` 产出，历史卡与 live 卡共用）。 */
  readonly subagentCards: ReadonlyMap<string, SubagentCardLines>;
  readonly thinkingExpanded: boolean;
  readonly thinkingMsAtVisible: ThinkingMsAtVisible;
  readonly running: boolean;
  readonly tailSlots: ReadonlyArray<TailSlotDecision>;
  readonly renderLiveRuns: (runs: ReadonlyArray<LiveToolRun>) => ReactNode;
  readonly deferredThinkingDrafts: string;
  readonly liveToolLines: ReadonlyArray<string>;
  readonly askLine: string | undefined;
  readonly crunchedSeconds: number;
  readonly unanchoredBlocks: ReadonlyArray<
    import("./activity-block.js").ActivityBlock
  >;
}): ReactNode {
  return (
    <scrollbox
      ref={props.sbRef}
      width={props.cols}
      height={props.rows}
      stickyScroll={true}
      stickyStart="bottom"
      scrollAcceleration={chatWheelScrollAccel}
      verticalScrollbarOptions={{
        trackOptions: {
          backgroundColor: scrollbarTrackColor(),
          foregroundColor: scrollbarThumbColor(props.scrollbarHovered),
        },
      }}
    >
      {props.bannerLines.length > 0 && (
        <TranscriptBanner bannerLines={props.bannerLines} />
      )}
      {props.mountWindow.spacerBefore > 0 && (
        <box
          key="transcript-spacer-before"
          width={props.contentWidth}
          height={props.mountWindow.spacerBefore}
          flexShrink={0}
        />
      )}
      {props.mountWindow.mounted.map((message, i) => {
        const visibleIndex = props.mountWindow.startIndex + i;
        const messageThinkingMs = props.thinkingMsAtVisible(visibleIndex);
        return (
          <MessageRow
            key={visibleIndex}
            message={message}
            visibleIndex={visibleIndex}
            contentWidth={props.contentWidth}
            messageThinkingMs={messageThinkingMs}
            messageSegments={messageSegmentsOfVisible(
              props.activitySegments,
              visibleIndex
            )}
            foldLinesBySegmentIndex={props.foldLinesBySegmentIndex}
            blockTitles={props.blockTitlesByMessage.get(visibleIndex) ?? []}
            slotPreviews={props.slotPreviewsByMessage.get(visibleIndex) ?? []}
            shownThinkingMsValues={props.shownThinkingMsValues}
            statusMap={props.statusMap}
            resultTextMap={props.resultTextMap}
            subagentCards={props.subagentCards}
            thinkingExpanded={props.thinkingExpanded}
          />
        );
      })}
      <TailSpacer
        height={props.mountWindow.spacerAfter}
        contentWidth={props.contentWidth}
      />
      <TranscriptTail
        contentWidth={props.contentWidth}
        running={props.running}
        crunchedSeconds={props.crunchedSeconds}
        tailSlots={props.tailSlots}
        renderLiveRuns={props.renderLiveRuns}
        deferredThinkingDrafts={props.deferredThinkingDrafts}
        thinkingExpanded={props.thinkingExpanded}
        liveToolLines={props.liveToolLines}
        askLine={props.askLine}
        unanchoredBlocks={props.unanchoredBlocks}
      />
    </scrollbox>
  );
}

/** 思考在流判定：draft 非空 + turn 进行中 —— 锁句 7 之后该闸不再受
 *  tool running 影响，迁到纯函数避免父组件 cc 越过 s5 hard gate。 */
function liveThinkingFromDraft(
  running: boolean,
  thinkingDraftMasked: string | undefined
): boolean {
  return (
    running &&
    thinkingDraftMasked !== undefined &&
    thinkingDraftMasked.length > 0
  );
}
