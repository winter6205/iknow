/**
 * Shared image-bearing test payloads.
 *
 * A payload several test files need gets one home instead of a hand-copied
 * `const` per file: hand copies drift by one character while every copy still
 * passes, which is the failure a shared fixture removes. Not exported from src/
 * barrels on purpose — tests reach this path by direct import.
 *
 * Framework-free by design: nothing here imports `vitest` or `bun:test`, so the
 * same module serves both runners.
 *
 * The payloads are opaque to the code under test — the image-block contract
 * (`src/harness/model-adapter/image-content.ts`) validates shape and encoded
 * size but never decodes `source.data` — so a truncated PNG header is enough to
 * exercise a gate. The three payload variants below are NOT interchangeable:
 * they decode to different byte lengths, and each set of cases was written
 * against one of them.
 */
import { MAX_IMAGE_WIRE_BYTES } from "../../src/harness/aci/tools/image-format.ts";
import type { ImageContentBlock } from "../../src/harness/model-adapter/image-content.ts";
import type { AnthropicContentBlock } from "../../src/harness/model-adapter/types.ts";

/** A complete 1x1 PNG, base64 (70 bytes decoded). */
export const PNG_1X1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

/** Minimal PNG-magic-shaped payload: `PNG_1X1_BASE64`'s first 16 bytes re-encoded
 *  with valid padding (24 characters, 16 bytes decoded). */
export const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUg==";

/** `PNG_1X1_BASE64` truncated mid-stream at 24 characters — a payload with no
 *  padding at all (18 bytes decoded), so it is a different string than
 *  `PNG_BASE64` even though both start identically. */
export const PNG_1X1_PREFIX_BASE64: string = PNG_1X1_BASE64.slice(0, 24);

/** A base64 payload well past the 8000-code-unit TEXT cap but inside the store's
 *  wire raw budget — the shape that proves a text cap is not an image cap. */
export const LARGE_PNG_BASE64 = PNG_1X1_BASE64.repeat(400);

/** The wire raw budget expressed at the only granularity a persisted record
 *  exposes: encoded length (`ceil(bytes / 3) * 4` base64 characters). Same
 *  derivation as `model-adapter/image-content.ts`, whose cap these cases probe.
 *  This is the store and clipboard admission cap, not `read_image`'s 1 MiB gate. */
export const MAX_IMAGE_BASE64_CHARS = Math.ceil(MAX_IMAGE_WIRE_BYTES / 3) * 4;

/** Base64 that matches the secret shape `sk-[A-Za-z0-9_-]{20,}`. A fabricated
 *  value (never a live key); it is here precisely because a text-only masking
 *  pass would placeholder it and destroy the attachment. `filler` is a parameter
 *  because the copies it replaces repeated a different character; each call site
 *  keeps its exact bytes. */
export function secretShapedBase64(filler: string): string {
  return `sk-${filler.repeat(60)}abcdefghijklmnopqrstuvwxyz0123456789`;
}

/** Anthropic base64 image block — the shape a user paste carries. Typed as the
 *  image arm so it feeds both the harness block union and the hub's narrower
 *  user-content contract. */
export function imageBlock(data: string = PNG_1X1_BASE64): ImageContentBlock {
  return {
    type: "image",
    source: { type: "base64", media_type: "image/png", data },
  };
}

/** Text block, in the narrow arm both the harness union and the hub contract
 *  accept. */
export function textBlock(
  text: string
): Extract<AnthropicContentBlock, { type: "text" }> {
  return { type: "text", text };
}

/** Image block wrapping a caller-supplied `source`, kept loose on purpose: the
 *  fail-closed cases hand it a `url` source, an unknown media_type, a non-string
 *  or an oversized `data`, none of which a typed source would admit. Defaults to
 *  the legal base64 shape. */
export function imageWithSource(
  source: Record<string, unknown> = {
    type: "base64",
    media_type: "image/png",
    data: PNG_BASE64,
  }
): AnthropicContentBlock {
  return { type: "image", source } as unknown as AnthropicContentBlock;
}
