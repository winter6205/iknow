/**
 * PROTOTYPE — Self-written Graph 多任务编排：Proto C「编译耦合拆分」核心函数。
 *
 * 验证问题：给定带编译耦合标签（触碰哪些模块）的任务，能否把耦合的串成链、
 * 解耦的分成并行 wave，作为子代理分配依据？
 *
 * 答案：通过 partitionByCoupling 把每个任务声明的 `touches` 映射成带 deps 的
 * GraphSpec；耦合的任务被串成链（同模块只有相邻边），解耦的任务形成可并行
 * 的并发 wave。topoWaves(spec) 直接给出分层 → 分给子代理的依据。
 *
 * 边界：本模块不 import loop-engine / build-engine；只依赖 ./types 与 ./topo。
 */

import type { GraphNodeSpec, GraphSpec } from "./types.js";

/** 最小任务形状：id + 触碰的模块列表。 */
export interface CouplingTask {
  readonly id: string;
  readonly touches: ReadonlyArray<string>;
}

/**
 * 把 (id, touches) 任务列表按编译耦合关系拆分成 GraphSpec。
 *
 * 规则：对每个模块 m，收集所有触碰 m 的任务（按输入顺序排），**只在相邻两个
 * 之间加一条边**（前 → 后，即 后.deps 包含 前）。所有模块的相邻边取并集。
 *
 * 为什么是「相邻」而非「两两连成团（clique）」？
 * 同一模块若被多个任务触碰，clique 会强制其中所有任务成全序串行——但实际
 * 编译耦合只需要"前一个任务改完，后一个再修"。相邻加边给出了最小化串行的
 * 偏序：只保证必须链式的成链，不假链的保持解耦以利并行。
 *
 * 复杂度：O(T × M)，T = 任务数，M = 任务平均 touches 数。
 */
export function partitionByCoupling(
  tasks: ReadonlyArray<CouplingTask>
): GraphSpec {
  const depsById = new Map<string, string[]>();
  for (const t of tasks) {
    depsById.set(t.id, []);
  }

  // 任务输入索引（用于"按输入顺序排序"）
  const inputIndex = new Map<string, number>();
  for (let i = 0; i < tasks.length; i++) {
    inputIndex.set(tasks[i]!.id, i);
  }

  // module → 触碰该模块的任务 id 列表（按输入顺序）
  const byModule = new Map<string, string[]>();
  for (const t of tasks) {
    for (const m of t.touches) {
      const list = byModule.get(m) ?? [];
      list.push(t.id);
      byModule.set(m, list);
    }
  }

  // 对每个模块：在相邻任务对 (prev, next) 之间加一条 prev → next 边
  for (const ids of byModule.values()) {
    for (let i = 1; i < ids.length; i++) {
      const prev = ids[i - 1]!;
      const next = ids[i]!;
      depsById.get(next)!.push(prev);
    }
  }

  // 组装 GraphSpec：节点按输入顺序，去重 deps（一个任务可能因多个模块
  // 与同一上游产生重复边），按 inputIndex 稳定排序便于 verify 与可读性。
  const result: GraphNodeSpec[] = [];
  for (const t of tasks) {
    const deps = depsById.get(t.id)!;
    const stableDeps = [...new Set(deps)].sort(
      (a, b) => (inputIndex.get(a) ?? 0) - (inputIndex.get(b) ?? 0)
    );
    result.push({ id: t.id, deps: stableDeps });
  }
  return { nodes: result };
}

/** 两个 id 是否在 topoWaves(spec) 的同一 wave。 */
export function sameWave(
  a: string,
  b: string,
  waves: ReadonlyArray<ReadonlyArray<string>>
): boolean {
  for (const w of waves) {
    if (w.includes(a) && w.includes(b)) return true;
  }
  return false;
}
