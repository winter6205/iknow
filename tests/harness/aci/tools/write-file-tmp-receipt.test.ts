/**
 * Write-tool success receipts give the canonical host path for the session
 * tmp pad.
 *
 * Invariants authenticated:
 *   1. A write landing on the session tmp pad (outside taskRoot): the receipt
 *      contains the file's absolute host path (the canonical target returned
 *      by resolveWithinRoot, directly copyable back into read_file/edit_file),
 *      with no `../` chains and no form pretending the pad is a taskRoot
 *      relative path.
 *   2. Delivery writes inside taskRoot (relative or absolute input form):
 *      the receipt keeps the existing short taskRoot-relative form byte for
 *      byte — no regression.
 *   3. edit_file pad-write receipts already contain the absolute path — the
 *      existing implementation satisfies this; kept here as a regression nail.
 *   4. The meta side-channel (oldContent/newContent) is unaffected by the
 *      receipt change.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";

import { createWriteFileTool } from "../../../../src/harness/aci/tools/write-file.ts";
import { createEditFileTool } from "../../../../src/harness/aci/tools/edit-file.ts";
import type { AciToolDef } from "../../../../src/harness/aci/types.ts";
import { ensureMainSessionFenceTmpForConversation } from "../../../../src/harness/sandbox/fence-tmp.ts";

const scratchPaths: string[] = [];

/** mkdtemp + realpath: all later assertions use canonical paths, tolerating hosts whose tmpdir contains symlinks. */
async function makeScratch(prefix: string): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  scratchPaths.push(path);
  return path;
}

interface Receipt {
  readonly output: string;
  readonly meta: { readonly oldContent: string; readonly newContent: string };
}

async function writeReceipt(
  tool: AciToolDef,
  input: unknown,
  ctx?: Parameters<NonNullable<AciToolDef["handler"]>>[1]
): Promise<Receipt> {
  return (await tool.handler(input, ctx)) as Receipt;
}

afterEach(async () => {
  await Promise.all(
    scratchPaths
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe("write_file — 回执对会话 tmp 给出 canonical 宿主路径", () => {
  it("显式 tmpDir 垫底写：回执含绝对宿主路径，不含 ../ 链", async () => {
    const taskRoot = await makeScratch("wf-rc-pad-root-");
    const pad = await makeScratch("wf-rc-pad-pad-");
    const tool = createWriteFileTool(taskRoot, { tmpDir: pad });
    const absTarget = join(pad, "ok.txt");

    const receipt = await writeReceipt(tool, {
      path: absTarget,
      content: "scratch\n",
    });

    assert.equal(receipt.output.includes(absTarget), true);
    assert.equal(receipt.output.includes(".."), false);
    // meta side-channel must not regress
    assert.deepEqual(receipt.meta, { oldContent: "", newContent: "scratch\n" });
    assert.equal(await readFile(absTarget, "utf8"), "scratch\n");
  });

  it("projectDir+conversationId 垫底写：回执同样含绝对宿主路径", async () => {
    const taskRoot = await makeScratch("wf-rc-sess-root-");
    const projectDir = await makeScratch("wf-rc-sess-proj-");
    const tool = createWriteFileTool(taskRoot, { projectDir });
    const pad = ensureMainSessionFenceTmpForConversation(projectDir, "conv-rc");
    const absTarget = join(pad, "y");

    const receipt = await writeReceipt(
      tool,
      { path: absTarget, content: "via-session\n" },
      { conversationId: "conv-rc" }
    );

    assert.equal(receipt.output.includes(absTarget), true);
    assert.equal(receipt.output.includes(".."), false);
  });

  it("taskRoot 相对路径交付写：回执保持既有相对形态（逐字节）", async () => {
    const taskRoot = await makeScratch("wf-rc-rel-root-");
    const pad = await makeScratch("wf-rc-rel-pad-");
    const tool = createWriteFileTool(taskRoot, { tmpDir: pad });

    const receipt = await writeReceipt(tool, {
      path: "kept.txt",
      content: "delivery\n",
    });

    assert.equal(
      receipt.output,
      `[write_file] wrote ${Buffer.byteLength("delivery\n", "utf8")} bytes to kept.txt`
    );
  });

  it("taskRoot 绝对路径交付写：回执仍是相对 taskRoot 短形式，无 ../", async () => {
    const taskRoot = await makeScratch("wf-rc-abs-root-");
    const pad = await makeScratch("wf-rc-abs-pad-");
    const tool = createWriteFileTool(taskRoot, { tmpDir: pad });
    const absTarget = join(taskRoot, "abs.txt");

    const receipt = await writeReceipt(tool, {
      path: absTarget,
      content: "d2\n",
    });

    assert.equal(
      receipt.output,
      `[write_file] wrote ${Buffer.byteLength("d2\n", "utf8")} bytes to abs.txt`
    );
    assert.equal(receipt.output.includes(".."), false);
  });
});

describe("edit_file — 垫底编辑回执含绝对路径（回归钉子）", () => {
  it("垫底文件成功编辑：回执含 canonical 绝对宿主路径，不含 ../", async () => {
    const taskRoot = await makeScratch("ef-rc-pad-root-");
    const pad = await makeScratch("ef-rc-pad-pad-");
    const absTarget = join(pad, "ok.txt");
    await writeFile(absTarget, "before\n", "utf8");
    const tool = createEditFileTool(taskRoot, { tmpDir: pad });

    const receipt = await writeReceipt(tool, {
      path: absTarget,
      old_str: "before",
      new_str: "after",
    });

    assert.equal(receipt.output.includes(absTarget), true);
    assert.equal(receipt.output.includes(".."), false);
    assert.equal(await readFile(absTarget, "utf8"), "after\n");
  });
});
