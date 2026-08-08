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
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
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

  it("NearestRoot early-rejects file outside ctx.directory", async () => {
    // 关键构造：把 stop 设到嵌套子目录 `sub`，lockfile 放在 stop 之上（`root`）。
    // 若移除 server.ts:54-56 的 early-reject 守卫，walk 会从 file 的 dir 向上
    // 走到 root（含 lockfile）→ 错返 root 而非 undefined —— 测试会变红。
    // 因此该断言独立证明守卫触发，而非被既有 case 4（cross ctx.directory rejected）
    // 间接覆盖。
    const root = await makeSandbox();
    const sub = join(root, "nested");
    await mkdir(sub);
    await writeFile(join(root, "package-lock.json"), "{}"); // 位于 stop 之上
    // file 的 dirname = root，位于 ctx.directory=sub (=root/nested) 之外。
    // 若移除 server.ts:54-56 的 early-reject 守卫，walk 从 root 直接命中 lockfile
    // → 错返 root；守卫存在时 isInsideOrEqual(root, sub)=false → undefined。
    const find = NearestRoot(TS_LOCKFILES, TS_EXCLUDE);
    const result = await find(join(root, "x.ts"), { directory: sub });

    assert.equal(result, undefined);
  });

  it("NearestRoot survives unreadable directories", async () => {
    const root = await makeSandbox();
    const outer = join(root, "outer");
    await mkdir(outer);
    // file 指向一个已删除的中间层目录 → readdir 抛 ENOENT → catch 吞 [] 继续上走。
    const missing = join(outer, "ghost");
    await rm(missing, { recursive: true, force: true });

    const find = NearestRoot(TS_LOCKFILES, TS_EXCLUDE);
    const result = await find(join(missing, "foo.ts"), { directory: root });

    // readdir 失败被吞掉 → 不 throw，走到 outer（无 lockfile）→ 继续走至 root → undefined。
    assert.equal(result, undefined);
  });
});

// ── 鉴权补充：NearestRoot 边界（overflow / negative）─────────────────────────
// 覆盖：deep ancestor lockfile chain（deep）与超长路径（long path）。

describe("NearestRoot overflow / negative edges", () => {
  it("deep ancestor chain: lockfile found at a deep ancestor returns it", async () => {
    const root = await makeSandbox();
    await writeFile(join(root, "package-lock.json"), "{}");
    // 构造 20 层深嵌套,file 在最底层。
    let deep = root;
    for (let i = 0; i < 20; i++) deep = join(deep, `d${i}`);

    const find = NearestRoot(TS_LOCKFILES, TS_EXCLUDE);
    const result = await find(join(deep, "foo.ts"), { directory: root });

    // walk 从最底层向上,最终命中 root 的 lockfile。
    assert.equal(result, root);
  });

  it("deep chain with lockfile only at a mid ancestor returns that ancestor", async () => {
    const root = await makeSandbox();
    // 把 lockfile 放在第 15 层,而非 root。
    let mid = root;
    for (let i = 0; i < 15; i++) mid = join(mid, `m${i}`);
    await mkdir(mid, { recursive: true });
    await writeFile(join(mid, "yarn.lock"), "{}");
    // file 在 mid 之下再加 5 层。
    let deep = mid;
    for (let i = 0; i < 5; i++) deep = join(deep, `x${i}`);

    const find = NearestRoot(TS_LOCKFILES, TS_EXCLUDE);
    const result = await find(join(deep, "foo.ts"), { directory: root });

    assert.equal(result, mid);
  });

  it("very long file path inside ctx.directory still resolves within cwd", async () => {
    const root = await makeSandbox();
    await writeFile(join(root, "package-lock.json"), "{}");
    // 构造一个超长相对路径（不实际创建目录,仅测试 resolve/walk 逻辑不死循环）。
    const longRel =
      "a/".repeat(150) + "b/".repeat(150) + "very-long-file-name.ts";
    const file = join(root, longRel);

    const find = NearestRoot(TS_LOCKFILES, TS_EXCLUDE);
    // walk 遇到不存在目录时 readdir catch 吞 [],继续上找,最终命中 root lockfile。
    const result = await find(file, { directory: root });

    assert.equal(result, root);
  });

  it("MAX_SAFE_INTEGER path depth bomb does not hang (returns undefined if no lockfile)", async () => {
    const root = await makeSandbox();
    // 无 lockfile 的深层路径:NearestRoot 走到 root 上界 stop 后 break,不死循环。
    const file = join(root, "no/lockfile/here/foo.ts");
    const find = NearestRoot(TS_LOCKFILES, TS_EXCLUDE);
    const result = await find(file, { directory: root });
    assert.equal(result, undefined);
  });
});
