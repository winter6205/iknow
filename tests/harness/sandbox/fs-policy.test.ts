import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  READ_ONLY_SYSTEM_PATHS,
  SENSITIVE_PATHS,
  createFsPolicy,
} from "../../../src/harness/sandbox/fs-policy.js";

describe("createFsPolicy", () => {
  const policy = createFsPolicy({
    cwd: "/workspace",
    home: "/home/user",
    tmpDir: "/tmp/job",
  });

  it("freezes exported path lists and excludes sensitive home paths", () => {
    assert.ok(Object.isFrozen(SENSITIVE_PATHS));
    assert.ok(Object.isFrozen(READ_ONLY_SYSTEM_PATHS));
    assert.equal(policy.isSensitive("/home/user/.ssh/id_ed25519"), true);
    assert.equal(
      policy.allowedPaths().some((path) => path.endsWith("/.ssh")),
      false
    );
  });

  it("rejects sensitive and outside paths with a typed denial", () => {
    assert.throws(
      () => policy.assertWithin("/home/user/.ssh/config"),
      (error: unknown) =>
        error instanceof Error &&
        error.message ===
          "[fs_denied] path outside fence: /home/user/.ssh/config"
    );
    assert.throws(() => policy.assertWithin("/etc/passwd"), /\[fs_denied\]/);
  });

  it("allows paths within cwd and identifies read-only system roots", () => {
    assert.doesNotThrow(() => policy.assertWithin("/workspace/src/index.ts"));
    assert.equal(policy.isReadOnlySystem("/etc/hosts"), true);
    assert.equal(policy.isReadOnlySystem("/workspace/file"), false);
  });

  it("does not turn a recursive find root into an allowlisted sensitive path", () => {
    assert.equal(policy.allowedPaths().includes("/"), false);
    assert.equal(policy.isSensitive("/home/user/.docker/config.json"), true);
  });
});

/**
 * ADR-0019 (T4) acceptance: fs-policy protects per-root state files.
 *
 * Mirrors the plan's binary asserts:
 *   - `home = $HOME`, `workspaceRoot = $FAKE`, agent `fs.write` to
 *     `$FAKE/.iknow/state.json` is refused with `execution_failed`;
 *     same for `$HOME/.iknow/state.json`. `fs.write` to `$FAKE/AGENTS.md`
 *     (allowed path) succeeds.
 *   - boundary class `negative`: `cd $FAKE && fs.read .iknow/state.json`
 *     refused; `fs.read README.md` succeeds.
 *
 * The executor wraps `ToolExecutionError` thrown here into the
 * `execution_failed` envelope; the unit test asserts the typed-error
 * surface (`[fs_denied]` prefix) directly so the wrapping contract is
 * exercised by the integration probe (T2 evidence) rather than re-tested
 * here.
 */
