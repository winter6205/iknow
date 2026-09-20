import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, it } from "vitest";

import { ToolExecutionError } from "../../../../src/harness/errors.ts";
import {
  createGetRecordTool,
  GetRecordNotFoundError,
  GetRecordScanError,
  GetRecordSessionNotFoundError,
  GetRecordValidationError,
  GetRecordWindowOverflowError,
} from "../../../../src/harness/aci/tools/get-record.ts";
import {
  ACI_TOOLSET_NAMES,
  createDefaultAciRegistry,
} from "../../../../src/harness/aci/tools/registry.ts";
import {
  createGetRecordCore,
  GET_RECORD_DEFAULT_COUNT,
  GET_RECORD_MAX_COUNT,
  GET_RECORD_DESCRIPTION,
} from "../../../../src/traceserver/get-record-core.ts";
import { TRACE_OUTPUT_BACKSTOP } from "../../../../src/traceserver/output-backstop.ts";

/**
 * `get_record` on the ACI face — the content axis of the trace read-side tools.
 *
 * Reading, windowing and serialization are the shared core's and are pinned in
 * `tests/traceserver/`. What this file owns is the face: ACI metadata, the
 * schema bounds the executor's ajv gate enforces, and the domain-error → typed
 * error translation carrying **this face's** tool name.
 *
 * Why the kind-mapping tests live here and not on the MCP face: the MCP thin
 * face wraps its whole handler in one catch that renders any thrown error as
 * `isError` text (`src/trace-mcp/server.ts`), so an **unmapped** error still
 * looks handled from that side — the test would pass whether or not the arm
 * exists. Only the ACI face distinguishes a translated `ToolExecutionError`
 * from a bare `Error` escaping through `throw error`, so one test per raisable
 * kind is written against this face.
 */

const scratchPaths: string[] = [];
const RESULT_TEXT = "tool output secret";
const OVERSIZE_NOTE_CHARS = 25_000;
/** Sessions live in the two-level tree `<dir>/projects/<slug>/<convId>/trace.jsonl`. */
const TEST_PROJECT_SLUG = "test-project-aci-get-record";

function makeTraceDir(prefix = "iknow-get-record-aci-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchPaths.push(dir);
  return dir;
}

function writeSession(dir: string, conversationId: string, rows: unknown[]) {
  mkdirSync(join(dir, "projects", TEST_PROJECT_SLUG, conversationId), {
    recursive: true,
  });
  writeFileSync(
    join(dir, "projects", TEST_PROJECT_SLUG, conversationId, "trace.jsonl"),
    rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
    "utf8"
  );
}

afterEach(() => {
  for (const path of scratchPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

/** An addressable record carrying one tool_result part (`RESULT_TEXT`, 18 chars). */
function toolResultRow(
  conversationId: string,
  llmCallId: string,
  resultText = RESULT_TEXT,
  extraScalars: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    conversation_id: conversationId,
    record_type: "llm_call",
    llm_call_id: llmCallId,
    status: "ok",
    ...extraScalars,
    messages: [
      { role: "user", content: "the prompt" },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "toolu-1", name: "lookup", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu-1", content: resultText },
        ],
      },
    ],
  };
}

function makeRecordDir(): string {
  const dir = makeTraceDir();
  writeSession(dir, "c1", [
    toolResultRow("c1", "llm-target"),
    toolResultRow("c1", "llm-other", "second result"),
  ]);
  return dir;
}

/**
 * Largest legal window + a record scalar that alone exceeds the backstop.
 * Proves the ACI face applies no tool-level character cap: this fixture's
 * payload far exceeds `TRACE_OUTPUT_BACKSTOP`, so any cap imposed on the thin
 * face would immediately cut it.
 */
function makeWideRecordDir(): string {
  const dir = makeTraceDir("iknow-get-record-aci-wide-");
  writeSession(dir, "c1", [
    toolResultRow("c1", "llm-wide", "a".repeat(GET_RECORD_MAX_COUNT), {
      oversize_note: "n".repeat(OVERSIZE_NOTE_CHARS),
    }),
  ]);
  return dir;
}

