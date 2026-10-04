/**
 * `RuntimePersistenceBinder` host adapter (ADR-0136) — the JOIN between the
 * harness's persistence request vocabulary (src/shared/runtime-persistence.ts)
 * and the session store's ADR-0136 records. Without it the harness's loop,
 * graph, and worker publications are typechecked no-ops (plan-review finding
 * F1): nothing in the joined tree carried a runtime request to storage.
 *
 * The three jobs this adapter owns, and nothing else:
 *   1. translate the boundary vocabulary (one map, in the shared contract);
 *   2. resolve the host-owned inputs the request does not carry — the
 *      conversation's current head as the anchor;
 *   3. apply the publication gate, and turn the store's typed errors into the
 *      port's typed errors through the SAME mapping `createNativeStatePort`
 *      uses, so no consumer learns a second error dialect.
 *
 * It owns NO persistence of its own: every call lands on `SessionStore`, the
 * one writer per session file (ADR-0110). `NativeStatePort` stays exactly as
 * it is — the harness's file-intent recorder and the CLI resume/rollback
 * path's port, a different job on the same store.
 *
 * A rejection is never swallowed, retried, or degraded into an unpersisted
 * turn: the caller must not start the execution that depends on it.
 */
import { createHash } from "node:crypto";
import {
  NativeStatePortError,
  toNativeStateBoundary,
  type NativeStateMessage,
  type NativeStateSnapshot,
} from "../../shared/native-state-port.js";
import type {
  RuntimeGraphNodeFact,
  RuntimeOperationFact,
  RuntimePersistenceBinder,
  RuntimePersistenceSink,
  RuntimeSavedStateRequest,
  RuntimeWorkerFact,
} from "../../shared/runtime-persistence.js";
import { asPortError } from "./native-state-port-host.js";
import type { SessionStore } from "./session-store.js";

export interface RuntimePersistenceHostDeps {
  readonly store: SessionStore;
  /**
   * Run `work` inside the host's EXISTING per-session writer queue (ADR-0110).
   * MUST be re-entrant: when the caller already holds the queue slot for this
   * conversation, run the work INLINE. The hub runs a whole turn inside that
   * slot, so a publication issued from inside a turn arrives while it is
   * already held — a non-re-entrant implementation deadlocks there. This
   * adapter takes no second lock and opens no second journal.
   */
  readonly serialize: <T>(
    conversationId: string,
    work: () => Promise<T>
  ) => Promise<T>;
  /**
   * SC23 publication gate. False for a session this host did not create
   * (legacy / old-format, `--resume`): its bytes must stay untouched. False is
   * a skip, not an error — such a session is not this host's to write.
   */
  readonly shouldPublish: (
    conversationId: string
  ) => boolean | Promise<boolean>;
  /** Aborted when the host is going down abnormally. */
  readonly signal?: AbortSignal;
}

/** The host capabilities one unit of persistence work needs. Grouped so each
 *  operation takes one context instead of four loose dependencies. */
interface PersistenceContext {
  readonly store: SessionStore;
  readonly shouldPublish: RuntimePersistenceHostDeps["shouldPublish"];
  readonly signal: AbortSignal | undefined;
}

/**
 * The binder over one real store. `conversationId` is the store's session id
 * — the same identity the transcript is keyed by, so this seam needs no
 * separate routing vocabulary.
 */
export function createRuntimePersistenceBinder(
  deps: RuntimePersistenceHostDeps
): RuntimePersistenceBinder<NativeStateMessage> {
  const context: PersistenceContext = {
    store: deps.store,
    shouldPublish: deps.shouldPublish,
    signal: deps.signal,
  };
  return {
    bind(
      sessionId: string | undefined
    ): RuntimePersistenceSink<NativeStateMessage> | undefined {
      // "No session" and "not wired" take the same no-op path, so a caller
      // never has to tell them apart; a blank id is not a session.
      if (typeof sessionId !== "string" || sessionId.trim().length === 0) {
        return undefined;
      }
      return {
        publishSavedState: (request) =>
          serialized(deps.serialize, context, sessionId, () =>
            publishSavedState(context, sessionId, request)
          ),
        appendOperationFact: (fact) =>
          serialized(deps.serialize, context, sessionId, () =>
            appendOperationFact(context, sessionId, fact)
          ),
      };
    },
  };
}

/** Run one unit of persistence work inside the host's writer queue. The abort
 *  is checked BEFORE the queue is touched, so a going-down host fails fast
 *  instead of waiting behind a turn that will never finish writing. */
async function serialized<T>(
  serialize: RuntimePersistenceHostDeps["serialize"],
  context: PersistenceContext,
  conversationId: string,
  work: () => Promise<T>
): Promise<T> {
  return serialize(conversationId, async () => {
    if (context.signal?.aborted === true) throw aborted(conversationId);
    return work();
  });
}

async function publishSavedState(
  context: PersistenceContext,
  conversationId: string,
  request: RuntimeSavedStateRequest<NativeStateMessage>
): Promise<void> {
  if (!(await context.shouldPublish(conversationId))) return;
  const boundary = toNativeStateBoundary(request.boundary);
  const anchorEventId = await readHeadOrSkip(context, conversationId, request);
  if (anchorEventId === null) return;
  try {
    await context.store.appendNativeState({
      id: conversationId,
      anchorEventId,
      boundary,
      snapshot: snapshotFor(request, boundary),
    });
  } catch (err) {
    throw asPortError(err, conversationId, "publishSavedState");
  }
}

/**
 * Facts are appended in ARRIVAL order and are never buffered, reordered, or
 * merged across a publication: the append position is the fact's association
 * with the state it follows, so reordering it would make the fact claim a base
 * state that already contains its result.
 */
