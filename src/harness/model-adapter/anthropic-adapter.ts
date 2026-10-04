/**
 * Anthropic Model Adapter.
 *
 * Boundaries:
 *   - Owns response interpretation + tool-result encoding for the Anthropic
 *     Messages protocol;
 *   - Request assembly belongs to the Loop Engine (the Adapter only consumes
 *     { tools?: unknown } to decide whether to declare tools); the Adapter
 *     never builds outbound request bodies;
 *   - Atomically validates native assistant responses and projects them to
 *     AssistantTurnResult;
 *   - Any protocol-structural error in any block of an assistant turn throws
 *     ProtocolError — the whole turn stays out of the authoritative history
 *     and none of its tool calls execute;
 *   - Does not read / judge / construct other vendors' native fields;
 *   - Loop Engine only consumes native messages the Adapter delivered;
 *   - text / tool_use blocks are validated atomically (type + required
 *     fields); thinking / redacted_thinking blocks pass through with all
 *     fields retained (signature / data kept so the authoritative history
 *     stays replayable — no validation trimming).
 *
 * The offline implementation accepts scripted SdkMessage arrays as
 * responses (no real model) and supports a stream-interruption fixture.
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
import { randomUUID } from "node:crypto";
import type {
  AnthropicContentBlock,
  AnthropicNativeMessage,
  AssistantTurnResult,
  LoopState,
  ModelAdapter,
  SdkDispatchEvidence,
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
import { projectMessagesForWire } from "./outbound-projection.js";

/**
 * Minimal consumption surface of the SDK MessageStream returned by
 * `client.messages.stream(...)`.
 *
 * Why a structural type instead of importing `MessageStream`: under
 * NodeNext, `@anthropic-ai/sdk/lib/MessageStream.js` (CJS) and `.mjs` (ESM)
 * are two variants whose `#private` members are incompatible, so an
 * explicit import conflicts with the (ESM-resolved) return type of the
 * SDK's `.stream()`. This declares exactly what the module consumes
 * (`on` + `finalMessage`); real SDK streams are structurally compatible,
 * and test fake streams are assembled against this same surface (no real
 * network).
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
  /** Scripted responses: each step consumes the next; when exhausted, throw ProtocolError (simulates a broken stream). */
  readonly responses: ReadonlyArray<SdkMessage>;
  /** Optional stream events (used by the stream-interrupted fixture); if provided, must end with message_stop. */
  readonly streamEvents?: ReadonlyArray<unknown>;
  /** When true, streamEvents do not end with message_stop (simulates interruption). */
  readonly streamInterrupt?: boolean;
  readonly model: string;
  readonly maxTokens: number;
  /** Model-side timeout (ms). No effect in offline (scripted) mode; the signature exists so wiring the real SDK later needs no signature change. */
  readonly timeoutMs?: number;
}

/**
 * ADR-0008: pure projection of SDK Usage → domain TokenUsage.
 *
 * Passes through only the 4 token fields; surrounding fields
 * (cache_creation TTL object / output_tokens_details / server_tool_use /
 * inference_geo / service_tier) have no consumers and are dropped. Both
 * cache fields coalesce missing / null to null (the SDK's static contract
 * itself allows number|null). This is the single snake→camel mapping site
 * on the domain side; the jsonl persistence layer converts generically via
 * reflection, so no second map.
 */
