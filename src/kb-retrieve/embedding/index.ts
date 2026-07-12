export type { EmbeddingClient, ChunkEmbedInput } from "./types.js";
export { OpenAiCompatibleEmbeddingClient } from "./openai-compatible.js";
export { FakeEmbeddingClient, cosine, l2normalize } from "./fake.js";
export { VectorIndex } from "./vector-index.js";

import { loadIknowEnv } from "../../config/env.js";
import { OpenAiCompatibleEmbeddingClient } from "./openai-compatible.js";
import { FakeEmbeddingClient } from "./fake.js";
import { VectorIndex } from "./vector-index.js";
import type { EmbeddingClient } from "./types.js";
import type { InMemoryKnowledgeStore } from "../../knowledge-store/memory-store.js";

/** Shared process-level index (seed once per store lifetime). */
let sharedIndex: VectorIndex | undefined;
let sharedClient: EmbeddingClient | undefined;

export function createEmbeddingClientFromEnv(
  forceFake = false,
): EmbeddingClient | undefined {
  if (forceFake) return new FakeEmbeddingClient(32);
  const env = loadIknowEnv();
  if (env.embedding.mode !== "api") return undefined;
  if (!env.embedding.apiKey) return undefined;
  return new OpenAiCompatibleEmbeddingClient({
    baseUrl: env.embedding.baseUrl,
    apiKey: env.embedding.apiKey,
    model: env.embedding.model,
    dimensions: env.embedding.dimensions,
    timeoutMs: env.embedding.timeoutMs,
    dimsHint: env.embedding.dims,
  });
}

export function getOrCreateVectorIndex(opts?: {
  forceFake?: boolean;
  client?: EmbeddingClient;
}): VectorIndex | undefined {
  if (opts?.client) {
    sharedClient = opts.client;
    sharedIndex = new VectorIndex(opts.client);
    return sharedIndex;
  }
  if (sharedIndex) return sharedIndex;
  const client = createEmbeddingClientFromEnv(opts?.forceFake ?? false);
  if (!client) return undefined;
  sharedClient = client;
  sharedIndex = new VectorIndex(client);
  return sharedIndex;
}

export function resetVectorIndexForTests(): void {
  sharedIndex = undefined;
  sharedClient = undefined;
}

export async function ensureStoreIndexed(
  store: InMemoryKnowledgeStore,
  index?: VectorIndex,
): Promise<VectorIndex | undefined> {
  const idx = index ?? getOrCreateVectorIndex();
  if (!idx) return undefined;
  const chunks = store.listChunks().map((c) => ({
    chunk_id: c.chunk_id,
    text: c.text,
    summary: c.summary,
  }));
  await idx.ensureChunks(chunks);
  return idx;
}

export function getSharedEmbeddingClient(): EmbeddingClient | undefined {
  return sharedClient;
}
