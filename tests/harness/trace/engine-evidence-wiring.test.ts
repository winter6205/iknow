/**
 * T8 / SC12: loop-engine is the only place that sees a tool result, so it is
 * the only place that can put the result's *own* facts on the trace.
 *
 * `evidence-records.test.ts` pins the record shapes; this file pins the
 * wiring — that the engine actually reads ADR-0091's `message: "timeout"` /
 * ADR-0135's `message: "cancelled"` envelope and ADR-0134's `cleanup` field
 * off the executor result and reports them, rather than a reviewer having to
 * string-match a model-facing message.
 *
 * The engine under test is the real one; only the model and the tools are
 * stubs, and the trace writer is the production JSONL service against a real
 * temporary file (test.md: use the production writer against real files).
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { run } from "../../../src/harness/loop-engine.ts";
import type {
  Executor,
  ToolCall,
  ToolExecutionResult,
} from "../../../src/harness/tools/types.ts";
import { createRegistry } from "../../../src/harness/tools/registry.ts";
import { createStubModel } from "../../../src/harness/stubs/stub-model.ts";
import { createStubTool } from "../../../src/harness/stubs/stub-tool.ts";
import { createJsonlTraceService } from "../../../src/harness/trace/jsonl.ts";
import { assistantResult } from "../../cli/_fixtures.ts";
import { parseJsonl } from "./_fixtures.ts";

const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length > 0) {
    const d = tmpDirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

/** Registry with a single never-called tool; the executor below ignores it. */
function registry() {
  return createRegistry([createStubTool({ name: "bash", next: () => ({}) })]);
}

/**
 * An executor that answers every call with a caller-supplied result. Keeps the
 * engine real (wave scheduling, turn record, stop flags) while pinning exactly
 * which tool outcome is under test.
 */
function fixedExecutor(
  make: (call: ToolCall) => ToolExecutionResult
): Executor {
  return Object.freeze({
    executeAll: async (calls: ReadonlyArray<ToolCall>) =>
      calls.map((call) => make(call)),
  });
}

async function runWithFixedResult(
  conversationId: string,
  make: (call: ToolCall) => ToolExecutionResult
): Promise<Array<Record<string, unknown>>> {
  const dir = mkdtempSync(join(tmpdir(), "iknow-trace-wiring-"));
  tmpDirs.push(dir);
  const trace = createJsonlTraceService({ filePath: dir, conversationId });
  const model = createStubModel({
    responses: [
      assistantResult({
        texts: [],
        toolCalls: [{ id: "t1", name: "bash", input: { command: "sleep 30" } }],
      }),
      assistantResult({
        texts: ["done"],
        toolCalls: [],
        supplierStop: "success",
      }),
    ],
  });
  await run("go", {
    adapter: model,
    executor: fixedExecutor(make),
    registry: registry(),
    maxTurns: 5,
    trace,
  });
  return parseJsonl(join(dir, `${conversationId}.jsonl`));
}

function toolCallRows(
  rows: ReadonlyArray<Record<string, unknown>>
): Array<Record<string, unknown>> {
  return rows.filter((r) => r["record_type"] === "tool_call");
}

describe("loop-engine records a per-call timeout with its cause", () => {
  it("an execution_failed message of timeout becomes cause=timeout, not just a message string", async () => {
    const rows = await runWithFixedResult("w-timeout", (call) => ({
      kind: "execution_failed",
      toolUseId: call.id,
      message: "timeout",
    }));

    const [row] = toolCallRows(rows);
    // The ADR-0005 envelope is untouched...
    expect(row!["tool_kind"]).toBe("execution_failed");
    expect(row!["error"]).toEqual({
      type: "execution_failed",
      message: "timeout",
    });
    // ...and the typed cause a reviewer reads is now on the row.
    expect(row!["cause"]).toBe("timeout");
  });

  it("ADR-0091 holds: a per-call timeout is NOT a turn timeout in the trace", async () => {
    const rows = await runWithFixedResult("w-timeout-noturn", (call) => ({
      kind: "execution_failed",
      toolUseId: call.id,
      message: "timeout",
    }));

    const turn = rows.find((r) => r["record_type"] === "turn")!;
    // The per-call clock fired; the turn continued and completed normally.
    // This is the ADR-0091 contract the spec keeps frozen, and a regression
    // here would silently convert a tool timeout into a turn-cap failure that
    // a later attribution pass would read as model inability.
    expect(turn["decision"]).toBe("completed");
    expect(turn["status"]).toBe("ok");
  });
});

