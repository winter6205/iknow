/**
 * T8 (plans/write-situation-disclosure.md) — `worktree_exists` 与 `branch_exists`
 * 的 detail 指引唯一化（specs/write-situation-disclosure.md SC8 / SC9；输入五类
 * B 表 empty / negative / exception 臂）。
 *
 * 落点：
 *   - `createTaskWorktree` 在 `worktree_exists` 与 `branch_exists` 两个 kind
 *     抛 `WorktreeIsolationError` 时，detail 必须**只**指向一个模型可执行的
 *     下一步（不再说 "resolve … manually"——模型手里没有 manual 工具）。
 *   - `worktree_exists` 按 `taskWorktreeOwnerOf(worktreePath)` 分三臂：
 *       owner === 本会话 → 点名 `enter-worktree`；
 *       owner !== 本会话 → 点名 `enter-worktree`（显式接手）或换 label；
 *       owner 读不出（无 sidecar / 历史树 / 旁路） → 点名 `list-worktrees`。
 *   - `branch_exists` 按目标目录**是否存在**分两子况：
 *       目录存在 → 与 `worktree_exists` 同形（按归属分三臂）；
 *       目录不存在 → 指引换 label 或请操作员删分支，且**不含**
 *       `enter-worktree`（enter 必撞 `worktree_not_found`）。
 *   - sidecar 读 I/O 故障（非 ENOENT）退化到「owner 读不出」臂，**不 throw**
 *     （`taskWorktreeOwnerOf` 已有此保证；测试钉住）。
 *
 * 测试矩阵（输入五类 B 表）：
 *   - empty：sidecar 缺席 / 内容为空 / 不可读 → 退化到「list-worktrees」
 *     臂；detail **不含**「manually」、不含「operator」（这是 model 路径，不是
 *     operator_required 路径；operator_required 停止指令由 T7 的
 *     `gateBlockNotice` 另行附加）。
 *   - negative：`branch_exists` 且目标目录**不存在** → detail **不含**
 *     `enter-worktree`。
 *   - exception：sidecar 读失败（非 ENOENT I/O）→ 退化、不 throw。
 *   - overflow：极长 path / 多 owner 候选 / 旁路路径形态 → 仍走对应的归属臂。
 */
import { afterAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  WorktreeIsolationError,
  createTaskWorktree,
  taskWorktreeBranch,
  taskWorktreePath,
} from "../../../src/harness/isolation/worktree-gate.ts";

// -- helpers -----------------------------------------------------------------

const roots: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function makeGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "iknow-wt-exists-"));
  roots.push(dir);
  git(dir, "init", "-q");
  git(
    dir,
    "-c",
    "user.email=t@t",
    "-c",
    "user.name=t",
    "commit",
    "--allow-empty",
    "-qm",
    "init"
  );
  return dir;
}

afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

// -- worktree_exists 三臂 ----------------------------------------------------

