/**
 * `content + context` 的**组构造**（SC6 / D3；SC12「附近几行」职责）。
 *
 * 为什么需要这一层（而不是直接把 rg 的 stdout 透出去）：
 *   rg 开 `-C N` 后，同一条记录里 `:` 与 `-` 混排、组间还夹裸 `--`。那份
 *   文本在模型眼里就是一堆行 —— 上下文行 `a.ts-4-line4` 与匹配行
 *   `a.ts:4:hit` 只差一个字符，模型很容易把上下文行读成命中。SC6 要求
 *   「上下文行与 `--` 不被切成假 `path:line:text`」，所以本层的产物是
 *   **显式分组 + 每条的 isMatch 标记**，渲染交给 `project.ts`。
 *
 * 单引擎化：rg 路径把解析出的组喂进来，Node 路径自己按「命中行 ± context」
 * 构造同样的组 —— 两种引擎产出的形状完全一致，投影层不需要知道谁算的。
 */

import type { ContextEntry, ContextGroup, LineHit } from "./types.js";

export interface ContextBuildInput {
  /** 命中行（已按 (path, line) 排序）。 */
  readonly matches: ReadonlyArray<LineHit>;
  /** 对称上下文半径（content 出法；>0 才调用本层）。 */
  readonly context: number;
  /** Workspace 相对路径 → 全文行；不可读 → null。 */
  readonly readLines: (path: string) => Promise<ReadonlyArray<string> | null>;
}

/**
 * 由命中行构造上下文组。
 *
 * 分组规则与 rg 的 `--` 语义同口径：**相邻或重叠的上下文窗合并成一组**。
 * 窗 `[line-N, line+N]` 与下一命中窗相接（或重叠）即同组，否则另起一组。
 * 文件边界处窗被夹到 `[1, 行数]`。
 */
export async function buildContextGroups(
  input: ContextBuildInput
): Promise<ContextGroup[]> {
  const byPath = groupByPath(input.matches);
  const groups: ContextGroup[] = [];
  for (const [path, hits] of byPath) {
    const lines = await input.readLines(path);
    if (lines === null) continue;
    groups.push(...groupsForFile(path, hits, lines, input.context));
  }
  return groups;
}

/** 同文件命中聚成一批（排序保证同 path 连续，但按 path 分组更稳）。 */
function groupByPath(matches: ReadonlyArray<LineHit>): Map<string, LineHit[]> {
  const byPath = new Map<string, LineHit[]>();
  for (const hit of matches) {
    const bucket = byPath.get(hit.path);
    if (bucket === undefined) byPath.set(hit.path, [hit]);
    else bucket.push(hit);
  }
  return byPath;
}

/**
 * 单文件的组序列。
 *
 * 窗相接判定用「本命中窗下界 ≤ 上一窗上界 + 1」：相接即合并（中间没有
 * 被跳过的行），否则另起一组并渲染 `--`。
 */
function groupsForFile(
  path: string,
  hits: ReadonlyArray<LineHit>,
  lines: ReadonlyArray<string>,
  context: number
): ContextGroup[] {
  const groups: ContextGroup[] = [];
  let current: ContextEntry[] = [];
  let windowEnd = -1;

  for (const hit of hits) {
    const from = Math.max(1, hit.line - context);
    const to = Math.min(lines.length, hit.line + context);
    if (from > windowEnd + 1 && current.length > 0) {
      groups.push({ entries: current });
      current = [];
    }
    const emitFrom = Math.max(from, windowEnd + 1);
    for (let line = emitFrom; line <= to; line++) {
      current.push(
        entryFor(path, line, lines[line - 1] ?? "", line === hit.line)
      );
    }
    windowEnd = Math.max(windowEnd, to);
    if (current.length > 0 && current[current.length - 1]!.line < to) {
      windowEnd = to;
    }
  }
  if (current.length > 0) groups.push({ entries: current });
  return groups;
}

function entryFor(
  path: string,
  line: number,
  text: string,
  isMatch: boolean
): ContextEntry {
  return { path, line, text, isMatch };
}

/**
 * 把 rg `--null -C N` 的 stdout 解析成组（rg 引擎路径）。
 *
 * rg 自己插的 `--` 是组边界；这里信任它，不重新按行号推导 —— rg 的合并
 * 阈值可能与上面 Node 路径的实现有细微出入，直接采用 rg 的边界比「猜它
 * 怎么分的」更稳。损坏记录整条跳过（不猜、不产生假命中）。
 */
export function parseRgContextStdout(stdout: string): ContextGroup[] {
  const groups: ContextGroup[] = [];
  let current: ContextEntry[] = [];
  const flush = (): void => {
    if (current.length > 0) {
      groups.push({ entries: current });
      current = [];
    }
  };
  for (const record of stdout.split("\n")) {
    if (record.length === 0) continue;
    if (record === "--") {
      flush();
      continue;
    }
    const entry = parseContextRecord(record);
    if (entry === undefined) continue;
    current.push(entry);
  }
  flush();
  return groups;
}

function parseContextRecord(record: string): ContextEntry | undefined {
  const nulIdx = record.indexOf("\0");
  if (nulIdx === -1) return undefined;
  const path = stripDotSlash(record.slice(0, nulIdx));
  const rest = record.slice(nulIdx + 1);
  // 行号是前导十进制段；其后紧跟单字符分隔符（`:` 匹配 / `-` 上下文）。
  // 先扫数字再判分隔符 —— 内容里的 `:` / `-` 因此不参与分列（SC6 的关键）。
  let i = 0;
  while (i < rest.length && rest[i]! >= "0" && rest[i]! <= "9") i += 1;
  if (i === 0) return undefined;
  const sep = rest[i];
  if (sep !== ":" && sep !== "-") return undefined;
  const line = Number(rest.slice(0, i));
  if (!Number.isInteger(line) || line < 1) return undefined;
  return { path, line, text: rest.slice(i + 1), isMatch: sep === ":" };
}

function stripDotSlash(path: string): string {
  return path.startsWith("./") ? path.slice(2) : path;
}
