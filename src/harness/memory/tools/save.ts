/**
 * #121 T5: memory_save tool (write-side, atomic).
 *
 * Spec: specs/121-memory-injection.md (Project Structure tools/save.ts,
 * Testing Strategy tools-save half, SC 6/7/9). Registered by build-engine T6;
 * here only the bounded-context-local definition + AciMeta (save = write /
 * block / default per T1 decision).
 *
 * Contract (SC 6/7/9):
 *   - input `{ title, body, type?, importance? }`; importance ∈ 1..5 (default 1)
 *   - affirmative phrasing rejection: any of `don't`/`never`/`禁止`/`不要`/
 *     `不能`/body starting with `not ` (case-insensitive word match) → typed
 *     MemoryError before any disk mutation (spec SC 9)
 *   - runtime capability persist gate (runtime-capability-memory-gate T2 /
 *     ADR-0086): a runtime capability / environment-availability observation
 *     → typed `MemoryCapabilityRejected` before any disk mutation; product
 *     policy constraints and conventions still pass
 *   - atomic write (tmp/rename): every rename lands a complete file or no file
 *     (concurrent saves cannot interleave a partial entry — 5 boundary class)
 *   - frontmatter auto-writes 6 fields + current timestamp
 *   - slug = 12 hex chars from node:crypto randomBytes (collision-safe under
 *     concurrent save — implementation choice, spec leaves open)
 *   - MEMORY.md index is appended (and previous lines preserved)
 *
 * Injection seam (web tool precedent): `now` / `randomBytes` for deterministic
 * tests. `now` returns an ISO-8601 string per MemoryEntryV1.updated_at; the
 * default is the real clock.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

import type { AciToolDef } from "../../aci/types.js";
import {
  MemoryCapabilityRejected,
  MemoryError,
  MemoryIOError,
  MemorySchemaInvalid,
} from "../errors.js";
import {
  CAPABILITY_OBSERVATION_REASON,
  detectCapabilityObservation,
} from "../capability-gate.js";
import { serializeMemoryEntry } from "../frontmatter.js";
import { foldEntryLineBreaks, normalizeMemoryType } from "../schema.js";
import type { MemoryEntryV1 } from "../schema.js";

const DEFAULT_IMPORTANCE = 1;
const MIN_IMPORTANCE = 1;
const MAX_IMPORTANCE = 5;

/** Allowed top-level keys — mirrors the inputSchema + write_file.ts precedent. */
const ALLOWED_KEYS = new Set(["title", "body", "type", "importance"]);

/** Prefix of a successful memory_save tool result (skip-extract detector). */
export const MEMORY_SAVE_PERSISTED_PREFIX = "[memory_save] persisted as";

/** Spec SC 9 locked rejection list. */
const NEGATIVE_FORM_WORDS = ["don't", "never", "禁止", "不要", "不能"];

export interface MemorySaveToolDeps {
  readonly memoryDir: string;
  /** ISO-8601 timestamp for updated_at; defaults to real clock. */
  readonly now?: () => string;
  /** 6 bytes hex = 12 chars; defaults to node:crypto randomBytes. */
  readonly randomBytes?: (n: number) => Buffer;
}

export function createMemorySaveTool(deps: MemorySaveToolDeps): AciToolDef {
  const now = deps.now ?? defaultNow;
  const random = deps.randomBytes ?? ((n: number) => randomBytes(n));
  return Object.freeze({
    name: "memory_save",
    description:
      "Capture a fact worth keeping across sessions (convention, decision, gotcha) after confirming it once; pair with memory_recall first to spot duplicates. Persists `title`/`body`/`type`/`importance` as an atomic file under the per-conversation memory library; entries must use affirmative phrasing (negative-form words reject before any disk mutation); importance 1..5 (default 1).",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        body: { type: "string" },
        type: { type: "string" },
        importance: {
          type: "integer",
          minimum: MIN_IMPORTANCE,
          maximum: MAX_IMPORTANCE,
          default: DEFAULT_IMPORTANCE,
        },
      },
      required: ["title", "body"],
      additionalProperties: false,
    },
    aci: {
      category: "write",
      isConcurrencySafe: false,
      interruptBehavior: "block",
      timeoutTier: "default",
    } as const,
    handler: async (input: unknown) => {
      const params = parseInput(input);
      assertDraftAllowed(params);
      const draft: MemoryEntryV1 = {
        id: "", // filled by serialize from frontmatter; we use slug as canonical key
        type: params.type,
        importance: params.importance,
        ttl_days: 0,
        disabled: false,
        supersedes: null,
        title: params.title,
        body: params.body,
        updated_at: now(),
      };
      const slug = makeSlug(random);
      // The index row is rendered from what the writer actually stored, so the
      // human index can never show a title the file does not hold.
      const written = await writeMemoryEntryAtomic(deps.memoryDir, slug, draft);
      await upsertMemoryIndex(deps.memoryDir, slug, written);
      return `${MEMORY_SAVE_PERSISTED_PREFIX} ${slug}.md`;
    },
  });
}

