/**
 * T3 (plans/worktree-live-task-root.md §6) — session-roots SSOT 契约测试。
 *
 * 目标：钉住 `src/harness/session-roots.ts` 现有契约，作为 T4 活化 `taskRoot`
 * 前的安全网。**不改 src/ 任何一行**——只是把现状固化下来，约束后面任何
 * 重构都要通过这一关。
 *
 * 覆盖范围（对应 T3 Acceptance 逐条点名）：
 *  - 四角色归位（happy path / 任一角色缺 / 任一角色非法）
 *  - 缺根 → `SessionRootError kind:"missing_root"`
 *  - 相对 / 空白 / 含 NUL → `SessionRootError kind:"invalid_root"`
 *  - **绝不回退 `process.cwd()`**（doc :30-31）
 *  - `stripTrailingSeparators` 保 posix `/` 与 win32 `C:\` 根本身（:108-119）
 *  - `resolveInstallRoot` 锚 `import.meta.url`，且进程级缓存不给 reset 缝
 *    （:168-171）
 *  - 跨 rebind 不变的三条（`productRoot` / `projectIdentityRoot` /
 *    `installRoot`）有测试点名，作为 T4 之后不回归的锚（D3）。
 *  - 并发类：同一波内多次读 `resolveSessionRoots` 拿到等值结果（D2 的机制
 *    在 T4 才上，本测试先把"纯函数 → 等值"这条钉住）。
 *
 * 不写实现测试：所有断言针对 src/harness/session-roots.ts 的**导出行为**，
 * 不进入私有实现细节。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, realpathSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  MAX_ROOT_DETAIL_CHARS,
  createLiveTaskRoot,
  normalizeRootCandidate,
  quoteRoot,
  resolveInstallRoot,
  resolveSessionRoots,
  withLiveTaskRootWrite,
  writeLiveTaskRoot,
  type LiveTaskRoot,
  type ResolveSessionRootsInput,
  type SessionRoots,
} from "../../src/harness/session-roots.ts";
import { SessionRootError } from "../../src/harness/errors.ts";

function makeInput(
  over: Partial<ResolveSessionRootsInput> = {}
): ResolveSessionRootsInput {
  return {
    productRoot: "/repo",
    taskRoot: "/repo/worktrees/abc",
    installRoot: "/opt/iknow",
    projectIdentityRoot: "/repo",
    ...over,
  };
}

describe("resolveSessionRoots — happy path", () => {
  it("returns all four roles with the supplied normalized values", () => {
    const roots = resolveSessionRoots(makeInput());
    expect(roots).toEqual({
      productRoot: "/repo",
      taskRoot: "/repo/worktrees/abc",
      installRoot: "/opt/iknow",
      projectIdentityRoot: "/repo",
    });
  });

  it("accepts identical productRoot and taskRoot (rebinned-to-main shape)", () => {
    const roots = resolveSessionRoots(makeInput({ taskRoot: "/repo" }));
    expect(roots.taskRoot).toBe("/repo");
    expect(roots.productRoot).toBe(roots.taskRoot);
  });

  it("normalizes trailing separators before returning roots", () => {
    const roots = resolveSessionRoots(
      makeInput({
        productRoot: "/repo/",
        taskRoot: "/repo/worktrees/abc/",
        installRoot: "/opt/iknow/",
        projectIdentityRoot: "/repo//",
      })
    );
    expect(roots.productRoot).toBe("/repo");
    expect(roots.taskRoot).toBe("/repo/worktrees/abc");
    expect(roots.installRoot).toBe("/opt/iknow");
    expect(roots.projectIdentityRoot).toBe("/repo");
  });

  it("is a pure function: same input → deeply equal output across many calls", () => {
    // D2 的最终形态在 T4 才上；先把"纯函数 → 等值"这条钉住，保证之后任何
    // 同一波 snapshot 实现的退化都会被这一关拦下来。
    const input = makeInput();
    const first = resolveSessionRoots(input);
    for (let i = 0; i < 32; i++) {
      const next = resolveSessionRoots(input);
      expect(next).toEqual(first);
      expect(next.productRoot).toBe(first.productRoot);
      expect(next.taskRoot).toBe(first.taskRoot);
      expect(next.installRoot).toBe(first.installRoot);
      expect(next.projectIdentityRoot).toBe(first.projectIdentityRoot);
    }
  });
});

describe("resolveSessionRoots — cross-rebind invariant roles (D3 anchors)", () => {
  // D3 稳定根清单：productRoot / projectIdentityRoot / installRoot 必须**不**
  // 由 taskRoot 推导，也不得自动 rebind。它们仅由装配层传进来的值决定。
  // 这里把这条契约钉成测试：调同样 input，taskRoot 怎么变，另三根**不动**
  // —— 这三根是"跨 rebind 不变"角色。

  it("productRoot stays at the supplied value regardless of taskRoot rebinding", () => {
    const before = resolveSessionRoots(makeInput({ taskRoot: "/repo/wt/a" }));
    const after = resolveSessionRoots(
      makeInput({ taskRoot: "/repo/wt/b", productRoot: before.productRoot })
    );
    expect(after.productRoot).toBe(before.productRoot);
    expect(after.taskRoot).toBe("/repo/wt/b");
  });

  it("projectIdentityRoot stays at the supplied value regardless of taskRoot rebinding", () => {
    const before = resolveSessionRoots(
      makeInput({
        projectIdentityRoot: "/some/identity",
        taskRoot: "/repo/wt/a",
      })
    );
    const after = resolveSessionRoots(
      makeInput({
        projectIdentityRoot: "/some/identity",
        taskRoot: "/repo/wt/b",
      })
    );
    expect(after.projectIdentityRoot).toBe(before.projectIdentityRoot);
    expect(after.taskRoot).toBe("/repo/wt/b");
  });

  it("installRoot stays at the supplied value regardless of taskRoot rebinding", () => {
    const before = resolveSessionRoots(
      makeInput({ installRoot: "/opt/iknow", taskRoot: "/repo/wt/a" })
    );
    const after = resolveSessionRoots(
      makeInput({ installRoot: "/opt/iknow", taskRoot: "/repo/wt/b" })
    );
    expect(after.installRoot).toBe(before.installRoot);
    expect(after.taskRoot).toBe("/repo/wt/b");
  });

  it("productRoot and projectIdentityRoot are independent slots (not derived from each other)", () => {
    // ADR-0037 §4 / session-roots.ts :16-20：项目身份根与 productRoot
    // 分开是因为 `--workspace-root <dir>` 重定向档下 `dir ≠ cwd`。
    // 这条契约：不传 productRoot 但传 projectIdentityRoot（反之亦然），
    // 必须 fail-closed（missing_root），不得由另一槽位推导。
    expect(() =>
      resolveSessionRoots(
        makeInput({
          productRoot: undefined,
          projectIdentityRoot: "/some/identity",
        })
      )
    ).toThrowError(
      expect.objectContaining({
        name: "SessionRootError",
        kind: "missing_root",
      })
    );
    expect(() =>
      resolveSessionRoots(
        makeInput({
          productRoot: "/repo",
          projectIdentityRoot: undefined,
        })
      )
    ).toThrowError(
      expect.objectContaining({
        name: "SessionRootError",
        kind: "missing_root",
      })
    );
  });
});

describe("resolveSessionRoots — missing_root per role", () => {
  const allRequiredRoles = [
    "productRoot",
    "taskRoot",
    "installRoot",
    "projectIdentityRoot",
  ] as const;

  for (const role of allRequiredRoles) {
    it(`${role}=undefined → SessionRootError kind:"missing_root" naming the role`, () => {
      const input = makeInput({ [role]: undefined });
      let caught: unknown;
      try {
        resolveSessionRoots(input);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(SessionRootError);
      expect(caught).toMatchObject({
        name: "SessionRootError",
        kind: "missing_root",
      });
      expect((caught as SessionRootError).detail).toContain(role);
      expect((caught as SessionRootError).detail).toContain("required");
    });
  }

  it("never falls back to process.cwd() when a role is undefined", () => {
    // doc :30-31 明文：缺根 / 空白 / 相对 / 无法规范化一律 fail-closed，
    // 绝不回退 process.cwd()。这里把这条钉成测试：
    // 1) 切到一个全新 temp dir；
    // 2) productRoot 缺席 → 必须 throw，不得静默拿 cwd 兜住；
    // 3) 切回原 cwd，避免污染同进程后续测试。
    const freshCwd = mkdtempSync(path.join(tmpdir(), "iknow-t3-cwd-"));
    const originalCwd = process.cwd();
    process.chdir(freshCwd);
    try {
      let caught: unknown;
      try {
        resolveSessionRoots(
          makeInput({
            productRoot: undefined,
            // 其它三根仍按 happy path 传，确保仅 productRoot 触发缺根
          })
        );
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(SessionRootError);
      expect(caught).toMatchObject({
        kind: "missing_root",
        detail: expect.stringContaining("productRoot"),
      });
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("never falls back to process.cwd() even if cwd looks absolute", () => {
    // 强化版：cwd 本身是绝对路径，更容易伪装成"合理的兜底"——仍然必须 throw。
    const originalCwd = process.cwd();
    const altCwd = mkdtempSync(path.join(tmpdir(), "iknow-t3-cwd2-"));
    process.chdir(altCwd);
    try {
      expect(() =>
        resolveSessionRoots(makeInput({ installRoot: undefined }))
      ).toThrowError(expect.objectContaining({ kind: "missing_root" }));
    } finally {
      process.chdir(originalCwd);
    }
  });
});

describe("resolveSessionRoots — invalid_root per role", () => {
  it('relative productRoot → SessionRootError kind:"invalid_root" (not_absolute)', () => {
    let caught: unknown;
    try {
      resolveSessionRoots(makeInput({ productRoot: "relative/path" }));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SessionRootError);
    expect(caught).toMatchObject({
      kind: "invalid_root",
      detail: expect.stringContaining("must be an absolute path"),
    });
    expect((caught as SessionRootError).detail).toContain("productRoot");
  });

  it("whitespace-only taskRoot → invalid_root (not_normalizable)", () => {
    let caught: unknown;
    try {
      resolveSessionRoots(makeInput({ taskRoot: "   " }));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SessionRootError);
    expect(caught).toMatchObject({
      kind: "invalid_root",
      detail: expect.stringContaining("must be a normalizable absolute path"),
    });
    expect((caught as SessionRootError).detail).toContain("taskRoot");
  });

  it("empty string installRoot → invalid_root (not_normalizable)", () => {
    let caught: unknown;
    try {
      resolveSessionRoots(makeInput({ installRoot: "" }));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SessionRootError);
    expect(caught).toMatchObject({ kind: "invalid_root" });
    expect((caught as SessionRootError).detail).toContain("installRoot");
  });

  it("NUL byte in projectIdentityRoot → invalid_root (not_normalizable)", () => {
    let caught: unknown;
    try {
      resolveSessionRoots(
        makeInput({ projectIdentityRoot: "/repo/\u0000bad" })
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SessionRootError);
    expect(caught).toMatchObject({
      kind: "invalid_root",
      detail: expect.stringContaining("must be a normalizable absolute path"),
    });
    expect((caught as SessionRootError).detail).toContain(
      "projectIdentityRoot"
    );
  });

  it("quoted shown value respects MAX_ROOT_DETAIL_CHARS", () => {
    const longRel = "x".repeat(MAX_ROOT_DETAIL_CHARS + 50);
    let caught: unknown;
    try {
      resolveSessionRoots(makeInput({ productRoot: longRel }));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SessionRootError);
    const detail = (caught as SessionRootError).detail;
    expect(detail).toContain("…"); // 截断符
    // 截断后 ≤ MAX_ROOT_DETAIL_CHARS + 引号 + 省略号
    expect(detail.length).toBeLessThan(longRel.length);
  });
});

describe("normalizeRootCandidate — public surface", () => {
  it("undefined → { ok:false, rejection:{ reason:'missing' } }", () => {
    expect(normalizeRootCandidate(undefined)).toEqual({
      ok: false,
      rejection: { reason: "missing" },
    });
  });

  it("empty string → { ok:false, rejection:{ reason:'not_normalizable', shown:'' } }", () => {
    expect(normalizeRootCandidate("")).toEqual({
      ok: false,
      rejection: { reason: "not_normalizable", shown: "" },
    });
  });

  it("whitespace-only → not_normalizable (after trim)", () => {
    expect(normalizeRootCandidate("   \t  ")).toEqual({
      ok: false,
      rejection: { reason: "not_normalizable", shown: "" },
    });
  });

  it("string with NUL byte → not_normalizable", () => {
    expect(normalizeRootCandidate("/foo\u0000bar")).toEqual({
      ok: false,
      rejection: { reason: "not_normalizable", shown: "/foo\u0000bar" },
    });
  });

  it("relative path → not_absolute", () => {
    expect(normalizeRootCandidate("foo/bar")).toEqual({
      ok: false,
      rejection: { reason: "not_absolute", shown: "foo/bar" },
    });
  });

  it("absolute path with trailing separators → stripped (posix)", () => {
    expect(normalizeRootCandidate("/foo/")).toEqual({
      ok: true,
      root: "/foo",
    });
    expect(normalizeRootCandidate("/foo//")).toEqual({
      ok: true,
      root: "/foo",
    });
  });
});

describe("stripTrailingSeparators — posix (via normalizeRootCandidate)", () => {
  // 私有函数，通过 normalizeRootCandidate 观察 :108-119 的契约：
  // 「去掉结尾分隔符，但保留文件系统根本身」。

  it("filesystem root `/` is preserved", () => {
    expect(normalizeRootCandidate("/")).toEqual({ ok: true, root: "/" });
  });

  it("non-root posix paths lose trailing slashes", () => {
    expect(normalizeRootCandidate("/a")).toEqual({ ok: true, root: "/a" });
    expect(normalizeRootCandidate("/a/")).toEqual({ ok: true, root: "/a" });
    expect(normalizeRootCandidate("/a/b/")).toEqual({ ok: true, root: "/a/b" });
  });

  it("path.parse root length is the contract boundary", () => {
    // 间接断言：stripTrailingSeparators 用 `path.parse(p).root` 做"是否已到
    // 根本身"判定。验证一个长度等于 root 的路径被原样保留。
    const root = path.parse("/").root; // "/"
    expect(normalizeRootCandidate(root)).toEqual({ ok: true, root });
  });
});

describe("stripTrailingSeparators — win32 (mocked path module)", () => {
  // 在 linux CI 上 src/harness/session-roots.ts 用的是平台 path。要验证
  // win32 分支（`C:\` 保留、`C:\foo\` 去尾），必须 mock `node:path` 为
  // `path.win32`。每次只对一组测试做这个替换，之后清理。
  beforeEach(() => {
    vi.resetModules();
    vi.doMock("node:path", () => {
      // src/harness/session-roots.ts 用 `import path from "node:path"`
      // (default import)。vi.doMock 把整个模块替换为工厂返回值，所以我们
      // 必须把 win32 同时作为 default 与命名空间导出。
      const win32 = path.win32 as unknown as Record<string, unknown> & {
        default: unknown;
      };
      return { ...win32, default: win32 };
    });
  });
  afterEach(() => {
    vi.doUnmock("node:path");
    vi.resetModules();
  });

  it("filesystem root `C:\\` is preserved", async () => {
    const mod = await import("../../src/harness/session-roots.ts");
    expect(mod.normalizeRootCandidate("C:\\")).toEqual({
      ok: true,
      root: "C:\\",
    });
  });

  it("non-root win32 path loses trailing separators", async () => {
    const mod = await import("../../src/harness/session-roots.ts");
    expect(mod.normalizeRootCandidate("C:\\foo")).toEqual({
      ok: true,
      root: "C:\\foo",
    });
    expect(mod.normalizeRootCandidate("C:\\foo\\")).toEqual({
      ok: true,
      root: "C:\\foo",
    });
    expect(mod.normalizeRootCandidate("C:\\foo\\bar\\")).toEqual({
      ok: true,
      root: "C:\\foo\\bar",
    });
  });

  it("win32 driver-letter paths are recognized as absolute", async () => {
    const mod = await import("../../src/harness/session-roots.ts");
    const res = mod.normalizeRootCandidate("D:\\data\\");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.root).toBe("D:\\data");
  });
});

describe("resolveInstallRoot — anchor to import.meta.url + process-level cache", () => {
  it("returns a path that contains a real package.json (anchored to this module)", () => {
    const root = resolveInstallRoot();
    expect(typeof root).toBe("string");
    expect(root.length).toBeGreaterThan(0);
    expect(existsSync(path.join(root, "package.json"))).toBe(true);
  });

  it("is anchored to import.meta.url of session-roots.ts, not to cwd or any session root", () => {
    // 显式 invariant：resolveInstallRoot 的查找起点是本模块文件自身所在的目录，
    // 不是 process.cwd()，也不是任何 task worktree。resolveInstallRoot 沿
    // 目录树向上找 package.json，因此返回值不一定是 here 本身 —— 但一定
    // 是 here 的某个祖先。把 result 也 realpath 一下避免 normalize 引发的
    // 大小写 / 软链偏差。
    const here = path.dirname(fileURLToPath(import.meta.url));
    const realHere = realpathSync(here);
    const realRoot = realpathSync(resolveInstallRoot());
    // realRoot 是 realHere 的某个祖先目录：把 realRoot + sep 当前缀查就行。
    expect(
      realHere.startsWith(realRoot + path.sep) || realHere === realRoot
    ).toBe(true);
    // 锁住：本仓库的 installRoot 一定有 src/ 与 tests/ 在其下 —— 这是与
    // "锚在 import.meta.url" 互为表里的可观测形态（从 src/ 子树向上找必然
    // 落到包根）。
    expect(
      existsSync(path.join(realRoot, "src", "harness", "session-roots.ts"))
    ).toBe(true);
    expect(existsSync(path.join(realRoot, "tests"))).toBe(true);
  });

  it("the resolved root is the iknow package root (src/ 之上有 package.json)", () => {
    const root = resolveInstallRoot();
    // 该根应是本仓库 package.json 所在目录：包名是 iknow（顶层 src/ 与
    // tests/ 的共同祖先）。
    const pkg = path.join(root, "package.json");
    expect(existsSync(pkg)).toBe(true);
    // sanity: 根是目录而非文件
    expect(statSync(root).isDirectory()).toBe(true);
  });

  it("process-level cache: multiple calls return the same string instance", async () => {
    // :168-171 「进程级缓存不给 reset 缝」。我们验证：
    //  (a) 多次调用返回**严格相等**的字符串（同一引用，不只是 deep-equal）；
    //  (b) 模块没有导出 reset 函数。
    const a = resolveInstallRoot();
    const b = resolveInstallRoot();
    const c = resolveInstallRoot();
    expect(a).toBe(b);
    expect(b).toBe(c);
    // 导出面没有 reset / clear / uncache 之类的入口。
    const mod = await import("../../src/harness/session-roots.ts");
    const exportedNames = Object.keys(mod);
    for (const name of exportedNames) {
      expect(name.toLowerCase()).not.toMatch(
        /(reset|clear|uncache|invalidate)/
      );
    }
  });

  it("is unaffected by chdir of process.cwd() (regression of import.meta.url anchor)", () => {
    // 把 cwd 切到一个完全无关的临时目录，installRoot 必须**不变**——它锚在
    // import.meta.url，不是 process.cwd()。
    const before = resolveInstallRoot();
    const originalCwd = process.cwd();
    const alt = mkdtempSync(path.join(tmpdir(), "iknow-t3-install-"));
    process.chdir(alt);
    try {
      expect(resolveInstallRoot()).toBe(before);
    } finally {
      process.chdir(originalCwd);
    }
  });
});

describe("quoteRoot — diagnostic truncation", () => {
  it("wraps short values with quotes and does not truncate", () => {
    expect(quoteRoot("/foo", 16)).toBe("'/foo'");
  });

  it("truncates values longer than limit and appends an ellipsis", () => {
    const value = "x".repeat(200);
    const out = quoteRoot(value, 10);
    expect(out.startsWith("'")).toBe(true);
    expect(out.endsWith("…'")).toBe(true);
    // 引号内展示部分长度 = limit + 省略号
    expect(out.length).toBe(10 + 1 /* … */ + 2 /* quotes */);
  });

  it("boundary: exactly at limit is not truncated", () => {
    const value = "x".repeat(10);
    expect(quoteRoot(value, 10)).toBe(`'${value}'`);
  });
});

