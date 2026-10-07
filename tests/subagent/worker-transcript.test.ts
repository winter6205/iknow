/**
 * ADR-0102 — worker transcript disk-write chain tests.
 *
 * One invariant pinned per surface:
 *   A. manager payload: at spawn, transcriptPath is separate from the
 *      per-agent trace (same directory, different file; never overwrites
 *      `agent-<taskId>.jsonl`), plus degraded edges for empty parent id /
 *      assembly without a directory.
 *   B. worker runWorkerOnce: wiring present -> seed + commit batches land
 *      while running, and the load projection contains this conversation's
 *      events; absent -> zero calls (byte-stable legacy shape).
 *   C. fence-tmp enumeration: worker transcripts never enter the trace-record list.
 *
 * Storage codec and listSessions-exclusion assertions live in
 * tests/session-api/worker-transcript-store.test.ts (the other half of the same seam).
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "vitest";
import type { ChildProcess } from "node:child_process";

import { createSubAgentManager } from "../../src/harness/subagent/manager.ts";
import type {
  SubAgentDefinition,
  SubAgentManager,
} from "../../src/harness/subagent/manager.ts";
import type { WorkerEnvelope } from "../../src/harness/subagent/envelope.ts";
import { runWorkerOnce } from "../../src/harness/subagent/worker.ts";
import type { WorkerTranscriptIOFactory } from "../../src/harness/subagent/worker.ts";
import type { LoopEngineDeps } from "../../src/harness/loop-engine.ts";
import type {
  AssistantTurnResult,
  ModelAdapter,
} from "../../src/harness/model-adapter/types.ts";
import { listSubagentRecordPaths } from "../../src/harness/sandbox/fence-tmp.ts";
import {
  appendWorkerTranscript,
  loadWorkerTranscript,
} from "../../src/session-api/store/index.ts";
import { assistantResult } from "../cli/_fixtures.ts";

// ── fake child (follows the manager.test.ts precedent) ──────────────────────

function makeFakeChild(): ChildProcess {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: 31337,
    kill: () => true,
  }) as unknown as ChildProcess;
}

function managerCapturingPayload(setup: {
  readonly subagentsDir?: string;
  readonly projectDir?: string;
}): {
  manager: SubAgentManager;
  payloads: Array<{
    def: SubAgentDefinition;
    taskId: string;
    payload: WorkerEnvelope;
  }>;
} {
  const payloads: Array<{
    def: SubAgentDefinition;
    taskId: string;
    payload: WorkerEnvelope;
  }> = [];
  const manager = createSubAgentManager({
    spawn: (def, taskId, payload) => {
      payloads.push({ def, taskId, payload });
      return makeFakeChild();
    },
    ...(setup.subagentsDir !== undefined
      ? { subagentsDir: setup.subagentsDir }
      : {}),
    ...(setup.projectDir !== undefined ? { projectDir: setup.projectDir } : {}),
  });
  return { manager, payloads };
}

// ── minimal stub deps (same shape as graceful-timeout.test.ts) ──────────────

function makeDeps(adapter: ModelAdapter): LoopEngineDeps {
  return {
    adapter,
    executor: undefined as never,
    registry: { list: () => [], get: () => undefined },
    system: () => undefined,
    promptTools: () => [],
  } as unknown as LoopEngineDeps;
}

function scriptedAdapter(text: string): ModelAdapter {
  return {
    step: async () =>
      assistantResult({ texts: [text], toolCalls: [] }) as AssistantTurnResult,
    streamMode: false,
    encodeUserText: (value: string) => ({
      role: "user",
      content: [{ type: "text", text: value }],
    }),
    encodeToolResults: () => [],
  } as unknown as ModelAdapter;
}

/** Test copy of the production implementation: store seam -> the narrow IO of runWorkerOnce. */
function storeBackedTranscriptIo(): WorkerTranscriptIOFactory {
  return (loc) => ({
    loadMessages: async () => {
      try {
        const file = await loadWorkerTranscript({
          transcriptPath: loc.transcriptPath,
          taskId: loc.taskId,
        });
        return { status: "present", messages: file.messages };
      } catch (err) {
        if ((err as { kind?: string }).kind === "not_found") {
          return { status: "absent" };
        }
        throw err;
      }
    },
    appendMessages: async (events, thinkingMs) => {
      await appendWorkerTranscript({
        location: { transcriptPath: loc.transcriptPath, taskId: loc.taskId },
        events,
        ...(thinkingMs !== undefined ? { thinkingMs } : {}),
        cwd: loc.cwd,
      });
    },
  });
}

