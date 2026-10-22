/**
 * Protected-target enumeration snapshot cache — the session-scoped holder that
 * lets one session reuse ONE walked snapshot of the protected-target
 * enumeration across fence assemblies (perf: without the holder every
 * assembly re-walks the whole name-rule scan scope).
 *
 * What the holder promises, and what this suite pins:
 *   - a reused snapshot is checked for FRESHNESS, never trusted and never
 *     refused: the stat-only identity pass re-reads no listing, and every
 *     walked directory whose fs identity is unchanged means the tree is
 *     provably the tree the snapshot was walked from, so the match set still
 *     holds;
 *   - a CHANGED tree is a STALE snapshot, not a refusal: the holder discards
 *     it and the assembly walks fresh, exactly as the fence does without a
 *     holder — so a credential that appears under the protected subtree is
 *     MASKED by that very call (the plan's invariant), and the call SUCCEEDS;
 *   - the holder is PER INSTANCE (one per bash-tool factory, i.e. one per
 *     session): two holders share nothing, and no snapshot outlives the
 *     session that produced it;
 *   - the retired-fence path neither consults nor populates the holder.
 *
 * Observability: the enumeration is counted at the `node:fs/promises` level
 * (`readdir` — the awaited walk's directory read) and at the `node:fs` level
 * (`readdirSync` — a changed listing's re-read). Both wrappers call the real
 * implementation, so the mock observes a DEPENDENCY of the subject and fakes
 * none of the subject's behaviour. Every case ALSO asserts the behavioural
 * outcome — the materialized protected targets — so no case rests on the
 * counter alone.
 *
 * Fixture discipline: every home and scan scope lives in an mkdtemp scratch
 * root, cleaned with the suite. No host credential file is read or written.
 */

import assert from "node:assert/strict";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, it, vi } from "vitest";

import {
  createProtectedTargetSnapshotCache,
  materializeProtectedTargets,
  type ProtectedTargetSnapshotCache,
} from "../../../src/harness/sandbox/protected-targets.js";
import { prepareProtectedFenceWiring } from "../../../src/harness/sandbox/protected-fence-wiring.js";

// The fs-level call counters. `vi.hoisted` puts them in scope before the
// hoisted `vi.mock` factories below run.
const fsCounter = vi.hoisted(() => ({
  /** The awaited walk's directory reads (`readdir`). */
  awaitedReads: [] as string[],
  /** The changed-listing re-reads (`readdirSync`). */
  syncReads: [] as string[],
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readdirSync: vi.fn((...args: Parameters<typeof actual.readdirSync>) => {
      fsCounter.syncReads.push(String(args[0]));
      return actual.readdirSync(...args);
    }),
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readdir: vi.fn(async (...args: Parameters<typeof actual.readdir>) => {
      fsCounter.awaitedReads.push(String(args[0]));
      return actual.readdir(...args);
    }),
  };
});

// ── fixtures ───────────────────────────────────────────────────────────────

const scratch: string[] = [];

function scratchDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of scratch.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface Fixture {
  readonly homeRoot: string;
  readonly workspaceRoot: string;
  /** The credential fixture the scan scope holds from the start. */
  readonly pem: string;
}

/** A home plus a scan scope holding one name-rule match (`*.pem`). */
function fixture(prefix: string): Fixture {
  const root = scratchDir(prefix);
  const homeRoot = join(root, "home");
  const workspaceRoot = join(root, "ws");
  mkdirSync(homeRoot, { recursive: true });
  mkdirSync(join(workspaceRoot, "src"), { recursive: true });
  const pem = join(workspaceRoot, "src", "server.pem");
  writeFileSync(pem, "p\n", "utf8");
  return { homeRoot, workspaceRoot, pem };
}

// ── assembly helper ────────────────────────────────────────────────────────

/**
 * One fence assembly's protected-target half: prepare the wiring (the
 * awaited walk) and materialize the inventory it hands the fence — the consume
 * of the parked walk, which is where the snapshot's freshness is checked.
 */
async function assemble(opts: {
  readonly homeRoot: string;
  readonly workspaceRoot: string;
  readonly snapshotCache?: ProtectedTargetSnapshotCache;
  readonly fenceRetired?: boolean;
}): Promise<{
  readonly targets: readonly string[];
  readonly identities: readonly {
    dev: bigint | number;
    ino: bigint | number;
  }[];
}> {
  const wiring = await prepareProtectedFenceWiring({
    homeRoot: opts.homeRoot,
    workspaceRoot: opts.workspaceRoot,
    fenceRetired: opts.fenceRetired === true,
    ...(opts.snapshotCache === undefined
      ? {}
      : { snapshotCache: opts.snapshotCache }),
  });
  if (opts.fenceRetired === true) return { targets: [], identities: [] };
  const materialized = materializeProtectedTargets(wiring.protectedTargets);
  return {
    targets: materialized.targets.map((target) => target.path),
    identities: materialized.identities,
  };
}

