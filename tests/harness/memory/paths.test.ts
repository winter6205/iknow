/**
 * resolveProjectMemoryDir — home 项目树兄弟 `memory/`（ADR-0099）。
 * 跨函数等式钉死与会话文件夹同 slug；fail-closed 同 resolveTasksDir。
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  resolveProjectMemoryDir,
  resolveUserMemoryDir,
} from "../../../src/harness/memory/paths.ts";
import { resolveProjectSessionDir } from "../../../src/session-api/store/session-store.ts";

const TEST_POOL = "/tmp/iknow-memory-pool";

describe("resolveProjectMemoryDir", () => {
  it("is the session project dir plus memory/", () => {
    assert.equal(
      resolveProjectMemoryDir({
        dataDir: TEST_POOL,
        projectIdentityRoot: "/tmp/alpha/proj",
      }),
      join(resolveProjectSessionDir(TEST_POOL, "/tmp/alpha/proj"), "memory")
    );
  });

  it("is stable for the same identity across repeated calls", () => {
    const a = resolveProjectMemoryDir({
      dataDir: TEST_POOL,
      projectIdentityRoot: "/tmp/alpha/proj",
    });
    const b = resolveProjectMemoryDir({
      dataDir: TEST_POOL,
      projectIdentityRoot: "/tmp/alpha/proj",
    });
    assert.equal(a, b);
  });

  it("does not collide for same-basename projects at different paths", () => {
    const a = resolveProjectMemoryDir({
      dataDir: TEST_POOL,
      projectIdentityRoot: "/home/u/A/proj",
    });
    const b = resolveProjectMemoryDir({
      dataDir: TEST_POOL,
      projectIdentityRoot: "/home/u/B/proj",
    });
    assert.notEqual(a, b);
  });

  it("does not use workspaceRoot as the parent (throwaway does not fork the store)", () => {
    const dir = resolveProjectMemoryDir({
      dataDir: TEST_POOL,
      projectIdentityRoot: "/tmp/alpha/proj",
    });
    assert.equal(dir.startsWith(join(TEST_POOL, "projects")), true);
    assert.equal(dir.includes(".iknow/memory"), false);
  });

  it("121–255 char identity roots are accepted on both sides of the tree", () => {
    const longRoot = "/" + "a".repeat(254);
    assert.equal(longRoot.length, 255);
    assert.doesNotThrow(() => resolveProjectSessionDir("/pool", longRoot));
    assert.doesNotThrow(() =>
      resolveProjectMemoryDir({
        dataDir: "/pool",
        projectIdentityRoot: longRoot,
      })
    );
    assert.equal(
      resolveProjectMemoryDir({
        dataDir: "/pool",
        projectIdentityRoot: longRoot,
      }),
      join(resolveProjectSessionDir("/pool", longRoot), "memory")
    );
  });

  it("rejects empty / blank / relative / overlong identity with SessionRootError", () => {
    const cases: ReadonlyArray<string> = [
      "",
      "   ",
      "relative/path",
      "/" + "a".repeat(255),
    ];
    for (const bad of cases) {
      assert.throws(
        () =>
          resolveProjectMemoryDir({
            dataDir: "/pool",
            projectIdentityRoot: bad,
          }),
        (err: unknown) => {
          const e = err as { name?: string; kind?: string };
          assert.equal(e.name, "SessionRootError");
          assert.ok(
            e.kind === "missing_root" || e.kind === "invalid_root",
            `unexpected kind: ${String(e.kind)}`
          );
          return true;
        }
      );
    }
  });
});

describe("resolveUserMemoryDir", () => {
  it("is per-root <workspaceRoot>/.iknow/memory (user-level parent, not the project store)", () => {
    assert.equal(
      resolveUserMemoryDir(TEST_POOL),
      join(TEST_POOL, ".iknow", "memory")
    );
  });

  it("is independent of projectIdentityRoot", () => {
    assert.equal(
      resolveUserMemoryDir(TEST_POOL),
      resolveUserMemoryDir(TEST_POOL)
    );
  });
});
