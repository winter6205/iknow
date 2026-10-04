/**
 * The `run_graph` ACI tool — the orchestration entry, exposed only when graph mode is on.
 *
 * Division of labor with `spawn_subagent`: `spawn_subagent` hands off one
 * task; `run_graph` hands off an entire dependency graph at once. The
 * parent agent declares a DAG and the host runs `validateGraph` →
 * `topoWaves` (inside `runGraph`) → `createSubAgentNodeExecutor`; nodes are
 * still foreground spawns (ADR-0014), so concurrency uses the manager's
 * global configurable hard cap (default 15) — no separate per-graph budget.
 *
 * Exit gates:
 *   - invoked while graph mode is off (same-round flag flip / model
 *     hallucination) → `ToolExecutionError`, zero spawns. The assembly
 *     layer already filters the tool out of promptTools by snapshot; this
 *     is the second gate.
 *   - invalid topology (cycle / self-dep / unknown dep / duplicate id) →
 *     `ToolExecutionError`, likewise zero spawns — validation completes
 *     before any `manager.spawn`.
 *   - on a graph with failure edges, once the same id exceeds the executor
 *     entry threshold the effort fuse trips (`effort-fuse.ts`): done results
 *     freeze first, then the whole call is rejected with a typed error —
 *     the same channel as a mid-run violation.
 *
 * Node-level failure is data, not an exception: `runGraph` marks the
 * downstream of a failed node as skipped, independent branches keep running,
 * and the call returns one condensed report so the parent agent decides how
 * to wrap up.
 */

import type { AciToolDef } from "../aci/types.js";
import type { ToolExecutionContext } from "../tools/types.js";
import type { SubAgentManager } from "../subagent/manager.js";
import { ToolExecutionError } from "../errors.js";
import { safeEmitStream } from "../stream.js";
import type { GraphProgressSnapshot } from "./progress.js";
import { createGraphProgressTracker } from "./progress.js";
import { validateGraph, type GraphValidationError } from "./topo.js";
import { formatNodeError } from "./error-render.js";
import { runGraph } from "./scheduler.js";
import { runGraphWithFailureEdges } from "./outcome-scheduler.js";
import type { FailureEdgeViolation } from "./outcome-scheduler.js";
import { createSubAgentNodeExecutor } from "./node-executor.js";
import type { LiveGraphLedger, LiveGraphLedgerHost } from "./ledger.js";
import type {
  RuntimeGraphNodeFact,
  RuntimePersistenceBinder,
  RuntimePersistenceSink,
} from "../../shared/runtime-persistence.js";
import type { AnthropicNativeMessage } from "../model-adapter/types.js";
import { resolveResidualSubgraph } from "./residual.js";
import { validateOnFailureEdges } from "./on-failure.js";
import { createEffortFuse } from "./effort-fuse.js";
import { EFFORT_FUSE_THRESHOLD } from "./effort-threshold.js";
import type {
  GraphExecution,
  GraphNodeResult,
  GraphSpec,
  NodeContext,
  NodeExecutor,
  NodeOutcome,
} from "./types.js";

export interface RunGraphToolDeps {
  readonly manager: SubAgentManager;
  /**
   * This round's graph assembly snapshot (`GraphAssembly.enabled`).
   *
   * The tool surface is now always resident; whether a call is admitted is
   * decided solely by this gate. **Absent = always off** (the handler
   * rejects with a typed error, zero spawns) — the fail-closed stance.
   * Tests constructing the tool directly must pass an explicit isEnabled to
   * reach the handler; production assembly injects graphAssembly.enabled
   * via build-engine.
   */
  readonly isEnabled?: () => boolean;
  /**
   * Live-graph ledger host (ADR-0047). Resolves the per-conversation ledger
   * by `ctx.conversationId`: the first call that passes validation creates
   * it via `ensure()`; after settle, terminal nodes freeze as done/failed
   * (skipped does not freeze); resubmitting a frozen id → typed rejection,
   * zero spawns. **Absent = no ledger** — behavior is byte-identical to the
   * ledger-free path (ask / direct-call tests / callers not wired to a live
   * graph see no change).
   */
  readonly ledger?: LiveGraphLedgerHost;
  /**
   * Session-checkpoint plan B: runtime persistence seam. The handler resolves
   * it per `ctx.conversationId` and records node transitions through it, so a
   * restarted process does not re-run settled nodes. Absent → no facts
   * recorded, ledger behavior unchanged.
   */
  readonly runtimePersistence?: RuntimePersistenceBinder<AnthropicNativeMessage>;
}

