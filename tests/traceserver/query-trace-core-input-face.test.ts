import assert from "node:assert/strict";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, it } from "vitest";

import {
  createQueryTraceCore,
  QUERY_TRACE_MAX_LIMIT,
  type QueryTraceCoreHandler,
} from "../../src/traceserver/query-trace-core.ts";
import {
  TraceQueryRecordScanError,
  TraceQueryValidationError,
} from "../../src/traceserver/query-trace-errors.ts";

/**
 * Characterization baseline for the `query_trace` core's input face and session
 * resolution (plan `trace-mcp-read-side-split` T2, spec SC14).
 *
 * Pins what the unmodified core accepts / rejects today, the exact error text
 * (T5 removes the `query_trace: ` prefix and will rewrite those assertions),
 * and the implicit "most recent session" default that T7 replaces with
 * `session_not_found`.
 */

const DAY_MS = 86_400_000;
const traceDirs: string[] = [];

/**
 * What the core answers when there is nothing to answer with. Compared as a
 * parsed object, never as a whole string: the key order comes from the single
 * envelope constructor in src/traceserver/envelope.ts, but no contract fixes
 * that order, so a string pin would still break for a reason unrelated to
 * behaviour.
 */
const EMPTY_ENVELOPE = {
  records: [],
  total: 0,
  skipped_lines: 0,
  truncated: false,
  offset: 0,
};

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

/** Compare an empty envelope as data, never as a serialized string. */
function assertEmptyEnvelope(json: string, message?: string): void {
  const parsed = JSON.parse(json) as Record<string, unknown>;
  assert.deepEqual(
    Object.keys(parsed).sort(),
    Object.keys(EMPTY_ENVELOPE).sort(),
    message ?? "the empty envelope must carry exactly the five reader keys"
  );
  assert.deepEqual(parsed, EMPTY_ENVELOPE);
}

