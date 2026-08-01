/**
 * Anthropic Model Adapter (014 拥有;spec Code Style 区钉死接口形状)。
 *
 * 边界:
 *   - 完整拥有 Anthropic Messages 协议的响应解释 + 工具结果编码;
 *   - 请求组装由 Loop Engine 负责(Adapter 只消费 { tools?: unknown }
 *     决定是否声明工具);Adapter 不构造外发请求体;
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
import Anthropic from "@anthropic-ai/sdk";
import type {
  AnthropicContentBlock,
  AnthropicNativeMessage,
  AssistantTurnResult,
  LoopState,
  ModelAdapter,
} from "./types.js";
import type {
  Message as SdkMessage,
  MessageCreateParamsNonStreaming,
  MessageParam,
  Tool as SdkTool,
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
  /** 017: 模型侧超时(ms)。离线(scripted)模式下无实际效果,签名就位以便 018 接真实 SDK 时零改签名。 */
  readonly timeoutMs?: number;
}

/**
 * 把 Anthropic 原生 SDK Message 解释为 Foundation AssistantTurnResult。
 * 完整原子校验:任一 block 协议错误 -> 抛 ProtocolError,整回合不进入历史。
 *
 * 019: 提为模块级 export,供 createAnthropicAdapter(离线)与
 * createRealAnthropicAdapter(真实 SDK)共享同一解释逻辑(SSOT)。
 */
export function interpretMessage(sdk: SdkMessage): AssistantTurnResult {
  if (!sdk || sdk.role !== "assistant") {
    throw new ProtocolError(
      `anthropic-adapter: expected assistant message, got role=${(sdk as { role?: string })?.role ?? "missing"}`
    );
  }
  if (!Array.isArray(sdk.content)) {
    throw new ProtocolError("anthropic-adapter: missing content array");
  }

  const texts: string[] = [];
  const toolCalls: Array<{ id: string; name: string; input: unknown }> = [];

  for (const block of sdk.content as unknown as Array<
    Record<string, unknown>
  >) {
    if (!block || typeof block !== "object" || !("type" in block)) {
      throw new ProtocolError(
        "anthropic-adapter: assistant block missing 'type'"
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
          "anthropic-adapter: tool_use block missing non-empty id"
        );
      }
      if (typeof tb.name !== "string" || tb.name.length === 0) {
        throw new ProtocolError(
          `anthropic-adapter: tool_use ${tb.id} missing tool name`
        );
      }
      toolCalls.push({ id: tb.id, name: tb.name, input: tb.input });
    } else if (t === "thinking" || t === "redacted_thinking") {
      // Foundation 不解释 thinking / redacted_thinking,原样保留在历史。
    } else {
      throw new ProtocolError(
        `anthropic-adapter: unsupported assistant block type '${String(t)}'`
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
    supplierStop === "success" && texts.length === 0 && toolCalls.length === 0;

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
      toolCalls: Object.freeze(toolCalls.map((c) => Object.freeze({ ...c }))),
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
      readonly kind:
        "ok" | "validation_failed" | "tool_not_found" | "execution_failed";
      readonly toolUseId: string;
      readonly payload?: AnthropicContentBlock[];
      readonly message?: string;
      readonly toolName?: string;
    }>
  ) => AnthropicContentBlock[];
}

/**
 * 把用户文本编码为 Anthropic 原生 user message(单 text block)。
 *
 * 019: 提为模块级 export,供 createAnthropicAdapter(离线)与
 * createRealAnthropicAdapter(真实 SDK)共享同一编码逻辑(SSOT)。
 */
export function encodeUserText(userText: string): AnthropicNativeMessage {
  return {
    role: "user",
    content: [{ type: "text", text: userText }],
  };
}

/**
 * 把工具执行结果数组编码为 Anthropic 原生 tool_result content blocks。
 *
 * 019: 提为模块级 export,供 createAnthropicAdapter(离线)与
 * createRealAnthropicAdapter(真实 SDK)共享同一编码逻辑(SSOT)。
 */
export function encodeToolResults(
  results: ReadonlyArray<{
    readonly kind:
      "ok" | "validation_failed" | "tool_not_found" | "execution_failed";
    readonly toolUseId: string;
    readonly payload?: AnthropicContentBlock[];
    readonly message?: string;
    readonly toolName?: string;
  }>
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
        ? `[tool_not_found] tool not found: ${r.toolName ?? "unknown"}`
        : r.kind === "validation_failed"
          ? `[validation_failed] ${r.message ?? "invalid input"}`
          : `[execution_failed] ${r.message ?? "tool execution failed"}`;
    return {
      type: "tool_result",
      tool_use_id: r.toolUseId,
      is_error: true,
      content: [{ type: "text", text }],
    } satisfies AnthropicContentBlock;
  });
}

