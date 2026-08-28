/**
 * #121 T2: src/harness/memory/ public exports.
 *
 * Spec: specs/121-memory-injection.md (Project Structure index.ts — public
 * exports for harness + tests). Re-exports only the public API; sanitize's
 * internal helpers (per-entry validation, coercion) are NOT exported.
 */
export { resolveProjectMemoryDir, resolveUserMemoryDir } from "./paths.js";

export type { MemoryEntryV1, MemoryFileV1, MemoryType } from "./schema.js";
export {
  CURRENT_MEMORY_SCHEMA_VERSION,
  DEFAULT_MEMORY_TYPE,
  MEMORY_TYPES,
  defaultMemoryEntry,
  normalizeMemoryType,
  sanitizeMemoryFile,
} from "./schema.js";

export {
  computeSignature,
  parseMemoryEntry,
  serializeMemoryEntry,
} from "./frontmatter.js";

export {
  MemoryError,
  MemoryExtractError,
  MemoryGcOptionInvalid,
  MemoryIOError,
  MemoryQuarantinedReason,
  MemorySchemaInvalid,
} from "./errors.js";

export { listStoreEntries } from "./store.js";
export type { MemoryStoreScan, StoredMemoryEntry } from "./store.js";

export {
  AUTO_MEMORY_SOURCE,
  MAX_CANDIDATES_PER_INGEST,
  MIN_CANDIDATE_CONFIDENCE,
  buildExtractPrompt,
  decideMemoryOps,
  extractMemoryCandidates,
  ingestMemory,
  persistMemoryOps,
} from "./ingest.js";
export {
  DEFAULT_COMPLETED_TURN_GATE,
  createAutoMemoryHook,
} from "./auto-hook.js";
export type {
  AutoMemoryHook,
  AutoMemoryHookOptions,
  AutoMemoryTurn,
} from "./auto-hook.js";

export type {
  MemoryCandidate,
  MemoryExtractLlm,
  MemoryIngestOptions,
  MemoryIngestResult,
  MemoryOp,
  MemoryOpKind,
  MemoryPersistDeps,
  PersistedMemoryOp,
} from "./ingest.js";

export {
  DEFAULT_MEMORY_STORE_CAP,
  memoryEntryUtility,
  planMemoryGc,
  runMemoryGc,
} from "./gc.js";
export type {
  MemoryGcCandidate,
  MemoryGcDisable,
  MemoryGcOptions,
  MemoryGcPlan,
  MemoryGcReason,
  MemoryGcResult,
} from "./gc.js";

export {
  findProjectAgents,
  findUserAgents,
  listRulesFiles,
} from "./discovery.js";
export type { MemoryLayerEntry } from "./discovery.js";

export { scoreMemoryEntries } from "./bm25.js";
export type { ScoredEntry, ScoreOpts } from "./bm25.js";
export { tokenize } from "./tokenize.js";

export {
  eligibleForPromote,
  listPromotableEntries,
  loadUsageSidecar,
  recordRecall,
  PROMOTE_SEGMENT_CAP,
} from "./promote.js";
export type { SlugUsage, UsageSidecar } from "./promote.js";

export {
  assembleSystemPrompt,
  PRIORITY_DECLARATION,
  EXISTENCE_POINTER,
} from "./assembly.js";
export type { AssemblyContext } from "./assembly.js";
export { createSystemResolver } from "./refresh.js";
