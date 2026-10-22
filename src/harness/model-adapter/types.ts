/**
 * Foundation shared types for the model-adapter bounded context.
 *
 * These types are the core interface shapes both the loop engine and the
 * model adapter depend on. Note: wire-protocol types like
 * `AnthropicNativeMessage` are interpreted and produced ONLY by the model
 * adapter — the loop engine never reads or constructs vendor-native fields.
 *
 * `ModelAdapter.step`'s `request` carries an optional `onStream` observer
 * (streaming event contract SSOT `../stream.ts`); only the streaming arm
 * consumes it — non-streaming arms ignore it, and when absent, behavior is
 * byte-identical to before. The optional `onDispatch` observer (evidence only,
 * see `SdkDispatchEvidence`) has the same absent-means-unchanged rule.
 */

import type { HarnessStreamEvent } from "../stream.js";
import type { ImageContentBlock } from "./image-content.js";

/** Anthropic native content block (interpreted by the model adapter). */
export type AnthropicContentBlock =
  | { type: "text"; text: string }
  | {
      type: "tool_use";
      id: string;
      name: string;
      input: unknown;
    }
  | {
      type: "tool_result";
      tool_use_id: string;
      content: unknown;
      is_error?: boolean;
    }
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "redacted_thinking"; data: string }
  // Top-level images exist only on the user-paste path (`image-content.ts`);
  // the `read_image` tool's output stays nested inside `tool_result.content`.
  | ImageContentBlock;

/** Anthropic native message role. */
export type AnthropicRole = "user" | "assistant" | "system";

/** Anthropic native message (the append-only unit of authoritative history). */
export interface AnthropicNativeMessage {
  readonly role: AnthropicRole;
  readonly content: ReadonlyArray<AnthropicContentBlock>;
  /**
   * ADR-0112: host-injection commit stamp. NOT model-visible — the outbound
   * projection (`outbound-projection.ts`) strips it before serialization, so
   * it never appears in wire JSON; official frame shapes
   * (`<agent_status>` / prefix anchors) are only allowed on stamped messages.
   * On-disk truth may carry the field (store validation passes unknown
   * top-level fields through), and the stamp surviving the JSONL chain keeps
   * the same history producing the same wire prefix after resume (KV stable).
   */
  readonly hostInjected?: true;
}

/** Runtime authoritative state (single source of truth — no second copy). */
export interface LoopState {
  /** Anthropic native messages, append-only immutable growth. */
  readonly messages: ReadonlyArray<AnthropicNativeMessage>;
  /** +1 per completed assistant turn (including plain-text completion). */
  readonly turnCount: number;
}

/** Stop reasons (append-only union, never reorder). */
export type StopReason =
  | "completed" // success stop + no tool call + at least one non-empty text
  | "maxTurns" // turnCount hit its ceiling
  | "nonSuccessStop" // legitimate but unfinished vendor result (truncation/refusal)
  | "protocolError" // assistant turn structurally invalid; turn excluded from history
  | "emptyFinalResponse" // vendor reports success stop but no displayable text; excluded from history
  | "cancelled" // signal abort
  | "timeout" // timeoutMs hit
  | "fused"; // this run fused on tool-loop stall (appended only; earlier values stable)

/**
 * ADR-0126: the adapter's normalized supplier stop minus `success` — the
 * diagnostic detail a failed turn carries alongside its StopReason. Keyed off
 * `AssistantTurnResult["supplierStop"]` so a new supplier value is listed here
 * without a second hand-maintained union drifting.
 */
export type SupplierStopDetail = Exclude<
  AssistantTurnResult["supplierStop"],
  "success"
>;

/** State-machine transition (discriminated union, backward-compatible). */
export type Transition =
  | { kind: "continue"; nextState: LoopState }
  | { kind: "stop"; reason: StopReason; finalState: LoopState };

/** External result of one run. */
export interface RunResult {
  /** Derived from the last successful assistant turn's text blocks (non-authoritative). */
  readonly finalText: string | null;
  readonly messages: ReadonlyArray<AnthropicNativeMessage>;
  readonly turnCount: number;
  readonly stopReason: StopReason;
  /**
   * ADR-0126: normalized supplier-stop detail behind a `nonSuccessStop`
   * (`truncation` = the output budget was exhausted). Absent for every other
   * stop — the StopReason union stays untouched and this field never
   * substitutes for it.
   */
  readonly supplierDetail?: SupplierStopDetail;
  /**
   * ADR-0008: token usage of the last successful model call (for display;
   * the TUI reads it via hub-bridge straight from RunResult). Required field:
   * null = the run had no successful model call (or all had absent usage).
   * Deliberately not an optional field — absence semantics are reserved for
   * the LlmCallRecord persistence surface (Postel, ADR-0008).
   */
  readonly lastUsage: TokenUsage | null;
  /**
   * ADR-0094: gateway-side summary (status + message text) when transport
   * failed — extracted from the cause after loop-engine catches
   * TransportRetryExhaustedError; absent for non-transport failures
   * (byte-stable; different semantics from lastUsage, which is required null).
   * hub.toTurnDto forwards it to TurnAnswerDto.apiError so the TUI can
   * render an "API error (status): message" notice.
   */
  readonly apiError?: { readonly status?: number; readonly message: string };
}

