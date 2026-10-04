/**
 * Session-entry recovery (ADR-0136 §4): given a selected session, restore its
 * published native state and reconcile the real world against persisted facts.
 *
 * READ-ONLY, AND THAT IS THE WHOLE DESIGN. Recovery appends no record, writes
 * no receipt, publishes no checkpoint, mutates no file, and signals no
 * process. Idempotence across repeated opens (SC27) and the separation from
 * explicit code rewind (SC14) then hold structurally instead of by discipline:
 * there is nothing here that a second call could duplicate. Recovery issues no
 * model or tool call either — the only things it produces are a
 * classification and the SAVED context the host must restore.
 *
 * The authority chain, in order, and no other:
 *   - `loadPublishedNativeState` selects the published state and reports
 *     whether the session is new format at all;
 *   - `readPublishedNativeStateBody` loads and validates that state, keeping
 *     missing / corrupt / schema-invalid as three distinct failures;
 *   - the raw head chain is the authority for whether a call SETTLED;
 *   - `projectTurnOutcomes` supplies the terminal `turn outcome`.
 *
 * `SessionStore.load()` is deliberately NOT the settlement source: it
 * backfills synthetic process-closeout `tool_result`s for orphan tool_uses
 * (closeout-projection.ts), which would turn a call that never returned into
 * a settled error — exactly the state SC11 requires recovery to keep unknown.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  headChainEvents,
  parseSessionJsonl,
  projectSessionLog,
  SESSION_JSONL_EXT,
} from "./jsonl.js";
import type {
  FileIntentPosition,
  SessionEventRecord,
  SessionOperationFactRecord,
  SessionTailRecord,
} from "./jsonl.js";
import {
  reconcileFileIntents,
  reduceOperationFacts,
  type RecoveredFileOperation,
  type RecoveredOperationFacts,
  type ToolOperationSettlement,
} from "./recovery-reconcile.js";
import type {
  RecoveryHandlingItem,
  RecoveryStatus,
} from "./recovery-status.js";
import { resolveConversationDir } from "./session-store.js";
import type { SessionStore } from "./session-store.js";
import type { SessionStoreError } from "./errors.js";
import type { StopReason } from "../../harness/index.js";
import type { OwnedWorkerSweepResult } from "../../harness/subagent/worker-identity-stop.js";
import type {
  RuntimeAssemblyState,
  RuntimeGraphNodeFact,
  RuntimeTerminalState,
  RuntimeToolResultFact,
  RuntimeWorkerFact,
} from "../../shared/runtime-persistence.js";
import type {
  NativeStateMessage,
  NativeStateSnapshot,
} from "../../shared/native-state-port.js";

export {
  RECOVERY_IN_PROGRESS_LABEL,
  type FileHandlingReason,
  type RecoveryBlockedReason,
  type RecoveryHandlingItem,
  type RecoveryInProgressLabel,
  type RecoveryStatus,
} from "./recovery-status.js";
export {
  reconcileFileIntents,
  reduceOperationFacts,
  type FactAnchoring,
  type FileTargetVerdict,
  type OperationFactKind,
  type ReconcileInput,
  type ReconcileResult,
  type RecoveredFileOperation,
  type RecoveredGraphNode,
  type RecoveredOperationFacts,
  type RecoveredOwnedWorker,
  type RecoveredToolResultFact,
  type ReduceOperationFactsInput,
  type RejectedFact,
  type ToolOperationSettlement,
  type UnanchoredFact,
} from "./recovery-reconcile.js";

/**
 * The selected checkpoint's typed runtime state (spec §2.2 loop position,
 * §2.3 assembly, §2.5 graph, §2.6 workers, §2.8 terminal).
 *
 * EVERY FIELD STAYS OPTIONAL, and that is the contract: an absent field means
 * this publication carried no such state, which is a different fact from "the
 * state was empty". A host must never substitute `[]`, `false`, or `""` for an
 * absent one — a reader that sees an empty graph list may conclude the graph
 * ran and finished, when the truth is that graph state was never saved.
 */
export interface RecoveredRuntimeState {
  /** Frozen session assembly inputs and their provenance. */
  readonly assembly?: RuntimeAssemblyState;
  /** Loop position: the in-flight turn's tool-batch bookkeeping. */
  readonly toolResults?: ReadonlyArray<
    RuntimeToolResultFact<NativeStateMessage>
  >;
  /** Validated live graph state, one entry per known node. */
  readonly graphNodes?: ReadonlyArray<RuntimeGraphNodeFact>;
  /** Owned-worker state, one entry per known worker. */
  readonly workers?: ReadonlyArray<RuntimeWorkerFact>;
  /** Terminal state of the published turn; absent means unknown. */
  readonly terminal?: RuntimeTerminalState;
  /** The publication's opaque runtime bag, round-tripped verbatim. */
  readonly runtimeFacts?: Readonly<Record<string, unknown>>;
}