export function projectSdkUsage(sdk: SdkMessage): TokenUsage | undefined {
  const u = sdk?.usage as SdkUsage | undefined;
  // Postel hard gate: usage present but input/output not numbers
  // (including usage:{} / the whole block missing) → the field is absent
  // entirely; never emit a garbage object violating the TokenUsage
  // contract.
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
    // cache fields: anything non-number (missing / null / vendor junk)
    // normalizes to null, matching the SDK's static contract
    // (number | null); junk never reaches downstream.
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
 * Normalize thinking-block signatures.
 *
 * AnthropicContentBlock requires `signature: string` (types.ts), and the
 * session-store validator (schema.ts isValidContentBlock, thinking branch)
 * requires the same. But non-Anthropic models (e.g. deepseek forwarded via
 * 9router) can return thinking blocks without a signature (observed:
 * blocks carrying only {type, thinking}).
 *
 * Postel semantics: accept vendor input with missing fields leniently and
 * normalize to the canonical contract — non-string (missing / null /
 * undefined) → ""; string → passthrough. Same shape as the cache-field
 * normalization precedent in projectSdkUsage.
 *
 * Replay safety: 9router accepts thinking blocks with an empty signature
 * (verified), so filling with "" does not break multi-turn replay (real
 * Anthropic signatures are preserved verbatim).
 *
 * Note: this normalization applies to **all models** (the adapter cannot
 * distinguish vendors at interpret time), and an empty signature is written
 * silently into history. This is a deliberate compatibility widening — the
 * cost is that a genuine Anthropic model's missing signature is no longer
 * surfaced as a protocol error but normalized to "". Accepted after
 * weighing: the gateway forwards non-Anthropic models over an
 * openai-compatible channel where signature semantics are already
 * incomplete; if strict validation is ever needed, branch by model inside
 * this function.
 */
export function normalizeThinkingSignature(signature: unknown): string {
  return typeof signature === "string" ? signature : "";
}

/**
 * Interpret a native Anthropic SDK Message into a Foundation
 * AssistantTurnResult. text / tool_use blocks are validated atomically:
 * any block protocol error → throw ProtocolError, the whole turn stays out
 * of history. thinking / redacted_thinking pass through (see module
 * header): structural errors do not enter validation here (returned
 * as-is, replay still carries valid signatures).
 *
 * Module-level export shared by createAnthropicAdapter (offline) and
 * createRealAnthropicAdapter (real SDK) so both interpret through one SSOT.
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
      // Foundation does not interpret thinking / redacted_thinking (they
      // never enter texts/toolCalls); nativeContent keeps all fields
      // verbatim (signature / data) so the authoritative history is replayable.
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
      // Keep all fields verbatim in the authoritative history: signature
      // must round-trip (trimming breaks replay); thinking text never
      // enters texts. normalizeThinkingSignature covers the
      // missing-signature case from non-Anthropic vendors — see its doc
      // for why filling "" stays replay-safe.
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
      // data kept verbatim (encrypted blob: neither interpretable nor
      // trimmable).
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
    // ADR-0008: usage absent = Postel semantics — when the SDK returns no
    // usage, the key does not exist at all (not a null placeholder, not an
    // undefined wrapper).
    ...(usage !== undefined ? { usage } : {}),
  };
}

export interface AnthropicAdapter extends ModelAdapter {
  readonly encodeUserText: (userText: string) => AnthropicNativeMessage;
  /**
   * Which call mode this adapter instance actually takes: true = stream
   * arm (`client.messages.stream`), false/undefined = non-stream arm
   * (`messages.create`). loop-engine's `recordLlmCall` uses it to set the
   * trace `stream` boolean; never read back, never affects control flow
   * (arm routing inside the adapter remains ground truth — this only
   * declares it).
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
 * Encode user text as a native Anthropic user message (single text block).
 * Module-level export shared by both adapter factories (SSOT).
 */
export function encodeUserText(userText: string): AnthropicNativeMessage {
  return {
    role: "user",
    content: [{ type: "text", text: userText }],
  };
}

/**
 * Encode tool execution results as native Anthropic tool_result content
 * blocks. Module-level export shared by both adapter factories (SSOT).
 *
 * When an execution_failed result carries partial stdout/stderr, append
 * the corresponding `[partial stdout]` / `[partial stderr]` text blocks
 * after the error-text block so the model sees what was already written
 * before cancellation / timeout (the strict-equal text-driven stopReason
 * contract is unchanged).
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
    // partial is an additive field; only append on execution_failed and only
    // when stdout/stderr actually has content (skip empty strings to avoid noise).
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
 * Build the offline Anthropic adapter: no real model, consumes only the
 * responses array.
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
    // The offline scripted implementation does not consume signal/timeout;
    // the signature is in place so a later real-SDK wiring can bind it to
    // client/fetch with zero signature change. Stream-interrupted fixture:
    // with streamEvents provided and streamInterrupt=true, simulate a
    // mid-stream break — throw ProtocolError, the turn is not submitted.
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
 * Options for the real Anthropic adapter.
 *
 * Deliberately disjoint from the offline AnthropicAdapterOptions (which
 * requires scripted responses): the real adapter depends on an externally
 * injected Anthropic client (dependency injection) and never runs
 * `new Anthropic` inside the factory.
 */
export interface RealAnthropicAdapterOptions {
  /** Injected Anthropic SDK client (default baseURL or a 9router gateway both fine). */
  readonly client: Anthropic;
  /** Model id, e.g. "claude-3-5-sonnet-20241022". */
  readonly model: string;
  /** SDK max_tokens (must be > 0). */
  readonly maxTokens: number;
  /** Sampling temperature (0.0–1.0). Omitted → SDK default. */
  readonly temperature?: number;
  /**
   * Request-side thinking control arm.
   *   - mode="off"      → send no thinking / output_config (default)
   *   - mode="adaptive" → send thinking:{type:'adaptive'}; when effort is
   *     non-empty also append output_config:{effort}
   * temperature is orthogonal to thinking: the on/off flag never changes
   * whether temperature is sent.
   */
  readonly thinking?: {
    readonly mode: "off" | "adaptive";
    readonly effort?: "" | "low" | "medium" | "high" | "xhigh" | "max";
  };
  /**
   * Stream-arm switch. true → `client.messages.stream(params, { signal })`
   * → `finalMessage()` → existing `interpretMessage` (SSOT, zero changes) →
   * `AssistantTurnResult` byte-identical in shape to the non-stream arm;
   * false/undefined → the existing `client.messages.create` arm (frozen
   * fallback behavior, zero change).
   *
   * The signal hangs directly on the SDK RequestOptions second parameter,
   * inheriting cancel/timeout semantics unchanged. Production wiring (env
   * `IKNOW_LLM_STREAM`, default on) passes this in at the call site.
   */
  readonly stream?: boolean;
}

/**
 * Map harness ToolDef[] to SDK Tool[].
 *
 * - `inputSchema` (camelCase) → `input_schema` (snake_case)
 * - empty array / non-array → undefined, so the SDK never receives `tools: []`
 * - SDK `Tool.InputSchema` is a strict shape (requires `type: "object"`)
 *   while harness ToolDef.inputSchema is `Record<string, unknown>`; the
 *   `as unknown as SdkTool` assertion is deliberate — at runtime the SDK
 *   sends the wire shape as-is, and real schema validation is the model's job.
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
 * Stream arm:
 *   - SDK `client.messages.stream(params, { signal })`; the signal rides
 *     the RequestOptions second parameter, attached directly to the
 *     raceModel composite signal (cancel/timeout semantics inherited
 *     unchanged).
 *   - `wireStreamEvents` installs observer listeners (text → text_delta;
 *     content_block_start tool_use → tool_call_start); every emit is
 *     wrapped in try/catch swallowing observer errors, matching the
 *     `safeTrace` MUST-NOT-throw precedent.
 *   - Terminal state: `await stream.finalMessage()` → existing
 *     `interpretMessage` SSOT, zero changes → `AssistantTurnResult`
 *     byte-identical in shape to the non-stream arm.
 *   - Broken stream (`finalMessage()` reject, e.g. connection drop / no
 *     chunks / silent EOF / abort) → step reject, and **no
 *     `AssistantTurnResult` is constructed** (the whole turn is not
 *     submitted); the partial snapshot in `stream.currentMessage` is not
 *     consumed in v1 (Postel's Law).
 *   - Request body is byte-identical to the non-stream arm; both share
 *     `buildMessageParams` for validation.
 */
/**
 * Translate SDK 400 prompt-too-long into PromptTooLongError (extends
 * ProtocolError, so loop-engine's instanceof ProtocolError branch still
 * catches it — the entry point for reactive compact). All other errors
 * (other 400s / non-400 / non-APIError) rethrow unchanged, keeping
 * raceModel's existing catch routing intact. Shared by both the stream and
 * non-stream arms to avoid duplicated predicates.
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
 * ADR-0111: shape predicate for the SDK's bare "stream ended but produced
 * no Message" Error. The SDK exposes no typed class to instanceof, so match
 * on message shape — all three conditions required:
 *   1. `/stream ended without producing a Message/i` (a sentinel test pins
 *      the shape to the SDK version; a shape change on upgrade goes RED for
 *      manual review);
 *   2. not an APIError — real HTTP semantic errors must not be shadowed;
 *   3. no network error in the cause chain — a genuine disconnect belongs
 *      to the retryable `llm_network` cell; no double-labeling (predicate
 *      reuses the single-point `someCause` / `isConnectionFault`).
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
 * thinkingMs measurement closure + ADR-0111 visible-delta flag, declared in
 * one place — stepStreamArm and wireStreamEvents share this shape so the
 * two sites cannot drift apart. `sawVisibleDelta` = this attempt has seen a
 * non-empty visible delta (text / thinking / input_json); set at the same
 * site as the timing marks, never on empty deltas; carried as `visible`
 * when a broken stream translates to ModelStreamIncompleteError.
 */
type StreamMeasurement = {
  start?: number;
  end?: number;
  sawVisibleDelta?: boolean;
};

/**
 * An aborted signal must end the step promise: a hung stream body (open
 * connection, no chunk, no end event) never settles `finalMessage()`, so
 * without this race the engine's idle / hard-cap clock abort would only
 * settle its own outcome while the attempt dangles past the clock (the
 * 698s/0-token hang shape). The rejection is the SDK-native
 * `APIUserAbortError` — the translate layer reads the `clock_abort` marker
 * on the signal first (clock_timeout / timeout), and an unmarked abort
 * classifies as user_cancel; never `stream_incomplete`, which stays
 * reserved for a stream that ended on its own without a Message (ADR-0111).
 */
function settleOnAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined
): Promise<T> {
  if (signal === undefined) return promise;
  if (signal.aborted) {
    // The real SDK rejects finalMessage() once its signal is aborted, so the
    // discarded promise here already carries (or will soon carry) a rejection.
    // Without a handler attached here the race outcome is dropped and Node
    // reports an orphaned unhandled rejection — the entry branch must
    // silence it before rejecting its own APIUserAbortError.
    void promise.catch(() => {});
    return Promise.reject(new APIUserAbortError());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new APIUserAbortError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      }
    );
  });
}

