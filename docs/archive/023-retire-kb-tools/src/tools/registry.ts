import type { InMemoryKnowledgeStore } from "../knowledge-store/memory-store.js";
import type {
  KbCompileInput,
  KbGovernanceInput,
  KbRetrieveInput,
  KbVerifyCitationInput,
  SessionContext,
} from "../shared/schema.js";
import { kbRetrieve } from "../kb-retrieve/retrieve.js";
import type { VectorIndex } from "../kb-retrieve/embedding/vector-index.js";
import { kbVerifyCitation } from "../kb-verify/verify.js";
import { kbCompile } from "../kb-compile/compile.js";
import { kbGovernance } from "../kb-governance/governance.js";

export interface ToolRegistryOptions {
  /** Optional embedding vector index for kb_retrieve vector arm. */
  vectorIndex?: VectorIndex;
}

/**
 * Thin facade: bind the 4 protocol tools to a store + session.
 * Harness injects caller role via SessionContext.
 */
export function createToolRegistry(
  store: InMemoryKnowledgeStore,
  session: SessionContext,
  options?: ToolRegistryOptions,
) {
  const retrieveOpts = options?.vectorIndex
    ? { vectorIndex: options.vectorIndex }
    : undefined;
  return {
    kb_retrieve: (input: KbRetrieveInput) =>
      kbRetrieve(store, input, session, retrieveOpts),
    kb_verify_citation: (input: KbVerifyCitationInput) =>
      kbVerifyCitation(store, input),
    kb_compile: (input: KbCompileInput) => kbCompile(store, input),
    kb_governance: (input: KbGovernanceInput) =>
      kbGovernance(store, input, session),
  };
}

export type ToolRegistry = ReturnType<typeof createToolRegistry>;
