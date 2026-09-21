import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

import { createTraceMcpServer } from "../../src/trace-mcp/server.js";
import { createGetRecordTool } from "../../src/harness/aci/tools/get-record.js";
import { createListSessionsTool } from "../../src/harness/aci/tools/list-sessions.js";
import { createQueryTraceTool } from "../../src/harness/aci/tools/query-trace.js";
import { GET_RECORD_MAX_COUNT } from "../../src/traceserver/get-record-core.js";
import { LIST_SESSIONS_MAX_LIMIT } from "../../src/traceserver/list-sessions-core.js";
import { QUERY_TRACE_MAX_LIMIT } from "../../src/traceserver/query-trace-core.js";
import {
  TRACE_BACKSTOP_MARKER,
  TRACE_OUTPUT_BACKSTOP,
} from "../../src/traceserver/output-backstop.js";
import { createTraceFixture, type TraceFixture } from "./fixtures.js";

/** Either face's JSON Schema, narrowed to what SC18 compares. */
type FaceSchema = {
  properties: Record<
    string,
    { type?: string; minimum?: number; maximum?: number }
  >;
  required?: string[];
  additionalProperties?: unknown;
};

const fixtures: TraceFixture[] = [];
const scratchPaths: string[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
  for (const path of scratchPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

async function connectFixture(traceDir?: string): Promise<{
  readonly client: Client;
  readonly close: () => Promise<void>;
  readonly fixture: TraceFixture;
}> {
  const fixture = createTraceFixture();
  fixtures.push(fixture);
  const server = createTraceMcpServer({
    traceDir: traceDir ?? fixture.traceDir,
  });
  const client = new Client({
    name: "trace-mcp-test-client",
    version: "1.0.0",
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  return {
    client,
    fixture,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

/**
 * One record padded with just an extra scalar `pad` (no messages, so the row-axis
 * preview contains no other truncation marks). "A single record past the 4000 line
 * reads back verbatim" is certified by exactly this.
 */
const PADDED_CONVERSATION = "padded-conversation";

function writePaddedTraceDir(pad: number): string {
  const traceDir = mkdtempSync(join(tmpdir(), "iknow-trace-mcp-pad-"));
  scratchPaths.push(traceDir);
  // Sessions land in the two-level tree `<traceDir>/projects/<slug>/<convId>/trace.jsonl`.
  const convDir = join(
    traceDir,
    "projects",
    "test-project-trace-mcp",
    PADDED_CONVERSATION
  );
  mkdirSync(convDir, { recursive: true });
  writeFileSync(
    join(convDir, "trace.jsonl"),
    JSON.stringify({
      conversation_id: PADDED_CONVERSATION,
      record_type: "llm_call",
      llm_call_id: "llm-padded",
      status: "ok",
      messages: [],
      pad: "a".repeat(pad),
    }) + "\n",
    "utf8"
  );
  return traceDir;
}

/** Row axis: the whole page as text. */
async function callPaddedQueryTrace(client: Client): Promise<string> {
  const result = await client.callTool({
    name: "query_trace",
    arguments: { conversation_id: PADDED_CONVERSATION },
  });
  return firstText(result);
}

const WINDOW_CONVERSATION = "window-conversation";
const WINDOW_RECORD_ID = "llm-window";
/** Length of the window body. It stays constant across the three probes; only the `count` reading it changes. */
const WINDOW_PART_CHARS = 16_001;
/**
 * Record scalar padded to near the backstop. 9 700 + the calibration `count: 10_000`
 * keep the calibration probe itself **off** the cap (hitting it would measure the cut
 * length), while leaving the target `count` (≈10 050) within `GET_RECORD_MAX_COUNT`.
 */
const WINDOW_SCALAR_PAD = 9_700;

/** A record with a fixed-width scalar and one 16 001-char tool_result part. */
function writeWindowTraceDir(scalarPad: number): string {
  const traceDir = mkdtempSync(join(tmpdir(), "iknow-trace-mcp-window-"));
  scratchPaths.push(traceDir);
  const convDir = join(
    traceDir,
    "projects",
    "test-project-trace-mcp",
    WINDOW_CONVERSATION
  );
  mkdirSync(convDir, { recursive: true });
  writeFileSync(
    join(convDir, "trace.jsonl"),
    JSON.stringify({
      conversation_id: WINDOW_CONVERSATION,
      record_type: "llm_call",
      llm_call_id: WINDOW_RECORD_ID,
      status: "ok",
      pad: "y".repeat(scalarPad),
      messages: [
        { role: "user", content: "hi" },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu-window",
              content: "z".repeat(WINDOW_PART_CHARS),
            },
          ],
        },
      ],
    }) + "\n",
    "utf8"
  );
  return traceDir;
}

/** Content axis: read a `count`-character window, return the text the face hands back. */
async function callWindow(client: Client, count: number): Promise<string> {
  const result = await client.callTool({
    name: "get_record",
    arguments: {
      conversation_id: WINDOW_CONVERSATION,
      record_id: WINDOW_RECORD_ID,
      part_index: 0,
      from_char: 0,
      count,
    },
  });
  return firstText(result);
}

/**
 * The slope-1 knob: `text` is the **last key** of the response, so `count` + 1 =
 * uncut text + 1 — the scalar `pad`, `part_chars`, and echoed `from_char`/`part_index`
 * stay constant, and the body has no characters that JSON.stringify would escape-open.
 * The one exception is a decimal carry (`count` crossing 9 999 → 10 000 adds a free
 * character to length), so the line holds only **within one digit count**; the band
 * check below enforces equal digit counts. With this 1:1 in hand we can feed "uncut
 * text of exactly N characters" — the backstop's verdict sits on the N line itself,
 * off by one and the conclusion flips.
 */
const CALIBRATION_COUNT = 10_000;

async function measureWindowOverhead(client: Client): Promise<number> {
  const measured = await callWindow(client, CALIBRATION_COUNT);
  assert.ok(
    measured.length < TRACE_OUTPUT_BACKSTOP,
    `calibration probe itself reached the backstop (${measured.length} chars); shrink WINDOW_SCALAR_PAD`
  );
  return measured.length - CALIBRATION_COUNT;
}

/** Calibration band: target count shares CALIBRATION_COUNT's digit count and is a window this face can actually read. */
function assertInCalibrationBand(count: number): number {
  assert.ok(
    String(count).length === String(CALIBRATION_COUNT).length &&
      count >= 1 &&
      count <= GET_RECORD_MAX_COUNT &&
      count <= WINDOW_PART_CHARS,
    `count ${count} leaves the calibration band (${
      String(CALIBRATION_COUNT).length
    } digits, <=${GET_RECORD_MAX_COUNT})`
  );
  return count;
}

/** Make this face's **uncut** handler text exactly `wanted` characters; return the text the face hands back. */
async function probeAtTextLength(wanted: number): Promise<string> {
  const connected = await connectFixture(
    writeWindowTraceDir(WINDOW_SCALAR_PAD)
  );
  try {
    const count = assertInCalibrationBand(
      wanted - (await measureWindowOverhead(connected.client))
    );
    return await callWindow(connected.client, count);
  } finally {
    await connected.close();
  }
}

/** Slope check: in the same fixture, `count` + 1 yields an uncut response exactly +1. */
async function measuredSlope(): Promise<number> {
  const connected = await connectFixture(
    writeWindowTraceDir(WINDOW_SCALAR_PAD)
  );
  try {
    const overhead = await measureWindowOverhead(connected.client);
    const next = await callWindow(connected.client, CALIBRATION_COUNT + 1);
    return next.length - (overhead + CALIBRATION_COUNT + 1);
  } finally {
    await connected.close();
  }
}

describe("trace MCP server", () => {
  it("registers the three read-side faces in axis order and marks all read-only", async () => {
    // The whitelist's axis order: catalog → row → content (`server.ts`'s registerTool order is the tools/list order). Exactly these three, each carrying readOnlyHint.
    const connected = await connectFixture();
    try {
      const result = await connected.client.listTools();

      expect(result.tools).toHaveLength(3);
      expect(result.tools.map((tool) => tool.name)).toEqual([
        "list_sessions",
        "query_trace",
        "get_record",
      ]);
      expect(result.tools.every((tool) => tool.annotations?.readOnlyHint)).toBe(
        true
      );
    } finally {
      await connected.close();
    }
  });

  it("returns row projections without list-level messages", async () => {
    const connected = await connectFixture();
    try {
      const result = await connected.client.callTool({
        name: "query_trace",
        arguments: { conversation_id: "conversation-1" },
      });
      const text = result.content[0];

      assert.equal(text?.type, "text");
      if (text?.type !== "text") throw new Error("expected text content");
      // The 4000 number was retired, so on a small fixture `length <= 4_000` would
      // certify a guarantee the core **no longer provides** — a tautological cap
      // assertion. Re-pinned to what this test actually claims: this page is far
      // inside the face's budget, hence byte-for-byte untouched (no truncation mark).
      // "One record past 4000 returns whole" and "cut only past budget" each have dedicated tests below.
      expect(text.text.length).toBeLessThan(TRACE_OUTPUT_BACKSTOP);
      expect(text.text.endsWith(TRACE_BACKSTOP_MARKER)).toBe(false);
      expect(text.text).toContain("llm-2");
      const body = JSON.parse(text.text) as {
        records: Array<Record<string, unknown>>;
      };
      expect(body.records.every((record) => !("messages" in record))).toBe(
        true
      );
      expect(text.text).not.toContain('"messages":[');
    } finally {
      await connected.close();
    }
  });

  it("returns one record past the retired 4000 line whole and parseable (SC7)", async () => {
    // The behavioral half of SC7: "a record over 4000 must read back verbatim". The cap
    // is no longer a parameter of any tool, so crossing the line itself cannot change the
    // return — only this face's backstop changes returns, and it sits on the 20 000 line,
    // not this one. `total` was deleted (it belonged to panel paging), so no such field is read here.
    const traceDir = writePaddedTraceDir(6_000);
    const connected = await connectFixture(traceDir);
    try {
      const text = await callPaddedQueryTrace(connected.client);

      expect(text.length).toBeGreaterThan(4_000);
      expect(text.endsWith(TRACE_BACKSTOP_MARKER)).toBe(false);
      const body = JSON.parse(text) as {
        records: Array<{ pad?: string }>;
      };
      // The field comes back whole: neither dropped (v1.0's silent `compactRecord` degradation) nor trimmed short.
      expect(body.records[0]?.pad).toEqual("a".repeat(6_000));
    } finally {
      await connected.close();
    }
  });

  it("uses zod .strict() to reject the retired parameters (record_id/detail/resume_offset)", async () => {
    // T7: drill-down left query_trace for get_record. The MCP face keeps its
    // tight `.strict()` shape, so a stale name is rejected with a zod-prefixed
    // message — the same gate the executor provides on the ACI face.
    const connected = await connectFixture();
    try {
      for (const stale of [
        { conversation_id: "conversation-1", record_id: "llm-2" },
        { conversation_id: "conversation-1", detail: "messages" },
        { conversation_id: "conversation-1", resume_offset: 0 },
      ]) {
        const rejected = await connected.client.callTool({
          name: "query_trace",
          arguments: stale,
        });
        expect(rejected.isError).toBe(true);
        const text = rejected.content[0];
        assert.equal(text?.type, "text");
        if (text?.type !== "text") {
          throw new Error("expected text content");
        }
        expect(text.text).toMatch(/Unrecognized key|too_big|too_small/);
      }
    } finally {
      await connected.close();
    }
  });

  it("returns an MCP error for invalid tool arguments without closing the server", async () => {
    const connected = await connectFixture();
    try {
      const invalid = await connected.client.callTool({
        name: "query_trace",
        arguments: { limit: 0 },
      });
      const valid = await connected.client.callTool({
        name: "query_trace",
        arguments: { conversation_id: "conversation-1", limit: 1 },
      });

      expect(invalid.isError).toBe(true);
      expect(valid.isError).not.toBe(true);
    } finally {
      await connected.close();
    }
  });

  it("names the tool on an error the core rejects past the transport schema", async () => {
    // The core's own message carries no tool name, so a caller can only tell
    // which tool rejected the call if this face prefixes it. `a/b` passes the
    // zod transport schema and is rejected by the core, which is the route
    // through the face's catch arm rather than transport-level schema rejection.
    const connected = await connectFixture();
    try {
      const rejected = await connected.client.callTool({
        name: "query_trace",
        arguments: { conversation_id: "a/b" },
      });

      expect(rejected.isError).toBe(true);
      const text = rejected.content[0];
      assert.equal(text?.type, "text");
      if (text?.type !== "text") throw new Error("expected text content");
      expect(text.text).toBe(
        "query_trace: conversation_id must not contain path separators"
      );
    } finally {
      await connected.close();
    }
  });
});

describe("trace MCP server — list_sessions", () => {
  function parsePage(text: string): {
    sessions: Array<Record<string, unknown>>;
    limit: number;
    offset: number;
  } {
    return JSON.parse(text) as {
      sessions: Array<Record<string, unknown>>;
      limit: number;
      offset: number;
    };
  }

  it("lists the session the record axis cannot reach by name, agent_version absent", async () => {
    // The shared fixture writes two llm_call rows and no session root record —
    // exactly what a crashed or in-progress run leaves behind (the root lands at
    // run end). query_trace on the same directory reports records; only the
    // directory axis reports the session itself, with agent_version absent.
    const connected = await connectFixture();
    try {
      const result = await connected.client.callTool({
        name: "list_sessions",
        arguments: {},
      });
      const text = result.content[0];
      assert.equal(text?.type, "text");
      if (text?.type !== "text") throw new Error("expected text content");

      const page = parsePage(text.text);
      expect(Object.keys(page)).toEqual(["sessions", "limit", "offset"]);
      expect(page.sessions.map((s) => s["conversation_id"])).toEqual([
        "conversation-1",
      ]);
      expect(page.sessions[0]).not.toHaveProperty("agent_version");
      expect(typeof page.sessions[0]?.["mtime"]).toBe("number");
      expect(typeof page.sessions[0]?.["size"]).toBe("number");
    } finally {
      await connected.close();
    }
  });

  it("honours caller paging and answers an empty page past the end", async () => {
    const connected = await connectFixture();
    try {
      const first = await connected.client.callTool({
        name: "list_sessions",
        arguments: { limit: 1 },
      });
      const past = await connected.client.callTool({
        name: "list_sessions",
        arguments: { offset: 40 },
      });
      assert.equal(first.content[0]?.type, "text");
      assert.equal(past.content[0]?.type, "text");

      const firstPage = parsePage(first.content[0]!.text!);
      expect(firstPage.sessions).toHaveLength(1);
      expect(firstPage.limit).toBe(1);
      const pastPage = parsePage(past.content[0]!.text!);
      expect(pastPage.sessions).toEqual([]);
      expect(pastPage.offset).toBe(40);
    } finally {
      await connected.close();
    }
  });

  it("prefixes its own tool name on the read failure both faces share (SC16)", async () => {
    // Why this is the route SC16 is pinned with: `limit` / `offset` bounds are
    // declared on both face schemas, so zod (here) and ajv (ACI) reject an
    // out-of-range page before the core's own re-check can be reached — a bad
    // `limit` cannot demonstrate a `<tool>: ` prefix on this face. A traceDir
    // pointing at a regular file reaches TraceReadError instead, deterministically
    // and on both faces, without root or chmod.
    const scratch = mkdtempSync(join(tmpdir(), "iknow-trace-mcp-filedir-"));
    scratchPaths.push(scratch);
    const asFile = join(scratch, "not-a-dir.jsonl");
    writeFileSync(asFile, '{"record_type":"session"}\n', "utf8");

    const connected = await connectFixture(asFile);
    try {
      const failed = await connected.client.callTool({
        name: "list_sessions",
        arguments: {},
      });
      const text = failed.content[0];
      assert.equal(text?.type, "text");
      if (text?.type !== "text") throw new Error("expected text content");

      expect(failed.isError).toBe(true);
      expect(text.text).toBe("list_sessions: trace file read failed: ENOTDIR");
    } finally {
      await connected.close();
    }
  });

  it("shows the SDK's own schema-rejection shape, which is not the core route", async () => {
    // The other caller-visible error path on this face: zod rejects before the
    // face's catch arm runs, so the SDK writes the text. It names the tool, just
    // in `... for tool list_sessions: ...` form rather than `list_sessions: ...`.
    // Both bound edges are pinned with zod's own measured wording (`Too small` /
    // `Too big` are the SDK's strings, and this face produces the same shape for
    // query_trace). Pinned separately so nobody "fixes" it into the prefixed shape
    // (which would mean relaxing the schema or double-prefixing SDK text).
    const connected = await connectFixture();
    try {
      const tooSmall = await connected.client.callTool({
        name: "list_sessions",
        arguments: { limit: 0 },
      });
      const tooLarge = await connected.client.callTool({
        name: "list_sessions",
        arguments: { limit: LIST_SESSIONS_MAX_LIMIT + 1 },
      });

      expect(tooSmall.isError).toBe(true);
      expect(tooLarge.isError).toBe(true);
      expect(tooSmall.content[0]).toEqual({
        type: "text",
        text: "Input validation error: Invalid arguments for tool list_sessions: limit: Too small: expected number to be >=1",
      });
      expect(tooLarge.content[0]).toEqual({
        type: "text",
        // The SDK quotes the bound back in its own sentence, so the number here
        // is the schema's, not this test's: `LIST_SESSIONS_MAX_LIMIT` moved
        // 200 → 128 in the read-side-split work. Interpolating it keeps
        // the claim (the face refuses one past its declared maximum, in the SDK's
        // wording) without pinning a value the core owns.
        text: `Input validation error: Invalid arguments for tool list_sessions: limit: Too big: expected number to be <=${LIST_SESSIONS_MAX_LIMIT}`,
      });
    } finally {
      await connected.close();
    }
  });
});

/** Every response on this face is a single text block; on failure that sole block is the message to the caller. */
function firstText(result: unknown): string {
  const content = (result as { content?: unknown }).content;
  assert.ok(Array.isArray(content), "expected a content array");
  const block = content[0] as { type?: unknown; text?: unknown } | undefined;
  assert.equal(block?.type, "text");
  assert.equal(typeof block?.text, "string");
  return block!.text as string;
}

describe("trace MCP server — get_record", () => {
  it("answers a character window and echoes the effective coordinates (SC8)", async () => {
    // The wiring needs its own pin: all three tools share one handler factory, so a
    // "name registered right, core wired wrong" defect is invisible to the whitelist
    // test. The window arm's criteria themselves (exactly count chars, echo of
    // effective coordinates) belong to tests/traceserver/; here we only certify the
    // evidence reaches the caller unchanged.
    const connected = await connectFixture();
    try {
      const result = await connected.client.callTool({
        name: "get_record",
        arguments: {
          conversation_id: "conversation-1",
          record_id: "llm-2",
          // The window arm is selected by the **presence** of `part_index`: giving only
          // from_char/count lands on the manifest arm — rejected, not ignored — which the
          // SC16 test below pins exactly.
          part_index: 0,
          from_char: 8,
          count: 4,
        },
      });
      const text = firstText(result);
      expect(result.isError).not.toBe(true);

      const body = JSON.parse(text) as {
        matched_on: string;
        detail: string;
        part_index: number;
        from_char: number;
        count: number;
        part_chars: number;
        text: string;
      };
      // part 0 is llm-2's only tool_result in full: "private tool output" (19 chars).
      expect(body.matched_on).toBe("llm_call_id");
      expect(body.detail).toBe("tool_results");
      expect([body.part_index, body.from_char, body.count]).toEqual([0, 8, 4]);
      expect(body.part_chars).toBe(19);
      expect(body.text).toBe("tool");
      // `text` being the last key is not a formatting preference: this face's backstop
      // cuts from the tail, so key order decides whether the cut lands on the body or
      // the echoed coordinates (the latter must survive so the caller can simply lower
      // count and retry).
      expect(Object.keys(body).at(-1)).toBe("text");
    } finally {
      await connected.close();
    }
  });

  it("names get_record on every error that leaves the face catch arm (SC16)", async () => {
    // Three catch-arm routes that need no large fixture: `a/b` passes zod and is rejected
    // by the core; `record_not_found` is an error the core itself constructs; window
    // coordinates without `part_index` land on the manifest arm and are rejected (the two
    // arms are selected by the **presence** of `part_index`; unused coordinates are
    // rejected, not ignored). All three messages must carry this face's tool name — the
    // shared core **deliberately** omits tool names from its messages (that would
    // misattribute the other two axes), so the prefix can only come from this skin.
    //
    // This face **deliberately** carries no `kind` (MCP has no ACI-style structured
    // channel; folding it into text would change SC16's shape; filed as a follow-up).
    // The absence is pinned here too, so nobody helpfully adds it.
    const connected = await connectFixture();
    try {
      const rejected = await connected.client.callTool({
        name: "get_record",
        arguments: { conversation_id: "a/b", record_id: "llm-1" },
      });
      const missing = await connected.client.callTool({
        name: "get_record",
        arguments: { conversation_id: "conversation-1", record_id: "no-such" },
      });
      const manifestWithWindow = await connected.client.callTool({
        name: "get_record",
        arguments: {
          conversation_id: "conversation-1",
          record_id: "llm-2",
          count: 4,
        },
      });

      expect(rejected.isError).toBe(true);
      expect(missing.isError).toBe(true);
      expect(manifestWithWindow.isError).toBe(true);
      expect(firstText(rejected)).toBe(
        "get_record: conversation_id must not contain path separators"
      );
      expect(firstText(missing)).toBe(
        "get_record: no record matched record_id 'no-such'"
      );
      expect(firstText(manifestWithWindow)).toBe(
        "get_record: count addresses a window and requires part_index; " +
          "omit the window coordinates to read the inventory instead"
      );
      expect(firstText(rejected)).not.toContain("kind");
    } finally {
      await connected.close();
    }
  });
});

describe("trace MCP server — role projection (v1.2)", () => {
  // After the role-projection spec landed, verify over the stdio MCP call path the
  // projection shared by both skins: query_trace's row-axis projection carries
  // last_assistant_preview; get_record(detail=messages)'s manifest parts carry role.
  // Both skins inherit automatically via the shared core; this pins that the MCP
  // layer also exposes these fields.

  it("query_trace llm_call projection carries last_assistant_preview", async () => {
    const fixture = createTraceFixture();
    fixtures.push(fixture);
    const connected = await connectFixture();
    try {
      const result = await connected.client.callTool({
        name: "query_trace",
        arguments: { conversation_id: "conversation-1" },
      });
      const text = result.content[0];
      assert.equal(text?.type, "text");
      if (text?.type !== "text") throw new Error("expected text content");

      const body = JSON.parse(text.text) as {
        records: Array<Record<string, unknown>>;
      };
      // The fixture has an assistant message on conversation-1's second record llm-2,
      // containing one tool_use block. last_assistant_preview should be its JSON string.
      const llm2 = body.records.find(
        (record) => record.llm_call_id === "llm-2"
      );
      assert.ok(llm2, "fixture must contain llm-2");
      assert.ok(
        "last_assistant_preview" in llm2!,
        `last_assistant_preview must appear in llm_call projection, got: ${JSON.stringify(llm2)}`
      );
      // preview() JSON-stringifies the message object. The fixture's
      // llm-2 messages are [user prompt, assistant tool_use, user
      // tool_result] -- the LAST assistant is the second message; the
      // last_message_preview answers a different question (last message
      // of any role) and lands on the tool_result.
      assert.equal(
        llm2!.last_assistant_preview,
        JSON.stringify({
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu-1",
              name: "lookup",
              input: { query: "private input" },
            },
          ],
        })
      );
      // last_message_preview semantics preserved: still the last message
      // of any role (the user tool_result, here).
      assert.equal(
        llm2!.last_message_preview,
        JSON.stringify({
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu-1",
              content: "private tool output",
            },
          ],
        })
      );
    } finally {
      await connected.close();
    }
  });

  it("get_record(detail=messages) manifest parts carry role", async () => {
    const fixture = createTraceFixture();
    fixtures.push(fixture);
    const connected = await connectFixture();
    try {
      const result = await connected.client.callTool({
        name: "get_record",
        arguments: {
          conversation_id: "conversation-1",
          record_id: "llm-2",
          detail: "messages",
        },
      });
      const text = result.content[0];
      assert.equal(text?.type, "text");
      if (text?.type !== "text") throw new Error("expected text content");

      const body = JSON.parse(text.text) as {
        parts: Array<{ role?: string; message_index?: number }>;
      };

      // llm-2 fixture: 3 messages [user, assistant, user], one part each.
      // role follows the message: [user, assistant, user].
      assert.equal(body.parts.length, 3);
      assert.equal(body.parts[0]?.role, "user");
      assert.equal(body.parts[1]?.role, "assistant");
      assert.equal(body.parts[2]?.role, "user");
    } finally {
      await connected.close();
    }
  });

  it("get_record default detail=tool_results manifest parts carry no role", async () => {
    // Closing the role-projection criteria: detail=tool_results parts carry **no** role.
    // Pinned via the MCP path as "absent", not null/undefined.
    const fixture = createTraceFixture();
    fixtures.push(fixture);
    const connected = await connectFixture();
    try {
      const result = await connected.client.callTool({
        name: "get_record",
        arguments: {
          conversation_id: "conversation-1",
          record_id: "llm-2",
        },
      });
      const text = result.content[0];
      assert.equal(text?.type, "text");
      if (text?.type !== "text") throw new Error("expected text content");

      const body = JSON.parse(text.text) as {
        parts: Array<Record<string, unknown>>;
      };
      // llm-2 has 1 projected tool_result.
      assert.equal(body.parts.length, 1);
      assert.ok(
        !("role" in body.parts[0]!),
        `tool_results part must not carry role, got: ${JSON.stringify(body.parts[0])}`
      );
    } finally {
      await connected.close();
    }
  });
});