/** A single node as declared by the model (schema maps one-to-one to this shape). */
interface RunGraphNodeInput {
  readonly id: string;
  readonly task: string;
  readonly deps?: ReadonlyArray<string>;
  /**
   * Marked failure edge (single endpoint). The target must be some id in
   * this `nodes` batch; targeting self = a marked single-cell re-entry,
   * legal. Runtime semantics (traversed only from `failed`, never from
   * `done`) belong to the scheduler.
   */
  readonly onFailure?: string;
}

/**
 * `onFailure` is upgraded from "failure markers rejected" (an earlier
 * now-superseded rule) to a declared attribute: legal forms (target within
 * batch's ids) pass readNodes + the validation layer; illegal forms (value
 * not a string, target unknown or frozen) get a typed rejection, zero
 * spawns. The scheduler is what later walks the edge per NodeOutcome.
 *
 * The tool description must teach the model the live-graph ledger's
 * residual-subgraph semantics:
 *   (a) submit only the nodes that still need to run (residual subgraph) —
 *       never resubmit terminal ids;
 *   (b) ids already done / failed are frozen; resubmitting them gets a
 *       typed rejection;
 *   (c) deps pointing at already-done upstreams may omit that upstream node
 *       — the host merges the ledger and threads the upstream output into
 *       downstream tasks;
 *   (d) after a caller-side cancel (abort), done ids stay frozen on the
 *       ledger, unfinished ids can be resubmitted in the next residual
 *       subgraph.
 *
 * The schema accepts `onFailure`; `wait:false` is still unrecognized and
 * gated by schema and handler; the description text guides positively and
 * describes only capabilities and boundaries.
 */
const DESCRIPTION =
  "Run several sub-agent tasks as one dependency graph in a single call. " +
  "Use it when a single turn needs ordered sub-agent work whose pieces " +
  "depend on each other, so results flow between tasks; for a single task, " +
  "or for several tasks with no ordering between them, use " +
  "`spawn_subagent` instead — a graph with no edges buys nothing over " +
  "parallel spawns. Use `graph mode on` so the call is admitted. Declare each " +
  "node with an `id`, a self-contained `task`, and the `deps` it must wait " +
  "for. Nodes whose dependencies are all satisfied run in parallel; a node " +
  "starts only after every node it depends on finished, and sees those " +
  "results. If a node fails, the nodes downstream of it are skipped and " +
  "unrelated branches keep running. The call blocks until the whole graph " +
  "settles and returns one condensed report of every node. The harness " +
  "maintains a live-graph ledger across calls: submit only the nodes that " +
  "still need to run as a residual subgraph — ids already frozen as done " +
  "or failed are rejected on resubmission; deps pointing at already-done " +
  "ids from earlier calls may omit those nodes and the host merges the " +
  "ledger to thread their outputs into downstream tasks. After a cancel, " +
  "only the done ids stay frozen, and unfinished ids can be re-submitted " +
  "in the next residual subgraph. Each node may also declare a marked " +
  "failure edge with `onFailure`: the id of the single node to start once " +
  "when this node finishes with status `failed`; the host traverses the " +
  "failure edge only from `failed` nodes — a node that finishes as `done` " +
  "or `skipped` leaves its failure edge unused. Failure-edge targets must " +
  "be ids in the same submission (pointing at the same id is allowed as a " +
  "marked single-cell re-entry); targets that are missing from the " +
  "submission or already frozen on the ledger are rejected. " +
  "Only available when graph mode is on; calling it while graph mode is " +
  "off returns a tool execution error.";

function describeValidationError(err: GraphValidationError): string {
  switch (err.kind) {
    case "unknown-dep":
      return `node "${err.node}" depends on unknown node "${err.dep}"`;
    case "self-dep":
      return `node "${err.node}" depends on itself`;
    case "duplicate-id":
      return `duplicate node id "${err.id}"`;
    case "cycle":
      return `cycle detected involving nodes: ${err.involved.join(", ")}`;
  }
}

/** Defensive arg reading: ajv strict already checks the shape; this guards the direct-handler-call path.
 *
 * Both gates align strictly with inputSchema:
 *   - root: any key other than `nodes` (including undeclared fields like
 *     `wait`) → typed rejection, zero spawns. `onFailure` is allowed only
 *     at the node level.
 *   - node: any key other than `id` / `task` / `deps` / `onFailure` → typed
 *     rejection, zero spawns. `onFailure` is a declared field; target
 *     validation (unknown / frozen) is a separate pass the handler runs
 *     after schema/readNodes succeed (kept distinct from the shape gate).
 */
