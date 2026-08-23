/**
 * translateToObservability (B-scope 占位 stub, GH #64)。
 *
 * 文件名 / 函数名 rename 自 orchestrator 原始 contract 的 "otel-translator / translateToOtel":
 * Gate B 禁止可执行面出现 OTel 导出（import / 标识符），注释用词不扫。
 * 占位 stub 改用 observability-bridge / translateToObservability 命名,
 * 保持 B-scope 占位语义不变。
 *
 * 4 项契约:
 * 1. translateToObservability(llm) → 抛 "B-scenario not implemented"
 * 2. translateToObservability(tool) → 抛同样错误
 * 3. translateToObservability(turn) → 抛同样错误
 * 4. safeTrace 包裹后 → resolves undefined
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
