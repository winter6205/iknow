/** @jsxImportSource @opentui/react */
/**
 * src/tui/model-picker.tsx
 *
 * /model picker over the provider registry: one row per
 * `${provider}/${model}` (plus display name when configured), sharing the
 * rounded flowing-border frame + ◆─ title + ▸ cursor + key hints visual
 * language with the other pickers.
 *
 * Interaction semantics (same SSOT as thinking-picker / memory-picker):
 *  - ↑/↓ → move focus (clamped to the **visible window**, panel stays open);
 *  - Enter → fix (commit the focused entry; host persists + reloadFromEnv +
 *    closes);
 *  - Esc → commit (**close without persisting**) — see the cancel-semantics
 *    note below;
 *  - Space/Tab and ←/→ → ignore (no toggle / no horizontal movement);
 *  - ctrl/meta combos → ignore (leave them to the app layer; Ctrl+C/O is not
 *    swallowed).
 *
 * ## Why Esc is not a cancel path
 *
 * thinking-picker's Esc = "save and exit" because the panel holds uncommitted
 * staged state (switchPreview / effortFocusIndex) that Esc writes to real
 * state. This panel has no staged state — ↑/↓ only move focusedIndex and
 * write nothing; the only write happens on Enter. So on Esc there is nothing
 * to save and nothing to roll back: it is neither "save" nor "discard".
 * Reopening seeds focus back to the current model's entry (app.tsx seed
 * logic), so closing has zero side effect on configuration.
 *
 * Row budget: `modelPickerRows(entryCount)` = border 2 + content rows (hard
 * cap 12, overflow collapses into one "…N more" row) + key hints 1;
 * **excludes marginBottom=1** (same convention as thinkingPickerRows,
 * accounted by chromeReserveRows +1).
 */
import { useEffect, useState, type ReactNode } from "react";
import { TextAttributes } from "@opentui/core";
import { useTimeline } from "@opentui/react";
import type { IknowSettingsLlmProvider } from "../config/settings.js";
import type { ModalKeyEvent } from "./modal.js";
import { PICKER_WIDTH } from "./thinking-picker.js";
import { tuiPalette } from "./theme.js";
import { BORDER_CYCLE_MS, flowBorderColor } from "./designs/_color.js";

/** Max visible content rows: the rest collapses into one "…N more" row so the
 *  panel height never grows with the registry (V1 has no scrolling, same
 *  constant-rows discipline as thinking-picker). */
export const MODEL_PICKER_MAX_ROWS = 12;

/** One picker entry (flat projection of the provider registry; the caller
 *  expands provider × models). */
export interface ModelPickerEntry {
  readonly providerId: string;
  readonly modelId: string;
  /** provider.models[i].name (display name). Absent → route ID only. */
  readonly label?: string;
}

export interface ModelPickerState {
  readonly entries: ReadonlyArray<ModelPickerEntry>;
  readonly focusedIndex: number;
}

/** Route-ID string (persisted value + primary row label): `${provider}/${model}`. */
export function modelRouteId(entry: ModelPickerEntry): string {
  return `${entry.providerId}/${entry.modelId}`;
}

/**
 * Provider registry → flat `provider × models` entries (the single
 * implementation of the expansion semantics).
 *
 * Both the host (app's /model panel) and the display surface (context-bar's
 * model-name prefix) need this projection, but they are upstream/downstream
 * of each other (app → context-bar); either one owning it would force a
 * circular reverse import — hence it lives in this leaf module (which already
 * holds `ModelPickerEntry` and the route-ID predicate; flattening and route
 * matching are two halves of one semantic). Empty / absent registry → empty
 * array (callers fall back to notice / raw route string accordingly).
 */
export function modelPickerEntries(
  providers: ReadonlyArray<IknowSettingsLlmProvider> | undefined
): ReadonlyArray<ModelPickerEntry> {
  const out: ModelPickerEntry[] = [];
  for (const provider of providers ?? []) {
    for (const model of provider.models) {
      out.push({
        providerId: provider.id,
        modelId: model.id,
        ...(model.name !== undefined ? { label: model.name } : {}),
      });
    }
  }
  return out;
}

/**
 * Route-ID → entry lookup (the predicate lives here only: `modelRouteId`,
 * never inlined at call sites — inlining would let the `${provider}/${model}`
 * separator convention drift across files).
 */