const ROOT_KEYS: ReadonlySet<string> = new Set(["nodes"]);
const NODE_KEYS: ReadonlySet<string> = new Set([
  "id",
  "task",
  "deps",
  "onFailure",
]);

function readNodes(input: unknown): ReadonlyArray<RunGraphNodeInput> {
  const obj = (input ?? {}) as Record<string, unknown>;
  // Root: reject undeclared keys (including `wait` — there is no wait:false on the graph).
  for (const key of Object.keys(obj)) {
    if (!ROOT_KEYS.has(key)) {
      throw new ToolExecutionError(
        `run_graph: unknown root property \`${key}\` (only \`nodes\` is accepted)`
      );
    }
  }
  const raw = obj.nodes;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ToolExecutionError(
      "run_graph: `nodes` must be a non-empty array"
    );
  }
  // Complexity 14 was already over the threshold on master before this
  // change (which only touches the description string); extracting a
  // function is a separate task — scope-disable so lint does not block commits.
  // eslint-disable-next-line complexity -- baseline: pre-existing on master
  return raw.map((entry, i) => {
    const node = (entry ?? {}) as Record<string, unknown>;
    // Node: reject undeclared keys (`onFailure` is already a declared field).
    for (const key of Object.keys(node)) {
      if (!NODE_KEYS.has(key)) {
        throw new ToolExecutionError(
          `run_graph: node[${i}] has unknown property \`${key}\` (only \`id\`, \`task\`, \`deps\`, \`onFailure\` are accepted)`
        );
      }
    }
    const id = node.id;
    const task = node.task;
    if (typeof id !== "string" || id.length === 0) {
      throw new ToolExecutionError(`run_graph: node[${i}] has no valid \`id\``);
    }
    if (typeof task !== "string" || task.length === 0) {
      throw new ToolExecutionError(
        `run_graph: node "${id}" has no valid \`task\``
      );
    }
    const deps = node.deps;
    if (deps !== undefined && !Array.isArray(deps)) {
      throw new ToolExecutionError(
        `run_graph: node "${id}" has a non-array \`deps\``
      );
    }
    const onFailure = node.onFailure;
    if (onFailure !== undefined && typeof onFailure !== "string") {
      // onFailure must be a string; arrays, numbers, and other non-string
      // values are the only way a JSON object can smuggle in "two failure
      // edges" or a malformed shape — the schema's primary contract is
      // type:"string", and this rejects the direct-call path. Zero spawns.
      throw new ToolExecutionError(
        `run_graph: node "${id}" has a non-string \`onFailure\` (only a string target id is accepted)`
      );
    }
    return {
      id,
      task,
      deps: (deps as ReadonlyArray<string> | undefined) ?? [],
      ...(onFailure !== undefined ? { onFailure } : {}),
    };
  });
}

/** Condensed report: the parent agent needs who succeeded, who failed, and what each produced — not execution detail. */
function condense(
  nodes: ReadonlyArray<RunGraphNodeInput>,
  results: Readonly<Record<string, GraphNodeResult>>,
  waveCount: number
): string {
  return JSON.stringify({
    waveCount,
    nodes: nodes.map((n) => {
      const r = results[n.id];
      if (r === undefined) return { id: n.id, status: "pending" };
      if (r.status === "done") {
        return { id: n.id, status: "done", output: String(r.output ?? "") };
      }
      if (r.status === "failed") {
        return { id: n.id, status: "failed", error: r.error };
      }
      return { id: n.id, status: "skipped", reason: r.reason };
    }),
  });
}

/**
 * Dependency outputs flow along edges: a downstream node is a fresh session
 * in its own process and cannot see upstream messages, so upstream results
 * must be written into its task text for "depends on" to mean anything.
 * Nodes without deps pass through unchanged (task bytes identical to a
 * single `spawn_subagent`).
 */
function renderTask(node: RunGraphNodeInput, ctx: NodeContext): string {
  const deps = node.deps ?? [];
  if (deps.length === 0) return node.task;
  const sections = deps.flatMap((dep) => {
    const output = ctx.outputs[dep];
    return output === undefined
      ? []
      : [`### ${dep}\n${typeof output === "string" ? output : String(output)}`];
  });
  if (sections.length === 0) return node.task;
  return `${node.task}\n\n## Results from the tasks this one depends on\n\n${sections.join("\n\n")}`;
}

function emitGraphProgress(
  ctx: ToolExecutionContext | undefined,
  snapshot: GraphProgressSnapshot | null
): void {
  safeEmitStream(ctx?.onStream, { type: "graph_progress", snapshot });
}

