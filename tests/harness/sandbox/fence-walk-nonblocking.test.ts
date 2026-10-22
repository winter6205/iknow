/**
 * The protected-target walk must not monopolize the thread that renders the UI.
 *
 * Bug (operator report "the TUI freezes the moment a task starts running"): the
 * sandbox fence materializes its name-rule matches at EVERY assembly by walking
 * the whole workspace with `readdirSync`, and OpenTUI renders and reads
 * keystrokes on that same Bun thread — so the block is a whole-UI freeze, not a
 * slow turn. `prepareProtectedFenceWiring` carries the measured magnitude and
 * the product rationale in one place.
 *
 * The fix keeps the enumerator's coverage contract (specs/effect-boundary-protection.md
 * "Exclusions are not implied": no skip list and no coverage change), while
 * recording directory and matching-object identities around awaited reads.
 * Materialization permits proven removals to take the existing absent-target
 * warning path (SC10), and refuses the shapes that could leave a match
 * unrepresented: a new name-rule match in a changed directory, a new unscanned
 * subdirectory, a replaced object (class 5), an unenumerable tree (class 1), or
 * traversal work past the bound (class 6). A changed directory that gained only
 * NON-matching entries is none of those six classes — an ordinary concurrent
 * write (`npm install`, a fetch, a build watcher, an editor lock file) must not
 * make every bash call die, so the per-item classification is the fail-closed
 * decision and a listing-length comparison is not a guard.
 *
 * Asserted here without any wall-clock threshold, so it cannot flake. Coverage
 * is pinned through observable protected targets. The filesystem boundary
 * wrappers call the real reads and count synchronous fallback reads; they never
 * fabricate listings or replace the protected-target implementation:
 *   - the awaited walk interleaves with other work, observed by a macrotask
 *     counter that only advances when the event loop gets control;
 *   - consuming a parked walk issues NO directory read of its own — pinned on
 *     the counted synchronous `readdirSync` calls, because `materialize` is
 *     synchronous and a macrotask counter cannot advance inside it whether it
 *     re-walks the tree or not;
 *   - a new credential omitted from the awaited listing refuses materialize,
 *     consumes that one-shot result, and a later synchronous fallback protects
 *     the new credential; a disappeared match warns while its siblings remain
 *     bound; a parked directory that gained only non-matching entries still
 *     assembles and binds every match present at that moment;
 *   - the pre-walk and the synchronous walk classify the same tree identically,
 *     including a match inside `node_modules` (the spec's named example);
 *   - every refusal case names the GUARD that fired, not just the shared
 *     `materialization` prefix all ~20 refusal sites emit, so a broad guard
 *     cannot fire in place of the precise one and keep the suite green;
 *   - a walk parked under different limits is consumed before the assembly
 *     falls back under its own bounds;
 *   - both enumeration bounds refuse through the awaited arm, as typed errors,
 *     and the consume's changed-listing revalidation is charged to the same
 *     bound;
 *   - a match's discovered identity is captured in the same synchronous block
 *     as the directory read that enumerated it — checked as a structural
 *     invariant over the syscall log for every directory that holds both matches
 *     and descendants, because readdir order is filesystem-dependent.
 *
 * Fixture discipline: every tree is an mkdtemp scratch root; no real home,
 * credential, or session is read.
 */

import assert from "node:assert/strict";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it, vi } from "vitest";

const readBoundary = vi.hoisted(() => ({
  /** Counted `readdirSync` calls: the falsifiable measure of "this path
   *  enumerated directories". Identity probes are `lstat`, never `readdir`. */
  syncCalls: 0,
  /** Ordered observation log of the real read syscalls the walk uses. */
  events: [] as string[],
  afterRead: undefined as ((path: string) => void | Promise<void>) | undefined,
}));

// The synchronous fallback is counted through the real fs implementation too.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readdirSync: vi.fn((...args: Parameters<typeof actual.readdirSync>) => {
      readBoundary.syncCalls += 1;
      return actual.readdirSync(...args);
    }),
    // Identity probes are logged, never intercepted: the ordering invariant of
    // the awaited walk is asserted on real syscalls rather than on whatever
    // order this filesystem happens to answer readdir in.
    lstatSync: vi.fn((...args: Parameters<typeof actual.lstatSync>) => {
      readBoundary.events.push(`lstat:${String(args[0])}`);
      return actual.lstatSync(...args);
    }),
  };
});

// Observe the real directory reads and allow deterministic mutations at their
// completion boundary. The wrapper never fabricates a directory listing.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readdir: vi.fn(async (...args: Parameters<typeof actual.readdir>) => {
      const entries = await actual.readdir(...args);
      readBoundary.events.push(`awaited-readdir:${String(args[0])}`);
      const afterRead = readBoundary.afterRead;
      if (afterRead !== undefined) {
        await afterRead(String(args[0]));
      }
      return entries;
    }),
  };
});

