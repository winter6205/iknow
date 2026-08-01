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
  LoopEngineDeps,
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
  const blocks: AnthropicContentBlock[] = [];
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
  };
}

export function makeDeps(responses: AssistantTurnResult[]): LoopEngineDeps {
  const tool = createStubTool({ name: "noop", next: () => ({}) });
  const registry = createRegistry([tool]);
  const executor = createExecutor(registry);
  const adapter = createStubModel({ responses });
  return { adapter, executor, registry, maxTurns: 5 };
}

export function makeState(over: Partial<CliChatState> = {}): CliChatState {
  return {
    messages: [],
    jsonMode: false,
    session: { caller_role: "employee" },
    ...over,
  };
}

export interface MakeCtxOpts {
  readonly responses: AssistantTurnResult[];
  readonly stateOverrides?: Partial<CliChatState>;
}

export function makeCtx(opts: MakeCtxOpts): ChatLineContext {
  return {
    deps: makeDeps(opts.responses),
    state: makeState(opts.stateOverrides ?? {}),
  };
}
