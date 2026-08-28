/**
 * D-α T3/T4 —— `run_graph` ACI 工具（graph mode 打开时才露出的编排入口）。
 *
 * 与 `spawn_subagent` 的分工：`spawn_subagent` 是「一件事交出去」，`run_graph`
 * 是「一张有依赖的图一次性交出去」。父代理声明 DAG，host 走
 * `validateGraph` → `topoWaves`（由 `runGraph` 内部完成）→
 * `createSubAgentNodeExecutor`；节点本身仍是前景 spawn（ADR-0014），所以
 * 并发上限沿用 manager 的全局 4，不另起 per-graph budget。
 *
 * 两道 EXIT：
 *   - graph mode 关着还被调到（同 round 翻键 / 模型幻觉）→ `ToolExecutionError`，
 *     零 spawn。装配层已按快照把工具从 promptTools 里滤掉，这里是第二道闸。
 *   - 拓扑非法（环 / 自依赖 / 未知依赖 / 重复 id）→ `ToolExecutionError`，
 *     同样零 spawn —— 校验在任何 `manager.spawn` 之前跑完。
 *
 * 节点级失败不是异常而是数据：失败节点的下游被 `runGraph` 标 skipped，独立
 * 分支照跑，最终以浓缩结果整体返回，让父代理自己决定怎么收尾。
 */

import type { AciToolDef } from "../aci/types.js";
import type { ToolExecutionContext } from "../tools/types.js";
import type { SubAgentManager } from "../subagent/manager.js";
import { ToolExecutionError } from "../errors.js";
import { safeEmitStream } from "../stream.js";
import type { GraphProgressSnapshot } from "./progress.js";
import { createGraphProgressTracker } from "./progress.js";
import { validateGraph, type GraphValidationError } from "./topo.js";
import { runGraph } from "./scheduler.js";
import { createSubAgentNodeExecutor } from "./node-executor.js";
import type {
  GraphNodeResult,
  GraphSpec,
  NodeContext,
  NodeExecutor,
} from "./types.js";

export interface RunGraphToolDeps {
  readonly manager: SubAgentManager;
  /**
   * 本 round 的 graph 装配快照（`GraphAssembly.enabled`）。缺席 = 恒开，
   * 仅供直接构造工具的测试用；生产装配总是把快照传进来。
   */
  readonly isEnabled?: () => boolean;
}

/** 模型声明的单节点（schema 与本形状一一对应）。 */
interface RunGraphNodeInput {
  readonly id: string;
  readonly task: string;
  readonly deps?: ReadonlyArray<string>;
}

const DESCRIPTION =
  "Run several sub-agent tasks as one dependency graph in a single call. " +
  "Declare every node with an `id`, a self-contained `task`, and the `deps` " +
  "it must wait for. Nodes whose dependencies are all satisfied run in " +
  "parallel; a node starts only after every node it depends on finished, and " +
  "sees those results. If a node fails, the nodes downstream of it are " +
  "skipped and unrelated branches keep running. The call blocks until the " +
  "whole graph settles and returns one condensed report of every node. Use " +
  "`spawn_subagent` instead when there is a single task, or several tasks " +
  "with no ordering between them.";

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

/** 防御式读参：ajv strict 已守过形状，这里挡直调 handler 的路径。 */
function readNodes(input: unknown): ReadonlyArray<RunGraphNodeInput> {
  const obj = (input ?? {}) as Record<string, unknown>;
  const raw = obj.nodes;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ToolExecutionError(
      "run_graph: `nodes` must be a non-empty array"
    );
  }
  return raw.map((entry, i) => {
    const node = (entry ?? {}) as Record<string, unknown>;
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
    return {
      id,
      task,
      deps: (deps as ReadonlyArray<string> | undefined) ?? [],
    };
  });
}

/** 浓缩回报：父代理要的是「谁成了、谁没成、产出是什么」，不是执行细节。 */
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
 * 依赖产出沿边流动：下游节点是独立进程里的新会话，看不见上游 messages，
 * 所以上游结果必须写进它的 task 文本才叫「有依赖」。无 deps 的节点原样
 * 透传（与单次 `spawn_subagent` 的 task 字节一致）。
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

export function createRunGraphTool(deps: RunGraphToolDeps): AciToolDef {
  const isEnabled = deps.isEnabled ?? ((): boolean => true);
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
      // 与 spawn_subagent 同归类：执行耗时但工具本身不改文件系统,
      // 真正的写权限由每个子代理各自的 permission 层守。
      category: "read-only",
      lazy: false,
      // 图寿命 = 各节点 manager per-task 钟之和；ACI 不另起 timer,
      // 否则会在节点还活着时提前 abort（与 spawn_subagent 同理）。
      timeoutTier: "unbounded",
      isConcurrencySafe: false,
      interruptBehavior: "cancel",
    } as const,
    handler: async (input: unknown, ctx?: ToolExecutionContext) => {
      // EXIT:overlay 关着 —— 装配层已把工具滤出 promptTools,能走到这里
      // 说明是同 round 翻键或模型幻觉。零 spawn,typed 拒绝。
      if (!isEnabled()) {
        throw new ToolExecutionError(
          "run_graph: graph mode is off for this run; use spawn_subagent, or turn graph mode on (Shift+Tab / `/graph on`) and try again on the next turn"
        );
      }
      const nodes = readNodes(input);
      const spec: GraphSpec = {
        nodes: nodes.map((n) => ({ id: n.id, deps: n.deps ?? [] })),
      };
      // EXIT:拓扑非法 —— 在任何 spawn 之前 fail-fast(spec SC4 零 spawn)。
      const errors = validateGraph(spec);
      if (errors.length > 0) {
        throw new ToolExecutionError(
          `run_graph: invalid graph — ${errors.map(describeValidationError).join("; ")}`
        );
      }
      const byId = new Map(nodes.map((n) => [n.id, n]));
      const signal = ctx?.signal;
      const parentTurnId = ctx?.turnId;
      // 每节点现装一次 executor:task 文本要带上该节点 deps 的产出,而
      // NodePlan 是静态的 —— 现装是让「数据沿边流动」落在既有 executor
      // 上而不改它的最小做法。
      const exec: NodeExecutor = (id, nodeCtx) => {
        // 调用侧已取消 → 本节点不再 spawn。scheduler 把它记成 failed,
        // 下游随之 skipped;整张图收敛后由下面的 EXIT 统一归因。
        if (signal?.aborted) {
          return Promise.resolve({
            status: "failed" as const,
            error: "run_graph: cancelled by caller abort",
          });
        }
        const node = byId.get(id)!;
        return createSubAgentNodeExecutor({
          manager: deps.manager,
          plans: { [id]: { task: renderTask(node, nodeCtx) } },
          ...(signal ? { signal } : {}),
          ...(parentTurnId !== undefined ? { parentTurnId } : {}),
        })(id, nodeCtx);
      };
      const tracker = createGraphProgressTracker(spec.nodes);
      try {
        const execution = await runGraph(spec, exec, {
          onWave: (wave, ids) => {
            emitGraphProgress(ctx, tracker.onWave(wave, ids));
          },
          onNode: (result) => {
            emitGraphProgress(ctx, tracker.onNode(result));
          },
        });
        // EXIT:归因调用侧取消 —— 与 spawn_subagent 一致(executor 因
        // signal.aborted 归一 execution_failed:cancelled)。半张图的部分结果
        // 不当成功数据返回:调用方已经不要这轮了。
        if (signal?.aborted) {
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
