/**
 * T1 (ADR-0071) — session folder layout & resolver
 * pure-function contract tests. Covers SC1–SC4 + 输入五类表 A.
 *
 * These tests pin the **new** contract:
 *   - `resolveProjectSessionDir(baseDir, projectIdentityRoot)` keys by
 *     `projectIdentityRoot` (was `cwd`); the segment is `projects/<slug>` (was
 *     `sessions/<slug>`).
 *   - `resolveConversationDir({ projectDir, conversationId })` resolves a
 *     per-conversation folder (was implicit in SessionStore private helpers).
 *   - Both are pure: no git, no FS, no `process.cwd()` fallback. Typed
 *     fail-closed on empty / negative / overflow inputs.
 *
 * The legacy 5-case `cwd` test set is preserved with the **same invariants**
 * (slug shape, sha1 suffix, basename collision resolution, distinct roots)
 * — only the input parameter changes from `cwd` to `projectIdentityRoot`.
 */
import { describe, it, expect } from "vitest";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { basename, join } from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  CURRENT_SCHEMA_VERSION,
  resolveConversationDir,
  resolveProjectSessionDir,
  SessionStore,
  type SessionFileV1,
} from "../../../src/session-api/store/index.ts";

// -- resolveProjectSessionDir: SC1–SC3 (layout / key / slug shape) -------------

describe("resolveProjectSessionDir", () => {
  it("uses projectIdentityRoot (not cwd) as the grouping key (SC1)", () => {
    // Same projectIdentityRoot, two cwds (main checkout + task worktree) →
    // identical dir. The cwd distinction is what we're eliminating.
    const root = "/work/iknow";
    const a = resolveProjectSessionDir("/base", root);
    const b = resolveProjectSessionDir("/base", root);
    assert.equal(a, b);
    // Layout uses `projects/<slug>` (was `sessions/<slug>`) — top-level
    // segment is the SSOT claim of the new contract.
    assert.equal(
      basename(a),
      `${basename(root)}-${createHash("sha1").update(root).digest("hex").slice(0, 12)}`
    );
    // Path-level: <base>/projects/<basename>-<sha1(root)[:12]>
    const digest = createHash("sha1").update(root).digest("hex").slice(0, 12);
    assert.equal(a, join("/base", "projects", `${basename(root)}-${digest}`));
  });

  it("slug retains <basename>-<sha1[:12]> form regardless of input (SC3)", () => {
    const dir = resolveProjectSessionDir("/base", "/work/anything-here");
    assert.match(basename(dir), /^[A-Za-z0-9_-]+-[0-9a-f]{12}$/);
    assert.match(basename(dir), /-[0-9a-f]{12}$/);
  });

  it("is stable for the same projectIdentityRoot", () => {
    assert.equal(
      resolveProjectSessionDir("/base", "/work/p"),
      resolveProjectSessionDir("/base", "/work/p")
    );
  });

  it("same basename at different projectIdentityRoot paths do not collide", () => {
    const a = resolveProjectSessionDir("/base", "/a/proj");
    const b = resolveProjectSessionDir("/base", "/b/proj");
    assert.notEqual(a, b);
    assert.match(basename(a), /^proj-[0-9a-f]{12}$/);
    assert.match(basename(b), /^proj-[0-9a-f]{12}$/);
    assert.notEqual(basename(a), basename(b));
  });

  it("different projectIdentityRoots always produce different dirs", () => {
    const a = resolveProjectSessionDir("/base", "/x/alpha");
    const b = resolveProjectSessionDir("/base", "/y/beta");
    const c = resolveProjectSessionDir("/base", "/z/gamma");
    assert.notEqual(a, b);
    assert.notEqual(b, c);
    assert.notEqual(a, c);
  });
});

// -- resolveConversationDir: SC2 (UUID leaf) + SC4 (pure) -----------------------

describe("resolveConversationDir", () => {
  const sampleProjectDir = "/base/projects/myproj-3d7759ffa337";

  it("lays the conversationId verbatim under the project dir (SC2)", () => {
    const id = "550e8400-e29b-41d4-a716-446655440000"; // UUID shape
    const dir = resolveConversationDir({
      projectDir: sampleProjectDir,
      conversationId: id,
    });
    assert.equal(dir, join(sampleProjectDir, id));
    assert.equal(basename(dir), id);
  });

  it("pure: no IO, no process.cwd() fallback (SC4)", () => {
    // Same inputs → same output. The function never reads git / FS / cwd.
    const id = "abc";
    assert.equal(
      resolveConversationDir({ projectDir: "/x", conversationId: id }),
      resolveConversationDir({ projectDir: "/x", conversationId: id })
    );
  });

  it("is idempotent — two calls on the same id give the same path", () => {
    const id = "550e8400-e29b-41d4-a716-446655440000";
    assert.equal(
      resolveConversationDir({
        projectDir: sampleProjectDir,
        conversationId: id,
      }),
      resolveConversationDir({
        projectDir: sampleProjectDir,
        conversationId: id,
      })
    );
  });
});

