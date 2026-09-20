/**
 * SessionStore typed IO error contract.
 *
 * Why typed: hub maps each kind to a distinct HTTP status / wire
 * ApiErrorBody. Bare `throw new Error(...)` collapses everything into a
 * single 500.
 */

/**
 * SessionStore error classification. Hub throws this on IO failure; the
 * http layer maps each kind to a wire ApiErrorBody.
 */
export type SessionStoreError =
  | { kind: "not_found"; conversation_id: string }
  | { kind: "parse_failed"; conversation_id: string; reason: string }
  | { kind: "schema_invalid"; conversation_id: string; field: string }
  | { kind: "write_failed"; conversation_id: string; cause: string }
  | { kind: "concurrent_write"; conversation_id: string }
  | { kind: "io_error"; conversation_id: string; cause: string };

/** Discriminant union — used by wire ApiErrorBody.error.kind (contract.ts). */
export type SessionStoreErrorKind = SessionStoreError["kind"];
