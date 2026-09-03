import assert from "node:assert/strict";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, it } from "vitest";

import { ToolExecutionError } from "../../../../src/harness/errors.ts";
import {
  createListSessionsTool,
  ListSessionsValidationError,
} from "../../../../src/harness/aci/tools/list-sessions.ts";
import {
  ACI_TOOLSET_NAMES,
  createDefaultAciRegistry,
} from "../../../../src/harness/aci/tools/registry.ts";
import {
  LIST_SESSIONS_DEFAULT_LIMIT,
  LIST_SESSIONS_MAX_LIMIT,
  LIST_SESSIONS_DESCRIPTION,
} from "../../../../src/traceserver/list-sessions-core.ts";

/**
 * `list_sessions` on the ACI face (plan `trace-mcp-read-side-split` T5b,
 * spec SC16 / SC20 and the 目录轴 column of the 边界类 × 三面 table).
 *
 * This face owns three things and nothing else: the ACI metadata, the schema
 * bounds the executor's ajv validator enforces, and the domain-error → typed
 * error translation with **this face's** tool name prefixed. Reading, ordering
 * and paging are the shared core's (tests/traceserver/list-sessions-core.test.ts
 * pins those), so nothing here re-tests them.
 */

const scratchPaths: string[] = [];

afterEach(() => {
  for (const path of scratchPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function makeTraceDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "iknow-list-sessions-aci-"));
  scratchPaths.push(dir);
  const base = 1_600_000_000;
  for (const [name, ageSeconds] of [
    ["older-session", 300],
    ["newer-session", 100],
  ] as const) {
    const path = join(dir, `${name}.jsonl`);
    const body = [
      { record_type: "llm_call", conversation_id: name, llm_call_id: "llm-1" },
      {
        record_type: "session",
        conversation_id: name,
        agent_version: "1.0.0",
      },
    ]
      .map((row) => JSON.stringify(row))
      .join("\n");
    writeFileSync(path, `${body}\n`, "utf8");
    // mtime is what decides the page; the older session is written first so that
    // on a creation-ordered filesystem a readdir-ordered answer comes back
    // reversed, and the expectation below cannot pass by luck of directory order.
    const at = new Date((base - ageSeconds) * 1000);
    utimesSync(path, at, at);
  }
  return dir;
}

