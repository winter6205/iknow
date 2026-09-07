/**
 * D-α T3/T4 —— `run_graph` ACI 工具（graph mode 打开时才露出的编排入口）。
 *
 * 与 `spawn_subagent` 的分工：`spawn_subagent` 是「一件事交出去」，`run_graph`
 * 是「一张有依赖的图一次性交出去」。父代理声明 DAG，host 走
 * `validateGraph` → `topoWaves`（由 `runGraph` 内部完成）→
 * `createSubAgentNodeExecutor`；节点本身仍是前景 spawn（ADR-0014），所以
 * 并发上限沿用 manager 的全局可配硬顶（默认 15），不另起 per-graph budget。
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
import type { LiveGraphLedger, LiveGraphLedgerHost } from "./ledger.js";
import { resolveResidualSubgraph } from "./residual.js";
import type {
  GraphNodeResult,
  GraphSpec,
  NodeContext,
  NodeExecutor,
} from "./types.js";

export interface RunGraphToolDeps {
  readonly manager: SubAgentManager;
  /**
   * 本 round 的 graph 装配快照（`GraphAssembly.enabled`）。
   *
   * ADR-0041 / plans/model-prefix-layering.md B3:工具面已常驻，调用侧是否
   * 可用由本 gate 单点决定。**缺省 = 恒关**(handler typed 拒绝,零 spawn),
   * 这是 fail-closed 安全姿态 —— 直接构造工具的测试必须显式传 isEnabled
   * 才能跑通;生产装配由 build-engine 按 graphAssembly.enabled 注入。
   */
  readonly isEnabled?: () => boolean;
  /**
   * 活图账本 host（live-graph-phase1 T1 / ADR-0047 / ADR-0051）。按
   * `ctx.conversationId` 解析会话账本：第一次校验通过的调用 `ensure()`
   * 建账；settle 后按终态冻结 done/failed（skipped 不冻）；已冻结 id
   * 再交 → typed 拒绝、零 spawn。**缺省 = 无账本** —— 行为与 V1 字节
   * 一致（ask / 直调测试 / 未接活图的调用方零变化）。
   */
  readonly ledger?: LiveGraphLedgerHost;
}

/** 模型声明的单节点（schema 与本形状一一对应）。 */
interface RunGraphNodeInput {
  readonly id: string;
  readonly task: string;
  readonly deps?: ReadonlyArray<string>;
}

/**
 * live-graph-phase1 T4（spec SC5–SC12 / ADR-0050 / 0065 / 0067）：
 * 工具说明要让模型掌握活图账本的剩余子图语义：
 *   (a) 只交还要跑的节点（residual subgraph）—— 已终态 id 不要重交；
 *   (b) 已 done / failed 的 id 会冻结，再次提交会被 typed 拒绝；
 *   (c) deps 指向已 done 的上游可以省略该上游节点 —— host 合并账本、
 *       把上游产出写进下游 task（不写也得不出"重演已 done 的节点"）；
 *   (d) 调用侧取消（abort）后，已 done 的 id 留在账本继续冻结，
 *       未完成的 id 可在下一段剩余子图里再交。
 * 阶段 1 拒失败边标记（onFailure 等）、不识别 wait —— 这些由 schema 与
 * handler 一起守门；说明文字保持正面引导（D9 paradigm），仅描述
 * 能力与边界。
 */
const DESCRIPTION =
  "Run several sub-agent tasks as one dependency graph in a single call. " +
  "Use it when a single turn needs ordered or parallel sub-agent work with " +
  "results flowing between tasks; pair with `spawn_subagent` for one-shot " +
  "tasks and use `graph mode on` so the call is admitted. Declare each " +
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
  "in the next residual subgraph. Failure-edge markers such as `onFailure` " +
  "are reserved for a later phase and return a tool execution error here. " +
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

/** 防御式读参：ajv strict 已守过形状，这里挡直调 handler 的路径。
 *
 * 两道闸门与 inputSchema 严格对齐（live-graph-phase1 T4 / spec SC10–SC11 /
 * ADR-0065 / ADR-0067）：
 *   - 根：除了 `nodes` 之外的任何键（包括 `wait` / `onFailure` /
 *     任何阶段 2 字段）→ typed 拒、零 spawn。
 *   - 节点：除了 `id` / `task` / `deps` 之外的任何键（包括
 *     `onFailure` 等阶段 2 失败边字段）→ typed 拒、零 spawn。schema
 *     是主合同，本函数是直调 handler 路径上的兜底；两边同拒才能
 *     在没有 ajv 编译（直调 / 单测）的路径上守住阶段 1 不认识
 *     `onFailure` 的合同。
 */
const ROOT_KEYS: ReadonlySet<string> = new Set(["nodes"]);
const NODE_KEYS: ReadonlySet<string> = new Set(["id", "task", "deps"]);

