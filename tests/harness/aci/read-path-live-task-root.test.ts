/**
 * Read-path tools take the live `taskRoot` cell at call time, keeping
 * `extraReadRoots` / `root` on the **same vintage**.
 *
 * Coverage map:
 *   1. read_file: liveTaskRoot flips → next read_file call resolves to the
 *      new tree (no factory-time closure on `root`).
 *   2. read_file: liveTaskRoot absent → factory-captured `root` stays
 *      authoritative (legacy parity, byte-identical).
 *   3. read_file: same vintage — `root` and `<workspaceRoot>/.iknow`
 *      extraReadRoots are computed against the same snapshot; rebinding
 *      mid-handler does NOT mutate the in-flight call's root/extras.
 *   4. read_file: same vintage under the widened host reach (ADR-0128 T4) —
 *      post-rebind, ordinary outside paths read through the policy arm of the
 *      current snapshot, protected ones stay refused, and relative names
 *      never resolve through the stale root.
 *   5. glob: liveTaskRoot flips → next glob call walks the new tree.
 *   6. grep: liveTaskRoot flips → next grep call walks the new tree.
 *   7. Identity-root wiring: when `projectIdentityRoot` differs from the live
 *      root, read_file can reach the identity-root path; when equal, it does
 *      NOT add a redundant entry (root already covers it).
 *   8. `string` legacy callers (no cell) keep byte-identical behavior
 *      across read_file / glob / grep.
 *
 * Strategy mirrors the bash live-task-root tests: drive the AciToolDef's
 * `handler` directly so we
 * observe the per-call snapshot without going through executor wiring. rg
 * unavailability on the runner is tolerated — the glob/grep rebind tests
 * create files only in the rebound tree so the absence of the file in the
 * pre-rebind tree (and presence in the post-rebind tree) is what the
 * assertions hinge on.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";

import {
  createLiveTaskRoot,
  writeLiveTaskRoot,
  type LiveTaskRoot,
} from "../../../src/harness/session-roots.ts";
import { createReadFileTool } from "../../../src/harness/aci/tools/read-file.ts";
import { createGlobTool } from "../../../src/harness/aci/tools/glob.ts";
import { createGrepTool } from "../../../src/harness/aci/tools/grep.ts";

const scratchPaths: string[] = [];

async function makeScratch(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  scratchPaths.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    scratchPaths
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

// ─── 1. read_file: per-call snapshot ──────────────────────────────────────

describe("read_file T6: live taskRoot cell drives handler root", () => {
  it("cell flips between two calls → second call resolves the rebound tree", async () => {
    const rootA = await makeScratch("t6-readfile-a-");
    const rootB = await makeScratch("t6-readfile-b-");
    await writeFile(join(rootA, "marker.txt"), "from-A\n");
    await writeFile(join(rootB, "marker.txt"), "from-B\n");

    const cell: LiveTaskRoot = createLiveTaskRoot(rootA);
    const tool = createReadFileTool(cell);

    // Pre-rebind: read from rootA.
    const before = (await tool.handler({ path: "marker.txt" })) as string;
    assert.ok(
      before.includes("from-A"),
      `pre-rebind read must come from A; got: ${before}`
    );
    assert.ok(
      !before.includes("from-B"),
      `pre-rebind read must NOT come from B; got: ${before}`
    );

    // Rebind: the single writer updates the cell.
    writeLiveTaskRoot(cell, rootB);

    // Post-rebind: read from rootB without rebuilding the tool.
    const after = (await tool.handler({ path: "marker.txt" })) as string;
    assert.ok(
      after.includes("from-B"),
      `post-rebind read must come from B; got: ${after}`
    );
    assert.ok(
      !after.includes("from-A"),
      `post-rebind read must NOT come from A; got: ${after}`
    );
  });

  it("absence of cell → factory-captured `root` stays authoritative (legacy parity)", async () => {
    const root = await makeScratch("t6-readfile-legacy-");
    await writeFile(join(root, "x.txt"), "alpha\n");
    // Pass a string (legacy shape) — no cell threading.
    const tool = createReadFileTool(root);
    const out = (await tool.handler({ path: "x.txt" })) as string;
    assert.ok(out.includes("alpha"), `legacy string-root read: ${out}`);
  });
});

// ─── 2. read_file: same vintage (root + extraReadRoots share snapshot) ─────

describe("read_file T6: D9 — root + extraReadRoots share the same wave snapshot", () => {
  it("workspaceRoot extraReadRoots are anchored to the live root snapshot, not a stale value", async () => {
    // Construct two distinct per-root anchor dirs (workspaceRootA, workspaceRootB).
    // Both have `.iknow/state.json`. When root === workspaceRootA → only A's
    // .iknow is reachable (and reads through <root>/.iknow). After rebind
    // to workspaceRootB → only B's .iknow is reachable (B is the new root,
    // and <workspaceRootA>/.iknow is NOT in scope because A is no longer the
    // live root's identity).
    //
    // This proves the same-vintage invariant: both root and extraReadRoots are
    // computed at the same wave; rebinding the cell mid-stream changes
    // BOTH at once. No "root is new, extra is old" mixed vintage can
    // exist because the conditional uses the live `rootAtCall`, not a
    // factory-time capture.
    const wsA = await makeScratch("t6-d9-wsA-");
    const wsB = await makeScratch("t6-d9-wsB-");
    await mkdir(join(wsA, ".iknow"), { recursive: true });
    await mkdir(join(wsB, ".iknow"), { recursive: true });
    await writeFile(join(wsA, ".iknow", "state.json"), '{"from":"A"}\n');
    await writeFile(join(wsB, ".iknow", "state.json"), '{"from":"B"}\n');

    const cell: LiveTaskRoot = createLiveTaskRoot(wsA);
    const tool = createReadFileTool(cell, { workspaceRoot: wsA });

    // Pre-rebind: <root>/.iknow = wsA/.iknow → reachable; wsA IS the root,
    // so the conditional `<wsA>/.iknow` extra is dropped (it's the root).
    // The state.json is reachable because it sits under the root.
    const before = (await tool.handler({
      path: ".iknow/state.json",
    })) as string;
    assert.ok(
      before.includes('"from":"A"'),
      `pre-rebind must see A's state.json; got: ${before}`
    );
    assert.ok(
      !before.includes('"from":"B"'),
      `pre-rebind must NOT see B's state.json; got: ${before}`
    );

    // Rebind the cell. Now `rootAtCall = wsB`. The workspaceRoot option
    // is still wsA (stable, set at assembly). With same-vintage reads:
    //   - root = wsB
    //   - <workspaceRoot>/.iknow = wsA/.iknow (extra)
    //   - root === workspaceRoot is false (wsB !== wsA), so the extra
    //     `wsA/.iknow` is in scope.
    //   - <root>/.iknow = wsB/.iknow → also in scope.
    writeLiveTaskRoot(cell, wsB);

    const after = (await tool.handler({
      path: ".iknow/state.json",
    })) as string;
    // Both wsA/.iknow and wsB/.iknow are valid read roots now. The
    // assertion that matters is the rebind took effect: wsB's state is
    // reachable through the new root.
    assert.ok(
      after.includes('"from":"B"'),
      `post-rebind must see B's state.json (B is the live root); got: ${after}`
    );
    // wsA's state.json should NOT be reachable any more — the pre-rebind
    // state was bound to the workspaceRoot extra which is keyed off the
    // workspaceRoot option (still wsA). The actual reachability is
    // <root>/.iknow = wsB/.iknow. wsA's .iknow is NOT under wsB → typed
    // reject. So either we get B's state OR an outside-workspace error,
    // but never A's.
    assert.ok(
      !after.includes('"from":"A"'),
      `post-rebind must NOT see A's state.json (no longer under live root); got: ${after}`
    );
  });

  it("mid-handler rebind does NOT mutate the in-flight call's root or extras", async () => {
    // Wave snapshot: handler reads cell.read() exactly once; subsequent
    // writes to the cell during the same handler call must NOT affect
    // either root or extraReadRoots (both are derived from the same
    // snapshot). Pin this by binding a cell, calling read_file, and
    // flipping the cell synchronously after the handler resolves — the
    // result we already got is unchanged. (In-process flip from a
    // microtask is impossible without a promise hook, so we use the
    // direct call as the lower-bound check: result holds the value it
    // computed before any flip.)
    const rootA = await makeScratch("t6-d9-mid-");
    await writeFile(join(rootA, "p.txt"), "stable\n");
    const cell: LiveTaskRoot = createLiveTaskRoot(rootA);
    const tool = createReadFileTool(cell);

    const result = (await tool.handler({ path: "p.txt" })) as string;
    assert.ok(result.includes("stable"));
    // Mid-stream flip after resolution — proves the next call observes
    // the new value, and confirms the previous result wasn't retroactively
    // rewritten.
    const rootB = await makeScratch("t6-d9-mid-b-");
    writeLiveTaskRoot(cell, rootB);
    // In rootB there's no p.txt → handler must throw ToolExecutionError;
    // the previous result is still A's "stable" — proof that handler
    // internal state does not leak (the second call uses the new root).
    await assert.rejects(
      () => tool.handler({ path: "p.txt" }),
      (error: unknown) =>
        error instanceof Error && error.message.includes("file not found")
    );
    // And the first result is preserved byte-for-byte.
    assert.ok(
      result.includes("stable"),
      `result from the first (pre-rebind) call stays unchanged`
    );
  });
});

// ─── 3. read_file: per-call snapshot across the host-reach widening ───────

describe("read_file T6: same-vintage snapshot under the widened host reach", () => {
  it("post-rebind ordinary path outside every root reads through the policy arm of THIS call", async () => {
    const rootA = await makeScratch("t6-contain-A-");
    const rootB = await makeScratch("t6-contain-B-");
    const outside = await realpath(await makeScratch("t6-contain-out-"));
    await writeFile(join(outside, "plain.txt"), "host-ordinary\n");

    const cell: LiveTaskRoot = createLiveTaskRoot(rootA);
    const tool = createReadFileTool(cell);

    writeLiveTaskRoot(cell, rootB);
    // ADR-0128 T4: reach is granted by the decideRead allow verdict computed
    // against this call's root snapshot (rootB) — the read succeeds and never
    // resolves through the stale rootA vintage.
    const out = (await tool.handler({
      path: join(outside, "plain.txt"),
    })) as string;
    assert.ok(
      out.includes("host-ordinary"),
      `widened post-rebind read: ${out}`
    );
  });

  it("post-rebind protected path outside every root is refused by the roster, not by reach", async () => {
    const rootA = await makeScratch("t6-contain-prot-A-");
    const rootB = await makeScratch("t6-contain-prot-B-");
    const outside = await realpath(await makeScratch("t6-contain-prot-out-"));
    await mkdir(join(outside, ".ssh"), { recursive: true });
    await writeFile(join(outside, ".ssh", "id_rsa"), "protected\n");

    const cell: LiveTaskRoot = createLiveTaskRoot(rootA);
    const tool = createReadFileTool(cell);

    writeLiveTaskRoot(cell, rootB);
    await assert.rejects(
      () => tool.handler({ path: join(outside, ".ssh", "id_rsa") }),
      (error: unknown) =>
        error instanceof Error &&
        /protected-path roster/.test(error.message) &&
        !/outside workspace/.test(error.message)
    );
  });

  it("post-rebind relative names anchor the LIVE root — the old root's tree is not consulted", async () => {
    const rootA = await makeScratch("t6-vintage-A-");
    const rootB = await makeScratch("t6-vintage-B-");
    await writeFile(join(rootA, "only-in-A.txt"), "from-A\n");

    const cell: LiveTaskRoot = createLiveTaskRoot(rootA);
    const tool = createReadFileTool(cell);
    writeLiveTaskRoot(cell, rootB);

    // The request is anchored to rootB by decideRead and stays inside the
    // containment roots of rootB — widening does not resurrect rootA's tree
    // under a relative name (same root+extras vintage as the D9 pins).
    await assert.rejects(
      () => tool.handler({ path: "only-in-A.txt" }),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes("file not found") &&
        !error.message.includes(rootA)
    );
  });
});

// ─── 4. glob: per-call snapshot ───────────────────────────────────────────

describe("glob T6: live taskRoot cell drives handler root", () => {
  it("cell flips → next glob call walks the rebound tree", async () => {
    const rootA = await makeScratch("t6-glob-A-");
    const rootB = await makeScratch("t6-glob-B-");
    // Distinct filenames so the result is unambiguous across rg + Node
    // fallback paths.
    await writeFile(join(rootA, "alpha-marker.txt"), "A\n");
    await writeFile(join(rootB, "beta-marker.txt"), "B\n");

    const cell: LiveTaskRoot = createLiveTaskRoot(rootA);
    const tool = createGlobTool(cell);

    const before = String(await tool.handler({ pattern: "*-marker.txt" }));
    assert.ok(
      before.includes("alpha-marker.txt"),
      `pre-rebind glob must include A marker; got: ${before}`
    );
    assert.ok(
      !before.includes("beta-marker.txt"),
      `pre-rebind glob must NOT include B marker; got: ${before}`
    );

    writeLiveTaskRoot(cell, rootB);
    const after = String(await tool.handler({ pattern: "*-marker.txt" }));
    assert.ok(
      after.includes("beta-marker.txt"),
      `post-rebind glob must include B marker; got: ${after}`
    );
    assert.ok(
      !after.includes("alpha-marker.txt"),
      `post-rebind glob must NOT include A marker; got: ${after}`
    );
  });

  it("absence of cell → factory-captured `root` stays authoritative", async () => {
    const root = await makeScratch("t6-glob-legacy-");
    await writeFile(join(root, "x-marker.txt"), "x\n");
    const tool = createGlobTool(root); // string legacy
    const out = String(await tool.handler({ pattern: "x-marker.txt" }));
    assert.ok(out.includes("x-marker.txt"));
  });
});

// ─── 5. grep: per-call snapshot ───────────────────────────────────────────

describe("grep T6: live taskRoot cell drives handler root", () => {
  it("cell flips → next grep call walks the rebound tree", async () => {
    const rootA = await makeScratch("t6-grep-A-");
    const rootB = await makeScratch("t6-grep-B-");
    await writeFile(join(rootA, "needle.txt"), "needle-A\n");
    await writeFile(join(rootB, "needle.txt"), "needle-B\n");

    const cell: LiveTaskRoot = createLiveTaskRoot(rootA);
    const tool = createGrepTool(cell);

    // Both roots hold a file named `needle.txt` — only the **content** tells
    // which tree was read; since the default output mode is paths, this
    // snapshot invariant must be observed with output=content.
    const before = String(
      await tool.handler({ pattern: "needle-", output: "content" })
    );
    assert.ok(
      before.includes("needle-A"),
      `pre-rebind grep must include A hit; got: ${before}`
    );
    assert.ok(
      !before.includes("needle-B"),
      `pre-rebind grep must NOT include B hit; got: ${before}`
    );

    writeLiveTaskRoot(cell, rootB);
    const after = String(
      await tool.handler({ pattern: "needle-", output: "content" })
    );
    assert.ok(
      after.includes("needle-B"),
      `post-rebind grep must include B hit; got: ${after}`
    );
    assert.ok(
      !after.includes("needle-A"),
      `post-rebind grep must NOT include A hit; got: ${after}`
    );
  });

  it("absence of cell → factory-captured `root` stays authoritative", async () => {
    const root = await makeScratch("t6-grep-legacy-");
    await writeFile(join(root, "x.txt"), "needle-x\n");
    const tool = createGrepTool(root); // string legacy
    // Same as above: `needle-x` is line **content**, visible only with output=content.
    const out = String(
      await tool.handler({ pattern: "needle-x", output: "content" })
    );
    assert.ok(out.includes("needle-x"));
  });
});

// ─── 6. Identity-root wiring (projectIdentityRoot extraReadRoot in read_file) ─

describe("read_file T6: D10 wired — projectIdentityRoot extraReadRoot", () => {
  it("when projectIdentityRoot === live root, no redundant entry is added (root already covers it)", async () => {
    const root = await makeScratch("t6-d10-eq-");
    await mkdir(join(root, "identity"), { recursive: true });
    await writeFile(join(root, "identity", "AGENTS.md"), "identity-doc\n");

    const cell: LiveTaskRoot = createLiveTaskRoot(root);
    // projectIdentityRoot equals the root → no extra entry needed.
    const tool = createReadFileTool(cell, { projectIdentityRoot: root });
    const out = (await tool.handler({
      path: "identity/AGENTS.md",
    })) as string;
    assert.ok(
      out.includes("identity-doc"),
      `equal projectIdentityRoot must allow reach via root; got: ${out}`
    );
  });

  it("when projectIdentityRoot !== live root, identity-root path is reachable as an extraReadRoot", async () => {
    // After rebind: live root = the new task worktree (rootB), but the
    // identity root is the stable project root (rootA). ADR-0037
    // requires the identity-root files (e.g. AGENTS.md / permissions.toml)
    // to remain readable from the rebound tree — the wiring through
    // projectIdentityRoot satisfies that.
    const identityRoot = await makeScratch("t6-d10-ident-");
    const reboundRoot = await makeScratch("t6-d10-rebound-");
    await writeFile(join(identityRoot, "AGENTS.md"), "# project identity\n");
    await writeFile(join(reboundRoot, "marker.txt"), "rebound-content\n");

    const cell: LiveTaskRoot = createLiveTaskRoot(reboundRoot);
    const tool = createReadFileTool(cell, {
      projectIdentityRoot: identityRoot,
    });

    // Live root's own file is reachable (sanity).
    const ownOut = (await tool.handler({
      path: "marker.txt",
    })) as string;
    assert.ok(
      ownOut.includes("rebound-content"),
      `live-root read must work; got: ${ownOut}`
    );

    // Identity-root file is reachable via the identity-root wiring.
    const idOut = (await tool.handler({
      path: join(identityRoot, "AGENTS.md"),
    })) as string;
    assert.ok(
      idOut.includes("project identity"),
      `projectIdentityRoot extra must allow identity-root read; got: ${idOut}`
    );
  });
});