/**
 * Merge two local AbortSignals: if either aborts → the returned signal
 * aborts; both absent → undefined. Hand-rolled listener composition rather
 * than `AbortSignal.any` — that static method needs Node ≥ 20.3 while
 * package.json engines only guarantees `>=20`. No leak risk in the composed
 * controller: the scheduler's lifetime = this handler invocation, so
 * listeners are GC'd with the controller.
 */
function combineAbortSignals(
  a: AbortSignal | undefined,
  b: AbortSignal | undefined
): AbortSignal | undefined {
  if (a === undefined && b === undefined) return undefined;
  if (a === undefined) return b;
  if (b === undefined) return a;
  if (a.aborted) return a;
  if (b.aborted) return b;
  const controller = new AbortController();
  for (const s of [a, b]) {
    s.addEventListener("abort", () => controller.abort(), { once: true });
  }
  return controller.signal;
}

/**
 * Residual-subgraph merge: fold the ledger before validateGraph — a
 * frozen-done dep counts as satisfied and is removed from deps (its output
 * is brought back separately and merged into nodeCtx.outputs so renderTask
 * writes it into downstream tasks); a frozen-failed dep → typed rejection;
 * resubmitting a frozen id → typed rejection, whole submission refused.
 * Everything beyond the merge — topology / duplicates / cycles / self-deps
 * — stays validateGraph's single authority (freeze logic must not leak into
 * Kahn).
 *
 * Ledger absent → zero behavior change: nodes pass through, no ledger
 * outputs.
 */
function mergeResidual(
  nodes: ReadonlyArray<RunGraphNodeInput>,
  ledger: LiveGraphLedger | undefined
): {
  readonly specNodes: ReadonlyArray<{
    readonly id: string;
    readonly deps: ReadonlyArray<string>;
    readonly onFailure?: string;
  }>;
  readonly ledgerOutputs: Readonly<Record<string, string>>;
} {
  if (ledger === undefined) {
    return {
      specNodes: nodes.map((n) => ({
        id: n.id,
        deps: n.deps ?? [],
        ...(n.onFailure !== undefined ? { onFailure: n.onFailure } : {}),
      })),
      ledgerOutputs: {},
    };
  }
  const merged = resolveResidualSubgraph(
    nodes.map((n) => ({ id: n.id, task: n.task, deps: n.deps ?? [] })),
    ledger
  );
  if (merged.rejections.length > 0) {
    throw new ToolExecutionError(`run_graph: ${merged.rejections.join("; ")}`);
  }
  // Re-attach `onFailure` onto the merged specNodes — the residual layer
  // only handles deps / ids (ledger freeze semantics); the handler pastes
  // failure edges back on here for the scheduler.
  const onFailureById = new Map(nodes.map((n) => [n.id, n.onFailure] as const));
  const specNodes = merged.nodes.map((n) => {
    const of = onFailureById.get(n.id);
    return {
      id: n.id,
      deps: n.deps,
      ...(of !== undefined ? { onFailure: of } : {}),
    };
  });
  return { specNodes, ledgerOutputs: merged.ledgerOutputs };
}

/**
 * Is this settlement real? The one definition of that question.
 *
 * The in-process ledger freeze and the durable fact are two projections of a
 * single settlement decision, so they ask here instead of each spelling the
 * rules out — a rule change cannot land in one projection and miss the other.
 *
 *   - `skipped` is not a settlement: the node was never dispatched, and its
 *     status is a deterministic consequence of an upstream failure that *is*
 *     recorded, so re-deriving it from validated graph state is the
 *     continuation rule itself.
 *   - On a caller-side cancel only `done` is real. A `failed` on the abort
 *     path (the executor's signal.aborted pre-check returning failed,
 *     waitFor rejecting as failed under abort) is a symptom of cancellation,
 *     not a real termination; freezing it as failed would mean "cancelled =
 *     failed-frozen", and the residual-subgraph merge layer would then refuse
 *     those ids as frozen-failed, leaving the parent agent unable to rescue
 *     unfinished nodes. Since a single run has no "rerun a failed node"
 *     semantics, declining to freeze is declining the failed terminal —
 *     whether the failure was real is settled by the next residual
 *     submission.
 *   - On a normal settle (no abort) `done` and a real `failed` are both real.
 *     The fuse path is a normal settle and deliberately does not reuse cancel's
 *     "done only" rule: a failed returned there is a **real failure**
 *     (sub-agent envelope failed, or entry refused because the fuse tripped),
 *     so the next residual subgraph must not be able to resubmit it —
 *     otherwise "completed is never replayed" is violated and mergeResidual's
 *     frozen-failed rejection is bypassed. Caller-side cancellation is the
 *     only distinction either projection needs.
 *
 * `cancelled` is the flag *as observed by the calling projection*, and the two
 * projections observe different moments: the fact at the node's own settlement
 * (`runNodeDurably`), the freeze after the whole graph has converged. So a
 * settlement can be real at the first moment and unreal at the second — a
 * failure that settled before a later abort is recorded as a fact while the
 * ledger declines to freeze it. That asymmetry is deliberate, not a drift bug:
 * append-only facts are conservative observations, whereas the ledger's cancel
 * rule is a resubmission policy, and only the fact stream may still say "this
 * really happened" after the caller has dropped the round.
 */
