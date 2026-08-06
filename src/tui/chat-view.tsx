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
 * 滚动（#189 行级窗口）：把"消息级切片"换成"行级窗口 + 块级裁剪"。
 *  - `scrollRows` = 视口向上滚动的物理行数（0 = 底部 auto-follow，>0 = 向上）；
 *  - `viewportRows` = 聊天区域可视行数（终端总行 - banner - 状态栏 - 输入框
 *    - ask / notice 槽，动态算；调用方传入）；
 *  - 每个 message 的块级行映射由 `measureMessage`（message-rows.ts SSOT）
 *    给出（rowsForText 折行 + margin/tool_use 行高）；
 *  - 渲染时先累加消息行数，从 `totalRows - scrollRows - viewportRows` 起
 *    切到 `totalRows - scrollRows`，按行窗口选 messages 渲染；
 *  - 窗口与消息重叠时按块级切片（`MessageBlocksClipped`）：只渲染落在
 *    窗口内的块，块内局部裁剪（部分段落 / 部分工具行 / margin 空行）；
 *  - `scrollRows > 0` 顶部 dim 指示「↑ N 行历史（End 回到底部）」；同窗口
 *    tail 折叠为单行底部指示「↓ N 行正在生成（End 回到底部）」。
 *
 * 行级窗口数学与裁剪逻辑抽到 row-window.ts（纯函数）；消息渲染器在
 * message-blocks.tsx（code review 整改：Large Class / Long Method 拆分）。
 */
import type { ReactElement } from "react";
import { Box, Text } from "ink";
import type { AnthropicNativeMessage } from "../harness/model-adapter/types.js";
import type { TuiSessionState } from "./session-state.js";
import { toolResultStatusMap } from "./tool-summary.js";
import { Markdown } from "./markdown.js";
import { Spinner } from "./components.js";
import { tuiPalette } from "./theme.js";
import { measureMessage } from "./message-rows.js";
import type { BlockRowSpan } from "./message-rows.js";
import { computeRowWindow, type RowSlice } from "./row-window.js";
import { MessageBlocks, MessageBlocksClipped } from "./message-blocks.js";

/** live 工具行 + ask 行 + spinner 占位也占行；用于总行数估计。 */
export interface TailSlot {
  readonly liveToolRows: number;
  readonly askRow: number; // 0 / 1
  readonly spinnerRow: number; // 0 / 1
}

export function tailSlot(
  liveToolLines: ReadonlyArray<string>,
  askLine: string | undefined,
  running: boolean
): TailSlot {
  return {
    liveToolRows: liveToolLines.length,
    askRow: askLine !== undefined ? 1 : 0,
    spinnerRow: running ? 1 : 0,
  };
}

/** 一条已测消息及其行级切片的窗口坐标。 */
interface Measured {
  readonly message: AnthropicNativeMessage;
  readonly blocks: ReadonlyArray<BlockRowSpan>;
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
   * 行级滚动偏移（任务 A 行级）：0 = 视口底（auto-follow）；
   * k = 向上滚 k 行（k 由调用方 clamp 到 [0, totalRows - viewportRows]）。
   */
  readonly scrollRows?: number;
  /**
   * 视口可视行数（行级窗口高度，含顶部指示行）。调用方负责算：
   * 终端 rows - banner - 状态栏 - 输入框 - ask / notice 槽。<= 0 = 不限。
   */
  readonly viewportRows?: number;
  /**
   * T6 (D5):thinking 折叠面板展开态;默认折叠(摘要行)。
   * 由 app 层 /thinking 斜杠命令切换(运行态,会话重启回退折叠)。
   */
  readonly thinkingExpanded?: boolean;
}

export function ChatView(props: ChatViewProps): ReactElement {
  const { session, cols } = props;
  const pal = tuiPalette;
  const statusMap = toolResultStatusMap(session.messages);
  // 行级块坐标（Fix2）：行数与块坐标统一走 `measureMessage`（SSOT）。
  const measured: Measured[] = [];
  let messageCursor = 0;
  for (const m of session.messages) {
    const mm = measureMessage(m, cols, {
      thinkingExpanded: props.thinkingExpanded,
    });
    if (mm.totalRows === 0) continue;
    measured.push({
      message: m,
      blocks: mm.blocks,
      totalRows: mm.totalRows,
      startRow: messageCursor,
    });
    messageCursor += mm.totalRows;
  }
  const tail = tailSlot(
    props.liveToolLines,
    props.askLine,
    session.runState === "running-fg"
  );
  // masked draft 占 1 行（折叠时不需视觉精度；与 tail 一并参与 totalRows）。
  const draftRow =
    props.draftsMasked !== undefined && props.draftsMasked.length > 0 ? 1 : 0;
  const tailRows = tail.liveToolRows + tail.askRow + tail.spinnerRow + draftRow;
  const totalRows = messageCursor + tailRows;
  const viewport = props.viewportRows ?? 0;
  const { scroll, endRow, startRow } = computeRowWindow(
    totalRows,
    props.scrollRows ?? 0,
    viewport
  );
  // Fix3：scroll > 0 折叠 tail（liveTool/ask/draft/spinner 隐藏）为底部单行指示。
  const foldTail = scroll > 0 && tailRows > 0;
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
            end: Math.min(mm.totalRows, endRow - mm.startRow),
          };
          if (slice.end <= slice.start) return null;
          // 完全可见走 MessageBlocks 保留 Markdown 全功能；部分切片走
          // MessageBlocksClipped 做行级裁剪。
          const full = slice.start === 0 && slice.end === mm.totalRows;
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
              blocks={mm.blocks}
              cols={cols}
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
          {session.runState === "running-fg" &&
            props.draftsMasked !== undefined &&
            props.draftsMasked.length > 0 && (
              <Box flexDirection="column" marginBottom={1}>
                <Markdown text={props.draftsMasked} width={cols} />
              </Box>
            )}
          {session.runState === "running-fg" && <Spinner />}
        </>
      )}
    </Box>
  );
}
