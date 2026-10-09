/**
 * Harness streaming-event contract SSOT (minimal set, extended in later phases).
 *
 * Event set:
 *   - text_delta / thinking_delta: incremental text (answer / thinking);
 *   - tool_call_start: tool call begins, carries `id` (the tool_use block id
 *     used to pair with postToolUse completion events for live status);
 *   - tool_input_delta: incremental tool input (partial_json pieces),
 *     carrying the same `id` as tool_call_start — increments serve only the
 *     display layer; the authoritative input still arrives in one shot from
 *     `finalMessage()`;
 *   - stop_summary: terminal event — after an abnormal stop, the
 *
 // (ADR-0011)
 *     best-effort closing model summary as plain text, emitted by
 *     loop-engine run() before returning; carries no structure / metadata
 *     (the summary text is the payload).
 *
 * Why these events:
 *   - native SSE events do not cross the adapter boundary (adjudicated
 *     early), translated via wireStreamEvents;
 *   - tool input incremental streaming emits pieces via `tool_input_delta`
 *     (display only; the authoritative input comes from `finalMessage()` —
 *     the end state goes through the existing `interpretMessage` SSOT path
 *     with zero changes, and whole-turn commit semantics are unaffected).
 *   - the SDK has no wire-level ping/error events, so the contract promises
 *     none.
 *
 * Extension point: adding a member only extends this union (consumers
 * narrow on `type`); no emit / consume sites to change.
 */
import type { AgentStatusSnapshot } from "./agent-status.js";
import type { EnvSnapshot } from "./env-snapshot.js";
import type { GraphProgressSnapshot } from "./graph/progress.js";
import type { TokenUsage } from "./model-adapter/types.js";