export function findEntryByRouteId(
  entries: ReadonlyArray<ModelPickerEntry>,
  model: string
): ModelPickerEntry | undefined {
  return entries.find((e) => modelRouteId(e) === model);
}

/**
 * Status-bar model-name projection (pure function): when the current model
 * route ID hits a registry entry that has a `name`, show the `name` (e.g.
 * `MiniMax M3`); on miss / no name / absent registry → fall back to the raw
 * route string (`provider/model`), never fabricate or throw. Only the
 * status-bar display surface uses this projection; `/info` and the /model
 * picker's focus seed still use the raw route string. The settings layer's
 * drop-not-throw parsing already guarantees a non-empty label; this guards
 * empty strings again (same standard as the picker's `label.length > 0`
 * render guard) — an empty label is treated as "no name" and falls back.
 *
 * Hosted together with flattening / route matching: the three are segments
 * of one "registry → entry → display name" projection semantic; splitting
 * them would let the `${provider}/${model}` convention and fallback rules
 * drift across call sites.
 */
export function modelDisplayName(
  model: string | undefined,
  providers: ReadonlyArray<IknowSettingsLlmProvider> | undefined
): string | undefined {
  if (model === undefined) return undefined;
  const entry = findEntryByRouteId(modelPickerEntries(providers), model);
  return entry?.label ? entry.label : model;
}

export type ModelPickerAction =
  | { readonly kind: "move"; readonly index: number }
  | { readonly kind: "fix" }
  | { readonly kind: "commit" }
  | { readonly kind: "ignore" };

/**
 * Focus clamp upper bound (same source as the render row budget): focus may
 * only land inside the **visible window**, i.e.
 * `min(entryCount, MODEL_PICKER_MAX_ROWS) - 1`.
 *
 * Deliberate V1 "no scrolling" trade-off: the panel always renders the first
 * MODEL_PICKER_MAX_ROWS entries; extras are only counted in "…N more" and
 * never visible. Clamping to `entryCount-1` instead would let ↓ move the ▸
 * cursor out of the rendered area once the registry has ≥13 entries — an
 * invisible focus could still Enter-commit a hidden entry. Consequence:
 * reaching a hidden entry requires **trimming the registry** (removing models
 * beyond the first 12); this panel offers no scrolling window (same
 * constant-rows discipline as thinking-picker).
 */
function maxFocusedIndex(entryCount: number): number {
  return Math.max(0, Math.min(entryCount, MODEL_PICKER_MAX_ROWS) - 1);
}

/**
 * Key-routing pure function (consumed by the host's useKeyboard):
 *  - ctrl/meta → ignore (Ctrl+C/O not swallowed);
 *  - Esc → commit (close without persisting);
 *  - ↑/↓ → move, clamp [0, maxFocusedIndex] (visible window; empty list → 0);
 *  - Enter → fix (commit the focused entry);
 *  - Space / Tab / ←/→ / rest → ignore (no toggle, no horizontal move).
 */
export function reduceModelPickerKey(
  event: ModalKeyEvent,
  opts: { readonly focusedIndex: number; readonly entryCount: number }
): ModelPickerAction {
  const { focusedIndex, entryCount } = opts;
  const { key } = event;
  if (key.ctrl || key.meta) return { kind: "ignore" };
  if (key.escape) return { kind: "commit" };
  // Both directions clamp to the visible window: the focus seed (app layer
  // looks up the index of the current model) may land outside it, and either
  // arrow key pulls focus back into view.
  const max = maxFocusedIndex(entryCount);
  if (key.upArrow) {
    return {
      kind: "move",
      index: Math.max(0, Math.min(max, focusedIndex - 1)),
    };
  }
  if (key.downArrow) {
    return {
      kind: "move",
      index: Math.max(0, Math.min(max, focusedIndex + 1)),
    };
  }
  if (key.return) return { kind: "fix" };
  return { kind: "ignore" };
}

/**
 * Total terminal rows (row-budget SSOT, pure): border 2 + title 1 + content
 * rows + key hints 1 (itemized accounting, same style as memoryPickerRows'
 * "border 2 + title + two toggle rows + key hints"). Content rows =
 * min(entryCount, MODEL_PICKER_MAX_ROWS); when entryCount exceeds the cap the
 * remainder is represented by one "…N more" row (so panel height is bounded
 * and never grows with the registry). entryCount = 0 → 1 placeholder row
 * (the empty-registry path is intercepted by an app-layer notice and the
 * panel never opens; a deterministic row count is kept here anyway so the
 * render box is never zero-height). **Excludes marginBottom=1** — same
 * convention as modalRows / thinkingPickerRows, accounted by the +1 in
 * chromeReserveRows.
 */
