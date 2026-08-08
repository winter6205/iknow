/**
 * src/tui/chat-view.tsx
 *
 * #146 对话视图（Q5a=C 完整 markdown + Q5b=B 工具摘要行）：仅做 JSX 组装。
 *  - user 文本 → 「❯ 文本」行；assistant 文本 → Markdown；
 *  - assistant.tool_use → 摘要行（tool_result 按 id 回填状态）；
 *  - running-fg → 底部 spinner；turn 进行中工具事件尾部（live 摘要流）。
 *
 * 流式（#147）拓展点：turn 完成回调处整段替换渲染；未来增量渲染挂载于此。
 *
 * 滚动（#189 行级窗口，修复版）：行账 SSOT = `messageRender`（message-rows.ts，
 * flat 物理行，与 `<Markdown>` 渲染逐行对齐 + 视觉宽度折行）。行账/窗口数学
 * 在 chat-flow.ts（T5 拆分，行数预算内）：
 *  - `tailSlot`：tail（liveTool/ask/draft/spinner）行数精确化；
 *  - `computeMeasured`：消息 flat 行 + 块坐标 + 末条尾 margin 收口；
 *  - `computeWindow`：朴素滚动窗口（scroll=0 锚底，scroll>0 上移）。
 *
 * 渲染规则：
 *  - scroll=0：窗口 = [contentRows - viewport, contentRows)，tail 原样渲染；
 *  - scroll>0：窗口上移 scroll 行，老消息进入窗口、底部消息被裁；
 *  - 无「↑ N 行历史」指示、无「↓ N 行正在生成」折叠、无 maxScroll 文案。
 */
import { useDeferredValue, type ReactElement } from "react";
import { Box, Text } from "ink";
import type { TuiSessionState } from "./session-state.js";
import { toolResultStatusMap } from "./tool-summary.js";
import type { LiveToolRun } from "./live-tool-state.js";
import { liveToolPreviewBox } from "./live-tool-preview.js";
import { Markdown } from "./markdown.js";
import { Spinner } from "./components.js";
import { tuiPalette } from "./theme.js";
import type { RowSlice } from "./row-window.js";
import { MessageBlocks, MessageBlocksClipped } from "./message-blocks.js";
import type { Selection } from "./selection.js";
import { HighlightedLine } from "./selection-render.js";
import { computeMeasured, computeWindow, tailSlot } from "./chat-flow.js";

export { flatContentLines, type TailSlot } from "./chat-flow.js";

export interface ChatViewProps {
  readonly session: TuiSessionState;
  readonly cols: number;
  /** turn 进行中逐条出现的工具事件文案（formatLiveToolEvent 产物）。 */
  readonly liveToolLines: ReadonlyArray<string>;
  /**
   * T4 (#175): 结构化工具调用实时状态。运行中条目按 `[运行中] name` 渲染,
   * 已完成条目按 `formatCompletedToolLine` 渲染。两类按 `liveToolReduce` 维护
   * 顺序;缺失时退化为 liveToolLines 字符串行追加(向后兼容)。
   *
   * 缺省 = 空(老调用方兼容);app.tsx 必传。
   */
  readonly liveToolRuns?: ReadonlyArray<LiveToolRun>;
  /**
   * T4 (#175)：当前 turn 流式累积的 masked 助手文本（草稿）。running-fg
   * 且在迭代中时渲染于 spinner 之前；空串/undefined 不渲染。终稿 commit 后
   * 由 app 层转进 transcript（messages），此处不再出现。
   */
  readonly draftsMasked?: string;
  /**
   * T3 (#175): 流式 thinking 草稿 masked 文本。turn 进行中按 `thinkingExpanded`
   * 渲染折叠摘要/展开全文;turn 结束 stream-draft.reset 清空后面板自然消失,
   * 交棒给终稿 thinking blocks 面板。
   */
  readonly thinkingDraftMasked?: string;
  /** askUser 待决提示（undefined = 无 pending ask）。 */
  readonly askLine: string | undefined;
  /**
   * 行级滚动偏移：0 = 视口底（auto-follow）；k = 向上滚 k 行（内部 clamp）。
   */
  readonly scrollRows?: number;
  /**
   * 视口可视行数（聊天区域总预算，**含指示器 chrome**——ChatView 内部扣除
   * 指示器实际占用后得到消息窗口高度）。<= 0 = 不限。
   */
  readonly viewportRows?: number;
  /**
   * T6 (D5):thinking 折叠面板展开态;默认折叠(摘要行)。
   * 由 app 层 /thinking 斜杠命令切换(运行态,会话重启回退折叠)。
   */
  readonly thinkingExpanded?: boolean;
  /**
   * 滚动对齐（方案 B + 完整眼常驻）：banner 是 row window 的第一段内容（与消息
   * 同 scroll space）。完整眼 + 顶部分隔常驻历史，默认锚底看最新消息，
   * PgUp/Home 上滚可见完整眼（app 层 bannerLines 决定，2026-08-08 用户二次
   * 裁定「不坍塌，完整历史」；窄终端 cols < BANNER_MIN_COLS 退单行）。
   * 输入框 / 状态栏固定在 app 底部不受影响。
   */
  readonly bannerLines?: ReadonlyArray<string>;
  /**
   * #238 鼠标拖选选区（已 normalize 由 app 层保证）。undefined = 无选区。
   * 存在时消息路径强制走 MessageBlocksClipped（高亮注入唯一入口）；
   * banner 走 HighlightedLine。
   */
  readonly selection?: Selection;
  /**
   * #238 内容视口窗口回调（effect 同步给 app 层坐标映射）：ChatView 每帧
   * 计算 startRow/endRow/cols 后回调，app 层据此把 SGR (x,y) 映射成
   * 内容 CellPos。不传 = 无选区（纯键盘滚动场景）。
   */
  readonly onWindow?: (win: {
    readonly startRow: number;
    readonly endRow: number;
    readonly cols: number;
    /** 内容区在终端里的起始行偏移（marginTop headroom 行数）。 */
    readonly topOffset?: number;
  }) => void;
}