describe("loop-engine records a security-interruption cancellation", () => {
  it("an execution_failed message of cancelled becomes cause=cancelled", async () => {
    const rows = await runWithFixedResult("w-cancel", (call) => ({
      kind: "execution_failed",
      toolUseId: call.id,
      message: "cancelled",
    }));

    const [row] = toolCallRows(rows);
    expect(row!["cause"]).toBe("cancelled");
    expect((row!["error"] as { message: string }).message).toBe("cancelled");
  });
});

describe("loop-engine records the process-tree cleanup verdict", () => {
  it("an unconfirmed teardown reaches the trace with its typed reason and pgid", async () => {
    const cleanup = {
      state: "unconfirmed" as const,
      reason: "observation_expired" as const,
      pgid: 31337,
      detail: "process group 31337 still alive after 2000ms",
    };
    const rows = await runWithFixedResult("w-cleanup-unconf", (call) => ({
      kind: "execution_failed",
      toolUseId: call.id,
      message: "timeout",
      cleanup,
    }));

    const [row] = toolCallRows(rows);
    expect(row!["cleanup"]).toEqual(cleanup);
    // All three facts coexist on one row: the filterable cause names the
    // unproven teardown, the ADR-0005 envelope keeps the timeout the model
    // saw, and the cleanup body carries the typed observation verdict.
    // Collapsing any of them is what a boolean cleanup flag would have done.
    expect(row!["cause"]).toBe("cleanup_unconfirmed");
    expect((row!["error"] as { message: string }).message).toBe("timeout");
    expect((row!["cleanup"] as { state: string }).state).toBe("unconfirmed");
  });

  it("a confirmed stop is distinguishable from a stop that was only requested", async () => {
    const confirmed = await runWithFixedResult("w-cleanup-conf", (call) => ({
      kind: "execution_failed",
      toolUseId: call.id,
      message: "cancelled",
      cleanup: { state: "confirmed_stopped" as const, pgid: 5 },
    }));

    expect(toolCallRows(confirmed)[0]!["cleanup"]).toEqual({
      state: "confirmed_stopped",
      pgid: 5,
    });
  });

  it("an unconfirmed teardown is flagged on the cause so a filter cannot read it as a clean stop", async () => {
    const rows = await runWithFixedResult("w-cleanup-flag", (call) => ({
      kind: "execution_failed",
      toolUseId: call.id,
      message: "timeout",
      cleanup: {
        state: "unconfirmed" as const,
        reason: "teardown_failed" as const,
        pgid: 8,
        detail: "kill -8 KILL failed (EPERM)",
      },
    }));

    const [row] = toolCallRows(rows);
    // The reason is carried twice on purpose: structurally in cleanup.reason,
    // and as a cause a reader can filter on without parsing the cleanup body.
    expect(row!["cause"]).toBe("cleanup_unconfirmed");
    expect((row!["cleanup"] as { reason: string }).reason).toBe("teardown_failed");
  });

  it("a result with no cleanup evidence leaves the field absent", async () => {
    const rows = await runWithFixedResult("w-cleanup-none", (call) => ({
      kind: "execution_failed",
      toolUseId: call.id,
      message: "cancelled",
    }));

    expect("cleanup" in toolCallRows(rows)[0]!).toBe(false);
  });
});

describe("policy verdicts stay readable as facts, not verdicts", () => {
  it("a hard-wall denial is recorded with its message but no cause and no cleanup", async () => {
    // The trace records what the gate said. It does not decide that the gate
    // was right — that judgement is the attribution task's, and the raw
    // pass/fail it reads must stay unchanged.
    const message = "[hard_wall] dangerous command: rm -rf /";
    const rows = await runWithFixedResult("w-wall", (call) => ({
      kind: "execution_failed",
      toolUseId: call.id,
      message,
    }));

    const [row] = toolCallRows(rows);
    expect((row!["error"] as { message: string }).message).toBe(message);
    expect(row!["tool_name"]).toBe("bash");
    expect("cause" in row!).toBe(false);
    expect("cleanup" in row!).toBe(false);
  });

  it("a validation failure keeps its own kind and is not recast as an execution fault", async () => {
    const rows = await runWithFixedResult("w-invalid", (call) => ({
      kind: "validation_failed",
      toolUseId: call.id,
      message: "timeout_ms must be a positive integer",
    }));

    const [row] = toolCallRows(rows);
    expect(row!["tool_kind"]).toBe("validation_failed");
    expect((row!["error"] as { type: string }).type).toBe("validation_failed");
    // ADR-0134: invalid input fails before launch, so there is no process and
    // no cleanup to report — and the message merely containing the word
    // "timeout" must not promote this to cause=timeout.
    expect("cause" in row!).toBe(false);
    expect("cleanup" in row!).toBe(false);
  });
});
