import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, it } from "vitest";

import {
  createQueryTraceCore,
  QUERY_TRACE_DEFAULT_LIMIT,
  QUERY_TRACE_PREVIEW_CAP,
} from "../../src/traceserver/query-trace-core.ts";
import { TRACE_OUTPUT_BACKSTOP } from "../../src/traceserver/output-backstop.ts";
import { TraceQueryValidationError } from "../../src/traceserver/query-trace-errors.ts";

/**
 * Contract suite for the shared `query_trace` core (plan
 * `trace-mcp-read-side-split` T7, spec SC14).
 *
 * T2 pinned what the unmodified core did today, the P0 silent field-drop
 * included, as passing assertions and marked every one of them `// T3:`. T3
 * landed, so those marked assertions now read the other way and pin the NEW
 * contract: a page narrows by whole records only. T6 retired the 4000-character
 * red line in favour of `TRACE_OUTPUT_BACKSTOP`. T7 then took the row axis to
 * its real shape:
 *   - `record_id` / `detail` / `resume_offset` are gone (drill-down moved to
 *     `get_record`; byte-pagination was a panel-only concern);
 *   - `offset` is now a real parameter — row pagination — and the envelope
 *     echoes the effective limit + offset so callers can resume;
 *   - the tool face envelope no longer carries `total` / `truncated` /
 *     `skipped_lines` (panel paging metadata), and `records.length < limit`
 *     is the end-of-data signal.
 * Nothing here is an xfail / skipped "known bug" test.
 */

const traceDirs: string[] = [];
/**
 * T6 (SC16): all sessions sit at
 *   `<traceDir>/projects/<slug>/<convId>/trace.jsonl`.
 */
const TEST_PROJECT_SLUG = "test-project-query-trace-core";

afterEach(() => {
  for (const traceDir of traceDirs.splice(0)) {
    rmSync(traceDir, { recursive: true, force: true });
  }
});

function makeTraceDir(): string {
  const traceDir = mkdtempSync(join(tmpdir(), "iknow-query-trace-core-"));
  traceDirs.push(traceDir);
  return traceDir;
}

function jsonLine(row: Record<string, unknown>): string {
  return `${JSON.stringify(row)}\n`;
}

/** Write `content` to the conversation's `trace.jsonl` under the two-level tree. */
function writeSession(
  traceDir: string,
  conversationId: string,
  content: string
): string {
  const text =
    content.length === 0 || content.endsWith("\n") ? content : `${content}\n`;
  mkdirSync(join(traceDir, "projects", TEST_PROJECT_SLUG, conversationId), {
    recursive: true,
  });
  writeFileSync(
    join(
      traceDir,
      "projects",
      TEST_PROJECT_SLUG,
      conversationId,
      "trace.jsonl"
    ),
    text
  );
  return text;
}

/**
 * An llm_call row whose `started_at` increases with `index`, so the reader's
 * time-descending order is `index` descending.
 */
function llmCallRow(
  conversationId: string,
  index: number,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    record_type: "llm_call",
    conversation_id: conversationId,
    llm_call_id: `llm-${index}`,
    turn_id: `turn-${index}`,
    // One millisecond apart (Date.UTC's 7th arg is ms) keeps the rows distinct,
    // so the reader's descending-time sort equals `index` descending for any
    // index. Distinctness is what matters; the size of the gap is not.
    started_at: new Date(Date.UTC(2026, 0, 1, 0, 0, 0, index)).toISOString(),
    ...extra,
  };
}

/** `pairCount` assistant tool_use + user tool_result messages, ~`chars` each. */
function toolRoundTrips(pairCount: number, chars: number): unknown[] {
  const messages: unknown[] = [];
  for (let i = 0; i < pairCount; i++) {
    messages.push({
      role: "assistant",
      content: [
        { type: "tool_use", id: `toolu-${i}`, name: "bash", input: {} },
      ],
    });
    messages.push({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: `toolu-${i}`,
          content: "y".repeat(chars),
        },
      ],
    });
  }
  return messages;
}

/**
 * The payload every record of `writeNarrowingPageSession` carries. Shared with
 * the assertions so an expected preview is derived from what was written, not
 * re-templated next to it.
 */
const NARROWING_PAGE_MESSAGES = toolRoundTrips(2, 500);

/**
 * 一页要多少条记录才真越过 `TRACE_OUTPUT_BACKSTOP`（实测本夹具：一条投影记录
 * ≈ 1,200 字符 ⇒ 24 条 ≈ 28.8 KB，收窄后 16 条 ≈ 19.3 KB）。宽度是夹具的属性，
 * 预算是核与 MCP 面共用的那一个值，所以这里只引用常量，不再抄一份数字。
 */
