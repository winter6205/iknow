/**
 * src/tui/chat-view.tsx
 *
 * #146 对话视图（Q5a=C 完整 markdown + Q5b=B 工具摘要行）：
 *  - user 文本 → 「❯ 文本」行；assistant 文本 → Markdown；
 *  - assistant.tool_use → 摘要行（tool_result 按 id 回填状态）；
 *  - user.tool_result 不单独渲染（摘要行已覆盖）；
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
 *  - 窗口与消息重叠时按块级切片（`MessageBlocksRowRange`）：只渲染落在
 *    窗口内的块，块内局部裁剪（部分段落 / 部分工具行 / margin 空行）；
 *  - `scrollRows > 0` 顶部 dim 指示「↑ N 行历史（End 回到底部）」；同窗口
 *    tail 折叠为单行底部指示「↓ N 行正在生成（End 回到底部）」。
 *
 * 行级窗口数学（Fix2）：`estimateMessageRows` 保留做 parity 断言，渲染
 * 侧行高统一走 `measureMessage`（SSOT，与 markdown.tsx 的 measureBlocks
 * 坐标对齐，块级切片才能落到块内部）。
 */
import type { ReactElement } from "react";
import { Box, Text } from "ink";
import type {
  AnthropicContentBlock,
  AnthropicNativeMessage,
} from "../harness/model-adapter/types.js";
import type { TuiSessionState } from "./session-state.js";
import { toolResultStatusMap, summarizeToolCall } from "./tool-summary.js";
import { Markdown } from "./markdown.js";
import { Spinner } from "./components.js";
import { tuiPalette } from "./theme.js";
import { wrapText } from "./text.js";
import { measureMessage } from "./message-rows.js";
import type { BlockRowSpan } from "./message-rows.js";
import {
  REDACTED_PLACEHOLDER,
  summarizeThinkingContent,
} from "../cli/format.js";

/** TUI 折叠摘要 SSOT —— `summarizeThinkingContent` 字面(`思考（N 段...）`),
 *  与 chat 端 `formatRunHuman showThinking=true` 折叠摘要行完全一致;避免
 *  跨入口字面漂移。*/

/** 单个 message 渲染估算的物理行数（含 prompt 前缀 / 摘要行 / margin）。 */
export function estimateMessageRows(
  message: AnthropicNativeMessage,
  cols: number,
  opts?: { readonly thinkingExpanded?: boolean }
): number {
  if (message.role === "user") {
    const texts = message.content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    if (!texts.trim()) return 0; // 纯 tool_result 消息不占行（摘要行已覆盖）
    // prompt 前缀「❯ 」占 2 列；剩余按 wrap 折行 + 底部 1 行 margin。
    const wrapCols = Math.max(1, cols - 2);
    const lines = wrapText(texts, wrapCols);
    return lines.length + 1; // margin
  }
  // T6 (D5):thinking 折叠面板行数。折叠态 = 1 摘要行(+margin);展开态按
  // thinking 文本行数 + redacted 占位行累加。判空复用 `summarizeThinkingContent`
  // (SSOT 摘要字面),行数独立统计不依赖其字符串。
  let rows = 0;
  let blocks = 0;
  const thinkingSummary = summarizeThinkingContent(message.content);
  if (thinkingSummary !== "") {
    if (opts?.thinkingExpanded) {
      for (const block of message.content) {
        if (block.type === "thinking") {
          const lines = wrapText(block.thinking, cols);
          rows += Math.max(1, lines.length);
          blocks += 1;
        } else if (block.type === "redacted_thinking") {
          rows += 1; // 占位行
          blocks += 1;
        }
      }
    } else {
      rows += 1; // 折叠摘要单行
      blocks += 1;
    }
  }
  // assistant：text → markdown 行级估计；tool_use → 1 摘要行；
  // 每个块之间 marginBottom=1。保守按"每块行数 = max(1, 文本行) + 1"
  // 算，不细究 markdown 子块（headings / list / fence 是 React 渲染，
  // 我们只估总行数）。
  for (const block of message.content) {
    if (block.type === "text" && block.text.trim().length > 0) {
      const lines = wrapText(block.text, cols);
      rows += Math.max(1, lines.length) + 1; // +1 = marginBottom
      blocks += 1;
    } else if (block.type === "tool_use") {
      // 工具摘要单行 + marginBottom（实际无 margin，但给 +1 留视觉余量）。
      rows += 2;
      blocks += 1;
    }
  }
  if (blocks === 0) return 0;
  // 容器自身有 marginBottom=1，已经被加到最后一个块的 +1 上了。
  return Math.max(1, rows);
}

/** 把 messages 序列按行级累计，产出每个 message 的「起始行 / 行数」元数据。 */
export interface MessageRowSpan {
  readonly message: AnthropicNativeMessage;
  readonly startRow: number;
  readonly rows: number;
}

