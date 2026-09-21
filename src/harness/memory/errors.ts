/**
 * Typed memory errors (Errors bounded context).
 *
 * Spec: specs/121-memory-injection.md (Boundaries Always — typed MemoryError,
 * no empty catch; never string error codes). Shape mirrors src/harness/errors.ts
 * (lightweight class extends Error + name override); index.ts re-exports.
 */

import type { ModelFacingError } from "../errors.js";

/** Base error for everything in src/harness/memory/. */
export class MemoryError extends Error {
  override readonly name: string = "MemoryError";
}

/**
 * The memory file is structurally valid JSON but the shape fails the v1
 * schema contract. Carries the failing field name so callers can attach
 * load-side context (conversation_id analog for memory: slug path).
 */
export class MemorySchemaInvalid extends MemoryError {
  override readonly name: string = "MemorySchemaInvalid";
  readonly field: string;
  constructor(field: string, message?: string) {
    super(message ?? `memory file schema invalid at field: ${field}`);
    this.field = field;
  }
}

/**
 * Auto-memory ingest could not produce usable candidates (ADR-0031 D5):
 * the extraction call failed, its output was not a JSON array,
 * or a candidate reached the write path still carrying negative-form
 * phrasing. One error type so the host wire has exactly one thing to swallow.
 */
export class MemoryExtractError extends MemoryError {
  override readonly name: string = "MemoryExtractError";
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

/**
 * A GC option is outside its declared domain (ADR-0031).
 * Thrown before any scan or write so a bad cap cannot half-apply a plan.
 */
export class MemoryGcOptionInvalid extends MemoryError {
  override readonly name: string = "MemoryGcOptionInvalid";
}

/** Filesystem-side failure (read / write / rename / directory). */
export class MemoryIOError extends MemoryError {
  override readonly name: string = "MemoryIOError";
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

/**
 * ADR-0086: the draft is a runtime
 * capability / environment-availability observation ("web_search is
 * unavailable in this sandbox"). Subclass of `MemoryError` so the
 * typed-error contract still holds; a named subclass lets the host and the
 * tests tell "this fact may not be stored" apart from a malformed input or an
 * IO fault. `reason` is the wire-stable token
 * (`CAPABILITY_OBSERVATION_REASON`) and `detail` the human-readable why.
 */
export class MemoryCapabilityRejected
  extends MemoryError
  implements ModelFacingError
{
  override readonly name: string = "MemoryCapabilityRejected";
  /**
   * Executor opacity opt-in (see `ModelFacingError` in src/harness/errors.ts):
   * the rejection reason is the whole point — the model must learn *why* the
   * fact may not be stored, and this message names no path or secret. The
   * `implements` clause is the type-level tie; `isModelFacingError` still
   * matches the runtime property.
   */
  readonly modelFacing = true as const;
  readonly reason: string;
  readonly detail: string;
  constructor(reason: string, detail: string) {
    super(`[memory_save] rejected: ${reason} — ${detail}`);
    this.reason = reason;
    this.detail = detail;
  }
}

/**
 * Quarantine classification for memory_save rejection (spec SC 9). Stored
 * alongside the rejected draft so the loader / UI can surface a stable
 * machine-readable reason. String values are wire-stable: future versions
 * only add new members, never rename existing ones.
 */
export const MemoryQuarantinedReason = {
  NegativeForm: "negative_form",
  SchemaInvalid: "schema_invalid",
  IoError: "io_error",
} as const;

export type MemoryQuarantinedReason =
  (typeof MemoryQuarantinedReason)[keyof typeof MemoryQuarantinedReason];
