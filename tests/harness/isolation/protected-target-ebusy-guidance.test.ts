/**
 * The EBUSY arm of the protected-target boundary refusal — the second
 * template beside the EROFS arm, for the refusal subclass the EROFS trigger
 * cannot see.
 *
 * Physics being covered: a credential masked as an EXACT file
 * (`--ro-bind /dev/null <file>`) becomes a MOUNT POINT under an otherwise
 * writable parent. `unlink` on a mount point returns EBUSY, not EROFS, so the
 * EROFS template never fires for it. The refusal itself is truthful; what was
 * missing is the target-class / boundary attribution.
 *
 * The contract this file pins:
 *   1. EBUSY fires ONLY on paths the fence actually masked for THAT assembly.
 *      "Device or resource busy" is a generic host errno (a CD-ROM, an
 *      overlay, a loopback mount all produce it) — an uncorrelated trigger
 *      would relabel unrelated execution failures as boundary violations.
 *   2. Unmatched EBUSY and all other stderr stay byte-identical (`undefined`).
 *   3. The EBUSY wording is DISTINCT from the EROFS wording — a separate
 *      function, no shared sentence, no shared constant. Both directions
 *      pinned here.
 *   4. The copy states the session cannot remove the target at all, and
 *      advertises NO receipt / claim / cleanup-window route (the withdrawn
 *      mechanism — advertising one would be untruthful guidance).
 *
 * Real-bwrap cases live at the bottom; every fixture is a mkdtemp scratch root
 * with `HOME` redirected into it. The operator's real `~/.ssh`, `~/.aws`,
 * `~/.gnupg`, `/etc/shadow` are never read or written, and no credential value
 * is ever printed.
 */
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createBwrapFence } from "../../../src/harness/sandbox/bwrap.js";
import { createFsPolicy } from "../../../src/harness/sandbox/fs-policy.js";
import { createProtectedTargetInventory } from "../../../src/harness/sandbox/protected-targets.js";
import {
  describeProtectedTargetClass,
  modeBoundaryFenceGuidance,
  protectedTargetEbusyFenceGuidance,
  protectedTargetEbusyGuidance,
  protectedTargetFenceGuidance,
  type FsModeBoundary,
} from "../../../src/harness/sandbox/protected-target-feedback.js";
import { VIOLATION_PREFIXES } from "../../../src/harness/permission/prefixes.js";

import { canRunBwrapFence } from "../../_helpers/bwrap-capability.js";

const HOME = "/home/u";
/**
 * The name-pattern scan scope must be a REAL directory — the inventory refuses
 * an absent or non-directory root at assembly rather than assembling a fence
 * whose name arm matched nothing. These cases classify fictional `/home/u`
 * paths, so the scope is a scratch dir none of them reads.
 */
const SCAN_ROOT = mkdtempSync(join(tmpdir(), "iknow-ebusy-scan-"));
const INVENTORY = createProtectedTargetInventory({
  home: HOME,
  scanRoot: SCAN_ROOT,
});
/** An exact-file credential arm — masked as `/dev/null` AT the file. */
const NETRC = join(HOME, ".netrc");
/** A subtree credential arm — its interior files are masked individually too. */
const SSH_KEY = join(HOME, ".ssh", "id_ed25519");

const NETRC_RM = `rm: cannot remove '${NETRC}': Device or resource busy`;
const SSH_RM = `rm: cannot remove '${SSH_KEY}': Device or resource busy`;
/** A host EBUSY with nothing to do with any mask: an unrelated device refusal. */
const UNRELATED_BUSY =
  "umount: /mnt/cdrom: Device or resource busy\n" +
  "losetup: /dev/loop7: Device or resource busy";