const NARROWING_PAGE_RECORD_COUNT = 24;

/**
 * 一条记录要多少个 400 字符字段才单独装不进预算（实测 ≈ 416 字符/字段 ⇒ 60 个
 * ≈ 25.1 KB > `TRACE_OUTPUT_BACKSTOP`）。收不窄到零的判据要吃这个宽度。
 */
const UNFITTABLE_FIELD_COUNT = 60;

/**
 * A session whose list page overshoots `TRACE_OUTPUT_BACKSTOP`, so the
 * serializer must narrow it by whole records. Records are written oldest-first
 * and the reader emits them newest-first.
 */
function writeNarrowingPageSession(
  traceDir: string,
  conversationId: string,
  count: number
): void {
  let content = "";
  for (let i = 0; i < count; i++) {
    content += jsonLine(
      llmCallRow(conversationId, i, { messages: NARROWING_PAGE_MESSAGES })
    );
  }
  writeSession(traceDir, conversationId, content);
}

/**
 * A session holding one record too wide to fit `TRACE_OUTPUT_BACKSTOP` on its
 * own, so no narrowing can produce a non-empty page. Returns the written row,
 * letting the caller assert the key set it expected to survive.
 */
function writeUnfittableRecordSession(
  traceDir: string,
  conversationId: string,
  recordIndex: number,
  fieldCount: number
): Record<string, unknown> {
  const wide: Record<string, unknown> = llmCallRow(conversationId, recordIndex);
  for (let i = 0; i < fieldCount; i++) {
    wide[`field_${i}`] = "q".repeat(400);
  }
  writeSession(traceDir, conversationId, jsonLine(wide));
  return wide;
}

interface ToolPageEnvelope {
  records: Array<Record<string, unknown>>;
  limit: number;
  offset: number;
}

function envelope(json: string): ToolPageEnvelope {
  return JSON.parse(json) as ToolPageEnvelope;
}

function idsOf(page: ReadonlyArray<Record<string, unknown>>): unknown[] {
  return page.map((record) => record["llm_call_id"]);
}

/** The preview marker `preview()` (query-trace-core.ts) appends. */
const MARKER = "...[truncated]";

