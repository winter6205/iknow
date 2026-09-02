import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, it } from "vitest";

import {
  createQueryTraceCore,
  QUERY_TRACE_MAX_LIMIT,
  type QueryTraceCoreHandler,
} from "../../src/traceserver/query-trace-core.ts";
import {
  TraceQueryValidationError,
  TraceSessionNotFoundError,
} from "../../src/traceserver/query-trace-errors.ts";

/**
 * Contract suite for the `query_trace` core's input face and session
 * resolution (plan `trace-mcp-read-side-split` T7, spec SC14).
 *
 * Pins what the core accepts / rejects today, the exact error text it raises
 * (no tool name: the core backs several tools, and each thin face prefixes its
 * own). The implicit "most recent session" default that lived here in T2 is gone
 * — `conversation_id` is required on the tool face, and a missing file raises
 * `session_not_found`.
 */

const traceDirs: string[] = [];

afterEach(() => {
  for (const traceDir of traceDirs.splice(0)) {
    rmSync(traceDir, { recursive: true, force: true });
  }
});

function makeTraceDir(): string {
  const traceDir = mkdtempSync(join(tmpdir(), "iknow-query-trace-input-"));
  traceDirs.push(traceDir);
  return traceDir;
}

function row(conversationId: string, llmCallId: string): string {
  return `${JSON.stringify({
    record_type: "llm_call",
    conversation_id: conversationId,
    llm_call_id: llmCallId,
    turn_id: `turn-${llmCallId}`,
    started_at: "2026-01-01T00:00:00.000Z",
  })}\n`;
}

function coreWithSession(conversationId: string): QueryTraceCoreHandler {
  const traceDir = makeTraceDir();
  writeFileSync(
    join(traceDir, `${conversationId}.jsonl`),
    row(conversationId, "llm-1")
  );
  return createQueryTraceCore({ traceDir });
}

async function rejectionOf(
  core: QueryTraceCoreHandler,
  input: unknown
): Promise<TraceQueryValidationError> {
  try {
    await core(input);
  } catch (error) {
    assert.ok(
      error instanceof TraceQueryValidationError,
      `expected a TraceQueryValidationError, got ${String(error)}`
    );
    return error;
  }
  assert.fail(`input ${JSON.stringify(input)} was expected to be rejected`);
}