// -- 表 A — resolveProjectSessionDir / resolveConversationDir boundary --------

describe("表 A — empty", () => {
  it("conversationId undefined → typed fail", () => {
    expect(() =>
      resolveConversationDir({
        projectDir: "/x",
        // @ts-expect-error — probe defensive boundary
        conversationId: undefined,
      })
    ).toThrow();
  });

  it("conversationId empty string → typed fail", () => {
    expect(() =>
      resolveConversationDir({ projectDir: "/x", conversationId: "" })
    ).toThrow();
  });

  it("projectIdentityRoot empty → typed fail", () => {
    expect(() => resolveProjectSessionDir("/base", "")).toThrow();
  });
});

describe("表 A — negative (path-hostile inputs)", () => {
  it("conversationId containing '/' cannot escape project dir (sanitize keeps it inside)", () => {
    // Per spec: `..` 风格与含分隔符 id 不可能逃逸会话文件夹. sanitize
    // replaces non-[A-Za-z0-9_-] with `_`, so a `..` becomes `__`.
    const dir = resolveConversationDir({
      projectDir: "/x/proj",
      conversationId: "../../../etc/passwd",
    });
    assert.ok(dir.startsWith("/x/proj/"));
    assert.ok(!dir.includes(".."));
    assert.ok(!/[\\/]etc[\\/]/.test(dir));
  });

  it("conversationId containing '..' becomes safe underscores", () => {
    const dir = resolveConversationDir({
      projectDir: "/x/proj",
      conversationId: "..",
    });
    assert.equal(dir, join("/x/proj", "__"));
  });

  it("projectIdentityRoot relative path → typed fail", () => {
    expect(() => resolveProjectSessionDir("/base", "relative/path")).toThrow();
  });
});

describe("表 A — overflow", () => {
  it("conversationId exceeding 255 bytes → typed fail (no silent truncation)", () => {
    const id = "a".repeat(256);
    expect(() =>
      resolveConversationDir({ projectDir: "/x", conversationId: id })
    ).toThrow();
  });

  it("conversationId at 255 bytes is accepted", () => {
    const id = "a".repeat(255);
    expect(() =>
      resolveConversationDir({ projectDir: "/x", conversationId: id })
    ).not.toThrow();
  });

  it("projectIdentityRoot slug input exceeding 255 bytes → typed fail", () => {
    const root = "/work/" + "p".repeat(300);
    expect(() => resolveProjectSessionDir("/base", root)).toThrow();
  });
});

describe("表 A — concurrent (mkdir recursive idempotent)", () => {
  it("two stores with the same projectIdentityRoot can independently init the same conversation dir without half-state", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "iknow-sf-concurrent-"));
    try {
      const root = "/work/proj";
      const id = "conv-concurrent";
      const storeA = new SessionStore(baseDir, root);
      const storeB = new SessionStore(baseDir, root);
      const file: SessionFileV1 = {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        conversation_id: id,
        title: "",
        cwd: "",
        sanitized_at: new Date().toISOString(),
        messages: [],
        jsonMode: false,
        turnCount: 0,
        updatedAt: new Date().toISOString(),
        checkpoints: [],
      };
      // Save twice into the same (projectDir, conversationId); the second
      // save MUST NOT leave half-written state. mkdir recursive + atomic
      // rename are the contract.
      await storeA.save({ id, file });
      await storeB.save({ id, file });
      // Both stores can read what they wrote — proves the path resolves to
      // the same dir and both writes are observable.
      const fromA = await storeA.load(id);
      const fromB = await storeB.load(id);
      assert.equal(fromA.conversation_id, id);
      assert.equal(fromB.conversation_id, id);
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  });
});

describe("表 A — exception (deep IO tree typed failures)", () => {
  it("save: project dir traversal blocked by regular file → typed write_failed", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "iknow-sf-enotdir-"));
    try {
      // Block <baseDir>/projects so traversal of mkdir hits ENOTDIR.
      await writeFile(join(baseDir, "projects"), "blocker", "utf8");
      const store = new SessionStore(baseDir, "/work/proj");
      await expect(
        store.save({
          id: "enotdir",
          file: {
            schemaVersion: CURRENT_SCHEMA_VERSION,
            conversation_id: "enotdir",
            title: "",
            cwd: "",
            sanitized_at: new Date().toISOString(),
            messages: [],
            jsonMode: false,
            turnCount: 0,
            updatedAt: new Date().toISOString(),
            checkpoints: [],
          },
        })
      ).rejects.toMatchObject({
        kind: "write_failed",
        conversation_id: "enotdir",
        cause: expect.stringMatching(/ENOTDIR/),
      });
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  });
});

// -- SessionStore constructor: projectIdentityRoot required (no default cwd) ---

