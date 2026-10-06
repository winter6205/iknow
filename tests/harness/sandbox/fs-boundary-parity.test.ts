/**
 * ADR-0092's rejected-option record / ADR-0140 §2 reason 3 — the **parity
 * probe** between the declared boundary and the fence that enforces it.
 *
 * The drift class this file exists to kill: `fs-boundary.ts` declares what the
 * current tier's reach is, and `bwrap.ts` mounts the fence. They are two
 * readers of one fact, and nothing in the type system connects them — so a
 * later edit to either side (a third writable root in the fence, a root dropped
 * from the declaration) would leave both green while the permission layer asks
 * the operator a question about a boundary the kernel does not have. ADR-0092
 * rejected implementing this boundary in two places precisely because "two
 * implementations that can each drift".
 *
 * The assertion is mechanical, not restated: the roots bwrap ACTUALLY emits as
 * writable `--bind` triples in the workspace segment must equal the declared
 * `reachableRoots`, in order. Global is the other direction — the declaration is
 * `null` (unbounded) and the fence's only writable mount is the host-root base
 * bind, which is what makes "unbounded" true rather than merely asserted.
 *
 * No bwrap binary and no host namespace: `createBwrapFence` is a pure argv
 * factory, so this file runs in both CI jobs.
 *
 * Home is checked as a *third* fact rather than a second: it must be a
 * `--ro-bind` triple and must NOT appear in `reachableRoots`. The two concerns
 * are deliberately separate (the declaration is where a write can land; home is
 * where a read can land), and folding home into the reachable set would make
 * the argv's home layer look like a writable root.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { createBwrapFence } from "../../../src/harness/sandbox/bwrap.js";
import {
  fsBoundaryIsActive,
  fsBoundarySnapshot,
  isWithinFsBoundary,
  type FsBoundaryMounts,
} from "../../../src/harness/sandbox/fs-boundary.js";
import { createFsPolicy } from "../../../src/harness/sandbox/fs-policy.js";
import type { FsIsolationMode } from "../../../src/harness/sandbox/fs-mode.js";
import { fsModeFeedbackBoundary } from "../../../src/harness/sandbox/protected-target-feedback.js";

const ROOT = mkdtempSync(join(tmpdir(), "fs-boundary-parity-"));
const TASK = join(ROOT, "task");
const SESSION_TMP = join(ROOT, "session-tmp");
const HOME = join(ROOT, "home");

// Module load, not a hook: `createFsPolicy` is a contract root and the snapshot
// helpers below build one per call.
for (const dir of [TASK, SESSION_TMP, HOME]) {
  mkdirSync(dir, { recursive: true });
}

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

/**
 * The minimal fence for one tier: no egress seam, no unbound fence, no cwd
 * read-only override, no protected inventory. Every writable `--bind` in the
 * result is then a workspace-segment mount or the host-root base, so the
 * comparison below is not diluted by segments the boundary does not own.
 */
function fenceArgv(mode: FsIsolationMode): readonly string[] {
  return createBwrapFence({
    command: "bash",
    args: ["-c", "true"],
    fsPolicy: createFsPolicy({ tmpDir: SESSION_TMP, mode }),
    env: { PATH: "/bin" },
    cwd: TASK,
    ...(mode === "workspace"
      ? { homeRoot: HOME, workspaceRoot: TASK, tmpRoot: SESSION_TMP }
      : {}),
  }).argv;
}

/** Writable bind sources bwrap emits, as `src` (every workspace bind is src===dest). */
function writableBindSources(argv: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--bind") {
      const src = argv[i + 1];
      if (src !== undefined) out.push(src);
      i += 2;
    }
  }
  return out;
}

function snapshotFor(mode: FsIsolationMode) {
  return fsBoundarySnapshot(createFsPolicy({ tmpDir: SESSION_TMP, mode }), {
    homeRoot: mode === "workspace" ? HOME : undefined,
    workspaceRoot: mode === "workspace" ? TASK : undefined,
    tmpRoot: mode === "workspace" ? SESSION_TMP : undefined,
  });
}

