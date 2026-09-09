import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, it } from "vitest";
import assert from "node:assert/strict";
import { createBwrapFence } from "../../../src/harness/sandbox/bwrap.js";
import { createFsPolicy } from "../../../src/harness/sandbox/fs-policy.js";
import { createNetworkPolicy } from "../../../src/harness/sandbox/network-policy.js";
import { createResourceLimits } from "../../../src/harness/sandbox/resource-limits.js";

/**
 * post-tmpfs 重绑(机制保留,T3 闭世界形态)。
 *
 * `--tmpfs /tmp` 会把此前绑进来的所有 /tmp/* 子树遮蔽(#196 T12b 病灶)。
 * 旧世界重绑对象 = home + cwd(writable 打底)与 identity ro-bind;闭世界
 * 下 home 不再是 bind root(home rebind 随 writable home 打底一起消亡),
 * 重绑对象 = 读白名单根(ro 夺回)+ cwd(可写夺回,最后)。cwdReadonly 时
 * cwd 重绑保持只读(#562 T5)。
 *
 * 合同根盘上校验 → fixtures 真实存在:/tmp 子树用 mkdtemp(tmpdir()),
 * /tmp 子树外用 homedir() 下的 fixture(生产形态)。
 */

const OUTSIDE_ROOT = mkdtempSync(join(homedir(), ".iknow-bwrap-rebind-"));

afterAll(() => {
  rmSync(OUTSIDE_ROOT, { recursive: true, force: true });
});

interface RebindSpec {
  readonly cwd: string;
  readonly home: string;
  readonly tmpDir?: string;
  readonly installRoot?: string;
  /** T5:identity 根经 policy 读白名单进围栏(bwrap 层选项已删)。 */
  readonly identityRoot?: string;
  readonly cwdReadonly?: boolean;
}

function fenceArgs(spec: RebindSpec): readonly string[] {
  return createBwrapFence({
    command: "bash",
    args: ["-c", "true"],
    fsPolicy: createFsPolicy({
      cwd: spec.cwd,
      home: spec.home,
      ...(spec.tmpDir !== undefined ? { tmpDir: spec.tmpDir } : {}),
      ...(spec.installRoot !== undefined
        ? { installRoot: spec.installRoot }
        : {}),
      ...(spec.identityRoot !== undefined
        ? { projectIdentityRoot: spec.identityRoot }
        : {}),
    }),
    networkPolicy: createNetworkPolicy(),
    resourceLimits: createResourceLimits(),
    env: { PATH: "/bin" },
    cwd: spec.cwd,
    ...(spec.cwdReadonly ? { cwdReadonly: true } : {}),
  }).argv;
}

function guestTmpMountIdx(argv: readonly string[]): number {
  let idx = -1;
  for (let i = 0; i + 2 < argv.length; i++) {
    if (argv[i] === "--bind" && argv[i + 2] === "/tmp") idx = i;
  }
  assert.notEqual(idx, -1, "expected `--bind <pad> /tmp` in argv");
  return idx;
}

function postTmpfs(argv: readonly string[]): readonly string[] {
  return argv.slice(guestTmpMountIdx(argv) + 3);
}

/** `verb <target> <target>` 三元组位置(在给定切片内)。 */
function tripleIdx(
  slice: readonly string[],
  verb: string,
  target: string
): number {
  return slice.findIndex(
    (arg, i) =>
      arg === verb && slice[i + 1] === target && slice[i + 2] === target
  );
}

