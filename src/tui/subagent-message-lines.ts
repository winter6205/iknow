/**
 * src/tui/subagent-message-lines.ts
 *
 * Card-level two-line projection (specs/tui-subagent-transcript-live.md):
 * join one subagent back to the `spawn_subagent` card that spawned it in the
 * session transcript. Live line 1 is `{role} running...`, line 2 the dim
 * `taskPreview`; once that worker completes, the overview stays, line 1
 * drops the running suffix and is identity only, and a literal green `✓ Done`
 * is appended below it. The join key is `SubagentInfo.toolUseId` (the tool_use
 * id of that spawn — the same id space as the card side).
 *
 * This replaces the older "spread the whole live list" projection
 * (`projectSubagentMessageLines` / `subagentMessageRowCount`) and the identity
 * bar above the prompt: placement is decided by the session card, so "every
 * live subagent always occupies two rows" is no longer the projection's output
 * shape — a card only knows its own correlator.
 *
 * This file is React-free pure TS (no React / OpenTUI): the projection is
 * unit-testable directly, and rendering belongs to the hosts' single surface
 * (`subagent-card-view.tsx`) — live tail and history hosts must not each
 * write their own template.
 *
 * Boundaries:
 *   - empty: empty array / `toolUseId` absent, empty or whitespace-only →
 *     `null` (no correlator — never borrow another worker's preview);
 *   - negative: no match / match is `failed` → `null` (failed goes to that
 *     card's existing failure overlay, not the green `✓ Done`); role absent /
 *     empty / whitespace-only → catalog fallback (the literal 子代理 is never
 *     emitted);
 *   - overflow: the two live lines are each truncated to cols visual width
 *     (CJK-safe) and never wrap; `cols <= 0` → a 1-column budget. The
 *     completed card's overview is width-clamped the same way (once back on
 *     the page it must not overflow columns any more than live does); the
 *     done marker `✓ Done` is a fixed literal face with no width clamp —
 *     literal text wins over column aesthetics, and the host's
 *     `wrapMode="none"` clips edges;
 *   - concurrent: pure function — each projection reads the arguments at call
 *     time with no history residue; two live workers each take the
 *     `taskPreview` of their own join without crossing; on duplicate
 *     `toolUseId` the first entry in list order wins (deterministic);
 *   - exception: `startedAt` / `endedAt` / `summary` are never read (invalid
 *     ISO cannot affect the projection); missing / empty `taskPreview` → the
 *     overview line holds an empty-string placeholder so the row count never
 *     collapses.
 */
import type { SubagentInfo } from "../harness/subagent/manager.js";
import { clipOneLineVisual } from "./tool-summary.js";
import { SUBAGENT_ROLE_FALLBACK } from "../shared/tool-line.js";

/**
 * Catalog fallback when role is missing. Same value and source as
 * `SUBAGENT_ROLE_FALLBACK` in `resolveSubagentRoleFromInput`
 * (src/shared/tool-line.ts) — the tool card and the two-line projection must
 * not print two different role names for the same subagent.
 */
export const IDENTITY_FALLBACK_ROLE = SUBAGENT_ROLE_FALLBACK;

/** Fixed suffix of live line 1 (three dots). Completed lines drop it — line 1
 *  is identity only then. A spawn card that never joins skips this suffix —
 *  it falls into formatToolStatusLine's dotless form (`explore running`). */
const RUNNING_SUFFIX = " running...";

/** Completed card's done marker: the overview stays and this literal green
 *  `✓ Done` renders below it. A geometric glyph like the panel's `●` / `✓`
 *  (no emoji). */
const DONE_MARKER = "✓ Done";

/**
 * The single predicate for a live subagent: `starting` + `running` (the row
 * order contract).
 *
 * The panel's live row order (`projectSubagentLines`), the Ctrl+X kill
 * dispatch (subagent-kill.ts) and the app's focus count all share this
 * predicate — restating the literals in several places means any drift would
 * misalign "focused row ↔ who gets killed". Terminal states (completed /
 * failed) are not live: their window semantics belong to the panel.
 *
 * Lives in this module (the React / OpenTUI-free pure layer) rather than the
 * panel .tsx so the kill dispatch and the projection can import it without
 * dragging OpenTUI into their dependency graphs.
 *
 * Note: the card-level projection ignores this predicate — it classifies by
 * `state` three ways (live / completed / failed), because a completed card
 * still draws its overview + green `✓ Done`.
 */
export function isLiveSubagent(info: SubagentInfo): boolean {
  return info.state === "starting" || info.state === "running";
}

/**
 * Role projection for one live subagent:
 *   - role present and non-blank (after trim) → role.trim();
 *   - role absent / empty / whitespace-only → IDENTITY_FALLBACK_ROLE; the
 *     literal 子代理 is never emitted.
 */
export function resolveIdentityRole(info: SubagentInfo): string {
  const role = info.role;
  if (role === undefined) return IDENTITY_FALLBACK_ROLE;
  const trimmed = role.trim();
  return trimmed.length > 0 ? trimmed : IDENTITY_FALLBACK_ROLE;
}

