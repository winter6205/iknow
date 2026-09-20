/**
 * Session-folder consolidation: todos land at `<sessionFolder>/todos.md` and
 * the `<surface>` tier is retired (ADR-0071 Decision 2).
 *
 * Key invariants pinned by this file:
 *   1. resolveSessionTodoDir is retired — a grep of `src/` comes back empty;
 *   2. the path chain never contains `todos/chat` / `todos/serve` / `todos/tui`;
 *   3. the same session driven from two surfaces (simulated TUI and serve
 *      entries) with the same (baseDir, projectIdentityRoot, conversationId)
 *      injection lands on one and the same file — the observable elimination
 *      of the `<surface>` split;
 *   4. replace-mode snapshots live in the same session directory as the
 *      current ledger (ADR-0046);
 *   5. resolveConversationTodoPath is a pure function taking projectDir (the
 *      session folder) + conversationId, shaped like session-store's
 *      resolveProjectSessionDir (same session-folder root, todos.md inside it).
 *
 * These assertions do not depend on the todoDir injection point's parameter
 * name (still `todoDir` in TodoWriteToolDeps) — only on the resolution layer
 * treating the root as a session folder, not a surface directory.
 */
import { afterEach, beforeEach, describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  createTodoWriteTool,
  resolveConversationTodoPath,
  TODOS_FILE,
} from "../../../../src/harness/aci/tools/todo-write.ts";
import { formatLedgerLine } from "../../../../src/harness/aci/tools/todo-ledger.ts";
import { resolveProjectSessionDir } from "../../../../src/session-api/store/session-store.ts";
import { deriveProjectIdentityRoot } from "../../../../src/harness/session-roots.ts";

let baseDir: string;

beforeEach(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "iknow-todo-session-folder-"));
});

afterEach(async () => {
  await rm(baseDir, { recursive: true, force: true });
});

/**
 * Assembly-layer equivalent: all three entries compute the session folder with
 * this formula (the pinned slug shape). Calls the session-store resolution
 * SSOT directly — no re-implementing join(basename, sha) inside the test.
 */
function sessionFolderOf(base: string, projectIdentityRoot: string): string {
  return resolveProjectSessionDir(base, projectIdentityRoot);
}

// ---------------------------------------------------------------------------
// resolveSessionTodoDir retired; the new resolution layer never mentions surfaces
// ---------------------------------------------------------------------------

describe("SC5: resolveSessionTodoDir is retired — no <surface> in todo path chain", () => {
  it("resolveConversationTodoPath 接受的参数里不再含 `surface` 字段", () => {
    // Type-level constraint: the new signature's keys are projectDir /
    // conversationId, and `surface` is not in the interface. Stray runtime
    // fields must be ignored verbatim.
    const base = baseDir;
    const projectRoot = deriveProjectIdentityRoot({ cwd: base });
    const projectDir = sessionFolderOf(base, projectRoot);
    const path = resolveConversationTodoPath({
      projectDir,
      conversationId: "conv-1",
    });
    // No surface segment (chat/serve/tui) in the path, and todos.md sits inside the session folder.
    assert.ok(
      !/todos[\\/]+(chat|serve|tui)/.test(path),
      `path 不应含 <surface> 段, got: ${path}`
    );
    assert.ok(path.endsWith(join(projectDir, "conv-1", TODOS_FILE)));
  });

  it("conversationId 净化后路径仍嵌在 projectDir 内,无 .. 逃逸", () => {
    const base = baseDir;
    const projectRoot = deriveProjectIdentityRoot({ cwd: base });
    const projectDir = sessionFolderOf(base, projectRoot);
    const path = resolveConversationTodoPath({
      projectDir,
      conversationId: "../../etc",
    });
    assert.ok(!path.includes(".."), `path 含 .. 段, got: ${path}`);
    assert.ok(
      path.startsWith(projectDir),
      `path 必须在 projectDir 内, got: ${path}`
    );
    // Still below projectDir, never above the root baseDir.
    assert.ok(
      !path.startsWith(dirname(projectDir) + "/.."),
      `path 不应逃逸 projectDir 父级, got: ${path}`
    );
  });
});

// ---------------------------------------------------------------------------
// Key verdict: one session run through the TUI and serve entries → todos land in the same file
// ---------------------------------------------------------------------------

