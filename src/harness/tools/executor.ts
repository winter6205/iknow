/**
 * Tool executor.
 *
 * Boundaries:
 *   - Takes ordered valid tool-call projections (id + name + raw input);
 *   - serial execution (no parallelism, short-circuit, or auto-retry);
 *   - validation reuses the Registry's pre-compiled validator
 *     (`registry.getValidator`) — same schema as construction, never recompiled;
 *   - validation failure / missing tool / runtime exception all converge to a
 *     structured ToolExecutionResult instead of throwing (so the Assistant
 *     turn cannot pollute the authoritative history);
 *   - handler returns are normalized into model-facing payload (string or
 *     JSON-compatible value); unknown errors are sanitized to a generic
 *     failure — never stack / internal paths / credentials;
 *   - the Executor never reads or builds provider-native fields; the Model
 *     Adapter owns encoding.
 */

import type { ImageBlockParam } from "@anthropic-ai/sdk/resources/messages.js";
import { IMAGE_MEDIA_TYPES } from "../aci/tools/read-image.js";
import type { AnthropicContentBlock } from "../model-adapter/types.js";
import type { RegistryImpl } from "./registry.js";
import type {
  Executor,
  ToolCall,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolOutputEnvelope,
  ToolResultMeta,
} from "./types.js";

const TIMEOUT = Symbol("executor-timeout");

/** ADR-0006 — last-resort truncation threshold; char-level is the only practical measure. */
const OUTPUT_HARD_CAP = 20000;

/** ADR-0006 — truncation marker template with {original} / {kept} placeholders. */
const TRUNCATION_MARKER_TEMPLATE =
  "…[executor: 输出超长已截断，原长 {original} 字符，保留 {kept} 字符；如需更多信息，用更精确的输入重新调用]";

/**
 * The image-passthrough hole in `safeContent` opens only for the successful
 * `read_image` arm; every other tool stays text. Dual condition of name gate
 * + shape gate: the shape check stops malformed payloads from slipping
 * through under the name, and stops a same-named tool returning a non-image
 * shape from bypassing the existing text semantics.
 */
const IMAGE_PASSTHROUGH_TOOL_NAME = "read_image";

/** Legal media_types for SDK base64 image sources; the list SSOT is read-image.ts. */
const IMAGE_MEDIA_TYPE_SET: ReadonlySet<string> = new Set<string>(
  IMAGE_MEDIA_TYPES
);

/**
 * Executor-side output content-block union. Image blocks (SDK
 * `ImageBlockParam`) live only inside `tool_result.content` (protocol type
 * `unknown`) and never enter the top-level `AnthropicContentBlock` union —
 * the protocol stays unchanged. This union is an internal assembly type,
 * downcast when landing in `ToolExecutionResult.payload` (declared as
 * `AnthropicContentBlock[]`; the Adapter ships `unknown` content verbatim
 * without structural interpretation).
 */
type ToolResultContentBlock = AnthropicContentBlock | ImageBlockParam;

function isImageBlockParam(v: unknown): v is ImageBlockParam {
  if (!isNonArrayObject(v) || v.type !== "image") return false;
  const source = v.source;
  if (!isNonArrayObject(source) || source.type !== "base64") return false;
  return (
    typeof source.data === "string" &&
    source.data.length > 0 &&
    IMAGE_MEDIA_TYPE_SET.has(source.media_type as string)
  );
}

function safeContent(
  payload: unknown,
  def: ToolDefinition
): ToolResultContentBlock[] {
  if (def.name === IMAGE_PASSTHROUGH_TOOL_NAME && isImageBlockParam(payload)) {
    // Pixels are the payload; ADR-0006's char cap is a text measure, N/A here.
    return [payload];
  }
  let text: string;
  if (typeof payload === "string") {
    text = payload;
  } else if (isEnvelope(payload)) {
    // Structured envelope `{ output, meta? }`: only the output string reaches
    // the model tool_result; meta rides the observation side-channel, never
    // the model-visible payload. Plain JSON-compatible callers unaffected.
    text = payload.output;
  } else if (isJsonCompatible(payload)) {
    text = JSON.stringify(payload);
  } else {
    // Tool/Adapter boundary breach: converge to a correctable signal instead of throwing (ADR-0005).
    text = "[executor: payload not JSON-compatible]";
  }
  // ADR-0083: tools declared exempt at assembly time (static field on the
  // def) skip the cap untouched and without a marker; all others keep the
  // existing truncation semantics byte for byte.
  const capped = def.exemptFromOutputCap === true ? text : applyOutputCap(text);
  return [{ type: "text", text: capped }];
}

