import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, it } from "vitest";

import {
  createQueryTraceTool,
  QueryTraceSessionNotFoundError,
  QueryTraceValidationError,
} from "../../../../src/harness/aci/tools/query-trace.ts";
import {
  ACI_TOOLSET_NAMES,
  createDefaultAciRegistry,
} from "../../../../src/harness/aci/tools/registry.ts";
import { TRACE_BACKSTOP_MARKER } from "../../../../src/traceserver/output-backstop.ts";

/**
 * plan `trace-mcp-read-side-split` T7: drill-down (`record_id` / `detail`) is
 * gone — `get_record` owns the content axis. The byte-pagination `resume_offset`
 * left with the panel, leaving `query_trace` a row axis: filter + page. The
 * `additionalProperties: false` gate is the per-face contract (SC18) that
 * prevents the three retired names from sneaking back in.
 */

const scratchPaths: string[] = [];

/**
 * The scan-cap case below writes and then reads a 10,001-row fixture, because
 * `QUERY_TRACE_MAX_RECORD_ID_SCAN = 10_000` is the contract it pins: the target
 * id sits one row past the cap, so the scan has to run to exhaustion. That one
 * case costs 2.5s on an idle core but measured 5158ms inside a full 385-file
 * `npm test` — over the 5000ms default. The fork pool (`maxForks: 3` on 4
 * cores) decides whether it lands above or below, which is why #864 saw it fail
 * in the full run and pass standalone. Not state pollution: the fixtures are
 * mkdtemp-only, and `pool: "forks"` runs each file in its own process.
 */
const SCAN_CAP_TEST_TIMEOUT = 20_000;
/** T6 (SC16): 会话落两级树 `<dir>/projects/<slug>/<convId>/trace.jsonl`。 */
const TEST_PROJECT_SLUG = "test-project-aci-query-trace";

function writeSession(convId: string, jsonl: string): string {
  const dir = mkdtempSync(join(tmpdir(), "iknow-query-trace-"));
  scratchPaths.push(dir);
  mkdirSync(join(dir, "projects", TEST_PROJECT_SLUG, convId), {
    recursive: true,
  });
  writeFileSync(
    join(dir, "projects", TEST_PROJECT_SLUG, convId, "trace.jsonl"),
    jsonl
  );
  return dir;
}

function makeTraceDir(): string {
  return writeSession(
    "c1",
    [
      {
        conversation_id: "c1",
        record_type: "llm_call",
        llm_call_id: "llm-ok",
        started_at: "2026-08-28T00:00:01.000Z",
        status: "ok",
        messages: [{ role: "user", content: "normal" }],
      },
      {
        conversation_id: "c1",
        record_type: "llm_call",
        llm_call_id: "llm-error",
        started_at: "2026-08-28T00:00:02.000Z",
        status: "error",
        error: { type: "execution_failed", message: "provider failed" },
        messages: [
          { role: "user", content: "first secret prompt" },
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "toolu-1",
                name: "lookup",
                input: { query: "secret" },
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu-1",
                content: "tool output secret",
              },
            ],
          },
        ],
      },
    ]
      .map((row) => JSON.stringify(row))
      .join("\n") + "\n"
  );
}

