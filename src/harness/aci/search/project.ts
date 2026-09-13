/**
 * 输出投影（SC12「输出投影」；契约 D2/D3；SC4/SC5/SC6/SC7）。
 *
 * 三种出法共用同一条流水线：**sort → paginate → project**。出法只决定
 * 「名单里放什么」，不决定「怎么切」—— 切的是已排序名单（见 `sort.ts`）。
 *
 * 投影层不碰 fs / 进程：输入是两条引擎归一后的原始产物。
 */

import {
  CONTEXT_GROUP_SEPARATOR,
  type ContextGroup,
  type FileCount,
  type LineHit,
} from "./types.js";
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
 * 匹配行 `path:line:text`；上下文行 `path:line-text`；组间插 `--`。
 *
 * 为什么上下文行是 `path:line-text` 而**不是** `path-line-text`：后者的
 * 行号前那一段里允许出现任意字符，于是「内容里带冒号」的上下文行会长成
 * `a.ts-1-see x:9:fake` —— 任何按 `^[^:]*:\d+:` 判匹配行的消费者（人也
 * 好、下游 parser 也好）都会把它读成一条真命中，SC6 的「不脏行」就破了。
 * 把路径与行号用同一种分隔符框住（`path:line` 前缀），真假只由行号之后
 * 那**一个字符**承担（`:` = 匹配、`-` = 上下文），与 rg 原生 `--null
 * -C N` 输出的判别位置完全一致（那里是 `\0` 之后的 `path\0line:text` /
 * `path\0line-text`）。这样无论内容含什么，上下文行都无法被拆成
 * `path:整数:text` 三元组。
 */
export function projectContext(groups: ReadonlyArray<ContextGroup>): string {
  if (groups.length === 0) return "";
  const blocks = groups.map((group) =>
    group.entries
      .map(
        (entry) =>
          `${entry.path}:${String(entry.line)}${entry.isMatch ? ":" : "-"}${entry.text}`
      )
      .join("\n")
  );
  return blocks.join(`\n${CONTEXT_GROUP_SEPARATOR}\n`);
}
