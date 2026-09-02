import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, it } from "vitest";

import {
  createQueryTraceCore,
  QUERY_TRACE_MAX_LIMIT,
  QUERY_TRACE_PREVIEW_CAP,
} from "../../src/traceserver/query-trace-core.ts";
import { TRACE_OUTPUT_BACKSTOP } from "../../src/traceserver/output-backstop.ts";

/**
 * Contract suite for the shared `query_trace` core (plan
 * `trace-mcp-read-side-split` T2 + T3, spec SC14).
 *
 * T2 pinned what the unmodified core did today, the P0 silent field-drop
 * included, as passing assertions and marked every one of them `// T3:`. T3
 * landed, so those marked assertions now read the other way and pin the NEW
 * contract instead: a page narrows by whole records only, a drilled record
 * comes back complete, and no `response_truncated` flag claims otherwise.
 * T6 then moved the budget these fixtures are built to cross: the
 * `QUERY_TRACE_RESPONSE_CAP = 4000` red line retired and `serializeListPage`
 * narrowed to `TRACE_OUTPUT_BACKSTOP` instead (20 000 = the executor's
 * `OUTPUT_HARD_CAP`, re-declared in `src/traceserver/output-backstop.ts`
 * because the core may not import `harness/`). The narrowing rule the page
 * itself is about did not change, so only the widths moved.
 * Everything else still describes current behaviour. Nothing here is an xfail /
 * skipped "known bug" test.
 */

const traceDirs: string[] = [];

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

