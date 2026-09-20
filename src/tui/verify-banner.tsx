/** @jsxImportSource @opentui/react */
/**
 * src/tui/verify-banner.tsx
 *
 * Human-readable end-state banner for the TUI verify loop:
 *   - shown in both HITL and auto modes for the 4 terminal states
 *     passed / failed / unstable / escalated;
 *   - missing verify → silent (0 rows, the render shell returns null, no
 *     fake hint);
 *   - malformed wire shape (runtime boundary) → degraded "verification result
 *     unavailable" line plus the typed-error detail (contract in
 *     code-quality.md: `${kind}: ${conversation_id}`; the
 *     `err instanceof Error ? err.message : String(err)` fallback is banned);
 *   - same two-layer shape as agent-status-line: pure projection functions +
 *     a render shell; the pure functions are unit-testable under bun:test
 *     directly, without OpenTUI / React rendering.
 *
 * Glyph discipline: passed ✓ / failed ✗ (established ✓ ✗ ▤ convention from
 * subagent-panel); unstable ⚠ / escalated ⤴. HITL shows the label directly;
 * auto prefixes `[auto] ` as a visual marker.
 *
 * Single data source: no second ledger. Banner state lives in app.tsx keyed
 * by conversation (`verifySlots`), fed by the `verify` DTO returned from
 * bridge.postMessage (passed is already in the wire union). On resume hydrate,
 * a transcript without a VerifyAnswerView stays silent (empty slot); we do not
 * try to restore from <agent_status> / verify envelopes, to avoid cloning a
 * second ledger (same stance as agent-status).
 */
import type { ReactNode } from "react";
import type { VerifyAnswerView } from "../session-api/contract.js";
import { clipOneLineVisual } from "./tool-summary.js";
import { tuiPalette } from "./theme.js";

/** Verify mode from the TUI perspective: hitl = the default interactive flow;
 *  auto = full_auto mode (the banner adds the `[auto] ` visual marker; see the
 *  src/tui/run.tsx --auto-mode flag). */
export type VerifyBannerMode = "hitl" | "auto";

/** Projection failure reason (code-quality.md typed-error rendering contract):
 *  lifts `kind` out of the discriminated union as the primary key; no
 *  exhaustiveness enforcement (reason may keep evolving). The render side
 *  outputs `${kind}: ${conversation_id}`, skipping the id when absent. */
export interface VerifyProjectionError {
  readonly kind: string;
  readonly conversation_id?: string;
}

/** Discriminated union for the app.tsx state slot (data slot and render
 *  projection converge in the projection function). none = missing verify
 *  (legal state, silent, no render); ok = one of the 4 terminal states;
 *  unavailable = projection failed (degraded "result unavailable" line). */
export type VerifySlot =
  | { readonly kind: "none" }
  | { readonly kind: "ok"; readonly verify: VerifyAnswerView }
  | {
      readonly kind: "unavailable";
      readonly reason: VerifyProjectionError;
    };

export interface VerifyBannerLine {
  readonly fg: string;
  readonly text: string;
}

// ===== outcome → glyph + label + fg (4-state mapping) =============================
//
// Color basis: passed green (palette.add, same source as add diff lines);
// failed / escalated red (palette.error, same source as del/error); unstable
// amber (palette.running, a hint state between running and error).
//
// Short-form labels — matching the labels of cli/format.ts formatVerifyReport
// but without its "not judged complete" warning suffix (the banner is
// end-state feedback, not a report).
const VERIFY_OUTCOME_PRESENTATION = {
  passed: { glyph: "✓", label: "验证通过", fg: tuiPalette.add },
  failed: { glyph: "✗", label: "验证未通过", fg: tuiPalette.error },
  unstable: {
    glyph: "⚠",
    label: "验证不稳定",
    fg: tuiPalette.running,
  },
  escalated: {
    glyph: "⤴",
    label: "验证耗尽（升级后仍未通过）",
    fg: tuiPalette.error,
  },
} as const;

/** Runtime wire-shape validation (runtime boundary): the verify field passed
 *  through postMessage crosses process boundaries and future wire drift, so it
 *  needs checking. Returns VerifySlot. Explicitly accepts outcome ∈ the 4 states
 *  + rounds as a finite non-negative integer; anything else → unavailable rather
 *  than throwing — the upper layer can render degraded without polluting the
 *  React render stack. */
