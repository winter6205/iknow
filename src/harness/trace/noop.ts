import type { TraceService } from "./types.js";

/**
 * 零副作用 TraceService (T2, GH #64)。
 *
 * 三方法全部返回 undefined —— 语义: 未生成 ID, 与 ADR Decision 14 失败路径一致
 * (recordLlmCall 失败 → recordToolCall 仍记, parentLlmCallId = undefined)。
 * 不写盘、不 IO、不 console、不动全局。
 */
export function createNoopTraceService(): TraceService {
  return {
    async recordLlmCall(_record) {
      return undefined;
    },
    async recordToolCall(_record) {
      return undefined;
    },
    async recordTurn(_record) {
      return undefined;
    },
  };
}
