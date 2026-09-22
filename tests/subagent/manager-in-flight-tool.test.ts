/**
 * specs/subagent-card-title.md — the read-only subagent list carries the name
 * of the tool each live worker is executing right now (`SubagentInfo.inFlightTool`).
 *
 * Manager-side invariants pinned here:
 *   - the manager owns no transcript codec: the reader is **injected** (an
 *     opaque `(taskId, transcriptPath) => Promise<string>` seam), so the
 *     harness never reaches into the store layer;
 *   - `listSubagents` stays synchronous (src/tui/hub-bridge.ts + the 1 Hz poll
 *     call it directly): it surfaces the last read and kicks at most one
 *     outstanding refresh per task;
 *   - with no reader injected the field never appears — every existing
 *     consumer and test stays byte-identical;
 *   - terminal tasks must not surface it (that card shows `✓ Done`), and the
 *     parent-visible handoff envelope is untouched (SC6).
 *
 * Ledgers are real temp files written through the append SSOT and read by the
 * production reader (not a mocked seam) wherever the assertion is about the
 * value; a deferred fake reader is used only where the assertion is about the
 * refresh schedule. Cache assertions are deterministic — the pending read is
 * resolved and flushed with a single macrotask boundary, never a sleep.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import type { ChildProcess } from "node:child_process";

import { createSubAgentManager } from "../../src/harness/subagent/manager.ts";
import type {
  SubAgentDefinition,
  SubAgentManager,
  SubagentActivityReader,
} from "../../src/harness/subagent/manager.ts";
import type {
  SubAgentEnvelope,
  WorkerEnvelope,
} from "../../src/harness/subagent/envelope.ts";
import type { AnthropicNativeMessage } from "../../src/harness/index.ts";
import {
  appendWorkerTranscript,
  readWorkerInFlightToolName,
} from "../../src/session-api/store/index.ts";

interface FakeChild {
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
  emit: (event: string | symbol, ...args: unknown[]) => boolean;
}

function makeFakeChild(): FakeChild {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: 31337,
    kill: () => true,
  }) as unknown as FakeChild;
}

function okEnvelope(result = "final"): SubAgentEnvelope {
  return { status: "ok", summary: "done", result };
}

function emitEnvelope(child: FakeChild, env: SubAgentEnvelope): void {
  child.stdout.write(JSON.stringify(env) + "\n");
  child.emit("exit", 0, null);
}

interface Harness {
  readonly manager: SubAgentManager;
  readonly spawned: FakeChild[];
  readonly spawnCalls: Array<{
    def: SubAgentDefinition;
    taskId: string;
    payload: WorkerEnvelope;
  }>;
}

function makeHarness(
  opts: {
    readonly subagentsDir?: string;
    readonly readInFlightTool?: SubagentActivityReader;
  } = {}
): Harness {
  const spawned: FakeChild[] = [];
  const spawnCalls: Harness["spawnCalls"] = [];
  const manager = createSubAgentManager({
    spawn: (def, taskId, payload) => {
      const child = makeFakeChild();
      spawned.push(child);
      spawnCalls.push({ def, taskId, payload });
      return child as unknown as ChildProcess;
    },
    ...(opts.subagentsDir !== undefined
      ? { subagentsDir: opts.subagentsDir }
      : {}),
    ...(opts.readInFlightTool !== undefined
      ? { readInFlightTool: opts.readInFlightTool }
      : {}),
  });
  return { manager, spawned, spawnCalls };
}

/** One macrotask boundary: every already-resolved reader continuation has run. */
async function flushPendingReads(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

/**
 * The production reader plus a handle on every read it started, so a test
 * awaits the read the manager kicked instead of sleeping. The manager
 * subscribes to the promise synchronously at kick time, so its cache write is
 * already done by the time `awaitReads()` returns.
 */
function trackedActivityReader(): {
  readonly reader: SubagentActivityReader;
  readonly awaitReads: () => Promise<void>;
} {
  const pending: Array<Promise<string>> = [];
  const reader: SubagentActivityReader = (query) => {
    const started = readWorkerInFlightToolName(query);
    pending.push(started);
    return started;
  };
  const awaitReads = async (): Promise<void> => {
    // Wave by wave: every list pass queues at most one read per live task.
    while (pending.length > 0) {
      const wave = pending.splice(0, pending.length);
      await Promise.all(wave);
      await flushPendingReads();
    }
  };
  return { reader, awaitReads };
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

function infoOf(
  manager: SubAgentManager,
  taskId: string
): ReturnType<SubAgentManager["listSubagents"]>[number] {
  const hit = manager.listSubagents().find((i) => i.taskId === taskId);
  assert.ok(hit, `task ${taskId} missing from listSubagents()`);
  return hit;
}

describe("SubagentInfo.inFlightTool — live worker's in-flight tool name", () => {
  let dir: string;
  let subagentsDir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "iknow-in-flight-"));
    subagentsDir = join(dir, "subagents");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Write that task's worker ledger exactly where the manager points it. */
  async function writeLedgerFor(
    payload: WorkerEnvelope,
    events: ReadonlyArray<AnthropicNativeMessage>
  ): Promise<string> {
    const transcriptPath = payload.transcriptPath;
    assert.ok(transcriptPath, "spawn payload must carry transcriptPath");
    await appendWorkerTranscript({
      location: {
        transcriptPath,
        taskId: payload.taskId ?? "unknown-task",
      },
      events,
    });
    return transcriptPath;
  }

  it("两个 live task 各有各的工人账 → 两个不同的名字，互不串台", async () => {
    const { reader, awaitReads } = trackedActivityReader();
    const { manager, spawnCalls } = makeHarness({
      subagentsDir,
      readInFlightTool: reader,
    });
    const a = manager.spawn({ task: "inspect A" });
    const b = manager.spawn({ task: "inspect B" });
    await writeLedgerFor(spawnCalls[0]!.payload, [toolUse("a-1", "bash")]);
    await writeLedgerFor(spawnCalls[1]!.payload, [
      toolUse("b-1", "web_search"),
    ]);

    // First pass: the list is synchronous and has nothing cached yet.
    manager.listSubagents();
    await awaitReads();

    assert.equal(infoOf(manager, a.taskId).inFlightTool, "bash");
    assert.equal(infoOf(manager, b.taskId).inFlightTool, "web_search");
  });

  it('工人账里所有 tool_use 都已结算 → 缓存值是 ""（空是有意义的读数，字段仍在）', async () => {
    const { reader, awaitReads } = trackedActivityReader();
    const { manager, spawnCalls } = makeHarness({
      subagentsDir,
      readInFlightTool: reader,
    });
    const { taskId } = manager.spawn({ task: "settled worker" });
    await writeLedgerFor(spawnCalls[0]!.payload, [
      toolUse("c-1", "grep"),
      toolResult("c-1"),
    ]);

    manager.listSubagents();
    await awaitReads();

    const info = infoOf(manager, taskId);
    assert.equal("inFlightTool" in info, true);
    assert.equal(info.inFlightTool, "");
  });

  it('工人账尚未落盘（spawn 后 worker 还没写账）→ ""，不抛', async () => {
    const { reader, awaitReads } = trackedActivityReader();
    const { manager, spawnCalls } = makeHarness({
      subagentsDir,
      readInFlightTool: reader,
    });
    const { taskId } = manager.spawn({ task: "no ledger yet" });
    assert.ok(spawnCalls[0]!.payload.transcriptPath);

    manager.listSubagents();
    await awaitReads();

    assert.equal(infoOf(manager, taskId).inFlightTool, "");
  });

  it('工人账不可解析 → list 不抛且读数为 ""（invalid records never reach the card）', async () => {
    const { reader, awaitReads } = trackedActivityReader();
    const { manager, spawnCalls } = makeHarness({
      subagentsDir,
      readInFlightTool: reader,
    });
    const { taskId } = manager.spawn({ task: "corrupt ledger" });
    const transcriptPath = spawnCalls[0]!.payload.transcriptPath!;
    mkdirSync(transcriptPath.replace(/\/[^/]+$/, ""), { recursive: true });
    writeFileSync(transcriptPath, "}{ not json at all\n", "utf8");

    manager.listSubagents();
    await awaitReads();

    assert.equal(infoOf(manager, taskId).inFlightTool, "");
  });

  it("不注入 reader → 条目与今天的形状逐字节相同（既无键也无 undefined 值）", async () => {
    const { manager } = makeHarness({ subagentsDir });
    const { taskId } = manager.spawn({ task: "T" });

    const info = infoOf(manager, taskId);
    const { taskId: _id, startedAt: _stamp, ...rest } = info;
    assert.deepEqual(rest, { state: "running", taskPreview: "T" });
    assert.equal("inFlightTool" in info, false);
  });

  it("装配没有账本目录（manager 直造）→ 不刷新、字段不出现", () => {
    const reader = vi.fn(readWorkerInFlightToolName);
    const { manager } = makeHarness({ readInFlightTool: reader });
    manager.spawn({ task: "no dir" });

    const info = manager.listSubagents()[0]!;
    assert.equal("inFlightTool" in info, false);
    assert.equal(reader.mock.calls.length, 0);
  });

  it("listSubagents 保持同步：同一 live task 只有一个在途刷新，落定前重复读不排队", async () => {
    const settle: Array<(name: string) => void> = [];
    const reader: SubagentActivityReader = () =>
      new Promise<string>((resolve) => settle.push(resolve));
    const { manager, spawnCalls } = makeHarness({
      subagentsDir,
      readInFlightTool: reader,
    });
    const { taskId } = manager.spawn({ task: "one refresh at a time" });

    manager.listSubagents();
    manager.listSubagents();
    manager.listSubagents();
    assert.equal(settle.length, 1, "guard flag: at most one outstanding read");
    assert.equal(spawnCalls.length, 1);

    settle[0]!("read_file");
    await flushPendingReads();
    assert.equal(infoOf(manager, taskId).inFlightTool, "read_file");

    // Cached now: the next pass surfaces it immediately and queues one refresh.
    manager.listSubagents();
    assert.equal(settle.length, 2);
  });

  it("任务进入终态 → 字段消失；父可见 handoff envelope 不携带它（SC6）", async () => {
    const { reader, awaitReads } = trackedActivityReader();
    const { manager, spawned, spawnCalls } = makeHarness({
      subagentsDir,
      readInFlightTool: reader,
    });
    const { taskId } = manager.spawn({ task: "will finish" });
    await writeLedgerFor(spawnCalls[0]!.payload, [toolUse("d-1", "edit_file")]);
    manager.listSubagents();
    await awaitReads();
    assert.equal(infoOf(manager, taskId).inFlightTool, "edit_file");

    emitEnvelope(spawned[0]!, okEnvelope("shipped"));

    const info = infoOf(manager, taskId);
    assert.equal(info.state, "completed");
    assert.equal("inFlightTool" in info, false);
    // The handoff envelope the parent reads is unchanged by this feature.
    const buffer = manager.queryBuffer(taskId) as SubAgentEnvelope;
    assert.equal(buffer.result, "shipped");
    assert.equal("inFlightTool" in buffer, false);
  });

  it("resume（同一外部 taskId 换新进程）→ 新进程的第一次 list 不带上一次的旧读数", async () => {
    const { reader, awaitReads } = trackedActivityReader();
    const { manager, spawned, spawnCalls } = makeHarness({
      subagentsDir,
      readInFlightTool: reader,
    });
    const { taskId } = manager.spawn({ task: "hop 1" });
    await writeLedgerFor(spawnCalls[0]!.payload, [toolUse("r-1", "edit_file")]);
    manager.listSubagents();
    await awaitReads();
    assert.equal(infoOf(manager, taskId).inFlightTool, "edit_file");

    // Terminal with **no** list pass in between, so the terminal-time eviction
    // never ran; resume is the only thing that can drop the previous hop's read.
    emitEnvelope(spawned[0]!, okEnvelope("hop 1 done"));
    manager.resumeTask!(taskId, { task: "hop 2" });

    const afterResume = infoOf(manager, taskId);
    assert.equal(afterResume.state, "running");
    assert.equal(
      "inFlightTool" in afterResume,
      false,
      "a brand-new process has no read yet — the old hop's name must not ride over"
    );
  });

  it('刷新失败的 reader（违约：本该永不 reject）→ 退化成 ""，list 不抛，且诊断里点一次名', async () => {
    const warns: string[] = [];
    const spy = vi
      .spyOn(console, "warn")
      .mockImplementation((...args: unknown[]) => {
        warns.push(args.map(String).join(" "));
      });
    const reader: SubagentActivityReader = () =>
      Promise.reject(new Error("reader broke its contract"));
    const { manager } = makeHarness({ subagentsDir, readInFlightTool: reader });
    const { taskId } = manager.spawn({ task: "rejecting reader" });

    manager.listSubagents();
    await flushPendingReads();
    manager.listSubagents();
    await flushPendingReads();

    assert.equal(infoOf(manager, taskId).inFlightTool, "");
    // One assembly-level defect, named once: a line per 1 Hz pass would bury
    // the render path it is there to explain.
    assert.equal(warns.length, 1);
    assert.match(warns[0]!, /in-flight tool reader/);
    spy.mockRestore();
  });

  it("reader 同步抛（同一种违约）→ 退化 + 点一次名，list 不抛", () => {
    const warns: string[] = [];
    const spy = vi
      .spyOn(console, "warn")
      .mockImplementation((...args: unknown[]) => {
        warns.push(args.map(String).join(" "));
      });
    const reader: SubagentActivityReader = () => {
      throw new Error("reader threw before returning a promise");
    };
    const { manager } = makeHarness({ subagentsDir, readInFlightTool: reader });
    const { taskId } = manager.spawn({ task: "throwing reader" });

    assert.doesNotThrow(() => manager.listSubagents());
    assert.equal(infoOf(manager, taskId).inFlightTool, "");
    assert.equal(warns.length, 1);
    spy.mockRestore();
  });
});

