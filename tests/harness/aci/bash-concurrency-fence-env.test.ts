/**
 * #D2 — the FENCE ENV of a per-call concurrency-safe bash call, and the
 * per-call fence invariant.
 *
 * Two facts this file pins, both about the PRODUCTION handler (the object
 * under test is the bash tool, not a re-implementation of it):
 *
 * 1. The env injection. A call the per-call concurrency predicate
 *    (`isReadonlyBashConcurrencySafe`) judges safe AND whose command actually
 *    runs git gets `GIT_OPTIONAL_LOCKS=0` in the fence env, so two concurrent
 *    `git status` calls in the SAME repository do not race on
 *    `.git/index.lock`. The trigger has TWO halves and both are pinned here:
 *      - a call the predicate REJECTS gets nothing added — the fence env
 *        stays exactly as it was;
 *      - a call that does NOT run git gets nothing added either — the
 *        variable is git-specific, and a read-only call that never runs git
 *        (`ls`, `pwd`, `cat file`) must not carry it. Widening the trigger
 *        back to "the verdict alone" makes these cases RED.
 *    The variable reaches the bwrap argv through the `envArgs` mechanism
 *    (`--setenv <NAME> <VALUE>`, see `src/harness/sandbox/bwrap.ts`).
 *
 * 2. The per-call fence. Two concurrent read-only calls each build their OWN
 *    fence — each argv carries its own netns flag (`--unshare-net`) — i.e. the
 *    two calls did not share one fence.
 *
 * The seam needs no production change: the fence the handler assembles is
 * handed to `runInSandbox` as `opts.fence`, and `runInSandbox` lives in
 * `src/harness/sandbox/runner.ts`. The repo's established interception pattern
 * for that module is `tests/harness/aci/bash-unbound-fence.test.ts`; here the
 * whole module is replaced by `vi.mock` (as `bash-concurrency-bwrap-probe.test.ts`
 * also does), so the captured fence argv is the REAL one the production
 * `createBwrapFence` produced.
 *
 * Why the drive differs per test: the env assertions read the fence of ONE
 * call, so the handler is invoked directly (`tool.handler({ command })` — the
 * production handler, exactly as `bash-unbound-fence.test.ts` drives it). The
 * per-call fence test needs the two calls to be CONCURRENT, so they go
 * through the real ACI executor with the REAL catalog projection
 * (`createAciCatalog(registry)`) — the same path production takes, so the
 * wave formation itself is under test too.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/** Module-level capture box (vi.hoisted: the mock factory reads it at import time). */
const h = vi.hoisted(() => ({
  /** one entry per fenced call that reached the sandbox seam. */
  fences: [] as Array<{ readonly argv: readonly string[] }>,
  /** the call windows (one per fenced call) — used to prove overlap. */
  windows: [] as Array<{ start: number; end: number }>,
}));

vi.mock("../../../src/harness/sandbox/runner.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../src/harness/sandbox/runner.js")
    >();
  return {
    ...actual,
    // The real probe would fail loud on a host without bwrap; the fence is
    // what is under test, not bwrap's presence.
    requireBwrap: () => {},
    runInSandbox: vi.fn(
      async (opts: Parameters<typeof actual.runInSandbox>[0]) => {
        const start = Date.now();
        h.fences.push(opts.fence);
        // Hold the call open so a neighbour can overlap it (a serial run would
        // take twice as long and the two windows would not intersect).
        await new Promise((r) => setTimeout(r, 120));
        h.windows.push({ start, end: Date.now() });
        return { exitCode: 0, stdout: "", stderr: "" };
      }
    ),
  };
});

import { createAciExecutor } from "../../../src/harness/aci/aci-executor.ts";
import { createPermissionPolicy } from "../../../src/harness/aci/permission.ts";
import { createBashTool } from "../../../src/harness/aci/tools/bash.ts";
import { createAciCatalog } from "../../../src/harness/permission/permission-executor.ts";
import { createLiveTaskRoot } from "../../../src/harness/session-roots.ts";
import { createExecutor } from "../../../src/harness/tools/executor.ts";
import { createRegistry } from "../../../src/harness/tools/registry.ts";
import type { AciToolDef } from "../../../src/harness/aci/types.ts";

const scratch: string[] = [];

function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "iknow-bash-fence-env-"));
  scratch.push(dir);
  return dir;
}

