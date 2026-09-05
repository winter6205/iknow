import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
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
 * T6 (plans/closed-world-bash-fence.md) — 白名单 miss 路径 5 类边界覆盖
 * （defensive-contract-validator：empty / negative / overflow / concurrent /
 * exception）。对象 = fs-policy 合同根 / 可选成员 / bwrap fence 构造。
 *
 * 与 fs-policy.test.ts 的分工：那里锁正常轴分离与合同根 fail-loud 的存在性
 * （blank / missing → ToolExecutionError）；这里锁边界形态——
 *   - empty：读白名单结果集为空（闭世界仍成立、argv 无读根 bind）、可选
 *     成员空数组 / 空白字符串条目静默丢弃；
 *   - negative：`../` 逃逸、symlink 语义按现状（词法判定，mount 层执法）、
 *     空字符串入参；
 *   - overflow：超长路径（> PATH_MAX）词法判定不炸出非 typed 错误、合同根
 *     超长缺失仍走 config-fault 分型；
 *   - concurrent：同一 policy 并发 createBwrapFence / 并发 createFsPolicy
 *     结果一致（无共享可变状态污染）；
 *   - exception：typed fail-loud 冒泡——合同根缺失抛 ToolExecutionError 且
 *     fence 构造（及下游 spawn）不可达；可选成员缺席静默跳过；两型不得混淆。
 *
 * 合同根盘上校验 → fixtures 真实存在（mkdtemp）；home 保持假路径（状态锚）。
 */

const FIX_ROOT = mkdtempSync(join(tmpdir(), "fs-policy-boundary-t6-"));
const TASK = join(FIX_ROOT, "task");
const INSTALL = join(FIX_ROOT, "install");
const IDENTITY = join(FIX_ROOT, "repo");
const TMP = mkdtempSync(join(tmpdir(), "fs-policy-boundary-t6-tmp-"));

beforeAll(() => {
  for (const dir of [TASK, INSTALL, IDENTITY]) {
    mkdirSync(dir, { recursive: true });
  }
});

afterAll(() => {
  rmSync(FIX_ROOT, { recursive: true, force: true });
  rmSync(TMP, { recursive: true, force: true });
});

