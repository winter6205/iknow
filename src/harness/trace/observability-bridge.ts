import type {
  LlmCallRecord,
  ToolCallRecord,
  TurnRecord,
  SubagentSpawnRecord,
  SubagentStopRecord,
  SubagentStateChangeRecord,
} from "./types.js";

/**
 * Observability backend translator — reserved placeholder, deliberately not
 * implemented. The real mapping table (gen_ai.* attributes, naming policy,
 * ...) will be defined by a future ADR/spec; until then callers must wrap
 * this in safeTrace so a throw can never break the harness.
 *
 * The parameter is the trace-record union: any collected domain record is
 * accepted here so translation stays centralized and callers only ever see
 * domain types, never observability SDK types.
 */
export function translateToObservability(
  // Underscore prefix satisfies noUnusedParameters (placeholder consumes nothing);
  // callers pass by record type — type-checking enforces exhaustiveness.
  _record:
    | LlmCallRecord
    | ToolCallRecord
    | TurnRecord
    | SubagentSpawnRecord
    | SubagentStopRecord
    | SubagentStateChangeRecord
): never {
  throw new Error("B-scenario not implemented");
}