afterEach(() => {
  h.fences.length = 0;
  h.windows.length = 0;
  for (const dir of scratch.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** The bash tool under test (the REAL production factory). */
function makeTool(): AciToolDef {
  const main = scratchDir();
  const pad = scratchDir();
  const home = scratchDir();
  return createBashTool(main, {
    liveTaskRoot: createLiveTaskRoot(main),
    tmpDir: pad,
    homeRoot: home,
  });
}

/** The fence argv of the ONE call the handler just made. */
function lastFenceArgv(): readonly string[] {
  expect(h.fences.length).toBe(1);
  return h.fences[0]!.argv;
}

/**
 * Is `--setenv GIT_OPTIONAL_LOCKS 0` among the argv's `--setenv` triples?
 *
 * The env reaches the fence as a `--setenv NAME VALUE` triple, so the check
 * walks the triples — `indexOf("GIT_OPTIONAL_LOCKS")` alone would not prove the
 * value, and a lone `--setenv` scan would not prove the NAME.
 */
function hasGitOptionalLocksZero(argv: readonly string[]): boolean {
  return argv.some(
    (arg, i) =>
      arg === "--setenv" &&
      argv[i + 1] === "GIT_OPTIONAL_LOCKS" &&
      argv[i + 2] === "0"
  );
}

describe("bash fence env — the per-call concurrency injection (#D2)", () => {
  it("a READ-ONLY GIT call gets --setenv GIT_OPTIONAL_LOCKS 0 in its fence argv", async () => {
    const tool = makeTool();

    await tool.handler({ command: "git status" });

    const argv = lastFenceArgv();
    expect(hasGitOptionalLocksZero(argv)).toBe(true);
  });

  it("a READ-ONLY call that does NOT run git gets NO --setenv GIT_OPTIONAL_LOCKS 0", async () => {
    // The variable is git-specific. `ls` is concurrency-safe (the predicate
    // judges it safe) but it never runs git, so it must not carry the
    // variable — injecting it would change the env of every read-only call
    // for a race they cannot have. Widening the trigger back to "the verdict
    // alone" turns this case RED.
    const tool = makeTool();

    await tool.handler({ command: "ls" });

    const argv = lastFenceArgv();
    expect(hasGitOptionalLocksZero(argv)).toBe(false);
    // The fence itself is real (the negative case is not vacuous).
    expect(argv.includes("--unshare-net")).toBe(true);
    expect(argv.includes("--clearenv")).toBe(true);
  });

  it("a call the predicate REJECTS gets NO --setenv GIT_OPTIONAL_LOCKS 0", async () => {
    // `touch newfile` mutates the filesystem: the readonly policy rejects it
    // (`touch` is not in the readonly roster), so the concurrency predicate
    // answers false. The call still runs (bashMode "any"), so a fence IS
    // built — and that fence must carry today's env, unchanged.
    const tool = makeTool();

    await tool.handler({ command: "touch newfile" });

    const argv = lastFenceArgv();
    expect(hasGitOptionalLocksZero(argv)).toBe(false);
    // The fence itself is real (the negative case is not vacuous): the argv
    // carries the isolation flags a fence always carries.
    expect(argv.includes("--unshare-net")).toBe(true);
    expect(argv.includes("--clearenv")).toBe(true);
  });
});

describe("bash per-call fence — two concurrent read-only calls each get their OWN fence", () => {
  it("2 fences, 2 netns flags, 2 distinct fence objects (no shared fence)", async () => {
    const tool = makeTool();
    const registry = createRegistry([tool]);
    // The REAL catalog projection: `createAciExecutor` reads the PROJECTED
    // def, so the per-call predicate has to survive the projection for the
    // two calls to land in one wave at all.
    const aciExec = createAciExecutor({
      inner: createExecutor(registry),
      catalog: createAciCatalog(registry),
      policy: createPermissionPolicy({ defaultRule: "allow" }),
    });

    const results = await aciExec.executeAll([
      { id: "c0", name: "bash", input: { command: "git status" } },
      { id: "c1", name: "bash", input: { command: "git log --oneline -5" } },
    ]);

    expect(results.length).toBe(2);
    expect(results.every((r) => r.kind === "ok")).toBe(true);

    // Each concurrent call built its OWN fence — two fences, not one shared.
    expect(h.fences.length).toBe(2);
    expect(h.fences[0]).not.toBe(h.fences[1]);
    // Each argv carries its own netns flag (the bwrap network-isolation flag).
    for (const fence of h.fences) {
      expect(fence.argv.includes("--unshare-net")).toBe(true);
    }
    // Both calls were concurrency-safe AND both run git, so both fences
    // carry the injection.
    for (const fence of h.fences) {
      expect(hasGitOptionalLocksZero(fence.argv)).toBe(true);
    }
    // … and they really overlapped (the two sandbox windows intersect): the
    // two calls ran in ONE wave, not one after the other.
    expect(h.windows.length).toBe(2);
    const [a, b] = h.windows;
    expect(a!.start < b!.end && b!.start < a!.end).toBe(true);
  });

  it("one wave, one git call and one non-git call: only the git fence carries the injection", async () => {
    // The two calls share ONE wave (both are read-only), so the trigger is
    // decided per CALL, not per wave: the git call carries the variable, the
    // non-git call does not. The fence argv ends with `-- bash -c <command>`,
    // so the command text identifies which fence is which.
    const tool = makeTool();
    const registry = createRegistry([tool]);
    const aciExec = createAciExecutor({
      inner: createExecutor(registry),
      catalog: createAciCatalog(registry),
      policy: createPermissionPolicy({ defaultRule: "allow" }),
    });

    const results = await aciExec.executeAll([
      { id: "g0", name: "bash", input: { command: "git status" } },
      { id: "p0", name: "bash", input: { command: "pwd" } },
    ]);

    expect(results.length).toBe(2);
    expect(results.every((r) => r.kind === "ok")).toBe(true);
    expect(h.fences.length).toBe(2);

    const gitFence = h.fences.find((f) => f.argv.includes("git status"));
    const plainFence = h.fences.find((f) => f.argv.includes("pwd"));
    expect(gitFence).toBeDefined();
    expect(plainFence).toBeDefined();
    expect(hasGitOptionalLocksZero(gitFence!.argv)).toBe(true);
    expect(hasGitOptionalLocksZero(plainFence!.argv)).toBe(false);
  });
});
