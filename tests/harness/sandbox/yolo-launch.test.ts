/**
 * ADR-0119 §launch / specs/yolo-mode.md T3–T4 — `enterAtLaunch`, the startup
 * state combination behind `--yolo`.
 *
 * The bug this pins: `createYoloContext(options.yolo)` seeds the holder (which
 * retires the fence at assembly time) but the holder seeding alone leaves the
 * fs tier as it was — a half-applied fence posture. `enterAtLaunch` must apply
 * the same fence combination the `/yolo` confirmation applies, and it must do
 * so WITHOUT the enter-side probe refusal: the spec's requireBwrap sequencing
 * ruling says a bwrap-less host does not block yolo assembly; only the exit
 * stays probe-guarded there.
 *
 * The permission axis is NOT part of the launch combination (ADR-0139): entry
 * writes the fence axis only, so these cases pin that the permission holder
 * passes through the launch untouched — from `default` and from every other
 * starting mode alike.
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
import type { PermissionMode } from "../../../src/harness/permission/modes.js";

function makeLaunchFixture(
  seed: unknown,
  probeWorks = true,
  permissionStart: PermissionMode = "default"
) {
  const yolo = createYoloContext(seed);
  const permission = createPermissionModeContext(permissionStart);
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

describe("enterAtLaunch: --yolo startup applies the fence enter combination", () => {
  it("holder seeded by the flag alone is not enough — workspace fsMode on global, permission untouched", () => {
    const fx = makeLaunchFixture(true);
    const result = fx.controller.enterAtLaunch();

    expect(result).toEqual({ ok: true, yolo: true, text: YOLO_ENTER_TEXT });
    expect(fx.yolo.get()).toBe(true);
    expect(fx.fsMode.get()).toBe("global");
    // ADR-0139: the launch entry applies the fence combination only. The
    // session's permission posture stays whatever the session would otherwise
    // have — here the holder's own starting value.
    expect(fx.permission.get()).toBe("default");
  });

  it.each(["default", "plan", "full_auto"] as const)(
    "a launch entry leaves the permission holder at %s — from every starting mode (ADR-0139)",
    (start) => {
      const fx = makeLaunchFixture(true, true, start);
      expect(fx.controller.enterAtLaunch().ok).toBe(true);
      expect(fx.permission.get()).toBe(start);
      expect(fx.fsMode.get()).toBe("global");
      expect(fx.yolo.get()).toBe(true);
    }
  );

  it("exit after a launched entry restores the pre-launch fs tier (ADR-0119: snapshot = startup initial values)", () => {
    const fx = makeLaunchFixture(true);
    fx.controller.enterAtLaunch();

    const result = fx.controller.exit();
    expect(result.ok).toBe(true);
    expect(fx.yolo.get()).toBe(false);
    expect(fx.fsMode.get()).toBe("workspace");
    expect(fx.permission.get()).toBe("default");
  });

  it("bwrap-less host: launch entry is NOT probe-refused (assembly stays open), exit still refuses with zero state change", () => {
    const fx = makeLaunchFixture(true, false);

    expect(fx.controller.enterAtLaunch().ok).toBe(true);
    expect(fx.permission.get()).toBe("default");

    const exit = fx.controller.exit();
    expect(exit.ok).toBe(false);
    expect(fx.yolo.get()).toBe(true);
    expect(fx.permission.get()).toBe("default");
    expect(fx.fsMode.get()).toBe("global");
  });

  it("once-guard: a repeat launch entry never re-snapshots a mid-session fs tier flip (ruling 6)", () => {
    const fx = makeLaunchFixture(true);
    fx.controller.enterAtLaunch();
    // Distinct from the launch snapshot ("workspace"), so a re-snapshot would
    // be visible as a different restore target.
    fx.fsMode.set("global");

    const second = fx.controller.enterAtLaunch();
    expect(second.ok).toBe(true);
    expect(second.text).toBe(YOLO_ALREADY_ON_TEXT);

    fx.controller.exit();
    expect(fx.fsMode.get()).toBe("workspace");
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
