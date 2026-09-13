import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";
import assert from "node:assert/strict";
import { createFsPolicy } from "../../../src/harness/sandbox/fs-policy.js";
import { createBwrapFence } from "../../../src/harness/sandbox/bwrap.js";
import { createNetworkPolicy } from "../../../src/harness/sandbox/network-policy.js";
import { createResourceLimits } from "../../../src/harness/sandbox/resource-limits.js";
import { ToolExecutionError } from "../../../src/harness/errors.js";

/**
 * ADR-0092 全局档 fs-policy 边界 5 类(empty / negative / overflow /
 * concurrent / exception)。
 *
 * 闭世界白名单退役后,边界面收敛到 policy 的两个合同输入(tmpDir 状态锚 +
 * home/workspaceRoot 状态锚)。这里锁:
 *   - empty:`tmpRoot` 必须是调用方传入的会话 tmp,空轴不产生任何 argv 变化;
 *   - negative:isSensitive 对兄弟/祖先前缀不误伤(`/home/userX` 不是
 *     `/home/user` 的子路径);
 *   - overflow:> PATH_MAX 的超长入参不得抛非 typed 错误;
 *   - concurrent:同输入的并发构造访问器一致、无跨实例污染;
 *   - exception:tmpDir 缺失 typed fail-loud,fence 构造不可达。
 */

const FIX_ROOT = mkdtempSync(join(tmpdir(), "fs-policy-boundary-global-"));
const TASK = join(FIX_ROOT, "task");
const TMP = mkdtempSync(join(tmpdir(), "fs-policy-boundary-global-tmp-"));

beforeAll(() => {
  mkdirSync(TASK, { recursive: true });
});

afterAll(() => {
  rmSync(FIX_ROOT, { recursive: true, force: true });
  rmSync(TMP, { recursive: true, force: true });
});

function baseOpts(): Parameters<typeof createFsPolicy>[0] {
  return { home: "/home/user", tmpDir: TMP };
}

function fenceArgv(
  policy: ReturnType<typeof createFsPolicy>
): readonly string[] {
  return createBwrapFence({
    command: "bash",
    args: ["-c", "true"],
    fsPolicy: policy,
    networkPolicy: createNetworkPolicy(),
    resourceLimits: createResourceLimits(),
    env: { PATH: "/bin" },
    cwd: TASK,
  }).argv;
}

describe("fs-policy boundary — empty (no per-instance mount axes)", () => {
  it("tmpRoot is exactly the caller's session tmp — never a guest /tmp alias", () => {
    const policy = createFsPolicy(baseOpts());
    assert.equal(policy.tmpRoot(), resolve(TMP));
    assert.notEqual(policy.tmpRoot(), "/tmp");
  });

  it("a policy with no workspaceRoot still builds the global fence (no empty-axis argv drift)", () => {
    const withWs = createFsPolicy({ ...baseOpts(), workspaceRoot: TASK });
    const withoutWs = createFsPolicy(baseOpts());
    // workspaceRoot 只是状态锚(argv 不读 policy) → 两 fence 完全一致。
    assert.deepEqual([...fenceArgv(withWs)], [...fenceArgv(withoutWs)]);
  });
});

describe("fs-policy boundary — negative (prefix/sibling semantics)", () => {
  it("does not treat a sibling home as sensitive", () => {
    const policy = createFsPolicy({ home: "/home/user", tmpDir: TMP });
    assert.equal(policy.isSensitive("/home/userX/.ssh/id_ed25519"), false);
    assert.equal(policy.isSensitive("/home/other/.ssh/id_ed25519"), false);
  });

  it("does not treat a workspaceRoot sibling as protected state", () => {
    const policy = createFsPolicy({
      ...baseOpts(),
      workspaceRoot: join(FIX_ROOT, "ws"),
    });
    assert.equal(
      policy.isSensitive(join(FIX_ROOT, "ws2", ".iknow", "state.json")),
      false
    );
    assert.equal(policy.isSensitive("/home/user/.iknow/state.json"), true);
  });

  it("empty-string path resolves to process.cwd() and is not a false positive", () => {
    const policy = createFsPolicy(baseOpts());
    // process.cwd()(仓库根)不在任何状态锚下。
    assert.equal(policy.isSensitive(""), false);
  });
});