describe("trace MCP server — output backstop", () => {
  // The cap must exist on **this** skin only: the in-process route still has the
  // executor's `OUTPUT_HARD_CAP` behind it (the sole truncation authority of
  // contract X), while the stdio route has nothing inspecting the text afterwards.
  // The criterion is "marker counts toward the budget → returned length strictly
  // ≤ `TRACE_OUTPUT_BACKSTOP`", falsifiable only by probing both sides of the
  // boundary. Value-source locking lives in tests/traceserver/output-backstop.test.ts
  // (where the executor can run across the boundary); this file does not re-pin a bare constant.

  it("leaves text at exactly the budget whole and cuts it one character later", async () => {
    const whole = await probeAtTextLength(TRACE_OUTPUT_BACKSTOP);
    const cut = await probeAtTextLength(TRACE_OUTPUT_BACKSTOP + 1);
    const head = TRACE_OUTPUT_BACKSTOP - TRACE_BACKSTOP_MARKER.length;

    // The calibration itself: slope must be 1. Two adjacent same-digit-count counts must
    // yield uncut responses exactly one character apart — otherwise the "20 000 uncut /
    // 20 001 cut" comparison below is not comparing adjacent points on the same line.
    expect(await measuredSlope()).toBe(0);

    // 20 000: untouched, hence still parseable JSON with no truncation marker.
    expect(whole).toHaveLength(TRACE_OUTPUT_BACKSTOP);
    expect(whole.endsWith(TRACE_BACKSTOP_MARKER)).toBe(false);
    // 20 001: cut to exactly the budget — if the marker did not count, it would be 20 014 and the invariant breaks.
    expect(cut).toHaveLength(TRACE_OUTPUT_BACKSTOP);
    expect(cut.length).toBeLessThanOrEqual(TRACE_OUTPUT_BACKSTOP);
    expect(cut.endsWith(TRACE_BACKSTOP_MARKER)).toBe(true);
    // Cut at the budget's last position, keeping exactly the original head. The two
    // responses align character-for-character apart from their echoed `count` digits
    // (which should differ by one anyway), so that field can be compared directly on
    // both sides; the 20 chars just before the marker are still body `z`s, proving the
    // tail was cut, not the middle ("summary + marker" would be a different cut).
    const echoStart = whole.indexOf('"count":') + '"count":'.length;
    const echoEnd = whole.indexOf(",", echoStart);
    expect(echoEnd).toBeGreaterThan(echoStart);
    expect(cut.slice(0, echoStart)).toBe(whole.slice(0, echoStart));
    expect(cut.slice(echoEnd, head)).toBe(whole.slice(echoEnd, head));
    expect(cut.slice(head - 20, head)).toBe("z".repeat(20));
  });

  it("caps a far-oversized response to the same budget", async () => {
    // No calibration, just "far past the cap": pad the magnitude to ~100 000 (fixed-width
    // scalar ~84 000 + a 16 000 body window = the largest window this face can read); the
    // returned length must still equal the budget exactly.
    const connected = await connectFixture(writeWindowTraceDir(84_000));
    try {
      const huge = await callWindow(connected.client, GET_RECORD_MAX_COUNT);

      expect(huge).toHaveLength(TRACE_OUTPUT_BACKSTOP);
      expect(huge.endsWith(TRACE_BACKSTOP_MARKER)).toBe(true);
    } finally {
      await connected.close();
    }
  });

  it("caps the error arm too, with the tool-name prefix still in front", async () => {
    // Both arms pass through the backstop (written twice inside `readOnlyToolHandler`).
    // This makes "errors can exceed the budget too" explicit: a 30 000-char record_id is
    // echoed verbatim by the core into the message; after cutting it still starts with
    // `get_record: ` — the prefix survives at the head, the body is cut at the tail.
    const connected = await connectFixture();
    try {
      const failed = await connected.client.callTool({
        name: "get_record",
        arguments: {
          conversation_id: "conversation-1",
          record_id: "x".repeat(30_000),
        },
      });
      const text = firstText(failed);

      expect(failed.isError).toBe(true);
      expect(text).toHaveLength(TRACE_OUTPUT_BACKSTOP);
      expect(text.startsWith("get_record: ")).toBe(true);
      expect(text.endsWith(TRACE_BACKSTOP_MARKER)).toBe(true);
    } finally {
      await connected.close();
    }
  });
});

