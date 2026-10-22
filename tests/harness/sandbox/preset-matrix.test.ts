/**
 * ADR-0141 / specs/yolo-mode.md — the two presets on one session overlay.
 *
 * The carrier replaces the old snapshot channel (ADR-0119 ruling 6, retracted):
 * a preset declares its axes into an in-memory overlay, the effective value is
 * settings < startup flag < overlay, and exit CLEARS the overlay whole so the
 * lower tiers show through again.
 *
 * Pinned here:
 *  - invariant 6: the overlay clears as a whole, and only a user change to an
 *    axis the preset DECLARES clears it — yolo declares three axes, no-sandbox
 *    declares two and therefore survives a permission change;
 *  - invariant 7: `fsMode: workspace` with a retired fence is a typed error, and
 *    the derivation never silently corrects it;
 *  - a fresh process carries no overlay.
 */
import { describe, expect, it } from "vitest";

import { createPermissionModeContext } from "../../../src/harness/permission/index.js";
import { createFsModeContext } from "../../../src/harness/sandbox/fs-mode.js";
import {
  createPresetOverlay,
  isNoSandboxActive,
} from "../../../src/harness/sandbox/no-sandbox-marker.js";
import {
  createYoloContext,
  createYoloController,
  YOLO_ALREADY_ON_TEXT,
} from "../../../src/harness/sandbox/yolo.js";
import type { FsIsolationMode } from "../../../src/harness/sandbox/fs-mode.js";
import type { PermissionMode } from "../../../src/harness/permission/modes.js";

/**
 * A session's three tiers: the persisted settings value, the startup-flag tier,
 * and the overlay. Only the overlay is the preset's.
 */
function makeOverlayFixture(opts?: {
  readonly fsModeStart?: FsIsolationMode;
  readonly permissionStart?: PermissionMode;
  readonly probeWorks?: boolean;
}) {
  const yolo = createYoloContext(false);
  const fsMode = createFsModeContext(opts?.fsModeStart ?? "workspace");
  const permission = createPermissionModeContext(
    opts?.permissionStart ?? "default"
  );
  let probeWorks = opts?.probeWorks ?? true;
  const overlay = createPresetOverlay();
  const controller = createYoloController({
    yolo,
    fsMode,
    permission,
    overlay,
    probe: () => {
      if (!probeWorks) throw new Error("bwrap not available (injected)");
    },
  });
  return {
    yolo,
    fsMode,
    permission,
    overlay,
    controller,
    setProbeWorks: (works: boolean) => {
      probeWorks = works;
    },
  };
}

describe("preset overlay — the yolo preset declares all three axes", () => {
  it("enter declares fence + fsMode global + full_auto; exit clears the overlay whole", () => {
    const fx = makeOverlayFixture({ fsModeStart: "workspace" });
    expect(fx.controller.enter().ok).toBe(true);

    expect(fx.overlay.preset()).toBe("yolo");
    expect(fx.overlay.effectiveFsMode()).toBe("global");
    expect(fx.overlay.effectivePermission()).toBe("full_auto");
    expect(fx.overlay.fenceRetired()).toBe(true);

    // ADR-0141: a declaration is only real when it reaches the holders the
    // product reads. `createPermissionPolicy` reads `PermissionModeContext` and
    // the fence reads the fsMode holder — an overlay-only declaration would
    // make `--yolo` behave exactly like `--no-sandbox`.
    expect(fx.fsMode.get()).toBe("global");
    expect(fx.permission.get()).toBe("full_auto");

    expect(fx.controller.exit().ok).toBe(true);
    expect(fx.overlay.preset()).toBeUndefined();
    // Whole clear, no restore: the seeded settings tier is what the operator
    // owned, and both holders show it again.
    expect(fx.fsMode.get()).toBe("workspace");
    expect(fx.permission.get()).toBe("default");
    expect(fx.overlay.effectiveFsMode()).toBe("workspace");
    expect(fx.overlay.effectivePermission()).toBe("default");
    expect(fx.overlay.fenceRetired()).toBe(false);
  });
});

describe("preset overlay — the no-sandbox preset declares two axes and survives a permission change", () => {
  it("declares fence + fsMode global, leaves permission alone", () => {
    const fx = makeOverlayFixture({ fsModeStart: "workspace" });
    expect(fx.controller.enterNoSandbox().ok).toBe(true);

    expect(fx.overlay.preset()).toBe("no-sandbox");
    expect(fx.overlay.effectiveFsMode()).toBe("global");
    expect(fx.overlay.fenceRetired()).toBe(true);
    expect(fx.overlay.effectivePermission()).toBe("default");

    // Permission is an undeclared axis here: a change must NOT clear it.
    expect(fx.overlay.clearFor("permission")).toBe(false);
    expect(fx.overlay.preset()).toBe("no-sandbox");

    // fsMode IS declared, so a change there does clear it.
    expect(fx.overlay.clearFor("fsMode")).toBe(true);
    fx.overlay.clear();
    expect(fx.overlay.preset()).toBeUndefined();
    expect(fx.overlay.fenceRetired()).toBe(false);
  });
});

