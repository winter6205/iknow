/**
 * ADR-0092 / ADR-0140 §2 reason 3 — the SHARED definition of "what the current
 * `fsMode`'s reach is" (`src/harness/sandbox/fs-boundary.ts`).
 *
 * ADR-0092's rejected-option record forbids **two implementations of this
 * boundary** ("two implementations that can each drift"). The fence's mount
 * layer therefore cannot own the answer privately, and neither may the
 * permission layer compute its own: both read this snapshot, and
 * `fs-boundary-parity.test.ts` pins the snapshot to the argv bwrap actually
 * emits.
 *
 * What this file pins (the derivation + the containment rule):
 *   - `global` → `reachableRoots === null`, i.e. UNBOUNDED: the global tier
 *     stacks no workspace layer, so there is no edge for a call to cross.
 *     `null` (not `[]`) is the load-bearing part — an empty array would claim a
 *     boundary exists and refuse every write.
 *   - `workspace` → exactly the two roots bwrap `--bind`s writable, in
 *     last-mount-wins order (taskRoot then session tmp). `homeRoot` is
 *     deliberately NOT among them: home is `--ro-bind`, so no write can land
 *     there however the fence is read.
 *   - containment is `path.resolve` + separator-boundary comparison, so a
 *     naive prefix read (`/a/bc` vs root `/a/b`) cannot report an escape as
 *     inside.
 *   - absent / empty roots are omitted rather than becoming a `""` root that
 *     would resolve to the cwd.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
  fsBoundaryIsActive,
  fsBoundarySnapshot,
  isRefusedByFsBoundary,
  isWithinFsBoundary,
} from "../../../src/harness/sandbox/fs-boundary.js";
import { createFsPolicy } from "../../../src/harness/sandbox/fs-policy.js";

const ROOT = mkdtempSync(join(tmpdir(), "fs-boundary-unit-"));
const HOME = join(ROOT, "home");
const TASK = join(ROOT, "wave", "root");
const SESSION_TMP = join(ROOT, "session-tmp");

// `createFsPolicy` is a contract root: the tmp dir must exist on disk before the
// policy is built, so the fixtures are created at module load (not in a hook).
// No operator path is read or written.
for (const dir of [HOME, TASK, SESSION_TMP]) {
  mkdirSync(dir, { recursive: true });
}

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

function globalSnapshot(
  mounts: Parameters<typeof fsBoundarySnapshot>[1] = {}
): ReturnType<typeof fsBoundarySnapshot> {
  return fsBoundarySnapshot(
    createFsPolicy({ tmpDir: SESSION_TMP, mode: "global" }),
    mounts
  );
}

function workspaceSnapshot(
  mounts: Parameters<typeof fsBoundarySnapshot>[1] = {}
): ReturnType<typeof fsBoundarySnapshot> {
  return fsBoundarySnapshot(
    createFsPolicy({ tmpDir: SESSION_TMP, mode: "workspace" }),
    mounts
  );
}

describe("fsBoundarySnapshot — the reachable set per tier (ADR-0092)", () => {
  it("global declares unbounded reach (null), not an empty array", () => {
    const snapshot = globalSnapshot({
      homeRoot: HOME,
      workspaceRoot: TASK,
      tmpRoot: SESSION_TMP,
    });
    expect(snapshot.mode).toBe("global");
    expect(snapshot.reachableRoots).toBeNull();
    // An empty array would mean "a boundary exists and nothing is inside it",
    // i.e. every write refused. The global tier stacks no workspace layer, so
    // there is no edge to cross at all.
    expect(fsBoundaryIsActive(snapshot)).toBe(false);
  });

  it("global declares unbounded reach even with no mount inputs at all", () => {
    expect(globalSnapshot().reachableRoots).toBeNull();
  });

  it("workspace declares taskRoot ∪ session tmp, in bwrap last-mount-wins order", () => {
    const snapshot = workspaceSnapshot({
      homeRoot: HOME,
      workspaceRoot: TASK,
      tmpRoot: SESSION_TMP,
    });
    expect(snapshot.mode).toBe("workspace");
    expect(snapshot.reachableRoots).toEqual([TASK, SESSION_TMP]);
    expect(fsBoundaryIsActive(snapshot)).toBe(true);
  });

  it("workspace excludes homeRoot: home is bound read-only, so it is never a write target", () => {
    const snapshot = workspaceSnapshot({
      homeRoot: HOME,
      workspaceRoot: TASK,
      tmpRoot: SESSION_TMP,
    });
    expect(snapshot.reachableRoots).not.toContain(HOME);
    expect(isWithinFsBoundary(`${HOME}/.ssh/config`, snapshot)).toBe(false);
  });

  it("workspace omits an absent or empty root instead of declaring it", () => {
    expect(
      workspaceSnapshot({ homeRoot: HOME, workspaceRoot: TASK }).reachableRoots
    ).toEqual([TASK]);
    expect(
      workspaceSnapshot({ homeRoot: HOME, tmpRoot: SESSION_TMP }).reachableRoots
    ).toEqual([SESSION_TMP]);
    // `bindArgs` drops an empty string; the declaration must drop it too or the
    // two sides disagree about which roots exist.
    expect(
      workspaceSnapshot({ homeRoot: HOME, workspaceRoot: "", tmpRoot: "" })
        .reachableRoots
    ).toEqual([]);
    // An empty reachable set under the workspace tier is still a boundary: every
    // write is outside it. It is NOT a degradation to the global tier's
    // unbounded `null` — bwrap's own home guard is what refuses a workspace
    // fence with no home, and it lives in the argv layer, not here.
    expect(fsBoundaryIsActive(workspaceSnapshot({ homeRoot: HOME }))).toBe(
      true
    );
  });
});

describe("isWithinFsBoundary — containment against the snapshot", () => {
  const snapshot = workspaceSnapshot({
    homeRoot: HOME,
    workspaceRoot: TASK,
    tmpRoot: SESSION_TMP,
  });

  it("accepts a root itself and everything below it", () => {
    expect(isWithinFsBoundary(TASK, snapshot)).toBe(true);
    expect(
      isWithinFsBoundary(`${TASK}/src/harness/sandbox/bwrap.ts`, snapshot)
    ).toBe(true);
    expect(isWithinFsBoundary(`${SESSION_TMP}/scratch.tmp`, snapshot)).toBe(
      true
    );
  });

  it("rejects a sibling whose name merely shares the root's prefix", () => {
    // The escape a naive `startsWith` grants: `/a/bc` is not inside `/a/b`.
    const prefixProbe = fsBoundarySnapshot(
      createFsPolicy({ tmpDir: SESSION_TMP, mode: "workspace" }),
      { homeRoot: HOME, workspaceRoot: "/a/b", tmpRoot: SESSION_TMP }
    );
    expect(isWithinFsBoundary("/a/bc", prefixProbe)).toBe(false);
    expect(isWithinFsBoundary("/a/b", prefixProbe)).toBe(true);
    expect(isWithinFsBoundary("/a/b/", prefixProbe)).toBe(true);
    expect(isWithinFsBoundary("/a/b/../c", prefixProbe)).toBe(false);
  });

  it("resolves the target before comparing (dot segments and trailing slashes)", () => {
    expect(isWithinFsBoundary(`${TASK}/src/../lib`, snapshot)).toBe(true);
    expect(isWithinFsBoundary(`${TASK}/`, snapshot)).toBe(true);
    expect(isWithinFsBoundary(`${HOME}/wave/root-secrets`, snapshot)).toBe(
      false
    );
  });

  it("is always true under global, whatever the path", () => {
    const unbounded = globalSnapshot({
      homeRoot: HOME,
      workspaceRoot: TASK,
      tmpRoot: SESSION_TMP,
    });
    expect(isWithinFsBoundary("/etc/shadow", unbounded)).toBe(true);
    expect(isWithinFsBoundary(`${HOME}/.ssh/id_rsa`, unbounded)).toBe(true);
  });

  it("treats the filesystem root as a boundary root that contains every absolute path", () => {
    const rootReachable = workspaceSnapshot({
      homeRoot: HOME,
      workspaceRoot: "/",
    });
    expect(isWithinFsBoundary("/etc/hosts", rootReachable)).toBe(true);
  });
});

/**
 * The refusal geometry — the question ADR-0140's boundary ask actually asks.
 *
 * Measured on the real fence: the workspace tier emits `--bind / /` and then
 * ro-binds over it, so the declared writable set is a WHITELIST OVERLAY and
 * "outside the declaration" is NOT "the fence refuses". A predicate built on the
 * complement would prompt the operator about writes that succeed.
 */
