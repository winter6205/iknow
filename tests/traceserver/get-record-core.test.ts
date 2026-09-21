import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, it } from "vitest";

import {
  createGetRecordCore,
  GET_RECORD_DEFAULT_COUNT,
  GET_RECORD_MAX_COUNT,
  GET_RECORD_DESCRIPTION,
  type GetRecordCoreHandler,
} from "../../src/traceserver/get-record-core.ts";
import {
  TraceQueryValidationError,
  TraceQueryRecordScanError,
  TraceRecordNotFoundError,
  TraceSessionNotFoundError,
  TraceWindowOverflowError,
} from "../../src/traceserver/query-trace-errors.ts";
import {
  TRACE_OUTPUT_BACKSTOP,
  TRACE_BACKSTOP_MARKER,
  applyTraceOutputBackstop,
} from "../../src/traceserver/output-backstop.ts";
import { TraceReadError } from "../../src/traceserver/types.ts";

/**
 * Contract suite for `get_record` — the third read axis.
 *
 * What makes this axis different from the other two: its read unit is a
 * character window the caller names, so the response is a fact about one span of
 * one part rather than a page or a projection. Three consequences run through
 * every assertion below.
 *
 *   1. A coordinate that does not take part in addressing is **rejected**, never
 *      ignored (the contract: 「参与寻址的坐标必须被回答，不被使用的坐标必须被拒」 —
 *      coordinates that participate in addressing must be answered, unused ones rejected).
 *   2. A window must lie entirely inside its part, so a successful call returns
 *      **exactly `count` characters** — that is what makes `count` a read unit
 *      whose response size can be budgeted in advance.
 *   3. Every failure the axis can raise is a typed error with its own `kind` and
 *      **no tool name in the message**: prefixing belongs
 *      to the two thin faces.
 *
 * The reader is never mocked: each case writes a real `.jsonl` under a temp dir.
 */

const traceDirs: string[] = [];
/**
 * All sessions sit at
 *   `<traceDir>/projects/<slug>/<convId>/trace.jsonl`.
 */
const TEST_PROJECT_SLUG = "test-project-get-record-core";

afterEach(() => {
  for (const traceDir of traceDirs.splice(0)) {
    rmSync(traceDir, { recursive: true, force: true });
  }
});

function makeTraceDir(): string {
  const traceDir = mkdtempSync(join(tmpdir(), "iknow-get-record-core-"));
  traceDirs.push(traceDir);
  return traceDir;
}

function jsonLine(row: Record<string, unknown>): string {
  return `${JSON.stringify(row)}\n`;
}

function writeSession(
  traceDir: string,
  conversationId: string,
  rows: ReadonlyArray<Record<string, unknown>>
): void {
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
    rows.map(jsonLine).join(""),
    "utf8"
  );
}

/**
 * The blob dir sits at `<traceDir>/projects/<slug>/<convId>/blobs`.
 * Mirror of the writer's `JsonlTraceService` default (ADR-0071 D4).
 */
function writeBlobFile(
  traceDir: string,
  conversationId: string,
  sha: string,
  stored: unknown
): void {
  const blobDir = join(
    traceDir,
    "projects",
    TEST_PROJECT_SLUG,
    conversationId,
    "blobs"
  );
  mkdirSync(blobDir, { recursive: true });
  writeFileSync(join(blobDir, sha), JSON.stringify(stored), "utf8");
}

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
    started_at: new Date(Date.UTC(2026, 0, 1, 0, 0, 0, index)).toISOString(),
    ...extra,
  };
}

/**
 * A text block whose rendered part starts with `b<i>`, so any returned slice is
 * attributable to the block it came from — a window that silently read a
 * neighbour would be caught by the prefix, not just by the length.
 */
function textBlock(index: number, chars: number): Record<string, unknown> {
  return { type: "text", text: `b${index}`.padEnd(chars, "z") };
}

function textMessage(index: number, blocks: number, chars: number) {
  return {
    role: index % 2 === 0 ? "user" : "assistant",
    content: Array.from({ length: blocks }, (_unused, b) =>
      textBlock(index * 10 + b, chars)
    ),
  };
}

/**
 * The rendering rule the contract leaves to the implementation, stated here as
 * the contract the tests hold it to: a content block is addressable as the text it
 * is stored as — a bare string stays a string, anything else is its JSON text.
 * Written independently of `src/` on purpose, so changing the implementation
 * silently cannot flip these cases green.
 */
function partText(part: unknown): string {
  return typeof part === "string" ? part : JSON.stringify(part);
}

/** `pairCount` assistant tool_use + user tool_result pairs, `chars` per result. */
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