function isRealSettlement(
  outcome: NodeOutcome,
  cancelled: boolean
): outcome is Exclude<NodeOutcome, { readonly status: "skipped" }> {
  if (outcome.status === "skipped") return false;
  if (cancelled) return outcome.status === "done";
  return true;
}

/**
 * What a real settlement carries: only a string output travels into either
 * projection. The condense layer renders a non-string `output` with a
 * `String(...)` fallback, but the ledger is the cross-call durable authority
 * and the fact is what a restored session reads — freezing or recording a
 * `String()`-ified "[object Object]" of an object would later be written into
 * downstream tasks as a real output.
 */
function carriedOutput(outcome: NodeOutcome): string | undefined {
  if (outcome.status !== "done") return undefined;
  return typeof outcome.output === "string" ? outcome.output : undefined;
}

/**
 * Freeze settled ids into the ledger by terminal status, in one batch pass
 * after convergence. Done nodes also write their output into the ledger — the
 * data source for downstream reads.
 *
 * This is the in-process, cross-call authority: a cross-call resubmission
 * reads the ledger, not the fact stream. It is NOT the durability path — a
 * node's outcome reaches the host's persistence port per node at its own
 * settlement point (`runNodeDurably`), because a kill inside the scheduler
 * arrives long before this pass runs.
 *
 * Which settlements are real and what a real one carries is decided once, in
 * `isRealSettlement` and `carriedOutput`; `settlementFact` asks the same two,
 * so a rule change reaches both projections. What the two do not share is the
 * moment they ask at — see the `cancelled` note on `isRealSettlement` for the
 * single asymmetry that follows from it.
 */
function freezeResults(
  ledger: LiveGraphLedger,
  results: Readonly<Record<string, GraphNodeResult>>,
  cancelled: boolean
): void {
  for (const result of Object.values(results)) {
    if (isRealSettlement(result, cancelled)) {
      ledger.freeze(result.id, result.status, carriedOutput(result));
      continue;
    }
    // An unreal settlement is split by who has to hear about it, not decided
    // twice: a never-ran node is still forwarded because the ledger is the one
    // point that drops it (its `SettleStatus` exists so this pass can hand
    // `GraphNodeResult.status` over unchanged), while a cancel-symptom
    // failure never reaches the ledger at all — that id must stay rescuable
    // for the next residual subgraph.
    if (result.status === "skipped") {
      ledger.freeze(result.id, result.status, undefined);
    }
  }
}

/**
 * Node fact for one settlement, the durable twin of what the ledger records
 * for the same decision: both ask `isRealSettlement` and `carriedOutput`, so
 * the rules cannot drift, and a real settlement records the same status and
 * the same string output the ledger would freeze — which is what lets a
 * restored session and an in-process residual merge read one story. Only the
 * moment each asks at differs (see `isRealSettlement`).
 *
 * A `skipped` node produces nothing for the same reason the ledger does not
 * freeze it: such a node was never dispatched and its status is a
 * deterministic consequence of an upstream failure that *is* recorded, so
 * re-deriving it from validated graph state is the continuation rule itself.
 *
 * `undefined` = nothing to record, which leaves this node's dispatch marker as
 * its last fact: the "dispatched, outcome unknown" state an interrupted run
 * must be able to tell apart from a node that was never submitted.
 */
function settlementFact(
  nodeId: string,
  outcome: NodeOutcome,
  cancelled: boolean
): RuntimeGraphNodeFact | undefined {
  if (!isRealSettlement(outcome, cancelled)) return undefined;
  if (outcome.status === "failed") {
    return {
      kind: "graph_node",
      nodeId,
      status: "failed",
      error: outcome.error,
    };
  }
  const output = carriedOutput(outcome);
  return {
    kind: "graph_node",
    nodeId,
    status: "done",
    // A done node whose output is not a string is recorded as a status only —
    // the same rule the freeze applies, asked once.
    ...(output !== undefined ? { output } : {}),
  };
}

