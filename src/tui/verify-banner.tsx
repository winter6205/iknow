/** @jsxImportSource @opentui/react */
/**
 * src/tui/verify-banner.tsx
 *
 * Human-readable end-state banner for the TUI verify loop:
 *   - shown in both HITL and auto modes for the terminal states
 *     passed / failed / unstable / escalated / not_run;
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
 * subagent-panel); unstable ⚠ / escalated ⤴ / not_run ⚠. HITL shows the label directly;
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
 *  (legal state, silent, no render); ok = one of the terminal states;
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

// ===== outcome → glyph + label + fg (terminal-state mapping) =============================
//
// Color basis: passed green (palette.add, same source as add diff lines);
// failed / escalated red (palette.error, same source as del/error); unstable
// amber (palette.running, a hint state between running and error); not_run
// amber (palette.running — not verified is neither a pass nor a verified
// failure). The two not_run rows are keyed by the notRunReason discriminator
// and must never collapse onto one string.
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
  not_run_insufficient: {
    glyph: "⚠",
    label: "未验证（证据不足）",
    fg: tuiPalette.running,
  },
  not_run_contradicted: {
    glyph: "⚠",
    label: "未验证（证据冲突）",
    fg: tuiPalette.running,
  },
} as const;

function verifyPresentationKey(
  view: VerifyAnswerView
): keyof typeof VERIFY_OUTCOME_PRESENTATION {
  if (view.outcome !== "not_run") {
    return view.outcome;
  }
  return view.notRunReason === "contradicted"
    ? "not_run_contradicted"
    : "not_run_insufficient";
}

/** Wire outcome allowlist (runtime boundary): narrows a raw outcome to the
 *  five projectable states; anything else → undefined (the caller degrades). */
function parseWireOutcome(
  raw: unknown
): VerifyAnswerView["outcome"] | undefined {
  if (
    raw === "passed" ||
    raw === "failed" ||
    raw === "unstable" ||
    raw === "escalated" ||
    raw === "not_run"
  ) {
    return raw;
  }
  return undefined;
}

/** notRunReason normalization: the two known kinds pass through, anything
 *  else (absent / garbage) → undefined. The malformed verdict itself is the
 *  outcome-coupling check in verifyFromWire (spec Q-A: the two are coupled on
 *  the wire, both violation directions are malformed). */
function parseNotRunReason(raw: unknown): VerifyAnswerView["notRunReason"] {
  return raw === "insufficient" || raw === "contradicted" ? raw : undefined;
}

/** rounds: finite non-negative integer (0 allowed); anything else → undefined. */
function parseWireRounds(raw: unknown): number | undefined {
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 0
    ? raw
    : undefined;
}

/** Degraded slot shared by every malformed-shape exit (runtime boundary):
 *  unavailable + malformed_view, never a throw, never a rendered lie. */
function malformedVerifySlot(): VerifySlot {
  return {
    kind: "unavailable",
    reason: { kind: "malformed_view" },
  };
}

/** Runtime wire-shape validation (runtime boundary): the verify field passed
 *  through postMessage crosses process boundaries and future wire drift, so it
 *  needs checking. Explicitly accepts outcome ∈ the 5 states + rounds as a
 *  finite non-negative integer; anything else → unavailable rather than
 *  throwing — the upper layer can render degraded without polluting the React
 *  render stack. notRunReason is cross-validated with outcome in both
 *  directions: "not_run" requires a known reason, and a present reason on any
 *  other outcome is malformed (the two are coupled on the wire). */
export function verifyFromWire(raw: unknown): VerifySlot {
  if (raw === undefined || raw === null) {
    return { kind: "none" };
  }
  if (typeof raw !== "object") {
    return malformedVerifySlot();
  }
  const obj = raw as Record<string, unknown>;
  const outcome = parseWireOutcome(obj.outcome);
  if (outcome === undefined) {
    return malformedVerifySlot();
  }
  const rawReason = obj.notRunReason;
  const notRunReason = parseNotRunReason(rawReason);
  // Both coupling directions: not_run demands a known kind; every other
  // outcome forbids a present reason.
  if (
    outcome === "not_run" ? notRunReason === undefined : rawReason !== undefined
  ) {
    return malformedVerifySlot();
  }
  const rounds = parseWireRounds(obj.rounds);
  if (rounds === undefined) {
    return malformedVerifySlot();
  }
  return {
    kind: "ok",
    verify: {
      outcome,
      rounds,
      ...(notRunReason !== undefined ? { notRunReason } : {}),
    },
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
 *  `[auto] ` uniformly (terminal states and the degraded line alike, so the
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
    const pres = VERIFY_OUTCOME_PRESENTATION[verifyPresentationKey(view)];
    const text = `${autoPrefix}${pres.glyph} ${pres.label}（${view.rounds} 轮）`;
    return [{ fg: pres.fg, text: clipOneLineVisual(text, cols) }];
  }
  // unavailable — auto mode gets the same [auto] prefix (marker consistent with the terminal states).
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
