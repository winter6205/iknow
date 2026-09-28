/**
 * read_file — the session tmp pad is a first-class read root (same identity
 * resolution as ADR-0092).
 *
 * Shares `resolveSessionFenceTmp` identity with write_file's `sessionTmpRoot`:
 * files on the pad (`<sessionFolder>/fence-tmp`, resolved from an explicit
 * tmpDir or from projectDir+conversationId) are readable even when the pad
 * is outside `~/.iknow` extraReadRoots. Guest literal `/tmp/...` paths are
 * never aliased onto the pad — since ADR-0128 host reach they are ordinary
 * host paths decided by the canonical policy on their literal form, so a
 * missing one is typed-rejected as not-found instead of reach-denied. Legacy
 * factory calls without tmpDir/projectDir keep pad semantics unchanged and
 * reach ordinary outside paths through the policy arm.
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

  it("a worker pad does not fence parent-pad reads, but never aliases them onto the pad (ADR-0128)", async () => {
    const root = await makeScratch("rf-iso-root-");
    const parentPad = await makeScratch("rf-iso-parent-");
    const workerPad = await makeScratch("rf-iso-worker-");
    await writeFile(join(parentPad, "private.txt"), "parent only\n", "utf8");

    const workerTool = createReadFileTool(root, { tmpDir: workerPad });
    // The absolute parent pad is an ordinary host path: reachable through the
    // canonical policy arm, not because the worker pad admits it.
    const result = (await workerTool.handler({
      path: join(parentPad, "private.txt"),
    })) as string;
    assert.equal(result, "     1\tparent only");
    // No aliasing: a bare name still anchors at the live root, never the pad.
    await assert.rejects(
      () => workerTool.handler({ path: "private.txt" }),
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        /file not found/.test(error.message)
    );
  });

  it("SC4: reading a literal /tmp path is never aliased onto the pad", async () => {
    const root = await makeScratch("rf-alias-root-");
    const pad = await makeScratch("rf-alias-pad-");
    await writeFile(join(pad, "ok.txt"), "pad original\n", "utf8");

    const guestPath = join(
      "/tmp",
      `rf-never-alias-${process.pid}-${Date.now()}.txt`
    );
    const tool = createReadFileTool(root, { tmpDir: pad });
    // ADR-0128: the literal /tmp path is decided on its own canonical form —
    // missing means typed not-found, never a silent redirect to the pad's ok.txt.
    await assert.rejects(
      () => tool.handler({ path: guestPath }),
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        /file not found/.test(error.message) &&
        !error.message.includes(join(pad, "ok.txt"))
    );
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

  it("legacy factory call without tmpDir/projectDir reaches ordinary outside paths (ADR-0128)", async () => {
    const root = await makeScratch("rf-legacy-root-");
    const outside = await makeScratch("rf-legacy-outside-");
    await writeFile(join(outside, "secret.txt"), "private\n", "utf8");

    const tool = createReadFileTool(root);
    const result = (await tool.handler({
      path: join(outside, "secret.txt"),
    })) as string;

    assert.equal(result, "     1\tprivate");
  });
});