/** Schema only, no filesystem touched: all three tool factories are lazy. */
const SC18_ONLY_TRACE_DIR = "/iknow-sc18-schema-only";

/**
 * This needs a table (one diff per tool), not three copy-pasted assertions.
 * `boundedField` / `maximum` name per tool "this tool's sole upper bound is declared
 * by the core"; without them we'd rely on the loop below, which goes silent when both
 * faces drop a bound simultaneously.
 */
const PARAMETER_PLANE: ReadonlyArray<{
  readonly name: string;
  readonly aciSchema: FaceSchema;
  readonly boundedField: string;
  readonly maximum: number;
}> = [
  {
    name: "list_sessions",
    aciSchema: createListSessionsTool(SC18_ONLY_TRACE_DIR)
      .inputSchema as FaceSchema,
    boundedField: "limit",
    maximum: LIST_SESSIONS_MAX_LIMIT,
  },
  {
    name: "query_trace",
    aciSchema: createQueryTraceTool(SC18_ONLY_TRACE_DIR)
      .inputSchema as FaceSchema,
    boundedField: "limit",
    maximum: QUERY_TRACE_MAX_LIMIT,
  },
  {
    name: "get_record",
    aciSchema: createGetRecordTool(SC18_ONLY_TRACE_DIR)
      .inputSchema as FaceSchema,
    boundedField: "count",
    maximum: GET_RECORD_MAX_COUNT,
  },
];