/**
 * The restored turn's terminal posture (ADR-0126). A missing record is
 * UNKNOWN, never `completed`, and a settled outcome is withheld while an
 * operation is still outstanding — a turn cannot be closed over work that has
 * not been accounted for.
 */
export type RestoredTurnOutcome =
  | {
      readonly state: "settled";
      readonly turnEventId: string;
      readonly stopReason: StopReason;
    }
  | {
      readonly state: "unknown";
      readonly reason: "no_record" | "operation_outstanding";
    };

/** Everything one recovery produced. A host restores `messages` — the SAVED
 *  context, never a projection of the transcript — restores `runtime` as the
 *  execution state that context was published with, and renders `status`. */
export interface SessionRecoveryReport {
  readonly conversationId: string;
  readonly status: RecoveryStatus;
  /** The published state's exact native message sequence. Empty for every
   *  variant that did not load a state. */
  readonly messages: ReadonlyArray<NativeStateMessage>;
  /** `messages.length`, reported explicitly so a host never infers saved
   *  progress from an array size. */
  readonly savedMessageCount: number;
  /** Post-anchor file operations in transcript file order; empty when nothing
   *  was published after the restored state. */
  readonly operations: ReadonlyArray<RecoveredFileOperation>;
  /** Terminal posture of the restored turn. */
  readonly outcome: RestoredTurnOutcome;
  /** The selected checkpoint's runtime state, or null when it published none.
   *  null is the ABSENT case, never an empty object. */
  readonly runtime: RecoveredRuntimeState | null;
  /** What the log's operation facts account for against that state, or null
   *  when no state was restored (nothing to account it against). */
  readonly operationFacts: RecoveredOperationFacts | null;
}

export interface RecoverSessionOptions {
  readonly store: SessionStore;
  readonly conversationId: string;
  /** LIVE write root. Every recorded `relPath` resolves against it. */
  readonly taskRoot: string;
  /** Identity of that live root, produced by the host from the same
   *  derivation `applyCodeRestore` receives (the hub's `rootIdentityFor`).
   *  Recovery must not re-derive it: that decision belongs to the live host
   *  state, and a second derivation could compare unequal to every captured
   *  identity. */
  readonly liveRootIdentity: string;
  /** Owned-worker verdicts from a sweep the host ran BEFORE calling. Only
   *  consumed, never triggered: recovery signals no process, so a host that
   *  supplies none leaves every worker without a stop proof — which reads as
   *  needing handling, never as stopped. */
  readonly workerSweep?: OwnedWorkerSweepResult;
}

/** Selection as recovery needs it: post-anchor intents only, and the selected
 *  state's content address. */
interface RecoverySelection {
  readonly newFormat: boolean;
  readonly bodySha: string | null;
  readonly intents: ReadonlyArray<FileIntentPosition>;
}

/**
 * Restore one selected session. Every unusable-published-state case resolves
 * to a visible `blocked` / `unsupported_format` classification instead of
 * throwing, because each is an operator state rather than an exception. A
 * conversation that does not exist, and a real IO fault, still propagate as
 * the store's typed errors — neither is a recovery state. The single
 * degradation is the restored turn's terminal posture, which falls back to
 * `unknown` rather than discarding an otherwise complete restore; see
 * `restoredOutcome`.
 */