export type HarnessStreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "tool_call_start"; name: string; id: string }
  | { type: "tool_input_delta"; id: string; partialJson: string }
  | { type: "stop_summary"; text: string }
  // LLM structured-summary compaction (full-compact) lifecycle events. The
  // host renders a "Compacting…" indicator / surfaces summary latency from
  // them. During compaction the turn is still running (the main loop waits
  // for the summary before the next step), so on compaction_started the host
  // may show a progress indicator, cleared by any terminal event
  // (completed / failed / cancelled; cancelled = user cancelled during the
  // wait, not an error — Esc mid-compaction keeps the conversation as-is
  // with no failure presentation). Shapes stay
  // minimal: only fields the host needs for rendering / logging.
  | { type: "compaction_started"; droppedCount: number }
  | { type: "compaction_completed"; summaryLen: number; durationMs: number }
  | { type: "compaction_failed"; reason: string; durationMs: number }
  | { type: "compaction_cancelled" }
  // Streaming text track for the compaction summary. runFullCompact no
  // longer passes the adapter's raw text_delta through to the host but
  // remaps it to this event — a host that appended it to the main answer
  // draft would let summary text pollute the assistant reply (a latent
  // rendering-pollution bug). Hosts narrow on `type` into a separate
  // compaction draft; thinking_delta inside the compaction context is
  // swallowed by runFullCompact (scratchpad, not exposed).
  | { type: "compaction_text_delta"; text: string }
  // Status-bar current-snapshot event — the read port for the TUI's
  // (ADR-0028)
  // "latest current state". loop-engine emits it at the same computation
  // point where it injects the `<agent_status>` bar, just before each model
  // call; fields share the bar's source (AgentStatusSnapshot data fields,
  // see agent-status.ts; the bar `text` is not carried — it derives from the
  // same snapshot, and any divergence between the two would be a design
  // flaw). When deps.agentStatus is absent (ask / worker paths) the bar is
  // not injected and this event is not emitted either. The event goes only
  // to host UI, never into the model bar (in-flight state belongs to
  // existing events like tool_call_start). The shape uses Pick directly from
  // AgentStatusSnapshot (no inlined re-declaration, one source of truth;
  // per-field docs live in agent-status.ts and are not repeated here). The
  // Pick grows additively with the snapshot's instruction / reconcile slots —
  // conditional presence follows the snapshot field itself (absent → key not
  // emitted); reconcile settlement is wired through the loop-engine
  // run-scoped box: the event's reconcile key appears once this bar has
  // settled (including false); nothing to settle → slot absent.
  | ({
      type: "agent_status";
    } & Pick<
      AgentStatusSnapshot,
      "lastTool" | "openTodoLines" | "instruction" | "reconcile"
    >)
  // Environment-freshness snapshot event — an **independent** stream
  // parallel to `agent_status` (data source for human-readable chrome, the
  // TUI EnvironmentPane; for humans, not the model). loop-engine emits it at
  // the same turn boundary, right after the `agent_status` event, before
  // each model call. It deliberately does not reuse the agent_status event /
  // snapshot shape (zero field overlap), does not enter messages, does not
  // (ADR-0028)
  // enter verify input, and does not write the status bar. When
  // deps.envSnapshot is absent (ask / worker paths) the event is not sent.
  // The snapshot is readEnvSnapshot's product: git failure → all git fields
  // null + a degradeReason classification (degraded, cwd preserved), never
  // throws.
  | { type: "env_snapshot"; snapshot: EnvSnapshot }
  // TUI run_graph execution view: scheduler onWave/onNode accumulate a
  // snapshot. snapshot null = this run_graph ended or was cancelled; the
  // host should tear down the graph chrome.
  | { type: "graph_progress"; snapshot: GraphProgressSnapshot | null }
  // Graph-mode switch stream event — emitted only when loop-engine detects
  // a graphAssembly flip (off→on / on→off) between two adjacent step
  // boundaries, same source as the single `<graph_mode>` line appended to
  // the message tail (SSOT in graph/notification.ts). The host updates
  // human-readable chrome (title bar / status bar) from it; the
  // model-facing switch notice goes only through the messages append
  // (appendGraphModeChange → appendMessage), not a stream event. Only
  // `enabled` is kept as a field — flip direction maps 1:1 to text
  // direction, and the text itself is carried by the messages sequence.
  | { type: "graph_mode_changed"; enabled: boolean }
  // Transport retry progress — emitted by withTransportRetry before each
  // backoff retry so the host can render a "connection retry attempt/max"
  // style indicator. Retries were previously silent: during 429 / network
  // faults the user saw no activity at all. `detail` is a short description
  // of the fault (status code / error class) for humans only, never into
  // the model face.
  | {
      type: "transport_retry";
      attempt: number;
      maxAttempts: number;
      detail: string;
    }
  // Context-usage call-beat reading (#1079 Track A) — the display truth for
  // the usage bar, one beat per model call instead of one per run(). Two
  // phases ride the same event: `pre_call` is emitted at the same turn
  // boundary as `agent_status` / `env_snapshot`, just before the model call,
  // and carries the **measured** outgoing input occupancy (system + tools +
  // messages via `ModelAdapter.countTokens`; outputTokens 0 / cache null —
  // nothing is invented for fields the measurement cannot know);
  // `post_call` is emitted as soon as that call succeeds and carries the
  // call's real API usage (the `AssistantTurnResult.usage` sealed
  // passthrough). A beat without a successful real reading emits nothing —
  // chars/N estimation must never fill the bar (ADR-0008 D6). Hosts narrow
  // on `phase` only if they distinguish; the TUI display consumes both
  // phases verbatim as the latest reading.
  | {
      type: "context_usage";
      phase: "pre_call" | "post_call";
      usage: TokenUsage;
    };

/**
 * SSOT for the `transport_retry.detail` value that marks an invisible-stall
 * resend (stream-hang-detect T3/T4). The loop-engine's clock-retry machine
 * emits it once per resend of a zero-delta attempt; the subagent worker taps
 * it as the hang fingerprint that distinguishes "budget exhausted on open-
 * but-silent stream" (→ modelTransient) from a plain per-call timeout stop.
 * Production-side drift here would silently degrade the attribution, so both
 * the emit site and the consumer import this constant rather than
 * duplicating the string literal.
 */
export const TRANSPORT_RETRY_DETAIL_INVISIBLE_TIMEOUT = "invisible_timeout";

/**
 * Observer errors must not back-flow into the emit path (aligned with
 * ADR-0003's `safeTrace` MUST NOT throw and the wireStreamEvents precedent).
 * Single wrapper: both the anthropic-adapter stream translation and the
 * full-compact lifecycle events consume it, avoiding copy-pasted try/catch
 * at each site.
 */
export function safeEmitStream(
  onStream: ((event: HarnessStreamEvent) => void) | undefined,
  event: HarnessStreamEvent
): void {
  if (onStream === undefined) return;
  try {
    onStream(event);
  } catch {
    // Swallow observer exceptions: host faults must not back-flow into
    // the stream arm (aligned with ADR-0003 `safeTrace` MUST NOT throw).
  }
}