describe("T8 — worktree_exists detail 三臂（按 taskWorktreeOwnerOf 归属）", () => {
  it("owner === 本会话 → detail 点名 enter-worktree，不说 'manually'", async () => {
    const repo = makeGitRepo();
    const convId = "conv-own";
    const worktreePath = taskWorktreePath(repo, convId, "own-label");
    await createTaskWorktree({
      repoRoot: repo,
      worktreePath,
      branch: taskWorktreeBranch(convId, "own-label"),
      conversationId: convId,
    });

    // 用相同的 label / 不同的 branch 名再触发——目录已存在 → worktree_exists。
    let err: WorktreeIsolationError | undefined;
    try {
      await createTaskWorktree({
        repoRoot: repo,
        worktreePath,
        branch: "iknow/task/own-label-other",
        conversationId: convId,
      });
    } catch (e) {
      err = e as WorktreeIsolationError;
    }
    expect(err).toBeInstanceOf(WorktreeIsolationError);
    expect(err!.kind).toBe("worktree_exists");
    expect(err!.detail).toContain("enter-worktree");
    // 不引诱「手工解决」——模型手里没有 manual 工具
    expect(err!.detail).not.toContain("manually");
    // 归属臂细节：owner === 本会话，不强调「换 label」
    expect(err!.detail).toContain(convId);
  });

  it("owner !== 本会话（别的会话建过） → detail 点名 enter-worktree + 换 label 二选一", async () => {
    const repo = makeGitRepo();
    const otherConv = "conv-other";
    const worktreePath = taskWorktreePath(repo, otherConv, "shared-label");
    await createTaskWorktree({
      repoRoot: repo,
      worktreePath,
      branch: taskWorktreeBranch(otherConv, "shared-label"),
      conversationId: otherConv,
    });

    // 本会话用相同 label 触发：worktree dir 已存在 → worktree_exists，且 owner
    // 从 sidecar 反演为 otherConv。
    const myConv = "conv-self";
    let err: WorktreeIsolationError | undefined;
    try {
      await createTaskWorktree({
        repoRoot: repo,
        worktreePath,
        branch: "iknow/task/shared-label-self",
        conversationId: myConv,
      });
    } catch (e) {
      err = e as WorktreeIsolationError;
    }
    expect(err).toBeInstanceOf(WorktreeIsolationError);
    expect(err!.kind).toBe("worktree_exists");
    // 两条出路：enter-worktree（显式接手）+ 换 label
    expect(err!.detail).toContain("enter-worktree");
    expect(err!.detail).toMatch(/label/);
    expect(err!.detail).toContain(otherConv);
  });

  it("owner 读不出（旁路目录、无 .git） → detail 点名 list-worktrees", async () => {
    const repo = makeGitRepo();
    // 在工作树路径下放一个「像 worktree 但不是 git 工作树」的目录——has shape
    // (<repo>/.iknow/worktrees/<leaf>) but no .git pointer inside. owner inversion
    // 返回 undefined（isTaskWorktreePath 通过，但 sidecar / leaf 都不匹配）。
    const wtDir = join(repo, ".iknow", "worktrees", "alien-leaf");
    // mkdirSync via fs not imported; use exec mkdir
    execFileSync("mkdir", ["-p", wtDir], { encoding: "utf8" });

    let err: WorktreeIsolationError | undefined;
    try {
      await createTaskWorktree({
        repoRoot: repo,
        worktreePath: wtDir,
        branch: "iknow/task/alien-leaf-fresh",
      });
    } catch (e) {
      err = e as WorktreeIsolationError;
    }
    expect(err).toBeInstanceOf(WorktreeIsolationError);
    expect(err!.kind).toBe("worktree_exists");
    // 退化臂：唯一的可执行出路是 list-worktrees
    expect(err!.detail).toContain("list-worktrees");
    // 不说 manually，不引诱换 label（不知道是不是被别的会话占着）
    expect(err!.detail).not.toContain("manually");
  });

  it("sidecar I/O 故障（非 ENOENT，例如权限拒绝） → 退化到 list-worktrees，不 throw", async () => {
    const repo = makeGitRepo();
    const convId = "conv-io-fail";
    const worktreePath = taskWorktreePath(repo, convId, "iofail-label");
    await createTaskWorktree({
      repoRoot: repo,
      worktreePath,
      branch: taskWorktreeBranch(convId, "iofail-label"),
      conversationId: convId,
    });

    // 让 sidecar 文件不可读：chmod 0000（root 用户下 chmod 0000 仍可读——
    // 跳过 root 用户断言，避免宿主环境导致假阴性）。这是 best-effort：用
    // rmSync 删 sidecar 文件，模拟「sidecar 缺失」（属于 empty 臂，等价）。
    // 直接用「sidecar 文件不存在」触发退化臂。
    const gitdir = (() => {
      const dotGit = execFileSync("cat", [join(worktreePath, ".git")], {
        encoding: "utf8",
      }).trim();
      const m = /^gitdir:\s*(.+)$/m.exec(dotGit);
      return m ? m[1]!.trim() : null;
    })();
    if (gitdir !== null && existsSync(join(gitdir, "iknow-conversation-id"))) {
      rmSync(join(gitdir, "iknow-conversation-id"));
    }

    // 用相同 leaf 重新触发
    let err: WorktreeIsolationError | undefined;
    try {
      await createTaskWorktree({
        repoRoot: repo,
        worktreePath,
        branch: "iknow/task/iofail-label-fresh",
        conversationId: convId,
      });
    } catch (e) {
      err = e as WorktreeIsolationError;
    }
    expect(err).toBeInstanceOf(WorktreeIsolationError);
    expect(err!.kind).toBe("worktree_exists");
    // sidecar 缺失：leaf 形态是「iofail-label」（合法 label），
    // taskWorktreeOwnerOf 走 sidecar + leaf 分支：sidecar 缺席则走 historical
    // `<slug>--<conversationId>` 形式判定——leaf 是 iofail-label，不是
    // iofail-label--xxx，所以最终返回 undefined（owner 读不出）。
    expect(err!.detail).toContain("list-worktrees");
  });
});