describe("the three read-side faces agree on the parameter plane (SC18)", () => {
  // One diff assertion per tool: no face may quietly move a bound. Writing the bridge
  // inside the test is deliberate — `src/trace-mcp/` must not import the ACI registry,
  // so only a caller-perspective comparison can say the two declarations still agree.
  //
  // Two legitimate differences are named, not smoothed over: each ACI axis carries a
  // `default` (this SDK does not surface it), and zod attaches an implicit
  // `Number.MAX_SAFE_INTEGER` maximum to `.int()` without a declared bound (visible only
  // on fields like `offset` / `message_index`), so maximum is compared only where ACI declares it.
  it.each(PARAMETER_PLANE)(
    "$name publishes the same properties, bounds and required-ness on both faces",
    async ({ name, aciSchema, boundedField, maximum }) => {
      const connected = await connectFixture();
      try {
        const tools = await connected.client.listTools();
        const mcpSchema = tools.tools.find((tool) => tool.name === name)
          ?.inputSchema as FaceSchema;

        expect(Object.keys(mcpSchema.properties).sort()).toEqual(
          Object.keys(aciSchema.properties).sort()
        );
        expect(mcpSchema.additionalProperties).toBe(false);
        expect(aciSchema.additionalProperties).toBe(false);
        // required-ness compared together: the content axis's two ids are contractual
        // only if **both faces** require them.
        expect([...(mcpSchema.required ?? [])].sort()).toEqual(
          [...(aciSchema.required ?? [])].sort()
        );
        for (const [field, aciField] of Object.entries(aciSchema.properties)) {
          const mcpField = mcpSchema.properties[field]!;
          expect(mcpField.type).toEqual(aciField.type);
          expect(mcpField.minimum).toEqual(aciField.minimum);
          if ("maximum" in aciField) {
            expect(mcpField.maximum).toEqual(aciField.maximum);
          }
        }
        // The loop above goes silent when both faces drop a bound together, so name the real bound per tool.
        expect(aciSchema.properties[boundedField]?.maximum).toBe(maximum);
        expect(mcpSchema.properties[boundedField]?.maximum).toBe(maximum);
      } finally {
        await connected.close();
      }
    }
  );

  it("keeps the content axis the only face with required arguments", async () => {
    // The per-tool comparison above proves the faces agree; still needed: "required-ness
    // exists only on the content axis". The catalog and row axes keep "omitted = most
    // recently active session"; this axis switched it off. Array order is the three-axis
    // order, same source as the registration order.
    expect(
      PARAMETER_PLANE.map((face) => face.aciSchema.required ?? [])
    ).toEqual([[], ["conversation_id"], ["conversation_id", "record_id"]]);
  });
});

