/**
 * read_file — `~/.iknow/` profile-read is allowed by default.
 *
 * Isolated from the rest of read_file tests so we can stub HOME and avoid
 * clobbering the real `$HOME/.iknow/user.md` on every test run (ACR
 * defensive-contract fix: never touch real user data). `os.homedir()` reads
 * `process.env.HOME` on POSIX, so stubbing that env is sufficient to redirect
 * the production code into a scratch dir.
 *
 * Coverage:
 *  - reads `~/.iknow/user.md` via absolute path (resolved)
 *  - reads `~/.iknow/user.md` via `~`-expansion
 *  - reads `~/.iknow/state.json` (sibling — the whole profile dir is exposed)
 *  - symlink escape: symlink inside `~/.iknow/` whose real target is outside
 *    both cwd and `~/.iknow/` → denied (the security-critical boundary of
 *    the containment relaxation)
 *  - path outside BOTH cwd and `~/.iknow/` → denied
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";

import { ToolExecutionError } from "../../../../src/harness/errors.ts";
import { createReadFileTool } from "../../../../src/harness/aci/tools/read-file.ts";

const scratchPaths: string[] = [];

async function makeScratch(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  scratchPaths.push(path);
  return path;
}

let origHome: string | undefined;
let fakeHome: string;
let fakeIknow: string;

beforeAll(async () => {
  origHome = process.env.HOME;
  fakeHome = await makeScratch("read-file-profile-home-");
  fakeIknow = join(fakeHome, ".iknow");
  await mkdir(fakeIknow, { recursive: true });
  process.env.HOME = fakeHome;
});

afterAll(async () => {
  process.env.HOME = origHome;
  await Promise.all(
    scratchPaths.splice(0).map((p) => rm(p, { recursive: true, force: true }))
  );
});

describe("read_file — ~/.iknow profile read allowed by default (isolated HOME)", () => {
  it("reads ~/.iknow/user.md via absolute path", async () => {
    const root = await makeScratch("read-file-profile-abs-");
    await writeFile(join(fakeIknow, "user.md"), "# User Profile\n- Name: t\n");

    const tool = createReadFileTool(root);
    const result = (await tool.handler({
      path: join(fakeIknow, "user.md"),
    })) as string;

    assert.equal(result, "     1\t# User Profile\n     2\t- Name: t");
  });

  it("reads ~/.iknow/user.md via ~-expanded path", async () => {
    const root = await makeScratch("read-file-profile-tilde-");
    await writeFile(join(fakeIknow, "user.md"), "alpha\n");

    const tool = createReadFileTool(root);
    const result = (await tool.handler({
      path: "~/.iknow/user.md",
    })) as string;

    assert.equal(result, "     1\talpha");
  });

  it("reads ~/.iknow/state.json (whole ~/.iknow dir is allowed, not just user.md)", async () => {
    const root = await makeScratch("read-file-profile-state-");
    await writeFile(join(fakeIknow, "state.json"), '{"schema_version":1}\n');

    const tool = createReadFileTool(root);
    const result = (await tool.handler({
      path: "~/.iknow/state.json",
    })) as string;

    assert.equal(result, '     1\t{"schema_version":1}');
  });

  it("rejects a symlink inside ~/.iknow whose real target is outside both roots", async () => {
    const root = await makeScratch("read-file-profile-symlink-root-");
    const outside = await makeScratch("read-file-profile-symlink-outside-");
    await writeFile(join(outside, "secret.txt"), "private\n");
    await symlink(outside, join(fakeIknow, "escape"), "dir");

    const tool = createReadFileTool(root);
    await assert.rejects(
      () => tool.handler({ path: "~/.iknow/escape/secret.txt" }),
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        error.message.includes("outside workspace")
    );
  });

  it("rejects a path outside BOTH the project root and ~/.iknow", async () => {
    const root = await makeScratch("read-file-profile-other-");
    const outside = await makeScratch("read-file-profile-other-other-");
    await writeFile(join(outside, "secret.txt"), "private\n");

    const tool = createReadFileTool(root);
    await assert.rejects(
      () => tool.handler({ path: join(outside, "secret.txt") }),
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        error.message.includes("outside workspace")
    );
  });
});
