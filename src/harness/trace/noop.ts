import type { TraceService } from "./types.js";
import type { TraceServiceWithHealth } from "./jsonl.js";

/**
 * Zero-side-effect TraceService.
 *
 * Every method returns undefined — meaning "no id generated", matching the
 * failure-path semantics (recordLlmCall failure → recordToolCall still
 * recorded with parentLlmCallId = undefined; callers distinguish "not
 * persisted" via the undefined return). No disk, IO, console, or global
 * mutation. Optional VerificationRecord fields are covered by the type
 * signature only — noop consumes nothing, semantics unchanged.
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
    async recordViolation(_record) {
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
