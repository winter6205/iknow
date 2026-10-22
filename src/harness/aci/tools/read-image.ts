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
 *     arm passes it straight into `tool_result.content` (this tool's output is
 *     always nested — the only top-level image block is a user-pasted one,
 *     which never goes through this tool);
 *   - every error throws ToolExecutionError (executor turns it into
 *     execution_failed; the failure arm stays text);
 *   - never recorded in the last-read ledger: this factory takes no ledger
 *     parameter (only read_file and whitelisted bash are ledger subjects,
 *     ADR-0084);
 *   - deliberately narrower than read_file's shared reach resolution
 *     (`resolveReadReach`): no
 *     `projectIdentityRoot` read-only passthrough — only the
 *     `resolveWithinRoot` workspace fence, fail-closed.
 */

import { readFile, stat } from "node:fs/promises";

import { ToolExecutionError } from "../../errors.js";
import type { LiveTaskRoot } from "../../session-roots.js";
import type { AciToolDef } from "../types.js";
import type { ImageBlockParam } from "@anthropic-ai/sdk/resources/messages.js";
import { MAX_IMAGE_BYTES, detectImageMediaType } from "./image-format.js";
import { resolveWithinRoot } from "./helpers.js";

function readRoot(root: string | LiveTaskRoot): string {
  return typeof root === "string" ? root : root.read();
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
  const mediaType = detectImageMediaType(buffer);
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