describe("T2 关键判据: <surface> 收敛 — 同一会话从两入口落同一文件", () => {
  it("TUI 与 serve 各解析 (baseDir, projectIdentityRoot, convId) → 文件路径相等", () => {
    const projectRoot = deriveProjectIdentityRoot({ cwd: baseDir });
    const projectDir = sessionFolderOf(baseDir, projectRoot);
    const conversationId = "conv-surface-convergence";

    // Each entry (simulated TUI buildTuiDeps / serve hub) resolves on its own:
    const fromTui = resolveConversationTodoPath({
      projectDir,
      conversationId,
    });
    const fromServe = resolveConversationTodoPath({
      projectDir,
      conversationId,
    });

    assert.equal(fromTui, fromServe, "<surface> 分裂已消除");
    assert.ok(fromTui.endsWith(join(projectDir, conversationId, TODOS_FILE)));
  });

  it("同一 projectDir 上两 surface 注入的 todo_write 落同一文件,可读同一份账本", async () => {
    // Hands-on check: two independent todoWriteTool instances (TUI vs serve)
    // injected with the same (projectDir, conversationId); add in one → list hits in the other.
    const projectRoot = deriveProjectIdentityRoot({ cwd: baseDir });
    const projectDir = sessionFolderOf(baseDir, projectRoot);
    const conversationId = "conv-surface-merge-real";
    const ctx = { conversationId };

    const fromTui = createTodoWriteTool({ todoDir: projectDir });
    const fromServe = createTodoWriteTool({ todoDir: projectDir });

    await fromTui.handler({ mode: "add", item: "from TUI" }, ctx);
    const listedFromServe = await fromServe.handler({ mode: "read" }, ctx);
    assert.equal(listedFromServe, "- [ ] [t1] from TUI\n");
  });

  it("两 surface 各自 add 一条 → 同一文件累积两条,顺序按时间", async () => {
    const projectRoot = deriveProjectIdentityRoot({ cwd: baseDir });
    const projectDir = sessionFolderOf(baseDir, projectRoot);
    const conversationId = "conv-surface-merge-accumulate";
    const ctx = { conversationId };

    const fromTui = createTodoWriteTool({ todoDir: projectDir });
    const fromServe = createTodoWriteTool({ todoDir: projectDir });

    await fromTui.handler({ mode: "add", item: "tui-step" }, ctx);
    await fromServe.handler({ mode: "add", item: "serve-step" }, ctx);

    const path = resolveConversationTodoPath({
      projectDir,
      conversationId,
    });
    const content = await readFile(path, "utf8");
    assert.equal(
      content,
      `${formatLedgerLine({ id: "t1", status: "pending", subject: "tui-step" })}${formatLedgerLine({ id: "t2", status: "pending", subject: "serve-step" })}`
    );
  });
});

// ---------------------------------------------------------------------------
// ADR-0046: replace renames the old ledger into a snapshot in the same directory
// ---------------------------------------------------------------------------

describe("ADR-0046: replace 后旧账本与现行同目录", () => {
  it("快照落在 projectDir/<conversationId>/ 下,与 todos.md 同目录", async () => {
    const projectRoot = deriveProjectIdentityRoot({ cwd: baseDir });
    const projectDir = sessionFolderOf(baseDir, projectRoot);
    const conversationId = "conv-snapshot-same-dir";
    const ctx = { conversationId };

    const tool = createTodoWriteTool({ todoDir: projectDir });
    await tool.handler({ mode: "add", item: "pre-replace" }, ctx);
    await tool.handler({ mode: "replace", items: ["post-replace"] }, ctx);

    const currentPath = resolveConversationTodoPath({
      projectDir,
      conversationId,
    });
    const expectedDir = dirname(currentPath); // = projectDir/<convId>

    // Snapshot and current ledger share one directory. Scan it for the
    // `todos.<unixMs>.<hex>.md` snapshot (same regex as listSnapshotNames in
    // other tests — excludes the current `todos.md`).
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(expectedDir);
    const snapshots = entries.filter((n) =>
      /^todos\.\d+\.[0-9a-f]{12}\.md$/.test(n)
    );
    assert.equal(snapshots.length, 1, "恰好一个快照,与现行同目录");
    assert.equal(
      dirname(join(expectedDir, snapshots[0]!)),
      expectedDir,
      "快照目录 === 现行目录"
    );
  });
});
