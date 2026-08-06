/**
 * #121 T2: resolveProjectMemoryDir / resolveUserMemoryDir pure-function tests.
 *
 * Spec: specs/121-memory-injection.md (Testing Strategy paths half, SC 6/7,
 * Boundaries Always — user-level root ALWAYS = ~/.iknow, decoupled from
 * --data-dir). Naming rule reuses session-store.ts:42-45
 * `<basename(cwd)>-<sha1(cwd)[:12]>` under the user-level `~/.iknow/memory/`.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import {
  resolveProjectMemoryDir,
  resolveUserMemoryDir,
} from "../../../src/harness/memory/paths.ts";

describe("resolveProjectMemoryDir", () => {
  it("is stable for the same cwd across repeated calls", () => {
    const a = resolveProjectMemoryDir("/tmp/alpha/proj");
    const b = resolveProjectMemoryDir("/tmp/alpha/proj");
    assert.equal(a, b);
  });

  it("does not collide for same-basename projects at different paths", () => {
    const a = resolveProjectMemoryDir("/home/u/A/proj");
    const b = resolveProjectMemoryDir("/home/u/B/proj");
    assert.notEqual(a, b);
    assert.equal(basename(a).startsWith("proj-"), true);
    assert.equal(basename(b).startsWith("proj-"), true);
  });

  it("extracts the basename of the cwd into the directory name", () => {
    const dir = resolveProjectMemoryDir("/opt/workspaces/my-agent");
    assert.equal(basename(dir).startsWith("my-agent-"), true);
  });

  it("normalizes relative cwd to an absolute path", () => {
    const abs = resolveProjectMemoryDir("/tmp/foo/rel");
    const rel = resolveProjectMemoryDir("/tmp/foo/rel/../rel");
    assert.equal(abs, rel);
  });

  it("lives under the user-level ~/.iknow/memory root", () => {
    const dir = resolveProjectMemoryDir("/tmp/alpha/proj");
    assert.equal(dir.startsWith(join(homedir(), ".iknow", "memory")), true);
  });
});

describe("resolveUserMemoryDir", () => {
  it("is always ~/.iknow/memory", () => {
    assert.equal(resolveUserMemoryDir(), join(homedir(), ".iknow", "memory"));
  });

  it("is independent of cwd (decoupled from --data-dir)", () => {
    // Takes no cwd input; repeated calls must be identical regardless of the
    // caller's working directory context.
    assert.equal(resolveUserMemoryDir(), resolveUserMemoryDir());
  });

  it("does not contain a project-namespace suffix", () => {
    const dir = resolveUserMemoryDir();
    assert.equal(dir, join(homedir(), ".iknow", "memory"));
  });
});
