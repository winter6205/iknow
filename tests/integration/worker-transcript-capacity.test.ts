/**
 * 容量回归 — 工人 transcript 单写者契约在并行压力下的集成压测（ADR-0110）。
 *
 * 产品容量目标：单会话 ≥5 个 worker 并行、≥3 个会话并行互不干扰。
 * 写者模型（已核）：一文件一写者进程；per-instance 串行队列在装配点
 * （src/cli/worker-transcript.ts 的 createSerialQueue），store 层无锁是
 * 架构纪律（锁在装配边界）。本测试不起真子进程，而是同形装配：每个
 * (conversationId, taskId) 一个 storeWorkerTranscriptIo 实例 = 一个 worker
 * 写者进程，实例内不 await 并发发起多批 append（含 tool_use/tool_result
 * 形态），实例间 Promise.all 确定性交错（不 sleep 赌时序）。
 *
 * 钉住的不变式（每本账）：
 *   1. parseSessionJsonl 通过（交错 read-modify-write 造的重复 event id 在此抛）；
 *   2. 零重复 event id、parent 链按文件序合法、生效 head 指向链尾；
 *   3. 批次按入队顺序齐全（串行队列 FIFO）；
 *   4. 各 taskId 的事件只出现在各自文件（互不串写）。
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "vitest";

import { storeWorkerTranscriptIo } from "../../src/cli/worker-transcript.ts";
import { parseSessionJsonl } from "../../src/session-api/store/index.ts";
import type {
  AnthropicContentBlock,
  AnthropicNativeMessage,
} from "../../src/harness/model-adapter/types.ts";

// ── 批次构造 ─────────────────────────────────────────────────────────────────

function textBlock(text: string): AnthropicContentBlock {
  return { type: "text", text };
}

/**
 * 一批 = 一轮真实 worker 流量的形状：user 种子 → assistant tool_use →
 * user tool_result → assistant 收口文本。所有 text 带 `[taskId]` 前缀，
 * 串写检测据此判定（事件只要属于别的 taskId 就会破前缀不变式）。
 */
function makeBatch(taskId: string, batchIndex: number): AnthropicNativeMessage[] {
  const tag = `[${taskId}]`;
  const callId = `${taskId}-call-${batchIndex}`;
  return [
    { role: "user", content: [textBlock(`${tag}seed-${batchIndex}`)] },
    {
      role: "assistant",
      content: [
        textBlock(`${tag}before-tool-${batchIndex}`),
        { type: "tool_use", id: callId, name: "probe", input: { batchIndex } },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: callId, content: `${tag}result-${batchIndex}` },
      ],
    },
    { role: "assistant", content: [textBlock(`${tag}after-tool-${batchIndex}`)] },
  ];
}

function flattenTexts(messages: ReadonlyArray<AnthropicNativeMessage>): string[] {
  return messages.flatMap((m) =>
    m.content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
  );
}

// ── 场景驱动 ─────────────────────────────────────────────────────────────────

const BATCHES_PER_WORKER = 4;

interface WorkerDrive {
  readonly transcriptPath: string;
  readonly expectedTexts: string[];
}

/**
 * 模拟一个 worker 写者进程：一个 io 实例，不 await 地并发发起多批 append。
 * 同一实例内串行队列决定落盘顺序（FIFO），首批并行的 mkdir 竞态发生在
 * 共享的 `<convDir>/subagents` 前缀上。
 */
async function driveWorker(
  rootDir: string,
  conversationId: string,
  taskId: string
): Promise<WorkerDrive> {
  const transcriptPath = join(
    rootDir,
    conversationId,
    "subagents",
    taskId,
    `${taskId}.jsonl`
  );
  const io = storeWorkerTranscriptIo({ transcriptPath, taskId, cwd: rootDir });
  const batches = Array.from({ length: BATCHES_PER_WORKER }, (_, i) =>
    makeBatch(taskId, i)
  );
  await Promise.all(batches.map((messages) => io.appendMessages(messages)));
  return { transcriptPath, expectedTexts: batches.flatMap(flattenTexts) };
}

async function assertLedgerClean(drive: WorkerDrive, taskId: string): Promise<void> {
  const raw = await readFile(drive.transcriptPath, "utf8");
  const log = parseSessionJsonl(raw); // 重复 id / 断链在此抛 schema_invalid

  const ids = log.events.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length, `${taskId}: event id 不得重复`);

  let parent: string | null = null;
  for (const ev of log.events) {
    assert.equal(ev.parent, parent, `${taskId}: 事件链必须按文件序衔接`);
    parent = ev.id;
  }
  assert.equal(log.head, parent, `${taskId}: 生效 head 指向链尾`);

  const texts = flattenTexts(log.events.map((e) => e.message));
  assert.deepEqual(texts, drive.expectedTexts, `${taskId}: 批次齐全且按入队顺序`);

  // 串写检测：本账每个事件都带本 task 前缀（别的 taskId 混入即破）。
  for (const text of texts) {
    assert.ok(text.startsWith(`[${taskId}]`), `${taskId}: 账上混入非本 task 事件: ${text}`);
  }
}

function taskIds(n: number, prefix: string): string[] {
  return Array.from({ length: n }, (_, i) => `${prefix}-w${i}`);
}

// ── 测试 ─────────────────────────────────────────────────────────────────────

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "iknow-worker-transcript-capacity-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("工人 transcript 容量压测（stub fs，真 store 写路径）", () => {
  it("单会话 5 worker 并行：5 本账各自 parse 合法、链完整、互不串写", async () => {
    const ids = taskIds(5, "c1");
    const drives = await Promise.all(
      ids.map((taskId) => driveWorker(dir, "conv-single", taskId))
    );
    for (const [i, drive] of drives.entries()) {
      await assertLedgerClean(drive, ids[i]!);
    }
  });

  it("3 会话并行（15 实例全并发）：逐本账不干扰、全部合法", async () => {
    const plan = ["conv-a", "conv-b", "conv-c"].flatMap((conv, c) =>
      taskIds(5, `c${c}`).map((taskId) => ({ conv, taskId }))
    );
    const drives = await Promise.all(
      plan.map(({ conv, taskId }) => driveWorker(dir, conv, taskId))
    );
    for (const [i, drive] of drives.entries()) {
      await assertLedgerClean(drive, plan[i]!.taskId);
    }
  });
});