interface Manifest {
  record: Record<string, unknown>;
  matched_on: string;
  detail: string;
  message_index?: number;
  parts: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

interface Window {
  record: Record<string, unknown>;
  matched_on: string;
  detail: string;
  message_index?: number;
  part_index: number;
  from_char: number;
  count: number;
  part_chars: number;
  text: string;
  [key: string]: unknown;
}

function coreFor(
  traceDir: string,
  rows: ReadonlyArray<Record<string, unknown>>,
  conversationId = "c1"
): GetRecordCoreHandler {
  writeSession(traceDir, conversationId, rows);
  return createGetRecordCore({ traceDir });
}

async function manifestOf(
  core: GetRecordCoreHandler,
  input: Record<string, unknown>
): Promise<Manifest> {
  return JSON.parse(
    await core({ conversation_id: "c1", ...input })
  ) as Manifest;
}

async function windowOf(
  core: GetRecordCoreHandler,
  input: Record<string, unknown>
): Promise<Window> {
  return JSON.parse(await core({ conversation_id: "c1", ...input })) as Window;
}

describe("get_record core — record addressing", () => {
  it("requires conversation_id instead of defaulting to the newest session", async () => {
    // Assumption 4: the implicit "newest session" default is what let an
    // external agent read a file it never named. This face is the first place
    // the parameter is required, so the omission is a validation rejection.
    const traceDir = makeTraceDir();
    const core = coreFor(traceDir, [llmCallRow("c1", 1, { messages: [] })]);

    for (const conversationId of [undefined, "", 42]) {
      await assert.rejects(
        () => core({ record_id: "llm-1", conversation_id: conversationId }),
        (error: unknown) =>
          error instanceof TraceQueryValidationError &&
          error.kind === "validation" &&
          error.field === "conversation_id" &&
          error.message === "conversation_id must be a non-empty string",
        `conversation_id ${JSON.stringify(conversationId)} must be rejected`
      );
    }
  });

  it("rejects a path separator in conversation_id, unprefixed", async () => {
    const traceDir = makeTraceDir();
    const core = coreFor(traceDir, [llmCallRow("c1", 1, { messages: [] })]);

    await assert.rejects(
      () => core({ conversation_id: "a/b", record_id: "llm-1" }),
      (error: unknown) =>
        error instanceof TraceQueryValidationError &&
        error.message === "conversation_id must not contain path separators",
      "expected the same unprefixed validation text both faces prefix themselves"
    );
  });

  it("requires record_id", async () => {
    const traceDir = makeTraceDir();
    const core = coreFor(traceDir, [llmCallRow("c1", 1, { messages: [] })]);

    await assert.rejects(
      () => core({ conversation_id: "c1" }),
      (error: unknown) =>
        error instanceof TraceQueryValidationError &&
        error.field === "record_id" &&
        error.message === "record_id must be a non-empty string",
      "a call that names no record has no content axis to read"
    );
  });

  it("reports an absent session file as session_not_found, not as an empty answer", async () => {
    // This kind is deliberately not `record_not_found`: reusing it here would
    // mislabel "no such session" as "no such record" — the record may well
    // exist, it was just never looked at.
    const traceDir = makeTraceDir();
    writeSession(traceDir, "present", [llmCallRow("present", 1)]);
    const core = createGetRecordCore({ traceDir });

    await assert.rejects(
      () => core({ conversation_id: "absent", record_id: "llm-1" }),
      (error: unknown) =>
        error instanceof TraceSessionNotFoundError &&
        error.kind === "session_not_found" &&
        error.conversationId === "absent" &&
        error.message === "no trace session file for conversation_id 'absent'",
      "expected session_not_found, which is a different claim from record_not_found"
    );
  });

  it("raises record_not_found where the row axis answers a silent empty list", async () => {
    const traceDir = makeTraceDir();
    const core = coreFor(traceDir, [llmCallRow("c1", 1, { messages: [] })]);

    // Same fixture, same missing id: query_trace's list face still returns
    // `records: []` (a silent empty list is the row axis's answer). Naming a record is a request that
    // can only be answered one of two ways, and "nothing matched" is not a
    // result — it is an error.
    await assert.rejects(
      () => core({ conversation_id: "c1", record_id: "no-such-record" }),
      (error: unknown) =>
        error instanceof TraceRecordNotFoundError &&
        error.kind === "record_not_found" &&
        error.recordId === "no-such-record" &&
        error.message === "no record matched record_id 'no-such-record'",
      "expected record_not_found instead of records: []"
    );
  });

  it("raises record_not_found for a session file that exists but holds nothing", async () => {
    // The empty class on this axis: a 0-byte file is a session that exists, so
    // the honest answer is `record_not_found` and not `session_not_found`.
    const traceDir = makeTraceDir();
    writeSession(traceDir, "c1", []);
    const core = createGetRecordCore({ traceDir });

    await assert.rejects(
      () => core({ conversation_id: "c1", record_id: "llm-1" }),
      (error: unknown) => error instanceof TraceRecordNotFoundError
    );
  });

  it("names which id axis matched", async () => {
    // RECORD_ID_KEYS is a 10-field OR, and `turn_id` doubles as a row filter and
    // an id, so a caller that asked by session_id must be told which key the hit
    // came in through rather than inferring it from the row.
    const traceDir = makeTraceDir();
    const core = coreFor(traceDir, [
      llmCallRow("c1", 7, { session_id: "sess-7", messages: [] }),
    ]);

    for (const [recordId, matchedOn] of [
      ["llm-7", "llm_call_id"],
      ["turn-7", "turn_id"],
      ["sess-7", "session_id"],
    ] as const) {
      const manifest = await manifestOf(core, { record_id: recordId });
      assert.equal(manifest.matched_on, matchedOn);
      assert.equal(manifest.record["llm_call_id"], "llm-7");
    }
  });

  it("carries the record's scalars and leaves messages and the reader's raw copy out", async () => {
    const traceDir = makeTraceDir();
    const messages = toolRoundTrips(1, 40);
    const row = llmCallRow("c1", 3, {
      model: "some-model",
      usage: { input_tokens: 5 },
      messages,
    });
    const core = coreFor(traceDir, [row]);

    const manifest = await manifestOf(core, { record_id: "llm-3" });

    assert.equal(manifest.record["model"], "some-model");
    assert.deepEqual(manifest.record["usage"], { input_tokens: 5 });
    assert.ok(!("messages" in manifest.record));
    assert.ok(!("raw" in manifest.record));
  });

  it("surfaces a TraceSessionNotFoundError when the conversation folder has no trace.jsonl", async () => {
    // The conv folder exists but carries no trace.jsonl. The
    // old layout would EISDIR a directory named `<convId>.jsonl`; the new
    // layout skips folders without the canonical name. The session is therefore
    // "not found" (vs. "session folder present but unreadable"). The test now
    // pins that distinction: TraceSessionNotFoundError comes through with the
    // exact conversation_id the caller sent, unprefixed.
    const traceDir = makeTraceDir();
    mkdirSync(join(traceDir, "projects", TEST_PROJECT_SLUG, "c1"), {
      recursive: true,
    });

    await assert.rejects(
      () =>
        createGetRecordCore({ traceDir })({
          conversation_id: "c1",
          record_id: "llm-1",
        }),
      (error: unknown) =>
        error instanceof TraceSessionNotFoundError &&
        error.conversationId === "c1"
    );
  });

  it("ignores keys this axis has no meaning for", async () => {
    const traceDir = makeTraceDir();
    const core = coreFor(traceDir, [llmCallRow("c1", 1, { messages: [] })]);

    const strict = await manifestOf(core, { record_id: "llm-1" });
    const withExtras = JSON.parse(
      await core({
        conversation_id: "c1",
        record_id: "llm-1",
        limit: 5,
        record_type: "turn",
      })
    ) as Manifest;

    assert.deepEqual(withExtras, strict);
  });
});

describe("get_record core — arm selection", () => {
  it("answers an inventory when part_index is absent, with sizes and no content", async () => {
    const traceDir = makeTraceDir();
    const messages = [textMessage(0, 2, 900), textMessage(1, 1, 50)];
    const core = coreFor(traceDir, [llmCallRow("c1", 1, { messages })]);

    const manifest = await manifestOf(core, {
      record_id: "llm-1",
      detail: "messages",
    });

    assert.deepEqual(Object.keys(manifest), [
      "record",
      "matched_on",
      "detail",
      "parts",
    ]);
    assert.deepEqual(
      manifest.parts,
      messages.flatMap((message, messageIndex) =>
        (message.content as unknown[]).map((part, partIndex) => ({
          message_index: messageIndex,
          part_index: partIndex,
          chars: partText(part).length,
          // The inventory arm's parts carry their message's role: parts of a
          // user message carry "user", parts of an assistant message carry "assistant".
          role: message.role,
        }))
      )
    );
    // Sizes only: the inventory's whole point is to let the caller budget a
    // window, so a part's text must not ride along with it.
    assert.ok(!JSON.stringify(manifest.parts).includes("zzz"));
  });

  it("scopes the inventory to one message when message_index is given, and echoes it", async () => {
    const traceDir = makeTraceDir();
    const core = coreFor(traceDir, [
      llmCallRow("c1", 1, {
        messages: [textMessage(0, 2, 900), textMessage(1, 3, 700)],
      }),
    ]);

    const manifest = await manifestOf(core, {
      record_id: "llm-1",
      detail: "messages",
      message_index: 1,
    });

    assert.deepEqual(Object.keys(manifest), [
      "record",
      "matched_on",
      "detail",
      "message_index",
      "parts",
    ]);
    assert.equal(manifest.message_index, 1);
    assert.deepEqual(
      manifest.parts.map((p) => p["part_index"]),
      [0, 1, 2]
    );
  });

  it("lists projected tool results in projection order with full sizes, not preview sizes", async () => {
    const traceDir = makeTraceDir();
    const messages = toolRoundTrips(3, 900);
    const core = coreFor(traceDir, [llmCallRow("c1", 1, { messages })]);

    const manifest = await manifestOf(core, { record_id: "llm-1" });

    assert.equal(manifest.detail, "tool_results");
    assert.deepEqual(Object.keys(manifest), [
      "record",
      "matched_on",
      "detail",
      "parts",
    ]);
    // `chars` is the part's real length. The list axis caps previews at
    // TOOL_RESULT_PREVIEW_CAP; reusing that number here would tell a caller a
    // 900-character result needs one window when it needs three.
    assert.deepEqual(
      manifest.parts.map((part, index) => ({
        ...part,
        expected: index,
      })),
      [0, 1, 2].map((index) => ({
        part_index: index,
        chars: 900,
        tool_use_id: `toolu-${index}`,
        name: "bash",
        is_error: false,
        expected: index,
      }))
    );
  });

  it("carries a failed tool result's is_error into the inventory", async () => {
    // `is_error` is the read-first signal on this face: a failed result is
    // precisely the part a caller wants to open a window on, and the test above
    // only ever pins `false`. The half that breaks quietly is the merge —
    // `collectToolResults` ORs the flag across blocks sharing one tool_use_id
    // (src/traceserver/project-tool-results.ts), so a merge that kept the first
    // block's answer would still return a well-formed inventory, just one that
    // tells the caller this result succeeded.
    const traceDir = makeTraceDir();
    const core = coreFor(traceDir, [
      llmCallRow("c1", 1, {
        messages: [
          {
            role: "assistant",
            content: [
              { type: "tool_use", id: "toolu-fail", name: "bash", input: {} },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu-fail",
                content: "e".repeat(700),
                is_error: true,
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu-split",
                content: "z".repeat(30),
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu-split",
                content: "!",
                is_error: true,
              },
            ],
          },
        ],
      }),
    ]);

    const manifest = await manifestOf(core, { record_id: "llm-1" });

    assert.deepEqual(manifest.parts, [
      {
        part_index: 0,
        chars: 700,
        tool_use_id: "toolu-fail",
        name: "bash",
        is_error: true,
      },
      {
        part_index: 1,
        // The two blocks are one part, so `chars` is the merged text's length —
        // the window has to be planned against that, not against either block.
        chars: 31,
        tool_use_id: "toolu-split",
        is_error: true,
      },
    ]);
    // No tool_use block ever named `toolu-split`, so the inventory omits the key
    // instead of answering null/undefined: a caller must be able to tell "not
    // named" from "named nothing".
    assert.ok(!("name" in (manifest.parts[1] ?? {})));
  });

  it("defaults detail to tool_results and echoes the value it applied", async () => {
    const traceDir = makeTraceDir();
    const core = coreFor(traceDir, [
      llmCallRow("c1", 1, { messages: toolRoundTrips(1, 50) }),
    ]);

    const omitted = await manifestOf(core, { record_id: "llm-1" });
    const explicit = await manifestOf(core, {
      record_id: "llm-1",
      detail: "tool_results",
    });

    assert.equal(omitted.detail, "tool_results");
    assert.deepEqual(omitted, explicit);
  });

  it("rejects an unknown detail", async () => {
    const traceDir = makeTraceDir();
    const core = coreFor(traceDir, [llmCallRow("c1", 1, { messages: [] })]);

    await assert.rejects(
      () => manifestOf(core, { record_id: "llm-1", detail: "prompts" }),
      (error: unknown) =>
        error instanceof TraceQueryValidationError &&
        error.field === "detail" &&
        error.message ===
          "detail must be one of: tool_results, messages, system, tools"
    );
  });

  it("rejects the window coordinates on the inventory arm, where nothing uses them", async () => {
    const traceDir = makeTraceDir();
    const core = coreFor(traceDir, [
      llmCallRow("c1", 1, { messages: toolRoundTrips(1, 900) }),
    ]);

    for (const coordinate of [
      { from_char: 10 },
      { count: 50 },
      { from_char: 0, count: GET_RECORD_DEFAULT_COUNT },
    ]) {
      await assert.rejects(
        () => manifestOf(core, { record_id: "llm-1", ...coordinate }),
        (error: unknown) =>
          error instanceof TraceQueryValidationError &&
          error.kind === "validation" &&
          /requires part_index/.test(error.message),
        `${JSON.stringify(coordinate)} addresses nothing without part_index`
      );
    }
  });

  it("rejects message_index under detail=tool_results on both arms", async () => {
    // The projected result sequence is not message-indexed, so a caller that
    // passes it is aiming at something this axis cannot reach. Silently
    // ignoring it would answer a question nobody asked.
    const traceDir = makeTraceDir();
    const core = coreFor(traceDir, [
      llmCallRow("c1", 1, { messages: toolRoundTrips(2, 900) }),
    ]);

    await assert.rejects(
      () => manifestOf(core, { record_id: "llm-1", message_index: 1 }),
      (error: unknown) =>
        error instanceof TraceQueryValidationError &&
        error.field === "message_index"
    );
    await assert.rejects(
      () =>
        windowOf(core, {
          record_id: "llm-1",
          message_index: 1,
          part_index: 0,
        }),
      (error: unknown) =>
        error instanceof TraceQueryValidationError &&
        error.field === "message_index"
    );
  });

  it("requires message_index for the messages window arm instead of reading message 0", async () => {
    const traceDir = makeTraceDir();
    const core = coreFor(traceDir, [
      llmCallRow("c1", 1, {
        messages: [textMessage(0, 1, 900), textMessage(1, 1, 900)],
      }),
    ]);

    await assert.rejects(
      () =>
        windowOf(core, {
          record_id: "llm-1",
          detail: "messages",
          part_index: 0,
          count: 10,
        }),
      (error: unknown) =>
        error instanceof TraceQueryValidationError &&
        error.field === "message_index" &&
        /detail=messages/.test(error.message),
      "defaulting to 0 would hand back the first message for a call that named none"
    );
  });
});

