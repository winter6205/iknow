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

export { kbRetrieve } from "./kb-retrieve/retrieve.js";
export { rrfFusion, RRF_K } from "./kb-retrieve/rrf.js";
export { scoreKeyword, scoreOverlap, tokenize } from "./kb-retrieve/keyword.js";
export { kbVerifyCitation } from "./kb-verify/verify.js";
export { kbCompile } from "./kb-compile/compile.js";
export { kbGovernance } from "./kb-governance/governance.js";

export { IknowAgent, IknowAgentLoop, MAX_HOPS } from "./agent-loop/loop.js";
export {
  createSession,
  createManagerSession,
  createAdminSession,
  createDegradedSession,
  isPrivilegedRole,
  withRole,
} from "./agent-loop/session.js";

export { createToolRegistry } from "./tools/registry.js";
export type { ToolRegistry } from "./tools/registry.js";

export {
  createSeededStore,
  seedEnterpriseKb,
  seedDemoKnowledge,
} from "./fixtures/seed-kb.js";

export type * from "./shared/schema.js";
export * from "./shared/errors.js";
export { sha256Hex, buildSnapshotId, contentHash } from "./shared/hash.js";
