/**
 * #121 T2: typed memory errors (Errors bounded context).
 *
 * Spec: specs/121-memory-injection.md (Boundaries Always — typed MemoryError,
 * 不空 catch; never string error codes). Shape mirrors src/harness/errors.ts
 * (lightweight class extends Error + name override); index.ts re-exports.
 */

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

/** Filesystem-side failure (read / write / rename / directory). */
export class MemoryIOError extends MemoryError {
  override readonly name: string = "MemoryIOError";
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
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
