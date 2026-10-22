/** @jsxImportSource @opentui/react */
/**
 * src/tui/context-bar.tsx
 *
 * Context-usage bar (migrated from archive/tui-ink/src/context-bar.tsx,
 * ink → OpenTUI): three-tier colored capacity bar
 * (`│ ctx █░ band NN% status X.Xk/Y.Yk`).
 *
 * Data contract (ADR-0008): this component consumes `lastUsage` and
 * `displayOccupancy` **read-only** — no second token ledger, no write-back.
 * `lastUsage` is the confirmed API usage; `displayOccupancy` is the
 * bar-facing reading from the `context_usage` channel (Plan A T4). Since the
 * ADR-0008 2026-10-22 amendment the TUI reducer produces confirmed
 * input-side readings only; a `projected` reading still renders `~NN%` for
 * direct component callers, but no production session producer emits one.
 * Without a reading the bar falls back to the confirmed `lastUsage`, so a
 * reopened session still shows a value.
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
 * the full band + `0% ok` + `0.0k/window`. Token speed always occupies the
 * trailing slot; narrow rows give up model/context detail before hiding it.
 * A projected reading (direct caller only) renders `~NN%` (same shape, one
 * column wider).
 *
 * Model source: the `model` prop carries the CURRENT conversation's own route
 * (ADR-0145) and wins. Without it the model name in the prefix comes from the
 * envDisplay store, which this component subscribes to directly — env changes
 * do not flow through the React tree, so we re-project the model name here
 * without re-rendering other chrome or the message area. effortLabel is still
 * precomputed by the host (thinking is outside this store's subscription
 * surface). The route-id -> display-name projection `modelDisplayName` lives
 * in model-picker.tsx (same host as the registry flattening, see there).
 */