describe("query_trace traceserver core (T7)", () => {
  describe("assistant projection (v1.2)", () => {
    // spec v1.2 判据 (b): llm_call 投影新增 `last_assistant_preview` = 最后一条
    // role==="assistant" 消息的预览，截断帽沿复用既有 `preview()` 的
    // QUERY_TRACE_PREVIEW_CAP=400。无 assistant 消息的 llm_call -> 字段**缺席**
    // （合法态，非错误）。
    it("carries last_assistant_preview taken from the LAST assistant message, not the first", async () => {
      // Two distinct assistant messages, each with text content that names itself
      // -- a sliding window over the assistant tail has to land on the second
      // one, not the first. Surrounding user messages are kept so the projection
      // is forced to walk past non-assistant messages.
      const traceDir = makeTraceDir();
      writeSession(
        traceDir,
        "c-role-last",
        jsonLine(
          llmCallRow("c-role-last", 1, {
            messages: [
              { role: "user", content: "ignore me" },
              { role: "assistant", content: "first assistant answer" },
              { role: "user", content: "ignore me again" },
              { role: "assistant", content: "final assistant answer" },
            ],
          })
        )
      );

      const parsed = envelope(
        await createQueryTraceCore({ traceDir })({
          conversation_id: "c-role-last",
        })
      );
      const record = parsed.records[0] ?? {};

      // The last-assistant preview must be the LAST assistant's message,
      // not the first's and not the trailing user message -- that is the
      // whole point of the field's name. preview() JSON-stringifies
      // non-string values (the message object); the assistant content
      // travels inside that JSON, which is the same shape the existing
      // last_message_preview keys give.
      const expectedLast = JSON.stringify({
        role: "assistant",
        content: "final assistant answer",
      });
      assert.equal(
        record["last_assistant_preview"],
        expectedLast,
        "last_assistant_preview must read the LAST assistant message, not the first"
      );
      // The existing last_message_preview must stay unchanged: it answers a
      // different question (last message of any role), and the spec pins its
      // semantics in v1.2. Reading both together is the contract.
      assert.equal(
        record["last_message_preview"],
        expectedLast,
        "last_message_preview still answers the last message of any role"
      );
    });

    it("omits last_assistant_preview when no assistant message is present", async () => {
      // Empty case for the new field (defensive-contract boundary class
      // "empty"): the call answered, just nothing matched. Field absence is the
      // contract -- a `last_assistant_preview: ""` would silently confuse a
      // caller that uses `in` / `Object.keys` to gate its next step.
      const traceDir = makeTraceDir();
      writeSession(
        traceDir,
        "c-no-assistant",
        jsonLine(
          llmCallRow("c-no-assistant", 1, {
            messages: [{ role: "user", content: "only user" }],
          })
        )
      );

      const parsed = envelope(
        await createQueryTraceCore({ traceDir })({
          conversation_id: "c-no-assistant",
        })
      );
      const record = parsed.records[0] ?? {};

      // The field must be absent, not empty-string -- the same shape the
      // first/last_message_preview guard gives for messages.length === 0.
      assert.ok(
        !("last_assistant_preview" in record),
        `last_assistant_preview must be absent for a non-assistant-only trace, got: ${JSON.stringify(record)}`
      );
      // The two existing preview keys are still gated by messages.length > 0,
      // so this single-user case keeps emitting them. preview() JSON-
      // stringifies the message object, so the preview is the serialized
      // message, not the raw content.
      const expectedPreview = JSON.stringify({
        role: "user",
        content: "only user",
      });
      assert.equal(record["first_message_preview"], expectedPreview);
      assert.equal(record["last_message_preview"], expectedPreview);
    });

    it("omits last_assistant_preview when messages is empty", async () => {
      // Same boundary as the first/last_message_preview empty guard: no
      // messages means no previews at all.
      const traceDir = makeTraceDir();
      writeSession(
        traceDir,
        "c-empty-messages",
        jsonLine(llmCallRow("c-empty-messages", 1, { messages: [] }))
      );

      const parsed = envelope(
        await createQueryTraceCore({ traceDir })({
          conversation_id: "c-empty-messages",
        })
      );
      const record = parsed.records[0] ?? {};

      assert.ok(!("last_assistant_preview" in record));
      assert.ok(!("first_message_preview" in record));
      assert.ok(!("last_message_preview" in record));
      assert.equal(record["messages_count"], 0);
    });

    it("caps last_assistant_preview at QUERY_TRACE_PREVIEW_CAP with the same marker", async () => {
      // v1.2 判据 (b): 帽沿与 last_message_preview 同款 -- preview() 的同一段
      // 截断语义, 同一 cap, 同一 marker. assistant 文本 500 字符, 截到 400 + 标记.
      const traceDir = makeTraceDir();
      const assistantText = "a".repeat(500);
      writeSession(
        traceDir,
        "c-cap",
        jsonLine(
          llmCallRow("c-cap", 1, {
            messages: [
              { role: "user", content: "q" },
              { role: "assistant", content: assistantText },
            ],
          })
        )
      );

      const parsed = envelope(
        await createQueryTraceCore({ traceDir })({
          conversation_id: "c-cap",
        })
      );
      const record = parsed.records[0] ?? {};
      const preview = record["last_assistant_preview"];

      // preview() JSON-stringifies the message object, so the truncated text
      // is the serialized form cut at QUERY_TRACE_PREVIEW_CAP, not the raw
      // content string. Same shape as the last_message_preview cap test.
      const expected = JSON.stringify({
        role: "assistant",
        content: assistantText,
      });
      assert.equal(typeof preview, "string");
      assert.ok((preview as string).endsWith(MARKER));
      assert.equal(
        (preview as string).length,
        QUERY_TRACE_PREVIEW_CAP + MARKER.length
      );
      assert.equal(
        preview,
        expected.slice(0, QUERY_TRACE_PREVIEW_CAP) + MARKER
      );
    });
  });

  describe("list projection", () => {
    it("counts zero messages and emits no preview keys at all for an empty messages array", async () => {
      const traceDir = makeTraceDir();
      writeSession(
        traceDir,
        "c15",
        jsonLine(llmCallRow("c15", 1, { messages: [] }))
      );

      const parsed = envelope(
        await createQueryTraceCore({ traceDir })({ conversation_id: "c15" })
      );
      const record = parsed.records[0] ?? {};

      // Boundary class "empty" on the list face: the `messages.length > 0` guard
      // and the `toolResults.length > 0` guard in projectRecord
      // (query-trace-core.ts) mean an empty array yields no preview keys at all rather than
      // empty-string ones, so `messages_count: 0` is the only positive signal
      // that the projection ran.
      assert.equal(record["messages_count"], 0);
      assert.equal(record["tool_result_count"], 0);
      assert.ok(!("first_message_preview" in record));
      assert.ok(!("last_message_preview" in record));
      assert.ok(!("tool_result_previews" in record));
      assert.deepEqual(
        Object.keys(record).sort(),
        [
          "conversation_id",
          "llm_call_id",
          "messages_count",
          "record_type",
          "started_at",
          "tool_result_count",
          "turn_id",
        ].sort()
      );
    });

    it("projects a non-llm_call row as the base field copy with no message counters", async () => {
      const traceDir = makeTraceDir();
      writeSession(
        traceDir,
        "c16",
        jsonLine({
          record_type: "turn",
          conversation_id: "c16",
          turn_id: "turn-1",
          started_at: "2026-01-01T00:00:00.000Z",
        })
      );

      const parsed = envelope(
        await createQueryTraceCore({ traceDir })({ conversation_id: "c16" })
      );
      const record = parsed.records[0] ?? {};

      // Boundary class "empty" for a row that has no messages axis at all: the
      // projectRecord's `record_type !== "llm_call"` early return hands back
      // projectRecordBase's verbatim scalar copy, so messages_count /
      // tool_result_count are never even created — not zero, absent.
      assert.ok(!("messages_count" in record));
      assert.ok(!("tool_result_count" in record));
      assert.ok(!("first_message_preview" in record));
      assert.ok(!("last_message_preview" in record));
      assert.deepEqual(record, {
        record_type: "turn",
        conversation_id: "c16",
        turn_id: "turn-1",
        started_at: "2026-01-01T00:00:00.000Z",
      });
    });
  });

  describe("list page serialization", () => {
    it("narrows an over-backstop list page to a leading run of whole records", async () => {
      const traceDir = makeTraceDir();
      writeNarrowingPageSession(traceDir, "c4", NARROWING_PAGE_RECORD_COUNT);

      const json = await createQueryTraceCore({ traceDir })({
        conversation_id: "c4",
        limit: NARROWING_PAGE_RECORD_COUNT,
      });
      const parsed = envelope(json);

      assert.ok(
        json.length <= TRACE_OUTPUT_BACKSTOP,
        `a narrowed page must reach the caller inside the backstop, got ${json.length} characters`
      );
      // The page shrank by RECORDS, never by fields: `records.length < limit` is
      // the honest end-of-data signal, and each surviving record is the same
      // object the un-narrowed path would have returned.
      assert.ok(parsed.records.length < NARROWING_PAGE_RECORD_COUNT);
      assert.ok(
        parsed.records.length > 1,
        "a narrowed page still holds more than one record, so it is a page and " +
          "not the zero-fits single-record fallback"
      );
      // Narrowed, but only as far as it had to: one more record of the width this
      // page already carries would cross the budget. Without this arm a serializer
      // that stopped at an arbitrary smaller anchor — the retired 4000, say — would
      // still satisfy the two bounds above.
      const recordWidth = JSON.stringify(parsed.records[0] ?? {}).length + 1;
      assert.ok(
        json.length + recordWidth > TRACE_OUTPUT_BACKSTOP,
        `the page gave back ${json.length} characters and could have carried ~${recordWidth} more inside ${TRACE_OUTPUT_BACKSTOP}`
      );
      // Tool face echoes the effective limit/offset; callers resume by adding
      // `records.length` to `offset`, and `records.length < limit` is the
      // "no more rows" signal.
      assert.equal(parsed.limit, NARROWING_PAGE_RECORD_COUNT);
      assert.equal(parsed.offset, 0);
      const expectedOrder = Array.from(
        { length: NARROWING_PAGE_RECORD_COUNT },
        (_unused, i) => `llm-${NARROWING_PAGE_RECORD_COUNT - 1 - i}`
      );
      assert.deepEqual(
        idsOf(parsed.records),
        expectedOrder.slice(0, parsed.records.length)
      );
      // Tool face envelope must not carry panel-only fields: `total` /
      // `truncated` / `skipped_lines` belong to the panel's byte-paging
      // semantics, not to a row-axis page the caller asked for.
      assert.deepEqual(Object.keys(parsed).sort(), [
        "limit",
        "offset",
        "records",
      ]);
    });

    it("caps a list preview at QUERY_TRACE_PREVIEW_CAP and keeps the marker when the response fits", async () => {
      const traceDir = makeTraceDir();
      writeSession(
        traceDir,
        "c18",
        jsonLine(
          llmCallRow("c18", 1, {
            messages: [{ role: "user", content: "x".repeat(500) }],
          })
        )
      );

      const parsed = envelope(
        await createQueryTraceCore({ traceDir })({ conversation_id: "c18" })
      );
      const record = parsed.records[0] ?? {};
      const preview = record["first_message_preview"];

      // `preview()` (query-trace-core.ts) is the only preview owner: cut at
      // QUERY_TRACE_PREVIEW_CAP, append the marker. The test below pins that the
      // over-cap page gives back this same shape, so both paths agree.
      assert.equal(typeof preview, "string");
      assert.ok((preview as string).endsWith(MARKER));
      assert.equal(
        (preview as string).length,
        QUERY_TRACE_PREVIEW_CAP + MARKER.length
      );
      assert.equal(parsed.limit, QUERY_TRACE_DEFAULT_LIMIT);
      assert.equal(parsed.offset, 0);
    });

    it("keeps every field of a narrowed page's records, previews and arrays included", async () => {
      const traceDir = makeTraceDir();
      writeNarrowingPageSession(traceDir, "c5", NARROWING_PAGE_RECORD_COUNT);

      const parsed = envelope(
        await createQueryTraceCore({ traceDir })({ conversation_id: "c5" })
      );
      const lastMessage = JSON.stringify(
        NARROWING_PAGE_MESSAGES[NARROWING_PAGE_MESSAGES.length - 1] ?? {}
      );

      // Every surviving record is asserted, not just one: narrowing must not
      // shorten a string or drop an array field on the way past
      // `TRACE_OUTPUT_BACKSTOP`, or a truncated value on a narrowed page would
      // look complete.
      assert.ok(
        parsed.records.length < NARROWING_PAGE_RECORD_COUNT,
        "the fixture must still be over the backstop"
      );
      assert.ok(parsed.records.length > 1);
      for (const record of parsed.records) {
        const preview = record["last_message_preview"];
        assert.equal(typeof preview, "string");
        assert.equal(
          (preview as string).length,
          QUERY_TRACE_PREVIEW_CAP + MARKER.length
        );
        assert.ok(
          (preview as string).endsWith(MARKER),
          "a truncated preview still says so"
        );
        assert.equal(
          preview,
          lastMessage.slice(0, QUERY_TRACE_PREVIEW_CAP) + MARKER
        );
        // Array fields are no longer dropped for being arrays.
        assert.deepEqual(record["tool_result_previews"], [
          "y".repeat(200),
          "y".repeat(200),
        ]);
        assert.equal(record["tool_result_count"], 2);
      }
      // Order is still the reader's, and the first record is a whole one.
      assert.equal(
        parsed.records[0]?.["llm_call_id"],
        `llm-${NARROWING_PAGE_RECORD_COUNT - 1}`
      );
    });

    it("returns the first record whole instead of an empty page when not even one record fits", async () => {
      const traceDir = makeTraceDir();
      writeUnfittableRecordSession(traceDir, "c6", 6, UNFITTABLE_FIELD_COUNT);

      const json = await createQueryTraceCore({ traceDir })({
        conversation_id: "c6",
      });
      const parsed = envelope(json);
      const record = parsed.records[0] ?? {};

      // A page never shrinks to zero. When not even one record fits
      // `TRACE_OUTPUT_BACKSTOP`, the first record is returned whole and the
      // response overshoots the budget rather than emitting an empty `records`
      // array that would read as "no data" — which is what the old count-0
      // branch did. The overshoot is the honest half of the deal: the caller
      // reads a whole record it can parse, not a lie about there being nothing.
      assert.equal(parsed.records.length, 1);
      assert.ok(
        json.length > TRACE_OUTPUT_BACKSTOP,
        `the unfittable record is returned whole, got ${json.length} characters`
      );
      // Whole means whole: every field of the wide record survived the walk.
      assert.deepEqual(
        Object.keys(record).sort(),
        [
          ...Object.keys(
            writeUnfittableRecordSession(
              traceDir,
              "c6-shadow",
              6,
              UNFITTABLE_FIELD_COUNT
            )
          ),
          "messages_count",
          "tool_result_count",
        ].sort()
      );
    });
  });

  describe("truncation metadata", () => {
    it("carries no panel-paging metadata on any tool-face shape", async () => {
      const traceDir = makeTraceDir();
      writeSession(traceDir, "empty", "");
      writeSession(traceDir, "fits", jsonLine(llmCallRow("fits", 1)));
      writeNarrowingPageSession(
        traceDir,
        "narrows",
        NARROWING_PAGE_RECORD_COUNT
      );
      writeUnfittableRecordSession(
        traceDir,
        "oversize",
        6,
        UNFITTABLE_FIELD_COUNT
      );
      const core = createQueryTraceCore({ traceDir });

      // One entry per answer shape, each with a `branch` witness that proves the
      // call really took the budget path its name claims — a fixture that quietly
      // fit under `TRACE_OUTPUT_BACKSTOP` would otherwise make this loop assert
      // nothing the fitted path does not already assert. Behaviour itself is
      // pinned by the two blocks above; only the metadata is read here.
      const shapes: ReadonlyArray<{
        readonly shape: string;
        readonly input: Record<string, unknown>;
        readonly branch: (parsed: ToolPageEnvelope, json: string) => void;
      }> = [
        {
          shape: "an empty session",
          input: { conversation_id: "empty" },
          branch: (parsed) => assert.equal(parsed.records.length, 0),
        },
        {
          shape: "a page that fits",
          input: { conversation_id: "fits" },
          branch: (parsed, json) => {
            assert.ok(json.length <= TRACE_OUTPUT_BACKSTOP);
            assert.equal(parsed.records.length, 1);
          },
        },
        {
          shape: "a narrowed page",
          input: {
            conversation_id: "narrows",
            limit: NARROWING_PAGE_RECORD_COUNT,
          },
          // Fewer records than asked for, yet inside the budget and filled as far
          // as the budget allows: the whole-record narrowing ran, at the anchor
          // this ticket moved to.
          branch: (parsed, json) => {
            assert.ok(json.length <= TRACE_OUTPUT_BACKSTOP);
            assert.ok(
              json.length + JSON.stringify(parsed.records[0] ?? {}).length + 1 >
                TRACE_OUTPUT_BACKSTOP,
              "a narrowed page stopped as late as the backstop allows"
            );
            assert.ok(parsed.records.length < NARROWING_PAGE_RECORD_COUNT);
          },
        },
        {
          shape: "an unfittable single record",
          input: { conversation_id: "oversize" },
          branch: (parsed, json) => {
            assert.ok(json.length > TRACE_OUTPUT_BACKSTOP);
            assert.equal(parsed.records.length, 1);
          },
        },
      ];
      for (const { shape, input, branch } of shapes) {
        const json = await core(input);
        const parsed = envelope(json);
        branch(parsed, json);
        // T7: tool face keys are exactly the three the contract names; nothing
        // panel-paging (total / truncated / skipped_lines) leaks through.
        assert.deepEqual(Object.keys(parsed).sort(), [
          "limit",
          "offset",
          "records",
        ]);
        // `records.length < limit` is the end-of-data signal — the only one the
        // contract gives callers — so the echo must be honest: the limit the
        // caller used (or the default) and the offset they used.
        assert.ok(
          typeof parsed.limit === "number",
          `${shape}: limit must be echoed as a number`
        );
        assert.ok(
          typeof parsed.offset === "number",
          `${shape}: offset must be echoed as a number`
        );
      }
    });
  });

  describe("row pagination", () => {
    it("honours the caller's offset, so the second page is rows 2-3, the third is rows 4-5, and so on", async () => {
      const traceDir = makeTraceDir();
      let content = "";
      for (let i = 0; i < 10; i++) content += jsonLine(llmCallRow("c7", i));
      writeSession(traceDir, "c7", content);
      const core = createQueryTraceCore({ traceDir });

      const firstPage = envelope(
        await core({ conversation_id: "c7", limit: 2 })
      );
      assert.deepEqual(idsOf(firstPage.records), ["llm-9", "llm-8"]);
      assert.equal(firstPage.limit, 2);
      assert.equal(firstPage.offset, 0);

      // `offset` is now a real tool-face parameter: page 2 begins where page 1
      // ended, and the limit echo is the same on every page so callers can
      // resume without remembering what they asked for.
      const secondPage = envelope(
        await core({ conversation_id: "c7", limit: 2, offset: 2 })
      );
      assert.deepEqual(idsOf(secondPage.records), ["llm-7", "llm-6"]);
      assert.equal(secondPage.limit, 2);
      assert.equal(secondPage.offset, 2);

      // The last full page carries whatever is left; the page after it is the
      // implicit "no more rows" signal (`records.length < limit`), which the
      // tool face never spells out as a metadata field.
      const finalFullPage = envelope(
        await core({ conversation_id: "c7", limit: 2, offset: 8 })
      );
      assert.deepEqual(idsOf(finalFullPage.records), ["llm-1", "llm-0"]);
      assert.equal(finalFullPage.records.length, 2);

      const beyond = envelope(
        await core({ conversation_id: "c7", limit: 2, offset: 10 })
      );
      assert.equal(beyond.records.length, 0);
      assert.equal(beyond.offset, 10);
    });

    it("filters first, then pages, so an offset past the filtered set answers with an empty records array", async () => {
      const traceDir = makeTraceDir();
      let content = "";
      for (let i = 0; i < 5; i++) {
        content += jsonLine(
          llmCallRow("c7a", i, { status: i % 2 === 0 ? "ok" : "error" })
        );
      }
      writeSession(traceDir, "c7a", content);
      const core = createQueryTraceCore({ traceDir });

      // Three rows match status=ok (0, 2, 4). An offset past the end of that
      // filter answers with zero records; the offset echo tells the caller
      // where to back up to.
      const beyond = envelope(
        await core({
          conversation_id: "c7a",
          status: "ok",
          limit: 2,
          offset: 3,
        })
      );
      assert.deepEqual(beyond.records, []);
      assert.equal(beyond.offset, 3);
    });
  });

  describe("reader result plumbing", () => {
    it("degrades a missing blob to an empty projection instead of throwing into the caller", async () => {
      const traceDir = makeTraceDir();
      writeSession(
        traceDir,
        "c13",
        jsonLine(
          llmCallRow("c13", 1, {
            messages: [
              {
                role: "assistant",
                content: [
                  { type: "tool_use", id: "toolu-1", name: "bash", input: {} },
                ],
              },
              {
                sha: "0".repeat(64),
                bytes: 10,
              },
            ],
          })
        )
      );
      const core = createQueryTraceCore({ traceDir });

      const list = envelope(await core({ conversation_id: "c13" }));
      assert.equal(list.records[0]["tool_result_count"], 0);
    });
  });

  describe("concurrency", () => {
    it("returns byte-identical output for concurrent calls against the same fixture", async () => {
      const traceDir = makeTraceDir();
      writeSession(
        traceDir,
        "c14",
        jsonLine(llmCallRow("c14", 1, { messages: toolRoundTrips(3, 120) }))
      );
      const core = createQueryTraceCore({ traceDir });

      const [listA, listB] = await Promise.all([
        core({ conversation_id: "c14" }),
        core({ conversation_id: "c14" }),
      ]);

      assert.equal(listA, listB);
      assert.equal(envelope(listA).records.length, 1);
    });
  });

  describe("guard against the retired parameters reappearing", () => {
    it("ignores record_id, detail and resume_offset at the core layer", async () => {
      // T7: those three names left the per-face schemas entirely
      // (additionalProperties: false on ACI / .strict() on MCP, both pinned by
      // the SC18 test in tests/trace-mcp/server.test.ts). The shared core's
      // parseInput does NOT reject them — that's the per-face gate's job —
      // so this test pins the narrower guarantee the core gives: an unknown
      // key is forwarded to the reader, the reader ignores it, and the
      // response is byte-equal to the same call without the stale key. A
      // future refactor that re-activates any of the three keys would
      // therefore change this response — that diff is the failing test.
      const traceDir = makeTraceDir();
      writeSession(traceDir, "c-guard", jsonLine(llmCallRow("c-guard", 1)));
      const core = createQueryTraceCore({ traceDir });

      const baseline = await core({ conversation_id: "c-guard" });
      for (const stale of [
        { record_id: "llm-1" },
        { detail: "messages" },
        { resume_offset: 0 },
      ]) {
        const withStale = await core({
          conversation_id: "c-guard",
          ...stale,
        });
        assert.equal(
          withStale,
          baseline,
          `${JSON.stringify(stale)} must not change the response`
        );
      }
    });
  });

  describe("contains filter (trace-mcp-args-search task)", () => {
    it("hits llm_call rows whose serialized messages carry the substring", async () => {
      const traceDir = makeTraceDir();
      writeSession(
        traceDir,
        "c-contains",
        [
          jsonLine(
            llmCallRow("c-contains", 1, {
              messages: [{ role: "user", content: "review .iknow/skills/x" }],
            })
          ),
          jsonLine(llmCallRow("c-contains", 2, { messages: [] })),
        ].join("")
      );
      const core = createQueryTraceCore({ traceDir });

      const parsed = envelope(
        await core({ conversation_id: "c-contains", contains: ".iknow/skills" })
      );
      assert.equal(parsed.records.length, 1);
      assert.equal(parsed.records[0]?.["llm_call_id"], "llm-1");
    });

    it("answers an empty page when the substring matches nothing", async () => {
      const traceDir = makeTraceDir();
      writeSession(
        traceDir,
        "c-contains-miss",
        jsonLine(llmCallRow("c-contains-miss", 1))
      );
      const core = createQueryTraceCore({ traceDir });

      const parsed = envelope(
        await core({
          conversation_id: "c-contains-miss",
          contains: "no-such-substring",
        })
      );
      assert.deepEqual(parsed.records, []);
      assert.equal(parsed.limit, QUERY_TRACE_DEFAULT_LIMIT);
      assert.equal(parsed.offset, 0);
    });

    it("narrows contains hits further with record_type (AND semantics)", async () => {
      const traceDir = makeTraceDir();
      writeSession(
        traceDir,
        "c-contains-and",
        [
          jsonLine({
            record_type: "tool_call",
            conversation_id: "c-contains-and",
            tool_call_id: "tool-1",
            started_at: "2026-01-01T00:00:00.000Z",
            status: "ok",
            arguments: { path: ".iknow/skills" },
          }),
          jsonLine(
            llmCallRow("c-contains-and", 2, {
              messages: [{ role: "user", content: "open .iknow/skills" }],
            })
          ),
        ].join("")
      );
      const core = createQueryTraceCore({ traceDir });

      const both = envelope(
        await core({
          conversation_id: "c-contains-and",
          contains: ".iknow/skills",
        })
      );
      assert.equal(both.records.length, 2);

      const narrowed = envelope(
        await core({
          conversation_id: "c-contains-and",
          contains: ".iknow/skills",
          record_type: "tool_call",
        })
      );
      assert.equal(narrowed.records.length, 1);
      assert.equal(narrowed.records[0]?.["tool_call_id"], "tool-1");
    });

    it("keeps contains orthogonal to limit/offset paging", async () => {
      const traceDir = makeTraceDir();
      let content = "";
      for (let i = 0; i < 4; i++) {
        content += jsonLine(
          llmCallRow("c-contains-paging", i, {
            messages: [{ role: "user", content: `needle-${i}` }],
          })
        );
      }
      writeSession(traceDir, "c-contains-paging", content);
      const core = createQueryTraceCore({ traceDir });

      const page = envelope(
        await core({
          conversation_id: "c-contains-paging",
          contains: "needle-",
          limit: 2,
          offset: 1,
        })
      );
      // Descending time: llm-3, llm-2, llm-1, llm-0; offset 1 skips llm-3.
      assert.deepEqual(idsOf(page.records), ["llm-2", "llm-1"]);
      assert.equal(page.limit, 2);
      assert.equal(page.offset, 1);
    });

    it("rejects an empty contains as invalid_input, in line with the other string axes", async () => {
      const traceDir = makeTraceDir();
      writeSession(
        traceDir,
        "c-contains-empty",
        jsonLine(llmCallRow("c-contains-empty", 1))
      );
      const core = createQueryTraceCore({ traceDir });

      await assert.rejects(
        core({ conversation_id: "c-contains-empty", contains: "" }),
        (error: unknown) => {
          assert.ok(
            error instanceof TraceQueryValidationError,
            `expected TraceQueryValidationError, got ${String(error)}`
          );
          assert.equal(error.field, "contains");
          assert.equal(error.kind, "validation");
          assert.equal(error.message, "contains must be a non-empty string");
          return true;
        }
      );
    });

    it("rejects a non-string contains", async () => {
      const traceDir = makeTraceDir();
      writeSession(
        traceDir,
        "c-contains-type",
        jsonLine(llmCallRow("c-contains-type", 1))
      );
      const core = createQueryTraceCore({ traceDir });

      for (const bad of [42, null, true, { key: "v" }]) {
        await assert.rejects(
          core({ conversation_id: "c-contains-type", contains: bad }),
          (error: unknown) =>
            error instanceof TraceQueryValidationError &&
            error.field === "contains"
        );
      }
    });

    it("is case-sensitive end to end", async () => {
      const traceDir = makeTraceDir();
      writeSession(
        traceDir,
        "c-contains-case",
        jsonLine(
          llmCallRow("c-contains-case", 1, {
            messages: [{ role: "user", content: "MixedCase Token" }],
          })
        )
      );
      const core = createQueryTraceCore({ traceDir });

      const lower = envelope(
        await core({
          conversation_id: "c-contains-case",
          contains: "mixedcase",
        })
      );
      assert.deepEqual(lower.records, []);
      const exact = envelope(
        await core({
          conversation_id: "c-contains-case",
          contains: "MixedCase",
        })
      );
      assert.equal(exact.records.length, 1);
    });
  });
});