describe("query_trace core input face (T7)", () => {
  // Contract, file-wide: no expected message below carries a tool-name prefix.
  // The core is shared by every read-side tool, so naming one would misreport
  // the others; each thin face adds its own prefix.
  it("requires conversation_id on the tool face", async () => {
    const core = coreWithSession("c1");

    for (const input of [
      {},
      { conversation_id: "" },
      { conversation_id: 42 },
    ]) {
      const error = await rejectionOf(core, input);
      assert.equal(error.field, "conversation_id");
      assert.equal(error.kind, "validation");
      assert.equal(error.message, "conversation_id must be a non-empty string");
    }
  });

  it("rejects limit outside 1..QUERY_TRACE_MAX_LIMIT and accepts both bounds", async () => {
    const core = coreWithSession("c1");

    for (const limit of [
      0,
      -1,
      QUERY_TRACE_MAX_LIMIT + 1,
      1.5,
      Number.NaN,
      "5",
      "1",
    ]) {
      const error = await rejectionOf(core, { conversation_id: "c1", limit });
      assert.equal(error.field, "limit");
      assert.equal(error.kind, "validation");
      assert.equal(
        error.message,
        `limit must be an integer in 1..${QUERY_TRACE_MAX_LIMIT}`
      );
    }

    for (const limit of [1, QUERY_TRACE_MAX_LIMIT]) {
      const parsed = JSON.parse(
        await core({ conversation_id: "c1", limit })
      ) as { records: unknown[] };
      assert.equal(parsed.records.length, 1, `limit ${limit} must be accepted`);
    }
  });

  it("rejects a negative offset but accepts zero and any larger integer", async () => {
    const core = coreWithSession("c2");

    for (const offset of [-1, -1000, 0.5, "0"]) {
      const error = await rejectionOf(core, {
        conversation_id: "c2",
        offset,
      });
      assert.equal(error.field, "offset");
      // offset has no declared upper bound: parseInteger's default `maximum` is
      // Number.MAX_SAFE_INTEGER (see parse-integer.ts), so the message is built
      // from that constant rather than a transcribed digit string.
      assert.equal(
        error.message,
        `offset must be an integer in 0..${Number.MAX_SAFE_INTEGER}`
      );
    }

    for (const offset of [0, 100]) {
      const parsed = JSON.parse(
        await core({ conversation_id: "c2", offset })
      ) as { records: unknown[]; offset: number };
      assert.equal(parsed.offset, offset);
      // The fixture only carries one row, so any non-zero offset answers with
      // an empty page — that's `records.length < limit`, the tool face's
      // implicit end-of-data signal, NOT an error.
      assert.equal(parsed.records.length, offset === 0 ? 1 : 0);
    }
  });

  it("rejects a conversation_id carrying a path separator", async () => {
    const core = coreWithSession("c3");

    for (const conversationId of ["a/b", "a\\b", "../evil", "/abs"]) {
      const error = await rejectionOf(core, {
        conversation_id: conversationId,
      });
      assert.equal(error.field, "conversation_id");
      assert.equal(
        error.message,
        "conversation_id must not contain path separators"
      );
    }
  });

  it("rejects empty strings and unknown enum values on the scalar axes", async () => {
    const core = coreWithSession("c4");

    const stringAxes: Array<[string, string]> = [
      ["task_id", "task_id must be a non-empty string"],
      ["turn_id", "turn_id must be a non-empty string"],
      ["parent_turn_id", "parent_turn_id must be a non-empty string"],
    ];
    for (const [field, message] of stringAxes) {
      const error = await rejectionOf(core, {
        conversation_id: "c4",
        [field]: "",
      });
      assert.equal(error.field, field);
      assert.equal(error.message, message);
    }

    const statusError = await rejectionOf(core, {
      conversation_id: "c4",
      status: "failed",
    });
    assert.equal(statusError.field, "status");
    assert.equal(statusError.message, "status must be one of: ok, error");

    const recordTypeError = await rejectionOf(core, {
      conversation_id: "c4",
      record_type: "anything",
    });
    assert.equal(recordTypeError.field, "record_type");
    assert.equal(
      recordTypeError.message,
      "record_type must be one of: llm_call, tool_call, turn, " +
        "violation, session, sandbox_cmd, subagent_spawn, subagent_stop, " +
        "subagent_state_change, subagent_step, verification, goal"
    );
  });

  it("rejects a non-object input before touching the filesystem", async () => {
    const traceDir = makeTraceDir();
    const core = createQueryTraceCore({ traceDir });

    for (const input of [null, undefined, [], "c1", 42]) {
      const error = await rejectionOf(core, input);
      assert.equal(error.field, "input");
      assert.equal(error.message, "input must be an object");
    }
  });

  it("names no tool on either domain error class", () => {
    // The core backs several tools, so a message that named one would misreport
    // the others; prefixing is the thin faces' job.
    const validation = new TraceQueryValidationError("limit", "boom");
    assert.equal(validation.message, "boom");
    assert.equal(validation.name, "TraceQueryValidationError");
    assert.equal(validation.kind, "validation");
    assert.equal(validation.field, "limit");

    const session = new TraceSessionNotFoundError("missing-id");
    assert.equal(
      session.message,
      "no trace session file for conversation_id 'missing-id'"
    );
    assert.equal(session.name, "TraceSessionNotFoundError");
    assert.equal(session.kind, "session_not_found");
    assert.equal(session.conversationId, "missing-id");
  });

  it("raises session_not_found, not the silent empty envelope, when the conversation_id has no file", async () => {
    // T7: a typo'd conversation_id used to be indistinguishable from a session
    // that recorded nothing. Plan §执行期前提修正 第 14 条 — this throw is the
    // reason the read side's `TraceSessionNotFoundError` was given a real kind
    // (T6) before T7 reused it on the row axis.
    const traceDir = makeTraceDir();
    writeFileSync(join(traceDir, "present.jsonl"), row("present", "llm-1"));
    const core = createQueryTraceCore({ traceDir });

    let caught: unknown;
    try {
      await core({ conversation_id: "no-such-session" });
    } catch (error) {
      caught = error;
    }
    assert.ok(
      caught instanceof TraceSessionNotFoundError,
      `expected a TraceSessionNotFoundError, got ${String(caught)}`
    );
    assert.equal(caught.kind, "session_not_found");
    assert.equal(caught.conversationId, "no-such-session");
    assert.equal(
      caught.message,
      "no trace session file for conversation_id 'no-such-session'"
    );
  });

  it("does not silently default to the newest session when conversation_id is omitted", async () => {
    // T7: the tool face rejects a missing conversation_id at the input layer
    // (rejectionOf path above); this case asserts the rejection is the same one
    // a misconfigured host would see — never the implicit "most recent" answer
    // pre-T7 returned.
    const traceDir = makeTraceDir();
    writeFileSync(join(traceDir, "only.jsonl"), row("only", "llm-only"));
    const core = createQueryTraceCore({ traceDir });

    let caught: unknown;
    try {
      await core({});
    } catch (error) {
      caught = error;
    }
    assert.ok(
      caught instanceof TraceQueryValidationError,
      `expected a TraceQueryValidationError, got ${String(caught)}`
    );
    assert.equal(caught.field, "conversation_id");
  });
});
