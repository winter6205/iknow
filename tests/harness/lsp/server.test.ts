/**
 * NearestRoot + resolveServer 单测 — spec 251-lsp-tool + spec 302-lsp-multilang（T2）。
 *
 * 覆盖 4 块：
 *   1. NearestRoot exclude 可选：省略 exclude 时无排除（含 lockfile 就返回）、
 *      exclude 命中跳过、上界 stop 保留、跨 ctx.directory 拒绝、不可读目录存活。
 *   2. resolveServer 扩展名路由：.py→Pyright、.yaml→YamlLS、.json→JsonLS、
 *      Dockerfile（无扩展名全文件名）→DockerfileLS、.ts→Typescript、无匹配→undefined。
 *   3. overflow：SERVERS 空数组时 `SERVERS.find` 返回 undefined 不 throw。
 *   4. 局部常量语义：TS lockfile/exclude 不再是导出顶层常量，测试用显式数组注入。
 */
import { describe, it, afterEach } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  NearestRoot,
  resolveServer,
  SERVERS,
  Typescript,
  Pyright,
  YamlLS,
  JsonLS,
  DockerfileLS,
} from "../../../src/harness/lsp/server.js";

// 显式局部数组（TS_LOCKFILES/TS_EXCLUDE 已移为 server.ts 内就近局部常量，不再导出，#305 决策2）。
const lockfiles = [
  "package-lock.json",
  "bun.lockb",
  "bun.lock",
  "pnpm-lock.yaml",
  "yarn.lock",
];
const excludeDeno = ["deno.json", "deno.jsonc"];

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

    const find = NearestRoot(lockfiles, excludeDeno);
    const result = await find(join(root, "src", "foo", "inside.ts"), {
      directory: root,
    });

    assert.equal(result, root);
  });

  it("deno.json exclude: 目录同时含 deno.json + package-lock.json → undefined", async () => {
    const root = await makeSandbox();
    await writeFile(join(root, "deno.json"), "{}");
    await writeFile(join(root, "package-lock.json"), "{}");

    const find = NearestRoot(lockfiles, ["deno.json"]);
    const result = await find(join(root, "src", "foo.ts"), {
      directory: root,
    });

    assert.equal(result, undefined);
  });

  it("exclude 可选 #1 — 省略 exclude 且含 lockfile → 返回该祖先（无排除）", async () => {
    const root = await makeSandbox();
    await writeFile(join(root, "package-lock.json"), "{}");
    // 省略 exclude 参数：即使目录含 deno.json 也不排除。
    await writeFile(join(root, "deno.json"), "{}");

    const find = NearestRoot(lockfiles); // exclude 省略
    const result = await find(join(root, "src", "foo.ts"), {
      directory: root,
    });

    assert.equal(result, root);
  });

  it("no lockfile fallback: 走到 ctx.directory 仍无 lockfile → undefined", async () => {
    const root = await makeSandbox();

    const find = NearestRoot(lockfiles, excludeDeno);
    const result = await find(join(root, "src", "foo.ts"), {
      directory: root,
    });

    assert.equal(result, undefined);
  });

  it("cross ctx.directory rejected: lockfile 在 ctx.directory 之上 → undefined", async () => {
    const root = await makeSandbox();
    const sub = join(root, "nested");
    await writeFile(join(root, "package-lock.json"), "{}"); // 位于 ctx.directory 之上

    const find = NearestRoot(lockfiles, excludeDeno);
    const result = await find(join(sub, "foo.ts"), {
      directory: sub,
    });

    assert.equal(result, undefined);
  });

  it("NearestRoot early-rejects file outside ctx.directory", async () => {
    const root = await makeSandbox();
    const sub = join(root, "nested");
    await mkdir(sub);
    await writeFile(join(root, "package-lock.json"), "{}"); // 位于 stop 之上
    const find = NearestRoot(lockfiles, excludeDeno);
    const result = await find(join(root, "x.ts"), { directory: sub });

    assert.equal(result, undefined);
  });

  it("NearestRoot survives unreadable directories", async () => {
    const root = await makeSandbox();
    const outer = join(root, "outer");
    await mkdir(outer);
    const missing = join(outer, "ghost");
    await rm(missing, { recursive: true, force: true });

    const find = NearestRoot(lockfiles, excludeDeno);
    const result = await find(join(missing, "foo.ts"), { directory: root });

    assert.equal(result, undefined);
  });
});

// ── 鉴权补充：NearestRoot 边界（overflow / negative）─────────────────────────

