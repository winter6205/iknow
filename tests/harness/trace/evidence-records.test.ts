/**
 * T8 / SC12: the runtime-evidence record kinds the JSONL trace service owns.
 *
 * Three gaps this file pins, all on the write side of the *existing* service
 * (no parallel transcript, no LoopTrace reuse):
 *
 *  1. `tool_call` carried `error.type = result.kind`, so a per-call
 *     `execution_failed` whose message is ADR-0091's `"timeout"` or ADR-0135's
 *     `"cancelled"` was indistinguishable from any other execution failure.
 *     The cause was in `error.message`, and the only reliable read was string
 *     equality on a model-facing message — exactly the "recognize it by
 *     matching an arbitrary message substring" the spec forbids. `cause` is
 *     the typed carrier.
 *  2. `tool_call` never carried the process-tree cleanup verdict ADR-0134 /
 *     cleanup-result.ts produced, so a timeout could not be read as "stopped"
 *     vs "stop requested and never proven".
 *  3. `recordViolation` did not exist: the `violation` row was hand-assembled
 *     by hub.ts with a raw `appendFileSync`, so a security interruption was
 *     written by a second writer with its own (absent) failure accounting.
 *
 * Postel throughout: every new field is absent when the engine had no source
 * for it, and absence stays the discriminator (a `not_started` cleanup and a
 * missing cleanup field are different facts and must not collapse).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createJsonlTraceService } from "../../../src/harness/trace/jsonl.ts";
import { createNoopTraceService } from "../../../src/harness/trace/noop.ts";
import type {
  ToolCallRecord,
  ViolationRecord,
  ToolCallCause,
  CleanupTraceEvidence,
} from "../../../src/harness/trace/types.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "iknow-trace-evidence-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function readRows(conversationId: string): Array<Record<string, unknown>> {
  return readFileSync(join(dir, `${conversationId}.jsonl`), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

function sampleToolCall(
  overrides: Partial<ToolCallRecord> = {}
): ToolCallRecord {
  return {
    parentLlmCallId: "llm-1",
    toolName: "bash",
    toolKind: "execution_failed",
    startedAt: "2026-09-30T00:00:00.000Z",
    endedAt: "2026-09-30T00:00:10.000Z",
    durationMs: 10_000,
    argumentsCaptured: true,
    arguments: { command: "sleep 30" },
    resultCaptured: false,
    status: "error",
    error: { type: "execution_failed", message: "timeout" },
    ...overrides,
  };
}

describe("tool_call cause (ADR-0091 timeout / ADR-0135 cancel)", () => {
  it("a per-call timeout is written as cause=timeout beside error.type=execution_failed", async () => {
    const trace = createJsonlTraceService({ filePath: dir, conversationId: "c1" });

    await trace.recordToolCall(sampleToolCall({ cause: "timeout" }));

    const [row] = readRows("c1");
    expect(row!["record_type"]).toBe("tool_call");
    // The ADR-0005 envelope is unchanged: kind stays execution_failed and the
    // message stays the literal "timeout" the model already saw.
    expect(row!["tool_kind"]).toBe("execution_failed");
    expect(row!["error"]).toEqual({ type: "execution_failed", message: "timeout" });
    // The new typed carrier is what a reviewer reads instead of the message.
    expect(row!["cause"]).toBe("timeout");
  });

  it("a security-interruption cancellation is written as cause=cancelled", async () => {
    const trace = createJsonlTraceService({ filePath: dir, conversationId: "c2" });

    await trace.recordToolCall(
      sampleToolCall({
        toolKind: "execution_failed",
        error: { type: "execution_failed", message: "cancelled" },
        cause: "cancelled",
      })
    );

    const [row] = readRows("c2");
    expect(row!["cause"]).toBe("cancelled");
    expect((row!["error"] as { message: string }).message).toBe("cancelled");
  });

  it("no cause field is written when the result carried no recognized cause", async () => {
    const trace = createJsonlTraceService({ filePath: dir, conversationId: "c3" });

    await trace.recordToolCall(
      sampleToolCall({
        error: { type: "validation_failed", message: "bad input" },
      })
    );

    const [row] = readRows("c3");
    // Postel: the key is absent, never a default. "absent" and "timeout" are
    // different facts and a reader must be able to tell them apart.
    expect("cause" in row!).toBe(false);
  });

  it("a security_review_unavailable denial keeps tool_kind=execution_failed and is not claimed as a violation", async () => {
    // The category boundary the trace must preserve: this failure is a policy
    // *verdict* (the reviewer could not be reached), not a confirmed security
    // violation and not a timeout. cause stays absent so no reader can count
    // it toward a streak from the trace alone.
    const trace = createJsonlTraceService({ filePath: dir, conversationId: "c4" });

    await trace.recordToolCall(
      sampleToolCall({
        error: {
          type: "execution_failed",
          message: "[security_review_unavailable] no reviewer configured",
        },
      })
    );

    const [row] = readRows("c4");
    expect(row!["tool_kind"]).toBe("execution_failed");
    expect((row!["error"] as { message: string }).message).toContain(
      "security_review_unavailable"
    );
    expect("cause" in row!).toBe(false);
  });
});

describe("tool_call cleanup evidence (ADR-0134 / cleanup-result.ts)", () => {
  it("an unconfirmed teardown is written verbatim with its typed reason and pgid", async () => {
    const cleanup: CleanupTraceEvidence = {
      state: "unconfirmed",
      reason: "observation_expired",
      pgid: 4242,
      detail: "process group 4242 still alive after 2000ms",
    };
    const trace = createJsonlTraceService({ filePath: dir, conversationId: "k1" });

    await trace.recordToolCall(sampleToolCall({ cause: "timeout", cleanup }));

    const [row] = readRows("k1");
    expect(row!["cause"]).toBe("timeout");
    expect(row!["cleanup"]).toEqual(cleanup);
    // The unconfirmed verdict must stay readable as such: a consumer that only
    // checks `state === "confirmed_stopped"` is the bug this shape prevents.
    expect((row!["cleanup"] as { state: string }).state).toBe("unconfirmed");
  });

  it("a confirmed stop carries its pgid, and a not_started teardown carries nothing else", async () => {
    const trace = createJsonlTraceService({ filePath: dir, conversationId: "k2" });

    await trace.recordToolCall(
      sampleToolCall({
        cleanup: { state: "confirmed_stopped", pgid: 99, task_id: "bg-1" },
      })
    );
    await trace.recordToolCall(
      sampleToolCall({
        cleanup: { state: "not_started" },
      })
    );

    const rows = readRows("k2");
    expect(rows[0]!["cleanup"]).toEqual({
      state: "confirmed_stopped",
      pgid: 99,
      task_id: "bg-1",
    });
    // `pgid` is absent in not_started because no teardown ran and no process
    // group was ever observed; writing pgid:0 would invent one.
    expect(rows[1]!["cleanup"]).toEqual({ state: "not_started" });
  });

  it("a result with no cleanup evidence omits the field entirely", async () => {
    const trace = createJsonlTraceService({ filePath: dir, conversationId: "k3" });

    await trace.recordToolCall(sampleToolCall({ cause: "cancelled" }));

    const [row] = readRows("k3");
    // Absent means "no teardown was reported" — a spawn failure, or a caller
    // cancel whose cleanup never ran. It is not a successful stop.
    expect("cleanup" in row!).toBe(false);
  });
});

describe("recordViolation (security interruption through the shared service)", () => {
  const INTERRUPTION: ViolationRecord = {
    ts: "2026-09-30T00:00:12.000Z",
    tier: "mid",
    tool: "bash",
    message: "[hard_wall] dangerous command: rm -rf /",
    turnId: "turn-7",
    confirmedViolations: 3,
    cleanup: [
      {
        kind: "background_task",
        id: "bg-9",
        state: "confirmed_stopped",
        cleanup: { state: "confirmed_stopped", pgid: 77, task_id: "bg-9" },
      },
      {
        kind: "subagent",
        id: "sub-3",
        state: "stop_requested",
        cleanup: { state: "not_started" },
      },
      {
        kind: "background_task",
        id: "bg-10",
        state: "unconfirmed",
        reason: "no_background_cancel_route",
        cleanup: { state: "not_started" },
      },
    ],
  };

  it("writes a violation row carrying the turn id, the count and per-item cleanup", async () => {
    const trace = createJsonlTraceService({ filePath: dir, conversationId: "v1" });

    const id = await trace.recordViolation(INTERRUPTION);

    expect(id).toBeTypeOf("string");
    const [row] = readRows("v1");
    expect(row!["conversation_id"]).toBe("v1");
    expect(row!["record_type"]).toBe("violation");
    expect(row!["tier"]).toBe("mid");
    expect(row!["tool"]).toBe("bash");
    expect(row!["turn_id"]).toBe("turn-7");
    expect(row!["confirmed_violations"]).toBe(3);
    expect(row!["ts"]).toBe(INTERRUPTION.ts);
  });

  it("preserves each cancelled item's owner id and its cleanup verdict verbatim", async () => {
    const trace = createJsonlTraceService({ filePath: dir, conversationId: "v2" });

    await trace.recordViolation(INTERRUPTION);

    const [row] = readRows("v2");
    const cleanup = row!["cleanup"] as Array<Record<string, unknown>>;
    expect(cleanup).toHaveLength(3);
    // Owner identity per item: a reviewer must be able to name WHICH task this
    // turn cancelled, not merely that something was cancelled.
    expect(cleanup.map((c) => c["id"])).toEqual(["bg-9", "sub-3", "bg-10"]);
    expect(cleanup.map((c) => c["kind"])).toEqual([
      "background_task",
      "subagent",
      "background_task",
    ]);
    // All three cleanup outcomes survive; none is flattened to a boolean.
    expect(cleanup.map((c) => c["state"])).toEqual([
      "confirmed_stopped",
      "stop_requested",
      "unconfirmed",
    ]);
    expect(cleanup[2]!["reason"]).toBe("no_background_cancel_route");
    expect(cleanup[0]!["cleanup"]).toEqual({
      state: "confirmed_stopped",
      pgid: 77,
      task_id: "bg-9",
    });
  });

  it("a high-tier immediate kill records tier=high with no cleanup fabrication", async () => {
    const trace = createJsonlTraceService({ filePath: dir, conversationId: "v3" });

    await trace.recordViolation({
      ts: "2026-09-30T00:00:12.000Z",
      tier: "high",
      tool: "bash",
      message: "[hard_wall] secret env access",
      confirmedViolations: 1,
    });

    const [row] = readRows("v3");
    expect(row!["tier"]).toBe("high");
    // No cleanup pass ran for the immediate arm, so the key is absent rather
    // than an empty array a reader could count as "nothing needed stopping".
    expect("cleanup" in row!).toBe(false);
  });

  it("a write failure returns undefined and is counted as a trace write failure", async () => {
    // The shared service's failure contract: the interruption report is
    // best-effort observability and must not throw into the turn that is
    // already stopping, but it must also not disappear silently.
    const failing = createJsonlTraceService({
      filePath: dir,
      conversationId: "v4",
      writer: () => {
        throw new Error("ENOSPC");
      },
    });

    const id = await failing.recordViolation(INTERRUPTION);

    expect(id).toBeUndefined();
    expect(failing.traceWriteFailures).toBe(1);
  });

  it("the noop service implements recordViolation and reports no write failure", async () => {
    const svc = createNoopTraceService();

    const id = await svc.recordViolation(INTERRUPTION);

    expect(id).toBeUndefined();
    expect(svc.traceWriteFailures).toBe(0);
  });
});
