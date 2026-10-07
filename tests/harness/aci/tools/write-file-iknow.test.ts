/**
 * write_file — `~/.iknow/` stays cwd-scoped even though read_file may read it.
 *
 * Containment-relaxation regression guard. The read tool gained `~/.iknow/`
 * as an extra read root, but the write tool's `resolveWithinRoot` call MUST
 * NOT receive that extra root. Isolated HOME stubbing (process.env.HOME) so
 * the test does not touch real user data — `os.homedir()` reads HOME on POSIX.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";

import { ToolExecutionError } from "../../../../src/harness/errors.ts";
import { createWriteFileTool } from "../../../../src/harness/aci/tools/write-file.ts";

const scratchPaths: string[] = [];

async function makeScratch(prefix: string): Promise<string> {
  const p = await mkdtemp(join(tmpdir(), prefix));
  scratchPaths.push(p);
  return p;
}

let origHome: string | undefined;
let fakeHome: string;

beforeAll(async () => {
  origHome = process.env.HOME;
  fakeHome = await makeScratch("write-file-iknow-home-");
  process.env.HOME = fakeHome;
});

afterAll(async () => {
  process.env.HOME = origHome;
  await Promise.all(
    scratchPaths.splice(0).map((p) => rm(p, { recursive: true, force: true }))
  );
});

describe("write_file — ~/.iknow stays cwd-scoped (regression guard)", () => {
  it("rejects writes into ~/.iknow/ even though read_file may read it", async () => {
    const root = await makeScratch("write-file-iknow-root-");
    const target = join(fakeHome, ".iknow", "user.md");
    const tool = createWriteFileTool(root);

    await assert.rejects(
      async () =>
        tool.handler({
          path: target,
          content: "tampered\n",
          create_directories: false,
        }),
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        error.message.includes("outside workspace")
    );
  });
});
