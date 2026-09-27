/**
 * Shared tool types: the boundary shapes between Tool / Registry / Executor.
 *   - A Tool owns the model-visible name, description, input JSON Schema and
 *     the real call entry;
 *   - the Registry holds the full registration set, validates at construction
 *     and locates by name; it knows nothing about the Loop;
 *   - the Executor carries call identity + raw input, locates, strictly
 *     validates, invokes, and returns an identity-matched ToolExecutionResult.
 *
 * Error types stay minimal here: distinguishable, actionable by the model,
 * losslessly encodable, and non-leaking by default, without premature fixation.
 */

import type {
  AnthropicContentBlock,
  AnthropicNativeMessage,
} from "../model-adapter/types.js";
import type { HarnessStreamEvent } from "../stream.js";
import type { ThinkingParams } from "../model-adapter/anthropic-adapter.js";

/**
 * Runtime entry signature: takes strictly validated input, returns a
 * model-facing payload.
 *
 * On success the payload is already field-selected / ordered / truncated and
 * JSON-compatible: a string or structured JSON value. No undefined / BigInt /
 * cyclic objects / Map / Date / class instances.
 */
export type ToolHandler = (
  input: unknown,
  ctx?: ToolExecutionContext // optional; legacy (input) => ... handlers stay legal
) => Promise<unknown> | unknown;

/** Execution context the Executor passes through to the handler: signal +
 *  conversation/turn attribution + stream observer. timeoutMs is not here —
 *  the Executor wraps Promise.race itself. conversationId feeds bash
 *  background scope filtering (ADR-0021); absent = no filter. */
export interface ToolExecutionContext {
  readonly signal?: AbortSignal;
  readonly conversationId?: string;
  /**
   * Trace turn id owning this call. conversationId answers "which session"
   * (fixed at assembly); turnId answers "which turn" (refreshed per turn), so
   * it can only travel through executeAll. Consumer: spawn_subagent writes it
   * into def.parentTurnId → the child's three record kinds. Absent = no
   * owning turn (worker / ask / direct handler calls); downstream omits the key.
   */
  readonly turnId?: string;
  /**
   * Host stream observer for this turn (graph progress etc.). `run_graph`
   * pushes `graph_progress` via safeEmitStream; absent = no events.
   */
  readonly onStream?: (event: HarnessStreamEvent) => void;
  /**
   * Anthropic tool_use_id of this tool_call (the model-side wire id), from
   * call.id (ADR-0071). spawn_subagent writes it into def.toolUseId and the
   * manager copies it into `.meta.json` to back-reference the parent loop's
   * call. Absent → key omitted; direct-handler / test paths stay compatible.
   */
  readonly toolUseId?: string;
  /**
   * Read-only snapshot of this turn's model-visible history. skill() uses it
   * to decide whether a name's full body is still visible (second
   * short-circuit). Snapshot absent (slash / direct handler / unsewn paths) →
   * consumers fail closed.
   */
  readonly messages?: ReadonlyArray<AnthropicNativeMessage>;
  /** Effective parent thinking snapshot for subagent spawn and continuation. */
  readonly parentThinking?: ThinkingParams;
}

/**
 * Tool descriptor: model-visible name + JSON Schema + real call entry.
 * Enforced: the schema advertised to the model and the Executor's validation
 * schema are the same authoritative object — never maintained separately.
 */
export interface ToolDef {
  readonly name: string;
  readonly description: string;
  /** JSON Schema, same-source as Executor validation. */
  readonly inputSchema: Record<string, unknown>;
  readonly handler: ToolHandler;
  /**
   * Static assembly-time declaration (ADR-0083): this tool's output skips the
   * Executor's fallback output cap; delivered as-is with no truncation marker.
   *
   * Rationale: the cap (ADR-0006) presumes output is a re-derivable query; a
   * skill body is one assembly product (single source, whole semantics) — no
   * "retry with a more precise input" recovery path exists, and a half skill
   * is more dangerous than none.
   *
   * Boundary: the flag lives on the ToolDef set by the tool factory, not on
   * any single output, and is not a truncation-metadata claim — the executor
   * remains the sole authority on truncation metadata. MCP conversion paths
   * never set it (tools cannot self-grant).
   */
  readonly exemptFromOutputCap?: boolean;
}