/** The awaited directory reads made under `root` since the last reset. */
function awaitedReadsUnder(root: string): readonly string[] {
  return fsCounter.awaitedReads.filter(
    (path) => path === root || path.startsWith(`${root}/`)
  );
}

/** The synchronous listing re-reads made under `root` since the last reset. */
function syncReadsUnder(root: string): readonly string[] {
  return fsCounter.syncReads.filter(
    (path) => path === root || path.startsWith(`${root}/`)
  );
}

function resetFsCounter(): void {
  fsCounter.awaitedReads.length = 0;
  fsCounter.syncReads.length = 0;
}

/** The fs identity of the object a materialized target was bound to. */
function identityOf(path: string): {
  dev: bigint | number;
  ino: bigint | number;
} {
  const stats = lstatSync(path, { bigint: true });
  return { dev: stats.dev, ino: stats.ino };
}

// ── cases ──────────────────────────────────────────────────────────────────

describe("protected-target enumeration snapshot cache", () => {
  it("C1 inputs unchanged → the second assembly does not re-run the enumeration", async () => {
    const { homeRoot, workspaceRoot, pem } = fixture("iknow-targetcache-c1-");
    const cache = createProtectedTargetSnapshotCache();

    resetFsCounter();
    const first = await assemble({
      homeRoot,
      workspaceRoot,
      snapshotCache: cache,
    });
    assert.ok(
      awaitedReadsUnder(workspaceRoot).length > 0,
      "the first assembly walks the scan scope (the snapshot is built fresh)"
    );
    assert.ok(
      first.targets.includes(pem),
      "the scan scope's credential is protected by the first assembly"
    );

    resetFsCounter();
    const second = await assemble({
      homeRoot,
      workspaceRoot,
      snapshotCache: cache,
    });
    assert.deepEqual(
      [...awaitedReadsUnder(workspaceRoot)],
      [],
      "the second assembly must not re-walk the scan scope"
    );
    assert.deepEqual(
      [...syncReadsUnder(workspaceRoot)],
      [],
      "the second assembly must not re-read any listing either"
    );
    assert.deepEqual(
      [...second.targets],
      [...first.targets],
      "the reused snapshot protects exactly the same targets"
    );
  });

  it("C2 a new credential under the scan scope is MASKED by the next assembly", async () => {
    const { homeRoot, workspaceRoot } = fixture("iknow-targetcache-c2-");
    const cache = createProtectedTargetSnapshotCache();

    await assemble({ homeRoot, workspaceRoot, snapshotCache: cache });
    const late = join(workspaceRoot, "src", "late.pem");
    writeFileSync(late, "k\n", "utf8");

    // The tree changed, so the cached snapshot is STALE: the holder discards
    // it and the assembly walks fresh — the credential is masked by THAT very
    // call, and the call succeeds (the behaviour the fence has without a
    // holder). It is never refused, and never masked one call later.
    const second = await assemble({
      homeRoot,
      workspaceRoot,
      snapshotCache: cache,
    });
    assert.ok(
      second.targets.includes(late),
      "the newly appearing credential must be masked by the next assembly"
    );
    assert.ok(
      second.targets.includes(join(workspaceRoot, "src", "server.pem")),
      "the credential that was already there stays masked"
    );

    // The fresh walk became the session's snapshot, so the assembly after it
    // takes the fast path again.
    resetFsCounter();
    const third = await assemble({
      homeRoot,
      workspaceRoot,
      snapshotCache: cache,
    });
    assert.deepEqual(
      [...awaitedReadsUnder(workspaceRoot)],
      [],
      "the assembly after the fresh walk must not re-walk the scan scope"
    );
    assert.ok(third.targets.includes(late));
  });

  it("C2 the cached path masks exactly what the UNCACHED path masks", async () => {
    // The branch's behaviour without a holder is the baseline: a walk per
    // assembly, so a credential that appeared is masked by the next call.
    // Two identical scopes, one driven through the holder and one without, and
    // the protected sets must agree.
    const plain = fixture("iknow-targetcache-c2a-");
    const cached = fixture("iknow-targetcache-c2b-");
    const cache = createProtectedTargetSnapshotCache();

    // The holder's snapshot is taken BEFORE the new credential exists, so the
    // next assembly is the one that has to notice it.
    await assemble({
      homeRoot: cached.homeRoot,
      workspaceRoot: cached.workspaceRoot,
      snapshotCache: cache,
    });
    for (const scope of [plain, cached]) {
      writeFileSync(
        join(scope.workspaceRoot, "src", "late.pem"),
        "k\n",
        "utf8"
      );
    }

    const plainAssembly = await assemble({
      homeRoot: plain.homeRoot,
      workspaceRoot: plain.workspaceRoot,
    });
    const cachedAssembly = await assemble({
      homeRoot: cached.homeRoot,
      workspaceRoot: cached.workspaceRoot,
      snapshotCache: cache,
    });

    const relative = (
      assembly: { readonly targets: readonly string[] },
      scope: string
    ): string[] =>
      assembly.targets.map((path) => path.slice(scope.length)).sort();
    assert.deepEqual(
      relative(cachedAssembly, cached.workspaceRoot),
      relative(plainAssembly, plain.workspaceRoot),
      "the cached path must protect exactly what the uncached path protects"
    );
    assert.ok(
      cachedAssembly.targets.includes(
        join(cached.workspaceRoot, "src", "late.pem")
      ),
      "the newly appearing credential is masked by the cached path too"
    );
  });

  it("C3 a changed directory that gains a NON-match still assembles", async () => {
    const { homeRoot, workspaceRoot, pem } = fixture("iknow-targetcache-c3a-");
    const cache = createProtectedTargetSnapshotCache();

    await assemble({ homeRoot, workspaceRoot, snapshotCache: cache });
    const ordinary = join(workspaceRoot, "src", "notes.txt");
    writeFileSync(ordinary, "hello\n", "utf8");

    const second = await assemble({
      homeRoot,
      workspaceRoot,
      snapshotCache: cache,
    });
    assert.ok(
      second.targets.includes(pem),
      "an ordinary file in the scan scope must not change what is protected"
    );
  });

  it("C3 a changed directory that gains an unscanned subdirectory still assembles", async () => {
    const { homeRoot, workspaceRoot, pem } = fixture("iknow-targetcache-c3b-");
    const cache = createProtectedTargetSnapshotCache();

    await assemble({ homeRoot, workspaceRoot, snapshotCache: cache });
    mkdirSync(join(workspaceRoot, "fresh-dir"), { recursive: true });

    // The fresh walk enumerates the new subtree, so there is nothing left
    // unscanned: the assembly succeeds exactly as it does without a holder.
    const second = await assemble({
      homeRoot,
      workspaceRoot,
      snapshotCache: cache,
    });
    assert.ok(
      second.targets.includes(pem),
      "a new subdirectory must not change what is protected"
    );
  });

  it("C3 a replaced match file is masked again, as the new object", async () => {
    const { homeRoot, workspaceRoot, pem } = fixture("iknow-targetcache-c3c-");
    const cache = createProtectedTargetSnapshotCache();

    const first = await assemble({
      homeRoot,
      workspaceRoot,
      snapshotCache: cache,
    });
    assert.ok(first.targets.includes(pem));
    const before = identityOf(pem);

    // An atomic save: the same path, a new inode.
    rmSync(pem, { force: true });
    writeFileSync(pem, "rotated\n", "utf8");
    const after = identityOf(pem);
    assert.notEqual(
      String(after.ino),
      String(before.ino),
      "the fixture must really have replaced the object"
    );

    const second = await assemble({
      homeRoot,
      workspaceRoot,
      snapshotCache: cache,
    });
    assert.ok(
      second.targets.includes(pem),
      "the replaced credential is masked again"
    );
    const bound = second.identities.find(
      (identity) => String(identity.ino) === String(after.ino)
    );
    assert.ok(
      bound !== undefined,
      "the assembly bound the NEW object, not the replaced one"
    );
  });

  it("C4 the retired fence path neither consults nor populates the holder", async () => {
    const { homeRoot, workspaceRoot, pem } = fixture("iknow-targetcache-c4-");
    const cache = createProtectedTargetSnapshotCache();

    resetFsCounter();
    const retired = await assemble({
      homeRoot,
      workspaceRoot,
      snapshotCache: cache,
      fenceRetired: true,
    });
    assert.deepEqual(
      [...awaitedReadsUnder(workspaceRoot)],
      [],
      "the retired path enumerates nothing"
    );
    assert.deepEqual([...retired.targets], []);

    // The holder was not populated: the next real assembly walks for itself.
    resetFsCounter();
    const after = await assemble({
      homeRoot,
      workspaceRoot,
      snapshotCache: cache,
    });
    assert.ok(
      awaitedReadsUnder(workspaceRoot).length > 0,
      "the holder had nothing to serve — the real assembly walks"
    );
    assert.ok(after.targets.includes(pem));
  });

  it("C4 the retired fence path does not spend a snapshot the holder already holds", async () => {
    const { homeRoot, workspaceRoot } = fixture("iknow-targetcache-c4b-");
    const cache = createProtectedTargetSnapshotCache();

    await assemble({ homeRoot, workspaceRoot, snapshotCache: cache });

    resetFsCounter();
    await assemble({
      homeRoot,
      workspaceRoot,
      snapshotCache: cache,
      fenceRetired: true,
    });
    assert.deepEqual(
      [...awaitedReadsUnder(workspaceRoot)],
      [],
      "the retired path walks nothing"
    );

    resetFsCounter();
    await assemble({ homeRoot, workspaceRoot, snapshotCache: cache });
    assert.deepEqual(
      [...awaitedReadsUnder(workspaceRoot)],
      [],
      "the retired call must not have spent the holder's snapshot"
    );
  });

  it("C5 the holder is per-instance → two sessions never share a snapshot", async () => {
    const { homeRoot, workspaceRoot, pem } = fixture("iknow-targetcache-c5-");
    const holderA = createProtectedTargetSnapshotCache();

    resetFsCounter();
    const viaA = await assemble({
      homeRoot,
      workspaceRoot,
      snapshotCache: holderA,
    });
    assert.ok(
      awaitedReadsUnder(workspaceRoot).length > 0,
      "holder A walks the scan scope"
    );

    const holderB = createProtectedTargetSnapshotCache();
    resetFsCounter();
    const viaB = await assemble({
      homeRoot,
      workspaceRoot,
      snapshotCache: holderB,
    });
    assert.ok(
      awaitedReadsUnder(workspaceRoot).length > 0,
      "holder B must walk the scan scope itself — no module-level cache exists"
    );
    assert.deepEqual(
      [...viaB.targets],
      [...viaA.targets],
      "both sessions protect the same targets"
    );
    assert.ok(viaA.targets.includes(pem));
  });

  it("C6 a different scan scope is a different snapshot", async () => {
    const { homeRoot, workspaceRoot } = fixture("iknow-targetcache-c6a-");
    const other = fixture("iknow-targetcache-c6b-");
    const cache = createProtectedTargetSnapshotCache();

    await assemble({ homeRoot, workspaceRoot, snapshotCache: cache });

    resetFsCounter();
    const viaOther = await assemble({
      homeRoot,
      workspaceRoot: other.workspaceRoot,
      snapshotCache: cache,
    });
    assert.ok(
      awaitedReadsUnder(other.workspaceRoot).length > 0,
      "a different scan scope must be walked, not served from the other scope's snapshot"
    );
    assert.ok(
      viaOther.targets.includes(other.pem),
      "the other scope's credential is protected"
    );
    assert.ok(
      !viaOther.targets.includes(join(workspaceRoot, "src", "server.pem")),
      "the other scope's snapshot must not leak into this assembly"
    );
  });

  it("C7 the reused snapshot's own race window: a change between the serve and the consume is re-walked", async () => {
    // The window no stat pass can close: the tree changes AFTER the holder
    // served the snapshot and BEFORE the assembly consumes it. The consume
    // site re-checks the snapshot's own directory identities; a change there
    // means the snapshot is stale, so the assembly re-walks and masks what
    // appeared — it neither serves a stale match set nor refuses.
    //
    // This is the ONLY path that reaches the reused branch with a changed
    // tree: the holder's own check (which runs earlier) drops the snapshot
    // first, so without this case the branch is untested.
    const { homeRoot, workspaceRoot } = fixture("iknow-targetcache-c7-");
    const cache = createProtectedTargetSnapshotCache();

    await assemble({ homeRoot, workspaceRoot, snapshotCache: cache });

    // Step 1 — the holder serves the snapshot: its own freshness check passes,
    // because nothing has changed yet.
    const wiring = await prepareProtectedFenceWiring({
      homeRoot,
      workspaceRoot,
      fenceRetired: false,
      snapshotCache: cache,
    });

    // The tree changes in the window between the serve and the consume.
    const late = join(workspaceRoot, "src", "late.pem");
    writeFileSync(late, "k\n", "utf8");

    // Step 2 — the consume re-checks the snapshot, finds it stale, re-walks.
    const materialized = materializeProtectedTargets(wiring.protectedTargets);
    const targets = materialized.targets.map((target) => target.path);
    assert.ok(
      targets.includes(late),
      "the credential that appeared in the race window must be masked by this assembly"
    );
    assert.ok(
      targets.includes(join(workspaceRoot, "src", "server.pem")),
      "the pre-existing credential stays protected"
    );
  });
});
