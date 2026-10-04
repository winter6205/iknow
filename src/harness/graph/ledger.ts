/**
 * Live-graph ledger: host-held record of which graph nodes have settled, so
 * finished work is never re-run.
 *
 * Authority: `docs/adr/0047-live-graph-session-authority.md` — the "done stays
 * done" guarantee for long-running graphs comes from this session state, not
 * from the model's memory of the transcript. Single authority within
 * harness/graph: session-api / cli only hold or destroy the ledger, they do
 * not implement ledger logic.
 *
 * Lifecycle:
 *   1. **Creation**: `ensure()` is called after the first `run_graph`'s
 *      `nodes` pass `validateGraph`; `exists()` is false before that. A failed
 *      validation leaves no trace — `ledgerFor` lazily creates the object, but
 *      `exists()` stays false and the frozen set stays empty. The one other
 *      caller is the restore seed (below), which only creates a ledger for a
 *      session that already ran a graph.
 *   2. **Survives the overlay**: closing and reopening graph mode keeps the
 *      same ledger for the same conversation — `LiveGraphLedger` hangs beside
 *      `GraphModeContext` on the session runtime, not inside a `GraphAssembly`
 *      snapshot.
 *   3. **reset / session end**: `destroy()` clears the frozen set and the
 *      existence flag; called by `/reset` (CLI), `resetSession` (hub), process
 *      exit, and `hub.shutdown`. Old ids may really spawn again afterwards.
 *   4. **Compaction keeps it**: the ledger is an in-process object; compact
 *      only rewrites the transcript, so the frozen set is untouched.
 *
 * Freeze semantics: `freeze(id, status)` accepts only `done` and `failed` —
 * `skipped` and never-run ids are not frozen (NodeOutcome freeze = last
 * settled outcome is done or failed). `isFrozen(id)` is the typed-rejection
 * basis for the `run_graph` handler before any spawn (zero spawn, same class
 * as invalid-topology rejection).
 *
 * Process death / cross-process resume: the ledger is not persisted to JSONL.
 * What survives a kill is the session's DURABLE graph facts, and
 * `seedRestoredGraphNodes` folds those back into this in-memory ledger at
 * session open — so "done stays done" now crosses the process boundary
 * through the durable fact stream instead of dying with the process. The seed
 * is in-memory only: it writes no record, restores no process, and its
 * verdict is rebuilt from the log by every later open.
 *
 * `LiveGraphLedgerHost` is a thin per-conversationId resolver: one hub's many
 * session ledgers are created and destroyed through it; single-session entry
 * points (CLI / one-shot calls) use the same host with just one id.
 *
 * Boundary: this module does not import loop-engine / build-engine /
 * session-api.
 */

/** Terminal statuses — the basis for freezing. */
export type FrozenTerminal = "done" | "failed";

/**
 * All statuses a settlement may carry. The only producer is the settled value
 * of `GraphNodeResult.status` (done / failed / skipped) — "running" /
 * "pending" are mid-scheduling states with no producer feeding freeze, so
 * they stay out of this union.
 */
export type SettleStatus = FrozenTerminal | "skipped";

/** Enforced centrally: only terminal statuses enter the frozen set. */
const TERMINAL_STATUSES: ReadonlySet<string> = new Set(["done", "failed"]);