/** Registry public interface: construction-time validation, immutable, locate by name. */
export interface Registry {
  readonly list: () => ReadonlyArray<ToolDef>;
  readonly get: (name: string) => ToolDef | undefined;
}

/** Tool call identity + input: projected from the Model Adapter, consumed by the Executor. */
export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}

/**
 * Tool execution result: the deterministic receipt of one call.
 *
 * Carries call identity, success payload or failure label. Failure labels are
 * structured at the field level, distinguishing business-visible failures
 * (exposable to the model) from unknown errors (sanitized to generic failure).
 *
 * No Anthropic-native encoding here; the Model Adapter encodes tool_result.
 */
/**
 * Optional side-channel of the ok variant: carries diff old/new content for
 * the host without touching the model-visible payload. Present only when
 * non-empty; additive. Bash display fields stdout / stderr follow the same
 * rule — observation bypass only, never into the model's tool_result; the
 * executor shape guard checks field types (string) only, and further host-use
 * fields must join through the same SSOT discipline.
 */
export interface ToolResultMeta {
  readonly oldContent?: string;
  readonly newContent?: string;
  readonly stdout?: string;
  readonly stderr?: string;
}

/**
 * Structured envelope a handler may return: `{ output: string, meta?:
 * ToolResultMeta }`. The Executor takes only `output` into the model-facing
 * tool_result; `meta` rides the observation side-channel.
 *
 * Single authoritative shape: the executor's type guard and extractor share
 * this interface, ending duplicated shape-checks.
 */
export interface ToolOutputEnvelope {
  readonly output: string;
  readonly meta?: ToolResultMeta;
}

export type ToolExecutionResult =
  | {
      readonly kind: "ok";
      readonly toolUseId: string;
      readonly payload: AnthropicContentBlock[];
      /** Optional typed envelope: host-side diff old/new; invisible to the model. */
      readonly meta?: ToolResultMeta;
    }
  | {
      readonly kind: "validation_failed";
      readonly toolUseId: string;
      /** Human-readable safe error summary (exposable to the model). */
      readonly message: string;
    }
  | {
      readonly kind: "tool_not_found";
      readonly toolUseId: string;
      readonly toolName: string;
    }
  | {
      readonly kind: "execution_failed";
      readonly toolUseId: string;
      /** Sanitized safe error summary (exposable to the model). */
      readonly message: string;
      /**
       * Partial stdout/stderr from a handler that produced output before
       * being cancelled/timed out, so the model sees what exists already.
       * Present only when output actually happened; additive — loop-engine
       * still decides stopReason by strict `message` equality.
       */
      readonly partial?: { readonly stdout?: string; readonly stderr?: string };
      /**
       * The caller already got "cancelled" but the handler ignored the signal
       * and is still running. Only set when the ACI detaches that handler;
       * clean cancellations omit the field.
       */
      readonly background?: true;
    };

/** Executor interface: takes ordered valid tool-call projections, returns identity-matched results. */
export interface Executor {
  /**
   * Execute a sequence of calls. The base executor is serial; the ACI
   * scheduling layer may overlap isConcurrencySafe batches. No
   * short-circuit, no auto-retry. onSettled fires per result in input order;
   * omitted = never called.
   */
  readonly executeAll: (
    calls: ReadonlyArray<ToolCall>,
    signal?: AbortSignal, // forwarded to ctx.signal
    timeoutMs?: number, // per-handler Promise.race timeout; undefined = no race
    conversationId?: string, // forwarded to ctx.conversationId; absent = no filter
    /** Each result as it settles (index = input order). Optional. */
    onSettled?: (
      result: ToolExecutionResult,
      index: number
    ) => void | Promise<void>,
    turnId?: string, // forwarded to ctx.turnId; absent = no owning turn
    onStream?: (event: HarnessStreamEvent) => void, // in-tool emits (graph progress etc.)
    /** Read-only model-visible history snapshot for this turn; absent → handler fails closed. */
    messages?: ReadonlyArray<AnthropicNativeMessage>,
    /** Effective parent thinking snapshot; optional for legacy executeAll callers. */
    parentThinking?: ThinkingParams
  ) => Promise<ReadonlyArray<ToolExecutionResult>>;
}
