/**
 * Foundation-owned error classes: no host business packages, no re-exported
 * vendor SDK types.
 *
 * - RegistryConstructionError: construction-time failure (dup name/schema/validator)
 * - ProtocolError: whole-turn protocol structure error; turn never enters history
 * - PromptTooLongError: SDK 400 prompt-too-long, translated for reactive compact
 * - MaxTurnsExceeded: throws instead of silent-stopping on maxTurns exhaustion
 * - ToolExecutionError: sanitized tool business failure fed back to the model
 * - ToolInputValidationError: handler input-shape rejection (validation_failed)
 * - SubAgentSandboxRootError: sandboxRoot narrowed outside the parent root
 * - SkipAppend*Error: skip-append guards (`skip_append_with_text` / `skip_append_empty_prior`)
 *
 // (ADR-0011)
 */

export class RegistryConstructionError extends Error {
  override readonly name = "RegistryConstructionError";
}

export class ProtocolError extends Error {
  // Explicit `: string` so subclasses may override `name` with a different
  // literal (otherwise TS infers the literal "ProtocolError" and rejects TS2416).
  override readonly name: string = "ProtocolError";
}

/**
 * Reactive-compact foundation: thrown when the SDK returns 400 prompt-too-long.
 * Extends ProtocolError so loop-engine's `instanceof ProtocolError` branch
 * catches it. Adapters translate at both call sites (`messages.create` /
 * `finalMessage()`) when `instanceof APIError && status === 400 &&
 * /prompt.*length|too long/i`; all other errors rethrow unchanged.
 */
export class PromptTooLongError extends ProtocolError {
  override readonly name = "PromptTooLongError";
}

/**
 * ModelAdapter transport retries exhausted. Typed failure (never a bare
 * `Error`); loop-engine maps it to the `protocolError` stop reason so the
 * whole turn stays out of history.
 */
export class TransportRetryExhaustedError extends Error {
  override readonly name = "TransportRetryExhaustedError";
  readonly attempts: number;
  readonly cause: unknown;
  constructor(attempts: number, cause: unknown) {
    super(`transport retry exhausted after ${attempts} attempt(s)`);
    this.attempts = attempts;
    this.cause = cause;
  }
}

/**
 * ADR-0111: the upstream stream ended without a complete assistant message
 * (empty/dropped stream — transient shape). Extends `ProtocolError` so
 * loop-engine closes it via the matching branch (subclass branches run first).
 *
 * - `visible` = this attempt saw a non-empty visible delta (same test as
 *   `clock_timeout`: invisible → whole-step retry is safe; text shown → no
 *   auto-retry, surface the typed failure).
 * - `cause` = original SDK error; apiError summary via `transportApiErrorOf`.
 */
export class ModelStreamIncompleteError extends ProtocolError {
  override readonly name = "ModelStreamIncompleteError";
  readonly visible: boolean;
  readonly cause: unknown;
  constructor(visible: boolean, cause: unknown) {
    super("model stream ended without producing a complete assistant message");
    this.visible = visible;
    this.cause = cause;
  }
}

/**
 * maxTurns exhausted: throw instead of silent-stopping. Carries no
 *
 // (ADR-0011)
 * messages/usage snapshot (session state stays the single source of truth),
 * only turns ran + reason. Surfaces catching it must persist the session
 * first, then show a closing summary.
 */
export class MaxTurnsExceeded extends Error {
  override readonly name = "MaxTurnsExceeded";
  readonly turnsRan: number;
  readonly reason: string;
  constructor(turnsRan: number, reason: string) {
    super(`MaxTurnsExceeded: ${reason} after ${turnsRan} turns`);
    this.turnsRan = turnsRan;
    this.reason = reason;
  }
}

export class ToolExecutionError extends Error {
  override readonly name: string = "ToolExecutionError";
}

/**
 * Deterministic input-shape rejection thrown by a handler's validation stage
 * (todo_write parseInput). The executor classifies it as `validation_failed`
 * instead of `execution_failed`; as a `ToolExecutionError` subclass it keeps
 * ADR-0086 message passthrough and every existing `instanceof` site unchanged.
 * WHY no `name` override: rendering seam-locks on "ToolExecutionError"; the
 * executor discriminates on class identity, not the name string.
 */
export class ToolInputValidationError extends ToolExecutionError {}

/**
 * ADR-0086: opt-in contract marking an error's message as safe to show the
 * model. Executor sanitization passes through only `ToolExecutionError`
 * messages by default; anything else collapses to a constant string (no stack
 * / path leakage). Bounded contexts with their own typed error bases (e.g.
 * memory's `MemoryError`) can implement this interface with `readonly
 * modelFacing = true` instead of extending a foundation class. This is a
 * *declaration*, not an inference: undeclared messages stay sanitized.
 */
export interface ModelFacingError {
  readonly modelFacing: true;
}

/** True if `ToolExecutionError`, or the error self-declares `modelFacing`. */
export function isModelFacingError(err: unknown): boolean {
  if (err instanceof ToolExecutionError) return true;
  return (
    err instanceof Error &&
    (err as { readonly modelFacing?: unknown }).modelFacing === true
  );
}