/** 完整合同根基线（边界测试按类做减法 / 加料）。 */
function baseOpts(): Parameters<typeof createFsPolicy>[0] {
  return {
    cwd: TASK,
    home: "/home/user",
    tmpDir: TMP,
    installRoot: INSTALL,
    projectIdentityRoot: IDENTITY,
  };
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

describe("fs-policy boundary — empty (empty whitelist roots / optional members)", () => {
  it("empty read whitelist (no contract roots + collapsed node root) still builds a closed world", () => {
    // 不传 installRoot / projectIdentityRoot，node 根塌缩进系统前缀 → 读白
    // 名单结果集为空。闭世界不因此失效：写根内放行，其余一律 deny。
    const policy = createFsPolicy({
      cwd: TASK,
      home: "/home/user",
      tmpDir: TMP,
      nodeToolchainRoot: "/usr/bin",
    });
    assert.deepEqual([...policy.readRoots()], []);
    assert.deepEqual([...policy.optionalReadRoots()], []);
    assert.doesNotThrow(() => policy.assertWithin(join(TASK, "src.ts")));
    assert.throws(
      () => policy.assertWithin(join(INSTALL, "tool")),
      /\[fs_denied\]/,
      "a root that was not provided must not be whitelisted"
    );
    assert.throws(
      () => policy.assertWithin("/home/user/Documents/notes.txt"),
      /\[fs_denied\]/
    );
  });

  it("empty read whitelist emits a fence argv with no read-root ro-binds", () => {
    const policy = createFsPolicy({
      cwd: TASK,
      home: "/home/user",
      tmpDir: TMP,
      nodeToolchainRoot: "/usr/bin",
    });
    const argv = fenceArgv(policy);
    assert.equal(argv[0], "bwrap");
    for (const absent of [INSTALL, IDENTITY]) {
      const idx = argv.indexOf(absent);
      assert.equal(
        idx,
        -1,
        `absent contract root ${absent} must not appear as a bind target`
      );
    }
    // 写轴仍在：cwd bind + tmpfs。
    assert.ok(argv.includes("--tmpfs"));
    assert.ok(argv.includes(TASK));
  });

  it("empty optionalReadRoots array and blank-string entries are dropped silently, never fail", () => {
    const empty = createFsPolicy({ ...baseOpts(), optionalReadRoots: [] });
    assert.deepEqual([...empty.optionalReadRoots()], []);
    // 空白字符串条目 resolve 后会指向 process.cwd()——在 resolve 前过滤掉,
    // 不炸、不产生伪根。
    const blanks = createFsPolicy({
      ...baseOpts(),
      optionalReadRoots: ["", "   "],
    });
    assert.deepEqual([...blanks.optionalReadRoots()], []);
  });
});

describe("fs-policy boundary — negative (path escape / symlink semantics)", () => {
  it("denies ../ escape from a write root at any depth", () => {
    const policy = createFsPolicy(baseOpts());
    assert.throws(
      () => policy.assertWithin(join(TASK, "..", "sibling-escape")),
      /\[fs_denied\]/
    );
    assert.throws(
      () => policy.assertWithin(join(TASK, "a", "..", "..", "out")),
      /\[fs_denied\]/
    );
  });

  it("denies a read-root sibling (deny-by-default outside the whitelist)", () => {
    const policy = createFsPolicy(baseOpts());
    assert.throws(
      () => policy.assertWithin(join(IDENTITY, "..", "other-repo")),
      /\[fs_denied\]/
    );
  });

  it("symlink semantics (current behavior): the path-level check is lexical — a symlink inside a root is allowed, enforcement is mount-level", () => {
    // 现状合同：assertWithin 用 resolve()（纯词法，不跟随 symlink）。taskRoot
    // 内的 symlink 指向树外 → 词法上仍在 taskRoot 内 → 放行。物理越界由
    // bwrap mount 面执法（taskRoot bind 只暴露树内真实内容）。此处按现状
    // 钉死语义，防止未来无声改成跟随 symlink 的 stat 语义。
    const outside = join(FIX_ROOT, "outside-target");
    mkdirSync(outside, { recursive: true });
    const link = join(TASK, "sneaky-link");
    symlinkSync(outside, link);
    try {
      const policy = createFsPolicy(baseOpts());
      assert.doesNotThrow(() => policy.assertWithin(link));
      assert.equal(resolve(link), link, "resolve must not follow the symlink");
    } finally {
      rmSync(link, { force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("empty-string path resolves to process.cwd() and is judged by the same closed world", () => {
    const policy = createFsPolicy(baseOpts());
    // resolve("") === process.cwd()（测试进程 = 仓库根,不在任何 fixture 根内）
    // → deny-by-default,不因空入参崩溃或放行。
    assert.throws(() => policy.assertWithin(""), /\[fs_denied\]/);
  });
});

describe("fs-policy boundary — overflow (super-long paths, > PATH_MAX)", () => {
  const LONG = "a".repeat(5000);

  it("super-long path inside a write root is judged lexically without crashing", () => {
    const policy = createFsPolicy(baseOpts());
    // assertWithin 不 stat（纯词法）→ 不触发 ENAMETOOLONG / RangeError。
    assert.doesNotThrow(() => policy.assertWithin(join(TASK, LONG)));
  });

  it("super-long path outside the whitelist fails typed (no raw ENAMETOOLONG)", () => {
    const policy = createFsPolicy(baseOpts());
    try {
      policy.assertWithin(join(TMP, "..", LONG));
      assert.fail("expected ToolExecutionError");
    } catch (err) {
      assert.ok(
        err instanceof ToolExecutionError,
        `expected ToolExecutionError, got ${String(err)}`
      );
      assert.match((err as Error).message, /\[fs_denied\]/);
    }
  });

  it("contract root with a super-long nonexistent path fails typed at construction (config-fault, not raw ENAMETOOLONG)", () => {
    // existsSync 对超长路径返回 false（libuv 吞掉 ENAMETOOLONG）→ 走既有的
    // config-fault 分型,错误面不变。
    assert.throws(
      () => createFsPolicy({ ...baseOpts(), cwd: `/${LONG}` }),
      (err: unknown) =>
        err instanceof ToolExecutionError && /taskRoot/.test(err.message)
    );
  });
});

describe("fs-policy boundary — concurrent (fence / policy construction)", () => {
  it("concurrent createBwrapFence on one policy yields byte-identical argv and sealed tokens", async () => {
    const policy = createFsPolicy(baseOpts());
    const baseline = fenceArgv(policy);
    const fences = await Promise.all(
      Array.from({ length: 20 }, async () => {
        const fence = createBwrapFence({
          command: "bash",
          args: ["-c", "true"],
          fsPolicy: policy,
          networkPolicy: createNetworkPolicy(),
          resourceLimits: createResourceLimits(),
          env: { PATH: "/bin" },
          cwd: TASK,
        });
        return { argv: [...fence.argv], sealed: fence.sealed };
      })
    );
    for (const fence of fences) {
      assert.deepEqual(fence.argv, [...baseline], "argv must be identical");
      assert.equal(fence.sealed, true);
    }
  });

  it("concurrent createFsPolicy from the same inputs yields identical accessors", async () => {
    const baseline = createFsPolicy(baseOpts());
    const policies = await Promise.all(
      Array.from({ length: 10 }, async () => createFsPolicy(baseOpts()))
    );
    for (const policy of policies) {
      assert.deepEqual([...policy.writeRoots()], [...baseline.writeRoots()]);
      assert.deepEqual([...policy.readRoots()], [...baseline.readRoots()]);
      assert.deepEqual(
        [...policy.optionalReadRoots()],
        [...baseline.optionalReadRoots()]
      );
      assert.equal(policy.tmpRoot(), baseline.tmpRoot());
    }
  });

  it("interleaved policies keep separate root sets — no cross-pollution", async () => {
    // A 带全部合同根;B 无 identity 根且 node 根塌缩（读白名单为空）。
    // 并发构造 + 并发取 fence 后,各自与自己的串行基线一致。
    const aBaseline = createFsPolicy(baseOpts());
    const bBaseline = createFsPolicy({
      cwd: TASK,
      home: "/home/user",
      tmpDir: TMP,
      nodeToolchainRoot: "/usr/bin",
    });
    const [aFences, bFences] = await Promise.all([
      Promise.all(Array.from({ length: 5 }, async () => fenceArgv(aBaseline))),
      Promise.all(Array.from({ length: 5 }, async () => fenceArgv(bBaseline))),
    ]);
    assert.ok(
      [...aBaseline.readRoots()].includes(IDENTITY),
      "policy A whitelists the identity root"
    );
    assert.deepEqual(
      [...bBaseline.readRoots()],
      [],
      "policy B has an empty read whitelist"
    );
    for (const argv of aFences) {
      assert.deepEqual([...argv], [...fenceArgv(aBaseline)]);
    }
    for (const argv of bFences) {
      assert.deepEqual([...argv], [...fenceArgv(bBaseline)]);
    }
  });
});

describe("fs-policy boundary — exception (typed fail-loud bubbling, two error surfaces)", () => {
  it("contract root missing on disk → typed ToolExecutionError naming the role, and the fence flow never reaches fence construction (spawn unreachable)", () => {
    // 模拟 bash tool 的调用序:createFsPolicy → createBwrapFence → spawn。
    // 配置故障必须在第一环抛出,fence（及下游 spawn）不可达。
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
          projectIdentityRoot: "/nonexistent-t6-boundary-identity",
        }),
      (err: unknown) =>
        err instanceof ToolExecutionError &&
        /projectIdentityRoot/.test(err.message),
      "the error must be typed and name the missing contract root"
    );
    assert.equal(
      fenceConstructed,
      false,
      "config fault must prevent fence construction (and thus spawn)"
    );
  });

  it("optional member missing on disk → silent skip, never an error (other axis)", () => {
    const policy = createFsPolicy({
      ...baseOpts(),
      optionalReadRoots: ["/nonexistent-t6-boundary-gitconfig"],
    });
    assert.deepEqual([...policy.optionalReadRoots()], []);
    assert.doesNotThrow(() => policy.assertWithin(join(TASK, "still-works")));
  });

  it("the two error surfaces do not blur: a config fault does not contaminate a subsequent valid construction", () => {
    // 先炸一次（配置故障型）,紧接同形入参但可选项缺席的构造必须照常成功
    // ——fail-loud 不留模块级脏状态,缺席可选项也不得被升级成 config-fault。
    assert.throws(
      () =>
        createFsPolicy({
          ...baseOpts(),
          installRoot: "/nonexistent-t6-install",
        }),
      ToolExecutionError
    );
    const after = createFsPolicy({
      ...baseOpts(),
      optionalReadRoots: ["/nonexistent-t6-boundary-gitconfig"],
    });
    assert.ok([...after.readRoots()].includes(INSTALL));
    assert.deepEqual([...after.optionalReadRoots()], []);
  });
});
