/**
 * auto-memory T2: mechanical memory GC (TTL / supersede / cap eviction).
 *
 * Spec: specs/auto-memory.md D3; ADR-0031 Decision 4; ADR-0086
 * (capability memory sweep). Mechanical rules, no LLM, soft-disable only:
 *
 *   0. `detectCapabilityObservation` trips on title/body → `disabled: true`
 *      (runtime-capability-memory-gate: an environment snapshot must not
 *      survive as durable memory — the live tool result is authoritative)
 *   1. `ttl_days > 0` and `updated_at + ttl_days` elapsed → `disabled: true`
 *   2. a slug named by a live entry's `supersedes` → `disabled: true`
 *   3. active entries beyond the store cap → the lowest-utility ones disabled,
 *      utility = `importance × recency × (1 + recall_count)`
 *
 * GC never deletes a file: a wrong eviction is undone by flipping one
 * frontmatter line back. Repeat calls are idempotent — already-disabled
 * entries are neither re-disabled nor counted against the cap.
 *
 * auto-memory-layering T7: disabled entries eventually leave the hot dir —
 * `disabled: true` + (`updated_at` ≥ 30 days old OR disabled count > cap)
 * moves `<slug>.md` to `memoryDir/archive/<slug>.md` (a rename, not a delete;
 * no hot scan — recall / prefetch / dream / cap / `listStoreEntries` — ever
 * opens `archive/`). The archived slug's MEMORY.md index line is removed so
 * the human index stays truthful (policy pinned by gc.test.ts).
 *
 * `planMemoryGc` is pure (no IO, no clock read — `nowMs` is injected) so all
 * five boundary classes are unit-reachable without a tmpdir; `runMemoryGc`
 * is the thin IO shell that scans the store, applies the plan with the same
 * tmp+rename atomic replace `memory_save` uses, and reports what it skipped.
 * The archive plan (`planMemoryArchive`) is pure the same way; only the
 * rename shell touches the filesystem.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  CAPABILITY_OBSERVATION_REASON,
  detectCapabilityObservation,
} from "./capability-gate.js";
import { MemoryGcOptionInvalid, MemoryIOError } from "./errors.js";
import { loadUsageSidecar, type UsageSidecar } from "./promote.js";
import type { MemoryEntryV1 } from "./schema.js";
import { listStoreEntries, type StoredMemoryEntry } from "./store.js";
import { writeMemoryEntryAtomic } from "./tools/save.js";

/** Default active-entry ceiling for one project memory store. */
export const DEFAULT_MEMORY_STORE_CAP = 200;

/**
 * A disabled entry at least this many days past `updated_at` moves to
 * `memoryDir/archive/` (specs/auto-memory-layering.md — `≥ 30 天`, pinned
 * boundary: exactly 30 days archives).
 */
const ARCHIVE_MIN_AGE_DAYS = 30;

/**
 * Recency half-life in days. Same constant as bm25.ts's recency boost — the
 * two are intentionally the same shape (a memory that scores stale for recall
 * should score stale for eviction) but kept as separate declarations because
 * bm25 ranks read results and GC ranks retention.
 */
const RECENCY_HALFLIFE_DAYS = 30;

/**
 * Why GC disabled an entry. Wire-stable: future versions only add members.
 * `capability_observation` is the sweep half (ADR-0086) — the same pass, a
 * distinct reason so a host can tell "this was an environment snapshot" from
 * "this expired / was superseded / lost the cap". The token's single source
 * is capability-gate.ts, so a sweep verdict and a save rejection can never
 * drift apart.
 */
export type MemoryGcReason =
  | typeof CAPABILITY_OBSERVATION_REASON
  | "ttl_expired"
  | "superseded"
  | "cap_evicted";

/** One entry offered to GC, keyed by its on-disk slug (filename stem). */
export type MemoryGcCandidate = StoredMemoryEntry;

export interface MemoryGcDisable {
  readonly slug: string;
  readonly reason: MemoryGcReason;
}

export interface MemoryGcPlan {
  /**
   * Slugs to soft-disable, ordered capability → TTL → supersede → cap
   * (lowest utility first). The capability verdict leads so a store over cap
   * still sweeps environment snapshots rather than evicting by utility alone.
   */
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
  /**
   * Slugs moved to `memoryDir/archive/` this pass (auto-memory-layering:
   * disabled + ≥30d old, or disabled-count overflow past the cap).
   */
  readonly archived: ReadonlyArray<string>;
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
  return (
    entry.importance * recency(entry.updated_at, nowMs) * (1 + recallCount)
  );
}

