/**
 * User thinking-mode settings — pure function layer, localStorage key
 * "iknow:thinking". UI components consume only this module; the wire
 * override mapping goes through toWireOverride.
 */
import type { ThinkingOverride } from "../api/types";

export const THINKING_STORAGE_KEY = "iknow:thinking";

export type ThinkingEffort = "" | "low" | "medium" | "high" | "xhigh" | "max";

export type ThinkingSettings = {
  /** false → thinking off (wire mode="off"); true → adaptive. */
  enabled: boolean;
  /** adaptive effort level; "" = auto (backend default). */
  effort: ThinkingEffort;
};

export const DEFAULT_THINKING_SETTINGS: ThinkingSettings = {
  enabled: false,
  effort: "",
};

/** Effort level → label (English; "" = auto). */
export const EFFORT_LABELS: Record<ThinkingEffort, string> = {
  "": "auto",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
};

/** Effort order for the segmented picker (auto first). */
export const EFFORT_OPTIONS: readonly ThinkingEffort[] = [
  "",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

const VALID_EFFORTS = new Set<ThinkingEffort>(EFFORT_OPTIONS);

function isValidEffort(v: unknown): v is ThinkingEffort {
  return typeof v === "string" && VALID_EFFORTS.has(v as ThinkingEffort);
}

/**
 * Parse stored JSON; any bad shape (non-JSON, non-object, wrong field types,
 * unknown effort) falls back to DEFAULT_THINKING_SETTINGS field-by-field.
 */
export function parseThinkingSettings(raw: string | null): ThinkingSettings {
  if (raw === null || raw === "") return DEFAULT_THINKING_SETTINGS;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_THINKING_SETTINGS;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return DEFAULT_THINKING_SETTINGS;
  }
  const obj = parsed as Record<string, unknown>;
  return {
    enabled:
      typeof obj.enabled === "boolean"
        ? obj.enabled
        : DEFAULT_THINKING_SETTINGS.enabled,
    effort: isValidEffort(obj.effort)
      ? obj.effort
      : DEFAULT_THINKING_SETTINGS.effort,
  };
}

/** Canonical JSON form for localStorage (enabled + effort only). */
export function serializeThinkingSettings(settings: ThinkingSettings): string {
  return JSON.stringify({ enabled: settings.enabled, effort: settings.effort });
}

/** Map settings → wire override for PostMessageRequest.thinking. */
export function toWireOverride(settings: ThinkingSettings): ThinkingOverride {
  if (!settings.enabled) return { mode: "off" };
  return { mode: "adaptive", effort: settings.effort };
}

/** Read from localStorage; unavailable/corrupt → default (fail quiet). */
export function loadThinkingSettings(): ThinkingSettings {
  try {
    if (typeof localStorage === "undefined") return DEFAULT_THINKING_SETTINGS;
    return parseThinkingSettings(localStorage.getItem(THINKING_STORAGE_KEY));
  } catch {
    return DEFAULT_THINKING_SETTINGS;
  }
}

/** Persist to localStorage; unavailable → no-op (fail quiet). */
export function saveThinkingSettings(settings: ThinkingSettings): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(
      THINKING_STORAGE_KEY,
      serializeThinkingSettings(settings)
    );
  } catch {
    // localStorage may be disabled (privacy mode, quota); UI state still works.
  }
}
