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
 * flat 物理行，与 `<Markdown>` 渲染逐行对齐 + 视觉宽度折行）。修复点：
 *  1. 窗口数学：`endRow = totalSpace - scroll`，窗口高 = `viewport - chrome`
 *     （chrome = 顶部指示 2 行 + fold 指示 2 行；指示器 `<Box mb=1><Text>` 实测
 *     各占 2 行，旧实现未扣 → 内容溢出 viewport，滚动区渲染漂移）；
 *  2. tail 行数精确化（liveTool/ask/draft/spinner 的 margin 按「后随兄弟」计）；
 *  3. 裁剪路径渲染 flat 行切片（MessageBlocksClipped），与全可见路径逐行一致。
 *
 * 渲染规则：
 *  - scroll=0：窗口 = [totalSpace - budget, totalSpace)，tail 原样渲染；
 *  - scroll>0：窗口 = [msgSpace - scroll - budget, msgSpace - scroll)，
 *    tail 折叠为底部「↓ N 行正在生成」指示；
 *  - 顶部 dim 指示「↑ N 行历史（End 回到底部）」恒在 scroll>0 时出现。
 */
import type { ReactElement } from "react";
import { Box, Text } from "ink";
import type { TuiSessionState } from "./session-state.js";
import { toolResultStatusMap } from "./tool-summary.js";
import { Markdown } from "./markdown.js";
import { Spinner } from "./components.js";
import { tuiPalette } from "./theme.js";
import { messageRender } from "./message-rows.js";
import { markdownToLines } from "./markdown-lines.js";
import type { RowSlice } from "./row-window.js";
import { MessageBlocks, MessageBlocksClipped } from "./message-blocks.js";

/** live 工具行 + ask 行 + spinner 占位也占行；用于总行数估计。 */
export interface TailSlot {
  readonly liveToolRows: number;
  readonly askRow: number; // 0 / 1
  readonly spinnerRow: number; // 0 / 1
  readonly draftRows: number;
  /** 实际渲染行数合计（含「后随兄弟」时的 marginBottom）。 */
  readonly total: number;
}

/**
 * tail 行账（精确）：各元素按渲染顺序排布，marginBottom 仅在后随兄弟存在
 * 时计 1（ink 折叠末尾子元素 margin）。draft 行数 = markdownToLines 实测。
 */