describe("createFsPolicy — workspaceRoot state protection (ADR-0019 T4)", () => {
  const FAKE = "/fake-root";
  const HOME = "/home/user";
  const policy = createFsPolicy({
    cwd: FAKE,
    home: HOME,
    tmpDir: "/tmp/job",
    workspaceRoot: FAKE,
  });

  it("refuses state paths under <workspaceRoot>/.iknow with [fs_denied] (policy-refusal)", () => {
    // every child of `.iknow` is refused uniformly: `isWithin` cascades so
    // the directory anchor covers the whole subtree without enumerating.
    assert.throws(
      () => policy.assertWithin(`${FAKE}/.iknow/state.json`),
      (error: unknown) =>
        error instanceof Error &&
        error.message ===
          "[fs_denied] path outside fence: /fake-root/.iknow/state.json"
    );
    assert.throws(
      () => policy.assertWithin(`${FAKE}/.iknow/user.md`),
      /\[fs_denied\]/
    );
    assert.throws(
      () => policy.assertWithin(`${FAKE}/.iknow/BOOTSTRAP.md`),
      /\[fs_denied\]/
    );
    assert.throws(
      () => policy.assertWithin(`${FAKE}/.iknow/memory/slot/notes.md`),
      /\[fs_denied\]/
    );
    assert.throws(
      () => policy.assertWithin(`${FAKE}/.iknow/skills/foo/SKILL.md`),
      /\[fs_denied\]/
    );
  });

  it("refuses state paths under <home>/.iknow with [fs_denied] (same pattern as T4 plan)", () => {
    // T4 mirrors <home>/.iknow protection onto <workspaceRoot>/.iknow;
    // both halves must hold symmetrically (D1.4 per-root persona state).
    assert.throws(
      () => policy.assertWithin(`${HOME}/.iknow/state.json`),
      /\[fs_denied\]/
    );
    assert.throws(
      () => policy.assertWithin(`${HOME}/.iknow/user.md`),
      /\[fs_denied\]/
    );
  });

  it("allows sibling paths under workspaceRoot (AGENTS.md / README.md / src/...)", () => {
    // positive control: the fence admits everything under workspaceRoot
    // except `.iknow/` — that's the actual semantic of the protection.
    assert.doesNotThrow(() => policy.assertWithin(`${FAKE}/AGENTS.md`));
    assert.doesNotThrow(() => policy.assertWithin(`${FAKE}/README.md`));
    assert.doesNotThrow(() => policy.assertWithin(`${FAKE}/src/index.ts`));
  });

  it("isSensitive reports true for protected state paths and false elsewhere (boundary class negative)", () => {
    // bash fence + read_file shared indicator. The 'negative' class here
    // is: an input that LOOKS like a normal project file but lives under
    // a protected-state directory — `isSensitive` correctly classifies it.
    assert.equal(policy.isSensitive(`${FAKE}/.iknow/state.json`), true);
    assert.equal(policy.isSensitive(`${HOME}/.iknow/state.json`), true);
    assert.equal(policy.isSensitive(`${FAKE}/README.md`), false);
    // pre-existing sensitive paths remain untouched (no scope creep on
    // SENSITIVE_PATHS: SSH/AWS/GnuPG/etc. still gated).
    assert.equal(policy.isSensitive(`${HOME}/.ssh/id_ed25519`), true);
  });

  it("preserves bwrap positional contract: allowedPaths[0..3] stable + frozen", () => {
    // bwrap.ts indexes paths[1]=home and paths[2]=tmp positionally. Adding
    // workspaceRoot at [3] must NOT disturb the first three slots — that's
    // the load-bearing invariant for the existing fence-binding argv.
    // workspaceRoot must differ from cwd/home/tmp for [3] to materialize;
    // when it overlaps (default flow: workspaceRoot == cwd) dedup collapses
    // it, and the dedup test below locks that sibling behavior.
    const distinct = createFsPolicy({
      cwd: FAKE,
      home: HOME,
      tmpDir: "/tmp/job",
      workspaceRoot: "/fake-workspace-root",
    });
    const paths = distinct.allowedPaths();
    assert.equal(paths[0], FAKE, "[0] = cwd (primary soft sandbox)");
    assert.equal(paths[1], HOME, "[1] = home (bwrap --bind home home)");
    assert.equal(paths[2], "/tmp/job", "[2] = tmpDir (bwrap --tmpfs overlay)");
    assert.equal(
      paths[3],
      "/fake-workspace-root",
      "[3] = workspaceRoot (T4 addition)"
    );
    assert.ok(Object.isFrozen(paths));
    // the distinct workspaceRoot still gates its own .iknow subtree.
    assert.equal(
      distinct.isSensitive("/fake-workspace-root/.iknow/state.json"),
      true
    );
    assert.throws(
      () => distinct.assertWithin("/fake-workspace-root/.iknow/state.json"),
      /\[fs_denied\]/
    );
    assert.doesNotThrow(() =>
      distinct.assertWithin("/fake-workspace-root/README.md")
    );
  });

  it("makeRoots dedups workspaceRoot when it overlaps cwd or home (Set-based, order-stable)", () => {
    // workspaceRoot == cwd: Set drops the duplicate, the position contract
    // is preserved (no spurious [3]).
    const collapsedWithCwd = createFsPolicy({
      cwd: FAKE,
      home: HOME,
      tmpDir: "/tmp/job",
      workspaceRoot: FAKE,
    });
    assert.deepEqual(
      [...collapsedWithCwd.allowedPaths()],
      [FAKE, HOME, "/tmp/job"],
      "workspaceRoot == cwd → dedup drops workspaceRoot at [3]"
    );
    // workspaceRoot == home: same discipline.
    const collapsedWithHome = createFsPolicy({
      cwd: FAKE,
      home: HOME,
      tmpDir: "/tmp/job",
      workspaceRoot: HOME,
    });
    assert.deepEqual(
      [...collapsedWithHome.allowedPaths()],
      [FAKE, HOME, "/tmp/job"],
      "workspaceRoot == home → dedup drops workspaceRoot at [3]"
    );
    // protection still applies — `.iknow` under the surviving root is
    // sensitive regardless of which constructor input "owns" the path.
    assert.equal(
      collapsedWithHome.isSensitive(`${HOME}/.iknow/state.json`),
      true
    );
  });

  it("does not regress pre-existing protection when workspaceRoot is threaded", () => {
    // The legacy protected paths (SENSITIVE_PATHS / READ_ONLY_SYSTEM_PATHS)
    // and the `<home>/.iknow` coverage all keep working with the new opt.
    assert.throws(
      () => policy.assertWithin(`${HOME}/.ssh/config`),
      /\[fs_denied\]/
    );
    assert.throws(() => policy.assertWithin("/etc/passwd"), /\[fs_denied\]/);
    assert.equal(policy.isReadOnlySystem("/etc/hosts"), true);
    assert.equal(policy.isReadOnlySystem(`${FAKE}/src/index.ts`), false);
  });
});
