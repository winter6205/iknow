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
 *   - Loop Engine 只消费 Adapter 交付的原生消息;
 *   - #150 范围:text / tool_use blocks 原子校验(& 类型 + 必填字段);
 *     thinking / redacted_thinking blocks 全字段原样保留(pass-through,
 *     Q2 决议:保留 signature / data 以便权威历史可重放,无校验裁剪)。
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
  ThinkingBlock,
  RedactedThinkingBlock,
} from "@anthropic-ai/sdk/resources/messages.js";
import type { MessageStreamEvent } from "@anthropic-ai/sdk/resources/messages.js";
import type { HarnessStreamEvent } from "../stream.js";

/**
 * #176 T3: `client.messages.stream(...)` 返回的 SDK MessageStream 之最小消费面。
 *
 * 为什么不直接 import `MessageStream` 类型:NodeNext 下
 * `@anthropic-ai/sdk/lib/MessageStream.js` (CJS) 与 `.mjs` (ESM) 是两个变体,
 * 其 `#private` 成员互不相容,显式 import 会与 SDK `.stream()` 返回类型
 * (ESM 解析)冲突。以结构类型表达本模块实际消费的子集(`on` + `finalMessage`),
 * 真实 SDK stream 结构兼容,测试假 stream 对象亦按此面装配(不依赖真实网络)。
 */
