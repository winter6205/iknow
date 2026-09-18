/**
 * ADR-0102 / plan subagent-stop-and-continue T3 — 工人 transcript 写盘链测试。
 *
 * 三面各钉一条不变式：
 *   A. manager payload：spawn 时 transcriptPath 与 per-agent trace 分家
 *      （同目录不同文件，不覆盖 `agent-<taskId>.jsonl`），并覆盖空父 id /
 *      无目录装配的退化边界（锁句 3、6）。
 *   B. worker runWorkerOnce：接线在场 → seed + commit 批边跑边落账，
 *      load 投影含本次对话事件；缺席 → 零调用（byte-stable 旧形态）。
 *   C. fence-tmp 枚举：工人账不进 trace record 名单。
 *
 * 存储 codec 与 listSessions 不收录的断言在
 * tests/session-api/worker-transcript-store.test.ts（同一缝的另一半）。
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
import type {
  SubAgentEnvelope,
  WorkerEnvelope,
} from "../../src/harness/subagent/envelope.ts";
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

// ── fake child（沿用 manager.test.ts 先例）───────────────────────────────────

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
  payloads: Array<{ def: SubAgentDefinition; taskId: string; payload: WorkerEnvelope }>;
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

function okEnvelope(result = "ok"): SubAgentEnvelope {
  return { status: "ok", summary: result, result };
}

// ── minimal stub deps (与 graceful-timeout.test.ts 同构) ─────────────────────

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

/** 生产同一实现的测试拷贝：store 缝 → runWorkerOnce 的窄 IO。 */
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
    assert.equal(payload.transcriptPath, join(subagentsDir, taskId, `${taskId}.jsonl`));
    assert.equal(
      payload.traceFilePath,
      join(subagentsDir, taskId, `agent-${taskId}.jsonl`)
    );
    assert.notEqual(payload.traceFilePath, payload.transcriptPath);
    // spawn 时刻：布局目录已建，工人账尚未写（worker 边跑边 append）；
    // per-agent trace 文件独立存在（不覆盖 / 不共用）。
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
    // 初始历史（write-root prior 段 + task user）经 seed 落账，
    // assistant 终稿经 commit 落账 —— 投影两条都在。
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
    const afterFirst = await loadWorkerTranscript({ transcriptPath, taskId: "t4" });
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
    const afterSecond = await loadWorkerTranscript({ transcriptPath, taskId: "t4" });
    // 续跑前账本原样作 prefix + 新 user 一句 + 新 assistant 一轮。
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
