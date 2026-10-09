/**
 * src/tui/subagent-message-lines.ts
 *
 * Card-level two-line projection (specs/subagent-card-title.md): join one
 * subagent back to the `spawn_subagent` card that spawned it in the session
 * transcript. Line 1 is the operator `title` — from that worker's spawn record
 * (`SubagentInfo.title`) while a list describes it, else from the settled
 * block's own input (`settledSpawnCardFromBlock`, the durable copy), and
 * identical while the worker runs and once it completes; line 2 is a single
 * activity slot — the dim `tool name · argument summary` of the tool that worker
 * issued most recently (wording from the shared tool-summary formatter, so the
 * slot and the transcript's own tool lines cannot drift), or the literal green
 * `✓ Done` once it completes. The card is exactly two lines in
 * every state: `taskPreview` is not on the card (it stays on `SubagentInfo` and
 * in `SubagentPanel`). The join key is
 * `SubagentInfo.toolUseId` (the tool_use id of that spawn — the same id space as
 * the card side).
 *
 * This replaces the older "spread the whole live list" projection
 * (`projectSubagentMessageLines` / `subagentMessageRowCount`) and the identity
 * bar above the prompt: placement is decided by the session card, so "every live
 * subagent always occupies two rows" is no longer the projection's output shape —
 * a card only knows its own correlator.
 *
 * This file is React-free pure TS (no React / OpenTUI): the projection is
 * unit-testable directly, and rendering belongs to the hosts' single surface
 * (`subagent-card-view.tsx`) — live tail and history hosts must not each write
 * their own template.
 *
 * Boundaries:
 *   - empty: empty array / `toolUseId` absent, empty or whitespace-only →
 *     `null` (no correlator — never borrow another worker's title or tool
 *     name); no `title` on the spawn record → catalog role fallback
 *     (`subagent_type`, else `general-purpose`), never a blank line 1;
 *   - negative: no match / match is `failed` → `null` (failed goes to that
 *     card's existing failure overlay, not the green `✓ Done`); the fallback
 *     role absent / empty / whitespace-only → `IDENTITY_FALLBACK_ROLE` (the
 *     Chinese "subagent" literal is never emitted);
 *   - overflow: both lines are truncated to cols visual width (CJK-safe) and
 *     never wrap; `cols <= 0` → a 1-column budget. The completion marker
 *     `✓ Done` is a fixed literal face with no width clamp — literal text wins
 *     over column aesthetics, and the host's `wrapMode="none"` clips edges;
 *   - concurrent: pure function — each projection reads the arguments at call
 *     time with no history residue; two live workers each take their own title
 *     and their own `activity`; on duplicate `toolUseId` the first eligible
 *     entry in list order wins (deterministic);
 *   - exception: `startedAt` / `endedAt` / `summary` / `taskPreview` are never
 *     read (invalid ISO cannot affect the projection); `activity` absent
 *     (no reader injected / first read pending) or `null` (no call issued yet)
 *     → the slot holds an empty-string placeholder so the row count never
 *     collapses.
 */
import type {
  SubagentActivity,
  SubagentInfo,
} from "../harness/subagent/manager.js";
import { clipOneLineVisual } from "./tool-summary.js";
import {
  TOOL_SUMMARIES,
  formatToolStatusLine,
  resolveSubagentRoleFromInput,
  SUBAGENT_ROLE_FALLBACK,
} from "../shared/tool-line.js";

/**
 * Catalog fallback when role is missing. Same value and source as
 * `SUBAGENT_ROLE_FALLBACK` in `resolveSubagentRoleFromInput`
 * (src/shared/tool-line.ts) — the tool card and the two-line projection must
 * not print two different role names for the same subagent.
 */
export const IDENTITY_FALLBACK_ROLE = SUBAGENT_ROLE_FALLBACK;

/** Completed card's activity slot: this literal green `✓ Done` replaces the
 *  retained issued-tool name (the name is not kept). A geometric glyph like the
 *  panel's `●` / `✓` (no emoji). */
const DONE_MARKER = "✓ Done";

/** The one tool whose card this module owns (`subagent_result` cards stay the
 *  generic tool row). */
const SPAWN_TOOL_NAME = "spawn_subagent";

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
 * still draws its title + green `✓ Done`.
 */
export function isLiveSubagent(info: SubagentInfo): boolean {
  return info.state === "starting" || info.state === "running";
}

/**
 * Live **background** worker count for one session (docs/CONTEXT.md
 * background-residual hint): live per isLiveSubagent AND `foreground !== true` AND
 * `conversationId === activeConversationId`. A foreground (`wait:true`)
 * worker is already truthfully represented by the parent's running-fg
 * chrome, so counting it here would paint the worker as parent 「运行中」 ("running");
 * terminal states never count so the tail line disappears with the last
 * live worker (including never-spawned sessions). The bridge list is the
 * global projection — rows owned by another session tab, and rows without a
 * conversationId (judge / graph-node / direct-manager population, which the
 * manager's own scoped listSubagents likewise attributes to no session),
 * never count here.
 */
