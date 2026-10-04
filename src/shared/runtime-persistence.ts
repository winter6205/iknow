/**
 * Neutral contract for harness runtime-state persistence
 * (`specs/session-checkpoint-architecture.md`, plan B: harness execution, graph
 * state, and owned workers).
 *
 * The harness never owns a session file format, a blob directory, or a store
 * error type. It emits a typed request at each boundary the spec names and the
 * host decides how to make it durable. This module is the whole contract, and
 * it is deliberately dependency-free: `src/shared/` is the neutral layer that
 * harness / session-api / traceserver may all import, so nothing here may
 * import a project type (a native message arrives as the generic `M`).
 *
 * Two request kinds, deliberately different in durability:
 *
 *   - `publishSavedState` replaces the selected full state. A publication that
 *     fails leaves the previous one selected; callers must await it before
 *     starting dependent execution.
 *   - `appendOperationFact` only ever appends. Facts account for progress
 *     between two published states, so a fact written for a state that later
 *     fails to publish is harmless and is never mutated afterwards.
 *
 * Deliberately absent, because the spec excludes them from saved state: API
 * credentials, secret values, the secret-roundtrip registry, permission grants
 * of any kind (including `allow-once`), timers, abort signals, streams, and
 * live process handles. A worker fact carries process *identity* only, which
 * is what makes "prove this exact worker stopped" decidable; it never carries
 * a way to reach the process.
 *
 * The port carries no live object: every field it declares is a string, number,
 * boolean or null, or a readonly array / object of those, so a payload survives
 * a JSON round trip by construction. The one value left open is the native
 * message (`M`), which this layer cannot type by design; the layer that
 * serializes it validates it there.
 *
 * WHY THIS IS THE HARNESS-FACING SEAM: the harness's loop, graph tool, and
 * worker spawn all persist through `RuntimePersistenceBinder` and nothing else,
 * so the whole harness has exactly one place to be told "this write is
 * correctness-critical". `NativeStatePort` (native-state-port.ts) is the
 * host-internal facility underneath it: the storage side writes the
 * transcript record and the immutable body, and it is also the harness's
 * `intentRecorder` for file-preimage capture — a different job (pre-write
 * intent, not runtime state) that stays exactly as it is. This module owns the
 * only translation between the two vocabularies, `toNativeStateBoundary`.
 *
 * One boundary vocabulary, translated once: the four values below are the
 * harness's names, `NativeStateBoundary`'s four are the storage record's, and
 * the map lives in `native-state-port.ts` — this file stays import-free so a
 * project type can never reach a payload through it (locked by
 * `tests/harness/permission/saved-state-excludes-grants.test.ts`).
 */

/**
 * The four boundaries at which the harness may publish a full saved state.
 *
 * - `accepted_input`: the accepted user message and its assembled native
 *   context, published before the first model request of a turn.
 * - `tool_batch_settled`: every call of the batch has returned and its result
 *   is already in the saved context.
 * - `compacted`: the exact post-compaction native context.
 * - `terminal_turn`: the turn is settled and no operation is outstanding.
 */
export type RuntimeSavedStateBoundary =
  "accepted_input" | "tool_batch_settled" | "compacted" | "terminal_turn";

/**
 * The harness's boundary vocabulary becomes the storage record's in
 * `toNativeStateBoundary` (src/shared/native-state-port.ts). Keyed off BOTH
 * unions, so a member added to either one fails to compile there instead of
 * reaching disk unmapped.
 */

