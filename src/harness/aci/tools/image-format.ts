/**
 * src/harness/aci/tools/image-format.ts
 *
 * The image admission policy: which media types may enter a conversation at all,
 * how big one may be, and how raw bytes decide which type they are.
 *
 * One classifier instead of a copy per entry point, because two hand-kept
 * signature checks drift into the one failure this policy must not have: bytes
 * that `read_image` calls PNG and the clipboard reader calls unsupported — or
 * the reverse, an attachment the store accepts and the model then refuses.
 *
 * Classification looks only at the file header, never the extension: a name is
 * not evidence about bytes.
 */

/** The admitted media types. The executor's shape gate, the magic-byte
 *  classifier, the top-level image-block validator
 *  (`model-adapter/image-content.ts`) and the composer's draft table all draw
 *  from this single source. */
export const IMAGE_MEDIA_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
] as const;

export type ImageMediaType = (typeof IMAGE_MEDIA_TYPES)[number];

/** `read_image` file gate, the same 1 MiB tier as read_file's `MAX_FILE_BYTES`,
 *  checked before encoding. A clipboard image and a stored image block use
 *  `MAX_IMAGE_WIRE_BYTES` instead, so this gate must not grow to match them. */
export const MAX_IMAGE_BYTES = 1_048_576;

/** Long edge (the greater of width and height) for a clipboard image that is
 *  stored. A source already at or under this edge is not enlarged. */
export const MAX_IMAGE_LONG_EDGE_PX = 2_000;

/** Largest raw size of a clipboard image or a stored image block. Base64 of
 *  this many bytes is 5 MiB: 3932160 / 3 * 4 = 5242880 = 5 * 1024 * 1024.
 *  Binary MiB, not decimal MB. */
export const MAX_IMAGE_WIRE_BYTES = 3_932_160;

/** Header bytes the clipboard host script and `detectImageMediaType` both use.
 *  A second hand-written signature list is the drift this module exists to stop. */
export const IMAGE_SIGNATURE_BYTES = {
  png: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  jpeg: [0xff, 0xd8, 0xff],
  gif87a: [0x47, 0x49, 0x46, 0x38, 0x37, 0x61],
  gif89a: [0x47, 0x49, 0x46, 0x38, 0x39, 0x61],
  riff: [0x52, 0x49, 0x46, 0x46],
  webp: [0x57, 0x45, 0x42, 0x50],
} as const;

function matchesAt(
  bytes: Buffer,
  signature: readonly number[],
  offset = 0
): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

function hasPngMagic(bytes: Buffer): boolean {
  // Full 8-byte signature: checking only the first 4 bytes would misclassify
  // any byte stream starting with \x89PNG as PNG.
  return matchesAt(bytes, IMAGE_SIGNATURE_BYTES.png);
}

function hasJpegMagic(bytes: Buffer): boolean {
  return matchesAt(bytes, IMAGE_SIGNATURE_BYTES.jpeg);
}

function hasGifMagic(bytes: Buffer): boolean {
  return (
    matchesAt(bytes, IMAGE_SIGNATURE_BYTES.gif87a) ||
    matchesAt(bytes, IMAGE_SIGNATURE_BYTES.gif89a)
  );
}

function hasWebpMagic(bytes: Buffer): boolean {
  return (
    matchesAt(bytes, IMAGE_SIGNATURE_BYTES.riff) &&
    matchesAt(bytes, IMAGE_SIGNATURE_BYTES.webp, 8)
  );
}

/** The admitted types in signature order, paired with the header that proves
 *  one. A format added to `IMAGE_MEDIA_TYPES` without a signature here is
 *  simply never detected, so the list stays the policy and this table the map. */
const SIGNATURES: ReadonlyArray<{
  readonly mediaType: ImageMediaType;
  readonly matches: (bytes: Buffer) => boolean;
}> = [
  { mediaType: "image/png", matches: hasPngMagic },
  { mediaType: "image/jpeg", matches: hasJpegMagic },
  { mediaType: "image/gif", matches: hasGifMagic },
  { mediaType: "image/webp", matches: hasWebpMagic },
];

/** Media type of these bytes, or undefined when they match none of the admitted
 *  signatures (an empty buffer and a NUL-bearing binary both land there). */
export function detectImageMediaType(
  bytes: Buffer
): ImageMediaType | undefined {
  return SIGNATURES.find((signature) => signature.matches(bytes))?.mediaType;
}
