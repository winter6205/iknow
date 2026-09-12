/**
 * D5 行窗过滤（SC8）：`also` + `within_lines`。
 *
 * 语义是**过滤**不是展示 —— 主词命中后，只在以该行为中心、半径
 * `within_lines` 的闭区间内找第二段；窗内没有 → 该命中当没中。不把附近
 * 原文带进结果（那是 `context` 的职责），也不做裸跨行正则。
 *
 * 与引擎解耦：输入命中行 + 「按 path 取全文行」的回调。rg 引擎与 Node 降级
 * 引擎共用本层。ADR-0089 之后本层只对 rg 路径的命中做 also 过滤（用 JS
 * `RegExp` 跑 `also` 文本）—— 不再声称「两条引擎同判」：rg 给出命中就
 * 用这些命中过本层，Node 路径因命中集不同而可能过滤掉的命中数也不同。
 */

import { ToolExecutionError } from "../../errors.js";
import { compilePattern } from "./pattern.js";
import type { LineHit } from "./types.js";

export interface AlsoWindowInput {
  readonly matches: ReadonlyArray<LineHit>;
  readonly also: RegExp;
  readonly withinLines: number;
  /** 返回该文件的全部行（1 基行号 = 下标 + 1）；不可读 → null。 */
  readonly readLines: (path: string) => ReadonlyArray<string> | null;
}

/** 保留窗内第二段命中的主词命中行；顺序与输入一致。 */
export function filterHitsByAlsoWindow(input: AlsoWindowInput): LineHit[] {
  const cache = new Map<string, ReadonlyArray<string> | null>();
  const linesFor = (path: string): ReadonlyArray<string> | null => {
    if (!cache.has(path)) cache.set(path, input.readLines(path));
    return cache.get(path) ?? null;
  };

  return input.matches.filter((hit) => {
    const lines = linesFor(hit.path);
    if (lines === null) return false;
    const from = Math.max(1, hit.line - input.withinLines);
    const to = Math.min(lines.length, hit.line + input.withinLines);
    for (let line = from; line <= to; line++) {
      const text = lines[line - 1];
      if (text !== undefined && input.also.test(text)) return true;
    }
    return false;
  });
}

/**
 * 把 `also` 文本编译为正则（与主 `pattern` 同口径：默认大小写敏感，
 * `ignoreCase` 共用，模式判据同源）。
 *
 * `also` 是**字面词**（D5 的行窗第二段），不是主 pattern 的宽正则：它在
 * `also-window.ts` 里只做 `test()`，两端引擎共用本函数，所以不需要任何
 * rg argv 开关（本模块的判据不再投影到 rg）。`also` 的窗判定只在 Node 侧
 * 跑（rg 只按主 pattern 出命中），故这里走与主 pattern 同一套编译（含
 * `u` 规则与退回）即可 —— 与 rg 的命中集差异是 ADR-0089 已接受的合同。
 *
 * 坏正则 → typed 拒绝，文案点名 `also` —— 与主 pattern 的错误区分，也与
 * 未知 `type` 的错误区分（SC10 要求两类错误不可混为一种）。
 */
export function expandAlsoNeedle(also: string, ignoreCase: boolean): RegExp {
  try {
    return compilePattern(also, ignoreCase);
  } catch {
    throw new ToolExecutionError(
      `grep: invalid also pattern: ${also} (the main pattern was fine; fix the also expression)`
    );
  }
}
