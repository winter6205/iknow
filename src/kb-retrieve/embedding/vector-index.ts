import { ValidationError } from "../../shared/errors.js";
import type { EmbeddingClient, ChunkEmbedInput } from "./types.js";
import { cosine, l2normalize } from "./math.js";

const BATCH = 16;
const MAX_CHARS = 8000;

/**
 * In-memory vector index for chunk embeddings.
 * Vector arm of kb_retrieve when embedding mode is on.
 */
export class VectorIndex {
  private readonly client: EmbeddingClient;
  private readonly vectors = new Map<string, number[]>();
  /** Serializes concurrent ensureChunks so shared index does not double-embed. */
  private ensureMutex: Promise<void> = Promise.resolve();

  constructor(client: EmbeddingClient) {
    this.client = client;
  }

  get size(): number {
    return this.vectors.size;
  }

  has(chunkId: string): boolean {
    return this.vectors.has(chunkId);
  }

  clear(): void {
    this.vectors.clear();
  }

  async ensureChunks(chunks: ChunkEmbedInput[]): Promise<void> {
    const run = this.ensureMutex.then(() => this.ensureChunksLocked(chunks));
    // Keep chain alive on failure so later callers still queue.
    this.ensureMutex = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async ensureChunksLocked(chunks: ChunkEmbedInput[]): Promise<void> {
    const missing = chunks.filter((c) => !this.vectors.has(c.chunk_id));
    if (missing.length === 0) return;

    for (let i = 0; i < missing.length; i += BATCH) {
      const batch = missing.slice(i, i + BATCH);
      const texts = batch.map((c) =>
        `${c.summary}\n${c.text}`.slice(0, MAX_CHARS),
      );
      const embs = await this.client.embed(texts);
      if (embs.length !== batch.length) {
        throw new ValidationError(
          `embedding batch size mismatch: expected ${batch.length}, got ${embs.length}`,
          { expected: batch.length, got: embs.length },
        );
      }
      for (let j = 0; j < batch.length; j++) {
        const row = embs[j];
        if (!row) {
          throw new ValidationError(`embedding missing at batch index ${j}`, {
            batchIndex: j,
          });
        }
        const chunk = batch[j];
        if (!chunk) {
          throw new ValidationError(`chunk missing at batch index ${j}`, {
            batchIndex: j,
          });
        }
        this.vectors.set(chunk.chunk_id, l2normalize(row));
      }
    }
  }

  async rankQuery(
    query: string,
    limit = 50,
    minScore = 0,
  ): Promise<Array<{ id: string; score: number }>> {
    if (this.vectors.size === 0) return [];
    const [q] = await this.client.embed([query]);
    if (!q) return [];
    const qn = l2normalize(q);
    const scored: Array<{ id: string; score: number }> = [];
    for (const [id, vec] of this.vectors) {
      scored.push({ id, score: cosine(qn, vec) });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).filter((s) => s.score > minScore);
  }
}