/**
 * Rule 0: capability sweep (ADR-0086). A live entry whose title/body trips the
 * same pure predicate `memory_save` rejects with becomes one disable verdict:
 * one verdict, two entry points, so a relabeled observation cannot survive on
 * disk just because it entered before the gate existed. Slug-sorted so the
 * plan never depends on directory scan order.
 */
function capabilitySweep(
  live: ReadonlyArray<MemoryGcCandidate>
): MemoryGcDisable[] {
  return live
    .filter((c) =>
      detectCapabilityObservation({ title: c.entry.title, body: c.entry.body })
    )
    .map((c) => c.slug)
    .sort()
    .map((slug) => ({ slug, reason: CAPABILITY_OBSERVATION_REASON }));
}

/** Plan the mechanical rules over a candidate set. Pure: no IO, no clock read. */
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

  // Rule 0: capability sweep (ADR-0086) — same predicate as the save gate.
  const capability = capabilitySweep(live);
  const capabilitySlugs = new Set(capability.map((d) => d.slug));
  disable.push(...capability);

  // Rule 1: TTL. Capability rows already carry their verdict.
  const expired = new Set(
    live
      .filter((c) => !capabilitySlugs.has(c.slug) && isExpired(c.entry, nowMs))
      .map((c) => c.slug)
  );
  for (const slug of [...expired].sort()) {
    disable.push({ slug, reason: "ttl_expired" });
  }

  // Rule 2: supersede. Only live, non-expired entries carry a live pointer —
  // a dead entry's `supersedes` must not keep disabling its target forever.
  const survivors = live.filter(
    (c) => !expired.has(c.slug) && !capabilitySlugs.has(c.slug)
  );
  const supersededTargets = new Set<string>();
  const survivorSlugs = new Set(survivors.map((c) => c.slug));
  for (const c of survivors) {
    for (const target of c.entry.supersedes ?? []) {
      if (target !== c.slug && survivorSlugs.has(target)) {
        supersededTargets.add(target);
      }
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
 * Scan a memory store, plan GC (capability sweep + TTL / supersede / cap),
 * and write the plan back as soft-disables, then archive disabled entries out
 * of the hot dir.
 *
 * A missing / unreadable directory is an empty store, not a failure: GC is a
 * maintenance pass that must be safe to call before anything has been saved.
 * Individual unparseable entries are reported in `skipped` and left untouched
 * (mirrors the per-slug skip in promote.ts / tools/recall.ts). Archive moves
 * (rename into `archive/`) and the MEMORY.md index rewrite throw the typed
 * `MemoryIOError` on failure — the host's EXIT log-and-continue catches it
 * (specs/auto-memory-layering.md SC15); gc.ts never swallows them.
 */
export async function runMemoryGc(
  memoryDir: string,
  opts?: MemoryGcOptions
): Promise<MemoryGcResult> {
  const scan = await listStoreEntries(memoryDir);
  if (scan.entries.length === 0) {
    return { disabled: [], archived: [], scanned: 0, skipped: scan.skipped };
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
  // Archive pass runs over the post-GC state: everything already disabled on
  // disk plus everything this pass just disabled. Soft-disable preserves
  // `updated_at`, so the scan's parsed entries carry the right timestamps.
  const disabledSlugs = new Set([
    ...scan.entries.filter((c) => c.entry.disabled).map((c) => c.slug),
    ...plan.disable.map((d) => d.slug),
  ]);
  const archivePlan = planMemoryArchive(
    scan.entries.filter((c) => disabledSlugs.has(c.slug)),
    { cap: requireCap(opts?.cap), nowMs: opts?.nowMs ?? Date.now() }
  );
  for (const slug of archivePlan) {
    await archiveEntryFile(memoryDir, slug);
  }
  if (archivePlan.length > 0) {
    await removeMemoryIndexLines(memoryDir, archivePlan);
  }
  return {
    disabled: plan.disable,
    archived: archivePlan,
    scanned: scan.entries.length,
    skipped: scan.skipped,
  };
}

// -- helpers (not exported; index.ts re-export policy) -----------------------

/**
 * Archive plan over the post-GC disabled set. Pure: no IO, no clock read.
 *
 * Rule A (age): `updated_at` ≥ 30 days old → archive. Unparseable timestamps
 * are not age-eligible (same posture as `isExpired`).
 * Rule B (overflow): when the hot-dir disabled count exceeds the cap, the
 * excess (disabled.length − cap) come from the not-yet-30d ones, archived
 * oldest-`updated_at`-first (unparseable timestamps sort as oldest — same
 * "maximally stale" posture as `recency`), ties broken by slug so the verdict
 * never depends on scan order. Exactly cap-many disabled entries stay hot:
 * only `> cap` archives.
 */
function planMemoryArchive(
  disabled: ReadonlyArray<MemoryGcCandidate>,
  opts: { cap: number; nowMs: number }
): string[] {
  const cutoffMs = opts.nowMs - ARCHIVE_MIN_AGE_DAYS * 24 * 3600 * 1000;
  const ageEligible: string[] = [];
  const recent: MemoryGcCandidate[] = [];
  for (const c of disabled) {
    const t = c.entry.updated_at ? Date.parse(c.entry.updated_at) : NaN;
    if (Number.isFinite(t) && t <= cutoffMs) {
      ageEligible.push(c.slug);
    } else {
      recent.push(c);
    }
  }
  const archived = [...ageEligible.sort()];
  // Overflow is measured against the whole disabled set in the hot dir
  // (specs/auto-memory-layering.md SC13: "热目录 disabled 条数 > store cap");
  // age-eligible entries already archive by rule A, the excess comes from the
  // not-yet-30d ones, oldest first.
  if (disabled.length > opts.cap && recent.length > 0) {
    const excess = Math.min(disabled.length - opts.cap, recent.length);
    archived.push(
      ...[...recent]
        .sort(
          (a, b) =>
            tsOrZero(a.entry) - tsOrZero(b.entry) ||
            a.slug.localeCompare(b.slug)
        )
        .slice(0, excess)
        .map((c) => c.slug)
        .sort()
    );
  }
  return archived;
}

/** `Date.parse(updated_at)`, or 0 (oldest) when missing / unparseable. */
function tsOrZero(entry: MemoryEntryV1): number {
  const t = entry.updated_at ? Date.parse(entry.updated_at) : NaN;
  return Number.isFinite(t) ? t : 0;
}

/**
 * Move one hot `<slug>.md` into `memoryDir/archive/` via rename. Idempotent:
 * a slug already gone from the hot dir is an archived no-op, and rename
 * either lands the complete file or nothing (SC14 — no half-files). Missing
 * `archive/` is created; a non-directory `archive/` path surfaces as the
 * typed `MemoryIOError` (SC15).
 */
async function archiveEntryFile(
  memoryDir: string,
  slug: string
): Promise<void> {
  const srcPath = join(memoryDir, `${slug}.md`);
  const archiveDir = join(memoryDir, "archive");
  try {
    await readFile(srcPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return; // already archived — idempotent replay
    }
    throw new MemoryIOError(`[memory_gc] read ${srcPath} failed`, {
      cause: error,
    });
  }
  try {
    await mkdir(archiveDir, { recursive: true });
    await rename(srcPath, join(archiveDir, `${slug}.md`));
  } catch (error) {
    throw new MemoryIOError(`[memory_gc] archive ${slug}.md failed`, {
      cause: error,
    });
  }
}

/**
 * Remove each archived slug's link line from MEMORY.md so the human index
 * never points into `archive/` (specs/auto-memory-layering.md: "对应行删除
 * 或忽略失效链" — this implementation deletes the line; pinned by
 * gc.test.ts). Missing MEMORY.md is a no-op; unchanged content is not
 * rewritten. Same tmp+rename atomic replace as `upsertMemoryIndex`.
 */
async function removeMemoryIndexLines(
  memoryDir: string,
  slugs: ReadonlyArray<string>
): Promise<void> {
  const indexPath = join(memoryDir, "MEMORY.md");
  let existing: string;
  try {
    existing = await readFile(indexPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new MemoryIOError(`[memory_gc] read MEMORY.md failed`, {
      cause: error,
    });
  }
  const patterns = slugs.map((slug) => `(${slug}.md)`);
  const next = existing
    .split("\n")
    .filter((line) => !patterns.some((p) => line.includes(p)))
    .join("\n");
  if (next === existing) return;
  const tmpPath = `${indexPath}.${process.pid}.${Date.now()}.gc.tmp`;
  try {
    await writeFile(tmpPath, next, "utf8");
    await rename(tmpPath, indexPath);
  } catch (error) {
    throw new MemoryIOError(`[memory_gc] MEMORY.md update failed`, {
      cause: error,
    });
  }
}

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
