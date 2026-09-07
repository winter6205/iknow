/**
 * live-graph-phase2 T3 —— effort 熔断阈值（spec SC7 / ADR-0064）。
 *
 * 每个节点 id 在一次 `run_graph` 调用内的 executor 进入次数上限（含首次）。
 * 默认 **8**：第 9 次进入触发 typed 熔断、整次调用停、已 done 仍冻、外环
 * 新 id 仍可跑。
 *
 * **不进 settings。** ADR-0064：本图不把该数字做成 settings；要改再另开
 * 决策（本文件 URL 即钉死的入口 —— test `ADR-0064: 阈值常量 = 8` 守门）。
 *
 * 熔断闸的位置与形态（计数器 + AbortController signal）见
 * `effort-fuse.ts` 的文件头注释。
 */

export const EFFORT_FUSE_THRESHOLD = 8;
