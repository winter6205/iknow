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
}

export function ChatView(props: ChatViewProps): ReactElement {
  const { session, cols } = props;
  const pal = tuiPalette;
  const statusMap = toolResultStatusMap(session.messages);
  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box flexDirection="column">
        {session.messages.map((m, i) => (
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
