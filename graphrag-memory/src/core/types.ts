/**
 * Core domain types for graphrag-memory stage 1.
 *
 * Stage 1 = chunks-only vector retrieval with valid_window time slicing.
 * No triples/entities/facts (stage 3). No snapshot_id (T-001 drift verdict #2).
 */

/** A stored text chunk with its embedding and temporal validity. */
export interface ChunkRecord {
  id: string;
  content: string;
  embedding: number[]; // vector of configured dimensions
  source_ref: string;
  metadata: Record<string, unknown>;
  valid_from: string; // ISO 8601 datetime
  valid_until: string | null; // null = forever valid
  created_at: string; // ISO 8601 datetime
}

/** Input to the ingest tool (after Zod validation). */
export interface IngestInput {
  content: string;
  source_ref: string;
  metadata?: Record<string, unknown>;
  valid_from?: string; // ISO 8601; defaults to now
  valid_until?: string; // ISO 8601; defaults to null (forever)
}

/** Input to the retrieve tool (after Zod validation). */
export interface RetrieveInput {
  query: string;
  valid_at?: string; // ISO 8601; defaults to now
  filters?: Record<string, string>; // exact match on source_ref / metadata keys
  limit?: number; // top-K; defaults to 10
}

/** A single chunk in a retrieve response. */
export interface RetrievedChunk {
  id: string;
  content: string;
  source_ref: string;
  valid_window: [string, string | null]; // [valid_from, valid_until]
  score: number; // cosine similarity 0-1
}

/** Response from the retrieve tool. */
export interface RetrieveResult {
  chunks: RetrievedChunk[];
}

/** Storage backend contract — both MemoryBackend and PgvectorBackend implement this. */
export interface StorageBackend {
  upsert(chunks: ChunkRecord[]): Promise<string[]>; // returns chunk ids
  search(
    queryEmbedding: number[],
    opts: SearchOptions
  ): Promise<RetrievedChunk[]>;
  close(): Promise<void>;
}

export interface SearchOptions {
  limit: number;
  validAt: string; // ISO 8601 — filter: valid_from <= validAt AND (valid_until IS NULL OR valid_until > validAt)
  filters?: Record<string, string>; // exact match on source_ref / metadata keys
}