describe("fs-policy boundary — overflow (super-long paths, > PATH_MAX)", () => {
  const LONG = "a".repeat(5000);

  it("super-long path in isSensitive is judged lexically without crashing", () => {
    const policy = createFsPolicy(baseOpts());
    assert.doesNotThrow(() => policy.isSensitive(join("/home/user", LONG)));
    assert.equal(policy.isSensitive(join("/home/user", LONG)), false);
    assert.equal(
      policy.isSensitive(join("/home/user/.ssh", LONG)),
      true,
      "a descendant of a sensitive root stays sensitive at any depth"
    );
  });

  it("contract root with a super-long nonexistent path fails typed (no raw ENAMETOOLONG)", () => {
    // existsSync 对超长路径返回 false(libuv 吞掉 ENAMETOOLONG)→ 走既有
    // config-fault 分型,错误面不变。
    assert.throws(
      () => createFsPolicy({ ...baseOpts(), tmpDir: `/${LONG}` }),
      (err: unknown) =>
        err instanceof ToolExecutionError && /tmpDir/.test(err.message)
    );
  });
});

describe("fs-policy boundary — concurrent (policy / fence construction)", () => {
  it("concurrent createFsPolicy from the same inputs yields identical accessors", async () => {
    const baseline = createFsPolicy(baseOpts());
    const policies = await Promise.all(
      Array.from({ length: 10 }, async () => createFsPolicy(baseOpts()))
    );
    for (const policy of policies) {
      assert.equal(policy.tmpRoot(), baseline.tmpRoot());
      assert.equal(
        policy.isSensitive("/home/user/.ssh/id_ed25519"),
        baseline.isSensitive("/home/user/.ssh/id_ed25519")
      );
    }
  });

  it("concurrent createBwrapFence yields byte-identical argv and sealed tokens", async () => {
    const baseline = [...fenceArgv(createFsPolicy(baseOpts()))];
    const fences = await Promise.all(
      Array.from({ length: 20 }, async () => {
        const fence = createBwrapFence({
          command: "bash",
          args: ["-c", "true"],
          fsPolicy: createFsPolicy(baseOpts()),
          networkPolicy: createNetworkPolicy(),
          resourceLimits: createResourceLimits(),
          env: { PATH: "/bin" },
          cwd: TASK,
        });
        return { argv: [...fence.argv], sealed: fence.sealed };
      })
    );
    for (const fence of fences) {
      assert.deepEqual(fence.argv, baseline, "argv must be identical");
      assert.equal(fence.sealed, true);
    }
  });

  it("interleaved policies with different homes keep separate sensitive sets", async () => {
    const a = createFsPolicy({ home: "/home/a", tmpDir: TMP });
    const b = createFsPolicy({ home: "/home/b", tmpDir: TMP });
    await Promise.all(Array.from({ length: 5 }, async () => undefined));
    assert.equal(a.isSensitive("/home/a/.ssh/config"), true);
    assert.equal(a.isSensitive("/home/b/.ssh/config"), false);
    assert.equal(b.isSensitive("/home/b/.ssh/config"), true);
    assert.equal(b.isSensitive("/home/a/.ssh/config"), false);
  });
});

describe("fs-policy boundary — exception (typed fail-loud bubbling)", () => {
  it("missing tmpDir throws typed and the fence flow never reaches fence construction", () => {
    let fenceConstructed = false;
    const buildFence = (opts: Parameters<typeof createFsPolicy>[0]) => {
      const policy = createFsPolicy(opts);
      fenceConstructed = true;
      return createBwrapFence({
        command: "bash",
        args: ["-c", "true"],
        fsPolicy: policy,
        networkPolicy: createNetworkPolicy(),
        resourceLimits: createResourceLimits(),
        env: { PATH: "/bin" },
        cwd: TASK,
      });
    };
    assert.throws(
      () =>
        buildFence({
          ...baseOpts(),
          tmpDir: "/nonexistent-global-boundary-tmp",
        }),
      (err: unknown) =>
        err instanceof ToolExecutionError && /tmpDir/.test(err.message),
      "the error must be typed and name the missing contract root"
    );
    assert.equal(
      fenceConstructed,
      false,
      "config fault must prevent fence construction (and thus spawn)"
    );
  });

  it("a config fault does not contaminate a subsequent valid construction", () => {
    assert.throws(
      () =>
        createFsPolicy({
          ...baseOpts(),
          tmpDir: "/nonexistent-global-boundary-tmp",
        }),
      ToolExecutionError
    );
    const after = createFsPolicy(baseOpts());
    assert.equal(after.tmpRoot(), resolve(TMP));
    assert.equal(after.isSensitive("/home/user/.ssh/config"), true);
  });
});
