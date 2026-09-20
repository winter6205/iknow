/**
 * read_file — the session tmp pad is a first-class read root (same identity
 * resolution as ADR-0092).
 *
 * Shares `resolveSessionFenceTmp` identity with write_file's `sessionTmpRoot`:
 * files on the pad (`<sessionFolder>/fence-tmp`, resolved from an explicit
 * tmpDir or from projectDir+conversationId) are readable even when the pad
 * is outside `~/.iknow` extraReadRoots. Guest literal `/tmp/...` paths are
 * still typed-rejected and never aliased. Legacy factory calls without
 * tmpDir/projectDir are byte-for-byte unchanged.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";

import { ToolExecutionError } from "../../../../src/harness/errors.ts";
import { createReadFileTool } from "../../../../src/harness/aci/tools/read-file.ts";
import { ensureMainSessionFenceTmpForConversation } from "../../../../src/harness/sandbox/fence-tmp.ts";

const scratchPaths: string[] = [];

async function makeScratch(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  scratchPaths.push(path);
  return path;
}

async function doesNotExist(path: string): Promise<boolean> {
  try {
    await readFile(path);
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

describe("read_file — session tmp pad as first-class read root", () => {
  it("reads a file on an explicit tmpDir pad outside ~/.iknow extraReadRoots", async () => {
    const root = await makeScratch("rf-tmp-root-");
    const pad = await makeScratch("rf-tmp-pad-");
    await writeFile(join(pad, "scratch.txt"), "pad content\n", "utf8");

    const tool = createReadFileTool(root, { tmpDir: pad });
    const result = (await tool.handler({
      path: join(pad, "scratch.txt"),
    })) as string;

    assert.equal(result, "     1\tpad content");
  });

  it("reads <sessionFolder>/fence-tmp resolved from projectDir + ctx.conversationId", async () => {
    const root = await makeScratch("rf-sess-root-");
    const projectDir = await makeScratch("rf-sess-proj-");
    const pad = ensureMainSessionFenceTmpForConversation(
      projectDir,
      "conv-t1-read"
    );
    await writeFile(join(pad, "note.txt"), "via session\n", "utf8");

    const tool = createReadFileTool(root, { projectDir });
    const result = (await tool.handler(
      { path: join(pad, "note.txt") },
      { conversationId: "conv-t1-read" }
    )) as string;

    assert.equal(result, "     1\tvia session");
  });

  it("worker identity pad reads do not open the parent pad", async () => {
    const root = await makeScratch("rf-iso-root-");
    const parentPad = await makeScratch("rf-iso-parent-");
    const workerPad = await makeScratch("rf-iso-worker-");
    await writeFile(join(parentPad, "private.txt"), "parent only\n", "utf8");

    const workerTool = createReadFileTool(root, { tmpDir: workerPad });
    await assert.rejects(
      () => workerTool.handler({ path: join(parentPad, "private.txt") }),
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        error.message.includes("outside workspace")
    );
  });

  it("SC4: reading /tmp/... is typed-rejected and never aliased onto the pad", async () => {
    const root = await makeScratch("rf-alias-root-");
    const pad = await makeScratch("rf-alias-pad-");
    await writeFile(join(pad, "ok.txt"), "pad original\n", "utf8");

    const tool = createReadFileTool(root, { tmpDir: pad });
    await assert.rejects(
      () => tool.handler({ path: "/tmp/ok.txt" }),
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        error.message.includes("outside workspace")
    );
    // No aliasing: reading a literal /tmp path must not touch or create
    // files on the pad.
    assert.equal(await readFile(join(pad, "ok.txt"), "utf8"), "pad original\n");
  });

  it("relative reads still resolve against the live root with a pad threaded", async () => {
    const root = await makeScratch("rf-rel-root-");
    const pad = await makeScratch("rf-rel-pad-");
    await writeFile(join(root, "kept.txt"), "delivery\n", "utf8");

    const tool = createReadFileTool(root, { tmpDir: pad });
    const result = (await tool.handler({ path: "kept.txt" })) as string;

    assert.equal(result, "     1\tdelivery");
  });

  it("legacy factory call without tmpDir/projectDir still rejects paths outside the root", async () => {
    const root = await makeScratch("rf-legacy-root-");
    const outside = await makeScratch("rf-legacy-outside-");
    await writeFile(join(outside, "secret.txt"), "private\n", "utf8");

    const tool = createReadFileTool(root);
    await assert.rejects(
      () => tool.handler({ path: join(outside, "secret.txt") }),
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        error.message.includes("outside workspace")
    );
  });
});
