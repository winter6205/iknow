/**
 * ADR-0119 / specs/yolo-mode.md Contract — the enter/exit **idempotent set** on
 * the controller axis (the `/yolo` TUI route, not the `--yolo` launch route
 * pinned by yolo-launch.test.ts).
 *
 * Invariants pinned here:
 *  - repeated entry takes no second snapshot (the guard against snapshot
 *    self-pollution: a permission flip under yolo must never become the
 *    restore target);
 *  - repeated exit overwrites nothing (early return before the probe, so an
 *    OFF session on a bwrap-less host still gets the plain already-OFF notice,
 *    not a refusal);
 *  - re-entry after a completed exit takes a **fresh** snapshot (the cleared
 *    snapshot is not stale);
 *  - yolo does not lock the permission axis: Shift+Tab-style flips under yolo
 *    stick, and exit restores the pre-entry snapshot, not the mid-yolo value.
 */
import { describe, expect, it } from "vitest";

import { ToolExecutionError } from "../../../src/harness/errors.js";
import { createPermissionModeContext } from "../../../src/harness/permission/index.js";
import { createFsModeContext } from "../../../src/harness/sandbox/fs-mode.js";
import {
  createYoloContext,
  createYoloController,
  YOLO_ALREADY_OFF_TEXT,
  YOLO_ALREADY_ON_TEXT,
  YOLO_ENTER_TEXT,
  YOLO_EXIT_TEXT,
} from "../../../src/harness/sandbox/yolo.js";

function makeControllerFixture(probeWorks = true) {
  const yolo = createYoloContext(false);
  const permission = createPermissionModeContext("default");
  const fsMode = createFsModeContext("workspace");
  let probeCalls = 0;
  const controller = createYoloController({
    yolo,
    permission,
    fsMode,
    probe: () => {
      probeCalls++;
      if (!probeWorks) {
        throw new ToolExecutionError("bwrap not available (injected)");
      }
    },
  });
  return {
    yolo,
    permission,
    fsMode,
    controller,
    probeCalls: () => probeCalls,
  };
}

describe("yolo controller enter/exit idempotent set (ADR-0119)", () => {
  it("repeated enter() takes no second snapshot — a permission flip under yolo never becomes the restore target", () => {
    const fx = makeControllerFixture();
    expect(fx.controller.enter()).toEqual({
      ok: true,
      yolo: true,
      text: YOLO_ENTER_TEXT,
    });

    // Repeated entry is a no-op notice (spec: repeated entry takes no second
    // snapshot). The early return also skips the probe.
    const probesBefore = fx.probeCalls();
    expect(fx.controller.enter()).toEqual({
      ok: true,
      yolo: true,
      text: YOLO_ALREADY_ON_TEXT,
    });
    expect(fx.probeCalls()).toBe(probesBefore);

    // Even an external permission flip between the two enters cannot pollute
    // the snapshot: exit restores the TRUE pre-entry value.
    fx.permission.set("plan");
    fx.controller.enter();
    fx.permission.set("full_auto");
    expect(fx.controller.exit().ok).toBe(true);
    expect(fx.permission.get()).toBe("default");
    expect(fx.fsMode.get()).toBe("workspace");
    expect(fx.yolo.get()).toBe(false);
  });

  it("repeated exit() on an OFF session returns the already-OFF notice with zero state change — before the probe (a bwrap-less host is not refused)", () => {
    const fx = makeControllerFixture(false);
    const result = fx.controller.exit();
    expect(result).toEqual({
      ok: true,
      yolo: false,
      text: YOLO_ALREADY_OFF_TEXT,
    });
    expect(fx.yolo.get()).toBe(false);
    expect(fx.permission.get()).toBe("default");
    expect(fx.fsMode.get()).toBe("workspace");
    // The already-OFF early return precedes the probe gate: nothing probed.
    expect(fx.probeCalls()).toBe(0);
  });

  it("re-enter after a completed exit takes a FRESH snapshot (the cleared snapshot is not stale)", () => {
    const fx = makeControllerFixture();
    fx.controller.enter();
    fx.controller.exit();
    expect(fx.yolo.get()).toBe(false);

    // The session's posture moved between entry cycles: the second enter must
    // snapshot "plan", not the first cycle's "default".
    fx.permission.set("plan");
    expect(fx.controller.enter().ok).toBe(true);
    expect(fx.permission.get()).toBe("full_auto");
    expect(fx.controller.exit().ok).toBe(true);
    expect(fx.permission.get()).toBe("plan");
    expect(fx.fsMode.get()).toBe("workspace");
  });

  it("permission axis stays orthogonal under yolo: entry lands on full_auto, later flips stick, exit restores the pre-entry snapshot", () => {
    const fx = makeControllerFixture();
    fx.controller.enter();
    expect(fx.permission.get()).toBe("full_auto");

    // Shift+Tab under yolo still cycles (yolo never re-forces full_auto).
    fx.permission.set("plan");
    expect(fx.permission.get()).toBe("plan");
    expect(fx.yolo.get()).toBe(true);

    // Exit restores the snapshot taken at entry, not the mid-yolo value.
    expect(fx.controller.exit()).toEqual({
      ok: true,
      yolo: false,
      text: YOLO_EXIT_TEXT,
    });
    expect(fx.permission.get()).toBe("default");
    expect(fx.fsMode.get()).toBe("workspace");
  });
});
