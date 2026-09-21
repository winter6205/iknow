/**
 * Capacity regression — integration stress of the worker-transcript
 * single-writer contract under parallel load (ADR-0110).
 *
 * Product capacity target: ≥5 workers in one conversation and ≥3 conversations
 * in parallel, without interference. Writer model (verified): one writer
 * process per file; the per-instance serial queue lives at the assembly point
 * (createSerialQueue in src/cli/worker-transcript.ts) — the lock-free store
 * layer is an architectural discipline (locks at the assembly boundary). This
 * test spawns no real subprocesses; it assembles the same shape: one
 * storeWorkerTranscriptIo instance per (conversationId, taskId) = one worker
 * writer process, with multiple append batches fired concurrently (no await)
 * inside each instance (tool_use/tool_result shapes included), and
 * Promise.all deterministic interleaving across instances (no sleep-based timing bets).
 *
 * Pinned invariants (per ledger):
 *   1. parseSessionJsonl passes (duplicate event ids from interleaved read-modify-write throw here);
 *   2. zero duplicate event ids, parent chain legal in file order, effective head points at the chain tail;
 *   3. all batches present in enqueue order (serial queue FIFO);
 *   4. each taskId's events appear only in its own file (no cross-writes).
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

// ── batch construction ───────────────────────────────────────────────────────

function textBlock(text: string): AnthropicContentBlock {
  return { type: "text", text };
}

/**
 * One batch = one real worker turn's shape: user seed → assistant tool_use →
 * user tool_result → assistant closing text. Every text carries a `[taskId]`
 * prefix, which is how cross-write detection works (an event from another
 * taskId breaks the prefix invariant).
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

// ── scenario driver ──────────────────────────────────────────────────────────

const BATCHES_PER_WORKER = 4;

interface WorkerDrive {
  readonly transcriptPath: string;
  readonly expectedTexts: string[];
}

/**
 * Simulate one worker writer process: one io instance, multiple append batches
 * fired concurrently without awaiting. Within the same instance the serial
 * queue decides on-disk order (FIFO); the first-batch mkdir race happens on the
 * shared `<convDir>/subagents` prefix.
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
  const log = parseSessionJsonl(raw); // duplicate ids / broken chains throw schema_invalid here

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

  // Cross-write detection: every event here carries this task's prefix (any other taskId breaks it).
  for (const text of texts) {
    assert.ok(text.startsWith(`[${taskId}]`), `${taskId}: 账上混入非本 task 事件: ${text}`);
  }
}

function taskIds(n: number, prefix: string): string[] {
  return Array.from({ length: n }, (_, i) => `${prefix}-w${i}`);
}

// ── tests ────────────────────────────────────────────────────────────────────

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
