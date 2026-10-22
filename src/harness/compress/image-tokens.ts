/**
 * Pixel-based image token estimation.
 *
 * The provider prices an image by its decoded dimensions, not by the length of
 * the base64 text. This module reads the dimensions from a bounded prefix of
 * the encoded payload (64 KiB decoded, no image decode) and returns the raw
 * estimate: `round(width × height / 750)`, after scaling the long edge down to
 * 1568 px, then clamped to `[1, VISION_IMAGE_TOKEN_CEILING]`.
 *
 * Supported headers: PNG (IHDR), JPEG (SOF0/1/2), GIF (logical screen
 * descriptor), WebP (VP8X canvas or VP8L packed dimensions). WebP's plain VP8
 * lossy chunk carries dimensions too, but the wire admission path only
 * produces VP8X/VP8L-era files, so an unreadable header fails closed to the
 * ceiling like every other malformed/unknown/truncated payload.
 *
 * The 1568-px rescale followed by the 3072 clamp makes a very large image read
 * ~6% under the raw pixel formula (1568²/750 ≈ 3278). That is intentional: the
 * ceiling is the anti-trip bound, not a second formula. Callers that total
 * message tokens still apply their own 4/3 padding; this module returns raw
 * tokens.
 */
import type { AnthropicNativeMessage } from "../model-adapter/types.js";
import { VISION_IMAGE_TOKEN_CEILING } from "./constant.js";

/** Header bytes decoded at most. All supported headers live in the first few
 *  dozen bytes; the bound keeps a multi-megabyte payload from being decoded. */
const MAX_DECODED_PREFIX_BYTES = 64 * 1024;
const MAX_PREFIX_BASE64_CHARS = Math.ceil(MAX_DECODED_PREFIX_BYTES / 3) * 4;

/** The provider's long-edge limit: a larger image is scaled down before it is
 *  priced, so dimensions above this do not inflate the estimate quadratically. */
const MAX_LONG_EDGE_PX = 1_568;
const PIXELS_PER_TOKEN = 750;

interface Dimensions {
  readonly width: number;
  readonly height: number;
}

function decodePrefix(data: string): Uint8Array {
  const decoded = Buffer.from(data.slice(0, MAX_PREFIX_BASE64_CHARS), "base64");
  return decoded.length > MAX_DECODED_PREFIX_BYTES
    ? decoded.subarray(0, MAX_DECODED_PREFIX_BYTES)
    : decoded;
}

function matchesAscii(
  bytes: Uint8Array,
  offset: number,
  text: string
): boolean {
  if (offset + text.length > bytes.length) return false;
  for (let i = 0; i < text.length; i++) {
    if (bytes[offset + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

function readUint16BE(bytes: Uint8Array, offset: number): number | null {
  if (offset + 2 > bytes.length) return null;
  return (bytes[offset]! << 8) | bytes[offset + 1]!;
}

function readUint32BE(bytes: Uint8Array, offset: number): number | null {
  if (offset + 4 > bytes.length) return null;
  return (
    bytes[offset]! * 0x1000000 +
    (bytes[offset + 1]! << 16) +
    (bytes[offset + 2]! << 8) +
    bytes[offset + 3]!
  );
}

function readUint24LE(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16)
  );
}

function valid(width: number | null, height: number | null): Dimensions | null {
  if (width === null || height === null) return null;
  if (width <= 0 || height <= 0) return null;
  return { width, height };
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function readPngDimensions(bytes: Uint8Array): Dimensions | null {
  if (bytes.length < 24) return null;
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (bytes[i] !== PNG_SIGNATURE[i]) return null;
  }
  if (!matchesAscii(bytes, 12, "IHDR")) return null;
  return valid(readUint32BE(bytes, 16), readUint32BE(bytes, 20));
}

const JPEG_SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2]);

function isJpegStream(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8;
}

/** Standalone markers (TEM, SOI, EOI, RSTn) carry no length segment. */
function isStandaloneJpegMarker(marker: number): boolean {
  return (
    marker === 0x01 ||
    marker === 0xd8 ||
    marker === 0xd9 ||
    (marker >= 0xd0 && marker <= 0xd7)
  );
}

/** SOS / EOI: the bytes that follow are entropy-coded, not markers. */
function isJpegScanOrEnd(marker: number): boolean {
  return marker === 0xda || marker === 0xd9;
}

/**
 * Walk the marker at `offset` (which holds `0xff`) past its fill bytes.
 * `null` = the bounded prefix ended inside the fill run.
 */
function scanJpegMarker(
  bytes: Uint8Array,
  offset: number
): { readonly marker: number; readonly segment: number } | null {
  let index = offset + 1;
  while (bytes[index] === 0xff) index += 1;
  return index < bytes.length
    ? { marker: bytes[index]!, segment: index + 1 }
    : null;
}

