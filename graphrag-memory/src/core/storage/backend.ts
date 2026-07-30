/**
 * Storage backend contract re-export.
 * Concrete implementations: MemoryBackend (dev/test), PgvectorBackend (prod, T8).
 */
export type { StorageBackend, SearchOptions } from "../types.js";