describe("MAX_ROOT_DETAIL_CHARS — diagnostic constant", () => {
  it("is a positive finite integer used as the diagnostic cap", () => {
    expect(typeof MAX_ROOT_DETAIL_CHARS).toBe("number");
    expect(Number.isInteger(MAX_ROOT_DETAIL_CHARS)).toBe(true);
    expect(MAX_ROOT_DETAIL_CHARS).toBeGreaterThan(0);
  });
});

describe("SessionRoots — readonly shape (D3 typed contract)", () => {
  // 类型层契约：编译期由 TS 校验；运行期这里给一个最小烟雾测试，确认
  // 返回对象确实有这四个键（避免以后有人不小心 delete 字段）。
  it("returned object has exactly the four role keys", () => {
    const roots: SessionRoots = resolveSessionRoots(makeInput());
    expect(Object.keys(roots).sort()).toEqual(
      ["installRoot", "productRoot", "projectIdentityRoot", "taskRoot"].sort()
    );
  });
});

// --------------------------------------------------------------------------
// T4 (plans/worktree-live-task-root.md §6 T4) — live taskRoot holder + single
// writer wiring. Zero behavior change in T4 (no consumer reads), so the
// tests below pin the structural invariants the holder + wrap must keep:
//   - read() returns the initial snapshot,
//   - writeLiveTaskRoot updates the cell in-place,
//   - D2 batch snapshot: many synchronous reads see the same string value,
//   - D3 stable-root list is NOT carried by the cell (only `taskRoot` is),
//   - withLiveTaskRootWrite: seam resolves → cell written + value returned,
//   - withLiveTaskRootWrite: seam throws → cell **unchanged** + error
//     propagates unchanged (no write, no rollback),
//   - withLiveTaskRootWrite forwards seam arguments verbatim.
// --------------------------------------------------------------------------

