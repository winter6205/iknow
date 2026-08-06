/**
 * Wire seeded store + env for CLI / test paths.
 */
import { createSeededStore } from "../fixtures/seed-kb.js";
import { loadIknowEnv, type IknowEnv } from "../config/env.js";
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
  const store = createSeededStore();
  return { store, env };
}
