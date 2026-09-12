/**
 * grep 搜面共享类型（D2–D5 / SC4–SC10）。
 *
 * 契约真值：`specs/aci-file-search-surface.md`（D2 出法 / D3 分页与 parser /
 * D4 收窄 / D5 行窗）。本模块只声明形状，不承载行为 —— 行为落在
 * options / argv / rg-output / node-scan / sort / paginate / project。
 */

/** D2 出法：默认 paths。 */
export type GrepOutput = "paths" | "content" | "count";

/** 一次查询的规范化参数（flag 解析产物，handler 全路径共用）。 */
export interface QuerySpec {
  readonly pattern: string;
  /** 主词命中的第二段（D5 行窗过滤）；缺席 = 不做行窗过滤。 */
  readonly also?: string;
  /** `also` 在场时的对称行窗半径（默认 5）。 */
  readonly withinLines: number;
  readonly ignoreCase: boolean;
  readonly output: GrepOutput;
  /** `content` 出法的对称上下文行数；0 = 关闭（默认）。 */
  readonly context: number;
  /** 文件名模式（D4），与 `type` 并列。 */
  readonly glob?: string;
  /** 语言类型（D4）。 */
  readonly type?: string;
  /** 已排序结果名单的起始下标（D3）。 */
  readonly offset: number;
  /** 已排序结果名单的条数上限（D3；默认 50、硬顶 2000）。 */
  readonly headLimit: number;
}

/**
 * 一条命中行。`line` 为 1 基行号；`text` 已按 MAX_MATCH_LINE_COLUMNS 截断
 * （与旧契约一致，两种引擎同口径）。
 */
export interface LineHit {
  readonly path: string;
  readonly line: number;
  readonly text: string;
}

/** 单文件命中数（count 出法的输入）。 */
export interface FileCount {
  readonly path: string;
  readonly count: number;
}

/**
 * `content` + `context` 的一个展示组。
 *
 * rg 会在两段不相邻的上下文之间插 `--` 分隔行；本形状把「组」显式化，
 * 渲染层负责分隔符 —— 这样 `:` / `-` / `--` 不会被误解析成假
 * `path:line:text`（SC6）。
 */
export interface ContextGroup {
  /** 组内条目：匹配行 `isMatch=true`，上下文行 `isMatch=false`。 */
  readonly entries: ReadonlyArray<ContextEntry>;
}

export interface ContextEntry {
  readonly path: string;
  readonly line: number;
  readonly text: string;
  readonly isMatch: boolean;
}

/**
 * 组间分隔行（渲染与解析的唯一权威）。
 *
 * rg 在 `--null -C N` 下把分组行印成**两个空格加 `--`**
 * （`\0--\0\n`，实测 15.1.0，与不带 `--null` 时的裸 `--` 不同）。解析侧
 * 若只认裸 `--`，分组行会被当成损坏记录丢掉 —— 相邻两组于是被拼成一组
 * （`--` 没了，`head_limit` 的组数、`offset` 的落点全跟着变），而 Node 侧
 * 是自己造组的、不受影响：同一个 `-C N` 查询在两条引擎下的分页结果分叉。
 */
export const CONTEXT_GROUP_SEPARATOR = "--";