/**
 * 构造 Anthropic Adapter。完全离线:不连真实模型,只消费 responses 数组。
 */
export function createAnthropicAdapter(
  options: AnthropicAdapterOptions
): AnthropicAdapter {
  const queue = options.responses.slice();

  async function step(
    _state: LoopState,
    _request: { tools?: unknown },
    _signal?: AbortSignal
  ): Promise<AssistantTurnResult> {
    // 017 离线 scripted 实现不消费 signal/timeout;签名就位,018 接真实 SDK 时绑到 client/fetch。
    // Stream-interrupted fixture:若 streamEvents 提供且 streamInterrupt=true,
    // 模拟中途断流,抛 ProtocolError,整回合不提交。
    if (options.streamEvents && options.streamInterrupt) {
      throw new ProtocolError(
        "anthropic-adapter: stream interrupted before complete response (no half-turn submit)"
      );
    }
    const next = queue.shift();
    if (!next) {
      throw new ProtocolError(
        "anthropic-adapter: scripted responses exhausted"
      );
    }
    return interpretMessage(next);
  }

  return Object.freeze({
    step,
    encodeUserText,
    encodeToolResults,
  });
}

/**
 * 019: 真实 Anthropic Adapter 构造选项。
 *
 * 与离线的 AnthropicAdapterOptions(需要 responses 脚本化)互不重叠:
 * 真实 adapter 依赖外部注入的 Anthropic client(019 Q1c 决议:dep injection),
 * 不在工厂内 new Anthropic。
 */
export interface RealAnthropicAdapterOptions {
  /** 注入的 Anthropic SDK 客户端(默认 baseURL 或 9router 均可)。 */
  readonly client: Anthropic;
  /** 模型 id,例如 "claude-3-5-sonnet-20241022"。 */
  readonly model: string;
  /** SDK max_tokens(必须 > 0)。 */
  readonly maxTokens: number;
  /** Sampling temperature (0.0–1.0). Omitted → SDK default. */
  readonly temperature?: number;
}

/**
 * 把 harness ToolDef[] 映射为 SDK Tool[]。
 *
 * - `inputSchema` (camelCase) → `input_schema` (snake_case)
 * - 空数组/非数组 → undefined,避免给 SDK 下发 `tools: []`
 * - `Tool.InputSchema` 在 SDK 0.115 是 strict 形状(要求 `type: "object"`),
 *   harness ToolDef.inputSchema 是 `Record<string, unknown>`;此处用 `as unknown as SdkTool`
 *   断言,运行时 SDK 仍按 wire shape 发送,真的 schema 校验由 model 自行完成。
 */
function toSdkTools(tools: unknown): SdkTool[] | undefined {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  return tools.map((t) => {
    const def = t as {
      name: string;
      description: string;
      inputSchema: Record<string, unknown>;
    };
    return {
      name: def.name,
      description: def.description,
      input_schema: def.inputSchema,
    } as unknown as SdkTool;
  });
}

/**
 * 019: 真实 Anthropic Adapter 工厂。
 *
 * step 委托 `client.messages.create(params, { signal })`;signal 走 SDK 0.115
 * 第二参 RequestOptions(不在 MessageCreateParamsBase body,见 toSdkTools 上方签名)。
 *
 * 响应经 `interpretMessage` 同一解释逻辑(SSOT)投影为 AssistantTurnResult。
 * SDK 错误(APIError / AbortError 等)不捕获,让 raceModel 现有 catch 路由处理:
 *   signal.aborted → "cancelled";MODEL_TIMEOUT → "timeout";
 *   ProtocolError → "protocolError";其他 → rethrow(`run()` reject)。
 * 真实失败回流占位见 #54 raceModel abort(#023 engine-timeout HTTP 未取消)。
 *
 * 协议不变:`stream:false` 拿非流式 SdkMessage(017 A1 冻);不构造 SdkMessage 队列;
 * 不重试、不收集 telemetry。
 */
export function createRealAnthropicAdapter(
  opts: RealAnthropicAdapterOptions
): AnthropicAdapter {
  async function step(
    state: LoopState,
    request: { tools?: unknown },
    signal?: AbortSignal
  ): Promise<AssistantTurnResult> {
    const tools = toSdkTools(request.tools);
    const params: MessageCreateParamsNonStreaming = {
      model: opts.model,
      max_tokens: opts.maxTokens,
      messages: state.messages as unknown as MessageParam[],
      ...(tools !== undefined ? { tools } : {}),
      ...(opts.temperature !== undefined
        ? { temperature: opts.temperature }
        : {}),
    };
    const sdkResp = await opts.client.messages.create(params, { signal });
    return interpretMessage(sdkResp as SdkMessage);
  }
  return Object.freeze({
    step,
    encodeUserText,
    encodeToolResults,
  });
}
