import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBwrapFence } from "../../../src/harness/sandbox/bwrap.js";
import { createFsPolicy } from "../../../src/harness/sandbox/fs-policy.js";
import { createNetworkPolicy } from "../../../src/harness/sandbox/network-policy.js";
import { createResourceLimits } from "../../../src/harness/sandbox/resource-limits.js";
import { ToolExecutionError } from "../../../src/harness/errors.js";

/**
 * #891 T2: 改绑后（isolation ON + rebind）bash 围栏的身份根只读 overlay。
 *
 * 病灶（2026-09-05 复现，ADR-0037 §4 amendment (a)–(d)）：围栏 `--bind
 * $HOME $HOME` 后挂于 cwd bind，主仓在 home 下时被可写祖先罩住，bash 写
 * 主仓穿透（exit 0）。修复 = 把 `projectIdentityRoot` 整棵树以 `--ro-bind`
 * 后挂于 writable home bind 之后、writable cwd bind 之前（taskRoot 在身份
 * 树内，cwd 最后夺回可写；cwdReadonly 已证明的覆盖祖先纪律）。
 *
 * 身份根是合同输入：空白 / 盘上不存在 → typed fail-loud，不 spawn——所以
 * 排序用例必须落真实 tmpdir 目录，不能造假路径。
 */

interface FenceSpec {
  cwd: string;
  home: string;
  projectIdentityRoot?: string;
}

function fenceArgs(spec: FenceSpec): readonly string[] {
  return createBwrapFence({
    command: "bash",
    args: ["-c", "true"],
    fsPolicy: createFsPolicy({
      cwd: spec.cwd,
      home: spec.home,
    }),
    networkPolicy: createNetworkPolicy(),
    resourceLimits: createResourceLimits(),
    env: { PATH: "/bin" },
    cwd: spec.cwd,
    ...(spec.projectIdentityRoot !== undefined
      ? { projectIdentityRoot: spec.projectIdentityRoot }
      : {}),
  }).argv;
}

function bindIndex(
  argv: readonly string[],
  verb: string,
  target: string
): number {
  const idx = argv.findIndex(
    (arg, i) => arg === verb && argv[i + 1] === target && argv[i + 2] === target
  );
  assert.notEqual(idx, -1, `expected \`${verb} ${target} ${target}\` in argv`);
  return idx;
}

/** 建一棵 `<root>/home/projects/iknow` 主仓 + 其下 task worktree 形状的树。 */
function makeLeakShape(): {
  root: string;
  home: string;
  repo: string;
  taskRoot: string;
} {
  const root = mkdtempSync(join(tmpdir(), "bwrap-ovl-891-"));
  const home = join(root, "home");
  const repo = join(home, "projects", "iknow");
  const taskRoot = join(repo, ".iknow", "worktrees", "conv-891");
  mkdirSync(taskRoot, { recursive: true });
  return { root, home, repo, taskRoot };
}