/** SOF payload: precision(1) + height(2) + width(2); truncated → null. */
function readSofDimensions(
  bytes: Uint8Array,
  payload: number
): Dimensions | null {
  if (payload + 4 >= bytes.length) return null;
  return valid(
    readUint16BE(bytes, payload + 3),
    readUint16BE(bytes, payload + 1)
  );
}

function readJpegDimensions(bytes: Uint8Array): Dimensions | null {
  if (!isJpegStream(bytes)) return null;
  let offset = 2;
  while (offset + 1 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const scanned = scanJpegMarker(bytes, offset);
    if (scanned === null) return null;
    // Without a preceding SOF, a later `FF C0` in entropy-coded data is a
    // stuffed byte, not a frame header. Fail closed to the ceiling.
    if (isJpegScanOrEnd(scanned.marker)) return null;
    if (isStandaloneJpegMarker(scanned.marker)) {
      offset = scanned.segment;
      continue;
    }
    const length = readUint16BE(bytes, scanned.segment);
    if (length === null || length < 2) return null;
    if (JPEG_SOF_MARKERS.has(scanned.marker)) {
      return readSofDimensions(bytes, scanned.segment + 2);
    }
    offset = scanned.segment + length;
  }
  return null;
}

function readGifDimensions(bytes: Uint8Array): Dimensions | null {
  if (bytes.length < 10) return null;
  if (!matchesAscii(bytes, 0, "GIF87a") && !matchesAscii(bytes, 0, "GIF89a")) {
    return null;
  }
  const width = bytes[6]! | (bytes[7]! << 8);
  const height = bytes[8]! | (bytes[9]! << 8);
  return valid(width, height);
}

function readWebpDimensions(bytes: Uint8Array): Dimensions | null {
  if (bytes.length < 16) return null;
  if (!matchesAscii(bytes, 0, "RIFF") || !matchesAscii(bytes, 8, "WEBP")) {
    return null;
  }
  if (matchesAscii(bytes, 12, "VP8X")) {
    // 4 flags/reserved bytes, then canvas width-1 and height-1 as 24-bit LE.
    if (bytes.length < 30) return null;
    return valid(1 + readUint24LE(bytes, 24), 1 + readUint24LE(bytes, 27));
  }
  if (matchesAscii(bytes, 12, "VP8L")) {
    // 0x2f signature byte, then 14-bit width-1 and 14-bit height-1.
    if (bytes.length < 25 || bytes[20] !== 0x2f) return null;
    const bits =
      (bytes[21]! |
        (bytes[22]! << 8) |
        (bytes[23]! << 16) |
        (bytes[24]! << 24)) >>>
      0;
    return valid(1 + (bits & 0x3fff), 1 + ((bits >>> 14) & 0x3fff));
  }
  return null;
}

function readDimensions(bytes: Uint8Array): Dimensions | null {
  return (
    readPngDimensions(bytes) ??
    readJpegDimensions(bytes) ??
    readGifDimensions(bytes) ??
    readWebpDimensions(bytes)
  );
}

function scaleToLongEdge({ width, height }: Dimensions): Dimensions {
  const longEdge = Math.max(width, height);
  if (longEdge <= MAX_LONG_EDGE_PX) return { width, height };
  const scale = MAX_LONG_EDGE_PX / longEdge;
  return { width: width * scale, height: height * scale };
}

/**
 * Raw pixel estimate for one base64-encoded image, capped at
 * `VISION_IMAGE_TOKEN_CEILING`. An unreadable header (malformed, unknown
 * format, truncated prefix) fails closed to the ceiling: a block must never
 * read as free or as a short text block.
 */
export function estimateImageTokensFromBase64(data: string): number {
  const dimensions = readDimensions(decodePrefix(data));
  if (dimensions === null) return VISION_IMAGE_TOKEN_CEILING;
  const scaled = scaleToLongEdge(dimensions);
  const estimate = Math.round(
    (scaled.width * scaled.height) / PIXELS_PER_TOKEN
  );
  return Math.min(VISION_IMAGE_TOKEN_CEILING, Math.max(1, estimate));
}

function isImageBlock(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { readonly type?: unknown }).type === "image"
  );
}

function contentHasImage(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  for (const block of content) {
    if (isImageBlock(block)) return true;
    if (
      typeof block === "object" &&
      block !== null &&
      (block as { readonly type?: unknown }).type === "tool_result"
    ) {
      const nested = (block as { readonly content?: unknown }).content;
      if (Array.isArray(nested) && nested.some(isImageBlock)) return true;
    }
  }
  return false;
}

/**
 * Whether the outgoing request carries an image block, top-level (user paste)
 * or nested inside `tool_result.content` (a tool that returned pixels). Such a
 * request must never be charged through a text-shaped `countTokens` reading:
 * the gateway prices the base64 text, not the decoded pixels.
 */
export function containsImageBlocks(
  messages: ReadonlyArray<AnthropicNativeMessage>
): boolean {
  return messages.some((message) => contentHasImage(message.content));
}