async function stepStreamArm(deps: {
  readonly client: Anthropic;
  readonly params: MessageCreateParamsNonStreaming;
  readonly signal?: AbortSignal;
  readonly onStream?: (event: HarnessStreamEvent) => void;
}): Promise<AssistantTurnResult> {
  const stream = deps.client.messages.stream(deps.params, {
    signal: deps.signal,
  });
  // thinkingMs measurement closure — hooked in when wireStreamEvents
  // installs listeners: first thinking_delta records the start, the first
  // non-thinking delta (text_delta / input_json_delta / tool_call_start)
  // records the end. Installed even when `onStream` is absent (measure
  // only, zero emits) — measurement and emission fully decouple so the
  // host observer contract stays clean. Once `end` is recorded it is never
  // overwritten (only the first non-thinking point counts).
  // sawVisibleDelta semantics: see the StreamMeasurement doc (ADR-0111).
  const measurement: StreamMeasurement = {};
  wireStreamEvents(stream, deps.onStream, measurement);
  // Broken stream / abort → finalMessage() reject → no AssistantTurnResult
  // is constructed. The abort race (see `settleOnAbort`) guarantees a hung
  // stream body cannot keep this promise pending past the caller's abort.
  try {
    const final = await settleOnAbort(stream.finalMessage(), deps.signal);
    const result = interpretMessage(final);
    // Derive thinkingMs. `start` absent (no thinking_delta) → not produced.
    // `end` absent (thinking only, no follow-up) → not produced (both ends
    // must be marked). Boundary shape pinned: diff <= 0 or non-finite →
    // field absent (the store's persistence entry filters once more; never
    // persist 0 / NaN / Infinity).
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
    // Content already emitted by wireStreamEvents is unaffected — the
    // whole-turn-not-submitted semantics come from step rejecting without
    // constructing AssistantTurnResult; translation only changes the
    // exception class. ADR-0111: SDK broken-stream shape →
    // ModelStreamIncompleteError (visible read from measurement). Its
    // predicate is mutually exclusive with prompt-too-long (requires
    // non-APIError), so the ordering between the two is not behavioral.
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
 * Emit wiring: SDK-native SSE events (`on("text")` / `on("streamEvent")`)
 * never cross the adapter boundary — they are translated into the harness
 * stream-event contract (`HarnessStreamEvent`). Every emit is wrapped in
 * try/catch swallowing errors: an observer failure must not flow back into
 * the stream arm's terminal state.
 *
 * empty-class decision: when `text_delta` is an empty string (text=""), do
 * **not** emit — an empty delta carries no rendering information; skipping
 * removes host rendering noise. The design offered "don't emit" vs "emit
 * side-effect-free" (implementation picks one); this code chose the former,
 * locked in `anthropic-adapter-stream.test.ts`.
 *
 * `content_block_delta` payloads carry only `index`, no block id (SDK
 * `RawContentBlockDeltaEvent`), while the `tool_input_delta` contract needs
 * an id for the host to pair with tool_call_start / postToolUse — so
 * `index → block.id` is registered at `content_block_start tool_use` and
 * looked up when deltas arrive.
 */
function wireStreamEvents(
  stream: AnthropicMessageStream,
  onStream: ((event: HarnessStreamEvent) => void) | undefined,
  /** thinkingMs measurement closure. Installed even when `onStream` is
   *  absent (measure only, zero emits) — measurement and emission fully
   *  decouple.
   *  - first thinking_delta → `start` = `performance.now()`
   *  - first non-thinking delta (text_delta / input_json_delta /
   *    tool_call_start) → `end` = `performance.now()`
   *  Only the first point per end is recorded; with both ends present,
   *  stepStreamArm computes elapsed, and if the boundary shape is legal
   *  (> 0 and finite) attaches `thinkingMs`, otherwise the field is absent.
   *  - `sawVisibleDelta` semantics: see the StreamMeasurement doc (ADR-0111). */
  measurement?: StreamMeasurement
): void {
  // Whether measurement is present decides whether listeners install at
  // all. `onStream` and measurement are independent dimensions —
  // measurement present + onStream absent = silent measurement: hosts with
  // zero observers can still produce thinkingMs.
  if (onStream === undefined && measurement === undefined) return;
  const safeEmit = (event: HarnessStreamEvent): void =>
    safeEmitStream(onStream, event);
  // Timing helpers — call performance.now() only when measurement is
  // present and the end point is not yet recorded. Never mark on the
  // text-delta empty-skip path: an empty string carries no information and
  // must not be mistaken for the first non-thinking delta (phase switch).
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
  // ADR-0111: visible-delta flagging — same site as the timing marks,
  // called only on **non-empty** deltas (aligned with the empty-delta
  // discipline); the broken-stream translation to
  // ModelStreamIncompleteError reads `visible` from here.
  const markVisible = (): void => {
    if (measurement !== undefined) {
      measurement.sawVisibleDelta = true;
    }
  };
  // Register content_block_start index → block.id so content_block_delta
  // (input_json_delta) can pair; naturally cleaned when the function
  // returns (one assembly per turn).
  const indexToBlockId = new Map<number, string>();
  stream.on("text", (textDelta) => {
    if (textDelta === "") return; // empty delta: do not emit (empty-class decision above)
    markEnd(); // text_delta counts as the first non-thinking delta → record end
    markVisible(); // ADR-0111 — non-empty text delta = visible output
    safeEmit({ type: "text_delta", text: textDelta });
  });
  stream.on("streamEvent", (event: MessageStreamEvent) => {
    // thinking_delta passes through the content_block_delta path (a
    // thinking-block-only delta, never confused with text_delta — the SDK
    // short-circuits text blocks via `on("text")`; thinking blocks only
    // reach content_block_delta).
    if (event.type === "content_block_delta") {
      const delta = (
        event as {
          index?: number;
          delta?: { type?: string; thinking?: string; partial_json?: string };
        }
      ).delta;
      if (delta?.type === "thinking_delta") {
        const text = delta.thinking ?? "";
        if (text === "") return; // empty delta: do not emit — aligned with text_delta discipline
        markStart(); // first thinking_delta records start
        markVisible(); // ADR-0111 — non-empty thinking delta = visible output
        safeEmit({ type: "thinking_delta", text });
        return;
      }
      // tool-input delta passthrough — deltas serve only the display layer;
      // authoritative input still arrives once via finalMessage() →
      // interpretMessage (zero changes).
      if (delta?.type === "input_json_delta") {
        const partialJson = delta.partial_json ?? "";
        if (partialJson === "") return; // empty delta: do not emit — aligned with text_delta discipline
        markEnd(); // input_json_delta counts as the first non-thinking delta → record end
        markVisible(); // ADR-0111 — non-empty tool-input delta = visible output
        const id = indexToBlockId.get(event.index);
        // Unregistered id or empty-string id → nothing to pair with → do
        // not emit (empty string = legacy fallback for a missing tool_use
        // block.id; cannot pair with tool_call_start / postToolUse).
        if (id === undefined || id === "") return;
        safeEmit({ type: "tool_input_delta", id, partialJson });
        return;
      }
      return;
    }
    if (event.type !== "content_block_start") return;
    const block = event.content_block;
    // Minimal set: only tool_use translates to tool_call_start;
    // server_tool_use and other content blocks are out of v1 scope
    // (interpretMessage throws ProtocolError on unsupported types anyway).
    if (block.type !== "tool_use") return;
    // tool_call_start also counts as the first non-thinking delta → record
    // end (when tool_use follows thinking immediately, content_block_start
    // arrives before input_json_delta).
    markEnd();
    // Register index → block.id for input_json_delta pairing.
    const id = typeof block.id === "string" ? block.id : "";
    indexToBlockId.set(event.index, id);
    // tool_use block.id passes through so the host can pair it with
    // postToolUse completion events (live-status display depends on this);
    // on missing id, fall back to empty string (backward compat with legacy).
    safeEmit({
      type: "tool_call_start",
      name: block.name,
      id,
    });
  });
}

/**
 * Request-body constructor **shared** by the stream and non-stream arms —
 * message history + tools + thinking + temperature are attached with
 * identical conditional logic, byte-for-byte (history fields must not vary
 * between arms, keeping the KV cache prefix stable). No `stream: true`
 * here; the SDK's `.stream()` appends it internally.
 */
export function buildMessageParams(
  opts: RealAnthropicAdapterOptions,
  state: LoopState,
  request: { tools?: unknown; system?: string }
): MessageCreateParamsNonStreaming {
  const tools = toSdkTools(request.tools);
  // Request-side thinking control arm. SDK 0.115.0 declares
  // thinking?: ThinkingConfigParam and output_config?: OutputConfig on
  // MessageCreateParamsBase; attached conditionally here — off/absent
  // config → neither field appears (default zero behavior change).
  const thinkingParam =
    opts.thinking?.mode === "adaptive"
      ? { type: "adaptive" as const }
      : undefined;
  const effort = opts.thinking?.effort;
  return {
    model: opts.model,
    max_tokens: opts.maxTokens,
    // ADR-0112: messages go through the outbound projection (pure function)
    // instead of passing directly — system-role filtering (system messages
    // must never reach the wire), host provenance stamps stripped (stamps
    // are not model-visible), and stamp-free / tool_result text
    // deterministically reworded (untrusted text must not reproduce host
    // syntax). The projection throws typed errors → this hop aborts before
    // touching the SDK.
    messages: projectMessagesForWire(
      state.messages
    ) as unknown as MessageParam[],
    ...(tools !== undefined ? { tools } : {}),
    // Conditional `system` attachment — undefined or empty string → field
    // omitted (byte-identical prior behavior + KV cache prefix stable at
    // byte level, same filtering discipline used elsewhere).
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
 * A declared-`void` observer may still be async; a returned thenable needs an
 * explicit handler so its rejection cannot surface as an unhandled rejection.
 */
function isPromiseLike(value: unknown): value is Promise<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { catch?: unknown }).catch === "function"
  );
}

/**
 * Report the exact request object this invocation will dispatch.
 *
 * The single source is `params` — the post-projection object handed to the SDK
 * — because pre-projection engine state is not an oracle for the final request.
 * Called once per attempt (transport retry re-enters `step`, so a retry is a
 * second invocation with its own id), and before the arm branch so a rejected
 * `create` or a broken stream still leaves its evidence behind.
 *
 * Best-effort by contract: observer failures are swallowed so evidence can
 * never fail, retry, or re-dispatch a model call (same MUST-NOT-throw rule as
 * `safeEmitStream`). Credentials and transport headers are not part of the
 * evidence, and emission claims no provider receipt.
 */
function emitDispatchEvidence(
  params: MessageCreateParamsNonStreaming,
  onDispatch: ((evidence: SdkDispatchEvidence) => void) | undefined,
  stream: boolean
): void {
  if (onDispatch === undefined) return;
  // The SDK type also admits a text-block array for `system`; the request body
  // built here only ever carries the assembled string.
  const system = typeof params.system === "string" ? params.system : undefined;
  const evidence: SdkDispatchEvidence = {
    invocationId: randomUUID(),
    stream,
    messages: params.messages,
    ...(system !== undefined ? { system } : {}),
    ...(params.tools !== undefined ? { tools: params.tools } : {}),
  };
  try {
    const returned: unknown = onDispatch(evidence);
    if (isPromiseLike(returned)) void returned.catch(() => {});
  } catch {
    // Swallow observer faults: evidence failure must not back-flow into the
    // dispatch path.
  }
}

/**
 * Real Anthropic adapter factory.
 *
 * step delegates to `client.messages.create(params, { signal })`; the
 * signal rides the SDK's second-parameter RequestOptions (not in the
 * MessageCreateParamsBase body).
 *
 * Responses are projected through the same `interpretMessage` logic (SSOT)
 * into AssistantTurnResult. SDK errors (APIError / AbortError etc.) are
 * not caught here — raceModel's existing catch routing handles them:
 *   signal.aborted → "cancelled"; MODEL_TIMEOUT → "timeout";
 *   ProtocolError → "protocolError"; anything else → rethrow (`run()` rejects).
 * Known gap: a real HTTP request may not cancel on engine timeout (socket-
 * level teardown is still the SDK's); the step promise itself now always
 * lands on abort (stream arm: `settleOnAbort`).
 *
 * Contract: `step` routes between two arms by `opts.stream` (non-stream:
 * `client.messages.create`; stream: `client.messages.stream` +
 * `finalMessage()` → `interpretMessage`); both deliver the same
 * `AssistantTurnResult` (SSOT). No SdkMessage queue is built; no retries,
 * no telemetry collection.
 */
export function createRealAnthropicAdapter(
  opts: RealAnthropicAdapterOptions
): AnthropicAdapter {
  async function step(
    state: LoopState,
    request: {
      tools?: unknown;
      // request.system flows from LoopAdapter.step through to SDK params.
      system?: string;
      onStream?: (event: HarnessStreamEvent) => void;
      onDispatch?: (evidence: SdkDispatchEvidence) => void;
    },
    signal?: AbortSignal
  ): Promise<AssistantTurnResult> {
    const params = buildMessageParams(opts, state, request);
    // Evidence first, then the arm branch: the record of what was attempted
    // must exist even when the attempt fails.
    emitDispatchEvidence(params, request.onDispatch, opts.stream === true);
    // Stream / non-stream routing: all branch logic of the step body lives
    // here; business behavior is carried by `stepStreamArm` and the
    // existing create arm respectively.
    if (opts.stream !== true) {
      // Non-stream arm (byte-identical prior behavior when `stream` is off).
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
   * ADR-0043: measured token count — passes through to SDK
   * `client.messages.countTokens({ messages, model, system?, tools? })`
   * and reads only `input_tokens` (the SDK's `MessageTokensCount` carries
   * just this field).
   *
   * Contract (aligned with types.ts CountTokensInput):
   *   - `input.tools` = current visibleSchemas() (same source as step request.tools)
   *   - `input.system` = assembly-time system text (same source as step request.system)
   *   - `input.messages` = current message history (an empty list is rejected
   *     by Anthropic-compatible gateways, so a caller measuring a first-request
   *     surface supplies a stand-in; the adapter projects what it is given)
   *   - messages must be system-role filtered (same invariant as
   *     `buildMessageParams`: system messages never reach the wire)
   *
   * Failure path: any SDK error (APIError / AbortError / non-200) rethrows
   * as-is; the assembly layer catches and skips this session (see skip
   * semantics in `tool-overflow.ts`).
   */
  async function countTokens(input: {
    tools?: ReadonlyArray<unknown>;
    system?: string;
    messages?: ReadonlyArray<AnthropicNativeMessage>;
  }): Promise<{ inputTokens: number }> {
    // ADR-0112: the token count must align with the wire — consume the same
    // outbound projection as `buildMessageParams` (system-role filtering,
    // stamp stripping, untrusted rewording — same seam, same rules). If the
    // projection throws typed errors the SDK is never called; the assembly
    // layer catches → skip this session (tool-overflow skip semantics
    // unchanged).
    const messagesParam: MessageParam[] = input.messages
      ? (projectMessagesForWire(input.messages) as unknown as MessageParam[])
      : [];
    const toolsParam = toSdkTools(input.tools);
    // SDK 0.115 `MessageCountTokensParams`: model + messages required;
    // system / tools attached conditionally, empty/absent values omitted.
    const resp = await opts.client.messages.countTokens({
      model: opts.model,
      messages: messagesParam,
      ...(toolsParam !== undefined ? { tools: toolsParam } : {}),
      ...(input.system !== undefined && input.system !== ""
        ? { system: input.system }
        : {}),
    });
    // SDK response `MessageTokensCount`: only `input_tokens: number`.
    // Missing / empty treated as 0 — `runOverflowJudge` in the assembly
    // layer guards again (non-finite / negative → skip semantics).
    const n = (resp as { input_tokens?: unknown }).input_tokens;
    return { inputTokens: typeof n === "number" ? n : 0 };
  }
  return Object.freeze({
    step,
    countTokens,
    encodeUserText,
    encodeToolResults,
    // Adapter-level mode declaration (stream is a static construction-time
    // decision; never switches within an instance).
    streamMode: opts.stream === true,
  });
}

/**
 * Thinking request-parameter construction factory.
 *
 * Input shape mirrors LlmEnv.thinking / LlmEnv.thinkingEffort (the env SSOT
 * output) without binding the LlmEnv type itself (avoids a reverse
 * dependency from anthropic-adapter onto src/config/). Callers pass env.llm
 * or any object carrying thinking / thinkingEffort fields.
 *
 * Mode and effort raw values pass through as given; the conditional
 * attachment of SDK thinkingParam / output_config still lives inside
 * createRealAnthropicAdapter.step. This function only kills the copy-paste
 * of literal plumbing between the runtime and hub call sites.
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
 * Vendor-side translation of thrown errors into transient HTTP / network vs
 * PromptTooLong vs other FaultEvents. The retry loop lives in
 * withTransportRetry, not in this file.
 *
 * **A clock abort must never translate to `user_cancel`.** The predicate
 * can only read the `clock_abort` marker on `signal.reason` — the SDK's
 * `APIUserAbortError` does not forward `signal.reason` (neither does
 * fetch), and does not even change `.name` (stays `"Error"`), so viewed
 * alone it is indistinguishable from a host Ctrl+C.
 *
 * When the marker is present, branch on `visible`: not visible →
 * `clock_timeout` (retryable); visible → `timeout` (output already on
 * screen, no retry, falls into the existing non-retryable class).
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

/** Cause-chain depth bound: the SDK wraps a fetch failure one layer deep; the native TLS / socket error sits below that. */
const CAUSE_CHAIN_MAX_DEPTH = 5;

/**
 * Non-clock branch: vendor-side thrown error → FaultEvent.
 *
 * The discrimination order is part of the contract:
 *   1. `prompt_too_long` — over-limit input is already decided; resending
 *      the same prompt just over-limits again;
 *   2. `stream_incomplete` — ADR-0111: direct instanceof of
 *      `ModelStreamIncompleteError` (it extends `ProtocolError`; falling
 *      through to later branches would be flattened by the default into
 *      `protocol_error` and lose the visible retry predicate), before any
 *      shape guessing;
 *   3. abort — `APIUserAbortError extends APIError<T, T, T>` with
 *      `status === undefined`; letting it reach the HTTP branch would turn
 *      host Ctrl+C into a fake `llm_http: 0` status (typed-error contract
 *      corollary: never disguise a non-HTTP fault as HTTP status 0);
 *   4. `llm_http` — **only real HTTP responses with a numeric status**;
 *   5. cert / TLS validation failures — deterministic failures, explicitly
 *      `protocol_error`; must not masquerade as retryable `llm_network`;
 *   6. `llm_network` — connection-class faults (including native network
 *      errors inside SDK-class `cause` chains), retryable class.
 *
 * Steps 5 / 6 both sit after the HTTP branch: `APIConnectionError` /
 * `APIConnectionTimeoutError` also extend `APIError` with
 * `status === undefined`; if the HTTP branch caught them first they would
 * translate to `llm_http: 0` (classifyFault → none), making the network
 * retry cell unreachable — hence the HTTP branch gates on a numeric
 * `status` and yields them to the connection branches. Conversely, real
 * HTTP semantics win: a deterministic 4xx does not become retryable just
 * because a connection error hangs in its `cause`.
 *
 * The default branch leaves only genuinely unknown shapes (ADR-0111): emit
 * one console.warn diagnostic before returning (name + message truncated
 * to ≤200 chars; no stack / request body); classification stays
 * `protocol_error` — no more silent flattening, so an SDK upgrade changing
 * shapes produces a signal in the field.
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
    // 429 / 5xx `retry-after` becomes milliseconds at this layer;
    // backoff policy stays in withTransportRetry — this layer only fills
    // the FaultEvent shape.
    return {
      kind: "llm_http",
      status: err.status,
      ...withRetryAfter(err.headers),
    };
  }
  if (someCause(err, isCertFailure)) return { kind: "protocol_error" };
  if (someCause(err, isConnectionFault)) return { kind: "llm_network" };
  // ADR-0111: the default branch now covers only genuinely unknown shapes —
  // one diagnostic instead of silent flattening (name + message truncated
  // to ≤200 chars, no stack / request body); classification unchanged.
  // Worker stdout is the envelope-protocol surface, so the warn goes to
  // stderr and never pollutes it (ADR-0111).
  const name = err instanceof Error ? err.name : typeof err;
  console.warn(
    `[anthropic-adapter] unclassified model fault: ${name}: ${errorMessage(
      err
    ).slice(0, 200)}`
  );
  return { kind: "protocol_error" };
}

/**
 * Whether any layer of the `cause` chain (including self) satisfies
 * `predicate`. Depth-bounded, stops on self-loops: the SDK's
 * `APIConnectionError.cause` is a `TypeError("fetch failed")` and the real
 * predicate (socket error code / cert error) lives one layer below —
 * looking only at the outermost layer is like seeing nothing.
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

/** Cert / TLS validation failures: code (e.g. `DEPTH_ZERO_SELF_SIGNED_CERT` class) or message text. */
const CERT_FAILURE_CODE = /CERT|_SSL_/i;
const CERT_FAILURE_MESSAGE = /certificate|self[-_ ]signed|\bTLS\b|\bSSL\b/i;

function isCertFailure(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code: unknown = (err as { readonly code?: unknown }).code;
  if (typeof code === "string" && CERT_FAILURE_CODE.test(code)) return true;
  return CERT_FAILURE_MESSAGE.test(err.message);
}

/** Connection-class fault (single-layer predicate; chain traversal is `someCause`'s job). */
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

/** `retry-after` header → `retryAfterMs` field; absent / malformed → field omitted. */
function withRetryAfter(headers: Headers | undefined): {
  readonly retryAfterMs?: number;
} {
  const retryAfterMs = parseRetryAfterMs(headers?.get("retry-after"));
  return retryAfterMs !== undefined ? { retryAfterMs } : {};
}

/** Bare DOMException / Error-shaped abort (offline stand-ins and existing tests' AbortError). */
function isAbortErrorShape(err: unknown): boolean {
  if (typeof DOMException !== "undefined" && err instanceof DOMException) {
    return err.name === "AbortError";
  }
  return err instanceof Error && err.name === "AbortError";
}
