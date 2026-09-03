import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
 * 一条只多了一个标量 `pad` 的记录（没有 messages，所以行轴预览里不会掺进别的截断
 * 标记）。「越 4000 那条线的单条记录原样可读」认证的就是它。
 */
const PADDED_CONVERSATION = "padded-conversation";

function writePaddedTraceDir(pad: number): string {
  const traceDir = mkdtempSync(join(tmpdir(), "iknow-trace-mcp-pad-"));
  scratchPaths.push(traceDir);
  writeFileSync(
    join(traceDir, `${PADDED_CONVERSATION}.jsonl`),
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

/** 行轴：整页文本。 */
async function callPaddedQueryTrace(client: Client): Promise<string> {
  const result = await client.callTool({
    name: "query_trace",
    arguments: { conversation_id: PADDED_CONVERSATION },
  });
  return firstText(result);
}

const WINDOW_CONVERSATION = "window-conversation";
const WINDOW_RECORD_ID = "llm-window";
/** 窗正文的长度。它在三次探针里都不变，变的只有读它的 `count`。 */
const WINDOW_PART_CHARS = 16_001;
/**
 * 把量级垫到 backstop 附近的记录标量。9 700 + 标定用的 `count: 10_000` 让标定那一发
 * 自己**不**撞帽（撞了量到的就是切完的长度），同时把目标 `count`（≈10 050）留在
 * `GET_RECORD_MAX_COUNT` 之内。
 */
const WINDOW_SCALAR_PAD = 9_700;

/** 一条带定宽标量与一条 16 001 字符 tool_result part 的记录。 */
function writeWindowTraceDir(scalarPad: number): string {
  const traceDir = mkdtempSync(join(tmpdir(), "iknow-trace-mcp-window-"));
  scratchPaths.push(traceDir);
  writeFileSync(
    join(traceDir, `${WINDOW_CONVERSATION}.jsonl`),
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

/** 内容轴：读 `count` 个字符的窗，返回 face 交回去的文本。 */
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
 * 斜率为 1 的旋钮：`text` 是回复的**最后一个键**，所以 `count` 加一 = 未切文本加一
 * —— 标量 `pad`、`part_chars`、回显的 `from_char`/`part_index` 都不随之变，正文里也
 * 没有会被 `JSON.stringify` 转义膨胀的字符。唯一的例外是十进制进位（`count` 从 9 999
 * 到 10 000 会给长度白加一个字符），所以整条线只在**同一个位数**内成立：下面用位数
 * 相等把它圈出来。有了这条 1:1，才能喂「未切文本恰好 N 个字符」—— backstop 的判据就
 * 压在 N 那条线上，差一个字符结论就翻。
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

/** 标定的有效区间：目标 count 与标定值同位数，且是本面读得出来的窗。 */
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

/** 让本面**未切**的 handler 文本正好 `wanted` 个字符，返回 face 交回去的文本。 */
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

/** 斜率检查：同一份夹具里 `count` 加一，未切回复正好加一。 */
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
    // SC6 的白名单：目录轴 → 行轴 → 内容轴（`server.ts` 的 registerTool 顺序即
    // tools/list 顺序）。含且仅含这三件，且三件都带 readOnlyHint。
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
      // T6 让 4000 这个数字退场（plan 第 5 条），所以小夹具上的
      // `length <= 4_000` 认证的是核心**不再提供**的保证 —— 一条恒真的帽断言。改钉
      // 本测真正主张的事：这一页远在面的预算之内，因此一字未动（没有任何截断标记）。
      // 「越 4000 的单条整发返回」与「超预算才切」两条判据各有专门的测在下面。
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
    // SC7 的行为断言半边：「一条超 4000 的记录必须原样可读」。帽不再是任何工具的
    // 参数，所以越线本身不能改变返回 —— 唯一会改变返回的是本面的 backstop，而它
    // 在 20 000 那条线上，不在这条线上。T7 删了 `total`（属面板分页），所以这里
    // 不再读这个字段。
    const traceDir = writePaddedTraceDir(6_000);
    const connected = await connectFixture(traceDir);
    try {
      const text = await callPaddedQueryTrace(connected.client);

      expect(text.length).toBeGreaterThan(4_000);
      expect(text.endsWith(TRACE_BACKSTOP_MARKER)).toBe(false);
      const body = JSON.parse(text) as {
        records: Array<{ pad?: string }>;
      };
      // 字段整发回来：既没被删（v1.0 `compactRecord` 的静默降级），也没被裁短。
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
        // 200 → 128 in plan `trace-mcp-read-side-split` T6. Interpolating it keeps
        // the claim (the face refuses one past its declared maximum, in the SDK's
        // wording) without pinning a value the core owns.
        text: `Input validation error: Invalid arguments for tool list_sessions: limit: Too big: expected number to be <=${LIST_SESSIONS_MAX_LIMIT}`,
      });
    } finally {
      await connected.close();
    }
  });
});

