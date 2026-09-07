/**
 * PROTOTYPE — Self-written Graph 多任务编排：公共出口。
 *
 * 本模块作为 graph 编排原型的统一入口，向上层（chat host / future CLI / future
 * TUI）暴露：拓扑（validateGraph / topoWaves）、调度（runGraph）、耦合拆分
 * （partitionByCoupling）、skill 门禁（skillCheckGate）、子代理绑定 executor
 * （createSubAgentNodeExecutor）。原型验证通过后，这些接口会折入真代码；
 * 留档即删。
 *
 * 边界：仅 re-export 内部模块符号；不引入 loop-engine / build-engine。
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
  FrozenTerminal,
  SettleStatus,
  LiveGraphLedger,
  LiveGraphLedgerHost,
} from "./ledger.js";
export { resolveResidualSubgraph } from "./residual.js";
export { createLiveGraphLedger, createLiveGraphLedgerHost } from "./ledger.js";

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
