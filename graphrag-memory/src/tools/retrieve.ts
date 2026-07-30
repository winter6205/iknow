/**
 * Retrieve tool — semantic search over the knowledge memory store.
 *
 * Pipeline: embed query → vector search with valid_window filter → return ranked chunks.
 * Stage 1: vector-only (no BM25, no reranker, no PPR — stages 2/3).
 */
import { z } from "zod";
import {
  textResult,
  type ToolRegistration,
  type ToolResult,
} from "./registry.js";
import type { EmbeddingClient } from "../core/embedder.js";
import type { SearchOptions, StorageBackend } from "../core/types.js";

const DEFAULT_LIMIT = 10;

export const RetrieveInputSchema = z.object({
  query: z.string().min(1, "query must be a non-empty string"),
  valid_at: z.string().datetime().optional(),
  filters: z.record(z.string(), z.string()).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

export type RetrieveInput = z.infer<typeof RetrieveInputSchema>;

/** Dependencies injected at wiring time (T7). */
export interface RetrieveDeps {
  embedder: EmbeddingClient;
  storage: StorageBackend;
}

export function createRetrieveHandler(deps: RetrieveDeps) {
  return async function retrieveHandler(
    input: RetrieveInput
  ): Promise<ToolResult> {
    // 1. Embed the query text.
    const [queryEmbedding] = await deps.embedder.embed([input.query]);

    // 2. Build search options. Default valid_at to "now" so time-bounded
    //    filtering always has a concrete reference point.
    const opts: SearchOptions = {
      limit: input.limit ?? DEFAULT_LIMIT,
      validAt: input.valid_at ?? new Date().toISOString(),
      ...(input.filters !== undefined ? { filters: input.filters } : {}),
    };

    // 3. Vector search with valid_window + exact-match filters.
    const chunks = await deps.storage.search(queryEmbedding, opts);

    // 4. Project into the tool's wire shape (RetrieveResult).
    return textResult(JSON.stringify({ chunks }));
  };
}

export const retrieveTool = (deps: RetrieveDeps): ToolRegistration => ({
  name: "retrieve",
  description:
    "Semantic search over the knowledge memory store. Returns ranked chunks filtered by temporal validity.",
  inputSchema: RetrieveInputSchema,
  // The registry's erased `ToolRegistrationAny` takes `input: unknown`;
  // the schema validates upstream, so this cast is sound (mirrors echo.ts).
  handler: createRetrieveHandler(
    deps
  ) as unknown as ToolRegistration["handler"],
});
