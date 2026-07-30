/**
 * Typed error taxonomy for graphrag-memory stage 1.
 *
 * Handlers throw GraphragError (never bare Error/string).
 * The registerOne catch in index.ts logs the code field.
 */

export type GraphragErrorCode =
  | "INVALID_INPUT" // Zod passed but semantically invalid (e.g. valid_from > valid_until)
  | "CONTENT_TOO_LARGE" // content exceeds MAX_CONTENT_BYTES (1MB)
  | "EMBEDDING_FAILED" // 9router /v1/embeddings call failed
  | "EMBEDDING_DIM_MISMATCH" // returned vector dimension !== configured dimensions
  | "STORAGE_ERROR"; // backend upsert/search underlying exception

export class GraphragError extends Error {
  constructor(
    message: string,
    readonly code: GraphragErrorCode
  ) {
    super(message);
    this.name = "GraphragError";
  }
}

/** Max content size for a single ingest call (1 MB). */
export const MAX_CONTENT_BYTES = 1_048_576;