describe("trace MCP server — query_trace contains (trace-mcp-args-search task)", () => {
  // The schema-diff test sees `contains` on both faces' schemas and passes naturally.
  // Add one end-to-end: MCP face input contains → core (reader) → result.
  it("propagates contains to the core and returns the matching record", async () => {
    const connected = await connectFixture();
    try {
      const result = await connected.client.callTool({
        name: "query_trace",
        arguments: {
          conversation_id: "conversation-1",
          contains: "private prompt",
        },
      });
      const text = result.content[0];
      assert.equal(text?.type, "text");
      if (text?.type !== "text") throw new Error("expected text content");
      const body = JSON.parse(text.text) as {
        records: Array<{ llm_call_id?: string }>;
      };
      assert.equal(body.records.length, 2);
      assert.deepEqual(
        body.records.map((record) => record.llm_call_id).sort(),
        ["llm-1", "llm-2"]
      );
    } finally {
      await connected.close();
    }
  });

  it("rejects an empty contains via zod .strict() as SDK schema-rejection", async () => {
    // The MCP face's .strict() does not reject `contains` itself (a legitimate schema
    // property), but the core throws TraceQueryValidationError — here we verify the face's
    // catch arm prefixes it as `query_trace: ...` before it reaches the caller.
    const connected = await connectFixture();
    try {
      const failed = await connected.client.callTool({
        name: "query_trace",
        arguments: {
          conversation_id: "conversation-1",
          contains: "",
        },
      });
      const text = failed.content[0];
      assert.equal(text?.type, "text");
      if (text?.type !== "text") throw new Error("expected text content");
      expect(failed.isError).toBe(true);
      expect(text.text).toBe(
        "query_trace: contains must be a non-empty string"
      );
    } finally {
      await connected.close();
    }
  });
});

