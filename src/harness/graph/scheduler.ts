/**
 * PROTOTYPE — Self-written Graph 多任务编排：调度器。
 *
 * 验证问题：（同 types.ts 头注释）
 * 本文件是纯编排逻辑：按 wave 并发执行节点（Promise.all），跨 wave 串行；
 * 节点失败 → 其（传递）依赖者标 skipped（分支 fail-fast），独立分支继续；
 * 不可变累积状态，一次性返回 GraphExecution。不 import loop-engine、
 * 不 console.log（回调用参数传入，逻辑不直接打印）。
 *
 * 边界：纯编排逻辑，不直接 spawn；executor 闭包由调用方注入。
 */

import { validateGraph, topoWaves } from "./topo.js";
import type {
  GraphExecution,
  GraphNodeResult,
  GraphSpec,
  NodeContext,
  NodeExecutor,
  NodeStatus,
} from "./types.js";

export interface RunGraphOptions {
  /** 每个含可跑节点的 wave 开跑前回调（整波全 skipped 时不触发；外壳用来打印，逻辑不用它做控制流）。 */
  readonly onWave?: (wave: number, ids: ReadonlyArray<string>) => void;
  /** 每个节点落定后回调（含 skipped 节点）。 */
  readonly onNode?: (result: GraphNodeResult) => void;
}

/**
 * 按 wave 执行：同 wave 内并发（Promise.all），跨 wave 串行。
 * 节点失败 → 其（传递）依赖者标 skipped（分支 fail-fast），独立分支继续。
 * 不可变累积状态，一次性返回 GraphExecution。
 */
export async function runGraph(
  spec: GraphSpec,
  exec: NodeExecutor,
  opts?: RunGraphOptions
): Promise<GraphExecution> {
  const errors = validateGraph(spec);
  if (errors.length > 0) {
    throw new Error(`invalid graph: ${errors[0]!.kind}`);
  }

  const waves = topoWaves(spec);

  // depsOf: 直接依赖表（用于追溯失败上游）
  const depsOf = new Map<string, ReadonlyArray<string>>();
  for (const node of spec.nodes) {
    depsOf.set(node.id, node.deps);
  }

  // 不可变累积：每次 wave 结束 spread 出新对象替换，确保 GraphExecution 整体可冻结，
  // 且 exec 的 ctx.outputs 读到的也是 Object.freeze 快照（下面 wave 起点会重新 freeze）。
  let statuses: Record<string, NodeStatus> = {};
  let results: Record<string, GraphNodeResult> = {};
  let outputs: Readonly<Record<string, unknown>> = {};

  // 初始：所有节点 pending
  for (const node of spec.nodes) {
    statuses[node.id] = "pending";
  }

  let waveCount = 0;
  for (let w = 0; w < waves.length; w++) {
    const wave = waves[w]!;
    waveCount = w + 1;

    // 决定本 wave 内哪些节点跑、哪些标 skipped
    const toRun: string[] = [];
    for (const id of wave) {
      const failedUpstream = findFailedUpstream(id, depsOf, results);
      if (failedUpstream !== null) {
        const reason = `upstream node "${failedUpstream}" did not complete`;
        const result: GraphNodeResult = { id, status: "skipped", reason };
        statuses = { ...statuses, [id]: "skipped" };
        results = { ...results, [id]: result };
        opts?.onNode?.(result);
      } else {
        toRun.push(id);
      }
    }

    if (toRun.length === 0) continue;

    opts?.onWave?.(w, toRun);

    for (const id of toRun) {
      statuses = { ...statuses, [id]: "running" };
    }

    // 同 wave 节点共享同一 ctx（已 done 节点的 outputs 快照）
    const ctx: NodeContext = Object.freeze({
      outputs: Object.freeze({ ...outputs }),
    });

    const settled = await Promise.all(
      toRun.map(async (id): Promise<GraphNodeResult> => {
        try {
          const outcome = await exec(id, ctx);
          return { id, ...outcome };
        } catch (err) {
          return { id, status: "failed", error: formatNodeError(err) };
        }
      })
    );

    for (const result of settled) {
      statuses = { ...statuses, [result.id]: result.status };
      results = { ...results, [result.id]: result };
      if (result.status === "done") {
        outputs = { ...outputs, [result.id]: result.output };
      }
      opts?.onNode?.(result);
    }
  }

  return Object.freeze({
    statuses: Object.freeze({ ...statuses }),
    results: Object.freeze({ ...results }),
    waveCount,
  });
}

/**
 * 沿 deps 链向上追溯，找到第一个失败/被跳过的上游节点。
 * 用于决定本节点是否因分支 fail-fast 而被标 skipped。
 */
function findFailedUpstream(
  nodeId: string,
  depsOf: ReadonlyMap<string, ReadonlyArray<string>>,
  results: Readonly<Record<string, GraphNodeResult>>
): string | null {
  const visited = new Set<string>();
  const stack: string[] = [...(depsOf.get(nodeId) ?? [])];
  while (stack.length > 0) {
    const dep = stack.pop()!;
    if (visited.has(dep)) continue;
    visited.add(dep);
    const r = results[dep];
    if (r && (r.status === "failed" || r.status === "skipped")) {
      return dep;
    }
    const upstream = depsOf.get(dep);
    if (upstream) stack.push(...upstream);
  }
  return null;
}

/**
 * 节点执行异常 → `error` 字符串的渲染契约（per code-quality.md typed-error catch）：
 * 优先识别判别联合 `{kind, context}`；未知形态退回到 `err.message`；最末回到 `String(err)`。
 * 禁止 `err instanceof Error ? err.message : String(err)`（plain typed object 会被打成
 * `[object Object]`，让 kind/context 完全不可见）。
 */
function formatNodeError(err: unknown): string {
  if (err && typeof err === "object" && "kind" in err) {
    const e = err as { kind?: unknown; context?: unknown };
    const kind = typeof e.kind === "string" ? e.kind : "unknown";
    const ctxStr =
      e.context !== undefined ? JSON.stringify(e.context) : JSON.stringify(err);
    return `${kind}: ${ctxStr}`;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}
