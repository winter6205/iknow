/**
 * Wire seeded store + env for CLI / test paths.
 *
 * 023 retired: vector index / embedding path (was kb_retrieve's optional
 * vector arm). Now bare-bones: store + env; --embeddings CLI flag is
 * retained for surface compatibility but no longer wires a vector index.
 */
import { createSeededStore } from "../fixtures/seed-kb.js";
import {
  assertOfflineCompatible,
  loadIknowEnv,
  type IknowEnv,
} from "../config/env.js";
import type { InMemoryKnowledgeStore } from "../knowledge-store/memory-store.js";

export interface CreateIknowRuntimeOptions {
  /** Prefer preloaded env (avoids double loadIknowEnv; keeps process mutations consistent). */
  env?: IknowEnv;
}

export interface IknowRuntime {
  store: InMemoryKnowledgeStore;
  env: IknowEnv;
}

export async function createIknowRuntime(
  opts?: CreateIknowRuntimeOptions
): Promise<IknowRuntime> {
  const env = opts?.env ?? loadIknowEnv();
  // Fail closed: offline CI/eval must not open network LLM.
  assertOfflineCompatible({ env });
  const store = createSeededStore();
  return { store, env };
}