export async function recoverSession(
  opts: RecoverSessionOptions
): Promise<SessionRecoveryReport> {
  const { store, conversationId } = opts;
  const selection = await readSelection(store, conversationId);
  if (selection.status !== "ok")
    return unrestoredReport(conversationId, selection.status);
  if (!selection.value.newFormat) {
    return unrestoredReport(conversationId, { status: "unsupported_format" });
  }
  if (selection.value.bodySha === null) {
    return unrestoredReport(conversationId, { status: "no_published_state" });
  }
  const body = await readBody(store, conversationId, selection.value.bodySha);
  if (body.status !== "ok") {
    return unrestoredReport(conversationId, body.status);
  }
  const chain = await readHeadChain(store, conversationId);
  if (chain.status !== "ok") {
    return unrestoredReport(conversationId, chain.status);
  }
  const { operations, handling } = await reconcileFileIntents({
    sessionFolder: resolveConversationDir({
      projectDir: store.getProjectDir(),
      conversationId,
    }),
    taskRoot: opts.taskRoot,
    liveRootIdentity: opts.liveRootIdentity,
    intents: selection.value.intents,
    settlements: settlementMap(chain.value.messages),
    onChainToolUseIds: onChainToolUseIds(chain.value.events),
  });
  const outcome = outstanding(operations)
    ? ({ state: "unknown", reason: "operation_outstanding" } as const)
    : await restoredOutcome(store, conversationId, body.value);
  const operationFacts = reduceOperationFacts({
    facts: chain.value.facts,
    selectedBodySha: selection.value.bodySha,
    ...(opts.workerSweep !== undefined
      ? { workerSweep: opts.workerSweep }
      : {}),
  });
  return {
    conversationId,
    status: statusOf(handling, operationFacts),
    messages: body.value.messages,
    savedMessageCount: body.value.messages.length,
    operations,
    outcome,
    runtime: runtimeStateOf(body.value),
    operationFacts,
  };
}

/**
 * `needs handling` covers an unprovable owned-worker stop as well as a file
 * an operator must decide about (SC17): the spec asks for the same visible
 * outcome for both, and a worker nobody could confirm is a work somebody has
 * to be told about. The two lists stay separate — `handling` is per file
 * target, `workers` is per task.
 */
function statusOf(
  handling: ReadonlyArray<RecoveryHandlingItem>,
  facts: RecoveredOperationFacts
): RecoveryStatus {
  const workers = facts.workers
    .filter((worker) => worker.needsHandling)
    .map((worker) => worker.taskId);
  if (handling.length === 0 && workers.length === 0) {
    return { status: "recovered" };
  }
  return {
    status: "needs handling",
    handling,
    ...(workers.length > 0 ? { workers } : {}),
  };
}

/**
 * The published state's typed runtime state, or null when it published none.
 *
 * null is deliberately not an object with empty members: "this session had no
 * graph" and "no graph state was saved" are different facts, and only the
 * first may be acted on. Each field is carried only when the publication
 * actually had it.
 */
function runtimeStateOf(
  snapshot: NativeStateSnapshot
): RecoveredRuntimeState | null {
  if (!publishedRuntimeState(snapshot)) return null;
  return {
    ...(snapshot.assembly !== undefined ? { assembly: snapshot.assembly } : {}),
    ...(snapshot.toolResults !== undefined
      ? { toolResults: snapshot.toolResults }
      : {}),
    ...(snapshot.graphNodes !== undefined
      ? { graphNodes: snapshot.graphNodes }
      : {}),
    ...(snapshot.workers !== undefined ? { workers: snapshot.workers } : {}),
    ...(snapshot.terminal !== undefined ? { terminal: snapshot.terminal } : {}),
    ...(snapshot.runtimeFacts !== undefined
      ? { runtimeFacts: snapshot.runtimeFacts }
      : {}),
  };
}

const publishedRuntimeState = (snapshot: NativeStateSnapshot): boolean =>
  snapshot.assembly !== undefined ||
  snapshot.toolResults !== undefined ||
  snapshot.graphNodes !== undefined ||
  snapshot.workers !== undefined ||
  snapshot.terminal !== undefined ||
  snapshot.runtimeFacts !== undefined;

const unrestoredReport = (
  conversationId: string,
  status: RecoveryStatus
): SessionRecoveryReport => ({
  conversationId,
  status,
  messages: [],
  savedMessageCount: 0,
  operations: [],
  outcome: { state: "unknown", reason: "no_record" },
  runtime: null,
  operationFacts: null,
});

/** `ok` carries the value; anything else is the visible status to return. */
type Ok<T> = { readonly status: "ok"; readonly value: T };
type Step<T> = Ok<T> | { readonly status: RecoveryStatus };

/** Step 1+2: format identification, selection, and the post-anchor slice. */
async function readSelection(
  store: SessionStore,
  conversationId: string
): Promise<Step<RecoverySelection>> {
  let selection: Awaited<ReturnType<SessionStore["loadPublishedNativeState"]>>;
  try {
    selection = await store.loadPublishedNativeState({ id: conversationId });
  } catch (err) {
    const status = blockedFromLogError(err);
    if (status === null) throw err;
    return { status };
  }
  const { selected, anchorIndex } = selection;
  return {
    status: "ok",
    value: {
      newFormat: selection.newFormat,
      bodySha: selected === null ? null : selected.bodySha,
      // At or before the anchor the saved state already accounts for the
      // intent, so re-reporting it would claim progress the restore includes.
      intents: selection.fileIntents.filter((i) => i.anchorIndex > anchorIndex),
    },
  };
}