describe("protectedTargetEbusyFenceGuidance — correlation against emitted masks", () => {
  it("an EBUSY naming an emitted exact-file mask → class + boundary attribution, no route advertised", () => {
    const guidance = protectedTargetEbusyFenceGuidance(NETRC_RM, INVENTORY, [
      NETRC,
    ])!;
    expect(guidance).toBeDefined();
    expect(guidance.startsWith(`${VIOLATION_PREFIXES.fsDenied} `)).toBe(true);
    // target CLASS named from the inventory, never a bare path
    expect(guidance).toContain(
      describeProtectedTargetClass("netrc_credential")
    );
    // boundary attribution, distinct from the EROFS physics
    expect(guidance).toContain("kernel (EBUSY)");
    expect(guidance).toContain("not a command-syntax judgment");
    expect(guidance).toContain("re-spelling the command will not help");
    // the unconditional "cannot remove at all" statement (issue #1159 revision)
    expect(guidance).toContain("cannot remove");
    expect(guidance).toContain("at all");
    // NO receipt / cleanup route is advertised anywhere in the copy
    for (const banned of [
      "receipt",
      "Receipt",
      "authorization",
      "cleanup",
      "window",
      "claim",
    ]) {
      expect(guidance).not.toContain(banned);
    }
  });

  it("an EBUSY naming a path the fence did NOT mask → undefined (no fabricated class)", () => {
    // protected path, but this assembly masked only the netrc
    expect(
      protectedTargetEbusyFenceGuidance(SSH_RM, INVENTORY, [NETRC])
    ).toBeUndefined();
    // not a protected path at all, even when "masked" — inventory resolution
    // is the second gate, so an unknown path never gets a guessed class
    expect(
      protectedTargetEbusyFenceGuidance(
        "rm: cannot remove '/tmp/x': Device or resource busy",
        INVENTORY,
        ["/tmp/x"]
      )
    ).toBeUndefined();
  });

  it("an EMPTY emitted-mask list can never fire — even on a fully masked stderr", () => {
    // the yolo shape (fence retired, no masks) and the "mask off" shape
    expect(
      protectedTargetEbusyFenceGuidance(NETRC_RM, INVENTORY, [])
    ).toBeUndefined();
    expect(
      protectedTargetEbusyFenceGuidance(`${NETRC_RM}\n${SSH_RM}`, INVENTORY, [])
    ).toBeUndefined();
  });

  it("a subtree-seeded mask resolves its class too (not only `exact` rules)", () => {
    // The fence masks individual regular files INSIDE credential subtrees —
    // a list built from `exact` rules only would miss the majority.
    const guidance = protectedTargetEbusyFenceGuidance(SSH_RM, INVENTORY, [
      SSH_KEY,
    ])!;
    expect(guidance).toContain(
      describeProtectedTargetClass("ssh_key_material")
    );
  });

  it("an unrelated EBUSY (no parseable path) → undefined", () => {
    expect(
      protectedTargetEbusyFenceGuidance(UNRELATED_BUSY, INVENTORY, [NETRC])
    ).toBeUndefined();
    expect(
      protectedTargetEbusyFenceGuidance("", INVENTORY, [NETRC])
    ).toBeUndefined();
  });

  it("python OSError shape (quoted path AFTER the marker) correlates too", () => {
    const guidance = protectedTargetEbusyFenceGuidance(
      `OSError: [Errno 16] Device or resource busy: '${NETRC}'`,
      INVENTORY,
      [NETRC]
    )!;
    expect(guidance).toContain(
      describeProtectedTargetClass("netrc_credential")
    );
  });

  it("unquoted absolute path shape correlates too", () => {
    const guidance = protectedTargetEbusyFenceGuidance(
      `tee: ${NETRC}: Device or resource busy`,
      INVENTORY,
      [NETRC]
    )!;
    expect(guidance).toContain(
      describeProtectedTargetClass("netrc_credential")
    );
  });

  it("two masked classes in one stderr → one [fs_denied] message per class", () => {
    const guidance = protectedTargetEbusyFenceGuidance(
      `${NETRC_RM}\n${SSH_RM}`,
      INVENTORY,
      [NETRC, SSH_KEY]
    )!;
    const messages = guidance.split("\n");
    expect(messages).toHaveLength(2);
    for (const m of messages) {
      expect(m.startsWith(`${VIOLATION_PREFIXES.fsDenied} `)).toBe(true);
    }
    expect(guidance).toContain(
      describeProtectedTargetClass("netrc_credential")
    );
    expect(guidance).toContain(
      describeProtectedTargetClass("ssh_key_material")
    );
  });

  it("cap-and-count: first 5 EBUSY lines, then (+N more EBUSY lines)", () => {
    const lines = Array.from(
      { length: 7 },
      (_, i) =>
        `rm: cannot remove '${HOME}/.ssh/k${i}': Device or resource busy`
    );
    const guidance = protectedTargetEbusyGuidance(
      lines.join("\n"),
      "ssh_key_material"
    )!;
    expect(guidance).toContain("k4");
    expect(guidance).not.toContain("k5");
    expect(guidance).toContain("(+2 more EBUSY lines)");
  });

  it("a stderr with no EBUSY line yields undefined (existing no-EROFS contract stays green)", () => {
    expect(
      protectedTargetEbusyGuidance(
        NETRC_RM.replace(/Device or resource busy/, "Read-only file system"),
        "netrc_credential"
      )
    ).toBeUndefined();
    expect(
      protectedTargetEbusyGuidance("", "netrc_credential")
    ).toBeUndefined();
  });
});

