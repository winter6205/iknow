/**
 * ADR-0141 / specs/yolo-mode.md — the session overlay and the derived
 * 无沙箱 marker.
 *
 * A preset is a declaration of axis values held in memory for the session. It
 * has no snapshot and no restore: exit clears the overlay whole, and the lower
 * tiers (settings, then the startup flag) show through again. That is what
 * replaces ADR-0119 ruling 6's snapshot channel, whose restore could re-apply a
 * remembered value over a user's later choice (F4).
 *
 * Nothing here is persisted, and nothing is derived from which entry raised the
 * posture — the marker reads the effective configuration plus the descendants
 * that were spawned while it was retired.
 */

import type { FsIsolationMode } from "./fs-mode.js";
import type { PermissionMode } from "../permission/modes.js";
import { deriveFenceRetired } from "./yolo.js";

/** The two named presets. `--auto-mode` is permission-axis-only and is not one. */
export type PresetId = "yolo" | "no-sandbox";

/**
 * The axes a user can change. A change clears the overlay only when the preset
 * in force DECLARES that axis (spec invariant 6): yolo declares all three,
 * no-sandbox declares fence and fsMode but not permission.
 */
export type PresetAxis = "fence" | "fsMode" | "permission";

/**
 * The axes each preset declares — a change to any of them resolves the
 * contradiction between the declaration and the user's choice, so the whole
 * overlay clears.
 */
const DECLARED_AXES: Readonly<Record<PresetId, ReadonlySet<PresetAxis>>> = {
  yolo: new Set<PresetAxis>(["fence", "fsMode", "permission"]),
  "no-sandbox": new Set<PresetAxis>(["fence", "fsMode"]),
};

/** The axis values a preset declares, on top of the tiers below it. */
interface PresetDeclaration {
  readonly preset: PresetId;
  readonly fsMode: FsIsolationMode;
  readonly permission: PermissionMode | undefined;
}

export interface PresetOverlay {
  /** The preset in force, or undefined when no preset is declared. */
  readonly preset: () => PresetId | undefined;
  /** The effective fsMode: the overlay's declared value, else the settings tier. */
  readonly effectiveFsMode: () => FsIsolationMode;
  /** The effective permission: the declared value when the preset has one, else the settings tier. */
  readonly effectivePermission: () => PermissionMode;
  /**
   * The **settings tier** seeded before the declaration — what the operator
   * owned, and therefore what `exit` restores. Distinct from the effective
   * reads above, which answer "what is in force now"; this one answers "what
   * was there before a preset spoke".
   */
  readonly declaredTier: () => {
    readonly fsMode: FsIsolationMode;
    readonly permission: PermissionMode;
  };
  /** The derived fence posture — invariant 7 is asserted on this read. */
  readonly fenceRetired: () => boolean;
  /**
   * Whether a user change to `axis` clears the overlay. False when no preset is
   * in force, and false for an axis the preset never declared.
   */
  readonly clearFor: (axis: PresetAxis) => boolean;
  /** Clear the overlay whole, whatever the axis. Used by exit. */
  readonly clear: () => void;
  /** Invariant 7 on an explicit declaration — the assertion, callable directly. */
  readonly assertFenceRetirement: (decl: {
    readonly fenceRetired: boolean;
    readonly fsMode: FsIsolationMode;
  }) => void;
  /** Seed the declaration. The controller owns this; readers see `preset()`. */
  readonly declare: (preset: PresetId) => void;
  /** Re-seed the settings tier when the user changes an axis with no preset in force. */
  readonly seedSettingsTier: (tier: {
    readonly fsMode: FsIsolationMode;
    readonly permission: PermissionMode;
  }) => void;
}

export interface CreatePresetOverlayOptions {
  /** The settings tier — the value that shows through when no preset is declared. */
  readonly settingsFsMode?: FsIsolationMode;
  /** The permission tier — likewise. */
  readonly settingsPermission?: PermissionMode;
}

/**
 * Build the overlay. The settings tier is captured once at construction because
 * it is the fallback the session started from; the holders themselves stay the
 * live source, and the controller re-seeds this tier when the user changes it.
 */
export function createPresetOverlay(
  opts?: CreatePresetOverlayOptions
): PresetOverlay {
  let declared: PresetDeclaration | undefined;
  let settingsFsMode: FsIsolationMode = opts?.settingsFsMode ?? "global";
  let settingsPermission: PermissionMode = opts?.settingsPermission ?? "default";

  const effectiveFsMode = (): FsIsolationMode =>
    declared?.fsMode ?? settingsFsMode;

  const effectivePermission = (): PermissionMode =>
    declared?.permission ?? settingsPermission;

  const assertFenceRetirement = (decl: {
    readonly fenceRetired: boolean;
    readonly fsMode: FsIsolationMode;
  }): void => {
    deriveFenceRetired(decl);
  };

  return Object.freeze({
    preset: () => declared?.preset,
    effectiveFsMode,
    effectivePermission,
    declaredTier: () => ({ fsMode: settingsFsMode, permission: settingsPermission }),
    assertFenceRetirement,
    fenceRetired: () => {
      const fenceRetired = declared !== undefined;
      assertFenceRetirement({ fenceRetired, fsMode: effectiveFsMode() });
      return fenceRetired;
    },
    clearFor: (axis: PresetAxis): boolean =>
      declared !== undefined && DECLARED_AXES[declared.preset].has(axis),
    clear: () => {
      declared = undefined;
    },
    declare: (preset: PresetId): void => {
      declared = {
        preset,
        fsMode: "global",
        permission: preset === "yolo" ? "full_auto" : undefined,
      };
      assertFenceRetirement({ fenceRetired: true, fsMode: "global" });
    },
    seedSettingsTier: (tier: {
      readonly fsMode: FsIsolationMode;
      readonly permission: PermissionMode;
    }): void => {
      settingsFsMode = tier.fsMode;
      settingsPermission = tier.permission;
    },
  });
}

/** A descendant registered at spawn with the fence posture it started under. */
export interface FenceRegistration {
  readonly fenceRetiredAtSpawn: boolean;
}

/**
 * The one clear hook every user-change site calls (ADR-0141, spec invariant 6).
 *
 * A hook site names the axis the user just changed and nothing else: the
 * overlay decides whether that axis was declared, so no site carries its own
 * "which preset declares this" table and no site can drift from it. An absent
 * overlay — an unwired entry point — is inert rather than an error.
 *
 * Call sites: `toggleFsModeAndPersist` and `/config <set>` (fsMode),
 * `applyPermissionsCommand` (permission), `applyShiftTabAgentModeFlip`
 * (permission). The capacity and worktree rows deliberately have no hook: they
 * are not preset axes.
 */
export function clearOverlayForUserChange(
  overlay: PresetOverlay | undefined,
  axis: PresetAxis
): void {
  if (overlay === undefined) return;
  if (overlay.clearFor(axis)) overlay.clear();
}

/**
 * The 无沙箱 marker: true whenever the fence is retired — by this session's
 * effective configuration, or by a live descendant that was spawned while it was.
 * Derived, never entry-sourced (spec §7).
 */
export function isNoSandboxActive(opts: {
  readonly fenceRetired: boolean;
  readonly liveDescendants: ReadonlyArray<FenceRegistration>;
}): boolean {
  if (opts.fenceRetired) return true;
  return opts.liveDescendants.some((d) => d.fenceRetiredAtSpawn);
}
