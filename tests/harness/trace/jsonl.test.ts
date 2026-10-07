/**
 * createJsonlTraceService.
 *
 * 10 contracts:
 * 1. snake_case key conversion (camelCase TS fields → snake_case JSONL keys)
 * 2. each line is valid single-line JSONL (JSON.parse per line, no embedded newlines)
 * 3. parent_llm_call_id: null (parentLlmCallId=undefined → literal null)
 * 4. write failures never throw (always-throw writer → recordXxx returns undefined)
 * 5. console.warn fires once (repeated failures still warn only once)
 * 6. all three record methods return string | undefined (UUID on success)
 * 7. conversation_id present on every line (instance-bound)
 * 8. record_type discriminator (llm_call / tool_call / turn)
 * 9. real-FS coverage (mkdtempSync + actual appends + statSync size > 0)
 * 10. no fsync (code-review fact, not a test)
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
import { createHash } from "node:crypto";
import { createJsonlTraceService } from "../../../src/harness/trace/jsonl.ts";
import {
  clearActiveExtraSecrets,
  setActiveExtraSecrets,
} from "../../../src/harness/sandbox/env-isolation.ts";
import * as sandbox from "../../../src/harness/sandbox/index.ts";
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

  it("不递归进 content payload: messages role 内联 / arguments/result 内部 key 保持原样", async () => {
    // llm_call message content goes to a content-level blob ref while role
    // stays inline, so the "camelToSnake never recurses" judgement lives on
    // tool_call arguments / result instead: fully inline, inner keys not
    // snake_cased.
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
    assert.deepEqual(Object.keys(messages[0]?.content as object).sort(), [
      "bytes",
      "sha",
    ]);
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

  it("写盘失败增加实例级 traceWriteFailures 计数且不抛", async () => {
    const svc = createJsonlTraceService({
      filePath: join(scratch, "counter.jsonl"),
      conversationId: "conv-counter",
      writer: (): void => {
        throw new Error("simulated disk failure");
      },
    });

    await assert.doesNotReject(svc.recordLlmCall(SAMPLE_LLM));
    assert.equal(svc.traceWriteFailures, 1);
  });

  it("filePath 被同名文件占据 (旧 ./trace.jsonl) → 构造不抛, recordXxx 返回 undefined 不炸 turn", async () => {
    // Regression: the writer default used to be a single ./trace.jsonl file;
    // after the directory-semantics switch, mkdirSync hitting that legacy file
    // threw EEXIST at construction time and killed a TUI turn.
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
    // Blobs are the only mode, so two sessions sharing a traceDir also share
    // the blobs/ content-addressed pool (same SAMPLE_LLM content → exactly 1 blob).
    const files = readdirSync(scratch).sort();
    assert.deepEqual(files, ["blobs", "conv-a.jsonl", "conv-b.jsonl"]);
    assert.equal(readdirSync(join(scratch, "blobs")).length, 1);
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
// Output-mask fallback: jsonl calls currentSecretValues() with no arguments,
// so it picks up the registry values via the module slot (setActiveExtraSecrets).
// Real secret values written into rows must be masked to *** through that chain.
describe("#406 T3 — jsonl 输出 mask 兜底 (A4)", () => {
  beforeEach(() => clearActiveExtraSecrets());
  afterEach(() => clearActiveExtraSecrets());

  it("registry 追踪值出现在 recordLlmCall 消息里 → blob 正文含 *** 且不含真值, 行内亦无真值", async () => {
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
    assert.ok(
      !content.includes("sk-registry-secret"),
      `行不应含 registry 真值（实际=${content}）`
    );
    // The body went into a blob — the masked *** lives in the blob content.
    const blobsDir = join(scratch, "blobs");
    const blob = readFileSync(
      join(blobsDir, readdirSync(blobsDir)[0]!),
      "utf8"
    );
    assert.ok(blob.includes("***"), `blob 应含 mask 结果（实际=${blob}）`);
    assert.ok(!blob.includes("sk-registry-secret"));
  });

  it("clearActiveExtraSecrets 后 registry 值不再被遮蔽 (blob 正文保留原值)", async () => {
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

    const blobsDir = join(scratch, "blobs");
    const blob = readFileSync(
      join(blobsDir, readdirSync(blobsDir)[0]!),
      "utf8"
    );
    assert.ok(
      blob.includes("sk-registry-secret"),
      `清槽位后应保留原值（实际=${blob}）`
    );
  });
});

describe("createJsonlTraceService — output mask lifecycle", () => {
  it("constructs one output mask per factory instance", async () => {
    const maskSpy = vi.spyOn(sandbox, "createOutputMask");
    try {
      const { writer } = captureWriter();
      const svc = createJsonlTraceService({
        filePath: scratch,
        conversationId: "conv-mask-once",
        writer,
      });
      await svc.recordLlmCall(SAMPLE_LLM);
      await svc.recordToolCall(SAMPLE_TOOL);
      await svc.recordTurn(SAMPLE_TURN);
      assert.equal(maskSpy.mock.calls.length, 1);
    } finally {
      maskSpy.mockRestore();
    }
  });

  it("rebuilds the mask when active secrets change after factory creation", async () => {
    clearActiveExtraSecrets();
    try {
      const { lines, writer } = captureWriter();
      const svc = createJsonlTraceService({
        filePath: scratch,
        conversationId: "conv-mask-refresh",
        writer,
      });

      setActiveExtraSecrets(["NEWSECRET"]);
      await svc.recordLlmCall({
        ...SAMPLE_LLM,
        messages: [{ role: "user", content: "NEWSECRET" }],
      });

      assert.equal(lines.length, 1);
      assert.equal(lines[0]!.includes("NEWSECRET"), false);
      // Masking takes effect on the blob body — the inline sha ref reveals
      // nothing, so the *** must be inside the blob.
      const blobsDir = join(scratch, "blobs");
      const blob = readFileSync(
        join(blobsDir, readdirSync(blobsDir)[0]!),
        "utf8"
      );
      assert.equal(blob.includes("NEWSECRET"), false);
      assert.equal(blob.includes("***"), true);
    } finally {
      clearActiveExtraSecrets();
    }
  });
});

describe("createJsonlTraceService — content 级 blob 引用 (SC10, T4)", () => {
  // Blob mode is the only mode (the on/off switch was retired): always on,
  // no "full" branch. Granularity = content: messages[i] keeps the two keys
  // {role, content}, with content replaced by {sha, bytes}
  // (per ADR-0036 Amendment table C).
  interface ContentRef {
    sha: string;
    bytes: number;
    kind: "str" | "blocks";
  }

  function parseMessages(line: string): Array<{
    role: unknown;
    content: ContentRef;
  }> {
    const parsed = JSON.parse(line) as {
      messages: Array<{ role: unknown; content: ContentRef }>;
    };
    return parsed.messages;
  }

  it("messages[i] 保持 {role, content} 两键, content 为 {sha, bytes} ref (SC10)", async () => {
    const { lines, writer } = captureWriter();
    const svc = createJsonlTraceService({
      filePath: scratch,
      conversationId: "conv-blob",
      writer,
    });
    await svc.recordLlmCall({
      ...SAMPLE_LLM,
      messages: [{ role: "user", content: "plain body" }],
    });

    const messages = parseMessages(lines[0]!);
    assert.equal(messages.length, 1);
    const message = messages[0]!;
    // role stays inline — the reader's messageRole() works unchanged.
    assert.equal(message.role, "user");
    // content is replaced by a {sha, bytes} ref.
    assert.deepEqual(Object.keys(message.content).sort(), ["bytes", "sha"]);
    assert.equal(typeof message.content.sha, "string");
    assert.equal(typeof message.content.bytes, "number");
  });

  it("形状 1: block 数组 content 整体寻址; 形状 2: 字符串 content 寻址且 kind=str (表 C)", async () => {
    const { lines, writer } = captureWriter();
    const svc = createJsonlTraceService({
      filePath: scratch,
      conversationId: "conv-blob-shapes",
      writer,
    });
    await svc.recordLlmCall({
      ...SAMPLE_LLM,
      messages: [
        { role: "user", content: "string shape" },
        {
          role: "assistant",
          content: [{ type: "text", text: "block shape" }],
        },
      ],
    });

    const messages = parseMessages(lines[0]!);
    // Shape 2 (string): blob encoding keeps a shape tag so the reader restores
    // a string, never wrongly wrapping it into an array.
    const strBlob = readFileSync(
      join(scratch, "blobs", messages[0]!.content.sha),
      "utf8"
    );
    const strPayload = JSON.parse(strBlob) as { kind: string; v: unknown };
    assert.equal(strPayload.kind, "str");
    assert.equal(strPayload.v, "string shape");
    // Shape 1 (block array): the whole array is one blob.
    const blocksBlob = readFileSync(
      join(scratch, "blobs", messages[1]!.content.sha),
      "utf8"
    );
    const blocksPayload = JSON.parse(blocksBlob) as {
      kind: string;
      v: Array<unknown>;
    };
    assert.equal(blocksPayload.kind, "blocks");
    assert.deepEqual(blocksPayload.v, [{ type: "text", text: "block shape" }]);
    // Each shape's ref bytes match independently.
    assert.equal(
      messages[0]!.content.bytes,
      Buffer.byteLength(strBlob, "utf8")
    );
    assert.equal(
      messages[1]!.content.bytes,
      Buffer.byteLength(blocksBlob, "utf8")
    );
  });

  it("混合: 同一 messages 数组两种形状并存, 逐元素独立判定 (表 C)", async () => {
    const { lines, writer } = captureWriter();
    const svc = createJsonlTraceService({
      filePath: scratch,
      conversationId: "conv-blob-mixed",
      writer,
    });
    await svc.recordLlmCall({
      ...SAMPLE_LLM,
      messages: [
        { role: "user", content: "string one" },
        { role: "assistant", content: [{ type: "text", text: "blocks" }] },
        { role: "user", content: "string two" },
      ],
    });

    const messages = parseMessages(lines[0]!);
    assert.equal(messages.length, 3);
    for (const [index, message] of messages.entries()) {
      const blob = readFileSync(
        join(scratch, "blobs", message.content.sha),
        "utf8"
      );
      const payload = JSON.parse(blob) as { kind: string; v: unknown };
      if (index % 2 === 0) {
        assert.equal(payload.kind, "str");
      } else {
        assert.equal(payload.kind, "blocks");
      }
    }
  });

  it("表 B empty: 空串 / 空数组 content 仍走内容寻址, 不内联", async () => {
    const { lines, writer } = captureWriter();
    const svc = createJsonlTraceService({
      filePath: scratch,
      conversationId: "conv-blob-empty",
      writer,
    });
    await svc.recordLlmCall({
      ...SAMPLE_LLM,
      messages: [
        { role: "user", content: "" },
        { role: "assistant", content: [] },
      ],
    });

    const messages = parseMessages(lines[0]!);
    for (const message of messages) {
      assert.deepEqual(Object.keys(message.content).sort(), ["bytes", "sha"]);
      const blobPath = join(scratch, "blobs", message.content.sha);
      assert.equal(existsSync(blobPath), true, "empty content has its sha");
    }
    // Empty string and empty array are different content → different sha, different blob.
    assert.notEqual(messages[0]!.content.sha, messages[1]!.content.sha);
    // No inline ""/[] literals remain in the row (content addressing applied).
    assert.ok(!lines[0]!.includes('"content":[]'));
  });

  it("SC13: blob 内容 mask 后写入, sha == 内容 sha256, bytes == 实际 UTF-8 字节数", async () => {
    setActiveExtraSecrets(["blob-secret"]);
    try {
      const { lines, writer } = captureWriter();
      const svc = createJsonlTraceService({
        filePath: scratch,
        conversationId: "conv-blob-mask",
        writer,
      });
      await svc.recordLlmCall({
        ...SAMPLE_LLM,
        messages: [{ role: "user", content: "blob-secret" }],
      });

      const messages = parseMessages(lines[0]!);
      const ref = messages[0]!.content;
      assert.ok(ref.bytes > 0);
      const blobPath = join(scratch, "blobs", ref.sha);
      assert.equal(existsSync(blobPath), true);
      const blob = readFileSync(blobPath, "utf8");
      assert.equal(blob.includes("blob-secret"), false);
      assert.equal(blob.includes("***"), true);
      assert.equal(
        ref.sha,
        createHash("sha256").update(blob, "utf8").digest("hex")
      );
      assert.equal(ref.bytes, Buffer.byteLength(blob, "utf8"));
      // The row also contains no secret.
      assert.equal(lines[0]!.includes("blob-secret"), false);
    } finally {
      clearActiveExtraSecrets();
    }
  });

  it("SC12: 同一 content 出现在两个 llm_call → blobs/ 恰好 1 个文件, 两行 sha 相同", async () => {
    const { lines, writer } = captureWriter();
    const svc = createJsonlTraceService({
      filePath: scratch,
      conversationId: "conv-blob-dedup",
      writer,
    });
    await svc.recordLlmCall({
      ...SAMPLE_LLM,
      messages: [{ role: "user", content: "repeated body" }],
    });
    await svc.recordLlmCall({
      ...SAMPLE_LLM,
      messages: [{ role: "user", content: "repeated body" }],
    });

    assert.equal(lines.length, 2);
    const first = parseMessages(lines[0]!)[0]!.content;
    const second = parseMessages(lines[1]!)[0]!.content;
    assert.equal(first.sha, second.sha);
    const blobsDir = join(scratch, "blobs");
    const files = readdirSync(blobsDir);
    assert.deepEqual(files, [first.sha]);
  });

  it("表 B overflow: 单条 891KB 级 content 写入不失败, bytes 准确", async () => {
    const { lines, writer } = captureWriter();
    const svc = createJsonlTraceService({
      filePath: scratch,
      conversationId: "conv-blob-overflow",
      writer,
    });
    const huge = "x".repeat(891_000);
    const result = await svc.recordLlmCall({
      ...SAMPLE_LLM,
      messages: [{ role: "user", content: huge }],
    });
    assert.ok(typeof result === "string", "large content must not fail");

    const messages = parseMessages(lines[0]!);
    const ref = messages[0]!.content;
    const blob = readFileSync(join(scratch, "blobs", ref.sha), "utf8");
    assert.equal(JSON.parse(blob).v, huge);
    assert.equal(ref.bytes, Buffer.byteLength(blob, "utf8"));
    assert.equal(ref.bytes > 891_000, true);
  });

  it("表 B concurrent: 两个 service 实例同 sha write-if-missing → EEXIST 吞, 单文件, 不半写", async () => {
    const content = "concurrently addressed body";
    const svcA = createJsonlTraceService({
      filePath: scratch,
      conversationId: "conv-blob-conc-a",
    });
    const svcB = createJsonlTraceService({
      filePath: scratch,
      conversationId: "conv-blob-conc-b",
    });
    const results = await Promise.all([
      svcA.recordLlmCall({
        ...SAMPLE_LLM,
        messages: [{ role: "user", content }],
      }),
      svcB.recordLlmCall({
        ...SAMPLE_LLM,
        messages: [{ role: "user", content }],
      }),
    ]);
    assert.ok(typeof results[0] === "string");
    assert.ok(typeof results[1] === "string");
    // Same traceDir → same blobs/ directory, exactly 1 file, fully parseable.
    const blobsDir = join(scratch, "blobs");
    const files = readdirSync(blobsDir);
    assert.equal(files.length, 1);
    const blob = readFileSync(join(blobsDir, files[0]!), "utf8");
    assert.equal(JSON.parse(blob).v, content);
  });

  it("SC11: blobs/ 不可写 → 零行落盘, 返回 undefined, 服务存活 (无内联回退)", async () => {
    setActiveExtraSecrets(["blob-secret"]);
    try {
      writeFileSync(join(scratch, "blobs"), "not a directory", "utf8");
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const svc = createJsonlTraceService({
          filePath: scratch,
          conversationId: "conv-blob-failclosed",
        });
        const result = await svc.recordLlmCall({
          ...SAMPLE_LLM,
          messages: [{ role: "user", content: "blob-secret" }],
        });

        // (iii) recordLlmCall returns undefined instead of throwing (ADR-0003 D13).
        assert.equal(result, undefined);

        // trace file absent → (i) zero rows for that llm_call_id and
        // (ii) no fully-inlined rows anywhere.
        const traceFile = join(scratch, "conv-blob-failclosed.jsonl");
        assert.equal(
          existsSync(traceFile),
          false,
          "fail-closed: zero rows including zero inline fallback rows"
        );

        // (v) service survives: the same instance keeps recording later events
        // (turn) and returns an id normally.
        const turnId = await svc.recordTurn(SAMPLE_TURN);
        assert.ok(
          typeof turnId === "string",
          "service survives blob IO failure"
        );

        // (iv) the later tool_call of the same turn is still present (real-FS
        // write) with parent_llm_call_id = null — the loop-engine side
        // (ADR-0003 D14) is certified by loop-engine-trace.test.ts
        // "recordLlmCall returns undefined"; here we certify that the writer
        // accepts and persists the null chain as usual.
        const toolSvc = createJsonlTraceService({
          filePath: scratch,
          conversationId: "conv-blob-failclosed",
        });
        const toolId = await toolSvc.recordToolCall({
          ...SAMPLE_TOOL,
          parentLlmCallId: undefined,
        });
        assert.ok(typeof toolId === "string");
        const lines = readFileSync(traceFile, "utf8").trim().split("\n");
        assert.equal(lines.length, 2);
        const turnRow = JSON.parse(lines[0]!) as Record<string, unknown>;
        const toolRow = JSON.parse(lines[1]!) as Record<string, unknown>;
        assert.equal(turnRow["record_type"], "turn");
        assert.equal(toolRow["record_type"], "tool_call");
        assert.equal(toolRow["parent_llm_call_id"], null);

        // Inner blob IO failures also route through recordFailure warn-once.
        assert.ok(warnSpy.mock.calls.length >= 1);
      } finally {
        warnSpy.mockRestore();
      }
    } finally {
      clearActiveExtraSecrets();
    }
  });
});

// ---------------------------------------------------------------------------
// Direct unit tests for file-mode (`traceFilePath`). Both the main session and
// per-agent sinks converge on file-mode, but until now only manager/worker
// indirect tests covered it — this pins the mutual-exclusion contract of the
// jsonl.ts factory:
//   1. file-mode sink = traceFilePath itself (no <dir>/<convId>.jsonl join);
//   2. passing both keys fails loud;
//   3. passing neither key fails loud;
//   4. directory-mode rotation never applies to file-mode.
// ---------------------------------------------------------------------------

describe("createJsonlTraceService — file-mode (traceFilePath) 互斥合约", () => {
  it("file-mode 落点 = traceFilePath 本身, conversation_id 逐行写入", async () => {
    const dir = mkdtempSync(join(tmpdir(), "iknow-trace-jsonl-file-"));
    try {
      const target = join(dir, "subagents", "agent-fixed-id.jsonl");
      const svc = createJsonlTraceService({
        traceFilePath: target,
        conversationId: "fixed-id",
      });
      await svc.recordToolCall(SAMPLE_TOOL);
      assert.equal(existsSync(target), true, "file written at exact path");
      const line = JSON.parse(readFileSync(target, "utf8").trim()) as Record<
        string,
        unknown
      >;
      assert.equal(line["conversation_id"], "fixed-id");
      assert.equal(line["record_type"], "tool_call");
      // Must never produce extra files shaped like directory mode (<dir>/<convId>.jsonl).
      assert.equal(existsSync(join(dir, "subagents", "fixed-id.jsonl")), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("双键同传 → 构造期 fail-loud (both keys)", () => {
    assert.throws(
      () =>
        createJsonlTraceService({
          filePath: scratch,
          traceFilePath: join(scratch, "x.jsonl"),
          conversationId: "c",
        }),
      /both filePath and traceFilePath/
    );
  });

  it("双键同缺 → 构造期 fail-loud (neither key)", () => {
    assert.throws(
      () =>
        createJsonlTraceService({
          conversationId: "c",
        } as Parameters<typeof createJsonlTraceService>[0]),
      /requires either filePath/
    );
  });

  it("file-mode 不触发 rotation (无轮转目标, *.1.jsonl 永不产生)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "iknow-trace-jsonl-rot-"));
    try {
      const target = join(dir, "trace.jsonl");
      const svc = createJsonlTraceService({
        traceFilePath: target,
        conversationId: "rot",
        // Conservative cap for directory mode (rotation.ts default 5MB) —
        // the tiny value proves file-mode never enters maybeRotate: if rotation
        // applied, the first write would already produce trace.1.jsonl.
        rotation: { maxTotalBytes: 1 },
      });
      await svc.recordToolCall(SAMPLE_TOOL);
      await svc.recordToolCall(SAMPLE_TOOL);
      assert.equal(existsSync(join(dir, "trace.1.jsonl")), false);
      assert.equal(existsSync(join(dir, "trace.2.jsonl")), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
