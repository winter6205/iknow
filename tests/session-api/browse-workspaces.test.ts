/**
 * GET /api/v1/workspaces/browse endpoint.
 *
 * Covers the subdirectory-probe surface:
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
 * Five boundary cases: empty dir / missing / non-absolute / hidden filtering /
 * permission-denied. Each gets an isolated fixture + a deterministic assertion.
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

/** Temp-root cleanup stack. */
const tempRoots: string[] = [];

/** mkdtemp + register for cleanup. */
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
    // Subdirs expected to survive (alphabetical order).
    await mkdir(join(root, "alpha"));
    await mkdir(join(root, "beta"));
    // Hidden subdirs, expected excluded.
    await mkdir(join(root, ".git"));
    await mkdir(join(root, ".claude"));
    await mkdir(join(root, ".hidden"));
    // Deny-listed subdir, expected excluded.
    await mkdir(join(root, "node_modules"));
    // Plain file, not a dir, expected filtered.
    await writeFile(join(root, "regular-file.txt"), "hi", "utf8");

    const out = await listSubdirectories(root);
    assert.equal(out.ok, true);
    if (out.ok === true) {
      assert.deepEqual(
        out.entries.map((e) => e.name),
        ["alpha", "beta"]
      );
      // path must strictly equal join(root, name).
      assert.equal(out.entries[0]?.path, join(root, "alpha"));
      assert.equal(out.entries[1]?.path, join(root, "beta"));
    }
  });

  it("symlink 目录不被跟随（仅 Dirent.isDirectory 直列）", async () => {
    const root = await freshDir("iknow-browse-sym-");
    const realDir = await freshDir("iknow-browse-real-");
    await symlink(realDir, join(root, "linked"));
    // A real subdir as control.
    await mkdir(join(root, "real-child"));

    const out = await listSubdirectories(root);
    assert.equal(out.ok, true);
    if (out.ok === true) {
      // Symlinks are not followed (Dirent.isDirectory() is false under
      // lstat), leaving only the real subdir.
      assert.deepEqual(
        out.entries.map((e) => e.name),
        ["real-child"]
      );
    }
  });

  it("排序按 name 字母序（与 `readdir` 自然序一致）", async () => {
    const root = await freshDir("iknow-browse-sort-");
    // Create dirs deliberately out of order.
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
    // readdir fails once the executable bit is stripped via EACCES. The
    // parent keeps 070 so temp cleanup can still take the force / chmod
    // fallback path.
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
      // Strict: raw fs EACCES must not surface as 500 — the protocol layer
      // classifies it as typed validation, same contract as non-absolute /
      // missing, so the frontend can rely on it.
      assert.equal(status, 422);
      assertNestedError({ body, kind: "validation" });
    } finally {
      // Restore permissions so cleanup can rm. If chmod fails (e.g.
      // chmod-only FUSE / container mount), the global afterEach rm still
      // tries force and ignores failure — cleanup errors must not mask the
      // business assertions already proven above.
      await chmod(sealed, 0o700).catch((err) => {
        console.warn(
          `[browse-workspaces.test] chmod restore failed for ${sealed}:`,
          err
        );
      });
    }
  });

  it("path separator in entry.path is platform-correct (POSIX = /)", async () => {
    // Documents path-join behavior: CI on Linux yields POSIX separators, but
    // assert with path.sep instead of hardcoded '/' for Windows / WSL safety.
    const root = await freshDir("iknow-browse-sep-");
    await mkdir(join(root, "only"));
    const qs = encodeURIComponent(root);
    const { body } = await getJson(`/api/v1/workspaces/browse?root=${qs}`);
    const b = body as { entries: { path: string }[] };
    assert.equal(b.entries[0]?.path, join(root, "only"));
    assert.ok(b.entries[0]?.path.includes(sep));
  });
});
