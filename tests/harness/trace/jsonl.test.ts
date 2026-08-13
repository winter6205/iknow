/**
 * createJsonlTraceService (T3, GH #64).
 *
 * 10 项契约 (spec §Testing Strategy + 判据 6/7/10/15):
 * 1. snake_case 转换 (camelCase TS 字段 → snake_case JSONL key)
 * 2. 单行合法 JSONL (每行 JSON.parse 成功, 无嵌入换行)
 * 3. parent_llm_call_id: null (parentLlmCallId=undefined → 字面 null)
 * 4. 写盘失败不抛 (always-throw writer → recordXxx 返回 undefined)
 * 5. console.warn 一次 (多次失败 → 只 warn 一次)
 * 6. 三方法返回 string | undefined (成功 string UUID, 失败 undefined)
 * 7. conversation_id 每行存在 (实例绑定)
 * 8. record_type 判别器 (llm_call / tool_call / turn)
 * 9. 真实 FS 测试 (mkdtempSync + appendFileSync 实际写盘 + statSync size > 0)
 * 10. 不 fsync (代码审查, 非测试)
 */

import { describe, it, beforeEach, afterEach, vi } from "vitest";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  existsSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createJsonlTraceService } from "../../../src/harness/trace/jsonl.ts";
import {
  clearActiveExtraSecrets,
  setActiveExtraSecrets,
} from "../../../src/harness/sandbox/env-isolation.ts";
import type {
  LlmCallRecord,
  ToolCallRecord,
  TurnRecord,
  SessionRecord,
  SandboxCmdRecord,
} from "../../../src/harness/trace/types.ts";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const SAMPLE_LLM: LlmCallRecord = {
  startedAt: "2026-07-31T00:00:00.000Z",
  endedAt: "2026-07-31T00:00:01.000Z",
  durationMs: 1000,
  supplierStop: "success",
  stream: false,
  messagesCaptured: true,
  messages: [{ role: "user", content: "hi" }],
  status: "ok",
};

const SAMPLE_TOOL: ToolCallRecord = {
  parentLlmCallId: "llm-1",
  toolName: "echo",
  toolKind: "ok",
  startedAt: "2026-07-31T00:00:00.000Z",
  endedAt: "2026-07-31T00:00:00.500Z",
  durationMs: 500,
  argumentsCaptured: true,
  arguments: { foo: "bar" },
  resultCaptured: true,
  result: { ok: true },
  status: "ok",
};

const SAMPLE_TURN: TurnRecord = {
  turnIndex: 0,
  startedAt: "2026-07-31T00:00:00.000Z",
  endedAt: "2026-07-31T00:00:01.000Z",
  durationMs: 1000,
  llmCallIds: ["llm-1"],
  toolCallIds: ["tool-1"],
  decision: "completed",
  status: "ok",
};

const SAMPLE_SESSION: SessionRecord = {
  startedAt: "2026-07-31T00:00:00.000Z",
  endedAt: "2026-07-31T00:01:00.000Z",
  durationMs: 60000,
  agentVersion: "0.20.0",
  status: "ok",
};

const SAMPLE_CMD: SandboxCmdRecord = {
  parentTurnId: "turn-1",
  command: "ls -la",
  exitCode: 0,
  stdoutCaptured: true,
  stdout: "total 0",
  startedAt: "2026-07-31T00:00:00.000Z",
  endedAt: "2026-07-31T00:00:00.100Z",
  durationMs: 100,
  status: "ok",
};