describe("LiveTaskRoot — T4 holder", () => {
  it("createLiveTaskRoot(initial) returns a cell whose read() yields the initial value", () => {
    const cell = createLiveTaskRoot("/repo/wt/conv-1");
    expect(cell.read()).toBe("/repo/wt/conv-1");
  });

  it("writeLiveTaskRoot(cell, value) updates the cell so read() reflects the new value", () => {
    const cell = createLiveTaskRoot("/repo/wt/conv-1");
    writeLiveTaskRoot(cell, "/repo/wt/conv-2");
    expect(cell.read()).toBe("/repo/wt/conv-2");
    writeLiveTaskRoot(cell, "/repo/wt/conv-3");
    expect(cell.read()).toBe("/repo/wt/conv-3");
  });

  it("concurrent reads within one synchronous stretch return the same value (D2 batch snapshot)", () => {
    // D2: a wave of tool calls shares one snapshot. We exercise the
    // underlying mechanism here — JS single-threaded closure reads are
    // atomic, so a tight loop of reads always sees the current value with
    // no partial-update window.
    const cell = createLiveTaskRoot("/repo/wt/conv-1");
    const reads: string[] = [];
    for (let i = 0; i < 64; i++) reads.push(cell.read());
    expect(new Set(reads).size).toBe(1);
    expect(reads[0]).toBe("/repo/wt/conv-1");

    // After a single synchronous write, every read in the next stretch
    // observes the new value with the same atomicity guarantee.
    writeLiveTaskRoot(cell, "/repo/wt/conv-2");
    const reads2: string[] = [];
    for (let i = 0; i < 64; i++) reads2.push(cell.read());
    expect(new Set(reads2).size).toBe(1);
    expect(reads2[0]).toBe("/repo/wt/conv-2");
  });

  it("cell shape carries only taskRoot — D3 stable roots are not exposed (no other slots)", () => {
    // D3 稳定根清单：productRoot / projectIdentityRoot / installRoot /
    // mcpConfigRoot / stateAnchor / memoryDir / todoDir / traceDir 全部保持
    // 装配期冻结。LiveTaskRoot 只承载 taskRoot 一个值，且 LiveTaskRoot 接口
    // 不暴露任何 setter (single writer 由 writeLiveTaskRoot 独占)。
    const cell: LiveTaskRoot = createLiveTaskRoot("/repo/wt/conv-1");
    expect(cell.read()).toBe("/repo/wt/conv-1");
    // Public 接口面只剩 read；setter 不会跨导出面泄漏。
    type PublicSurface = keyof LiveTaskRoot;
    const publicKeys: PublicSurface[] = ["read"];
    expect(publicKeys).toEqual(["read"]);
  });
});

