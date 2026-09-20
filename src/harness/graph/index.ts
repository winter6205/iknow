/**
 * PROTOTYPE — self-written Graph multi-task orchestration: public surface.
 *
 * Unified entry for the graph orchestration prototypes, exposing upward
 * (chat host / future CLI / future TUI): topology (validateGraph /
 * topoWaves), scheduling (runGraph), coupling partition
 * (partitionByCoupling), skill gate (skillCheckGate), and the subagent-bound
 * executor (createSubAgentNodeExecutor). Once the prototypes validate, these
 * interfaces fold into real code.
 *
 * Boundary: re-exports internal module symbols only; introduces no
 * loop-engine / build-engine dependency.
 */

export type {
  NodeStatus,
  NodeOutcome,
  GraphNodeSpec,
  GraphSpec,
  GraphNodeResult,
  GraphExecution,
  NodeContext,
  NodeExecutor,
} from "./types.js";

export type { GraphValidationError } from "./topo.js";
export { validateGraph, topoWaves } from "./topo.js";

export type { RunGraphOptions } from "./scheduler.js";
export { runGraph } from "./scheduler.js";

export type {
  FailureEdgeViolation,
  FailureEdgeExecutionResult,
  RunGraphWithFailureEdgesOptions,
} from "./outcome-scheduler.js";
export { runGraphWithFailureEdges } from "./outcome-scheduler.js";

export type {
  FrozenTerminal,
  SettleStatus,
  LiveGraphLedger,
  LiveGraphLedgerHost,
} from "./ledger.js";
export { resolveResidualSubgraph } from "./residual.js";
export { createLiveGraphLedger, createLiveGraphLedgerHost } from "./ledger.js";

export type { OnFailureNode } from "./on-failure.js";
export { validateOnFailureEdges } from "./on-failure.js";

export type { EffortFuse } from "./effort-fuse.js";
export { createEffortFuse } from "./effort-fuse.js";
export { EFFORT_FUSE_THRESHOLD } from "./effort-threshold.js";

export type {
  GraphNodeProgress,
  GraphNodeSeed,
  GraphProgressSnapshot,
  GraphProgressTracker,
} from "./progress.js";
export { createGraphProgressTracker } from "./progress.js";

export type { CouplingTask } from "./partition-by-coupling.js";
export { partitionByCoupling, sameWave } from "./partition-by-coupling.js";

export type { SkillContract, GateDecision } from "./skill-check-gate.js";
export { skillCatalog, skillCheckGate } from "./skill-check-gate.js";

export type { NodePlan, SubAgentNodeExecutorOptions } from "./node-executor.js";
export { createSubAgentNodeExecutor } from "./node-executor.js";

export { formatNodeError } from "./error-render.js";
