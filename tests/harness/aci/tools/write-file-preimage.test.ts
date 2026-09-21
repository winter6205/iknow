/**
 * ADR-0036 E2E: a real write tool fires the preimage port BEFORE writing.
 * End-to-end through createWriteFileTool's handler (no gate host passed → the
 * ADR-0084 last-read gate is off, so an overwrite is allowed): pins that
 *   - the injected capture is called exactly once, just before the write, with
 *     preBytes = current on-disk content (empty for a brand-new file) and
 *     postBytes = the incoming content, plus relPath/rootIdentity/ids forwarded
 *   - a THROWING capture aborts the write: the handler rejects and the target
 *     file is left untouched on disk (bytes never hit disk)
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, it } from "vitest";

import { createWriteFileTool } from "../../../../src/harness/aci/tools/write-file.ts";
import type { PreimageCaptureInput } from "../../../../src/harness/aci/preimage-port.ts";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "iknow-wf-preimg-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const ctx = { toolUseId: "tu-1", conversationId: "conv-1" };

describe("write_file → preimage port E2E", () => {
  it("(i) 覆盖已存在文件: capture 恰被调用一次, pre=旧内容 post=新内容, ids/relPath 转发", async () => {
    const file = join(root, "existing.ts");
    const oldContent = "const old = 1;\n";
    const newContent = "const new = 2;\n";
    await writeFile(file, oldContent, "utf8");

    const seen: PreimageCaptureInput[] = [];
    const tool = createWriteFileTool(root, {
      preimageCapture: (i) => {
        seen.push(i);
      },
      rootIdentity: "/canonical/id",
    });

    await tool.handler({ path: "existing.ts", content: newContent }, ctx);

    assert.equal(seen.length, 1, "端口须在写之前恰调用一次");
    const inp = seen[0]!;
    assert.equal(inp.preBytes.toString("utf8"), oldContent);
    assert.equal(inp.postBytes.toString("utf8"), newContent);
    assert.equal(inp.relPath, relative(root, file));
    assert.equal(inp.relPath, "existing.ts");
    assert.equal(inp.rootIdentity, "/canonical/id");
    assert.equal(inp.toolUseId, "tu-1");
    assert.equal(inp.conversationId, "conv-1");
    // 写确实发生了
    assert.equal(await readFile(file, "utf8"), newContent);
  });

  it("(i') 新建文件: preBytes 为空 (create 无前像)", async () => {
    const seen: PreimageCaptureInput[] = [];
    const tool = createWriteFileTool(root, {
      preimageCapture: (i) => {
        seen.push(i);
      },
    });
    await tool.handler({ path: "brand-new.ts", content: "fresh\n" }, ctx);

    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.preBytes.length, 0);
    assert.equal(seen[0]!.postBytes.toString("utf8"), "fresh\n");
    // rootIdentity 缺席 → 回退到 live root
    assert.equal(seen[0]!.rootIdentity, root);
    assert.equal(await readFile(join(root, "brand-new.ts"), "utf8"), "fresh\n");
  });

  it("(ii) 抛出的 capture → handler reject 且目标文件保持原样 (字节从未落盘)", async () => {
    const file = join(root, "protected.ts");
    const oldContent = "MUST NOT CHANGE\n";
    await writeFile(file, oldContent, "utf8");

    const tool = createWriteFileTool(root, {
      preimageCapture: async () => {
        throw new Error("capture refused");
      },
    });

    await assert.rejects(async () => {
      await tool.handler({ path: "protected.ts", content: "OVERWRITE\n" }, ctx);
    }, /capture refused/);
    // 写被 abort: 盘上仍是旧内容
    assert.equal(await readFile(file, "utf8"), oldContent);
  });
});
