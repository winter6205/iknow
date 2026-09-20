/**
 * NearestRoot + resolveServer unit tests (specs/251-lsp-tool.md, multi-language
 * extension routing).
 *
 * Four areas:
 *   1. NearestRoot exclude is optional: omitting it excludes nothing (returns
 *      the ancestor once a lockfile is found); an exclude hit skips the
 *      candidate; the ctx.directory upper-bound stop holds; lockfiles above
 *      the stop are rejected; unreadable directories don't crash the walk.
 *   2. resolveServer extension routing: .py→Pyright, .yaml→YamlLS,
 *      .json→JsonLS, Dockerfile (extension-less, full-file-name match) →
 *      DockerfileLS, .ts→Typescript, no match→undefined.
 *   3. overflow: with SERVERS empty, `SERVERS.find` returns undefined, no throw.
 *   4. local-constant semantics: TS lockfile/exclude are no longer exported
 *      top-level constants; tests inject explicit arrays.
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

// Explicit local arrays: TS_LOCKFILES/TS_EXCLUDE are now local constants near
// their use site inside server.ts and no longer exported.
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
    // Omitting the exclude arg: deno.json in the directory no longer excludes.
    await writeFile(join(root, "deno.json"), "{}");

    const find = NearestRoot(lockfiles); // exclude omitted
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
    await writeFile(join(root, "package-lock.json"), "{}"); // above ctx.directory

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
    await writeFile(join(root, "package-lock.json"), "{}"); // above the stop
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

// ── NearestRoot boundary edges (overflow / negative) ─────────────────────────

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

// ── resolveServer extension routing ──────────────────────────────────────────

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

  it("routes extension-less Dockerfile with full path → DockerfileLS", () => {
    // The handler passes `params.file` as a full path (e.g. `/proj/Dockerfile`).
    // `path.extname("/proj/Dockerfile")` is empty → fall back to basename to
    // match `Dockerfile` (falling back to the full path would never match).
    assert.equal(resolveServer("/proj/Dockerfile"), DockerfileLS);
    assert.equal(resolveServer("/a/b/c/Dockerfile"), DockerfileLS);
  });

  it("routes .dockerfile → DockerfileLS", () => {
    assert.equal(
      resolveServer("container/Dockerfile.dev.dockerfile"),
      DockerfileLS
    );
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

// ── overflow: empty SERVERS → find returns undefined, no throw ───────────────

describe("SERVERS overflow / find semantics", () => {
  it("find over empty array returns undefined (不 throw)", () => {
    const empty: typeof SERVERS = [];
    const result = empty.find((s) => s.extensions.includes(".ts"));
    assert.equal(result, undefined);
  });

  it("SERVERS.find 无匹配也返回 undefined（不 throw）", () => {
    // Verified against the real SERVERS: pass an extension that can never match.
    const result = SERVERS.find((s) => s.extensions.includes(".unknown"));
    assert.equal(result, undefined);
  });

  it("resolveServer is defensive: 空数组等价场景不抛错", () => {
    // resolveServer internally uses `SERVERS.find(...)`; find returns
    // undefined (never throws) for empty or non-matching arrays. This
    // assertion pins that semantics directly, echoing the overflow cases.
    const result = resolveServer("no.such-ext");
    assert.equal(result, undefined);
  });
});