export function verifyFromWire(raw: unknown): VerifySlot {
  if (raw === undefined || raw === null) {
    return { kind: "none" };
  }
  if (typeof raw !== "object") {
    return {
      kind: "unavailable",
      reason: { kind: "malformed_view" },
    };
  }
  const obj = raw as Record<string, unknown>;
  const outcome = obj.outcome;
  if (
    outcome !== "passed" &&
    outcome !== "failed" &&
    outcome !== "unstable" &&
    outcome !== "escalated"
  ) {
    return {
      kind: "unavailable",
      reason: { kind: "malformed_view" },
    };
  }
  const rounds = obj.rounds;
  if (typeof rounds !== "number" || !Number.isFinite(rounds) || rounds < 0) {
    return {
      kind: "unavailable",
      reason: { kind: "malformed_view" },
    };
  }
  return {
    kind: "ok",
    verify: { outcome, rounds },
  };
}

/** Typed-error rendering contract (code-quality.md): recognize the kind field,
 *  render `${kind}: ${conversation_id}` or just `${kind}`; anything that is not
 *  a legal typed-error shape → null (the upper layer must not fall back to
 *  `instanceof Error ? err.message : String(err)` — it must take the safe
 *  degraded line without details). */
export function describeVerifyErrorDetail(err: unknown): string | null {
  if (typeof err !== "object" || err === null) return null;
  const obj = err as Record<string, unknown>;
  if (typeof obj.kind !== "string") return null;
  const convId = obj.conversation_id;
  return typeof convId === "string" ? `${obj.kind}: ${convId}` : obj.kind;
}

/** Render projection: slot + mode → display-line array. none → []; ok → 1 line
 *  (terminal-state text); unavailable → 1 line (degraded). auto mode prefixes
 *  `[auto] ` uniformly (4 terminal states and the degraded line alike, so the
 *  marker is recognizable at a glance). cols truncation goes through
 *  clipOneLineVisual (CJK counts 2 columns; same as agent-status-line /
 *  subagent-panel). */
export function projectVerifyBanner(
  slot: VerifySlot,
  mode: VerifyBannerMode,
  cols: number
): ReadonlyArray<VerifyBannerLine> {
  if (slot.kind === "none") return [];
  const autoPrefix = mode === "auto" ? "[auto] " : "";
  if (slot.kind === "ok") {
    const view = slot.verify;
    const pres = VERIFY_OUTCOME_PRESENTATION[view.outcome];
    const text = `${autoPrefix}${pres.glyph} ${pres.label}（${view.rounds} 轮）`;
    return [{ fg: pres.fg, text: clipOneLineVisual(text, cols) }];
  }
  // unavailable — auto mode gets the same [auto] prefix (marker consistent with the 4 terminal states).
  const detail = describeVerifyErrorDetail(slot.reason);
  const suffix = detail === null ? "" : `（${detail}）`;
  const base = "⚠ 验证结果不可用";
  return [
    {
      fg: tuiPalette.error,
      text: clipOneLineVisual(`${autoPrefix}${base}${suffix}`, cols),
    },
  ];
}

// ===== Render shell (single-line status row: same discipline as StatusLine in components.tsx) =====

export interface VerifyBannerStripProps {
  /** Current slot from app.tsx verifySlots; no verify → none → silent. */
  readonly slot: VerifySlot;
  readonly mode: VerifyBannerMode;
  readonly cols: number;
}

/** Single-line banner render shell. An empty slot (slot.kind === "none") →
 *  the component returns null (no extra row, unified with ChatView's own
 *  rendering constraints). The banner itself has no marginBottom / border →
 *  chromeReserveRows counts it as a bare row (see the verifyRows coupled
 *  cases in chrome-budget.test.ts). */
export function VerifyBannerStrip(props: VerifyBannerStripProps): ReactNode {
  const lines = projectVerifyBanner(props.slot, props.mode, props.cols);
  if (lines.length === 0) return null;
  return (
    <box flexDirection="column">
      {lines.map((line, idx) => (
        <text key={idx} fg={line.fg} wrapMode="none">
          {line.text}
        </text>
      ))}
    </box>
  );
}
