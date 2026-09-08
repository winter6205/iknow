/**
 * live-graph-phase2 T2 —— outcome 驱动失败边调度器（spec SC1–SC3 / SC6
 * / ADR-0053–0056、0062–0063）。
 *
 * 与 `scheduler.ts` 的分工：原 `runGraph` 仍是阶段 1 的 Kahn wave 调度
 * （无失败边的图走它，行为与阶段 1 字节一致）；本模块是带 `onFailure`
 * 的图的调度线。启用规则按 NodeOutcome 判定（spec Does #4，实现不锁
 * Kahn 函数名）：
 *
 *   - **前进边 = deps**：deps 全 done 才启动（与阶段 1 同语义）。
 *   - **失败边 = onFailure**：起点结局 failed 才启动终点一次（ADR-0055
 *     / 0062）；done / skipped 起点不启动失败边（ADR-0056 / SC3）。
 *   - **失败边启动绕过 deps 门**：终点可以 dep 着刚失败的起点（SC2 新
 *     格的常见画法），此时 deps 不满足 —— 回边本身就是启用依据，
 *     host 不按失败内容改路（ADR-0063）。
 *   - **同 id 再进入**：终点是刚 failed 的旧 id（含 self）→ 同 id 再进
 *     executor（ADR-0053 / SC6）；终点本段已 done → violation，不 spawn、
 *     调度收敛，handler typed 拒（ADR-0060：done 永不因失败边再跑）。
 *   - **abort 后不再启动新进入**：in-flight 落定后收敛，不空转。
 *
 * 进入互斥：同一 id 同时至多一个进入在排队或执行（`queued` 集合）；多
 * 条失败边指到同一排队中的 id 只算一次启动。同 id 串行反复再进入的次数
 * 上限（effort 熔断）不在本模块 —— 那是 T3 在 executor 入口加的闸。
 *
 * 分层（complexity-anti-drift）：本模块不调 validateGraph（输入 spec 必
 * 须已过 handler 校验）、不读账本、不 import node-executor / loop-engine。
 *
 * 边界：纯调度逻辑，executor 闭包由调用方注入；不 import loop-engine /
 * build-engine / index.ts。
 */

import type {
  GraphExecution,
  GraphNodeResult,
  GraphSpec,
  NodeContext,
  NodeExecutor,
  NodeOutcome,
  NodeStatus,
} from "./types.js";
import { formatNodeError } from "./error-render.js";

export interface FailureEdgeViolation {
  /** 触发违规的起点 id（本段 failed，但其 `onFailure` 终点已 done）。 */
  readonly from: string;
  /** 标明的失败边终点（本段已 done，不可再跑）。 */
  readonly target: string;
}

export interface FailureEdgeExecutionResult {
  readonly execution: GraphExecution;
  /**
   * mid-run typed 违反：失败边终点在本段已 done。handler 据此 typed 拒
   * （与 abort 同一 partial-results 通道 —— 已 done 的结果保留并冻结），
   * 与提交期 schema/校验拒绝相区分。
   */
  readonly violation?: FailureEdgeViolation;
}

export interface RunGraphWithFailureEdgesOptions {
  /** 每批可跑节点开跑前回调（批次号从 0 起；外壳用来打印进度）。 */
  readonly onWave?: (wave: number, ids: ReadonlyArray<string>) => void;
  /** 每个节点落定后回调（含 skipped 节点；同 id 再进入按末次触发）。 */
  readonly onNode?: (result: GraphNodeResult) => void;
  /**
   * 调用侧取消信号。abort 后：in-flight 节点按其真实 NodeOutcome 落定，
   * 但不再启动任何新进入（失败边 kick 与 deps 晋升都停）。
   */
  readonly signal?: AbortSignal;
}

/**
 * outcome 驱动失败边调度器。返回不可变 GraphExecution + 可选 violation。
 */