import { useSyncExternalStore, useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { TokenUsage } from "../harness/model-adapter/types.js";
import { occupancyFromUsage } from "../harness/compress/occupancy.js";
import type { OccupancyReading } from "../harness/compress/projection.js";
import {
  ZERO_TOKEN_SPEED_READING,
  type TokenSpeedReading,
} from "./token-speed.js";
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
  /**
   * Plan A T4: the bar-facing occupancy reading (UI-only). Absent / null →
   * the bar falls back to the confirmed `lastUsage` (a reopened session
   * shows the persisted confirmed value until the first beat arrives). The
   * TUI session reducer produces confirmed input-side readings only since
   * ADR-0008's 2026-10-22 amendment; a `projected` reading is retained as
   * component capability for direct callers (renders `~NN%`).
   */
  readonly displayOccupancy?: OccupancyReading | null;
  /** Live estimated rate or the completed per-turn average. */
  readonly tokenSpeed?: TokenSpeedReading | null;
  readonly contextWindow: number;
  readonly running: boolean;
  readonly cols: number;
  /**
   * env display store: source of the model prefix segment when the `model`
   * prop is absent (the snapshot carries the DEFAULT model), subscribed inside
   * the component — an env publish re-renders this component only, no host prop
   * swap, hence no TuiApp whole-tree repaint. Unwired default → EMPTY_ENV_DISPLAY_STORE
   * whose snapshot model is always undefined (same render path as passing no model).
   */
  readonly envDisplay?: EnvDisplayStore;
  /**
   * ADR-0145: the CURRENT conversation's model route. It takes precedence over
   * the envDisplay snapshot (which carries the DEFAULT model): a conversation
   * owns its route, so the bar must show the route this conversation uses.
   * Absent → the snapshot's model is used (a draft / a conversation without a
   * route yet → the default).
   */
  readonly model?: string;
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
// (formula / three-tier color thresholds move together). The occupancy
// FORMULA stays mirrored; the display source is also confirmed-only on both
// sides since the ADR-0008 2026-10-22 amendment. The TUI refreshes per
// call-beat; Web still waits for the persisted answer (live channel follow-up).
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

/** Render estimated live rates with `~`; an idle zero is displayed plainly. */
export function formatTokenSpeed(reading: TokenSpeedReading): string {
  const value = Number.isFinite(reading.value)
    ? Math.max(0, Math.round(reading.value))
    : 0;
  const estimated = reading.estimated && value > 0 ? "~" : "";
  return `${estimated}${value} tok/s`;
}

/** Plan A T4: the reading the bar renders. The session's display reading
 *  wins; absent → the confirmed `lastUsage` (a reopened session still shows a
 *  value right away); neither → null (the idle 0% frame). */
export function selectOccupancyReading(
  displayOccupancy: OccupancyReading | null | undefined,
  lastUsage: TokenUsage | null
): OccupancyReading | null {
  if (displayOccupancy != null) return displayOccupancy;
  if (lastUsage === null) return null;
  return { tokens: occupancyFromUsage(lastUsage), source: "measured" };
}

/** Numerator + percentage text of one reading (ADR-0118 + Plan A T4).
 *  A projected reading carries the `~` marker; an invalid denominator renders
 *  the idle 0% frame instead of NaN. */
export interface BarOccupancy {
  readonly used: number;
  readonly pct: number;
  /** `NN%` for a confirmed reading, `~NN%` for a projection. */
  readonly pctText: string;
}

export function barOccupancy(
  reading: OccupancyReading | null,
  contextWindow: number
): BarOccupancy {
  if (reading === null || !(contextWindow > 0)) {
    return { used: 0, pct: 0, pctText: "0%" };
  }
  const pct = Math.round((reading.tokens / contextWindow) * 100);
  return {
    used: reading.tokens,
    pct,
    pctText: reading.source === "projected" ? `~${pct}%` : `${pct}%`,
  };
}

/** Model-name prefix segment (the model part of `{model} · {effort}`): truncated
 *  to visual columns (CJK-safe, trailing `…`). budgetCols ≤ 1 (not even `…`
 *  fits) → empty string. Pure function for unit tests. */
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

/** ADR-0145: the route the bar displays — the CURRENT conversation's own route
 *  wins over the env snapshot's default (the snapshot carries the default for
 *  conversations started later). */
export function displayedModelRoute(
  conversationRoute: string | undefined,
  snapshotRoute: string | undefined
): string | undefined {
  return conversationRoute ?? snapshotRoute;
}

/** Body + rate separator: ` · ` after an occupancy body; speed-only mode has
 *  no body, so its suffix keeps a single leading space (no dangling dot).
 *  Leaf helper (like modelPrefix) so the branch stays out of ContextBar's
 *  complexity budget. */
function speedSuffixFor(body: string, speedText: string): string {
  return body.length > 0 ? ` · ${speedText}` : ` ${speedText}`; // EXIT: speed-only row (no occupancy body) → one leading space, no dangling separator
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
  // Plan A T4 / 2026-10-22: the bar-facing reading (the session's confirmed
  // measured reading when present, else `lastUsage`), and the percentage text
  // it renders. Direct callers may still pass a projected reading (`~`), but
  // no production session emits one. The text is built BEFORE the body strings
  // so both width ledgers count the extra column of the `~` marker.
  const reading = selectOccupancyReading(props.displayOccupancy, lastUsage);
  const { used, pct, pctText } = barOccupancy(reading, contextWindow);
  // No pulse before the first turn (no reading) — there is no usage to read,
  // the frame idles at 0%; pulse the left border only while running with usage.
  const warm = reading !== null && running && pct > 0 && denomOk;
  const leftBorder = usePulse(!warm) ? pal.border : pal.running;
  const color = contextColor(pct);
  const speedText = formatTokenSpeed(
    props.tokenSpeed ?? ZERO_TOKEN_SPEED_READING
  );
  const separatorWidth = 3; // ` · `
  const speedCost = visualWidth(speedText) + separatorWidth;
  // ADR-0145: the conversation's own route wins over the snapshot's default.
  const model = (
    modelDisplayName(
      displayedModelRoute(props.model, envSnapshot.model),
      props.providers
    ) ?? ""
  ).trim();
  const effortLabel = (props.effortLabel ?? "").trim();
  const statusWord = pct > 80 ? "alert" : pct >= 50 ? "warn" : "ok";
  const tokensText = `${(used / 1000).toFixed(1)}k/${(
    contextWindow / 1000
  ).toFixed(1)}k`;
  const wideBody = `ctx ${valueBand(pct, 10)} ${pctText} ${statusWord} ${tokensText}`;
  const narrowBody = `ctx ${pctText}`;
  const compactBody = ` ${pctText}`;
  const wideBodyWidth = visualWidth(wideBody);
  const narrowBodyWidth = visualWidth(narrowBody);
  const compactBodyWidth = visualWidth(compactBody);
  const wideFits = 1 + 1 + wideBodyWidth + speedCost <= cols;
  const narrowFits = 1 + 1 + narrowBodyWidth + speedCost <= cols;
  const compactFits = 1 + compactBodyWidth + speedCost <= cols;
  const bodyMode = wideFits
    ? "wide"
    : narrowFits
      ? "narrow"
      : compactFits
        ? "compact"
        : "speed-only";
  const bodyWidth =
    bodyMode === "wide"
      ? wideBodyWidth
      : bodyMode === "narrow"
        ? narrowBodyWidth
        : bodyMode === "compact"
          ? compactBodyWidth
          : 0;
  const body =
    bodyMode === "wide"
      ? wideBody
      : bodyMode === "narrow"
        ? narrowBody
        : bodyMode === "compact"
          ? compactBody
          : "";
  const speedSuffix = speedSuffixFor(body, speedText);

  // Model and effort are optional; the speed and the most compact context
  // reading have already reserved their columns before these are considered.
  const prefixBudget = Math.max(
    0,
    cols - 1 - separatorWidth - 1 - bodyWidth - speedCost
  );
  const effortWidth = visualWidth(effortLabel);
  const modelBudget = Math.max(
    0,
    prefixBudget - (effortLabel.length > 0 ? separatorWidth + effortWidth : 0)
  );
  const clippedModel = model.length > 0 ? modelPrefix(model, modelBudget) : "";
  const prefix =
    clippedModel.length === 0
      ? effortLabel
      : effortLabel.length === 0
        ? clippedModel
        : `${clippedModel} · ${effortLabel}`;
  const prefixWidth = visualWidth(prefix);
  const prefixFits =
    prefix.length > 0 &&
    1 + prefixWidth + separatorWidth + 1 + bodyWidth + speedCost <= cols;
  const wide = bodyMode === "wide";

  if (!wide) {
    return (
      <box flexDirection="row">
        <text fg={leftBorder}>│</text>
        {prefixFits && <text fg={pal.dim}> {prefix} ·</text>}
        {body.length > 0 && <text fg={color}>{body}</text>}
        <text fg={pal.dim}>{speedSuffix}</text>
      </box>
    );
  }

  return (
    <box flexDirection="row">
      <text fg={leftBorder}>│</text>
      {prefixFits && <text fg={pal.dim}> {prefix} ·</text>}
      <text>
        <span> ctx </span>
        <span fg={color}>{valueBand(pct, 10)}</span>
        <span fg={color}> {pctText}</span>
        <span fg={color}> {statusWord}</span>
        <span fg={pal.dim}> {tokensText}</span>
      </text>
      <text fg={pal.dim}>{speedSuffix}</text>
    </box>
  );
}