/** Stable failure discriminants for MCP root/config/reload lifecycle edges. */
export type McpLifecycleErrorKind =
  | "missing_cwd"
  | "invalid_cwd"
  | "invalid_config_root"
  | "root_mismatch"
  | "config_load_failed"
  | "reload_failed";

const MCP_LIFECYCLE_DETAIL_FALLBACK = "MCP lifecycle operation failed";

/**
 * Keep lifecycle diagnostics useful without copying raw transport input into
 * the product-visible error. In particular, command arguments and
 * secret-shaped values must not cross this error boundary.
 */
function sanitizeMcpLifecycleDetail(detail: string): string {
  let safeDetail =
    typeof detail === "string" ? detail.trim() : MCP_LIFECYCLE_DETAIL_FALLBACK;

  if (!safeDetail) return MCP_LIFECYCLE_DETAIL_FALLBACK;

  safeDetail = safeDetail
    .replace(
      /\b(?:command|cmd|argv|args)\b\s*[:=]\s*[^\n;]*/gi,
      "[command redacted]"
    )
    .replace(
      /\b(?:node|npm|npx|bun|deno|bash|sh|python|tsx)\b(?:\s+\S+)+/gi,
      "[command redacted]"
    )
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(
      /\b(api[-_ ]?key|token|secret|password|passwd|authorization|credential|cookie)\b\s*[:=]\s*\S+/gi,
      "$1=[redacted]"
    )
    .replace(
      /\b[A-Z][A-Z0-9_]*(?:_KEY|_TOKEN|_SECRET|_PASSWORD)\s*=\s*\S+/g,
      "[env]=[redacted]"
    )
    .replace(
      /\bprocess\.env\.[A-Za-z_][A-Za-z0-9_]*\b/g,
      "process.env.[redacted]"
    )
    .replace(/\$[A-Z_][A-Z0-9_]*/g, "$[redacted]");

  return safeDetail.trim() || MCP_LIFECYCLE_DETAIL_FALLBACK;
}

/**
 * Typed, stable MCP lifecycle failure. Callers branch on `kind`, while
 * `message` and `detail` remain non-empty and safe for product surfaces.
 */
export class McpLifecycleError extends ToolExecutionError {
  override readonly name: string = "McpLifecycleError";
  readonly kind: McpLifecycleErrorKind;
  readonly detail: string;

  constructor(
    kind: McpLifecycleErrorKind,
    detail: string,
    options?: { readonly cause?: unknown }
  ) {
    const safeDetail = sanitizeMcpLifecycleDetail(detail);
    super(`McpLifecycleError: ${kind} — ${safeDetail}`, options);
    this.kind = kind;
    this.detail = safeDetail;
  }
}

/**
 * ADR-0037: session three-roots (product/task/install) resolution failure.
 * Only two kinds — the role rides in `detail` (root name), so callers need no
 * per-role kind. "mismatch against a pinned root" stays in
 * `McpLifecycleError.root_mismatch`; no parallel scheme. Reuses its detail
 * sanitization (root paths may contain env-shaped fragments).
 */
export type SessionRootErrorKind = "missing_root" | "invalid_root";

export class SessionRootError extends ToolExecutionError {
  override readonly name: string = "SessionRootError";
  readonly kind: SessionRootErrorKind;
  readonly detail: string;

  constructor(
    kind: SessionRootErrorKind,
    detail: string,
    options?: { readonly cause?: unknown }
  ) {
    const safeDetail = sanitizeMcpLifecycleDetail(detail);
    super(`SessionRootError: ${kind} — ${safeDetail}`, options);
    this.kind = kind;
    this.detail = safeDetail;
  }
}

/**
 * The host-injected commit hook failed. loop-engine neither retries, swallows,
 * nor maps commit failures to a stop reason — it wraps them here and
 * rethrows, aborting the run (committed events stay on disk). Surfaces
 * distinguish "persistence failed" via instanceof; `cause` keeps the host's
 * original typed error.
 */
export class MessageCommitError extends Error {
  override readonly name = "MessageCommitError";
  readonly cause: unknown;
  constructor(cause: unknown) {
    super(`MessageCommitError: commit hook failed: ${errorMessage(cause)}`);
    this.cause = cause;
  }
}

/** Skip-append guard: `appendUserText: false` forbids new task user text (EXIT `skip_append_with_text`). */
export class SkipAppendWithTextError extends Error {
  override readonly name = "SkipAppendWithTextError";
  constructor() {
    super(
      "skip_append_with_text: appendUserText false requires empty userText"
    );
  }
}

/** Skip-append guard: with `appendUserText: false`, priorMessages must exist and be non-empty (EXIT `skip_append_empty_prior`). */
export class SkipAppendEmptyPriorError extends Error {
  override readonly name = "SkipAppendEmptyPriorError";
  constructor() {
    super(
      "skip_append_empty_prior: appendUserText false requires non-empty priorMessages"
    );
  }
}

