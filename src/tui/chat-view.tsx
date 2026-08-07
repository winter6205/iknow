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
 * STICKY banner：banner 是 ChatView 的独立 sticky 段（恒完整渲染），消息段
 * 用独立 row window（高 = viewport - bannerRows）。banner 永远在顶部完整可见，
 * 消息区独立滚动；输入框 / 状态栏在 app 底部固定。
 *  - scroll=0：消息窗口底 = 消息段底（auto-follow 最新消息）；
 *  - scroll>0：消息窗口上移 scroll 行（clamp 到 maxScroll = messageRows - messageViewport）；
 *  - 无「↑ N 行历史」指示、无「↓ N 行正在生成」折叠（2026-08-07 移除）；
 *  - banner 缺省（未传）→ bannerRows=0 → 消息窗口 = 全 viewport（回归兼容）。
 */
import { useDeferredValue, type ReactElement } from "react";
import { Box, Text } from "ink";
import type { TuiSessionState } from "./session-state.js";
import { toolResultStatusMap } from "./tool-summary.js";
import {
  formatCompletedToolLine,
  formatRunningToolLine,
  type LiveToolRun,
} from "./live-tool-state.js";
import { Markdown } from "./markdown.js";
import { Spinner } from "./components.js";
import { tuiPalette } from "./theme.js";
import { messageRender } from "./message-rows.js";
import { markdownToLines } from "./markdown-lines.js";
import type { RowSlice } from "./row-window.js";
import { MessageBlocks, MessageBlocksClipped } from "./message-blocks.js";
import type { Selection } from "./selection.js";
import { HighlightedLine } from "./selection-render.js";

/** live 工具行 + ask 行 + spinner 占位也占行；用于总行数估计。 */
export interface TailSlot {
  readonly liveToolRows: number;
  readonly askRow: number; // 0 / 1
  readonly spinnerRow: number; // 0 / 1
  readonly thinkingDraftRows: number;
  readonly draftRows: number;
  /** 实际渲染行数合计（含「后随兄弟」时的 marginBottom）。 */
  readonly total: number;
}

/**
 * tail 行账（精确）：各元素按渲染顺序排布，marginBottom 仅在后随兄弟存在
 * 时计 1（ink 折叠末尾子元素 margin）。draft 行数 = markdownToLines 实测。
 *
 * T3: thinking 草稿排在 answer 草稿之前（与下方 JSX 渲染顺序一致）；
 * 折叠态永远 = 1 行摘要（[思考] 思考中…），展开态走 markdownToLines 实测。
 * `thinkingExpanded` 必传 — 调用方从 ChatViewProps 注入，不引入新 React 路径。
 *
 * T4: liveToolRuns 与 liveToolLines 同块渲染（结构化运行状态先,
 * legacy 字符串后),行账合并。两路之一存在才渲染该 Box。
 */
export function tailSlot(
  liveToolLines: ReadonlyArray<string>,
  askLine: string | undefined,
  running: boolean,
  thinkingDraft: string | undefined,
  draft: string | undefined,
  cols: number,
  thinkingExpanded: boolean,
  liveToolRuns: ReadonlyArray<LiveToolRun> = []
): TailSlot {
  // T4: 结构化运行状态每条目 1 行,合并计入 liveToolRows。
  const liveToolRows = liveToolLines.length + liveToolRuns.length;
  const askRow = askLine !== undefined ? 1 : 0;
  const spinnerRow = running ? 1 : 0;
  const hasThinking =
    running && thinkingDraft !== undefined && thinkingDraft.length > 0;
  // 折叠态固定 1 行([思考] 思考中…);展开态走 markdownToLines 实测。
  const thinkingDraftRows = hasThinking
    ? thinkingExpanded
      ? markdownToLines(thinkingDraft!, cols).length
      : 1
    : 0;
  const draftRows =
    draft !== undefined && draft.length > 0
      ? markdownToLines(draft, cols).length
      : 0;
  // 渲染顺序：liveTool → ask → thinkingDraft → draft → spinner。
  const liveToolMargin =
    askRow + thinkingDraftRows + draftRows + spinnerRow > 0 ? 1 : 0;
  const askMargin = thinkingDraftRows + draftRows + spinnerRow > 0 ? 1 : 0;
  const thinkingMargin = draftRows + spinnerRow > 0 ? 1 : 0;
  const draftMargin = spinnerRow > 0 ? 1 : 0;
  const total =
    liveToolRows +
    liveToolMargin +
    askRow +
    askMargin +
    thinkingDraftRows +
    thinkingMargin +
    draftRows +
    draftMargin +
    spinnerRow;
  return {
    liveToolRows,
    askRow,
    spinnerRow,
    thinkingDraftRows,
    draftRows,
    total,
  };
}