describe("preset overlay — invariant 7 is a typed error, never a silent correction", () => {
  it("a workspace tier with a retired fence throws rather than rewriting the tier", () => {
    const fx = makeOverlayFixture({ fsModeStart: "workspace" });
    fx.controller.enterNoSandbox();
    // An undeclared path that retires the fence while the effective tier is
    // `workspace` is exactly what the assertion exists to catch.
    expect(() =>
      fx.overlay.assertFenceRetirement({ fenceRetired: true, fsMode: "workspace" })
    ).toThrowError();
    expect(fx.overlay.effectiveFsMode()).toBe("global");
  });
});

describe("preset overlay — a bwrap-less host refuses entry and exit alike", () => {
  it("entry refused with zero state change", () => {
    const fx = makeOverlayFixture({ fsModeStart: "workspace", probeWorks: false });
    const result = fx.controller.enter();
    expect(result.ok).toBe(false);
    expect(fx.overlay.preset()).toBeUndefined();
    expect(fx.overlay.fenceRetired()).toBe(false);
    expect(fx.fsMode.get()).toBe("workspace");
  });

  it("exit refused with zero state change — the overlay survives intact", () => {
    const fx = makeOverlayFixture({ fsModeStart: "workspace" });
    fx.controller.enter();
    expect(fx.overlay.preset()).toBe("yolo");

    fx.setProbeWorks(false);
    const result = fx.controller.exit();
    expect(result.ok).toBe(false);
    // Nothing moved: the preset still holds, the fence is still retired.
    expect(fx.overlay.preset()).toBe("yolo");
    expect(fx.overlay.fenceRetired()).toBe(true);
    expect(fx.yolo.get()).toBe(true);
  });
});

describe("clear hooks — only declared axes clear, and only at the four hook sites", () => {
  it("an undeclared axis leaves the overlay intact; a declared one clears it whole", () => {
    const fx = makeOverlayFixture({ fsModeStart: "workspace" });
    fx.controller.enterNoSandbox();

    // permission is NOT declared by no-sandbox: no hook may fire here.
    expect(fx.overlay.clearFor("permission")).toBe(false);
    fx.permission.set("plan");
    expect(fx.overlay.preset()).toBe("no-sandbox");

    // The axes the hook sites DO watch: fence and fsMode are both declared.
    expect(fx.overlay.clearFor("fence")).toBe(true);
    expect(fx.overlay.clearFor("fsMode")).toBe(true);
  });

  it("the yolo preset DOES clear on a permission change", () => {
    const fx = makeOverlayFixture({ fsModeStart: "workspace" });
    fx.controller.enter();
    expect(fx.overlay.clearFor("permission")).toBe(true);
    fx.overlay.clear();
    expect(fx.overlay.preset()).toBeUndefined();
  });

  it("clearFor is false when no preset is in force (a bare-fence session has nothing to clear)", () => {
    const fx = makeOverlayFixture({ fsModeStart: "workspace" });
    for (const axis of ["fence", "fsMode", "permission"] as const) {
      expect(fx.overlay.clearFor(axis)).toBe(false);
    }
    // Clearing with nothing declared is inert, not a throw.
    fx.overlay.clear();
    expect(fx.overlay.fenceRetired()).toBe(false);
  });
});

describe("clear ordering — clear first, then the failed write-back never rolls back", () => {
  it("a rejected write-back leaves the user's choice effective and does not re-seed the overlay", async () => {
    const fx = makeOverlayFixture({ fsModeStart: "workspace" });
    fx.controller.enterNoSandbox();
    expect(fx.overlay.effectiveFsMode()).toBe("global");

    // The site order: clear synchronously, apply the user's choice, THEN
    // issue the write-back — which is rejected here.
    fx.overlay.clear();
    fx.fsMode.set("workspace");
    const caught = Promise.reject(new Error("settings write refused")).catch(
      (err: unknown) => err
    );
    expect(fx.overlay.effectiveFsMode()).toBe("workspace");
    // No re-seed: the overlay stays clear, so the lower tiers govern.
    expect(fx.overlay.preset()).toBeUndefined();
    await expect(caught).resolves.toBeInstanceOf(Error);
  });
});

describe("no-sandbox marker — derived, never entry-sourced", () => {
  it("true from the main process, from a live bare descendant, and false once it ends", () => {
    expect(isNoSandboxActive({ fenceRetired: true, liveDescendants: [] })).toBe(
      true
    );
    expect(
      isNoSandboxActive({
        fenceRetired: false,
        liveDescendants: [{ fenceRetiredAtSpawn: true }],
      })
    ).toBe(true);
    expect(
      isNoSandboxActive({
        fenceRetired: false,
        liveDescendants: [{ fenceRetiredAtSpawn: false }],
      })
    ).toBe(false);
    expect(isNoSandboxActive({ fenceRetired: false, liveDescendants: [] })).toBe(
      false
    );
  });
});

/* -----------------------------------------------------------------------------
 * The LAUNCH-shaped entry, as opposed to the in-session entry the cases above
 * drive.
 * -------------------------------------------------------------------------- */

