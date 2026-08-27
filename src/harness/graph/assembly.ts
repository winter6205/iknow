/**
 * graph 装配快照 —— overlay 的「什么时候生效」那一半（ADR-0030 / spec SC2）。
 *
 * `GraphModeContext` 是会话级可变 holder：Shift+Tab 与 `/graph` 随时翻它。
 * 但工具面与 system 文本不能随之抖动 —— 同一次 `run()` 里换掉模型看得见的
 * 工具集，等于在一段对话中途改契约（KV cache 前缀失效，模型还可能引用一
 * 个下一 turn 就消失的工具）。所以 overlay 的读侧统一走本模块：
 *
 * - `beginRound()`：host 在每次 `run()` 之前拍一次快照；
 * - `enabled()`：装配层（promptTools 过滤 + 编排段 gate）只读快照。
 *
 * 于是「过程中切换不拦、不中途重装配、不防抖」（spec 假设 4）落成一句
 * 可验证的话：翻键立刻改 holder，但要下一次 `run()` 才改装配面。
 *
 * holder 缺席 → 恒关。未接 overlay 的入口（ask / worker / 老调用方）因此
 * 零行为变化。
 */

import type { GraphModeContext } from "./mode.js";

export interface GraphAssembly {
  /** 拍一次新快照（host 在每次 run() 前调），返回本 round 的开关。 */
  readonly beginRound: () => boolean;
  /** 当前 round 的快照值。装配层只读它，不读 holder。 */
  readonly enabled: () => boolean;
}

export function createGraphAssembly(
  mode: GraphModeContext | undefined
): GraphAssembly {
  let snapshot = mode?.get().enabled ?? false;
  return Object.freeze({
    beginRound: (): boolean => {
      snapshot = mode?.get().enabled ?? false;
      return snapshot;
    },
    enabled: (): boolean => snapshot,
  });
}