export function tailSlot(
  liveToolLines: ReadonlyArray<string>,
  askLine: string | undefined,
  running: boolean,
  draft: string | undefined,
  cols: number
): TailSlot {
  const liveToolRows = liveToolLines.length;
  const askRow = askLine !== undefined ? 1 : 0;
  const spinnerRow = running ? 1 : 0;
  const draftRows =
    draft !== undefined && draft.length > 0
      ? markdownToLines(draft, cols).length
      : 0;
  // 渲染顺序：liveTool → ask → draft → spinner（与下方 JSX 一致）。
  const liveToolMargin = askRow + draftRows + spinnerRow > 0 ? 1 : 0;
  const askMargin = draftRows + spinnerRow > 0 ? 1 : 0;
  const draftMargin = spinnerRow > 0 ? 1 : 0;
  const total =
    liveToolRows +
    liveToolMargin +
    askRow +
    askMargin +
    draftRows +
    draftMargin +
    spinnerRow;
  return { liveToolRows, askRow, spinnerRow, draftRows, total };
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

export interface ChatViewProps {
  readonly session: TuiSessionState;
  readonly cols: number;
  /** turn 进行中逐条出现的工具事件文案（formatLiveToolEvent 产物）。 */
  readonly liveToolLines: ReadonlyArray<string>;
  /**
   * T4 (#175)：当前 turn 流式累积的 masked 助手文本（草稿）。running-fg
   * 且在迭代中时渲染于 spinner 之前；空串/undefined 不渲染。终稿 commit 后
   * 由 app 层转进 transcript（messages），此处不再出现。
   */
  readonly draftsMasked?: string;
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
}

/** 指示器实际占用行（`<Box mb=1><Text>` 实测各 2 行）。 */
const INDICATOR_ROWS = 2;

export function ChatView(props: ChatViewProps): ReactElement {
  const { session, cols } = props;
  const pal = tuiPalette;
  const statusMap = toolResultStatusMap(session.messages);
  const measured: Measured[] = [];
  let messageCursor = 0;
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
    running ? props.draftsMasked : undefined,
    cols
  );
  const tailRows = tail.total;
  // 滚动预算：scroll>0 时 tail 折叠为单指示（INDICATOR_ROWS），否则 tail 原样占行。
  const hasTail = tailRows > 0;
  const requestedScroll = Math.max(0, props.scrollRows ?? 0);
  // 顶部指示 chrome（scroll>0 时恒在）+ fold 指示 chrome。
  const scrollClampedMax = messageCursor + (hasTail ? tailRows : 0);
  const scroll = Math.min(requestedScroll, Math.max(0, scrollClampedMax - 1));
  const foldTail = scroll > 0 && hasTail;
  const chromeRows =
    (scroll > 0 ? INDICATOR_ROWS : 0) + (foldTail ? INDICATOR_ROWS : 0);
  const viewport = props.viewportRows ?? 0;
  // 消息窗口高度 = 视口预算 - chrome（下界 1，避免负窗）。
  const budget = viewport > 0 ? Math.max(1, viewport - chromeRows) : 0;
  // viewport <= 0 → 无限视口：消息窗口不裁剪，scroll 仅驱动指示器文案。
  const unlimited = budget <= 0;
  // endRow：unlimited / scroll=0 → 全空间底；scroll>0 → 消息空间内上移
  // scroll（tail 已折叠，fold 指示占 2 行 chrome，不计入 endRow）。
  const endRow =
    scroll === 0 || unlimited
      ? messageCursor + tailRows
      : messageCursor - scroll;
  const startRow = unlimited ? 0 : Math.max(0, endRow - budget);
  const indicator = scroll > 0 ? `↑ ${scroll} 行历史（End 回到底部）` : "";
  return (
    <Box flexDirection="column" flexGrow={1}>
      {indicator.length > 0 && (
        <Box marginBottom={1}>
          <Text color={pal.dim}>{indicator}</Text>
        </Box>
      )}
      <Box flexDirection="column">
        {measured.map((mm, i) => {
          if (mm.startRow + mm.totalRows <= startRow || mm.startRow >= endRow) {
            return null;
          }
          const slice: RowSlice = {
            start: Math.max(0, startRow - mm.startRow),
            end: Math.min(mm.lines.length, endRow - mm.startRow),
          };
          if (slice.end <= slice.start) return null;
          // 完全可见走 MessageBlocks 保留 Markdown 全功能；部分切片走
          // MessageBlocksClipped（flat 行切片，与全可见路径逐行一致）。
          const full = slice.start === 0 && slice.end >= mm.lines.length;
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
            />
          );
        })}
      </Box>
      {foldTail ? (
        <Box marginBottom={1}>
          <Text color={pal.dim}>
            {`↓ ${tailRows} 行正在生成（End 回到底部）`}
          </Text>
        </Box>
      ) : (
        <>
          {props.liveToolLines.length > 0 && (
            <Box flexDirection="column" marginBottom={1}>
              {props.liveToolLines.map((line, i) => (
                <Text key={i} color={pal.dim}>
                  {line}
                </Text>
              ))}
            </Box>
          )}
          {props.askLine !== undefined && (
            <Box marginBottom={1}>
              <Text color={pal.running}>{props.askLine}</Text>
            </Box>
          )}
          {running &&
            props.draftsMasked !== undefined &&
            props.draftsMasked.length > 0 && (
              <Box flexDirection="column" marginBottom={1}>
                <Markdown text={props.draftsMasked} width={cols} />
              </Box>
            )}
          {running && <Spinner />}
        </>
      )}
    </Box>
  );
}