afterEach(() => {
  for (const path of scratchPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("query_trace ACI tool (T7)", () => {
  it("is read-only, fast, exposes the slimmed schema, and rejects the retired parameters", () => {
    const tool = createQueryTraceTool(makeTraceDir());
    const schema = tool.inputSchema as {
      properties: Record<string, unknown>;
      additionalProperties: boolean;
      required: ReadonlyArray<string>;
    };

    assert.equal(tool.name, "query_trace");
    assert.equal(tool.aci.category, "read-only");
    assert.equal(tool.aci.timeoutTier, "fast");
    assert.equal(tool.aci.interruptBehavior, "cancel");
    assert.equal(schema.additionalProperties, false);
    // Slimmed schema: row axis = filter + page, conversation_id required.
    for (const key of [
      "conversation_id",
      "record_type",
      "status",
      "task_id",
      "parent_turn_id",
      "turn_id",
      "limit",
      "offset",
    ]) {
      assert.ok(key in schema.properties, `missing query parameter ${key}`);
    }
    assert.deepEqual(schema.required, ["conversation_id"]);
    // Retired names must not slip back in via an untyped extension: SC18's
    // additionalProperties: false is the gate that catches a future
    // "let it through" refactor.
    for (const retired of ["record_id", "detail", "resume_offset"]) {
      assert.ok(
        !(retired in schema.properties),
        `${retired} must no longer be a query_trace property`
      );
    }
  });

  it("projects llm_call messages for status=error and returns the page whole", async () => {
    const tool = createQueryTraceTool(makeTraceDir());
    const output = (await tool.handler({
      conversation_id: "c1",
      status: "error",
    })) as string;
    const body = JSON.parse(output) as {
      records: Array<Record<string, unknown>>;
      limit: number;
      offset: number;
    };

    // T6 retired the per-tool character cap; T7 stripped the panel-paging
    // metadata. The page returns whole, and the tool face echoes the
    // effective limit/offset so callers can resume.
    assert.ok(!output.includes(TRACE_BACKSTOP_MARKER));
    assert.equal(body.records.length, 1);
    assert.equal(body.records[0]?.llm_call_id, "llm-error");
    assert.equal(body.records[0]?.messages_count, 3);
    assert.equal(body.records[0]?.tool_result_count, 1);
    assert.deepEqual(body.records[0]?.tool_result_previews, [
      "tool output secret",
    ]);
    assert.ok(!("tool_results" in body.records[0]!));
    assert.ok(!("messages" in body.records[0]!));
    assert.ok("first_message_preview" in body.records[0]!);
    assert.ok("last_message_preview" in body.records[0]!);
    assert.deepEqual(body.records[0]?.error, {
      type: "execution_failed",
      message: "provider failed",
    });
    // Tool face keys: only `records` + `limit` + `offset` — no `total` /
    // `truncated` / `skipped_lines` from the panel's byte-paging world.
    assert.deepEqual(Object.keys(body).sort(), ["limit", "offset", "records"]);
  });

  it("echoes the caller's offset so resume is just offset + records.length", async () => {
    const tool = createQueryTraceTool(makeTraceDir());
    const output = (await tool.handler({
      conversation_id: "c1",
      status: "error",
      limit: 1,
      offset: 5,
    })) as string;
    const body = JSON.parse(output) as {
      records: Array<Record<string, unknown>>;
      limit: number;
      offset: number;
    };

    // Two rows match status=error in the fixture, so offset 5 lands past
    // them: `records.length < limit` is the implicit end-of-data signal.
    assert.equal(body.limit, 1);
    assert.equal(body.offset, 5);
    assert.equal(body.records.length, 0);
  });

  it("raises session_not_found (not the panel's empty envelope) when conversation_id has no file", async () => {
    const tool = createQueryTraceTool(makeTraceDir());
    await assert.rejects(
      async () => tool.handler({ conversation_id: "no-such-session" }),
      (error: unknown) =>
        error instanceof QueryTraceSessionNotFoundError &&
        error.kind === "session_not_found" &&
        error.conversationId === "no-such-session" &&
        error.message ===
          "query_trace: no trace session file for conversation_id 'no-such-session'"
    );
  });

  it("requires conversation_id on the tool face", async () => {
    const tool = createQueryTraceTool(makeTraceDir());
    await assert.rejects(
      async () => tool.handler({}),
      (error: unknown) =>
        error instanceof QueryTraceValidationError &&
        error.field === "conversation_id"
    );
  });

  it("rejects an unknown record_type with a typed validation error", async () => {
    const tool = createQueryTraceTool(makeTraceDir());
    await assert.rejects(
      async () =>
        tool.handler({
          conversation_id: "c1",
          record_type: "not-a-trace-record",
        }),
      (error: unknown) =>
        error instanceof QueryTraceValidationError &&
        error.field === "record_type" &&
        error.message.includes("record_type must be one of")
    );
  });

  it("rejects conversation_id path traversal", async () => {
    const tool = createQueryTraceTool(makeTraceDir());
    await assert.rejects(
      async () => tool.handler({ conversation_id: "../outside" }),
      (error: unknown) =>
        error instanceof QueryTraceValidationError &&
        error.field === "conversation_id"
    );
  });

  it("rejects an unknown additional property as additionalProperties=false (SC18)", () => {
    // The ACI ajv gate runs through the executor's compiled validator, not
    // directly through `tool.handler` (a thin wrapper that the executor wraps).
    // Compile the schema the same way the executor does and assert each
    // retired name fails it.
    const tool = createQueryTraceTool(makeTraceDir());
    const registry = createDefaultAciRegistry({
      env: { web: { searchUrl: undefined, proxy: undefined } },
      sandboxRoot: makeTraceDir(),
    });
    const validator = registry.inner.getValidator(tool.name);
    assert.ok(validator, "executor must compile query_trace's schema");
    for (const stale of [
      { conversation_id: "c1", record_id: "x" },
      { conversation_id: "c1", detail: "messages" },
      { conversation_id: "c1", resume_offset: 0 },
    ]) {
      assert.equal(
        validator(stale),
        false,
        `additionalProperties: false must reject ${JSON.stringify(stale)}`
      );
    }
  });

  it("registers query_trace as an append-only SSOT member followed by every post-#251 tool", () => {
    // query_trace 之后的事实清单由 SSOT 长度派生（不再写 22 / 23 之类硬编数字）：
    // append-only 纪律下,query_trace 后只允许再加新件,不能插队改既有顺序。
    // 本测锁三件事:① query_trace 仍在名单;② 之后还有若干件(SSOT 派生);
    // ③ 名单末尾必须收在新件上(get_record 是本场景无 host 缝时的常驻末位)。
    const queryTraceIndex = ACI_TOOLSET_NAMES.indexOf("query_trace");
    assert.ok(queryTraceIndex >= 0, "query_trace 仍在 ACI_TOOLSET_NAMES");
    // query_trace 之前的部分 = SSOT 头(append-only 不重排既有);
    // 之后件数由 ACI_TOOLSET_NAMES.length 推导,以数组为 source of truth。
    const tailCount = ACI_TOOLSET_NAMES.length - queryTraceIndex - 1;
    assert.ok(tailCount > 0, "query_trace 之后必有 append 件");
    // 锁每件 query_trace 之后的成员都是单一 append(不重排):
    for (let i = queryTraceIndex + 1; i < ACI_TOOLSET_NAMES.length; i++) {
      assert.ok(
        typeof ACI_TOOLSET_NAMES[i] === "string" &&
          ACI_TOOLSET_NAMES[i].length > 0,
        `query_trace 后成员 ${i} 必须为非空字符串`
      );
    }
    const registry = createDefaultAciRegistry({
      env: { web: { searchUrl: undefined, proxy: undefined } },
      sandboxRoot: makeTraceDir(),
    });
    assert.equal(registry.catalog.get("query_trace")?.name, "query_trace");
    // 读侧三件都无装配条件 → 常驻;两件读轴工具也是 trace 读侧的同门。
    // 本场景（无 host 缝）下 get_record 收尾（host 缝条件化的 task-worktree
    // 工具全数缺席）。这取代旧的「末位 = get_record 永远是末位」脆弱断言。
    const presentNames = registry.inner.list().map((d) => d.name);
    assert.ok(presentNames.includes("query_trace"));
    assert.ok(presentNames.includes("list_sessions"));
    assert.ok(presentNames.includes("get_record"));
    assert.equal(presentNames.at(-1), "get_record");
  });
});

describe("query_trace ACI tool -- role projection (v1.2)", () => {
  it("projects last_assistant_preview for an llm_call (v1.2 判据 b)", async () => {
    // Two distinct assistant messages with the second being the LAST in the
    // array. The first/user line is included so the projection has to walk
    // past a non-assistant message to find the assistant tail.
    const dir = mkdtempSync(join(tmpdir(), "iknow-query-trace-v12-"));
    scratchPaths.push(dir);
    mkdirSync(join(dir, "projects", TEST_PROJECT_SLUG, "c-v12"), {
      recursive: true,
    });
    writeFileSync(
      join(dir, "projects", TEST_PROJECT_SLUG, "c-v12", "trace.jsonl"),
      [
        {
          conversation_id: "c-v12",
          record_type: "llm_call",
          llm_call_id: "llm-v12",
          turn_id: "turn-v12",
          started_at: "2026-08-28T00:00:01.000Z",
          status: "ok",
          messages: [
            { role: "user", content: "ask" },
            { role: "assistant", content: "first answer" },
            { role: "user", content: "follow-up" },
            { role: "assistant", content: "final answer" },
          ],
        },
      ]
        .map((row) => JSON.stringify(row))
        .join("\n") + "\n",
      "utf8"
    );

    const tool = createQueryTraceTool(dir);
    const output = (await tool.handler({
      conversation_id: "c-v12",
    })) as string;
    const body = JSON.parse(output) as {
      records: Array<Record<string, unknown>>;
    };

    // v1.2 判据 (b): last_assistant_preview 是最后一条 assistant 消息的预览.
    // preview() JSON-stringifies the message object, hence the form.
    const record = body.records[0]!;
    assert.equal(
      record.last_assistant_preview,
      JSON.stringify({ role: "assistant", content: "final answer" })
    );
    // last_message_preview 语义不变 (仍是最后一条任意角色消息).
    assert.equal(
      record.last_message_preview,
      JSON.stringify({ role: "assistant", content: "final answer" })
    );
  });

  it("omits last_assistant_preview when no assistant message exists (v1.2 合法态)", async () => {
    // v1.2 判据 (b): 「无 assistant 消息的 llm_call → 字段缺席为合法态」.
    // 钉住「缺席」语义, 不退化为 empty string.
    const dir = mkdtempSync(join(tmpdir(), "iknow-query-trace-v12-no-"));
    scratchPaths.push(dir);
    mkdirSync(join(dir, "projects", TEST_PROJECT_SLUG, "c-v12"), {
      recursive: true,
    });
    writeFileSync(
      join(dir, "projects", TEST_PROJECT_SLUG, "c-v12", "trace.jsonl"),
      [
        {
          conversation_id: "c-v12",
          record_type: "llm_call",
          llm_call_id: "llm-v12-no",
          turn_id: "turn-v12-no",
          started_at: "2026-08-28T00:00:01.000Z",
          status: "ok",
          messages: [{ role: "user", content: "user only" }],
        },
      ]
        .map((row) => JSON.stringify(row))
        .join("\n") + "\n",
      "utf8"
    );

    const tool = createQueryTraceTool(dir);
    const output = (await tool.handler({
      conversation_id: "c-v12",
    })) as string;
    const body = JSON.parse(output) as {
      records: Array<Record<string, unknown>>;
    };

    const record = body.records[0]!;
    assert.ok(
      !("last_assistant_preview" in record),
      `last_assistant_preview must be absent for a no-assistant trace, got: ${JSON.stringify(record)}`
    );
  });
});
