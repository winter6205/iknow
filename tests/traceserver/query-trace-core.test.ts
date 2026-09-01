import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, it } from "vitest";

import {
  createQueryTraceCore,
  QUERY_TRACE_MAX_LIMIT,
  QUERY_TRACE_PREVIEW_CAP,
  QUERY_TRACE_RESPONSE_CAP,
} from "../../src/traceserver/query-trace-core.ts";

/**
 * Characterization baseline for the shared `query_trace` core (plan
 * `trace-mcp-read-side-split` T2, spec SC14).
 *
 * Every assertion here describes what the UNMODIFIED core does today, including
 * the P0 silent field-drop, which is pinned as a passing assertion. T3 flips
 * these directions; nothing here is an xfail / skipped "known bug" test.
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

interface Envelope {
  records: Array<Record<string, unknown>>;
  total: number;
  skipped_lines: number;
  truncated: boolean;
  offset: number;
  response_truncated?: boolean;
}

function envelope(json: string): Envelope {
  return JSON.parse(json) as Envelope;
}

function idsOf(page: ReadonlyArray<Record<string, unknown>>): unknown[] {
  return page.map((record) => record["llm_call_id"]);
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
      // (query-trace-core.ts:289-292) and the `toolResults.length > 0` guard
      // (:295-299) mean an empty array yields no preview keys at all rather than
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
      // `record_type !== "llm_call"` early return (query-trace-core.ts:285)
      // hands back projectRecordBase's verbatim scalar copy, so messages_count /
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
    it("returns the raw row untouched (messages and raw included) for detail=messages under the response cap", async () => {
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
      // The compacting branch never runs, so the flag is absent entirely.
      assert.equal(parsed.response_truncated, undefined);
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
      // that it captured nothing, and `detail: "messages"` returns the row
      // verbatim (query-trace-core.ts:308), so `messages` is simply not a key of
      // the response.
      assert.equal(record["messages_captured"], false);
      // Near-vacuous on its own: this fixture never writes a `messages` key at
      // all. The load-bearing assertion is the key set below.
      assert.ok(!("messages" in record));
      // And because that row is far under the cap, compactRecord never runs, so
      // the envelope carries neither response_truncated nor truncated:true —
      // there is no truncation signal of any kind to read as "nothing was
      // captured".
      assert.equal(parsed.response_truncated, undefined);
      assert.equal(parsed.truncated, false);
      // Honest finding: this shape and the P0 silent-drop shape below differ only
      // by `raw` (plus the 256-char slicing compaction applies). `raw` is present
      // here solely because this response is small enough that compactRecord never
      // runs — projectRecordBase deletes it outright on the compacted path — and
      // projectRecordBase also strips `messages` on both paths. So the discriminator
      // tracks response SIZE, not capture status: no field encodes "a drop
      // happened", which is why "never captured" and "silently dropped" stay
      // indistinguishable to the caller. Note this hinges on `messages_captured`
      // and `llm_call_id` remaining unmapped in fields.ts, which is what routes
      // them into raw.unmapped; if that mapping is ever added, `raw` stops being
      // the differentiator. T6 gives the drill-down a real contract
      // (`get_record` + `record_not_found` / `window_overflow`) and T7 removes
      // the implicit defaults; the conflation is resolved there, not by T3.
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

    it("silently drops messages yet reports response_truncated:false when an oversize row is drilled with detail=messages", async () => {
      const traceDir = makeTraceDir();
      const messages = toolRoundTrips(16, 300); // 32 messages
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
        Buffer.byteLength(rawLine) > QUERY_TRACE_RESPONSE_CAP,
        `fixture must exceed the response cap, got ${Buffer.byteLength(rawLine)}`
      );

      const json = await createQueryTraceCore({ traceDir })({
        conversation_id: "c2",
        record_id: "llm-2",
        detail: "messages",
      });
      const parsed = envelope(json);
      const record = parsed.records[0] ?? {};

      // THE P0: the caller asked for messages, got a scalar stub back, and the
      // response still claims it was not truncated.
      // T3: flip site — every assertion in this block describes today's silent
      // drop and is rewritten there (fields stop vanishing, and
      // response_truncated leaves the tool face entirely).
      assert.ok(!("messages" in record), "messages vanished from the record");
      assert.ok(!("raw" in record), "raw vanished from the record");
      assert.equal(parsed.response_truncated, false);
      assert.equal(parsed.records.length, 1);
      assert.equal(parsed.total, 1);
      assert.ok(json.length <= QUERY_TRACE_RESPONSE_CAP);
      // compactRecord keeps numbers/booleans/null and the `error` key only;
      // every other object/array field is dropped with no signal.
      assert.equal(record["model"], "claude-some-model");
      assert.equal(record["max_tokens"], 8192);
      assert.equal(record["stream"], true);
      assert.equal(record["cache"], null);
      assert.deepEqual(record["error"], { kind: "upstream" });
      assert.ok(!("usage" in record));
    });

    it("silently drops tool_results yet reports response_truncated:false when the tool_results projection exceeds the response cap", async () => {
      const traceDir = makeTraceDir();
      const rawLine = writeSession(
        traceDir,
        "c3",
        jsonLine(llmCallRow("c3", 3, { messages: toolRoundTrips(16, 300) }))
      );
      assert.ok(Buffer.byteLength(rawLine) > QUERY_TRACE_RESPONSE_CAP);

      const json = await createQueryTraceCore({ traceDir })({
        conversation_id: "c3",
        record_id: "llm-3",
        detail: "tool_results",
      });
      const parsed = envelope(json);
      const record = parsed.records[0] ?? {};

      // The documented T3 escape hatch (detail=tool_results) is hit by the same
      // drop: 16 projections × a 300-char preview — 300 chars, not the
      // TOOL_RESULT_PREVIEW_CAP=400 ceiling, because truncatePreview
      // (project-tool-results.ts:172-178) leaves a 300-char text untouched —
      // are enough to push the untrimmed drill-down past the 4,000 cap, so the
      // whole array disappears while the response still claims
      // response_truncated:false. The load-bearing claim is qualitative (over the
      // cap yet reporting no truncation), so no exact byte count is pinned here.
      // T3: flip site — tool_results stops being dropped with it.
      assert.ok(!("tool_results" in record));
      assert.equal(parsed.response_truncated, false);
      assert.equal(parsed.records.length, 1);
      assert.equal(record["llm_call_id"], "llm-3");
    });
  });

  describe("response cap serialization", () => {
    it("trims records off the tail of an over-cap list page and flips response_truncated", async () => {
      const traceDir = makeTraceDir();
      let content = "";
      for (let i = 0; i < 8; i++) {
        content += jsonLine(
          llmCallRow("c4", i, { messages: toolRoundTrips(2, 500) })
        );
      }
      writeSession(traceDir, "c4", content);

      const json = await createQueryTraceCore({ traceDir })({
        conversation_id: "c4",
        limit: 8,
      });
      const parsed = envelope(json);

      assert.ok(json.length <= QUERY_TRACE_RESPONSE_CAP);
      // Fewer records than the caller asked for, cut from the tail; `total`
      // still reports the untrimmed filtered count.
      assert.ok(parsed.records.length < 8);
      assert.ok(parsed.records.length >= 1);
      assert.equal(parsed.total, 8);
      // T3: flip site — the records.length < limit signal above stays, but
      // response_truncated itself leaves the tool face in T3 (it tracks record
      // count, not fields, and is the false-negative source).
      assert.equal(parsed.response_truncated, true);
      const expectedOrder = [7, 6, 5, 4, 3, 2, 1, 0].map((i) => `llm-${i}`);
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
      const marker = "...[truncated]";

      // On the non-compacted path `preview()` (query-trace-core.ts:330-340) is
      // the only preview owner: cut at QUERY_TRACE_PREVIEW_CAP, append the
      // marker. No test pinned that pair today, and T3 restores precisely this
      // shape on the compacted path too (compactRecord stops slicing to 256), so
      // this is the value T3's change has to land on.
      assert.equal(typeof preview, "string");
      assert.ok((preview as string).endsWith(marker));
      assert.equal(
        (preview as string).length,
        QUERY_TRACE_PREVIEW_CAP + marker.length
      );
      // Compaction did not run: the flag is absent, not false.
      assert.equal(parsed.response_truncated, undefined);
    });

    it("slices compacted string fields to 256 characters, losing the preview truncation marker", async () => {
      const traceDir = makeTraceDir();
      let content = "";
      for (let i = 0; i < 8; i++) {
        content += jsonLine(
          llmCallRow("c5", i, { messages: toolRoundTrips(2, 500) })
        );
      }
      writeSession(traceDir, "c5", content);

      const parsed = envelope(
        await createQueryTraceCore({ traceDir })({ conversation_id: "c5" })
      );
      const record = parsed.records[0] ?? {};
      const messages = toolRoundTrips(2, 500);
      const lastMessage = JSON.stringify(messages[messages.length - 1] ?? {});
      const preview = record["last_message_preview"];

      // The uncompressed list projection caps a preview at QUERY_TRACE_PREVIEW_CAP
      // plus a "...[truncated]" marker (pinned by the test above); compactRecord
      // slices the string to 256 and so cuts the marker off — the value looks like
      // a complete string.
      // No separate "compaction actually ran" guard is needed: `preview()` can only
      // ever produce a CAP+marker-length string, so length === 256 with the marker
      // absent is reachable on the compactRecord path alone. These assertions
      // self-witness.
      // T3: flip site — compactRecord leaves the tool face, so the preview keeps
      // its QUERY_TRACE_PREVIEW_CAP cut and its marker instead of being sliced to
      // 256 here.
      assert.equal(typeof preview, "string");
      assert.equal((preview as string).length, 256);
      assert.ok(!(preview as string).endsWith("...[truncated]"));
      assert.equal(preview, lastMessage.slice(0, 256));
      // A string already under 256 chars is left alone by the slice.
      assert.equal(record["llm_call_id"], "llm-7");
      // Array fields are neither strings nor scalars, so they are dropped.
      assert.ok(!("tool_result_previews" in record));
    });

    it("returns zero records when even one compacted record exceeds the cap, with truncated left as the reader reported it", async () => {
      const traceDir = makeTraceDir();
      const wide: Record<string, unknown> = llmCallRow("c6", 6);
      for (let i = 0; i < 40; i++) wide[`field_${i}`] = "q".repeat(400);
      writeSession(traceDir, "c6", jsonLine(wide));

      const json = await createQueryTraceCore({ traceDir })({
        conversation_id: "c6",
      });
      const parsed = envelope(json);

      // T3: flip site — this whole shape comes from the count-0 branch of the
      // compaction loop, and that branch is one of the two paths T3 retires (a
      // page never shrinks to zero records and a single record never loses
      // fields), so the assertions below are rewritten there.
      assert.ok(json.length <= QUERY_TRACE_RESPONSE_CAP);
      assert.deepEqual(parsed.records, []);
      assert.equal(parsed.total, 1);
      assert.equal(parsed.response_truncated, true);
      // 40 fields × 256 chars stay over the cap, so the loop exits at count 0.
      // That count-0 iteration is what produces this shape: `truncated` keeps
      // the reader's value and response_truncated carries the signal. The
      // `truncated: true` fallback below the loop is therefore unreachable.
      assert.equal(parsed.truncated, false);
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
      assert.equal(parsed.response_truncated, undefined);
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
