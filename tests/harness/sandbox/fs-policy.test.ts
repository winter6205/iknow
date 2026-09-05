import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  READ_ONLY_SYSTEM_PATHS,
  SENSITIVE_PATHS,
  createFsPolicy,
  defaultOptionalReadRoots,
} from "../../../src/harness/sandbox/fs-policy.js";
import { ToolExecutionError } from "../../../src/harness/errors.js";

/**
 * T3 (plans/closed-world-bash-fence.md) — fs-policy 读写双轴。
 *
 * ADR-0037 §9.2 / §9.4:
 *   - home 退出 bind roots——仅保留为状态锚(tilde 展开、protected state
 *     paths `~/.iknow` / `<workspaceRoot>/.iknow` 判定),不产生任何 bind。
 *   - 可写集 = taskRoot + tmp,无第三者;读通道 deny-by-default,按角色
 *     (installRoot / projectIdentityRoot / node 工具链根 / 可选成员)放行。
 *   - 合同根空白或盘上不存在 = 配置故障型 → typed fail-loud 不 spawn;
 *     可选成员存在性跳过——两轴错误面不得混淆。
 *   - 位置合同退役:allowedPaths() 按 index 取根的形态由角色取根
 *     (writeRoots / readRoots / tmpRoot)取代。
 *
 * 合同根是盘上校验的 → fixtures 必须真实存在(mkdtemp)。
 */

function isWithin(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return (
    rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep))
  );
}

/** 系统前缀在效集(与实现塌缩判定同源:固定集 + 在盘可选前缀)。 */
function systemPrefixesInEffect(): readonly string[] {
  return [
    ...READ_ONLY_SYSTEM_PATHS,
    ...["/opt", "/snap"].filter((p) => existsSync(p)),
  ];
}