/** Card-level projection (the single shape both hosts render). */
export interface SubagentCardLines {
  /** Line 1: live → `{role} running...`; completed → identity only, no
   *  `running...`. */
  readonly roleLine: string;
  /** Line 2: `taskPreview` truncated to cols for both live and completed
   *  (empty string = placeholder row). For a completed card this line is the
   *  kept overview, not a stand-in. */
  readonly detailLine: string;
  /** Line 3 (completed only): literal `✓ Done`; absent (undefined) while live. */
  readonly doneLine?: string;
  /** Completion flag: true → doneLine present; the host draws it with
   *  tuiPalette.add (green). */
  readonly done: boolean;
}

/**
 * Join-key normalization: absent / empty / whitespace-only is not a valid
 * correlator → `null`. The same rule applies on both sides (the argument and
 * the entry field) — whitespace differences must not create fake joins.
 */
function normalizeCorrelator(toolUseId: string | undefined): string | null {
  if (toolUseId === undefined) return null;
  const trimmed = toolUseId.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Single-card assembly (live / completed). The caller guarantees state !== "failed". */
function buildCard(info: SubagentInfo, budget: number): SubagentCardLines {
  const role = resolveIdentityRole(info);
  if (info.state === "completed") {
    // Completed: the overview stays (truncated to cols like live), line 1
    // drops the running suffix to identity only, and the literal `✓ Done` is
    // appended below with no width clamp.
    return {
      roleLine: clipOneLineVisual(role, budget),
      detailLine: clipOneLineVisual(info.taskPreview, budget),
      doneLine: DONE_MARKER,
      done: true,
    };
  }
  return {
    roleLine: clipOneLineVisual(`${role}${RUNNING_SUFFIX}`, budget),
    detailLine: clipOneLineVisual(info.taskPreview, budget),
    done: false,
  };
}

/**
 * Single-card projection: the card-level two lines of the subagent joined to
 * `toolUseId`.
 *
 * All cases returning `null` (the host falls back to the existing single-line
 * title / failure overlay):
 *   - `toolUseId` absent / empty / whitespace-only — EXIT: no correlator,
 *     never borrow another worker's preview;
 *   - no entry matches the key;
 *   - every entry under the key is `failed` — failed stays out of the join
 *     and belongs to that card's failure overlay.
 *
 * The implementation queries subagentCardLinesMap directly: both functions
 * share the single rule "skip absent-key / failed entries, first entry wins
 * on duplicate keys" rather than each writing it — once the two
 * implementations drift, the live host (per-card projection) and the history
 * host (map) would render different lines for the same worker.
 */
export function projectSubagentCardLines(
  subagents: ReadonlyArray<SubagentInfo>,
  toolUseId: string | undefined,
  cols: number
): SubagentCardLines | null {
  const key = normalizeCorrelator(toolUseId);
  if (key === null) return null; // EXIT: no correlator — never borrow another worker's preview
  return subagentCardLinesMap(subagents, cols).get(key) ?? null;
}

/**
 * Content signature of the projection input (for useMemo deps). The app
 * layer polls at 1Hz and calls setSubagents with a fresh array each time —
 * depending on the array reference would make subagentCardLinesMap build a
 * new Map every second, and the memoized history message blocks
 * (MessageBlocks) below would rebuild their whole element tree likewise
 * (same class of regression as history-rerender-cost). The signature fields
 * are exactly everything the projection reads (`toolUseId` / `state` /
 * `role` / `taskPreview`); omitting one would let the cache serve stale
 * cards.
 *
 * Encoding is JSON.stringify over nested arrays: any character inside a
 * field (quotes / commas / control chars) is escaped, and the tuple→signature
 * map is injective. Hand-joined delimiters cannot achieve that — role (the
 * `subagent_type` input) and taskPreview (`def.task`) are arbitrary
 * model-supplied strings that could collide into the same signature across a
 * delimiter and serve stale cards. JSON also keeps literal control bytes out
 * of the source (a literal NUL would make git treat this file as binary and
 * blind both diff and rg).
 */
export function subagentCardsKey(
  subagents: ReadonlyArray<SubagentInfo>
): string {
  return JSON.stringify(
    subagents.map((info) => [
      info.toolUseId ?? "",
      info.state,
      info.role ?? "",
      info.taskPreview,
    ])
  );
}

/**
 * Per-card map (key = `toolUseId`): the history-card host reads it once and
 * looks each card up by its own id — avoiding one linear scan per card.
 *
 * Skip rules share the source with the single-card projection: entries with
 * absent / empty `toolUseId` are skipped entirely (never enter the map, never
 * occupy a key), `failed` entries are skipped, duplicate keys keep the first
 * entry in list order (deterministic — later entries never overwrite). Both
 * live and completed enter the map (a completed card still draws its overview
 * + green `✓ Done`).
 */
export function subagentCardLinesMap(
  subagents: ReadonlyArray<SubagentInfo>,
  cols: number
): ReadonlyMap<string, SubagentCardLines> {
  const budget = Math.max(1, cols);
  const out = new Map<string, SubagentCardLines>();
  for (const info of subagents) {
    const key = normalizeCorrelator(info.toolUseId);
    if (key === null) continue; // EXIT: entries without a correlator never enter the map
    if (info.state === "failed") continue; // failed belongs to the card's failure overlay
    if (out.has(key)) continue; // first entry in list order wins
    out.set(key, buildCard(info, budget));
  }
  return out;
}