/**
 * The two protected-target wordings, rendered once at module scope so the
 * pairwise (two-arm) and the three-arm distinctness matrices below read the
 * SAME strings — a per-describe re-render would let the two matrices drift
 * onto different inputs.
 */
const EBUSY_COPY = protectedTargetEbusyGuidance(NETRC_RM, "netrc_credential")!;
const EROFS_COPY = protectedTargetFenceGuidance(
  `rm: cannot remove '${NETRC}': Read-only file system`,
  INVENTORY
)!;
/** seven lines, so the cap-and-count remainder markers exist. `.ssh/kN` is a
 *  real subtree member, so the EROFS arm resolves a class for every line (an
 *  unresolved class would yield no message at all). */
const seven = (marker: string): string =>
  Array.from(
    { length: 7 },
    (_, i) => `rm: cannot remove '${HOME}/.ssh/k${i}': ${marker}`
  ).join("\n");
const EBUSY_LONG = protectedTargetEbusyGuidance(
  seven("Device or resource busy"),
  "netrc_credential"
)!;
const EROFS_LONG = protectedTargetFenceGuidance(
  seven("Read-only file system"),
  INVENTORY
)!;

describe("EBUSY wording is DISTINCT from EROFS wording (both directions)", () => {
  const ebusy = EBUSY_COPY;
  const erofs = EROFS_COPY;
  const ebusyLong = EBUSY_LONG;
  const erofsLong = EROFS_LONG;

  it("the EBUSY copy carries none of the EROFS copy's distinctive sentences", () => {
    for (const erofsOnly of [
      "Read-only file system",
      "mounted read-only by the sandbox fence",
      "kernel (EROFS) refused the write",
    ]) {
      expect(erofs).toContain(erofsOnly);
      expect(ebusy).not.toContain(erofsOnly);
    }
    expect(erofsLong).toContain("(+2 more EROFS lines)");
    expect(ebusyLong).not.toContain("more EROFS lines");
  });

  it("the EROFS copy carries none of the EBUSY copy's distinctive sentences", () => {
    for (const ebusyOnly of [
      "Device or resource busy",
      "kernel (EBUSY)",
      "individually masked mount point",
    ]) {
      expect(ebusy).toContain(ebusyOnly);
      expect(erofs).not.toContain(ebusyOnly);
    }
    expect(ebusyLong).toContain("(+2 more EBUSY lines)");
    expect(erofsLong).not.toContain("more EBUSY lines");
  });

  it("the two are not the same string even for the same target class", () => {
    expect(ebusy).not.toBe(erofs);
  });

  it("neither EBUSY nor EROFS copy mentions the worktree boundary", () => {
    for (const copy of [ebusy, erofs]) {
      expect(copy.toLowerCase()).not.toContain("worktree");
      expect(copy).not.toContain("create_worktree");
    }
  });
});

