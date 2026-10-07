/**
 * The per-stimulus acceptance ledger (#1219).
 *
 * WHY this is the heart of the fix: the historical driver had ONE pending slot
 * (`pending_verify = send(...)`), so a failed verification was overwritten the
 * moment the next stimulus went due, and its report counted `stimuli_sent`
 * (attempts) instead of outcomes — so a run where two of four stimuli were
 * REFUSED read exactly like a clean 4/4. Every stimulus therefore owns one
 * record, and `due / sent / accepted / settled` are four separate fields, never
 * collapsed into one "submitted" boolean.
 *
 * The acceptance signature, implemented here exactly:
 *   `type === "message"` AND `message.role === "user"` AND `hostInjected`
 *   absent AND `id` not in the baseline set AND the concatenated text equals the
 *   submitted text — correlated with a `native_state boundary:"input"` anchored
 *   at that event in the same conversation. Settlement is a
 *   `boundary:"terminal"` anchored at the round's reply; `boundary:"tool_batch"`
 *   is internal per-LLM-turn activity and is never a settle.
 */
import {
  isInputBoundary,
  isRealUserMessage,
  messageText,
  takeBaseline,
  type Baseline,
  type PollResult,
  type SessionEventRecord,
  type SessionNativeStateRecord,
  type StoreRecord,
} from "./session-store-reader.js";
import type { Stimulus } from "./protocol.js";

/** What the observer concluded about one stimulus. */
export type Verdict =
  "pending" | "accepted" | "refused" | "timeout" | "observer-error";

/** What the persisted lifecycle currently says about the host. */
export type LifecycleState = "unproven" | "running" | "idle";

/** One stimulus' complete record. Times are run-relative milliseconds. */
export interface AcceptanceRecord {
  readonly tag: string;
  readonly text: string;
  readonly due_at_ms: number | null;
  readonly sent_at_ms: number | null;
  readonly accepted_at_ms: number | null;
  readonly accepted_created_at: string | null;
  readonly accepted_event_id: string | null;
  readonly input_anchor: string | null;
  readonly settled_at_ms: number | null;
  readonly settled_anchor: string | null;
  readonly outcome_turn_id: string | null;
  readonly verdict: Verdict;
  readonly detail: string;
}

/** The mutable shape a verdict patch applies to. */
type MutableRecord = {
  -readonly [K in keyof AcceptanceRecord]: AcceptanceRecord[K];
};

/** A fresh, unsent record for a stimulus. */
export function pendingRecord(stimulus: Stimulus): MutableRecord {
  return {
    tag: stimulus.tag,
    text: stimulus.text,
    due_at_ms: stimulus.at,
    sent_at_ms: null,
    accepted_at_ms: null,
    accepted_created_at: null,
    accepted_event_id: null,
    input_anchor: null,
    settled_at_ms: null,
    settled_anchor: null,
    outcome_turn_id: null,
    verdict: "pending",
    detail: "not submitted",
  };
}

/** The result of classifying one record against one polled snapshot. */
export interface AcceptanceVerdict {
  readonly verdict: Verdict;
  readonly accepted_event_id: string | null;
  readonly input_anchor: string | null;
  readonly settled_at_ms: number | null;
  readonly settled_anchor: string | null;
  readonly accepted_at_ms: number | null;
  readonly accepted_created_at: string | null;
  readonly outcome_turn_id: string | null;
  readonly detail: string;
}

function isHostEcho(
  poll: PollResult,
  text: string,
  seen: ReadonlySet<string>
): boolean {
  return poll.messages.some(
    (m) =>
      m.message.role === "user" &&
      (m.message as { hostInjected?: unknown }).hostInjected !== undefined &&
      messageText(m) === text &&
      !seen.has(m.id)
  );
}

/** Find the persisted user message that matches the submitted text exactly. */
function matchAccepted(
  poll: PollResult,
  text: string,
  seen: ReadonlySet<string>
): SessionEventRecord | null {
  for (const message of poll.messages) {
    if (!isRealUserMessage(message, seen)) continue;
    if (messageText(message) === text) return message;
  }
  return null;
}

/** True when `anchor` is the accepted message or a reply descending from it. */
function descendsFrom(
  anchor: string,
  acceptedId: string,
  byId: ReadonlyMap<string, string | null>
): boolean {
  let cursor: string | null = anchor;
  for (let hops = 0; hops < 64 && cursor !== null; hops++) {
    if (cursor === acceptedId) return true;
    cursor = byId.get(cursor) ?? null;
  }
  return false;
}

/**
 * Pure classification: what does this snapshot prove about this record?
 *
 * `pending` is a real answer (nothing persisted yet), never a soft pass: the run
 * stays open and the stimulus keeps its own slot until a real verdict lands.
 */