/**
 * Object guard: rejects null / arrays / primitives only — deliberately no
 * prototype-chain check (unlike isJsonCompatible), so Date / Map instances
 * pass and the field guards below report the missing fields themselves.
 */
function isNonArrayObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Optional-meta guard: undefined (absent) or string both legal. */
function isOptionalString(v: unknown): boolean {
  return v === undefined || typeof v === "string";
}

/**
 * `meta` shape guard: non-array object whose four known ToolResultMeta
 * fields, when present, are strings (unknown fields unchecked — opposite of
 * isJsonCompatible's whitelist stance). Reject-fast: one illegal known field
 * means the whole value is not an envelope.
 */
function isMetaShape(v: unknown): boolean {
  if (!isNonArrayObject(v)) return false;
  return (
    isOptionalString(v.oldContent) &&
    isOptionalString(v.newContent) &&
    isOptionalString(v.stdout) &&
    isOptionalString(v.stderr)
  );
}

/**
 * Single envelope discriminator: plain object with a string `output`, and an
 * optional plain-object `meta` (fields limited to string oldContent /
 * newContent / stdout / stderr). Shape follows `ToolOutputEnvelope`
 * (types.ts SSOT) so shape checks cannot drift; reject-fast: illegal meta
 * shape → not an envelope at all (meta dropped).
 */
function isEnvelope(v: unknown): v is ToolOutputEnvelope {
  if (!isNonArrayObject(v)) return false;
  if (typeof v.output !== "string") return false;
  const m = v.meta;
  return m === undefined || isMetaShape(m); // undefined = envelope with no meta
}

/** Extract the side-channel meta from a value already passed isEnvelope
 *  (shape verified by the guard; plain read here). */
function extractMeta(v: ToolOutputEnvelope): ToolResultMeta | undefined {
  const m = (v as unknown as Record<string, unknown>).meta as
    ToolResultMeta | undefined;
  return m;
}

/**
 * ADR-0006 — serialized text longer than OUTPUT_HARD_CAP → hard truncate +
 * append marker (the marker itself counts against the cap). Never persisted.
 * The executor always re-measures the actual serialized length; self-declared
 * fields inside a payload (truncated / total / ...) may be forged by
 * third-party MCP servers and are not trusted.
 *
 * `kept`'s digit count (1~5) makes the final marker vary ±4 chars, so this
 * runs estimate → verify → shrink-until-fit to guarantee the assembled total
 * stays strictly within the cap.
 */
function applyOutputCap(text: string): string {
  if (text.length <= OUTPUT_HARD_CAP) return text;
  const markerTemplate = TRUNCATION_MARKER_TEMPLATE.replace(
    "{original}",
    String(text.length)
  );
  // Phase 1: estimate kept worst-case ("{kept}" as 5 digits) → a safe lower bound.
  const estimateKept =
    OUTPUT_HARD_CAP - markerTemplate.replace("{kept}", "99999").length;
  let kept = Math.max(0, estimateKept);
  // Phase 2: substitute the real digit count; shrink kept while the total overflows.
  for (let i = 0; i < 8; i++) {
    const finalMarker = markerTemplate.replace("{kept}", String(kept));
    const totalLen = kept + finalMarker.length;
    if (totalLen <= OUTPUT_HARD_CAP) {
      return text.slice(0, kept) + finalMarker;
    }
    kept -= totalLen - OUTPUT_HARD_CAP;
    if (kept < 0) kept = 0;
  }
  // Extreme edge (near-unreachable): truncate to the cap without a marker.
  return text.slice(0, OUTPUT_HARD_CAP);
}

/**
 * ADR-0005 — strict JSON-compatibility whitelist.
 *   - Allow: null / string / boolean / finite number / Array / plain object
 *     (prototype === Object.prototype).
 *   - Reject: NaN / ±Infinity / Date / Map / Set / class instances / cycles.
 *   - Stack-overflow guard: a WeakSet of visited objects rejects re-entry.
 */
function isJsonCompatible(v: unknown): boolean {
  return isJsonCompatibleInner(v, new WeakSet());
}

function isJsonCompatibleInner(v: unknown, seen: WeakSet<object>): boolean {
  if (v === null) return true;
  const t = typeof v;
  if (t === "string" || t === "boolean") return true;
  if (t === "number") return Number.isFinite(v as number);
  if (Array.isArray(v)) {
    if (seen.has(v)) return false;
    seen.add(v);
    return v.every((item) => isJsonCompatibleInner(item, seen));
  }
  if (t === "object") {
    const o = v as Record<string, unknown>;
    if (Object.getPrototypeOf(o) !== Object.prototype) return false;
    if (seen.has(o)) return false;
    seen.add(o);
    return Object.values(o).every((value) =>
      isJsonCompatibleInner(value, seen)
    );
  }
  return false;
}

