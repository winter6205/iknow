import type { TraceService } from "./types.js";
import type { TraceServiceWithHealth } from "./jsonl.js";

/**
 * 零副作用 TraceService (T2, GH #64)。
 *
 * 各方法全部返回 undefined —— 语义: 未生成 ID, 与 ADR Decision 14 失败路径一致
 * (recordLlmCall 失败 → recordToolCall 仍记, parentLlmCallId = undefined)。
 * recordVerification 同样返回 undefined (零副作用, 调用方以返回值 undefined
 * 区分"未落盘", 与既有失败路径语义一致)。
 * 不写盘、不 IO、不 console、不动全局。
 *
 * VerificationRecord 的 T5 新可选字段 (reason/evidence/missing) 由类型签名
 * 扩展覆盖, noop 不做任何消费 —— 零副作用语义不变 (plan T5: 接口扩展由
 * typecheck 验收)。
 */
export function createNoopTraceService(): TraceServiceWithHealth {
  const service: TraceService = {
    async recordLlmCall(_record) {
      return undefined;
    },
    async recordToolCall(_record) {
      return undefined;
    },
    async recordTurn(_record) {
      return undefined;
    },
    async recordSession(_record) {
      return undefined;
    },
    async recordSandboxCmd(_record) {
      return undefined;
    },
    async recordVerification(_record) {
      return undefined;
    },
    async recordGoal(_record) {
      return undefined;
    },
    async recordSubagentSpawn(_record) {
      return undefined;
    },
    async recordSubagentStop(_record) {
      return undefined;
    },
    async recordSubagentStateChange(_record) {
      return undefined;
    },
    async recordSubagentStep(_record) {
      return undefined;
    },
  };
  Object.defineProperty(service, "traceWriteFailures", {
    value: 0,
    enumerable: false,
  });
  return service as TraceServiceWithHealth;
}