/** Step 3: load and validate the selected state, or fail closed on it. */
async function readBody(
  store: SessionStore,
  conversationId: string,
  bodySha: string
): Promise<Step<NativeStateSnapshot>> {
  try {
    return {
      status: "ok",
      value: await store.readPublishedNativeStateBody({
        id: conversationId,
        bodySha,
      }),
    };
  } catch (err) {
    const status = blockedFromBodyError(err, conversationId, bodySha);
    if (status === null) throw err;
    return { status };
  }
}

/** Step 4: the committed head chain, without the closeout backfill. */
async function readHeadChain(
  store: SessionStore,
  conversationId: string
): Promise<Step<HeadChain>> {
  try {
    const raw = await readFile(jsonlPath(store, conversationId), "utf8");
    const log = parseSessionJsonl(raw);
    const events = headChainEvents(log);
    return {
      status: "ok",
      value: {
        events,
        messages: projectSessionLog(log).messages,
        facts: onChainFacts(log.records, events),
      },
    };
  } catch (err) {
    // EXIT: a codec error classifies into a blocked reason; the store's own
    // re-projection is the fallback that disambiguates which one. A failure
    // outside the store's typed vocabulary is a real IO fault and PROPAGATES
    // — reporting EACCES or EISDIR as a damaged log sends the operator after
    // damage that is not there (the contract this file's JSDoc states).
    const reclassified =
      blockedFromLogError(err) ??
      blockedFromLogError(await restateStoreError(store, conversationId));
    if (reclassified === null && !isStoreTyped(err)) throw err;
    return {
      status: reclassified ?? {
        status: "blocked",
        reason: "session_log_corrupt",
        detail: `session ${conversationId} log is unreadable`,
      },
    };
  }
}

/** Whether `err` is already in the store's typed vocabulary. A raw filesystem
 *  `Error` is not: it carries a real fault, not a store verdict, so this is
 *  what separates "the store said no" from "the disk said no". */
const isStoreTyped = (err: unknown): boolean =>
  typeof err === "object" && err !== null && "kind" in err;

/** Re-projection through the store converts a codec error the local read could
 *  not classify into the store's own typed vocabulary. A success means the
 *  file is fine and the raw read failed for some other reason, which the
 *  caller judges against the original error. */
async function restateStoreError(
  store: SessionStore,
  conversationId: string
): Promise<unknown> {
  try {
    await store.loadPublishedNativeState({ id: conversationId });
    return null;
  } catch (err) {
    return err;
  }
}

/**
 * The three body failures keep three blocked reasons. Collapsing them would
 * let a damaged state read as an absent one — the silent fallback the spec
 * forbids.
 */
function blockedFromBodyError(
  err: unknown,
  conversationId: string,
  bodySha: string
): Extract<RecoveryStatus, { status: "blocked" }> | null {
  const e = err as SessionStoreError;
  if (e.kind === "not_found") {
    return {
      status: "blocked",
      reason: "published_state_body_missing",
      detail: `native state body ${bodySha} is absent for ${conversationId}`,
    };
  }
  if (e.kind === "parse_failed") {
    return {
      status: "blocked",
      reason: "published_state_body_corrupt",
      detail: e.reason,
    };
  }
  if (e.kind === "schema_invalid") {
    return {
      status: "blocked",
      reason: "published_state_body_schema_invalid",
      detail: `field ${e.field} of the published native state is invalid`,
    };
  }
  return null;
}

/**
 * `head` and `events` are the two fields the head-chain walk itself raises, so
 * a failure there is an unusable selected chain rather than a damaged
 * record — the two blocked reasons stay apart.
 */
function blockedFromLogError(
  err: unknown
): Extract<RecoveryStatus, { status: "blocked" }> | null {
  const e = err as SessionStoreError;
  if (e.kind === "parse_failed") {
    return {
      status: "blocked",
      reason: "session_log_corrupt",
      detail: e.reason,
    };
  }
  if (e.kind === "schema_invalid") {
    const chainFields = e.field === "head" || e.field === "events";
    return {
      status: "blocked",
      reason: chainFields ? "selected_head_invalid" : "session_log_corrupt",
      detail: `field ${e.field} of the session log is invalid`,
    };
  }
  return null;
}

