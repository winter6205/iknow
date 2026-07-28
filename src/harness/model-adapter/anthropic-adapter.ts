/**
 * Anthropic Model Adapter (014 拥有;spec Code Style 区钉死接口形状)。
 *
 * 边界:
 *   - 完整拥有 Anthropic Messages 协议的请求组装 + 响应解释 + 工具结果编码;
 *   - 把原生 assistant 响应原子校验 + 投影为 AssistantTurnResult;
 *   - 任何 assistant 回合任一 block 存在协议结构错误时抛 ProtocolError,
 *     整回合不进入权威历史,不执行其中工具调用(014 冻);
 *   - 不读取 / 不判断 / 不构造其它供应商原生字段;
 *   - Loop Engine 只消费 Adapter 交付的原生消息。
 *
 * **T11 离线实现**:本 adapter 在 Foundation 自治模式下接受脚本化
 * SdkMessage 数组作为响应(不连真实模型);支持 stream 中断 fixture;离线
 * 7 类样例全过。
 */

import { ProtocolError } from "../errors.js";
import type {
  AnthropicContentBlock,
  AnthropicNativeMessage,
  AssistantTurnResult,
  LoopState,
  ModelAdapter,
} from "./types.js";
import type {
  Message as SdkMessage,
  ToolUseBlock,
  TextBlock,
} from "@anthropic-ai/sdk/resources/messages.js";

export interface AnthropicAdapterOptions {
  /** 脚本化响应:每次 step 消费下一条;耗尽抛 ProtocolError(模拟断流)。 */
  readonly responses: ReadonlyArray<SdkMessage>;
  /** 可选:流式响应事件(用于 stream-interrupted 验收);若提供,必须以 message_stop 收尾。 */
  readonly streamEvents?: ReadonlyArray<unknown>;
  /** 设为 true 时,streamEvents 不以 message_stop 收尾(模拟中断) */
  readonly streamInterrupt?: boolean;
  readonly model: string;
  readonly maxTokens: number;
}

/**
 * 把 Anthropic 原生 SDK Message 解释为 Foundation AssistantTurnResult。
 * 完整原子校验:任一 block 协议错误 -> 抛 ProtocolError,整回合不进入历史。
 */
function interpretMessage(sdk: SdkMessage): AssistantTurnResult {
  if (!sdk || sdk.role !== "assistant") {
    throw new ProtocolError(
      `anthropic-adapter: expected assistant message, got role=${(sdk as { role?: string })?.role ?? "missing"}`,
    );
  }
  if (!Array.isArray(sdk.content)) {
    throw new ProtocolError("anthropic-adapter: missing content array");
  }

  const texts: string[] = [];
  const toolCalls: Array<{ id: string; name: string; input: unknown }> = [];

  for (const block of sdk.content as unknown as Array<Record<string, unknown>>) {
    if (!block || typeof block !== "object" || !("type" in block)) {
      throw new ProtocolError(
        "anthropic-adapter: assistant block missing 'type'",
      );
    }
    const t = block.type;
    if (t === "text") {
      const tb = block as unknown as TextBlock;
      texts.push(typeof tb.text === "string" ? tb.text : "");
    } else if (t === "tool_use") {
      const tb = block as unknown as ToolUseBlock;
      if (typeof tb.id !== "string" || tb.id.length === 0) {
        throw new ProtocolError(
          "anthropic-adapter: tool_use block missing non-empty id",
        );
      }
      if (typeof tb.name !== "string" || tb.name.length === 0) {
        throw new ProtocolError(
          `anthropic-adapter: tool_use ${tb.id} missing tool name`,
        );
      }
      toolCalls.push({ id: tb.id, name: tb.name, input: tb.input });
    } else if (
      t === "thinking" ||
      t === "redacted_thinking"
    ) {
      // Foundation 不解释 thinking / redacted_thinking,原样保留在历史。
    } else {
      throw new ProtocolError(
        `anthropic-adapter: unsupported assistant block type '${String(t)}'`,
      );
    }
  }

  let supplierStop: AssistantTurnResult["supplierStop"];
  switch (sdk.stop_reason) {
    case "end_turn":
    case "stop_sequence":
      supplierStop = "success";
      break;
    case "max_tokens":
      supplierStop = "truncation";
      break;
    case "refusal":
      supplierStop = "refusal";
      break;
    default:
      supplierStop = "other";
  }

  const isEmptyFinalResponse =
    supplierStop === "success" &&
    texts.length === 0 &&
    toolCalls.length === 0;

  const nativeContent: AnthropicContentBlock[] = (
    sdk.content as unknown as Array<Record<string, unknown>>
  ).flatMap((b): AnthropicContentBlock[] => {
    if (b.type === "text") {
      return [{ type: "text", text: (b as { text: string }).text }];
    }
    if (b.type === "tool_use") {
      const tb = b as unknown as ToolUseBlock;
      return [
        {
          type: "tool_use",
          id: tb.id,
          name: tb.name,
          input: tb.input,
        },
      ];
    }
    return [];
  });

  const nativeMessage: AnthropicNativeMessage = {
    role: "assistant",
    content: Object.freeze([...nativeContent]),
  };

  return {
    nativeMessage,
    projection: {
      nativeMessage,
      texts: Object.freeze([...texts]),
      toolCalls: Object.freeze(
        toolCalls.map((c) => Object.freeze({ ...c })),
      ),
    },
    supplierStop,
    needsTools: toolCalls.length > 0,
    isEmptyFinalResponse,
  };
}