describe("list_sessions ACI tool", () => {
  it("carries the read-only ACI metadata this axis needs", () => {
    const tool = createListSessionsTool(makeTraceDir());

    assert.equal(tool.name, "list_sessions");
    assert.equal(tool.aci.category, "read-only");
    assert.equal(tool.aci.isConcurrencySafe, true);
    assert.equal(tool.aci.interruptBehavior, "cancel");
    assert.equal(tool.aci.timeoutTier, "fast");
  });

  it("reuses the core's description text verbatim — one source for both faces", () => {
    const tool = createListSessionsTool(makeTraceDir());

    assert.equal(tool.description, LIST_SESSIONS_DESCRIPTION);
  });

  it("declares the same bounds the core re-validates, so neither face drifts", () => {
    const tool = createListSessionsTool(makeTraceDir());
    const schema = tool.inputSchema as {
      type: string;
      additionalProperties: boolean;
      properties: {
        limit: {
          type: string;
          minimum: number;
          maximum: number;
          default: number;
        };
        offset: { type: string; minimum: number; default: number };
      };
    };

    assert.equal(schema.type, "object");
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(schema.properties.limit, {
      type: "integer",
      minimum: 1,
      maximum: LIST_SESSIONS_MAX_LIMIT,
      default: LIST_SESSIONS_DEFAULT_LIMIT,
    });
    assert.deepEqual(schema.properties.offset, {
      type: "integer",
      minimum: 0,
      default: 0,
    });
  });

  it("answers with the newest session first, echoing coordinates only", async () => {
    const tool = createListSessionsTool(makeTraceDir());
    const raw = (await tool.handler({})) as string;
    const body = JSON.parse(raw) as {
      sessions: Array<Record<string, unknown>>;
      limit: number;
      offset: number;
    };

    assert.deepEqual(Object.keys(body), ["sessions", "limit", "offset"]);
    assert.deepEqual(
      body.sessions.map((s) => s["conversation_id"]),
      ["newer-session", "older-session"]
    );
    // The echo is what makes `sessions.length < limit` testable here, since this
    // call omitted limit and only the core knows the default it applied.
    assert.deepEqual(
      { limit: body.limit, offset: body.offset },
      { limit: LIST_SESSIONS_DEFAULT_LIMIT, offset: 0 }
    );
    // 契约 X (ADR-0004:23): the executor owns output-size reporting, so this face
    // must not grow a truncation field of its own.
    for (const banned of ["total", "truncated", "response_truncated"]) {
      assert.ok(!raw.includes(banned), `"${banned}" leaked into the response`);
    }
    assert.deepEqual(Object.keys(body.sessions[0]!).sort(), [
      "agent_version",
      "conversation_id",
      "mtime",
      "size",
    ]);
  });

  it("cuts the page the caller asked for", async () => {
    const tool = createListSessionsTool(makeTraceDir());

    const first = JSON.parse((await tool.handler({ limit: 1 })) as string) as {
      sessions: Array<Record<string, unknown>>;
    };
    const second = JSON.parse(
      (await tool.handler({ limit: 1, offset: 1 })) as string
    ) as { sessions: Array<Record<string, unknown>> };

    assert.deepEqual(
      first.sessions.map((s) => s["conversation_id"]),
      ["newer-session"]
    );
    assert.deepEqual(
      second.sessions.map((s) => s["conversation_id"]),
      ["older-session"]
    );
  });

  it("maps a core validation rejection onto this face's name (SC16)", async () => {
    // Called through the handler, this is the route the executor's ajv gate
    // would normally stop earlier; it stays pinned because the core is the
    // second authority, and because SC20 counts one catch arm per kind.
    // Measured: the ajv gate's own text is `[validation_failed] invalid input
    // at /limit: must be >= 1` — no tool name at all (executor.ts:316-321 +
    // tool-result.ts:42, and that shape is shared by every live tool). So SC16
    // claims the prefix for errors leaving *this face's* catch arm, which is
    // what this case exercises, not for the schema gate in front of it.
    const tool = createListSessionsTool(makeTraceDir());

    await assert.rejects(
      () => tool.handler({ limit: 0 }),
      (error: unknown) =>
        error instanceof ListSessionsValidationError &&
        error instanceof ToolExecutionError &&
        error.kind === "validation" &&
        error.field === "limit" &&
        error.message ===
          `list_sessions: limit must be an integer in 1..${LIST_SESSIONS_MAX_LIMIT}`,
      "expected a list_sessions-prefixed validation error"
    );
  });

  it("maps TraceReadError instead of leaking it bare (catch-arm 通则)", async () => {
    // A regular file standing where the trace directory should be is the one
    // deterministic IO failure reachable without root or chmod, so it is CI-safe.
    const dir = mkdtempSync(join(tmpdir(), "iknow-list-sessions-aci-filedir-"));
    scratchPaths.push(dir);
    const asFile = join(dir, "not-a-dir.jsonl");
    writeFileSync(asFile, '{"record_type":"session"}\n', "utf8");
    const tool = createListSessionsTool({ traceDir: asFile });

    await assert.rejects(
      () => tool.handler({}),
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        !(error instanceof ListSessionsValidationError) &&
        error.message === "list_sessions: trace file read failed: ENOTDIR",
      "expected a list_sessions-prefixed ToolExecutionError"
    );
  });

  it("is assembled unconditionally right before the content axis, and its schema bounds are enforced", () => {
    const reg = createDefaultAciRegistry({
      env: { web: { searchUrl: undefined, proxy: undefined } },
      sandboxRoot: makeTraceDir(),
    });
    const validator = reg.inner.getValidator("list_sessions");

    // append-only 仍生效：list_sessions 是目录轴读工具（无 host 缝条件），
    // get_record 是内容轴读工具（同形态常驻）。断言改用 SSOT 派生的索引对：
    // list_sessions 与 get_record 在 ACI_TOOLSET_NAMES 中相邻且前后顺序固定,
    // 位置由 indexOf 推导（不写死 at(-N) 之类的硬编码下标;task-worktree-lifecycle
    // #869 在末尾再 append 2 件 host 缝条件化装配的 list/remove,使硬编码下标
    // 立刻过期）。
    const listSessionsIdx = ACI_TOOLSET_NAMES.indexOf("list_sessions");
    const getRecordIdx = ACI_TOOLSET_NAMES.indexOf("get_record");
    assert.ok(listSessionsIdx >= 0, "list_sessions 仍在 SSOT");
    assert.ok(getRecordIdx >= 0, "get_record 仍在 SSOT");
    assert.equal(
      getRecordIdx - listSessionsIdx,
      1,
      "list_sessions 必须紧邻 get_record 之前（append-only 不重排）"
    );
    assert.equal(reg.inner.list().at(-2)?.name, "list_sessions");
    assert.equal(reg.inner.list().at(-1)?.name, "get_record");
    assert.equal(reg.catalog.get("list_sessions")?.name, "list_sessions");
    assert.ok(validator, "the registry must compile a validator for the tool");
    // 界真的由 ajv 执行，不只是写在 schema 里：这是 ACI 面拒 `limit: 0` 的那道门。
    assert.equal(validator!({ limit: 0 }), false);
    assert.equal(validator!({ limit: LIST_SESSIONS_MAX_LIMIT }), true);
    assert.equal(validator!({ offset: -1 }), false);
    assert.equal(validator!({ unknown_axis: 1 }), false);
    // append-only SSOT 纪律：行轴 query_trace 必须排在 list_sessions 之前；
    // 这是「后来者不能悄悄把它打乱」的可测不变式。
    assert.ok(
      ACI_TOOLSET_NAMES.indexOf("query_trace") < listSessionsIdx,
      "query_trace (行轴) 必须在 list_sessions (目录轴) 之前"
    );
  });
});