/* ------------------------------------------------------------------ *
 * THREE arms, one prefix. ADR-0140 added a second refusal to this
 * channel: a write that left what the current `fsMode` permits. It is a
 * DIFFERENT boundary with a different truth condition (temporary and
 * answerable, not permanent), so it carries its own sentences.
 *
 * The property is pairwise distinctness across all three, both
 * directions: for every ordered pair (A, B), every distinctive claim of A
 * is absent from B. Scope note, stated so the test is not read as
 * stronger than it is: this asserts distinctness of the arms' DISTINCTIVE
 * claims (the convention the two protected arms already use), not
 * byte-level sentence disjointness — the two protected arms do share one
 * framing sentence ("This is a boundary refusal, not a command-syntax
 * judgment"), and that shared sentence is not what separates the
 * boundaries.
 * ------------------------------------------------------------------ */

/** A write that left the writable roots while the tier is `workspace`. */
const OUT_OF_TIER_TOUCH =
  "touch: cannot touch '/home/u/notes.txt': Read-only file system";
const TIER: FsModeBoundary = {
  mode: "workspace",
  readOnlyRoots: [HOME],
  writableRoots: ["/workspace/task", "/tmp/session"],
};

describe("THREE-way wording distinctness (EROFS / EBUSY / fs-mode boundary)", () => {
  const mode = modeBoundaryFenceGuidance(OUT_OF_TIER_TOUCH, INVENTORY, TIER)!;
  const sevenOutOfTier = (marker: string): string =>
    Array.from(
      { length: 7 },
      (_, i) => `touch: cannot touch '/home/u/n${i}.txt': ${marker}`
    ).join("\n");
  const modeLong = modeBoundaryFenceGuidance(
    sevenOutOfTier("Read-only file system"),
    INVENTORY,
    TIER
  )!;

  /** Each arm's distinctive claims: sentences that state what THIS boundary
   *  is. Absent from the other two, in both directions. */
  const CLAIMS: ReadonlyArray<{
    readonly arm: string;
    readonly copy: string;
    readonly distinctive: readonly string[];
  }> = [
    {
      arm: "protected-target EROFS",
      copy: EROFS_COPY,
      distinctive: [
        "mounted read-only by the sandbox fence",
        "kernel (EROFS) refused the write",
        "is not an operation this session can perform",
        "the target stays read-only for the whole session",
      ],
    },
    {
      arm: "protected-target EBUSY",
      copy: EBUSY_COPY,
      distinctive: [
        "individually masked mount point",
        "kernel (EBUSY)",
        // the template's own sentence, not the bare "cannot remove" that the
        // EROFS arm's quoted stderr clue also contains
        "This session cannot remove",
      ],
    },
    {
      arm: "fs-mode boundary",
      copy: mode,
      distinctive: [
        "left what this session's filesystem isolation tier permits",
        "mounts that region read-only",
        "a narrower destination can still work",
      ],
    },
  ];

  it("each arm really does carry its own distinctive claims (the matrix is not vacuous)", () => {
    for (const { arm, copy, distinctive } of CLAIMS) {
      for (const claim of distinctive) {
        expect(copy, `${arm} should carry: ${claim}`).toContain(claim);
      }
    }
  });

  it("no arm carries another arm's distinctive claims — every ordered pair, both directions", () => {
    for (const a of CLAIMS) {
      for (const b of CLAIMS) {
        if (a.arm === b.arm) continue;
        for (const claim of a.distinctive) {
          expect(
            b.copy,
            `${b.arm} must not carry ${a.arm}'s claim: ${claim}`
          ).not.toContain(claim);
        }
      }
    }
  });

  it("all three share the typed prefix and nothing else: the three strings are pairwise unequal", () => {
    for (const copy of [EROFS_COPY, EBUSY_COPY, mode]) {
      expect(copy.startsWith(`${VIOLATION_PREFIXES.fsDenied} `)).toBe(true);
    }
    expect(new Set([EROFS_COPY, EBUSY_COPY, mode]).size).toBe(3);
  });

  it("the fs-mode copy carries NO permanence claim and NO re-spelling claim", () => {
    // The whole point of the third arm (spec amendment 2026-10-06): a
    // permanent-sounding refusal about a temporary condition tells the model
    // there is no narrower spelling to try, which is the one thing it needs
    // to know.
    for (const permanent of [
      "stays read-only for the whole session",
      "is not an operation this session can perform",
      "re-spelling the command will not help",
      "at all",
    ]) {
      expect(mode).not.toContain(permanent);
    }
    // ...and it does name the narrower route instead.
    expect(mode).toContain("a narrower destination can still work");
  });

  it("each arm has its own cap-and-count remainder marker", () => {
    expect(EROFS_LONG).toContain("(+2 more EROFS lines)");
    expect(EBUSY_LONG).toContain("(+2 more EBUSY lines)");
    expect(modeLong).toContain("(+2 more out-of-tier EROFS lines)");
    expect(EROFS_LONG).not.toContain("more EBUSY lines");
    expect(EROFS_LONG).not.toContain("more out-of-tier EROFS lines");
    expect(EBUSY_LONG).not.toContain("more EROFS lines");
    expect(EBUSY_LONG).not.toContain("more out-of-tier EROFS lines");
    expect(modeLong).not.toContain("more EBUSY lines");
    expect(modeLong).not.toContain("(+2 more EROFS lines)");
  });

  it("the fs-mode copy mentions neither the worktree boundary nor a protected class", () => {
    expect(mode.toLowerCase()).not.toContain("worktree");
    expect(mode).not.toContain("create_worktree");
    // No protected class is claimed: the refused path resolved to none, which
    // is the precondition for this arm firing at all.
    for (const phrase of ["an SSH private key", "a netrc credential file"]) {
      expect(mode).not.toContain(phrase);
    }
  });
});