describe("get_record core — the window arm", () => {
  it("returns exactly count characters and echoes every effective coordinate", async () => {
    const traceDir = makeTraceDir();
    const blocks = [textBlock(0, 1200), textBlock(1, 30)];
    const core = coreFor(traceDir, [
      llmCallRow("c1", 1, { messages: [{ role: "user", content: blocks }] }),
    ]);

    const window = await windowOf(core, {
      record_id: "llm-1",
      detail: "messages",
      message_index: 0,
      part_index: 1,
      from_char: 4,
      count: 10,
    });

    assert.deepEqual(Object.keys(window), [
      "record",
      "matched_on",
      "detail",
      "message_index",
      "part_index",
      "from_char",
      "count",
      "part_chars",
      "text",
    ]);
    assert.deepEqual(
      {
        detail: window.detail,
        message_index: window.message_index,
        part_index: window.part_index,
        from_char: window.from_char,
        count: window.count,
        part_chars: window.part_chars,
      },
      {
        detail: "messages",
        message_index: 0,
        part_index: 1,
        from_char: 4,
        count: 10,
        part_chars: partText(blocks[1]).length,
      }
    );
    assert.equal(window.text, partText(blocks[1]).slice(4, 14));
    assert.equal(window.text.length, 10);

    // The echo carries the **effective** value, so a caller can budget a page of
    // windows without remembering what it omitted.
    const defaulted = await windowOf(core, {
      record_id: "llm-1",
      detail: "messages",
      message_index: 0,
      part_index: 0,
    });
    assert.equal(defaulted.count, GET_RECORD_DEFAULT_COUNT);
    assert.equal(defaulted.from_char, 0);
    assert.equal(defaulted.text.length, GET_RECORD_DEFAULT_COUNT);
    assert.equal(defaulted.part_chars, partText(blocks[0]).length);
  });

  it("names which id axis the window was reached through", async () => {
    // The echo test above pins `matched_on` as a key; the manifest case pins its
    // value on the inventory arm only. A window arm that rebuilt its own envelope
    // and settled on "llm_call_id" would pass both, and would then misreport the
    // one fact the caller cannot recover from the record itself — all three ids
    // sit on it, and `RECORD_ID_KEYS` is an OR.
    const traceDir = makeTraceDir();
    const core = coreFor(traceDir, [
      llmCallRow("c1", 4, {
        session_id: "sess-4",
        messages: [{ role: "user", content: [textBlock(0, 100)] }],
      }),
    ]);

    for (const [recordId, matchedOn] of [
      ["llm-4", "llm_call_id"],
      ["turn-4", "turn_id"],
      ["sess-4", "session_id"],
    ] as const) {
      const window = await windowOf(core, {
        record_id: recordId,
        detail: "messages",
        message_index: 0,
        part_index: 0,
        count: 10,
      });
      assert.equal(window.matched_on, matchedOn, `asked by ${recordId}`);
      assert.equal(window.text, partText(textBlock(0, 100)).slice(0, 10));
    }
  });

  it("reads a tool result in full, past the 400-character preview cap", async () => {
    const traceDir = makeTraceDir();
    const core = coreFor(traceDir, [
      llmCallRow("c1", 1, { messages: toolRoundTrips(2, 900) }),
    ]);

    const window = await windowOf(core, {
      record_id: "llm-1",
      part_index: 1,
      count: 900,
    });

    assert.equal(window.text, "y".repeat(900));
    assert.equal(window.text.length, 900);
    assert.equal(window.part_chars, 900);
  });

  it("walks a part to its end in successive windows and rebuilds it exactly", async () => {
    // The property `count` was designed for: the windows tile the part, so the
    // concatenation of successive calls is the part itself — no gaps, no overlap,
    // and nothing beyond the last window to guess at.
    const traceDir = makeTraceDir();
    const block = textBlock(0, 1000);
    const full = partText(block);
    const core = coreFor(traceDir, [
      llmCallRow("c1", 1, { messages: [{ role: "user", content: [block] }] }),
    ]);

    let rebuilt = "";
    let fromChar = 0;
    for (let guard = 0; guard < 10; guard++) {
      const remaining = full.length - fromChar;
      const count = Math.min(400, remaining);
      const window = await windowOf(core, {
        record_id: "llm-1",
        detail: "messages",
        message_index: 0,
        part_index: 0,
        from_char: fromChar,
        count,
      });
      assert.equal(window.text.length, count);
      rebuilt += window.text;
      fromChar += count;
      if (fromChar >= full.length) break;
    }

    assert.equal(fromChar, full.length);
    assert.equal(rebuilt, full);
  });

  it("rejects a window that crosses the part end, with the budget and zero part bytes", async () => {
    const traceDir = makeTraceDir();
    const block = textBlock(0, 900);
    const partChars = partText(block).length;
    const core = coreFor(traceDir, [
      llmCallRow("c1", 1, { messages: [{ role: "user", content: [block] }] }),
    ]);

    // from_char + count === part_chars is the last legal window, so the first
    // illegal one is exactly one character past it.
    const last = await windowOf(core, {
      record_id: "llm-1",
      detail: "messages",
      message_index: 0,
      part_index: 0,
      from_char: 0,
      count: partChars,
    });
    assert.equal(last.text.length, partChars);

    await assert.rejects(
      () =>
        windowOf(core, {
          record_id: "llm-1",
          detail: "messages",
          message_index: 0,
          part_index: 0,
          from_char: partChars - 1,
          count: 3,
        }),
      (error: unknown) => {
        assert.ok(
          error instanceof TraceWindowOverflowError,
          `expected a window_overflow, got ${String(error)}`
        );
        assert.equal(error.kind, "window_overflow");
        assert.equal(error.partChars, partChars);
        assert.equal(error.remaining, 1);
        // 「不回传任何 part 字节」 ("return no part bytes"): the natural wrong
        // answer is "you asked for 3
        // past the end, here are the 1 that fit". assert.rejects already proves no
        // text was returned; this proves the message does not smuggle any either.
        assert.ok(
          !error.message.includes("zzz"),
          `part content leaked into the error: ${error.message}`
        );
        assert.equal(
          error.message,
          `window of 3 characters at from_char=${partChars - 1} exceeds the part: part_chars=${partChars}, remaining=1`
        );
        return true;
      }
    );
  });

  it("keeps every surface of the overflow error free of part bytes", async () => {
    // 「不回传任何 part 字节」 ("return no part bytes") as a property, not a
    // substring spot-check. The case
    // above pins `message` exactly, which covers the message; it cannot see a
    // field added to the error later (a `text` holding "the part that fitted",
    // say), and such a field would ride out through whichever thin face
    // serializes the error. So: the error's own enumerable keys stay the closed
    // documented set, and no surface reachable from the error carries any run of
    // the part. Head / middle / tail are three different sentinels, because a
    // leak of the fitted prefix and a leak of the requested tail are different
    // bugs and a uniform fixture would only catch one of them.
    const traceDir = makeTraceDir();
    const head = "HEADSENTINEL";
    const middle = "MIDDLESENTINEL";
    const tail = "TAILSENTINEL";
    const partChars = 2_600;
    const part =
      head +
      "-".repeat(partChars - head.length - middle.length - tail.length) +
      middle +
      tail;
    const core = coreFor(traceDir, [
      llmCallRow("c1", 1, {
        messages: [
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu-0",
                content: part,
              },
            ],
          },
        ],
      }),
    ]);

    await assert.rejects(
      () =>
        windowOf(core, {
          record_id: "llm-1",
          part_index: 0,
          from_char: partChars - 1,
          count: 5,
        }),
      (error: unknown) => {
        assert.ok(
          error instanceof TraceWindowOverflowError,
          `expected a window_overflow, got ${String(error)}`
        );
        assert.deepEqual(Object.keys(error).sort(), [
          "count",
          "fromChar",
          "kind",
          "name",
          "partChars",
          "remaining",
        ]);
        for (const [label, surface] of [
          ["message", error.message],
          ["String(error)", String(error)],
          ["JSON.stringify(error)", JSON.stringify(error)],
          ["stack", error.stack ?? ""],
        ] as const) {
          for (const sentinel of [head, middle, tail]) {
            assert.ok(
              !surface.includes(sentinel),
              `part content leaked into ${label}: ${surface.slice(0, 200)}`
            );
          }
        }
        return true;
      }
    );
  });

  it("reports remaining=0 for a window that starts at the part end", async () => {
    const traceDir = makeTraceDir();
    const block = textBlock(0, 50);
    const partChars = partText(block).length;
    const core = coreFor(traceDir, [
      llmCallRow("c1", 1, { messages: [{ role: "user", content: [block] }] }),
    ]);

    await assert.rejects(
      () =>
        windowOf(core, {
          record_id: "llm-1",
          detail: "messages",
          message_index: 0,
          part_index: 0,
          from_char: partChars,
          count: 1,
        }),
      (error: unknown) =>
        error instanceof TraceWindowOverflowError &&
        error.remaining === 0 &&
        error.partChars === partChars
    );
  });

  it("names the real number of addressable items for an out-of-range index", async () => {
    const messageCore = coreFor(makeTraceDir(), [
      llmCallRow("c1", 1, {
        messages: [textMessage(0, 3, 500), textMessage(1, 1, 40)],
      }),
    ]);
    const windowInput = {
      record_id: "llm-1",
      detail: "messages",
      part_index: 0,
      count: 10,
    };

    await assert.rejects(
      () => windowOf(messageCore, { ...windowInput, message_index: 4 }),
      (error: unknown) =>
        error instanceof TraceQueryValidationError &&
        error.field === "message_index" &&
        error.message ===
          "message_index 4 is out of range: this record has 2 messages",
      "an out-of-range index must report the addressable count, not just refuse"
    );
    await assert.rejects(
      () =>
        windowOf(messageCore, {
          ...windowInput,
          message_index: 0,
          part_index: 5,
        }),
      (error: unknown) =>
        error instanceof TraceQueryValidationError &&
        error.field === "part_index" &&
        error.message ===
          "part_index 5 is out of range: message 0 has 3 content blocks"
    );

    const resultCore = coreFor(makeTraceDir(), [
      llmCallRow("c1", 1, { messages: toolRoundTrips(2, 900) }),
    ]);
    await assert.rejects(
      () => windowOf(resultCore, { record_id: "llm-1", part_index: 7 }),
      (error: unknown) =>
        error instanceof TraceQueryValidationError &&
        error.field === "part_index" &&
        error.message ===
          "part_index 7 is out of range: this record has 2 tool results"
    );
  });

  it("answers an empty inventory and a named-count rejection for a record with no messages", async () => {
    const traceDir = makeTraceDir();
    const core = coreFor(traceDir, [
      llmCallRow("c1", 1, { messages_captured: false }),
    ]);

    const manifest = await manifestOf(core, {
      record_id: "llm-1",
      detail: "messages",
    });
    assert.deepEqual(manifest.parts, []);

    await assert.rejects(
      () =>
        windowOf(core, {
          record_id: "llm-1",
          detail: "messages",
          message_index: 0,
          part_index: 0,
        }),
      (error: unknown) =>
        error instanceof TraceQueryValidationError &&
        error.message ===
          "message_index 0 is out of range: this record has 0 messages",
      "the empty case must report 0, not invent a 6th error kind (SC20)"
    );
  });

  it("treats a message whose content is a plain string as one addressable part", async () => {
    const traceDir = makeTraceDir();
    const core = coreFor(traceDir, [
      llmCallRow("c1", 1, { messages: [{ role: "user", content: "hello" }] }),
    ]);

    const manifest = await manifestOf(core, {
      record_id: "llm-1",
      detail: "messages",
    });
    assert.deepEqual(manifest.parts, [
      { message_index: 0, part_index: 0, chars: 5, role: "user" },
    ]);

    const window = await windowOf(core, {
      record_id: "llm-1",
      detail: "messages",
      message_index: 0,
      part_index: 0,
      count: 5,
    });
    assert.equal(window.text, "hello");
  });
});

