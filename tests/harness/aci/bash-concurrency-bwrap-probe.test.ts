/**
 * ADR-0141 invariant 9 — the bwrap re-check CADENCE under concurrency.
 *
 * `createBwrapFence` re-checks bwrap's presence on EVERY fenced call: a
 * success is evidence about one moment, because bwrap can disappear
 * mid-session (package removed, PATH changed) after the assembly-time probe
 * passed. The check is never cached across calls.
 *
 * The question this file answers: do CONCURRENT calls each perform their OWN
 * check, or is one call's check result shared with its neighbour?
 *
 * The seam needs no production change: `createBwrapFence(opts, probe =
 * requireBwrap)` calls the probe on every fenced call, and `requireBwrap`
 * lives in `src/harness/sandbox/runner.ts`. The repo's established
 * interception pattern for that module is in
 * `tests/harness/aci/bash-unbound-fence.test.ts`; here `requireBwrap` is a
 * COUNTER instead of a no-op, so the number of checks is observable.
 *
 * The two calls are driven through the REAL bash handler — the fence is the
 * thing under test, so the handler must really run — and the two calls must
 * really overlap: the overlap is asserted, not assumed. The sandbox itself is
 * stubbed (`runInSandbox`), so nothing is spawned; only the fence assembly
 * and its per-call probe are real.
 *
 * The factory's own construction-time probe is counted separately: it is NOT
 * a per-call check, so the counter is reset after the tool is built.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/** Module-level capture box (vi.hoisted: the mock factories read it at import time). */
const h = vi.hoisted(() => ({
  /** how many times the bwrap presence probe ran. */
  probes: 0,
  /** the sandbox seam's call windows (one per fenced call that reached it). */
  sandboxCalls: [] as Array<{ start: number; end: number }>,
}));

vi.mock("../../../src/harness/sandbox/runner.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../src/harness/sandbox/runner.js")
    >();
  return {
    ...actual,
    // The probe becomes a counter: every fenced call must run it for itself.
    requireBwrap: () => {
      h.probes += 1;
    },
    runInSandbox: vi.fn(async () => {
      const start = Date.now();
      // The window is wide enough that two concurrent calls are observably
      // concurrent (a serial run would take twice as long and never overlap).
      await new Promise((r) => setTimeout(r, 300));
      const end = Date.now();
      h.sandboxCalls.push({ start, end });
      return { exitCode: 0, stdout: "", stderr: "" };
    }),
  };
});

import { createAciExecutor } from "../../../src/harness/aci/aci-executor.ts";
import { createPermissionPolicy } from "../../../src/harness/aci/permission.ts";
import { createBashTool } from "../../../src/harness/aci/tools/bash.ts";
import { createLiveTaskRoot } from "../../../src/harness/session-roots.ts";
import { createExecutor } from "../../../src/harness/tools/executor.ts";
import { createRegistry } from "../../../src/harness/tools/registry.ts";
import type { AciCatalog, AciToolDef } from "../../../src/harness/aci/types.ts";

const scratch: string[] = [];

function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "iknow-bwrap-probe-"));
  scratch.push(dir);
  return dir;
}

afterEach(() => {
  h.probes = 0;
  h.sandboxCalls.length = 0;
  for (const dir of scratch.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** The bash tool under test: the fence is either in force or retired. */
function makeTool(opts: { readonly fenceRetired: boolean }): AciToolDef {
  const main = scratchDir();
  const pad = scratchDir();
  const home = scratchDir();
  return createBashTool(main, {
    liveTaskRoot: createLiveTaskRoot(main),
    tmpDir: pad,
    homeRoot: home,
    ...(opts.fenceRetired ? { fenceRetired: { get: () => true } } : {}),
  });
}

function makeCatalog(tools: AciToolDef[]): AciCatalog {
  const byName = new Map(tools.map((t) => [t.name, t]));
  return Object.freeze({
    get: (n: string) => byName.get(n),
    all: () => Object.freeze([...tools]) as ReadonlyArray<AciToolDef>,
  });
}

/**
 * Drive the given read-only bash calls through the REAL handler, in one wave.
 * The bash policy allows the calls, so the executor starts them concurrently
 * (the "allow" stage), not one at a time (the approval stage).
 */
async function runConcurrentCalls(
  tool: AciToolDef,
  commands: readonly string[]
): Promise<ReadonlyArray<{ kind: string; toolUseId: string }>> {
  const registry = createRegistry([tool]);
  const aciExec = createAciExecutor({
    inner: createExecutor(registry),
    catalog: makeCatalog([tool]),
    policy: createPermissionPolicy({ defaultRule: "allow" }),
  });
  return await aciExec.executeAll(
    commands.map((command, i) => ({
      id: `c${i}`,
      name: "bash",
      input: { command },
    }))
  );
}

/** Do the two sandbox windows overlap in time? */
function sandboxCallsOverlap(): boolean {
  const [a, b] = h.sandboxCalls;
  if (a === undefined || b === undefined) return false;
  return a.start < b.end && b.start < a.end;
}

describe("bash — the per-call bwrap re-check cadence (ADR-0141 invariant 9)", () => {
  it("one fenced call runs exactly ONE check (the cadence is per call, not per wave)", async () => {
    const tool = makeTool({ fenceRetired: false });

    // The factory's own construction-time probe: exactly one, and it is NOT a
    // per-call check — the counter is reset before the calls run.
    expect(h.probes).toBe(1);
    h.probes = 0;

    const results = await runConcurrentCalls(tool, ["pwd"]);

    expect(results.length).toBe(1);
    expect(results.every((r) => r.kind === "ok")).toBe(true);
    expect(h.sandboxCalls.length).toBe(1);
    // One call, one check.
    expect(h.probes).toBe(1);
  });

  it("two concurrent read-only calls each run their OWN bwrap check (2 probes, not 1)", async () => {
    const tool = makeTool({ fenceRetired: false });

    // The factory's own construction-time probe: exactly one, and it is NOT a
    // per-call check — the counter is reset before the calls run.
    expect(h.probes).toBe(1);
    h.probes = 0;

    const results = await runConcurrentCalls(tool, ["pwd", "ls"]);

    // Both calls succeeded …
    expect(results.length).toBe(2);
    expect(results.every((r) => r.kind === "ok")).toBe(true);
    // … and they really overlapped: the two sandbox windows intersect.
    expect(h.sandboxCalls.length).toBe(2);
    expect(sandboxCallsOverlap()).toBe(true);
    // Each concurrent call performed its OWN check: the result of one call's
    // check was not shared with (nor skipped by) its neighbour.
    expect(h.probes).toBe(2);
  });

  it("the fence RETIRED: no per-call check happens at all (0 probes)", async () => {
    const tool = makeTool({ fenceRetired: true });

    // The retired assembly skips the factory probe too.
    expect(h.probes).toBe(0);

    const results = await runConcurrentCalls(tool, ["pwd", "ls"]);

    expect(results.length).toBe(2);
    expect(results.every((r) => r.kind === "ok")).toBe(true);
    // The two calls still ran concurrently …
    expect(h.sandboxCalls.length).toBe(2);
    expect(sandboxCallsOverlap()).toBe(true);
    // … and no fenced call happened, so no bwrap check was performed.
    expect(h.probes).toBe(0);
  });
});
