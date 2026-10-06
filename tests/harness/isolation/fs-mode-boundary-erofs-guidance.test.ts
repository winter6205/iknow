/**
 * The fs-MODE boundary refusal arm — the third `[fs_denied]` template, added by
 * ADR-0140. Today a write that left what the current `fsMode` permits reaches
 * the kernel as a bare EROFS and the model gets no boundary attribution at all;
 * this arm is the message that names the crossing instead.
 *
 * Why it is a separate template and not a fourth wording of the protected-target
 * one: the protected-target arm's truth condition is PERMANENT (physical,
 * unconditional, no route), and the mode boundary's is TEMPORARY and ANSWERABLE
 * (the operator is asked about that one call). Reusing the permanent sentences
 * would tell the model "there is no narrower spelling to try" about a condition
 * the operator can widen. specs/effect-boundary-protection.md's 2026-10-06
 * amendment states the rule: two refusals, one typed prefix, no shared sentence.
 *
 * The conservatism is the load-bearing part of this file: an EROFS that does
 * not resolve to a protected class has MANY innocent causes (a read-only host
 * filesystem, a read-only system prefix, an unrelated failure that merely
 * mentions the marker), so the arm fires only on a positively identified
 * crossing — a non-protected path inside one of the tier's read-only roots and
 * outside every writable root. Everything else is `undefined`, which is today's
 * behaviour: the result stays byte-identical.
 *
 * Real-bwrap cases live at the bottom behind the capability probe (never the
 * `bwrap --version` existence check — see tests/_helpers/bwrap-capability.ts).
 * Every fixture is a mkdtemp scratch root with `HOME` redirected into it; the
 * operator's real home, `~/.ssh`, `~/.aws` are never read or written.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { createBwrapFence } from "../../../src/harness/sandbox/bwrap.js";
import {
  fsBoundarySnapshot,
  isWithinFsBoundary,
} from "../../../src/harness/sandbox/fs-boundary.js";
import { createFsPolicy } from "../../../src/harness/sandbox/fs-policy.js";
import { createProtectedTargetInventory } from "../../../src/harness/sandbox/protected-targets.js";
import {
  modeBoundaryErofsGuidance,
  modeBoundaryFenceGuidance,
  type FsModeBoundary,
} from "../../../src/harness/sandbox/protected-target-feedback.js";
import { VIOLATION_PREFIXES } from "../../../src/harness/permission/prefixes.js";

import { canRunBwrapFence } from "../../_helpers/bwrap-capability.js";

const HOME = "/home/u";
/** The inventory refuses an absent / non-directory scan root at assembly, so
 *  the scope is a scratch dir these fictional `/home/u` paths never touch. */
const SCAN_ROOT = mkdtempSync(join(tmpdir(), "iknow-mode-scan-"));
const INVENTORY = createProtectedTargetInventory({
  home: HOME,
  scanRoot: SCAN_ROOT,
});

const TASK_ROOT = "/workspace/task";
const SESSION_TMP = "/tmp/iknow-session";
/** The workspace tier: home visible but read-only, writes = task root + tmp. */
const WORKSPACE_TIER: FsModeBoundary = {
  mode: "workspace",
  readOnlyRoots: [HOME],
  writableRoots: [TASK_ROOT, SESSION_TMP],
};

const OUT_OF_TIER =
  "touch: cannot touch '/home/u/notes.txt': Read-only file system";

afterAll(() => rmSync(SCAN_ROOT, { recursive: true, force: true }));

