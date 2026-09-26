/**
 * Pre-model skill index delta (`specs/skill-index-increment.md` / ADR-0098):
 * before each model call, rescan the live skill roots →
 * `modelIndex − ledger` → render only the NEW rows as `<available_skills>`
 * text appended as a hidden user message at the tail of messages. Rendering
 * reuses `skillsSegment` (identity/assemble.ts) — no second implementation.
 *
 * ## What this module owns
 *
 * One `computeSkillIndexDelta()` = one complete "what to paste this round"
 * decision:
 *   1. `rescanner.rescan()` for the live `SkillCatalogFaces` (failure →
 *      typed `SkillRescanError` propagates; a partial delta is NEVER pasted);
 *   2. from `catalog.modelIndex()` (has description, not disabled), pick
 *      names where `ledger.has(name) === false` — already-entered names are
 *      never re-pasted (the check reads the persisted ledger only, not
 *      messages, so compaction eating a delta still won't re-paste it);
 *   3. persist FIRST: `ledger.addMany(names)`; failure →
 *      `SkillIndexLedgerError` propagates and the caller never receives the
 *      text, so messages can gain an "un-entered" listing (the module's key
 *      ordering contract);
 *   4. only after persistence succeeds, render `skillsSegment(added.map(...))`
 *      with FULL descriptions (ADR-0098's 10% index downgrade applies only
 *      to the opening frozen table, not this path).
 *
 * `added` is the persisted receipt's name set (ascending); `text` is a copy
 * of the rendered delta; empty `added` → empty `text`, caller appends nothing.
 *
 * ## What this module does NOT own
 *
 * Message injection (loop-engine's `createPendingInjected` seam), the system
 * prompt (frozen table bytes come from assembly-time `skillIndexList`), and
 * TUI/Web projection (hiding is `isSkillIndexDeltaText` /
 * `isTuiHiddenUserMessage`).
 *
 * ## The hidden-message predicate
 *
 * `isSkillIndexDeltaText` mirrors the four existing sibling predicates
 * (`isAgentStatusText` / `isGraphModeText` / `isSubagentDrainText` /
 * `isVerifyInjectedText`): constant prefix, exported from the producer
 * module; consumers (TUI `isTuiHiddenUserMessage` / Web `isTurnQuery`) call
 * the predicate instead of checking prefixes themselves. The prefix is
 * `<available_skills>` — the delta shares the frozen table's exact shape (the
 * model reads new rows under the same heading), so no second interpretation
 * is needed model-side; human-side, the prefix marks "host-injected index
 * delta, not operator input."
 *
 * Why the prefix is precise enough: an operator typing a line that starts
 * with `<available_skills>` is a pathological case; the sibling XML headings
 * (`<agent_status>` / `<graph_mode>`) use the same "trimStart + line-head
 * match = injected" discipline with no exception for human text.
 */
import { skillsSegment, type SkillSummary } from "../identity/assemble.js";
import type { SkillCatalogFaces } from "./catalog.js";
import {
  createSkillIndexLedger,
  type SkillIndexLedger,
} from "./index-ledger.js";
import type { SkillRescanner } from "./rescan.js";

/**
 * Leading constant of the delta segment — the same literal as `skillsSegment`'s
 * heading. The SSOT is `skillsSegment`; this constant is only the predicate's
 * read anchor, and the two cannot drift (the text the predicate matches IS
 * what skillsSegment produces).
 */
export const SKILL_INDEX_DELTA_PREFIX = "<available_skills>";

/**
 * Is this user-message text a skill index delta (host-injected, not typed by
 * the operator)? Same rule as `isAgentStatusText`: trimStart + line-head
 * prefix match. Mentions of `<available_skills>` mid-text don't trip it.
 */
export function isSkillIndexDeltaText(text: string): boolean {
  return text.trimStart().startsWith(SKILL_INDEX_DELTA_PREFIX);
}

