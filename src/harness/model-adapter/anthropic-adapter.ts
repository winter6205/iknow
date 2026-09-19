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

import {
  ProtocolError,
  PromptTooLongError,
  ModelStreamIncompleteError,
  errorMessage,
} from "../errors.js";
import {
  clockAbortOf,
  parseRetryAfterMs,
  type FaultEvent,
} from "../fault-class.js";
import Anthropic, {
  APIConnectionError,
  APIError,
  APIUserAbortError,
} from "@anthropic-ai/sdk";
import type {
  AnthropicContentBlock,
  AnthropicNativeMessage,
  AssistantTurnResult,
  LoopState,
  ModelAdapter,
  TokenUsage,
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
  Usage as SdkUsage,
} from "@anthropic-ai/sdk/resources/messages.js";
import type { MessageStreamEvent } from "@anthropic-ai/sdk/resources/messages.js";
import type { HarnessStreamEvent } from "../stream.js";
import { safeEmitStream } from "../stream.js";

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
 * #160 / ADR-0008 Decision 2: SDK Usage → 域 TokenUsage 纯函数投影。
 *
 * 只透传 4 个 token 字段;周边字段(cache_creation TTL 对象 /
 * output_tokens_details / server_tool_use / inference_geo / service_tier)
 * 无消费者,一律丢弃。cache 两字段缺失 / null 均 coalesce 为 null(
 * SDK 0.115 静态契约本身允许 number|null)。snake→camel 映射在域侧
 * 仅此一处;jsonl.ts 落盘面由泛型反射自动转换,不另写映射。
 */
export function projectSdkUsage(sdk: SdkMessage): TokenUsage | undefined {
  const u = sdk?.usage as SdkUsage | undefined;
  // Postel 硬门:usage 存在但 input/output 非 number(含 usage:{} / 整段缺失)
  // → 整条缺席,绝不产出 {inputTokens: undefined,...} 这类违反 TokenUsage 契约
  // 的垃圾对象。
  if (
    !u ||
    typeof u.input_tokens !== "number" ||
    typeof u.output_tokens !== "number"
  ) {
    return undefined;
  }
  return {
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
    // cache 两字段:非 number(缺失 / null / 供应商垃圾值)统一归一为 null,
    // 与 SDK 0.115 静态契约(number | null)对齐,不把垃圾值透给下游。
    cacheCreationInputTokens:
      typeof u.cache_creation_input_tokens === "number"
        ? u.cache_creation_input_tokens
        : null,
    cacheReadInputTokens:
      typeof u.cache_read_input_tokens === "number"
        ? u.cache_read_input_tokens
        : null,
  };
}

/**
 * #191 compat: 归一化 thinking 块 signature。
 *
 * AnthropicContentBlock 契约要求 `signature: string`(必填,types.ts),session
 * store 校验(schema.ts isValidContentBlock thinking 分支)同样要求 string。
 * 但非 Anthropic 模型(deepseek 等经 9router 转发)返回的 thinking 块可缺
 * signature 字段(实测:deepseek-flash-combo 的 block 仅 {type, thinking})。
 *
 * Postel 语义:宽松接受缺字段的供应商输入,归一化到 canonical 契约 —
 * 非 string(缺失 / null / undefined)→ "";string → 原样透传。与
 * projectSdkUsage 的 cache 两字段归一化先例同构。
 *
 * 回放安全性:9router 接受空 signature 的 thinking 块(实测,"#191"),
 * 故补空串不破坏多轮对话回放(真 Anthropic 模型的 signature 原样保留,
 * 不受影响)。
 *
 * 注意:此归一化对**所有模型**生效(adapter 在 interpret 时无法区分供应商),
 * 空 signature 会静默写入历史。这是有意的兼容性放宽 — 代价是真实
 * Anthropic 模型的 signature 缺失不再被当作协议错误暴露,而是归一为 ""。
 * 权衡后接受:网关对非 Anthropic 模型用 openai-compatible 通道转发,
 * signature 语义本身不完整;若未来需要严格校验,应在此函数按 model 分叉。
 */