export function classifyAcceptance(
  record: AcceptanceRecord,
  poll: PollResult,
  nowMs: number,
  opts: { readonly baselineEventIds?: readonly string[] } = {}
): AcceptanceVerdict {
  const seen = new Set(opts.baselineEventIds ?? []);
  if (isFinal(record)) return finalVerdict(record, poll, nowMs);
  if (poll.error !== null) {
    return {
      ...carryForward(record),
      verdict: "observer-error",
      detail: `observer error: ${poll.error.message}`,
    };
  }
  const matched = matchAccepted(poll, record.text, seen);
  const settled = settledState(record, poll, nowMs, matched);
  if (matched === null) return unmatchedVerdict(record, poll, settled, seen);
  if (!poll.inputAnchors.includes(matched.id))
    return awaitingAnchor(record, matched.id, settled);
  return acceptedVerdict({ record, poll, matched, settled, nowMs });
}

/** Verdicts that will not change on further polls. */
function isFinal(record: AcceptanceRecord): boolean {
  return (
    record.verdict === "accepted" ||
    record.verdict === "refused" ||
    record.verdict === "timeout"
  );
}

/** The record's own state, carried forward unchanged. */
function carryForward(record: AcceptanceRecord): AcceptanceVerdict {
  return {
    verdict: "pending",
    accepted_event_id: record.accepted_event_id,
    input_anchor: record.input_anchor,
    settled_at_ms: record.settled_at_ms,
    settled_anchor: record.settled_anchor,
    accepted_at_ms: record.accepted_at_ms,
    accepted_created_at: record.accepted_created_at,
    outcome_turn_id: record.outcome_turn_id,
    detail: record.detail,
  };
}

/** An accepted record still folds in a terminal boundary from a later poll. */
function finalVerdict(
  record: AcceptanceRecord,
  poll: PollResult,
  nowMs: number
): AcceptanceVerdict {
  const base = carryForward(record);
  if (record.verdict !== "accepted")
    return { ...base, verdict: record.verdict };
  return {
    ...base,
    ...settledState(record, poll, nowMs, null),
    verdict: "accepted",
  };
}

function unmatchedVerdict(
  record: AcceptanceRecord,
  poll: PollResult,
  settled: Pick<
    AcceptanceVerdict,
    "settled_at_ms" | "settled_anchor" | "outcome_turn_id"
  >,
  seen: ReadonlySet<string>
): AcceptanceVerdict {
  const detail = isHostEcho(poll, record.text, seen)
    ? "host_injected echo matched the text; that is plumbing, not acceptance"
    : "no persisted user-message event matched the submitted text";
  return { ...carryForward(record), ...settled, detail };
}

function awaitingAnchor(
  record: AcceptanceRecord,
  eventId: string,
  settled: Pick<
    AcceptanceVerdict,
    "settled_at_ms" | "settled_anchor" | "outcome_turn_id"
  >
): AcceptanceVerdict {
  return {
    ...carryForward(record),
    accepted_event_id: eventId,
    ...settled,
    detail:
      "user-message event persisted; awaiting input_boundary (native_state boundary:input) at that event",
  };
}

function acceptedVerdict(args: {
  readonly record: AcceptanceRecord;
  readonly poll: PollResult;
  readonly matched: SessionEventRecord;
  readonly settled: Pick<
    AcceptanceVerdict,
    "settled_at_ms" | "settled_anchor" | "outcome_turn_id"
  >;
  readonly nowMs: number;
}): AcceptanceVerdict {
  const { record, poll, matched, settled, nowMs } = args;
  const anchor = poll.records.find(
    (r): r is SessionNativeStateRecord =>
      isInputBoundary(r) && r.anchorEventId === matched.id
  );
  return {
    verdict: "accepted",
    accepted_event_id: matched.id,
    input_anchor: anchor?.anchorEventId ?? matched.id,
    settled_at_ms: settled.settled_at_ms,
    settled_anchor: settled.settled_anchor,
    accepted_at_ms: record.accepted_at_ms ?? nowMs,
    accepted_created_at:
      typeof matched.createdAt === "string" ? matched.createdAt : null,
    outcome_turn_id: settled.outcome_turn_id,
    detail:
      "accepted: persisted user-message event with a boundary:input publication",
  };
}

/** The settlement fold, with every field resolved (null when absent). */
function settledState(
  record: AcceptanceRecord,
  poll: PollResult,
  nowMs: number,
  matched: SessionEventRecord | null
): Pick<
  AcceptanceVerdict,
  "settled_at_ms" | "settled_anchor" | "outcome_turn_id"