/** 一条已测消息及其 flat 物理行 / 块坐标的窗口坐标。 */
interface Measured {
  readonly message: import("../harness/model-adapter/types.js").AnthropicNativeMessage;
  readonly lines: ReadonlyArray<string>;
  readonly blocks: import("./message-rows.js").BlockRowSpan[];
  /** 内容行 + self margin + 1（外层 margin）= 非末尾位置渲染高度。 */
  readonly totalRows: number;
  readonly startRow: number;
}

/** margin 占位（与 message-rows.ts MARGIN_LINE 一致）。 */
const MARGIN_LINE_CHAT = " ";

/**
 * #238：把当前 ChatView 内容流（banner + 消息 flat 行 + tail 行）拼成一份
 * flat 字符串数组（行号即内容行号 0-based）。用于 extractSelectionText：
 *  - banner 段占 [0, bannerLines.length)——STICKY：banner 永远在 [0,bannerRows)
 *    占位，但**不参与** ChatView 的 row-window 滚动数学，行号仍是真实内容行；
 *  - 消息段按 measure 顺序拼接（messageRender.lines 与全可见路径逐行一致），
 *    行号从 bannerRows 起（与 MessageBlocksClipped 的 absRow 同口径）；
 *  - tail 行（liveToolRuns + liveToolLines + ask + thinkingDraft + draft）
 *    按 ChatView JSX 渲染顺序追加（spinner 是 1 行非字符 "<spinner>"，留空）。
 *
 * 调用方必须保证本函数与 ChatView JSX 行账同步；只读 SessionState props，
 * 不接受 props.selection。
 */
export function flatContentLines(args: {
  readonly bannerLines: ReadonlyArray<string>;
  readonly session: TuiSessionState;
  readonly cols: number;
  readonly liveToolLines: ReadonlyArray<string>;
  readonly liveToolRuns: ReadonlyArray<LiveToolRun>;
  readonly askLine: string | undefined;
  readonly draftsMasked: string;
  readonly thinkingDraftMasked: string;
  readonly thinkingExpanded: boolean;
}): ReadonlyArray<string> {
  const out: string[] = [];
  for (const ln of args.bannerLines) out.push(ln);
  for (const m of args.session.messages) {
    const mm = messageRender(m, args.cols, {
      thinkingExpanded: args.thinkingExpanded,
    });
    for (const ln of mm.lines) out.push(ln);
    if (mm.lines.length > 0) out.push(MARGIN_LINE_CHAT);
  }
  const running = args.session.runState === "running-fg";
  const tail = tailSlot(
    args.liveToolLines,
    args.askLine,
    running,
    running ? args.thinkingDraftMasked : undefined,
    running ? args.draftsMasked : undefined,
    args.cols,
    args.thinkingExpanded,
    args.liveToolRuns
  );
  const tailTotal = tail.total;
  for (const run of args.liveToolRuns) {
    out.push(
      run.status === "running"
        ? formatRunningToolLine(run)
        : formatCompletedToolLine(run)
    );
  }
  for (const ln of args.liveToolLines) out.push(ln);
  if (args.askLine !== undefined) out.push(args.askLine);
  if (running && args.thinkingDraftMasked.length > 0) {
    if (args.thinkingExpanded) {
      for (const ln of markdownToLines(args.thinkingDraftMasked, args.cols)) {
        out.push(ln);
      }
    } else {
      out.push("[思考] 思考中…");
    }
  }
  if (running && args.draftsMasked.length > 0) {
    for (const ln of markdownToLines(args.draftsMasked, args.cols)) {
      out.push(ln);
    }
  }
  // tail 与 ChatView tailSlot 行账对齐：spinner 1 行 + 各 margin 行以占位补齐，
  // 保证 flatContentLines 长度 === ChatView 的 contentRows（窗口映射才一致）。
  while (out.length < tailTarget(args, tailTotal)) out.push(MARGIN_LINE_CHAT);
  return out;
}

