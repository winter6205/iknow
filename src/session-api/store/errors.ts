/**
 * SessionStore typed IO error contract (022 spec §SessionStore IO 错误契约).
 *
 * Why typed: hub maps each kind to a distinct HTTP status / wire ApiErrorBody
 * (spec 错误映射契约 table). Bare `throw new Error(...)` collapses everything
 * into a single 500 and is forbidden by spec.
 */

/**
 * SessionStore 错误分类。hub 在 IO 失败时抛此类型，http 层映射到 wire ApiErrorBody。
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