/* ------------------------------------------------------------------ *
 * Real-bwrap cases. The mask list under test comes from the fence's own
 * `exactFileMaskPaths` field — the assembly that emitted the masks is the one
 * being correlated, which is the whole point of the seam.
 * ------------------------------------------------------------------ */

/**
 * Capability gate, not a `bwrap --version` existence check: `runFence` below
 * really spawns the production fence argv (constant `--unshare-net`), so the
 * question is whether a fence can start HERE. The existence check passes on a
 * GHA runner that installed bwrap but has no user-namespace, and the refusal
 * (RTM_NEWADDR) then surfaces as a red instead of a skip.
 */
const SKIP = !canRunBwrapFence();

const scratch: string[] = [];
function scratchDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(d);
  return d;
}

const R_HOME = scratchDir("iknow-ebusy-home-");
const R_TASK = scratchDir("iknow-ebusy-task-");
const R_TMP = scratchDir("iknow-ebusy-tmp-");
const R_NETRC = join(R_HOME, ".netrc");
const R_SENTINEL = "netrc-SECRET-fixture-value";

/** Assemble the real production fence combo and run a script inside it. */
function runFence(script: string): {
  r: { status: number | null; stdout: string; stderr: string };
  fence: ReturnType<typeof createBwrapFence>;
} {
  const fence = createBwrapFence({
    command: "bash",
    args: ["-c", script],
    fsPolicy: createFsPolicy({ tmpDir: R_TMP, mode: "global" }),
    env: { HOME: R_HOME, PATH: "/usr/bin:/bin" },
    cwd: R_TASK,
    protectedTargets: createProtectedTargetInventory({
      home: R_HOME,
      scanRoot: R_HOME,
    }),
    protectCredentialReads: true,
    onProtectedTargetSkipped: () => {},
  });
  const argv = fence.argv;
  const r = spawnSync(argv[0]!, argv.slice(1), { encoding: "utf8" });
  return {
    fence,
    r: {
      status: r.status,
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? "",
    },
  };
}

