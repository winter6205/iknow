import { createHash } from "node:crypto";

/**
 * SHA-256 hex digest of a UTF-8 string.
 * Used for snapshot_id and content_hash.
 */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * Canonical JSON stringify: sorted object keys, stable for hashing.
 * Arrays preserve order; primitives as-is.
 * Date → ISO string; Map / Set / RegExp and other non-plain objects → TypeError.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function isPlainObject(value: object): value is Record<string, unknown> {
  if (Object.getPrototypeOf(value) === null) {
    return true;
  }
  return Object.getPrototypeOf(value) === Object.prototype;
}

function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value instanceof Map || value instanceof Set || value instanceof RegExp) {
    throw new TypeError(
      `canonicalJson rejects non-plain object: ${Object.prototype.toString.call(value)}`
    );
  }
  if (!isPlainObject(value)) {
    throw new TypeError(
      `canonicalJson rejects non-plain object: ${Object.prototype.toString.call(value)}`
    );
  }
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = sortKeys(value[key]);
  }
  return sorted;
}

/** Hash a structured snapshot payload into hex digest. */
export function snapshotIdFromPayload(
  payload: Readonly<Record<string, unknown>>
): string {
  return sha256Hex(canonicalJson(payload));
}

/**
 * Build snapshot_id with snap_ prefix (G2 envelope).
 * Full SHA-256 hex digest (no truncation).
 * Includes document_version for version consistency.
 */
export function buildSnapshotId(
  payload: Readonly<Record<string, unknown>>
): string {
  return `snap_${snapshotIdFromPayload(payload)}`;
}

/** Hash document/content bytes for content_hash. */
export function contentHash(content: string): string {
  return sha256Hex(content);
}