export interface SkillIndexDelta {
  /** Names newly entered this round (ledger receipt, ascending); empty = nothing new. */
  readonly added: readonly string[];
  /**
   * Rendered delta text (output of `skillsSegment`; empty string when `added`
   * is empty). The caller encodeUserText's it and appends to the tail of messages.
   */
  readonly text: string;
}

export interface ComputeSkillIndexDeltaOptions {
  /** The rescan seam over live skill roots. Throws `SkillRescanError` on failure. */
  readonly rescanner: SkillRescanner;
  /** The per-conversation index ledger. Throws `SkillIndexLedgerError` on failure. */
  readonly ledger: SkillIndexLedger;
  /**
   * Called once after a successful rescan and before any decision, handing
   * over the model-index face seen at this beat. The assembly layer uses it
   * to refresh the worker-snapshot sync mirror (name → description) —
   * otherwise spawns would only see bare names and degrade the worker's
   * `<available_skills>` rendering.
   *
   * Independent of the decision/persist outcome (called even for empty
   * deltas): the mirror records "what the current face looks like".
   */
  readonly onModelIndex?: (
    entries: ReadonlyArray<{
      readonly name: string;
      readonly description?: string;
    }>
  ) => void;
}

/**
 * One complete delta decision + persist (four steps in the header). Never
 * degrades silently: rescan and persist failures propagate as typed errors,
 * so the caller can skip touching the frozen table or pasting a partial delta.
 */
export async function computeSkillIndexDelta(
  options: ComputeSkillIndexDeltaOptions
): Promise<SkillIndexDelta> {
  const catalog: SkillCatalogFaces = await options.rescanner.rescan();
  // Model index face (has description, not disabled, ascending by name — catalog SSOT).
  const entries = catalog.modelIndex();
  // Hand this beat's face to the assembly layer (worker snapshot mirror)
  // BEFORE the diff — called even for empty deltas; the mirror records the
  // current face, not this round's additions.
  options.onModelIndex?.(
    entries.map((entry) =>
      entry.description === undefined
        ? { name: entry.name }
        : { name: entry.name, description: entry.description }
    )
  );
  // Entry history reads only the ledger, never messages — compaction can't
  // cause a re-paste.
  const fresh = entries.filter((entry) => !options.ledger.has(entry.name));
  if (fresh.length === 0) return { added: [], text: "" };

  // Persist first, render second: a persist failure throws before the caller
  // can obtain any text, so messages never gain an un-persisted listing.
  const receipt = await options.ledger.addMany(fresh.map((e) => e.name));
  if (receipt.added.length === 0) return { added: [], text: "" };

  // receipt.added is already ascending names; re-look-up entries by name (in
  // concurrent windows catalog and ledger are separate beats — align by name,
  // not array index).
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  const summaries: SkillSummary[] = receipt.added.map((name) => {
    const entry = byName.get(name);
    // Full description — the opening 10% downgrade is not on the delta path.
    return entry === undefined
      ? { name }
      : {
          name,
          description: entry.description ?? "",
          ...(entry.whenToUse !== undefined
            ? { whenToUse: entry.whenToUse }
            : {}),
        };
  });
  return {
    added: receipt.added,
    text: skillsSegment(summaries),
  };
}