interface ParsedInput {
  readonly title: string;
  readonly body: string;
  readonly type: string;
  readonly importance: number;
}

function parseInput(input: unknown): ParsedInput {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new MemoryError("[memory_save] input must be an object");
  }
  const raw = input as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!ALLOWED_KEYS.has(key)) {
      throw new MemoryError(`[memory_save] unknown field: ${key}`);
    }
  }
  if (typeof raw.title !== "string" || raw.title.length === 0) {
    throw new MemoryError("[memory_save] title must be a non-empty string");
  }
  if (typeof raw.body !== "string" || raw.body.length === 0) {
    throw new MemoryError("[memory_save] body must be a non-empty string");
  }
  // Closed enum (#731): an illegal or absent type degrades to `note` rather
  // than failing the write — a mislabeled fact is still worth keeping.
  const type = normalizeMemoryType(raw.type);
  const importance =
    raw.importance === undefined
      ? DEFAULT_IMPORTANCE
      : requireImportance(raw.importance);
  return { title: raw.title, body: raw.body, type, importance };
}

/**
 * The two persist gates, in their pinned order: affirmative phrasing (spec
 * SC 9) first, then the runtime capability gate (ADR-0086). `parseInput` has
 * already rejected empty / malformed input, and nothing may touch disk until
 * both pass. The capability arm throws rather than dropping because
 * `memory_save` is a foreground tool call the model must learn from.
 */
function assertDraftAllowed(params: ParsedInput): void {
  const reason = validateAffirmativePhrasing(params.title, params.body);
  if (reason !== null) {
    throw new MemoryError(`[memory_save] rejected: negative_form — ${reason}`);
  }
  const capabilityReason = detectCapabilityObservation({
    title: params.title,
    body: params.body,
  });
  if (capabilityReason !== null) {
    throw new MemoryCapabilityRejected(
      CAPABILITY_OBSERVATION_REASON,
      capabilityReason
    );
  }
}

function requireImportance(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < MIN_IMPORTANCE ||
    value > MAX_IMPORTANCE
  ) {
    throw new MemoryError(
      `[memory_save] importance must be an integer in ${MIN_IMPORTANCE}..${MAX_IMPORTANCE}`
    );
  }
  return value;
}

/**
 * Return a human-readable reason string if the draft contains a negative-form
 * indicator (spec SC 9), or null if the draft passes.
 *
 * Rejection list:
 *   - `don't` / `never` / `禁止` / `不要` / `不能` anywhere in title or body
 *     (case-insensitive for Latin words; CJK matched verbatim)
 *   - body starting with `not ` (case-insensitive)
 *
 * Why a typed error follows: `MemoryError` is the bounded context's base
 * exception class; the rejection is named (`MemoryError` with name
 * `MemoryError` and a message starting with `negative_form`) so the test can
 * pin it down without inventing a new subclass (T5 does not modify errors.ts).
 */
export function validateAffirmativePhrasing(
  title: string,
  body: string
): string | null {
  const haystack = `${title}\n${body}`;
  const lower = haystack.toLowerCase();
  for (const word of NEGATIVE_FORM_WORDS) {
    // CJK words ("禁止" / "不要" / "不能") match verbatim; ASCII words
    // ("don't" / "never") match case-insensitively.
    if (lower.includes(word.toLowerCase())) {
      return `contains negative-form word: ${word}`;
    }
  }
  if (/^\s*not\s/i.test(body)) {
    return "body starts with 'not '";
  }
  return null;
}

function makeSlug(random: (n: number) => Buffer): string {
  return random(6).toString("hex"); // 12 hex chars
}

/**
 * Write `<slug>.md` via tmp + rename: every rename lands a complete file or
 * no file, so a reader can never observe a partial entry under the final
 * path. Exported because auto-memory (ADR-0031 D2) requires the ingest write
 * path to be this same path rather than a second implementation of it.
 *
 * Returns the entry as written. `entry` is folded here rather than in each
 * caller's construction, so every writer shares one normalization — and the
 * return value is what makes the MEMORY.md row trustworthy: rendering the row
 * from the caller's own (unfolded) object would split it across lines for a
 * title that came back from a model with newlines in it.
 */
