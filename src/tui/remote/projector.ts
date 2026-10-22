/**
 * Seat projector (spec specs/remote-sync.md §4.4, §5.5-§5.7, ADR-0149 §4).
 *
 * Merges the three TUI surfaces that know about a live turn into one ordered,
 * sequenced event stream plus a reconnect snapshot:
 *  - the hub event bus (every turn's stream events, `user_message`,
 *    `turn_started`, `turn_ended`);
 *  - the TUI ask bridge (approvals, for every conversation — the modal shows
 *    them all);
 *  - the tool event sink (tool results, subject to the bridge's attribution
 *    rule).
 *
 * Load-bearing rules:
 *  - Only the active conversation's events are forwarded; a switch emits one
 *    `active_changed` and retires the outgoing conversation's held tool calls
 *    without touching its turn (never abort / stop anything here).
 *  - Streamed tool calls are held per `toolUseId` until their input is known
 *    (an approval for the call, a tool result, the next `agent_status`, or
 *    `turn_ended`), then emitted once, in order, before whatever released
 *    them.
 *  - Every emitted event goes through the ring, so `seq` is monotonic and a
 *    catch-up replay has no gap or duplicate. Emission is synchronous: the
 *    seat can replay and subscribe in one turn with no window between them.
 *  - Projector faults never reach a turn (spec §3 invariant 7): listener
 *    faults are swallowed and nothing here throws into a hub publish.
 */
import { createSeatEventRing } from "../../remote-api/ring.js";
import type {
  AnswerChoice,
  OpenToolCall,
  PendingApprovalView,
  SeatEvent,
  SeatEventBody,
  Snapshot,
  TranscriptTailEntry,
} from "../../remote-api/protocol.js";
import type {
  AskUserOutcome,
  ApprovalOutcome,
} from "../../harness/permission/types.js";
import type { HarnessStreamEvent } from "../../harness/stream.js";
import type { TurnOutcomeView } from "../../session-api/contract.js";
import type { HubEvent } from "../../session-api/hub.js";
import type {
  TuiAskSettledBy,
  TuiAskUserBridge,
  TuiPendingAsk,
} from "../ask-user.js";
import type { TuiToolEvent } from "../deps.js";
import type { TuiLoadedSessionFile } from "../session-state.js";

/** Cap on a projected `tool_call` input (spec §4.4). */
export const MAX_PROJECTED_INPUT_BYTES = 64 * 1024;

/** User / assistant text messages kept for `transcriptTail` (spec §5.5). */
export const TRANSCRIPT_TAIL_LIMIT = 20;

/** Settled ask ids remembered for duplicate suppression (FIFO bound). */
export const RESOLVED_ASKS_LIMIT = 256;

/** The TUI's active conversation, as the app reports it. */
export interface ProjectionActiveState {
  readonly conversationId: string | null;
  readonly running: boolean;
  readonly queued: number;
}

export interface SeatProjectorDeps {
  readonly instanceId: string;
  readonly hub: {
    subscribeEvents(listener: (event: HubEvent) => void): () => void;
  };
  readonly askBridge: Pick<
    TuiAskUserBridge,
    "subscribe" | "pendingAll" | "onSettled"
  >;
  readonly toolEventSink: {
    subscribe(listener: (event: TuiToolEvent) => void): () => void;
  };
  readonly loadTranscript: (
    conversationId: string
  ) => Promise<TuiLoadedSessionFile>;
  /** Seat notice sink; accepted for wiring. The projector has no notifiable
   *  fault in v1 — its faults are silent by contract (spec §3 invariant 7). */
  readonly onNotice?: (text: string) => void;
  /** Event clock; tests inject. Defaults to `Date#toISOString`. */
  readonly now?: () => string;
}

export interface SeatProjector {
  readonly instanceId: string;
  start(): void;
  stop(): void;
  setActive(state: ProjectionActiveState | undefined): void;
  subscribeLive(deliver: (event: SeatEvent) => void): () => void;
  replaySince(sinceSeq: number): readonly SeatEvent[];
  readonly oldestSeq: number | undefined;
  readonly latestSeq: number;
  /** Async on purpose: `transcriptTail` / `title` come from a session read. The
   *  `seq` boundary is taken synchronously, before any await. */
  snapshot(): Promise<Snapshot>;
}

/** A call seen as `tool_call_start` but not yet emitted. */
interface BufferedToolCall {
  readonly toolUseId: string;
  readonly conversationId: string;
  readonly turnId: string;
  name: string;
  /** Concatenated `tool_input_delta` JSON, capped at the input byte limit. */
  json: string;
  bytes: number;
  truncated: boolean;
}

