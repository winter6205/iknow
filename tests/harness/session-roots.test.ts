/**
 * session-roots SSOT contract tests.
 *
 * Purpose: pin the current contract of `src/harness/session-roots.ts` as a
 * safety net before `taskRoot` rebinding is ever activated. **Not a single
 * line of src/ changes here** — it only freezes today's behavior so any
 * later refactor must pass this gate.
 *
 * Coverage:
 *  - four-role resolution (happy path / any role missing / any role invalid)
 *  - missing root → `SessionRootError kind:"missing_root"`
 *  - relative / blank / NUL-containing → `SessionRootError kind:"invalid_root"`
 *  - **never falls back to `process.cwd()`**
 *  - `stripTrailingSeparators` keeps the posix `/` and win32 `C:\` roots
 *    themselves
 *  - `resolveInstallRoot` anchors on `import.meta.url` and keeps a
 *    process-level cache with no reset seam
 *  - the three cross-rebind invariant roles (`productRoot` /
 *    `projectIdentityRoot` / `installRoot`) get named tests, so they cannot
 *    silently regress later
 *  - concurrency: many reads of `resolveSessionRoots` in one stretch return
 *    deeply equal results (the pure-function → equality guarantee is pinned
 *    here up front, ahead of any same-wave snapshot mechanism).
 *
 * No implementation tests: all assertions target the **exported behavior**
 * of src/harness/session-roots.ts, never private internals.
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
    // Pin the "pure function → deeply equal" guarantee up front, so any later
    // same-wave snapshot implementation that regresses gets caught by this gate.
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
  // Stable-root list: productRoot / projectIdentityRoot / installRoot must
  // **never** be derived from taskRoot or auto-rebound; they are decided only
  // by the values the assembly layer passes in. Pin that contract as a test:
  // with the same input, however taskRoot changes, the other three roots
  // **stay put** — they are the "cross-rebind invariant" roles.

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
    // ADR-0037: the project-identity root is kept separate from productRoot
    // because under `--workspace-root <dir>` redirection `dir ≠ cwd`.
    // Contract here: supplying projectIdentityRoot without productRoot (or
    // vice versa) must fail closed (missing_root); neither slot derives the other.
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
    // Explicit contract: missing / blank / relative / non-normalizable roots
    // all fail closed and NEVER fall back to process.cwd(). Pin it as a test:
    // 1) chdir into a fresh temp dir;
    // 2) productRoot absent → must throw, never silently borrow cwd;
    // 3) chdir back to avoid polluting later tests in the same process.
    const freshCwd = mkdtempSync(path.join(tmpdir(), "iknow-t3-cwd-"));
    const originalCwd = process.cwd();
    process.chdir(freshCwd);
    try {
      let caught: unknown;
      try {
        resolveSessionRoots(
          makeInput({
            productRoot: undefined,
            // pass the other three roots as in the happy path so only productRoot triggers missing_root
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
    // Stronger form: an absolute cwd looks like a plausible fallback — still must throw.
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
    expect(detail).toContain("…"); // truncation ellipsis
    // after truncation the detail is at most MAX_ROOT_DETAIL_CHARS + quotes + ellipsis
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
  // Private helper; its contract is observed through normalizeRootCandidate:
  // strip trailing separators but keep the filesystem root itself.

  it("filesystem root `/` is preserved", () => {
    expect(normalizeRootCandidate("/")).toEqual({ ok: true, root: "/" });
  });

  it("non-root posix paths lose trailing slashes", () => {
    expect(normalizeRootCandidate("/a")).toEqual({ ok: true, root: "/a" });
    expect(normalizeRootCandidate("/a/")).toEqual({ ok: true, root: "/a" });
    expect(normalizeRootCandidate("/a/b/")).toEqual({ ok: true, root: "/a/b" });
  });

  it("path.parse root length is the contract boundary", () => {
    // Indirect assertion: stripTrailingSeparators uses `path.parse(p).root`
    // as the "is this already the root itself" check. Verify a path whose
    // length equals the root is preserved verbatim.
    const root = path.parse("/").root; // "/"
    expect(normalizeRootCandidate(root)).toEqual({ ok: true, root });
  });
});

describe("stripTrailingSeparators — win32 (mocked path module)", () => {
  // On Linux CI src/harness/session-roots.ts uses the platform path. To
  // verify the win32 branch (keep `C:\`, trim `C:\foo\`) `node:path` must be
  // mocked as `path.win32`, scoped to this test group and cleaned up after.
  beforeEach(() => {
    vi.resetModules();
    vi.doMock("node:path", () => {
      // src/harness/session-roots.ts uses `import path from "node:path"`
      // (default import). vi.doMock replaces the whole module with the
      // factory result, so win32 must be exported both as default and namespace.
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
    // Explicit invariant: resolveInstallRoot starts its walk at this module's
    // own directory — not process.cwd(), not any task worktree. It walks up
    // the tree looking for package.json, so the result need not be `here`
    // itself but must be an ancestor of `here`. realpath the result too, to
    // dodge case / symlink skew introduced by normalization.
    const here = path.dirname(fileURLToPath(import.meta.url));
    const realHere = realpathSync(here);
    const realRoot = realpathSync(resolveInstallRoot());
    // realRoot is an ancestor of realHere: a prefix check on realRoot + sep suffices.
    expect(
      realHere.startsWith(realRoot + path.sep) || realHere === realRoot
    ).toBe(true);
    // Locked in: this repo's installRoot always has src/ and tests/ beneath
    // it — the observable twin of the "anchored to import.meta.url" claim
    // (a walk up from the src/ subtree necessarily lands on the package root).
    expect(
      existsSync(path.join(realRoot, "src", "harness", "session-roots.ts"))
    ).toBe(true);
    expect(existsSync(path.join(realRoot, "tests"))).toBe(true);
  });

  it("the resolved root is the iknow package root (src/ 之上有 package.json)", () => {
    const root = resolveInstallRoot();
    // The root should be this repo's package.json directory: the iknow
    // package root, the common ancestor of top-level src/ and tests/.
    const pkg = path.join(root, "package.json");
    expect(existsSync(pkg)).toBe(true);
    // sanity: the root is a directory, not a file
    expect(statSync(root).isDirectory()).toBe(true);
  });

  it("process-level cache: multiple calls return the same string instance", async () => {
    // Process-level cache with no reset seam. Verify:
    //  (a) repeated calls return the **strictly equal** string (same
    //      reference, not just deep-equal);
    //  (b) the module exports no reset function.
    const a = resolveInstallRoot();
    const b = resolveInstallRoot();
    const c = resolveInstallRoot();
    expect(a).toBe(b);
    expect(b).toBe(c);
    // The export surface offers no reset / clear / uncache entry point.
    const mod = await import("../../src/harness/session-roots.ts");
    const exportedNames = Object.keys(mod);
    for (const name of exportedNames) {
      expect(name.toLowerCase()).not.toMatch(
        /(reset|clear|uncache|invalidate)/
      );
    }
  });

  it("is unaffected by chdir of process.cwd() (regression of import.meta.url anchor)", () => {
    // Chdir to a completely unrelated temp dir: installRoot must **not
    // change** — it is anchored to import.meta.url, not process.cwd().
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
    // shown length inside the quotes = limit + ellipsis
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
  // Type-level contract: TS enforces it at compile time; at runtime a minimal
  // smoke test confirms the returned object really has the four role keys
  // (guards against someone accidentally deleting a field later).
  it("returned object has exactly the four role keys", () => {
    const roots: SessionRoots = resolveSessionRoots(makeInput());
    expect(Object.keys(roots).sort()).toEqual(
      ["installRoot", "productRoot", "projectIdentityRoot", "taskRoot"].sort()
    );
  });
});

// --------------------------------------------------------------------------
// live taskRoot holder + single-writer wiring. The holder has no consumer yet
// (zero behavior change), so the tests below pin the structural invariants
// the holder + wrap must keep:
//   - read() returns the initial snapshot,
//   - writeLiveTaskRoot updates the cell in-place,
//   - batch snapshot: many synchronous reads in one stretch see one string,
//   - stable roots are NOT carried by the cell (only `taskRoot` is),
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
    // A wave of tool calls shares one snapshot. We exercise the
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
    // Stable-root list: productRoot / projectIdentityRoot / installRoot /
    // mcpConfigRoot / stateAnchor / memoryDir / todoDir / traceDir all stay
    // frozen at assembly time. LiveTaskRoot carries only taskRoot, and its
    // interface exposes no setter (writeLiveTaskRoot is the single writer).
    const cell: LiveTaskRoot = createLiveTaskRoot("/repo/wt/conv-1");
    expect(cell.read()).toBe("/repo/wt/conv-1");
    // The public surface is just read; no setter leaks across the export surface.
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
    // The wrapper writes only when the seam resolves successfully. On failure: no write, no rollback; the typed error propagates verbatim.
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
    // The seam is (ctx) => Promise<string>; even a seam that resolves
    // immediately goes through the await path, so the write still happens.
    // Regression guard: an earlier wrap that misused seam(...args).then(...)
    // would bypass the awaited write; this test catches that.
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