describe("trace MCP server — ADR-0116 detail=system / detail=tools", () => {
  const SYSTEM_BODY =
    "You are iknow. Use the symbol tools — do not start with grep.";

  function make1077TraceDir(): string {
    const traceDir = mkdtempSync(join(tmpdir(), "iknow-trace-mcp-1077-"));
    const convDir = join(
      traceDir,
      "projects",
      "test-project-trace-mcp",
      "conversation-1"
    );
    mkdirSync(join(convDir, "blobs"), { recursive: true });
    const payload = JSON.stringify({ kind: "str", v: SYSTEM_BODY });
    const sha = createHash("sha256").update(payload, "utf8").digest("hex");
    writeFileSync(join(convDir, "blobs", sha), payload, "utf8");
    writeFileSync(
      join(convDir, "trace.jsonl"),
      JSON.stringify({
        conversation_id: "conversation-1",
        record_type: "llm_call",
        llm_call_id: "llm-sys",
        status: "ok",
        messages: [],
        system: { sha, bytes: Buffer.byteLength(payload, "utf8") },
        tool_names: ["read_file", "get_record"],
      }) + "\n",
      "utf8"
    );
    return traceDir;
  }

  it("accepts detail=system and returns the dereferenced body window", async () => {
    const connected = await connectFixture(make1077TraceDir());
    try {
      const result = await connected.client.callTool({
        name: "get_record",
        arguments: {
          conversation_id: "conversation-1",
          record_id: "llm-sys",
          detail: "system",
          part_index: 0,
          count: SYSTEM_BODY.length,
        },
      });
      const text = result.content[0];
      assert.equal(text?.type, "text");
      if (text?.type !== "text") throw new Error("expected text content");
      const body = JSON.parse(text.text) as {
        detail: string;
        part_chars: number;
        text: string;
      };
      assert.equal(body.detail, "system");
      assert.equal(body.part_chars, SYSTEM_BODY.length);
      assert.equal(body.text, SYSTEM_BODY);
    } finally {
      await connected.close();
    }
  });

  it("accepts detail=tools and lists one part per tool name", async () => {
    const connected = await connectFixture(make1077TraceDir());
    try {
      const result = await connected.client.callTool({
        name: "get_record",
        arguments: {
          conversation_id: "conversation-1",
          record_id: "llm-sys",
          detail: "tools",
        },
      });
      const text = result.content[0];
      assert.equal(text?.type, "text");
      if (text?.type !== "text") throw new Error("expected text content");
      const body = JSON.parse(text.text) as {
        parts: Array<Record<string, unknown>>;
      };
      assert.deepEqual(body.parts, [
        { part_index: 0, chars: "read_file".length, name: "read_file" },
        { part_index: 1, chars: "get_record".length, name: "get_record" },
      ]);
    } finally {
      await connected.close();
    }
  });

  it("query_trace contains reaches the blob-stored system sentence", async () => {
    const connected = await connectFixture(make1077TraceDir());
    try {
      const result = await connected.client.callTool({
        name: "query_trace",
        arguments: {
          conversation_id: "conversation-1",
          contains: "symbol tools",
        },
      });
      const text = result.content[0];
      assert.equal(text?.type, "text");
      if (text?.type !== "text") throw new Error("expected text content");
      const body = JSON.parse(text.text) as {
        records: Array<Record<string, unknown>>;
      };
      assert.equal(body.records.length, 1);
      assert.equal(body.records[0]?.["llm_call_id"], "llm-sys");
    } finally {
      await connected.close();
    }
  });
});
