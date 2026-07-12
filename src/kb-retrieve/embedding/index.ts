export type { EmbeddingClient, ChunkEmbedInput } from "./types.js";
export { OpenAiCompatibleEmbeddingClient } from "./openai-compatible.js";
export { FakeEmbeddingClient } from "./fake.js";
export { cosine, l2normalize } from "./math.js";
export { VectorIndex } from "./vector-index.js";

import { loadIknowEnv, type IknowEnv } from "../../config/env.js";
import { NetworkError } from "../../shared/errors.js";
import { OpenAiCompatibleEmbeddingClient } from "./openai-compatible.js";
import { FakeEmbeddingClient } from "./fake.js";
import { VectorIndex } from "./vector-index.js";
import type { EmbeddingClient } from "./types.js";
import type { InMemoryKnowledgeStore } from "../../knowledge-store/memory-store.js";

/** Shared process-level index (seed once per store lifetime). */
let sharedIndex: VectorIndex | undefined;
let sharedClient: EmbeddingClient | undefined;

/**
 * Build an embedding client from env.
 * @param forceFake use deterministic FakeEmbeddingClient (offline tests)
 * @param env optional preloaded IknowEnv (avoids re-reading dotenv)
 */
export function createEmbeddingClientFromEnv(
  forceFake = false,
  env?: IknowEnv,
): EmbeddingClient | undefined {
  const resolved = env ?? loadIknowEnv();
  if (forceFake) {
    return new FakeEmbeddingClient(resolved.embedding.dims || 32);
  }
  if (resolved.embedding.mode !== "api") return undefined;
  if (!resolved.embedding.apiKey) return undefined;
  return new OpenAiCompatibleEmbeddingClient({
    baseUrl: resolved.embedding.baseUrl,
    apiKey: resolved.embedding.apiKey,
    model: resolved.embedding.model,
    dimensions: resolved.embedding.dimensions,
    timeoutMs: resolved.embedding.timeoutMs,
    dimsHint: resolved.embedding.dims,
  });
}

export function getOrCreateVectorIndex(opts?: {
  forceFake?: boolean;
  client?: EmbeddingClient;
  env?: IknowEnv;
}): VectorIndex | undefined {
  // Explicit client: isolated index, do not touch process singletons.
  if (opts?.client) {
    return new VectorIndex(opts.client);
  }
  if (sharedIndex) return sharedIndex;
  const client = createEmbeddingClientFromEnv(
    opts?.forceFake ?? false,
    opts?.env,
  );
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
  try {
    await idx.ensureChunks(chunks);
    return idx;
  } catch (err) {
    if (err instanceof NetworkError) {
      if (idx === sharedIndex) {
        sharedIndex = undefined;
        sharedClient = undefined;
      }
      return undefined;
    }
    throw err;
  }
}

export function getSharedEmbeddingClient(): EmbeddingClient | undefined {
  return sharedClient;
}