function captureWriter(): {
  lines: string[];
  writer: (line: string) => void;
} {
  const lines: string[] = [];
  return {
    lines,
    writer: (line: string): void => {
      lines.push(line);
    },
  };
}

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "iknow-trace-jsonl-"));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("createJsonlTraceService — snake_case 转换", () => {
  it("recordLlmCall: camelCase TS 字段 → snake_case JSONL key", async () => {
    const { lines, writer } = captureWriter();
    const svc = createJsonlTraceService({
      filePath: join(scratch, "trace.jsonl"),
      conversationId: "conv-1",
      writer,
    });
    await svc.recordLlmCall(SAMPLE_LLM);
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]) as Record<string, unknown>;
    assert.equal(parsed.started_at, SAMPLE_LLM.startedAt);
    assert.equal(parsed.ended_at, SAMPLE_LLM.endedAt);
    assert.equal(parsed.duration_ms, SAMPLE_LLM.durationMs);
    assert.equal(parsed.supplier_stop, SAMPLE_LLM.supplierStop);
    assert.equal(parsed.messages_captured, SAMPLE_LLM.messagesCaptured);
    assert.equal(parsed.stream, SAMPLE_LLM.stream);
    assert.equal(parsed.status, SAMPLE_LLM.status);
    assert.ok(parsed.llm_call_id !== undefined);
    assert.equal(parsed.conversation_id, "conv-1");
    assert.equal(parsed.record_type, "llm_call");
    assert.equal(parsed.startedAt, undefined);
    assert.equal(parsed.durationMs, undefined);
  });

  it("recordToolCall: camelCase TS 字段 → snake_case JSONL key", async () => {
    const { lines, writer } = captureWriter();
    const svc = createJsonlTraceService({
      filePath: join(scratch, "trace.jsonl"),
      conversationId: "conv-1",
      writer,
    });
    await svc.recordToolCall(SAMPLE_TOOL);
    const parsed = JSON.parse(lines[0]) as Record<string, unknown>;
    assert.equal(parsed.tool_name, SAMPLE_TOOL.toolName);
    assert.equal(parsed.tool_kind, SAMPLE_TOOL.toolKind);
    assert.equal(parsed.started_at, SAMPLE_TOOL.startedAt);
    assert.equal(parsed.ended_at, SAMPLE_TOOL.endedAt);
    assert.equal(parsed.duration_ms, SAMPLE_TOOL.durationMs);
    assert.equal(parsed.arguments_captured, SAMPLE_TOOL.argumentsCaptured);
    assert.equal(parsed.result_captured, SAMPLE_TOOL.resultCaptured);
    assert.equal(parsed.parent_llm_call_id, "llm-1");
    assert.equal(parsed.tool_call_id !== undefined, true);
    assert.equal(parsed.record_type, "tool_call");
    assert.equal(parsed.toolName, undefined);
  });

  it("recordTurn: camelCase TS 字段 → snake_case JSONL key", async () => {
    const { lines, writer } = captureWriter();
    const svc = createJsonlTraceService({
      filePath: join(scratch, "trace.jsonl"),
      conversationId: "conv-1",
      writer,
    });
    await svc.recordTurn(SAMPLE_TURN);
    const parsed = JSON.parse(lines[0]) as Record<string, unknown>;
    assert.equal(parsed.turn_index, SAMPLE_TURN.turnIndex);
    assert.equal(parsed.started_at, SAMPLE_TURN.startedAt);
    assert.equal(parsed.ended_at, SAMPLE_TURN.endedAt);
    assert.equal(parsed.duration_ms, SAMPLE_TURN.durationMs);
    assert.deepEqual(parsed.llm_call_ids, SAMPLE_TURN.llmCallIds);
    assert.deepEqual(parsed.tool_call_ids, SAMPLE_TURN.toolCallIds);
    assert.equal(parsed.decision, SAMPLE_TURN.decision);
    assert.equal(parsed.status, SAMPLE_TURN.status);
    assert.ok(parsed.turn_id !== undefined);
    assert.equal(parsed.record_type, "turn");
    assert.equal(parsed.turnIndex, undefined);
  });

  it("recordLlmCall 带 token 字段: camelCase inputTokens/outputTokens/cacheCreationInputTokens/cacheReadInputTokens → snake_case JSONL key", async () => {
    const { lines, writer } = captureWriter();
    const svc = createJsonlTraceService({
      filePath: join(scratch, "trace.jsonl"),
      conversationId: "conv-tok",
      writer,
    });
    const llmWithUsage: LlmCallRecord = {
      ...SAMPLE_LLM,
      inputTokens: 1234,
      outputTokens: 56,
      cacheCreationInputTokens: 7,
      cacheReadInputTokens: 89,
    };
    await svc.recordLlmCall(llmWithUsage);
    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
    assert.equal(parsed.input_tokens, 1234);
    assert.equal(parsed.output_tokens, 56);
    assert.equal(parsed.cache_creation_input_tokens, 7);
    assert.equal(parsed.cache_read_input_tokens, 89);
    assert.equal(parsed.inputTokens, undefined);
    assert.equal(parsed.outputTokens, undefined);
    assert.equal(parsed.cacheCreationInputTokens, undefined);
    assert.equal(parsed.cacheReadInputTokens, undefined);
  });

  it("recordLlmCall 字段缺席: 行内无任何 *_tokens 键 (Postel 语义, undefined 被 JSON.stringify 丢弃)", async () => {
    const { lines, writer } = captureWriter();
    const svc = createJsonlTraceService({
      filePath: join(scratch, "trace.jsonl"),
      conversationId: "conv-no-tok",
      writer,
    });
    await svc.recordLlmCall(SAMPLE_LLM);
    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
    const keys = Object.keys(parsed);
    for (const k of keys) {
      assert.ok(
        !k.endsWith("_tokens"),
        `expected no *_tokens key in JSONL row, found ${k}: ${lines[0]}`
      );
    }
  });

  it("不递归进 content payload: messages/arguments/result 内部 key 保持原样", async () => {
    const { lines, writer } = captureWriter();
    const svc = createJsonlTraceService({
      filePath: join(scratch, "trace.jsonl"),
      conversationId: "conv-1",
      writer,
    });
    await svc.recordLlmCall(SAMPLE_LLM);
    await svc.recordToolCall(SAMPLE_TOOL);
    const llmParsed = JSON.parse(lines[0]) as Record<string, unknown>;
    const toolParsed = JSON.parse(lines[1]) as Record<string, unknown>;
    const messages = llmParsed.messages as Array<Record<string, unknown>>;
    assert.equal(messages[0]?.role, "user");
    assert.equal(messages[0]?.content, "hi");
    assert.deepEqual(toolParsed.arguments, { foo: "bar" });
    assert.deepEqual(toolParsed.result, { ok: true });
  });
});

