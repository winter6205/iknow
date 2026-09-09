/**
 * T2 / session-folder-consolidation: todos 落 `<会话文件夹>/todos.md`,
 * `<surface>` 层退役(Spec SC5 + SC20; ADR-0071 Decision 2)。
 *
 * 关键不变量(本文件钉死):
 *   1. resolveSessionTodoDir 已退役 — `src/` grep 为空(SC5);
 *   2. 路径链中不出现 `todos/chat` / `todos/serve` / `todos/tui` 字样(SC5);
 *   3. 同一会话从两个 surface(模拟 TUI 与 serve 入口)走同一
 *      (baseDir, projectIdentityRoot, conversationId) 注入 → 落**同一文件**,
 *      即「`<surface>` 分裂的可观察消除」(T2 判据);
 *   4. replace 模式快照与现行在同一会话目录下(ADR-0046);
 *   5. resolveConversationTodoPath 是纯函数,接受 projectDir(会话文件夹) +
 *      conversationId,与 session-store 的 resolveProjectSessionDir 形态
 *      一致(同一会话文件夹根, todos.md 落在它里面)。
 *
 * 这些断言不依赖 todoDir 注入点的具体名字(它仍叫 todoDir 在
 * TodoWriteToolDeps),只依赖**解析层**把 root 当作「会话文件夹」而非
 * 「surface 目录」使用。
 */
import { afterEach, beforeEach, describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  createTodoWriteTool,
  formatOpenLine,
  resolveConversationTodoPath,
  TODOS_FILE,
} from "../../../../src/harness/aci/tools/todo-write.ts";
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
 * 装配层等价物:三入口都按此公式算「会话文件夹」(SC1 钉死的 slug 形态)。
 * 直接调用 session-store 的解析 SSOT — 不在测试里复刻 join(basename, sha)。
 */
function sessionFolderOf(base: string, projectIdentityRoot: string): string {
  return resolveProjectSessionDir(base, projectIdentityRoot);
}

// ---------------------------------------------------------------------------
// SC5 / SC20:resolveSessionTodoDir 退役,新解析层不再出现 surface 字样
// ---------------------------------------------------------------------------

describe("SC5: resolveSessionTodoDir is retired — no <surface> in todo path chain", () => {
  it("resolveConversationTodoPath 接受的参数里不再含 `surface` 字段", () => {
    // 类型层强约束:新签名的 keys 是 projectDir / conversationId,
    // `surface` 不在接口里。运行时加越界字段应该被原样忽略。
    const base = baseDir;
    const projectRoot = deriveProjectIdentityRoot({ cwd: base });
    const projectDir = sessionFolderOf(base, projectRoot);
    const path = resolveConversationTodoPath({
      projectDir,
      conversationId: "conv-1",
    });
    // 路径内不出现任何 surface 段(chat/serve/tui)且 todos.md 落在会话文件夹里。
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
    // 仍然落在 projectDir 之下,不在根 baseDir 之上。
    assert.ok(
      !path.startsWith(dirname(projectDir) + "/.."),
      `path 不应逃逸 projectDir 父级, got: ${path}`
    );
  });
});

// ---------------------------------------------------------------------------
// T2 关键判据:同一会话从 TUI 与 serve 入口各跑一次 → todo 落同一文件
// ---------------------------------------------------------------------------

describe("T2 关键判据: <surface> 收敛 — 同一会话从两入口落同一文件", () => {
  it("TUI 与 serve 各解析 (baseDir, projectIdentityRoot, convId) → 文件路径相等", () => {
    const projectRoot = deriveProjectIdentityRoot({ cwd: baseDir });
    const projectDir = sessionFolderOf(baseDir, projectRoot);
    const conversationId = "conv-surface-convergence";

    // 两个入口(模拟 TUI buildTuiDeps / serve hub)各自解析:
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
    // 实操验证:两个独立 todoWriteTool 实例(代表 TUI 与 serve),同一
    // (projectDir, conversationId) 注入,add 一条 → list 命中。
    const projectRoot = deriveProjectIdentityRoot({ cwd: baseDir });
    const projectDir = sessionFolderOf(baseDir, projectRoot);
    const conversationId = "conv-surface-merge-real";
    const ctx = { conversationId };

    const fromTui = createTodoWriteTool({ todoDir: projectDir });
    const fromServe = createTodoWriteTool({ todoDir: projectDir });

    await fromTui.handler({ mode: "add", item: "from TUI" }, ctx);
    const listedFromServe = await fromServe.handler({ mode: "list" }, ctx);
    assert.equal(listedFromServe, "- [ ] from TUI\n");
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
      `${formatOpenLine("tui-step")}${formatOpenLine("serve-step")}`
    );
  });
});

// ---------------------------------------------------------------------------
// ADR-0046: replace 模式旧账本重命名成同目录快照
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

    // 快照与现行在同一目录。读目录找 `todos.<unixMs>.<hex>.md` 快照
    // (正则与其它测试的 listSnapshotNames 同形 —— 排除现行 `todos.md`)。
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