function buildStopSignal(
  outerSignal: AbortSignal | undefined,
  timeoutMs: number | undefined
): { signal: AbortSignal | undefined; abort: () => void } {
  const child = new AbortController();
  const needUnifiedSignal =
    outerSignal !== undefined || timeoutMs !== undefined;
  const unifiedSignal = needUnifiedSignal
    ? outerSignal !== undefined
      ? AbortSignal.any([outerSignal, child.signal])
      : child.signal
    : undefined;
  return { signal: unifiedSignal, abort: () => child.abort() };
}

async function raceWithTimeout<T>(
  handlerPromise: Promise<T>,
  timeoutMs: number,
  onTimeout: () => void
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      onTimeout();
      reject(TIMEOUT);
    }, timeoutMs);
  });
  try {
    return await Promise.race([handlerPromise, timeoutPromise]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

type ToolDefinition = NonNullable<ReturnType<RegistryImpl["get"]>>;
type CallValidation =
  | { ok: true; def: ToolDefinition }
  | { ok: false; failure: ToolExecutionResult };

function validateCall(registry: RegistryImpl, call: ToolCall): CallValidation {
  const def = registry.get(call.name);
  if (!def) {
    return {
      ok: false,
      failure: {
        kind: "tool_not_found",
        toolUseId: call.id,
        toolName: call.name,
      },
    };
  }
  const validator = registry.getValidator(call.name);
  if (!validator) {
    // Contract: the Registry always exposes a validator for tools its get()
    // returns; unreachable.
    return {
      ok: false,
      failure: {
        kind: "validation_failed",
        toolUseId: call.id,
        message: "validator not compiled for tool",
      },
    };
  }
  if (!validator(call.input)) {
    return {
      ok: false,
      failure: {
        kind: "validation_failed",
        toolUseId: call.id,
        message: formatAjvError(validator.errors),
      },
    };
  }
  return { ok: true, def };
}

/**
 * Ok-path assembly: an envelope's meta is lifted to the optional
 * side-channel; non-envelope paths have no meta. Payload always goes through
 * `safeContent` (cap exemption decided by the def's assembly-time field,
 * ADR-0083).
 */
function buildOkResult(
  call: ToolCall,
  out: unknown,
  def: ToolDefinition
): ToolExecutionResult {
  // Evaluate meta before payload to keep the pre-lifting evaluation order byte-identical.
  const meta: ToolResultMeta | undefined = isEnvelope(out)
    ? extractMeta(out)
    : undefined;
  // Downcast rationale in the ToolResultContentBlock note: image blocks reach
  // the wire only via tool_result.content (unknown); top-level union unchanged.
  return {
    kind: "ok",
    toolUseId: call.id,
    payload: safeContent(out, def) as AnthropicContentBlock[],
    meta,
  };
}

/**
 * Failure-path assembly: abort outranks timeout; other errors are sanitized
 * (never stack / internal paths / credentials). The check uses the outer
 * signal — a timeout aborts via the internal controller and must not be
 * reported as caller cancellation.
 */
function buildFailureResult(
  call: ToolCall,
  err: unknown,
  outerSignal: AbortSignal | undefined
): ToolExecutionResult {
  // Lifecycle outcomes outrank the input-rejection arm: an aborted or timed-out
  // call reports cancelled / timeout, never validation_failed.
  if (
    !outerSignal?.aborted &&
    err !== TIMEOUT &&
    err instanceof ToolInputValidationError
  ) {
    return {
      kind: "validation_failed",
      toolUseId: call.id,
      message: err.message,
    };
  }
  return {
    kind: "execution_failed",
    toolUseId: call.id,
    message: outerSignal?.aborted
      ? "cancelled"
      : err === TIMEOUT
        ? "timeout"
        : sanitizeFailure(err),
  };
}

/**
 * Build the Executor. It holds the Registry and reuses the construction-time
 * compiled ajv validators via `registry.getValidator` (same-source schema
 * enforcement); it creates no ajv instance itself. The Registry is immutable
 * and the Executor holds no mutable state.
 */
export function createExecutor(registry: RegistryImpl): Executor {
  async function runOne(
    call: ToolCall,
    signal?: AbortSignal,
    timeoutMs?: number,
    conversationId?: string,
    turnId?: string,
    onStream?: ToolExecutionContext["onStream"],
    messages?: ToolExecutionContext["messages"],
    parentThinking?: ToolExecutionContext["parentThinking"]
  ): Promise<ToolExecutionResult> {
    const validation = validateCall(registry, call);
    if (!validation.ok) return validation.failure;
    const stop = buildStopSignal(signal, timeoutMs);
    // conversationId flows into ctx so scope-filtering handlers
    // (bash-output / bash-stop) pass it to the manager; absent = no filter.
    // turnId works the same way — spawn_subagent records it as def.parentTurnId.
    const ctx: ToolExecutionContext = {
      signal: stop.signal,
      ...(conversationId !== undefined ? { conversationId } : {}),
      ...(turnId !== undefined ? { turnId } : {}),
      ...(onStream !== undefined ? { onStream } : {}),
      // Anthropic tool_use_id from call.id (the model-side wire id) — same
      // source as the toolUseId on the returned ToolExecutionResult, so
      // handlers need not rely on ctx for it. ADR-0071: spawn_subagent
      // consumes it into def.toolUseId → the manager copies it into
      // .meta.json. Paths calling the handler directly (tests) leave it
      // unfilled.
      toolUseId: call.id,
      ...(messages !== undefined ? { messages } : {}),
      ...(parentThinking !== undefined ? { parentThinking } : {}),
    };
    try {
      const out =
        timeoutMs === undefined
          ? await validation.def.handler(call.input, ctx)
          : await raceWithTimeout(
              Promise.resolve(validation.def.handler(call.input, ctx)),
              timeoutMs,
              stop.abort
            );
      return buildOkResult(call, out, validation.def);
    } catch (err) {
      return buildFailureResult(call, err, signal);
    }
  }

  async function executeAll(
    calls: ReadonlyArray<ToolCall>,
    signal?: AbortSignal,
    timeoutMs?: number,
    conversationId?: string,
    onSettled?: (
      result: ToolExecutionResult,
      index: number
    ) => void | Promise<void>,
    turnId?: string,
    onStream?: ToolExecutionContext["onStream"],
    // skill() second pass-through: a read-only snapshot of the model-visible
    // history, forwarded verbatim into ctx.messages.
    messages?: ToolExecutionContext["messages"],
    parentThinking?: ToolExecutionContext["parentThinking"]
  ): Promise<ReadonlyArray<ToolExecutionResult>> {
    const out: ToolExecutionResult[] = [];
    for (const [index, call] of calls.entries()) {
      const result = await runOne(
        call,
        signal,
        timeoutMs,
        conversationId,
        turnId,
        onStream,
        messages,
        parentThinking
      );
      await onSettled?.(result, index);
      out.push(result);
    }
    return out;
  }

  return Object.freeze({ executeAll });
}

/** One ajv error entry, read for the two fields the model needs. */
interface AjvErrorEntry {
  instancePath?: string;
  message?: string;
  keyword?: string;
  params?: { allowedValues?: unknown };
}

/** Where in the instance the violation is. */
function ajvErrorLocation(e: AjvErrorEntry): string {
  return e.instancePath && e.instancePath.length > 0
    ? e.instancePath
    : "(root)";
}

/**
 * What to change, in model-facing words (issue #1136): enum violations name the
 * accepted values, and a `false` subschema — the author's explicit "never
 * accepted here" — names the field instead of repeating ajv's boilerplate.
 * Other keywords keep the prior shape.
 */
function ajvErrorGuidance(e: AjvErrorEntry): string {
  if (e.keyword === "enum" && Array.isArray(e.params?.allowedValues)) {
    return `${e.message ?? "schema violation"} (${e.params.allowedValues.join(" / ")})`;
  }
  if (e.keyword === "false schema") {
    return "field is not accepted for this input shape";
  }
  return e.message ?? "schema violation";
}

function formatAjvError(errors: unknown): string {
  if (!Array.isArray(errors) || errors.length === 0) return "invalid input";
  const e = errors[0] as AjvErrorEntry;
  return `invalid input at ${ajvErrorLocation(e)}: ${ajvErrorGuidance(e)}`;
}

function sanitizeFailure(err: unknown): string {
  // Model-facing opt-in: ToolExecutionError, or a typed error from another
  // bounded context that declares `modelFacing` (ADR-0086). Everything else
  // keeps the generic string so stack / paths never reach the model.
  if (isModelFacingError(err)) {
    return (err as Error).message;
  }
  return "tool execution failed";
}

// Late import to break potential cycle: error helpers referenced here.
import { isModelFacingError, ToolInputValidationError } from "../errors.js";