describe("createJsonlTraceService — JSONL 行格式", () => {
  it("每行是合法 JSON (JSON.parse 成功)", async () => {
    const { lines, writer } = captureWriter();
    const svc = createJsonlTraceService({
      filePath: join(scratch, "trace.jsonl"),
      conversationId: "conv-1",
      writer,
    });
    await svc.recordLlmCall(SAMPLE_LLM);
    await svc.recordToolCall(SAMPLE_TOOL);
    await svc.recordTurn(SAMPLE_TURN);
    assert.equal(lines.length, 3);
    for (const line of lines) {
      assert.doesNotThrow(() => JSON.parse(line));
    }
  });

  it("每行无嵌入换行 (单行 JSONL)", async () => {
    const { lines, writer } = captureWriter();
    const svc = createJsonlTraceService({
      filePath: join(scratch, "trace.jsonl"),
      conversationId: "conv-1",
      writer,
    });
    await svc.recordLlmCall(SAMPLE_LLM);
    for (const line of lines) {
      assert.equal(
        line.includes("\n"),
        false,
        "line contains newline: " + line
      );
    }
  });

  it("三方法的 record_type 判别器正确 (llm_call / tool_call / turn)", async () => {
    const { lines, writer } = captureWriter();
    const svc = createJsonlTraceService({
      filePath: join(scratch, "trace.jsonl"),
      conversationId: "conv-1",
      writer,
    });
    await svc.recordLlmCall(SAMPLE_LLM);
    await svc.recordToolCall(SAMPLE_TOOL);
    await svc.recordTurn(SAMPLE_TURN);
    const types = lines.map(
      (l) => (JSON.parse(l) as Record<string, unknown>).record_type
    );
    assert.deepEqual(types, ["llm_call", "tool_call", "turn"]);
  });

  it("conversation_id 每行存在 (实例绑定)", async () => {
    const { lines, writer } = captureWriter();
    const svc = createJsonlTraceService({
      filePath: join(scratch, "trace.jsonl"),
      conversationId: "conv-bound",
      writer,
    });
    await svc.recordLlmCall(SAMPLE_LLM);
    await svc.recordToolCall(SAMPLE_TOOL);
    await svc.recordTurn(SAMPLE_TURN);
    for (const line of lines) {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      assert.equal(parsed.conversation_id, "conv-bound");
    }
  });
});

