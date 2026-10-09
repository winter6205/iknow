/**
 * specs/subagent-card-title.md SC2 / SC6 + input-contract row
 * "activity projection" — the read-only projection that answers "which tool did
 * this worker issue most recently?".
 *
 * The projection is the LAST `tool_use` in that worker's own ledger, with its
 * recorded input. Settling is deliberately not consulted: the call stays
 * visible through its `tool_result` until a later `tool_use` replaces it, so
 * the slot describes the issued call rather than whether it is still running
 * or succeeded.
 *
 * Invariants pinned here:
 *   - retention, not liveness: an already-settled tool_use still projects, and
 *     a later tool_use replaces it;
 *   - the recorded input travels with the name (never raw JSON to the card);
 *   - two workers, two ledgers: activities never cross;
 *   - every empty / broken input exits as `null` (the card's empty placeholder),
 *     never as a throw — missing file, unparsable records, an unreadable path.
 *
 * Real temp ledgers are written through the append SSOT
 * (`appendWorkerTranscript`), not mocks, so the projection is proven against
 * the exact byte shape a worker produces. The projection deliberately does NOT
 * run `closeoutOrphanToolUses` — that synthesis would erase the trailing
 * `tool_use` this reader exists to report (loadWorkerTranscript's contract is a
 * valid API chain; this one is a live activity read).
 */
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, vi } from "vitest";

import type { AnthropicNativeMessage } from "../../src/harness/index.js";
import { appendWorkerTranscript } from "../../src/session-api/store/index.js";
import { readWorkerActivity } from "../../src/session-api/store/index.js";

function userText(text: string): AnthropicNativeMessage {
  return { role: "user", content: [{ type: "text", text }] };
}

function toolUse(
  id: string,
  name: string,
  input: Record<string, unknown> = {}
): AnthropicNativeMessage {
  return {
    role: "assistant",
    content: [{ type: "tool_use", id, name, input }],
  };
}

function toolResult(id: string): AnthropicNativeMessage {
  return {
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: id, content: "ok", is_error: false },
    ],
  };
}

/** A `tool_use` whose `input` is whatever the ledger actually holds — a
 *  historical record may carry a non-object. The cast is at the fixture
 *  boundary only: the append SSOT serializes the block verbatim, and the
 *  projection's coercion is what makes a card show a bare tool name rather than
 *  raw text. */
function legacyToolUse(
  id: string,
  name: string,
  input: unknown
): AnthropicNativeMessage {
  return {
    role: "assistant",
    content: [{ type: "tool_use", id, name, input }],
  } as unknown as AnthropicNativeMessage;
}