export async function runGraphWithFailureEdges(
  spec: GraphSpec,
  exec: NodeExecutor,
  opts?: RunGraphWithFailureEdgesOptions
): Promise<FailureEdgeExecutionResult> {
  const onWave = opts?.onWave;
  const onNode = opts?.onNode;
  const signal = opts?.signal;

  const depsOf = new Map<string, ReadonlyArray<string>>();
  const failureEdgeOf = new Map<string, string | undefined>();
  for (const node of spec.nodes) {
    depsOf.set(node.id, node.deps);
    failureEdgeOf.set(node.id, node.onFailure);
  }

  const statuses: Record<string, NodeStatus> = {};
  const results: Record<string, GraphNodeResult> = {};
  const outputs: Record<string, unknown> = {};

  // ready：待启动批次；queued：已在 ready 排队或在当前批执行中的 id。
  // 失败边 kick 与 deps 晋升都经 queued 去重 —— 同一 id 同时至多一个进入。
  const ready: string[] = [];
  const queued = new Set<string>();

  function isFinal(id: string): boolean {
    const s = statuses[id];
    return s === "done" || s === "failed" || s === "skipped";
  }

  function depsSatisfied(id: string): boolean {
    for (const dep of depsOf.get(id) ?? []) {
      if (results[dep]?.status !== "done") return false;
    }
    return true;
  }

  /** deps 晋升：依赖全 done 且未排队、未落定 → 入队。 */
  function enqueueIfReady(id: string): void {
    if (queued.has(id) || isFinal(id)) return;
    if (!depsSatisfied(id)) return;
    queued.add(id);
    ready.push(id);
  }

  /**
   * 失败边 kick：绕过 deps 门与 isFinal（终点是刚 failed 的旧 id 是再进
   * 入的本体；终点 dep 着刚失败的起点是 SC2 的新格画法）。唯一不许的
   * 终点态是 done —— 那由调用方先查 violation。
   */
  function enqueueFailureEdgeTarget(target: string): void {
    if (queued.has(target)) return;
    queued.add(target);
    ready.push(target);
  }

  /** 沿 deps 传递地把依赖失败节点的未落定节点标 skipped（阶段 1 语义）。 */
  function skipDependentsOf(rootId: string, reason: string): void {
    const visited = new Set<string>([rootId]);
    const stack = [rootId];
    while (stack.length > 0) {
      const id = stack.pop()!;
      for (const node of spec.nodes) {
        if (!node.deps.includes(id) || visited.has(node.id)) continue;
        visited.add(node.id);
        stack.push(node.id);
        // 失败边 kick 过的目标不标 skipped —— 它的启用依据是回边而非
        // deps（kick 已入队，马上会真跑）。
        if (queued.has(node.id) || isFinal(node.id)) continue;
        const r: GraphNodeResult = { id: node.id, status: "skipped", reason };
        results[node.id] = r;
        statuses[node.id] = "skipped";
        onNode?.(r);
      }
    }
  }

  // 初始：无 deps 的根节点入队。
  for (const node of spec.nodes) {
    if (node.deps.length === 0) enqueueIfReady(node.id);
  }

  let waveCount = 0;
  let violation: FailureEdgeViolation | undefined;

  while (violation === undefined) {
    if (ready.length === 0) {
      // 收敛。abort 路径剩余未落定节点不补 skipped（handler 反正 typed
      // 拒、只冻 done）；非 abort 还有 blocked 属校验漏洞，兜底标
      // skipped 防死循环（正常不会到 —— deps 环已被 topo 拒）。
      if (signal?.aborted) break;
      for (const node of spec.nodes) {
        if (isFinal(node.id) || queued.has(node.id)) continue;
        const r: GraphNodeResult = {
          id: node.id,
          status: "skipped",
          reason: "deps could not be satisfied",
        };
        results[node.id] = r;
        statuses[node.id] = "skipped";
        onNode?.(r);
      }
      break;
    }

    const batch = ready.splice(0, ready.length);
    for (const id of batch) queued.delete(id);
    waveCount++;
    onWave?.(waveCount - 1, batch);
    for (const id of batch) statuses[id] = "running";

    const ctx: NodeContext = Object.freeze({
      outputs: Object.freeze({ ...outputs }),
    });

    const settled = await Promise.all(
      batch.map(async (id): Promise<GraphNodeResult> => {
        try {
          const outcome: NodeOutcome = await exec(id, ctx);
          return { id, ...outcome };
        } catch (err) {
          return { id, status: "failed", error: formatNodeError(err) };
        }
      })
    );

    // F1（review fix）：先遍一遍把整波所有 settle 结果全部写进 results
    // / statuses / outputs（partial-results 通道的承诺：handler 据此
    // 冻结整波已落定 id，违反 ADR-0050「已完成不重演」就会让下一段剩
    // 余子图把它们再跑一次）。第二遍再判失败边 / violation —— 让整
    // 波记录在 violation 抬升之前完成。
    for (const r of settled) {
      // 同 id 再进入：末次结局覆盖前次（results / statuses / onNode 同拍）。
      results[r.id] = r;
      statuses[r.id] = r.status;
      if (r.status === "done") outputs[r.id] = r.output;
      onNode?.(r);
    }

    for (const r of settled) {
      if (signal?.aborted) continue; // abort 后只落定、不推进

      if (r.status === "done") {
        // 前进边：依赖本节点的 blocked 节点尝试晋升（失败边不触发，
        // ADR-0055/0056）。
        for (const node of spec.nodes) {
          if (node.deps.includes(r.id)) enqueueIfReady(node.id);
        }
      } else if (r.status === "failed") {
        // 失败边（唯一终点，ADR-0062）：终点本段已 done → violation；
        // 否则 kick（新格首进 / 旧 id 再进入，ADR-0063）。
        const target = failureEdgeOf.get(r.id);
        if (target !== undefined) {
          if (results[target]?.status === "done") {
            violation = { from: r.id, target };
            break;
          }
          enqueueFailureEdgeTarget(target);
        }
        skipDependentsOf(r.id, `upstream node "${r.id}" did not complete`);
      }
      // skipped 结局不触发失败边（SC3）；其下游由 skipDependentsOf 或
      // deps 不满足自然挡住。
    }
  }

  return {
    execution: Object.freeze({
      statuses: Object.freeze({ ...statuses }),
      results: Object.freeze({ ...results }),
      waveCount,
    }),
    ...(violation !== undefined ? { violation } : {}),
  };
}