/** Scan to `TRACE_RECORD_ID_SCAN_LIMIT` with no hit: fills 10,001 rows like the record-axis case, no injected reader. */
function makeScanCapDir(): string {
  const dir = makeTraceDir("iknow-get-record-aci-scan-");
  const rows = Array.from({ length: 10_001 }, (_, index) => ({
    conversation_id: "c1",
    record_type: "llm_call",
    llm_call_id: index === 10_000 ? "past-scan-cap" : `llm-${index}`,
    status: "ok",
    messages: [],
  }));
  writeSession(dir, "c1", rows);
  return dir;
}

describe("get_record ACI tool", () => {
  it("carries the read-only ACI metadata this axis needs", () => {
    const tool = createGetRecordTool(makeRecordDir());

    assert.equal(tool.name, "get_record");
    assert.equal(tool.aci.category, "read-only");
    assert.equal(tool.aci.isConcurrencySafe, true);
    assert.equal(tool.aci.interruptBehavior, "cancel");
    assert.equal(tool.aci.timeoutTier, "fast");
  });

  it("reuses the core's description verbatim and claims no character cap (SC7)", () => {
    const tool = createGetRecordTool(makeRecordDir());

    // Single source: both faces share the core's one description; this face must not compose its own.
    assert.equal(tool.description, GET_RECORD_DESCRIPTION);
    // The description must contain no character-cap wording. Wording without a cap is easy
    // today; the risk is someone later appending "at most N characters", so pin it positively
    // here instead of relying on review.
    assert.match(tool.description, /exactly count characters/);
    assert.doesNotMatch(tool.description, /capped at \d+ characters/i);
    assert.doesNotMatch(tool.description, /at most \d+ characters/i);
  });

  it("declares the two id axes required and the bounds the core re-checks", async () => {
    const tool = createGetRecordTool(makeRecordDir());
    const schema = tool.inputSchema as {
      type: string;
      required: string[];
      additionalProperties: boolean;
      properties: Record<string, Record<string, unknown>>;
    };

    assert.equal(schema.type, "object");
    assert.equal(schema.additionalProperties, false);
    // Assumption 4: no "default = most recently active session" on this face — both ids are required.
    assert.deepEqual(schema.required, ["conversation_id", "record_id"]);
    assert.deepEqual(Object.keys(schema.properties).sort(), [
      "conversation_id",
      "count",
      "detail",
      "from_char",
      "message_index",
      "part_index",
      "record_id",
    ]);
    assert.deepEqual(schema.properties["count"], {
      type: "integer",
      minimum: 1,
      maximum: GET_RECORD_MAX_COUNT,
      default: GET_RECORD_DEFAULT_COUNT,
    });

    // "Same bounds" cannot live only in the schema: the core must re-check with the same
    // pair, otherwise a thin-face slip goes unguarded. This out-of-range call goes through
    // the handler (the layer before the executor), so the message shape is the core's `validation`.
    await assert.rejects(
      () =>
        tool.handler({
          conversation_id: "c1",
          record_id: "llm-target",
          count: GET_RECORD_MAX_COUNT + 1,
        }),
      (error: unknown) =>
        error instanceof GetRecordValidationError &&
        error.message ===
          `get_record: count must be an integer in 1..${GET_RECORD_MAX_COUNT}`
    );
    assert.equal(
      schema.properties["count"]?.["maximum"],
      GET_RECORD_MAX_COUNT,
      "the face's upper bound and the core's re-check must be one number"
    );
  });

  it("is assembled unconditionally at the trace read-side content axis tail and its bounds are enforced by ajv", () => {
    const reg = createDefaultAciRegistry({
      env: { web: { searchUrl: undefined, proxy: undefined } },
      sandboxRoot: makeRecordDir(),
    });
    const validator = reg.inner.getValidator("get_record");

    // append-only still holds: after get_record only tail-appended residents may
    // follow — read_image (resident read tool) plus host-seam-conditioned tools
    // (task-worktree list/remove and subagent stop/continue; this registry supplies
    // no host seam / manager → they are all absent). The three-axis order
    // (directory → record → content) is expressed by append order and later
    // additions must not reshuffle it. Assertions derive from indexOf on the SSOT
    // rather than hardcoded subscripts, answering "who else comes after the content axis".
    const getRecordIdx = ACI_TOOLSET_NAMES.indexOf("get_record");
    const afterContentAxis = ACI_TOOLSET_NAMES.slice(getRecordIdx + 1);
    // In this scenario (no host seam): only the resident read_image remains after get_record.
    assert.ok(getRecordIdx > 0, "get_record 必须在 list_sessions 之后");
    const presentNames = reg.inner.list().map((d) => d.name);
    assert.deepEqual(
      presentNames.slice(presentNames.indexOf("get_record") + 1),
      ["read_image"],
      "未供 host 缝时 get_record 后仅剩常驻 read_image（条件化件全数缺席）"
    );
    assert.equal(reg.catalog.get("get_record")?.name, "get_record");
    assert.ok(validator, "the registry must compile a validator for the tool");
    // The bounds are really enforced by ajv: every assertion pins a concrete boundary, not just text in the schema.
    assert.equal(validator!({ conversation_id: "c1" }), false); // record_id required
    assert.equal(validator!({ record_id: "r" }), false); // conversation_id required
    assert.equal(validator!({ conversation_id: "c1", record_id: "r" }), true);
    assert.equal(
      validator!({ conversation_id: "c1", record_id: "r", count: 0 }),
      false
    );
    assert.equal(
      validator!({
        conversation_id: "c1",
        record_id: "r",
        count: GET_RECORD_MAX_COUNT,
      }),
      true
    );
    assert.equal(
      validator!({
        conversation_id: "c1",
        record_id: "r",
        count: GET_RECORD_MAX_COUNT + 1,
      }),
      false
    );
    assert.equal(
      validator!({ conversation_id: "c1", record_id: "r", byte_window: 1 }),
      false
    );
    // append-only SSOT discipline: tools may still be appended after the content
    // axis, but only resident read tools (read_image) or conditioned assembly
    // pieces (host seam / subagentManager seam). This assertion turns "may append
    // after, must never cut in line" into a testable invariant.
    const allowedTailNames = new Set([
      "read_image",
      "list-worktrees",
      "remove-worktree",
      // stop / continue share the subagentManager-conditioned family with spawn /
      // result — this registry supplies no manager, so the tail converges to
      // [read_image] and the assertion above still certifies "all conditioned pieces absent".
      "subagent_stop",
      "subagent_continue",
    ]);
    for (const name of afterContentAxis) {
      assert.ok(
        allowedTailNames.has(name),
        `get_record 后只能 append 常驻读工具或条件化装配件,unexpected "${name}"`
      );
    }
  });

  // ── One mapping test per error kind this face can raise ─────────────────
  // Six cases = the five typed-error kinds + the reader's existing `io_error`
  // (`TraceReadError`, src/traceserver/types.ts). Each requires the error to be
  // genuinely translated into a `ToolExecutionError` subclass carrying the
  // fields the caller needs next; a missing arm means a bare `Error` leaks on
  // the ACI face, and the MCP face's catch-all would render that leak as
  // `isError` text — only this face can prove the arm exists.

  it("maps `validation` instead of leaking it bare", async () => {
    const tool = createGetRecordTool(makeRecordDir());

    await assert.rejects(
      () => tool.handler({ conversation_id: "a/b", record_id: "llm-target" }),
      (error: unknown) =>
        error instanceof GetRecordValidationError &&
        error instanceof ToolExecutionError &&
        error.kind === "validation" &&
        error.field === "conversation_id" &&
        error.message ===
          "get_record: conversation_id must not contain path separators"
    );
  });

  it("maps `window_overflow` with the coordinates and zero part bytes", async () => {
    const tool = createGetRecordTool(makeRecordDir());

    await assert.rejects(
      () =>
        tool.handler({
          conversation_id: "c1",
          record_id: "llm-target",
          part_index: 0,
          from_char: 0,
          count: RESULT_TEXT.length + 1,
        }),
      (error: unknown) => {
        assert.ok(error instanceof GetRecordWindowOverflowError);
        assert.ok(error instanceof ToolExecutionError);
        // The criterion is "the window must land wholly inside the part", so the right
        // answer is "fix the coordinates and read in full", not "hand over a truncated
        // page": any part body appearing in the error would mean the implementation
        // overturns this kind's very reason to exist.
        assert.ok(!error.message.includes(RESULT_TEXT));
        assert.ok(!error.message.includes("secret"));
        assert.equal(error.kind, "window_overflow");
        assert.equal(error.fromChar, 0);
        assert.equal(error.count, RESULT_TEXT.length + 1);
        assert.equal(error.partChars, RESULT_TEXT.length);
        assert.equal(error.remaining, RESULT_TEXT.length);
        assert.equal(
          error.message,
          "get_record: window of 19 characters at from_char=0 exceeds the " +
            `part: part_chars=${RESULT_TEXT.length}, remaining=${RESULT_TEXT.length}`
        );
        return true;
      },
      "expected a mapped window_overflow error"
    );
  });

  it("maps `record_not_found` instead of the row axis's silent empty page", async () => {
    const tool = createGetRecordTool(makeRecordDir());

    await assert.rejects(
      () => tool.handler({ conversation_id: "c1", record_id: "not-present" }),
      (error: unknown) =>
        error instanceof GetRecordNotFoundError &&
        error instanceof ToolExecutionError &&
        error.kind === "record_not_found" &&
        error.recordId === "not-present" &&
        error.message ===
          "get_record: no record matched record_id 'not-present'"
    );
  });

  it("maps `session_not_found` separately from `record_not_found`", async () => {
    // Two different claims: "this session was never read" vs "read it fully, no such
    // record". Merging them into one kind would state the former as the latter, so each
    // gets its own test.
    const tool = createGetRecordTool(makeRecordDir());

    await assert.rejects(
      () =>
        tool.handler({
          conversation_id: "no-such-session",
          record_id: "llm-target",
        }),
      (error: unknown) =>
        error instanceof GetRecordSessionNotFoundError &&
        error instanceof ToolExecutionError &&
        error.kind === "session_not_found" &&
        error.conversationId === "no-such-session" &&
        !(error instanceof GetRecordNotFoundError) &&
        error.message ===
          "get_record: no trace session file for conversation_id 'no-such-session'"
    );
  });

  it("maps `record_scan`, which says the scan did not finish", async () => {
    const tool = createGetRecordTool(makeScanCapDir());

    await assert.rejects(
      () => tool.handler({ conversation_id: "c1", record_id: "past-scan-cap" }),
      (error: unknown) =>
        error instanceof GetRecordScanError &&
        error instanceof ToolExecutionError &&
        error.kind === "record_scan" &&
        error.recordId === "past-scan-cap" &&
        error.scanned === 10_000 &&
        !(error instanceof GetRecordNotFoundError) &&
        error.message ===
          "get_record: record_id scan exhausted after 10000 records before finding 'past-scan-cap'",
      "expected a mapped record_scan error"
    );
    // The scan-cap branch writes and exhausts 10,001 rows: same relaxed timeout as the
    // record-axis twin (measured ~4-6s standalone with this fixture), without touching
    // the global testTimeout in vitest.config.ts.
  }, 120_000);

  it("maps the reader's `io_error` (TraceReadError) instead of leaking it bare", async () => {
    // Under the two-level tree, `findConversationTraceFile` stat
    // requires a *file* at `<convDir>/trace.jsonl` (a directory named like the
    // file no longer passes the discovery gate — it now reads as
    // session_not_found). The deterministic io_error left on this OS is a
    // permission-denied read: stat succeeds (stat needs no read bit), the
    // reader's openSync gets EACCES, and the mapper wraps it as TraceReadError.
    // POSIX-only; skipped where the read bit is not enforced (Windows).
    const dir = makeTraceDir("iknow-get-record-aci-io-");
    writeSession(dir, "c1", [toolResultRow("c1", "llm-target")]);
    const { chmodSync } = await import("node:fs");
    const tracePath = join(
      dir,
      "projects",
      TEST_PROJECT_SLUG,
      "c1",
      "trace.jsonl"
    );
    chmodSync(tracePath, 0o000);
    const tool = createGetRecordTool({ traceDir: dir });

    await assert.rejects(
      () => tool.handler({ conversation_id: "c1", record_id: "llm-target" }),
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        // This kind deliberately reuses the base class: IO failure is not a parameter
        // problem, so no `field`; the repo's `ToolExecutionError` has no `kind` channel
        // either (same verdict as query_trace / list_sessions for IO).
        !(error instanceof GetRecordValidationError) &&
        !(error instanceof GetRecordNotFoundError) &&
        !(error instanceof GetRecordSessionNotFoundError) &&
        !(error instanceof GetRecordScanError) &&
        !(error instanceof GetRecordWindowOverflowError) &&
        typeof error.message === "string" &&
        error.message.startsWith("get_record: trace file read failed")
    );
  });

  it("prefixes its own tool name over a core that names no tool (SC16)", async () => {
    // The prefix belongs to the thin face, the message to the core. Both ends are pinned
    // here: the core side shows the message names no tool at all (so a thin face that
    // forgets the prefix leaves the error unnamed), the thin-face side shows it is added
    // exactly once (dropping `strip` would double-prefix). All five cheap kinds are
    // compared one by one; record_scan must scan 10,001 rows and its full message is
    // already pinned verbatim by the test above.
    const dir = makeRecordDir();
    const core = createGetRecordCore({ traceDir: dir });
    const face = createGetRecordTool(dir);
    const inputs: unknown[] = [
      { conversation_id: "a/b", record_id: "llm-target" },
      { conversation_id: "no-such-session", record_id: "llm-target" },
      { conversation_id: "c1", record_id: "not-present" },
      {
        conversation_id: "c1",
        record_id: "llm-target",
        part_index: 0,
        from_char: 0,
        count: RESULT_TEXT.length + 1,
      },
      { conversation_id: "c1", record_id: "llm-target", detail: "everything" },
    ];

    for (const input of inputs) {
      const coreMessage = await core(input).then(
        () => {
          throw new Error(
            `expected the core to reject ${JSON.stringify(input)}`
          );
        },
        (error: unknown) => {
          assert.ok(error instanceof Error);
          for (const name of ["get_record", "query_trace", "list_sessions"]) {
            assert.ok(
              !error.message.includes(name),
              `core message named a tool: ${error.message}`
            );
          }
          return error.message;
        }
      );
      const faceMessage = await face.handler(input).then(
        () => {
          throw new Error(
            `expected the face to reject ${JSON.stringify(input)}`
          );
        },
        (error: unknown) => {
          assert.ok(error instanceof ToolExecutionError);
          return error.message;
        }
      );
      assert.equal(faceMessage, `get_record: ${coreMessage}`);
    }
  });

  it("applies no tool-level character cap on this face (SC7)", async () => {
    // ADR-0006 D6: the tool level owns "how much to read" (here the `count` read unit);
    // the executor owns "how much output may be". So this face must neither add its own
    // cap nor pre-apply the MCP face's `TRACE_OUTPUT_BACKSTOP` — doing either would be
    // the double truncation ADR-0006 forbids.
    //
    // The fixture deliberately pushes the payload far beyond `TRACE_OUTPUT_BACKSTOP`
    // (a 25,000-char record scalar + a full-size window), so "the thin face has no cap"
    // is falsifiable here: any cap applied on the ACI face reddens the full-return
    // assertions below.
    const tool = createGetRecordTool(makeWideRecordDir());
    const output = (await tool.handler({
      conversation_id: "c1",
      record_id: "llm-wide",
      part_index: 0,
      from_char: 0,
      count: GET_RECORD_MAX_COUNT,
    })) as string;

    assert.ok(
      output.length > TRACE_OUTPUT_BACKSTOP,
      "the fixture must be wide enough that a wrongly-applied cap would show"
    );
    const body = JSON.parse(output) as {
      text: string;
      count: number;
      part_chars: number;
      record: { oversize_note: string };
    };
    // `count` is the real read unit: the full-size window comes back uncut.
    assert.equal(body.text.length, GET_RECORD_MAX_COUNT);
    assert.equal(body.count, GET_RECORD_MAX_COUNT);
    assert.equal(body.part_chars, GET_RECORD_MAX_COUNT);
    assert.equal(body.record.oversize_note.length, OVERSIZE_NOTE_CHARS);
    assert.ok(!output.endsWith("...[truncated]"));
  });
});

