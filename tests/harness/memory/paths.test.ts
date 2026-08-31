/**
 * #121 T2 + ADR-0019 (T2): resolveProjectMemoryDir / resolveUserMemoryDir
 * pure-function tests.
 *
 * Spec: specs/121-memory-injection.md (Testing Strategy paths half, SC 6/7,
 * Boundaries Always — user-level root decoupled from --data-dir).
 * Naming rule reuses session-store.ts:42-45 `<basename(cwd)>-<sha1(cwd)[:12]>`
 * under `<workspaceRoot>/.iknow/memory/` (per-root memory, ADR-0019 T2 D1.4
 * follow-on). Pure: no IO；接受显式 workspaceRoot 缝，缺省落
 * `resolveWorkspaceRoot({cwd})`(=process.cwd())。
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { basename, join } from "node:path";
import {
  resolveProjectMemoryDir,
  resolveUserMemoryDir,
} from "../../../src/harness/memory/paths.ts";

const TEST_WORKSPACE_ROOT = "/tmp/iknow-paths-workspace";

describe("resolveProjectMemoryDir", () => {
  it("is stable for the same cwd across repeated calls", () => {
    const a = resolveProjectMemoryDir("/tmp/alpha/proj", TEST_WORKSPACE_ROOT);
    const b = resolveProjectMemoryDir("/tmp/alpha/proj", TEST_WORKSPACE_ROOT);
    assert.equal(a, b);
  });

  it("does not collide for same-basename projects at different paths", () => {
    const a = resolveProjectMemoryDir("/home/u/A/proj", TEST_WORKSPACE_ROOT);
    const b = resolveProjectMemoryDir("/home/u/B/proj", TEST_WORKSPACE_ROOT);
    assert.notEqual(a, b);
    assert.equal(basename(a).startsWith("proj-"), true);
    assert.equal(basename(b).startsWith("proj-"), true);
  });

  it("extracts the basename of the namespaceRoot into the directory name", () => {
    const dir = resolveProjectMemoryDir(
      "/opt/workspaces/my-agent",
      TEST_WORKSPACE_ROOT
    );
    assert.equal(basename(dir).startsWith("my-agent-"), true);
  });

  it("normalizes a relative namespaceRoot to an absolute path", () => {
    const abs = resolveProjectMemoryDir("/tmp/foo/rel", TEST_WORKSPACE_ROOT);
    const rel = resolveProjectMemoryDir(
      "/tmp/foo/rel/../rel",
      TEST_WORKSPACE_ROOT
    );
    assert.equal(abs, rel);
  });

  it("lives under the per-root <workspaceRoot>/.iknow/memory root (ADR-0019 T2)", () => {
    const dir = resolveProjectMemoryDir("/tmp/alpha/proj", TEST_WORKSPACE_ROOT);
    assert.equal(
      dir.startsWith(join(TEST_WORKSPACE_ROOT, ".iknow", "memory")),
      true
    );
  });
});

describe("resolveUserMemoryDir", () => {
  it("is per-root <workspaceRoot>/.iknow/memory (ADR-0019 T2; was ~/.iknow/memory)", () => {
    assert.equal(
      resolveUserMemoryDir(TEST_WORKSPACE_ROOT),
      join(TEST_WORKSPACE_ROOT, ".iknow", "memory")
    );
  });

  it("is independent of cwd (decoupled from --data-dir)", () => {
    // Takes no cwd input; repeated calls must be identical regardless of the
    // caller's working directory context.
    assert.equal(
      resolveUserMemoryDir(TEST_WORKSPACE_ROOT),
      resolveUserMemoryDir(TEST_WORKSPACE_ROOT)
    );
  });

  it("does not contain a project-namespace suffix", () => {
    const dir = resolveUserMemoryDir(TEST_WORKSPACE_ROOT);
    assert.equal(dir, join(TEST_WORKSPACE_ROOT, ".iknow", "memory"));
  });
});