export function countLiveBackgroundSubagents(
  infos: ReadonlyArray<SubagentInfo>,
  activeConversationId: string | undefined
): number {
  if (activeConversationId === undefined) return 0;
  let count = 0;
  for (const info of infos) {
    if (
      isLiveSubagent(info) &&
      info.foreground !== true &&
      info.conversationId === activeConversationId
    )
      count += 1;
  }
  return count;
}

/**
 * Dim English count line text for the transcript tail; 0 / absent → undefined
 * (no line). English on purpose: the Chinese 「运行中」 ("running") belongs to
 * parent chrome alone (CONTEXT background-residual hint _Avoid_). Takes
 * undefined so the tail
 * can pass the optional prop through without an extra branch. The only
 * producer is countLiveBackgroundSubagents (non-negative by construction), so
 * no negative-input branch.
 */
export function formatBackgroundRunningHint(
  count: number | undefined
): string | undefined {
  if (count === undefined || count === 0) return undefined;
  return count === 1
    ? "1 background subagent running"
    : `${count} background subagents running`;
}

/**
 * Role projection for one subagent — the card's line-1 fallback when its spawn
 * carried no `title`, and the panel's identity text:
 *   - role present and non-blank (after trim) → role.trim();
 *   - role absent / empty / whitespace-only → IDENTITY_FALLBACK_ROLE; the
 *     Chinese "subagent" literal is never emitted.
 */
export function resolveIdentityRole(info: SubagentInfo): string {
  const role = info.role;
  if (role === undefined) return IDENTITY_FALLBACK_ROLE;
  const trimmed = role.trim();
  return trimmed.length > 0 ? trimmed : IDENTITY_FALLBACK_ROLE;
}

/** Card-level projection (the single shape both hosts render). Two lines, in
 *  every state. */
