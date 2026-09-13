import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  OPTIONAL_HOST_RO_PREFIXES,
  READ_ONLY_SYSTEM_PATHS,
  createFsPolicy,
} from "../../../src/harness/sandbox/fs-policy.js";
import { ToolExecutionError } from "../../../src/harness/errors.js";

/**
 * ADR-0092 global-mode fs-policy contract (post-Round-2 dead-surface removal).
 *
 * 闭世界(读/写白名单 + assertWithin / SENSITIVE_PATHS / isSensitive)退役,
 * policy 只剩一面:
 *   - `tmpRoot()`:本 identity 的会话 tmp 宿主路径(供 `$TMPDIR` 与写工具
 *     可写根用),不是 guest `/tmp` 的 bind 目标。
 *
 * 没有 home / workspaceRoot 状态锚谓词、没有白名单、没有 isSensitive 表面;
 * 写保护由 bwrap 挂载层(host root + 系统前缀只读重绑)与权限链 + hard-wall
 * 共同承担。合同输入只有 `tmpDir`(空白或盘上缺席 → typed fail-loud,不 spawn)。
 */

describe("createFsPolicy — global-mode tmpRoot (ADR-0092)", () => {
  let fixtureRoot: string;
  let tmp: string;

  beforeAll(() => {
    fixtureRoot = mkdtempSync(join(tmpdir(), "fs-policy-global-"));
    mkdirSync(fixtureRoot, { recursive: true });
    tmp = mkdtempSync(join(tmpdir(), "fs-policy-global-tmp-"));
  });

  afterAll(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
    rmSync(tmp, { recursive: true, force: true });
  });

  function policyFor(
    extra: Partial<Parameters<typeof createFsPolicy>[0]> = {}
  ): ReturnType<typeof createFsPolicy> {
    return createFsPolicy({
      tmpDir: tmp,
      ...extra,
    });
  }

  it("exposes only tmpRoot — the closed-world root axes and isSensitive are gone", () => {
    const policy = policyFor();
    assert.equal(policy.tmpRoot(), resolve(tmp));
    // 闭世界退役面 + Round-2 placeholder 谓词 must all be gone — 残留即回归。
    const surface = policy as unknown as Record<string, unknown>;
    for (const retired of [
      "writeRoots",
      "readRoots",
      "optionalReadRoots",
      "assertWithin",
      "isSensitive",
    ]) {
      assert.equal(
        retired in surface,
        false,
        `retired closed-world accessor must not survive: ${retired}`
      );
    }
  });

  it("fails loud on a blank or missing tmpDir contract root (config-fault class)", () => {
    assert.throws(
      () => policyFor({ tmpDir: "" }),
      (err: unknown) =>
        err instanceof ToolExecutionError && /tmpDir/.test(err.message)
    );
    assert.throws(
      () => policyFor({ tmpDir: "   " }),
      (err: unknown) =>
        err instanceof ToolExecutionError && /tmpDir/.test(err.message)
    );
    assert.throws(
      () => policyFor({ tmpDir: "/nonexistent-global-tmp" }),
      (err: unknown) =>
        err instanceof ToolExecutionError && /tmpDir/.test(err.message)
    );
  });

  it("keeps the frozen host-prefix sources single-source (system + optional)", () => {
    assert.ok(Object.isFrozen(READ_ONLY_SYSTEM_PATHS));
    assert.ok(Object.isFrozen(OPTIONAL_HOST_RO_PREFIXES));
    assert.deepEqual(
      [...READ_ONLY_SYSTEM_PATHS],
      ["/usr", "/bin", "/lib", "/lib64", "/etc"]
    );
    assert.deepEqual([...OPTIONAL_HOST_RO_PREFIXES], ["/opt", "/snap"]);
  });

  it("tmpRoot is the exact host path passed in (never a guest /tmp alias)", () => {
    const policy = policyFor();
    assert.equal(policy.tmpRoot(), resolve(tmp));
    assert.notEqual(policy.tmpRoot(), "/tmp");
  });
});
