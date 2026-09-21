/** @jsxImportSource @opentui/react */
/**
 * src/tui/context-bar.tsx
 *
 * Context-usage bar (migrated from archive/tui-ink/src/context-bar.tsx,
 * ink → OpenTUI): three-tier colored capacity bar
 * (`│ ctx █░ band NN% status X.Xk/Y.Yk`).
 *
 * Data contract (ADR-0008): this component consumes `RunResult.lastUsage`
 * **read-only** (TokenUsage wire shape verbatim) — no second token ledger,
 * no write-back; the migration changed only the render component, the data
 * path is unchanged.
 *
 * Numeric semantics = context occupancy (ADR-0118), computed by
 * `compress/occupancy.ts` — the same function the proactive gate uses;
 * web/src/components/UsageChip.tsx keeps a cross-package mirror of it:
 * pre_call shape (cache fields null) →
 * used = inputTokens; post_call → inputTokens + cacheReadInputTokens +
 * cacheCreationInputTokens (null cache counts as 0); pct = round(used /
 * contextWindow * 100).
 *
 * Three-tier thresholds: <50% CTX_BLUE; 50-80% running (amber); >80% error.
 * While running with usage already reported, the left border pulses at 600ms.
 *
 * Always-on frame: even with lastUsage === null (before the first turn) render
 * the full band + `0% ok` + `0.0k/window`. Narrow columns (cols < 40) degrade
 * to `ctx NN%` only. activeToolName appends a `⚙ name` suffix (no extra chrome
 * row, the line budget is unchanged).
 *
 * Model source: the model name in the prefix is NOT passed via props; this
 * component subscribes to the envDisplay store directly — env changes do not
 * flow through the React tree, so we re-project the model name here without
 * re-rendering other chrome or the message area. effortLabel is still
 * precomputed by the host (thinking is outside this store's subscription
 * surface). The route-id -> display-name projection `modelDisplayName` lives
 * in model-picker.tsx (same host as the registry flattening, see there).
 */
