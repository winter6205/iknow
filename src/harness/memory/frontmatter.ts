/**
 * #121 T2: parseMemoryEntry / serializeMemoryEntry / computeSignature.
 *
 * Spec: specs/121-memory-injection.md (Project Structure frontmatter.ts,
 * Testing Strategy frontmatter half).
 *
 * Both sides speak YAML (ADR-0123): the read side is a fence slice + YAML parse
 * with the scalar coerce boundary, and the write side emits its frontmatter map
 * through `yaml.stringify`, so a value the flat shape would misread (`": "`,
 * ` #`, a leading indicator, a blank) is quoted rather than silently dropped by
 * the reader. Key order, the comma-flat list form and body-after-the-fence
 * placement stay pinned by the round-trip assertions; `computeSignature` reads
 * parsed fields, so the quoted form moves no digest.
 *
 * The serialized format mirrors session-store sanitized files: frontmatter
 * block delimited by `---`, body text after the closing fence. Sanitize is
 * pure (no IO, no clock read); an unknown extra the pinned shape cannot emit
 * is refused with a typed error instead of dropped; the signature is
 * deterministic over canonical fields (unknown extras are not part of the
 * fingerprint by design — they are forward-compat metadata and can change
 * without changing the memory's logical content).
 */
import { createHash } from "node:crypto";
import { stringify } from "yaml";
import { parseFrontmatter, stripFence } from "../frontmatter/index.js";
import { MemorySchemaInvalid } from "./errors.js";
import type { MemoryEntryV1 } from "./schema.js";
import { defaultMemoryEntry } from "./schema.js";

/** `lineWidth: -1` stops `yaml` from wrapping a long scalar onto continuation
 *  lines, which would split one frontmatter key across rows the reader reads as
 *  separate entries. Distinct from `foldEntryLineBreaks`, which joins lines. */
const STRINGIFY_OPTIONS = { lineWidth: -1 } as const;

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
  const fence = stripFence(raw);
  if (!fence.found) throw new MemorySchemaInvalid("frontmatter");
  const { fields, warnings, rejected } = parseFrontmatter(fence.block);
  // No warn channel reaches here (store/recall/promote catch the typed throw
  // instead), so a degraded key goes to the module-wide console.warn seam —
  // same posture as memory/prefetch. Reporting must never turn into a throw.
  for (const message of warnings)
    console.warn(`[memory/frontmatter] ${message}`);

  // Fail closed on a block this reader cannot parse. Returning defaults would
  // classify the file as a healthy empty entry, and a GC soft-disable write
  // would then replace the unreadable original with those defaults — so the
  // typed throw is what keeps the store's quarantine-and-preserve contract
  // (store.ts files it under `skipped`, and GC never rewrites `skipped`).
  // EXIT: unreadable block → throw, file preserved untouched on disk.
  if (rejected) throw new MemorySchemaInvalid("frontmatter");

  const out: Record<string, unknown> = {
    ...defaultMemoryEntry(),
    body: fence.body,
  };

  for (const [key, value] of Object.entries(fields))
    out[key] = coerce(key, value);
  return out as unknown as MemoryEntryV1;
}

/**
 * Serialize a MemoryEntryV1 to its on-disk frontmatter form. Round-trip-stable
 * for a scalar extra; a non-scalar one throws `MemorySchemaInvalid` naming the
 * key. The pinned shape has no block/list emission, and emitting the entry
 * without that extra would replace a file with one that quietly lost a field —
 * so the writer refuses and the caller preserves what is on disk. Still pure:
 * a throw is not IO and reads no clock.
 */
export function serializeMemoryEntry(entry: MemoryEntryV1): string {
  const fields: Record<string, unknown> = {};
  for (const key of KNOWN_FRONT_KEYS) {
    fields[key] = formatValue(entry[key as keyof MemoryEntryV1]);
  }
  const extraKeys = Object.keys(entry)
    .filter((k) => !ALL_KNOWN_KEYS.has(k))
    .sort();
  for (const key of extraKeys) {
    const v = (entry as unknown as Record<string, unknown>)[key];
    if (!isScalar(v))
      throw new MemorySchemaInvalid(
        key,
        `memory frontmatter extra "${key}" is not a scalar`
      );
    fields[key] = v;
  }
  return `---\n${stringify(fields, STRINGIFY_OPTIONS)}---\n${entry.body}`;
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

/**
 * Collapse a known-entry value onto a YAML scalar and let the library decide
 * quoting. `supersedes` keeps the comma-flat form the reader's coerce rule
 * parses, so a list costs no extra lines.
 */
function formatValue(v: unknown): string | number | boolean | null {
  if (v === undefined) return "";
  if (
    v === null ||
    typeof v === "string" ||
    typeof v === "number" ||
    typeof v === "boolean"
  )
    return v;
  if (Array.isArray(v)) return v.join(",");
  return String(v);
}
