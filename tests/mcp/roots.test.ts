/**
 * T2 (plans/worktree-mcp-rebind-lifecycle.md) — `resolveMcpRoots` 双根合同单测。
 *
 * 验收:
 *  1. 一次纯解析产生规范化的 `{ workspaceRoot, mcpConfigRoot }`;
 *     `mcpConfigRoot` 只由 `productRoot` 派生,rebind 后不随 task worktree 漂移。
 *  2. 缺根 / 空白 / 相对 / 无法规范化 / 与既有根不一致的输入,在任何文件读取、
 *     spawn 或工具执行前以 T1 的 `McpLifecycleError` typed kind fail-closed,
 *     绝不回退 `process.cwd()`。
 *  3. resolver 是纯函数:不读 git、不读文件系统、不持会话状态。
 */
import { describe, expect, it, vi } from "vitest";

import {
  McpLifecycleError,
  type McpLifecycleErrorKind,
} from "../../src/harness/errors.ts";
import { resolveMcpRoots } from "../../src/harness/mcp/roots.ts";

const PRODUCT_ROOT = "/repo/iknow";
const TASK_WORKTREE = "/repo/iknow/.iknow/worktrees/conv-1";

/** 断言调用抛出指定 kind 的 typed error,并返回它以便继续断言细节。 */
function expectLifecycleError(
  call: () => unknown,
  kind: McpLifecycleErrorKind
): McpLifecycleError {
  let caught: unknown;
  try {
    call();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(McpLifecycleError);
  const error = caught as McpLifecycleError;
  expect(error.kind).toBe(kind);
  expect(error.message.trim()).not.toBe("");
  expect(error.detail.trim()).not.toBe("");
  return error;
}

describe("resolveMcpRoots — dual-root contract", () => {
  it("returns both roots for absolute inputs", () => {
    expect(
      resolveMcpRoots({
        workspaceRoot: PRODUCT_ROOT,
        productRoot: PRODUCT_ROOT,
      })
    ).toEqual({
      workspaceRoot: PRODUCT_ROOT,
      mcpConfigRoot: PRODUCT_ROOT,
    });
  });

  it("normalizes trailing separators and redundant segments", () => {
    expect(
      resolveMcpRoots({
        workspaceRoot: "/repo/iknow/./sub/../",
        productRoot: "/repo//iknow/",
      })
    ).toEqual({
      workspaceRoot: PRODUCT_ROOT,
      mcpConfigRoot: PRODUCT_ROOT,
    });
  });

  it("keeps the filesystem root as-is when it is the whole path", () => {
    expect(resolveMcpRoots({ workspaceRoot: "/", productRoot: "/" })).toEqual({
      workspaceRoot: "/",
      mcpConfigRoot: "/",
    });
  });

  it("derives mcpConfigRoot from productRoot only, never from the task worktree", () => {
    const beforeRebind = resolveMcpRoots({
      workspaceRoot: PRODUCT_ROOT,
      productRoot: PRODUCT_ROOT,
    });
    const afterRebind = resolveMcpRoots({
      workspaceRoot: TASK_WORKTREE,
      productRoot: PRODUCT_ROOT,
    });

    expect(afterRebind.workspaceRoot).toBe(TASK_WORKTREE);
    expect(afterRebind.mcpConfigRoot).toBe(beforeRebind.mcpConfigRoot);
    expect(afterRebind.mcpConfigRoot).toBe(PRODUCT_ROOT);
  });

  it("is idempotent: feeding the result back yields the same roots", () => {
    const first = resolveMcpRoots({
      workspaceRoot: `${TASK_WORKTREE}/`,
      productRoot: `${PRODUCT_ROOT}/`,
    });
    const second = resolveMcpRoots({
      workspaceRoot: first.workspaceRoot,
      productRoot: first.mcpConfigRoot,
    });

    expect(second).toEqual(first);
  });
});

describe("resolveMcpRoots — fail-closed inputs", () => {
  it("rejects a missing workspaceRoot with missing_cwd", () => {
    expectLifecycleError(
      () =>
        resolveMcpRoots({
          workspaceRoot: undefined,
          productRoot: PRODUCT_ROOT,
        }),
      "missing_cwd"
    );
  });

  it("rejects a missing productRoot with missing_cwd", () => {
    expectLifecycleError(
      () =>
        resolveMcpRoots({
          workspaceRoot: PRODUCT_ROOT,
          productRoot: undefined,
        }),
      "missing_cwd"
    );
  });

  it.each(["", "   ", "\t\n"])(
    "rejects a blank workspaceRoot (%j) with invalid_cwd",
    (blank: string) => {
      expectLifecycleError(
        () =>
          resolveMcpRoots({
            workspaceRoot: blank,
            productRoot: PRODUCT_ROOT,
          }),
        "invalid_cwd"
      );
    }
  );

  it.each(["relative/dir", "./here", "../up", "~/iknow"])(
    "rejects a non-absolute workspaceRoot (%j) with invalid_cwd",
    (relative: string) => {
      expectLifecycleError(
        () =>
          resolveMcpRoots({
            workspaceRoot: relative,
            productRoot: PRODUCT_ROOT,
          }),
        "invalid_cwd"
      );
    }
  );

  it("rejects an unnormalizable workspaceRoot with invalid_cwd", () => {
    expectLifecycleError(
      () =>
        resolveMcpRoots({
          workspaceRoot: "/repo/ik\u0000now",
          productRoot: PRODUCT_ROOT,
        }),
      "invalid_cwd"
    );
  });

  it.each(["", "  ", "relative/dir", "./here", "/repo/ik\u0000now"])(
    "rejects a blank / non-absolute / unnormalizable productRoot (%j) with invalid_config_root",
    (bad: string) => {
      expectLifecycleError(
        () =>
          resolveMcpRoots({
            workspaceRoot: PRODUCT_ROOT,
            productRoot: bad,
          }),
        "invalid_config_root"
      );
    }
  );

  it("rejects non-string roots with missing_cwd", () => {
    expectLifecycleError(
      () =>
        resolveMcpRoots({
          workspaceRoot: 42 as unknown as string,
          productRoot: PRODUCT_ROOT,
        }),
      "missing_cwd"
    );
  });

  it("never falls back to process.cwd() when a root is missing or invalid", () => {
    const cwdSpy = vi.spyOn(process, "cwd");

    expectLifecycleError(
      () =>
        resolveMcpRoots({ workspaceRoot: undefined, productRoot: undefined }),
      "missing_cwd"
    );
    expectLifecycleError(
      () => resolveMcpRoots({ workspaceRoot: "", productRoot: PRODUCT_ROOT }),
      "invalid_cwd"
    );
    expectLifecycleError(
      () => resolveMcpRoots({ workspaceRoot: PRODUCT_ROOT, productRoot: "" }),
      "invalid_config_root"
    );

    expect(cwdSpy).not.toHaveBeenCalled();
    cwdSpy.mockRestore();
  });

  it("keeps diagnostics bounded and secret-free for overlong roots", () => {
    const overlong = `/repo/${"a".repeat(8000)}/ANTHROPIC_API_KEY=super-secret`;

    const error = expectLifecycleError(
      () =>
        resolveMcpRoots({
          workspaceRoot: overlong.slice(1),
          productRoot: PRODUCT_ROOT,
        }),
      "invalid_cwd"
    );

    expect(error.detail.length).toBeLessThanOrEqual(256);
    expect(error.message.length).toBeLessThanOrEqual(320);
    expect(error.detail).not.toContain("super-secret");
  });
});

describe("resolveMcpRoots — root mismatch", () => {
  it("accepts an expected workspace root that only differs by normalization", () => {
    expect(
      resolveMcpRoots({
        workspaceRoot: TASK_WORKTREE,
        productRoot: PRODUCT_ROOT,
        expectedWorkspaceRoot: `${TASK_WORKTREE}/./`,
      })
    ).toEqual({
      workspaceRoot: TASK_WORKTREE,
      mcpConfigRoot: PRODUCT_ROOT,
    });
  });

  it("rejects a foreign expected workspace root with root_mismatch", () => {
    expectLifecycleError(
      () =>
        resolveMcpRoots({
          workspaceRoot: TASK_WORKTREE,
          productRoot: PRODUCT_ROOT,
          expectedWorkspaceRoot: "/other/checkout",
        }),
      "root_mismatch"
    );
  });

  it("rejects an invalid expected workspace root before comparing", () => {
    expectLifecycleError(
      () =>
        resolveMcpRoots({
          workspaceRoot: TASK_WORKTREE,
          productRoot: PRODUCT_ROOT,
          expectedWorkspaceRoot: "relative/sandbox",
        }),
      "invalid_cwd"
    );
  });
});

describe("resolveMcpRoots — purity", () => {
  it("resolves roots that do not exist on disk and holds no session state", () => {
    const ghost = "/definitely/not/on/disk/iknow";

    const first = resolveMcpRoots({
      workspaceRoot: ghost,
      productRoot: ghost,
    });
    const second = resolveMcpRoots({
      workspaceRoot: TASK_WORKTREE,
      productRoot: PRODUCT_ROOT,
    });
    const third = resolveMcpRoots({
      workspaceRoot: ghost,
      productRoot: ghost,
    });

    expect(first).toEqual({ workspaceRoot: ghost, mcpConfigRoot: ghost });
    expect(third).toEqual(first);
    expect(second.mcpConfigRoot).toBe(PRODUCT_ROOT);
  });
});
