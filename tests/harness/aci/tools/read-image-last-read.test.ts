/**
 * read_image 不入 last-read ledger（specs/read-image-vision.md SC10 / 假设 10）。
 *
 * 不变式：成功 `read_image` 不把 path 写入 last-read ledger —— read_image
 * 工厂在签名层面就不接 ledger，本测试用真实 ledger host 锁住这一产品决定：
 *   - 读图后 host 不产生任何会话桶，图 path 查表为空；
 *   - 读过图不改变无关文本文件的 write_file 闸行为（先 read_file 文本入账 →
 *     read_image 图 → write_file 该文本仍放行）；
 *   - 读过图的 png 覆写仍被拒——本工具不入账，闸对图 path 恒 fail-closed。
 *
 * 账本 host 走真实实现（`createLastReadLedgerHost`），入账用真实 read_file
 * handler（样板同 write-file-last-read.test.ts）—— 不 stub 账本。
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";

import { createLastReadLedgerHost } from "../../../../src/harness/aci/last-read-ledger.ts";
import { createReadFileTool } from "../../../../src/harness/aci/tools/read-file.ts";
import { createReadImageTool } from "../../../../src/harness/aci/tools/read-image.ts";
import {
  createWriteFileTool,
  LastReadRequiredError,
} from "../../../../src/harness/aci/tools/write-file.ts";

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

// 真实 PNG 魔数（read-image.test.ts 同形状），保证 handler 成功臂入账判定成立。
const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03,
]);

describe("read_image — SC10 不入 last-read ledger", () => {
  it("成功读图后 ledger 对该 path 无入账，且 host 未产生任何会话桶", async () => {
    const root = await makeScratch("read-image-last-read-");
    const png = join(root, "pic.png");
    await writeFile(png, PNG_BYTES);

    const ledger = createLastReadLedgerHost();
    // read_image 工厂签名不接 ledger；ctx 仍带 conversationId，证明不是
    // 「因没传 id 才不入账」，而是路径本身不进表。
    const block = (await createReadImageTool(root).handler(
      { path: "pic.png" },
      { conversationId: "conv-a" }
    )) as { type: string };
    assert.equal(block.type, "image", "前置：读图必须成功");

    assert.equal(ledger.size(), 0, "读图不得触发任何会话桶的懒创建");
    assert.equal(ledger.ledgerFor("conv-a")?.has(png), false);
  });

  it("读文本入账 → 读图 → 覆写文本仍放行；覆写该图 path 仍被拒", async () => {
    const root = await makeScratch("read-image-last-read-");
    const text = join(root, "notes.txt");
    const png = join(root, "pic.png");
    await writeFile(text, "original text\n");
    await writeFile(png, PNG_BYTES);

    const ledger = createLastReadLedgerHost();
    const reader = createReadFileTool(root, { lastReadLedger: ledger });
    await reader.handler({ path: "notes.txt" }, { conversationId: "conv-a" });

    await createReadImageTool(root).handler(
      { path: "pic.png" },
      { conversationId: "conv-a" }
    );

    // 无关文本文件的闸行为不因读过图而改变。
    const writer = createWriteFileTool(root, { lastReadLedger: ledger });
    await writer.handler(
      { path: "notes.txt", content: "updated text\n" },
      { conversationId: "conv-a" }
    );
    assert.equal(await readFile(text, "utf8"), "updated text\n");

    // 图 path 覆写仍被拒：read_image 根本没入账，非空覆写闸 fail-closed。
    await assert.rejects(
      () =>
        writer.handler(
          { path: "pic.png", content: "not a png\n" },
          { conversationId: "conv-a" }
        ),
      (error: unknown) => {
        assert.ok(error instanceof LastReadRequiredError);
        assert.equal(error.kind, "last_read_required");
        assert.equal(error.path, png);
        return true;
      }
    );
    assert.deepEqual(await readFile(png), PNG_BYTES, "拒后字节不变");
  });
});