/** The same mounts `fenceArgv` spreads into the fence — one object, two readers. */
function mountsFor(mode: FsIsolationMode): FsBoundaryMounts {
  return mode === "workspace"
    ? { homeRoot: HOME, workspaceRoot: TASK, tmpRoot: SESSION_TMP }
    : {};
}

/** The fs-mode boundary arm's geometry for one tier, as the bash tool derives it. */
function feedbackBoundaryFor(mode: FsIsolationMode) {
  return fsModeFeedbackBoundary(
    createFsPolicy({ tmpDir: SESSION_TMP, mode }),
    mountsFor(mode)
  );
}

/** The home layer's ro-bind source on argv, or undefined when the fence emits
 *  none (the global tier never stacks it). */
function homeRoBindSource(argv: readonly string[]): string | undefined {
  return tripleIdx(argv, "--ro-bind", HOME) >= 0 ? HOME : undefined;
}

function tripleIdx(
  argv: readonly string[],
  verb: string,
  target: string
): number {
  return argv.findIndex(
    (arg, i) => arg === verb && argv[i + 1] === target && argv[i + 2] === target
  );
}

describe("every writable whitelist bwrap emits is a declared reachable root (declared ⊇ emitted, minus the `/` substrate)", () => {
  it("workspace: every non-base writable --bind is a declared reachable root, in order", () => {
    const argv = fenceArgv("workspace");
    const declared = snapshotFor("workspace").reachableRoots;
    expect(declared).not.toBeNull();
    // The host-root base bind is the fence's substrate, not a workspace
    // whitelisted root: dropping it from the argv makes the sandbox see an
    // empty filesystem, which is not a shape this test may bless.
    const emitted = writableBindSources(argv).filter((src) => src !== "/");
    expect(emitted).toEqual([...declared!]);
    // And the order bwrap mounts in is the order the declaration lists, so the
    // last-mount-wins tier cannot be assembled in reverse.
    const workspaceIdx = emitted.map((src) => tripleIdx(argv, "--bind", src));
    expect(workspaceIdx).toEqual([...workspaceIdx].sort((a, b) => a - b));
  });

  it("global: declaration is unbounded, and the fence's only writable mount is the host root", () => {
    const argv = fenceArgv("global");
    const snapshot = snapshotFor("global");
    expect(snapshot.reachableRoots).toBeNull();
    expect(fsBoundaryIsActive(snapshot)).toBe(false);
    // The mirror of `null`: nothing is re-covered writable, because the base
    // `/` bind already is. A global fence that grew a workspace-style writable
    // bind would make "unbounded" a declaration with no fence behind it.
    expect(writableBindSources(argv)).toEqual(["/"]);
  });

  it("global: no declared root exists, so every target is inside the boundary", () => {
    const snapshot = snapshotFor("global");
    for (const target of [
      "/",
      TASK,
      SESSION_TMP,
      `${HOME}/.ssh/id_rsa`,
      "/etc/shadow",
    ]) {
      expect(isWithinFsBoundary(target, snapshot)).toBe(true);
    }
  });

  it("home is a ro-bind on argv and absent from the reachable set, in both tiers", () => {
    for (const mode of ["global", "workspace"] as const) {
      const argv = fenceArgv(mode);
      const declared = snapshotFor(mode).reachableRoots ?? [];
      if (mode === "workspace") {
        expect(tripleIdx(argv, "--ro-bind", HOME)).toBeGreaterThanOrEqual(0);
        expect(declared).not.toContain(HOME);
      } else {
        // Global never emits the home layer, and declares no roots at all, so
        // "home is writable" is a consequence of the base bind rather than a
        // fact some second implementation has to keep in step.
        expect(declared).toEqual([]);
        expect(tripleIdx(argv, "--ro-bind", HOME)).toBe(-1);
      }
    }
  });

  it("every workspace-segment writable bind is inside the declared reach, and home is not", () => {
    // The direction the permission layer's future boundary question depends on
    // (ADR-0140 §2): a target the fence re-covers writable must be inside the
    // declared reach, or the operator would be asked about a crossing the kernel
    // never sees. Sampled from the emitted argv, not from the inputs.
    //
    // The host-root `--bind / /` substrate is excluded and is NOT a hole in the
    // declaration: ADR-0092's workspace tier tightens home writes only, so the
    // declaration is the set of roots the tier re-covers on top of that
    // substrate — not a full model of kernel reachability. Home is the one
    // subtree the tier takes back, which is exactly why the home ro-bind layer
    // and the reachable set are two separate facts.
    const snapshot = snapshotFor("workspace");
    const workspaceSegment = writableBindSources(fenceArgv("workspace")).filter(
      (src) => src !== "/"
    );
    expect(workspaceSegment.length).toBeGreaterThan(0);
    for (const src of workspaceSegment) {
      expect(isWithinFsBoundary(src, snapshot)).toBe(true);
    }
    expect(isWithinFsBoundary(HOME, snapshot)).toBe(false);
    // The substrate the tier builds on is writable in BOTH tiers, which is why
    // global's declaration is `null` rather than a list of two.
    expect(writableBindSources(fenceArgv("global"))).toContain("/");
  });
});

