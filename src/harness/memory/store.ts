/**
 * auto-memory T3: one reader for the on-disk entry store.
 *
 * `<slug>.md` files are the entries; `MEMORY.md` is the human index and
 * `usage.json` is the recall sidecar, so both are skipped. A file that fails
 * to parse is reported in `skipped` rather than thrown — a single corrupt
 * entry must not stall a maintenance or ingest pass (same posture as the
 * per-slug skip in promote.ts / tools/recall.ts).
 *
 * A missing directory reads as an empty store: both callers (GC, ingest) run
 * before anything has necessarily been saved.
 */
import { opendir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { parseMemoryEntry } from "./frontmatter.js";
import type { MemoryEntryV1 } from "./schema.js";

/** One stored entry, keyed by its on-disk slug (filename stem). */
export interface StoredMemoryEntry {
  readonly slug: string;
  readonly entry: MemoryEntryV1;
}

export interface MemoryStoreScan {
  /** Parsed entries, sorted by slug so scan order never leaks into a verdict. */
  readonly entries: ReadonlyArray<StoredMemoryEntry>;
  /** Slugs whose file could not be parsed. */
  readonly skipped: ReadonlyArray<string>;
}

export async function listStoreEntries(
  memoryDir: string
): Promise<MemoryStoreScan> {
  const entries: StoredMemoryEntry[] = [];
  const skipped: string[] = [];
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
    } catch {
      // EXIT: skip-and-report — surfaced to the caller via `skipped`.
      skipped.push(slug);
    }
  }
  entries.sort((a, b) => a.slug.localeCompare(b.slug));
  skipped.sort();
  return { entries, skipped };
}