function readNodes(input: unknown): ReadonlyArray<RunGraphNodeInput> {
  const obj = (input ?? {}) as Record<string, unknown>;
  // 根：拒未声明键（含 wait —— ADR-0065：图上无 wait:false）。
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
  return raw.map((entry, i) => {
    const node = (entry ?? {}) as Record<string, unknown>;
    // 节点：拒未声明键（含 onFailure —— ADR-0067：阶段 1 拒失败标记）。
    for (const key of Object.keys(node)) {
      if (!NODE_KEYS.has(key)) {
        throw new ToolExecutionError(
          `run_graph: node[${i}] has unknown property \`${key}\` (only \`id\`, \`task\`, \`deps\` are accepted)`
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

/**
 * live-graph-phase1 T2:剩余子图合并(spec SC5–SC7 / ADR-0050)。
 * 在 validateGraph 之前先折叠账本:frozen-done dep → 满足,从 deps
 * 剔除(产出单独带回,并入 nodeCtx.outputs 供 renderTask 写入
 * 下游 task);frozen-failed dep → typed 拒(spec ASSUMPTIONS #3);
 * 重交已冻结 id → typed 拒(SC5 末句 / SC6 整段拒绝)。merge
 * 之外的所有拓扑 / 重复 / 环 / 自依赖仍由 validateGraph 单一
 * 权威(complexity-anti-drift 不让 freeze 进 Kahn)。
 *
 * 账本缺席 → 零行为变化:原 nodes 透传、无账本产出。
 */
function mergeResidual(
  nodes: ReadonlyArray<RunGraphNodeInput>,
  ledger: LiveGraphLedger | undefined
): {
  readonly specNodes: ReadonlyArray<{
    readonly id: string;
    readonly deps: ReadonlyArray<string>;
  }>;
  readonly ledgerOutputs: Readonly<Record<string, string>>;
} {
  if (ledger === undefined) {
    return {
      specNodes: nodes.map((n) => ({ id: n.id, deps: n.deps ?? [] })),
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
  return { specNodes: merged.nodes, ledgerOutputs: merged.ledgerOutputs };
}

/**
 * live-graph-phase1 T1:按结算终态冻结已落定 id。skipped 不冻
 * (spec Glossary);账本单点强制,handler 直传 GraphNodeResult.status。
 * T2:done 节点的产出也写进账本(SC5「B 能读到 A 的产出」数据源)。
 * T3(spec SC8):调用侧取消时,只冻结「真 done」的节点。abort 路
 * 径上失败的节点(executor 的 signal.aborted 预检查返回
 * failed、waitFor 被 abort 拒绝回 failed)是取消的症状而非真
 * 终结,把它们冻成 failed 等于「取消失败 = 失败冻结」,会让
 * 剩余子图合并层把这些 id 拒为 frozen-failed,父代理就再也
 * 救不回未跑的子节点了(spec SC8 末段)。阶段 1 单跑一次
 * 没有「失败的子节点重跑」语义,放弃冻结就是放弃「失败」的
 * 终态 —— 而失败的真相要等下一段剩余子图提交再说。正常
 * settle(无 abort)路径下 failed 仍按 SC6 冻结,SC6 语义不变。
 *
 * 只有 string 产出进账本:非 string 的 `output` 在浓缩层有 `String(...)`
 * 兜底渲染,但账本是跨调用的持久权威 —— 把对象 `String()` 化的
 * "[object Object]" 冻进账本,会在后续剩余子图里被当真产出写进下游 task。
 */
function freezeResults(
  ledger: LiveGraphLedger,
  results: Readonly<Record<string, GraphNodeResult>>,
  cancelled: boolean
): void {
  for (const result of Object.values(results)) {
    // 取消路径:仅 done 进账本;failed / skipped 留给后续剩余
    // 子图。正常路径:账本单点强制 done / failed。
    if (cancelled && result.status !== "done") continue;
    ledger.freeze(
      result.id,
      result.status,
      result.status === "done" && typeof result.output === "string"
        ? result.output
        : undefined
    );
  }
}

export function createRunGraphTool(deps: RunGraphToolDeps): AciToolDef {
  // ADR-0041:isEnabled 缺省 = 恒关 —— 工具面常驻后,handler 是唯一守门。
  // 直接构造工具的测试必须显式传 isEnabled 才能调通 handler。
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
      const ledger = deps.ledger?.ledgerFor(ctx?.conversationId);
      // T2:剩余子图合并走 mergeResidual;账本缺席 → 零行为变化。
      const { specNodes, ledgerOutputs } = mergeResidual(nodes, ledger);
      const spec: GraphSpec = { nodes: specNodes };
      // EXIT:拓扑非法 —— 在任何 spawn 之前 fail-fast(spec SC4 零 spawn)。
      const errors = validateGraph(spec);
      if (errors.length > 0) {
        throw new ToolExecutionError(
          `run_graph: invalid graph — ${errors.map(describeValidationError).join("; ")}`
        );
      }
      // live-graph-phase1 T1:活图账本生命周期 —— 拓扑非法路径绝不建账本
      // (SC1 + ASSUMPTIONS #4),所以本块紧跟 validateGraph 之后。
      if (ledger !== undefined) {
        ledger.ensure();
      }
      const byId = new Map(nodes.map((n) => [n.id, n]));
      const signal = ctx?.signal;
      const parentTurnId = ctx?.turnId;
      // 每节点现装一次 executor:task 文本要带上该节点 deps 的产出,而
      // NodePlan 是静态的 —— 现装是让「数据沿边流动」落在既有 executor
      // 上而不改它的最小做法。T2:ledgerOutputs(本段合并出来的 frozen-done
      // 产出)合并进 nodeCtx.outputs,使 renderTask 字节不变地写进
      // 下游 task(spec SC5「B 能读到 A 的产出」)。
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
        const augmentedCtx: NodeContext = Object.freeze({
          outputs: Object.freeze({ ...ledgerOutputs, ...nodeCtx.outputs }),
        });
        return createSubAgentNodeExecutor({
          manager: deps.manager,
          plans: { [id]: { task: renderTask(node, augmentedCtx) } },
          ...(signal ? { signal } : {}),
          ...(parentTurnId !== undefined ? { parentTurnId } : {}),
        })(id, augmentedCtx);
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
        // T1/T2/T3 冻结语义集中在 freezeResults;详情见该函数。
        if (ledger !== undefined) {
          freezeResults(ledger, execution.results, signal?.aborted === true);
        }
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