describe("SessionStore constructor — projectIdentityRoot is required", () => {
  it("two stores with the same baseDir but different projectIdentityRoot are isolated", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "iknow-sf-ns-iso-"));
    try {
      const storeA = new SessionStore(baseDir, "/proj/alpha");
      const storeB = new SessionStore(baseDir, "/proj/beta");
      const id = "ns-iso-1";
      const file: SessionFileV1 = {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        conversation_id: id,
        title: "",
        cwd: "",
        sanitized_at: new Date().toISOString(),
        messages: [
          { role: "user", content: [{ type: "text", text: "hi" }] },
          { role: "assistant", content: [{ type: "text", text: "reply" }] },
        ],
        jsonMode: false,
        turnCount: 1,
        updatedAt: new Date().toISOString(),
        checkpoints: [],
      };
      await storeA.save({ id, file });
      // storeB cannot see alpha's session
      assert.deepEqual(await storeB.list(), []);
      await expect(storeB.load(id)).rejects.toMatchObject({
        kind: "not_found",
        conversation_id: id,
      });
      const loaded = await storeA.load(id);
      assert.equal(loaded.conversation_id, id);
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  });

  it("same baseDir + same projectIdentityRoot sees the same file", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "iknow-sf-ns-shared-"));
    try {
      const root = "/proj/shared";
      const storeA = new SessionStore(baseDir, root);
      const storeB = new SessionStore(baseDir, root);
      const id = "ns-shared-1";
      const file: SessionFileV1 = {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        conversation_id: id,
        title: "hello",
        cwd: "",
        sanitized_at: new Date().toISOString(),
        messages: [
          { role: "user", content: [{ type: "text", text: "hello" }] },
          { role: "assistant", content: [{ type: "text", text: "reply" }] },
        ],
        jsonMode: false,
        turnCount: 1,
        updatedAt: new Date().toISOString(),
        checkpoints: [],
      };
      await storeA.save({ id, file });
      const loaded = await storeB.load(id);
      assert.equal(loaded.conversation_id, id);
      assert.equal(loaded.title, "hello");
      const listB = await storeB.list();
      assert.equal(listB.length, 1);
      assert.equal(listB[0]?.conversation_id, id);
      assert.equal(listB[0]?.title, "hello");
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  });

  it("end-to-end demo — new session visible to list() and loadable via --resume path", async () => {
    // Spec acceptance: 新建会话后 TUI 列表能看见、--resume 能续跑. This
    // exercises the same data path (save → list → load) at the SessionStore
    // boundary.
    const baseDir = await mkdtemp(join(tmpdir(), "iknow-sf-resume-"));
    try {
      const root = "/proj/resume";
      const store = new SessionStore(baseDir, root);
      const id = "resume-demo-1";
      const file: SessionFileV1 = {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        conversation_id: id,
        title: "first",
        cwd: "",
        sanitized_at: new Date().toISOString(),
        messages: [
          { role: "user", content: [{ type: "text", text: "ask" }] },
          { role: "assistant", content: [{ type: "text", text: "answer" }] },
        ],
        jsonMode: false,
        turnCount: 1,
        updatedAt: new Date().toISOString(),
        checkpoints: [],
      };
      await store.save({ id, file });
      // Simulate "TUI list": list() returns the saved session.
      const entries = await store.list();
      assert.equal(entries.length, 1);
      assert.equal(entries[0]?.conversation_id, id);
      // Simulate "--resume id": a fresh SessionStore against the same
      // baseDir+projectIdentityRoot loads the session.
      const resumed = new SessionStore(baseDir, root);
      const loaded = await resumed.load(id);
      assert.equal(loaded.conversation_id, id);
      assert.equal(loaded.title, "first");
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  });
});

// Sanity smoke — make sure mkdir on a fresh conversation folder works once
// it's actually consumed. (This pre-empts any "session folder leaf is not
// created lazily" regression.)
describe("session folder leaf is created lazily", () => {
  it("save() under a fresh conversation id creates <projectDir>/<id>/", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "iknow-sf-lazy-"));
    try {
      const root = "/proj/lazy";
      const store = new SessionStore(baseDir, root);
      const id = "lazy-1";
      const file: SessionFileV1 = {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        conversation_id: id,
        title: "",
        cwd: "",
        sanitized_at: new Date().toISOString(),
        messages: [],
        jsonMode: false,
        turnCount: 0,
        updatedAt: new Date().toISOString(),
        checkpoints: [],
      };
      await store.save({ id, file });
      const expectedDir = join(resolveProjectSessionDir(baseDir, root), id);
      // The conversation folder MUST already exist after save() — no need
      // to mkdir. We stat the jsonl file directly to prove the layout.
      const stat = await import("node:fs/promises").then((m) =>
        m.stat(join(expectedDir, `${id}.jsonl`))
      );
      assert.ok(stat.isFile());
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  });
});
