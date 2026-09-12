/**
 * rg stdout 解析（SC12「行解析」）。
 *
 * 输入形状由 `argv.ts` 固定：`--null` → `path\0line:text\n`。NUL 定界把
 * 「路径含冒号」从分列问题里彻底移除 —— D3 的 `:` / `-` / `--` 分列只在
 * **content + context** 的渲染侧才有意义（那条路径由 `rg-output-context.ts`
 * 解析，见该文件注释）。
 *
 * 旧契约保持：单行内容 > MAX_MATCH_LINE_COLUMNS 截断 + `...[truncated]`，
 * 按 **code point** 切（不拆 surrogate pair，ADR-0004 修订）。
 */

import { truncateByCodePoint } from "../../sandbox/runner.js";
import type { LineHit } from "./types.js";

export const MAX_MATCH_LINE_COLUMNS = 2_000;
export const RG_TRUNCATION_MARKER = "...[truncated]";

/**
 * 解析 `--null` content 输出的命中行。
 *
 * 形状损坏的记录（无 NUL、行号非十进制）整条跳过 —— 不猜、不产生假命中。
 */
export function parseRgNullLines(stdout: string): LineHit[] {
  const hits: LineHit[] = [];
  for (const record of stdout.split("\n")) {
    if (record.length === 0) continue;
    const nulIdx = record.indexOf("\0");
    if (nulIdx === -1) continue;
    const path = stripDotSlash(record.slice(0, nulIdx));
    const rest = record.slice(nulIdx + 1);
    const colonIdx = rest.indexOf(":");
    if (colonIdx === -1) continue;
    const line = Number(rest.slice(0, colonIdx));
    if (!Number.isInteger(line) || line < 1) continue;
    hits.push({
      path,
      line,
      text: truncateMatchContent(stripCr(rest.slice(colonIdx + 1))),
    });
  }
  return hits;
}

/**
 * 剥尾随 `\r`（rg stdout 的每一条内容记录都要过这道）。
 *
 * `argv.ts` 带了 `--crlf`：rg 按 CRLF 判行边界（`foo$` 因此能命中 CRLF 行），
 * 但**回显的行内容仍带 `\r`**（实测 15.1.0，`--null` 与否都一样）。Node 侧按
 * `\n` 切行后已剥 `\r`（见 `file-lines.splitLines`），这里不剥就是同一查询两条
 * 引擎输出差一个不可见字符 —— 模型看不到它，但字节比较与后续 `edit_file` 的
 * `old_str` 都会撞上。命中行与上下文行共用本函数（`context-groups.ts` 也引）。
 */
export function stripCr(text: string): string {
  return text.endsWith("\r") ? text.slice(0, -1) : text;
}

/**
 * `--null` 下 `--count` 的输出形状：`path\0count\n`。
 *
 * count 出法不需要行号；路径用同款 NUL 定界。
 */
export function parseRgNullCounts(
  stdout: string
): ReadonlyArray<{ path: string; count: number }> {
  const counts: Array<{ path: string; count: number }> = [];
  for (const record of stdout.split("\n")) {
    if (record.length === 0) continue;
    const nulIdx = record.indexOf("\0");
    if (nulIdx === -1) continue;
    const path = stripDotSlash(record.slice(0, nulIdx));
    const count = Number(record.slice(nulIdx + 1));
    if (!Number.isInteger(count) || count < 0) continue;
    counts.push({ path, count });
  }
  return counts;
}

/** `--files-with-matches --null` → `path\0` 序列。 */
export function parseRgNullPaths(stdout: string): string[] {
  const paths: string[] = [];
  for (const record of stdout.split("\0")) {
    if (record.length === 0) continue;
    // 最后一段可能带尾随 \n（rg 每条记录以 \0 收尾后仍会有换行以外的
    // 空白），剥掉后再剥 `./`。
    const cleaned = stripDotSlash(record.replace(/\n+$/, ""));
    if (cleaned.length > 0) paths.push(cleaned);
  }
  return paths;
}

/**
 * 单行内容收口：按 **code point** 收到 MAX_MATCH_LINE_COLUMNS，超出加标记。
 *
 * 与 `sandbox/runner.ts` 的 `truncateByCodePoint` 是同一件事 —— 这里只是
 * 套上本层的省略标记与上限常量，切法不另写一份（旧实现的 `Array.from` +
 * `slice` 是第二份实现，漂移风险白担）。
 */
export function truncateMatchContent(content: string): string {
  if (Array.from(content).length <= MAX_MATCH_LINE_COLUMNS) return content;
  return `${truncateByCodePoint(content, MAX_MATCH_LINE_COLUMNS)}${RG_TRUNCATION_MARKER}`;
}

function stripDotSlash(path: string): string {
  return path.startsWith("./") ? path.slice(2) : path;
}
