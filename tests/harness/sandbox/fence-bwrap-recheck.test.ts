/**
 * ADR-0141 invariant 9 — bwrap presence is rechecked on EVERY fenced call, not
 * only at assembly (specs/yolo-mode.md:83).
 *
 * The three arms, all of which fail while the probe runs only at assembly:
 *   (a) a host that never had bwrap refuses the first fenced call — and does so
 *       through a typed error, never by running the command unfenced;
 *   (b) bwrap removed after a successful call refuses the NEXT call (no
 *       cross-call caching of success);
 *   (c) with the fence retired the probe is never called at all — a retired
 *       fence has no binary to require.
 *
 * Fixture discipline: the probe is injected rather than shadowing a real
 * `bwrap` on PATH, so the test says what it means and touches no host state.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
  createBwrapFence,
  type BwrapFenceOptions,
} from "../../../src/harness/sandbox/bwrap.js";
import { createFsPolicy } from "../../../src/harness/sandbox/fs-policy.js";
import { ToolExecutionError } from "../../../src/harness/errors.js";

const FIX_ROOT = mkdtempSync(join(tmpdir(), "fence-recheck-"));
const TMP = mkdtempSync(join(tmpdir(), "fence-recheck-tmp-"));

afterAll(() => {
  rmSync(FIX_ROOT, { recursive: true, force: true });
  rmSync(TMP, { recursive: true, force: true });
});

interface Probe {
  readonly calls: () => number;
  readonly setAvailable: (available: boolean) => void;
  /** The injectable probe handed to `createBwrapFence`. */
  readonly run: () => void;
}

function makeProbe(startsAvailable = true): Probe {
  let available = startsAvailable;
  let calls = 0;
  return {
    calls: () => calls,
    setAvailable: (next: boolean): void => {
      available = next;
    },
    run: (): void => {
      calls += 1;
      if (!available) {
        throw new ToolExecutionError(
          "bwrap: required for this fenced call; install bwrap (≥ 0.11.1)"
        );
      }
    },
  };
}

function fenceOpts(extra: Partial<BwrapFenceOptions> = {}): BwrapFenceOptions {
  return {
    command: "bash",
    args: ["-c", "echo hi"],
    fsPolicy: createFsPolicy({ tmpDir: TMP }),
    env: { PATH: "/bin" },
    cwd: FIX_ROOT,
    ...extra,
  };
}

describe("per-fenced-call bwrap recheck (ADR-0141 invariant 9)", () => {
  it("(a) a host without bwrap refuses the call with a typed error and builds no argv", () => {
    const probe = makeProbe(false);
    expect(() =>
      createBwrapFence(fenceOpts(), probe.run)
    ).toThrowError(ToolExecutionError);
    expect(probe.calls()).toBe(1);
  });

  it("(b) bwrap removed after a successful call refuses the NEXT call (no cached success)", () => {
    const probe = makeProbe(true);
    const first = createBwrapFence(fenceOpts(), probe.run);
    expect(first.argv[0]).toBe("bwrap");
    expect(probe.calls()).toBe(1);

    probe.setAvailable(false);
    expect(() => createBwrapFence(fenceOpts(), probe.run)).toThrowError(
      ToolExecutionError
    );
    expect(probe.calls()).toBe(2);
  });

  it("(c) a retired fence never probes — there is no binary to require", () => {
    const probe = makeProbe(false);
    const fence = createBwrapFence(
      fenceOpts({ fenceRetired: true }),
      probe.run
    );
    expect(fence.argv).toEqual(["bash", "-c", "echo hi"]);
    expect(probe.calls()).toBe(0);
  });

  it("(d) every fenced call probes — two calls are two probes, not one", () => {
    const probe = makeProbe(true);
    createBwrapFence(fenceOpts(), probe.run);
    createBwrapFence(fenceOpts(), probe.run);
    expect(probe.calls()).toBe(2);
  });
});