async function appendOperationFact(
  context: PersistenceContext,
  conversationId: string,
  fact: RuntimeOperationFact<NativeStateMessage>
): Promise<void> {
  if (!(await context.shouldPublish(conversationId))) return;
  const turnId = fact.kind === "tool_result" ? fact.turnId : undefined;
  try {
    await context.store.appendOperationFact({
      id: conversationId,
      factId: factIdFor(fact),
      fact,
      ...(turnId === undefined ? {} : { turnId }),
    });
  } catch (err) {
    throw asPortError(err, conversationId, "appendOperationFact");
  }
}

/**
 * The anchor is the conversation's persisted head — the only event id
 * guaranteed to be on the selected chain, and never a synthetic one: a state
 * anchored to nothing would be a record no reader could resolve.
 *
 * WHY a missing head SKIPS rather than failing: the only path that reaches a
 * headless publication is a silent host wake as the session's very first
 * activity. The hub deliberately does not pre-commit a wake's digest — so a
 * wake that never reaches the model leaves the session empty — while the
 * harness still treats that digest as accepted text and publishes at the input
 * boundary. Skipping loses nothing: the same context is published at the next
 * boundary, which by then has a real anchor, and a session with no committed
 * event has no transcript worth recovering. A session that HAS a head is the
 * opposite case — the anchor resolves, and every failure past that point is a
 * real `PERSIST_FAILED` that blocks the dependent execution.
 */
async function readHeadOrSkip(
  context: PersistenceContext,
  conversationId: string,
  request: RuntimeSavedStateRequest<NativeStateMessage>
): Promise<string | null> {
  let head: string | null;
  try {
    head = await context.store.readHead(conversationId);
  } catch (err) {
    throw asPortError(err, conversationId, "readHead");
  }
  if (head !== null) return head;
  if (context.signal?.aborted === true) {
    throw new NativeStatePortError(
      "PERSIST_FAILED",
      `publishSavedState failed for ${conversationId} at the ${request.boundary} boundary: the host is shutting down`,
      {
        boundary: request.boundary,
        conversationId,
        operation: "publishNativeState",
      }
    );
  }
  return null;
}

/** The published snapshot. Optional inputs stay ABSENT rather than becoming
 *  `field: undefined`: absent is what the record round-trip and the validator
 *  both read as "this run resolved none". A `turnId: null` request means the
 *  turn identity is not known yet, which is exactly the absent case. */
function snapshotFor(
  request: RuntimeSavedStateRequest<NativeStateMessage>,
  boundary: NativeStateSnapshot["boundary"]
): NativeStateSnapshot {
  return withoutUndefined({
    boundary,
    messages: request.messages,
    turnId: request.turnId === null ? undefined : request.turnId,
    assembly: request.assembly,
    terminal: request.terminal,
    toolResults: request.toolResults,
    graphNodes: request.graphNodes,
    workers: request.workers,
  });
}

/** Drop keys whose value is `undefined`, leaving every other key untouched —
 * the spread-discipline the JSONL record layer round-trips byte-stably. */
function withoutUndefined<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined)
  ) as T;
}

/** A fact's durable identity, derived from the EVENT rather than from the
 *  (entity, state) pair it describes.
 *
 *  WHY not the pair: the store drops a repeated id and a reader reads an
 *  entity's last fact as its current state, so a pair-shaped id silently
 *  discards a second REAL transition to the same state. The expensive case is a
 *  worker: a resume deliberately reuses the same `taskId` for a NEW process
 *  (subagent manager), so the resumed worker's `starting`/`running` were dropped
 *  and the previous round's terminal state stood as the answer while the worker
 *  was live.
 *
 *  The discriminator is the one the fact already carries, so it is an
 *  observation rather than a minted value: the OS process identity for a worker
 *  (identity is captured before any state is appended, so every real fact has
 *  one) and the settled payload for a graph node (the ledger permits a second
 *  freeze of one id — "last write wins" for back-edges). Two appends of ONE
 *  event derive the same id and dedupe; two distinct events do not collide. */
function factIdFor(fact: RuntimeOperationFact<NativeStateMessage>): string {
  if (fact.kind === "tool_result") return `tool_result:${fact.toolUseId}`;
  if (fact.kind === "graph_node")
    return `graph_node:${fact.nodeId}:${fact.status}:${settledPayloadOf(fact)}`;
  return `worker_progress:${fact.taskId}:${fact.state}:${processIdentityOf(fact)}`;
}

/**
 * The settled payload's short digest, or `-` for a fact that carries none
 * (`running` / `skipped` settle without output). Two freezes of one node that
 * disagree about the output are two events and must both land; a retried append
 * of one freeze repeats its payload and dedupes.
 */
function settledPayloadOf(fact: RuntimeGraphNodeFact): string {
  const payload = fact.status === "done" ? fact.output : fact.error;
  if (payload === undefined) return "-";
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

/**
 * `pid` + `/proc` start time, the same pair `RuntimeWorkerProcessIdentity`
 * carries, with a null start time spelled out rather than dropped so it cannot
 * collide with a real value. An absent identity keeps the pair-shaped id: with
 * no instance discriminator in the payload there is nothing that tells a retried
 * append from a second round, and the producer records the identity before it
 * appends any state, so this is the unrecorded case rather than the resumed one.
 */
function processIdentityOf(fact: RuntimeWorkerFact): string {
  const process = fact.process;
  if (process === undefined) return "no-process";
  return `${process.pid}/${process.startTime === null ? "unknown" : process.startTime}`;
}

function aborted(conversationId: string): NativeStatePortError {
  return new NativeStatePortError(
    "PERSIST_FAILED",
    `persistence aborted for ${conversationId}`
  );
}