describe("launch entry: the seeded-true holder does not shadow the declaration", () => {
  // The defect this pins: `run.tsx` seeds the yolo holder TRUE at assembly for
  // BOTH presets (so the fence is retired from the first fenced call on any
  // host), then routes the seed to `enterNoSandbox`. `enterNoSandbox` was
  // idempotent on the raw holder, so it returned "already on" and never
  // declared the overlay: `iknow tui --no-sandbox` started with the fence UP,
  // no badge and no 无沙箱 marker — the operator asked for a preset and got a
  // plain session. The in-session cases above cannot catch it because their
  // fixture seeds the holder false.
  function makeLaunchFixture(noSandbox: boolean) {
    const fsMode = createFsModeContext("global");
    const permission = createPermissionModeContext("default");
    // Exactly what run.tsx passes: the holder is seeded true for either flag.
    const yolo = createYoloContext(noSandbox || true);
    const overlay = createPresetOverlay({
      settingsFsMode: fsMode.get(),
      settingsPermission: permission.get(),
    });
    const controller = createYoloController({
      yolo,
      fsMode,
      permission,
      overlay,
      probe: () => {},
    });
    // The seed router, verbatim from applyYoloLaunchSeed.
    if (noSandbox) {
      controller.enterNoSandbox();
    } else {
      if (!yolo.get()) throw new Error("holder not seeded");
      controller.enterAtLaunch();
    }
    return { overlay, fsMode, permission, yolo };
  }

  it("--no-sandbox declares the overlay even though the holder was seeded true", () => {
    const fx = makeLaunchFixture(true);
    expect(fx.overlay.preset()).toBe("no-sandbox");
    expect(fx.overlay.fenceRetired()).toBe(true);
    expect(fx.overlay.effectiveFsMode()).toBe("global");
    // The one difference from yolo: permission is untouched.
    expect(fx.overlay.effectivePermission()).toBe("default");
  });

  it("--yolo declares the yolo preset with full_auto, unchanged by the fix", () => {
    const fx = makeLaunchFixture(false);
    expect(fx.overlay.preset()).toBe("yolo");
    expect(fx.overlay.fenceRetired()).toBe(true);
    expect(fx.overlay.effectivePermission()).toBe("full_auto");
  });

  // The declaration must reach the HOLDER, not only the overlay. `createPermissionPolicy`
  // reads `PermissionModeContext` and nothing reads `effectivePermission()`, so a
  // declaration that lives only in the overlay makes `--yolo` behave exactly
  // like `--no-sandbox` while usage.ts tells the operator the permission mode
  // goes full_auto.
  it("--yolo writes full_auto into the permission HOLDER the policy reads", () => {
    const fx = makeLaunchFixture(false);
    expect(fx.permission.get()).toBe("full_auto");
  });

  it("--no-sandbox writes nothing into the permission holder (its whole point)", () => {
    const fx = makeLaunchFixture(true);
    expect(fx.permission.get()).toBe("default");
    expect(fx.overlay.effectivePermission()).toBe("default");
  });

  it("both presets put the fsMode HOLDER at global, not only the overlay", () => {
    expect(makeLaunchFixture(false).fsMode.get()).toBe("global");
    expect(makeLaunchFixture(true).fsMode.get()).toBe("global");
  });

  it("exit clears the overlay and the holders return to the seeded settings tier", () => {
    const fsMode = createFsModeContext("workspace");
    const permission = createPermissionModeContext("plan");
    const yolo = createYoloContext(false);
    const overlay = createPresetOverlay({
      settingsFsMode: fsMode.get(),
      settingsPermission: permission.get(),
    });
    const controller = createYoloController({
      yolo,
      fsMode,
      permission,
      overlay,
      probe: () => {},
    });
    controller.enter();
    expect(permission.get()).toBe("full_auto");
    expect(fsMode.get()).toBe("global");

    expect(controller.exit().ok).toBe(true);
    // Whole clear, no restore — the holders show the seeded tier again, which
    // is what the operator owned before the preset.
    expect(overlay.preset()).toBeUndefined();
    expect(overlay.fenceRetired()).toBe(false);
  });

  it("a genuine repeat entry still short-circuits (idempotence survives)", () => {
    const fsMode = createFsModeContext("global");
    const permission = createPermissionModeContext("default");
    const yolo = createYoloContext(false);
    const overlay = createPresetOverlay();
    const controller = createYoloController({
      yolo,
      fsMode,
      permission,
      overlay,
      probe: () => {},
    });
    expect(controller.enterNoSandbox().text).not.toBe(YOLO_ALREADY_ON_TEXT);
    const second = controller.enterNoSandbox();
    expect(second.text).toBe(YOLO_ALREADY_ON_TEXT);
    // And the declaration survived the repeat.
    expect(overlay.preset()).toBe("no-sandbox");
  });

  it("without an overlay wired, the holder guard still makes it idempotent", () => {
    const fsMode = createFsModeContext("global");
    const permission = createPermissionModeContext("default");
    const yolo = createYoloContext(true);
    const controller = createYoloController({
      yolo,
      fsMode,
      permission,
      probe: () => {},
    });
    expect(controller.enterNoSandbox().text).toBe(YOLO_ALREADY_ON_TEXT);
  });
});