/**
 * Append one fact; a rejection becomes a failed `NodeOutcome` instead of a
 * throw. Both schedulers already turn a node throw into that same outcome, so
 * the graph's shape is unchanged — but the message says the node's state could
 * *not be recorded*, which is the difference between "the work failed" and
 * "the work's outcome is not durable". Dependents are then skipped by the
 * scheduler's own fail-fast, so no dependent execution ever runs on state that
 * was not written. No retry: re-attempting is an unbounded loop over a failing
 * writer, and whether to try again is the host's call, not this handler's.
 */
async function appendNodeFact(
  sink: RuntimePersistenceSink<AnthropicNativeMessage>,
  fact: RuntimeGraphNodeFact,
  undurable: string
): Promise<NodeOutcome | undefined> {
  try {
    await sink.appendOperationFact(fact);
    return undefined;
  } catch (err) {
    return {
      status: "failed",
      error: `run_graph: ${undurable}: ${formatNodeError(err)}`,
    };
  }
}

interface DurableNodeRun {
  /** Host sink for this call; absent = nothing is wired, no facts are written. */
  readonly sink: RuntimePersistenceSink<AnthropicNativeMessage> | undefined;
  readonly nodeId: string;
  /** Whether the caller has cancelled by the time the node settles. */
  readonly cancelled: () => boolean;
  /** The node's real work, already gated by the abort / fuse pre-checks. */
  readonly run: () => Promise<NodeOutcome>;
}

/**
 * One node's whole durable lifecycle, awaited at both ends: mark dispatched
 * *before* the spawn, record the settlement *after* it returns.
 *
 * Why not the post-convergence pass: freezing a run's results once the last
 * wave finished loses every already-settled node to a kill anywhere inside the
 * scheduler, and it cannot distinguish a node that was dispatched and
 * interrupted from one that was never submitted. Both facts are per node, so
 * both are written per node here.
 *
 * Ordering is per node and comes from these two awaits alone — no lock, no
 * queue, no second journal. Cross-node order is the host's writer queue's
 * business, and the handler deliberately has no per-conversation mutex
 * (run-graph-concurrency.test.ts pins that).
 */
async function runNodeDurably(opts: DurableNodeRun): Promise<NodeOutcome> {
  const { sink } = opts;
  // No sink: `run()` is invoked synchronously and its promise returned as-is,
  // so the unwired path adds no await and neither changes behaviour nor
  // reorders spawns inside a wave.
  if (sink === undefined) return opts.run();
  const undispatched = await appendNodeFact(
    sink,
    { kind: "graph_node", nodeId: opts.nodeId, status: "running" },
    `node "${opts.nodeId}" was not started because its dispatch could not be recorded`
  );
  if (undispatched !== undefined) return undispatched;
  const outcome = await opts.run();
  const fact = settlementFact(opts.nodeId, outcome, opts.cancelled());
  if (fact === undefined) return outcome;
  const unrecorded = await appendNodeFact(
    sink,
    fact,
    `node "${opts.nodeId}" finished as ${outcome.status} but that outcome could not be recorded`
  );
  return unrecorded ?? outcome;
}