export function normalizeThinkingSignature(signature: unknown): string {
  return typeof signature === "string" ? signature : "";
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
      // #191 compat: 非 Anthropic 模型(经 9router 转发的 deepseek 等)的
      // thinking 块可缺 signature — 此处归一化为空串,保证 AnthropicContentBlock
      // 契约(signature: string 必填)与 session store 校验(schema.ts
      // isValidContentBlock thinking 分支)在保存时通过。回放时 9router 接受
      // 空 signature(实测,`#191`),故不破坏多轮回放。
      const tb = b as unknown as ThinkingBlock;
      return [
        {
          type: "thinking",
          thinking: tb.thinking,
          signature: normalizeThinkingSignature(tb.signature),
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

  const usage = projectSdkUsage(sdk);
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
    // #160 / ADR-0008 Decision 2+4: usage 字段缺席 = Postel 语义,
    // SDK 返回无 usage 时整个键不存在(不是 null 占位,不是 undefined 包装)。
    ...(usage !== undefined ? { usage } : {}),
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
/**
 * #252 T2 (reactive compact 地基):SDK 400 prompt-too-long → 翻译为
 * PromptTooLongError (extends ProtocolError,loop-engine instanceof
 * ProtocolError 分支能命中 — T3 reactive compact 入口)。其余错误
 * (其他 400 / 非 400 / 非 APIError) 原样 rethrow,raceModel 现有 catch
 * 路由不变。流式 / 非流式两臂共用此翻译,避免别名重复。
 */
function translatePromptTooLong(e: unknown): never {
  if (
    e instanceof APIError &&
    e.status === 400 &&
    /prompt.*length|too long/i.test(e.message)
  ) {
    throw new PromptTooLongError(e.message);
  }
  throw e;
}

/**
 * ADR-0111 Decision 1: SDK「流结束但未产出 Message」裸 Error 的形态判据。
 * SDK 无 typed 类可 instanceof,按 message 形态匹配,三条件缺一不可:
 *   1. `/stream ended without producing a Message/i`（哨兵测试钉住形态与
 *      SDK 版本,升级换形态即 RED 人工复核）;
 *   2. 非 APIError —— 真 HTTP 语义错误不许被抢翻;
 *   3. cause 链无网络错误 —— 真网络断开属可重试的 `llm_network` 格,
 *      不双标签（判据复用 `someCause` / `isConnectionFault` 单点）。
 */
const STREAM_INCOMPLETE_MESSAGE = /stream ended without producing a Message/i;

function isStreamIncompleteShape(e: unknown): boolean {
  return (
    e instanceof Error &&
    STREAM_INCOMPLETE_MESSAGE.test(e.message) &&
    !(e instanceof APIError) &&
    !someCause(e, isConnectionFault)
  );
}

/**
 * D2 thinkingMs 测量闭包 + ADR-0111 D1 可见增量标志（单点声明——
 * stepStreamArm 与 wireStreamEvents 共用同一形态，防两处内联漂移）。
 * `sawVisibleDelta` = 本次 attempt 见过非空可见增量（text / thinking /
 * input_json 任一），置位点与 measurement 打点同址、空 delta 不置位；
 * 断流翻译 ModelStreamIncompleteError 时作 `visible` 携带。
 */
type StreamMeasurement = {
  start?: number;
  end?: number;
  sawVisibleDelta?: boolean;
};

async function stepStreamArm(deps: {
  readonly client: Anthropic;
  readonly params: MessageCreateParamsNonStreaming;
  readonly signal?: AbortSignal;
  readonly onStream?: (event: HarnessStreamEvent) => void;
}): Promise<AssistantTurnResult> {
  const stream = deps.client.messages.stream(deps.params, {
    signal: deps.signal,
  });
  // D2 (tui-display-consistency):thinkingMs 测量闭包 —— 在 wireStreamEvents
  // 装配时挂 listener,首条 thinking_delta 打起点,首个非思考增量
  // (text_delta / input_json_delta / tool_call_start) 收点。`onStream` 缺席
  // 也挂(只为测时长,零 emit),measurement 与 emit 完全解耦 —— 不污染
  // host 观察者契约。`end` 已记 → 后续不再覆盖(只记首个非思考点)。
  // sawVisibleDelta 语义见 StreamMeasurement doc（ADR-0111 Decision 1）。
  const measurement: StreamMeasurement = {};
  wireStreamEvents(stream, deps.onStream, measurement);
  // D8:断流 / abort → finalMessage() reject → 不构造 AssistantTurnResult。
  try {
    const final = await stream.finalMessage();
    const result = interpretMessage(final);
    // D2: 派生 thinkingMs。`start` 缺席(无 thinking_delta)→ 不产。
    // `end` 缺席(仅思考,无后续非思考)→ 不产(spec: 测量必须两端都打)。
    // 边界形态钉死:差 <= 0 或非有限数 → 字段缺席(store 落盘入口再过滤
    // 一次,绝不落 0 / NaN / Infinity)。
    if (
      typeof measurement.start === "number" &&
      typeof measurement.end === "number"
    ) {
      const elapsed = measurement.end - measurement.start;
      if (Number.isFinite(elapsed) && elapsed > 0) {
        return { ...result, thinkingMs: elapsed };
      }
    }
    return result;
  } catch (e) {
    // wireStreamEvents 已 emit 的部分不受影响 — D8 整回合不提交语义由 step
    // reject 不构造 AssistantTurnResult 保证,翻译只是改变异常类。
    // ADR-0111 Decision 1:SDK 断流形态 → ModelStreamIncompleteError(visible
    // 从 measurement 取)。与 prompt-too-long 判据互斥(断流判据要求非 APIError),
    // 先后顺序不构成行为差。
    if (isStreamIncompleteShape(e)) {
      throw new ModelStreamIncompleteError(
        measurement.sawVisibleDelta === true,
        e
      );
    }
    translatePromptTooLong(e);
  }
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
 *
 * T1 (tui-render-optimization):`content_block_delta` 事件的 payload 只有
 * `index` 无 block id(SDK `RawContentBlockDeltaEvent`),而 `tool_input_delta`
 * 契约需要 id 供 host 与 tool_call_start / postToolUse 配对 — 故在
 * `content_block_start tool_use` 处登记 `index → block.id`,delta 到达时查表。
 */
function wireStreamEvents(
  stream: AnthropicMessageStream,
  onStream: ((event: HarnessStreamEvent) => void) | undefined,
  /** D2 (tui-display-consistency):thinkingMs 测量闭包。`onStream` 缺席时
   *  也挂(只为测时长,零 emit)—— measurement 与 emit 完全解耦。
   *  - 首条 thinking_delta → `start` 记 `performance.now()`
   *  - 首条非思考增量(text_delta / input_json_delta / tool_call_start)
   *    → `end` 记 `performance.now()`
   *  仅记首个端点,后续不覆盖;两端都有 → stepStreamArm 计算 elapsed,
   *  边界形态合法(> 0 且有限数)→ 挂 `thinkingMs`,否则字段缺席。
   *  - `sawVisibleDelta` 语义见 StreamMeasurement doc（ADR-0111 D1）。 */
  measurement?: StreamMeasurement
): void {
  // D2:测量是否在场决定 listener 是否挂。`onStream` 与 measurement 是
  // 独立维度 —— measurement 在场 + onStream 缺席 = 静默测量(只测不 emit),
  // host 零观察者场景仍能产出 thinkingMs。
  if (onStream === undefined && measurement === undefined) return;
  const safeEmit = (event: HarnessStreamEvent): void =>
    safeEmitStream(onStream, event);
  // D2:打点辅助 —— 仅在 measurement 在场 + 端点尚未记时调用 performance.now()。
  // 不在 text-delta 的 empty-skip 路径上打点,避免空文本被误当作首条非思考增量
  // 触发 end(空字符串语义:无信息,不视为阶段切换)。
  const markStart = (): void => {
    if (measurement !== undefined && measurement.start === undefined) {
      measurement.start = performance.now();
    }
  };
  const markEnd = (): void => {
    if (measurement !== undefined && measurement.end === undefined) {
      measurement.end = performance.now();
    }
  };
  // ADR-0111 Decision 1:可见增量置位 —— 与打点同址,只在**非空** delta 上调用
  // (对齐 empty-delta 纪律);断流翻译 ModelStreamIncompleteError 从此读 `visible`。
  const markVisible = (): void => {
    if (measurement !== undefined) {
      measurement.sawVisibleDelta = true;
    }
  };
  // T1:content_block_start 登记 index → block.id,供 content_block_delta
  // (input_json_delta) 配对;函数返回即自然清理(每回合一次装配)。
  const indexToBlockId = new Map<number, string>();
  stream.on("text", (textDelta) => {
    if (textDelta === "") return; // empty delta:不 emit(见上方 empty-class 决策注释)
    markEnd(); // D2 — text_delta 视为首个非思考增量 → 收点
    markVisible(); // ADR-0111 D1 — 非空 text 增量 = 可见输出
    safeEmit({ type: "text_delta", text: textDelta });
  });
  stream.on("streamEvent", (event: MessageStreamEvent) => {
    // 阶段二扩展:thinking_delta 从 content_block_delta 路径透传
    // (thinking 块专属 delta,不与 text_delta 路径混淆 — SDK 对 text 块用
    // `on("text")` 短路,thinking 块只在 content_block_delta 流到)。
    if (event.type === "content_block_delta") {
      const delta = (
        event as {
          index?: number;
          delta?: { type?: string; thinking?: string; partial_json?: string };
        }
      ).delta;
      if (delta?.type === "thinking_delta") {
        const text = delta.thinking ?? "";
        if (text === "") return; // empty delta 不 emit — 对齐 text_delta 纪律
        markStart(); // D2 — 首条 thinking_delta 打起点
        markVisible(); // ADR-0111 D1 — 非空 thinking 增量 = 可见输出
        safeEmit({ type: "thinking_delta", text });
        return;
      }
      // T1:tool input 增量透传 — 增量只服务展示层,权威 input 仍由
      // finalMessage() → interpretMessage 一次性交付(零改动)。
      if (delta?.type === "input_json_delta") {
        const partialJson = delta.partial_json ?? "";
        if (partialJson === "") return; // empty delta 不 emit — 对齐 text_delta 纪律
        markEnd(); // D2 — input_json_delta 视为首个非思考增量 → 收点
        markVisible(); // ADR-0111 D1 — 非空 tool input 增量 = 可见输出
        const id = indexToBlockId.get(event.index);
        // 未登记 / 空串 id 均无 id 可配对 → 不 emit(空串 = tool_use block.id
        // 缺失的 legacy 回退,无法与 tool_call_start / postToolUse 配对)。
        if (id === undefined || id === "") return;
        safeEmit({ type: "tool_input_delta", id, partialJson });
        return;
      }
      return;
    }
    if (event.type !== "content_block_start") return;
    const block = event.content_block;
    // D1 最小集:只 tool_use 翻译为 tool_call_start;server_tool_use 等其它
    // 内容块不在 v1 范围内(interpretMessage 也会因不支持类型 ProtocolError)。
    if (block.type !== "tool_use") return;
    // D2:tool_call_start 也视为首个非思考增量 → 收点(在 thinking 后立刻
    // 接 tool_use,input_json_delta 之前 content_block_start 先到)。
    markEnd();
    // T1:登记 index → block.id,供 input_json_delta 增量配对。
    const id = typeof block.id === "string" ? block.id : "";
    indexToBlockId.set(event.index, id);
    // 阶段二扩展:tool_use block.id 透传,host 据此与 postToolUse 完成事件
    // 配对(T4 实时状态依赖);id 缺失时回退空串(向后兼容 legacy)。
    safeEmit({
      type: "tool_call_start",
      name: block.name,
      id,
    });
  });
}

/**
 * #176 T3 (D2):流式 / 非流式臂之间**共享**的参数体构造 — message 历史 +
 * tools + thinking + temperature 条件附加逻辑一致,字节级同形(消息历史
 * 字段不因流式 / 非流式而变化,KV 缓存前缀稳定性不受影响)。此处不引入
 * `stream: true`,SDK `.stream()` 内部追加。
 */
export function buildMessageParams(
  opts: RealAnthropicAdapterOptions,
  state: LoopState,
  request: { tools?: unknown; system?: string }
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
    // invariant (#383 B2 T2 / R1 #385): system 消息绝不上 wire ——
    // 服务端拒收 + 语义错位。Ctrl+C 打断的 system 项只进 transcript 展示层,
    // 交给 SDK 前必须先过滤掉。
    messages: state.messages.filter(
      (m) => m.role !== "system"
    ) as unknown as MessageParam[],
    ...(tools !== undefined ? { tools } : {}),
    // #196 IKNOW T1:system 字段条件附加 — undefined 或空串都不发
    // (byte-identical 既有行为 + KV 缓存前缀字节级稳定,对齐 #121 同款过滤)。
    ...(request.system !== undefined && request.system !== ""
      ? { system: request.system }
      : {}),
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
      // #196 IKNOW T1:LoopAdapter.step request.system 透传到 SDK params。
      system?: string;
      onStream?: (event: HarnessStreamEvent) => void;
    },
    signal?: AbortSignal
  ): Promise<AssistantTurnResult> {
    const params = buildMessageParams(opts, state, request);
    // #176 T3:流式臂 / 非流式臂分支路由(ACR hard gate — step 主体的全部分支
    // 逻辑;业务行为由 `stepStreamArm` 与既有 create 臂各自承载)。
    if (opts.stream !== true) {
      // 非流式臂(017 A1 freeze;未开 `stream` 时 byte-identical 既有行为)。
      try {
        const sdkResp = await opts.client.messages.create(params, { signal });
        return interpretMessage(sdkResp as SdkMessage);
      } catch (e) {
        translatePromptTooLong(e);
      }
    }
    return stepStreamArm({
      client: opts.client,
      params,
      signal,
      onStream: request.onStream,
    });
  }
  /**
   * B6 / ADR-0043 §3:实测 token 数 —— 透传 SDK `client.messages.
   * countTokens({ messages, model, system?, tools? })`,只取
   * `input_tokens` 一字段(SDK 响应 `MessageTokensCount` 仅此字段)。
   *
   * 契约(与 types.ts CountTokensInput 对齐):
   *   - `input.tools` = 当前 visibleSchemas()(与 step request.tools 同源)
   *   - `input.system` = 装配期 system 文本(与 step request.system 同源)
   *   - `input.messages` = 当前消息历史(空 messages 也合法,SDK 支持)
   *   - `messages` 字段须做 system-role 过滤(`buildMessageParams` 同款
   *     invariant #383 B2 T2 / R1 #385:system 消息绝不上 wire)
   *
   * 失败路径:SDK 抛错(APIError / AbortError / 任何非 200)→ 原样 rethrow,
   * 由装配层 catch → 跳过本会话(详见 `tool-overflow.ts` skip 语义)。
   */
  async function countTokens(input: {
    tools?: ReadonlyArray<unknown>;
    system?: string;
    messages?: ReadonlyArray<AnthropicNativeMessage>;
  }): Promise<{ inputTokens: number }> {
    // system 消息绝不上 wire(同 `buildMessageParams` 装配期 invariant
    // #383 B2 T2 / R1 #385);首轮典型场景 messages 缺席 → undefined → 字段
    // 省略,SDK 接受空 messages。
    const messagesParam: MessageParam[] = input.messages
      ? (input.messages.filter(
          (m) => m.role !== "system"
        ) as unknown as MessageParam[])
      : [];
    const toolsParam = toSdkTools(input.tools);
    // SDK 0.115 `MessageCountTokensParams` 字段:model + messages 必填;
    // system / tools 条件附加,空值/缺席不发。
    const resp = await opts.client.messages.countTokens({
      model: opts.model,
      messages: messagesParam,
      ...(toolsParam !== undefined ? { tools: toolsParam } : {}),
      ...(input.system !== undefined && input.system !== ""
        ? { system: input.system }
        : {}),
    });
    // SDK 响应 `MessageTokensCount`:仅 `input_tokens: number`。空 / 缺
    // 失视为 0 —— 装配层 `runOverflowJudge` 二次守门(非有限数 / 负数 →
    // skip 语义)。
    const n = (resp as { input_tokens?: unknown }).input_tokens;
    return { inputTokens: typeof n === "number" ? n : 0 };
  }
  return Object.freeze({
    step,
    countTokens,
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

/**
 * #672 T2: 供应商只翻译瞬态 HTTP / 网络 vs PromptTooLong vs 其它。
 * 重试循环在 withTransportRetry，不进本文件。
 *
 * transport-continue-persist T1 / spec inv 2（SC2）:**时钟 abort 绝不翻成
 * `user_cancel`**。判据只能读 `signal.reason` 上的 `clock_abort` 标记 ——
 * SDK 的 `APIUserAbortError` 不转发 `signal.reason`（fetch 不转发），且它连
 * `.name` 都不改（恒为 `"Error"`），单看 thrown error 与宿主 Ctrl+C 完全同形。
 *
 * 标记在场时按 `visible` 分流：不可见 → `clock_timeout`（可重试，spec inv 1）；
 * 可见 → `timeout`（已出字，不重试，落既有非重试类）。
 */
export function translateAnthropicTransportFault(
  err: unknown,
  signal?: AbortSignal
): FaultEvent {
  const clock = clockAbortOf(signal);
  if (clock !== undefined) {
    return clock.visible
      ? { kind: "timeout" }
      : { kind: "clock_timeout", source: clock.source, visible: false };
  }
  return nonClockFaultOf(err);
}

/** cause 链遍历上限：SDK 埋一层 fetch 失败，再下一层才是原生 TLS / socket 错误。 */
const CAUSE_CHAIN_MAX_DEPTH = 5;

/**
 * 非时钟分支：供应商侧 thrown error → FaultEvent。
 *
 * 判别顺序是契约的一部分：
 *   1. `prompt_too_long` —— 输入超限已可判定，重发同一 prompt 只会再超限一次；
 *   2. `stream_incomplete` —— ADR-0111 Decision 3：`ModelStreamIncompleteError`
 *      instanceof 直判（extends `ProtocolError`，若落到后续支会被 default 压成
 *      `protocol_error`，丢掉 visible 重试判据），先于一切形态猜测；
 *   3. abort —— `APIUserAbortError extends APIError<T, T, T>` 且 `status ===
 *      undefined`，落到 HTTP 支会把宿主 Ctrl+C 翻成 `llm_http: 0` 这个假状态码
 *      （typed-error 契约的一条推论：不许把「非 HTTP 故障」伪装成 0 号 HTTP）；
 *   4. `llm_http` —— **只认带数值 status 的真 HTTP 响应**；
 *   5. cert / TLS 校验失败 —— 确定性失败，显式落 `protocol_error`（spec inv 4 的
 *      cert 格），不得冒充可重试的 `llm_network`；
 *   6. `llm_network` —— 连接类故障（含 SDK 类 `cause` 链里的原生网络错误），
 *      归 retry 类（spec inv 4:explicit network faults）。
 *
 * 第 5 / 6 步都在 HTTP 支之后：`APIConnectionError` /
 * `APIConnectionTimeoutError` 同样 extends `APIError` 而 `status === undefined`，
 * 被 HTTP 支先接走就会翻成 `llm_http: 0`（classifyFault → none），使网络重试格
 * 永远不可达——所以 HTTP 支带上 `status` 数值判据，把它们让给连接支。反过来，
 * 真 HTTP 语义优先：4xx 的确定性失败不因 `cause` 里挂着连接错误就变成可重试。
 *
 * default 支只剩真·未知形态（ADR-0111 Decision 4）：return 前 console.warn
 * 一条诊断（name + message 截断 ≤200 字符，不打 stack / 请求体），分类结果
 * 仍 `protocol_error` —— 不再静默压平，SDK 升级换形态有线上信号。
 */
function nonClockFaultOf(err: unknown): FaultEvent {
  if (err instanceof PromptTooLongError) return { kind: "prompt_too_long" };
  if (err instanceof ModelStreamIncompleteError) {
    return { kind: "stream_incomplete", visible: err.visible };
  }
  if (err instanceof APIUserAbortError || isAbortErrorShape(err)) {
    return { kind: "user_cancel" };
  }
  if (err instanceof APIError && typeof err.status === "number") {
    // 429 / 5xx 的 `retry-after` 由本层翻成毫秒（spec inv 4:honor retry-after），
    // 退避策略仍在 withTransportRetry —— 本层只给 FaultEvent 填形状。
    return {
      kind: "llm_http",
      status: err.status,
      ...withRetryAfter(err.headers),
    };
  }
  if (someCause(err, isCertFailure)) return { kind: "protocol_error" };
  if (someCause(err, isConnectionFault)) return { kind: "llm_network" };
  // ADR-0111 Decision 4:default 只剩真·未知形态 —— 不静默压平,留一条诊断
  // （name + message 截断 ≤200 字符,不打 stack / 请求体）,分类结果不变。
  // worker stdout 是信封协议面,warn 走 stderr 不污染(ADR-0111 D4)。
  const name = err instanceof Error ? err.name : typeof err;
  console.warn(
    `[anthropic-adapter] unclassified model fault: ${name}: ${errorMessage(
      err
    ).slice(0, 200)}`
  );
  return { kind: "protocol_error" };
}

/**
 * `cause` 链（含自身）上是否存在满足 `predicate` 的一层。深度有界，自环即止：
 * SDK 的 `APIConnectionError.cause` 是 `TypeError("fetch failed")`，真正的判据
 * （socket 错误码 / 证书错误）在其下一层，只看最外层等于什么都没看。
 */
function someCause(
  err: unknown,
  predicate: (candidate: unknown) => boolean
): boolean {
  let current: unknown = err;
  for (
    let depth = 0;
    depth < CAUSE_CHAIN_MAX_DEPTH && current !== undefined;
    depth += 1
  ) {
    if (predicate(current)) return true;
    const next: unknown =
      current instanceof Error ? (current as Error).cause : undefined;
    if (next === current) return false;
    current = next;
  }
  return false;
}

/** 证书 / TLS 校验失败：code（`DEPTH_ZERO_SELF_SIGNED_CERT` 类）或文案。 */
const CERT_FAILURE_CODE = /CERT|_SSL_/i;
const CERT_FAILURE_MESSAGE = /certificate|self[-_ ]signed|\bTLS\b|\bSSL\b/i;

function isCertFailure(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code: unknown = (err as { readonly code?: unknown }).code;
  if (typeof code === "string" && CERT_FAILURE_CODE.test(code)) return true;
  return CERT_FAILURE_MESSAGE.test(err.message);
}

/** 连接类故障（单层判别，链式遍历由 `someCause` 负责）。 */
function isConnectionFault(err: unknown): boolean {
  if (err instanceof APIConnectionError) return true;
  if (!(err instanceof Error)) return false;
  return (
    err.name.includes("Connection") ||
    /ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|fetch failed|network/i.test(
      err.message
    )
  );
}

/** `retry-after` 头 → `retryAfterMs` 字段;缺席 / 畸形 → 字段不挂。 */
function withRetryAfter(headers: Headers | undefined): {
  readonly retryAfterMs?: number;
} {
  const retryAfterMs = parseRetryAfterMs(headers?.get("retry-after"));
  return retryAfterMs !== undefined ? { retryAfterMs } : {};
}

/** 裸 DOMException / Error 形态的 abort（离线替身与既有测试的 AbortError）。 */
function isAbortErrorShape(err: unknown): boolean {
  if (typeof DOMException !== "undefined" && err instanceof DOMException) {
    return err.name === "AbortError";
  }
  return err instanceof Error && err.name === "AbortError";
}
