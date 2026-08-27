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
 *  - **历史消息里的 preview**：`MessageBlocks.ToolPreviewRows` 已改为内嵌
 *    固定高度 `<ScrollableOutputRegion>`（主消息流只显摘要行，diff 收进
 *    固定高度区内部滚动）；
 *  - **live tail**：`liveToolRuns.map(liveToolPreviewBox)` 保持展开（运行中
 *    工具逐条展开预览行，与「固定高度历史 preview」是两件事——live 行是
 *    尾部临时面板，不占用历史消息流；T6 输出增量上线前维持现状）。
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
import { Markdown } from "./markdown.js";
import { MessageBlocks } from "./message-blocks.js";
import { liveToolPreviewBox } from "./live-tool-preview.js";
import {
  isTuiHiddenUserMessage,
  type TuiSessionState,
} from "./session-state.js";
import { liveTailSlots, type LiveToolRun } from "./live-tool-state.js";
import { EYE_LINES, eyeGradientCells } from "./banner.js";
import { Spinner } from "./components.js";
import { tuiPalette } from "./theme.js";
import { toolResultStatusMap } from "./tool-summary.js";
import { formatCrunched } from "./run-stats.js";
import {
  formatThinkingFold,
  formatThinkingLive,
  thinkingPeekLines,
} from "./think-fold.js";
import {
  listenScrollBoxTop,
  selectViewportMountWindow,
} from "./transcript-viewport.js";
import {
  countToolUsesByName,
  formatTurnActivityFold,
  lastTurnQueryIndex,
  sliceTurnFrom,
} from "./turn-activity.js";

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
  /** 最近一次 turn 的 thinking 最终秒数（app 层 turn 结束快照）。传给末条
   *  assistant 消息的 thinking 折叠行 → 显示「思考了 N 秒」留存，turn 结束后
   *  秒数不随流式草稿清空而消失。缺省 0 → 折叠行只显 `[思考]`。 */
  readonly lastThinkingSeconds?: number;
  /** thinking 阶段冻结秒数（answer 开始时刻快照）：>0 且流式 thinking 草稿
   *  仍在 → 思考已结束、折叠行显示「思考了 N 秒」（不再「思考中…」递增），
   *  秒数留存到 turn 结束历史消息接棒。缺省 0 → 仍按静态 `思考中…`
   *  （无实时秒数，2026-08-14）。 */
  readonly thinkingFrozenSeconds?: number;
  /** 最近一次完成 turn 的运行秒数快照（app 层 runTurnOnce finally 写入
   *  crunchedOf === activeKey 时传）。在消息流末尾渲染 `Crunched for X`，
   *  会话结束后显示，运行中清空（app 层管理 crunchedOf 归属，ChatView 仅做
   *  条件渲染）。缺省 undefined → 不渲染。 */
  readonly crunchedSeconds?: number;
  /** askUser 待决提示（undefined = 无 pending ask）。 */
  readonly askLine?: string;
  /** thinking 折叠面板展开态（false = 折叠成 1 行 [思考]）。 */
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
    const running = props.session.runState === "running-fg";
    const thinkingExpanded = props.thinkingExpanded === true;
    // 消息内容宽度留出滚动条 / 安全区余量（scrollbox 实测，不做行数估算）。
    const contentWidth = Math.max(1, props.cols - 2);
    const liveToolRuns = props.liveToolRuns ?? [];
    const tailSlots = liveTailSlots(liveToolRuns, deferredSegments);
    const renderLiveRuns = (runs: ReadonlyArray<LiveToolRun>) =>
      runs.map((run) => liveToolPreviewBox(run, contentWidth));
    const bannerLines = props.bannerLines ?? [];
    const pal = tuiPalette;
    const visibleMessages = useMemo(
      () =>
        props.session.messages.filter(
          (message) => !isTuiHiddenUserMessage(message)
        ),
      [props.session.messages]
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
    const turnToolCounts = running
      ? []
      : countToolUsesByName(sliceTurnFrom(visibleMessages, lastQueryVisible));
    const turnToolTotal = turnToolCounts.reduce((n, e) => n + e.count, 0);
    const showTurnFold =
      !running && ((props.lastThinkingSeconds ?? 0) > 0 || turnToolTotal > 1);
    const foldDisplayLine = showTurnFold
      ? formatTurnActivityFold(props.lastThinkingSeconds, turnToolCounts)
      : "";
    const collapseToolRows = !running && turnToolTotal > 1;
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
          const isLastAssistant =
            visibleIndex === visibleMessages.length - 1 &&
            message.role === "assistant";
          const inLastTurn =
            lastQueryVisible >= 0 && visibleIndex > lastQueryVisible;
          const foldLastTurn = inLastTurn && foldDisplayLine !== "";
          return (
            <box
              id={`tmsg-${visibleIndex}`}
              key={visibleIndex}
              width={contentWidth}
              flexShrink={0}
            >
              <MessageBlocks
                message={message}
                cols={contentWidth}
                statusMap={statusMap}
                thinkingExpanded={thinkingExpanded}
                thinkingSeconds={
                  isLastAssistant && (props.lastThinkingSeconds ?? 0) > 0
                    ? props.lastThinkingSeconds
                    : undefined
                }
                hideThinking={foldLastTurn && !thinkingExpanded}
                hideToolSummaries={inLastTurn && collapseToolRows}
                marginTop={visibleIndex === 0 ? 0 : 1}
              />
              {visibleIndex === lastQueryVisible && foldDisplayLine !== "" && (
                <text fg={pal.dim} wrapMode="none">
                  {foldDisplayLine}
                </text>
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
        {/* 流式 thinking 面板：折叠态 = 静态 `思考中…` 摘要行 + 正文末 ≤3 行
            预览 / 思考已结束 → 折回单行「思考了 N 秒」冻结留存；展开态走
            Markdown 全文。frozen 非空 = answer 已开始、thinking 阶段结束 →
            秒数不再递增，显示「思考了 N 秒」，直到 turn 结束历史消息接棒
            （留存不消失）。
            文案统一（2026-08-14）：两分支都走 think-fold.ts SSOT ——
            折叠行恒 `思考中…`（无实时秒数，PR 1）/ `思考了 N 秒` 即带语义，
            不再叠加 `[思考]` 前缀（与 message-blocks 历史折叠行同源收敛）。
            预览窗口（plans/model-idle-thinking-peek.md T2）：思考**进行中**
            才取，`thinkingPeekLines` 硬顶 3 行、`wrapMode="none"` 每行恒占
            1 行 —— 折叠态高度与思考全文长度无关（不把预览当全文高度）。 */}
        {running && deferredThinkingDrafts.length > 0 && (
          <box flexDirection="column" width={contentWidth}>
            {thinkingExpanded ? (
              <box width={contentWidth}>
                <Markdown
                  text={deferredThinkingDrafts}
                  width={contentWidth}
                  streaming
                />
              </box>
            ) : (props.thinkingFrozenSeconds ?? 0) > 0 ? (
              <text fg={pal.dim} wrapMode="none">
                {formatThinkingFold(props.thinkingFrozenSeconds)}
              </text>
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
        {/* 流式尾部：工具组与草稿段按 draftEpoch 交错（主流 agent 顺序：
            工具 → 文本 → 工具 → 文本）。liveToolLines 仍挂在末尾（legacy）。 */}
        {tailSlots.map((slot, i) =>
          slot.kind === "tools" ? (
            <box
              key={`live-tools-${i}`}
              flexDirection="column"
              width={contentWidth}
            >
              {renderLiveRuns(slot.runs)}
            </box>
          ) : (
            running && (
              <box key={`live-draft-${i}`} width={contentWidth}>
                <Markdown text={slot.text} width={contentWidth} streaming />
              </box>
            )
          )
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