describe("createJsonlTraceService — parent_llm_call_id 字面 null", () => {
  it("parentLlmCallId=undefined → JSONL 里字面 null (key 存在, 值是 null)", async () => {
    const { lines, writer } = captureWriter();
    const svc = createJsonlTraceService({
      filePath: join(scratch, "trace.jsonl"),
      conversationId: "conv-orphan",
      writer,
    });
    const orphan: ToolCallRecord = {
      ...SAMPLE_TOOL,
      parentLlmCallId: undefined,
    };
    await svc.recordToolCall(orphan);
    const parsed = JSON.parse(lines[0]) as Record<string, unknown>;
    assert.ok(
      "parent_llm_call_id" in parsed,
      "key parent_llm_call_id must be present in JSONL"
    );
    assert.equal(parsed.parent_llm_call_id, null);
    assert.notEqual(parsed.parent_llm_call_id, "undefined");
  });

  it("parentLlmCallId 字符串 → JSONL 里字符串透传", async () => {
    const { lines, writer } = captureWriter();
    const svc = createJsonlTraceService({
      filePath: join(scratch, "trace.jsonl"),
      conversationId: "conv-1",
      writer,
    });
    await svc.recordToolCall(SAMPLE_TOOL);
    const parsed = JSON.parse(lines[0]) as Record<string, unknown>;
    assert.equal(parsed.parent_llm_call_id, "llm-1");
  });
});