/** Assistant-turn projection: ordered texts + ordered tool calls, native order kept. */
export interface AssistantProjection {
  /** Raw native assistant message, preserved verbatim for history appends. */
  readonly nativeMessage: AnthropicNativeMessage;
  /** Ordered text projection (text blocks in appearance order). */
  readonly texts: ReadonlyArray<string>;
  /** Ordered tool-call projection (id + tool name + raw input). */
  readonly toolCalls: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly input: unknown;
  }>;
}

/** Adapter turn result (one native assistant turn). */
export interface AssistantTurnResult {
  /** Validated native assistant message, atomically appendable by the loop. */
  readonly nativeMessage: AnthropicNativeMessage;
  /** Projection (texts + tool calls, native order preserved). */
  readonly projection: AssistantProjection;
  /** Vendor stop reason as interpreted by the adapter (success / truncation / refusal / other). */
  readonly supplierStop: "success" | "truncation" | "refusal" | "other";
  /** Whether tools are needed (any valid tool call ⇒ true). */
  readonly needsTools: boolean;
  /**
   * Whether the turn carried thinking / redacted_thinking content. The
   * adapter is the only party that read the native blocks, so it reports the
   * fact: consumers that need "progress without an answer" (loop-engine's
   * tool-free arm) ask here instead of re-deriving the EmptyFinalResponse
   * rule from the block mix.
   */
  readonly hasThinking: boolean;
  /**
   * EmptyFinalResponse?: a success stop whose blocks carry no text, no
   * tool_use, and no thinking / redacted_thinking — neither an answer nor
   * visible progress.
   */
  readonly isEmptyFinalResponse: boolean;
  /**
   * ADR-0008: token usage of one successful assistant turn (sealed
   * passthrough, same shape as `supplierStop`). Entire SDK usage missing →
   * field absent (no null, no {0,0,...}); loop-engine copies it into
   * `LlmCallRecord` at `recordLlmCall`, and `RunResult.lastUsage` holds the
   * last successful value. Stub paths have no usage — absence is by design.
   */
  readonly usage?: TokenUsage;
  /**
   * Thinking duration of this assistant turn in ms. Measured in the
   * anthropic-adapter streaming arm: wall clock from the first thinking_delta
   * to the first non-thinking delta (text_delta / tool_call_start /
   * tool_input_delta). Edge forms are pinned: `thinkingMs <= 0` or
   * non-finite → undefined (the store entry filters again; 0 / NaN / Infinity
   * are never persisted). Non-streaming arms don't produce it (absent =
   * old-session compatibility + no-thinking turns). Postel: absent means
   * "not measurable" — the field simply doesn't exist (never null).
   */
  readonly thinkingMs?: number;
  /**
   * Generation duration of this assistant turn in ms: wall clock from the
   * first non-empty output delta (text_delta / thinking_delta /
   * tool_input_delta) to `finalMessage()` resolution. Excludes the first-token
   * wait and tool execution; measured on the monotonic clock. Edge forms are
   * pinned like thinkingMs: `generationMs <= 0` or non-finite → undefined
   * (never null). Non-streaming arms and streams whose deltas were all empty
   * don't produce it. Postel: absent means "not measurable".
   */
  readonly generationMs?: number;
}

/**
 * EmptyFinalResponse rule (the field above): a success stop ends the run with
 * no answer only when its blocks carry neither displayable content (text) nor
 * progress-bearing content (thinking / redacted_thinking); tool_use turns
 * continue regardless.
 *
 * Lives beside the contract it interprets, not in the adapter: this module is
 * a runtime leaf (every import in it is `import type`), so a test fixture can
 * state the rule without pulling in a module that other tests replace with a
 * `vi.mock` factory — a factory that imports such a fixture deadlocks when the
 * fixture statically imports the very module being mocked.
 */
