/**
 * Shared CLI test fixtures. Not exported from src/ barrels on purpose — tests
 * reach into harness stubs via direct imports, and `tests/cli/_fixtures.ts`
 * keeps the duplication local to the CLI test surface.
 *
 * Used by:
 *   - tests/cli-session.test.ts
 *   - tests/cli/process-chat-line-harness.test.ts
 *   - tests/chat-repl.test.ts (harness integration block)
 */
import type {
  AnthropicContentBlock,
  AnthropicNativeMessage,
  AssistantTurnResult,
  HarnessStreamEvent,
  LoopEngineDeps,
  TokenUsage,
} from "../../src/harness/index.ts";
import { createStubModel } from "../../src/harness/stubs/stub-model.ts";
import { createStubTool } from "../../src/harness/stubs/stub-tool.ts";
import { createRegistry } from "../../src/harness/tools/registry.ts";
import { createExecutor } from "../../src/harness/tools/executor.ts";
import type { ChatLineContext } from "../../src/cli/chat-session.ts";
import type { CliChatState } from "../../src/cli/slash.ts";

export interface MakeNativeOpts {
  readonly role: "user" | "assistant";
  readonly text: string;
}

export function makeNative(opts: MakeNativeOpts): AnthropicNativeMessage {
  return { role: opts.role, content: [{ type: "text", text: opts.text }] };
}

export interface AssistantResultOpts {
  readonly texts: string[];
  readonly toolCalls?: Array<{ id: string; name: string; input: unknown }>;
  readonly supplierStop?: "success" | "truncation" | "refusal" | "other";
  /** #152 T5: optional thinking blocks; full fields kept in nativeMessage.content. */
  readonly thinkingBlocks?: ReadonlyArray<{
    readonly type: "thinking" | "redacted_thinking";
    readonly thinking?: string;
    readonly signature?: string;
    readonly data?: string;
  }>;
  /**
   * #160 T4: optional token usage(传入时附带于返回对象;不传则字段缺席,
   * 保持 stub 路径无 usage 的设计语义)。
   */
  readonly usage?: TokenUsage;
}

/**
 * Build an `AssistantTurnResult` matching harness stub expectations.
 * Shape aligned with tests/harness/loop-engine.test.ts.
 */
export function assistantResult(
  opts: AssistantResultOpts
): AssistantTurnResult {
  const texts = opts.texts;
  const toolCalls = opts.toolCalls ?? [];
  const supplierStop = opts.supplierStop ?? "success";
  const thinkingBlocks = opts.thinkingBlocks ?? [];
  const blocks: AnthropicContentBlock[] = [];
  // thinking blocks precede text / tool_use (Q2 block-order decision).
  for (const tb of thinkingBlocks) {
    if (tb.type === "thinking") {
      blocks.push({
        type: "thinking",
        thinking: tb.thinking ?? "",
        signature: tb.signature ?? "",
      });
    } else {
      blocks.push({ type: "redacted_thinking", data: tb.data ?? "" });
    }
  }
  for (const t of texts) blocks.push({ type: "text", text: t });
  for (const c of toolCalls) {
    blocks.push({ type: "tool_use", id: c.id, name: c.name, input: c.input });
  }
  const native: AnthropicNativeMessage = { role: "assistant", content: blocks };
  return {
    nativeMessage: native,
    projection: { nativeMessage: native, texts, toolCalls },
    supplierStop,
    needsTools: toolCalls.length > 0,
    isEmptyFinalResponse:
      supplierStop === "success" &&
      texts.length === 0 &&
      toolCalls.length === 0,
    // 不传 usage 则字段缺席(stub 路径默认语义);传入时原样附带。
    ...(opts.usage !== undefined && { usage: opts.usage }),
  };
}

/**
 * Build LoopEngineDeps backed by stub-model (createStubModel).
 *
 * #179 T6: optional `streamEventsByStep` forwards to the stub's
 * `streamEventsByStep` seam (T4 wiring). When set, each step emits the
 * scripted events before returning its `responses` entry.
 */
export function makeDeps(
  responses: AssistantTurnResult[],
  opts: {
    readonly streamEventsByStep?: ReadonlyArray<
      ReadonlyArray<HarnessStreamEvent>
    >;
  } = {}
): LoopEngineDeps {
  const tool = createStubTool({ name: "noop", next: () => ({}) });
  const registry = createRegistry([tool]);
  const executor = createExecutor(registry);
  const adapter = createStubModel({
    responses,
    // createStubModel accepts `streamEventsByStep: undefined`; passing through
    // directly keeps the optional forward trivial (no conditional spread).
    streamEventsByStep: opts.streamEventsByStep,
  });
  return { adapter, executor, registry, maxTurns: 5 };
}

export function makeState(over: Partial<CliChatState> = {}): CliChatState {
  return {
    messages: [],
    jsonMode: false,
    session: {},
    ...over,
  };
}

export interface MakeCtxOpts {
  readonly responses: AssistantTurnResult[];
  readonly stateOverrides?: Partial<CliChatState>;
  /** #179 T6: per-step stream-event script (stub-model streamEventsByStep seam). */
  readonly streamEventsByStep?: ReadonlyArray<
    ReadonlyArray<HarnessStreamEvent>
  >;
}

export function makeCtx(opts: MakeCtxOpts): ChatLineContext {
  return {
    deps: makeDeps(opts.responses, {
      streamEventsByStep: opts.streamEventsByStep,
    }),
    state: makeState(opts.stateOverrides ?? {}),
  };
}
