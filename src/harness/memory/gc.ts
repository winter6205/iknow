/**
 * auto-memory T2: mechanical memory GC (TTL / supersede / cap eviction).
 *
 * Spec: specs/auto-memory.md D3; ADR-0030 Decision 4. Three mechanical rules,
 * no LLM, soft-disable only:
 *
 *   1. `ttl_days > 0` and `updated_at + ttl_days` elapsed → `disabled: true`
 *   2. a slug named by a live entry's `supersedes` → `disabled: true`
 *   3. active entries beyond the store cap → the lowest-utility ones disabled,
 *      utility = `importance × recency × (1 + recall_count)`
 *
 * GC never deletes a file: a wrong eviction is undone by flipping one
 * frontmatter line back. Repeat calls are idempotent — already-disabled
 * entries are neither re-disabled nor counted against the cap.
 *
 * `planMemoryGc` is pure (no IO, no clock read — `nowMs` is injected) so all
 * five boundary classes are unit-reachable without a tmpdir; `runMemoryGc`
 * is the thin IO shell that scans the store, applies the plan with the same
 * tmp+rename atomic replace `memory_save` uses, and reports what it skipped.
 */
import { MemoryGcOptionInvalid } from "./errors.js";
import { loadUsageSidecar, type UsageSidecar } from "./promote.js";
import type { MemoryEntryV1 } from "./schema.js";
import { listStoreEntries, type StoredMemoryEntry } from "./store.js";
import { writeMemoryEntryAtomic } from "./tools/save.js";

/** Default active-entry ceiling for one project memory store. */
export const DEFAULT_MEMORY_STORE_CAP = 200;

/**
 * Recency half-life in days. Same constant as bm25.ts's recency boost — the
 * two are intentionally the same shape (a memory that scores stale for recall
 * should score stale for eviction) but kept as separate declarations because
 * bm25 ranks read results and GC ranks retention.
 */
const RECENCY_HALFLIFE_DAYS = 30;

/** Why GC disabled an entry. Wire-stable: future versions only add members. */
export type MemoryGcReason = "ttl_expired" | "superseded" | "cap_evicted";

/** One entry offered to GC, keyed by its on-disk slug (filename stem). */
export type MemoryGcCandidate = StoredMemoryEntry;

export interface MemoryGcDisable {
  readonly slug: string;
  readonly reason: MemoryGcReason;
}

export interface MemoryGcPlan {
  /** Slugs to soft-disable, ordered TTL → supersede → cap (lowest utility first). */
  readonly disable: ReadonlyArray<MemoryGcDisable>;
  /** Slugs that stay active, in candidate input order. */
  readonly keep: ReadonlyArray<string>;
}

export interface MemoryGcOptions {
  /** Reference time; defaults to Date.now(). */
  readonly nowMs?: number;
  /** Active-entry ceiling; positive integer. Defaults to DEFAULT_MEMORY_STORE_CAP. */
  readonly cap?: number;
  /** Recall counts for the utility score; `runMemoryGc` reads usage.json when absent. */
  readonly usage?: UsageSidecar;
}

export interface MemoryGcResult {
  readonly disabled: ReadonlyArray<MemoryGcDisable>;
  /** How many `<slug>.md` entries parsed successfully. */
  readonly scanned: number;
  /** Slugs whose file could not be parsed; skipped, not disabled. */
  readonly skipped: ReadonlyArray<string>;
}

/**
 * Retention utility: `importance × recency × (1 + recall_count)`.
 *
 * A negative `importance` yields a negative utility and therefore sorts to
 * the front of the eviction queue — deliberate, not a clamp: an entry marked
 * below the floor is the first thing that should go.
 */
export function memoryEntryUtility(
  entry: MemoryEntryV1,
  recallCount: number,
  nowMs: number
): number {
  return entry.importance * recency(entry.updated_at, nowMs) * (1 + recallCount);
}

