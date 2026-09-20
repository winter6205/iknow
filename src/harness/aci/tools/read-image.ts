/**
 * read_image tool — read a file inside the fence as an SDK image block,
 * classified by magic bytes.
 *
 * Contract:
 *   - input: path (required, non-empty string); fence resolution uses the
 *     same entry point as read_file (`resolveWithinRoot`, symlink escapes
 *     rejected);
 *   - classification looks only at magic bytes, never the extension:
 *     PNG / JPEG / GIF87a / GIF89a / RIFF….WEBP; everything else (including
 *     NUL-bearing binaries and empty files) is a typed refusal, distinguishable
 *     from read_file's "read it as text" failure;
 *   - size cap = same 1 MiB as read_file, checked after stat and before
 *     encoding;
 *   - success returns an `ImageBlockParam` (base64); the executor's success
 *     arm passes it straight into `tool_result.content` (images live only
 *     inside tool_result, never at message top level);
 *   - every error throws ToolExecutionError (executor turns it into
 *     execution_failed; the failure arm stays text);
 *   - never recorded in the last-read ledger: this factory takes no ledger
 *     parameter (only read_file and whitelisted bash are ledger subjects,
 *     ADR-0084);
 *   - deliberately narrower than read_file's resolveReadTarget: no
 *     `projectIdentityRoot` read-only passthrough — only the
 *     `resolveWithinRoot` workspace fence, fail-closed.
 */

import { readFile, stat } from "node:fs/promises";

import { ToolExecutionError } from "../../errors.js";
import type { LiveTaskRoot } from "../../session-roots.js";
import type { AciToolDef } from "../types.js";
import type { ImageBlockParam } from "@anthropic-ai/sdk/resources/messages.js";
import { resolveWithinRoot } from "./helpers.js";

/** Same 1 MiB tier as read_file's `MAX_FILE_BYTES`; checked before encoding. */
const MAX_IMAGE_BYTES = 1_048_576;

/** SSOT for the media_type list: the executor's shape gate and the magic-byte
 * classifier draw from this single source. */
export const IMAGE_MEDIA_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
] as const;

type ImageMediaType = (typeof IMAGE_MEDIA_TYPES)[number];

function readRoot(root: string | LiveTaskRoot): string {
  return typeof root === "string" ? root : root.read();
}

/** Looks only at the file-header magic bytes; returns undefined when the
 * bytes match none of the four image types (caller then refuses by type). */
function detectMediaType(buffer: Buffer): ImageMediaType | undefined {
  if (hasPngMagic(buffer)) return "image/png";
  if (hasJpegMagic(buffer)) return "image/jpeg";
  if (hasGifMagic(buffer)) return "image/gif";
  if (hasWebpMagic(buffer)) return "image/webp";
  return undefined;
}

function hasPngMagic(b: Buffer): boolean {
  // Full 8-byte signature (89 50 4E 47 0D 0A 1A 0A): checking only the first
  // 4 bytes would misclassify any byte stream starting with \x89PNG as PNG.
  return (
    b.length >= 8 &&
    b[0] === 0x89 &&
    b[1] === 0x50 &&
    b[2] === 0x4e &&
    b[3] === 0x47 &&
    b[4] === 0x0d &&
    b[5] === 0x0a &&
    b[6] === 0x1a &&
    b[7] === 0x0a
  );
}

function hasJpegMagic(b: Buffer): boolean {
  return b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
}

function hasGifMagic(b: Buffer): boolean {
  if (b.length < 6) return false;
  const header = b.subarray(0, 6).toString("ascii");
  return header === "GIF87a" || header === "GIF89a";
}

function hasWebpMagic(b: Buffer): boolean {
  return (
    b.length >= 12 &&
    b.subarray(0, 4).toString("ascii") === "RIFF" &&
    b.subarray(8, 12).toString("ascii") === "WEBP"
  );
}

function parseInput(input: unknown): string {
  if (input === null || typeof input !== "object") {
    throw new ToolExecutionError("[read_image] input must be an object");
  }
  const raw = input as Record<string, unknown>;
  if (typeof raw.path !== "string" || raw.path.length === 0) {
    throw new ToolExecutionError(
      "[read_image] path must be a non-empty string"
    );
  }
  return raw.path;
}

/** stat → 1 MiB gate (before encoding) → magic-byte classification → base64;
 * every failure is a typed throw. */
async function encodeImageBlock(
  root: string,
  target: string
): Promise<ImageBlockParam> {
  const resolved = await resolveWithinRoot(root, target);
  let info;
  try {
    info = await stat(resolved);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ToolExecutionError(`[read_image] file not found: ${resolved}`);
    }
    throw error;
  }
  if (info.isDirectory()) {
    throw new ToolExecutionError(
      `[read_image] not a file (is a directory): ${resolved}`
    );
  }
  if (info.size > MAX_IMAGE_BYTES) {
    throw new ToolExecutionError(
      "[read_image] file exceeds 1MB limit, locate a smaller image or crop it first"
    );
  }
  const buffer = await readFile(resolved);
  const mediaType = detectMediaType(buffer);
  if (mediaType === undefined) {
    throw new ToolExecutionError(
      `[read_image] unsupported image format (magic bytes are not png/jpeg/gif/webp): ${resolved}`
    );
  }
  return {
    type: "image",
    source: {
      type: "base64",
      media_type: mediaType,
      data: buffer.toString("base64"),
    },
  };
}

export function createReadImageTool(root: string | LiveTaskRoot): AciToolDef {
  return Object.freeze({
    name: "read_image",
    description:
      "Read an image file (png, jpeg, gif, or webp — detected by magic bytes, not the extension) from inside the workspace fence and return it as a base64 image block for direct viewing. Format is verified from file content; any other bytes are rejected. Files >1MB are out of scope (rejected before encoding). Discover candidate paths with glob first. Stateless — each call reads the path you give.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
      },
      required: ["path"],
      additionalProperties: false,
    },
    aci: {
      category: "read-only" as const,
      isConcurrencySafe: true,
      interruptBehavior: "cancel" as const,
      timeoutTier: "fast" as const,
    },
    handler: async (input: unknown): Promise<ImageBlockParam> =>
      encodeImageBlock(readRoot(root), parseInput(input)),
  });
}