export function buildMessageRowSpans(
  messages: ReadonlyArray<AnthropicNativeMessage>,
  cols: number,
  opts?: { readonly thinkingExpanded?: boolean }
): ReadonlyArray<MessageRowSpan> {
  const out: MessageRowSpan[] = [];
  let cursor = 0;
  for (const m of messages) {
    const rows = estimateMessageRows(m, cols, opts);
    if (rows === 0) continue;
    out.push({ message: m, startRow: cursor, rows });
    cursor += rows;
  }
  return out;
}

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

function MessageBlocks(props: {
  readonly message: AnthropicNativeMessage;
  readonly cols: number;
  readonly statusMap: Map<string, boolean>;
  /** T6 (D5):thinking 折叠面板展开态;默认折叠(摘要行)。 */
  readonly thinkingExpanded?: boolean;
}): ReactElement | null {
  const { message, cols, statusMap, thinkingExpanded = false } = props;
  const pal = tuiPalette;
  if (message.role === "user") {
    const texts = message.content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    if (!texts.trim()) return null; // 纯 tool_result 消息：摘要行已覆盖
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text color={pal.accent} wrap="wrap">
          {"❯ "}
          {texts}
        </Text>
      </Box>
    );
  }
  // T6 (D5):thinking 折叠面板 — 摘要行恒显示;展开态追加 thinking 全文 +
  // redacted 占位。
  const nodes: ReactElement[] = [];
  const summary = summarizeThinkingContent(message.content);
  if (summary !== "") {
    nodes.push(
      <Box key="tk-sum" marginBottom={1}>
        <Text color={pal.dim}>[思考] {summary}</Text>
      </Box>
    );
  }
  if (summary !== "" && thinkingExpanded) {
    message.content.forEach((block, i) => {
      if (block.type === "thinking") {
        nodes.push(
          <Box key={`tk-b${i}`} marginBottom={1}>
            <Text wrap="wrap">{block.thinking}</Text>
          </Box>
        );
      } else if (block.type === "redacted_thinking") {
        nodes.push(
          <Box key={`tk-r${i}`} marginBottom={1}>
            <Text color={pal.dim}>{REDACTED_PLACEHOLDER}</Text>
          </Box>
        );
      }
    });
  }
  // assistant：text → markdown；tool_use → 摘要行
  message.content.forEach((block, i) => {
    if (block.type === "text" && block.text.trim().length > 0) {
      nodes.push(
        <Box key={`t${i}`} marginBottom={1}>
          <Markdown text={block.text} width={cols} />
        </Box>
      );
    } else if (block.type === "tool_use") {
      const { detail } = summarizeToolCall(block.name, block.input);
      const hasResult = statusMap.has(block.id);
      const failed = statusMap.get(block.id) === true;
      const mark = !hasResult ? "[运行中]" : failed ? "[失败]" : "[完成]";
      nodes.push(
        <Box key={`u${i}`}>
          <Text color={failed ? pal.error : pal.dim}>
            {mark} {block.name} · {detail}
          </Text>
        </Box>
      );
    }
  });
  if (nodes.length === 0) return null;
  return (
    <Box flexDirection="column" marginBottom={1}>
      {nodes}
    </Box>
  );
}

/**
 * 行级窗口里的 message 切片渲染（Fix2）。完全可见仍走 `MessageBlocks`
 * （保留 Markdown 全功能）；本组件仅做块级局部裁剪——按 measureMessage
 * 的 `blocks` 坐标切块，tool_use 伪块（text === ""）唯一识别，只在内容
 * 行 0 落在切片时渲染摘要行。裁剪行放弃 inline markdown（可接受取舍）。
 */
