/**
 * T2 (plans/worktree-session-roots.md) — 会话三根 SSOT 合同单测。
 *
 * 验收:
 *  1. 同一次输入可问出 `productRoot` / `taskRoot` / `installRoot`,三根按角色
 *     独立规范化;`taskRoot` 改绑到 task worktree 时 `productRoot` 不漂移。
 *  2. 缺根 / 空白 / 相对 / 无法规范化 / 与既有根不一致的输入,在任何文件读取
 *     或工具执行前以 `SessionRootError` typed kind fail-closed,**绝不**回退
 *     `process.cwd()`(与既有 MCP roots 同纪律)。
 *  3. `resolveSessionRoots` 是纯函数:不读 git、不读文件系统、不持会话状态。
 *  4. MCP 降为消费者:`mcpConfigRoot` 仍等于 `productRoot`,`workspaceRoot` 仍
 *     等于 `taskRoot`,旧调用方行为不变(ADR-0037 §4 / #828 保持)。
 */
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  SessionRootError,
  type SessionRootErrorKind,
} from "../../src/harness/errors.ts";
import {
  resolveInstallRoot,
  resolveSessionRoots,
} from "../../src/harness/session-roots.ts";
import { resolveMcpRoots } from "../../src/harness/mcp/roots.ts";

const PRODUCT_ROOT = "/repo/iknow";
const TASK_WORKTREE = "/repo/iknow/.iknow/worktrees/conv-1";
const INSTALL_ROOT = "/opt/iknow";

const ROOTS = {
  productRoot: PRODUCT_ROOT,
  taskRoot: PRODUCT_ROOT,
  installRoot: INSTALL_ROOT,
  projectIdentityRoot: PRODUCT_ROOT,
} as const;