export function isEmptyFinalResponseStop(
  supplierStop: AssistantTurnResult["supplierStop"],
  texts: readonly string[],
  toolCalls: readonly unknown[],
  hasThinking: boolean
): boolean {
  return (
    supplierStop === "success" &&
    texts.length === 0 &&
    toolCalls.length === 0 &&
    !hasThinking
  );
}

/** Token quartet aligned with the Anthropic SDK Usage (ADR-0008). */
export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheCreationInputTokens: number | null;
  readonly cacheReadInputTokens: number | null;
}

/**
 * ADR-0043: input for countTokens — the SDK's `client.messages.countTokens`
 * projected into the harness domain. Read-only token counting (no streaming
 * arm, no tool_call validation), used only by the assembly layer's first-turn
 * overflow governance.
 *
 * Minimal field projection:
 *   - `tools` = current visibleSchemas() (non-lazy + discovered lazy)
 *   - `system` = current system text (optional; same source as step request.system)
 *   - `messages` = current history (optional; an empty list is rejected by
 *     Anthropic-compatible gateways → a caller measuring a first-request
 *     surface supplies a stand-in turn)
 *
 * Real adapters implement this; stub / offline adapters / unavailable
 * endpoints → field absent (undefined), and the assembly layer skips this
 * session (see `tool-overflow.ts`).
 */
export interface CountTokensInput {
  readonly tools?: ReadonlyArray<unknown>;
  readonly system?: string;
  readonly messages?: ReadonlyArray<AnthropicNativeMessage>;
}

/**
 * ADR-0043: minimal countTokens response projection — the measured token
 * count, compared against `contextWindow * 0.1` for overflow. Deliberately
 * NOT the full SDK Usage (overflow governance needs no cache fields).
 */
export interface CountTokensResult {
  /** SDK `MessageTokensCount.input_tokens` (the only field countTokens returns). */
  readonly inputTokens: number;
}

/**
 * Evidence of one governed SDK invocation, read off the final request object
 * at the dispatch boundary (after outbound / tool / instruction projection).
 *
 * Per-invocation identity (`invocationId`) is deliberately separate from any
 * later content identity: two attempts whose bodies coincide are still two
 * invocations. Carries the request body only — no credentials, no transport
 * headers, and no claim that a response was received.
 */
export interface SdkDispatchEvidence {
  /** Unique per governed SDK invocation, minted before dispatch. */
  readonly invocationId: string;
  /** True when this invocation takes the streaming arm. */
  readonly stream: boolean;
  /** The exact ordered `messages` array handed to the SDK. */
  readonly messages: ReadonlyArray<unknown>;
  /** Present only when the request carried system instructions. */
  readonly system?: string;
  /** Present only when the request advertised tool definitions. */
  readonly tools?: ReadonlyArray<unknown>;
}

/** Model adapter interface. */
export interface ModelAdapter {
  /** Atomic validate + project: returns AssistantTurnResult or throws ProtocolError. */
  readonly step: (
    state: LoopState,
    // Optional onStream — streaming-event observer, consumed by the streaming
    // arm only; offline adapters / non-streaming arms ignore it.
    // Optional onDispatch — best-effort observer of the final SDK request
    // object, called once per attempt before dispatch. It is evidence only:
    // a throwing observer never fails, retries, or re-dispatches the call.
    request: {
      tools?: unknown;
      /** Assembled system instructions for this turn; absent → not sent. */
      system?: string;
      onStream?: (event: HarnessStreamEvent) => void;
      onDispatch?: (evidence: SdkDispatchEvidence) => void;
    },
    signal?: AbortSignal // run's third argument passed through verbatim; offline implementations may ignore it
  ) => Promise<AssistantTurnResult>;
  /**
   * ADR-0043: OPTIONAL countTokens hook (overflow governance only).
   *
   * The real Anthropic adapter (`createRealAnthropicAdapter`) implements it,
   * passing `{ messages, model, system?, tools? }` to SDK
   * `client.messages.countTokens` for a measured count. Stub / offline
   * adapters don't; when absent (`undefined`) the assembly layer skips this
   * session (all deferrable built-ins stay resident) + `console.warn` — no
   * throw, no retry on the first turn (pinned semantics).
   *
   * Contract:
   *   - `tools` = harness `ToolDef[]` (same source as step request.tools;
   *     offline/real adapters translate to their SDK shapes).
   *   - Returned `inputTokens` must be a finite positive number, otherwise
   *     treated as failure (same semantics as catch).
   *   - SDK errors (APIError / 4xx/5xx) → throw; the assembly layer catches
   *     and skips this session.
   */
  readonly countTokens?: (
    input: CountTokensInput
  ) => Promise<CountTokensResult>;
}
