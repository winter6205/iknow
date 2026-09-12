/**
 * 两条引擎的汇流层（D2–D5 单点落地；SC4–SC9）。
 *
 * 为什么需要这一层：rg 与 Node 扫的**产物形状不同**（rg 直出 `-l` 路径表 /
 * `--count` 计数表，Node 扫直出命中行），但契约要求二者对同一查询给出同一
 * 结果。若让 handler 分两条路各自投影，`also` 行窗、分页、`total:` 会各写
 * 一遍 —— SC9 的「Node 全语义」就成了一句口号。
 *
 * 做法：两条引擎都**先归一成命中行**，随后所有语义（also 过滤 → 排序 →
 * 分页 → 投影）只在这条流水线上发生一次。`paths` / `count` 只是投影的收窄
 * 视图，不再是引擎的另一条取样路径。
 *
 * 唯一例外是**没有 `also` 时的 `paths` / `count`**：那两种情形不需要行号，
 * 让 rg 走 `-l` / `--count` 可以少传一遍行内容（大仓下是数量级差异）。即便
 * 走这条快路，`total:` 仍按「切片前」算，与慢路一致。
 */

import { ToolExecutionError } from "../../errors.js";
import type { LineHit, QuerySpec } from "./types.js";
import type { EngineResult } from "./rg-engine.js";
import { expandAlsoNeedle, filterHitsByAlsoWindow } from "./also-window.js";
import { buildContextGroups } from "./context-groups.js";
import { NO_ENTRIES_AT_OFFSET } from "./paginate.js";
import { keepRepresentablePaths } from "./path-representable.js";
import { sortContextGroups, sortLineHits } from "./sort.js";
import {
  projectContent,
  projectContext,
  projectCount,
  projectCounts,
  projectPathList,
  projectPaths,
} from "./project.js";

export interface PipelineInput {
  readonly spec: QuerySpec;
  readonly result: EngineResult;
  /** 命中行的取行回调（`context` 展示 + `also` 行窗共用）。 */
  readonly readLines: (path: string) => Promise<ReadonlyArray<string> | null>;
}

/**
 * 引擎产物 → 模型可见字符串。
 *
 * 顺序是契约的一部分：**先 also 过滤，再排序，再切片**。颠倒任何一步，
 * 分页都会漏条或重条（SC7）。
 */
export async function renderResult(input: PipelineInput): Promise<string> {
  const { spec, result } = input;
  if (result.kind === "unavailable") {
    // 本层不该见到 unavailable：分派逻辑（`grep.ts` resolveEngineResult）
    // 已经在降级时改走 Node 扫。走到这里说明装配出了 bug，用本层统一的
    // typed 错误抛出（`ToolExecutionError`，与工具层其余失败同形），别让
    // 裸 Error 混进 ACI 的失败域。
    throw new ToolExecutionError(
      "grep: internal error: result projection received an unavailable engine result"
    );
  }

  const engineResult = dropUnrepresentable(result);
  const lines = await applyAlsoFilter({ ...input, result: engineResult });

  if (spec.output === "content") {
    if (spec.context > 0)
      return renderContext({ ...input, result: engineResult }, lines);
    return projectContent(projection(lines, spec));
  }
  if (spec.output === "count") {
    if (engineResult.kind === "counts" && !hasAlso(spec)) {
      return projectCounts(engineResult.counts, spec.offset, spec.headLimit);
    }
    return projectCount(projection(lines, spec));
  }
  if (engineResult.kind === "paths" && !hasAlso(spec)) {
    return projectPathList(engineResult.paths, spec.offset, spec.headLimit);
  }
  return projectPaths(projection(lines, spec));
}

/**
 * 行协议可表示性收口（D2；两条引擎共用）。
 *
 * 含 `\n` / `\0` 的路径在任何出法里都不能出现：`\n` 会把自己的记录拆成两条
 * （`path:line:text` 的行协议下前半段长成一条假命中），`\0` 与 `--null` 的
 * 分隔符撞车。这里放在**两条引擎的汇流点**，而不是各引擎内部 —— 将来任何
 * 新引擎只要走这条流水线就自动继承，不会再分叉出第三种坏法。
 *
 * 遍历期已由 argv 的排除 glob 挡掉绝大多数（含 `\n` 目录的整棵子树）；
 * rg 的显式点名目标由 `rg-engine.ts` 在 exec 前挡掉；本层兜住其余一切
 * （Node 扫、显式文件参数、以及「路径只在祖先段里带换行」这类漏网）。
 * 判定与理由见 `path-representable.ts`。
 */