describe("ADR-0102 T3 — manager payload 的 transcriptPath（与 trace 分家）", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "iknow-worker-transcript-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("subagentsDir 在场 → transcriptPath = <subagents>/<taskId>/<taskId>.jsonl，≠ traceFilePath", () => {
    const subagentsDir = join(dir, "parent-conv", "subagents");
    const { manager, payloads } = managerCapturingPayload({ subagentsDir });
    const { taskId } = manager.spawn({
      task: "T",
      conversationId: "parent-conv",
    } as SubAgentDefinition);
    assert.equal(payloads.length, 1);
    const { payload } = payloads[0]!;
    assert.equal(payload.taskId, taskId);
    assert.equal(
      payload.transcriptPath,
      join(subagentsDir, taskId, `${taskId}.jsonl`)
    );
    assert.equal(
      payload.traceFilePath,
      join(subagentsDir, taskId, `agent-${taskId}.jsonl`)
    );
    assert.notEqual(payload.traceFilePath, payload.transcriptPath);
    // At spawn time: the layout directory exists but the worker transcript is
    // unwritten (the worker appends while running); the per-agent trace file
    // exists independently (never overwritten / never shared).
    assert.ok(existsSync(join(subagentsDir, taskId)));
    assert.ok(!existsSync(payload.transcriptPath!));
    assert.ok(existsSync(payload.traceFilePath!));
  });

  it("空父 conversationId + projectDir → 项目层平铺落点仍派生（不崩、不猜叶子）", () => {
    const { manager, payloads } = managerCapturingPayload({
      projectDir: join(dir, "project"),
    });
    const { taskId } = manager.spawn({ task: "T", conversationId: "" });
    const { payload } = payloads[0]!;
    assert.equal(
      payload.transcriptPath,
      join(dir, "project", "subagents", taskId, `${taskId}.jsonl`)
    );
  });

  it("无 subagentsDir / projectDir（manager 直造 / legacy 装配）→ 三键整个省略（byte-stable 旧形态）", () => {
    const { manager, payloads } = managerCapturingPayload({});
    manager.spawn({ task: "T" });
    const { payload } = payloads[0]!;
    assert.equal(payload.transcriptPath, undefined);
    assert.equal(payload.traceFilePath, undefined);
    assert.equal(payload.taskId, undefined);
  });

  it("工人账不进 trace record 枚举（listSubagentRecordPaths 只认 agent-*.jsonl）", async () => {
    const subagentsDir = join(dir, "flat-subagents");
    const taskId = "task-enumeration";
    await appendWorkerTranscript({
      location: {
        transcriptPath: join(subagentsDir, taskId, `${taskId}.jsonl`),
        taskId,
      },
      events: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    });
    const listed = listSubagentRecordPaths(subagentsDir);
    assert.deepEqual(listed, []);
  });
});

describe("ADR-0102 T3 — runWorkerOnce 边跑边 append 工人账", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "iknow-worker-transcript-run-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("新 spawn → seed + assistant commit 落账，load 投影含本次对话事件", async () => {
    const transcriptPath = join(dir, "t1", "t1.jsonl");
    const envelope: WorkerEnvelope = {
      task: "inspect the repo",
      sandboxRoot: dir,
      taskId: "t1",
      transcriptPath,
      writeSituation: "writable_main",
    };
    const env = await runWorkerOnce({
      workerEnvelope: envelope,
      deps: makeDeps(scriptedAdapter("all good")),
      transcriptIo: storeBackedTranscriptIo(),
    });
    assert.equal(env.status, "ok");

    const file = await loadWorkerTranscript({ transcriptPath, taskId: "t1" });
    const texts = file.messages.flatMap((m) =>
      m.content
        .filter((b) => b.type === "text")
        .map((b) => (b as { text: string }).text)
    );
    // Initial history (write-root prior segment + task user) lands via seed,
    // the assistant final lands via commit — the projection contains both.
    assert.ok(
      texts.some((t) => t.includes("inspect the repo")),
      `transcript must contain the task user message; got ${JSON.stringify(texts)}`
    );
    assert.ok(texts.includes("all good"));
    assert.equal(file.conversation_id, "t1");
  });

  it("envelope 无 transcriptPath → IO 零调用（旧 envelope 逐字节不变）", async () => {
    let calls = 0;
    const io: WorkerTranscriptIOFactory = () => {
      calls += 1;
      return {
        loadMessages: async () => ({ status: "absent" }),
        appendMessages: async () => {},
      };
    };
    const env = await runWorkerOnce({
      workerEnvelope: { task: "legacy", sandboxRoot: dir },
      deps: makeDeps(scriptedAdapter("done")),
      transcriptIo: io,
    });
    assert.equal(env.status, "ok");
    assert.equal(calls, 0);
    assert.ok(!existsSync(join(dir, "legacy.jsonl")));
  });

  it("transcriptPath 在场但 IO 未注入 → 任务照跑、零落账（装配漏接不伪装成契约）", async () => {
    const transcriptPath = join(dir, "t3", "t3.jsonl");
    const env = await runWorkerOnce({
      workerEnvelope: {
        task: "no-io",
        sandboxRoot: dir,
        taskId: "t3",
        transcriptPath,
      },
      deps: makeDeps(scriptedAdapter("fine")),
    });
    assert.equal(env.status, "ok");
    assert.ok(!existsSync(transcriptPath));
  });

  it("二次 run（continue 臂的机械面）→ 盘上账作 prefix，只 seed 新句", async () => {
    const transcriptPath = join(dir, "t4", "t4.jsonl");
    const io = storeBackedTranscriptIo();
    await runWorkerOnce({
      workerEnvelope: {
        task: "first sentence",
        sandboxRoot: dir,
        taskId: "t4",
        transcriptPath,
      },
      deps: makeDeps(scriptedAdapter("reply-1")),
      transcriptIo: io,
    });
    const afterFirst = await loadWorkerTranscript({
      transcriptPath,
      taskId: "t4",
    });
    assert.equal(afterFirst.messages.length, 2); // user(task) + assistant

    await runWorkerOnce({
      workerEnvelope: {
        task: "second sentence",
        sandboxRoot: dir,
        taskId: "t4",
        transcriptPath,
      },
      deps: makeDeps(scriptedAdapter("reply-2")),
      transcriptIo: io,
    });
    const afterSecond = await loadWorkerTranscript({
      transcriptPath,
      taskId: "t4",
    });
    // The prior ledger stays a byte-exact prefix + one new user turn + one new assistant round.
    assert.equal(afterSecond.messages.length, 4);
    const texts = afterSecond.messages.flatMap((m) =>
      m.content
        .filter((b) => b.type === "text")
        .map((b) => (b as { text: string }).text)
    );
    assert.deepEqual(texts, [
      "first sentence",
      "reply-1",
      "second sentence",
      "reply-2",
    ]);
  });
});