/**
 * Frozen session-level inputs the native context was assembled from. Restoring
 * a session must not need current settings, so the prefix travels with the
 * state instead of being re-derived.
 *
 * `systemPrefix` is the harness's to produce and the only field here: every
 * publication carries the prefix of the nearest model request, and the run's
 * first publication (the accepted input, which precedes any request) seeds it
 * from the same per-turn seam, so even the earliest state is not prefix-less. A
 * run that sent no prefix leaves the whole `assembly` key absent.
 *
 * WHY no other field is declared: a field with no producer is a guarantee the
 * code does not make, and each of the three removed ones has no owner the engine
 * can observe. The skill-index seen set belongs to the persisted entry ledger
 * (`skill/index-ledger.ts`), which the `SkillIndexDeltaSeam` reveals only as one
 * round's delta, so a run-accumulated list would be a subset presented as the
 * whole set — and a second authority for a set the ledger already owns (the
 * delta producer never re-pastes a name the ledger holds). Logical
 * pending-continuation state is a session-api predicate over the transcript
 * (`session-api/continue-pending.ts`) that the engine neither holds nor reads.
 * The selected execution mode is the joint permission + graph snapshot, and the
 * engine sees at most the graph half, only when a graph seam is wired. Filling
 * any of them with `[]` / `false` / `""` would make absence impossible to read.
 *
 * Provenance, and the limit of it: the bytes are exactly the `system` the
 * requests were sent, so "which request was this assembled against" is answered
 * by the state they travel on. Where those bytes ORIGINATE is the host's prompt
 * seam, not an engine observation, so no provenance field is declared rather
 * than one carrying a constant the reader could mistake for an observation. The
 * per-message `hostInjected` stamp answers the other question §2.3 asks — which
 * frames in the context are host-injected — and it answers it per message; it
 * says nothing about the prompt prefix, which is not a message.
 */
export interface RuntimeAssemblyState {
  /** Frozen system/prompt prefix the context was assembled against. */
  readonly systemPrefix?: string;
}

/**
 * Terminal facts of a settled turn. Whether the turn is *known* to be finished
 * is the host's call: only a published turn outcome makes it known, so the
 * request carries the observed stop reason and never an `isComplete` verdict.
 */
export interface RuntimeTerminalState {
  readonly stopReason: string;
  readonly supplierDetail?: string;
}

/** One target of a multi-file write, recorded per target rather than per call. */
export interface RuntimeFileOperationRecord {
  /** Path relative to the live write root the operation resolved against. */
  readonly relPath: string;
  /** Write-root identity the relative path is meaningful under. */
  readonly rootIdentity: string;
  /** ENOENT observed before the write = the target did not exist. */
  readonly absentBefore: boolean;
  /** Content address of the captured preimage, when capture is enabled. */
  readonly preimageSha?: string;
  /** Content address of the complete expected postimage. */
  readonly postimageSha?: string;
  /** Whether the target was published by atomic replacement. */
  readonly published?: boolean;
}

/**
 * A settled or dispatched tool call, appended as soon as it returns.
 *
 * Why no base-state field: the association *is* the append position. A fact's
 * base state is the last full state published before it, and the harness
 * appends at settlement — before any state that could already contain this
 * result. The ordering is therefore load-bearing rather than cosmetic: a sink
 * must append in the order it receives the calls, and a caller must not buffer
 * or reorder a fact across a publication, or the fact lands on a state that
 * already holds its result. A redundant base-state reference would instead hand
 * the host a second copy of that order to keep in step.
 */
export interface RuntimeToolResultFact<M> {
  readonly kind: "tool_result";
  /** Anthropic `tool_use_id` of the call; also the file-association key. */
  readonly toolUseId: string;
  /** Turn the call belonged to, when the turn identity is known. */
  readonly turnId?: string;
  /**
   * Position of this call inside its assistant response's tool batch, so
   * reconstructed context keeps protocol order regardless of settlement order.
   * Unique per batch, zero-based.
   *
   * Batch-level, not wave-level: a concurrency wave is a scheduling split
   * inside the batch, and a wave-local index would make several calls of one
   * batch claim the same position (the reader could not order them at all).
   */
  readonly batchPosition: number;
  /** How many calls the batch contained, for a settled/unsettled comparison. */
  readonly batchSize: number;
  /** The encoded tool_result message, exactly as committed to history. */
  readonly resultMessage: M;
  /**
   * Per-file associations for this call. No producer writes it yet: the
   * harness kernel has no file view, and the layer that captures preimages
   * records them on their own durable `file_intent` record instead (the
   * preimage bytes are already persisted there, keyed by `toolUseId`). The
   * field stays in the contract because a caller that DOES hold a file view
   * must not be forced to drop the association on the floor; until one exists
   * it is always absent, and the reader must not infer "no files touched"
   * from an absent field.
   */
  readonly files?: ReadonlyArray<RuntimeFileOperationRecord>;
}

/** One live-graph node transition. `running` marks a node that was dispatched. */
export interface RuntimeGraphNodeFact {
  readonly kind: "graph_node";
  readonly nodeId: string;
  readonly status: "running" | "done" | "failed" | "skipped";
  /** Node output needed by later nodes; carried for settled `done` nodes. */
  readonly output?: string;
  /** Failure summary, so a settled `failed` node is queryable and not just a status. */
  readonly error?: string;
}

