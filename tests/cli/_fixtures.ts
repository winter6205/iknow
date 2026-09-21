/**
 * Shared CLI test fixtures. Not exported from src/ barrels on purpose — tests
 * reach into harness stubs via direct imports, and `tests/cli/_fixtures.ts`
 * keeps the duplication local to the CLI test surface.
 *
 * Used by:
 *   - tests/cli-session.test.ts
 *   - tests/cli/process-chat-line-harness.test.ts
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
  /** Optional thinking blocks; full fields kept in nativeMessage.content. */
  readonly thinkingBlocks?: ReadonlyArray<{
    readonly type: "thinking" | "redacted_thinking";
    readonly thinking?: string;
    readonly signature?: string;
    readonly data?: string;
  }>;
  /**
   * This assistant turn's thinking duration (ms). Absent by default on the stub
   * path (simulating the real "not measurable" case); attached only when passed
   * in.
   */
  readonly thinkingMs?: number;
  /**
   * Optional token usage: attached to the returned object when passed; when
   * omitted the field is absent, keeping the stub path's no-usage design.
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
    // thinkingMs default-field semantics: the stub passes nothing; when supplied it
    // is attached verbatim.
    ...(opts.thinkingMs !== undefined && { thinkingMs: opts.thinkingMs }),
    // No usage passed → field absent (the stub path's default); passed → attached
    // verbatim.
    ...(opts.usage !== undefined && { usage: opts.usage }),
  };
}

/**
 * Build LoopEngineDeps backed by stub-model (createStubModel).
 *
 * Optional `streamEventsByStep` forwards to the stub's `streamEventsByStep`
 * seam. When set, each step emits the scripted events before returning its
 * `responses` entry.
 *
 * Optional `delayMs` forwards to stub-model's step delay seam so stream-driven UI
 * states (e.g. `tool_call_start` → `[运行中]` ("running") tail) have time to
 * render before the turn completes.
 */
export function makeDeps(
  responses: AssistantTurnResult[],
  opts: {
    readonly streamEventsByStep?: ReadonlyArray<
      ReadonlyArray<HarnessStreamEvent>
    >;
    readonly delayMs?: number;
  } = {}
): LoopEngineDeps {
  const tool = createStubTool({ name: "noop", next: () => ({}) });
  const registry = createRegistry([tool]);
  const executor = createExecutor(registry);
  const adapter = createStubModel({
    responses,
    // createStubModel accepts `streamEventsByStep` / `delayMs`: undefined
    // passes through (no conditional spread); keeps the optional forward
    // trivial and lets future seams plug in the same way.
    streamEventsByStep: opts.streamEventsByStep,
    ...(opts.delayMs !== undefined && { delayMs: opts.delayMs }),
  });
  return { adapter, executor, registry, maxTurns: 5 };
}

export function makeState(over: Partial<CliChatState> = {}): CliChatState {
  return {
    messages: [],
    jsonMode: false,
    session: {},
    conversationId: null,
    ...over,
  };
}

export interface MakeCtxOpts {
  readonly responses: AssistantTurnResult[];
  readonly stateOverrides?: Partial<CliChatState>;
  /** Per-step stream-event script (stub-model streamEventsByStep seam). */
  readonly streamEventsByStep?: ReadonlyArray<
    ReadonlyArray<HarnessStreamEvent>
  >;
  /** Per-step stub-model delay (milliseconds). */
  readonly delayMs?: number;
  /** Checkpoint store; when injected, processChatLine takes its persistence branch. */
  readonly checkpointStore?: import("../../src/session-api/store/index.ts").SessionStore;
  /** Resolved root used when processChatLine bootstraps a session file. */
  readonly workspaceRoot?: string;
  /** Abort controller; when injected, processChatLine passes controller.signal to run(). */
  readonly abortController?: AbortController;
  /** ADR-0092: fs isolation-mode holder; when injected, processChatLine passes it to the verify surface. */
  readonly fsMode?: import("../../src/harness/sandbox/fs-mode.ts").FsModeContext;
}

export function makeCtx(opts: MakeCtxOpts): ChatLineContext {
  return {
    deps: makeDeps(opts.responses, {
      streamEventsByStep: opts.streamEventsByStep,
      delayMs: opts.delayMs,
    }),
    state: makeState(opts.stateOverrides ?? {}),
    ...(opts.checkpointStore !== undefined && {
      checkpointStore: opts.checkpointStore,
    }),
    ...(opts.workspaceRoot !== undefined && {
      workspaceRoot: opts.workspaceRoot,
    }),
    ...(opts.abortController !== undefined && {
      abortController: opts.abortController,
    }),
    ...(opts.fsMode !== undefined && { fsMode: opts.fsMode }),
  };
}