/** 计算 flat 行数目标 = banner + 消息（含 margin）+ tail.total（对齐 ChatView）。 */
function tailTarget(
  args: {
    readonly bannerLines: ReadonlyArray<string>;
    readonly session: TuiSessionState;
    readonly cols: number;
  },
  tailTotal: number
): number {
  let n = args.bannerLines.length;
  for (const m of args.session.messages) {
    n += messageRender(m, args.cols).totalRows;
  }
  return n + tailTotal;
}

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
  readonly liveToolRuns?: ReadonlyArray<
    import("./live-tool-state.js").LiveToolRun
  >;
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
   * STICKY banner（完整眼永不裁剪）：banner 是 ChatView 的独立 sticky 头，
   * 占据 `[0, bannerRows)` 恒完整渲染，**不参与**消息 row window 滚动数学。
   * bannerRows = `bannerLines.length`。消息区窗口高 = viewport - bannerRows。
   * banner 缺省（未传）→ bannerRows=0，消息区 = 全 viewport（回归兼容）。
   * 输入框 / 状态栏在 app 底部固定不受影响。
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
   * 计算 startRow/endRow/cols/bannerRows 后回调，app 层据此把 SGR (x,y)
   * 映射成内容 CellPos。
   *
   * STICKY：`startRow`/`endRow` 仅覆盖**消息段**（0-based 消息坐标，不含
   * banner）。`bannerRows` = sticky banner 高度，app 层 `terminalToCellPos`
   * 用它把 SGR y 映射回内容流行号；banner 行锁定不可被拖选。
   * 不传 = 无选区（纯键盘滚动场景）。
   */
  readonly onWindow?: (win: {
    readonly startRow: number;
    readonly endRow: number;
    readonly cols: number;
    readonly bannerRows: number;
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
  const measured: Measured[] = [];
  let messageCursor = 0;
  // STICKY banner：banner 是独立 sticky 段，恒完整渲染，**不参与**消息 row
  // window 滚动数学。`mm.startRow` 用**消息段 0-based 坐标**（= messageCursor，
  // 与消息窗口 startRow/endRow 同口径，slice 裁剪判断直接成立）；选区高亮
  // 用的内容流行号在渲染循环里另加 bannerRows（见 MessageBlocksClipped）。
  const bannerRows = props.bannerLines?.length ?? 0;
  for (const m of session.messages) {
    const mm = messageRender(m, cols, {
      thinkingExpanded: props.thinkingExpanded,
    });
    if (mm.totalRows === 0) continue;
    measured.push({
      message: mm.message,
      lines: mm.lines,
      blocks: [...mm.blocks],
      totalRows: mm.totalRows,
      startRow: messageCursor,
    });
    messageCursor += mm.totalRows;
  }
  const running = session.runState === "running-fg";
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
  // ── 朴素滚动（2026-08-07 定稿：用户「第二种」，去所有折叠/指示器）──
  // STICKY banner：banner 是独立 sticky 段，恒完整渲染，**不参与**消息 row
  // window 滚动数学。`scrollRows` = 消息段向上翻了多少物理行。消息窗口固定
  // 高 = viewport - bannerRows（下限 1）。scroll=0 时消息窗口底 = 消息段底
  // （auto-follow）；scroll>0 时消息窗口上移 scroll 行。无「↑ N 行历史」指示、
  // 无「↓ N 行正在生成」折叠。
  const requestedScroll = Math.max(0, props.scrollRows ?? 0);
  const viewport = props.viewportRows ?? 0;
  // viewport <= 0 → 无限视口：不裁剪，直接渲染全部内容。
  const unlimited = viewport <= 0;
  // 消息段内容总高 = 消息 + tail（**不含 banner**；banner 是 sticky 占位）。
  const messageRows = messageCursor + tailRows;
  // 消息区可视高 = 总 viewport - bannerRows（下限 1；banner 缺省 bannerRows=0
  // → = 全 viewport，回归兼容）。
  const messageViewport = unlimited
    ? messageRows
    : Math.max(1, viewport - bannerRows);
  // 滚动上界：消息段贴顶时 segStart=0（banner 恒见，不制造虚构滚动空间）。
  const maxScroll = unlimited ? 0 : Math.max(0, messageRows - messageViewport);
  // ── STICKY banner 溢出降级（gate-fix 矮终端，2026-08-08）──
  // 矮终端（bannerRows > viewport）时 STICKY「永完整」vs viewport 上限冲突 —
  // 当前 banner 仍恒完整渲染 bannerRows 行 + 消息区 ≥1 行 → 总渲染 > viewport，
  // banner 顶部被遮。降级：banner 进入 row window，底对齐（banner 底贴 viewport
  // 底），显示 `viewport - messageViewport` 行（预留消息区，保证
  // banner + 消息 ≤ viewport 不溢出）。`unlimited`（viewport ≤ 0）或
  // bannerRows ≤ viewport 时 sticky 行为不变（banner 仍恒完整）。
  // 坐标映射：banner 占 [0, bannerRows) 内容流行号不变（terminalToCellPos /
  // props.onWindow / mm.startRow 不变），仅渲染时 slice。
  const bannerOverflow = !unlimited && bannerRows > viewport;
  const bannerVisibleRows = bannerOverflow
    ? Math.max(0, viewport - messageViewport)
    : bannerRows;
  const bannerStart = bannerOverflow
    ? Math.max(0, bannerRows - bannerVisibleRows)
    : 0;
  const bannerSlice = props.bannerLines?.slice(bannerStart, bannerRows) ?? [];
  const scroll = Math.min(requestedScroll, maxScroll);
  // 消息段窗口（0-based 消息坐标，不含 banner）：
  //   scroll=0 → [messageRows - messageViewport, messageRows)（贴底）
  //   scroll>0 → 上移 scroll 行 → [messageRows - messageViewport - scroll, …)
  // startRow/endRow 都是消息段内行号（0 起算，与 mm.startRow=messageCursor
  // 同口径，渲染循环裁剪判断直接成立）。
  const endRow = unlimited ? messageRows : messageRows - scroll;
  const startRow = unlimited ? 0 : Math.max(0, endRow - messageViewport);
  // #238:窗口同步回调（app 层坐标映射用）。在渲染体内直接调用：只写 parent
  // 的 ref（无 setState），React 允许多次调用；移到 useEffect 会引入事件时序
  // 风险（mouse listener 可能比 effect 早拿到陈旧 window）。注：依赖稳定，
  // commit 期重复调用会写同一个值。
  // STICKY：窗口范围仅覆盖消息段 [startRow, endRow)（0-based 消息坐标，不含
  // banner）。app 层 terminalToCellPos 依 bannerRows 把 SGR y 映射回内容流行号；
  // banner 行锁定不可被拖选（固定 chrome）。
  props.onWindow?.({
    startRow,
    endRow,
    cols,
    bannerRows,
  });
  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box flexDirection="column">
        {/* banner 段（STICKY）：恒完整渲染，不参与消息 row window 裁剪。
            gate-fix 矮终端：bannerRows > viewport 时降级为 row window（底对齐
            slice），banner 顶部可被裁但整体不溢出；无限视口 / 正常终端仍完整。 */}
        {bannerSlice.map((line, i) => (
          <HighlightedLine
            key={`banner-${bannerStart + i}`}
            line={line}
            row={bannerStart + i}
            selection={props.selection}
          />
        ))}
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
            />
          ) : (
            <MessageBlocksClipped
              key={i}
              message={mm.message}
              lines={mm.lines}
              blocks={mm.blocks}
              statusMap={statusMap}
              slice={slice}
              selection={props.selection}
              // STICKY：messageStartRow = bannerRows + mm.startRow（内容流行号，
              // 与 CellPos.row / flatContentLines 下标同口径）。mm.startRow 自身
              // 仍是消息段 0-based（slice 裁剪用），加 bannerRows 偏移对齐内容流。
              messageStartRow={bannerRows + mm.startRow}
            />
          );
        })}
      </Box>
      {/* tail 原样渲染（不折叠、无「↓ N 行正在生成」指示）。 */}
      {(props.liveToolRuns?.length ?? 0) > 0 ||
      props.liveToolLines.length > 0 ? (
        <Box flexDirection="column" marginBottom={1}>
          {(props.liveToolRuns ?? []).map((run) => (
            <Text key={run.id} color={pal.dim}>
              {run.status === "running"
                ? formatRunningToolLine(run)
                : formatCompletedToolLine(run)}
            </Text>
          ))}
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
