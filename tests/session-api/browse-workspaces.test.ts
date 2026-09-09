/**
 * serve-workspace T2 — GET /api/v1/workspaces/browse endpoint.
 *
 * Covers the new subdirectory-probe endpoint surface introduced by
 * `serve-workspace-folder-browse.md` (plan T2):
 *  - pure function `listSubdirectories(root)` returns `{ ok, entries }` or
 *    `{ ok: false, kind, message }`.
 *  - HTTP route `GET /api/v1/workspaces/browse?root=<abs-existing-dir>`:
 *      * missing root param → 422 validation (kind=validation, field=root)
 *      * empty root        → 422 validation
 *      * relative root     → 422 validation
 *      * non-existent root → 422 validation
 *      * permission-denied → 422 validation (kind=validation; io_error
 *        hidden behind a typed `validation` so the wire stays predictable)
 *      * happy path        → 200 with `{ entries: [{ name, path }] }`,
 *        sorted lexicographically by name, only direct subdirs, hidden
 *        entries (`.git` / `.claude` / `.hidden` / etc.) excluded, files
 *        excluded, deny-list (`node_modules`) excluded, symlinks NOT
 *        followed (Dirent.isDirectory() check on lstat semantics).
 *
 * 5 类边界 (from ticket acceptance): 空目录 / 不存在 / 非绝对 / 隐藏过滤 /
 * 无权限. Each gets an isolated fixture + a deterministic assertion.
 *
 * Note: testing strategy — use real node:fs on mkdtemp temp dirs (no
 * memfs / mock-fs — the project tests use real fs consistently), and
 * `chmod 0` for the permission-denied case (real fs EACCES). This gives
 * full end-to-end coverage without dependency additions.
 */
