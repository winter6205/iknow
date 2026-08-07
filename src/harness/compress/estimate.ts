// Q6b-D3 决议:全量字符重估 × 4/3 padding,纯函数,不用 lastUsage
// Deviation from spec Code Style:import 用 .js 扩展名(对齐 src/ 既有 convention
// 如 model-adapter/types.ts → ../stream.js;NodeNext + verbatimModuleSyntax 下
// \\allowImportingTsExtensions\\ 未开启,spec 模板的 .ts 写法会让 tsc exit 2)。
import { TOKEN_ESTIMATION_PADDING } from "./constant.js";
import type { AnthropicNativeMessage } from "../model-adapter/types.js";

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.floor((text.length + 3) / 4));
}

export function estimateMessagesTokens(
  messages: ReadonlyArray<AnthropicNativeMessage>
): number {
  let total = 0;
  for (const msg of messages) {
    for (const block of msg.content) {
      switch (block.type) {
        case "text":
          total += estimateTokens(block.text);
          break;
        case "tool_use":
          total +=
            estimateTokens(block.name) +
            estimateTokens(JSON.stringify(block.input));
          break;
        case "tool_result":
          total += estimateTokens(String(block.content));
          break;
        case "thinking":
        case "redacted_thinking":
          break; // 不计入输入 token(thinking 非发送历史)
      }
    }
  }
  return Math.ceil(total * TOKEN_ESTIMATION_PADDING);
}