describe("get_record core — units and bounds", () => {
  it("counts UTF-16 code units, so a window may split a surrogate pair", async () => {
    // The unit ruling, pinned as a consequence rather than a restatement:
    // `chars` is `.length`, the window is `.slice`, and the only observable
    // outcome of cutting between the halves of a pair is a lone surrogate that
    // JSON.stringify then escapes. A byte-counted axis could not produce this.
    const traceDir = makeTraceDir();
    const text = "a\u{1D19E}b";
    assert.equal(text.length, 4);
    const core = coreFor(traceDir, [
      llmCallRow("c1", 1, {
        messages: [{ role: "user", content: [{ type: "text", text }] }],
      }),
    ]);

    const half = await windowOf(core, {
      record_id: "llm-1",
      detail: "messages",
      message_index: 0,
      part_index: 0,
      from_char: 0,
      count: 2,
    });
    assert.equal(half.count, 2);
    assert.equal(half.text.length, 2);
    assert.equal(half.text, partText({ type: "text", text }).slice(0, 2));

    // Now the message's own text, where the pair sits at code unit 1: a count of
    // 1 starting there returns the high surrogate alone.
    const stringCore = coreFor(traceDir, [
      llmCallRow("c1", 1, { messages: [{ role: "user", content: text }] }),
    ]);
    const split = await windowOf(stringCore, {
      record_id: "llm-1",
      detail: "messages",
      message_index: 0,
      part_index: 0,
      from_char: 1,
      count: 1,
    });
    assert.equal(split.text, "\ud834");
    assert.ok(
      JSON.stringify(split).includes("\\ud834"),
      "a lone surrogate must survive serialization as an escape, not as a replacement character"
    );
  });

  it("enforces the declared count and coordinate bounds", async () => {
    const traceDir = makeTraceDir();
    const core = coreFor(traceDir, [
      llmCallRow("c1", 1, { messages: toolRoundTrips(1, 900) }),
    ]);

    for (const count of [
      0,
      -1,
      GET_RECORD_MAX_COUNT + 1,
      1.5,
      Number.NaN,
      "400",
    ]) {
      await assert.rejects(
        () =>
          windowOf(core, {
            record_id: "llm-1",
            part_index: 0,
            count,
          }),
        (error: unknown) =>
          error instanceof TraceQueryValidationError &&
          error.field === "count" &&
          error.message ===
            `count must be an integer in 1..${GET_RECORD_MAX_COUNT}`,
        `count ${String(count)} must be rejected`
      );
    }
    for (const fromChar of [-1, 0.5, "0"]) {
      await assert.rejects(
        () =>
          windowOf(core, {
            record_id: "llm-1",
            part_index: 0,
            from_char: fromChar,
          }),
        (error: unknown) =>
          error instanceof TraceQueryValidationError &&
          error.field === "from_char" &&
          error.message ===
            `from_char must be an integer in 0..${Number.MAX_SAFE_INTEGER}`,
        `from_char ${String(fromChar)} must be rejected`
      );
    }
    for (const partIndex of [-1, 0.5]) {
      await assert.rejects(
        () =>
          windowOf(core, {
            record_id: "llm-1",
            part_index: partIndex,
          }),
        (error: unknown) =>
          error instanceof TraceQueryValidationError &&
          error.field === "part_index",
        `part_index ${String(partIndex)} must be rejected`
      );
    }
    // Both declared edges stay legal, so a face that moves a bound cannot pass
    // unnoticed against this core.
    assert.equal(
      (await windowOf(core, { record_id: "llm-1", part_index: 0, count: 1 }))
        .count,
      1
    );
    assert.equal(
      (
        await manifestOf(core, {
          record_id: "llm-1",
          detail: "messages",
          message_index: undefined,
        })
      ).detail,
      "messages"
    );
  });

  it("exposes 400 as the default window and 16000 as the ceiling", () => {
    // Sizes come from the measured part distribution (message p50=393, part
    // p99=13,848, part max=43,174): the default fits a median message, the
    // ceiling fits a p99 part in one window. Neither number is a promise about
    // response size — `count` budgets body characters, and the case below is
    // what measures what still holds at the top edge.
    assert.equal(GET_RECORD_DEFAULT_COUNT, 400);
    assert.equal(GET_RECORD_MAX_COUNT, 16_000);
  });

  it("answers the maximal legal window with exactly that many characters and `text` last", async () => {
    // Two claims the ceiling rests on that no case above measured.
    //
    //   1. Exactly `count`. The bound test only proves 16 000 is *accepted*; a core
    //      that quietly handed back less would still echo `count: 16000`, and the
    //      caller — which derives its next `from_char` from `count`, not from the
    //      text it received — would skip characters off the front of that window.
    //   2. `text` is the **last** key, so when a response does overshoot
    //      `TRACE_OUTPUT_BACKSTOP` the face's tail-cut eats body characters and
    //      leaves the echoed coordinates standing (a caller can then re-issue with
    //      a smaller `count` without re-addressing).
    //
    // The ceiling is deliberately **not** derived from the backstop: it follows
    // the part distribution (p99 = 13,848, max = 43,174 characters), and
    // `src/traceserver/get-record-core.ts` says outright that `count` budgets body
    // characters, not response size — JSON escaping alone can push a maximal
    // response past 20 000, which the case in the output-shape block measures. The
    // part here is longer than the ceiling, so this is the last legal window, not
    // an overflow.
    const traceDir = makeTraceDir();
    const partChars = GET_RECORD_MAX_COUNT + 1_000;
    const core = coreFor(traceDir, [
      llmCallRow("c1", 1, { messages: toolRoundTrips(1, partChars) }),
    ]);

    const serialized = await core({
      conversation_id: "c1",
      record_id: "llm-1",
      part_index: 0,
      count: GET_RECORD_MAX_COUNT,
    });
    const window = JSON.parse(serialized) as Window;

    assert.equal(window.text.length, GET_RECORD_MAX_COUNT);
    assert.equal(window.count, GET_RECORD_MAX_COUNT);
    assert.equal(window.from_char, 0);
    assert.equal(window.part_chars, partChars);
    assert.equal(window.text, "y".repeat(GET_RECORD_MAX_COUNT));
    assert.equal(
      Object.keys(window).at(-1),
      "text",
      `the response ends with ${String(Object.keys(window).at(-1))}, so a face's tail-cut would eat the coordinates instead of the body`
    );
  });
});

