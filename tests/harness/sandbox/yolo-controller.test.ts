/**
 * ADR-0119 / specs/yolo-mode.md Contract — the enter/exit **idempotent set** on
 * the controller axis (the `/yolo` TUI route, not the `--yolo` launch route
 * pinned by yolo-launch.test.ts), under ADR-0139 (the permission axis is
 * fence-independent).
 *
 * Invariants pinned here:
 *  - the permission axis is fence-independent in BOTH directions: entry writes
 *    nothing to it, a mid-yolo flip sticks, and exit restores nothing on it —
 *    from each of the three starting modes;
 *  - repeated entry takes no second snapshot (the guard against snapshot
 *    self-pollution: a mid-yolo flip must never become the restore target);
 *  - repeated exit overwrites nothing (early return before the probe, so an
 *    OFF session on a bwrap-less host still gets the plain already-OFF notice,
 *    not a refusal);
 *  - re-entry after a completed exit takes a **fresh** snapshot (the cleared
 *    snapshot is not stale).
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
import type { PermissionMode } from "../../../src/harness/permission/modes.js";
import type { FsIsolationMode } from "../../../src/harness/sandbox/fs-mode.js";

/**
 * A fixture whose starting posture is the test's to choose, because "unchanged
 * by the fence axis" is only a meaningful claim against a KNOWN starting value
 * (a `full_auto` start is what distinguishes "yolo wrote it" from "it already
 * was").
 */
function makeControllerFixture(opts?: {
  readonly probeWorks?: boolean;
  readonly permissionStart?: PermissionMode;
  readonly fsModeStart?: FsIsolationMode;
}) {
  const yolo = createYoloContext(false);
  const permission = createPermissionModeContext(
    opts?.permissionStart ?? "default"
  );
  const fsMode = createFsModeContext(opts?.fsModeStart ?? "workspace");
  const probeWorks = opts?.probeWorks ?? true;
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

describe("yolo controller enter/exit idempotent set (ADR-0119, as amended by ADR-0139)", () => {
  it("repeated enter() takes no second snapshot — a mid-yolo flip is never the restore target", () => {
    // Starting at `global` makes the two candidates distinguishable: the
    // snapshot is `global`, and a mid-yolo flip to `workspace` is the value a
    // polluted snapshot would wrongly restore.
    const fx = makeControllerFixture({ fsModeStart: "global" });
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

    // An external fsMode flip between the two enters cannot pollute the
    // snapshot: exit restores the TRUE pre-entry value, not this one.
    fx.fsMode.set("workspace");
    fx.controller.enter();
    expect(fx.permission.get()).toBe("default");
    expect(fx.controller.exit().ok).toBe(true);
    expect(fx.fsMode.get()).toBe("global");
    expect(fx.permission.get()).toBe("default");
    expect(fx.yolo.get()).toBe(false);
  });

  it("repeated exit() on an OFF session returns the already-OFF notice with zero state change — before the probe (a bwrap-less host is not refused)", () => {
    const fx = makeControllerFixture({ probeWorks: false });
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
    expect(fx.fsMode.get()).toBe("workspace");

    // The session's fs tier moved between entry cycles: the second entry must
    // snapshot "global", not the first cycle's "workspace".
    fx.fsMode.set("global");
    expect(fx.controller.enter().ok).toBe(true);
    expect(fx.fsMode.get()).toBe("global");
    fx.fsMode.set("workspace");
    fx.permission.set("plan");
    expect(fx.controller.exit().ok).toBe(true);
    expect(fx.fsMode.get()).toBe("global");
    // The permission holder is never in the snapshot, so the mid-yolo flip is
    // still standing after exit — exit restored the fs tier and nothing else.
    expect(fx.permission.get()).toBe("plan");
  });

  it.each(["default", "plan", "full_auto"] as const)(
    "permission axis is fence-independent from %s: entry leaves the holder exactly as it was, a mid-yolo flip sticks, exit changes nothing",
    (start) => {
      const fx = makeControllerFixture({ permissionStart: start });
      expect(fx.permission.get()).toBe(start);

      expect(fx.controller.enter()).toEqual({
        ok: true,
        yolo: true,
        text: YOLO_ENTER_TEXT,
      });
      // Entry wrote the fence axis only: the permission holder reads back as
      // the value it started at, not as a constant the action imposes, while
      // the fence axis really did land (`workspace` tier forced to `global`).
      expect(fx.permission.get()).toBe(start);
      expect(fx.fsMode.get()).toBe("global");
      expect(fx.yolo.get()).toBe(true);

      // Shift+Tab under yolo still cycles (the fence axis never re-forces it).
      const midYolo: PermissionMode = start === "plan" ? "full_auto" : "plan";
      fx.permission.set(midYolo);
      expect(fx.permission.get()).toBe(midYolo);
      expect(fx.yolo.get()).toBe(true);

      expect(fx.controller.exit()).toEqual({
        ok: true,
        yolo: false,
        text: YOLO_EXIT_TEXT,
      });
      // Exit restores the fence axis' own snapshot and leaves the permission
      // holder on whatever the session last chose — here the mid-yolo value,
      // which the pre-change action would have overwritten with `start`.
      expect(fx.permission.get()).toBe(midYolo);
      expect(fx.fsMode.get()).toBe("workspace");
      expect(fx.yolo.get()).toBe(false);
    }
  );
});
