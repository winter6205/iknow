/**
 * auto-memory T3: one reader for the on-disk entry store.
 *
 * `<slug>.md` files are the entries; `MEMORY.md` is the human index and
 * `usage.json` is the recall sidecar, so both are skipped. A file that fails
 * to read or parse is quarantined into a structured `skipped` record — slug
 * plus machine-usable reason category, never file content — rather than
 * thrown: a single corrupt entry must not stall a maintenance or ingest pass
 * (same posture as the per-slug skip in promote.ts / tools/recall.ts).
 *
 * A missing directory reads as an empty store: both callers (GC, ingest) run
 * before anything has necessarily been saved.
 */
import { opendir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { MemorySchemaInvalid } from "./errors.js";
import { parseMemoryEntry } from "./frontmatter.js";
import type { MemoryEntryV1 } from "./schema.js";

/** One stored entry, keyed by its on-disk slug (filename stem). */
export interface StoredMemoryEntry {
  readonly slug: string;
  readonly entry: MemoryEntryV1;
}

/**
 * One quarantined file: slug plus a machine-usable reason category, never
 * file content (wire-stable tokens — future versions only add categories).
 */
export interface MemoryStoreSkip {
  readonly slug: string;
  readonly reason: string;
}

export interface MemoryStoreScan {
  /** Parsed entries, sorted by slug so scan order never leaks into a verdict. */
  readonly entries: ReadonlyArray<StoredMemoryEntry>;
  /** Files the reader could not parse, sorted by slug. */
  readonly skipped: ReadonlyArray<MemoryStoreSkip>;
}

export async function listStoreEntries(
  memoryDir: string
): Promise<MemoryStoreScan> {
  const entries: StoredMemoryEntry[] = [];
  const skipped: MemoryStoreSkip[] = [];
  let dir;
  try {
    dir = await opendir(memoryDir);
  } catch {
    // EXIT: missing store == empty store. Neither GC nor ingest may create
    // the directory as a side effect of reading it.
    return { entries, skipped };
  }
  // for await over a Dir auto-closes the handle (promote.ts precedent).
  for await (const e of dir) {
    if (!e.isFile()) continue;
    if (!e.name.endsWith(".md") || e.name === "MEMORY.md") continue;
    const slug = e.name.slice(0, -3);
    try {
      entries.push({
        slug,
        entry: parseMemoryEntry(
          await readFile(join(memoryDir, e.name), "utf8")
        ),
      });
    } catch (error) {
      // EXIT: skip-and-report — structured {slug, reason} surfaced to the
      // caller via `skipped`; bytes on disk stay untouched.
      skipped.push({ slug, reason: classifySkip(error) });
    }
  }
  entries.sort((a, b) => a.slug.localeCompare(b.slug));
  skipped.sort((a, b) => a.slug.localeCompare(b.slug));
  return { entries, skipped };
}

/**
 * Failure category for a quarantined file: the reader's typed quarantine
 * throw (`frontmatter_unreadable`, the case that keeps the file preserved)
 * versus a read-side fault carrying its errno code. Categories only —
 * neither the exception message nor file content may ride along.
 */
function classifySkip(error: unknown): string {
  if (error instanceof MemorySchemaInvalid) return "frontmatter_unreadable";
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === "string" ? `read_failed:${code}` : "read_failed";
}

/**
 * Consumer warn seam: one aggregated line per scan run naming every skipped
 * slug and its reason category — never content, same posture as the other
 * `[memory/*]` warns. Each scan consumer calls it exactly once.
 */
export function warnSkippedEntries(
  prefix: string,
  skipped: ReadonlyArray<MemoryStoreSkip>
): void {
  if (skipped.length === 0) return;
  const summary = skipped.map((s) => `${s.slug}.md=${s.reason}`).join(", ");
  console.warn(`${prefix} skipped unparseable entries: ${summary}`);
}
