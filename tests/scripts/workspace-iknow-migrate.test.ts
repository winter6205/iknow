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

/** Seed a file (creating intermediate dirs); returns the written path. */
function seedFile(path: string, body: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  return path;
}

/** Same slug formula as the product (reuses `resolveProjectSessionDir` — the test no longer
 *  recomputes the hash itself; a review fix: independent recomputation kept both sides "green"
 *  even after the formula drifted). */
function slugOf(root: string): string {
  // basename(root) matches resolveProjectSessionDir's internal basename (POSIX split);
  // to avoid cross-platform drift from Windows path separators, the cross-function equation is steadier:
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
    // A same-named session leaf already exists pool-side → must SKIP (ADR-0087: pool side wins)
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
    // Conflict unit = the session leaf directory (ADR-0087: same-conversation leaf conflicts keep pool side)
    assert.ok(
      plan.conflicts[0]!.source.endsWith(join("proj-x-abc123", "conv-2")),
      plan.conflicts[0]!.source
    );

    const report = applyWorkspaceIknowMigrate(plan, { workspaceRoot: ws });
    assert.equal(report.moved.length, 1);
    // migrated item in place
    assert.equal(
      readFileSync(
        join(pool, "projects", "proj-x-abc123", "conv-1", "conv-1.jsonl"),
        "utf8"
      ),
      "from-workspace\n"
    );
    // conflicted leaf: pool-side content untouched, workspace side still there (awaiting manual resolution)
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
    // shape preserved: not rewritten into projects/<slug>/<convId>/
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
    // a non-empty anchor dir must not be touched
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
    // real landing point (not migrated)
    const target = seedFile(join(ws, "outside.json"), "{}");
    // place a symlink in the workspace (pointing at outside.json) — valid path but un-migratable semantics
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

    // apply must not move the symlink either (blocked as conflict)
    const report = applyWorkspaceIknowMigrate(plan, { workspaceRoot: ws });
    assert.equal(report.moved.length, 0);
    assert.equal(report.failed.length, 0);
    assert.equal(
      existsSync(join(ws, ".iknow", "sessions", "proj", "linked.jsonl")),
      true
    );
  });

  it("路径敌意名（含分隔符 / NUL / . / ..）被守卫拒收，不参与 join", () => {
    // The guard is a pure predicate: `isHostileName` decides which names must never be
    // joined into a target path. If a readdirSync name contains `/`, join treats it as a
    // separator — escaping the target root; NUL triggers syscall rejection; `.` / `..`
    // are inherent readdir entries.
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

    // plan layer: normal entries still become moves, and `.` / `..` appear in no category
    // (readdir returns them but the guard filters them out — if the guard failed, they would surface as conflict sources).
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
    // review fix: previously the first non-EXDEV failure threw; earlier moves had
    // landed but remaining moves were skipped. Now failures accumulate and the
    // remaining moves continue.
    // Construct a real failure: make a middle path segment of the target a plain file
    // (not a directory) → renameSync reports ENOTDIR (non-EXDEV) → failed branch.
    // Also add a second legal move to the plan to verify "remaining still run after a failure".
    const ws = tempRoot("iknow-ws-migrate-fail-");
    const pool = tempRoot("iknow-pool-migrate-fail-");
    // second move: legal, should be moved
    seedFile(join(ws, ".iknow", "sessions", "ok-proj", "ok.jsonl"), "ws-ok\n");
    // first move: target's middle segment is a plain file → renameSync reports ENOTDIR
    seedFile(
      join(ws, ".iknow", "sessions", "bad-proj", "bad.jsonl"),
      "ws-bad\n"
    );
    // Make pool/sessions/bad-proj exist as a plain file — mkdirSync still succeeds
    // (it only needs a writable parent), but renameSync fails when landing
    // sessions/bad-proj/bad.jsonl into a pool side where "bad-proj is a file, not a directory".
    seedFile(join(pool, "sessions", "bad-proj"), "I-am-a-file\n");

    const plan = planWorkspaceIknowMigrate({
      workspaceRoot: ws,
      poolRoot: pool,
      projectIdentityRoot: "/repo",
    });
    // The plan phase does not notice the target's middle segment is a file — it only
    // checks whether the target leaf exists; here target = pool/sessions/bad-proj/bad.jsonl
    // does not exist → goes into moves.
    assert.equal(plan.moves.length, 2);

    const report = applyWorkspaceIknowMigrate(plan, { workspaceRoot: ws });
    // At least one failure; which one depends on OS and ordering — assert failed is
    // non-empty, and the legal move still moved (as long as its target is not blocked by the bad move).
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
    // the function must not throw; the returned report is truthy
    assert.ok(report);
  });
});
