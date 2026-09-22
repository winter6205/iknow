/**
 * specs/subagent-card-title.md SC2 / SC6 + input-contract row
 * "activity projection" — the read-only projection that answers "which tool is
 * this worker executing right now?".
 *
 * The projection is the latest `tool_use` on the worker's own ledger with no
 * matching `tool_result` later in that ledger. This is observable because
 * loop-engine commits the assistant turn (with its tool_use) *before* the tool
 * phase runs, so an unpaired tool_use really is the call in flight.
 *
 * Invariants pinned here:
 *   - pairing, not mere presence: a settled tool_use must not surface;
 *   - two workers, two ledgers: names never cross;
 *   - every empty / broken input exits as "" (the card's empty placeholder),
 *     never as a throw — missing file, unparsable records, an unreadable path.
 *
 * Real temp ledgers are written through the append SSOT
 * (`appendWorkerTranscript`), not mocks, so the projection is proven against
 * the exact byte shape a worker produces. The projection deliberately does NOT
 * run `closeoutOrphanToolUses` — that synthesis would erase the in-flight
 * signal this reader exists to report (loadWorkerTranscript's contract is a
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
import { readWorkerInFlightToolName } from "../../src/session-api/store/index.js";

function userText(text: string): AnthropicNativeMessage {
  return { role: "user", content: [{ type: "text", text }] };
}

function toolUse(id: string, name: string): AnthropicNativeMessage {
  return {
    role: "assistant",
    content: [{ type: "tool_use", id, name, input: {} }],
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

describe("activity projection — worker-activity readWorkerInFlightToolName", () => {
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

  it("最新一条未配对的 tool_use → 返回它的 name（更早已配对的被忽略）", async () => {
    const transcriptPath = await ledger("t-open", [
      userText("do the work"),
      toolUse("call-1", "grep"),
      toolResult("call-1"),
      toolUse("call-2", "read_file"),
    ]);
    assert.equal(
      await readWorkerInFlightToolName({ transcriptPath, taskId: "t-open" }),
      "read_file"
    );
  });

  it('全部 tool_use 都已配对 → ""（空是有意义的读数，不是缺文件）', async () => {
    const transcriptPath = await ledger("t-settled", [
      userText("do the work"),
      toolUse("call-1", "grep"),
      toolResult("call-1"),
      toolUse("call-2", "read_file"),
      toolResult("call-2"),
    ]);
    assert.equal(
      await readWorkerInFlightToolName({ transcriptPath, taskId: "t-settled" }),
      ""
    );
  });

  it('只有 task 文本、没有任何 tool_use → ""', async () => {
    const transcriptPath = await ledger("t-notool", [
      userText("do the work"),
      { role: "assistant", content: [{ type: "text", text: "done" }] },
    ]);
    assert.equal(
      await readWorkerInFlightToolName({
        transcriptPath,
        taskId: "t-notool",
      }),
      ""
    );
  });

  it("两条 tool_use 同时未配对 → 取更后的那条（the latest in-flight call）", async () => {
    const transcriptPath = await ledger("t-parallel", [
      toolUse("call-1", "grep"),
      toolUse("call-2", "glob"),
      toolResult("call-1"),
    ]);
    assert.equal(
      await readWorkerInFlightToolName({
        transcriptPath,
        taskId: "t-parallel",
      }),
      "glob"
    );
  });

  it("配对是顺序的：账本里先出现的 tool_result 不结算之后的同名 tool_use", async () => {
    const transcriptPath = await ledger("t-order", [
      toolResult("call-9"),
      toolUse("call-9", "write_file"),
    ]);
    assert.equal(
      await readWorkerInFlightToolName({
        transcriptPath,
        taskId: "t-order",
      }),
      "write_file"
    );
  });

  it("两个 worker 两本账 → 各报各自的名字，永不串台", async () => {
    const pathA = await ledger("task-a", [toolUse("a-1", "bash")]);
    const pathB = await ledger("task-b", [toolUse("b-1", "web_search")]);
    assert.deepEqual(
      await Promise.all([
        readWorkerInFlightToolName({ transcriptPath: pathA, taskId: "task-a" }),
        readWorkerInFlightToolName({ transcriptPath: pathB, taskId: "task-b" }),
      ]),
      ["bash", "web_search"]
    );
  });

  it('账本不存在 → ""，不抛（missing file is the card\'s empty placeholder）', async () => {
    const missing = join(dir, "task-ghost", "task-ghost.jsonl");
    assert.equal(
      await readWorkerInFlightToolName({
        transcriptPath: missing,
        taskId: "task-ghost",
      }),
      ""
    );
  });

  it('账本内容不可解析 → ""，不把异常抛进读数（invalid records never reach the card）', async () => {
    const taskId = "task-corrupt";
    const transcriptPath = join(dir, taskId, `${taskId}.jsonl`);
    mkdirSync(join(dir, taskId), { recursive: true });
    // No header record at all: parseSessionJsonl exits as schema_invalid.
    writeFileSync(transcriptPath, "{ this is not a session record\n", "utf8");
    assert.equal(
      await readWorkerInFlightToolName({ transcriptPath, taskId }),
      ""
    );
  });

  it('路径不可读（目录冒充账本）→ ""，不抛', async () => {
    const taskId = "task-eisdir";
    const transcriptPath = join(dir, taskId, `${taskId}.jsonl`);
    mkdirSync(transcriptPath, { recursive: true });
    assert.equal(
      await readWorkerInFlightToolName({ transcriptPath, taskId }),
      ""
    );
  });

  it('空 taskId / 空路径（非法入参）→ ""，不抛', async () => {
    assert.equal(
      await readWorkerInFlightToolName({ transcriptPath: "", taskId: "" }),
      ""
    );
  });
});

/**
 * `""` is what "nothing in flight" and "the ledger could not be read" share as
 * a rendering value, so the second one has to leave a trace or the operator
 * sees an idle worker forever. A missing ledger is *not* that case: a worker
 * appends its first record after its loop starts, so absence is the expected
 * reading for a young task and stays silent.
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

  it('账本不存在 → "" 且不记录任何诊断（合法空读数不是故障）', async () => {
    const transcriptPath = join(dir, "f-absent", "f-absent.jsonl");
    assert.equal(
      await readWorkerInFlightToolName({ transcriptPath, taskId: "f-absent" }),
      ""
    );
    assert.deepEqual(lines, []);
  });

  it('账本中间坏行 → 读数 ""，诊断里看得见 parse_failed 而不是 [object Object]', async () => {
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
      await readWorkerInFlightToolName({ transcriptPath, taskId: "f-parse" }),
      ""
    );
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /f-parse/);
    assert.match(lines[0]!, /parse_failed/);
  });

  it("账本里一条合法记录都没有 → 诊断里看得见 schema_invalid，而不是 [object Object]", async () => {
    const transcriptPath = rawLedger("f-schema", '{"type":"bogus"}\n');
    assert.equal(
      await readWorkerInFlightToolName({ transcriptPath, taskId: "f-schema" }),
      ""
    );
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /schema_invalid/);
  });

  it("路径不可读（目录冒充账本）→ 记一次故障并带上 errno，区别于「没有账本」", async () => {
    const transcriptPath = join(dir, "f-eisdir", "f-eisdir.jsonl");
    mkdirSync(transcriptPath, { recursive: true });
    assert.equal(
      await readWorkerInFlightToolName({ transcriptPath, taskId: "f-eisdir" }),
      ""
    );
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /EISDIR/);
  });

  it("同一个 worker 反复读 → 故障只报一次，读数不受影响", async () => {
    const transcriptPath = rawLedger("f-once", "}{ broken\n");
    for (let pass = 0; pass < 3; pass += 1) {
      assert.equal(
        await readWorkerInFlightToolName({ transcriptPath, taskId: "f-once" }),
        ""
      );
    }
    assert.equal(lines.filter((l) => l.includes("f-once")).length, 1);
  });
});
