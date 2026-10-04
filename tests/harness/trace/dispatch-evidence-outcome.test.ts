/**
 * Per-entry outcome of the dispatch-evidence channel.
 *
 * A settled `llm_call` row can hold more than one entry: transport retry
 * re-enters the same model step, and every attempt reports its own request.
 * The row-level `status` describes only the SETTLED outcome, so the per-entry
 * `outcome` is what keeps a rejected attempt from reading as a success
 * (ADR-0136 D8).
 *
 * The observable is the row on disk, parsed from a real JSONL file written by
 * the production `createJsonlTraceService`; the retry case is driven through the
 * real `withTransportRetry` decorator and the real fault translation, not a
 * hand-built evidence array.
 */

import { describe, it, afterEach } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { APIConnectionError } from "@anthropic-ai/sdk";
import { createJsonlTraceService } from "../../../src/harness/trace/jsonl.ts";
import type {
  DispatchEvidenceEntry,
  LlmCallRecord,
} from "../../../src/harness/trace/types.ts";
import { run, type LoopAdapter } from "../../../src/harness/loop-engine.ts";
import { withTransportRetry } from "../../../src/harness/model-adapter/with-transport-retry.ts";
import { translateAnthropicTransportFault } from "../../../src/harness/model-adapter/anthropic-adapter.ts";
import type {
  LoopState,
  SdkDispatchEvidence,
} from "../../../src/harness/model-adapter/types.ts";
import { createRegistry } from "../../../src/harness/tools/registry.ts";
import { createStubModel } from "../../../src/harness/stubs/stub-model.ts";
import { createStubTool } from "../../../src/harness/stubs/stub-tool.ts";
import { assistantResult } from "../../cli/_fixtures.ts";
import { parseJsonl } from "./_fixtures.ts";

const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length > 0) {
    const d = tmpDirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

function poolDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "iknow-evidence-outcome-"));
  tmpDirs.push(dir);
  return dir;
}

function evidenceOf(row: Record<string, unknown>): DispatchEvidenceEntry[] {
  return (
    (row["dispatch_evidence"] as DispatchEvidenceEntry[] | undefined) ?? []
  );
}

const MESSAGES = [{ role: "user", content: [{ type: "text", text: "go" }] }];

function llmCall(status: LlmCallRecord["status"]): LlmCallRecord {
  return {
    startedAt: "2026-10-03T00:00:00.000Z",
    endedAt: "2026-10-03T00:00:01.000Z",
    durationMs: 1000,
    stream: true,
    messagesCaptured: true,
    status,
    dispatchEvidence: [
      { invocationId: "inv-1", stream: true, messages: MESSAGES },
    ],
  };
}

describe("dispatch evidence — settled outcome at write time", () => {
  it("a single-attempt success records one ok entry", async () => {
    const dir = poolDir();
    const trace = createJsonlTraceService({
      filePath: dir,
      conversationId: "conv-ok",
    });
    await trace.recordLlmCall(llmCall("ok"));

    const [row] = parseJsonl(join(dir, "conv-ok.jsonl"));
    const entries = evidenceOf(row!);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.outcome, "ok");
  });

  it("a row whose status is error never records an ok entry", async () => {
    const dir = poolDir();
    const trace = createJsonlTraceService({
      filePath: dir,
      conversationId: "conv-error",
    });
    await trace.recordLlmCall(llmCall("error"));

    const [row] = parseJsonl(join(dir, "conv-error.jsonl"));
    const entries = evidenceOf(row!);
    assert.equal(row!["status"], "error");
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.outcome, "failed");
    assert.equal(
      entries.some((e) => e.outcome === "ok"),
      false
    );
  });

  it("persists the outcome on every entry, with no other key added", async () => {
    const dir = poolDir();
    const trace = createJsonlTraceService({
      filePath: dir,
      conversationId: "conv-keys",
    });
    await trace.recordLlmCall(llmCall("ok"));

    const [row] = parseJsonl(join(dir, "conv-keys.jsonl"));
    assert.deepEqual(Object.keys(evidenceOf(row!)[0]!).sort(), [
      "invocationId",
      "messages",
      "outcome",
      "stream",
    ]);
  });
});

/**
 * Model boundary double: reports the request it was handed (as the real
 * adapter does, before dispatch) and then answers with the scripted result —
 * or rejects the first attempt with a connection-class fault, so the REAL
 * `withTransportRetry` re-enters `step` and the engine's single sink collects
 * two invocations in order.
 */
function rejectingOnceAdapter(
  emitted: Array<SdkDispatchEvidence>
): LoopAdapter {
  const inner = createStubModel({
    responses: [
      assistantResult({
        texts: ["done"],
        toolCalls: [],
        supplierStop: "success",
      }),
    ],
  });
  let minted = 0;
  return {
    ...inner,
    streamMode: true,
    async step(
      state: LoopState,
      request: {
        tools?: unknown;
        system?: string;
        onDispatch?: (evidence: SdkDispatchEvidence) => void;
      },
      signal?: AbortSignal
    ) {
      minted += 1;
      const evidence: SdkDispatchEvidence = {
        invocationId: `inv-${minted}`,
        stream: true,
        messages: state.messages,
        ...(request.system !== undefined ? { system: request.system } : {}),
        ...(Array.isArray(request.tools) ? { tools: request.tools } : {}),
      };
      emitted.push(evidence);
      request.onDispatch?.(evidence);
      if (minted === 1) {
        throw new APIConnectionError({ message: "connection reset" });
      }
      return inner.step(state, request, signal);
    },
  };
}

describe("dispatch evidence — a rejected attempt stays failed evidence", () => {
  it("two attempts of one retried step read failed then ok on the on-disk row", async () => {
    const dir = poolDir();
    const trace = createJsonlTraceService({
      filePath: dir,
      conversationId: "conv-retry",
    });
    const emitted: Array<SdkDispatchEvidence> = [];
    // Real retry decorator over the real Anthropic fault translation; only the
    // backoff sleep is stubbed so the test does not idle.
    const adapter = withTransportRetry(rejectingOnceAdapter(emitted), {
      translate: translateAnthropicTransportFault,
      sleep: async () => undefined,
    });

    await run("go", {
      adapter,
      executor: { executeAll: async () => [] },
      registry: createRegistry([
        createStubTool({ name: "bash", next: () => ({}) }),
      ]),
      maxTurns: 5,
      system: async () => "you are the harness",
      trace,
    });

    assert.equal(emitted.length, 2, "the retry must be a second real dispatch");
    const row = parseJsonl(join(dir, "conv-retry.jsonl")).find(
      (r) => r["record_type"] === "llm_call"
    )!;
    assert.equal(row["status"], "ok");
    const entries = evidenceOf(row);
    assert.equal(entries.length, 2);
    // Order follows invocation order, identity stays distinct per attempt.
    assert.deepEqual(
      entries.map((e) => e.invocationId),
      ["inv-1", "inv-2"]
    );
    // The rejected attempt is not readable as a success; only the settled
    // invocation carries the row's ok.
    assert.deepEqual(
      entries.map((e) => e.outcome),
      ["failed", "ok"]
    );
  });
});
