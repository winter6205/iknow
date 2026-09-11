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
      text: truncateMatchContent(rest.slice(colonIdx + 1)),
    });
  }
  return hits;
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

export function truncateMatchContent(content: string): string {
  const chars = Array.from(content);
  if (chars.length <= MAX_MATCH_LINE_COLUMNS) return content;
  return `${chars.slice(0, MAX_MATCH_LINE_COLUMNS).join("")}${RG_TRUNCATION_MARKER}`;
}

function stripDotSlash(path: string): string {
  return path.startsWith("./") ? path.slice(2) : path;
}