export interface SubagentCardLines {
  /** Line 1: the `title` the parent filed, or the catalog role when that spawn
   *  carried none. Identical while live and once completed; no progress
   *  suffix. */
  readonly titleLine: string;
  /** Line 2: the activity slot. Live → `tool name · argument summary` of the
   *  tool that worker issued most recently (an unregistered name degrades to
   *  the bare name, never raw input JSON; empty string = placeholder row when
   *  that worker has no call read yet / none issued); completed → the literal
   *  `✓ Done`, which the host draws in tuiPalette.add. Truncated to cols except
   *  for that fixed literal. */
  readonly detailLine: string;
  /** Completion flag: the host colours line 2 with tuiPalette.add when true
   *  and with tuiPalette.dim while live. */
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

/**
 * Activity-slot text for one live card: the shared tool-status-line assembly
 * (`formatToolStatusLine`) on the retained call, so the slot and the
 * transcript's own tool lines are one wording SSOT and this module invents no
 * template of its own.
 *
 * `status: "ok"` selects the neutral name-and-summary branch ONLY — the
 * projected value carries no settlement field, so the slot cannot tell a call
 * still in flight from one whose `tool_result` landed and asserts neither
 * success nor progress. Past-tense summaries ("Wrote", "Edited") therefore name
 * the *requested* operation; success belongs to `✓ Done`, failure to that card's
 * overlay.
 *
 * A name with no `TOOL_SUMMARIES` entry keeps the bare tool name on purpose:
 * the shared formatter answers an unknown tool with the `(name)` placeholder,
 * and joining that would print `Bash · (Bash)`. `Object.hasOwn` rather than a
 * truthiness probe because a tool name is model-supplied — an inherited key
 * (`toString`, `__proto__`) would otherwise reach the formatter as a bogus
 * declaration. Input JSON never reaches the card either way.
 *
 * The two subagent tools are registered, so they inherit the formatter's own
 * detail-only shape here (`explore` / `Poll abc`) — glyph and identity live on
 * line 1 and in SubagentPanel — not a `name · detail` restatement. Nothing is
 * special-cased for them.
 */
function activitySlotText(activity: SubagentActivity, budget: number): string {
  if (!Object.hasOwn(TOOL_SUMMARIES, activity.toolName)) {
    return clipOneLineVisual(activity.toolName, budget);
  }
  // The formatter already fits its own detail to `cols`; the outer clamp is the
  // card's invariant (line 2 is one row at the card width whatever the joined
  // text costs), kept from the name-only slot.
  return clipOneLineVisual(
    formatToolStatusLine({
      toolName: activity.toolName,
      input: activity.toolInput,
      status: "ok",
      cols: budget,
    }),
    budget
  );
}

/** Single-card assembly (live / completed). The caller guarantees state !== "failed". */
function buildCard(info: SubagentInfo, budget: number): SubagentCardLines {
  // A spawn that carried no title (a direct manager spawn, or one recorded
  // before `title` existed) stands in with that worker's own catalog role —
  // never another worker's title.
  const titleLine = clipOneLineVisual(
    info.title ?? resolveIdentityRole(info),
    budget
  );
  if (info.state === "completed") {
    // The slot becomes the literal `✓ Done` and the retained activity is
    // dropped; no width clamp on that literal (host wrapMode="none" edge-cuts
    // it).
    return { titleLine, detailLine: DONE_MARKER, done: true };
  }
  // `activity` absent = no reader injected / first read still pending, and
  // `null` = live with no call issued yet: both draw the empty placeholder, so
  // the card keeps its two rows either way.
  return {
    titleLine,
    detailLine: info.activity ? activitySlotText(info.activity, budget) : "",
    done: false,
  };
}

/**
 * The history host's card for a settled `spawn_subagent` block that no live
 * worker describes — a session reopened without the previous process's list.
 * Line 1 comes from the durable source, the tool input the parent itself wrote
 * into the transcript; a spawn that carried no title falls back to the same
 * catalog rule as everywhere else.
 *
 * Line 2 stays the empty placeholder rather than `✓ Done`: with no worker to
 * ask, the card cannot tell a handoff that finished from an ack that merely
 * dispatched, and a completion mark it cannot support is worse than a blank
 * slot. Not a spawn block, or one still waiting on its result (the live host
 * owns that) → `null`.
 */
export function settledSpawnCardFromBlock(args: {
  readonly name: string;
  readonly input: unknown;
  readonly settled: boolean;
  readonly cols: number;
}): SubagentCardLines | null {
  if (args.name !== SPAWN_TOOL_NAME || !args.settled) return null;
  const rec =
    typeof args.input === "object" && args.input !== null
      ? (args.input as Record<string, unknown>)
      : {};
  const title = typeof rec.title === "string" ? rec.title.trim() : "";
  return {
    titleLine: clipOneLineVisual(
      title.length > 0 ? title : resolveSubagentRoleFromInput(rec),
      Math.max(1, args.cols)
    ),
    detailLine: "",
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
 *     never borrow another worker's title or tool name;
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
  if (key === null) return null; // EXIT: no correlator — never borrow another worker's card
  return subagentCardLinesMap(subagents, cols).get(key) ?? null;
}

/**
 * Content signature of the projection input (for useMemo deps). The app
 * layer polls at 1Hz and calls setSubagents with a fresh array each time —
 * depending on the array reference would make subagentCardLinesMap build a
 * new Map every second, and the memoized history message blocks
 * (MessageBlocks) below would rebuild their whole element tree likewise
 * (same class of regression as history-rerender-cost). The signature fields
 * are exactly everything the projection reads (`toolUseId` / `state` / `role`
 * / `title` / `activity`); omitting one would let the cache serve stale
 * cards — `activity` is the field the 1Hz poll
 * actually moves, so leaving it out would freeze line 2 (whose summary now
 * comes from the recorded input, hence the whole call, not just its name).
 * `taskPreview` is deliberately absent: the card stopped drawing it, and the
 * panel reads it straight off the list.
 *
 * Encoding is JSON.stringify over nested arrays: any character inside a
 * field (quotes / commas / control chars) is escaped, and the tuple→signature
 * map is injective. Hand-joined delimiters cannot achieve that — role (the
 * `subagent_type` input) and the activity tool name are arbitrary strings that
 * could collide into the same signature across a delimiter and serve stale
 * cards. Because the whole activity object is serialized, the signature tracks
 * the complete projected call (name and input together), so a call whose input
 * changed cannot be masked by a matching name. JSON also keeps literal control
 * bytes out of the source (a literal NUL would make git treat this file as
 * binary and blind both diff and rg).
 */
export function subagentCardsKey(
  subagents: ReadonlyArray<SubagentInfo>
): string {
  return JSON.stringify(
    subagents.map((info) => [
      info.toolUseId ?? "",
      info.state,
      info.role ?? "",
      info.title ?? null,
      // Absent and `null` both draw the placeholder and are both "nothing to
      // show yet", so the old absent-vs-"" split (which meant "no reader wired"
      // vs "read completed with nothing waiting") carries no rendering
      // difference any more and is collapsed. What must repaint is the arrival
      // of a real activity object, which serializes distinctly from either.
      info.activity ?? null,
    ])
  );
}

/**
 * Per-card map (key = `toolUseId`): the history-card host reads it once and
 * looks each card up by its own id — avoiding one linear scan per card.
 *
 * Line 1 comes from the joined worker's own spawn record
 * (`SubagentInfo.title`); a worker that never carried one falls back to its
 * catalog role.
 *
 * Skip rules share the source with the single-card projection: entries with
 * absent / empty `toolUseId` are skipped entirely (never enter the map, never
 * occupy a key), `failed` entries are skipped, duplicate keys keep the first
 * entry in list order (deterministic — later entries never overwrite). Both
 * live and completed enter the map (a completed card still draws its title +
 * green `✓ Done`).
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