describe("createJsonlTraceService — 写盘失败处理", () => {
  it("recordLlmCall: always-throw writer → 返回 undefined, 不抛", async () => {
    const svc = createJsonlTraceService({
      filePath: join(scratch, "trace.jsonl"),
      conversationId: "conv-fail",
      writer: (): void => {
        throw new Error("simulated disk failure");
      },
    });
    const result = await svc.recordLlmCall(SAMPLE_LLM);
    assert.equal(result, undefined);
  });

  it("recordToolCall: always-throw writer → 返回 undefined, 不抛", async () => {
    const svc = createJsonlTraceService({
      filePath: join(scratch, "trace.jsonl"),
      conversationId: "conv-fail",
      writer: (): void => {
        throw new Error("simulated disk failure");
      },
    });
    const result = await svc.recordToolCall(SAMPLE_TOOL);
    assert.equal(result, undefined);
  });

  it("recordTurn: always-throw writer → 返回 undefined, 不抛", async () => {
    const svc = createJsonlTraceService({
      filePath: join(scratch, "trace.jsonl"),
      conversationId: "conv-fail",
      writer: (): void => {
        throw new Error("simulated disk failure");
      },
    });
    const result = await svc.recordTurn(SAMPLE_TURN);
    assert.equal(result, undefined);
  });

  it("多次写盘失败 → console.warn 只调用一次 (实例级去重)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const svc = createJsonlTraceService({
        filePath: join(scratch, "trace.jsonl"),
        conversationId: "conv-warn",
        writer: (): void => {
          throw new Error("fail");
        },
      });
      await svc.recordLlmCall(SAMPLE_LLM);
      await svc.recordLlmCall(SAMPLE_LLM);
      await svc.recordToolCall(SAMPLE_TOOL);
      await svc.recordTurn(SAMPLE_TURN);
      assert.equal(warnSpy.mock.calls.length, 1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("实例 A 失败 warn 后, 实例 B 独立计数", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const failingWriter = (): void => {
        throw new Error("fail");
      };
      const a = createJsonlTraceService({
        filePath: join(scratch, "a.jsonl"),
        conversationId: "conv-a",
        writer: failingWriter,
      });
      const b = createJsonlTraceService({
        filePath: join(scratch, "b.jsonl"),
        conversationId: "conv-b",
        writer: failingWriter,
      });
      await a.recordLlmCall(SAMPLE_LLM);
      await b.recordLlmCall(SAMPLE_LLM);
      assert.equal(warnSpy.mock.calls.length, 2);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("filePath 被同名文件占据 (旧 ./trace.jsonl) → 构造不抛, recordXxx 返回 undefined 不炸 turn", async () => {
    // 回归: 写侧默认曾是 ./trace.jsonl 单文件; T2 目录语义后 mkdirSync 撞旧文件
    // EEXIST 曾在构造期抛出打挂 TUI turn。
    const legacyFile = join(scratch, "trace.jsonl");
    writeFileSync(legacyFile, '{"legacy":"single-file"}\n', "utf8");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const svc = createJsonlTraceService({
        filePath: legacyFile,
        conversationId: "conv-eexist",
      });
      const turnId = await svc.recordTurn(SAMPLE_TURN);
      assert.equal(turnId, undefined, "EEXIST 走 warn-once, 返回 undefined");
      const llmId = await svc.recordLlmCall(SAMPLE_LLM);
      assert.equal(llmId, undefined, "后续记录同样降级, 不抛");
      assert.ok(warnSpy.mock.calls.length >= 1, "失败应 warn 一次");
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("createJsonlTraceService — ID 生成", () => {
  it("recordLlmCall 成功 → 返回 UUID v4 格式 string", async () => {
    const { writer } = captureWriter();
    const svc = createJsonlTraceService({
      filePath: join(scratch, "trace.jsonl"),
      conversationId: "conv-1",
      writer,
    });
    const id = await svc.recordLlmCall(SAMPLE_LLM);
    assert.ok(typeof id === "string");
    assert.match(id, UUID_RE);
  });

  it("recordToolCall 成功 → 返回 UUID v4 格式 string", async () => {
    const { writer } = captureWriter();
    const svc = createJsonlTraceService({
      filePath: join(scratch, "trace.jsonl"),
      conversationId: "conv-1",
      writer,
    });
    const id = await svc.recordToolCall(SAMPLE_TOOL);
    assert.ok(typeof id === "string");
    assert.match(id, UUID_RE);
  });

  it("recordTurn 成功 → 返回 UUID v4 格式 string", async () => {
    const { writer } = captureWriter();
    const svc = createJsonlTraceService({
      filePath: join(scratch, "trace.jsonl"),
      conversationId: "conv-1",
      writer,
    });
    const id = await svc.recordTurn(SAMPLE_TURN);
    assert.ok(typeof id === "string");
    assert.match(id, UUID_RE);
  });

  it("每次调用生成不同的 ID", async () => {
    const { writer } = captureWriter();
    const svc = createJsonlTraceService({
      filePath: join(scratch, "trace.jsonl"),
      conversationId: "conv-1",
      writer,
    });
    const a = await svc.recordLlmCall(SAMPLE_LLM);
    const b = await svc.recordLlmCall(SAMPLE_LLM);
    assert.ok(typeof a === "string" && typeof b === "string");
    assert.notEqual(a, b);
  });
});

describe("createJsonlTraceService — 真实 FS (T2 每会话独立文件)", () => {
  it("默认 writer: 写 <dir>/<conversationId>.jsonl, statSync size > 0", async () => {
    const svc = createJsonlTraceService({
      filePath: scratch,
      conversationId: "conv-fs",
    });
    const id = await svc.recordLlmCall(SAMPLE_LLM);
    assert.ok(typeof id === "string");
    const filePath = join(scratch, "conv-fs.jsonl");
    const stat = statSync(filePath);
    assert.ok(stat.size > 0, "expected file size > 0, got " + stat.size);
  });

  it("多条记录追加到同一会话文件", async () => {
    const svc = createJsonlTraceService({
      filePath: scratch,
      conversationId: "conv-multi",
    });
    await svc.recordLlmCall(SAMPLE_LLM);
    await svc.recordToolCall(SAMPLE_TOOL);
    await svc.recordTurn(SAMPLE_TURN);
    const filePath = join(scratch, "conv-multi.jsonl");
    const content = readFileSync(filePath, "utf8");
    const lines = content.trim().split("\n");
    assert.equal(lines.length, 3);
    for (const line of lines) {
      assert.doesNotThrow(() => JSON.parse(line));
    }
    const types = lines.map(
      (l) => (JSON.parse(l) as Record<string, unknown>).record_type
    );
    assert.deepEqual(types, ["llm_call", "tool_call", "turn"]);
  });

  it("filePath 是目录: 不生成裸 trace.jsonl, 目录下仅 <convId>.jsonl", async () => {
    const svc = createJsonlTraceService({
      filePath: scratch,
      conversationId: "conv-dir-sem",
    });
    await svc.recordLlmCall(SAMPLE_LLM);
    assert.equal(existsSync(join(scratch, "conv-dir-sem.jsonl")), true);
    assert.equal(
      existsSync(join(scratch, "trace.jsonl")),
      false,
      "no bare trace.jsonl under directory semantics"
    );
  });

  it("不同 conversationId 写到各自独立文件", async () => {
    const a = createJsonlTraceService({
      filePath: scratch,
      conversationId: "conv-a",
    });
    const b = createJsonlTraceService({
      filePath: scratch,
      conversationId: "conv-b",
    });
    await a.recordLlmCall(SAMPLE_LLM);
    await b.recordLlmCall(SAMPLE_LLM);
    assert.equal(existsSync(join(scratch, "conv-a.jsonl")), true);
    assert.equal(existsSync(join(scratch, "conv-b.jsonl")), true);
    const files = readdirSync(scratch).sort();
    assert.deepEqual(files, ["conv-a.jsonl", "conv-b.jsonl"]);
  });

  it("目录不存在时 mkdirSync recursive 自动创建", async () => {
    const nested = join(scratch, "nested", "trace");
    const svc = createJsonlTraceService({
      filePath: nested,
      conversationId: "conv-mkdir",
    });
    await svc.recordLlmCall(SAMPLE_LLM);
    assert.equal(
      existsSync(join(nested, "conv-mkdir.jsonl")),
      true,
      "nested dir must be created recursively"
    );
  });
});

describe("createJsonlTraceService — recordSession (T2)", () => {
  it("成功 → 返回 UUID v4 session_id, 行含 conversation_id + record_type=session", async () => {
    const { lines, writer } = captureWriter();
    const svc = createJsonlTraceService({
      filePath: scratch,
      conversationId: "conv-sess",
      writer,
    });
    const id = await svc.recordSession(SAMPLE_SESSION);
    assert.ok(typeof id === "string");
    assert.match(id, UUID_RE);
    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
    assert.equal(parsed.session_id, id);
    assert.equal(parsed.conversation_id, "conv-sess");
    assert.equal(parsed.record_type, "session");
    assert.equal(parsed.agent_version, "0.20.0");
    assert.equal(parsed.status, "ok");
    assert.equal(parsed.started_at, SAMPLE_SESSION.startedAt);
    assert.equal(parsed.ended_at, SAMPLE_SESSION.endedAt);
    assert.equal(parsed.duration_ms, SAMPLE_SESSION.durationMs);
  });

  it("@throws never: always-throw writer → 返回 undefined, 不抛", async () => {
    const svc = createJsonlTraceService({
      filePath: scratch,
      conversationId: "conv-sess-fail",
      writer: (): void => {
        throw new Error("simulated disk failure");
      },
    });
    const result = await svc.recordSession(SAMPLE_SESSION);
    assert.equal(result, undefined);
  });

  it("真实 FS: 写 <dir>/<convId>.jsonl", async () => {
    const svc = createJsonlTraceService({
      filePath: scratch,
      conversationId: "conv-sess-fs",
    });
    const id = await svc.recordSession(SAMPLE_SESSION);
    assert.ok(typeof id === "string");
    const filePath = join(scratch, "conv-sess-fs.jsonl");
    assert.equal(existsSync(filePath), true);
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Record<
      string,
      unknown
    >;
    assert.equal(parsed["record_type"], "session");
    assert.equal(parsed["conversation_id"], "conv-sess-fs");
  });
});

describe("createJsonlTraceService — recordSandboxCmd (T2, schema 就位埋点留 pendingRuntime)", () => {
  it("成功 → 返回 UUID v4 sandbox_cmd_id, 行含 parent_turn_id 单值", async () => {
    const { lines, writer } = captureWriter();
    const svc = createJsonlTraceService({
      filePath: scratch,
      conversationId: "conv-cmd",
      writer,
    });
    const id = await svc.recordSandboxCmd(SAMPLE_CMD);
    assert.ok(typeof id === "string");
    assert.match(id, UUID_RE);
    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
    assert.equal(parsed.sandbox_cmd_id, id);
    assert.equal(parsed.conversation_id, "conv-cmd");
    assert.equal(parsed.record_type, "sandbox_cmd");
    assert.equal(parsed.parent_turn_id, "turn-1");
    assert.equal(parsed.command, "ls -la");
    assert.equal(parsed.exit_code, 0);
    assert.equal(parsed.stdout_captured, true);
    assert.equal(parsed.stdout, "total 0");
    assert.equal(parsed.status, "ok");
  });

  it("@throws never: always-throw writer → 返回 undefined, 不抛", async () => {
    const svc = createJsonlTraceService({
      filePath: scratch,
      conversationId: "conv-cmd-fail",
      writer: (): void => {
        throw new Error("simulated disk failure");
      },
    });
    const result = await svc.recordSandboxCmd(SAMPLE_CMD);
    assert.equal(result, undefined);
  });

  it("真实 FS: 写 <dir>/<convId>.jsonl", async () => {
    const svc = createJsonlTraceService({
      filePath: scratch,
      conversationId: "conv-cmd-fs",
    });
    const id = await svc.recordSandboxCmd(SAMPLE_CMD);
    assert.ok(typeof id === "string");
    const filePath = join(scratch, "conv-cmd-fs.jsonl");
    assert.equal(existsSync(filePath), true);
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Record<
      string,
      unknown
    >;
    assert.equal(parsed["record_type"], "sandbox_cmd");
    assert.equal(parsed["conversation_id"], "conv-cmd-fs");
  });
});

// ---------------------------------------------------------------------------
// #406 T3 A4: 输出 mask 兜底 —— jsonl 无参 currentSecretValues() 覆盖 registry 值
// ---------------------------------------------------------------------------
// jsonl.ts:76 调用 currentSecretValues() 无参 → 经模块槽位（setActiveExtraSecrets）
// 覆盖 registry 追踪的密钥值。写入行里的真值应被 mask 成 ***（沿用 mask 链路）。
describe("#406 T3 — jsonl 输出 mask 兜底 (A4)", () => {
  beforeEach(() => clearActiveExtraSecrets());
  afterEach(() => clearActiveExtraSecrets());

  it("registry 追踪值出现在 recordLlmCall 消息里 → 文件行含 *** 且不含真值", async () => {
    setActiveExtraSecrets(["sk-registry-secret"]);
    const svc = createJsonlTraceService({
      filePath: scratch,
      conversationId: "conv-t3-a4",
    });
    const llm: LlmCallRecord = {
      ...SAMPLE_LLM,
      messages: [{ role: "user", content: "这是 sk-registry-secret 帮我测" }],
    };
    await svc.recordLlmCall(llm);

    const filePath = join(scratch, "conv-t3-a4.jsonl");
    const content = readFileSync(filePath, "utf8");
    assert.ok(content.includes("***"), `行应含 mask 结果（实际=${content}）`);
    assert.ok(
      !content.includes("sk-registry-secret"),
      `行不应含 registry 真值（实际=${content}）`
    );
  });

  it("clearActiveExtraSecrets 后 registry 值不再被遮蔽", async () => {
    setActiveExtraSecrets(["sk-registry-secret"]);
    clearActiveExtraSecrets();
    const svc = createJsonlTraceService({
      filePath: scratch,
      conversationId: "conv-t3-a4-clear",
    });
    const llm: LlmCallRecord = {
      ...SAMPLE_LLM,
      messages: [{ role: "user", content: "raw sk-registry-secret here" }],
    };
    await svc.recordLlmCall(llm);

    const filePath = join(scratch, "conv-t3-a4-clear.jsonl");
    const content = readFileSync(filePath, "utf8");
    assert.ok(
      content.includes("sk-registry-secret"),
      `清槽位后应保留原值（实际=${content}）`
    );
  });
});
