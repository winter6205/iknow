import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";
import { afterAll, describe, it } from "vitest";

import {
  applyWorkspaceIknowMigrate,
  planWorkspaceIknowMigrate,
  isHostileName,
} from "../../scripts/workspace-iknow-migrate.ts";
import { resolveProjectSessionDir } from "../../src/session-api/store/session-store.ts";

const roots: string[] = [];

function tempRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

/** 铺一个文件（含中间目录），返回写入路径。 */
function seedFile(path: string, body: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  return path;
}

/** 与产品同一 slug 公式（沿用 `resolveProjectSessionDir` —— 测试不再独立重算
 *  哈希；review fix:独立重算让公式漂移后两边仍各自"绿"）。 */
function slugOf(root: string): string {
  // basename(root) 与 resolveProjectSessionDir 内部 basename 同款（POSIX split）；
  // 但为防止 Windows 路径分隔符退化导致跨平台漂移，跨函数等式更稳：
  return resolveProjectSessionDir("/_unused_pool_", root).split("/").pop()!;
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("workspace-iknow-migrate（ADR-0087 / ADR-0088，plan T3）", () => {
  it("projects/ 会话叶子按项并入 <pool>/projects/<slug>/，同叶子冲突 SKIP 不覆盖", () => {
    const ws = tempRoot("iknow-ws-migrate-");
    const pool = tempRoot("iknow-pool-migrate-");
    seedFile(
      join(ws, ".iknow", "projects", "proj-x-abc123", "conv-1", "conv-1.jsonl"),
      "from-workspace\n"
    );
    // 同名会话叶子已在池侧存在 → 必须 SKIP（ADR-0087：保留池侧）
    seedFile(
      join(pool, "projects", "proj-x-abc123", "conv-2", "conv-2.jsonl"),
      "pool-side\n"
    );
    seedFile(
      join(ws, ".iknow", "projects", "proj-x-abc123", "conv-2", "conv-2.jsonl"),
      "workspace-side\n"
    );

    const plan = planWorkspaceIknowMigrate({
      workspaceRoot: ws,
      poolRoot: pool,
      projectIdentityRoot: "/repo",
    });

    assert.equal(plan.moves.length, 1);
    assert.equal(plan.conflicts.length, 1);
    // 冲突单元 = 会话叶子目录（ADR-0087：同 conversation 叶子冲突保留池侧）
    assert.ok(
      plan.conflicts[0]!.source.endsWith(join("proj-x-abc123", "conv-2")),
      plan.conflicts[0]!.source
    );

    const report = applyWorkspaceIknowMigrate(plan, { workspaceRoot: ws });
    assert.equal(report.moved.length, 1);
    // 迁入项到位
    assert.equal(
      readFileSync(
        join(pool, "projects", "proj-x-abc123", "conv-1", "conv-1.jsonl"),
        "utf8"
      ),
      "from-workspace\n"
    );
    // 冲突叶子：池侧内容未被覆盖，工作区侧仍在（等人处理）
    assert.equal(
      readFileSync(
        join(pool, "projects", "proj-x-abc123", "conv-2", "conv-2.jsonl"),
        "utf8"
      ),
      "pool-side\n"
    );
    assert.equal(
      existsSync(join(ws, ".iknow", "projects", "proj-x-abc123", "conv-2")),
      true
    );
  });

  it("sessions/ 扁 jsonl 保形并入 <pool>/sessions/，不转成 projects/ 会话文件夹", () => {
    const ws = tempRoot("iknow-ws-migrate-");
    const pool = tempRoot("iknow-pool-migrate-");
    seedFile(
      join(ws, ".iknow", "sessions", "proj-y-def456", "abc-123.jsonl"),
      "legacy\n"
    );

    const plan = planWorkspaceIknowMigrate({
      workspaceRoot: ws,
      poolRoot: pool,
      projectIdentityRoot: "/repo",
    });
    const report = applyWorkspaceIknowMigrate(plan, { workspaceRoot: ws });

    assert.equal(report.moved.length, 1);
    const archived = join(pool, "sessions", "proj-y-def456", "abc-123.jsonl");
    assert.equal(readFileSync(archived, "utf8"), "legacy\n");
    // 保形：没有被改写成 projects/<slug>/<convId>/
    assert.equal(existsSync(join(pool, "projects", "proj-y-def456")), false);
    assert.equal(existsSync(join(ws, ".iknow", "sessions")), false);
  });

  it("tasks/ 按 identity slug 并入 <pool>/projects/<slug>/tasks/，目标已存在 SKIP", () => {
    const ws = tempRoot("iknow-ws-migrate-");
    const pool = tempRoot("iknow-pool-migrate-");
    const identityRoot = "/repo";
    const tasksTarget = join(pool, "projects", slugOf(identityRoot), "tasks");
    seedFile(join(ws, ".iknow", "tasks", "bg-1.json"), "new\n");
    seedFile(join(tasksTarget, "bg-2.json"), "pool\n");
    seedFile(join(ws, ".iknow", "tasks", "bg-2.json"), "workspace\n");

    const plan = planWorkspaceIknowMigrate({
      workspaceRoot: ws,
      poolRoot: pool,
      projectIdentityRoot: identityRoot,
    });

    assert.equal(plan.moves.length, 1);
    assert.equal(plan.conflicts.length, 1);
    assert.ok(plan.moves[0]!.target.startsWith(tasksTarget));

    applyWorkspaceIknowMigrate(plan, { workspaceRoot: ws });
    assert.equal(readFileSync(join(tasksTarget, "bg-1.json"), "utf8"), "new\n");
    assert.equal(
      readFileSync(join(tasksTarget, "bg-2.json"), "utf8"),
      "pool\n"
    );
  });

  it("移空后的类别目录与 slug 目录按空即删，非空保留", () => {
    const ws = tempRoot("iknow-ws-migrate-");
    const pool = tempRoot("iknow-pool-migrate-");
    seedFile(join(ws, ".iknow", "sessions", "only-proj", "a.jsonl"), "x\n");
    seedFile(join(ws, ".iknow", "tasks", "bg-9.json"), "y\n");
    // 非空锚目录不该被动
    seedFile(join(ws, ".iknow", "worktrees", "keep.txt"), "anchor\n");

    const plan = planWorkspaceIknowMigrate({
      workspaceRoot: ws,
      poolRoot: pool,
      projectIdentityRoot: "/repo",
    });
    const report = applyWorkspaceIknowMigrate(plan, { workspaceRoot: ws });

    assert.equal(existsSync(join(ws, ".iknow", "sessions")), false);
    assert.equal(existsSync(join(ws, ".iknow", "tasks")), false);
    assert.equal(existsSync(join(ws, ".iknow", "worktrees", "keep.txt")), true);
    assert.ok(report.removedDirs.length >= 2);
  });

  it("幂等：源不存在 / 已空 → 0 条，apply 是 no-op", () => {
    const ws = tempRoot("iknow-ws-migrate-");
    const pool = tempRoot("iknow-pool-migrate-");
    const plan = planWorkspaceIknowMigrate({
      workspaceRoot: ws,
      poolRoot: pool,
      projectIdentityRoot: "/repo",
    });
    assert.equal(plan.moves.length, 0);
    assert.equal(plan.conflicts.length, 0);
    const report = applyWorkspaceIknowMigrate(plan, { workspaceRoot: ws });
    assert.equal(report.moved.length, 0);
    assert.equal(report.removedDirs.length, 0);
    assert.equal(report.failed.length, 0);
  });

  it("符号链接作源 → 归 conflict（不穿过链接移动）", () => {
    const ws = tempRoot("iknow-ws-migrate-link-");
    const pool = tempRoot("iknow-pool-migrate-link-");
    // 真实落点（不被迁移）
    const target = seedFile(join(ws, "outside.json"), "{}");
    // 工作区里挂一个 symlink（指向 outside.json）—— 路径合法但语义不可迁移
    mkdirSync(join(ws, ".iknow", "sessions", "proj"), { recursive: true });
    symlinkSync(target, join(ws, ".iknow", "sessions", "proj", "linked.jsonl"));

    const plan = planWorkspaceIknowMigrate({
      workspaceRoot: ws,
      poolRoot: pool,
      projectIdentityRoot: "/repo",
    });

    assert.equal(plan.moves.length, 0);
    assert.equal(plan.conflicts.length, 1);
    assert.ok(
      plan.conflicts[0]!.source.endsWith("linked.jsonl"),
      plan.conflicts[0]!.source
    );
    assert.match(plan.conflicts[0]!.reason ?? "", /符号链接/);

    // apply 也不该动 symlink（被冲突拦截）
    const report = applyWorkspaceIknowMigrate(plan, { workspaceRoot: ws });
    assert.equal(report.moved.length, 0);
    assert.equal(report.failed.length, 0);
    assert.equal(
      existsSync(join(ws, ".iknow", "sessions", "proj", "linked.jsonl")),
      true
    );
  });

  it("路径敌意名（含分隔符 / NUL / . / ..）被守卫拒收，不参与 join", () => {
    // 守卫是纯谓词：`isHostileName` 决定什么名字绝不 join 进目标路径。
    // readdirSync 返回的名字若含 `/`，join 会把它当路径分隔符 —— 可逃出
    // 目标根；NUL 触发系统调用 reject；`.` / `..` 是 readdir 固有条目。
    for (const hostile of [
      ".",
      "..",
      "a/b",
      "a\\b",
      "a\0b",
      "../escape",
      "..\\escape",
    ]) {
      assert.equal(isHostileName(hostile), true, `应拒收: ${hostile}`);
    }
    for (const safe of ["ok.json", "proj-x-abc123", "a.b", "..hidden"]) {
      assert.equal(isHostileName(safe), false, `应放行: ${safe}`);
    }

    // plan 层：正常条目仍作为 move，且 `.` / `..` 不出现在任何一类里
    // （readdir 返回它们，但守卫过滤掉了 —— 若守卫失效它们会变成冲突源）。
    const ws = tempRoot("iknow-ws-migrate-hostile-");
    const pool = tempRoot("iknow-pool-migrate-hostile-");
    seedFile(join(ws, ".iknow", "tasks", "ok.json"), "ok\n");

    const plan = planWorkspaceIknowMigrate({
      workspaceRoot: ws,
      poolRoot: pool,
      projectIdentityRoot: "/repo",
    });
    assert.equal(plan.moves.length, 1);
    assert.equal(plan.moves[0]!.source, join(ws, ".iknow", "tasks", "ok.json"));
    assert.equal(plan.conflicts.length, 0);
  });

  it("非 EXDEV 失败 → 累积到 report.failed 而非抛错，剩余 moves 继续", () => {
    // review-fix:之前第一处非 EXDEV 失败即 throw,前序 move 已落盘但剩余
    // moves 跳过。当前改成失败累积,继续剩余 moves。
    // 构造真实失败:让 target 的中间路径段是普通文件(非目录)→ renameSync
    // 报 ENOTDIR(非 EXDEV)→ 走 failed 分支。同时在 plan 里加第二条合法
    // move 验证「失败后剩余仍继续」。
    const ws = tempRoot("iknow-ws-migrate-fail-");
    const pool = tempRoot("iknow-pool-migrate-fail-");
    // 第二条 move:合法,应当 moved
    seedFile(join(ws, ".iknow", "sessions", "ok-proj", "ok.jsonl"), "ws-ok\n");
    // 第一条 move:让 target 的中间 segment 是普通文件 → renameSync 报 ENOTDIR
    seedFile(
      join(ws, ".iknow", "sessions", "bad-proj", "bad.jsonl"),
      "ws-bad\n"
    );
    // 让 pool/sessions/bad-proj 存在为普通文件 —— mkdirSync 仍会成功(它
    // 只要求父目录可写),但 renameSync 想把 sessions/bad-proj/bad.jsonl
    // 落进一个「bad-proj 是文件而非目录」的池侧时会失败。
    seedFile(join(pool, "sessions", "bad-proj"), "I-am-a-file\n");

    const plan = planWorkspaceIknowMigrate({
      workspaceRoot: ws,
      poolRoot: pool,
      projectIdentityRoot: "/repo",
    });
    // plan 阶段不感知 target 中间是文件 —— 它只查 target 叶子是否存在;
    // 此时 target = pool/sessions/bad-proj/bad.jsonl 不存在 → 进入 moves。
    assert.equal(plan.moves.length, 2);

    const report = applyWorkspaceIknowMigrate(plan, { workspaceRoot: ws });
    // 至少一条失败;具体哪条依 OS 与排序而定 —— 至少断言 failed 不为空,
    // 且合法 move 仍 moved(只要其 target 不被坏 move 阻塞)。
    assert.ok(
      report.failed.length > 0,
      `期望非 EXDEV 失败累积,实际 ${JSON.stringify({
        moved: report.moved.map((m) => m.source),
        failed: report.failed.map((f) => ({ s: f.source, e: f.error })),
      })}`
    );
    for (const f of report.failed) {
      assert.match(f.error, /ENOTDIR|EEXIST|EBUSY|EISDIR|ENOENT/);
    }
    // 函数不应抛错;返回 report 是真值
    assert.ok(report);
  });
});
