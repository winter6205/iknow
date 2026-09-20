/**
 * Shared contract for the 5 thinking-panel design variants (demo gallery
 * interface).
 *
 * Each design implements `ThinkingDesign`: pure rendering, pure key routing,
 * independently testable. The demo gallery entry assembles them; the user
 * presses 1-5 to switch and see the actual rendering.
 *
 * This directory is preview-only (existing app.tsx / slash.ts / theme.ts /
 * contract.ts untouched): a visual/animation candidate pool for later picker
 * form-factor selection.
 */
import type { ReactElement } from "react";
import type { KeyEvent } from "@opentui/core";

/** 5 concrete effort levels (no adaptive level; adaptive = top Auto dot toggle). */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

/** Picker model state (demo-managed; simulates real two-way state). */
export interface PickerModel {
  /** Auto dot toggle: true = effort="" (follow env/provider default), false = concrete level. */
  readonly autoOn: boolean;
  /** Active level index (0..4). */
  readonly currentIndex: number;
  /** Focus cursor inside the picker (0..4; -1 when autoOn means cursor is on Auto). */
  readonly focusIndex: number;
  /** Whether the picker is open (toggled inside demo). */
  readonly open: boolean;
}

/** Picker model events (produced by simulated demo interaction). */
export type PickerEvent =
  | { type: "open" }
  | { type: "close" }
  | { type: "confirm" }
  | { type: "cancel" }
  | { type: "left" }
  | { type: "right" }
  | { type: "tab" } // toggle Auto
  | { type: "space" }; // toggle Auto (same as Tab)

/** Pure reducer for PickerModel (decouples demo from designs). */
export function reducePickerModel(
  model: PickerModel,
  event: PickerEvent
): PickerModel {
  if (!model.open) {
    if (event.type === "open") {
      return {
        ...model,
        open: true,
        focusIndex: model.autoOn ? -1 : model.currentIndex,
      };
    }
    return model;
  }
  switch (event.type) {
    case "close":
      return { ...model, open: false };
    case "cancel":
      return { ...model, open: false };
    case "confirm": {
      // Auto on → keep effort=""; off → take focusIndex
      if (model.autoOn)
        return { ...model, open: false, currentIndex: model.currentIndex };
      return { ...model, open: false, currentIndex: model.focusIndex };
    }
    case "left": {
      if (model.autoOn) return model;
      return { ...model, focusIndex: Math.max(0, model.focusIndex - 1) };
    }
    case "right": {
      if (model.autoOn) return model;
      return {
        ...model,
        focusIndex: Math.min(EFFORT_LEVELS.length - 1, model.focusIndex + 1),
      };
    }
    case "tab":
    case "space": {
      const nextAuto = !model.autoOn;
      return {
        ...model,
        autoOn: nextAuto,
        focusIndex: nextAuto ? -1 : model.currentIndex,
      };
    }
    default:
      return model;
  }
}

/** Default picker state: Auto off, level medium (index=1). */
export const DEFAULT_PICKER_MODEL: PickerModel = {
  autoOn: false,
  currentIndex: 1, // medium
  focusIndex: 1,
  open: false,
};

/** Design render output: panel + doc-style aids (title, notes, key hints).
 *  Demo gallery lays it out on screen: panel left, notes + controls right. */
export interface ThinkingDesignProps {
  readonly model: PickerModel;
  readonly cols: number;
}

/** Design metadata (shown in demo gallery list). */
export interface ThinkingDesignMeta {
  readonly id: string;
  readonly name: string;
  readonly tag: string; // one-line style tag (Chinese)
  readonly summary: string; // design highlights (shown on demo right side)
}

/** Full design contract: metadata + render component + optional key routing.
 *  Key routing is optional (demo provides global defaults); supply it to
 *  customize non-standard keys. */
export interface ThinkingDesign {
  readonly meta: ThinkingDesignMeta;
  readonly render: (props: ThinkingDesignProps) => ReactElement;
  /** Optional custom key routing; return null to fall back to demo defaults (←/→ level / Tab+Space Auto / Enter confirm / Esc cancel). */
  readonly reduceKey?: (
    event: KeyEvent,
    model: PickerModel
  ) => PickerEvent | null;
}