export interface LiveGraphLedger {
  /** Whether the ledger has been created (true after first `ensure()`, false again after destroy). */
  readonly exists: () => boolean;
  /**
   * First call creates the ledger (deferred until `validateGraph` passes);
   * later calls are idempotent no-ops. Must never be called on the
   * validation-failure path.
   */
  readonly ensure: () => void;
  /**
   * Record one settled terminal status. `done` / `failed` freeze; `skipped` is
   * silently ignored. Repeated freezes of the same id: the last write wins
   * (converges for future re-write scenarios such as back-edges).
   *
   * `output` carries the data for residual-subgraph merging: when status is
   * done and a string is passed, it is stored for `outputOf`; failed /
   * skipped / absent → the old output is cleared so outputs always match the
   * last status.
   *
   * Accepts `SettleStatus` (not just terminals) so the handler can pass
   * `GraphNodeResult.status` through directly — "skipped does not freeze" is
   * enforced here, not by each caller filtering.
   */
  readonly freeze: (id: string, status: SettleStatus, output?: string) => void;
  /** Whether the id is frozen by a done/failed terminal — handler's typed-rejection check. */
  readonly isFrozen: (id: string) => boolean;
  /** Frozen status of the id; undefined when not frozen. Residual merging uses it to tell done from failed. */
  readonly statusOf: (id: string) => FrozenTerminal | undefined;
  /**
   * Output recorded when the id froze as done; undefined when not frozen or
   * not done. Data source for residual-subgraph merging: when a later segment
   * omits already-done upstream nodes, the host writes their output into
   * downstream node tasks.
   */
  readonly outputOf: (id: string) => string | undefined;
  /** Snapshot of all currently frozen ids, in first-freeze order (stable for test assertions). */
  readonly frozenIds: () => ReadonlyArray<string>;
  /** Destroy: clears the frozen set and existence flag. Called on session end / reset. */
  readonly destroy: () => void;
}

export function createLiveGraphLedger(): LiveGraphLedger {
  let created = false;
  // Map (not Record) keeps insertion order and makes isFrozen O(1); no
  // `frozen` boolean is stored — membership alone implies a terminal status,
  // and the status field stays for re-write scenarios such as back-edges.
  const frozen = new Map<string, FrozenTerminal>();
  // Outputs of done-frozen nodes, so later segments can read upstream
  // results. Only written when the freeze caller passes output and status is done.
  const outputs = new Map<string, string>();
  const ledger: LiveGraphLedger = {
    exists: () => created,
    ensure: () => {
      if (created) return;
      created = true;
    },
    freeze: (id, status, output) => {
      if (!created) return;
      if (!TERMINAL_STATUSES.has(status)) return;
      frozen.set(id, status as FrozenTerminal);
      if (status === "done" && typeof output === "string") {
        outputs.set(id, output);
      } else {
        outputs.delete(id);
      }
    },
    isFrozen: (id) => frozen.has(id),
    statusOf: (id) => frozen.get(id),
    outputOf: (id) => outputs.get(id),
    frozenIds: () => [...frozen.keys()],
    destroy: () => {
      created = false;
      frozen.clear();
      outputs.clear();
    },
  };
  return Object.freeze(ledger);
}

/**
 * Multi-session ledger resolver (for hubs). `ledgerFor` lazily creates one
 * ledger per conversationId on first access; repeated lookups return the same
 * object. `destroy` drops one session's ledger (reset); `destroyAll` drops
 * every ledger (hub.shutdown / process exit).
 *
 * Single-session entry points (CLI / handler-direct tests) use the same host;
 * `destroyAll` is usually backstopped by process exit (objects get GC'd even
 * without an explicit shutdown hook).
 *
 * An `undefined` conversationId (stub / direct-call paths where
 * `ctx.conversationId` is absent) falls back to a shared "anonymous" ledger —
 * observable behaviour, freeze semantics never silently dropped. Compatible
 * with "no ledger before the first accepted graph": tools skip ledger logic
 * entirely until the host is instantiated and a handler really runs.
 */
export interface LiveGraphLedgerHost {
  /** Get a ledger; same id always returns the same object. `undefined` uses the shared anonymous ledger. */
  readonly ledgerFor: (conversationId: string | undefined) => LiveGraphLedger;
  /** Destroy one session's ledger (reset / session end). Missing id → no-op. */
  readonly destroy: (conversationId: string) => void;
  /** Destroy all ledgers (hub.shutdown / process exit). */
  readonly destroyAll: () => void;
  /** Test-observable: number of created session ledgers (anonymous singleton excluded). */
  readonly size: () => number;
}