interface AnthropicMessageStream {
  readonly on: {
    (
      event: "text",
      listener: (textDelta: string, textSnapshot: string) => void
    ): unknown;
    (
      event: "streamEvent",
      listener: (event: MessageStreamEvent, snapshot: SdkMessage) => void
    ): unknown;
  };
  readonly finalMessage: () => Promise<SdkMessage>;
}

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
 * text / tool_use blocks 原子校验:任一 block 协议错误 -> 抛 ProtocolError,
 * 整回合不进入历史。thinking / redacted_thinking 走 pass-through(见模块
 * 顶部 #150 注释),遇结构错误不入校验(返回时透传,replay 仍有合法签名)。
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
      // Foundation 不解释 thinking / redacted_thinking(不进 texts/toolCalls),
      // nativeContent 阶段全字段原样保留(signature / data),权威历史可回放。
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
    if (b.type === "thinking") {
      // T3 (#150, closes #134 issue 1): 全字段原样进权威历史。
      // signature 必须回传,裁剪会毁 replay;thinking 文本不进 texts。
      const tb = b as unknown as ThinkingBlock;
      return [
        {
          type: "thinking",
          thinking: tb.thinking,
          signature: tb.signature,
        },
      ];
    }
    if (b.type === "redacted_thinking") {
      // T3: redacted_thinking.data 原样保留(加密 blob,不可解释也不可裁剪)。
      const tb = b as unknown as RedactedThinkingBlock;
      return [{ type: "redacted_thinking", data: tb.data }];
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
  /**
   * #178 T5 (#147 D6):本 adapter 实例实际走的调用模式 —— true = 流式臂
   * (`client.messages.stream`),false/undefined = 非流式臂(`messages.create`)。
   * loop-engine 的 `recordLlmCall` 用它翻转 trace `stream` 布尔;不读取、不影响
   * 控制流(模式真值仍以 adapter 内部 arm 路由为准,此处只做申报)。
   */
  readonly streamMode?: boolean;
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
 *
 * 124/T5:execution_failed 若携带 partial stdout/stderr,在错误文本块之后
 * 追加对应的 `[partial stdout]` / `[partial stderr]` 文本块,以便模型
 * 看到取消/超时前已经写入的内容(strict-equal 文本驱动 stopReason 的契约不变)。
 */
export function encodeToolResults(
  results: ReadonlyArray<{
    readonly kind:
      "ok" | "validation_failed" | "tool_not_found" | "execution_failed";
    readonly toolUseId: string;
    readonly payload?: AnthropicContentBlock[];
    readonly message?: string;
    readonly toolName?: string;
    readonly partial?: { readonly stdout?: string; readonly stderr?: string };
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
    const blocks: AnthropicContentBlock[] = [{ type: "text", text }];
    // 124/T5:SC13 — partial 是 additive 字段;只在执行_failed 上、且 stdout/stderr
    // 真的有内容时才追加(空串跳过,避免噪声)。
    if (
      r.kind === "execution_failed" &&
      r.partial &&
      (typeof r.partial.stdout === "string" ||
        typeof r.partial.stderr === "string")
    ) {
      if (typeof r.partial.stdout === "string" && r.partial.stdout.length > 0) {
        blocks.push({
          type: "text",
          text: `[partial stdout]\n${r.partial.stdout}`,
        });
      }
      if (typeof r.partial.stderr === "string" && r.partial.stderr.length > 0) {
        blocks.push({
          type: "text",
          text: `[partial stderr]\n${r.partial.stderr}`,
        });
      }
    }
    return {
      type: "tool_result",
      tool_use_id: r.toolUseId,
      is_error: true,
      content: blocks,
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
  /**
   * #151 T4 请求侧 thinking 控制臂。
   *   - mode="off"      → 不发送 thinking / output_config(默认)
   *   - mode="adaptive" → 发送 thinking:{type:'adaptive'};effort 非空时再追加 output_config:{effort}
   * temperature 与 thinking 正交:开/关 flag 不改变 temperature 发送。
   */
  readonly thinking?: {
    readonly mode: "off" | "adaptive";
    readonly effort?: "" | "low" | "medium" | "high" | "xhigh" | "max";
  };
  /**
   * #176 T3 (#147 D0/D1):流式臂开关。true → `client.messages.stream(params,
   * { signal })` → `finalMessage()` → 现有 `interpretMessage` (SSOT,零修改)
   * → `AssistantTurnResult` 与非流式臂逐字节同形;false/undefined → 既有
   * `client.messages.create` 臂(017 A1 freeze / D0 回退),行为零变化。
   *
   * 信号(signal)直挂 SDK RequestOptions 第二参(023 取消/超时语义零改造继
   * 承)。生产装配点(env `IKNOW_LLM_STREAM` 默认 on)由 T6 在调用处传入。
   */
  readonly stream?: boolean;
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
 * #176 T3 流式臂(#147 D1/`stream:true`):
 *   - SDK `client.messages.stream(params, { signal })`,signal 走
 *     RequestOptions 第二参,直挂 raceModel composite signal(023 语义零改造)。
 *   - `wireStreamEvents` 装配观察者监听(text → text_delta;
 *     content_block_start tool_use → tool_call_start),每次 emit try/catch
 *     吞咽异常(#147 D3,对齐 `safeTrace` MUST NOT throw 先例)。
 *   - 终态 `await stream.finalMessage()` → 现有 `interpretMessage` SSOT 零改动
 *     → `AssistantTurnResult` 与非流式臂逐字节同形。
 *   - 断流(`finalMessage()` reject,如连接中断 / 无 chunk / 静默 EOF / abort)
 *     → step reject,**不构造 `AssistantTurnResult`**(D8 整回合不提交);
 *     `stream.currentMessage` 的 partial 快照 v1 不消费(Postel's Law)。
 *   - 参数体与非流式臂逐字节相同(D2),共享 `buildMessageParams` 一并校验。
 */
async function stepStreamArm(deps: {
  readonly client: Anthropic;
  readonly params: MessageCreateParamsNonStreaming;
  readonly signal?: AbortSignal;
  readonly onStream?: (event: HarnessStreamEvent) => void;
}): Promise<AssistantTurnResult> {
  const stream = deps.client.messages.stream(deps.params, {
    signal: deps.signal,
  });
  wireStreamEvents(stream, deps.onStream);
  // D8:断流 / abort → finalMessage() reject → 不构造 AssistantTurnResult。
  const final = await stream.finalMessage();
  return interpretMessage(final);
}

/**
 * #176 T3 emit 装配(#147 D1/D3):SDK 原生 SSE 事件(`on("text")` /
 * `on("streamEvent")`)不出 adapter 边界,翻译为 harness 流式事件契约(
 * `HarnessStreamEvent`)。每次 emit try/catch 吞咽异常 — 观察者错误必须
 * 不反流回 stream arm 终态。
 *
 * empty-class 决策:`text_delta` 为空字符串(text="")时**不 emit** —
 * 空文本 delta 不承载渲染信息,跳过以消除 host 渲染噪声;Plan §3 "empty
 * 类" 给出"不 emit 或 emit 无副作用(实现期二选一)"的选项,本实现选中前者,
 * 在 `anthropic-adapter-stream.test.ts` 锁定。
 */
function wireStreamEvents(
  stream: AnthropicMessageStream,
  onStream: ((event: HarnessStreamEvent) => void) | undefined
): void {
  if (onStream === undefined) return;
  const safeEmit = (event: HarnessStreamEvent): void => {
    try {
      onStream(event);
    } catch {
      // D3:swallow observer exceptions,host faults must not back-flow into
      // the stream arm (aligned with ADR-0003 `safeTrace` MUST NOT throw).
    }
  };
  stream.on("text", (textDelta) => {
    if (textDelta === "") return; // empty delta:不 emit(见上方 empty-class 决策注释)
    safeEmit({ type: "text_delta", text: textDelta });
  });
  stream.on("streamEvent", (event: MessageStreamEvent) => {
    if (event.type !== "content_block_start") return;
    const block = event.content_block;
    // D1 最小集:只 tool_use 翻译为 tool_call_start;server_tool_use 等其它
    // 内容块不在 v1 范围内(interpretMessage 也会因不支持类型 ProtocolError)。
    if (block.type !== "tool_use") return;
    safeEmit({ type: "tool_call_start", name: block.name });
  });
}

/**
 * #176 T3 (D2):流式 / 非流式臂之间**共享**的参数体构造 — message 历史 +
 * tools + thinking + temperature 条件附加逻辑一致,字节级同形(消息历史
 * 字段不因流式 / 非流式而变化,KV 缓存前缀稳定性不受影响)。此处不引入
 * `stream: true`,SDK `.stream()` 内部追加。
 */
function buildMessageParams(
  opts: RealAnthropicAdapterOptions,
  state: LoopState,
  request: { tools?: unknown }
): MessageCreateParamsNonStreaming {
  const tools = toSdkTools(request.tools);
  // #151 T4 请求侧 thinking 控制臂。SDK 0.115.0 在 MessageCreateParamsBase
  // 已声明 thinking?: ThinkingConfigParam 与 output_config?: OutputConfig,
  // 此处按 config 条件附加,off/缺省 → 两字段都不出现(默认零行为变化)。
  const thinkingParam =
    opts.thinking?.mode === "adaptive"
      ? { type: "adaptive" as const }
      : undefined;
  const effort = opts.thinking?.effort;
  return {
    model: opts.model,
    max_tokens: opts.maxTokens,
    messages: state.messages as unknown as MessageParam[],
    ...(tools !== undefined ? { tools } : {}),
    ...(opts.temperature !== undefined
      ? { temperature: opts.temperature }
      : {}),
    ...(thinkingParam !== undefined ? { thinking: thinkingParam } : {}),
    ...(thinkingParam !== undefined && effort
      ? { output_config: { effort } }
      : {}),
  };
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
 * 协议不变:`createRealAnthropicAdapter.step` 根据 `opts.stream` 分两臂(非流式臂 `client.messages.create`,流式臂 `client.messages.stream` + `finalMessage()` → `interpretMessage`,#176 T3 #147 D1),两者交付同一 `AssistantTurnResult` (SSOT);不构造 SdkMessage 队列;
 * 不重试、不收集 telemetry。
 */
export function createRealAnthropicAdapter(
  opts: RealAnthropicAdapterOptions
): AnthropicAdapter {
  async function step(
    state: LoopState,
    request: {
      tools?: unknown;
      onStream?: (event: HarnessStreamEvent) => void;
    },
    signal?: AbortSignal
  ): Promise<AssistantTurnResult> {
    const params = buildMessageParams(opts, state, request);
    // #176 T3:流式臂 / 非流式臂分支路由(ACR hard gate — step 主体的全部分支
    // 逻辑;业务行为由 `stepStreamArm` 与既有 create 臂各自承载)。
    if (opts.stream !== true) {
      // 非流式臂(017 A1 freeze;未开 `stream` 时 byte-identical 既有行为)。
      const sdkResp = await opts.client.messages.create(params, { signal });
      return interpretMessage(sdkResp as SdkMessage);
    }
    return stepStreamArm({
      client: opts.client,
      params,
      signal,
      onStream: request.onStream,
    });
  }
  return Object.freeze({
    step,
    encodeUserText,
    encodeToolResults,
    // #178 T5 (D6):adapter 级模式申报(stream 是构造时静态决策,实例内不切换)。
    streamMode: opts.stream === true,
  });
}

/**
 * #151 T4 / #156 Low:thinking 请求侧参数构造工厂。
 *
 * 输入形状对齐 LlmEnv.thinking / LlmEnv.thinkingEffort(env SSOT 输出),
 * 不绑 LlmEnv 类型本身(避免 anthropic-adapter 反向依赖 src/config/)。
 * 调用点传 env.llm 或任意拥有 thinking / thinkingEffort 字段的对象即可。
 *
 * 模式与 effort 原始值照传;模式 → SDK thinkingParam 与 output_config 的条件
 * 附加仍在 createRealAnthropicAdapter.step 内部按 env 设计走,本函数只单点
 * 消除"runtime 和 hub 两处字面量搬运"的复制粘贴。
 */
export interface ThinkingParams {
  readonly mode: "off" | "adaptive";
  readonly effort?: "" | "low" | "medium" | "high" | "xhigh" | "max";
}

export function buildThinkingParams(env: {
  readonly thinking: "off" | "adaptive";
  readonly thinkingEffort: "" | "low" | "medium" | "high" | "xhigh" | "max";
}): ThinkingParams {
  return {
    mode: env.thinking,
    effort: env.thinkingEffort,
  };
}