/** Where a tool call's input comes from: the ask that released it, or the
 *  streamed deltas. */
type CallInputSource =
  | { readonly fromAsk: true; readonly input: unknown }
  | { readonly fromAsk: false };

interface ResolvedInput {
  readonly input: unknown;
  readonly inputPartial?: boolean;
  readonly inputTruncated?: boolean;
}

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** First `maxBytes` bytes of `text`. A split multi-byte sequence degrades to
 *  U+FFFD: the cap is a wire-safety bound, not a content promise. */
function cutUtf8(text: string, maxBytes: number): string {
  if (utf8Bytes(text) <= maxBytes) return text;
  return Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8");
}

/** Bound an ask-carried input the same way streamed deltas are bounded. */
function resolveAskInput(input: unknown): ResolvedInput {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(input);
  } catch {
    // EXIT: a non-serializable ask input cannot be bounded or put on the wire;
    // the "input incomplete" signal keeps the frame valid.
    return { input: {}, inputPartial: true };
  }
  if (encoded === undefined) return { input: {}, inputPartial: true };
  if (utf8Bytes(encoded) > MAX_PROJECTED_INPUT_BYTES) {
    return {
      input: cutUtf8(encoded, MAX_PROJECTED_INPUT_BYTES),
      inputTruncated: true,
    };
  }
  return { input };
}

/** Parse the held delta JSON; a still-open prefix is `inputPartial`. */
function resolveDeltaInput(call: BufferedToolCall): ResolvedInput {
  if (call.truncated) {
    return { input: call.json, inputTruncated: true };
  }
  if (call.json.length === 0) return { input: {}, inputPartial: true };
  try {
    return { input: JSON.parse(call.json) };
  } catch {
    // EXIT: a call released before its last delta is the normal path; the
    // partial flag is exactly the signal for it.
    return { input: {}, inputPartial: true };
  }
}

function resolveCallInput(
  call: BufferedToolCall,
  source: CallInputSource
): ResolvedInput {
  return source.fromAsk
    ? resolveAskInput(source.input)
    : resolveDeltaInput(call);
}

/** Turn-ending projection (spec §5.6 `turn_ended`). */
function projectTurnStatus(outcome: TurnOutcomeView): {
  readonly status: "completed" | "cancelled" | "failed";
  readonly stopReason?: string;
} {
  if (outcome.terminal !== "known") return { status: "failed" };
  const stopReason = outcome.stopReason;
  if (stopReason === "completed") return { status: "completed", stopReason };
  if (stopReason === "cancelled") return { status: "cancelled", stopReason };
  return { status: "failed", stopReason };
}

/**
 * Report the answer the settlement carries: the modal choice for an approval,
 * `reject` for a decline, and nothing for a system ending (timeout /
 * cancellation end the ask without an answer).
 */
function answerOf(
  outcome: AskUserOutcome,
  answer: AnswerChoice | undefined
): AnswerChoice | undefined {
  if (outcome.kind === "declined") return "reject";
  if (outcome.kind === "approved") {
    return answer === "once" || answer === "always" ? answer : undefined;
  }
  return undefined;
}

/** Last `TRANSCRIPT_TAIL_LIMIT` user / assistant text messages, chronological. */
function projectTranscriptTail(
  file: TuiLoadedSessionFile
): readonly TranscriptTailEntry[] {
  const tail: TranscriptTailEntry[] = [];
  for (
    let index = file.messages.length - 1;
    index >= 0 && tail.length < TRANSCRIPT_TAIL_LIMIT;
    index -= 1
  ) {
    const message = file.messages[index];
    if (message === undefined) continue;
    if (message.role !== "user" && message.role !== "assistant") continue;
    const parts: string[] = [];
    for (const block of message.content) {
      if (block.type === "text") parts.push(block.text);
    }
    const text = parts.join("\n");
    if (text.length === 0) continue;
    tail.unshift({ role: message.role, text });
  }
  return tail;
}