describe("isRefusedByFsBoundary — would the FENCE refuse this write?", () => {
  const mounts = { homeRoot: HOME, workspaceRoot: TASK, tmpRoot: SESSION_TMP };

  it("refuses a write into home, which the workspace tier ro-binds", () => {
    expect(
      isRefusedByFsBoundary(
        `${HOME}/notes.txt`,
        workspaceSnapshot(mounts),
        mounts
      )
    ).toBe(true);
  });

  it("refuses a write into a read-only system prefix", () => {
    expect(
      isRefusedByFsBoundary(
        "/usr/local/bin/x",
        workspaceSnapshot(mounts),
        mounts
      )
    ).toBe(true);
    expect(
      isRefusedByFsBoundary("/etc/hosts", workspaceSnapshot(mounts), mounts)
    ).toBe(true);
  });

  it("refuses NOTHING under the global tier: there is no workspace edge to cross", () => {
    const unbounded = globalSnapshot(mounts);
    expect(isRefusedByFsBoundary(`${HOME}/notes.txt`, unbounded, mounts)).toBe(
      false
    );
    expect(isRefusedByFsBoundary("/etc/hosts", unbounded, mounts)).toBe(false);
  });

  it("does NOT refuse the writable roots themselves", () => {
    const snapshot = workspaceSnapshot(mounts);
    expect(
      isRefusedByFsBoundary(`${TASK}/src/index.ts`, snapshot, mounts)
    ).toBe(false);
    expect(
      isRefusedByFsBoundary(`${SESSION_TMP}/scratch`, snapshot, mounts)
    ).toBe(false);
  });

  // The regression that justifies this function existing at all: these three are
  // OUTSIDE the declared whitelist yet the fence writes them successfully,
  // because the `/` substrate underneath is writable.
  it("does NOT refuse an out-of-whitelist path the fence still permits", () => {
    const snapshot = workspaceSnapshot(mounts);
    expect(isWithinFsBoundary("/tmp/scratch", snapshot)).toBe(false);
    expect(isRefusedByFsBoundary("/tmp/scratch", snapshot, mounts)).toBe(false);
    expect(isWithinFsBoundary("/var/tmp/x", snapshot)).toBe(false);
    expect(isRefusedByFsBoundary("/var/tmp/x", snapshot, mounts)).toBe(false);
    expect(isWithinFsBoundary("/dev/shm/x", snapshot)).toBe(false);
    expect(isRefusedByFsBoundary("/dev/shm/x", snapshot, mounts)).toBe(false);
  });

  it("resolves both sides, so a traversal out of a writable root is not excused", () => {
    const snapshot = workspaceSnapshot(mounts);
    // A traversal that lands back inside a writable root is still permitted...
    expect(
      isRefusedByFsBoundary(`${TASK}/src/../lib/x.ts`, snapshot, mounts)
    ).toBe(false);
    // ...but one that climbs OUT of it into the read-only home is not excused by
    // the root it was spelled under.
    expect(
      isRefusedByFsBoundary(`${TASK}/../../home/notes.txt`, snapshot, mounts)
    ).toBe(true);
    expect(
      isRefusedByFsBoundary(`${HOME}/wave/../notes.txt`, snapshot, mounts)
    ).toBe(true);
  });
});
