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
 * `get_record` on the ACI face (plan `trace-mcp-read-side-split` T6,
 * spec SC16 / SC18 / SC20 and the 内容轴 column of the 边界类 × 三面 table).
 *
 * Reading, windowing and serialization are the shared core's and are pinned in
 * `tests/traceserver/`. What this file owns is the face: ACI metadata, the
 * schema bounds the executor's ajv gate enforces, and the domain-error → typed
 * error translation carrying **this face's** tool name.
 *
 * Why the SC20 mapping tests live here and not on the MCP face (plan §catch-arm
 * 通则, ACR 四轮): the MCP thin face wraps its whole handler in one catch that
 * renders any thrown error as `isError` text (`src/trace-mcp/server.ts`), so an
 * **unmapped** error still looks handled from that side — the test would pass
 * whether or not the arm exists. Only the ACI face distinguishes a translated
 * `ToolExecutionError` from a bare `Error` escaping through `throw error`, so
 * one test per raisable kind is written against this face.
 */

const scratchPaths: string[] = [];
const RESULT_TEXT = "tool output secret";
const OVERSIZE_NOTE_CHARS = 25_000;

function makeTraceDir(prefix = "iknow-get-record-aci-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchPaths.push(dir);
  return dir;
}

function writeSession(dir: string, conversationId: string, rows: unknown[]) {
  writeFileSync(
    join(dir, `${conversationId}.jsonl`),
    rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
    "utf8"
  );
}

