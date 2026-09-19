/**
 * read_image 工具（path-image-vision T1）— 围栏内图片按魔数读为 SDK image block。
 *
 * 契约（specs/read-image-vision.md 假设 1–5 / 10，SC1–SC4）：
 *   - 输入: path (必填非空 string)；围栏解析与 read_file 同一入口
 *     （`resolveWithinRoot`，symlink 越界拒绝）
 *   - 判型只看魔数不看扩展名：PNG / JPEG / GIF87a / GIF89a / RIFF….WEBP；
 *     其余（含 NUL 二进制、空文件）typed 拒绝，与 read_file 的
 *     「当文本读」失败可区分
 *   - 体积顶 = read_file 同档 1MB，stat 后编码前判定
 *   - 成功返回 `ImageBlockParam`（base64）；executor 的成功臂据此直通进
 *     `tool_result.content`（image 只活在 tool_result 内，不上消息顶层）
 *   - 错误一律 throw ToolExecutionError（executor 转 execution_failed，失败臂仍 text）
 *   - 不入 last-read ledger：本工厂不接 ledger 参数（ADR-0084 入账面仅 read_file / 白名单 bash）
 *   - 不接 `projectIdentityRoot` 只读直通（有意窄于 read_file 的 resolveReadTarget）：
 *     只走 `resolveWithinRoot` 工作区围栏 fail-closed，spec read-image-vision 目标仅覆盖工作区根
 */

import { readFile, stat } from "node:fs/promises";

import { ToolExecutionError } from "../../errors.js";
import type { LiveTaskRoot } from "../../session-roots.js";
import type { AciToolDef } from "../types.js";
import type { ImageBlockParam } from "@anthropic-ai/sdk/resources/messages.js";
import { resolveWithinRoot } from "./helpers.js";

/** 与 read_file 的 `MAX_FILE_BYTES` 同档（1 MiB），spec 假设 5：编码前判定。 */
const MAX_IMAGE_BYTES = 1_048_576;

/** media_type 名单 SSOT：executor 的形状闸与魔数判型共用同一来源。 */
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

/** 只看文件头魔数；不匹配四类图像返回 undefined（调用方 typed 拒绝）。 */
function detectMediaType(buffer: Buffer): ImageMediaType | undefined {
  if (hasPngMagic(buffer)) return "image/png";
  if (hasJpegMagic(buffer)) return "image/jpeg";
  if (hasGifMagic(buffer)) return "image/gif";
  if (hasWebpMagic(buffer)) return "image/webp";
  return undefined;
}

function hasPngMagic(b: Buffer): boolean {
  // 完整 8 字节签名（89 50 4E 47 0D 0A 1A 0A）：只查前 4 字节会把
  // \x89PNG 开头的任意字节流误判为 PNG。
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
    throw new ToolExecutionError("[read_image] path must be a non-empty string");
  }
  return raw.path;
}

/** stat → 1MB 闸（编码前）→ 魔数判定 → base64 编码；任一失败皆 typed throw。 */
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
