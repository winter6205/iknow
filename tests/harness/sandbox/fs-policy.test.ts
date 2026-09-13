import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  OPTIONAL_HOST_RO_PREFIXES,
  READ_ONLY_SYSTEM_PATHS,
  SENSITIVE_PATHS,
  createFsPolicy,
} from "../../../src/harness/sandbox/fs-policy.js";
import { ToolExecutionError } from "../../../src/harness/errors.js";

/**
 * ADR-0092 全局档 fs-policy 合同。
 *
 * 闭世界(读/写白名单 + assertWithin)退役,policy 只剩两个面:
 *   - `tmpRoot()`:本 identity 的会话 tmp 宿主路径(供 `$TMPDIR` 与写工具
 *     可写根用),不是 guest `/tmp` 的 bind 目标;
 *   - `isSensitive()`:状态锚谓词(`~/.ssh` 等 + `<home>/.iknow` /
 *     `<workspaceRoot>/.iknow`),保留给 Round 2 工作区档,不塑形 argv。
 *
 * home 与 workspaceRoot 都只是状态锚,不再是 bind root。合同输入只有
 * `tmpDir`(空白或盘上缺席 → typed fail-loud,不 spawn)。
 */
function isWithin(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return (
    rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep))
  );
}

describe("createFsPolicy — 全局档状态锚 (ADR-0092)", () => {
  let fixtureRoot: string;
  let taskRoot: string;
  let tmp: string;

  beforeAll(() => {
    fixtureRoot = mkdtempSync(join(tmpdir(), "fs-policy-global-"));
    taskRoot = join(fixtureRoot, "task");
    mkdirSync(taskRoot, { recursive: true });
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
      home: "/home/user",
      tmpDir: tmp,
      ...extra,
    });
  }

  it("exposes only tmpRoot/isSensitive — the closed-world root axes and assertWithin are gone", () => {
    const policy = policyFor();
    assert.equal(policy.tmpRoot(), resolve(tmp));
    assert.equal(typeof policy.isSensitive, "function");
    // 角色取根访问器与 assertWithin 随闭世界退役;残留即回归。
    const surface = policy as unknown as Record<string, unknown>;
    for (const retired of [
      "writeRoots",
      "readRoots",
      "optionalReadRoots",
      "assertWithin",
    ]) {
      assert.equal(
        retired in surface,
        false,
        `retired closed-world accessor must not survive: ${retired}`
      );
    }
  });

  it("isSensitive expands the tilde sensitive set under the given home", () => {
    const policy = policyFor();
    assert.equal(policy.isSensitive("/home/user/.ssh/id_ed25519"), true);
    assert.equal(policy.isSensitive("/home/user/.aws/config"), true);
    assert.equal(policy.isSensitive("/home/user/.docker/config.json"), true);
    // 兄弟路径不误伤。
    assert.equal(policy.isSensitive("/home/user/Documents/notes.txt"), false);
  });

  it("isSensitive covers both protected-state anchors (<home>/.iknow, <workspaceRoot>/.iknow)", () => {
    const policy = policyFor({ workspaceRoot: taskRoot });
    assert.equal(policy.isSensitive("/home/user/.iknow/state.json"), true);
    assert.equal(
      policy.isSensitive(`${taskRoot}/.iknow/state.json`),
      true,
      "workspaceRoot stays a protected-state anchor"
    );
    assert.equal(policy.isSensitive(join(taskRoot, "AGENTS.md")), false);
    // workspaceRoot 只做状态锚:workspaceRoot 自身不是敏感路径。
    assert.equal(policy.isSensitive(taskRoot), false);
  });

  it("workspaceRoot is not required — omitting it keeps only the home anchor", () => {
    const policy = policyFor();
    assert.equal(policy.isSensitive("/home/user/.iknow/state.json"), true);
    assert.equal(policy.isSensitive(`${taskRoot}/.iknow/state.json`), false);
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

  it("keeps the frozen host-prefix sources single-source (system + optional + sensitive)", () => {
    assert.ok(Object.isFrozen(SENSITIVE_PATHS));
    assert.ok(Object.isFrozen(READ_ONLY_SYSTEM_PATHS));
    assert.ok(Object.isFrozen(OPTIONAL_HOST_RO_PREFIXES));
    assert.deepEqual(
      [...READ_ONLY_SYSTEM_PATHS],
      ["/usr", "/bin", "/lib", "/lib64", "/etc"]
    );
    assert.deepEqual([...OPTIONAL_HOST_RO_PREFIXES], ["/opt", "/snap"]);
    assert.equal(
      SENSITIVE_PATHS.some((p) => p.startsWith("~/.ssh")),
      true
    );
    assert.equal(
      SENSITIVE_PATHS.some((p) => isWithin("/home/user", "/home/user/.ssh")),
      true
    );
  });
});
