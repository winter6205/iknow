/**
 * Ingest tool — writes text content into the memory store.
 *
 * Pipeline: validate → size check → chunk → embed → store.
 * Stage 1: no triple extraction, no entity resolution (stage 3).
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  textResult,
  type ToolRegistration,
  type ToolResult,
} from "./registry.js";
import { chunkText } from "../core/chunker.js";
import type { EmbeddingClient } from "../core/embedder.js";
import type { ChunkRecord, StorageBackend } from "../core/types.js";
import { GraphragError, MAX_CONTENT_BYTES } from "../core/errors.js";

/**
 * Zod schema for the ingest input. Mirrors `IngestInput` in core/types.ts
 * but with validation rules attached.
 *
 * - `content` and `source_ref`: non-empty strings.
 * - `metadata`: optional string-keyed map of unknown values.
 * - `valid_from` / `valid_until`: optional ISO 8601 datetimes. The semantic
 *   check (valid_from < valid_until) lives in the handler, not the schema,
 *   because it depends on cross-field comparison.
 */
export const IngestInputSchema = z.object({
  content: z.string().min(1, "content must be a non-empty string"),
  source_ref: z.string().min(1, "source_ref must be a non-empty string"),
  metadata: z.record(z.string(), z.unknown()).optional(),
  valid_from: z.string().datetime().optional(),
  valid_until: z.string().datetime().optional(),
});

/** Inferred TypeScript type for the parsed ingest input. */
export type IngestInput = z.infer<typeof IngestInputSchema>;

/** Dependencies injected at wiring time (T7). */
export interface IngestDeps {
  embedder: EmbeddingClient;
  storage: StorageBackend;
}

/**
 * Build the ingest handler with the given dependencies closed over.
 *
 * Order of checks (and why this order):
 *  1. Schema — already done by Zod before the handler runs.
 *  2. Size — cheap byte-length check, prevents the expensive chunk/embed
 *     pipeline from running on a multi-MB payload.
 *  3. Semantic — valid_from < valid_until. Must be explicit (a `>=` window
 *     would be either always-empty or instant-expiry, both bugs).
 *  4. Chunk → embed → upsert.
 */
export function createIngestHandler(deps: IngestDeps) {
  return async function ingestHandler(input: IngestInput): Promise<ToolResult> {
    // 1. Size check: reject payloads above MAX_CONTENT_BYTES before doing
    //    any work. Buffer.byteLength gives UTF-8 byte count, not char count
    //    — which is what the cap actually limits.
    const byteLength = Buffer.byteLength(input.content, "utf8");
    if (byteLength > MAX_CONTENT_BYTES) {
      throw new GraphragError(
        `ingest: content size ${byteLength} bytes exceeds limit ${MAX_CONTENT_BYTES} (1MB)`,
        "CONTENT_TOO_LARGE"
      );
    }

    // 2. Semantic check: valid_from must be strictly before valid_until when
    //    both are present. A reversed or zero-width window is almost always
    //    a caller bug — we surface it as INVALID_INPUT so the host can fix
    //    the call instead of silently storing an empty window.
    if (input.valid_from && input.valid_until) {
      const fromMs = Date.parse(input.valid_from);
      const untilMs = Date.parse(input.valid_until);
      if (Number.isNaN(fromMs) || Number.isNaN(untilMs)) {
        // Zod's .datetime() should have caught this, but defend in depth:
        // a hand-built Input (or a future schema regression) should not
        // silently pass.
        throw new GraphragError(
          "ingest: valid_from / valid_until are not valid ISO 8601 timestamps",
          "INVALID_INPUT"
        );
      }
      if (fromMs >= untilMs) {
        throw new GraphragError(
          "ingest: valid_from must be strictly before valid_until",
          "INVALID_INPUT"
        );
      }
    }

    // 3. Chunk. chunkText returns [] for an empty string, but the schema
    //    already rejects empty content, so this is defense-in-depth.
    const chunks = chunkText(input.content);
    if (chunks.length === 0) {
      throw new GraphragError(
        "ingest: chunker produced zero chunks (empty content after validation)",
        "INVALID_INPUT"
      );
    }

    // 4. Embed. The embedder is contractually responsible for throwing
    //    GraphragError(EMBEDDING_FAILED | EMBEDDING_DIM_MISMATCH) on failure.
    const embeddings = await deps.embedder.embed(chunks.map((c) => c.text));

    // 5. Build ChunkRecord[] with new ids and ingest-time metadata.
    //    `valid_from` defaults to now (UTC ISO 8601) when not provided.
    //    `valid_until` defaults to null (forever valid).
    //    `created_at` is set to the same instant as the default `valid_from`
    //    so the two are consistent when the caller omits both.
    const now = new Date().toISOString();
    const validFrom = input.valid_from ?? now;
    const validUntil = input.valid_until ?? null;
    const records: ChunkRecord[] = chunks.map((chunk, i) => ({
      id: randomUUID(),
      content: chunk.text,
      embedding: embeddings[i]!,
      source_ref: input.source_ref,
      metadata: input.metadata ?? {},
      valid_from: validFrom,
      valid_until: validUntil,
      created_at: now,
    }));

    // 6. Store. upsert returns the chunk ids in input order — we relay
    //    them as the tool result so callers can correlate or reference
    //    them later.
    const ids = await deps.storage.upsert(records);

    // 7. Return: textResult(JSON.stringify({ chunk_ids: ids })). The
    //    shape matches the host's text-content convention.
    return textResult(JSON.stringify({ chunk_ids: ids }));
  };
}

/**
 * Wire the ingest tool into the registry. The handler is closed over `deps`
 * so the tool stays a static registration from the registry's perspective.
 */
export const ingestTool = (deps: IngestDeps): ToolRegistration => ({
  name: "ingest",
  description:
    "Ingest text content into the knowledge memory store. " +
    "Chunks, embeds, and stores with optional temporal validity.",
  inputSchema: IngestInputSchema,
  // The registry's handler signature is `(input: unknown) => ...` (the
  // generic is erased at the boundary so the registry stays a single
  // `ToolRegistrationAny` map). Each tool's real handler is typed against
  // its own Zod schema; the cast mirrors echo.ts.
  handler: createIngestHandler(deps) as unknown as ToolRegistration["handler"],
});