describe("query_trace core input face", () => {
  // T5 flip site, file-wide: every expected message below carries the literal
  // "query_trace: " prefix. That brittleness is deliberate — core owns no tool
  // name after T5 migrates prefix ownership into the two thin faces — and one
  // block-level marker is used instead of repeating a comment at each site so
  // that T5 has a single grep landing point that cannot miss a site.
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
        `query_trace: limit must be an integer in 1..${QUERY_TRACE_MAX_LIMIT}`
      );
    }

    for (const limit of [1, QUERY_TRACE_MAX_LIMIT]) {
      const parsed = JSON.parse(
        await core({ conversation_id: "c1", limit })
      ) as { records: unknown[] };
      assert.equal(parsed.records.length, 1, `limit ${limit} must be accepted`);
    }
  });

  it("rejects a negative resume_offset but accepts zero and any larger integer", async () => {
    const core = coreWithSession("c2");

    for (const resumeOffset of [-1, -1000, 0.5, "0"]) {
      const error = await rejectionOf(core, {
        conversation_id: "c2",
        resume_offset: resumeOffset,
      });
      assert.equal(error.field, "resume_offset");
      // resume_offset has no declared upper bound: parseInteger's default
      // `maximum` is Number.MAX_SAFE_INTEGER (see parseInteger in
      // query-trace-core.ts), so the message is built from that constant rather
      // than a transcribed digit string.
      assert.equal(
        error.message,
        `query_trace: resume_offset must be an integer in 0..${Number.MAX_SAFE_INTEGER}`
      );
    }

    for (const resumeOffset of [0, 4_096]) {
      const parsed = JSON.parse(
        await core({ conversation_id: "c2", resume_offset: resumeOffset })
      ) as { records: unknown[]; total: number };
      assert.equal(parsed.total, 1);
      assert.equal(parsed.records.length, 1);
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
        "query_trace: conversation_id must not contain path separators"
      );
    }
  });

  it("rejects empty strings and unknown enum values on the scalar axes", async () => {
    const core = coreWithSession("c4");

    const stringAxes: Array<[string, string]> = [
      [
        "conversation_id",
        "query_trace: conversation_id must be a non-empty string",
      ],
      ["record_id", "query_trace: record_id must be a non-empty string"],
      ["task_id", "query_trace: task_id must be a non-empty string"],
      ["turn_id", "query_trace: turn_id must be a non-empty string"],
      [
        "parent_turn_id",
        "query_trace: parent_turn_id must be a non-empty string",
      ],
    ];
    for (const [field, message] of stringAxes) {
      const error = await rejectionOf(core, {
        ...(field === "conversation_id" ? {} : { conversation_id: "c4" }),
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
    assert.equal(
      statusError.message,
      "query_trace: status must be one of: ok, error"
    );

    const recordTypeError = await rejectionOf(core, {
      conversation_id: "c4",
      record_type: "anything",
    });
    assert.equal(recordTypeError.field, "record_type");
    assert.equal(
      recordTypeError.message,
      "query_trace: record_type must be one of: llm_call, tool_call, turn, " +
        "violation, session, sandbox_cmd, subagent_spawn, subagent_stop, " +
        "subagent_state_change, subagent_step, verification, goal"
    );
  });

  it("rejects an unknown detail value on the detail axis", async () => {
    const traceDir = makeTraceDir();
    writeFileSync(join(traceDir, "c5.jsonl"), "");
    const core = createQueryTraceCore({ traceDir });

    // parseInput validates `detail` before anything touches the filesystem, so
    // the session file is deliberately empty: this rejection is not an IO
    // outcome.
    const error = await rejectionOf(core, {
      conversation_id: "c5",
      record_id: "llm-1",
      detail: "everything",
    });
    assert.equal(error.field, "detail");
    assert.equal(error.kind, "validation");
    assert.equal(
      error.message,
      "query_trace: detail must be one of: messages, tool_results"
    );
  });

  it("rejects a non-object input before touching the filesystem", async () => {
    const traceDir = makeTraceDir();
    const core = createQueryTraceCore({ traceDir });

    for (const input of [null, undefined, [], "c1", 42]) {
      const error = await rejectionOf(core, input);
      assert.equal(error.field, "input");
      assert.equal(error.message, "query_trace: input must be an object");
    }
  });

  it("hardcodes the query_trace prefix on both domain error classes", () => {
    // T5: flip site — the core stops naming the tool (query-trace-errors.ts:9 /
    // :22 lose the `query_trace: ` prefix) and each thin face adds its own, so
    // both message assertions below are rewritten there.
    const validation = new TraceQueryValidationError("limit", "boom");
    assert.equal(validation.message, "query_trace: boom");
    assert.equal(validation.name, "TraceQueryValidationError");
    assert.equal(validation.kind, "validation");
    assert.equal(validation.field, "limit");

    const scan = new TraceQueryRecordScanError("abc", 10_000);
    assert.equal(
      scan.message,
      "query_trace: record_id scan exhausted after 10000 records before finding 'abc'"
    );
    assert.equal(scan.name, "TraceQueryRecordScanError");
    assert.equal(scan.kind, "record_scan");
    assert.equal(scan.recordId, "abc");
    assert.equal(scan.scanned, 10_000);
  });

  it("defaults to the session with the greatest mtime when conversation_id is omitted", async () => {
    // T7: flip site — `conversation_id` becomes required on the tool face, so
    // this omitted-argument default retires there. The panel keeps its default
    // (ADR-0020 / SC-R 12) and does not reach this path.
    const traceDir = makeTraceDir();
    writeFileSync(join(traceDir, "aaa.jsonl"), row("aaa", "llm-aaa"));
    writeFileSync(join(traceDir, "zzz.jsonl"), row("zzz", "llm-zzz"));

    const now = new Date();
    const yesterday = new Date(now.getTime() - DAY_MS);
    const touch = (name: string, when: Date): void => {
      utimesSync(join(traceDir, name), when, when);
    };

    // Flip the mtimes twice: whichever file is newest must be the one queried,
    // which rules out file-name or readdir order as the deciding factor.
    touch("aaa.jsonl", yesterday);
    touch("zzz.jsonl", now);
    const core = createQueryTraceCore({ traceDir });
    const first = JSON.parse(await core({})) as {
      records: Array<Record<string, unknown>>;
    };
    assert.equal(first.records[0]["llm_call_id"], "llm-zzz");

    touch("aaa.jsonl", now);
    touch("zzz.jsonl", yesterday);
    const second = JSON.parse(await core({})) as {
      records: Array<Record<string, unknown>>;
    };
    assert.equal(second.records[0]["llm_call_id"], "llm-aaa");
  });

  it("returns the empty envelope instead of throwing when the trace dir holds no session", async () => {
    // T7: flip site — this call passes no `conversation_id`, so once the tool
    // face makes it required the call fails earlier, as `validation`, and never
    // reaches the empty-envelope branch. The "given an id that has no file" path
    // is the one that becomes `session_not_found` (pinned by the next test).
    const emptyDir = makeTraceDir();
    const missingDir = join(emptyDir, "not-created");

    for (const [label, dir] of [
      ["empty dir", emptyDir],
      ["never-created dir", missingDir],
    ] as const) {
      assertEmptyEnvelope(
        await createQueryTraceCore({ traceDir: dir })({}),
        `${label} must answer with the empty envelope, not throw`
      );
    }
  });

  it("reports a missing session file with the same empty envelope an empty session would give", async () => {
    const traceDir = makeTraceDir();
    writeFileSync(join(traceDir, "present.jsonl"), row("present", "llm-1"));
    writeFileSync(join(traceDir, "empty.jsonl"), "");
    const core = createQueryTraceCore({ traceDir });

    const missing = await core({ conversation_id: "no-such-session" });
    const empty = await core({ conversation_id: "empty" });

    // T7: flip site — no `session_not_found` signal today: a typo'd
    // conversation_id is indistinguishable from a session that recorded nothing.
    // (The comparison is shape-based on purpose: T4 owns the envelope literals.)
    assertEmptyEnvelope(
      missing,
      "a missing session must read as an empty page"
    );
    assert.equal(missing, empty);
  });
});
