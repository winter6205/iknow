/**
 * ADR-0092 — write tools target this identity's session tmp HOST dir.
 *
 * The session tmp host path is an independent containment root (the
 * `sessionTmpRoot` mechanism is retained). A model-supplied guest `/tmp/...`
 * literal is NO longer aliased onto it — it falls through to the containment
 * error (observable rejection, never a silent double-write).
 */
import assert from "node:assert/strict";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

describe("write_file — session tmp host dir (SC4 / S2)", () => {
  it("S2 empty: an empty path is typed-rejected and does not write taskRoot", async () => {
    const taskRoot = await makeScratch("wf-tmp-empty-root-");
    const pad = await makeScratch("wf-tmp-empty-pad-");
    const tool = createWriteFileTool(taskRoot, { tmpDir: pad });

    await assert.rejects(
      () => tool.handler({ path: "", content: "nope\n" }),
      (error: unknown) =>
        error instanceof ToolExecutionError && !error.message.includes("wrote")
    );
    assert.equal(await doesNotExist(join(taskRoot, "nope")), true);
  });

  it("S2 negative / SC4: write_file <pad>/ok.txt lands on the session tmp, not taskRoot", async () => {
    const taskRoot = await makeScratch("wf-tmp-neg-root-");
    const pad = await makeScratch("wf-tmp-neg-pad-");
    const tool = createWriteFileTool(taskRoot, { tmpDir: pad });

    await tool.handler({ path: join(pad, "ok.txt"), content: "pad-only\n" });

    assert.equal(await readFile(join(pad, "ok.txt"), "utf8"), "pad-only\n");
    assert.equal(await doesNotExist(join(taskRoot, "ok.txt")), true);
  });

  it("SC4: model-supplied /tmp/ok.txt is typed-rejected — never aliased onto the pad", async () => {
    const taskRoot = await makeScratch("wf-tmp-alias-root-");
    const pad = await makeScratch("wf-tmp-alias-pad-");
    const tool = createWriteFileTool(taskRoot, { tmpDir: pad });

    await assert.rejects(
      () => tool.handler({ path: "/tmp/ok.txt", content: "must-not-land\n" }),
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        error.message.includes("outside workspace")
    );
    assert.equal(await doesNotExist(join(pad, "ok.txt")), true);
    assert.equal(await doesNotExist(join(taskRoot, "ok.txt")), true);
  });

  it("projectDir + conversationId resolves <sessionFolder>/fence-tmp as the writable root", async () => {
    const taskRoot = await makeScratch("wf-tmp-sess-root-");
    const projectDir = await makeScratch("wf-tmp-sess-proj-");
    const tool = createWriteFileTool(taskRoot, { projectDir });

    const pad = ensureMainSessionFenceTmpForConversation(projectDir, "conv-t4");
    await tool.handler(
      { path: join(pad, "y"), content: "via-session\n" },
      { conversationId: "conv-t4" }
    );

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

  it("S2 overflow: a too-long basename under the pad does not fall into taskRoot", async () => {
    const taskRoot = await makeScratch("wf-tmp-ovf-root-");
    const pad = await makeScratch("wf-tmp-ovf-pad-");
    const tool = createWriteFileTool(taskRoot, { tmpDir: pad });
    const longName = `${"n".repeat(400)}.txt`;

    await assert.rejects(
      () => tool.handler({ path: join(pad, longName), content: "x\n" }),
      ToolExecutionError
    );
    assert.equal(await doesNotExist(join(taskRoot, longName)), true);
  });

  it("S2 concurrent: two identities write the same name to separate pads", async () => {
    const taskRoot = await makeScratch("wf-tmp-conc-root-");
    const parentPad = await makeScratch("wf-tmp-conc-parent-");
    const workerPad = await makeScratch("wf-tmp-conc-worker-");
    const parentTool = createWriteFileTool(taskRoot, { tmpDir: parentPad });
    const workerTool = createWriteFileTool(taskRoot, { tmpDir: workerPad });

    await Promise.all([
      parentTool.handler({
        path: join(parentPad, "same.txt"),
        content: "parent\n",
      }),
      workerTool.handler({
        path: join(workerPad, "same.txt"),
        content: "worker\n",
      }),
    ]);

    assert.equal(
      await readFile(join(parentPad, "same.txt"), "utf8"),
      "parent\n"
    );
    assert.equal(
      await readFile(join(workerPad, "same.txt"), "utf8"),
      "worker\n"
    );
  });

  it("worker identity does not write the parent pad", async () => {
    const taskRoot = await makeScratch("wf-tmp-iso-root-");
    const parentPad = await makeScratch("wf-tmp-iso-parent-");
    const workerPad = await makeScratch("wf-tmp-iso-worker-");
    const workerTool = createWriteFileTool(taskRoot, { tmpDir: workerPad });

    await workerTool.handler({
      path: join(workerPad, "z"),
      content: "worker-only\n",
    });

    assert.equal(await readFile(join(workerPad, "z"), "utf8"), "worker-only\n");
    assert.equal(await doesNotExist(join(parentPad, "z")), true);
  });

  it("S2 exception: unwritable pad fails typed and does not silently drop", async () => {
    const taskRoot = await makeScratch("wf-tmp-ex-root-");
    const pad = await makeScratch("wf-tmp-ex-pad-");
    await chmod(pad, 0o555);
    const tool = createWriteFileTool(taskRoot, { tmpDir: pad });

    try {
      await assert.rejects(
        () => tool.handler({ path: join(pad, "blocked.txt"), content: "x\n" }),
        ToolExecutionError
      );
      assert.equal(await doesNotExist(join(pad, "blocked.txt")), true);
      assert.equal(await doesNotExist(join(taskRoot, "blocked.txt")), true);
    } finally {
      await chmod(pad, 0o755);
    }
  });
});

describe("edit_file — session tmp host dir (SC4 / S2)", () => {
  it("S2 negative: edit_file mutates only the current identity pad", async () => {
    const taskRoot = await makeScratch("ef-tmp-neg-root-");
    const pad = await makeScratch("ef-tmp-neg-pad-");
    await writeFile(join(pad, "ok.txt"), "before\n", "utf8");
    const tool = createEditFileTool(taskRoot, { tmpDir: pad });

    await tool.handler({
      path: join(pad, "ok.txt"),
      old_str: "before",
      new_str: "after",
    });

    assert.equal(await readFile(join(pad, "ok.txt"), "utf8"), "after\n");
    assert.equal(await doesNotExist(join(taskRoot, "ok.txt")), true);
  });

  it("SC4: edit_file /tmp/ok.txt is typed-rejected (no guest /tmp alias)", async () => {
    const taskRoot = await makeScratch("ef-tmp-alias-root-");
    const pad = await makeScratch("ef-tmp-alias-pad-");
    await writeFile(join(pad, "ok.txt"), "before\n", "utf8");
    const tool = createEditFileTool(taskRoot, { tmpDir: pad });

    await assert.rejects(
      () =>
        tool.handler({
          path: "/tmp/ok.txt",
          old_str: "before",
          new_str: "after",
        }),
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        error.message.includes("outside workspace")
    );
    assert.equal(await readFile(join(pad, "ok.txt"), "utf8"), "before\n");
  });

  it("S2 empty: an empty path is typed-rejected and does not write taskRoot", async () => {
    const taskRoot = await makeScratch("ef-tmp-empty-root-");
    const pad = await makeScratch("ef-tmp-empty-pad-");
    await mkdir(join(taskRoot, "keep"), { recursive: true });
    const tool = createEditFileTool(taskRoot, { tmpDir: pad });

    await assert.rejects(
      () =>
        tool.handler({
          path: "",
          old_str: "a",
          new_str: "b",
        }),
      ToolExecutionError
    );
    assert.equal(await doesNotExist(join(taskRoot, "ok.txt")), true);
  });
});