describe("get_record core — blobs, output shape, and description", () => {
  it("dereferences blob messages before addressing their parts", async () => {
    // ADR-0036: the dereference happens before projection, so a blob-stored
    // message is read by the same coordinates as an inline one. Without it the
    // parts would be `{sha, bytes}` references.
    const traceDir = makeTraceDir();
    const stored = { role: "user", content: [{ type: "text", text: "b0" }] };
    const sha = "a".repeat(64);
    writeBlobFile(traceDir, "c1", sha, stored);
    const core = coreFor(traceDir, [
      llmCallRow("c1", 1, { messages: [{ sha, bytes: 10 }] }),
    ]);

    const manifest = await manifestOf(core, {
      record_id: "llm-1",
      detail: "messages",
    });
    assert.deepEqual(manifest.parts, [
      {
        message_index: 0,
        part_index: 0,
        chars: partText(stored.content[0]).length,
        // In blob mode the dereferenced role must appear on the inventory part.
        role: stored.role,
      },
    ]);

    const window = await windowOf(core, {
      record_id: "llm-1",
      detail: "messages",
      message_index: 0,
      part_index: 0,
      count: partText(stored.content[0]).length,
    });
    assert.equal(window.text, partText(stored.content[0]));
  });

  it("degrades a missing blob to no addressable parts instead of throwing", async () => {
    // The `// EXIT:` path in dereferenceTraceMessages stays (Assumption 5): a
    // corrupt blob must not turn a read into a crash. What it must still do is
    // report honestly — an empty inventory and a rejection that names 0 messages.
    const traceDir = makeTraceDir();
    const core = coreFor(traceDir, [
      llmCallRow("c1", 1, { messages: [{ sha: "b".repeat(64), bytes: 10 }] }),
    ]);

    const manifest = await manifestOf(core, {
      record_id: "llm-1",
      detail: "messages",
    });
    assert.deepEqual(manifest.parts, []);
    await assert.rejects(
      () =>
        windowOf(core, {
          record_id: "llm-1",
          detail: "messages",
          message_index: 0,
          part_index: 0,
        }),
      (error: unknown) => error instanceof TraceQueryValidationError
    );
  });

  it("carries no truncation metadata on either arm (契约 X)", async () => {
    const traceDir = makeTraceDir();
    // 17,000 characters, so the maximal legal window below is inside the part
    // rather than an overflow.
    const core = coreFor(traceDir, [
      llmCallRow("c1", 1, { messages: toolRoundTrips(1, 17_000) }),
    ]);

    const windowText = await core({
      conversation_id: "c1",
      record_id: "llm-1",
      part_index: 0,
      count: 500,
    });
    const manifestText = await core({
      conversation_id: "c1",
      record_id: "llm-1",
    });

    for (const text of [windowText, manifestText]) {
      for (const banned of ["truncated", "response_truncated", '"total"']) {
        assert.ok(
          !text.includes(banned),
          `"${banned}" leaked into the response`
        );
      }
    }
    // The executor is the only truncation authority on this face, and this axis
    // never reaches it on its own account. `worstCase` staying under the backstop
    // here is a property of **this** fixture: the result text is one uniform
    // character, so `JSON.stringify` does not inflate it. The general rule is the
    // opposite — `count` budgets body characters, not response size — and the case
    // below measures the overshoot that inflation produces.
    const worstCase = await core({
      conversation_id: "c1",
      record_id: "llm-1",
      part_index: 0,
      count: GET_RECORD_MAX_COUNT,
    });
    assert.ok(
      worstCase.length < TRACE_OUTPUT_BACKSTOP,
      `the worst-case response is ${worstCase.length} characters, past the ${TRACE_OUTPUT_BACKSTOP} the faces cut at`
    );
  });

  it("lets the face's cut eat the body when escaping pushes a maximal window past the backstop", async () => {
    // `src/traceserver/get-record-core.ts` states the rule and refuses to promise
    // the opposite: a maximal window's response can exceed `TRACE_OUTPUT_BACKSTOP`
    // because `JSON.stringify` inflates escape-worthy characters, and the core
    // trims nothing either way (that would be ADR-0006:29's double truncation).
    // 16 000 newlines is the minimal reproduction: 2 serialized characters each.
    //
    // What the key order buys is measured here. The cut output is no longer
    // parseable JSON, so the caller reads it as text — and because `text` is the
    // last key, the echoed coordinates are still standing in front of the marker,
    // which is exactly what a caller needs to re-issue the same address with a
    // smaller `count`.
    const traceDir = makeTraceDir();
    const core = coreFor(traceDir, [
      llmCallRow("c1", 1, {
        messages: [
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu-0",
                content: "\n".repeat(GET_RECORD_MAX_COUNT),
              },
            ],
          },
        ],
      }),
    ]);

    const serialized = await core({
      conversation_id: "c1",
      record_id: "llm-1",
      part_index: 0,
      count: GET_RECORD_MAX_COUNT,
    });

    // 1. The core returned the whole window: no silent trim below the face.
    assert.equal(
      (JSON.parse(serialized) as Window).text.length,
      GET_RECORD_MAX_COUNT
    );
    // 2. The response really does cross the backstop, so the arm below is not a
    //    claim about a case this axis cannot produce.
    assert.ok(
      serialized.length > TRACE_OUTPUT_BACKSTOP,
      `expected this fixture to overshoot the backstop, got ${serialized.length} characters`
    );
    // 3. The face's tail-cut eats the body and keeps the coordinates.
    const cut = applyTraceOutputBackstop(serialized);
    assert.equal(cut.length, TRACE_OUTPUT_BACKSTOP);
    assert.ok(cut.endsWith(TRACE_BACKSTOP_MARKER));
    for (const echo of [
      `"from_char":0`,
      `"count":${GET_RECORD_MAX_COUNT}`,
      `"part_chars":${GET_RECORD_MAX_COUNT}`,
    ]) {
      assert.ok(
        cut.includes(echo),
        `the cut dropped ${echo}; remaining: ${cut.slice(-120)}`
      );
    }
  });

  it("answers two different windows of the same record concurrently", async () => {
    // The table's concurrent cell for this axis: no cursor, no shared state —
    // two windows are two independent reads of the same file.
    const traceDir = makeTraceDir();
    const core = coreFor(traceDir, [
      llmCallRow("c1", 1, { messages: toolRoundTrips(1, 1200) }),
    ]);

    const [head, tail] = await Promise.all([
      core({
        conversation_id: "c1",
        record_id: "llm-1",
        part_index: 0,
        count: 600,
      }),
      core({
        conversation_id: "c1",
        record_id: "llm-1",
        part_index: 0,
        from_char: 600,
        count: 600,
      }),
    ]);

    assert.equal(JSON.parse(head).text, "y".repeat(600));
    assert.equal(JSON.parse(tail).from_char, 600);
    assert.equal(JSON.parse(tail).text, "y".repeat(600));
    assert.notEqual(head, tail);
  });

  it("describes both arms, the discovery step, and the paging rule — and no character cap", () => {
    assert.match(GET_RECORD_DESCRIPTION, /get_record/);
    assert.match(GET_RECORD_DESCRIPTION, /part_index/);
    assert.match(GET_RECORD_DESCRIPTION, /message_index/);
    assert.match(GET_RECORD_DESCRIPTION, /from_char/);
    assert.match(GET_RECORD_DESCRIPTION, /count/);
    assert.match(GET_RECORD_DESCRIPTION, /part_chars|chars/);
    // The two things a caller must be told without reading source: how to learn
    // a part's size, and how to continue a part it has only partly read.
    assert.match(GET_RECORD_DESCRIPTION, /omit part_index/);
    assert.match(GET_RECORD_DESCRIPTION, /raise from_char/);
    // Both id axes are named, since this tool is unreachable without them.
    assert.match(GET_RECORD_DESCRIPTION, /list_sessions/);
    assert.match(GET_RECORD_DESCRIPTION, /query_trace/);
    // SC7: no description on either face may claim a character cap. Phrase-level
    // on purpose — a window's `count` bound is a read unit, not an output budget,
    // so only the `[0-9] characters` shape would be a cap claim.
    assert.ok(
      !/capped|[0-9]+ ?characters/i.test(GET_RECORD_DESCRIPTION),
      "the description claims a character cap"
    );
    // Positive-trigger phrasing, no blocklist imperative. The substring
    // form matters — "whenever" contains "never".
    assert.ok(
      !/do not|don't|avoid|should not|shouldn't|never|trivial/i.test(
        GET_RECORD_DESCRIPTION
      ),
      "the description carries a negative phrase"
    );
    assert.match(
      GET_RECORD_DESCRIPTION,
      /\b(use|pair|read|return|discover)\b/i
    );
  });
});

