/**
 * Wire seeded store + optional M1 vector index for live / test paths.
 * Default: embeddings only when env.embedding.mode === "api" (and key present via loadIknowEnv).
 * Suite / CI: pass enableEmbeddings: false (or leave mode off) — no network.
 */
import { createSeededStore } from "../fixtures/seed-kb.js";
import {
  assertOfflineCompatible,
  loadIknowEnv,
  type IknowEnv,
} from "../config/env.js";
import type { InMemoryKnowledgeStore } from "../knowledge-store/memory-store.js";
import type { VectorIndex } from "../kb-retrieve/embedding/vector-index.js";
import {
  ensureStoreIndexed,
  getOrCreateVectorIndex,
} from "../kb-retrieve/embedding/index.js";

export interface CreateIknowRuntimeOptions {
  /** Use FakeEmbeddingClient (offline). Implies enableEmbeddings unless false. */
  forceFakeEmbeddings?: boolean;
  /**
   * When false, never build a vector index (CI / eval suite default path).
   * When true/undefined, index if forceFake or env.embedding.mode === "api".
   */
  enableEmbeddings?: boolean;
}

export interface IknowRuntime {
  store: InMemoryKnowledgeStore;
  vectorIndex: VectorIndex | undefined;
  env: IknowEnv;
}

export async function createIknowRuntime(
  opts?: CreateIknowRuntimeOptions,
): Promise<IknowRuntime> {
  const store = createSeededStore();
  const env = loadIknowEnv();
  // Fail closed: offline CI/eval must not open network LLM or API embeddings.
  // forceFakeEmbeddings is local-only and does not set embedding.mode=api.
  assertOfflineCompatible(env);
  let vectorIndex: VectorIndex | undefined;

  const wantEmbeddings =
    opts?.enableEmbeddings !== false &&
    (opts?.forceFakeEmbeddings === true || env.embedding.mode === "api");

  if (!wantEmbeddings) {
    return { store, vectorIndex: undefined, env };
  }

  try {
    vectorIndex = getOrCreateVectorIndex({
      forceFake: opts?.forceFakeEmbeddings === true,
    });
    if (vectorIndex) {
      await ensureStoreIndexed(store, vectorIndex);
    }
  } catch (err) {
    // Live path: continue keyword-only. Force-fake (tests) rethrow.
    if (opts?.forceFakeEmbeddings === true) {
      throw err;
    }
    vectorIndex = undefined;
  }

  return { store, vectorIndex, env };
}
