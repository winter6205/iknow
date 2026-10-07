/**
 * tests/harness/sandbox/output-mask-wiring.test.ts
 *
 * Wiring tests: verify the previously-unused `createOutputMask` +
 * `currentSecretValues` are now actually masking the consumer-side output
 * boundaries (cli format, session-api hub.toTurnDto, jsonl trace writer).
 *
 * Test strategy: install a fake secret value via `process.env[<apikey var>]`
 * with a SENTINEL token, then drive each output boundary with a finalText
 * that contains the sentinel; assert the output contains `***` and NOT the
 * sentinel. Env is restored in afterEach for isolation.
 *
 * For the masking side, secret variable names no longer come from
 * env.llm.apiKeyEnv (that field retired); they are resolved by env-isolation's
 * configuredSecretNames:
 *   - the variable names pointed to by settings.llm.apiKey `${VAR}` placeholders;
 *   - fallback: names in process.env matching SECRET_PATTERN
 *     (/API[_-]?KEY|SECRET|TOKEN|PASSWD|PASSWORD|PRIVATE[_-]?KEY/i).
 * This test sets settings.llm.apiKey to `${IKNOW_SC20_TEST_SECRET}` via
 * installTestSettingsSource and injects SENTINEL into that variable —
 * configuredSecretNames collects the variable name, currentSecretValues returns
 * [SENTINEL], and masking takes effect.
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
import { installTestSettingsSource } from "../../_helpers/install-test-settings-source.ts";

const SENTINEL = "sk-test-SENTINEL-123";
const SECRET_VAR = "IKNOW_SC20_TEST_SECRET";

let settingsSource: ReturnType<typeof installTestSettingsSource>;
let savedEnvValue: string | undefined;
let hadEnv: boolean;

beforeEach(() => {
  settingsSource = installTestSettingsSource({
    model: "test-model",
    apiKeyVar: SECRET_VAR,
    apiKeyValue: SENTINEL,
  });
  hadEnv = Object.prototype.hasOwnProperty.call(process.env, SECRET_VAR);
  savedEnvValue = process.env[SECRET_VAR];
});

afterEach(() => {
  if (hadEnv) process.env[SECRET_VAR] = savedEnvValue;
  else delete process.env[SECRET_VAR];
  settingsSource.restore();
});

function mkResult(over: Partial<RunResult> = {}): RunResult {
  return {
    finalText: "ok",
    messages: [],
    turnCount: 1,
    stopReason: "completed",
    // RunResult.lastUsage is a required field; mkResult defaults it to null (no usage view).
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
        parentLlmCallId: "p1",
        toolName: "bash",
        toolKind: "ok",
        argumentsCaptured: true,
        arguments: { command: "echo" },
        resultCaptured: true,
        result: {
          kind: "ok",
          payload: [{ type: "text", text: `out: ${SENTINEL}` }],
        },
        startedAt: "1970-01-01T00:00:00.000Z",
        endedAt: "1970-01-01T00:00:00.001Z",
        durationMs: 1,
        status: "ok",
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
    delete process.env[SECRET_VAR];
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
