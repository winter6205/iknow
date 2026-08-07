/**
 * #121 T3: bm25.ts (keyword heuristic scoring — pure function, no IO).
 *
 * Spec: specs/121-memory-injection.md (Project Structure bm25.ts, Testing
 * Strategy bm25 half). OpenHarness memory/search.py:15-50 同款启发式
 * (metadata 命中 2x + body 1x + importance 加权 + recency_boost + 排序稳定).
 *
 * Score formula (v0):
 *   hits_title × TITLE_WEIGHT (2.0)
 *   + hits_body  × BODY_WEIGHT  (1.0)
 *   + importance × IMPORTANCE_WEIGHT (0.4)   [additive — OpenHarness 同款]
 *   + recency_boost (≤ RECENCY_WEIGHT 0.4)
 *
 * Stable sort: descending score, ties broken by input index (Array.prototype.sort
 * is stable in modern V8; we still pre-tag the original index to make the
 * contract explicit and unit-testable).
 */
import type { MemoryEntryV1 } from "./schema.js";

export interface ScoredEntry {
  readonly entry: MemoryEntryV1;
  readonly score: number;
  /** Original input index — tie-breaker for stable ordering. */
  readonly index: number;
}

export interface ScoreOpts {
  /** Reference time for recency decay; defaults to Date.now(). */
  readonly nowMs?: number;
}

const TITLE_WEIGHT = 2.0;
const BODY_WEIGHT = 1.0;
const IMPORTANCE_WEIGHT = 0.4;
const RECENCY_WEIGHT = 0.4;
/** Days → recency weight (1 / (1 + ageDays/RECENCY_HALFLIFE_DAYS)). */
const RECENCY_HALFLIFE_DAYS = 30;

/** Tokenize a string into lowercase word-like tokens (>= 2 chars). */
function tokenize(s: string): readonly string[] {
  if (!s) return [];
  return s
    .toLowerCase()
    .split(/[^a-z0-9_]+/u)
    .filter((t) => t.length >= 2);
}

/** Count how many query tokens appear in haystack. */
function countHits(
  haystack: readonly string[],
  tokens: readonly string[]
): number {
  if (tokens.length === 0 || haystack.length === 0) return 0;
  const set = new Set(haystack);
  let n = 0;
  for (const t of tokens) if (set.has(t)) n++;
  return n;
}

/** Decay function: 1 / (1 + ageDays/halflife). Stable, bounded in (0, 1]. */
function recencyBoost(updatedAt: string, nowMs: number): number {
  if (!updatedAt) return 0;
  const t = Date.parse(updatedAt);
  if (!Number.isFinite(t)) return 0;
  const ageDays = Math.max(0, (nowMs - t) / (24 * 3600 * 1000));
  return 1 / (1 + ageDays / RECENCY_HALFLIFE_DAYS);
}

/**
 * Score entries against a query and return them sorted descending by score
 * (stable: equal scores preserve input order).
 *
 * - Empty query / single-character query → []
 * - Empty entries → []
 */
export function scoreMemoryEntries(
  query: string,
  entries: ReadonlyArray<MemoryEntryV1>,
  opts?: ScoreOpts
): ReadonlyArray<ScoredEntry> {
  const tokens = tokenize(query);
  if (tokens.length === 0) return [];
  const nowMs = opts?.nowMs ?? Date.now();

  const tagged = entries.map((entry, index) => {
    const titleHits = countHits(tokenize(entry.title), tokens);
    const bodyHits = countHits(tokenize(entry.body), tokens);
    const raw =
      titleHits * TITLE_WEIGHT +
      bodyHits * BODY_WEIGHT +
      entry.importance * IMPORTANCE_WEIGHT +
      recencyBoost(entry.updated_at, nowMs) * RECENCY_WEIGHT;
    return { entry, score: raw, index };
  });

  tagged.sort((a, b) => {
    if (a.score === b.score) return a.index - b.index; // stable tie-breaker
    return b.score - a.score;
  });
  return tagged;
}
