/**
 * T2 — write tools may write the current identity's fence `/tmp`
 * (specs/parent-visible-tmp.md SC2 + S2-A; amends mutate-write-contract SC4).
 */
import assert from "node:assert/strict";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { afterEach, describe, it } from "vitest";

import { ToolExecutionError } from "../../../../src/harness/errors.ts";
import { createWriteFileTool } from "../../../../src/harness/aci/tools/write-file.ts";
import { createEditFileTool } from "../../../../src/harness/aci/tools/edit-file.ts";
import { ensureMainSessionFenceTmpForConversation } from "../../../../src/harness/sandbox/fence-tmp.ts";

const scratchPaths: string[] = [];

async function makeScratch(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  scratchPaths.push(path);
  return path;
}

async function doesNotExist(path: string): Promise<boolean> {
  try {
    await access(path);
    return false;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENAMETOOLONG") return true;
    throw error;
  }
}

afterEach(async () => {
  await Promise.all(
    scratchPaths
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe("write_file — current-identity /tmp pad (SC2 / S2-A)", () => {
  it("S2-A empty: /tmp/ is typed-rejected and does not write taskRoot", async () => {
    const taskRoot = await makeScratch("wf-tmp-empty-root-");
    const pad = await makeScratch("wf-tmp-empty-pad-");
    const tool = createWriteFileTool(taskRoot, { tmpDir: pad });

    await assert.rejects(
      () => tool.handler({ path: "/tmp/", content: "nope\n" }),
      (error: unknown) =>
        error instanceof ToolExecutionError && !error.message.includes("wrote")
    );
    assert.equal(await doesNotExist(join(taskRoot, "nope")), true);
    const leftover = await readFile(join(taskRoot, "tmp"), "utf8").catch(
      () => ""
    );
    assert.equal(leftover, "");
  });

  it("S2-A negative / SC2: /tmp/ok.txt lands only on the current identity pad", async () => {
    const taskRoot = await makeScratch("wf-tmp-neg-root-");
    const pad = await makeScratch("wf-tmp-neg-pad-");
    const tool = createWriteFileTool(taskRoot, { tmpDir: pad });

    await tool.handler({ path: "/tmp/ok.txt", content: "pad-only\n" });

    assert.equal(await readFile(join(pad, "ok.txt"), "utf8"), "pad-only\n");
    assert.equal(await doesNotExist(join(taskRoot, "ok.txt")), true);
    assert.equal(await doesNotExist(join(taskRoot, "tmp", "ok.txt")), true);
  });

  it("SC2: write_file /tmp/y does not copy into taskRoot", async () => {
    const taskRoot = await makeScratch("wf-tmp-sc2-root-");
    const pad = await makeScratch("wf-tmp-sc2-pad-");
    const tool = createWriteFileTool(taskRoot, { tmpDir: pad });

    const result = (await tool.handler({
      path: "/tmp/y",
      content: "sc2-body\n",
    })) as { output: string };

    assert.equal(await readFile(join(pad, "y"), "utf8"), "sc2-body\n");
    assert.equal(await doesNotExist(join(taskRoot, "y")), true);
    assert.match(result.output, /wrote/);
  });

  it("projectDir + conversationId writes /tmp/y onto that session fence-tmp pad", async () => {
    const taskRoot = await makeScratch("wf-tmp-sess-root-");
    const projectDir = await makeScratch("wf-tmp-sess-proj-");
    const tool = createWriteFileTool(taskRoot, { projectDir });

    await tool.handler(
      { path: "/tmp/y", content: "via-session\n" },
      { conversationId: "conv-t2" }
    );

    const pad = ensureMainSessionFenceTmpForConversation(projectDir, "conv-t2");
    assert.equal(await readFile(join(pad, "y"), "utf8"), "via-session\n");
    assert.equal(await doesNotExist(join(taskRoot, "y")), true);
  });

  it("relative taskRoot writes still land in taskRoot (no regression)", async () => {
    const taskRoot = await makeScratch("wf-tmp-rel-root-");
    const pad = await makeScratch("wf-tmp-rel-pad-");
    const tool = createWriteFileTool(taskRoot, { tmpDir: pad });

    await tool.handler({ path: "kept.txt", content: "delivery\n" });

    assert.equal(
      await readFile(join(taskRoot, "kept.txt"), "utf8"),
      "delivery\n"
    );
    assert.equal(await doesNotExist(join(pad, "kept.txt")), true);
  });

  it("S2-A overflow: a too-long /tmp basename does not land in taskRoot", async () => {
    const taskRoot = await makeScratch("wf-tmp-ovf-root-");
    const pad = await makeScratch("wf-tmp-ovf-pad-");
    const tool = createWriteFileTool(taskRoot, { tmpDir: pad });
    const longName = `${"n".repeat(400)}.txt`;

    await assert.rejects(
      () => tool.handler({ path: `/tmp/${longName}`, content: "x\n" }),
      ToolExecutionError
    );
    assert.equal(await doesNotExist(join(taskRoot, longName)), true);
    assert.equal(await doesNotExist(join(taskRoot, "tmp", longName)), true);
  });

  it("S2-A concurrent: two identities writing /tmp/same.txt do not overwrite each other", async () => {
    const taskRoot = await makeScratch("wf-tmp-conc-root-");
    const parentPad = await makeScratch("wf-tmp-conc-parent-");
    const workerPad = await makeScratch("wf-tmp-conc-worker-");
    const parentTool = createWriteFileTool(taskRoot, { tmpDir: parentPad });
    const workerTool = createWriteFileTool(taskRoot, { tmpDir: workerPad });

    await Promise.all([
      parentTool.handler({ path: "/tmp/same.txt", content: "parent\n" }),
      workerTool.handler({ path: "/tmp/same.txt", content: "worker\n" }),
    ]);

    assert.equal(
      await readFile(join(parentPad, "same.txt"), "utf8"),
      "parent\n"
    );
    assert.equal(
      await readFile(join(workerPad, "same.txt"), "utf8"),
      "worker\n"
    );
    assert.equal(await doesNotExist(join(taskRoot, "same.txt")), true);
  });

  it("worker identity does not write the parent pad", async () => {
    const taskRoot = await makeScratch("wf-tmp-iso-root-");
    const parentPad = await makeScratch("wf-tmp-iso-parent-");
    const workerPad = await makeScratch("wf-tmp-iso-worker-");
    const workerTool = createWriteFileTool(taskRoot, { tmpDir: workerPad });

    await workerTool.handler({ path: "/tmp/z", content: "worker-only\n" });

    assert.equal(await readFile(join(workerPad, "z"), "utf8"), "worker-only\n");
    assert.equal(await doesNotExist(join(parentPad, "z")), true);
  });

  it("S2-A exception: unwritable pad fails typed and does not silently drop", async () => {
    const taskRoot = await makeScratch("wf-tmp-ex-root-");
    const pad = await makeScratch("wf-tmp-ex-pad-");
    await chmod(pad, 0o555);
    const tool = createWriteFileTool(taskRoot, { tmpDir: pad });

    try {
      await assert.rejects(
        () => tool.handler({ path: "/tmp/blocked.txt", content: "x\n" }),
        ToolExecutionError
      );
      assert.equal(await doesNotExist(join(pad, "blocked.txt")), true);
      assert.equal(await doesNotExist(join(taskRoot, "blocked.txt")), true);
    } finally {
      await chmod(pad, 0o755);
    }
  });
});

describe("edit_file — current-identity /tmp pad (SC2 / S2-A)", () => {
  it("S2-A negative: edit_file /tmp/ok.txt mutates the current identity pad only", async () => {
    const taskRoot = await makeScratch("ef-tmp-neg-root-");
    const pad = await makeScratch("ef-tmp-neg-pad-");
    await writeFile(join(pad, "ok.txt"), "before\n", "utf8");
    const tool = createEditFileTool(taskRoot, { tmpDir: pad });

    await tool.handler({
      path: "/tmp/ok.txt",
      old_str: "before",
      new_str: "after",
    });

    assert.equal(await readFile(join(pad, "ok.txt"), "utf8"), "after\n");
    assert.equal(await doesNotExist(join(taskRoot, "ok.txt")), true);
  });

  it("S2-A empty: /tmp/ is typed-rejected and does not write taskRoot", async () => {
    const taskRoot = await makeScratch("ef-tmp-empty-root-");
    const pad = await makeScratch("ef-tmp-empty-pad-");
    await mkdir(join(taskRoot, "keep"), { recursive: true });
    const tool = createEditFileTool(taskRoot, { tmpDir: pad });

    await assert.rejects(
      () =>
        tool.handler({
          path: "/tmp/",
          old_str: "a",
          new_str: "b",
        }),
      ToolExecutionError
    );
    assert.equal(await doesNotExist(join(taskRoot, "ok.txt")), true);
  });
});