/**
 * OS process identity of one owned worker spawn. `startTime` is the raw
 * `/proc` start-time value used to tell a recycled pid from the owned process;
 * `null` means the value could not be read, which is a "cannot confirm" answer
 * and never a "stopped" answer.
 */
export interface RuntimeWorkerProcessIdentity {
  readonly pid: number;
  readonly startTime: number | null;
}

/**
 * Ownership and liveness of one session-owned worker.
 *
 * `needs_handling` is a *live* state, not a synonym for the worker's last
 * known one: it is published when the owned process could neither be confirmed
 * stopped nor safely signalled, which is exactly the case where a reader must
 * not conclude anything from `running` alone. It is deliberately distinct from
 * a settled terminal state so "confirmed stopped" and "could not confirm"
 * cannot be collapsed by a reader that only checks for terminality.
 */
export interface RuntimeWorkerFact {
  readonly kind: "worker_progress";
  readonly taskId: string;
  readonly ownership: "foreground" | "background";
  readonly state:
    | "starting"
    | "running"
    | "completed"
    | "failed"
    | "stopped"
    | "needs_handling";
  /** Identity of the process this fact's `state` refers to. */
  readonly process?: RuntimeWorkerProcessIdentity;
  /** The worker's own transcript, which stays independently readable. */
  readonly transcriptPath?: string;
  /** `tool_use_id` of the spawn call, when the spawn is transcript-anchored. */
  readonly toolUseId?: string;
}

export type RuntimeOperationFact<M> =
  RuntimeToolResultFact<M> | RuntimeGraphNodeFact | RuntimeWorkerFact;

/** A full saved state, published to replace the currently selected one. */
export interface RuntimeSavedStateRequest<M> {
  readonly boundary: RuntimeSavedStateBoundary;
  /** Stable turn identity, or `null` when no turn identity is known yet. */
  readonly turnId: string | null;
  /** The exact native message sequence at this boundary, in order. */
  readonly messages: ReadonlyArray<M>;
  /** Frozen session assembly inputs; absent when the run resolved none. */
  readonly assembly?: RuntimeAssemblyState;
  /** Present only on a `terminal_turn` publication. */
  readonly terminal?: RuntimeTerminalState;
  /**
   * Runtime state the spec requires a published state to carry but that arrives
   * as its own fact stream rather than inside `assembly`: loop position
   * (§2.2), graph nodes (§2.5), owned workers (§2.6). All OPTIONAL so a caller
   * that tracks none keeps compiling, and absent means "this run resolved
   * none" — never a fabricated empty set.
   */
  readonly toolResults?: ReadonlyArray<RuntimeToolResultFact<M>>;
  readonly graphNodes?: ReadonlyArray<RuntimeGraphNodeFact>;
  readonly workers?: ReadonlyArray<RuntimeWorkerFact>;
}

/**
 * Session-bound persistence seam. Implementations are correctness-critical:
 * a rejected call must block the execution that depends on it rather than fall
 * back, and no caller may swallow the rejection. The trace writer is the one
 * existing exception to that rule, and it is not implemented through this port.
 *
 * One caller shape cannot await: a seam whose public API is synchronous (a
 * spawn that returns a handle) has no place to put the await. Such a caller
 * must then write its own durable record *before* the fact, treat the fact as a
 * projection of that record rather than the authority, and surface a rejected
 * append explicitly with its cause. It must never present an unwritten fact as
 * recorded, and it must never let the rejection look like success.
 */
export interface RuntimePersistenceSink<M> {
  publishSavedState(request: RuntimeSavedStateRequest<M>): Promise<void>;
  appendOperationFact(fact: RuntimeOperationFact<M>): Promise<void>;
}

/**
 * Resolves a session-bound sink from a session identity. Held at assembly time
 * by callers that learn the session id only at call time (graph tool context,
 * worker spawn definition); callers that already run inside one session hold a
 * `RuntimePersistenceSink` directly.
 *
 * `undefined` for an unknown session, and for a host that wired no persistence
 * at all, so "no session" and "not wired" take the same no-op path.
 */
export interface RuntimePersistenceBinder<M> {
  bind(sessionId: string | undefined): RuntimePersistenceSink<M> | undefined;
}
