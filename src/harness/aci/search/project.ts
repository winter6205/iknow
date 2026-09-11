/**
 * 输出投影（SC12「输出投影」；契约 D2/D3；SC4/SC5/SC6/SC7）。
 *
 * 三种出法共用同一条流水线：**sort → paginate → project**。出法只决定
 * 「名单里放什么」，不决定「怎么切」—— 切的是已排序名单（见 `sort.ts`）。
 *
 * 投影层不碰 fs / 进程：输入是两条引擎归一后的原始产物。
 */

import type { ContextGroup, FileCount, LineHit, QuerySpec } from "./types.js";
import { NO_ENTRIES_AT_OFFSET, paginate } from "./paginate.js";
import { sortCounts, sortLineHits, sortPaths } from "./sort.js";

export interface ProjectionInput {
  readonly hits: { readonly lines: ReadonlyArray<LineHit> };
  readonly offset: number;
  readonly headLimit: number;
}

/** 唯一文件相对路径，每文件一条；条数按文件计（SC4）。 */
export function projectPaths(input: ProjectionInput): string {
  const unique = sortPaths([...new Set(input.hits.lines.map((h) => h.path))]);
  const page = paginate(unique, input.offset, input.headLimit);
  if (page.beyondEnd) return NO_ENTRIES_AT_OFFSET;
  return page.items.join("\n");
}

/** `path:line:text`（SC5）。 */
export function projectContent(input: ProjectionInput): string {
  const sorted = sortLineHits(input.hits.lines);
  const page = paginate(sorted, input.offset, input.headLimit);
  if (page.beyondEnd) return NO_ENTRIES_AT_OFFSET;
  return page.items
    .map((hit) => `${hit.path}:${String(hit.line)}:${hit.text}`)
    .join("\n");
}

/**
 * `path:条数` + 全库 `total:`（SC5）。
 *
 * `total` 取**切片前**的命中总数 —— 它是「这个查询一共多少命中」的答案，
 * 不是「这一页多少条」。分页与总数因此互不干扰。
 */
export function projectCount(input: ProjectionInput): string {
  const lines = input.hits.lines;
  if (lines.length === 0) return "";
  const total = lines.length;
  const counts = new Map<string, number>();
  for (const hit of lines) {
    counts.set(hit.path, (counts.get(hit.path) ?? 0) + 1);
  }
  const files = sortPaths([...counts.keys()]);
  const page = paginate(files, input.offset, input.headLimit);
  if (page.beyondEnd) return NO_ENTRIES_AT_OFFSET;
  return [
    ...page.items.map((path) => `${path}:${String(counts.get(path) ?? 0)}`),
    `total:${String(total)}`,
  ].join("\n");
}

/** 引擎已给出每文件计数时直接投影（rg `--count` 路径；total 仍然切片前算）。 */
export function projectCounts(
  counts: ReadonlyArray<FileCount>,
  offset: number,
  headLimit: number
): string {
  const total = counts.reduce((sum, c) => sum + c.count, 0);
  if (counts.length === 0) return "";
  const sorted = sortCounts(counts);
  const page = paginate(sorted, offset, headLimit);
  if (page.beyondEnd) return NO_ENTRIES_AT_OFFSET;
  return [
    ...page.items.map((c) => `${c.path}:${String(c.count)}`),
    `total:${String(total)}`,
  ].join("\n");
}

/** 引擎已给出路径名单时直接投影（rg `-l` 路径）。 */
export function projectPathList(
  paths: ReadonlyArray<string>,
  offset: number,
  headLimit: number
): string {
  if (paths.length === 0) return "";
  const sorted = sortPaths([...new Set(paths)]);
  const page = paginate(sorted, offset, headLimit);
  if (page.beyondEnd) return NO_ENTRIES_AT_OFFSET;
  return page.items.join("\n");
}

/**
 * 渲染 `content + context` 的组序列（SC6）。
 *
 * 匹配行 `path:line:text`；上下文行 `path-line-text`；组间插 `--`。
 * 上下文行**绝不**长成 `path:line:text` 形 —— 这是 SC6 的字面要求。
 */
export function projectContext(groups: ReadonlyArray<ContextGroup>): string {
  if (groups.length === 0) return "";
  const blocks = groups.map((group) =>
    group.entries
      .map((entry) =>
        entry.isMatch
          ? `${entry.path}:${String(entry.line)}:${entry.text}`
          : `${entry.path}-${String(entry.line)}-${entry.text}`
      )
      .join("\n")
  );
  return blocks.join("\n--\n");
}

/** 出法 → 投影入口（handler 的单点分派；避免 handler 里再长 switch）。 */
export function projectBySpec(spec: QuerySpec, input: ProjectionInput): string {
  if (spec.output === "content") return projectContent(input);
  if (spec.output === "count") return projectCount(input);
  return projectPaths(input);
}
