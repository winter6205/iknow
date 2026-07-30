/**
 * In-memory storage backend for dev/test.
 * Vector search = brute-force cosine over all stored chunks.
 * No persistence — data lost on process exit.
 * Thread-safety: single-threaded Node; concurrent upserts are safe
 * because Map.set is synchronous within each await boundary.
 */
import type {
  ChunkRecord,
  RetrievedChunk,
  SearchOptions,
  StorageBackend,
} from "../types.js";
import { cosineSimilarity } from "../cosine.js";
import { GraphragError, EMBEDDING_DIM } from "../errors.js";

/**
 * In-process StorageBackend. Suitable for unit tests, local dev, and any
 * context where durability is not required (no snapshot_id in stage 1).
 *
 * Indexing strategy: brute-force scan over the entire chunk set on every
 * search. With O(N) chunks this is O(N * 1536) per query — fine for the
 * dev/test workloads stage 1 targets; PgvectorBackend (T8) takes over when
 * N grows past a few thousand.
 *
 * Why `Map<id, ChunkRecord>` and not an array: keyed by id gives us O(1)
 * overwrite semantics for "last write wins" on re-ingestion of the same
 * chunk id, and O(1) clear() on close().
 */
export class MemoryBackend implements StorageBackend {
  private readonly store = new Map<string, ChunkRecord>();

  /**
   * Validate then store each chunk. The whole batch is atomic: if any chunk
   * fails the embedding-dimension check, the batch throws and no chunk is
   * persisted (Map.set has not been called yet for that chunk).
   *
   * Throws GraphragError EMBEDDING_DIM_MISMATCH if a chunk's embedding has
   * a length other than EMBEDDING_DIM.
   */
  async upsert(chunks: ChunkRecord[]): Promise<string[]> {
    // Pre-validate all chunks before mutating the store so a bad chunk in
    // position N does not leave the first N-1 chunks half-persisted.
    for (const chunk of chunks) {
      if (chunk.embedding.length !== EMBEDDING_DIM) {
        throw new GraphragError(
          `upsert: chunk "${chunk.id}" embedding length ${chunk.embedding.length} !== ${EMBEDDING_DIM}`,
          "EMBEDDING_DIM_MISMATCH"
        );
      }
    }

    const ids: string[] = [];
    for (const chunk of chunks) {
      // Last-write-wins: a re-ingestion of the same id replaces the old record.
      this.store.set(chunk.id, chunk);
      ids.push(chunk.id);
    }
    return ids;
  }

  /**
   * Apply filters (valid_window + exact-match metadata/source_ref), score,
   * rank, and return the top-K.
   *
   * valid_window semantics: a chunk is in-window when
   *   valid_from <= validAt AND (valid_until === null OR valid_until > validAt)
   * valid_until is exclusive — a chunk expiring at exactly validAt is NOT
   * returned. This matches the spec at src/core/types.ts:63 ("OR valid_until > validAt").
   */
  async search(
    queryEmbedding: number[],
    opts: SearchOptions
  ): Promise<RetrievedChunk[]> {
    const validAtMs = Date.parse(opts.validAt);
    if (Number.isNaN(validAtMs)) {
      throw new GraphragError(
        `search: invalid validAt timestamp "${opts.validAt}"`,
        "INVALID_INPUT"
      );
    }

    const filters = opts.filters ?? {};
    const wantSourceRef = filters.source_ref;
    const metadataFilters: Array<{ key: string; value: string }> = [];
    for (const [k, v] of Object.entries(filters)) {
      if (k === "source_ref") continue;
      if (k.startsWith("metadata.")) {
        metadataFilters.push({ key: k.slice("metadata.".length), value: v });
      }
      // Unknown top-level filter keys are ignored — they cannot match
      // anything on a ChunkRecord (which only exposes source_ref + metadata).
    }

    const scored: RetrievedChunk[] = [];
    for (const chunk of this.store.values()) {
      // 1. valid_window filter
      const fromMs = Date.parse(chunk.valid_from);
      if (Number.isNaN(fromMs) || fromMs > validAtMs) continue;
      if (chunk.valid_until !== null) {
        const untilMs = Date.parse(chunk.valid_until);
        if (Number.isNaN(untilMs) || untilMs <= validAtMs) continue;
      }

      // 2. source_ref exact match
      if (wantSourceRef !== undefined && chunk.source_ref !== wantSourceRef) {
        continue;
      }

      // 3. metadata exact-match filters (text-comparison semantics to match
      // pgvector's `metadata ->> $key = $value`, which casts JSON values to
      // text before comparing — e.g. {category: 123} matches filter "123").
      let metaOk = true;
      for (const f of metadataFilters) {
        const val = chunk.metadata[f.key];
        if (val === undefined || String(val) !== f.value) {
          metaOk = false;
          break;
        }
      }
      if (!metaOk) continue;

      // 4. Score
      const score = cosineSimilarity(queryEmbedding, chunk.embedding);

      scored.push({
        id: chunk.id,
        content: chunk.content,
        source_ref: chunk.source_ref,
        valid_window: [chunk.valid_from, chunk.valid_until],
        score,
      });
    }

    // 5. Sort descending by score. Ties keep insertion order (Array.prototype.sort
    // is stable in V8/Node since ES2019).
    scored.sort((a, b) => b.score - a.score);

    // 6. Top-K
    return scored.slice(0, opts.limit);
  }

  /**
   * Drop all stored chunks. Resolves successfully even if the backend is
   * already empty, so callers can use close() in `finally` blocks without
   * caring about state.
   */
  async close(): Promise<void> {
    this.store.clear();
  }
}