/**
 * Typed rejection when a subagent's sandboxRoot narrows outside the parent
 * root. The single check in `buildWorkerPayload` throws synchronously when
 * def.sandboxRoot is outside the parent root or unresolvable (ENOENT); the
 * spawn factory never fires. Input-rejection domain (like ToolExecutionError),
 * not an envelope failure, so it carries `context` rather than status/reason;
 * the tool handler converts it to a ToolExecutionError. The message is
 * model-facing: narrow the path or omit it to inherit the parent root.
 */
export class SubAgentSandboxRootError extends Error {
  override readonly name = "SubAgentSandboxRootError";
  readonly context: {
    readonly parentSandboxRoot: string;
    readonly requested: string;
  };
  constructor(context: {
    readonly parentSandboxRoot: string;
    readonly requested: string;
  }) {
    super(
      `spawn_subagent: sandboxRoot '${context.requested}' is outside the parent sandbox root '${context.parentSandboxRoot}'. Pass a path inside the parent sandbox root, or omit sandboxRoot to inherit the parent root.`
    );
    this.context = context;
  }
}

/**
 * Any throwable → safe string summary (typed errors are branched by callers).
 * Replaces `err instanceof Error ? err.message : String(err)`, which flattens
 * plain objects to `[object Object]` and loses kind/context. Single point of
 * maintenance.
 */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/**
 * ADR-0094: viewport API error summary — optional status + non-empty message.
 * Shared alias (loop-engine / hub DTO / TUI bridge / app), no per-site inlining.
 */
export type ApiErrorSummary = {
  readonly status?: number;
  readonly message: string;
};

/** object (incl. Error instances) → Record view; anything else → undefined. */
function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null
    ? (v as Record<string, unknown>)
    : undefined;
}

/** Non-empty (after trim) string → itself; otherwise undefined. */
function nonEmptyString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

/**
 * Message from a gateway's nested error body: `error.message`, then a second
 * `error.error.message` layer (relayer gateways nest two). Missing/empty → undefined.
 */
function extractNestedMessage(
  record: Record<string, unknown>
): string | undefined {
  const body = asRecord(record["error"]);
  if (body === undefined) return undefined;
  return (
    nonEmptyString(body["message"]) ??
    nonEmptyString(asRecord(body["error"])?.["message"])
  );
}

/**
 * Top-level message: Error.message / bare string / object.message. Callers
 * prefer the nested gateway body (vendor's words beat the SDK's "404 Not
 * Found" HTTP text, ADR-0094); this is the fallback.
 */
function extractBaseMessage(cause: unknown): string | undefined {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "string") return cause;
  const record = asRecord(cause);
  return typeof record?.["message"] === "string"
    ? (record["message"] as string)
    : undefined;
}

/** Finite numeric `status` on the cause (object shape only); otherwise undefined. */
function extractCauseStatus(cause: unknown): number | undefined {
  const status = asRecord(cause)?.["status"];
  return typeof status === "number" && Number.isFinite(status)
    ? status
    : undefined;
}

/**
 * ADR-0094 (viewport API errors): distill `{ status?, message }` from a
 * TransportRetryExhaustedError.cause. SDK-agnostic. `message` is always
 * non-empty (falls back to `String(cause)`); null/undefined cause → undefined.
 */
export function summarizeTransportCause(
  cause: unknown
): ApiErrorSummary | undefined {
  if (cause === null || cause === undefined) return undefined;
  // An SDK APIError is both an Error instance and an object with a nested
  // body — nested extraction works for both shapes (extractBaseMessage is
  // only the fallback); the provider's own text wins.
  const record = asRecord(cause);
  const message =
    (record !== undefined ? extractNestedMessage(record) : undefined) ??
    extractBaseMessage(cause) ??
    "";
  const status = extractCauseStatus(cause);
  const nonEmpty = message.trim() || String(cause);
  return status !== undefined
    ? { status, message: nonEmpty }
    : { message: nonEmpty };
}

/**
 * ADR-0094 + ADR-0111: throw-path only. Transient model-stream/transport
 * failures carrying a cause (TransportRetryExhaustedError /
 * ModelStreamIncompleteError) → a `{ message, status? }` summary of the cause;
 * any other throwable → undefined. Invariant: apiError present ⇔ transient
 * failure with a cause.
 */
export function transportApiErrorOf(err: unknown): ApiErrorSummary | undefined {
  if (err instanceof TransportRetryExhaustedError) {
    return summarizeTransportCause(err.cause);
  }
  if (err instanceof ModelStreamIncompleteError) {
    return summarizeTransportCause(err.cause);
  }
  return undefined;
}

/**
 * ADR-0094: byte-stable optional-field mount — `apiError` key exists only when
 * defined (same wire discipline as an absent `lastUsage`). Lets assembly code
 * avoid repeating `...(x !== undefined ? {x} : {})` spreads.
 */
export function withApiError<T extends object>(
  target: T,
  apiError: ApiErrorSummary | undefined
): T & { readonly apiError?: ApiErrorSummary } {
  return apiError !== undefined ? { ...target, apiError } : target;
}