export function createSeatProjector(deps: SeatProjectorDeps): SeatProjector {
  const ring = createSeatEventRing();
  const timeOf = deps.now ?? ((): string => new Date().toISOString());
  const liveDeliveries = new Set<(event: SeatEvent) => void>();
  /** Held calls, insertion-ordered so a turn flush keeps stream order. */
  const buffered = new Map<string, BufferedToolCall>();
  /** `toolUseId` -> turn key already emitted (or retired by a switch): never
   *  re-buffer within that turn. Cleared at turn end and on an active switch
   *  so the guard tracks the current turn instead of the process lifetime. */
  const flushed = new Map<string, string>();
  const announcedAsks = new Set<string>();
  const resolvedAsks = new Set<string>();
  const resolvedAskOrder: string[] = [];
  let active: ProjectionActiveState | undefined;
  /** Baseline for change detection; `undefined` = no baseline yet, `null` = a
   *  draft session. Kept across `setActive(undefined)` so a view detour does
   *  not fake a conversation switch. */
  let lastActiveConversationId: string | null | undefined;
  let unsubscribers: Array<() => void> = [];
  let running = false;

  function isActive(conversationId: string): boolean {
    return (
      active !== undefined &&
      active.conversationId !== null &&
      active.conversationId === conversationId
    );
  }

  function flushKeyOf(conversationId: string, turnId: string): string {
    return `${conversationId}\u0000${turnId}`;
  }

  /** Forget a finished turn's emitted ids: only the live turn needs them. */
  function clearFlushedTurn(conversationId: string, turnId: string): void {
    const key = flushKeyOf(conversationId, turnId);
    for (const [toolUseId, owner] of flushed) {
      if (owner === key) flushed.delete(toolUseId);
    }
  }

  /** Remember one settled ask id, evicting the oldest beyond the bound. */
  function rememberResolvedAsk(askId: string): void {
    resolvedAsks.add(askId);
    resolvedAskOrder.push(askId);
    while (resolvedAskOrder.length > RESOLVED_ASKS_LIMIT) {
      const evicted = resolvedAskOrder.shift();
      if (evicted !== undefined) resolvedAsks.delete(evicted);
    }
  }

  function emit(body: SeatEventBody, conversationId?: string): void {
    if (!running) return;
    const stored = ring.push({
      time: timeOf(),
      ...(conversationId !== undefined ? { conversationId } : {}),
      event: body,
    });
    for (const deliver of [...liveDeliveries]) {
      try {
        deliver(stored);
      } catch {
        // Swallow consumer faults: a broken seat client must never fail or
        // delay the turn whose event it is watching (spec §3 invariant 7).
      }
    }
  }

  function bufferToolCallStart(
    conversationId: string,
    turnId: string,
    name: string,
    toolUseId: string
  ): void {
    if (flushed.has(toolUseId)) return;
    const existing = buffered.get(toolUseId);
    if (existing !== undefined) {
      // A repeated start only refines the name; the deltas stay.
      existing.name = name;
      return;
    }
    buffered.set(toolUseId, {
      toolUseId,
      conversationId,
      turnId,
      name,
      json: "",
      bytes: 0,
      truncated: false,
    });
  }

  function bufferToolInputDelta(toolUseId: string, partialJson: string): void {
    if (flushed.has(toolUseId)) return;
    const call = buffered.get(toolUseId);
    // Deltas without a start carry no call identity (no name, no turn), so
    // there is nothing addressable to emit later.
    if (call === undefined) return;
    if (call.truncated) return;
    const partialBytes = utf8Bytes(partialJson);
    const room = MAX_PROJECTED_INPUT_BYTES - call.bytes;
    if (partialBytes <= room) {
      call.json += partialJson;
      call.bytes += partialBytes;
      return;
    }
    call.json += cutUtf8(partialJson, room);
    call.bytes = MAX_PROJECTED_INPUT_BYTES;
    call.truncated = true;
  }

  function emitToolCall(
    call: BufferedToolCall,
    ask: TuiPendingAsk | undefined
  ): void {
    const resolved = resolveCallInput(
      call,
      ask === undefined
        ? { fromAsk: false }
        : { fromAsk: true, input: ask.input }
    );
    emit(
      {
        kind: "tool_call",
        toolUseId: call.toolUseId,
        name: call.name,
        input: resolved.input,
        ...(resolved.inputPartial !== undefined
          ? { inputPartial: resolved.inputPartial }
          : {}),
        ...(resolved.inputTruncated !== undefined
          ? { inputTruncated: resolved.inputTruncated }
          : {}),
      },
      call.conversationId
    );
  }

  /** Emit every held call of one turn, in stream order (spec §4.4 flush). */
  function flushTurnCalls(conversationId: string, turnId: string): void {
    const due: BufferedToolCall[] = [];
    for (const call of buffered.values()) {
      if (call.conversationId === conversationId && call.turnId === turnId) {
        due.push(call);
      }
    }
    if (due.length === 0) return;
    const pendingAsks = deps.askBridge.pendingAll();
    for (const call of due) {
      buffered.delete(call.toolUseId);
      flushed.set(call.toolUseId, flushKeyOf(call.conversationId, call.turnId));
      emitToolCall(
        call,
        pendingAsks.find((ask) => ask.toolUseId === call.toolUseId)
      );
    }
  }

  function handleStreamEvent(
    conversationId: string,
    turnId: string,
    event: HarnessStreamEvent
  ): void {
    switch (event.type) {
      case "text_delta":
        emit({ kind: "text", delta: event.text }, conversationId);
        return;
      case "thinking_delta":
        emit({ kind: "thinking", delta: event.text }, conversationId);
        return;
      case "tool_call_start":
        bufferToolCallStart(conversationId, turnId, event.name, event.id);
        return;
      case "tool_input_delta":
        bufferToolInputDelta(event.id, event.partialJson);
        return;
      case "agent_status":
        // The next model call is starting: anything still held has all the
        // input it will ever get.
        flushTurnCalls(conversationId, turnId);
        return;
      case "compaction_started":
        emit({ kind: "notice", text: "Compaction started" }, conversationId);
        return;
      case "compaction_completed":
        emit({ kind: "notice", text: "Compaction completed" }, conversationId);
        return;
      case "compaction_failed":
        emit({ kind: "notice", text: "Compaction failed" }, conversationId);
        return;
      case "compaction_cancelled":
        emit({ kind: "notice", text: "Compaction cancelled" }, conversationId);
        return;
      case "transport_retry":
        emit(
          {
            kind: "notice",
            text: `Connection retry ${event.attempt}/${event.maxAttempts}`,
          },
          conversationId
        );
        return;
      default:
        // Host UI state (env / graph / context usage / stop summary),
        // compaction summary text, and the stream's approval copies — approvals
        // are projected from the ask bridge, so the stream's are not.
        return;
    }
  }

  function handleHubEvent(event: HubEvent): void {
    switch (event.kind) {
      case "stream":
        if (!isActive(event.conversationId)) return;
        handleStreamEvent(event.conversationId, event.turnId, event.event);
        return;
      case "user_message":
        if (!isActive(event.conversationId)) return;
        emit(
          { kind: "user_message", text: event.text, origin: event.origin },
          event.conversationId
        );
        return;
      case "turn_started":
        if (!isActive(event.conversationId)) return;
        emit(
          { kind: "turn_started", turnId: event.turnId },
          event.conversationId
        );
        return;
      case "turn_ended": {
        if (!isActive(event.conversationId)) return;
        // A held call must not outlive its turn: close it first.
        flushTurnCalls(event.conversationId, event.turnId);
        emit(
          {
            kind: "turn_ended",
            turnId: event.turnId,
            ...projectTurnStatus(event.outcome),
          },
          event.conversationId
        );
        clearFlushedTurn(event.conversationId, event.turnId);
        return;
      }
    }
  }

  function handleToolEvent(event: TuiToolEvent): void {
    if (!isActive(event.conversationId)) return;
    const toolUseId = event.toolUseId;
    // Without a call id the result cannot address a call: drop it rather than
    // invent an identity (the TUI sink always carries one; older replays may
    // not).
    if (toolUseId === undefined) return;
    const call = buffered.get(toolUseId);
    if (call !== undefined) flushTurnCalls(call.conversationId, call.turnId);
    emit(
      {
        kind: "tool_result",
        toolUseId,
        resultKind: event.kind,
        ...(event.message !== undefined ? { message: event.message } : {}),
      },
      event.conversationId
    );
  }

  function announcePendingApprovals(): void {
    for (const ask of deps.askBridge.pendingAll()) {
      if (announcedAsks.has(ask.id)) continue;
      announcedAsks.add(ask.id);
      // An approval is the first moment the call's input is certainly
      // complete: release the turn's held calls before the card.
      const call = buffered.get(ask.toolUseId);
      if (call !== undefined) flushTurnCalls(call.conversationId, call.turnId);
      emit(
        {
          kind: "approval_pending",
          toolUseId: ask.toolUseId,
          tool: ask.tool,
          summaryHint: ask.summaryHint,
          input: ask.input,
          ...(ask.conversationId !== undefined
            ? { conversationId: ask.conversationId }
            : {}),
        },
        ask.conversationId
      );
    }
  }

  function handleSettled(
    ask: TuiPendingAsk,
    outcome: AskUserOutcome,
    by: TuiAskSettledBy,
    answer: AnswerChoice | undefined
  ): void {
    if (resolvedAsks.has(ask.id)) return;
    rememberResolvedAsk(ask.id);
    announcedAsks.delete(ask.id);
    const reported = answerOf(outcome, answer);
    const approvalOutcome: ApprovalOutcome = outcome.kind;
    emit(
      {
        kind: "approval_resolved",
        toolUseId: ask.toolUseId,
        outcome: approvalOutcome,
        ...(reported !== undefined ? { answer: reported } : {}),
        by,
      },
      ask.conversationId
    );
  }

  function retireBufferedOutside(conversationId: string | null): void {
    for (const call of [...buffered.values()]) {
      if (conversationId !== null && call.conversationId === conversationId) {
        continue;
      }
      buffered.delete(call.toolUseId);
      // Retired, not emitted: a late start / delta for the outgoing
      // conversation must not re-enter the new projection.
      flushed.set(call.toolUseId, flushKeyOf(call.conversationId, call.turnId));
    }
  }

  function setActive(state: ProjectionActiveState | undefined): void {
    active = state;
    if (state === undefined) return;
    if (lastActiveConversationId === undefined) {
      // Baseline: the first observed state is the starting point, not a switch.
      lastActiveConversationId = state.conversationId;
      return;
    }
    if (lastActiveConversationId === state.conversationId) return;
    lastActiveConversationId = state.conversationId;
    // The outgoing turn keeps running; only what the operator no longer sees
    // retires from the projection. Drop the accumulated per-turn emitted ids
    // first, then let retirement re-mark just the calls this switch retires.
    flushed.clear();
    retireBufferedOutside(state.conversationId);
    emit(
      { kind: "active_changed", conversationId: state.conversationId },
      state.conversationId ?? undefined
    );
  }

  function subscribeLive(deliver: (event: SeatEvent) => void): () => void {
    liveDeliveries.add(deliver);
    return () => {
      liveDeliveries.delete(deliver);
    };
  }

  function start(): void {
    if (running) return;
    running = true;
    unsubscribers = [
      deps.hub.subscribeEvents(handleHubEvent),
      deps.askBridge.subscribe(announcePendingApprovals),
      deps.askBridge.onSettled(handleSettled),
      deps.toolEventSink.subscribe(handleToolEvent),
    ];
    // Asks queued before the seat started are pending too.
    announcePendingApprovals();
  }

  function stop(): void {
    if (!running) return;
    running = false;
    for (const off of unsubscribers) off();
    unsubscribers = [];
    buffered.clear();
    flushed.clear();
    announcedAsks.clear();
    resolvedAsks.clear();
    resolvedAskOrder.length = 0;
    liveDeliveries.clear();
  }

  async function snapshot(): Promise<Snapshot> {
    // Boundary first: events with seq greater than this follow the snapshot.
    const seq = ring.latestSeq;
    const current = active;
    const conversationId =
      current === undefined ? null : current.conversationId;
    const pendingApprovals: PendingApprovalView[] = deps.askBridge
      .pendingAll()
      .map((ask) => ({
        toolUseId: ask.toolUseId,
        tool: ask.tool,
        summaryHint: ask.summaryHint,
        input: ask.input,
        ...(ask.conversationId !== undefined
          ? { conversationId: ask.conversationId }
          : {}),
      }));
    const openToolCalls: OpenToolCall[] = [];
    if (conversationId !== null) {
      for (const call of buffered.values()) {
        if (call.conversationId !== conversationId) continue;
        openToolCalls.push({
          toolUseId: call.toolUseId,
          name: call.name,
          input: resolveDeltaInput(call).input,
        });
      }
    }
    let title: string | undefined;
    let transcriptTail: readonly TranscriptTailEntry[] = [];
    if (conversationId !== null) {
      try {
        const file = await deps.loadTranscript(conversationId);
        if (file.title.length > 0) title = file.title;
        transcriptTail = projectTranscriptTail(file);
      } catch {
        // EXIT: a missing / unreadable transcript means no title or tail, not
        // a failed snapshot — seq, approvals and open calls still stand.
      }
    }
    return {
      seq,
      active:
        current === undefined
          ? null
          : {
              conversationId: current.conversationId,
              ...(title !== undefined ? { title } : {}),
              running: current.running,
              queued: current.queued,
            },
      pendingApprovals,
      openToolCalls,
      transcriptTail,
    };
  }

  const projector: SeatProjector = {
    instanceId: deps.instanceId,
    start,
    stop,
    setActive,
    subscribeLive,
    replaySince: (sinceSeq: number): readonly SeatEvent[] =>
      ring.replaySince(sinceSeq),
    get oldestSeq(): number | undefined {
      return ring.oldestSeq;
    },
    get latestSeq(): number {
      return ring.latestSeq;
    },
    snapshot,
  };
  return Object.freeze(projector);
}
