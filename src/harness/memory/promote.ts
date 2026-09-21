/**
 * promote.ts (usage.json sidecar + promote eligibility gate).
 *
 * Spec: specs/121-memory-injection.md (Project Structure promote.ts, Testing
 * Strategy promote half. usage.json accumulates recall counts + distinct
 * session_id tracking; recall_count ≥ 2 distinct session_id → eligibleForPromote.
 *
 * Sidecar JSON shape (v0 — implementation choice, recorded for downstream):
 *   {
 *     entries: {
 *       [slug: string]: {
 *         recall_count: number,
 *         sessions: string[]    // distinct session_ids
 *       }
 *     }
 *   }
 *
 * Sidecar writes are explicit (single read+write per recordRecall); no caching,
 * no background flush. Spec OQ4 leaves cross-process locking to a future ticket.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MemoryIOError, MemorySchemaInvalid } from "./errors.js";
import type { MemoryEntryV1 } from "./schema.js";

export interface SlugUsage {
  readonly recall_count: number;
  readonly sessions: ReadonlyArray<string>;
}

export interface UsageSidecar {
  readonly entries: Readonly<Record<string, SlugUsage>>;
}

const USAGE_FILENAME = "usage.json";
const PROMOTE_THRESHOLD = 2;
/** SC 10 cap for the promote segment in assembly. */
export const PROMOTE_SEGMENT_CAP = 4000;

/** Read usage.json from a memory dir; create an empty one if absent. */
export async function loadUsageSidecar(
  memoryDir: string
): Promise<UsageSidecar> {
  const file = join(memoryDir, USAGE_FILENAME);
  try {
    const buf = await readFile(file, "utf8");
    const parsed: unknown = JSON.parse(buf);
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      !("entries" in parsed)
    ) {
      throw new MemorySchemaInvalid("usage.json");
    }
    const entries = (parsed as { entries: unknown }).entries;
    if (
      entries === null ||
      typeof entries !== "object" ||
      Array.isArray(entries)
    ) {
      throw new MemorySchemaInvalid("usage.json");
    }
    const out: Record<string, SlugUsage> = {};
    for (const [slug, raw] of Object.entries(
      entries as Record<string, unknown>
    )) {
      const u = raw as Partial<SlugUsage> | null;
      if (
        !u ||
        typeof u.recall_count !== "number" ||
        !Array.isArray(u.sessions)
      ) {
        throw new MemorySchemaInvalid(`usage.json.entries.${slug}`);
      }
      out[slug] = { recall_count: u.recall_count, sessions: u.sessions };
    }
    return { entries: out };
  } catch (e) {
    if (e instanceof MemorySchemaInvalid) throw e;
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      const empty: UsageSidecar = { entries: {} };
      await writeSidecar(memoryDir, empty);
      return empty;
    }
    throw new MemoryIOError(`promote: load ${file} failed`, { cause: e });
  }
}

/** Atomically replace usage.json (tmp + rename) so concurrent writes do not corrupt. */
async function writeSidecar(
  memoryDir: string,
  sidecar: UsageSidecar
): Promise<void> {
  await mkdir(memoryDir, { recursive: true });
  const file = join(memoryDir, USAGE_FILENAME);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(sidecar, null, 2), "utf8");
  const { rename } = await import("node:fs/promises");
  await rename(tmp, file);
}

/** Increment recall count for slug; track session_id distinct. */
export async function recordRecall(
  memoryDir: string,
  slug: string,
  sessionId: string
): Promise<void> {
  const sidecar = await loadUsageSidecar(memoryDir);
  const cur = sidecar.entries[slug] ?? { recall_count: 0, sessions: [] };
  const sessions = cur.sessions.includes(sessionId)
    ? cur.sessions
    : [...cur.sessions, sessionId];
  const next: UsageSidecar = {
    entries: {
      ...sidecar.entries,
      [slug]: { recall_count: cur.recall_count + 1, sessions },
    },
  };
  await writeSidecar(memoryDir, next);
}

/** Promote gate: ≥ PROMOTE_THRESHOLD distinct sessions. */
export function eligibleForPromote(
  sidecar: UsageSidecar,
  slug: string
): boolean {
  const u = sidecar.entries[slug];
  if (!u) return false;
  return u.sessions.length >= PROMOTE_THRESHOLD;
}

/** True when ttl_days > 0 and updated_at + ttl_days has elapsed. */
function isExpired(entry: MemoryEntryV1, nowMs: number): boolean {
  if (!entry.ttl_days || entry.ttl_days <= 0) return false;
  if (!entry.updated_at) return false;
  const t = Date.parse(entry.updated_at);
  if (!Number.isFinite(t)) return false;
  const expiresAt = t + entry.ttl_days * 24 * 3600 * 1000;
  return nowMs >= expiresAt;
}

/**
 * Return all eligible entries ordered by importance desc, sized to fit within
 * the promote segment cap. Skips disabled + ttl-expired entries.
 *
 * Strategy (implementation choice): importance desc; cumulative size is the
 * serialized (frontmatter + title + body) byte count; we fill from the top
 * until adding the next entry would exceed PROMOTE_SEGMENT_CAP.
 */
export async function listPromotableEntries(
  memoryDir: string,
  entries?: ReadonlyArray<MemoryEntryV1>
): Promise<ReadonlyArray<MemoryEntryV1>> {
  const nowMs = Date.now();
  const sidecar = await loadUsageSidecar(memoryDir);
  const pool: ReadonlyArray<{ slug: string; entry: MemoryEntryV1 }> = entries
    ? entries.map((entry) => ({ slug: entry.id, entry }))
    : await loadEntries(memoryDir);
  const eligible = pool
    .filter((p) => !p.entry.disabled && !isExpired(p.entry, nowMs))
    .filter((p) => eligibleForPromote(sidecar, p.slug))
    .slice()
    .sort(
      (a, b) =>
        b.entry.importance - a.entry.importance || a.slug.localeCompare(b.slug)
    );

  const out: MemoryEntryV1[] = [];
  let used = 0;
  for (const p of eligible) {
    const size = approxEntrySize(p.entry);
    if (used + size > PROMOTE_SEGMENT_CAP && out.length > 0) break;
    out.push(p.entry);
    used += size;
  }
  return out;
}

/** Read all *.md entries from the memory dir, paired with their slug (filename stem). */
async function loadEntries(
  memoryDir: string
): Promise<ReadonlyArray<{ slug: string; entry: MemoryEntryV1 }>> {
  const { opendir } = await import("node:fs/promises");
  const { readFile } = await import("node:fs/promises");
  const { parseMemoryEntry } = await import("./frontmatter.js");
  const out: Array<{ slug: string; entry: MemoryEntryV1 }> = [];
  let dir;
  try {
    dir = await opendir(memoryDir);
  } catch {
    return [];
  }
  // for await over a Dir auto-closes the handle on completion; an explicit
  // close() in finally throws "Directory handle was closed".
  for await (const e of dir) {
    if (!e.name.endsWith(".md") || e.name === "MEMORY.md") continue;
    try {
      const buf = await readFile(join(memoryDir, e.name), "utf8");
      out.push({ slug: e.name.slice(0, -3), entry: parseMemoryEntry(buf) });
    } catch {
      // skip malformed files; assembly surfaces errors only for top-level
      // read, not per-slug scans (bad frontmatter is skipped).
      continue;
    }
  }
  return out;
}

/** Cheap byte estimate: title + body + frontmatter overhead. */
function approxEntrySize(e: MemoryEntryV1): number {
  return e.title.length + e.body.length + 64;
}
