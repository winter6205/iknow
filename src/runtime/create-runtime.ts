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
  resetVectorIndexForTests,
} from "../kb-retrieve/embedding/index.js";
import { NetworkError } from "../shared/errors.js";

export interface CreateIknowRuntimeOptions {
  /** Use FakeEmbeddingClient (offline). Implies enableEmbeddings unless false. */
  forceFakeEmbeddings?: boolean;
  /**
   * When false, never build a vector index (CI / eval suite default path).
   * When true/undefined, index if forceFake or env.embedding.mode === "api".
   */
  enableEmbeddings?: boolean;
  /** Prefer preloaded env (avoids double loadIknowEnv; keeps process mutations consistent). */
  env?: IknowEnv;
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
  const env = opts?.env ?? loadIknowEnv();
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
    const created = getOrCreateVectorIndex({
      forceFake: opts?.forceFakeEmbeddings === true,
      env,
    });
    // ensureStoreIndexed returns undefined on NetworkError (and clears shared singleton).
    vectorIndex = created
      ? await ensureStoreIndexed(store, created)
      : undefined;
  } catch (err) {
    // Drop partial shared singleton so the next caller does not reuse a half-built index.
    resetVectorIndexForTests();
    vectorIndex = undefined;
    // Force-fake (tests) always rethrow.
    if (opts?.forceFakeEmbeddings === true) {
      throw err;
    }
    // Live path: only NetworkError falls back to keyword-only; other errors surface.
    if (!(err instanceof NetworkError)) {
      throw err;
    }
  }

  return { store, vectorIndex, env };
}