/** Write `content` to `<traceDir>/<conversationId>.jsonl` (one file per session). */
function writeSession(
  traceDir: string,
  conversationId: string,
  content: string
): string {
  const text =
    content.length === 0 || content.endsWith("\n") ? content : `${content}\n`;
  writeFileSync(join(traceDir, `${conversationId}.jsonl`), text);
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

interface Envelope {
  records: Array<Record<string, unknown>>;
  total: number;
  skipped_lines: number;
  truncated: boolean;
  offset: number;
}

function envelope(json: string): Envelope {
  return JSON.parse(json) as Envelope;
}

function idsOf(page: ReadonlyArray<Record<string, unknown>>): unknown[] {
  return page.map((record) => record["llm_call_id"]);
}

/** The preview marker `preview()` (query-trace-core.ts) appends. */
const MARKER = "...[truncated]";

/**
 * T3 retired `response_truncated` from the tool face: it tracked how many
 * records survived the budget, never whether a field was dropped, so a record
 * stripped of its `tool_results` still reported `false`. Assert the key is
 * GONE — a `false` value would be the exact lie this ticket removes.
 */
function assertNoResponseTruncationFlag(parsed: Envelope, shape: string): void {
  assert.ok(
    !("response_truncated" in parsed),
    `${shape} must not carry a response_truncated key at all`
  );
}

describe("query_trace traceserver core", () => {
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

  describe("drill-down projection", () => {
    it("returns the raw row untouched (messages and raw included) for detail=messages", async () => {
      const traceDir = makeTraceDir();
      const messages = [{ role: "user", content: "hi" }];
      writeSession(traceDir, "c1", jsonLine(llmCallRow("c1", 1, { messages })));

      const json = await createQueryTraceCore({ traceDir })({
        conversation_id: "c1",
        record_id: "llm-1",
        detail: "messages",
      });
      const parsed = envelope(json);

      assert.equal(parsed.records.length, 1);
      assert.equal(parsed.total, 1);
      // projectDrillDownRecord hands back the reader row verbatim, so the
      // `messages` array AND the reader's `raw.unmapped` copy of it survive —
      // the payload carries the messages twice on this path. `messages` is not
      // a TRACE_FIELD_DEFS jsonlKey, so the reader parks it in `raw.unmapped`
      // (reader.ts:174-179); assert that copy's value, not merely that `raw` is
      // an object, which `null` and an empty `unmapped` would both satisfy.
      assert.deepEqual(parsed.records[0]["messages"], messages);
      const raw = parsed.records[0]["raw"] as
        { unmapped?: Array<{ key: string; value: unknown }> } | undefined;
      assert.ok(raw, "the reader must attach raw for unmapped keys");
      const unmappedMessages = (raw.unmapped ?? []).filter(
        (entry) => entry.key === "messages"
      );
      assert.equal(unmappedMessages.length, 1);
      assert.deepEqual(unmappedMessages[0]["value"], messages);
      // `serializeDrillDown` consults no budget at all — `TRACE_OUTPUT_BACKSTOP`
      // is the *list* path's anchor — so there is no flag here to read.
      assertNoResponseTruncationFlag(parsed, "a small drilled record");
    });

    it("drills a messages_captured:false row as a bare record with no messages and no truncation signal", async () => {
      const traceDir = makeTraceDir();
      writeSession(
        traceDir,
        "c17",
        jsonLine(llmCallRow("c17", 1, { messages_captured: false }))
      );

      const parsed = envelope(
        await createQueryTraceCore({ traceDir })({
          conversation_id: "c17",
          record_id: "llm-1",
          detail: "messages",
        })
      );
      const record = parsed.records[0] ?? {};

      // Boundary class "empty" on the drill-down face: the write side recorded
      // that it captured nothing, and `detail: "messages"` makes
      // projectDrillDownRecord return the row verbatim, so `messages` is simply
      // not a key of the response.
      assert.equal(record["messages_captured"], false);
      // Near-vacuous on its own: this fixture never writes a `messages` key at
      // all. The load-bearing assertion is the key set below.
      assert.ok(!("messages" in record));
      // Nothing on this path can claim truncation any more, so there is no
      // signal of any kind left to misread as "nothing was captured".
      assertNoResponseTruncationFlag(
        parsed,
        "the drilled messages_captured:false record"
      );
      assert.equal(parsed.truncated, false);
      // `messages_captured: false` is the only field separating "this record
      // really is empty" from "this record has content" — nothing encodes a drop
      // happening. Note this key set hinges on `messages_captured` and
      // `llm_call_id` staying unmapped in fields.ts, which is what routes them
      // into `raw.unmapped`; add that mapping and `raw` stops carrying them.
      assert.deepEqual(
        Object.keys(record).sort(),
        [
          "conversation_id",
          "llm_call_id",
          "messages_captured",
          "raw",
          "record_type",
          "started_at",
          "turn_id",
        ].sort()
      );
    });

    it("returns an oversize drilled row complete, messages and every object field included, on detail=messages", async () => {
      const traceDir = makeTraceDir();
      // 16 pairs × 1,500 characters: measured ≈ 27,179 characters on disk, so the
      // fixture really crosses the budget `serializeListPage` would narrow to.
      const messages = toolRoundTrips(16, 1_500); // 32 messages
      const row = llmCallRow("c2", 2, {
        model: "claude-some-model",
        max_tokens: 8192,
        stream: true,
        cache: null,
        usage: { input_tokens: 5 },
        error: { kind: "upstream" },
        messages,
      });
      const rawLine = writeSession(traceDir, "c2", jsonLine(row));
      assert.ok(
        rawLine.length > TRACE_OUTPUT_BACKSTOP,
        `fixture must exceed the backstop, got ${rawLine.length} characters`
      );

      const json = await createQueryTraceCore({ traceDir })({
        conversation_id: "c2",
        record_id: "llm-2",
        detail: "messages",
      });
      const parsed = envelope(json);
      const record = parsed.records[0] ?? {};

      // Compared in characters, the unit the budget is counted in (the anchor is
      // `JSON.stringify(...).length` in serializeListPage, not a byte count).
      // Overshooting here is the claim, not an accident: a record the caller
      // named comes back whole, where the old behaviour shrank it to a scalar
      // stub while claiming nothing had been truncated.
      assert.ok(
        json.length > TRACE_OUTPUT_BACKSTOP,
        `a drilled record is returned whole even when it overshoots the backstop, got ${json.length} characters`
      );
      assert.deepEqual(record["messages"], messages);
      // The reader's `raw` copy survives too: nothing on this path is stripped to
      // make the response smaller.
      assert.ok("raw" in record, "raw must survive the drill-down");
      assert.equal(parsed.records.length, 1);
      assert.equal(parsed.total, 1);
      assertNoResponseTruncationFlag(parsed, "an oversize drilled row");
      // Scalars, nulls, objects and arrays alike: the whole field set is there,
      // so usage / error / cache no longer disappear for their value types.
      assert.equal(record["model"], "claude-some-model");
      assert.equal(record["max_tokens"], 8192);
      assert.equal(record["stream"], true);
      assert.equal(record["cache"], null);
      assert.deepEqual(record["error"], { kind: "upstream" });
      assert.deepEqual(record["usage"], { input_tokens: 5 });
      // The record's own key set is the fixture's key set plus the reader's `raw`
      // — no field was dropped and none was invented. This is the shape-level
      // version of "nothing is silently removed".
      assert.deepEqual(
        Object.keys(record).sort(),
        [...Object.keys(row), "raw"].sort()
      );
    });

    it("keeps the whole tool_results projection, one entry per result, when a drilled projection overshoots the backstop", async () => {
      const traceDir = makeTraceDir();
      // 50 pairs: each projected entry carries a preview capped at
      // TOOL_RESULT_PREVIEW_CAP, so the projection is what has to be wide enough
      // to overshoot — the assertion below measures it against the live
      // TRACE_OUTPUT_BACKSTOP rather than trusting a recorded figure.
      const pairCount = 50;
      const messages = toolRoundTrips(pairCount, 400);
      const expectedIds = messages.flatMap((message) => {
        const content = (message as { content?: unknown }).content;
        if (!Array.isArray(content)) return [];
        return content
          .map((part) => (part as Record<string, unknown>)["tool_use_id"])
          .filter((id): id is string => typeof id === "string");
      });
      const rawLine = writeSession(
        traceDir,
        "c3",
        jsonLine(llmCallRow("c3", 3, { messages }))
      );
      assert.ok(
        rawLine.length > TRACE_OUTPUT_BACKSTOP,
        `fixture must exceed the backstop, got ${rawLine.length} characters`
      );

      const json = await createQueryTraceCore({ traceDir })({
        conversation_id: "c3",
        record_id: "llm-3",
        detail: "tool_results",
      });
      const parsed = envelope(json);
      const record = parsed.records[0] ?? {};

      // `detail=tool_results` goes through the same drill-down serializer as
      // `messages`, which consults no budget: this many pairs overshoot
      // `TRACE_OUTPUT_BACKSTOP` rather than one result being dropped.
      const toolResults = record["tool_results"];
      assert.ok(Array.isArray(toolResults), "tool_results must stay an array");
      assert.equal(
        toolResults.length,
        pairCount,
        "no result may be dropped to fit the backstop"
      );
      assert.deepEqual(
        toolResults.map(
          (entry) => (entry as Record<string, unknown>)["tool_use_id"]
        ),
        expectedIds
      );
      assert.ok(
        json.length > TRACE_OUTPUT_BACKSTOP,
        `the drilled projection is returned whole, got ${json.length} characters`
      );
      assertNoResponseTruncationFlag(parsed, "an oversize tool_results drill");
      assert.equal(parsed.records.length, 1);
      assert.equal(record["llm_call_id"], "llm-3");
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
      // the honest end-of-data signal, `total` still reports the untrimmed
      // filtered count, and each surviving record is the same object the
      // un-narrowed path would have returned.
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
      assert.equal(parsed.total, NARROWING_PAGE_RECORD_COUNT);
      assertNoResponseTruncationFlag(parsed, "a narrowed list page");
      const expectedOrder = Array.from(
        { length: NARROWING_PAGE_RECORD_COUNT },
        (_unused, i) => `llm-${NARROWING_PAGE_RECORD_COUNT - 1 - i}`
      );
      assert.deepEqual(
        idsOf(parsed.records),
        expectedOrder.slice(0, parsed.records.length)
      );
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
      assertNoResponseTruncationFlag(parsed, "a list page that fits");
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
      assertNoResponseTruncationFlag(
        parsed,
        "a narrowed page of whole records"
      );
    });

    it("returns the first record whole instead of an empty page when not even one record fits", async () => {
      const traceDir = makeTraceDir();
      const wide = writeUnfittableRecordSession(
        traceDir,
        "c6",
        6,
        UNFITTABLE_FIELD_COUNT
      );

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
      assert.equal(parsed.total, 1);
      // `truncated` still belongs to the reader's byte window, not to this
      // serializer: one line, fully read, so false.
      assert.equal(parsed.truncated, false);
      assertNoResponseTruncationFlag(parsed, "an unfittable single record");
      // Whole means whole: every field of the wide record survived the walk.
      assert.deepEqual(
        Object.keys(record).sort(),
        [...Object.keys(wide), "messages_count", "tool_result_count"].sort()
      );
      for (let i = 0; i < UNFITTABLE_FIELD_COUNT; i++) {
        assert.equal(record[`field_${i}`], "q".repeat(400));
      }
    });
  });

  describe("truncation metadata", () => {
    it("carries no response_truncated key on any tool-face shape", async () => {
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
        readonly branch: (parsed: Envelope, json: string) => void;
      }> = [
        {
          shape: "an empty session",
          input: { conversation_id: "empty" },
          branch: (parsed) => assert.equal(parsed.records.length, 0),
        },
        {
          shape: "a session with no file",
          input: { conversation_id: "no-such-session" },
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
            assert.equal(parsed.total, NARROWING_PAGE_RECORD_COUNT);
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
        {
          shape: "an oversize drill-down",
          input: {
            conversation_id: "oversize",
            record_id: "llm-6",
            detail: "messages",
          },
          branch: (parsed, json) => {
            assert.ok(json.length > TRACE_OUTPUT_BACKSTOP);
            assert.equal(parsed.records.length, 1);
          },
        },
        {
          shape: "a drill-down that matched nothing",
          input: { conversation_id: "narrows", record_id: "nope" },
          branch: (parsed) => assert.equal(parsed.records.length, 0),
        },
      ];
      for (const { shape, input, branch } of shapes) {
        const json = await core(input);
        const parsed = envelope(json);
        branch(parsed, json);
        assertNoResponseTruncationFlag(parsed, shape);
        // The envelope's whole key set, so no replacement metadata sneaks in
        // either. total / truncated stay for now; T7 takes them off the tool face.
        assert.deepEqual(Object.keys(parsed).sort(), [
          "offset",
          "records",
          "skipped_lines",
          "total",
          "truncated",
        ]);
      }
    });
  });

  describe("row pagination", () => {
    it("ignores every offset the caller passes, so rows past the first page are unreachable", async () => {
      const traceDir = makeTraceDir();
      let content = "";
      for (let i = 0; i < 10; i++) content += jsonLine(llmCallRow("c7", i));
      writeSession(traceDir, "c7", content);
      const core = createQueryTraceCore({ traceDir });

      const firstPage = await core({ conversation_id: "c7", limit: 2 });
      const parsed = envelope(firstPage);
      assert.deepEqual(idsOf(parsed.records), ["llm-9", "llm-8"]);
      assert.equal(parsed.total, 10);

      // TraceQuery carries a row `offset` and the reader honours it, but
      // parseInput never reads an `offset` key: the value is silently unused —
      // not rejected, so there is no negative-offset surface to test either.
      // T7: flip site — `offset` becomes a real tool-face parameter, so this
      // byte-identity loop turns into a paging assertion (and gains the
      // negative / non-integer rejections the panel face already applies at
      // http.ts:111-115).
      for (const offset of [2, 8, -5, "abc"]) {
        assert.equal(
          await core({ conversation_id: "c7", limit: 2, offset }),
          firstPage,
          `offset ${JSON.stringify(offset)} must be ignored`
        );
      }
    });
  });

  describe("record_id drill-down", () => {
    it("scans with the internal max limit even when the caller asked for one record", async () => {
      const traceDir = makeTraceDir();
      // More rows than one internal page, so the pin also covers the paging
      // loop inside findRecord.
      const rowCount = 250;
      assert.ok(rowCount > QUERY_TRACE_MAX_LIMIT);
      let content = "";
      for (let i = 0; i < rowCount; i++)
        content += jsonLine(llmCallRow("c8", i));
      writeSession(traceDir, "c8", content);
      const core = createQueryTraceCore({ traceDir });

      // Proof the caller's limit is honoured on the list page...
      const listPage = envelope(
        await core({ conversation_id: "c8", limit: 1 })
      );
      assert.deepEqual(idsOf(listPage.records), [`llm-${rowCount - 1}`]);
      assert.equal(listPage.total, rowCount);

      // ...and silently overridden on a drill-down: llm-0 is the oldest row,
      // unreachable on a page of one, yet it is found because findRecord forces
      // `limit: QUERY_TRACE_MAX_LIMIT` and keeps paging to the scan cap.
      // T7: flip site — the `record_id` axis leaves query_trace for get_record,
      // and the override that makes it work (and makes the caller's limit a
      // silent no-op) goes with it.
      const drill = envelope(
        await core({ conversation_id: "c8", limit: 1, record_id: "llm-0" })
      );
      assert.deepEqual(idsOf(drill.records), ["llm-0"]);
      assert.equal(drill.total, 1);
      assert.equal(drill.skipped_lines, 0);
    });

    it("matches a record_id against any of the ten id keys, not just llm_call_id", async () => {
      const traceDir = makeTraceDir();
      writeSession(
        traceDir,
        "c9",
        jsonLine(llmCallRow("c9", 1, { session_id: "sess-1" }))
      );
      const core = createQueryTraceCore({ traceDir });

      // The caller searched by turn_id; the row that matched is llm-1, whose
      // llm_call_id is a different value. `turn_id` doubles as filter and id.
      const byTurn = envelope(
        await core({ conversation_id: "c9", record_id: "turn-1" })
      );
      assert.deepEqual(idsOf(byTurn.records), ["llm-1"]);
      assert.equal(byTurn.records[0]["turn_id"], "turn-1");
      assert.equal(byTurn.total, 1);

      const bySession = envelope(
        await core({ conversation_id: "c9", record_id: "sess-1" })
      );
      assert.deepEqual(idsOf(bySession.records), ["llm-1"]);
    });

    it("returns the first scanned row whose id keys match when one id appears under two keys", async () => {
      const traceDir = makeTraceDir();
      writeSession(
        traceDir,
        "c10",
        jsonLine({
          record_type: "turn",
          conversation_id: "c10",
          turn_id: "dup",
          started_at: "2026-01-02T00:00:00.000Z",
        }) +
          jsonLine({
            record_type: "llm_call",
            conversation_id: "c10",
            llm_call_id: "dup",
            turn_id: "turn-other",
            started_at: "2026-01-01T00:00:00.000Z",
          })
      );

      const parsed = envelope(
        await createQueryTraceCore({ traceDir })({
          conversation_id: "c10",
          record_id: "dup",
        })
      );

      // Array#find over the scan order: the newer turn row matched on turn_id
      // before the llm_call row could match on llm_call_id.
      assert.equal(parsed.records.length, 1);
      assert.equal(parsed.records[0]["record_type"], "turn");
      assert.equal(parsed.records[0]["turn_id"], "dup");
    });

    it("returns an empty result, not an error, when record_id matches nothing", async () => {
      const traceDir = makeTraceDir();
      writeSession(traceDir, "c11", jsonLine(llmCallRow("c11", 1)));

      const parsed = envelope(
        await createQueryTraceCore({ traceDir })({
          conversation_id: "c11",
          record_id: "no-such-record",
        })
      );

      assert.deepEqual(parsed.records, []);
      assert.equal(parsed.total, 0);
      assert.equal(parsed.truncated, false);
      assertNoResponseTruncationFlag(
        parsed,
        "a drill-down that matched nothing"
      );
    });
  });

  describe("reader result plumbing", () => {
    it("propagates the reader's skipped_lines count into the envelope", async () => {
      const traceDir = makeTraceDir();
      writeSession(
        traceDir,
        "c12",
        `not json\n${jsonLine(llmCallRow("c12", 1))}[1,2]\n`
      );

      const parsed = envelope(
        await createQueryTraceCore({ traceDir })({ conversation_id: "c12" })
      );

      // A failed parse and a non-object JSON line both count; the good row is
      // still returned.
      assert.equal(parsed.skipped_lines, 2);
      assert.deepEqual(idsOf(parsed.records), ["llm-1"]);
      assert.equal(parsed.total, 1);
    });

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

      const drill = envelope(
        await core({
          conversation_id: "c13",
          record_id: "llm-1",
          detail: "tool_results",
        })
      );
      assert.deepEqual(drill.records[0]["tool_results"], []);
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
      const [drillA, drillB] = await Promise.all([
        core({
          conversation_id: "c14",
          record_id: "llm-1",
          detail: "tool_results",
        }),
        core({
          conversation_id: "c14",
          record_id: "llm-1",
          detail: "tool_results",
        }),
      ]);

      assert.equal(listA, listB);
      assert.equal(drillA, drillB);
      assert.equal(envelope(drillA).records.length, 1);
    });
  });
});
