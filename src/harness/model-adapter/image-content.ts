/**
 * The top-level `image` content block — one shape and one validator shared by
 * the session store's on-disk whitelist, the checkpoint mirror's block table,
 * and the outbound wire projection.
 *
 * Why this widening exists: an image used to reach the model only nested
 * inside `tool_result.content` (`read_image`'s path-based tool contract).
 * A user-pasted attachment is the second, deliberate home for the same block
 * shape at message top level, inside the already-accepted user message record
 * — no new record type, no side file.
 *
 * Why one predicate instead of three: the same rules are checked at persistence,
 * at checkpoint publication, and again at dispatch. Hand-copied predicates would
 * drift into the one failure mode this block must not have — a record the store
 * accepted and the wire then refuses, or an occupancy estimate that reads the
 * payload as free.
 *
 * `source.data` is an opaque payload, kept verbatim everywhere it travels
 * (the `redacted_thinking` precedent): nothing here decodes bytes, so nothing
 * here can rewrite them.
 */
import {
  IMAGE_MEDIA_TYPES,
  MAX_IMAGE_WIRE_BYTES,
} from "../aci/tools/image-format.js";

/** The SSOT list membership-tested at runtime, exactly as the executor's shape
 *  gate does it. Typed as a wider `string` on the block below because the
 *  neutral persistence mirror (`shared/native-state-port.ts`) declares these
 *  shapes structurally and imports nothing from the harness — a literal union
 *  there would either duplicate the list or cross that boundary. */
const IMAGE_MEDIA_TYPE_SET: ReadonlySet<string> = new Set<string>(
  IMAGE_MEDIA_TYPES
);

/** Base64 image source. Only `base64` is legal: a `url` source would put
 *  provider-fetched bytes into durable history the transcript cannot vouch for. */
export type ImageContentSource = {
  readonly type: "base64";
  readonly media_type: string;
  readonly data: string;
};

/** Anthropic native top-level image block. */
export type ImageContentBlock = {
  readonly type: "image";
  readonly source: ImageContentSource;
};

/** The wire raw budget — the largest raw size whose base64 form is 5 MiB —
 *  expressed as encoded length (`ceil(bytes / 3) * 4`). A user paste never
 *  passes through `read_image`'s 1 MiB stat gate, so this is the store cap. */
const MAX_IMAGE_BASE64_CHARS = Math.ceil(MAX_IMAGE_WIRE_BYTES / 3) * 4;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Fail-closed shape gate: `type` / `source.type` / `media_type` must all be
 *  legal, `data` must be a non-empty string within the wire raw budget. Takes
 *  `unknown` so the store's block whitelist can call it directly. */
export function isImageContentBlock(
  value: unknown
): value is ImageContentBlock {
  if (!isPlainRecord(value) || value["type"] !== "image") return false;
  const source = value["source"];
  if (!isPlainRecord(source) || source["type"] !== "base64") return false;
  const data = source["data"];
  if (typeof data !== "string" || data.length === 0) return false;
  if (data.length > MAX_IMAGE_BASE64_CHARS) return false;
  const mediaType = source["media_type"];
  if (typeof mediaType !== "string") return false;
  return IMAGE_MEDIA_TYPE_SET.has(mediaType);
}