/**
 * Assembly-time seam factory: merges the one-time rescan roots and the
 * per-conversation entry history into one closure, producing exactly the
 * shape of `LoopEngineDeps.skillIndexDelta` (loop-engine types this
 * structurally and does not import this module).
 *
 * Why merge at the assembly layer instead of letting loop-engine hold two
 * objects: loop-engine only needs "get one delta, paste if non-empty" and
 * shouldn't know about rescan/ledger/rendering — the same "host injects a
 * pure closure" discipline as `boundaryAttachment` / `agentStatus`.
 *
 * ## Why `conversationId` is a CALL argument, not an assembly argument
 *
 * Copying `agentStatus`'s shape (assembly-time constants + loop-engine passes
 * `deps.conversationId` at call time): assembly time — especially serve —
 * cannot know the conversationId; one build-engine instance spans sessions,
 * and per-session leaves are decided at call time. With the session anchor as
 * a call argument, `serve` doesn't rebuild the engine per session.
 *
 * Entry history is lazily created and memoized per conversationId (same
 * `<projectDir>/<sanitize(convId)>/` leaf shape as `todoDir`): repeated
 * `delta()` calls in one session reuse the same ledger (its in-memory set +
 * serial queue); another session gets another instance. First construction
 * reads from disk, so harness session recovery loads the persisted history
 * → no re-pasting.
 *
 * `conversationId === undefined` (ask / worker / unanchored assembly) →
 * empty delta: no session anchor means no persistable history, and pasting
 * would re-paste every round — fail-closed, don't paste.
 */
export interface CreateSkillIndexDeltaSeamOptions {
  /** The rescan seam (assembled once, shared across sessions). */
  readonly rescanner: SkillRescanner;
  /** Session-folder root (`SessionStore.getProjectDir()` / `BuildEngineOpts.todoDir`). */
  readonly projectDir: string;
  /**
   * This session's opening model-index names (frozen-table projection) — the
   * ledger's `initialNames`: names already in the frozen table are not
   * re-pasted as new.
   */
  readonly initialNames: readonly string[];
  /**
   * The entry face of the same frozen table (name + description) — used only
   * to prefill descriptions in the worker snapshot's sync mirror: a spawn can
   * happen before the first turn (before any `delta()` ran, when the mirror
   * would otherwise hold only the frozen half). Absent → frozen names enter
   * snapshots as bare names.
   */
  readonly initialEntries?: readonly SkillIndexSnapshotEntryShape[];
  /**
   * Write gate (ledger's `isIndexedName`): accept only names on the current
   * model-index face. Default = accept all (`computeSkillIndexDelta` already
   * feeds it only `modelIndex()` output, so the default is safe; hosts may
   * narrow further).
   */
  readonly isIndexedName?: (name: string) => boolean;
}

/**
 * The seam shape (structurally identical to `LoopEngineDeps.skillIndexDelta`).
 * loop-engine declares its own same-shape interface — alignment is
 * structural, with no import coupling.
 */
export interface SkillIndexDeltaSeam {
  delta(conversationId: string | undefined): Promise<SkillIndexDelta>;
  /**
   * This session's already-entered entries (in-process sync mirror, synchronous).
   *
   * For the worker-spawn snapshot getter: `manager.opts.skillIndexSnapshot` is
   * synchronous while ledger construction is async disk IO, so this mirror is
   * kept, refreshed on ledger load and after every `delta()` persist. The
   * persisted history remains authoritative: refreshes read from
   * `ledger.snapshot()` and never self-account.
   *
   * Descriptions come from the most recent rescan's model-index face (skills
   * created mid-session only have descriptions after a rescan); a name absent
   * from the current face (e.g. roots were swapped and old names vanished)
   * degrades to a bare-name entry — the known "index visible, body
   * unavailable" degradation, the same trade-off as passing entries rather
   * than a name list.
   *
   * Three states (aligned verbatim with the envelope's `skillIndexSnapshot`
   * key semantics):
   *   - session LOADED → entry array (possibly empty: empty frozen table and
   *     no entries is a definite fact "the parent has no model index");
   *   - session NOT yet loaded (no `delta()` ran in-process) → `undefined` —
   *     "unknown" is not "none"; callers OMIT the envelope key so the worker
   *     falls back to its own rescan instead of being lied to by an empty array;
   *   - `conversationId === undefined` (ask / worker / unanchored) → likewise
   *     `undefined` (no anchor = no history to speak of).
   */
  enteredEntries(
    conversationId: string | undefined
  ): readonly SkillIndexSnapshotEntryShape[] | undefined;
}