> {
  const none = {
    settled_at_ms: record.settled_at_ms,
    settled_anchor: record.settled_anchor,
    outcome_turn_id: record.outcome_turn_id,
  };
  const anchor = record.accepted_event_id ?? matched?.id ?? null;
  if (anchor === null) return none;
  const byId = new Map<string, string | null>(
    poll.messages
      .filter((m) => m.type === "message")
      .map((m) => [m.id, m.parent])
  );
  for (const candidate of poll.terminalAnchors) {
    if (!descendsFrom(candidate, anchor, byId)) continue;
    const outcome = poll.outcomes.find((o) => o.turnId === candidate);
    return {
      settled_at_ms: record.settled_at_ms ?? nowMs,
      settled_anchor: candidate,
      outcome_turn_id: outcome?.turnId ?? null,
    };
  }
  return none;
}

/**
 * The lifecycle boundary one persisted record published, in the store's order.
 *
 * WHY the ORDER and not a priority: the three anchor lists on a poll carry no
 * sequence, so ranking them (`terminal` outranks `input`) invents an order the
 * store never wrote. One poll routinely holds round N's `terminal` AND round
 * N+1's `input`; ranking those reports idle while N+1 is still in flight, which
 * submits the next stimulus into a busy composer and lets `quitableAt` decide
 * `/quit` mid-round. The last record the store appended is the only "last word"
 * it actually produced.
 *
 * `compaction` (and any boundary added later) is not one of the three signals
 * this ledger models, so it neither advances nor rewinds the lifecycle — the
 * fix is about order alone.
 */
function boundaryOf(
  record: StoreRecord
): "input" | "terminal" | "tool_batch" | null {
  if (record.type !== "native_state") return null;
  const { boundary } = record;
  if (
    boundary === "input" ||
    boundary === "terminal" ||
    boundary === "tool_batch"
  )
    return boundary;
  return null;
}

/**
 * Per-stimulus ledger. One record per stimulus, never overwritten; the busy /
 * idle signals come from the persisted lifecycle rather than from terminal
 * silence (the TUI redraws ~26 KB per 30 s, so silence never occurs — run3's
 * frozen stop rule could therefore never fire).
 */
export class AcceptanceLedger {
  readonly baseline: Baseline;
  private readonly order: Stimulus[];
  private readonly recordsByTag = new Map<string, MutableRecord>();
  private lastBoundary: "input" | "terminal" | "tool_batch" | null = null;
  private observerErrorDetail: string | null = null;

  constructor(opts: {
    readonly baseline?: Baseline;
    readonly stimuli: readonly Stimulus[];
  }) {
    this.baseline =
      opts.baseline ??
      takeBaseline({ dataDir: "", cwd: "", conversationId: "" });
    this.order = [...opts.stimuli];
    for (const stimulus of this.order)
      this.recordsByTag.set(stimulus.tag, pendingRecord(stimulus));
  }

  /** Tags in due order. */
  get tags(): readonly string[] {
    return this.order.map((s) => s.tag);
  }

  record(tag: string): AcceptanceRecord | undefined {
    return this.recordsByTag.get(tag);
  }

  records(): AcceptanceRecord[] {
    return this.order.map((s) => this.recordsByTag.get(s.tag)!);
  }

  /** True once this stimulus was written to the composer. The FIRST call wins:
   *  a second Enter for an unproven stimulus is the #1219 defect. A REFUSED
   *  stimulus is never written at all: the refusal is final, so a later tick
   *  that offers it again must not type it into the composer. */
  markSent(tag: string, nowMs: number): boolean {
    if (this.observerErrorDetail !== null) return false;
    const record = this.recordsByTag.get(tag);
    if (record === undefined || record.sent_at_ms !== null) return false;
    if (record.verdict === "refused") return false;
    record.sent_at_ms = nowMs;
    record.verdict = "pending";
    record.detail = "submitted; awaiting persisted acceptance evidence";
    return true;
  }

  /**
   * Record an explicit refusal (the round stayed busy past the bounded wait).
   *
   * No `sent_at_ms` guard here: the only production caller refuses the stimulus
   * the scheduler could NOT submit, which by construction was never marked
   * sent. Guarding on a send made the `refused` verdict unreachable in
   * production, so a round that stayed busy was recorded as `pending` /
   * "not submitted" and the run had no way to close.
   */
  markRefused(tag: string, nowMs: number, detail: string): void {
    const record = this.recordsByTag.get(tag);
    if (record === undefined) return;
    record.verdict = "refused";
    record.detail = `${detail} at ${nowMs}ms`;
  }

  /** Record that acceptance evidence never arrived inside its budget. */
  markTimeout(tag: string, nowMs: number, detail: string): void {
    const record = this.recordsByTag.get(tag);
    if (record === undefined || record.sent_at_ms === null) return;
    if (record.verdict === "refused") return;
    record.verdict = "timeout";
    record.detail = `${detail} at ${nowMs}ms`;
  }