describe("get_record core — shared scan with the row axis", () => {
  it("raises record_scan rather than record_not_found once the scan cap is exhausted", async () => {
    // The two "not found" answers are different claims: one says the file holds
    // no such id, the other says the scan stopped early. get_record reads through
    // the same single implementation query_trace uses, so the cap and
    // the message are shared, not re-derived here.
    const traceDir = makeTraceDir();
    const rows: Record<string, unknown>[] = [];
    for (let i = 0; i < 2; i++) {
      rows.push(llmCallRow("c1", i, { messages: [] }));
    }
    const core = coreFor(traceDir, rows);

    // Small fixture: below the cap, so this axis answers record_not_found. The
    // over-cap arm is pinned in query-trace-core-record-scan.test.ts against the
    // same lookup, which keeps the 10,001-row cost to one run.
    await assert.rejects(
      () => core({ conversation_id: "c1", record_id: "nope" }),
      (error: unknown) =>
        error instanceof TraceRecordNotFoundError &&
        !(error instanceof TraceQueryRecordScanError)
    );
  });
});
describe("get_record core — role projection (v1.2)", () => {
  // Role-projection contract, criterion (a): detail=messages manifest parts carry
  // their message's role; detail=tool_results parts do not (tool_result is by
  // definition on the user side); window responses do not either (a window is
  // already addressed via message_index, and role comes from the manifest arm).
  // ADR-0003: LLM call messages[].role ranges over user / assistant / tool / system.
  it("carries role on every detail=messages manifest part (v1.2 判据 a)", async () => {
    const traceDir = makeTraceDir();
    // Two distinct roles in two messages, plus an intra-message block. The
    // manifest must walk through them and stamp each part with its message's
    // role, not collapse them.
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "u1a" },
          { type: "text", text: "u1b" },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "a0" }],
      },
      {
        role: "user",
        content: [{ type: "text", text: "u2" }],
      },
    ];
    const core = coreFor(traceDir, [llmCallRow("c1", 1, { messages })]);

    const manifest = await manifestOf(core, {
      record_id: "llm-1",
      detail: "messages",
    });

    assert.deepEqual(
      manifest.parts.map((p) => ({
        message_index: p["message_index"],
        part_index: p["part_index"],
        role: p["role"],
      })),
      [
        { message_index: 0, part_index: 0, role: "user" },
        { message_index: 0, part_index: 1, role: "user" },
        { message_index: 1, part_index: 0, role: "assistant" },
        { message_index: 2, part_index: 0, role: "user" },
      ]
    );
  });

  it("omits role on detail=tool_results manifest parts (tool_result 按定义在 user 侧)", async () => {
    const traceDir = makeTraceDir();
    const core = coreFor(traceDir, [
      llmCallRow("c1", 1, { messages: toolRoundTrips(2, 40) }),
    ]);

    const manifest = await manifestOf(core, { record_id: "llm-1" });
    assert.equal(manifest.detail, "tool_results");

    for (const part of manifest.parts) {
      assert.ok(
        !("role" in part),
        `tool_results part must not carry role, got: ${JSON.stringify(part)}`
      );
    }
  });

  it("dereferences blob messages and still exposes role on the manifest parts", async () => {
    // ADR-0036: blob dereferencing must happen before projection, so the
    // dereferenced user role still shows on the manifest part. The role field on
    // message_index=0/part_index=0 is that dereferenced role; a missing field
    // would mean the blob path dropped it.
    const traceDir = makeTraceDir();
    const stored = {
      role: "user",
      content: [{ type: "text", text: "from-blob" }],
    };
    const sha = "a".repeat(64);
    writeBlobFile(traceDir, "c1", sha, stored);
    const core = coreFor(traceDir, [
      llmCallRow("c1", 1, { messages: [{ sha, bytes: 10 }] }),
    ]);

    const manifest = await manifestOf(core, {
      record_id: "llm-1",
      detail: "messages",
    });
    assert.equal(manifest.parts.length, 1);
    assert.equal(manifest.parts[0]["role"], "user");
    assert.equal(manifest.parts[0]["message_index"], 0);
    assert.equal(manifest.parts[0]["part_index"], 0);
  });

  it("window arm response carries no role key (四禁: 窗正文寻址已有 message_index)", async () => {
    // Windows stay role-free: role comes from the manifest arm, a window answers
    // only the window's facts. Pinning "not introduced" so nobody adds it casually.
    const traceDir = makeTraceDir();
    const core = coreFor(traceDir, [
      llmCallRow("c1", 1, {
        messages: [textMessage(0, 2, 100)],
      }),
    ]);

    const window = await windowOf(core, {
      record_id: "llm-1",
      detail: "messages",
      message_index: 0,
      part_index: 0,
      count: 10,
    });
    assert.ok(
      !("role" in window),
      `window response must not carry role, got: ${JSON.stringify(window)}`
    );
  });
});