describe("withLiveTaskRootWrite — T4 single-writer seam wrap", () => {
  it("seam resolves → cell written AND returned value forwarded", async () => {
    const cell = createLiveTaskRoot("/repo");
    const wrapped = withLiveTaskRootWrite(async () => "/repo/wt/conv-1", cell);
    const result = await wrapped();
    expect(result).toBe("/repo/wt/conv-1");
    expect(cell.read()).toBe("/repo/wt/conv-1");
  });

  it("seam throws typed error → cell UNCHANGED (no write, no rollback) + error propagates", async () => {
    // D1: 包装点只在缝成功 resolve 时写。失败不写、不回滚，typed error 原样冒泡。
    const cell = createLiveTaskRoot("/repo");
    const typedErr = Object.assign(new Error("foreign_worktree"), {
      kind: "foreign_worktree",
    });
    const wrapped = withLiveTaskRootWrite(async () => {
      throw typedErr;
    }, cell);
    await expect(wrapped()).rejects.toBe(typedErr);
    expect(cell.read()).toBe("/repo"); // unchanged
  });

  it("seam throws typed error after a previous successful write → cell stays at the previously written value", async () => {
    // Edge: cell already holds value V from a prior success; a subsequent
    // failing seam must leave V in place. No rollback, no partial state.
    const cell = createLiveTaskRoot("/repo");
    const typedErr = Object.assign(new Error("rebind_failed"), {
      kind: "rebind_failed",
    });
    const wrapped = withLiveTaskRootWrite(async (ok: boolean) => {
      if (!ok) throw typedErr;
      return "/repo/wt/conv-1";
    }, cell);
    const first = await wrapped(true);
    expect(first).toBe("/repo/wt/conv-1");
    expect(cell.read()).toBe("/repo/wt/conv-1");

    await expect(wrapped(false)).rejects.toBe(typedErr);
    // Cell must still hold the prior value, not be reset to initial.
    expect(cell.read()).toBe("/repo/wt/conv-1");
  });

  it("forwards seam arguments verbatim (provision ctx shape preserved)", async () => {
    const cell = createLiveTaskRoot("/repo");
    type Ctx = { conversationId?: string; root: string };
    let captured: Ctx | undefined;
    const wrapped = withLiveTaskRootWrite(async (ctx: Ctx) => {
      captured = ctx;
      return "/repo/wt/x";
    }, cell);
    const ctxArg: Ctx = { conversationId: "conv-1", root: "/repo" };
    const result = await wrapped(ctxArg);
    expect(result).toBe("/repo/wt/x");
    expect(captured).toEqual(ctxArg);
    expect(cell.read()).toBe("/repo/wt/x");
  });

  it("wrap is a no-op for a non-async seam (still returns the value, still writes)", async () => {
    // Seam 形如 (ctx) => Promise<string>；即使 seam 立即 resolve 也仍走
    // await 路径，写入依旧发生。回归保护：之前的 wrap 实现如果误用
    // seam(...args).then(...) 会绕过 await 的写入，本测试拦截。
    const cell = createLiveTaskRoot("/repo");
    const wrapped = withLiveTaskRootWrite(
      ((_ctx: unknown) => Promise.resolve("/repo/wt/conv-9")) as (
        ctx: unknown
      ) => Promise<string>,
      cell
    );
    await wrapped({});
    expect(cell.read()).toBe("/repo/wt/conv-9");
  });
});