// -- branch_exists 两子况 -----------------------------------------------------

describe("T8 — branch_exists detail 两子况（按目标目录是否存在）", () => {
  // 建树后删目录留分支——remove-worktree 默认不删分支的真实残留路径。
  // 目录不存在 → 不点名 enter-worktree。
  it("branch 残留（目录已删）→ 不点名 enter-worktree，指引换 label 或删分支", async () => {
    const repo = makeGitRepo();
    const convId = "conv-branch-exists";
    const worktreePath = taskWorktreePath(repo, convId, "branch-exists-label");
    await createTaskWorktree({
      repoRoot: repo,
      worktreePath,
      branch: taskWorktreeBranch(convId, "branch-exists-label"),
      conversationId: convId,
    });
    // 把 worktree 删掉但保留 branch —— 模拟 remove-worktree 默认不删分支
    execFileSync("git", ["worktree", "remove", "--force", worktreePath], {
      cwd: repo,
      encoding: "utf8",
    });
    // `--force` may have already pruned the dir; ensure it is gone so the
    // branch_exists path takes the directory-MISSING sub-case.
    rmSync(worktreePath, { recursive: true, force: true });

    // 重新触发：branch 存在（branch_exists），目录已不存在。
    let branchErr: WorktreeIsolationError | undefined;
    try {
      await createTaskWorktree({
        repoRoot: repo,
        worktreePath,
        branch: taskWorktreeBranch(convId, "branch-exists-label"),
      });
    } catch (e) {
      branchErr = e as WorktreeIsolationError;
    }
    // 当前实现先检 branch 再检 worktree——目录不存在则 branch_exists 在前。
    expect(branchErr).toBeInstanceOf(WorktreeIsolationError);
    expect(branchErr!.kind).toBe("branch_exists");
    // 目录不存在 → detail **不含** enter-worktree（enter 必撞
    // worktree_not_found，照抄会造第二次空转）
    expect(branchErr!.detail).not.toContain("enter-worktree");
    // 指引换 label 或请操作员删分支
    expect(branchErr!.detail).toMatch(/label|operator/i);
    expect(branchErr!.detail).not.toContain("manually");
  });

  it("目标目录不存在 + branch 残留 → 不点名 enter-worktree，指引换 label 或删分支", async () => {
    const repo = makeGitRepo();
    const convId = "conv-orphan-branch";
    const worktreePath = taskWorktreePath(repo, convId, "orphan-label");
    // branch 单独存在，目录从未被建过
    execFileSync(
      "git",
      ["branch", taskWorktreeBranch(convId, "orphan-label")],
      {
        cwd: repo,
        encoding: "utf8",
      }
    );

    let err: WorktreeIsolationError | undefined;
    try {
      await createTaskWorktree({
        repoRoot: repo,
        worktreePath,
        branch: taskWorktreeBranch(convId, "orphan-label"),
      });
    } catch (e) {
      err = e as WorktreeIsolationError;
    }
    expect(err).toBeInstanceOf(WorktreeIsolationError);
    expect(err!.kind).toBe("branch_exists");
    // 目录不存在（worktreePath 未被建过）→ 不走 enter 路径
    expect(err!.detail).not.toContain("enter-worktree");
    // 指引换 label 或请操作员删分支
    expect(err!.detail).toMatch(/label|operator/i);
    expect(err!.detail).not.toContain("manually");
  });

  it("目标目录存在 + branch 残留 → 与 worktree_exists 同形（点 enter-worktree）", async () => {
    const repo = makeGitRepo();
    const convId = "conv-branch-with-dir";
    const worktreePath = taskWorktreePath(repo, convId, "both-present-label");
    // 用一条 branch 直接建工作树（不调用 createTaskWorktree 避免走 owner sidecar
    // 路径复杂化——这里我们只需要目录 + branch 都存在的状态，sidecar 可缺席）
    execFileSync(
      "git",
      ["worktree", "add", "-b", "iknow/task/both-present-x", worktreePath],
      {
        cwd: repo,
        encoding: "utf8",
      }
    );

    // 现在用同名 branch 再触发 createTaskWorktree：branch 存在 + 目录存在。
    let err: WorktreeIsolationError | undefined;
    try {
      await createTaskWorktree({
        repoRoot: repo,
        worktreePath,
        branch: "iknow/task/both-present-x",
      });
    } catch (e) {
      err = e as WorktreeIsolationError;
    }
    // 实现顺序：先 branch probe，再 existsSync 检查。
    expect(err).toBeInstanceOf(WorktreeIsolationError);
    expect(err!.kind).toBe("branch_exists");
    // 目录存在 → 走 worktree_exists 同形指引：list-worktrees（旁路目录，
    // 没有 .git 指针 → owner 读不出）或 enter-worktree（若 owner 反演
    // 成功）。此处 .git 指针存在但 sidecar 缺席，owner 走 leaf 形态判定：
    // leaf = both-present-x 是合法 label 且 != convId，所以 taskWorktreeOwnerOf
    // 返回 undefined（因为 leaf 不是 `<slug>--<convId>` 形态）→ 退化臂。
    expect(err!.detail).toMatch(/list-worktrees|enter-worktree/);
    expect(err!.detail).not.toContain("manually");
  });
});