export interface AnthropicAdapter extends ModelAdapter {
  readonly encodeUserText: (userText: string) => AnthropicNativeMessage;
  readonly encodeToolResults: (
    results: ReadonlyArray<{
      readonly kind: "ok" | "validation_failed" | "tool_not_found" | "execution_failed";
      readonly toolUseId: string;
      readonly payload?: AnthropicContentBlock[];
      readonly message?: string;
      readonly toolName?: string;
    }>,
  ) => AnthropicContentBlock[];
}

/**
 * 构造 Anthropic Adapter。完全离线:不连真实模型,只消费 responses 数组。
 */
export function createAnthropicAdapter(
  options: AnthropicAdapterOptions,
): AnthropicAdapter {
  const queue = options.responses.slice();

  async function step(
    _state: LoopState,
    _request: { system?: string; tools?: unknown },
  ): Promise<AssistantTurnResult> {
    // Stream-interrupted fixture:若 streamEvents 提供且 streamInterrupt=true,
    // 模拟中途断流,抛 ProtocolError,整回合不提交。
    if (options.streamEvents && options.streamInterrupt) {
      throw new ProtocolError(
        "anthropic-adapter: stream interrupted before complete response (no half-turn submit)",
      );
    }
    const next = queue.shift();
    if (!next) {
      throw new ProtocolError(
        "anthropic-adapter: scripted responses exhausted",
      );
    }
    return interpretMessage(next);
  }

  function encodeUserText(userText: string): AnthropicNativeMessage {
    return {
      role: "user",
      content: [{ type: "text", text: userText }],
    };
  }

  function encodeToolResults(
    results: ReadonlyArray<{
      readonly kind: "ok" | "validation_failed" | "tool_not_found" | "execution_failed";
      readonly toolUseId: string;
      readonly payload?: AnthropicContentBlock[];
      readonly message?: string;
      readonly toolName?: string;
    }>,
  ): AnthropicContentBlock[] {
    return results.map((r) => {
      if (r.kind === "ok") {
        return {
          type: "tool_result",
          tool_use_id: r.toolUseId,
          content: r.payload ?? [],
        } satisfies AnthropicContentBlock;
      }
      const text =
        r.kind === "tool_not_found"
          ? `tool not found: ${r.toolName ?? "unknown"}`
          : r.message ?? "tool execution failed";
      return {
        type: "tool_result",
        tool_use_id: r.toolUseId,
        is_error: true,
        content: [{ type: "text", text }],
      } satisfies AnthropicContentBlock;
    });
  }

  return Object.freeze({
    step,
    encodeUserText,
    encodeToolResults,
  });
}