export function modelPickerRows(entryCount: number): number {
  const overflow = entryCount > MODEL_PICKER_MAX_ROWS ? 1 : 0;
  const content = Math.max(1, Math.min(entryCount, MODEL_PICKER_MAX_ROWS));
  return 2 + 1 + content + overflow + 1;
}

/** Visible entry window: [0, max) — V1 has no scrolling (the panel always
 *  shows the first MODEL_PICKER_MAX_ROWS entries, same source as
 *  reduceModelPickerKey's focus upper bound). */
function visibleEntries(
  entries: ReadonlyArray<ModelPickerEntry>
): ReadonlyArray<ModelPickerEntry> {
  return entries.slice(0, MODEL_PICKER_MAX_ROWS);
}

/** One rendered row: `▸ provider/model  ·  name` (focused rows carry the
 *  cursor, unfocused use two spaces — same 2-column cursor width as
 *  memory-picker so the row budget never breaks). */
function entryRow(
  key: string,
  entry: ModelPickerEntry,
  focused: boolean
): ReactNode {
  const pal = tuiPalette;
  const label = entry.label;
  return (
    <text key={key}>
      <span fg={focused ? pal.running : pal.dim}>{focused ? "▸ " : "  "}</span>
      <span
        fg={focused ? pal.running : pal.text}
        attributes={focused ? TextAttributes.BOLD : TextAttributes.NONE}
      >
        {modelRouteId(entry)}
      </span>
      {label !== undefined && label.length > 0 && (
        <span fg={pal.dim}>{`  ·  ${label}`}</span>
      )}
    </text>
  );
}

/**
 * ModelPicker — rounded flowing-border model panel. Persistent overlay: no
 * entry animation, fixed width PICKER_WIDTH with alignSelf flex-start (never
 * full-screen width); rows predicted by modelPickerRows (border 2 + content +
 * key hints 1).
 */
export function ModelPicker(props: {
  readonly state: ModelPickerState;
}): ReactNode {
  const pal = tuiPalette;
  const { entries, focusedIndex } = props.state;

  const tl = useTimeline();
  const [borderPhase, setBorderPhase] = useState(0);
  useEffect(() => {
    const target = { phase: 0 };
    tl.add(target, {
      phase: 4,
      duration: BORDER_CYCLE_MS,
      ease: "linear",
      onComplete: () => {
        target.phase = 0;
      },
      onUpdate: () => {
        const next = target.phase;
        setBorderPhase((prev) => (prev === next ? prev : next));
      },
    });
  }, [tl]);

  const visible = visibleEntries(entries);
  const overflow = entries.length - visible.length;
  const rows: ReactNode[] = visible.map((entry, i) =>
    entryRow(`${entry.providerId}/${entry.modelId}`, entry, i === focusedIndex)
  );
  if (rows.length === 0) {
    // Defensive branch: an empty registry never opens the panel (app-layer
    // notice intercepts); when mounted directly by the renderer, keep one
    // deterministic placeholder row to avoid a zero-height box.
    rows.push(
      <text key="model-empty" fg={pal.dim}>
        （未配置 providers）
      </text>
    );
  }
  if (overflow > 0) {
    rows.push(
      <text key="model-more" fg={pal.dim}>
        {`  …${overflow} more`}
      </text>
    );
  }

  return (
    <box
      flexDirection="column"
      borderStyle="rounded"
      borderColor={flowBorderColor(borderPhase)}
      paddingX={1}
      paddingY={0}
      marginBottom={1}
      width={PICKER_WIDTH}
      alignSelf="flex-start"
    >
      {/* Title: model (◆─ shared panel prefix, consistent with the picker family) */}
      <text>
        <span fg={pal.running}>{"◆─ "}</span>
        <span fg={pal.text} attributes={TextAttributes.BOLD}>
          模型
        </span>
      </text>
      {rows}
      {/* Key hints (wrapMode none: narrow terminals clip instead of wrapping, keeping the row budget constant) */}
      <text fg={pal.dim} wrapMode="none">
        [↑↓] 选择 · [Enter] 切换 · [Esc] 关闭
      </text>
    </box>
  );
}