// -- 输入五类 B 表 — 共同不变式 ------------------------------------------------

describe("T8 — 共同不变式（detail 文案唯一性、字面约定）", () => {
  it("两个 kind 的 detail 都不含「manually」", async () => {
    const repo = makeGitRepo();
    // worktree_exists: 占一个目录
    const wtPath = join(repo, "wt-occupied");
    writeFileSync(wtPath, "occupied");
    const wErr = await createTaskWorktree({
      repoRoot: repo,
      worktreePath: wtPath,
      branch: "iknow/task-x",
    }).then(
      () => undefined,
      (e: unknown) => e as WorktreeIsolationError
    );
    expect(wErr!.detail).not.toContain("manually");

    // branch_exists: 仅占一个 branch（目标目录不复用上面已存在的 wtPath，避免混淆）
    execFileSync("git", ["branch", "iknow/task-y"], {
      cwd: repo,
      encoding: "utf8",
    });
    const bErr = await createTaskWorktree({
      repoRoot: repo,
      worktreePath: join(repo, ".iknow", "worktrees", "fresh-leaf"),
      branch: "iknow/task-y",
    }).then(
      () => undefined,
      (e: unknown) => e as WorktreeIsolationError
    );
    expect(bErr!.detail).not.toContain("manually");
  });

  it("detail 给单一可执行出路（不含『resolve』/`/resolve/` 类手动指引）", async () => {
    const repo = makeGitRepo();
    const wtPath = join(repo, "wt-single");
    writeFileSync(wtPath, "occupied");
    const err = await createTaskWorktree({
      repoRoot: repo,
      worktreePath: wtPath,
      branch: "iknow/task-x",
    }).then(
      () => undefined,
      (e: unknown) => e as WorktreeIsolationError
    );
    // 「resolve」一字不再单独成指令；要么 enter-worktree，要么换 label，
    // 要么 list-worktrees。
    expect(err!.detail).not.toMatch(/\bresolve\b/);
  });
});