/** Snapshot entry shape — structurally aligned with
 *  `subagent/envelope.ts`'s `SkillIndexSnapshotEntry`; this module does not
 *  import the subagent layer's types. */
export interface SkillIndexSnapshotEntryShape {
  readonly name: string;
  readonly description?: string;
}

export function createSkillIndexDeltaSeam(
  options: CreateSkillIndexDeltaSeamOptions
): SkillIndexDeltaSeam {
  // Lazy + memoized: one conversationId reuses one ledger (the in-memory set
  // + serial queue are session state); failures are NOT cached — the next
  // call retries rather than pinning a transient IO fault into permanent
  // degradation.
  const ledgers = new Map<string, Promise<SkillIndexLedger>>();
  // Sync mirror of entry history (the spawn getter is sync while ledger
  // construction is async disk IO). Names refresh from `ledger.snapshot()`
  // (persisted history is authoritative); descriptions from the last rescan's
  // face. Sessions never loaded are absent.
  const enteredMirror = new Map<string, readonly string[]>();
  // Fully replaced on each rescan (the current face is authoritative): stale
  // descriptions don't linger — names that vanish after a root swap degrade
  // to bare entries rather than keeping expired text. Initial value = the
  // frozen-table entries face (so a spawn before the first turn reads
  // descriptions from here, not an empty map).
  let faceMirror: ReadonlyMap<string, string> = new Map(
    (options.initialEntries ?? [])
      .filter((entry) => entry.description !== undefined)
      .map((entry) => [entry.name, entry.description as string])
  );
  const refreshEntryMirror = (
    conversationId: string,
    ledger: SkillIndexLedger
  ): void => {
    enteredMirror.set(conversationId, ledger.snapshot());
  };
  const ledgerFor = (conversationId: string): Promise<SkillIndexLedger> => {
    const cached = ledgers.get(conversationId);
    if (cached !== undefined) return cached;
    const created = createSkillIndexLedger({
      projectDir: options.projectDir,
      conversationId,
      initialNames: options.initialNames,
      isIndexedName: options.isIndexedName ?? (() => true),
    })
      .then((ledger) => {
        // Refresh the mirror as soon as the disk load finishes (resume case:
        // a spawn before the first turn still sees persisted history, not []).
        refreshEntryMirror(conversationId, ledger);
        return ledger;
      })
      .catch((err: unknown) => {
        ledgers.delete(conversationId);
        throw err;
      });
    ledgers.set(conversationId, created);
    return created;
  };

  return Object.freeze({
    async delta(conversationId: string | undefined): Promise<SkillIndexDelta> {
      // EXIT: no session anchor → no persistable history → don't paste
      // (pasting would repeat every round).
      if (conversationId === undefined) return { added: [], text: "" };
      const ledger = await ledgerFor(conversationId);
      const result = await computeSkillIndexDelta({
        rescanner: options.rescanner,
        ledger,
        onModelIndex: (entries) => {
          const next = new Map<string, string>();
          for (const entry of entries) {
            if (entry.description !== undefined) {
              next.set(entry.name, entry.description);
            }
          }
          faceMirror = next;
        },
      });
      // Refresh the mirror after a successful persist (addMany persists before
      // returning, so by here the history is durable).
      refreshEntryMirror(conversationId, ledger);
      return result;
    },
    enteredEntries(
      conversationId: string | undefined
    ): readonly SkillIndexSnapshotEntryShape[] | undefined {
      // EXIT: no anchor / session never loaded → undefined ("unknown" is not
      // "none"; callers omit the key and the worker takes its own fallback).
      if (conversationId === undefined) return undefined;
      const names = enteredMirror.get(conversationId);
      if (names === undefined) return undefined;
      return names.map((name) => {
        const description = faceMirror.get(name);
        return description === undefined ? { name } : { name, description };
      });
    },
  });
}
