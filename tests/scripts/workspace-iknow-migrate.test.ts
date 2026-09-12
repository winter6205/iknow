import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterAll, describe, it } from "vitest";

import {
  applyWorkspaceIknowMigrate,
  planWorkspaceIknowMigrate,
} from "../../scripts/workspace-iknow-migrate.ts";

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

/** 与产品同一 slug 公式（测试独立重算，防止断言跟着实现漂移）。 */
function slugOf(root: string): string {
  const digest = createHash("sha1").update(root).digest("hex").slice(0, 12);
  return `${root.split("/").pop()}-${digest}`;
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
  });
});
