/**
 * #121 T2: src/harness/memory/ public exports.
 *
 * Spec: specs/121-memory-injection.md (Project Structure index.ts — public
 * exports for harness + tests). Re-exports only the public API; sanitize's
 * internal helpers (per-entry validation, coercion) are NOT exported.
 */
export { resolveProjectMemoryDir, resolveUserMemoryDir } from "./paths.js";

export type { MemoryEntryV1, MemoryFileV1 } from "./schema.js";
export {
  CURRENT_MEMORY_SCHEMA_VERSION,
  defaultMemoryEntry,
  sanitizeMemoryFile,
} from "./schema.js";

export {
  computeSignature,
  parseMemoryEntry,
  serializeMemoryEntry,
} from "./frontmatter.js";

export {
  MemoryError,
  MemoryIOError,
  MemoryQuarantinedReason,
  MemorySchemaInvalid,
} from "./errors.js";

export {
  findProjectAgents,
  findUserAgents,
  listRulesFiles,
} from "./discovery.js";
export type { MemoryLayerEntry } from "./discovery.js";

export { scoreMemoryEntries } from "./bm25.js";
export type { ScoredEntry, ScoreOpts } from "./bm25.js";

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