/**
 * One node as the restored facts state it. Deliberately structural: the
 * recovery reader's own per-node view satisfies it without harness/graph
 * importing session-api (the boundary above), so the two sides cannot drift
 * through an adapter that could be wrong in either direction.
 *
 * The two arms are the whole contract: a node whose LAST anchored fact is
 * `done`/`failed` is settled and must not be dispatched again; a node whose
 * last fact is `running` was dispatched with an unknown outcome, so it is
 * neither settled nor failed and stays resolvable for an explicit next call.
 */
export type RestoredGraphNodeView =
  | {
      readonly nodeId: string;
      readonly state: "settled";
      /** `done` / `failed` freeze; `skipped` was never dispatched and does
       *  not freeze — the same rule a live settlement obeys. */
      readonly status: SettleStatus;
      /** Output a downstream node needs; absent = recorded status only. */
      readonly output?: string;
    }
  | {
      readonly nodeId: string;
      readonly state: "in_flight";
      /** Always "unknown": an interrupted dispatch has no outcome to report. */
      readonly outcome: "unknown";
    };

/**
 * Fold a restored session's per-node view into the live ledger, in memory
 * only. This is the seam that makes durable graph state reach dispatch: the
 * handler's `isFrozen` check and the residual-subgraph merge already refuse to
 * re-run a frozen id, so seeding turns the restored facts into exactly the
 * behaviour an in-process settlement produces — a settled node is not
 * re-dispatched, and its `done` output is threaded into downstream tasks that
 * omit it.
 *
 * Why seed at session open rather than consult the restored view at each
 * dispatch: the ledger is keyed by `conversationId` and outlives a worktree
 * rebind, so a seeded verdict survives the engine rebuild a rebind performs
 * (the chat path deliberately does not rewire the ledger there), whereas a
 * per-dispatch view would have to be re-supplied to every rebuilt engine. One
 * seeding point, one owner, no second rule.
 *
 * In-flight nodes are deliberately NOT frozen: an interrupted dispatch has an
 * unknown outcome, and freezing it would either bar a real rescue submission
 * or read as a failure that never happened.
 *
 * Idempotent: `freeze` is last-write-wins per id, so re-running this for the
 * same view converges instead of accumulating.
 */
export function seedRestoredGraphNodes(
  ledger: LiveGraphLedger | undefined,
  nodes: ReadonlyArray<RestoredGraphNodeView>
): void {
  // No ledger = no live graph on this surface: stay a no-op rather than
  // inventing a container for a verdict nothing will read.
  if (ledger === undefined || nodes.length === 0) return;
  // Restored facts prove this session ran a graph, which is the same fact
  // `ensure()` records for a first validated call — and `freeze` is inert
  // until the ledger exists.
  ledger.ensure();
  for (const node of nodes) {
    if (node.state !== "settled") continue;
    ledger.freeze(node.nodeId, node.status, node.output);
  }
}

export function createLiveGraphLedgerHost(): LiveGraphLedgerHost {
  const byConv = new Map<string, LiveGraphLedger>();
  const anonymous = createLiveGraphLedger();
  const host: LiveGraphLedgerHost = {
    ledgerFor: (conversationId) => {
      if (conversationId === undefined) return anonymous;
      let ledger = byConv.get(conversationId);
      if (ledger === undefined) {
        ledger = createLiveGraphLedger();
        byConv.set(conversationId, ledger);
      }
      return ledger;
    },
    destroy: (conversationId) => {
      const ledger = byConv.get(conversationId);
      if (ledger !== undefined) {
        ledger.destroy();
        byConv.delete(conversationId);
      }
    },
    destroyAll: () => {
      for (const ledger of byConv.values()) {
        ledger.destroy();
      }
      byConv.clear();
      anonymous.destroy();
    },
    size: () => byConv.size,
  };
  return Object.freeze(host);
}