function MessageBlocksRowRange(props: {
  readonly message: AnthropicNativeMessage;
  readonly blocks: ReadonlyArray<BlockRowSpan>;
  readonly cols: number;
  readonly statusMap: Map<string, boolean>;
  readonly sliceStart: number;
  readonly sliceEnd: number;
}): ReactElement | null {
  const { message, blocks, cols, statusMap, sliceStart, sliceEnd } = props;
  const pal = tuiPalette;
  // measureMessage 产出全为 paragraph；此处显式收窄拿到 .text（MdBlock 是
  // 判别联合，非 paragraph 变体无 text）。
  const paraText = (b: BlockRowSpan): string =>
    b.block.type === "paragraph" ? b.block.text : "";
  if (message.role === "user") {
    const block = blocks[0];
    if (block === undefined) return null;
    const clipStart = Math.max(0, sliceStart - block.startRow);
    const clipEnd = Math.min(block.rows, sliceEnd - block.startRow);
    if (clipEnd <= clipStart) return null;
    const lines = wrapText(paraText(block), Math.max(1, cols - 2)).slice(
      clipStart,
      clipEnd
    );
    return (
      <Box flexDirection="column" marginBottom={1}>
        {lines.map((ln, li) => (
          <Text key={li} color={pal.accent} wrap="wrap">
            {li === 0 && clipStart === 0 ? `❯ ${ln}` : ln}
          </Text>
        ))}
      </Box>
    );
  }
  // assistant：逐块切片；tool_use pseudo-block（block.text === ""）走
  // 摘要行分支。
  const toolUses = message.content.filter(
    (b): b is Extract<AnthropicContentBlock, { type: "tool_use" }> =>
      b.type === "tool_use"
  );
  let toolIdx = 0;
  const nodes: ReactElement[] = [];
  blocks.forEach((block, i) => {
    // tool_use 伪块 pointer 按出现顺序恒自增，与窗口是否相交无关——
    // 否则被切片跳过的伪块会让后续索引错位。
    const isPseudo = paraText(block) === "";
    if (isPseudo) {
      toolIdx += 1;
    }
    const bcStart = block.startRow;
    const bcEnd = bcStart + block.rows;
    if (bcEnd <= sliceStart || bcStart >= sliceEnd) return;
    const clipStart = Math.max(0, sliceStart - bcStart);
    const clipEnd = Math.min(block.rows, sliceEnd - bcStart);
    if (clipEnd <= clipStart) return;
    if (isPseudo) {
      const tu = toolUses[toolIdx - 1];
      if (tu === undefined) return;
      if (clipStart < 1 && clipEnd > 0) {
        const { detail } = summarizeToolCall(tu.name, tu.input);
        const hasResult = statusMap.has(tu.id);
        const failed = statusMap.get(tu.id) === true;
        const mark = !hasResult ? "[运行中]" : failed ? "[失败]" : "[完成]";
        nodes.push(
          <Box key={`u${i}`}>
            <Text color={failed ? pal.error : pal.dim}>
              {mark} {tu.name} · {detail}
            </Text>
          </Box>
        );
      }
      return;
    }
    const lines = wrapText(paraText(block), cols).slice(clipStart, clipEnd);
    nodes.push(
      <Box key={`b${i}`} flexDirection="column">
        {lines.map((ln, li) => (
          <Text key={li} wrap="wrap">
            {ln}
          </Text>
        ))}
      </Box>
    );
  });
  if (nodes.length === 0) return null;
  return (
    <Box flexDirection="column" marginBottom={1}>
      {nodes}
    </Box>
  );
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
  // 行级块坐标（Fix2）：行数与块坐标统一走 `measureMessage`（SSOT），
  // 与 estimateMessageRows 逐字节一致。
  interface Measured {
    readonly message: AnthropicNativeMessage;
    readonly blocks: ReadonlyArray<BlockRowSpan>;
    readonly totalRows: number;
    readonly startRow: number;
  }
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
  // 行级窗口：[end - viewport - scroll, end - scroll]（end = totalRows，
  // tail 占底）。scroll=0 → 显示最末 viewport 行（auto-follow 底）。
  // Fix1 (#189 Commit 1)：短内容（totalRows <= viewport 且 >1）也能向上
  // 滚到顶部边缘（maxScroll = totalRows - 1）；viewport <= 0 = 无限视口
  // → 全部内容都放得下，没有可滚动量 → maxScroll = 0。
  const maxScroll =
    viewport > 0
      ? Math.max(
          0,
          Math.max(totalRows - viewport, totalRows > 1 ? totalRows - 1 : 0)
        )
      : 0;
  const scroll = Math.min(Math.max(0, props.scrollRows ?? 0), maxScroll);
  const endRow = totalRows - scroll;
  const startRow = viewport > 0 ? Math.max(0, endRow - viewport) : 0;
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
          const sliceStart = Math.max(0, startRow - mm.startRow);
          const sliceEnd = Math.min(mm.totalRows, endRow - mm.startRow);
          if (sliceEnd <= sliceStart) return null;
          // 完全可见走 MessageBlocks 保留 Markdown 全功能；部分切片走
          // MessageBlocksRowRange 做行级裁剪。
          const full = sliceStart === 0 && sliceEnd === mm.totalRows;
          return full ? (
            <MessageBlocks
              key={i}
              message={mm.message}
              cols={cols}
              statusMap={statusMap}
              thinkingExpanded={props.thinkingExpanded}
            />
          ) : (
            <MessageBlocksRowRange
              key={i}
              message={mm.message}
              blocks={mm.blocks}
              cols={cols}
              statusMap={statusMap}
              sliceStart={sliceStart}
              sliceEnd={sliceEnd}
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