export function ChatView(props: ChatViewProps): ReactElement {
  const { session, cols } = props;
  const pal = tuiPalette;
  // T5 (#175): useDeferredValue 是 React 并发防御的消费端 — 消费高频更新
  // 时延后(draft 文本变化快,最终态稳定),让低优先级渲染排到 transition
  // 之后,与 app 层 startTransition 构成双向防御。
  const deferredDrafts = useDeferredValue(props.draftsMasked);
  const deferredThinkingDrafts = useDeferredValue(props.thinkingDraftMasked);
  const statusMap = toolResultStatusMap(session.messages);
  const running = session.runState === "running-fg";
  // tail 先行：末条消息的尾 margin 收口依赖 tailRows（tail 为空时末条
  // 消息与输入框之间只留 1 行外层 margin，去掉块尾 self margin 的双空行）。
  const tail = tailSlot(
    props.liveToolLines,
    props.askLine,
    running,
    running ? deferredThinkingDrafts : undefined,
    running ? deferredDrafts : undefined,
    cols,
    props.thinkingExpanded ?? false,
    props.liveToolRuns ?? []
  );
  const tailRows = tail.total;
  // 方案 B（最终定稿）：banner 在 ChatView row window 内作为第一段，与
  // 消息共享同一 scroll space。向上滚能翻回完整 banner，向下滚 banner 与
  // 消息一起滚出（输入框 + 状态栏在 ChatView 之外固定挂载）。用户 2026-08-07
  // 复看：「下面对话框要固定，消息跟图标可以向上滚动」。
  const bannerRows = props.bannerLines?.length ?? 0;
  const { measured, messageCursor, lastTrimmed } = computeMeasured({
    session,
    cols,
    bannerRows,
    tailRows,
    thinkingExpanded: props.thinkingExpanded,
  });
  // ── 朴素滚动（2026-08-07 定稿：用户「第二种」，去所有折叠/指示器）──
  const { startRow, endRow } = computeWindow({
    bannerRows,
    messageCursor,
    tailRows,
    scrollRows: props.scrollRows,
    viewportRows: props.viewportRows,
  });
  // #238:窗口同步回调（app 层坐标映射用）。在渲染体内直接调用：只写 parent
  // 的 ref（无 setState），React 允许多次调用；移到 useEffect 会引入事件时序
  // 风险（mouse listener 可能比 effect 早拿到陈旧 window）。注：依赖稳定，
  // commit 期重复调用会写同一个值。
  // topOffset = marginTop headroom 行数（用户 2026-08-08 下移一行）；SGR y 落
  // 在 headroom 行（≤ topOffset）→ terminalToCellPos 范围外，drag 高亮只命中
  // 内容区。banner 前的终端行偏移：headroom 1 行 = SGR y 需减 1 再映射。
  props.onWindow?.({ startRow, endRow, cols, topOffset: 1 });
  return (
    <Box flexDirection="column" flexGrow={1} marginTop={1}>
      {/* marginTop=1 给 banner 顶端留 1 行 headroom：用户 2026-08-08 反馈
          进消息后最顶 iknow 图标被截断、TUI 对终端顶部没对齐，下移一行。 */}
      <Box flexDirection="column">
        {/* banner 段（内容流第一段）：按窗口行区间裁剪，selection 存在时高亮命中行。 */}
        {bannerRows > 0 &&
          props.bannerLines &&
          (() => {
            const bStart = Math.max(0, startRow);
            const bEnd = Math.min(bannerRows, endRow);
            if (bEnd <= bStart) return null;
            return props.bannerLines
              .slice(bStart, bEnd)
              .map((line, i) => (
                <HighlightedLine
                  key={`banner-${bStart + i}`}
                  line={line}
                  row={bStart + i}
                  selection={props.selection}
                />
              ));
          })()}
        {measured.map((mm, i) => {
          if (mm.startRow + mm.totalRows <= startRow || mm.startRow >= endRow) {
            return null;
          }
          const slice: RowSlice = {
            start: Math.max(0, startRow - mm.startRow),
            end: Math.min(mm.lines.length, endRow - mm.startRow),
          };
          if (slice.end <= slice.start) return null;
          // #238：selection 存在时强制走 Clipped 路径（高亮唯一入口）。
          // 无 selection 时保留原策略：完全可见 → MessageBlocks（Markdown
          // 全功能）；部分切片 → MessageBlocksClipped（flat 行切片）。
          const full =
            props.selection === undefined &&
            slice.start === 0 &&
            slice.end >= mm.lines.length;
          return full ? (
            <MessageBlocks
              key={i}
              message={mm.message}
              cols={cols}
              statusMap={statusMap}
              thinkingExpanded={props.thinkingExpanded}
              noTrailingSelfMargin={lastTrimmed && i === measured.length - 1}
            />
          ) : (
            <MessageBlocksClipped
              key={i}
              message={mm.message}
              lines={mm.lines}
              blocks={mm.blocks}
              statusMap={statusMap}
              slice={slice}
              cols={cols}
              selection={props.selection}
              messageStartRow={mm.startRow}
            />
          );
        })}
      </Box>
      {/* tail 原样渲染（不折叠、无「↓ N 行正在生成」指示）。 */}
      {(props.liveToolRuns?.length ?? 0) > 0 ||
      props.liveToolLines.length > 0 ? (
        <Box flexDirection="column" marginBottom={1}>
          {(props.liveToolRuns ?? []).map((run) =>
            liveToolPreviewBox(run, cols)
          )}
          {props.liveToolLines.map((line, i) => (
            <Text key={`legacy-${i}`} color={pal.dim}>
              {line}
            </Text>
          ))}
        </Box>
      ) : (
        <></>
      )}
      {props.askLine !== undefined && (
        <Box marginBottom={1}>
          <Text color={pal.running}>{props.askLine}</Text>
        </Box>
      )}
      {/* T3 (#175): 流式 thinking 面板。折叠态 = [思考] 思考中…(1 行); */}
      {/* 展开态渲染 deferredThinkingDrafts 全文。turn 结束 stream-draft 复位 */}
      {/* → 此条件失败 → 流式面板消失,接棒终稿 thinking blocks 面板。 */}
      {/* T5: 渲染走 deferred value — 高频更新低优先级,React 并发防御。 */}
      {running &&
        deferredThinkingDrafts !== undefined &&
        deferredThinkingDrafts.length > 0 && (
          <Box flexDirection="column" marginBottom={1}>
            {props.thinkingExpanded ? (
              <Markdown text={deferredThinkingDrafts} width={cols} />
            ) : (
              <Text color={pal.dim}>[思考] 思考中…</Text>
            )}
          </Box>
        )}
      {running && deferredDrafts !== undefined && deferredDrafts.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          <Markdown text={deferredDrafts} width={cols} />
        </Box>
      )}
      {running && <Spinner />}
    </Box>
  );
}