export function createRunGraphTool(deps: RunGraphToolDeps): AciToolDef {
  // isEnabled absent = always off — now that the tool surface is resident,
  // the handler is the only gate. Tests constructing the tool directly must
  // pass an explicit isEnabled to reach the handler.
  const isEnabled = deps.isEnabled ?? ((): boolean => false);
  return Object.freeze({
    name: "run_graph",
    description: DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        nodes: {
          type: "array",
          minItems: 1,
          description: "Graph nodes, in any order.",
          items: {
            type: "object",
            properties: {
              id: {
                type: "string",
                description: "Unique node id referenced by other nodes' deps.",
              },
              task: {
                type: "string",
                description:
                  "Self-contained task for this node's sub-agent. Results of its deps are appended automatically.",
              },
              deps: {
                type: "array",
                items: { type: "string" },
                description:
                  "Ids this node waits for. Omit or leave empty for a root node.",
              },
              onFailure: {
                type: "string",
                description:
                  "Marked failure edge: the id of the single node to start if this one finishes with status `failed`. Target must be the id of another node in this submission (pointing at the same id is allowed — a marked single-cell re-entry). The host ignores `onFailure` from any node that finishes as `done` or `skipped`.",
              },
            },
            required: ["id", "task"],
            additionalProperties: false,
          },
        },
      },
      required: ["nodes"],
      additionalProperties: false,
    },
    aci: {
      // Same classification as spawn_subagent: execution is slow but the
      // tool itself touches no filesystem; real write authority is guarded
      // by each sub-agent's own permission layer.
      category: "read-only",
      lazy: false,
      // Graph lifetime = sum of each node's manager per-task clocks; ACI
      // must not start its own timer, or it would abort early while nodes
      // are still alive (same reasoning as spawn_subagent).
      timeoutTier: "unbounded",
      isConcurrencySafe: false,
      interruptBehavior: "cancel",
    } as const,
    // Complexity 18 likewise pre-existed on master; this change only
    // touches the description string and does not split the handler
    // (minimal change) — scope-disable is left for a complexity task.
    // eslint-disable-next-line complexity -- baseline: pre-existing on master
    handler: async (input: unknown, ctx?: ToolExecutionContext) => {
      // EXIT: overlay off — the assembly layer already filtered the tool
      // out of promptTools, so reaching here means a same-round flag flip
      // or model hallucination. Zero spawns, typed rejection.
      if (!isEnabled()) {
        throw new ToolExecutionError(
          "run_graph: graph mode is off for this run; use spawn_subagent, or turn graph mode on (Shift+Tab / `/graph on`) and try again on the next turn"
        );
      }
      const nodes = readNodes(input);
      const ledger = deps.ledger?.ledgerFor(ctx?.conversationId);
      // Residual-subgraph merge goes through mergeResidual; ledger absent → zero behavior change.
      const { specNodes, ledgerOutputs } = mergeResidual(nodes, ledger);
      const spec: GraphSpec = { nodes: specNodes };
      // Does this submission carry failure edges — decides which scheduler path runs (see the split below).
      const hasFailureEdges = specNodes.some((n) => n.onFailure !== undefined);
      // EXIT: invalid topology — fail-fast before any spawn (zero spawns).
      const errors = validateGraph(spec);
      if (errors.length > 0) {
        throw new ToolExecutionError(
          `run_graph: invalid graph — ${errors.map(describeValidationError).join("; ")}`
        );
      }
      // Failure-edge validation: unknown / frozen target → typed rejection,
      // zero spawns. Placed after validateGraph: cycles formed by deps alone
      // remain topo's single point to refuse, and the onFailure
      // target check is its own layer (failure edges stay out of Kahn).
      // self-onFailure is legal inside validateOnFailureEdges.
      const onFailureRejections = validateOnFailureEdges(nodes, ledger);
      if (onFailureRejections.length > 0) {
        throw new ToolExecutionError(
          `run_graph: invalid failure edge(s) — ${onFailureRejections.join("; ")}`
        );
      }
      // Live-graph ledger lifecycle: an invalid topology / failure-edge path
      // must never create a ledger, so this block sits right after both
      // validations.
      if (ledger !== undefined) {
        ledger.ensure();
      }
      const byId = new Map(nodes.map((n) => [n.id, n]));
      const signal = ctx?.signal;
      const parentTurnId = ctx?.turnId;
      // Runtime-state sink for this call, resolved once after both validation
      // gates so a refused submission never touches the persistence authority.
      // Absent sink → no facts and byte-identical behavior (see runNodeDurably).
      const factSink = deps.runtimePersistence?.bind(ctx?.conversationId);
      // The effort fuse is installed only on the failure-edge scheduler
      // path: the plain Kahn path enters each id at most once, no counting.
      const fuse = hasFailureEdges ? createEffortFuse() : undefined;
      // Build the executor fresh per node: the task text must carry the
      // outputs of that node's deps while NodePlan is static — building
      // fresh is the minimal way to make "data flow along edges" work on
      // the existing executor without changing it. ledgerOutputs (frozen-
      // done outputs merged for this submission) fold into nodeCtx.outputs
      // so renderTask writes them into downstream tasks byte-for-byte.
      const exec: NodeExecutor = (id, nodeCtx) => {
        // Caller already cancelled → this node spawns nothing. The
        // scheduler records it as failed, downstream becomes skipped; once
        // the whole graph converges, the EXIT below attributes it uniformly.
        if (signal?.aborted) {
          return Promise.resolve({
            status: "failed" as const,
            error: "run_graph: cancelled by caller abort",
          });
        }
        // Count at the executor entry (the count point is entry, not the
        // validation or scheduler layer). Exceeding the threshold on one id
        // trips the fuse: this entry spawns nothing, fuse.signal makes the
        // scheduler stop all new entries (in-flight nodes still settle,
        // which is why fuse.signal is not fed to the node executor), and
        // after the call converges the EXIT below rejects with a typed error.
        if (fuse !== undefined && !fuse.enter(id)) {
          return Promise.resolve({
            status: "failed" as const,
            error: `run_graph: effort fuse tripped — node "${id}" was entered more than ${EFFORT_FUSE_THRESHOLD} times in one call`,
          });
        }
        const node = byId.get(id)!;
        const augmentedCtx: NodeContext = Object.freeze({
          outputs: Object.freeze({ ...ledgerOutputs, ...nodeCtx.outputs }),
        });
        // Past both gates, so a dispatched marker really means a spawn
        // followed: record the node's dispatch and its settlement through the
        // host's port instead of letting one post-convergence pass speak for
        // the whole run.
        return runNodeDurably({
          sink: factSink,
          nodeId: id,
          cancelled: () => signal?.aborted === true,
          run: () =>
            createSubAgentNodeExecutor({
              manager: deps.manager,
              plans: { [id]: { task: renderTask(node, augmentedCtx) } },
              ...(signal ? { signal } : {}),
              ...(parentTurnId !== undefined ? { parentTurnId } : {}),
            })(id, augmentedCtx),
        });
      };
      const tracker = createGraphProgressTracker(spec.nodes);
      try {
        // Scheduler split — graphs without failure edges still use plain
        // `runGraph` (Kahn, byte-level identical); graphs with failure edges
        // use the outcome scheduler, which starts the unique onFailure
        // target once per NodeOutcome and allows re-entry of the same id.
        const progressHooks = {
          onWave: (wave: number, ids: ReadonlyArray<string>): void => {
            emitGraphProgress(ctx, tracker.onWave(wave, ids));
          },
          onNode: (result: GraphNodeResult): void => {
            emitGraphProgress(ctx, tracker.onNode(result));
          },
        };
        let violation: FailureEdgeViolation | undefined;
        let execution: GraphExecution;
        if (hasFailureEdges) {
          // Known, accepted race (recorded in boundary review): a
          // concurrent second call submitting failure edges at the same time
          // could read an unfrozen ledger state mid-first-call and kick the
          // same id. The handler layer deliberately has no per-conversation
          // mutex (honestly pinned; see run-graph-concurrency.test.ts) —
          // the real serialization guard is in the ACI executor: run_graph
          // declares isConcurrencySafe:false, concurrent waves separate
          // unsafe calls from the rest, so two run_graph calls in one
          // conversation never overlap in the real executor and this race
          // is unreachable through the production path.
          // fuse.signal is fed only to the scheduler — it stops "starting
          // new entries"; in-flight nodes settle as-is (it is not fed to
          // node executors, or they would be misread as caller-side
          // cancellation). Combine the caller signal with fuse.signal:
          // either aborting → the scheduler converges.
          const r = await runGraphWithFailureEdges(spec, exec, {
            ...progressHooks,
            signal: combineAbortSignals(signal, fuse?.signal),
          });
          execution = r.execution;
          violation = r.violation;
        } else {
          execution = await runGraph(spec, exec, progressHooks);
        }
        // Freeze semantics for all paths are centralized in freezeResults;
        // see that function. violation and abort share one channel: the done
        // portion is kept into the ledger, not returned as success data.
        const cancelled = signal?.aborted === true;
        // A tripped fuse goes through the same partial-results channel as
        // violation / abort — freeze the done portion first ("what completed
        // before a trip stays"), then reject with a typed error. Fuse ≠
        // cancel: follow the normal settle path freezing done + real
        // failed, so the next residual subgraph cannot resubmit these ids.
        // Cancel still takes precedence: the caller dropped this round, so
        // cancel-symptom failed does not freeze.
        const fuseTripped = fuse?.signal.aborted === true;
        if (ledger !== undefined) {
          freezeResults(ledger, execution.results, cancelled);
        }
        if (fuseTripped) {
          throw new ToolExecutionError(
            `run_graph: effort fuse tripped — node "${fuse!.trippedBy}" was entered more than ${EFFORT_FUSE_THRESHOLD} times in one call; done ids remain frozen, submit a new node id in the next call to continue`
          );
        }
        if (violation !== undefined) {
          throw new ToolExecutionError(
            `run_graph: failure edge from "${violation.from}" targets "${violation.target}" which is already done — frozen node cannot be re-run; submit a new node id instead`
          );
        }
        // EXIT: attribute caller cancellation — consistent with
        // spawn_subagent (the executor normalizes signal.aborted to
        // execution_failed:cancelled). A half-graph's partial results are
        // not returned as success data: the caller no longer wants this round.
        if (cancelled) {
          throw new ToolExecutionError(
            "run_graph: cancelled by caller abort while the graph was running"
          );
        }
        return condense(nodes, execution.results, execution.waveCount);
      } finally {
        emitGraphProgress(ctx, null);
      }
    },
  });
}
