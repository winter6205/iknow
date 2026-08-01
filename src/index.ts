/**
 * iknow — standalone enterprise KB agent toolkit.
 * Runtime has zero dependency on any upstream host package or local reference clone.
 */

export { InMemoryKnowledgeStore } from "./knowledge-store/memory-store.js";
export type {
  ChunkRecord,
  DocumentRecord,
  FactRecord,
} from "./knowledge-store/types.js";

export {
  createSeededStore,
  seedEnterpriseKb,
  seedDemoKnowledge,
} from "./fixtures/seed-kb.js";

export { loadIknowEnv, getApiKey } from "./config/env.js";
export type { IknowEnv, LlmEnv } from "./config/env.js";

export { createIknowRuntime } from "./runtime/create-runtime.js";
export type {
  CreateIknowRuntimeOptions,
  IknowRuntime,
} from "./runtime/create-runtime.js";

export type * from "./shared/schema.js";
export {
  IknowError,
  ValidationError,
  NotFoundError,
  isIknowError,
} from "./shared/errors.js";
export type { IknowErrorCode } from "./shared/errors.js";
export { sha256Hex, buildSnapshotId, contentHash } from "./shared/hash.js";
