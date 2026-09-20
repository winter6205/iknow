/**
 * read_image unit tests.
 *
 * Contract (specs/read-image-vision.md):
 *   - input { path: string }; fence semantics identical to read_file (resolveWithinRoot)
 *   - type decided by magic bytes (never by extension): PNG / JPEG / GIF87a / GIF89a / RIFF….WEBP
 *   - size ceiling = read_file's tier at 1MB, checked before encoding
 *   - success returns an SDK ImageBlockParam-shaped image block (base64)
 *   - every failure throws ToolExecutionError: empty / non-string path,
 *     outside the fence, ENOENT, directory, >1MB, magic bytes outside the four
 *     families (incl. NUL binaries and empty files)
 *   - read_image never enters the last-read ledger (the factory takes no ledger param at all)
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";

import { ToolExecutionError } from "../../../../src/harness/errors.ts";
import { createReadFileTool } from "../../../../src/harness/aci/tools/read-file.ts";
import { createReadImageTool } from "../../../../src/harness/aci/tools/read-image.ts";

const scratchPaths: string[] = [];

async function makeScratch(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  scratchPaths.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(
    scratchPaths
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true }))
  );
});

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03,
]);
const JPEG_BYTES = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
]);
const GIF_BYTES = Buffer.concat([
  Buffer.from("GIF89a", "ascii"),
  Buffer.from([0x01, 0x02, 0x03, 0x04]),
]);
const WEBP_BYTES = Buffer.concat([
  Buffer.from("RIFF", "ascii"),
  Buffer.from([0x08, 0x00, 0x00, 0x00]),
  Buffer.from("WEBP", "ascii"),
  Buffer.from([0x2f, 0x00, 0x00, 0x00]),
]);

function isToolExecutionErrorMatching(pattern: RegExp) {
  return (err: unknown): boolean =>
    err instanceof ToolExecutionError && pattern.test(err.message);
}

describe("createReadImageTool — schema/aci shape", () => {
  it("name === 'read_image'", async () => {
    const root = await makeScratch("read-image-shape-");
    const tool = createReadImageTool(root);
    assert.equal(tool.name, "read_image");
  });

  it("inputSchema: path 必填 string，additionalProperties:false", async () => {
    const root = await makeScratch("read-image-shape-");
    const tool = createReadImageTool(root);
    const schema = tool.inputSchema as {
      type: string;
      required: string[];
      additionalProperties: boolean;
      properties: Record<string, { type: string }>;
    };
    assert.equal(schema.type, "object");
    assert.deepEqual(schema.required, ["path"]);
    assert.equal(schema.additionalProperties, false);
    assert.equal(schema.properties.path!.type, "string");
  });

  it("aci metadata matches the read-only contract", async () => {
    const root = await makeScratch("read-image-shape-");
    const tool = createReadImageTool(root);
    assert.equal(tool.aci.category, "read-only");
    assert.equal(tool.aci.isConcurrencySafe, true);
    assert.equal(tool.aci.interruptBehavior, "cancel");
    assert.equal(tool.aci.timeoutTier, "fast");
  });

  it("不带输出闸豁免声明（豁免只对 image 臂由 executor 判定，工具不自称）", async () => {
    const root = await makeScratch("read-image-shape-");
    const tool = createReadImageTool(root);
    assert.equal(tool.exemptFromOutputCap, undefined);
  });
});

describe("read_image — SC1 happy path（四类魔数）", () => {
  const cases: ReadonlyArray<{
    name: string;
    bytes: Buffer;
    mediaType: string;
  }> = [
    { name: "png", bytes: PNG_BYTES, mediaType: "image/png" },
    { name: "jpeg", bytes: JPEG_BYTES, mediaType: "image/jpeg" },
    { name: "gif", bytes: GIF_BYTES, mediaType: "image/gif" },
    { name: "webp", bytes: WEBP_BYTES, mediaType: "image/webp" },
  ];

  for (const { name, bytes, mediaType } of cases) {
    it(`returns an SDK ImageBlockParam for a ${name} file`, async () => {
      const root = await makeScratch(`read-image-${name}-`);
      await writeFile(join(root, `pix-${name}.dat`), bytes);

      const tool = createReadImageTool(root);
      const block = (await tool.handler({ path: `pix-${name}.dat` })) as {
        type: string;
        source: { type: string; media_type: string; data: string };
      };

      assert.equal(block.type, "image");
      assert.equal(block.source.type, "base64");
      assert.equal(block.source.media_type, mediaType);
      assert.ok(block.source.data.length > 0, "data 非空");
      assert.deepEqual(
        Buffer.from(block.source.data, "base64"),
        bytes,
        "base64 解码须逐字节还原原文件"
      );
    });
  }

  it("识别只看魔数不看扩展名：PNG 内容存成 .bin 仍判 image/png", async () => {
    const root = await makeScratch("read-image-magic-");
    await writeFile(join(root, "mystery.bin"), PNG_BYTES);

    const tool = createReadImageTool(root);
    const block = (await tool.handler({ path: "mystery.bin" })) as {
      source: { media_type: string };
    };
    assert.equal(block.source.media_type, "image/png");
  });
});

describe("read_image — SC2 read_file 对同一 PNG 回归拒绝", () => {
  it("read_file 仍 NUL 拒二进制，不返回 image", async () => {
    const root = await makeScratch("read-image-sc2-");
    await writeFile(join(root, "pic.png"), PNG_BYTES);

    const reader = createReadFileTool(root);
    await assert.rejects(
      () => Promise.resolve(reader.handler({ path: "pic.png" })),
      isToolExecutionErrorMatching(/binary file rejected/)
    );
  });
});

describe("read_image — SC3 非四类魔数 typed 拒绝", () => {
  it("含 NUL 但非图像魔数 → typed 失败", async () => {
    const root = await makeScratch("read-image-sc3-");
    await writeFile(
      join(root, "blob.bin"),
      Buffer.from([0x41, 0x42, 0x00, 0x43])
    );

    const tool = createReadImageTool(root);
    await assert.rejects(
      () => Promise.resolve(tool.handler({ path: "blob.bin" })),
      isToolExecutionErrorMatching(/unsupported image format/)
    );
  });

  it("无魔数文本文件 → typed 失败，不产出 image block", async () => {
    const root = await makeScratch("read-image-sc3-");
    await writeFile(join(root, "notes.txt"), "hello, not an image\n");

    const tool = createReadImageTool(root);
    await assert.rejects(
      () => Promise.resolve(tool.handler({ path: "notes.txt" })),
      isToolExecutionErrorMatching(/unsupported image format/)
    );
  });
});

describe("read_image — SC4 入参与文件系统边界", () => {
  it("空 path / 非字符串 path / 非对象 input → typed 失败", async () => {
    const root = await makeScratch("read-image-sc4-");
    const tool = createReadImageTool(root);

    await assert.rejects(
      () => Promise.resolve(tool.handler({ path: "" })),
      isToolExecutionErrorMatching(/path must be a non-empty string/)
    );
    await assert.rejects(
      () => Promise.resolve(tool.handler({ path: 42 })),
      isToolExecutionErrorMatching(/path must be a non-empty string/)
    );
    await assert.rejects(
      () => Promise.resolve(tool.handler(null)),
      isToolExecutionErrorMatching(/input must be an object/)
    );
  });

  it("越围栏路径 → typed 失败（path outside workspace）", async () => {
    const parent = await makeScratch("read-image-sc4-escape-");
    const root = join(parent, "ws");
    await mkdir(root);
    await writeFile(join(parent, "outside.png"), PNG_BYTES);

    const tool = createReadImageTool(root);
    await assert.rejects(
      () => Promise.resolve(tool.handler({ path: "../outside.png" })),
      isToolExecutionErrorMatching(/path outside workspace/)
    );
  });

  it("ENOENT → typed 失败 file not found", async () => {
    const root = await makeScratch("read-image-sc4-");
    const tool = createReadImageTool(root);
    await assert.rejects(
      () => Promise.resolve(tool.handler({ path: "missing.png" })),
      isToolExecutionErrorMatching(/file not found/)
    );
  });

  it("目录 → typed 失败 is a directory", async () => {
    const root = await makeScratch("read-image-sc4-");
    await mkdir(join(root, "adir"));
    const tool = createReadImageTool(root);
    await assert.rejects(
      () => Promise.resolve(tool.handler({ path: "adir" })),
      isToolExecutionErrorMatching(/is a directory/)
    );
  });

  it(">1MB（编码前判定）→ typed 失败，不产出 image", async () => {
    const root = await makeScratch("read-image-sc4-");
    const big = Buffer.concat([
      PNG_BYTES,
      Buffer.alloc(1_048_576 - PNG_BYTES.length + 1, 0x00),
    ]);
    assert.equal(big.length, 1_048_577);
    await writeFile(join(root, "big.png"), big);

    const tool = createReadImageTool(root);
    await assert.rejects(
      () => Promise.resolve(tool.handler({ path: "big.png" })),
      isToolExecutionErrorMatching(/exceeds 1MB limit/)
    );
  });

  it("恰好 1MB 的合法图 → 放行（边界含等号）", async () => {
    const root = await makeScratch("read-image-sc4-");
    const exact = Buffer.concat([
      PNG_BYTES,
      Buffer.alloc(1_048_576 - PNG_BYTES.length, 0x00),
    ]);
    assert.equal(exact.length, 1_048_576);
    await writeFile(join(root, "exact.png"), exact);

    const tool = createReadImageTool(root);
    const block = (await tool.handler({ path: "exact.png" })) as {
      type: string;
    };
    assert.equal(block.type, "image");
  });

  it("空文件 → typed 失败（非四类魔数），不产出 image", async () => {
    const root = await makeScratch("read-image-sc4-");
    await writeFile(join(root, "empty.png"), Buffer.alloc(0));
    const tool = createReadImageTool(root);
    await assert.rejects(
      () => Promise.resolve(tool.handler({ path: "empty.png" })),
      isToolExecutionErrorMatching(/unsupported image format/)
    );
  });

  it("PNG 前 4 字节 \\x89PNG 但签名后 4 字节损坏 → typed 拒绝（魔数须满 8 字节）", async () => {
    const root = await makeScratch("read-image-sc4-");
    const brokenPng = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x02, 0x03,
    ]);
    await writeFile(join(root, "broken.png"), brokenPng);
    const tool = createReadImageTool(root);
    await assert.rejects(
      () => Promise.resolve(tool.handler({ path: "broken.png" })),
      isToolExecutionErrorMatching(/unsupported image format/)
    );
  });
});
