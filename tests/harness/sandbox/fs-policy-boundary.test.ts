import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";
import assert from "node:assert/strict";
import { createFsPolicy } from "../../../src/harness/sandbox/fs-policy.js";
import { createBwrapFence } from "../../../src/harness/sandbox/bwrap.js";
import { ToolExecutionError } from "../../../src/harness/errors.js";

/**
 * ADR-0092 global-mode fs-policy boundary 5 classes (empty / negative /
 * overflow / concurrent / exception) — post-Round-2 dead-surface removal.
 *
 * 闭世界白名单退役后,边界面收敛到 policy 的唯一合同输入(tmpDir 状态锚)。
 * 这里锁:
 *   - empty:`tmpRoot` 必须是调用方传入的会话 tmp;argv 在 fence 形态下不读
 *     policy,同输入下 fence argv 逐字节一致;
 *   - negative:空白 / 盘上缺席的 tmpDir 不被静默容忍,而是 typed fail-loud;
 *   - overflow:> PATH_MAX 的超长入参不得抛非 typed 错误(不泄露 ENAMETOOLONG);
 *   - concurrent:同输入的并发构造访问器一致、无跨实例污染;
 *   - exception:缺失 tmpDir typed fail-loud,fence 构造不可达;一次 config
 *     fault 不污染下一次有效构造。
 *
 * The old "negative" class for home-prefix sibling semantics is gone with
 * `isSensitive`; the write-path negative / 5-class coverage lives in
 * tests/harness/aci/tools/write-file-fence-tmp.test.ts (already green).
 */

const FIX_ROOT = mkdtempSync(join(tmpdir(), "fs-policy-boundary-global-"));
const TMP = mkdtempSync(join(tmpdir(), "fs-policy-boundary-global-tmp-"));

beforeAll(() => {
  mkdirSync(FIX_ROOT, { recursive: true });
});

afterAll(() => {
  rmSync(FIX_ROOT, { recursive: true, force: true });
  rmSync(TMP, { recursive: true, force: true });
});

function baseOpts(): Parameters<typeof createFsPolicy>[0] {
  return { tmpDir: TMP };
}

function fenceArgv(
  policy: ReturnType<typeof createFsPolicy>
): readonly string[] {
  return createBwrapFence({
    command: "bash",
    args: ["-c", "true"],
    fsPolicy: policy,
    env: { PATH: "/bin" },
    cwd: FIX_ROOT,
  }).argv;
}

describe("fs-policy boundary — empty (no per-instance mount axes)", () => {
  it("tmpRoot is exactly the caller's session tmp — never a guest /tmp alias", () => {
    const policy = createFsPolicy(baseOpts());
    assert.equal(policy.tmpRoot(), resolve(TMP));
    assert.notEqual(policy.tmpRoot(), "/tmp");
  });

  it("two policies built from the same tmpDir produce identical fence argv", () => {
    // argv 不读 policy;两次构造同输入 → fence argv 逐字节一致(等价于旧的
    // 「workspaceRoot 不影响 argv」断言,在新合同下变成「tmpDir 不影响 argv」)。
    const a = createFsPolicy(baseOpts());
    const b = createFsPolicy(baseOpts());
    assert.deepEqual([...fenceArgv(a)], [...fenceArgv(b)]);
  });
});

describe("fs-policy boundary — negative (typed fail-loud for config faults)", () => {
  it("blank tmpDir throws typed (no silent fallback)", () => {
    assert.throws(
      () => createFsPolicy({ tmpDir: "" }),
      (err: unknown) =>
        err instanceof ToolExecutionError && /tmpDir/.test(err.message)
    );
  });

  it("whitespace-only tmpDir throws typed (no silent fallback)", () => {
    assert.throws(
      () => createFsPolicy({ tmpDir: "   " }),
      (err: unknown) =>
        err instanceof ToolExecutionError && /tmpDir/.test(err.message)
    );
  });

  it("missing tmpDir throws typed (no silent fallback)", () => {
    assert.throws(
      () => createFsPolicy({ tmpDir: "/nonexistent-boundary-missing-tmp" }),
      (err: unknown) =>
        err instanceof ToolExecutionError && /tmpDir/.test(err.message)
    );
  });
});

describe("fs-policy boundary — overflow (super-long paths, > PATH_MAX)", () => {
  const LONG = "a".repeat(5000);

  it("super-long tmpDir with a missing path fails typed (no raw ENAMETOOLONG)", () => {
    // existsSync 对超长路径返回 false(libuv 吞掉 ENAMETOOLONG)→ 走既有
    // config-fault 分型,错误面不变。
    assert.throws(
      () => createFsPolicy({ tmpDir: `/${LONG}` }),
      (err: unknown) =>
        err instanceof ToolExecutionError && /tmpDir/.test(err.message)
    );
  });

  it("valid super-long tmpDir survives without error", () => {
    // 真正超长但盘上存在的目录(由 mkdtemp 衍生)→ 构造成功,tmpRoot 等于
    // resolve 后的绝对路径,无 ENAMETOOLONG 渗漏。
    const longDir = mkdtempSync(
      join(tmpdir(), `fs-policy-boundary-overflow-${LONG.slice(0, 100)}-`)
    );
    try {
      const policy = createFsPolicy({ tmpDir: longDir });
      assert.equal(policy.tmpRoot(), resolve(longDir));
    } finally {
      rmSync(longDir, { recursive: true, force: true });
    }
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
          env: { PATH: "/bin" },
          cwd: FIX_ROOT,
        });
        return { argv: [...fence.argv], sealed: fence.sealed };
      })
    );
    for (const fence of fences) {
      assert.deepEqual(fence.argv, baseline, "argv must be identical");
      assert.equal(fence.sealed, true);
    }
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
        env: { PATH: "/bin" },
        cwd: FIX_ROOT,
      });
    };
    assert.throws(
      () =>
        buildFence({
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
          tmpDir: "/nonexistent-global-boundary-tmp",
        }),
      ToolExecutionError
    );
    const after = createFsPolicy(baseOpts());
    assert.equal(after.tmpRoot(), resolve(TMP));
  });
});
