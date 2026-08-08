/**
 * tests/harness/sandbox/output-mask-wiring.test.ts
 *
 * SC20 wiring tests: verify the previously-unused `createOutputMask` +
 * `currentSecretValues` are now actually masking the consumer-side output
 * boundaries (cli format, session-api hub.toTurnDto, jsonl trace writer).
 *
 * Test strategy: install a fake secret value via `process.env[llm.apiKeyEnv]`
 * with a SENTINEL token, then drive each output boundary with a finalText
 * that contains the sentinel; assert the output contains `***` and NOT the
 * sentinel. Env is restored in afterEach for isolation.
 */
import { describe, it, afterEach, beforeEach } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { formatRunJson, formatRunHuman } from "../../../src/cli/format.ts";
import {
  computeTotals,
  type LoopTrace,
  type RunResult,
} from "../../../src/harness/index.ts";
import { createJsonlTraceService } from "../../../src/harness/trace/jsonl.ts";
import { loadIknowEnv } from "../../../src/config/env.ts";

const SENTINEL = "sk-test-SENTINEL-123";

let savedEnvValue: string | undefined;
let savedEnvKey: string;
let hadEnv: boolean;

beforeEach(() => {
  const env = loadIknowEnv();
  savedEnvKey = env.llm.apiKeyEnv;
  hadEnv = Object.prototype.hasOwnProperty.call(process.env, savedEnvKey);
  savedEnvValue = process.env[savedEnvKey];
  process.env[savedEnvKey] = SENTINEL;
});

afterEach(() => {
  if (hadEnv) process.env[savedEnvKey] = savedEnvValue;
  else delete process.env[savedEnvKey];
});

function mkResult(over: Partial<RunResult> = {}): RunResult {
  return {
    finalText: "ok",
    messages: [],
    turnCount: 1,
    stopReason: "completed",
    // #160 T4:RunResult.lastUsage 必填字段;mkResult 默认 null(无 usage 视图)。
    lastUsage: null,
    ...over,
  };
}

function mkTrace(): LoopTrace {
  return { turns: [], totals: computeTotals([]) };
}

describe("output mask wiring (SC20)", () => {
  it("formatRunJson masks finalText when it contains a secret value", () => {
    const out = formatRunJson({
      result: mkResult({
        finalText: `token is ${SENTINEL} end`,
      }),
      trace: mkTrace(),
    });
    assert.ok(!out.includes(SENTINEL), "sentinel must not appear in JSON");
    assert.ok(out.includes("***"), "mask placeholder must appear");
    assert.ok(out.includes("token is ***"), "mask should replace in-place");
  });

  it("formatRunHuman masks the rendered text", () => {
    const out = formatRunHuman({
      result: mkResult({
        finalText: `prefix ${SENTINEL} suffix`,
      }),
      trace: mkTrace(),
    });
    assert.ok(
      !out.includes(SENTINEL),
      "sentinel must not appear in human output"
    );
    assert.ok(out.includes("***"));
  });

  it("formatRunJson leaves finalText=null unmasked (null is preserved)", () => {
    const out = formatRunJson({
      result: mkResult({ finalText: null, stopReason: "maxTurns" }),
      trace: mkTrace(),
    });
    const parsed = JSON.parse(out) as { finalText: unknown };
    assert.equal(parsed.finalText, null);
  });

  it("jsonl trace writer masks secret values in serialized records", () => {
    const scratch = mkdtempSync(join(tmpdir(), "sc20-mask-"));
    try {
      const trace = createJsonlTraceService({
        filePath: scratch,
        conversationId: "conv-mask-1",
      });
      // recordToolCall is the carrier most likely to embed tool payloads
      // (arguments / result). Inject the sentinel in the tool result.
      void trace.recordToolCall({
        toolCallId: "tc1",
        parentLlmCallId: "p1",
        toolName: "bash",
        arguments: { command: "echo" },
        result: {
          kind: "ok",
          payload: [{ type: "text", text: `out: ${SENTINEL}` }],
        },
        startedAt: 0,
        durationMs: 1,
      });
      const traceFile = join(scratch, "conv-mask-1.jsonl");
      assert.ok(existsSync(traceFile));
      const content = readFileSync(traceFile, "utf8");
      assert.ok(
        !content.includes(SENTINEL),
        "sentinel must not appear in trace file"
      );
      assert.ok(content.includes("***"));
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("formatRunJson does not mask when no secret env is set (currentSecretValues is empty)", () => {
    // Temporarily clear the env var (override the beforeEach setup).
    delete process.env[savedEnvKey];
    const out = formatRunJson({
      result: mkResult({
        finalText: `safe text with ${SENTINEL}`,
      }),
      trace: mkTrace(),
    });
    // With no secret value configured, currentSecretValues() returns []. The
    // createOutputMask returns a no-op pattern — output should pass through.
    assert.ok(
      out.includes(SENTINEL),
      "without a known secret value, output must not be masked"
    );
  });
});