describe("bwrap identity-root overlay (#891 T2)", () => {
  it("positive: overlay token ordered after writable home bind, before cwd bind", () => {
    const dirs = makeLeakShape();
    try {
      const argv = fenceArgs({
        cwd: dirs.taskRoot,
        home: dirs.home,
        projectIdentityRoot: dirs.repo,
      });
      const homeBindIdx = bindIndex(argv, "--bind", dirs.home);
      const identityIdx = bindIndex(argv, "--ro-bind", dirs.repo);
      const cwdBindIdx = bindIndex(argv, "--bind", dirs.taskRoot);
      assert.ok(
        identityIdx > homeBindIdx,
        "identity ro-bind must cover the writable home ancestor"
      );
      assert.ok(
        cwdBindIdx > identityIdx,
        "cwd (taskRoot) must come after the identity ro-bind to reclaim writability"
      );
    } finally {
      rmSync(dirs.root, { recursive: true, force: true });
    }
  });

  it("negative: identity ro-bind absent when the option is not passed (OFF / unbound)", () => {
    const dirs = makeLeakShape();
    try {
      const argv = fenceArgs({ cwd: dirs.taskRoot, home: dirs.home });
      // 系统树本来就带 --ro-bind（/usr 等），断言只针对身份根目标缺席。
      assert.equal(
        argv.findIndex(
          (arg, i) => arg === "--ro-bind" && argv[i + 1] === dirs.repo
        ),
        -1,
        "identity root must not be bound without the overlay option"
      );
    } finally {
      rmSync(dirs.root, { recursive: true, force: true });
    }
  });

  it("exception: blank identity root → typed fail-loud, no argv", () => {
    assert.throws(
      () =>
        fenceArgs({
          cwd: "/repo",
          home: "/home/user",
          projectIdentityRoot: "",
        }),
      (err: unknown) =>
        err instanceof ToolExecutionError &&
        /projectIdentityRoot/.test(err.message)
    );
  });

  it("exception: identity root missing on disk → typed fail-loud, no argv", () => {
    assert.throws(
      () =>
        fenceArgs({
          cwd: "/repo/.iknow/worktrees/conv-1",
          home: "/home/user",
          projectIdentityRoot: "/nonexistent/identity-root-891",
        }),
      (err: unknown) =>
        err instanceof ToolExecutionError &&
        /projectIdentityRoot/.test(err.message)
    );
  });

  it("off/unbound: argv byte-identical with and without undefined overlay", () => {
    const dirs = makeLeakShape();
    try {
      const base = { cwd: dirs.taskRoot, home: dirs.home };
      const without = fenceArgs(base);
      const withUndefined = createBwrapFence({
        command: "bash",
        args: ["-c", "true"],
        fsPolicy: createFsPolicy(base),
        networkPolicy: createNetworkPolicy(),
        resourceLimits: createResourceLimits(),
        env: { PATH: "/bin" },
        cwd: base.cwd,
        projectIdentityRoot: undefined,
      }).argv;
      assert.deepEqual(withUndefined, without);
    } finally {
      rmSync(dirs.root, { recursive: true, force: true });
    }
  });

  it("overflow: identity under home (leak shape) — overlay covers writable ancestor", () => {
    // 复现 2026-09-05 泄漏形状：主仓（身份根）是 $HOME 的子目录，taskRoot
    // 在主仓内。相对 mkdir -p <repo>/archive/.tmp 在旧 argv 下会落主仓。
    const dirs = makeLeakShape();
    try {
      const argv = fenceArgs({
        cwd: dirs.taskRoot,
        home: dirs.home,
        projectIdentityRoot: dirs.repo,
      });
      const homeBindIdx = bindIndex(argv, "--bind", dirs.home);
      const identityIdx = bindIndex(argv, "--ro-bind", dirs.repo);
      assert.ok(identityIdx > homeBindIdx);
      // tmpfs 重绑纪律：home 落在 tmpDir 之下时（本测试即如此），post-tmpfs
      // 的 home rebind 会再盖身份根 —— 身份根 rebind 必须跟在其后。
      const tmpfsIdx = argv.findIndex(
        (arg, i) => arg === "--tmpfs" && argv[i + 1] === "/tmp"
      );
      assert.notEqual(tmpfsIdx, -1);
      const postTmpfs = argv.slice(tmpfsIdx + 2);
      const homeRebindIdx = bindIndex(postTmpfs, "--bind", dirs.home);
      const identityRebindIdx = bindIndex(postTmpfs, "--ro-bind", dirs.repo);
      const cwdRebindIdx = bindIndex(postTmpfs, "--bind", dirs.taskRoot);
      assert.ok(
        identityRebindIdx > homeRebindIdx,
        "identity ro-bind must be re-asserted after the post-tmpfs home rebind"
      );
      assert.ok(
        cwdRebindIdx > identityRebindIdx,
        "cwd rebind must come last to reclaim writability"
      );
    } finally {
      rmSync(dirs.root, { recursive: true, force: true });
    }
  });
});
