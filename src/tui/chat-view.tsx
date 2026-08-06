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
 * 滚动（任务 A 行级重构）：把"消息级切片"换成"行级窗口"。
 *  - `scrollRows` = 视口向上滚动的物理行数（0 = 底部 auto-follow，>0 = 向上）；
 *  - `viewportRows` = 聊天区域可视行数（终端总行 - banner - 状态栏 - 输入框
 *    - ask / notice 槽，动态算；调用方传入）；
 *  - 每个 message 的物理行数由 `estimateMessageRows` 近似（user 文本按
 *    cols 折行 + 1 行 prompt 前缀；assistant markdown 用保守估计：每个
 *    块占 1..N 行 + margin）；
 *  - 渲染时先累加消息行数，从 `totalRows - scrollRows - viewportRows` 起
 *    切到 `totalRows - scrollRows`，按行窗口选 messages 渲染；
 *  - `scrollRows > 0` 顶部 dim 指示「↑ N 行历史（End 回到底部）」。
 *
 * 行数估算是保守近似（不算实际折行，宁可多算不可少算），保证窗口不会
 * 露出"被切掉"的内容；测试时 assert 行数 >= 实际折行（不精确等于）。
 */
import type { ReactElement } from "react";
import { Box, Text } from "ink";
import type { AnthropicNativeMessage } from "../harness/model-adapter/types.js";
import type { TuiSessionState } from "./session-state.js";
import { toolResultStatusMap, summarizeToolCall } from "./tool-summary.js";
import { Markdown } from "./markdown.js";
import { Spinner } from "./components.js";
import { tuiPalette } from "./theme.js";
import { wrapText } from "./text.js";
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
  const spans = buildMessageRowSpans(session.messages, cols, {
    thinkingExpanded: props.thinkingExpanded,
  });
  const tail = tailSlot(
    props.liveToolLines,
    props.askLine,
    session.runState === "running-fg"
  );
  const tailRows = tail.liveToolRows + tail.askRow + tail.spinnerRow;
  const totalRows = spans.reduce((acc, s) => acc + s.rows, 0) + tailRows;
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
  // 选 messages：startRow/endRow 落在哪个 span 范围内就保留。
  const visibleSpans = spans.filter(
    (s) => s.startRow + s.rows > startRow && s.startRow < endRow
  );
  // 顶部「↑ N 行历史」指示：scroll > 0 时显示 N = scroll 行数。
  const indicator = scroll > 0 ? `↑ ${scroll} 行历史（End 回到底部）` : "";
  return (
    <Box flexDirection="column" flexGrow={1}>
      {indicator.length > 0 && (
        <Box marginBottom={1}>
          <Text color={pal.dim}>{indicator}</Text>
        </Box>
      )}
      <Box flexDirection="column">
        {visibleSpans.map((s, i) => (
          <MessageBlocks
            key={i}
            message={s.message}
            cols={cols}
            statusMap={statusMap}
            thinkingExpanded={props.thinkingExpanded}
          />
        ))}
      </Box>
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
    </Box>
  );
}