import {
  createProtectedTargetInventory,
  materializeProtectedTargets,
  prewalkProtectedTargets,
} from "../../../src/harness/sandbox/protected-targets.js";
import {
  createBwrapFence,
  type ProtectedTargetSkippedWarning,
} from "../../../src/harness/sandbox/bwrap.js";
import { createFsPolicy } from "../../../src/harness/sandbox/fs-policy.js";
import { ToolExecutionError } from "../../../src/harness/errors.js";

const scratch: string[] = [];
function scratchRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(root);
  return root;
}

afterEach(() => {
  readBoundary.afterRead = undefined;
  for (const dir of scratch.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

beforeEach(() => {
  readBoundary.syncCalls = 0;
  readBoundary.events.length = 0;
  readBoundary.afterRead = undefined;
});

function isMaterializationRefusal(error: unknown): boolean {
  return (
    error instanceof ToolExecutionError &&
    /protected-targets: materialization/.test(error.message)
  );
}

/**
 * A refusal must name WHICH guard fired. Roughly twenty sites share the
 * `protected-targets: materialization` prefix, so a prefix-only assertion cannot
 * tell the precise guard from a broad one: an over-broad refusal could satisfy
 * the case while the guard that the spec enumerates never runs. `fragment` is
 * the guard-identifying phrase the message self-names (and, where the message
 * carries the path, the path too).
 */
function expectMaterializationRefusal(error: unknown, fragment: string): void {
  assert.ok(
    isMaterializationRefusal(error),
    `expected a typed materialization refusal, got ${String(error)}`
  );
  assert.ok(
    error instanceof Error && error.message.includes(fragment),
    `expected the refusal to name its guard via ${JSON.stringify(
      fragment
    )}, got: ${error instanceof Error ? error.message : String(error)}`
  );
}

/** One home doubling as the scan root (the shape `inventoryOf` uses elsewhere). */
function fixtureHome(): string {
  const home = join(scratchRoot("iknow-fence-walk-"), "home");
  mkdirSync(join(home, "project"), { recursive: true });
  writeFileSync(join(home, "project", "server.pem"), "pub\n", "utf8");
  writeFileSync(join(home, "project", ".env"), "A=1\n", "utf8");
  // The spec's own example: `node_modules/server.pem` inside the workspace is
  // materialized and protected, never skipped for being in a dependency tree.
  mkdirSync(join(home, "project", "node_modules", "dep"), { recursive: true });
  writeFileSync(
    join(home, "project", "node_modules", "dep", "server.pem"),
    "p\n",
    "utf8"
  );
  return home;
}

/** `dirs` directories of `per` files each, deep enough to be a real tree. */
function wideHome(root: string, dirs: number, per: number): string {
  const home = join(root, "home");
  for (let d = 0; d < dirs; d++) {
    const dir = join(home, "pkg", `d${d}`);
    mkdirSync(dir, { recursive: true });
    for (let f = 0; f < per; f++) {
      writeFileSync(join(dir, `m${f}.js`), "x\n", "utf8");
    }
  }
  writeFileSync(join(home, "pkg", "id_rsa"), "k\n", "utf8");
  return home;
}

/** One home plus a directory chain `levels` deep, to cross a depth bound. */
function deepHome(root: string, levels: number): string {
  const home = join(root, "home");
  let dir = home;
  for (let l = 0; l < levels; l++) {
    dir = join(dir, `l${l}`);
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(join(dir, "server.pem"), "p\n", "utf8");
  return home;
}

/**
 * A tree in which EVERY directory holds three name-rule matches AND three
 * subdirectories, recursing `levels` deep. Both halves matter: the ordering
 * invariant is only discriminating in a directory that has a match the walk
 * could postpone and a descendant it could descend into first. Subdirectories
 * are created before matches and are named `a*` against the matches' `m*`, so
 * this box's name-ordered readdir answers the descendants first — which is what
 * makes a hypothetical interleaved walk fail the invariant here rather than
 * merely being failable in principle.
 */
function matchAndSubdirTree(
  root: string,
  levels: number
): {
  /** Each directory's matching direct children, paths as the walk records them. */
  readonly matchesByParent: Map<string, string[]>;
  /** Every directory in the tree, in build order (parents before descendants). */
  readonly directories: string[];
} {
  const matchesByParent = new Map<string, string[]>();
  const directories: string[] = [];
  const build = (dir: string, level: number): void => {
    directories.push(dir);
    const children: string[] = [];
    if (level > 0) {
      for (let index = 0; index < 3; index += 1) {
        const child = join(dir, `a${index}`);
        mkdirSync(child);
        build(child, level - 1);
      }
    }
    for (let index = 0; index < 3; index += 1) {
      const match = join(dir, `m${index}.pem`);
      writeFileSync(match, "original\n", "utf8");
      children.push(match);
    }
    matchesByParent.set(dir, children);
  };
  build(root, levels);
  return { matchesByParent, directories };
}

/**
 * Index of the first awaited `readdir` of a DESCENDANT of `dir` in the walk's
 * syscall log, or -1 when the walk never descended into it.
 */
function firstDescendantReadIndex(
  events: readonly string[],
  dir: string
): number {
  const marker = "awaited-readdir:";
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!;
    if (!event.startsWith(marker)) continue;
    if (event.slice(marker.length).startsWith(`${dir}/`)) return index;
  }
  return -1;
}

/**
 * Materialized name-rule targets, home-relative: two inventories over
 * structurally identical fixtures in different scratch roots must agree
 * exactly, and the scratch prefix is not part of the classification.
 */
function relativeTargets(
  home: string,
  materialized: ReturnType<typeof materializeProtectedTargets>
): string[] {
  return materialized.targets.map((t) => t.path.slice(home.length + 1)).sort();
}

describe("protected-target walk — enumeration yields to the event loop", () => {
  it("counts how many times the event loop got control during one enumeration", async () => {
    const root = scratchRoot("iknow-fence-wide-");
    const home = wideHome(root, 400, 4);
    const inventory = createProtectedTargetInventory({ home, scanRoot: home });

    // A self-re-arming macrotask advances only on an event loop turn the
    // enumeration did not spend on the thread. An implementation that read the
    // tree with `readdirSync` — or even one that merely `await`ed synchronous
    // reads, which resumes on the microtask queue — would add no turns at all.
    let ticks = 0;
    let stop = false;
    const pump = (): void => {
      ticks += 1;
      if (!stop) setTimeout(pump, 0);
    };
    pump();
    const beforeWalk = ticks;

    await prewalkProtectedTargets(inventory);
    const turnsDuringWalk = ticks - beforeWalk;
    stop = true;

    // Observation, not proof: the awaited arm has to hand the thread back for
    // the pump to advance at all.
    assert.ok(
      turnsDuringWalk >= 10,
      `pre-walk yielded the event loop only ${turnsDuringWalk} times across 400 directories`
    );

    // The consume must issue NO directory read of its own: it works off the
    // parked listings and probes object identities with `lstat`, which is not a
    // directory read. A macrotask counter cannot pin this —
    // `materializeProtectedTargets` is synchronous, so the pump cannot advance
    // inside it whether the consume takes the parked walk or re-walks the whole
    // tree — so the claim goes to the counted `readdirSync` calls. Those are
    // falsifiable: the fallback walk in the cases below raises the same counter,
    // and a re-walk of this 402-directory tree would add 402 to it.
    const syncReadsBeforeConsume = readBoundary.syncCalls;
    const consumed = materializeProtectedTargets(inventory);
    assert.equal(
      readBoundary.syncCalls,
      syncReadsBeforeConsume,
      `consuming a parked walk issued ${
        readBoundary.syncCalls - syncReadsBeforeConsume
      } synchronous directory read(s); the consume must enumerate nothing itself`
    );
    // The counter only means something if the parked walk was the protection
    // this assembly used: pin the coverage too, so "issued no read" cannot be
    // satisfied by an assembly that protected nothing.
    assert.ok(
      consumed.targets.some(
        (target) => target.path === join(home, "pkg", "id_rsa")
      ),
      "the consume must hand back the parked walk's match"
    );
  });

  it("refuses a changed parked walk, consumes it, and the next walk sees the new credential", async () => {
    const home = fixtureHome();
    const inventory = createProtectedTargetInventory({ home, scanRoot: home });

    await prewalkProtectedTargets(inventory);
    const lateCredential = join(home, "project", "midwalk.key");
    writeFileSync(lateCredential, "k\n", "utf8");
    assert.throws(
      () => materializeProtectedTargets(inventory),
      (error: unknown) => {
        expectMaterializationRefusal(
          error,
          `contains a new protected match ${lateCredential}`
        );
        return true;
      },
      "a changed directory that gained a name-rule match invalidates the incomplete name-rule inventory"
    );
    const syncReadsAfterRefusal = readBoundary.syncCalls;

    // A failed consume must still take the one-shot cache. The next assembly
    // falls back to a fresh synchronous walk and covers the newly created file.
    const rewalked = materializeProtectedTargets(inventory);
    assert.ok(
      rewalked.targets.some((target) => target.path === lateCredential),
      "the next assembly must enumerate current filesystem contents"
    );
    assert.ok(
      readBoundary.syncCalls > syncReadsAfterRefusal,
      "the next assembly must perform real synchronous filesystem reads after consuming the failed walk"
    );
  });

  it("refuses a credential created in a directory after its real read completed", async () => {
    const home = fixtureHome();
    const inventory = createProtectedTargetInventory({ home, scanRoot: home });
    const project = join(home, "project");
    const lateCredential = join(project, "late.key");
    readBoundary.afterRead = (path) => {
      if (path === project) {
        readBoundary.afterRead = undefined;
        writeFileSync(lateCredential, "k\n", "utf8");
      }
    };

    await prewalkProtectedTargets(inventory);
    assert.throws(
      () => materializeProtectedTargets(inventory),
      (error: unknown) => {
        expectMaterializationRefusal(
          error,
          `contains a new protected match ${lateCredential}`
        );
        return true;
      },
      "a credential omitted from the directory listing must refuse assembly"
    );
  });

  it("binds every present match when a parked directory gains only non-matching entries", async () => {
    const home = fixtureHome();
    const inventory = createProtectedTargetInventory({ home, scanRoot: home });

    await prewalkProtectedTargets(inventory);

    // The growth a real session produces inside the walk window: an install
    // dropping a file into an existing dependency directory, a build watcher
    // writing a log, an editor leaving notes behind. None of these names hits a
    // name rule, so none of them can hide a match — `specs/effect-boundary-protection.md`
    // classes 1-6 do not make a scanned directory's ordinary growth a refusal,
    // and SC10 says the fence assembles and runs with every match present at
    // that moment bound. A refusal here would take EVERY bash call down on an
    // ordinary `npm install`, and on the verify route it is folded into a
    // generic startup failure.
    const presentMatches = [
      join(home, "project", "server.pem"),
      join(home, "project", ".env"),
      join(home, "project", "node_modules", "dep", "server.pem"),
    ];
    writeFileSync(join(home, "project", "notes.txt"), "n\n", "utf8");
    writeFileSync(join(home, "build.log"), "b\n", "utf8");
    writeFileSync(
      join(home, "project", "node_modules", "dep", "index.js"),
      "i\n",
      "utf8"
    );

    const assembled = materializeProtectedTargets(inventory);
    assert.deepEqual(
      relativeTargets(home, assembled),
      presentMatches.map((path) => path.slice(home.length + 1)).sort(),
      "a non-matching addition must not cost a present match its bind"
    );
    assert.deepEqual(assembled.vanished, []);
    assert.deepEqual(assembled.coveredByAncestor, []);

    // And the awaited consume must agree with the synchronous walk over the same
    // post-addition tree: the two drivers differ in WHEN the thread is released,
    // never in WHAT is protected. The next assembly has no parked walk left, so
    // this compares the consume's output against a fresh synchronous enumeration
    // of the identical tree.
    assert.deepEqual(
      relativeTargets(home, materializeProtectedTargets(inventory)),
      relativeTargets(home, assembled),
      "the next assembly's synchronous walk must classify the same tree identically"
    );
  });

  it("refuses through the precise guard when a parked directory gains a match", async () => {
    const home = fixtureHome();
    const inventory = createProtectedTargetInventory({ home, scanRoot: home });

    await prewalkProtectedTargets(inventory);
    // Same fixture, same growth shape as the case above, one difference: this
    // name hits `*.pem`, so it is a match the awaited listing never recorded.
    // The refusal must come from the per-item classification, not from a listing
    // length — which is what made the length comparison the wrong guard.
    const lateMatch = join(home, "project", "late-server.pem");
    writeFileSync(lateMatch, "p\n", "utf8");

    assert.throws(
      () => materializeProtectedTargets(inventory),
      (error: unknown) => {
        expectMaterializationRefusal(
          error,
          `contains a new protected match ${lateMatch}`
        );
        return true;
      },
      "growth that could hide a match must refuse, naming the new protected match"
    );
  });

  it("warns for a discovered match that disappears and keeps its present sibling bound", async () => {
    const root = scratchRoot("iknow-fence-vanished-");
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    const vanishedPath = join(workspace, "removed.pem");
    const siblingPath = join(workspace, "sibling.key");
    writeFileSync(vanishedPath, "p\n", "utf8");
    writeFileSync(siblingPath, "k\n", "utf8");
    const inventory = createProtectedTargetInventory({
      home: root,
      scanRoot: workspace,
    });

    await prewalkProtectedTargets(inventory);
    unlinkSync(vanishedPath);
    const warnings: ProtectedTargetSkippedWarning[] = [];
    const fence = createBwrapFence({
      command: "bash",
      args: ["-c", "true"],
      fsPolicy: createFsPolicy({ tmpDir: root }),
      env: { PATH: "/bin" },
      cwd: workspace,
      protectedTargets: inventory,
      onProtectedTargetSkipped: (warning) => warnings.push(warning),
    });

    assert.ok(
      warnings.some(
        (warning) =>
          warning.kind === "protected_target_absent_on_host" &&
          warning.target === vanishedPath
      ),
      "the vanished match must use the existing warn-and-continue diagnostic"
    );
    let siblingIsBound = false;
    for (let index = 0; index < fence.argv.length - 2; index += 1) {
      if (
        fence.argv[index] === "--ro-bind" &&
        fence.argv[index + 1] === siblingPath &&
        fence.argv[index + 2] === siblingPath
      ) {
        siblingIsBound = true;
        break;
      }
    }
    assert.ok(siblingIsBound, "the present sibling must stay read-only bound");
  });

  it("refuses a replacement object at a discovered matching pathname", async () => {
    const root = scratchRoot("iknow-fence-replaced-match-");
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    const matchPath = join(workspace, "credential.pem");
    const siblingPath = join(workspace, "sibling.key");
    const replacementPath = join(root, "replacement.tmp");
    writeFileSync(matchPath, "original\n", "utf8");
    writeFileSync(siblingPath, "sibling\n", "utf8");
    const inventory = createProtectedTargetInventory({
      home: root,
      scanRoot: workspace,
    });

    await prewalkProtectedTargets(inventory);
    writeFileSync(replacementPath, "replacement\n", "utf8");
    renameSync(replacementPath, matchPath);

    assert.throws(
      () => materializeProtectedTargets(inventory),
      (error: unknown) => {
        expectMaterializationRefusal(
          error,
          `match ${matchPath} was replaced since awaited enumeration`
        );
        return true;
      },
      "a matching pathname must remain bound to the object discovered by pre-walk"
    );
  });

  it("captures a parent match before awaited child reads can replace it", async () => {
    const root = scratchRoot("iknow-fence-midwalk-replacement-");
    const workspace = join(root, "workspace");
    const child = join(workspace, "nested");
    mkdirSync(child, { recursive: true });
    const matchPath = join(workspace, "credential.pem");
    const replacementPath = join(root, "replacement.tmp");
    writeFileSync(matchPath, "original\n", "utf8");
    writeFileSync(join(child, "ordinary.txt"), "x\n", "utf8");
    const inventory = createProtectedTargetInventory({
      home: root,
      scanRoot: workspace,
    });
    readBoundary.afterRead = (path) => {
      if (path === child) {
        readBoundary.afterRead = undefined;
        writeFileSync(replacementPath, "replacement\n", "utf8");
        renameSync(replacementPath, matchPath);
      }
    };

    await prewalkProtectedTargets(inventory);

    assert.throws(
      () => materializeProtectedTargets(inventory),
      (error: unknown) => {
        expectMaterializationRefusal(
          error,
          `match ${matchPath} was replaced since awaited enumeration`
        );
        return true;
      },
      "a parent match replaced while a child read is pending must retain its original identity"
    );
  });

  it("captures every directory's matches in the same synchronous block as its read, whatever readdir's order is", async () => {
    const root = scratchRoot("iknow-fence-midwalk-replacement-many-");
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    // Every level of this fixture holds BOTH name-rule matches and
    // subdirectories, so the invariant below has something to check in each
    // directory rather than only in the one the fixture happens to name first.
    const tree = matchAndSubdirTree(workspace, 2);
    const parentMatch = join(workspace, "m0.pem");
    const replacementPath = join(root, "replacement.tmp");
    const inventory = createProtectedTargetInventory({
      home: root,
      scanRoot: workspace,
    });
    readBoundary.afterRead = (path) => {
      // Any child of the parent — not one hardcoded name — so the window opens
      // on the first awaited descent whichever child readdir answers first.
      if (dirname(path) !== workspace) return;
      readBoundary.afterRead = undefined;
      writeFileSync(replacementPath, "replacement\n", "utf8");
      renameSync(replacementPath, parentMatch);
    };

    await prewalkProtectedTargets(inventory);
    const walkEvents = [...readBoundary.events];

    // Coverage first, so the invariant cannot be satisfied by a walk that read
    // nothing: every directory the fixture built must appear in the log.
    for (const dir of tree.directories) {
      assert.ok(
        walkEvents.includes(`awaited-readdir:${dir}`),
        `the awaited walk must read ${dir}`
      );
    }

    // The structural invariant, checked per directory over the recorded
    // syscalls: for every directory D, the `lstat` capture of EVERY matching
    // direct child of D precedes the first awaited `readdir` of any DESCENDANT
    // of D. A walk that descends as soon as it reaches a subdirectory breaks
    // this whenever readdir answers one subdirectory before one match — with 3
    // matches and 3 subdirectories per level that is a per-directory accident,
    // not a property of the fixture's names, and it must not be: the
    // replacement landing inside that window would then BE the discovered
    // identity, which is spec refusal class 5 accepted as a bind. The
    // two-pass walk satisfies it for every readdir order, so the assertion
    // measures the code and not the filesystem.
    for (const [dir, matches] of tree.matchesByParent) {
      const firstDescendantRead = firstDescendantReadIndex(walkEvents, dir);
      for (const match of matches) {
        const capture = walkEvents.indexOf(`lstat:${match}`);
        assert.ok(
          capture >= 0,
          `the identity of ${match} must be captured by lstat while ${dir} is enumerated`
        );
        if (firstDescendantRead < 0) continue;
        assert.ok(
          capture < firstDescendantRead,
          `${match} was captured at walk event ${capture}, at or after ${dir}'s first descendant read (${firstDescendantRead}); a match's discovered identity must belong to the directory read that enumerated it`
        );
      }
    }

    let refusal: unknown;
    try {
      materializeProtectedTargets(inventory);
    } catch (error) {
      refusal = error;
    }
    assert.ok(
      refusal !== undefined && isMaterializationRefusal(refusal),
      "a match replaced while child reads are pending must refuse instead of binding the replacement object"
    );
    expectMaterializationRefusal(
      refusal,
      `match ${parentMatch} was replaced since awaited enumeration`
    );
  });

  it("refuses a replacement of a discovered symlink bind source", async () => {
    const root = scratchRoot("iknow-fence-replaced-link-target-");
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    const targetPath = join(workspace, "payload.txt");
    const linkPath = join(workspace, "credential.pem");
    const replacementPath = join(root, "replacement.tmp");
    writeFileSync(targetPath, "original\n", "utf8");
    symlinkSync(targetPath, linkPath);
    const inventory = createProtectedTargetInventory({
      home: root,
      scanRoot: workspace,
    });

    await prewalkProtectedTargets(inventory);
    writeFileSync(replacementPath, "replacement\n", "utf8");
    renameSync(replacementPath, targetPath);

    assert.throws(
      () => materializeProtectedTargets(inventory),
      (error: unknown) => {
        expectMaterializationRefusal(
          error,
          `resolved bind source for ${linkPath} was replaced since awaited enumeration`
        );
        return true;
      },
      "an unchanged matching symlink must not authorize a replacement target object"
    );
  });

  it("refuses a nested directory created after its parent directory was read", async () => {
    const home = fixtureHome();
    const inventory = createProtectedTargetInventory({ home, scanRoot: home });
    const project = join(home, "project");
    const lateDirectory = join(project, "late-subtree");
    readBoundary.afterRead = (path) => {
      if (path === project) {
        readBoundary.afterRead = undefined;
        mkdirSync(lateDirectory);
        writeFileSync(join(lateDirectory, "late.pem"), "p\n", "utf8");
      }
    };

    await prewalkProtectedTargets(inventory);
    assert.throws(
      () => materializeProtectedTargets(inventory),
      (error: unknown) => {
        expectMaterializationRefusal(
          error,
          `contains an unscanned child directory ${lateDirectory}`
        );
        return true;
      },
      "a newly created subtree must not be omitted from a successful fence"
    );
  });

  it("refuses a subtree that disappears after its parent directory was read", async () => {
    const home = fixtureHome();
    const inventory = createProtectedTargetInventory({ home, scanRoot: home });
    const project = join(home, "project");
    readBoundary.afterRead = (path) => {
      if (path === home) {
        readBoundary.afterRead = undefined;
        rmSync(project, { recursive: true });
      }
    };

    await assert.rejects(
      () => prewalkProtectedTargets(inventory),
      (error: unknown) => {
        expectMaterializationRefusal(error, `could not enumerate ${project}`);
        return true;
      },
      "the awaited walk must refuse an unreadable subtree instead of caching partial matches"
    );
  });

  it("refuses when the asynchronous scan root disappears before its first read", async () => {
    const home = fixtureHome();
    const inventory = createProtectedTargetInventory({ home, scanRoot: home });
    rmSync(home, { recursive: true });

    await assert.rejects(
      () => prewalkProtectedTargets(inventory),
      (error: unknown) => {
        expectMaterializationRefusal(error, `could not enumerate ${home}`);
        return true;
      },
      "a missing async root is not an empty successful inventory"
    );
  });

  it("refuses a parked walk when ctime changed even after mtime was restored", async () => {
    const home = fixtureHome();
    const project = join(home, "project");
    const lateCredential = join(project, "late.key");
    const inventory = createProtectedTargetInventory({ home, scanRoot: home });
    utimesSync(project, 10, 10);
    const before = lstatSync(project, { bigint: true });
    readBoundary.afterRead = (path) => {
      if (path === project) {
        readBoundary.afterRead = undefined;
        writeFileSync(lateCredential, "k\n", "utf8");
        utimesSync(project, 10, 10);
      }
    };

    await prewalkProtectedTargets(inventory);
    const after = lstatSync(project, { bigint: true });
    assert.equal(after.mtimeNs, before.mtimeNs);
    assert.notEqual(after.ctimeNs, before.ctimeNs);
    assert.throws(
      () => materializeProtectedTargets(inventory),
      (error: unknown) => {
        expectMaterializationRefusal(
          error,
          `contains a new protected match ${lateCredential}`
        );
        return true;
      },
      "restoring mtime must not make an altered directory listing trusted"
    );
  });

  it("refuses a directory replaced by a symlink after the awaited walk", async () => {
    const home = fixtureHome();
    const movedHome = join(dirname(home), "moved-home");
    const inventory = createProtectedTargetInventory({ home, scanRoot: home });

    await prewalkProtectedTargets(inventory);
    renameSync(home, movedHome);
    symlinkSync(movedHome, home);

    assert.throws(
      () => materializeProtectedTargets(inventory),
      (error: unknown) => {
        expectMaterializationRefusal(
          error,
          `walk directory ${home} was replaced since awaited enumeration`
        );
        return true;
      },
      "a symlink directory must not stand in for an enumerated real directory"
    );
  });

  it("a failed re-walk evicts an older parked result", async () => {
    const home = fixtureHome();
    const inventory = createProtectedTargetInventory({ home, scanRoot: home });
    const project = join(home, "project");
    await prewalkProtectedTargets(inventory);

    readBoundary.afterRead = (path) => {
      if (path === home) rmSync(project, { recursive: true });
    };
    await assert.rejects(
      () => prewalkProtectedTargets(inventory),
      (error: unknown) => {
        expectMaterializationRefusal(error, `could not enumerate ${project}`);
        return true;
      }
    );

    const lateCredential = join(home, "fresh.key");
    writeFileSync(lateCredential, "k\n", "utf8");
    const syncReadsBeforeFallback = readBoundary.syncCalls;
    const current = materializeProtectedTargets(inventory);
    assert.ok(
      current.targets.some((target) => target.path === lateCredential),
      "a failed new walk must not leave an older result available to materialize"
    );
    assert.ok(readBoundary.syncCalls > syncReadsBeforeFallback);
  });

  it("an in-flight walk cannot overlap another walk or be consumed", async () => {
    const home = fixtureHome();
    const inventory = createProtectedTargetInventory({ home, scanRoot: home });
    let enteredRead!: () => void;
    let releaseRead!: () => void;
    const entered = new Promise<void>((resolve) => {
      enteredRead = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    readBoundary.afterRead = async (path) => {
      if (path === home) {
        readBoundary.afterRead = undefined;
        enteredRead();
        await blocked;
      }
    };

    const firstWalk = prewalkProtectedTargets(inventory);
    await entered;
    await assert.rejects(
      () => prewalkProtectedTargets(inventory),
      (error: unknown) => {
        expectMaterializationRefusal(
          error,
          "an awaited pre-walk is already in progress"
        );
        return true;
      },
      "the same inventory cannot park two walks concurrently"
    );
    assert.throws(
      () => materializeProtectedTargets(inventory),
      (error: unknown) => {
        expectMaterializationRefusal(
          error,
          "cannot materialize while an awaited pre-walk is in progress"
        );
        return true;
      },
      "materialization cannot consume a walk that has not completed"
    );
    releaseRead();
    await assert.rejects(
      () => firstWalk,
      (error: unknown) => {
        expectMaterializationRefusal(
          error,
          "the awaited pre-walk was invalidated before completion"
        );
        return true;
      },
      "a walk invalidated by a concurrent consume must not park afterward"
    );

    const lateCredential = join(home, "after-inflight.key");
    writeFileSync(lateCredential, "k\n", "utf8");
    assert.ok(
      materializeProtectedTargets(inventory).targets.some(
        (target) => target.path === lateCredential
      ),
      "an invalidated in-flight walk must not overwrite the later fresh scan"
    );
  });

  it("never takes a walk parked under different limits", async () => {
    const home = fixtureHome();
    const inventory = createProtectedTargetInventory({ home, scanRoot: home });

    await prewalkProtectedTargets(inventory, {
      maxWalkDepth: 64,
      maxEntries: 2_000_000,
    });
    // The assembly disagrees with the parked walk's bounds, so that walk is not
    // this assembly's enumeration: the assembly must re-walk under its own
    // limits, and a credential created after the park is then visible to it.
    writeFileSync(join(home, "project", "drift.pem"), "p\n", "utf8");
    const assembly = materializeProtectedTargets(inventory, {
      maxWalkDepth: 64,
      maxEntries: 1_999_999,
    });
    assert.ok(
      assembly.targets.some((t) => t.path.endsWith("drift.pem")),
      "a limits mismatch must fall back to this assembly's own walk"
    );
  });

  it("a limits mismatch consumes the older cache before the next matching-limit assembly", async () => {
    const home = fixtureHome();
    const inventory = createProtectedTargetInventory({ home, scanRoot: home });
    const originalLimits = { maxWalkDepth: 64, maxEntries: 2_000_000 };

    await prewalkProtectedTargets(inventory, originalLimits);
    materializeProtectedTargets(inventory, {
      maxWalkDepth: 64,
      maxEntries: 1_999_999,
    });

    const lateCredential = join(home, "project", "after-mismatch.key");
    writeFileSync(lateCredential, "k\n", "utf8");
    const current = materializeProtectedTargets(inventory, originalLimits);
    assert.ok(
      current.targets.some((target) => target.path === lateCredential),
      "the limits-mismatch fallback must evict the old cache before a later matching-limit consume"
    );
  });

  it("pre-walk plus consume classifies the tree exactly as the synchronous walk does", async () => {
    const homeA = fixtureHome();
    const homeB = fixtureHome();

    const synchronous = relativeTargets(
      homeA,
      materializeProtectedTargets(
        createProtectedTargetInventory({ home: homeA, scanRoot: homeA })
      )
    );

    const inventory = createProtectedTargetInventory({
      home: homeB,
      scanRoot: homeB,
    });
    await prewalkProtectedTargets(inventory);
    const walked = relativeTargets(
      homeB,
      materializeProtectedTargets(inventory)
    );

    assert.ok(
      synchronous.length >= 3,
      "fixture must produce name-rule matches"
    );
    assert.ok(
      synchronous.includes(
        join("project", "node_modules", "dep", "server.pem")
      ),
      "a match inside node_modules must stay protected in both drivers"
    );
    assert.deepEqual(walked, synchronous);
  });

  it("honours the enumeration bound through the awaited walk, as a typed refusal", async () => {
    const root = scratchRoot("iknow-fence-bound-");
    const home = wideHome(root, 40, 5);
    const inventory = createProtectedTargetInventory({ home, scanRoot: home });

    await assert.rejects(
      () =>
        prewalkProtectedTargets(inventory, {
          maxWalkDepth: 64,
          maxEntries: 30,
        }),
      (error: unknown) => {
        expectMaterializationRefusal(
          error,
          "exceeded the enumeration bound of 30 entries"
        );
        return true;
      }
    );
  });

  it("charges the changed-listing revalidation to the walk's enumeration bound", async () => {
    const root = scratchRoot("iknow-fence-revalidate-bound-");
    const home = wideHome(root, 4, 2);
    const inventory = createProtectedTargetInventory({ home, scanRoot: home });
    // The explicit limits exist so this fixture does not need a 2M-entry tree:
    // the walk itself spends 14 entries (home → pkg → four directories of two
    // files each, plus the `id_rsa` match), so 16 leaves it room to park.
    const limits = { maxWalkDepth: 64, maxEntries: 16 };

    await prewalkProtectedTargets(inventory, limits);

    // Every directory the walk parked now looks changed, so the consume rereads
    // all of them — the same 14 entries a second time, which is traversal work
    // the pass must not get for free. Their LISTINGS ARE UNCHANGED, so this case
    // trips the aggregate charge and nothing else: no new match and no new
    // subdirectory is added anywhere, which is what makes it the class-6 guard's
    // own case rather than a listing-length accident.
    const parked = [
      home,
      join(home, "pkg"),
      join(home, "pkg", "d0"),
      join(home, "pkg", "d1"),
      join(home, "pkg", "d2"),
      join(home, "pkg", "d3"),
    ];
    for (const dir of parked) utimesSync(dir, 10, 10);

    // The SAME limits on both calls, or the limits-mismatch path silently
    // re-walks instead of revalidating this listing.
    assert.throws(
      () => materializeProtectedTargets(inventory, limits),
      (error: unknown) => {
        expectMaterializationRefusal(
          error,
          "exceeded the enumeration bound of 16 entries"
        );
        const message = (error as Error).message;
        assert.match(message, /revalidat/u);
        assert.match(message, /refused, not truncated/u);
        return true;
      },
      "revalidation traversal work must be charged to the bound that named it"
    );
  });

  it("honours the depth bound through the awaited walk, as a typed refusal", async () => {
    const root = scratchRoot("iknow-fence-depth-");
    const home = deepHome(root, 4);
    const inventory = createProtectedTargetInventory({ home, scanRoot: home });

    // The same refusal the synchronous walk raises (the spec names both bounds),
    // arriving as a rejection here. Refused, not truncated: a walk that handed
    // back what it reached under a deeper bound would be a partial protection
    // the assembly could not tell from a complete one.
    await assert.rejects(
      () =>
        prewalkProtectedTargets(inventory, {
          maxWalkDepth: 2,
          maxEntries: 2_000_000,
        }),
      (error: unknown) => {
        expectMaterializationRefusal(
          error,
          "exceeded the walk-depth bound of 2"
        );
        return true;
      }
    );
  });

  it("feeds one assembly only: the next assembly re-walks and covers a new match", async () => {
    const home = fixtureHome();
    const inventory = createProtectedTargetInventory({ home, scanRoot: home });

    await prewalkProtectedTargets(inventory);
    const first = materializeProtectedTargets(inventory);

    // A credential appearing after this assembly is covered by the NEXT one —
    // the freshness rule of the spec. That only holds if a pre-walk is consumed
    // once and never kept as state on the inventory.
    writeFileSync(join(home, "project", "late.key"), "k\n", "utf8");
    const second = materializeProtectedTargets(inventory);
    assert.ok(
      second.targets.some((t) => t.path.endsWith("late.key")),
      "the assembly after a consumed pre-walk must re-enumerate the tree"
    );
    assert.ok(!first.targets.some((t) => t.path.endsWith("late.key")));
  });
});
