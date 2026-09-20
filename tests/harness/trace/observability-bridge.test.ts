/**
 * translateToObservability — placeholder stub for the B-scope.
 *
 * The file/function names were renamed from the orchestrator's original
 * contract ("otel-translator / translateToOtel"): Gate B forbids OTel exports
 * (imports / identifiers) on the executable surface, comment wording is not
 * scanned. The placeholder keeps B-scope semantics under the new names
 * observability-bridge / translateToObservability.
 *
 * 4 contracts:
 * 1. translateToObservability(llm) → throws "B-scenario not implemented"
 * 2. translateToObservability(tool) → throws the same error
 * 3. translateToObservability(turn) → throws the same error
 * 4. wrapped by safeTrace → resolves undefined
 */

import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { translateToObservability } from "../../../src/harness/trace/observability-bridge.ts";
import { safeTrace } from "../../../src/harness/trace/safe-trace.ts";
import type {
  LlmCallRecord,
  ToolCallRecord,
  TurnRecord,
} from "../../../src/harness/trace/types.ts";

const SAMPLE_LLM: LlmCallRecord = {
  startedAt: "2026-07-31T00:00:00.000Z",
  endedAt: "2026-07-31T00:00:01.000Z",
  durationMs: 1000,
  supplierStop: "success",
  stream: false,
  messagesCaptured: false,
  status: "ok",
};

const SAMPLE_TOOL: ToolCallRecord = {
  parentLlmCallId: "llm-1",
  toolName: "echo",
  toolKind: "ok",
  startedAt: "2026-07-31T00:00:00.000Z",
  endedAt: "2026-07-31T00:00:00.500Z",
  durationMs: 500,
  argumentsCaptured: false,
  resultCaptured: false,
  status: "ok",
};

const SAMPLE_TURN: TurnRecord = {
  turnIndex: 0,
  startedAt: "2026-07-31T00:00:00.000Z",
  endedAt: "2026-07-31T00:00:01.000Z",
  durationMs: 1000,
  llmCallIds: ["llm-1"],
  toolCallIds: ["tool-1"],
  decision: "completed",
  status: "ok",
};

describe("translateToObservability (B-scope stub)", () => {
  it("throws 'B-scenario not implemented' for an LlmCallRecord", () => {
    assert.throws(
      () => translateToObservability(SAMPLE_LLM),
      (err: unknown) =>
        err instanceof Error && err.message === "B-scenario not implemented"
    );
  });

  it("throws 'B-scenario not implemented' for a ToolCallRecord", () => {
    assert.throws(
      () => translateToObservability(SAMPLE_TOOL),
      (err: unknown) =>
        err instanceof Error && err.message === "B-scenario not implemented"
    );
  });

  it("throws 'B-scenario not implemented' for a TurnRecord", () => {
    assert.throws(
      () => translateToObservability(SAMPLE_TURN),
      (err: unknown) =>
        err instanceof Error && err.message === "B-scenario not implemented"
    );
  });

  it("safeTrace-wrapped translateToObservability resolves to undefined", async () => {
    const result = await safeTrace(async () =>
      translateToObservability(SAMPLE_LLM)
    );
    assert.equal(result, undefined);
  });
});