describe("createFsPolicy — read/write dual axis (closed world, ADR-0037 §9.2)", () => {
  let taskRoot: string;
  let tmp: string;
  let installRoot: string;
  let identityRoot: string;
  let fixtureRoot: string;

  beforeAll(() => {
    fixtureRoot = mkdtempSync(join(tmpdir(), "fs-policy-t3-"));
    taskRoot = join(fixtureRoot, "task");
    installRoot = join(fixtureRoot, "install");
    identityRoot = join(fixtureRoot, "repo");
    for (const dir of [taskRoot, installRoot, identityRoot]) {
      mkdirSync(dir, { recursive: true });
    }
    tmp = mkdtempSync(join(tmpdir(), "fs-policy-t3-tmp-"));
  });

  afterAll(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
    rmSync(tmp, { recursive: true, force: true });
  });

  function policyFor(
    extra: Partial<Parameters<typeof createFsPolicy>[0]> = {}
  ): ReturnType<typeof createFsPolicy> {
    return createFsPolicy({
      cwd: taskRoot,
      home: "/home/user",
      tmpDir: tmp,
      installRoot,
      projectIdentityRoot: identityRoot,
      ...extra,
    });
  }

  it("splits the fence into write/read axes; home exits the bind roots", () => {
    const policy = policyFor();
    // 写白名单 = taskRoot + tmp,无第三者(§9.2)。
    assert.deepEqual([...policy.writeRoots()], [taskRoot, tmp]);
    assert.equal(policy.tmpRoot(), tmp);
    // home 是状态锚,不再出现在任何 bind root 轴上(闭世界:不可见)。
    const allRoots = [
      ...policy.writeRoots(),
      ...policy.readRoots(),
      ...policy.optionalReadRoots(),
    ];
    assert.equal(
      allRoots.some((root) => root === "/home/user"),
      false,
      "home must not be a bind root anymore"
    );
    // 读白名单按角色:installRoot / projectIdentityRoot 合同根 + node 工具链根。
    assert.ok(policy.readRoots().includes(installRoot));
    assert.ok(policy.readRoots().includes(identityRoot));
    const nodeRoot = dirname(process.execPath);
    const nodeCollapsed = systemPrefixesInEffect().some((prefix) =>
      isWithin(prefix, nodeRoot)
    );
    assert.equal(
      policy.readRoots().includes(nodeRoot),
      !nodeCollapsed,
      "default node toolchain root = dirname(process.execPath) unless it collapses into system prefixes"
    );
  });

  it("honors a caller-provided nodeToolchainRoot (caller wins over the default derivation)", () => {
    const policy = policyFor({ nodeToolchainRoot: installRoot });
    assert.ok(
      policy.readRoots().includes(installRoot),
      "caller-passed node toolchain root enters the read whitelist"
    );
    assert.equal(
      policy.readRoots().filter((root) => root === installRoot).length,
      1,
      "identical read roots dedupe to one entry"
    );
  });

  it("collapses the node toolchain root when it falls under a system prefix (§9.2 #5)", () => {
    // /usr/bin 恒在盘上且位于 /usr 之下 → 不新增 bind。
    const policy = policyFor({ nodeToolchainRoot: "/usr/bin" });
    assert.equal(
      policy.readRoots().includes("/usr/bin"),
      false,
      "node root under a system prefix must collapse (already covered by the system ro-bind)"
    );
  });

  it("existence-skips optional read members without failing (different axis from contract roots)", () => {
    const optionalDir = mkdtempSync(join(tmpdir(), "fs-policy-t3-opt-"));
    try {
      const gitconfig = join(optionalDir, "gitconfig");
      writeFileSync(gitconfig, "");
      const policy = policyFor({
        optionalReadRoots: [gitconfig, "/nonexistent-t3/gitconfig"],
      });
      assert.deepEqual(
        [...policy.optionalReadRoots()],
        [resolve(gitconfig)],
        "only on-disk optional members survive; absent ones are skipped silently"
      );
    } finally {
      rmSync(optionalDir, { recursive: true, force: true });
    }
  });

  it("fails loud on blank or missing contract roots (config-fault class, §9.4)", () => {
    // 写根:taskRoot / tmp。
    assert.throws(
      () => policyFor({ cwd: "" }),
      (err: unknown) =>
        err instanceof ToolExecutionError && /taskRoot/.test(err.message)
    );
    assert.throws(
      () => policyFor({ cwd: "/nonexistent-t3-taskroot" }),
      (err: unknown) =>
        err instanceof ToolExecutionError && /taskRoot/.test(err.message)
    );
    assert.throws(
      () => policyFor({ tmpDir: "" }),
      (err: unknown) =>
        err instanceof ToolExecutionError && /tmpDir/.test(err.message)
    );
    assert.throws(
      () => policyFor({ tmpDir: "/nonexistent-t3-tmp" }),
      (err: unknown) =>
        err instanceof ToolExecutionError && /tmpDir/.test(err.message)
    );
    // 合同读根:installRoot / projectIdentityRoot / node 工具链根。
    assert.throws(
      () => policyFor({ installRoot: "" }),
      (err: unknown) =>
        err instanceof ToolExecutionError && /installRoot/.test(err.message)
    );
    assert.throws(
      () => policyFor({ installRoot: "/nonexistent-t3-install" }),
      (err: unknown) =>
        err instanceof ToolExecutionError && /installRoot/.test(err.message)
    );
    assert.throws(
      () => policyFor({ projectIdentityRoot: "/nonexistent-t3-identity" }),
      (err: unknown) =>
        err instanceof ToolExecutionError &&
        /projectIdentityRoot/.test(err.message)
    );
    assert.throws(
      () => policyFor({ nodeToolchainRoot: "/nonexistent-t3-node" }),
      (err: unknown) =>
        err instanceof ToolExecutionError &&
        /nodeToolchainRoot/.test(err.message)
    );
    // 两轴错误面不混淆:可选成员缺席不炸(存在性跳过),合同根缺席必炸。
    assert.doesNotThrow(() =>
      policyFor({ optionalReadRoots: ["/nonexistent-t3-git"] })
    );
  });

  it("assertWithin follows the closed world: write/read roots allowed, home invisible", () => {
    const policy = policyFor();
    // 写根内放行。
    assert.doesNotThrow(() => policy.assertWithin(join(taskRoot, "src.ts")));
    // 读根内放行(闭世界的可见集)。
    assert.doesNotThrow(() =>
      policy.assertWithin(join(installRoot, "node_modules/.bin/tsc"))
    );
    // home 下兄弟路径:旧世界 allowedPaths 含 home(放行),闭世界拒绝——更强。
    assert.throws(
      () => policy.assertWithin("/home/user/Documents/notes.txt"),
      /\[fs_denied\]/
    );
    // 系统前缀与敏感路径维持既有拒绝面。
    assert.throws(() => policy.assertWithin("/etc/passwd"), /\[fs_denied\]/);
    assert.throws(
      () => policy.assertWithin("/home/user/.ssh/config"),
      /\[fs_denied\]/
    );
  });

  it("keeps the state-anchor surface: tilde sensitive paths + protected state paths", () => {
    assert.ok(Object.isFrozen(SENSITIVE_PATHS));
    assert.ok(Object.isFrozen(READ_ONLY_SYSTEM_PATHS));
    const policy = policyFor({ workspaceRoot: taskRoot });
    // SENSITIVE_PATHS 经 home tilde 展开(isSensitive 保留——assertWithin 用)。
    assert.equal(policy.isSensitive("/home/user/.ssh/id_ed25519"), true);
    assert.equal(policy.isSensitive("/home/user/.docker/config.json"), true);
    // protected state paths(home 锚 + workspaceRoot 锚)判定位保持。
    assert.equal(policy.isSensitive("/home/user/.iknow/state.json"), true);
    assert.equal(policy.isSensitive(`${taskRoot}/.iknow/state.json`), true);
    assert.throws(
      () => policy.assertWithin(`${taskRoot}/.iknow/user.md`),
      /\[fs_denied\]/
    );
    assert.doesNotThrow(() => policy.assertWithin(join(taskRoot, "AGENTS.md")));
  });

  it("retires the positional contract: roots are taken by role, not by index", () => {
    // 位置合同(bwrap.ts 曾按 allowedPaths()[1]=home / [2]=tmp 取根)退役;
    // 接口只暴露角色取根访问器。workspaceRoot 仅状态锚,不进任何轴。
    const distinct = policyFor({ workspaceRoot: "/fake-workspace-root" });
    assert.deepEqual(
      [...distinct.writeRoots()],
      [taskRoot, tmp],
      "workspaceRoot must not appear on the write axis"
    );
    assert.equal(
      [...distinct.readRoots(), ...distinct.optionalReadRoots()].includes(
        "/fake-workspace-root"
      ),
      false,
      "workspaceRoot must not appear on the read axis"
    );
    assert.equal(
      distinct.isSensitive("/fake-workspace-root/.iknow/state.json"),
      true,
      "workspaceRoot stays a protected-state anchor"
    );
  });
});

