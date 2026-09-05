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
 * #891 T2 → T3 闭世界改写（plans/closed-world-bash-fence.md）。
 *
 * 旧形态（ADR-0037 amendment 2026-09-05）= writable home 打底 + 身份根
 * `--ro-bind` 后挂补罩；ADR-0037 §9.3 已将该 overlay 条款 superseded——闭
 * 世界下 home 不可写，「writable 祖先罩住主仓」的病灶消失，身份根降级为
 * §9.2 第 6 条读白名单成员。本文件改写为认证闭世界不变式：
 *
 * 1. 身份根以 `--ro-bind` 进读白名单块，位于可写 cwd bind **之前**
 *    （taskRoot 在身份树内时由后挂 cwd bind 夺回可写——等价于旧「cwd 最后
 *    夺回」不变式，且更强：不再存在可写 home 祖先可供穿透）。
 * 2. argv 不含任何 `--bind <home> <home>` token（writable home 打底消失）。
 * 3. 身份根 ∈ /tmp 子树时 post-tmpfs ro 重绑仍在 cwd 重绑之前（机制保留）。
 * 4. 合同输入 fail-loud：空白 / 盘上不存在 → typed error 不 spawn（存续
 *    条款，§9.4 继承）。
 *
 * 身份根 / cwd 是合同输入：空白 / 盘上不存在 → typed fail-loud——所以排序
 * 用例必须落真实 tmpdir 目录，不能造假路径。
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

describe("bwrap identity-root read whitelist (closed world, supersedes #891 T2 overlay)", () => {
  it("positive: identity ro-bind is a read member ordered before the writable cwd bind; no home bind exists", () => {
    const dirs = makeLeakShape();
    try {
      const argv = fenceArgs({
        cwd: dirs.taskRoot,
        home: dirs.home,
        projectIdentityRoot: dirs.repo,
      });
      const identityIdx = bindIndex(argv, "--ro-bind", dirs.repo);
      const cwdBindIdx = bindIndex(argv, "--bind", dirs.taskRoot);
      assert.ok(
        identityIdx < cwdBindIdx,
        "cwd (taskRoot) must come after the identity ro-bind to reclaim writability"
      );
      // 闭世界核心不变式：可写 home 打底 token 彻底消失——没有可写祖先可
      // 被身份根覆盖，也不存在可写 home 穿透面。
      assert.equal(
        argv.findIndex(
          (arg, i) => arg === "--bind" && argv[i + 1] === dirs.home
        ),
        -1,
        "writable home bind must be gone (closed world)"
      );
    } finally {
      rmSync(dirs.root, { recursive: true, force: true });
    }
  });

  it("negative: identity ro-bind absent when the option is not passed (caller has not threaded the whitelist)", () => {
    const dirs = makeLeakShape();
    try {
      const argv = fenceArgs({ cwd: dirs.taskRoot, home: dirs.home });
      // 系统树本来就带 --ro-bind（/usr 等），断言只针对身份根目标缺席。
      assert.equal(
        argv.findIndex(
          (arg, i) => arg === "--ro-bind" && argv[i + 1] === dirs.repo
        ),
        -1,
        "identity root must not be bound without the option"
      );
    } finally {
      rmSync(dirs.root, { recursive: true, force: true });
    }
  });

  it("exception: blank identity root → typed fail-loud, no argv", () => {
    const dirs = makeLeakShape();
    try {
      assert.throws(
        () =>
          fenceArgs({
            cwd: dirs.taskRoot,
            home: dirs.home,
            projectIdentityRoot: "",
          }),
        (err: unknown) =>
          err instanceof ToolExecutionError &&
          /projectIdentityRoot/.test(err.message)
      );
    } finally {
      rmSync(dirs.root, { recursive: true, force: true });
    }
  });

  it("exception: identity root missing on disk → typed fail-loud, no argv", () => {
    const dirs = makeLeakShape();
    try {
      assert.throws(
        () =>
          fenceArgs({
            cwd: dirs.taskRoot,
            home: dirs.home,
            projectIdentityRoot: "/nonexistent/identity-root-891",
          }),
        (err: unknown) =>
          err instanceof ToolExecutionError &&
          /projectIdentityRoot/.test(err.message)
      );
    } finally {
      rmSync(dirs.root, { recursive: true, force: true });
    }
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

  it("leak shape (identity under home under /tmp) — identity rebind precedes the cwd rebind after tmpfs", () => {
    // 复现 2026-09-05 泄漏形状的目录布局：主仓（身份根）是 $HOME 的子目录，
    // taskRoot 在主仓内。闭世界下身份根 ∈ /tmp 子树 → --tmpfs /tmp 会遮蔽
    // pre-tmpfs 的身份根 ro-bind → post-tmpfs ro 重绑夺回读通道；cwd 重绑
    // 最后夺回可写（机制保留，T5 清理 identity 专属条件层）。
    const dirs = makeLeakShape();
    try {
      const argv = fenceArgs({
        cwd: dirs.taskRoot,
        home: dirs.home,
        projectIdentityRoot: dirs.repo,
      });
      const tmpfsIdx = argv.findIndex(
        (arg, i) => arg === "--tmpfs" && argv[i + 1] === "/tmp"
      );
      assert.notEqual(tmpfsIdx, -1);
      const postTmpfs = argv.slice(tmpfsIdx + 2);
      const identityRebindIdx = bindIndex(postTmpfs, "--ro-bind", dirs.repo);
      const cwdRebindIdx = bindIndex(postTmpfs, "--bind", dirs.taskRoot);
      assert.ok(
        identityRebindIdx < cwdRebindIdx,
        "identity ro rebind must be re-asserted after the tmpfs and before the cwd reclaim"
      );
      // home 无任何 bind/rebind token。
      assert.equal(
        argv.findIndex(
          (arg, i) => arg === "--bind" && argv[i + 1] === dirs.home
        ),
        -1,
        "no home bind in the closed world"
      );
    } finally {
      rmSync(dirs.root, { recursive: true, force: true });
    }
  });
});