/** 本面每条回复都是单个 text block；失败时那唯一的 block 就是给调用方的消息。 */
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
    // 接线要单独钉：三件工具共用一个 handler 工厂，所以「名字注册对了、核接错了」
    // 这种缺陷白名单测看不见。窗臂的判据本身（恰好 count 个字符、坐标回显生效值）
    // 归 tests/traceserver/；这里只认证据到了调用方手里仍是原样。
    const connected = await connectFixture();
    try {
      const result = await connected.client.callTool({
        name: "get_record",
        arguments: {
          conversation_id: "conversation-1",
          record_id: "llm-2",
          // 窗臂由 `part_index` 的**存在**选定（第 14 条）：只给 from_char/count 落在
          // 清单臂上，那是被拒而不是被忽略 —— 下面那条 SC16 测正好钉这件事。
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
      // part 0 是 llm-2 唯一的 tool_result 全文 "private tool output"（19 字符）。
      expect(body.matched_on).toBe("llm_call_id");
      expect(body.detail).toBe("tool_results");
      expect([body.part_index, body.from_char, body.count]).toEqual([0, 8, 4]);
      expect(body.part_chars).toBe(19);
      expect(body.text).toBe("tool");
      // `text` 排在最后一个键不是排版偏好：本面的 backstop 从尾部切，键序决定了被切
      // 到的是正文还是回显坐标（后者必须留下，调用方才能只改小 count 重发）。
      expect(Object.keys(body).at(-1)).toBe("text");
    } finally {
      await connected.close();
    }
  });

  it("names get_record on every error that leaves the face catch arm (SC16)", async () => {
    // 三条不需要大夹具的 catch-arm 路线：`a/b` 过 zod 而由核拒；`record_not_found`
    // 干脆是核自己造的错误；只给窗坐标不给 `part_index` 落在清单臂上被拒（两臂由
    // `part_index` 的**存在**选定，未用的坐标是拒不是忽略）。三条的消息都必须带
    // 本面工具名 —— 共用的核**故意**不在消息里提名工具（那会把另外两条轴说错），
    // 前缀只可能来自这张皮。
    //
    // 本面**故意**不带 `kind`（MCP 没有 ACI 那样的结构化通道，拼进文本会改掉 SC16
    // 的形状；记为后续票）。这里把「不带」也钉住，免得有人顺手补上。
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
  // spec v1.2 判据落地后, 经 stdio MCP 调用路径验证两张皮共用的投影:
  // query_trace 行轴投影携带 last_assistant_preview;
  // get_record(detail=messages) 清单臂 parts 携带 role.
  // 两张皮经共享核自动继承, 这里钉住 MCP 这层也能看到这些字段.

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
      // fixture 在 conversation-1 第二条记录 llm-2 上有一条 assistant 消息,
      // 内容是一个 tool_use block. last_assistant_preview 应该是其 JSON 字符串.
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

      // llm-2 fixture: 3 条消息 [user, assistant, user], 每条单 part.
      // role 跟随 message: [user, assistant, user].
      assert.equal(body.parts.length, 3);
      assert.equal(body.parts[0]?.role, "user");
      assert.equal(body.parts[1]?.role, "assistant");
      assert.equal(body.parts[2]?.role, "user");
    } finally {
      await connected.close();
    }
  });

  it("get_record default detail=tool_results manifest parts carry no role", async () => {
    // v1.2 判据 (a) 收尾: detail=tool_results 的 part 上**不加** role.
    // 通过 MCP 路径钉住「缺席」而非 null/undefined.
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
      // llm-2 有 1 个 projected tool_result.
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
  // 帽只在**这条**皮上必须有：进程内那条路后面还有 executor 的 `OUTPUT_HARD_CAP`
  // （契约 X 的唯一截断权威），stdio 这条路没有任何东西在它之后再看一眼文本。
  // 判据是「marker 计入预算 → 返回长度严格 ≤ `TRACE_OUTPUT_BACKSTOP`」，而它只能在
  // 边界两侧各喂一次才被证伪。值的同源锁定在 tests/traceserver/output-backstop.test.ts
  // （那里可以跨边界跑 executor），本文件不重复钉一个纯常量。

  it("leaves text at exactly the budget whole and cuts it one character later", async () => {
    const whole = await probeAtTextLength(TRACE_OUTPUT_BACKSTOP);
    const cut = await probeAtTextLength(TRACE_OUTPUT_BACKSTOP + 1);
    const head = TRACE_OUTPUT_BACKSTOP - TRACE_BACKSTOP_MARKER.length;

    // 标定本身：斜率必须是 1。两个同位数的相邻 count，未切回复正好差一个字符 ——
    // 否则下面「20 000 未切 / 20 001 已切」比的就不是同一条线上的两个相邻点。
    expect(await measuredSlope()).toBe(0);

    // 20 000：一字未动，因此仍是可解析的 JSON，也没有任何截断标记。
    expect(whole).toHaveLength(TRACE_OUTPUT_BACKSTOP);
    expect(whole.endsWith(TRACE_BACKSTOP_MARKER)).toBe(false);
    // 20 001：切完正好等于预算 —— marker 不计入的话就是 20 014，那条不变式即破。
    expect(cut).toHaveLength(TRACE_OUTPUT_BACKSTOP);
    expect(cut.length).toBeLessThanOrEqual(TRACE_OUTPUT_BACKSTOP);
    expect(cut.endsWith(TRACE_BACKSTOP_MARKER)).toBe(true);
    // 切在预算末位，且留下的就是原文的头。两条回复除了各自回显的 `count` 数字（本来
    // 就该差一位）之外是逐字符对齐的，所以那个字段两侧都可以直接比；标记紧前面仍是
    // 正文的 `z` 串，说明被切掉的是尾部，不是中间（「摘要 + 标记」是另一种切法）。
    const echoStart = whole.indexOf('"count":') + '"count":'.length;
    const echoEnd = whole.indexOf(",", echoStart);
    expect(echoEnd).toBeGreaterThan(echoStart);
    expect(cut.slice(0, echoStart)).toBe(whole.slice(0, echoStart));
    expect(cut.slice(echoEnd, head)).toBe(whole.slice(echoEnd, head));
    expect(cut.slice(head - 20, head)).toBe("z".repeat(20));
  });

  it("caps a far-oversized response to the same budget", async () => {
    // 不标定，只要「远远越帽」：把量级垫到 ~100 000（定宽标量 ~84 000 + 一窗 16 000
    // 正文 = 本面能读的最大窗），返回长度仍必须正好等于预算。
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
    // 两条臂都过 backstop（`readOnlyToolHandler` 里写了两次）。这条测把「错误也可能
    // 超预算」说清楚：一个 30 000 字符的 record_id 会被核原样回抄进消息，切完仍然
    // 以 `get_record: ` 开头 —— 前缀在头部，所以它活下来；正文在尾部，所以被切。
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

/** 只造 schema，不碰文件系统：三件工具的工厂都是惰性的。 */
const SC18_ONLY_TRACE_DIR = "/iknow-sc18-schema-only";

/**
 * SC18 要的是一张表（每件工具各一条 diff），而不是三份复制粘贴的断言。
 * `boundedField` / `maximum` 逐件点名「这一件唯一的上界由核声明」，缺了它就得靠
 * 下面那个循环，而循环在两边同时掉界时会一声不响。
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
  // spec SC18：每件工具各一条 diff 断言，任何一面都不能悄悄挪动一个界。桥写在测里
  // 是故意的 —— `src/trace-mcp/` 不得 import ACI registry（SC12），于是只有调用方
  // 视角的比对能说这两份声明仍然一致。
  //
  // 两处合法差异点名而不抹平：ACI 侧每个轴带 `default`（本 SDK 不 surface 它），
  // zod 给未声明上界的 `.int()` 挂上隐式 `Number.MAX_SAFE_INTEGER` 上界（只在
  // `offset` / `message_index` 这类字段现身），所以 maximum 只在 ACI 声明它的地方比。
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
        // required-ness 一起比：内容轴那两个 id 只有**两面都**必填才是合同
        // （Assumption 4）。
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
        // 这条循环会在两边同时掉界时一声不响，所以逐个点名真正的界。
        expect(aciSchema.properties[boundedField]?.maximum).toBe(maximum);
        expect(mcpSchema.properties[boundedField]?.maximum).toBe(maximum);
      } finally {
        await connected.close();
      }
    }
  );

  it("keeps the content axis the only face with required arguments", async () => {
    // 上面逐件比过「两面一致」，还差一条「必填这件事只在内容轴」的断言：目录轴与
    // 行轴保留「缺省=最近活跃会话」，本轴把它关掉了。数组顺序即三轴顺序，与 SC6 的
    // 注册顺序同源。
    expect(
      PARAMETER_PLANE.map((face) => face.aciSchema.required ?? [])
    ).toEqual([[], ["conversation_id"], ["conversation_id", "record_id"]]);
  });
});