describe("activity projection — worker-activity readWorkerActivity", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "iknow-worker-activity-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Write a real worker ledger at the production layout and return its path. */
  async function ledger(
    taskId: string,
    events: ReadonlyArray<AnthropicNativeMessage>
  ): Promise<string> {
    const transcriptPath = join(dir, taskId, `${taskId}.jsonl`);
    await appendWorkerTranscript({
      location: { transcriptPath, taskId },
      events,
    });
    return transcriptPath;
  }

  it("最新发出的 tool_use → 返回它（与是否已结算无关）", async () => {
    const transcriptPath = await ledger("t-open", [
      userText("do the work"),
      toolUse("call-1", "grep"),
      toolResult("call-1"),
      toolUse("call-2", "read_file", { path: "a.ts" }),
    ]);
    assert.deepEqual(
      await readWorkerActivity({ transcriptPath, taskId: "t-open" }),
      { toolName: "read_file", toolInput: { path: "a.ts" } }
    );
  });

  it("全部 tool_use 都已配对 → 仍留存最后一条（retention after its own result）", async () => {
    // Retention is the whole point of the slot: a call that finished stays
    // visible until a later call replaces it, so settling cannot be the filter.
    const transcriptPath = await ledger("t-settled", [
      userText("do the work"),
      toolUse("call-1", "grep"),
      toolResult("call-1"),
      toolUse("call-2", "write_file", { path: "p" }),
      toolResult("call-2"),
    ]);
    assert.deepEqual(
      await readWorkerActivity({ transcriptPath, taskId: "t-settled" }),
      { toolName: "write_file", toolInput: { path: "p" } }
    );
  });

  it("只有 task 文本、没有任何 tool_use → null（空是有意义的读数，不是缺文件）", async () => {
    const transcriptPath = await ledger("t-notool", [
      userText("do the work"),
      { role: "assistant", content: [{ type: "text", text: "done" }] },
    ]);
    assert.equal(
      await readWorkerActivity({
        transcriptPath,
        taskId: "t-notool",
      }),
      null
    );
  });

  it("两条 tool_use 相邻 → 取账本序更后的那条（the latest issued call）", async () => {
    const transcriptPath = await ledger("t-parallel", [
      toolUse("call-1", "grep"),
      toolUse("call-2", "glob"),
      toolResult("call-1"),
    ]);
    assert.deepEqual(
      await readWorkerActivity({
        transcriptPath,
        taskId: "t-parallel",
      }),
      { toolName: "glob", toolInput: {} }
    );
  });

  it("账本里先出现的 tool_result 不影响投影（settling is never consulted）", async () => {
    // Kept as a shape guard: a ledger whose result precedes its own tool_use
    // (odd, but append-only ledgers are written by another process) still
    // projects the issued call, because pairing is not part of this read.
    const transcriptPath = await ledger("t-order", [
      toolResult("call-9"),
      toolUse("call-9", "write_file", { path: "late.ts" }),
    ]);
    assert.deepEqual(
      await readWorkerActivity({
        transcriptPath,
        taskId: "t-order",
      }),
      { toolName: "write_file", toolInput: { path: "late.ts" } }
    );
  });

  it("两个 worker 两本账 → 各报各自的调用，永不串台", async () => {
    const pathA = await ledger("task-a", [toolUse("a-1", "bash")]);
    const pathB = await ledger("task-b", [toolUse("b-1", "web_search")]);
    const [a, b] = await Promise.all([
      readWorkerActivity({ transcriptPath: pathA, taskId: "task-a" }),
      readWorkerActivity({ transcriptPath: pathB, taskId: "task-b" }),
    ]);
    assert.deepEqual([a?.toolName, b?.toolName], ["bash", "web_search"]);
  });

  it("未注册的工具名 + 结构化入参 → 名字与入参原样上到读数（回落裸名是卡片层的事）", async () => {
    // The reader owns no tool registry: filtering or re-naming an unregistered
    // name here would leave the card nothing to fall back to. The summary layer
    // decides wording; this read only reports the issued call.
    const transcriptPath = await ledger("task-mcp", [
      toolUse("m-1", "mcp__serena__find_symbol", {
        symbol_name: "buildCard",
        relation: "children",
      }),
    ]);
    assert.deepEqual(
      await readWorkerActivity({ transcriptPath, taskId: "task-mcp" }),
      {
        toolName: "mcp__serena__find_symbol",
        toolInput: { symbol_name: "buildCard", relation: "children" },
      }
    );
  });

  it("历史记录的 input 不是对象 → toolInput 收成 {}（摘要层退裸名，绝不带出原文）", async () => {
    // A pre-input-schema ledger record can hold a string / null / number here.
    // Passing it through would hand the summary layer a value it cannot read as
    // fields; coercing to {} is what makes the safe bare-name fallback the only
    // possible rendering, and it keeps the recorded text out of the transcript.
    const shapes: ReadonlyArray<readonly [string, unknown]> = [
      ["str", "ls -la"],
      ["null", null],
      ["num", 7],
    ];
    for (const [tag, input] of shapes) {
      const taskId = `task-legacy-${tag}`;
      const transcriptPath = await ledger(taskId, [
        legacyToolUse("g-1", "bash", input),
      ]);
      assert.deepEqual(await readWorkerActivity({ transcriptPath, taskId }), {
        toolName: "bash",
        toolInput: {},
      });
    }
  });

  it("input 是数组（合法 JSON，但不是字段对象）→ 工具名照旧上到读数", async () => {
    // This read deliberately invents no second coercion rule for an array: the
    // card's fallback only depends on the name surviving, and the summary layer's
    // own field lookup (string field or fallback) is what keeps the payload out
    // of the line.
    const taskId = "task-legacy-array";
    const transcriptPath = await ledger(taskId, [
      legacyToolUse("g-1", "bash", ["a", "b"]),
    ]);
    assert.equal(
      (await readWorkerActivity({ transcriptPath, taskId }))?.toolName,
      "bash"
    );
  });

  it("账本不存在 → null，不抛（missing file is the card's empty placeholder）", async () => {
    const missing = join(dir, "task-ghost", "task-ghost.jsonl");
    assert.equal(
      await readWorkerActivity({
        transcriptPath: missing,
        taskId: "task-ghost",
      }),
      null
    );
  });

  it("账本内容不可解析 → null，不把异常抛进读数（invalid records never reach the card）", async () => {
    const taskId = "task-corrupt";
    const transcriptPath = join(dir, taskId, `${taskId}.jsonl`);
    mkdirSync(join(dir, taskId), { recursive: true });
    // No header record at all: parseSessionJsonl exits as schema_invalid.
    writeFileSync(transcriptPath, "{ this is not a session record\n", "utf8");
    assert.equal(await readWorkerActivity({ transcriptPath, taskId }), null);
  });

  it("路径不可读（目录冒充账本）→ null，不抛", async () => {
    const taskId = "task-eisdir";
    const transcriptPath = join(dir, taskId, `${taskId}.jsonl`);
    mkdirSync(transcriptPath, { recursive: true });
    assert.equal(await readWorkerActivity({ transcriptPath, taskId }), null);
  });

  it("空 taskId / 空路径（非法入参）→ null，不抛", async () => {
    assert.equal(
      await readWorkerActivity({ transcriptPath: "", taskId: "" }),
      null
    );
  });
});