/** 断言调用抛出指定 kind 的 typed error,并返回它以便继续断言细节。 */
function expectRootError(
  call: () => unknown,
  kind: SessionRootErrorKind
): SessionRootError {
  let caught: unknown;
  try {
    call();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(SessionRootError);
  const error = caught as SessionRootError;
  expect(error.kind).toBe(kind);
  expect(error.message.trim()).not.toBe("");
  expect(error.detail.trim()).not.toBe("");
  return error;
}

describe("resolveSessionRoots — root role contract", () => {
  it("answers every root from one input", () => {
    expect(resolveSessionRoots(ROOTS)).toEqual({
      productRoot: PRODUCT_ROOT,
      taskRoot: PRODUCT_ROOT,
      installRoot: INSTALL_ROOT,
      projectIdentityRoot: PRODUCT_ROOT,
    });
  });

  it("normalizes trailing separators and redundant segments per root", () => {
    expect(
      resolveSessionRoots({
        productRoot: "/repo//iknow/",
        taskRoot: "/repo/iknow/./sub/../",
        installRoot: "/opt/iknow/.",
        projectIdentityRoot: "/repo/iknow//",
      })
    ).toEqual({
      productRoot: PRODUCT_ROOT,
      taskRoot: PRODUCT_ROOT,
      installRoot: INSTALL_ROOT,
      projectIdentityRoot: PRODUCT_ROOT,
    });
  });

  it("keeps the filesystem root as-is when it is the whole path", () => {
    expect(
      resolveSessionRoots({
        productRoot: "/",
        taskRoot: "/",
        installRoot: "/",
        projectIdentityRoot: "/",
      })
    ).toEqual({
      productRoot: "/",
      taskRoot: "/",
      installRoot: "/",
      projectIdentityRoot: "/",
    });
  });

  it("moves taskRoot on rebind while the other roots hold still", () => {
    const beforeRebind = resolveSessionRoots(ROOTS);
    const afterRebind = resolveSessionRoots({
      ...ROOTS,
      taskRoot: TASK_WORKTREE,
    });

    expect(afterRebind.taskRoot).toBe(TASK_WORKTREE);
    expect(afterRebind.productRoot).toBe(beforeRebind.productRoot);
    expect(afterRebind.projectIdentityRoot).toBe(
      beforeRebind.projectIdentityRoot
    );
    expect(afterRebind.installRoot).toBe(beforeRebind.installRoot);
  });

  it("is idempotent: feeding the result back yields the same roots", () => {
    const first = resolveSessionRoots({
      productRoot: `${PRODUCT_ROOT}/`,
      taskRoot: `${TASK_WORKTREE}/`,
      installRoot: `${INSTALL_ROOT}/`,
      projectIdentityRoot: `${PRODUCT_ROOT}/`,
    });

    expect(resolveSessionRoots(first)).toEqual(first);
  });

  it("normalizes trailing separators and `.` segments away", () => {
    expect(
      resolveSessionRoots({ ...ROOTS, taskRoot: `${TASK_WORKTREE}/./` })
    ).toEqual({
      productRoot: PRODUCT_ROOT,
      taskRoot: TASK_WORKTREE,
      installRoot: INSTALL_ROOT,
      projectIdentityRoot: PRODUCT_ROOT,
    });
  });
});

describe("resolveSessionRoots — fail-closed inputs", () => {
  it.each([
    "productRoot",
    "taskRoot",
    "installRoot",
    "projectIdentityRoot",
  ] as const)(
    "rejects a missing %s with missing_root naming the role",
    (role) => {
      const error = expectRootError(
        () => resolveSessionRoots({ ...ROOTS, [role]: undefined }),
        "missing_root"
      );
      expect(error.detail).toContain(role);
    }
  );

  it("rejects a non-string root with missing_root", () => {
    expectRootError(
      () =>
        resolveSessionRoots({
          ...ROOTS,
          taskRoot: 42 as unknown as string,
        }),
      "missing_root"
    );
  });

  it.each([
    "productRoot",
    "taskRoot",
    "installRoot",
    "projectIdentityRoot",
  ] as const)(
    "rejects a blank / relative / unnormalizable %s with invalid_root",
    (role) => {
      for (const bad of [
        "",
        "   ",
        "\t\n",
        "relative/dir",
        "./here",
        "../up",
        "~/iknow",
        "/repo/ik\u0000now",
      ]) {
        const error = expectRootError(
          () => resolveSessionRoots({ ...ROOTS, [role]: bad }),
          "invalid_root"
        );
        expect(error.detail).toContain(role);
      }
    }
  );

  it("never falls back to process.cwd() when a root is missing or invalid", () => {
    const cwdSpy = vi.spyOn(process, "cwd");

    expectRootError(
      () =>
        resolveSessionRoots({
          productRoot: undefined,
          taskRoot: undefined,
          installRoot: undefined,
          projectIdentityRoot: undefined,
        }),
      "missing_root"
    );
    expectRootError(
      () => resolveSessionRoots({ ...ROOTS, productRoot: "" }),
      "invalid_root"
    );
    expectRootError(
      () => resolveSessionRoots({ ...ROOTS, taskRoot: "" }),
      "invalid_root"
    );

    expect(cwdSpy).not.toHaveBeenCalled();
    cwdSpy.mockRestore();
  });

  it("keeps diagnostics bounded and secret-free for overlong roots", () => {
    const overlong = `repo/${"a".repeat(8000)}/ANTHROPIC_API_KEY=super-secret`;

    const error = expectRootError(
      () => resolveSessionRoots({ ...ROOTS, taskRoot: overlong }),
      "invalid_root"
    );

    expect(error.detail.length).toBeLessThanOrEqual(256);
    expect(error.message.length).toBeLessThanOrEqual(320);
    expect(error.detail).not.toContain("super-secret");
  });
});

describe("resolveSessionRoots — purity", () => {
  it("resolves roots that do not exist on disk and holds no session state", () => {
    const ghost = "/definitely/not/on/disk/iknow";

    const first = resolveSessionRoots({
      productRoot: ghost,
      taskRoot: ghost,
      installRoot: ghost,
      projectIdentityRoot: ghost,
    });
    resolveSessionRoots({ ...ROOTS, taskRoot: TASK_WORKTREE });
    const third = resolveSessionRoots({
      productRoot: ghost,
      taskRoot: ghost,
      installRoot: ghost,
      projectIdentityRoot: ghost,
    });

    expect(third).toEqual(first);
  });
});

describe("MCP is a consumer of the session roots", () => {
  it("maps the same roles byte-for-byte: mcpConfigRoot = productRoot, workspaceRoot = taskRoot", () => {
    const roots = resolveSessionRoots({ ...ROOTS, taskRoot: TASK_WORKTREE });

    expect(
      resolveMcpRoots({
        workspaceRoot: TASK_WORKTREE,
        productRoot: PRODUCT_ROOT,
      })
    ).toEqual({
      workspaceRoot: roots.taskRoot,
      mcpConfigRoot: roots.productRoot,
    });
  });
});

describe("resolveInstallRoot", () => {
  it("resolves the iknow install location, not the process cwd", () => {
    const installRoot = resolveInstallRoot();

    expect(isAbsolute(installRoot)).toBe(true);
    expect(existsSync(join(installRoot, "package.json"))).toBe(true);
  });

  it("is stable across calls and independent of process.cwd()", () => {
    const first = resolveInstallRoot();
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue("/nowhere");

    expect(resolveInstallRoot()).toBe(first);

    cwdSpy.mockRestore();
  });
});
