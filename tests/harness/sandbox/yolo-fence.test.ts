/**
 * ADR-0119 / specs/yolo-mode.md — the yolo branch of the fence factory (the
 * single SSOT point behind all four routes).
 *
 * Invariants pinned here (Contract "input contract table", fence row + §6
 * four-route consistency):
 *   - yolo `=== true` -> bare argv: `[command, ...args]`, no bwrap prefix, no
 *     netns, no mounts, no clearenv / setenv;
 *   - yolo absent / false / non-boolean -> non-yolo (fail-closed), argv
 *     byte-identical to the baseline (the V1 baseline regression contract);
 *   - yolo + workspace fsMode -> yolo wins: fsMode does not affect argv (with the
 *     fence retired the tier has nothing to carry), and a missing homeRoot does
 *     not trigger the workspace tier's fail-loud either;
 *   - yolo + an egress spec passed in -> egress has no effect: no socket
 *     `--bind`, no proxy env (the non-yolo control proves the same spec does
 *     emit under non-yolo).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
  createBwrapFence,
  type BwrapFenceOptions,
} from "../../../src/harness/sandbox/bwrap.js";
import type { EgressFenceSpec } from "../../../src/harness/sandbox/egress/session.js";
import { createFsPolicy } from "../../../src/harness/sandbox/fs-policy.js";

const FIX_ROOT = mkdtempSync(join(tmpdir(), "yolo-fence-"));
const TMP = mkdtempSync(join(tmpdir(), "yolo-fence-tmp-"));

afterAll(() => {
  rmSync(FIX_ROOT, { recursive: true, force: true });
  rmSync(TMP, { recursive: true, force: true });
});

function baseFenceOpts(
  extra: Partial<BwrapFenceOptions> = {}
): BwrapFenceOptions {
  return {
    command: "bash",
    args: ["-c", "echo hi"],
    fsPolicy: createFsPolicy({ tmpDir: TMP }),
    env: { PATH: "/bin" },
    cwd: FIX_ROOT,
    ...extra,
  };
}

/** Non-yolo baseline argv — a live sample of the bwrap global-tier (ADR-0092) shape. */
const BASELINE_NON_YOLO_ARGV = createBwrapFence(baseFenceOpts()).argv;

function egressSpec(): EgressFenceSpec {
  return {
    unixSocketPath: join(TMP, "egress.sock"),
    sandboxLocalPort: 18080,
    env: {
      HTTP_PROXY: "http://127.0.0.1:18080",
      HTTPS_PROXY: "http://127.0.0.1:18080",
      NO_PROXY: "127.0.0.1,localhost",
    },
    innerBridgeScript: "",
    relayAssetsDir: "",
  };
}

describe("createBwrapFence yolo branch (ADR-0119)", () => {
  it("yolo true -> bare argv: argv[0] = command, no bwrap prefix / mounts / env face", () => {
    const argv = createBwrapFence(baseFenceOpts({ yolo: true })).argv;
    expect(argv).toEqual(["bash", "-c", "echo hi"]);
  });

  it("yolo absent -> byte-identical to baseline (argv[0] = bwrap, --unshare-net always present)", () => {
    const argv = createBwrapFence(baseFenceOpts()).argv;
    expect(argv).toEqual(BASELINE_NON_YOLO_ARGV);
    expect(argv[0]).toBe("bwrap");
    expect(argv).toContain("--unshare-net");
  });

  it("yolo false -> the same baseline token sequence as when absent (fail-closed, same shape)", () => {
    const argv = createBwrapFence(baseFenceOpts({ yolo: false })).argv;
    expect(argv).toEqual(BASELINE_NON_YOLO_ARGV);
  });

  it("yolo non-boolean ('true' / 1) -> treated as false, no throw, baseline unchanged", () => {
    for (const bad of ["true", 1]) {
      const argv = createBwrapFence(
        baseFenceOpts({ yolo: bad as unknown as boolean })
      ).argv;
      expect(argv).toEqual(BASELINE_NON_YOLO_ARGV);
    }
  });

  it("yolo + workspace fsMode -> yolo wins: argv exactly equals yolo + global (fsMode has nothing to carry)", () => {
    const withWorkspace = createBwrapFence(
      baseFenceOpts({
        yolo: true,
        fsPolicy: createFsPolicy({ tmpDir: TMP, mode: "workspace" }),
        homeRoot: homedir(),
        workspaceRoot: FIX_ROOT,
        tmpRoot: TMP,
      })
    ).argv;
    const withGlobal = createBwrapFence(baseFenceOpts({ yolo: true })).argv;
    // With the fence retired the tier has zero effect on argv, and a missing
    // homeRoot does not fail loud either.
    expect(withWorkspace).toEqual(withGlobal);
    expect(withWorkspace).toEqual(["bash", "-c", "echo hi"]);
  });

  it("yolo + an egress spec -> egress has no effect: no socket --bind, no proxy env", () => {
    const spec = egressSpec();
    const argv = createBwrapFence(
      baseFenceOpts({ yolo: true, egress: spec })
    ).argv;
    expect(argv).toEqual(["bash", "-c", "echo hi"]);
    // The yolo branch does not consume egress: no socket bind, no --setenv (the
    // bare argv already excludes both; asserted key by key so the bare shape
    // cannot be loosened later without this firing).
    expect(argv.join("\u0000")).not.toContain(spec.unixSocketPath);
    expect(argv).not.toContain("--setenv");
  });

  it("control case: the same egress spec does emit socket bind + proxy env under non-yolo", () => {
    const spec = egressSpec();
    const argv = createBwrapFence(baseFenceOpts({ egress: spec })).argv;
    expect(argv).toContain("--bind");
    expect(argv).toContain(spec.unixSocketPath);
    expect(argv).toContain("--setenv");
    expect(argv).toContain("HTTP_PROXY");
  });
});