import { useSyncExternalStore, useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { TokenUsage } from "../harness/model-adapter/types.js";
import { occupancyFromUsage } from "../harness/compress/occupancy.js";
import type { IknowSettingsLlmProvider } from "../config/settings.js";
import { modelDisplayName } from "./model-picker.js";
import {
  EMPTY_ENV_DISPLAY_STORE,
  type EnvDisplayStore,
} from "./env-display-store.js";
import { visualWidth } from "./tool-summary.js";
import { tuiPalette } from "./theme.js";

export interface ContextBarProps {
  /** Read-only projection (ADR-0008): host passes RunResult.lastUsage; this component never writes back. */
  readonly lastUsage: TokenUsage | null;
  readonly contextWindow: number;
  readonly running: boolean;
  readonly cols: number;
  /** Name of the currently running tool (app derives it from liveToolRuns).
   *  undefined = no tool running → no indicator. Rendered as this row's suffix
   *  (no extra chrome row). */
  readonly activeToolName?: string;
  /**
   * env display store: sole source of the model prefix segment, subscribed inside
   * the component — an env publish re-renders this component only, no host prop
   * swap, hence no TuiApp whole-tree repaint. Unwired default → EMPTY_ENV_DISPLAY_STORE
   * whose snapshot model is always undefined (same render path as passing no model).
   */
  readonly envDisplay?: EnvDisplayStore;
  /** Model registry (provider × models) for the route-id → display-name projection.
   *  Missing → no lookup, the display name falls back to the route id itself. */
  readonly providers?: ReadonlyArray<IknowSettingsLlmProvider>;
  /** Thinking-level label ("off"/"auto"/"low"/... precomputed by host). Empty → segment omitted. */
  readonly effortLabel?: string;
}

/** envDisplay default resolution (kept out of the component body: no extra branch
 *  there, so the S5 complexity gate stays at its baseline). */
function resolveEnvDisplayStore(
  store: EnvDisplayStore | undefined
): EnvDisplayStore {
  return store ?? EMPTY_ENV_DISPLAY_STORE;
}

/** Light-blue safe tier; mirrors the Web UsageChip COLOR_SAFE value.
 *  Exported for tests (same pattern as the Web test). */
export const CTX_BLUE = "#7ab8ff";

// Numeric-semantics SSOT: the pure functions below stay mirrored with
// web/src/components/UsageChip.tsx — changing one side must change the other
// (formula / three-tier color thresholds move together).
/** Capacity band: █ filled + ░ remaining. */
export function valueBand(pct: number, width = 10): string {
  const clamped = Math.max(0, Math.min(100, pct));
  const filled = Math.round((clamped / 100) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

/** Three-tier color thresholds: <50% CTX_BLUE / 50-80% running / >80% error. */
export function contextColor(pct: number): string {
  if (pct > 80) return tuiPalette.error;
  if (pct >= 50) return tuiPalette.running;
  return CTX_BLUE;
}

/** 600ms boolean pulse (no timer started while frozen). */
function usePulse(frozen: boolean, periodMs = 600): boolean {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (frozen) return;
    const t = setInterval(() => setN((x) => x + 1), periodMs);
    return () => clearInterval(t);
  }, [frozen, periodMs]);
  return n % 2 === 0;
}

/** Active-tool indicator: `[tool] name` truncated to budgetCols visual columns
 *  (CJK-safe); a prefix that does not fit → empty string. Over-wide names get a
 *  trailing `…`. Pure function for unit tests. No emoji UI glyphs. */
export function toolIndicator(name: string, budgetCols: number): string {
  const PREFIX = "[tool] ";
  const prefixW = visualWidth(PREFIX);
  if (budgetCols <= prefixW) return "";
  const nameBudget = budgetCols - prefixW;
  // Fold whitespace: embedded newlines/multiple spaces would distort the row
  // (first-line remainder + overflow); fold to single spaces before truncating
  // (normal tool names contain no whitespace, so zero impact).
  const folded = name.replace(/\s+/g, " ");
  if (visualWidth(folded) <= nameBudget) return PREFIX + folded;
  // Tail truncation: accumulate code points over the folded text (only folded
  // names get here) until one more char would overflow (reserving the `…` slot).
  const ellW = visualWidth("…");
  let acc = "";
  for (const ch of folded) {
    if (visualWidth(acc + ch) > nameBudget - ellW) break;
    acc += ch;
  }
  return PREFIX + acc + "…";
}

/** Model-name prefix segment (the model part of `{model} · {effort}`): truncated
 *  to visual columns (CJK-safe, trailing `…`). budgetCols ≤ 1 (not even `…`
 *  fits) → empty string. Pure function for unit tests. Folds inner whitespace
 *  like toolIndicator (guards against newline/space distortion). */
export function modelPrefix(model: string, budgetCols: number): string {
  const folded = model.replace(/\s+/g, " ").trim();
  if (budgetCols <= 1 || folded.length === 0) return "";
  if (visualWidth(folded) <= budgetCols) return folded;
  const ellW = visualWidth("…");
  let acc = "";
  for (const ch of folded) {
    if (visualWidth(acc + ch) > budgetCols - ellW) break;
    acc += ch;
  }
  return acc + "…";
}

export function ContextBar(props: ContextBarProps): ReactNode {
  const pal = tuiPalette;
  const { lastUsage, contextWindow, running, cols } = props;
  // Always call the hook (React rules): with envDisplay absent use the module-level
  // inert store, whose getSnapshot returns a constant empty snapshot → no re-render.
  const envDisplay = resolveEnvDisplayStore(props.envDisplay);
  const envSnapshot = useSyncExternalStore(
    envDisplay.subscribe,
    envDisplay.get
  );
  // Denominator ≤ 0 (envInt gave 0 / negative) → treat as invalid; used/pct fall back to 0 to avoid NaN.
  const denomOk = contextWindow > 0;
  const used =
    lastUsage === null || !denomOk ? 0 : occupancyFromUsage(lastUsage);
  const pct =
    lastUsage === null || !denomOk
      ? 0
      : Math.round((used / contextWindow) * 100);
  // No pulse before the first turn (lastUsage null) — there is no usage to read,
  // the frame idles at 0%; pulse the left border only while running with usage.
  const warm = lastUsage !== null && running && pct > 0 && denomOk;
  const leftBorder = usePulse(!warm) ? pal.border : pal.running;
  const color = contextColor(pct);
  const activeToolName = props.activeToolName;
  // Prefix segment `{model} · {effort}`: each part and the ` · ` separator render
  // only when non-empty; both empty → no prefix (keeps existing direct-render
  // cases). effort is precomputed by the host (enabled ? formatEffortLabel :
  // "off"), at most 5 columns; the model name is width-truncated (modelPrefix,
  // CJK-safe …). No extra chrome row, the line budget is unchanged.
  //
  // Row-width ledger (visualWidth basis, overflow prevention, SSOT):
  //   row = `│` + ` {prefix} · ` + bodyContent + [` ` + tool]
  // segments: border 1 + leading space 1 + prefixCols + SEP(` · `) 3
  //          + bodyContentW + [tool leading space 1 + toolW]
  // model truncation budget = cols − border(1) − leading space(1) − SEP(3)
  // − bodyW − safety margin(1) − [effort segment ` · `(3) + effortW].
  // Budget ≤1 → the model segment exits.
  const SEP = 3; // ` · `
  // Project the snapshot route id to a display name via the registry, then trim (same basis as effortLabel).
  const model = (
    modelDisplayName(envSnapshot.model, props.providers) ?? ""
  ).trim();
  const effortLabel = (props.effortLabel ?? "").trim();
  const effW = visualWidth(effortLabel);
  const statusWord = pct > 80 ? "alert" : pct >= 50 ? "warn" : "ok";
  const tokensText = `${(used / 1000).toFixed(1)}k/${(
    contextWindow / 1000
  ).toFixed(1)}k`;
  const wideBodyContent = `ctx ${valueBand(pct, 10)} ${pct}% ${statusWord} ${tokensText}`;
  const narrowBodyContent = `ctx ${pct}%`;
  const wideBodyW = visualWidth(wideBodyContent);
  const narrowBodyW = visualWidth(narrowBodyContent);
  const modelBudgetWide = Math.max(
    0,
    cols -
      1 -
      1 -
      SEP -
      wideBodyW -
      1 -
      (effortLabel.length > 0 ? SEP : 0) -
      effW
  );
  const modelBudgetNarrow = Math.max(0, cols - 1 - 1 - SEP - narrowBodyW - 1);
  const clippedModel =
    model.length > 0 ? modelPrefix(model, modelBudgetWide) : "";
  const clippedModelNarrow =
    model.length > 0 ? modelPrefix(model, modelBudgetNarrow) : "";
  // Wide-column prefix: model (truncated) + effort; narrow-column prefix: effort
  // first (≤5 cols, the most stable content to keep when narrow), model truncated
  // with the narrow budget only when there is no effort. Both empty → no prefix.
  const widePrefix =
    model.length === 0 && effortLabel.length === 0
      ? ""
      : clippedModel.length === 0
        ? effortLabel
        : effortLabel.length === 0
          ? clippedModel
          : `${clippedModel} · ${effortLabel}`;
  const narrowPrefix =
    effortLabel.length > 0 ? effortLabel : clippedModelNarrow;
  const widePrefixCols = visualWidth(widePrefix);
  const narrowPrefixCols = visualWidth(narrowPrefix);
  // Fit guard: render the prefix only when the whole row (leading space + prefix
  // + SEP + body) fits. Budget math guarantees the model case fits; the guard
  // covers unexpected effort-only overflow (defense against bad host values).
  const wideFits =
    widePrefix.length === 0 || 1 + widePrefixCols + SEP + 1 + wideBodyW <= cols;
  const narrowFits =
    narrowPrefix.length === 0 ||
    1 + narrowPrefixCols + SEP + 1 + narrowBodyW <= cols;
  // Tool suffix budget = cols − border − leading space − [prefix + SEP] − body
  // − tool leading space − safety margin(1); it must subtract the prefix columns,
  // otherwise the prefix squeezes the suffix into overflow.
  const wideToolBudget = Math.max(
    0,
    cols - 1 - 1 - (wideFits ? widePrefixCols + SEP : 0) - wideBodyW - 1 - 1
  );
  const narrowToolBudget = Math.max(
    0,
    cols -
      1 -
      1 -
      (narrowFits ? narrowPrefixCols + SEP : 0) -
      narrowBodyW -
      1 -
      1
  );
  const wideTool =
    activeToolName === undefined
      ? ""
      : toolIndicator(activeToolName, wideToolBudget);
  const narrowTool =
    activeToolName === undefined
      ? ""
      : toolIndicator(activeToolName, narrowToolBudget);
  // Narrow columns (cols < 40): `ctx NN%` only (status word and k/k numbers
  // omitted). Prefix keeps effort (model yields); drop it if even that overflows.
  if (cols < 40) {
    return (
      <box flexDirection="row">
        <text fg={leftBorder}>│</text>
        {narrowFits && narrowPrefix.length > 0 && (
          <text fg={pal.dim}> {narrowPrefix} ·</text>
        )}
        <text fg={color}> ctx {pct}%</text>
        {narrowTool !== "" && <text fg={pal.dim}> {narrowTool}</text>}
      </box>
    );
  }
  return (
    <box flexDirection="row">
      <text fg={leftBorder}>│</text>
      {wideFits && widePrefix.length > 0 && (
        <text fg={pal.dim}> {widePrefix} ·</text>
      )}
      <text>
        <span> ctx </span>
        <span fg={color}>{valueBand(pct, 10)}</span>
        <span fg={color}> {pct}%</span>
        <span fg={color}> {statusWord}</span>
        <span fg={pal.dim}> {tokensText}</span>
        {wideTool !== "" && <span fg={pal.dim}> {wideTool}</span>}
      </text>
    </box>
  );
}
