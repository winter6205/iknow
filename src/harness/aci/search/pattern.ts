/**
 * 主 pattern 编译（两种引擎共用）。
 *
 * 单点职责：把 `pattern` + `ignoreCase` 变成 RegExp，坏正则 → typed 拒绝。
 * Node 引擎直接用它；rg 引擎用它做**前置**校验（rg 自己也会以 rc=2 报同类
 * 错误，前置校验让两条路径文案一致、且不必先花一次进程启动）。
 *
 * 与未知 `type` 的错误严格区分（SC10）：
 *   - 本模块文案含 `pattern`
 *   - `argv.ts` 的 type 文案含 `type`，不含 `pattern`
 * 两条文案互不包含对方关键词，测试直接比对两条真实 message。
 */

import { ToolExecutionError } from "../../errors.js";

/** 编译主 pattern；坏正则 → typed 拒绝（消息含 pattern 原文）。 */
export function compilePattern(pattern: string, ignoreCase: boolean): RegExp {
  try {
    return new RegExp(pattern, ignoreCase ? "i" : "");
  } catch {
    throw new ToolExecutionError(`grep: invalid pattern: ${pattern}`);
  }
}