import { afterEach, beforeEach, describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import {
  SessionHub,
  type SessionHubOptions,
} from "../../src/session-api/hub.ts";
import {
  listenSessionServer,
  type ListeningServer,
} from "../../src/session-api/http.ts";
import { SessionStore } from "../../src/session-api/store/index.ts";
import { assistantResult, makeDeps } from "../cli/_fixtures.ts";
import { listSubdirectories } from "../../src/session-api/browse-workspaces.ts";

// -- shared fixtures --------------------------------------------------------

/** 临时根目录 cleanup stack。 */
const tempRoots: string[] = [];

/** mkdtemp + 登记清理。 */
async function freshDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop()!;
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

// -- pure-function tests (no HTTP) ------------------------------------------

describe("listSubdirectories — pure function surface", () => {
  it("空目录 → 空 entries 列表", async () => {
    const root = await freshDir("iknow-browse-empty-");
    const out = await listSubdirectories(root);
    assert.deepEqual(out, { ok: true, entries: [] });
  });

  it("不存在目录 → message 含 'not found' / 'missing'", async () => {
    const out = await listSubdirectories(join(tmpdir(), "no-such-iknow-xyz"));
    assert.equal(out.ok, false);
    if (out.ok === false) {
      assert.match(out.message, /not[_ ]?found|exists|missing/i);
    }
  });

  it("非绝对路径 → message 提及 absolute", async () => {
    const out = await listSubdirectories("relative/path");
    assert.equal(out.ok, false);
    if (out.ok === false) {
      assert.match(out.message, /absolute/i);
    }
  });

  it("隐藏目录 (.git / .claude / .hidden / …) 与 deny-list (node_modules) 不进 entries", async () => {
    const root = await freshDir("iknow-browse-hide-");
    // 期望保留的子目录（按字母序排序）。
    await mkdir(join(root, "alpha"));
    await mkdir(join(root, "beta"));
    // 期望被隐藏的子目录。
    await mkdir(join(root, ".git"));
    await mkdir(join(root, ".claude"));
    await mkdir(join(root, ".hidden"));
    // 期望被 deny-list 排除的子目录。
    await mkdir(join(root, "node_modules"));
    // 期望被过滤的普通文件（不是目录）。
    await writeFile(join(root, "regular-file.txt"), "hi", "utf8");

    const out = await listSubdirectories(root);
    assert.equal(out.ok, true);
    if (out.ok === true) {
      assert.deepEqual(
        out.entries.map((e) => e.name),
        ["alpha", "beta"]
      );
      // path 必须严格 = join(root, name)。
      assert.equal(out.entries[0]?.path, join(root, "alpha"));
      assert.equal(out.entries[1]?.path, join(root, "beta"));
    }
  });

  it("symlink 目录不被跟随（仅 Dirent.isDirectory 直列）", async () => {
    const root = await freshDir("iknow-browse-sym-");
    const realDir = await freshDir("iknow-browse-real-");
    await symlink(realDir, join(root, "linked"));
    // 一个真子目录（对照）。
    await mkdir(join(root, "real-child"));

    const out = await listSubdirectories(root);
    assert.equal(out.ok, true);
    if (out.ok === true) {
      // symlink 不跟（withFileTypes 的 Dirent.isDirectory() 在 lstat 下为 false），
      // 只剩真子目录。
      assert.deepEqual(
        out.entries.map((e) => e.name),
        ["real-child"]
      );
    }
  });

  it("排序按 name 字母序（与 `readdir` 自然序一致）", async () => {
    const root = await freshDir("iknow-browse-sort-");
    // 故意打乱顺序建目录。
    for (const name of ["zebra", "alpha", "mango", "banana"]) {
      await mkdir(join(root, name));
    }
    const out = await listSubdirectories(root);
    assert.equal(out.ok, true);
    if (out.ok === true) {
      assert.deepEqual(
        out.entries.map((e) => e.name),
        ["alpha", "banana", "mango", "zebra"]
      );
    }
  });
});

// -- HTTP integration tests --------------------------------------------------

let baseDir: string;
let listening: ListeningServer;
let origin: string;

async function startServer(): Promise<void> {
  baseDir = await freshDir("iknow-browse-http-");
  const store = new SessionStore(baseDir, process.cwd());
  const hub = new SessionHub({
    store,
    deps: makeDeps([assistantResult({ texts: ["x"] })]),
  } satisfies SessionHubOptions);
  listening = await listenSessionServer({
    hub,
    host: "127.0.0.1",
    port: 0,
  });
  origin = `http://${listening.host}:${listening.port}`;
}

beforeEach(async () => {
  await startServer();
});

afterEach(async () => {
  await listening.close().catch(() => {});
});

async function getJson(
  path: string
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${origin}${path}`);
  const body = await res.json();
  return { status: res.status, body };
}

function assertNestedError(opts: {
  readonly body: unknown;
  readonly kind: string;
}): void {
  const { body, kind } = opts;
  const b = body as { error?: { kind?: string; message?: string } };
  assert.ok(b.error, "body must have top-level `error` object");
  assert.equal(b.error!.kind, kind);
  assert.equal(typeof b.error!.message, "string");
  assert.ok(b.error!.message.length > 0, "message must be non-empty");
}

describe("GET /api/v1/workspaces/browse — HTTP route", () => {
  it("happy path → 200 with sorted direct subdirs only (no hidden, no files)", async () => {
    const root = await freshDir("iknow-browse-http-happy-");
    await mkdir(join(root, "alpha"));
    await mkdir(join(root, "beta"));
    await mkdir(join(root, ".git"));
    await mkdir(join(root, "node_modules"));
    await writeFile(join(root, "file.txt"), "data", "utf8");

    const qs = encodeURIComponent(root);
    const { status, body } = await getJson(
      `/api/v1/workspaces/browse?root=${qs}`
    );
    assert.equal(status, 200);
    const b = body as { entries: { name: string; path: string }[] };
    assert.deepEqual(
      b.entries.map((e) => e.name),
      ["alpha", "beta"]
    );
    assert.equal(b.entries[0]?.path, join(root, "alpha"));
    assert.equal(b.entries[1]?.path, join(root, "beta"));
  });

  it("missing root param → 422 validation, field=root", async () => {
    const { status, body } = await getJson("/api/v1/workspaces/browse");
    assert.equal(status, 422);
    assertNestedError({ body, kind: "validation" });
    const b = body as { error: { field?: string } };
    assert.equal(b.error.field, "root");
  });

  it("empty root param → 422 validation, field=root", async () => {
    const { status, body } = await getJson("/api/v1/workspaces/browse?root=");
    assert.equal(status, 422);
    assertNestedError({ body, kind: "validation" });
    const b = body as { error: { field?: string } };
    assert.equal(b.error.field, "root");
  });

  it("relative root param → 422 validation, field=root", async () => {
    const { status, body } = await getJson(
      "/api/v1/workspaces/browse?root=relative/path"
    );
    assert.equal(status, 422);
    assertNestedError({ body, kind: "validation" });
    const b = body as { error: { field?: string } };
    assert.equal(b.error.field, "root");
  });

  it("non-existent root → 422 validation, field=root", async () => {
    const qs = encodeURIComponent(
      join(tmpdir(), "iknow-no-such-dir-xyz-browse")
    );
    const { status, body } = await getJson(
      `/api/v1/workspaces/browse?root=${qs}`
    );
    assert.equal(status, 422);
    assertNestedError({ body, kind: "validation" });
    const b = body as { error: { field?: string } };
    assert.equal(b.error.field, "root");
  });

  it("root 是文件而非目录 → 422 validation, field=root", async () => {
    const dir = await freshDir("iknow-browse-file-as-root-");
    const file = join(dir, "not-a-dir.txt");
    await writeFile(file, "x", "utf8");
    const qs = encodeURIComponent(file);
    const { status, body } = await getJson(
      `/api/v1/workspaces/browse?root=${qs}`
    );
    assert.equal(status, 422);
    assertNestedError({ body, kind: "validation" });
  });

  it("permission denied (chmod 000) → 422 validation, kind=validation（不是 500）", async () => {
    // EACCES 的可执行位丢失时 readdir 会拒绝。父目录保留 070 以确保临时清理
    // 仍可走 force / chmod 回退路径（rm -rf 在 0o000 仍可能成功，但 mkdir 父
    // 目录已 0o700 是为了避免影响其它测试）。
    const parent = await freshDir("iknow-browse-perm-parent-");
    const sealed = join(parent, "sealed");
    await mkdir(sealed, { mode: 0o700 });
    await mkdir(join(sealed, "visible-child"));
    await chmod(sealed, 0o000);

    try {
      const qs = encodeURIComponent(sealed);
      const { status, body } = await getJson(
        `/api/v1/workspaces/browse?root=${qs}`
      );
      // 严格断言:不允许把 fs EACCES 直接吐 500 → 必须在协议层归类为
      // typed validation（与"非绝对/不存在"语义统一，给前端的契约可预测）。
      assert.equal(status, 422);
      assertNestedError({ body, kind: "validation" });
    } finally {
      // 恢复权限，确保 cleanup 能 rm。如果 chmod 失败（例如 chmod-only
      // FUSE / 容器挂载），让全局 afterEach 的 rm 也尽量走 force / 忽略
      // 失败路径 —— 测试的核心契约已验（断言 422 已抛），清理失败不应
      // 掩盖业务断言。仍然保留 .catch 防止 cleanup 抛错阻塞后续测试。
      await chmod(sealed, 0o700).catch((err) => {
        console.warn(
          `[browse-workspaces.test] chmod restore failed for ${sealed}:`,
          err
        );
      });
    }
  });

  it("path separator in entry.path is platform-correct (POSIX = /)", async () => {
    // 文档化路径拼接行为；CI 在 Linux 上,实际就是 POSIX 分隔符,但断言用
    // path.sep 而不是硬编码 '/',确保 Windows / WSL 兼容。
    const root = await freshDir("iknow-browse-sep-");
    await mkdir(join(root, "only"));
    const qs = encodeURIComponent(root);
    const { body } = await getJson(`/api/v1/workspaces/browse?root=${qs}`);
    const b = body as { entries: { path: string }[] };
    assert.equal(b.entries[0]?.path, join(root, "only"));
    assert.ok(b.entries[0]?.path.includes(sep));
  });
});
