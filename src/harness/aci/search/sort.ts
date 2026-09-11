/**
 * 稳定排序（SC12「排序」；契约 D3「稳定排序（path 再行号）发生在切片之前」）。
 *
 * 两种引擎的原始顺序都不可依赖：rg 的并行遍历顺序随线程调度变，Node 扫的
 * `readdir` 顺序随文件系统变。分页要求「同一查询两次调用看到同一页」，所以
 * 排序必须是切片的前置步骤，而不是展示层的修饰。
 */

import type { ContextGroup, LineHit } from "./types.js";

/**
 * 按 (path, line) 升序排；同键保持输入相对顺序（Array#sort 自 ES2019 起
 * 稳定）。path 比较用 code unit 序 —— 与 rg `--sort path` 的字典序同口径，
 * 且不随 locale 变。
 */
export function sortLineHits(hits: ReadonlyArray<LineHit>): LineHit[] {
  return [...hits].sort((a, b) => {
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    return a.line - b.line;
  });
}

/** 文件名单排序（paths / count 出法共用；count 的 `path:条数` 行序）。 */
export function sortPaths(paths: ReadonlyArray<string>): string[] {
  return [...paths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * 上下文组排序（`content + context` 的分页名册）。
 *
 * 分页单位是**组**，所以切之前必须先给组排序 —— 两种引擎的组序都不可依赖：
 * rg 按并行遍历顺序吐组，Node 按 `readdir` 顺序建组。不排序就切片，同一个
 * `offset` 在两次调用里会落在不同的组上（SC7 要求 `offset=0,head_limit=50`
 * 与 `offset=50` 的集合不重叠）。
 *
 * 组间比较用组内**首条**的 (path, line)：组内条目必然同文件且行号递增，
 * 首条即该组在全局名册里的位置。
 */
export function sortContextGroups(
  groups: ReadonlyArray<ContextGroup>
): ContextGroup[] {
  return [...groups].sort((a, b) => {
    const left = a.entries[0];
    const right = b.entries[0];
    if (left === undefined || right === undefined) return 0;
    if (left.path !== right.path) return left.path < right.path ? -1 : 1;
    return left.line - right.line;
  });
}

/** 文件计数排序（rg `--count` 直出路径；条数不进比较，只按 path）。 */
export function sortCounts(
  counts: ReadonlyArray<{ readonly path: string; readonly count: number }>
): Array<{ readonly path: string; readonly count: number }> {
  return [...counts].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0
  );
}
