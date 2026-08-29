/**
 * #121 T2: parseMemoryEntry / serializeMemoryEntry / computeSignature.
 *
 * Spec: specs/121-memory-injection.md (Project Structure frontmatter.ts,
 * Testing Strategy frontmatter half).
 *
 * Why no YAML dependency: spec Tech Stack bans new npm deps. We parse a
 * minimal scalar subset (`key: value` lines; strings / numbers / booleans /
 * null) — enough for the 6 core fields + title + updated_at + scalar extras.
 *
 * The serialized format mirrors session-store sanitized files: frontmatter
 * block delimited by `---`, body text after the closing fence. Sanitize is
 * pure (no IO, no clock read); signature is deterministic over canonical
 * fields (unknown extras are not part of the fingerprint by design — they
 * are forward-compat metadata and can change without changing the
 * memory's logical content).
 */
import { createHash } from "node:crypto";
import { MemorySchemaInvalid } from "./errors.js";
import type { MemoryEntryV1 } from "./schema.js";
import { defaultMemoryEntry } from "./schema.js";

/** Frontmatter regex: opening `---`, lazy body, closing `---`, body text. */
const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

const STRING_KEYS = new Set(["id", "type", "title", "updated_at"]);
const NUMBER_KEYS = new Set(["importance", "ttl_days"]);

/** Canonical key order for serialize — known fields first, extras later sorted. */
const KNOWN_FRONT_KEYS = [
  "id",
  "type",
  "importance",
  "ttl_days",
  "disabled",
  "supersedes",
  "title",
  "updated_at",
] as const;
const ALL_KNOWN_KEYS = new Set([...KNOWN_FRONT_KEYS, "body"]);

/** Parse `--- ... ---` frontmatter + body into a MemoryEntryV1. Throws on malformed input. */
export function parseMemoryEntry(raw: string): MemoryEntryV1 {
  const m = FM_RE.exec(raw);
  if (!m) throw new MemorySchemaInvalid("frontmatter");
  const [, fm, body] = m;

  const out: Record<string, unknown> = {
    ...defaultMemoryEntry(),
    body,
  };

  for (const line of fm.split(/\r?\n/)) {
    const sep = line.indexOf(":");
    if (sep === -1) continue;
    const key = line.slice(0, sep).trim();
    if (!key) continue;
    const raw = line.slice(sep + 1).trim();
    out[key] = coerce(key, raw);
  }
  return out as unknown as MemoryEntryV1;
}

/** Serialize a MemoryEntryV1 to its on-disk frontmatter form. Round-trip-stable. */
export function serializeMemoryEntry(entry: MemoryEntryV1): string {
  const lines: string[] = ["---"];
  for (const key of KNOWN_FRONT_KEYS) {
    lines.push(`${key}: ${formatValue(entry[key as keyof MemoryEntryV1])}`);
  }
  const extraKeys = Object.keys(entry)
    .filter((k) => !ALL_KNOWN_KEYS.has(k))
    .sort();
  for (const key of extraKeys) {
    const v = (entry as unknown as Record<string, unknown>)[key];
    if (isScalar(v)) lines.push(`${key}: ${formatScalar(v)}`);
  }
  lines.push("---");
  lines.push(entry.body);
  return lines.join("\n");
}

/**
 * Deterministic signature over the 9 canonical fields. Excludes unknown
 * extras: they are forward-compat metadata and not part of the memory's
 * logical content fingerprint.
 */
export function computeSignature(entry: MemoryEntryV1): string {
  const canonical = [
    entry.id,
    entry.type,
    String(entry.importance),
    String(entry.ttl_days),
    String(entry.disabled),
    entry.supersedes?.join(",") ?? "null",
    entry.title,
    entry.updated_at,
    entry.body,
  ].join("\u0000");
  return createHash("sha1").update(canonical).digest("hex");
}

// -- helpers (not exported; index.ts re-export policy) -----------------------

/** Coerce a raw string value to its declared scalar type. */
function coerce(key: string, raw: string): unknown {
  if (key === "disabled") {
    if (raw === "true") return true;
    if (raw === "false") return false;
    return defaultMemoryEntry().disabled;
  }
  if (NUMBER_KEYS.has(key)) {
    const n = Number(raw);
    return Number.isFinite(n)
      ? n
      : defaultMemoryEntry()[key as "importance" | "ttl_days"];
  }
  if (key === "supersedes") {
    // Flat list form: `supersedes: a,b` (null when absent). Slugs are hex
    // ids with no commas, so comma-joined round-trips; an empty list must
    // not occur and normalizes back to null.
    if (raw === "null" || raw === "") return null;
    const ids = raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    return ids.length > 0 ? ids : null;
  }
  if (STRING_KEYS.has(key)) {
    return raw; // empty string is a valid string
  }
  // Unknown key: best-effort scalar inference so round-trip is stable.
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null") return null;
  if (raw === "") return "";
  const n = Number(raw);
  if (Number.isFinite(n) && /^-?\d+(\.\d+)?$/.test(raw)) return n;
  return raw;
}

function isScalar(v: unknown): v is string | number | boolean | null {
  return (
    typeof v === "string" ||
    typeof v === "number" ||
    typeof v === "boolean" ||
    v === null
  );
}

function formatScalar(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "string") return v;
  return String(v);
}

/** Format any known-entry value (including object-like edges) for serialize. */
function formatValue(v: unknown): string {
  if (v === null || v === undefined) return v === null ? "null" : "";
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.join(",");
  return String(v);
}