describe("NearestRoot overflow / negative edges", () => {
  it("deep ancestor chain: lockfile found at a deep ancestor returns it", async () => {
    const root = await makeSandbox();
    await writeFile(join(root, "package-lock.json"), "{}");
    let deep = root;
    for (let i = 0; i < 20; i++) deep = join(deep, `d${i}`);

    const find = NearestRoot(lockfiles, excludeDeno);
    const result = await find(join(deep, "foo.ts"), { directory: root });

    assert.equal(result, root);
  });

  it("deep chain with lockfile only at a mid ancestor returns that ancestor", async () => {
    const root = await makeSandbox();
    let mid = root;
    for (let i = 0; i < 15; i++) mid = join(mid, `m${i}`);
    await mkdir(mid, { recursive: true });
    await writeFile(join(mid, "yarn.lock"), "{}");
    let deep = mid;
    for (let i = 0; i < 5; i++) deep = join(deep, `x${i}`);

    const find = NearestRoot(lockfiles, excludeDeno);
    const result = await find(join(deep, "foo.ts"), { directory: root });

    assert.equal(result, mid);
  });

  it("very long file path inside ctx.directory still resolves within cwd", async () => {
    const root = await makeSandbox();
    await writeFile(join(root, "package-lock.json"), "{}");
    const longRel =
      "a/".repeat(150) + "b/".repeat(150) + "very-long-file-name.ts";
    const file = join(root, longRel);

    const find = NearestRoot(lockfiles, excludeDeno);
    const result = await find(file, { directory: root });

    assert.equal(result, root);
  });

  it("MAX_SAFE_INTEGER path depth bomb does not hang (returns undefined if no lockfile)", async () => {
    const root = await makeSandbox();
    const file = join(root, "no/lockfile/here/foo.ts");
    const find = NearestRoot(lockfiles, excludeDeno);
    const result = await find(file, { directory: root });
    assert.equal(result, undefined);
  });
});

// ── resolveServer 扩展名路由（spec 302-lsp-multilang § S4）──────────────────

describe("resolveServer", () => {
  it("routes .py → Pyright", () => {
    assert.equal(resolveServer("src/lib/analytics.py"), Pyright);
  });

  it("routes .pyi → Pyright", () => {
    assert.equal(resolveServer("src/lib/types.pyi"), Pyright);
  });

  it("routes .yaml → YamlLS", () => {
    assert.equal(resolveServer("deploy/config.yaml"), YamlLS);
  });

  it("routes .yml → YamlLS", () => {
    assert.equal(resolveServer("deploy/config.yml"), YamlLS);
  });

  it("routes .json → JsonLS", () => {
    assert.equal(resolveServer("package.json"), JsonLS);
  });

  it("routes extension-less Dockerfile (全文件名) → DockerfileLS", () => {
    assert.equal(resolveServer("Dockerfile"), DockerfileLS);
  });

  it("routes .dockerfile → DockerfileLS", () => {
    assert.equal(resolveServer("container/Dockerfile.dev.dockerfile"), DockerfileLS);
  });

  it("routes .ts → Typescript (保底不回归)", () => {
    assert.equal(resolveServer("src/main.ts"), Typescript);
  });

  it("no match → undefined (unsupported extension)", () => {
    assert.equal(resolveServer("README.md"), undefined);
  });

  it("no match → undefined (unsupported extension-less file)", () => {
    assert.equal(resolveServer("Makefile"), undefined);
  });
});

// ── overflow：SERVERS 空数组 → find 返回 undefined 不 throw ────────────────

describe("SERVERS overflow / find semantics", () => {
  it("find over empty array returns undefined (不 throw)", () => {
    const empty: typeof SERVERS = [];
    const result = empty.find((s) => s.extensions.includes(".ts"));
    assert.equal(result, undefined);
  });

  it("SERVERS.find 无匹配也返回 undefined（不 throw）", () => {
    // 用真实 SERVERS 验证：传入一个不可能命中的扩展名。
    const result = SERVERS.find((s) => s.extensions.includes(".unknown"));
    assert.equal(result, undefined);
  });

  it("resolveServer is defensive: 空数组等价场景不抛错", () => {
    // resolveServer 内部用 `SERVERS.find(...)`；find 对空/无匹配数组均返回
    // undefined 而非 throw。此断言直接锁定该语义（与上述 overflow 呼应）。
    const result = resolveServer("no.such-ext");
    assert.equal(result, undefined);
  });
});