describe("bwrap post-tmpfs rebinds (closed world)", () => {
  it("cwd under /tmp ⇒ writable cwd rebind after --tmpfs /tmp", () => {
    const cwd = mkdtempSync(join(tmpdir(), "bwrap-rebind-cwd-"));
    try {
      const argv = fenceArgs({ cwd, home: "/home/user" });
      const post = postTmpfs(argv);
      assert.notEqual(
        tripleIdx(post, "--bind", cwd),
        -1,
        "cwd descendant of /tmp must be re-bound writable after the tmpfs"
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("read root under /tmp ⇒ ro rebind after --tmpfs /tmp, before the cwd rebind (write reclaims last)", () => {
    const home = mkdtempSync(join(tmpdir(), "bwrap-rebind-home-"));
    const installRoot = join(home, "install");
    const cwd = join(home, "workspace");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(installRoot, { recursive: true });
    try {
      const argv = fenceArgs({ cwd, home, installRoot });
      const post = postTmpfs(argv);
      const installRebindIdx = tripleIdx(post, "--ro-bind", installRoot);
      const cwdRebindIdx = tripleIdx(post, "--bind", cwd);
      assert.notEqual(
        installRebindIdx,
        -1,
        "read root shadowed by the tmpfs must be re-asserted read-only"
      );
      assert.notEqual(
        cwdRebindIdx,
        -1,
        "cwd rebind must still reclaim writability"
      );
      assert.ok(
        installRebindIdx < cwdRebindIdx,
        "read rebinds precede the cwd write reclaim"
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("identity root under /tmp (main repo inside the tmp home) ⇒ identity ro rebind precedes the cwd rebind", () => {
    // T5 合并的 #891 泄漏形状用例(主仓 = /tmp home 的子目录,taskRoot 在
    // 主仓内)。机制对读白名单统一 —— identity 根作为 policy 读成员,与
    // installRoot 走同一条 post-tmpfs ro 重绑路径;cwd 重绑最后夺回可写。
    const home = mkdtempSync(join(tmpdir(), "bwrap-rebind-identity-"));
    const repo = join(home, "projects", "iknow");
    const cwd = join(repo, ".iknow", "worktrees", "conv-891");
    mkdirSync(cwd, { recursive: true });
    try {
      const argv = fenceArgs({ cwd, home, identityRoot: repo });
      const post = postTmpfs(argv);
      const identityRebindIdx = tripleIdx(post, "--ro-bind", repo);
      const cwdRebindIdx = tripleIdx(post, "--bind", cwd);
      assert.notEqual(
        identityRebindIdx,
        -1,
        "identity read member shadowed by the tmpfs must be re-asserted read-only"
      );
      assert.notEqual(cwdRebindIdx, -1, "cwd rebind reclaims writability");
      assert.ok(
        identityRebindIdx < cwdRebindIdx,
        "identity ro rebind precedes the cwd write reclaim"
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("home is never bound — under /tmp or not (writable-home base is gone, #196 T12b home rebind dies with it)", () => {
    // home 在 /tmp 子树内(旧世界必然触发 home rebind 的形状)+ cwd 在 home
    // 内:闭世界下 argv 不得含任何 home bind/rebind token。
    const home = mkdtempSync(join(tmpdir(), "bwrap-rebind-homeshadow-"));
    const cwd = join(home, "workspace");
    mkdirSync(cwd, { recursive: true });
    try {
      const argv = fenceArgs({ cwd, home });
      assert.equal(
        tripleIdx(argv, "--bind", home),
        -1,
        "no pre-tmpfs home bind in the closed world"
      );
      assert.equal(
        tripleIdx(postTmpfs(argv), "--bind", home),
        -1,
        "no post-tmpfs home rebind — home is not a bind root"
      );
      // cwd 仍按机制重绑(cwd 在 /tmp 子树内)。
      assert.notEqual(tripleIdx(postTmpfs(argv), "--bind", cwd), -1);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("cwd outside /tmp ⇒ no rebinds at all (production shape)", () => {
    const cwd = join(OUTSIDE_ROOT, "task");
    mkdirSync(cwd, { recursive: true });
    const argv = fenceArgs({ cwd, home: "/home/user" });
    const post = postTmpfs(argv);
    assert.equal(
      tripleIdx(post, "--bind", cwd),
      -1,
      "cwd outside /tmp needs no rebind"
    );
    assert.equal(
      tripleIdx(post, "--ro-bind", cwd),
      -1,
      "no read-only rebind for a cwd outside /tmp either"
    );
    // 无任何重绑 token:post-tmpfs 区只剩 --proc / --dev-bind。
    assert.deepEqual(post.slice(0, 4), [
      "--proc",
      "/proc",
      "--dev-bind",
      "/dev",
    ]);
  });

  it("cwdReadonly + cwd under /tmp ⇒ the post-tmpfs rebind stays read-only", () => {
    const cwd = mkdtempSync(join(tmpdir(), "bwrap-rebind-ro-"));
    try {
      const argv = fenceArgs({ cwd, home: "/home/user", cwdReadonly: true });
      const post = postTmpfs(argv);
      assert.equal(
        tripleIdx(post, "--bind", cwd),
        -1,
        "readonly fence must not reclaim writability after the tmpfs"
      );
      assert.notEqual(
        tripleIdx(post, "--ro-bind", cwd),
        -1,
        "readonly cwd rebinds as --ro-bind after the tmpfs"
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
