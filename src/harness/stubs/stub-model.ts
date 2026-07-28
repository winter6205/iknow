/**
 * Stub model (T4):Foundation 的替身 ModelAdapter。
 *
 * 接受脚本化 AssistantTurnResult 数组,每次 step 消费下一条,确定性、
 * 无时间 / 随机 / IO 依赖。响应耗尽时抛 ProtocolError(模拟"模型回应
 * 不再可用")。替身不进生产装配路径。
 *
 * 同时提供 encodeUserText / encodeToolResults 两个最小编码入口,让
 * Loop Engine 跑完 S1 完整闭环(替身不解释真实 Anthropic wire 格式)。
 */

import { ProtocolError } from "../errors.js";
import { toAnthropicToolResults } from "../tools/tool-result.js";
import type {
  AnthropicContentBlock,
  AnthropicNativeMessage,
  AssistantTurnResult,
  LoopState,
  ModelAdapter,
} from "../model-adapter/types.js";
import type { ToolExecutionResult } from "../tools/types.js";

export interface StubModelFull extends ModelAdapter {
  readonly encodeUserText: (userText: string) => AnthropicNativeMessage;
  readonly encodeToolResults: (
    results: ReadonlyArray<ToolExecutionResult>,
  ) => AnthropicContentBlock[];
}

export function createStubModel(
  responses: ReadonlyArray<AssistantTurnResult>,
): StubModelFull {
  const queue = responses.slice();
  return Object.freeze({
    async step(
      _state: LoopState,
      _request: { system?: string; tools?: unknown },
    ): Promise<AssistantTurnResult> {
      const next = queue.shift();
      if (!next) {
        throw new ProtocolError(
          "stub-model: scripted responses exhausted (no further model reply)",
        );
      }
      return next;
    },
    encodeUserText(userText: string): AnthropicNativeMessage {
      return {
        role: "user",
        content: [{ type: "text", text: userText }],
      };
    },
    encodeToolResults(
      results: ReadonlyArray<ToolExecutionResult>,
    ): AnthropicContentBlock[] {
      return toAnthropicToolResults(results);
    },
  });
}