/**
 * The SECOND reader of the same fact: the `[fs_denied]` fs-mode arm classifies
 * an EROFS path against `FsModeBoundary`, and its copy names the writable roots
 * to the model. If that geometry were hand-listed at the call site it would be
 * a second declaration of "what the tier permits" with nothing to catch it
 * drifting — which is exactly the failure ADR-0092's rejected-option record
 * rules out. These cases read the argv and the geometry the tool derives from
 * the same mounts and require them to agree, tier by tier.
 */
describe("the fs-mode feedback arm's geometry ≡ the fence that enforces it", () => {
  it("workspace: writableRoots are the emitted workspace binds; readOnlyRoots is the emitted home ro-bind", () => {
    const argv = fenceArgv("workspace");
    const boundary = feedbackBoundaryFor("workspace");
    expect(boundary.mode).toBe("workspace");
    // Emitted, not declared: a workspace tier that grows a third writable
    // whitelist changes the argv here and the arm's roots with it.
    expect(boundary.writableRoots).toEqual(
      writableBindSources(argv).filter((src) => src !== "/")
    );
    const home = homeRoBindSource(argv);
    expect(boundary.readOnlyRoots).toEqual(home === undefined ? [] : [home]);
  });

  it("global: no read-only root and no re-covered writable root, matching the argv", () => {
    const argv = fenceArgv("global");
    const boundary = feedbackBoundaryFor("global");
    expect(boundary.mode).toBe("global");
    expect(boundary.writableRoots).toEqual(
      writableBindSources(argv).filter((src) => src !== "/")
    );
    expect(homeRoBindSource(argv)).toBeUndefined();
    expect(boundary.readOnlyRoots).toEqual([]);
  });

  it("readOnlyRoots is NOT the reachable set's complement — the host's ro prefixes are not session crossings", () => {
    // The reason the arm cannot derive readOnlyRoots as "everything the tier
    // does not re-cover writable": `/etc` and `/usr` are read-only under BOTH
    // tiers, so a complement would make every read-only system prefix read as
    // an operator-answerable session decision. Only the one root the tier takes
    // back — home — belongs in the list.
    const snapshot = snapshotFor("workspace");
    for (const systemPrefix of ["/etc", "/usr", "/opt"]) {
      expect(isWithinFsBoundary(systemPrefix, snapshot)).toBe(false);
      expect(feedbackBoundaryFor("workspace").readOnlyRoots).not.toContain(
        systemPrefix
      );
    }
    expect(isWithinFsBoundary(HOME, snapshot)).toBe(false);
    expect(feedbackBoundaryFor("workspace").readOnlyRoots).toContain(HOME);
  });

  it("a traversal spelling is placed by its resolved target, not by a writable-root prefix", () => {
    // The containment authority behind the arm: the boundary arm routes every
    // classification through `isWithinFsBoundary`, so a path that leaves a
    // writable root by `..` is outside it. A prefix test on the unresolved
    // spelling would report the opposite and silence the arm on the escape.
    const traversal = `${TASK}/../${HOME.slice(1)}/notes.txt`;
    expect(isWithinFsBoundary(traversal, snapshotFor("workspace"))).toBe(false);
  });
});
