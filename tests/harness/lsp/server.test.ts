/**
 * NearestRoot + TS lockfile 常量单测 — spec 251-lsp-tool（T2）。
 *
 * 覆盖 4 个 case：
 *   1. lockfile hit：祖先含 package-lock.json → 返回该祖先；
 *   2. deno.json exclude：祖先同时含 deno.json + package-lock.json → undefined；
 *   3. no lockfile fallback：走到 ctx.directory 仍无 lockfile → undefined；
 *   4. cross ctx.directory rejected：lockfile 在 ctx.directory 之上 → undefined。
 */
import { describe, it, afterEach } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  NearestRoot,
  TS_LOCKFILES,
  TS_EXCLUDE,
} from "../../../src/harness/lsp/server.js";

const tmpDirs: string[] = [];

async function makeSandbox(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "lsp-server-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))
  );
});

describe("NearestRoot", () => {
  it("lockfile hit: 祖先含 package-lock.json → 返回该祖先目录", async () => {
    const root = await makeSandbox();
    await writeFile(join(root, "package-lock.json"), "{}");

    const find = NearestRoot(TS_LOCKFILES, TS_EXCLUDE);
    const result = await find(join(root, "src", "foo", "inside.ts"), {
      directory: root,
    });

    assert.equal(result, root);
  });

  it("deno.json exclude: 目录同时含 deno.json + package-lock.json → undefined", async () => {
    const root = await makeSandbox();
    await writeFile(join(root, "deno.json"), "{}");
    await writeFile(join(root, "package-lock.json"), "{}");

    const find = NearestRoot(TS_LOCKFILES, ["deno.json"]);
    const result = await find(join(root, "src", "foo.ts"), {
      directory: root,
    });

    assert.equal(result, undefined);
  });

  it("no lockfile fallback: 走到 ctx.directory 仍无 lockfile → undefined", async () => {
    const root = await makeSandbox();

    const find = NearestRoot(TS_LOCKFILES, TS_EXCLUDE);
    const result = await find(join(root, "src", "foo.ts"), {
      directory: root,
    });

    assert.equal(result, undefined);
  });

  it("cross ctx.directory rejected: lockfile 在 ctx.directory 之上 → undefined", async () => {
    const root = await makeSandbox();
    // ctx.directory 的子目录:lockfile 放 ctx.directory 之前的父级(即 root 之上不存在)。
    // 构造:ctx.directory = root/sub,lockfile 放 root(在 ctx.directory 之上)。
    // 但 root 是 mkdtemp 的临时根,其上没有 lockfile;这里用嵌套目录模拟 stop 边界。
    const sub = join(root, "nested");
    await writeFile(join(root, "package-lock.json"), "{}"); // 位于 ctx.directory 之上

    const find = NearestRoot(TS_LOCKFILES, TS_EXCLUDE);
    const result = await find(join(sub, "foo.ts"), {
      directory: sub,
    });

    assert.equal(result, undefined);
  });
});
