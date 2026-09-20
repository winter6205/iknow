/**
 * read_image never enters the last-read ledger (specs/read-image-vision.md).
 *
 * Invariant: a successful `read_image` does not write its path into the
 * last-read ledger — the read_image factory does not even accept a ledger at
 * the signature level; this test pins that product decision against a real
 * ledger host:
 *   - after an image read the host has produced no session bucket at all and
 *     the image path looks up empty;
 *   - reading an image does not change write_file gate behavior for unrelated
 *     text files (read_file the text first to register it → read_image the
 *     image → write_file on that text still passes);
 *   - overwriting a png that was read is still rejected — the tool registers
 *     nothing, so the gate stays fail-closed for image paths.
 *
 * The ledger host is the real implementation (`createLastReadLedgerHost`)
 * and registration uses the real read_file handler (same scaffolding as
 * write-file-last-read.test.ts) — no ledger stubs.
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

// Real PNG magic bytes (same shape as read-image.test.ts) so the handler's
// success path is genuinely reached.
const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03,
]);

describe("read_image — SC10 不入 last-read ledger", () => {
  it("成功读图后 ledger 对该 path 无入账，且 host 未产生任何会话桶", async () => {
    const root = await makeScratch("read-image-last-read-");
    const png = join(root, "pic.png");
    await writeFile(png, PNG_BYTES);

    const ledger = createLastReadLedgerHost();
    // The read_image factory takes no ledger; ctx still carries a
    // conversationId to prove the path is not registered because it never
    // enters the table, not because an id was missing.
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

    // Gate behavior on an unrelated text file is unchanged by the image read.
    const writer = createWriteFileTool(root, { lastReadLedger: ledger });
    await writer.handler(
      { path: "notes.txt", content: "updated text\n" },
      { conversationId: "conv-a" }
    );
    assert.equal(await readFile(text, "utf8"), "updated text\n");

    // Overwriting the image path is still rejected: read_image registered
    // nothing, so the non-empty-overwrite gate fails closed.
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
