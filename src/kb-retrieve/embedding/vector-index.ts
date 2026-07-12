import type { EmbeddingClient, ChunkEmbedInput } from "./types.js";
import { cosine, l2normalize } from "./fake.js";

const BATCH = 16;

/**
 * In-memory vector index for chunk embeddings.
 * Vector arm of kb_retrieve when embedding mode is on.
 */
export class VectorIndex {
  private readonly client: EmbeddingClient;
  private readonly vectors = new Map<string, number[]>();

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
    const missing = chunks.filter((c) => !this.vectors.has(c.chunk_id));
    if (missing.length === 0) return;

    for (let i = 0; i < missing.length; i += BATCH) {
      const batch = missing.slice(i, i + BATCH);
      const texts = batch.map((c) => `${c.summary}\n${c.text}`.slice(0, 8000));
      const embs = await this.client.embed(texts);
      for (let j = 0; j < batch.length; j++) {
        const row = embs[j];
        if (!row) continue;
        this.vectors.set(batch[j]!.chunk_id, l2normalize(row));
      }
    }
  }

  async rankQuery(
    query: string,
    limit = 50,
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
    return scored.slice(0, limit).filter((s) => s.score > 0);
  }
}