describe("get_record core — ADR-0116 detail=system / detail=tools", () => {
  const SYSTEM_BODY =
    "You are iknow. Use the symbol tools — do not start with grep. " +
    "proactively offer subagents when the ask warrants one.";
  const SYSTEM_SHA = createHash("sha256")
    .update(JSON.stringify({ kind: "str", v: SYSTEM_BODY }), "utf8")
    .digest("hex");

  function systemRow(traceDir: string): GetRecordCoreHandler {
    const core = coreFor(traceDir, [
      llmCallRow("c1", 1, {
        messages: [],
        system: { sha: SYSTEM_SHA, bytes: Buffer.byteLength(SYSTEM_BODY) },
        tool_names: ["read_file", "get_record"],
      }),
    ]);
    writeBlobFile(traceDir, "c1", SYSTEM_SHA, { kind: "str", v: SYSTEM_BODY });
    return core;
  }

  it("detail=system manifest: 单一 part, chars=正文长度, 无 role", async () => {
    const core = systemRow(makeTraceDir());
    const manifest = await manifestOf(core, {
      record_id: "llm-1",
      detail: "system",
    });
    assert.equal(manifest.detail, "system");
    assert.equal(manifest.parts.length, 1);
    assert.deepEqual(manifest.parts[0], {
      part_index: 0,
      chars: SYSTEM_BODY.length,
    });
  });

  it("detail=system window: 走 part-window 机制读出 blob 正文", async () => {
    const core = systemRow(makeTraceDir());
    const window = await windowOf(core, {
      record_id: "llm-1",
      detail: "system",
      part_index: 0,
      from_char: 13,
      count: 40,
    });
    assert.equal(window.detail, "system");
    assert.equal(window.part_chars, SYSTEM_BODY.length);
    assert.equal(window.text, SYSTEM_BODY.slice(13, 53));
  });

  it("detail=system: 行无 system 键 → 空清单; blob 缺失/形状错 → 同样空清单, 不抛", async () => {
    const absentCore = coreFor(makeTraceDir(), [
      llmCallRow("c1", 1, { messages: [] }),
    ]);
    const absent = await manifestOf(absentCore, {
      record_id: "llm-1",
      detail: "system",
    });
    assert.deepEqual(absent.parts, []);

    const missingBlobDir = makeTraceDir();
    const missingCore = coreFor(missingBlobDir, [
      llmCallRow("c1", 1, {
        messages: [],
        system: { sha: SYSTEM_SHA, bytes: 1 },
      }),
    ]);
    const missing = await manifestOf(missingCore, {
      record_id: "llm-1",
      detail: "system",
    });
    assert.deepEqual(missing.parts, []);

    const wrongShapeDir = makeTraceDir();
    const wrongCore = coreFor(wrongShapeDir, [
      llmCallRow("c1", 1, {
        messages: [],
        system: { sha: SYSTEM_SHA, bytes: 1 },
      }),
    ]);
    writeBlobFile(wrongShapeDir, "c1", SYSTEM_SHA, { kind: "blocks", v: [] });
    const wrong = await manifestOf(wrongCore, {
      record_id: "llm-1",
      detail: "system",
    });
    assert.deepEqual(wrong.parts, []);
  });

  it("detail=tools manifest: 每个名字一个 part, identity 携带 name", async () => {
    const core = systemRow(makeTraceDir());
    const manifest = await manifestOf(core, {
      record_id: "llm-1",
      detail: "tools",
    });
    assert.equal(manifest.detail, "tools");
    assert.deepEqual(manifest.parts, [
      { part_index: 0, chars: "read_file".length, name: "read_file" },
      { part_index: 1, chars: "get_record".length, name: "get_record" },
    ]);
  });

  it("detail=tools window: part_index 1 读出 'get_record'", async () => {
    const core = systemRow(makeTraceDir());
    const window = await windowOf(core, {
      record_id: "llm-1",
      detail: "tools",
      part_index: 1,
      count: "get_record".length,
    });
    assert.equal(window.text, "get_record");
    assert.equal(window.part_chars, "get_record".length);
  });

  it("detail=tools: 无 tool_names 键 → 空清单 (Postel 缺席对称)", async () => {
    const core = coreFor(makeTraceDir(), [llmCallRow("c1", 1, { messages: [] })]);
    const manifest = await manifestOf(core, {
      record_id: "llm-1",
      detail: "tools",
    });
    assert.deepEqual(manifest.parts, []);
  });

  it("新 arms 拒绝 message_index, 报错点名各自寻址词汇", async () => {
    const core = systemRow(makeTraceDir());
    for (const [detail, phrase] of [
      ["system", "the record's system body"],
      ["tools", "the record's tool name list"],
    ] as const) {
      await assert.rejects(
        () =>
          manifestOf(core, { record_id: "llm-1", detail, message_index: 0 }),
        (error: unknown) =>
          error instanceof TraceQueryValidationError &&
          error.field === "message_index" &&
          error.message.includes(phrase) &&
          error.message.includes("not message-indexed"),
        `detail=${detail} must reject message_index`
      );
    }
  });

  it("新 arms 的 part_index 越界报真实数量", async () => {
    const core = systemRow(makeTraceDir());
    await assert.rejects(
      () => windowOf(core, { record_id: "llm-1", detail: "system", part_index: 1 }),
      (error: unknown) =>
        error instanceof TraceQueryValidationError &&
        error.field === "part_index" &&
        error.message ===
          "part_index 1 is out of range: this record has 1 system body parts",
      "detail=system part_index 1 must be out of range"
    );
    await assert.rejects(
      () => windowOf(core, { record_id: "llm-1", detail: "tools", part_index: 2 }),
      (error: unknown) =>
        error instanceof TraceQueryValidationError &&
        error.field === "part_index" &&
        error.message ===
          "part_index 2 is out of range: this record has 2 tool names",
      "detail=tools part_index 2 must be out of range"
    );
  });
});