/**
 * The spawn record is line 1's only source, so the manager owns two sides of
 * it: the label must reach the parent-visible list (the card reads it there, and
 * a live turn's `tool_use.input` is not yet on the loaded transcript), and it
 * must never reach the worker.
 */
describe("SubagentInfo.title — spawn record 上到只读列表，且不下给 worker", () => {
  let dir: string;
  let subagentsDir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "iknow-card-title-"));
    subagentsDir = join(dir, "subagents");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("def.title 两侧空白 → 列表上是 trim 后的值", () => {
    const { manager } = makeHarness({ subagentsDir });
    const { taskId } = manager.spawn({ task: "t", title: "  Ship the card  " });
    assert.equal(infoOf(manager, taskId).title, "Ship the card");
  });

  it("live 与 completed 上是同一个值（第 1 行不随状态变）", () => {
    const { manager, spawned } = makeHarness({ subagentsDir });
    const { taskId } = manager.spawn({ task: "t", title: "查文档" });
    const live = infoOf(manager, taskId).title;

    emitEnvelope(spawned[0]!, okEnvelope("done"));

    assert.equal(infoOf(manager, taskId).title, live);
    assert.equal(live, "查文档");
  });

  it("def 无 title / 只有空白 → 列表上既无键也无 undefined 值（卡走 catalog 角色）", () => {
    const { manager } = makeHarness({ subagentsDir });
    const bare = manager.spawn({ task: "no label" });
    const blank = manager.spawn({ task: "blank label", title: " \t " });

    assert.equal("title" in infoOf(manager, bare.taskId), false);
    assert.equal("title" in infoOf(manager, blank.taskId), false);
  });

  it("SC6：worker payload 里没有任何 title 痕迹（标签只属于父侧）", () => {
    const { manager, spawnCalls } = makeHarness({ subagentsDir });
    manager.spawn({ task: "t", title: "Ship the card" });

    const payload = spawnCalls[0]!.payload as unknown as Record<
      string,
      unknown
    >;
    assert.equal("title" in payload, false);
    assert.equal(JSON.stringify(payload).includes("Ship the card"), false);
  });
});
