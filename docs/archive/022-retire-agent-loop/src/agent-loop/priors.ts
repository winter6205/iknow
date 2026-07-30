import type { PriorChunk } from "../shared/schema.js";

/** Protocol + host cap for prior_chunks (matches conversation MAX_PRIORS). */
export const MAX_PRIOR_CHUNKS = 5;

/**
 * Sanitize host/LLM prior_chunks before kb_retrieve or system appendix.
 * - non-empty chunk_id
 * - non-empty summary after trim
 * - max MAX_PRIOR_CHUNKS (first-seen order)
 */
export function normalizePriors(
  priors: PriorChunk[] | undefined
): PriorChunk[] | undefined {
  if (!priors?.length) return undefined;
  const out: PriorChunk[] = [];
  for (const p of priors) {
    if (out.length >= MAX_PRIOR_CHUNKS) break;
    if (
      typeof p?.chunk_id === "string" &&
      p.chunk_id.length > 0 &&
      typeof p?.summary === "string" &&
      p.summary.trim().length > 0
    ) {
      out.push({ chunk_id: p.chunk_id, summary: p.summary });
    }
  }
  return out.length ? out : undefined;
}
