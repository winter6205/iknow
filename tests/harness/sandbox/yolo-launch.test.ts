/**
 * ADR-0119 §launch / specs/yolo-mode.md T3–T4 — `enterAtLaunch`, the startup
 * state combination behind `--yolo`.
 *
 * The bug this pins: `createYoloContext(options.yolo)` seeds the holder (which
 * retires the fence at assembly time) but the holder seeding alone leaves
 * permission at `default` — a half-applied posture (fence gone, prompts kept).
 * `enterAtLaunch` must apply the same combination the `/yolo` confirmation
 * applies, and it must do so WITHOUT the enter-side probe refusal: the spec's
 * requireBwrap sequencing ruling says a bwrap-less host does not block yolo
 * assembly; only the exit stays probe-guarded there.
 */
import { describe, expect, it } from "vitest";

import { ToolExecutionError } from "../../../src/harness/errors.js";
import { createPermissionModeContext } from "../../../src/harness/permission/index.js";
import { createFsModeContext } from "../../../src/harness/sandbox/fs-mode.js";
import {
  createYoloContext,
  createYoloController,
  YOLO_ALREADY_ON_TEXT,
  YOLO_ENTER_TEXT,
} from "../../../src/harness/sandbox/yolo.js";

function makeLaunchFixture(seed: unknown, probeWorks = true) {
  const yolo = createYoloContext(seed);
  const permission = createPermissionModeContext("default");
  const fsMode = createFsModeContext("workspace");
  const controller = createYoloController({
    yolo,
    permission,
    fsMode,
    probe: () => {
      if (!probeWorks) {
        throw new ToolExecutionError("bwrap not available (injected)");
      }
    },
  });
  return { yolo, permission, fsMode, controller };
}

describe("enterAtLaunch: --yolo startup applies the T3 enter combination", () => {
  it("holder seeded by the flag alone is not enough — permission lands on full_auto, workspace fsMode on global", () => {
    const fx = makeLaunchFixture(true);
    const result = fx.controller.enterAtLaunch();

    expect(result).toEqual({ ok: true, yolo: true, text: YOLO_ENTER_TEXT });
    expect(fx.yolo.get()).toBe(true);
    expect(fx.permission.get()).toBe("full_auto");
    expect(fx.fsMode.get()).toBe("global");
  });

  it("exit after a launched entry restores the pre-launch values (ADR-0119: snapshot = startup initial values)", () => {
    const fx = makeLaunchFixture(true);
    fx.controller.enterAtLaunch();

    const result = fx.controller.exit();
    expect(result.ok).toBe(true);
    expect(fx.yolo.get()).toBe(false);
    expect(fx.permission.get()).toBe("default");
    expect(fx.fsMode.get()).toBe("workspace");
  });

  it("bwrap-less host: launch entry is NOT probe-refused (assembly stays open), exit still refuses with zero state change", () => {
    const fx = makeLaunchFixture(true, false);

    expect(fx.controller.enterAtLaunch().ok).toBe(true);
    expect(fx.permission.get()).toBe("full_auto");

    const exit = fx.controller.exit();
    expect(exit.ok).toBe(false);
    expect(fx.yolo.get()).toBe(true);
    expect(fx.permission.get()).toBe("full_auto");
    expect(fx.fsMode.get()).toBe("global");
  });

  it("once-guard: a repeat launch entry never re-snapshots a mid-session permission flip (ruling 6)", () => {
    const fx = makeLaunchFixture(true);
    fx.controller.enterAtLaunch();
    fx.permission.set("plan");

    const second = fx.controller.enterAtLaunch();
    expect(second.ok).toBe(true);
    expect(second.text).toBe(YOLO_ALREADY_ON_TEXT);

    fx.controller.exit();
    expect(fx.permission.get()).toBe("default");
  });

  it("fail-closed seeds (undefined / unparsable / false) leave the launch path uncalled — holders untouched", () => {
    for (const seed of [undefined, "maybe", "0", false]) {
      const fx = makeLaunchFixture(seed);
      expect(fx.yolo.get()).toBe(false);
      expect(fx.permission.get()).toBe("default");
      expect(fx.fsMode.get()).toBe("workspace");
    }
  });
});