  /** An observer failure is its own verdict; it never becomes a timeout. */
  markObserverError(detail: string): void {
    this.observerErrorDetail = detail;
    for (const record of this.recordsByTag.values()) {
      if (record.verdict !== "accepted") {
        record.verdict = "observer-error";
        record.detail = `observer error: ${detail}`;
      }
    }
  }

  /** Fold one polled snapshot into every outstanding record. */
  observe(poll: PollResult, nowMs: number): void {
    if (poll.error !== null) {
      this.markObserverError(poll.error.message);
      return;
    }
    this.trackBoundary(poll);
    for (const record of this.recordsByTag.values()) {
      if (record.sent_at_ms === null) continue;
      const verdict = classifyAcceptance(record, poll, nowMs, {
        baselineEventIds: this.baseline.eventIds,
      });
      this.apply(record, verdict);
    }
  }

  private apply(record: MutableRecord, verdict: AcceptanceVerdict): void {
    record.accepted_event_id = verdict.accepted_event_id;
    record.input_anchor = verdict.input_anchor;
    record.accepted_at_ms = verdict.accepted_at_ms;
    record.accepted_created_at = verdict.accepted_created_at;
    record.settled_at_ms = verdict.settled_at_ms;
    record.settled_anchor = verdict.settled_anchor;
    record.outcome_turn_id = verdict.outcome_turn_id;
    record.verdict = verdict.verdict;
    record.detail = verdict.detail;
  }

  /** Fold a known acceptance in without a snapshot (already-verified evidence). */
  markAccepted(
    tag: string,
    evidence: {
      readonly eventId: string;
      readonly anchor: string;
      readonly atMs: number;
    }
  ): void {
    const record = this.recordsByTag.get(tag);
    if (record === undefined) return;
    record.verdict = "accepted";
    record.accepted_event_id = evidence.eventId;
    record.input_anchor = evidence.anchor;
    record.accepted_at_ms = evidence.atMs;
    record.accepted_created_at = null;
    record.detail = "accepted: folded from verified evidence";
  }

  /** Test/observer hook: settle an accepted stimulus. */
  markSettled(tag: string, anchor: string, nowMs: number): void {
    const record = this.recordsByTag.get(tag);
    if (record === undefined) return;
    record.settled_anchor = anchor;
    record.settled_at_ms = nowMs;
  }

  private trackBoundary(poll: PollResult): void {
    for (const record of poll.records) {
      const boundary = boundaryOf(record);
      if (boundary !== null) this.lastBoundary = boundary;
    }
  }

  /** The persisted lifecycle's last word on the host. */
  lifecycleState(): LifecycleState {
    if (this.observerErrorDetail !== null) return "unproven";
    if (this.lastBoundary === null) return "unproven";
    return this.lastBoundary === "terminal" ? "idle" : "running";
  }

  /** True while a round is in flight — the product's own refusal condition. */
  get busy(): boolean {
    return this.lifecycleState() === "running";
  }

  /** Idle may be CLAIMED only from a persisted terminal boundary. */
  get idleProven(): boolean {
    return this.lifecycleState() === "idle";
  }

  get hasObserverError(): boolean {
    return this.observerErrorDetail !== null;
  }

  observerError(): string | null {
    return this.observerErrorDetail;
  }

  isAccepted(tag: string): boolean {
    return this.recordsByTag.get(tag)?.verdict === "accepted";
  }

  isSettled(tag: string): boolean {
    const record = this.recordsByTag.get(tag);
    return record !== undefined && record.settled_at_ms !== null;
  }

  acceptedTags(): string[] {
    return this.records()
      .filter((r) => r.verdict === "accepted")
      .map((r) => r.tag);
  }

  settledTags(): string[] {
    return this.records()
      .filter((r) => r.settled_at_ms !== null && r.verdict === "accepted")
      .map((r) => r.tag);
  }

  /** Every stimulus sent — the precondition for "the sequence is over". */
  allSent(): boolean {
    return this.records().every((r) => r.sent_at_ms !== null);
  }

  /** Every stimulus accepted AND settled from persisted evidence. */
  allSettled(): boolean {
    return this.records().every(
      (r) => r.verdict === "accepted" && r.settled_at_ms !== null
    );
  }

  lastSettledAtMs(): number | null {
    const stamps = this.records()
      .map((r) => r.settled_at_ms)
      .filter((v): v is number => v !== null);
    return stamps.length === 0 ? null : Math.max(...stamps);
  }

  /**
   * Stimuli that were never submitted, in due order — INCLUDING refused ones,
   * which were indeed never written.
   *
   * NOT the "still deliverable" set a stop rule wants: a refusal is final, so
   * such a stimulus will never be typed again. Use `records()` and the verdict
   * (see the runner's `isDeliverable`) for that question.
   */
  unsent(): Stimulus[] {
    return this.order.filter(
      (s) => this.recordsByTag.get(s.tag)?.sent_at_ms === null
    );
  }
}

export { takeBaseline };