describe("modeBoundaryErofsGuidance — what the copy must and must not say", () => {
  it("carries the typed prefix, the crossing statement, and the narrower route", () => {
    const copy = modeBoundaryErofsGuidance(OUT_OF_TIER, WORKSPACE_TIER)!;
    expect(copy.startsWith(`${VIOLATION_PREFIXES.fsDenied} `)).toBe(true);
    // the target CLASS of this boundary: a location outside the tier's reach
    expect(copy).toContain(
      "left what this session's filesystem isolation tier permits"
    );
    // the attribution: the tier's own ro-bind, not a protected mount
    expect(copy).toContain("mounts that region read-only");
    // the answerable half — the sentence the protected arms do NOT carry
    expect(copy).toContain("a narrower destination can still work");
    // the reachable roots are named, so the model has somewhere to go
    expect(copy).toContain(TASK_ROOT);
    expect(copy).toContain(SESSION_TMP);
  });

  it("claims NO permanence and NO protected-target status", () => {
    const copy = modeBoundaryErofsGuidance(OUT_OF_TIER, WORKSPACE_TIER)!;
    for (const forbidden of [
      "stays read-only for the whole session",
      "is not an operation this session can perform",
      "re-spelling the command will not help",
      "cannot remove",
      "at all",
      "protected target",
      "worktree",
    ]) {
      expect(copy).not.toContain(forbidden);
    }
  });

  it("uses the same cap-and-count discipline with its OWN remainder marker", () => {
    const many = Array.from(
      { length: 7 },
      (_, i) => `touch: cannot touch '/home/u/n${i}.txt': Read-only file system`
    ).join("\n");
    const copy = modeBoundaryErofsGuidance(many, WORKSPACE_TIER)!;
    expect(copy).toContain("n4");
    expect(copy).not.toContain("n5");
    expect(copy).toContain("(+2 more out-of-tier EROFS lines)");
    const five = many.split("\n").slice(0, 5).join("\n");
    expect(modeBoundaryErofsGuidance(five, WORKSPACE_TIER)).not.toContain(
      "more out-of-tier EROFS lines"
    );
  });

  it("a stderr with no EROFS line yields undefined (today's byte-identical result)", () => {
    expect(
      modeBoundaryErofsGuidance(
        "rm: cannot remove '/tmp/x': No such file",
        WORKSPACE_TIER
      )
    ).toBeUndefined();
    expect(modeBoundaryErofsGuidance("", WORKSPACE_TIER)).toBeUndefined();
  });

  it("carries NO effect-safety vocabulary (the boundary-refusal copy rule)", () => {
    // The same rule tests/harness/permission/boundary-refusal-copy.test.ts
    // applies to the EROFS copy. That file's enumeration DOES reach this arm,
    // and the rule is applied to the new template here too — belt and braces,
    // so the guarantee holds from both sides rather than by assumption.
    const copy = modeBoundaryErofsGuidance(OUT_OF_TIER, WORKSPACE_TIER)!;
    expect(copy).not.toMatch(
      /\b(safe|safely|clean|cleanly|passed|harmless|benign)\b/i
    );
  });
});

describe("modeBoundaryFenceGuidance — a crossing only", () => {
  it("a non-protected path inside the tier's read-only root, outside the writable roots → fires", () => {
    const copy = modeBoundaryFenceGuidance(
      OUT_OF_TIER,
      INVENTORY,
      WORKSPACE_TIER
    )!;
    expect(copy).toContain("filesystem isolation tier");
  });

  it("a path INSIDE a writable root → undefined (the tier permits it; this is not a crossing)", () => {
    expect(
      modeBoundaryFenceGuidance(
        "touch: cannot touch '/workspace/task/f.txt': Read-only file system",
        INVENTORY,
        WORKSPACE_TIER
      )
    ).toBeUndefined();
    expect(
      modeBoundaryFenceGuidance(
        "touch: cannot touch '/tmp/iknow-session/f.txt': Read-only file system",
        INVENTORY,
        WORKSPACE_TIER
      )
    ).toBeUndefined();
  });

  it("a path outside every read-only root → undefined (not this tier's refusal)", () => {
    // `/opt` is a host read-only prefix the fence mounts ro in BOTH tiers; it
    // is not the fs-mode boundary, so naming it here would be a fabrication.
    expect(
      modeBoundaryFenceGuidance(
        "touch: cannot touch '/opt/tool/data.bin': Read-only file system",
        INVENTORY,
        WORKSPACE_TIER
      )
    ).toBeUndefined();
  });

  it("a PROTECTED path → undefined here (the protected-target arm owns it)", () => {
    // `~/.ssh/id_ed25519` is inside the tier's read-only root too, so only the
    // protected-class exclusion keeps the two arms from both speaking for one
    // refusal.
    expect(
      modeBoundaryFenceGuidance(
        "rm: cannot remove '/home/u/.ssh/id_ed25519': Read-only file system",
        INVENTORY,
        WORKSPACE_TIER
      )
    ).toBeUndefined();
  });

  it("an EROFS with no parseable path → undefined (no guessing)", () => {
    expect(
      modeBoundaryFenceGuidance(
        "bash: some other failure: Read-only file system",
        INVENTORY,
        WORKSPACE_TIER
      )
    ).toBeUndefined();
  });

  it("a GLOBAL tier has no read-only root to cross → undefined for every EROFS", () => {
    // Global mode is host-read-write below the protected layer, so an EROFS
    // there is never a mode-boundary crossing. Firing would relabel a host
    // condition as a session decision.
    const globalTier: FsModeBoundary = {
      mode: "global",
      readOnlyRoots: [],
      writableRoots: ["/"],
    };
    expect(
      modeBoundaryFenceGuidance(OUT_OF_TIER, INVENTORY, globalTier)
    ).toBeUndefined();
  });

  it("a path that TRAVERSES out of a writable root is classified by its resolved target, so the crossing fires", () => {
    // `/workspace/task/../../home/u/notes.txt` resolves to `/home/u/notes.txt`:
    // a real escape out of the writable task root and into the tier's read-only
    // root, spelled the way a shell-built stderr line carries it. A prefix test
    // on the unresolved spelling ("starts with /workspace/task/") answers
    // "inside a writable root" and the arm stays silent on an escape — the
    // second containment implementation ADR-0092's rejected-option record
    // rules out. Containment has exactly one authority: `isWithinFsBoundary`.
    const traversal = "/workspace/task/../../home/u/notes.txt";
    expect(resolve(traversal)).toBe("/home/u/notes.txt");
    expect(
      isWithinFsBoundary(
        traversal,
        fsBoundarySnapshot(
          createFsPolicy({ tmpDir: SCAN_ROOT, mode: "workspace" }),
          { workspaceRoot: TASK_ROOT, tmpRoot: SCAN_ROOT }
        )
      )
    ).toBe(false);
    expect(
      modeBoundaryFenceGuidance(
        `touch: cannot touch '${traversal}': Read-only file system`,
        INVENTORY,
        WORKSPACE_TIER
      )
    ).toBeDefined();
  });

  it("python and tee spellings of the same crossing resolve too", () => {
    expect(
      modeBoundaryFenceGuidance(
        "OSError: [Errno 30] Read-only file system: '/home/u/notes.txt'",
        INVENTORY,
        WORKSPACE_TIER
      )
    ).toBeDefined();
    expect(
      modeBoundaryFenceGuidance(
        "tee: /home/u/notes.txt: Read-only file system",
        INVENTORY,
        WORKSPACE_TIER
      )
    ).toBeDefined();
  });
});