describe("defaultOptionalReadRoots — §9.2 #7 git global config pair (single source)", () => {
  it("derives ~/.gitconfig + ~/.config/git/config under the given home, in order", () => {
    const roots = defaultOptionalReadRoots({ home: "/home/user" });
    assert.deepEqual(roots, [
      "/home/user/.gitconfig",
      "/home/user/.config/git/config",
    ]);
  });

  it("feeds createFsPolicy as existence-skipped optional members (on-disk file survives)", () => {
    const home = mkdtempSync(join(tmpdir(), "fs-policy-t4-git-"));
    try {
      mkdirSync(join(home, ".config", "git"), { recursive: true });
      writeFileSync(join(home, ".gitconfig"), "[user]\n");
      writeFileSync(join(home, ".config", "git", "config"), "[user]\n");
      const taskRoot = mkdtempSync(join(tmpdir(), "fs-policy-t4-git-task-"));
      try {
        const policy = createFsPolicy({
          cwd: taskRoot,
          home,
          tmpDir: taskRoot,
          optionalReadRoots: defaultOptionalReadRoots({ home }),
        });
        assert.deepEqual(
          [...policy.optionalReadRoots()],
          [join(home, ".gitconfig"), join(home, ".config", "git", "config")]
        );
        // 可选成员在闭世界可见集内(assertWithin 放行)。
        assert.doesNotThrow(() =>
          policy.assertWithin(join(home, ".gitconfig"))
        );
      } finally {
        rmSync(taskRoot, { recursive: true, force: true });
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
