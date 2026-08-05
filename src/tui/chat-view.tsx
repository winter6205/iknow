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
 * 滚动（任务 A）：消息级切片——`scroll = 0` 展示全部（auto-follow 底），
 * `scroll = k` 截掉最新 k 条（用户向上滚动查看更早内容时保留早期可见；
 * 按 End / 新 turn 完成 → scroll 重置为 0）。`scroll > 0` 时顶部加 dim
 * 提示「↓ N 条新消息」告知可向下滚回底部。
 */
import type { ReactElement } from "react";
import { Box, Text } from "ink";
import type { AnthropicNativeMessage } from "../harness/model-adapter/types.js";
import type { TuiSessionState } from "./session-state.js";
import { toolResultStatusMap, summarizeToolCall } from "./tool-summary.js";
import { Markdown } from "./markdown.js";
import { Spinner } from "./components.js";
import { tuiPalette } from "./theme.js";

function MessageBlocks(props: {
  readonly message: AnthropicNativeMessage;
  readonly cols: number;
  readonly statusMap: Map<string, boolean>;
}): ReactElement | null {
  const { message, cols, statusMap } = props;
  const pal = tuiPalette;
  if (message.role === "user") {
    const texts = message.content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    if (!texts.trim()) return null; // 纯 tool_result 消息：摘要行已覆盖
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text color={pal.accent}>❯ {texts}</Text>
      </Box>
    );
  }
  // assistant：text → markdown；tool_use → 摘要行
  const nodes: ReactElement[] = [];
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
  /** askUser 待决提示（undefined = 无 pending ask）。 */
  readonly askLine: string | undefined;
  /**
   * 消息级滚动偏移（任务 A）：0 = 显示全部（auto-follow 底）；
   * k = 截掉最新 k 条（用户已向上滚 k 条查看更早内容）。
   * 负数 / 越界由调用方负责 clamp。
   */
  readonly scroll?: number;
}

export function ChatView(props: ChatViewProps): ReactElement {
  const { session, cols } = props;
  const pal = tuiPalette;
  const statusMap = toolResultStatusMap(session.messages);
  const total = session.messages.length;
  const rawScroll = props.scroll ?? 0;
  // 调用方应已 clamp；此处兜底防越界。
  const scroll = Math.max(0, Math.min(rawScroll, Math.max(0, total - 1)));
  const visible = session.messages.slice(0, Math.max(0, total - scroll));
  const hiddenNew = scroll; // 顶部被截掉的最新消息数
  return (
    <Box flexDirection="column" flexGrow={1}>
      {hiddenNew > 0 && (
        <Box marginBottom={1}>
          <Text
            color={pal.dim}
          >{`↓ ${hiddenNew} 条新消息（End 回到底部）`}</Text>
        </Box>
      )}
      <Box flexDirection="column">
        {visible.map((m, i) => (
          <MessageBlocks
            key={i}
            message={m}
            cols={cols}
            statusMap={statusMap}
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
      {session.runState === "running-fg" && <Spinner />}
    </Box>
  );
}