/* ------------------------------------------------------------------ *
 * Real-bwrap: the refusal half of T3 class (c). The boundary being
 * changed is a kernel refusal, so an offline fixture cannot witness it —
 * only a real fence produces the EROFS the arm reads.
 * ------------------------------------------------------------------ */

/**
 * Capability gate, not `bwrap --version`: the cases below really spawn the
 * production fence argv (constant `--unshare-net`), so the question is whether
 * a fence can start HERE. A host with the binary but no user-namespace passes
 * an existence check and then refuses the spawn.
 */
const SKIP = !canRunBwrapFence();

const scratch: string[] = [];
function scratchDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(d);
  return d;
}

const R_HOME = scratchDir("iknow-mode-home-");
const R_TASK = scratchDir("iknow-mode-task-");
const R_TMP = scratchDir("iknow-mode-tmp-");
/** Inside the tier's read-only root (home) and outside both writable roots. */
const R_OUT_OF_TIER = join(R_HOME, "notes.txt");

const R_INVENTORY = createProtectedTargetInventory({
  home: R_HOME,
  scanRoot: R_TASK,
});
const R_TIER: FsModeBoundary = {
  mode: "workspace",
  readOnlyRoots: [R_HOME],
  writableRoots: [R_TASK, R_TMP],
};

/** Assemble the production fence at the workspace tier and run a script in it. */
function runFence(script: string): {
  r: { status: number | null; stdout: string; stderr: string };
} {
  const fence = createBwrapFence({
    command: "bash",
    args: ["-c", script],
    fsPolicy: createFsPolicy({ tmpDir: R_TMP, mode: "workspace" }),
    env: { HOME: R_HOME, PATH: "/usr/bin:/bin" },
    cwd: R_TASK,
    // ADR-0092 workspace tier: home ro-bind + the two writable whitelists.
    homeRoot: R_HOME,
    workspaceRoot: R_TASK,
    tmpRoot: R_TMP,
    protectedTargets: R_INVENTORY,
    protectCredentialReads: true,
    onProtectedTargetSkipped: () => {},
  });
  const r = spawnSync(fence.argv[0]!, fence.argv.slice(1), {
    encoding: "utf8",
  });
  return {
    r: { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" },
  };
}

afterAll(() => {
  for (const p of scratch.splice(0))
    rmSync(p, { recursive: true, force: true });
});

describe("real bwrap — the workspace tier refuses an out-of-tier write", () => {
  it.skipIf(SKIP)(
    "the kernel EROFS, the host file is NOT created, and the arm fires on the real stderr",
    () => {
      const { r } = runFence(`touch '${R_OUT_OF_TIER}'`);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain("Read-only file system");
      // the refusal is real: nothing was written on the host either
      expect(existsSync(R_OUT_OF_TIER)).toBe(false);
      const copy = modeBoundaryFenceGuidance(r.stderr, R_INVENTORY, R_TIER)!;
      expect(copy).toContain(
        "left what this session's filesystem isolation tier permits"
      );
      // and the protected-target arm stays silent on a non-protected path
      expect(copy).not.toContain("an SSH private key");
    }
  );

  it.skipIf(SKIP)(
    "CONTROL: a write inside a writable root succeeds → no refusal, no message",
    () => {
      const { r } = runFence(`touch '${join(R_TASK, "ok.txt")}'`);
      expect(r.status).toBe(0);
      expect(r.stderr).not.toContain("Read-only file system");
      expect(
        modeBoundaryFenceGuidance(r.stderr, R_INVENTORY, R_TIER)
      ).toBeUndefined();
    }
  );
});