export async function writeMemoryEntryAtomic(
  memoryDir: string,
  slug: string,
  entry: MemoryEntryV1
): Promise<MemoryEntryV1> {
  try {
    await mkdir(memoryDir, { recursive: true });
  } catch (error) {
    throw new MemoryIOError(`[memory_save] mkdir ${memoryDir} failed`, {
      cause: error,
    });
  }
  const finalPath = join(memoryDir, `${slug}.md`);
  const tmpPath = `${finalPath}.${process.pid}.${Date.now()}.${slug}.tmp`;
  const written = foldEntryLineBreaks(entry);
  let serialized: string;
  try {
    serialized = serializeMemoryEntry(written);
  } catch (error) {
    // EXIT: serializer refused; disk untouched. One warn names slug and key
    // (the typed message carries no value), then the caller sees the typed
    // failure.
    if (error instanceof MemorySchemaInvalid) {
      console.warn(`[memory/save] refused ${slug}.md: ${error.message}`);
    }
    throw new MemoryIOError(`[memory_save] serialize failed`, { cause: error });
  }
  try {
    await writeFile(tmpPath, serialized, "utf8");
  } catch (error) {
    throw new MemoryIOError(`[memory_save] write tmp ${tmpPath} failed`, {
      cause: error,
    });
  }
  try {
    await rename(tmpPath, finalPath);
  } catch (error) {
    // Best-effort tmp cleanup; the directory remains consistent (no half-written
    // entry can be observed under the final slug path).
    throw new MemoryIOError(`[memory_save] rename tmp to ${finalPath} failed`, {
      cause: error,
    });
  }
  return written;
}

/** Append a `<slug>.md` link line to MEMORY.md; idempotent on replay. */
export async function upsertMemoryIndex(
  memoryDir: string,
  slug: string,
  entry: MemoryEntryV1
): Promise<void> {
  const indexPath = join(memoryDir, "MEMORY.md");
  let existing = "";
  try {
    existing = await readFile(indexPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new MemoryIOError(`[memory_save] read MEMORY.md failed`, {
        cause: error,
      });
    }
  }
  const next = appendLine(existing, formatIndexLine(slug, entry));
  try {
    await mkdir(memoryDir, { recursive: true });
    await replaceIndexFile(indexPath, next, slug);
  } catch (error) {
    throw new MemoryIOError(`[memory_save] MEMORY.md update failed`, {
      cause: error,
    });
  }
}

/**
 * Replace the row that links `<slug>.md` with a row rendered from the stored
 * entry (runtime-capability-memory-gate T5 / SC10). A refreshed row carries
 * the new title as well as importance and updated_at, so the human index
 * never points at a title the store no longer holds.
 *
 * The link `(slug.md)` is the row's identity — the title in front of it is
 * exactly what an UPDATE changes. Rows for other slugs are preserved byte for
 * byte. An UPDATE on a slug with no row adds it: the index is derived from
 * the store, so a missing row is a gap rather than a statement.
 *
 * A missing MEMORY.md stays missing — refreshing one row is not a reason to
 * materialize a file that was never written (same choice as the GC line
 * remover). Re-running is a no-op: the second pass writes an identical row.
 */
export async function refreshMemoryIndexLine(
  memoryDir: string,
  slug: string,
  entry: MemoryEntryV1
): Promise<void> {
  const indexPath = join(memoryDir, "MEMORY.md");
  let existing: string;
  try {
    existing = await readFile(indexPath, "utf8");
  } catch (error) {
    // EXIT: no-op — the index was never written; not an error.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new MemoryIOError(`[memory_save] read MEMORY.md failed`, {
      cause: error,
    });
  }
  const next = replaceSlugLine(existing, slug, formatIndexLine(slug, entry));
  if (next === existing) return;
  try {
    await replaceIndexFile(indexPath, next, slug);
  } catch (error) {
    throw new MemoryIOError(`[memory_save] MEMORY.md update failed`, {
      cause: error,
    });
  }
}

/** The one place the MEMORY.md row format lives. */
function formatIndexLine(slug: string, entry: MemoryEntryV1): string {
  return `- [${entry.title}](${slug}.md) · importance=${entry.importance} · updated_at=${entry.updated_at}`;
}

/** Write MEMORY.md via tmp+rename: a reader sees the old rows or the new. */
async function replaceIndexFile(
  indexPath: string,
  content: string,
  slug: string
): Promise<void> {
  const tmpPath = `${indexPath}.${process.pid}.${Date.now()}.${slug}.tmp`;
  await writeFile(tmpPath, content, "utf8");
  await rename(tmpPath, indexPath);
}

/**
 * Swap the row linking `slug.md` for `line`, dropping later duplicates of the
 * same link so a slug owns at most one row. Unrelated rows keep their
 * position. Appends when no row mentions the slug.
 */
function replaceSlugLine(existing: string, slug: string, line: string): string {
  const link = `(${slug}.md)`;
  const rows = existing.split("\n");
  if (!rows.some((row) => row.includes(link)))
    return appendLine(existing, line);
  const out: string[] = [];
  let replaced = false;
  for (const row of rows) {
    if (!row.includes(link)) {
      out.push(row);
    } else if (!replaced) {
      out.push(line);
      replaced = true;
    }
  }
  return out.join("\n");
}

/** Append `line` to `existing` if not already present (idempotent on replay). */
function appendLine(existing: string, line: string): string {
  if (existing.includes(line)) return existing;
  const sep = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  return `${existing}${sep}${line}\n`;
}

function defaultNow(): string {
  return new Date().toISOString();
}