/** Plan the three GC rules over a candidate set. Pure: no IO, no clock read. */
export function planMemoryGc(
  candidates: ReadonlyArray<MemoryGcCandidate>,
  opts?: MemoryGcOptions
): MemoryGcPlan {
  const cap = requireCap(opts?.cap);
  const nowMs = opts?.nowMs ?? Date.now();
  const usage = opts?.usage ?? { entries: {} };

  // Rule 0 (idempotence): already-disabled entries leave the pipeline here —
  // they are neither re-disabled nor counted against the cap.
  const live = candidates.filter((c) => !c.entry.disabled);

  const disable: MemoryGcDisable[] = [];

  // Rule 1: TTL.
  const expired = new Set(
    live.filter((c) => isExpired(c.entry, nowMs)).map((c) => c.slug)
  );
  for (const slug of [...expired].sort()) {
    disable.push({ slug, reason: "ttl_expired" });
  }

  // Rule 2: supersede. Only live, non-expired entries carry a live pointer —
  // a dead entry's `supersedes` must not keep disabling its target forever.
  const survivors = live.filter((c) => !expired.has(c.slug));
  const supersededTargets = new Set<string>();
  const survivorSlugs = new Set(survivors.map((c) => c.slug));
  for (const c of survivors) {
    const target = c.entry.supersedes;
    if (target !== null && target !== c.slug && survivorSlugs.has(target)) {
      supersededTargets.add(target);
    }
  }
  for (const slug of [...supersededTargets].sort()) {
    disable.push({ slug, reason: "superseded" });
  }

  // Rule 3: cap. Rank what is left by utility descending; everything past the
  // cap is evicted lowest-utility first. Ties break on slug so the verdict
  // does not depend on directory scan order.
  const active = survivors.filter((c) => !supersededTargets.has(c.slug));
  const ranked = active
    .map((c) => ({
      slug: c.slug,
      utility: memoryEntryUtility(
        c.entry,
        usage.entries[c.slug]?.recall_count ?? 0,
        nowMs
      ),
    }))
    .sort((a, b) => b.utility - a.utility || a.slug.localeCompare(b.slug));
  const evicted = new Set(ranked.slice(cap).map((r) => r.slug));
  for (const r of ranked.slice(cap).reverse()) {
    disable.push({ slug: r.slug, reason: "cap_evicted" });
  }

  return {
    disable,
    keep: active.filter((c) => !evicted.has(c.slug)).map((c) => c.slug),
  };
}

/**
 * Scan a memory store, plan GC, and write the plan back as soft-disables.
 *
 * A missing / unreadable directory is an empty store, not a failure: GC is a
 * maintenance pass that must be safe to call before anything has been saved.
 * Individual unparseable entries are reported in `skipped` and left untouched
 * (mirrors the per-slug skip in promote.ts / tools/recall.ts).
 */
export async function runMemoryGc(
  memoryDir: string,
  opts?: MemoryGcOptions
): Promise<MemoryGcResult> {
  const scan = await listStoreEntries(memoryDir);
  if (scan.entries.length === 0) {
    return { disabled: [], scanned: 0, skipped: scan.skipped };
  }
  const usage = opts?.usage ?? (await loadUsageSidecar(memoryDir));
  const plan = planMemoryGc(scan.entries, { ...opts, usage });
  const bySlug = new Map(scan.entries.map((c) => [c.slug, c.entry]));
  for (const action of plan.disable) {
    const entry = bySlug.get(action.slug);
    if (!entry) continue;
    await writeMemoryEntryAtomic(memoryDir, action.slug, {
      ...entry,
      disabled: true,
    });
  }
  return {
    disabled: plan.disable,
    scanned: scan.entries.length,
    skipped: scan.skipped,
  };
}

// -- helpers (not exported; index.ts re-export policy) -----------------------

/** True when ttl_days > 0 and updated_at + ttl_days has elapsed. */
function isExpired(entry: MemoryEntryV1, nowMs: number): boolean {
  if (!entry.ttl_days || entry.ttl_days <= 0) return false;
  if (!entry.updated_at) return false;
  const t = Date.parse(entry.updated_at);
  if (!Number.isFinite(t)) return false;
  return nowMs >= t + entry.ttl_days * 24 * 3600 * 1000;
}

/** Decay in (0, 1]; an unparseable timestamp scores as maximally stale. */
function recency(updatedAt: string, nowMs: number): number {
  if (!updatedAt) return 0;
  const t = Date.parse(updatedAt);
  if (!Number.isFinite(t)) return 0;
  const ageDays = Math.max(0, (nowMs - t) / (24 * 3600 * 1000));
  return 1 / (1 + ageDays / RECENCY_HALFLIFE_DAYS);
}

function requireCap(cap: number | undefined): number {
  if (cap === undefined) return DEFAULT_MEMORY_STORE_CAP;
  if (!Number.isInteger(cap) || cap < 1) {
    throw new MemoryGcOptionInvalid(
      `memory gc: cap must be a positive integer, got ${String(cap)}`
    );
  }
  return cap;
}