interface HeadChain {
  readonly events: ReadonlyArray<SessionEventRecord>;
  readonly messages: ReadonlyArray<AnthropicLikeMessage>;
  /** On-chain `operation_fact` records in log order. Off-chain facts stay on
   *  disk and are not usable, exactly like every other ADR-0136 record. */
  readonly facts: ReadonlyArray<SessionOperationFactRecord>;
}

interface AnthropicLikeMessage {
  readonly role: string;
  readonly content: ReadonlyArray<Record<string, unknown>>;
}

/** `<sessionFolder>/<conversationId>.jsonl` — the same derivation
 *  `SessionStore` uses, through the same exported resolver, so this reader
 *  cannot be pointed at another session's folder. */
function jsonlPath(store: SessionStore, conversationId: string): string {
  return join(
    resolveConversationDir({
      projectDir: store.getProjectDir(),
      conversationId,
    }),
    `${conversationId}${SESSION_JSONL_EXT}`
  );
}

/** Operation facts whose anchor is on the selected chain, in file order. A
 *  fact recorded against another transcript is off-chain here for the same
 *  reason a rewound-away state is: this chain does not own it. */
function onChainFacts(
  records: ReadonlyArray<SessionTailRecord>,
  events: ReadonlyArray<SessionEventRecord>
): ReadonlyArray<SessionOperationFactRecord> {
  const onChain = new Set(events.map((event) => event.id));
  return records.filter(
    (record): record is SessionOperationFactRecord =>
      record.type === "operation_fact" && onChain.has(record.anchorEventId)
  );
}

/** tool_use ids the selected chain committed. A `file_intent` naming an id
 *  outside this set was recorded against another transcript. */
function onChainToolUseIds(
  events: ReadonlyArray<SessionEventRecord>
): ReadonlySet<string> {
  const out = new Set<string>();
  for (const event of events) {
    const content = event.message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      const b = block as { type?: unknown; id?: unknown };
      if (b.type === "tool_use" && typeof b.id === "string") out.add(b.id);
    }
  }
  return out;
}

/** Per-`toolUseId` settlement from the chain's own `tool_result` blocks; a
 *  later record for the same id wins, matching the append-only discipline of
 *  the other on-chain resolvers. Assistant text is never read as a settlement. */
function settlementMap(
  messages: ReadonlyArray<AnthropicLikeMessage>
): Map<string, ToolOperationSettlement> {
  const out = new Map<string, ToolOperationSettlement>();
  for (const message of messages) {
    for (const block of message.content) {
      const b = block as {
        type?: unknown;
        tool_use_id?: unknown;
        is_error?: unknown;
      };
      if (b.type !== "tool_result" || typeof b.tool_use_id !== "string") {
        continue;
      }
      out.set(
        b.tool_use_id,
        b.is_error === true ? "settled_error" : "settled_success"
      );
    }
  }
  return out;
}

/**
 * The restored turn's terminal posture. The turn is the saved state's own
 * `turnId` when it published one, else the last event the chain committed —
 * a missing record is UNKNOWN, never projected as completed (ADR-0126).
 * `projectTurnOutcomes` is the existing resolver: no turn-outcome logic is
 * reimplemented here.
 */
async function restoredOutcome(
  store: SessionStore,
  conversationId: string,
  snapshot: NativeStateSnapshot
): Promise<RestoredTurnOutcome> {
  const unknown: RestoredTurnOutcome = {
    state: "unknown",
    reason: "no_record",
  };
  let projected: Awaited<ReturnType<SessionStore["projectTurnOutcomes"]>>;
  try {
    projected = await store.projectTurnOutcomes(conversationId);
  } catch {
    // EXIT: the same log was read successfully a moment ago, so only a fault
    // ON it can land here — and UNKNOWN is the honest posture for a turn whose
    // outcome cannot be projected (ADR-0126: never a synthesized completion).
    // Throwing would discard an otherwise complete restore over one optional
    // annotation; the degraded value under-claims, which is the safe direction.
    return unknown;
  }
  const turnEventId =
    snapshot.turnId ??
    projected.messageEventIds[projected.messageEventIds.length - 1];
  if (turnEventId === undefined) return unknown;
  const record = projected.outcomes.get(turnEventId);
  if (record === undefined) return unknown;
  return { state: "settled", turnEventId, stopReason: record.stopReason };
}

const outstanding = (
  operations: ReadonlyArray<RecoveredFileOperation>
): boolean => operations.some((op) => op.needsOperatorAction);