beforeAll(() => {
  // Exact-file credential arm under a WRITABLE parent (the fence's home tier
  // does not ro-bind `$HOME` in global mode), which is precisely the shape
  // that yields EBUSY rather than EROFS.
  writeFileSync(R_NETRC, `machine gh login tok password ${R_SENTINEL}\n`, {
    mode: 0o600,
  });
  chmodSync(R_NETRC, 0o600);
  mkdirSync(R_TASK, { recursive: true });
});

afterAll(() => {
  for (const p of scratch.splice(0)) {
    rmSync(p, { recursive: true, force: true });
  }
});

describe("real bwrap — the exact-file /dev/null mask refusal (EBUSY)", () => {
  it.skipIf(SKIP)(
    "rm -f on the exact-file-masked credential exits NON-ZERO with EBUSY, host bytes UNCHANGED",
    () => {
      const before = readFileSync(R_NETRC, "utf8");
      const { r } = runFence(`rm -f '${R_NETRC}'`);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain("Device or resource busy");
      expect(existsSync(R_NETRC)).toBe(true);
      expect(readFileSync(R_NETRC, "utf8")).toBe(before);
      // no credential value anywhere in the refusal
      expect(r.stdout + r.stderr).not.toContain(R_SENTINEL);
    }
  );

  it.skipIf(SKIP)(
    "the fence's OWN emitted mask list correlates the real EBUSY → [fs_denied] guidance fires",
    () => {
      const { r, fence } = runFence(`rm -f '${R_NETRC}'`);
      // the seam itself: this fence really did mask the file
      expect(fence.exactFileMaskPaths).toContain(R_NETRC);
      const guidance = protectedTargetEbusyFenceGuidance(
        r.stderr,
        createProtectedTargetInventory({ home: R_HOME, scanRoot: R_HOME }),
        fence.exactFileMaskPaths
      );
      expect(guidance).toBeDefined();
      expect(guidance!.startsWith(`${VIOLATION_PREFIXES.fsDenied} `)).toBe(
        true
      );
      expect(guidance).toContain(
        describeProtectedTargetClass("netrc_credential")
      );
      expect(guidance).toContain("kernel (EBUSY)");
      expect(guidance).not.toContain("receipt");
      expect(guidance).not.toContain("authorization");
    }
  );

  it.skipIf(SKIP)(
    "python3 os.remove on the same masked credential is the same EBUSY boundary",
    () => {
      const before = readFileSync(R_NETRC, "utf8");
      // no try/except: an uncaught OSError is what makes the interpreter
      // exit non-zero, so the refusal is surfaced the way a model would see it
      const { r, fence } = runFence(
        `python3 -c "import os; os.remove('${R_NETRC}')"`
      );
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain("Device or resource busy");
      expect(readFileSync(R_NETRC, "utf8")).toBe(before);
      expect(
        protectedTargetEbusyFenceGuidance(
          r.stderr,
          createProtectedTargetInventory({ home: R_HOME, scanRoot: R_HOME }),
          fence.exactFileMaskPaths
        )
      ).toBeDefined();
    }
  );

  it.skipIf(SKIP)(
    "CONTROL: a genuinely unrelated EBUSY produces NO guidance (advisory never relabels)",
    () => {
      // No emitted-mask list from a fence that masked nothing: the exact
      // shape a yolo / mask-off assembly produces.
      const guidance = protectedTargetEbusyFenceGuidance(
        UNRELATED_BUSY,
        createProtectedTargetInventory({ home: R_HOME, scanRoot: R_HOME }),
        []
      );
      expect(guidance).toBeUndefined();
    }
  );

  it.skipIf(SKIP)(
    "CONTROL: an EBUSY on a masked path but with an EMPTY list (yolo) yields nothing",
    () => {
      const { fence } = runFence("true");
      // a real fence's list is populated, but the yolo contract is that the
      // list rides the same guard — an empty list can never fire
      expect(Array.isArray(fence.exactFileMaskPaths)).toBe(true);
      expect(
        protectedTargetEbusyFenceGuidance(NETRC_RM, INVENTORY, [])
      ).toBeUndefined();
    }
  );
});
