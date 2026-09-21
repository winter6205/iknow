/**
 * MemoryFileV1 + MemoryEntryV1 types + sanitizeMemoryFile.
 *
 * Spec: specs/121-memory-injection.md (Project Structure schema.ts, Testing
 * Strategy schema half — sanitize is a pure function with no disk-write side
 * effects; it rejects schemaVersion > CURRENT and preserves unknown fields.
 *
 * Shape mirrors src/session-api/store/schema.ts (SessionFileV1 sanitize
 * precedent): reject-first for schemaVersion, unknown-field preservation on
 * <= CURRENT files, pure (no IO). Sanitize never repairs malformed data —
 * it backfills missing fields but throws on structural wrong-shape so the
 * caller can quarantine the file.
 */
import { MemorySchemaInvalid } from "./errors.js";

/**
 * The closed `memory_type` enum (specs/memory-layer-follow-ups.md SC 2).
 *
 * Write-path vocabulary only: `memory_save` input and auto-ingest candidates
 * are normalized against it. Frontmatter already on disk is left alone, so
 * entries written before the enum existed still round-trip verbatim.
 */
export const MEMORY_TYPES = [
  "convention",
  "decision",
  "gotcha",
  "constraint",
  "note",
] as const;

export type MemoryType = (typeof MEMORY_TYPES)[number];

/** The value an illegal or absent type falls back to — never a write failure. */
export const DEFAULT_MEMORY_TYPE: MemoryType = "note";

/**
 * Map an untrusted type onto the closed enum. Exact match only: no trimming
 * and no case folding, because a near-miss is a caller mistake, and silently
 * repairing it would let two spellings of the same intent both look legal.
 */
export function normalizeMemoryType(value: unknown): MemoryType {
  return (MEMORY_TYPES as ReadonlyArray<string>).includes(value as string)
    ? (value as MemoryType)
    : DEFAULT_MEMORY_TYPE;
}

/** Six core fields + title + body + timestamp (spec SC 7). */
export interface MemoryEntryV1 {
  readonly id: string;
  readonly type: string;
  readonly importance: number;
  readonly ttl_days: number;
  readonly disabled: boolean;
  /** Slugs this entry supersedes. Empty arrays normalize to null. */
  readonly supersedes: string[] | null;
  readonly title: string;
  readonly body: string;
  /** ISO-8601 string. Empty when missing (sanitize is pure / no clock read). */
  readonly updated_at: string;
}

/** Top-level shape: versioned, forward-compatible via unknown-field preservation. */
export interface MemoryFileV1 {
  readonly schemaVersion: 1;
  readonly entries: ReadonlyArray<MemoryEntryV1>;
}

export const CURRENT_MEMORY_SCHEMA_VERSION = 1 as const;

/** Spec defaults — Postel-lenient for missing fields, structural-reject on shape. */
export function defaultMemoryEntry(): MemoryEntryV1 {
  return {
    id: "",
    type: "note",
    importance: 1,
    ttl_days: 0,
    disabled: false,
    supersedes: null,
    title: "",
    body: "",
    updated_at: "",
  };
}

/**
 * Sanitize a parsed memory file into the current shape.
 *
 * Reject-first: schemaVersion > CURRENT fails before any field work, so
 * unknown future-version fields cannot leak past the version check.
 *
 * V0 files (no schemaVersion key) are treated as v1 with backfilled version;
 * unknown top-level and per-entry fields are preserved verbatim so future
 * schema additions round-trip without dropping data.
 *
 * Pure, no IO, no writes (Boundaries Always).
 */
export function sanitizeMemoryFile(raw: unknown): MemoryFileV1 {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new MemorySchemaInvalid("root");
  }
  const obj = raw as Record<string, unknown>;

  // Version gate runs BEFORE any field work — reject-first contract.
  const sv = obj["schemaVersion"];
  if (sv === undefined) {
    // v0 file: fall through, backfill at the end.
  } else if (typeof sv !== "number" || sv > CURRENT_MEMORY_SCHEMA_VERSION) {
    throw new MemorySchemaInvalid("schemaVersion");
  }

  const entriesRaw = obj["entries"];
  let entries: ReadonlyArray<MemoryEntryV1>;
  if (entriesRaw === undefined) {
    entries = [];
  } else if (!Array.isArray(entriesRaw)) {
    throw new MemorySchemaInvalid("entries");
  } else {
    entries = entriesRaw.map((e) => sanitizeMemoryEntry(e));
  }

  return {
    ...obj,
    schemaVersion: CURRENT_MEMORY_SCHEMA_VERSION,
    entries,
  } as unknown as MemoryFileV1;
}

/** Per-entry sanitize. Object entries get defaults for missing fields; non-object → reject. */
function sanitizeMemoryEntry(raw: unknown): MemoryEntryV1 {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new MemorySchemaInvalid("entries");
  }
  const obj = raw as Record<string, unknown>;
  const base = defaultMemoryEntry();
  // Preserve unknown fields; only overlay known fields with their declared type.
  const out: Record<string, unknown> = { ...obj, ...base };
  out["id"] = typeof obj["id"] === "string" ? obj["id"] : base.id;
  out["type"] = typeof obj["type"] === "string" ? obj["type"] : base.type;
  out["importance"] =
    typeof obj["importance"] === "number" ? obj["importance"] : base.importance;
  out["ttl_days"] =
    typeof obj["ttl_days"] === "number" ? obj["ttl_days"] : base.ttl_days;
  out["disabled"] =
    typeof obj["disabled"] === "boolean" ? obj["disabled"] : base.disabled;
  out["supersedes"] = normalizeSupersedes(obj["supersedes"]);
  out["title"] = typeof obj["title"] === "string" ? obj["title"] : base.title;
  out["body"] = typeof obj["body"] === "string" ? obj["body"] : base.body;
  out["updated_at"] =
    typeof obj["updated_at"] === "string" ? obj["updated_at"] : base.updated_at;
  return out as unknown as MemoryEntryV1;
}

/**
 * Normalize `supersedes` onto `string[] | null`: only string elements
 * survive, an empty (or all-invalid) array normalizes to null — an empty
 * pointer list must never occur on disk or in memory.
 */
function normalizeSupersedes(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const ids = value
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .map((v) => v.trim());
  return ids.length > 0 ? ids : null;
}