describe("get_record ACI tool -- role projection (v1.2)", () => {
  it("carries role on detail=messages manifest parts through the ACI face (v1.2 判据 a)", async () => {
    // In detail=messages, every manifest part carries the role of its owning message.
    // Verified through the ACI tool-call path so the projected part list is what's checked.
    const dir = makeTraceDir("iknow-get-record-aci-role-");
    writeSession(dir, "c-role", [
      {
        conversation_id: "c-role",
        record_type: "llm_call",
        llm_call_id: "llm-role",
        status: "ok",
        messages: [
          { role: "user", content: "ask" },
          {
            role: "assistant",
            content: [
              { type: "tool_use", id: "toolu-1", name: "lookup", input: {} },
            ],
          },
          { role: "user", content: "follow-up" },
        ],
      },
    ]);

    const tool = createGetRecordTool(dir);
    const output = (await tool.handler({
      conversation_id: "c-role",
      record_id: "llm-role",
      detail: "messages",
    })) as string;
    const body = JSON.parse(output) as {
      parts: Array<{ role?: string; message_index?: number }>;
    };

    // 3 parts, roles follow the owning message: [user, assistant, user]
    assert.equal(body.parts.length, 3);
    assert.equal(body.parts[0]?.role, "user");
    assert.equal(body.parts[1]?.role, "assistant");
    assert.equal(body.parts[2]?.role, "user");
  });

  it("omits role on detail=tool_results manifest parts (tool_result 按定义在 user 侧)", async () => {
    // Counterpart for the messages arm: tool_results parts must NOT carry role —
    // pinned as "absent", not null/undefined.
    const tool = createGetRecordTool(makeRecordDir());

    const output = (await tool.handler({
      conversation_id: "c1",
      record_id: "llm-target",
    })) as string;
    const body = JSON.parse(output) as {
      parts: Array<Record<string, unknown>>;
    };

    assert.equal(body.parts.length, 1);
    assert.ok(
      !("role" in body.parts[0]!),
      `tool_results part must not carry role, got: ${JSON.stringify(body.parts[0])}`
    );
  });

  it("window arm response carries no role key on the ACI face (四禁)", async () => {
    // Window content addressing already carries message_index; role comes from the
    // manifest arm. The window arm adds no role.
    const tool = createGetRecordTool(makeRecordDir());

    const output = (await tool.handler({
      conversation_id: "c1",
      record_id: "llm-target",
      part_index: 0,
      count: 5,
    })) as string;
    const body = JSON.parse(output) as Record<string, unknown>;

    assert.ok(
      !("role" in body),
      `window response must not carry role, got: ${JSON.stringify(body)}`
    );
  });
});
