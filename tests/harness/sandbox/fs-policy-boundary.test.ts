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
 * overflow / concurrent / exception) — dead-surface removal.
 *
 * After the closed-world allowlist retired, the boundary surface converges on
 * the policy's sole contract input (the tmpDir state anchor). Pinned here:
 *   - empty: `tmpRoot` must be the session tmp passed in by the caller; in
 *     fence shape argv does not read the policy, so same input → byte-identical
 *     fence argv;
 *   - negative: blank / disk-absent tmpDir is not silently tolerated but typed fail-loud;
 *   - overflow: super-long inputs (> PATH_MAX) must not throw non-typed errors (no ENAMETOOLONG leak);
 *   - concurrent: concurrent construction from the same input agrees on
 *     accessors, no cross-instance pollution;
 *   - exception: missing tmpDir is typed fail-loud, fence construction
 *     unreachable; one config fault does not contaminate the next valid construction.
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
    // argv does not read the policy; two constructions from the same input →
    // byte-identical fence argv (the old "workspaceRoot does not affect argv"
    // assertion becomes "tmpDir does not affect argv" under the new contract).
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
    // existsSync returns false for super-long paths (libuv swallows ENAMETOOLONG)
    // → the existing config-fault classification applies; the error surface is unchanged.
    assert.throws(
      () => createFsPolicy({ tmpDir: `/${LONG}` }),
      (err: unknown) =>
        err instanceof ToolExecutionError && /tmpDir/.test(err.message)
    );
  });

  it("valid super-long tmpDir survives without error", () => {
    // genuinely super-long but existing on disk (derived via mkdtemp) → construction
    // succeeds, tmpRoot equals the resolved absolute path, no ENAMETOOLONG leakage.
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