function dropUnrepresentable(result: EngineResult): EngineResult {
  if (result.kind === "unavailable") return result;
  if (result.kind === "lines") {
    return {
      kind: "lines",
      lines: keepRepresentablePaths(result.lines, (hit) => hit.path),
    };
  }
  if (result.kind === "paths") {
    return {
      kind: "paths",
      paths: keepRepresentablePaths(result.paths, (path) => path),
    };
  }
  if (result.kind === "counts") {
    return {
      kind: "counts",
      counts: keepRepresentablePaths(result.counts, (count) => count.path),
    };
  }
  if (result.kind === "context") {
    return {
      kind: "context",
      groups: result.groups
        .map((group) => ({
          entries: keepRepresentablePaths(group.entries, (entry) => entry.path),
        }))
        .filter((group) => group.entries.length > 0),
    };
  }
  return result;
}

/**
 * `context` 出法：得到组 → 排序 → 按组切片。分页单位是**组**（一段连续展示块）。
 *
 * rg 路径已经把组算好了（它自己插的 `--` 就是组边界），直接用；Node 路径
 * 没有这层信息，由 `buildContextGroups` 按「命中行 ± context」重建同样的
 * 形状。两条引擎产出的组结构一致，投影因此只有一处。
 *
 * 排序在切片之前（D3）**对两条引擎都必要**：rg 的组序跟着并行遍历走，Node
 * 的组序跟着 `readdir` 走，两者都不是 (path, line) 序。少了这一步，同一个
 * `offset` 在两次调用里会落到不同的组上 —— 分页名册必须是确定的。
 */
async function renderContext(
  input: PipelineInput,
  lines: ReadonlyArray<LineHit>
): Promise<string> {
  const raw =
    input.result.kind === "context"
      ? input.result.groups
      : await buildContextGroups({
          matches: sortLineHits(lines),
          context: input.spec.context,
          readLines: input.readLines,
        });
  const groups = sortContextGroups(raw);
  if (groups.length === 0) return "";
  const { offset, headLimit } = input.spec;
  if (offset >= groups.length) return NO_ENTRIES_AT_OFFSET;
  return projectContext(groups.slice(offset, offset + headLimit));
}

/**
 * `also` 行窗过滤（D5）。
 *
 * 有 `also` → 必须先有行号，故取样出法此时是 `content`（见 `engineSpecFor`），
 * `lines` 即命中行；窗内没有第二段的命中被丢掉。
 */
async function applyAlsoFilter(
  input: PipelineInput
): Promise<ReadonlyArray<LineHit>> {
  const { spec, result } = input;
  const lines = result.kind === "lines" ? result.lines : [];
  if (!hasAlso(spec)) return lines;
  const also = expandAlsoNeedle(spec.also!, spec.ignoreCase);
  // `filterHitsByAlsoWindow` 的取行是同步的（纯判定层），这里先把命中涉及的
  // 文件**预读**成一张同步表再喂进去 —— 文件读取仍走 `input.readLines`
  // （异步、带 1MB / 二进制准入），判定层不必知道 fs。
  const files = new Map<string, ReadonlyArray<string> | null>();
  for (const hit of lines) {
    if (files.has(hit.path)) continue;
    files.set(hit.path, await input.readLines(hit.path));
  }
  return filterHitsByAlsoWindow({
    matches: lines,
    also,
    withinLines: spec.withinLines,
    readLines: (path) => files.get(path) ?? null,
  });
}

/** 投影输入的最小形状（`project.ts` 只认命中行 + 切片参数）。 */
function projection(
  lines: ReadonlyArray<LineHit>,
  spec: QuerySpec
): {
  hits: { lines: ReadonlyArray<LineHit> };
  offset: number;
  headLimit: number;
} {
  return { hits: { lines }, offset: spec.offset, headLimit: spec.headLimit };
}

function hasAlso(spec: QuerySpec): boolean {
  return spec.also !== undefined && spec.also.length > 0;
}

/**
 * 引擎取样用的 spec。
 *
 * `also` 在场时**必须**取内容行（要行号才能判窗），所以把出法临时改成
 * `content` 且关掉 context（行窗是过滤，不是展示）。没有 `also` 时按请求
 * 出法取样，让 rg 走 `-l` / `--count` 的快路。
 */
export function engineSpecFor(spec: QuerySpec): QuerySpec {
  if (!hasAlso(spec)) return spec;
  return { ...spec, output: "content", context: 0 };
}