/**
 * `null` is what "the worker has issued no call" and "the ledger could not be
 * read" share as a rendering value, so the second one has to leave a trace or
 * the operator sees an idle worker forever. A missing ledger is *not* that
 * case: a worker appends its first record after its loop starts, so absence is
 * the expected reading for a young task and stays silent.
 */
describe("activity projection — a fault is named, an empty reading is not", () => {
  let dir: string;
  let lines: string[];
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "iknow-worker-fault-"));
    lines = [];
    vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  /** A ledger path whose directory exists, holding the given raw bytes. */
  function rawLedger(taskId: string, bytes: string): string {
    const taskDir = join(dir, taskId);
    mkdirSync(taskDir, { recursive: true });
    const transcriptPath = join(taskDir, `${taskId}.jsonl`);
    writeFileSync(transcriptPath, bytes, "utf8");
    return transcriptPath;
  }

  it("账本不存在 → null 且不记录任何诊断（合法空读数不是故障）", async () => {
    const transcriptPath = join(dir, "f-absent", "f-absent.jsonl");
    assert.equal(
      await readWorkerActivity({ transcriptPath, taskId: "f-absent" }),
      null
    );
    assert.deepEqual(lines, []);
  });

  it("账本中间坏行 → 读数 null，诊断里看得见 parse_failed 而不是 [object Object]", async () => {
    const taskDir = join(dir, "f-parse");
    mkdirSync(taskDir, { recursive: true });
    const transcriptPath = join(taskDir, "f-parse.jsonl");
    await appendWorkerTranscript({
      location: { transcriptPath, taskId: "f-parse" },
      events: [toolUse("p-1", "grep")],
    });
    // A bad line only reaches parse_failed when it is not the trailing one:
    // jsonl.ts deliberately treats a torn tail as a partial write.
    writeFileSync(
      transcriptPath,
      "{ this is not a session record\n" + readFileSync(transcriptPath, "utf8"),
      "utf8"
    );
    assert.equal(
      await readWorkerActivity({ transcriptPath, taskId: "f-parse" }),
      null
    );
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /f-parse/);
    assert.match(lines[0]!, /parse_failed/);
  });

  it("账本里一条合法记录都没有 → 诊断里看得见 schema_invalid，而不是 [object Object]", async () => {
    const transcriptPath = rawLedger("f-schema", '{"type":"bogus"}\n');
    assert.equal(
      await readWorkerActivity({ transcriptPath, taskId: "f-schema" }),
      null
    );
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /schema_invalid/);
  });

  it("路径不可读（目录冒充账本）→ 记一次故障并带上 errno，区别于「没有账本」", async () => {
    const transcriptPath = join(dir, "f-eisdir", "f-eisdir.jsonl");
    mkdirSync(transcriptPath, { recursive: true });
    assert.equal(
      await readWorkerActivity({ transcriptPath, taskId: "f-eisdir" }),
      null
    );
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /EISDIR/);
  });

  it("同一个 worker 反复读 → 故障只报一次，读数不受影响", async () => {
    const transcriptPath = rawLedger("f-once", "}{ broken\n");
    for (let pass = 0; pass < 3; pass += 1) {
      assert.equal(
        await readWorkerActivity({ transcriptPath, taskId: "f-once" }),
        null
      );
    }
    assert.equal(lines.filter((l) => l.includes("f-once")).length, 1);
  });
});