afterEach(() => {
  for (const path of scratchPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

/** 一条带单个 tool_result part（`RESULT_TEXT`，18 字符）的可寻址记录。 */
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
 * 最大合法窗 + 一条本身就超过 backstop 的记录标量。用来证「ACI 面没有任何工具级
 * 字符帽」：本夹具的返回体远超 `TRACE_OUTPUT_BACKSTOP`，任何在薄皮上施加的帽都会
 * 立刻把它切掉。
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

/** 扫到 `TRACE_RECORD_ID_SCAN_LIMIT` 仍未命中：与行轴同法写满 10 001 行，不注入 reader。 */
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

    // 单源：两张皮共用核里那一份文案，本面不得自己拼一段。
    assert.equal(tool.description, GET_RECORD_DESCRIPTION);
    // SC7 第三条判据：description 不含任何字符帽表述。文案不提帽很容易，容易的是
    // 日后有人「顺手补一句最多 N 字符」，所以这里正向锁一次而不是靠 review 记着。
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
    // Assumption 4：本面没有「缺省 = 最近活跃会话」，两个 id 都是必填。
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

    // 「同值」不能只写在 schema 里：核必须用同一对界复查，否则薄皮漏守时没人守。
    // 这里越界走的是 handler（executor 之前那一层），消息形状即核的 `validation`。
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

  it("is assembled last in the registry and its bounds are enforced by ajv", () => {
    const reg = createDefaultAciRegistry({
      env: { web: { searchUrl: undefined, proxy: undefined } },
      sandboxRoot: makeRecordDir(),
    });
    const validator = reg.inner.getValidator("get_record");

    // T6 append-only：内容轴是新的末位（`list_sessions` 仍在尾部区间，见
    // list-sessions.test.ts 对同一件事的断言）。
    assert.equal(ACI_TOOLSET_NAMES.at(-1), "get_record");
    assert.equal(reg.inner.list().at(-1)?.name, "get_record");
    assert.equal(reg.catalog.get("get_record")?.name, "get_record");
    assert.ok(validator, "the registry must compile a validator for the tool");
    assert.equal(validator!({ conversation_id: "c1" }), false); // record_id 必填
    assert.equal(validator!({ record_id: "r" }), false); // conversation_id 必填
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
  });

  // ── SC20：本面可抛的每个 kind 一条映射测 ───────────────────────────────
  // 六条 = plan typed-error 表的五个 kind + reader 既有的 `io_error`
  // （`TraceReadError`，src/traceserver/types.ts）。每条都要求错误真被翻译成
  // `ToolExecutionError` 子类并带上调用方下一步要用的字段；少一条臂就是 ACI 面上
  // 泄漏一个裸 `Error`，而 MCP 面的兜底 catch 会把这种泄漏照显示成 `isError` 文本
  // （plan §catch-arm 通则），所以只有这里能证明臂存在。

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
        // 判据是「窗必须整个落在 part 内」（plan 第 14 条），所以正确回答是
        // 「改坐标就能读全」，不是「顺手给一页截好的」：任何 part 正文出现在错误里
        // 都意味着本 kind 存在的理由被实现自己推翻了。
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
    // 两条主张不同：「这个会话没被读到」vs「读完了，没有这条」。合成一个 kind 就会
    // 把前者说成后者，所以各占一条测（plan 第 14 条把该 kind 从 T7 前移到 T6）。
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
    // 扫帽分支要写满并扫完 10 001 行：与行轴同一条测一样超时放宽（实测同夹具
    // 单跑约 4~6 s），不动 vitest.config.ts 的全局 testTimeout。
  }, 120_000);

  it("maps the reader's `io_error` (TraceReadError) instead of leaking it bare", async () => {
    // `get_record` 先用 existsSync 判会话在不在，所以把 `<conversation_id>.jsonl`
    // 造成一个**目录**就能越过 session 判定、在 reader 里确定性地拿到 EISDIR ——
    // 不需要 root 或 chmod，CI 安全。这是本面第六条（也是唯一非 typed 表的）路。
    const dir = makeTraceDir("iknow-get-record-aci-io-");
    mkdirSync(join(dir, "c1.jsonl"));
    const tool = createGetRecordTool({ traceDir: dir });

    await assert.rejects(
      () => tool.handler({ conversation_id: "c1", record_id: "llm-target" }),
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        // 本 kind 刻意复用基类：IO 失败不是参数问题，所以不带 `field`；仓库的
        // `ToolExecutionError` 本身没有 `kind` 通道（同 query_trace / list_sessions
        // 对 IO 的裁定）。
        !(error instanceof GetRecordValidationError) &&
        !(error instanceof GetRecordNotFoundError) &&
        !(error instanceof GetRecordSessionNotFoundError) &&
        !(error instanceof GetRecordScanError) &&
        !(error instanceof GetRecordWindowOverflowError) &&
        error.message === "get_record: trace file read failed: EISDIR"
    );
  });

  it("prefixes its own tool name over a core that names no tool (SC16)", async () => {
    // 前缀归薄皮、核消息归核（plan §前缀归属）。两头都在这里钉：核那侧证明消息里
    // 一个工具名都没有（所以薄皮漏加前缀就是真的没人点名），薄皮这侧证明恰好加一次
    // （漏了 `strip` 就会打双前缀）。五个便宜 kind 逐个比对；record_scan 要扫满
    // 10 001 行，它的完整消息已由上面那条测逐字钉住。
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
    // ADR-0006 D6：工具级管「读多少」（这里是 `count` 这个 read unit），executor
    // 管「输出不超多少」。所以本面既不得给自己加帽，也不得提前套 MCP 面那个
    // `TRACE_OUTPUT_BACKSTOP` —— 加了就是 ADR-0006:29 禁止的双层截断。
    //
    // 夹具故意让返回体远超 `TRACE_OUTPUT_BACKSTOP`（一条 25 000 字符的记录标量 +
    // 一个满额窗），于是「薄皮自己没帽」这件事在这里是可伪的：任何在 ACI 面上施加
    // 的帽都会让下面的整发返回断言红。
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
    // `count` 是真正的 read unit：满额窗一字不差地回来。
    assert.equal(body.text.length, GET_RECORD_MAX_COUNT);
    assert.equal(body.count, GET_RECORD_MAX_COUNT);
    assert.equal(body.part_chars, GET_RECORD_MAX_COUNT);
    assert.equal(body.record.oversize_note.length, OVERSIZE_NOTE_CHARS);
    assert.ok(!output.endsWith("...[truncated]"));
  });
});
  it("carries role on detail=messages manifest parts through the ACI face (v1.2 判据 a)", async () => {
    // v1.2 判据 (a): detail=messages 清单臂每个 part 携带所属 message 的 role.
    // 通过 ACI 工具调用路径验证投影的 part 列表中每条都带 role.
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

    // 3 parts, roles 跟随所属 message: [user, assistant, user]
    assert.equal(body.parts.length, 3);
    assert.equal(body.parts[0]?.role, "user");
    assert.equal(body.parts[1]?.role, "assistant");
    assert.equal(body.parts[2]?.role, "user");
  });

  it("omits role on detail=tool_results manifest parts (tool_result 按定义在 user 侧)", async () => {
    // v1.2 判据 (a) 收尾: tool_results parts 上**不加** role (与 messages
    // 臂对照, 钉住「缺席」而非 null/undefined).
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
    // 窗正文寻址已有 message_index, role 在清单臂给出. 窗臂不添 role.
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

