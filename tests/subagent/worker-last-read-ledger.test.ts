/**
 * Worker assembly x last-read ledger (ADR-0084).
 *
 * Invariant (assembly-layer meaning of "a subagent is a fresh conversation
 * with an empty table"):
 *   - a subagent is an **independent** conversation: the worker gets its own
 *     **empty bucket** keyed by envelope.taskId, sharing no ledger entries
 *     with the parent session;
 *   - hence inside a worker, "read_file then write_file the same file" must
 *     succeed (the read landed in its own bucket);
 *   - an unread non-empty file is still refused (typed
 *     `last_read_required`), bytes unchanged;
 *   - the bucket starts **empty**: reading a.ts must never allow overwriting b.ts.
 *
 * Uses the real assembly path: `createWorkerDeps` → `createDefaultAciRegistry`
 * → `createAciExecutor`, then a real loop-engine via `runWorkerOnce`
 * (stub-model scripted read→write two hops). Deliberately no ledger stub and
 * no direct handler calls — otherwise the "assembly forgot to pass
 * conversationId" defect would be bypassed by the test itself.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";

import { createStubModel } from "../../src/harness/stubs/stub-model.ts";
import {
  createWorkerDeps,
  runWorkerOnce,
  type CreateWorkerDepsOptions,
} from "../../src/harness/subagent/worker.ts";
import { createSkillCatalog } from "../../src/harness/skill/catalog.ts";
import { createNoopTraceService } from "../../src/harness/trace/noop.ts";
import type { LoopEngineDeps } from "../../src/harness/loop-engine.ts";
import type {
  AnthropicContentBlock,
  AnthropicNativeMessage,
  AssistantTurnResult,
} from "../../src/harness/model-adapter/types.ts";
import type { WorkerEnvelope } from "../../src/harness/subagent/envelope.ts";
import type { IknowEnv } from "../../src/config/env.ts";
import { assistantResult } from "../cli/_fixtures.ts";

/** Minimal test IknowEnv — required by createWorkerDeps typing; no real requests. */
const TEST_ENV: IknowEnv = {
  llm: {
    apiKey: "test-key",
    baseUrl: "https://example.test",
    model: "test-model",
    fallback: [],
    maxOutputTokens: 1024,
    temperature: 0,
    stream: "off",
    thinking: "off",
    thinkingEffort: "",
    timeoutMs: 60_000,
  },
  web: { proxy: undefined, searchUrl: undefined },
  compress: { contextWindow: 200000, thresholdTokens: undefined },
  chat: { showThinking: false },
  mcp: { connectTimeoutMs: 60_000 },
  subagent: { taskTimeoutMs: undefined },
  workspaceRoot: undefined,
  productRoot: undefined,
};

const TASK_ID = "11111111-2222-4333-8444-555555555555";

const scratchPaths: string[] = [];

async function makeScratch(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  scratchPaths.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(
    scratchPaths
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true }))
  );
});

/**
 * stub-model wrapper: capture a messages snapshot at each step entry.
 *
 * loop-engine's RunResult never returns tool results and `runWorkerOnce`'s
 * envelope doesn't carry them either — to assert "was write_file refused or
 * allowed" we must read that tool_result from the authoritative history
 * (it is exactly what the model saw).
 */
function capturingAdapter(responses: AssistantTurnResult[]): {
  readonly adapter: LoopEngineDeps["adapter"];
  readonly seen: Array<ReadonlyArray<AnthropicNativeMessage>>;
} {
  const inner = createStubModel({ responses });
  const seen: Array<ReadonlyArray<AnthropicNativeMessage>> = [];
  const adapter: LoopEngineDeps["adapter"] = {
    ...inner,
    async step(state, request, signal) {
      seen.push(state.messages);
      return inner.step(state, request, signal);
    },
  };
  return { adapter, seen };
}

/** tool_result text for a tool_use_id from the authoritative history (model-visible). */
function toolResultText(
  messages: ReadonlyArray<AnthropicNativeMessage> | undefined,
  toolUseId: string
): string | undefined {
  if (messages === undefined) return undefined;
  for (const message of messages) {
    for (const block of message.content as ReadonlyArray<AnthropicContentBlock>) {
      if (block.type !== "tool_result" || block.tool_use_id !== toolUseId) {
        continue;
      }
      const content: unknown = block.content;
      if (typeof content === "string") return content;
      if (Array.isArray(content)) {
        return (content as ReadonlyArray<AnthropicContentBlock>)
          .map((b) => (b.type === "text" ? b.text : ""))
          .join("");
      }
    }
  }
  return undefined;
}

/** Hermetic worker assembly seam: scratch root + scratch home + noop trace. */
function workerOpts(
  root: string,
  adapter: LoopEngineDeps["adapter"],
  extra?: Partial<CreateWorkerDepsOptions>
): CreateWorkerDepsOptions {
  return {
    env: TEST_ENV,
    sandboxRoot: root,
    cwd: root,
    userHome: join(root, "home"),
    model: adapter,
    skillCatalog: createSkillCatalog([]),
    system: async () => undefined,
    trace: createNoopTraceService(),
    ...extra,
  };
}

function readThenWrite(callIds: { read: string; write: string }) {
  return [
    assistantResult({
      texts: [],
      toolCalls: [
        { id: callIds.read, name: "read_file", input: { path: "a.ts" } },
      ],
    }),
    assistantResult({
      texts: [],
      toolCalls: [
        {
          id: callIds.write,
          name: "write_file",
          input: { path: "a.ts", content: "new content\n" },
        },
      ],
    }),
    assistantResult({ texts: ["done"], toolCalls: [] }),
  ];
}

// ---------------------------------------------------------------------------
// A. conversationId wiring — the subagent gets its own id (not the parent's, never fabricated)
// ---------------------------------------------------------------------------

describe("worker 装配：last-read 账本的 conversationId 接线", () => {
  it("envelope.taskId 在场 → deps.conversationId = taskId（子代理自己的桶）", async () => {
    const root = await makeScratch("worker-last-read-wire-");
    const adapter = createStubModel({ responses: [] });

    const deps = await createWorkerDeps(
      workerOpts(root, adapter, { taskId: TASK_ID })
    );

    assert.equal(deps.conversationId, TASK_ID);
  });

  it("taskId 缺席（legacy envelope）→ 不伪造身份，conversationId 仍缺席", async () => {
    const root = await makeScratch("worker-last-read-wire-");
    const adapter = createStubModel({ responses: [] });

    const deps = await createWorkerDeps(workerOpts(root, adapter));

    assert.equal(deps.conversationId, undefined);
  });

  it("taskId 在场但 traceFilePath 缺席 → 账本 id 仍生效（两键不是绑死的）", async () => {
    // Unlike the trace contract: file-mode requires traceFilePath + taskId
    // paired (fail-loud at assembly if missing), while the ledger only needs
    // taskId. This pins "the ledger is not nested in the traceFilePath
    // branch" — otherwise taskId-only callers would silently lose their id.
    const root = await makeScratch("worker-last-read-wire-");
    const adapter = createStubModel({ responses: [] });

    const deps = await createWorkerDeps(
      workerOpts(root, adapter, { taskId: TASK_ID })
    );

    assert.equal(deps.conversationId, TASK_ID);
  });

  it("两次装配 = 两份独立账本 host：上一次 worker 的读不残留到下一次", async () => {
    // Each spawn is a new process + new registry, so every host starts from
    // an empty table — the "empty" half of "subagent = fresh conversation".
    // If the host were a process-level singleton (or a module-level constant),
    // the second assembly below would be allowed through by the first read and go red.
    const root = await makeScratch("worker-last-read-fresh-");
    const target = join(root, "a.ts");
    await writeFile(target, "original\n");

    // First assembly: a real read lands in the ledger (full assembly path, no direct handler call).
    const first = capturingAdapter([
      assistantResult({
        texts: [],
        toolCalls: [{ id: "c1", name: "read_file", input: { path: "a.ts" } }],
      }),
      assistantResult({ texts: ["done"], toolCalls: [] }),
    ]);
    const firstDeps = await createWorkerDeps(
      workerOpts(root, first.adapter, { taskId: TASK_ID })
    );
    await runWorkerOnce({
      workerEnvelope: { task: "read a", sandboxRoot: root },
      deps: firstDeps,
    });
    const readResult = toolResultText(first.seen.at(-1), "c1");
    assert.ok(
      readResult !== undefined && !readResult.startsWith("[execution_failed]"),
      `第一次装配的 read_file 应先成功，实际: ${readResult}`
    );

    // Second assembly: same TASK_ID, same path — but a different spawn, so the bucket is empty again.
    const second = capturingAdapter([
      assistantResult({
        texts: [],
        toolCalls: [
          {
            id: "c2",
            name: "write_file",
            input: { path: "a.ts", content: "clobbered\n" },
          },
        ],
      }),
      assistantResult({ texts: ["done"], toolCalls: [] }),
    ]);
    const secondDeps = await createWorkerDeps(
      workerOpts(root, second.adapter, { taskId: TASK_ID })
    );
    await runWorkerOnce({
      workerEnvelope: { task: "write a", sandboxRoot: root },
      deps: secondDeps,
    });
    const writeResult = toolResultText(second.seen.at(-1), "c2");
    assert.ok(
      writeResult !== undefined &&
        writeResult.startsWith(
          "[execution_failed] [write_file] refusing to overwrite a non-empty file"
        ),
      `上一次装配的读不得残留到下一次（桶必须是空的起点），实际: ${writeResult}`
    );
    assert.equal(await readFile(target, "utf8"), "original\n");
  });
});

// ---------------------------------------------------------------------------
// B. read-before-write is allowed on the worker assembly path
// ---------------------------------------------------------------------------

describe("worker 装配路径：read_file 后 write_file 同一文件", () => {
  it("先 read_file 再 write_file 覆写 → 写入成功（读入的是 worker 自己的桶）", async () => {
    const root = await makeScratch("worker-last-read-rw-");
    const target = join(root, "a.ts");
    await writeFile(target, "old content\n");

    const { adapter, seen } = capturingAdapter(
      readThenWrite({ read: "c1", write: "c2" })
    );
    const deps = await createWorkerDeps(
      workerOpts(root, adapter, { taskId: TASK_ID })
    );

    const env = await runWorkerOnce({
      workerEnvelope: { task: "read then write", sandboxRoot: root },
      deps,
    });

    assert.equal(env.status, "ok");
    const finalMessages = seen.at(-1);
    assert.ok(finalMessages, "stub 至少被调用一次");

    const readResult = toolResultText(finalMessages, "c1");
    assert.ok(
      readResult !== undefined && !readResult.startsWith("[execution_failed]"),
      `read_file 应先成功，实际: ${readResult}`
    );
    const writeResult = toolResultText(finalMessages, "c2");
    assert.ok(writeResult !== undefined, "write_file 必须有 tool_result");
    assert.ok(
      !writeResult.startsWith("[execution_failed]"),
      `write_file 不应被拒（账本漏接线），实际: ${writeResult}`
    );
    assert.equal(await readFile(target, "utf8"), "new content\n");
  });
});

// ---------------------------------------------------------------------------
// C. unread non-empty files stay refused on the worker assembly path (typed message + bytes unchanged)
// ---------------------------------------------------------------------------

describe("worker 装配路径：未读的非空文件仍被拒", () => {
  it("worker 没读过 → typed last_read_required，字节不变", async () => {
    const root = await makeScratch("worker-last-read-sc3-");
    const target = join(root, "a.ts");
    await writeFile(target, "original\n");

    const { adapter, seen } = capturingAdapter([
      assistantResult({
        texts: [],
        toolCalls: [
          {
            id: "w1",
            name: "write_file",
            input: { path: "a.ts", content: "clobbered\n" },
          },
        ],
      }),
      assistantResult({ texts: ["done"], toolCalls: [] }),
    ]);
    const deps = await createWorkerDeps(
      workerOpts(root, adapter, { taskId: TASK_ID })
    );

    const env = await runWorkerOnce({
      workerEnvelope: { task: "write unread", sandboxRoot: root },
      deps,
    });
    assert.equal(env.status, "ok");

    const finalMessages = seen.at(-1);
    assert.ok(finalMessages);
    const writeResult = toolResultText(finalMessages, "w1");
    assert.ok(writeResult !== undefined, "write_file 必须有 tool_result");
    assert.match(
      writeResult,
      /^\[execution_failed\] \[write_file\] refusing to overwrite a non-empty file that was not read in this conversation: /
    );
    assert.ok(
      writeResult.includes(target),
      `拒绝文案必须点名规范绝对 path，实际: ${writeResult}`
    );
    assert.ok(
      writeResult.includes("read_file"),
      `拒绝文案必须点名 read_file，实际: ${writeResult}`
    );
    assert.equal(await readFile(target, "utf8"), "original\n");
  });

  it("桶是空起点：读过 a.ts 不代表 b.ts 可覆写", async () => {
    const root = await makeScratch("worker-last-read-empty-bucket-");
    await writeFile(join(root, "a.ts"), "old a\n");
    await writeFile(join(root, "b.ts"), "old b\n");

    const { adapter, seen } = capturingAdapter([
      assistantResult({
        texts: [],
        toolCalls: [{ id: "c1", name: "read_file", input: { path: "a.ts" } }],
      }),
      assistantResult({
        texts: [],
        toolCalls: [
          {
            id: "c2",
            name: "write_file",
            input: { path: "b.ts", content: "clobbered b\n" },
          },
        ],
      }),
      assistantResult({ texts: ["done"], toolCalls: [] }),
    ]);
    const deps = await createWorkerDeps(
      workerOpts(root, adapter, { taskId: TASK_ID })
    );

    await runWorkerOnce({
      workerEnvelope: { task: "read a, write b", sandboxRoot: root },
      deps,
    });

    const finalMessages = seen.at(-1);
    assert.ok(finalMessages);
    const writeResult = toolResultText(finalMessages, "c2");
    assert.ok(
      writeResult !== undefined &&
        writeResult.startsWith(
          "[execution_failed] [write_file] refusing to overwrite a non-empty file"
        ),
      `未读的 b.ts 必须仍被拒，实际: ${writeResult}`
    );
    assert.equal(await readFile(join(root, "b.ts"), "utf8"), "old b\n");
  });
});

// ---------------------------------------------------------------------------
// D. legacy envelope (no taskId) — no id -> non-empty overwrite fails closed
// ---------------------------------------------------------------------------

describe("worker 装配路径：无 id 的 legacy envelope 保持 fail-closed", () => {
  it("envelope 无 taskId → 非空覆写仍拒（不引入隐式全局桶）", async () => {
    const root = await makeScratch("worker-last-read-legacy-");
    const target = join(root, "a.ts");
    await writeFile(target, "original\n");

    const { adapter, seen } = capturingAdapter([
      assistantResult({
        texts: [],
        toolCalls: [{ id: "c1", name: "read_file", input: { path: "a.ts" } }],
      }),
      assistantResult({
        texts: [],
        toolCalls: [
          {
            id: "c2",
            name: "write_file",
            input: { path: "a.ts", content: "clobbered\n" },
          },
        ],
      }),
      assistantResult({ texts: ["done"], toolCalls: [] }),
    ]);
    const deps = await createWorkerDeps(workerOpts(root, adapter));

    const envelope: WorkerEnvelope = { task: "legacy", sandboxRoot: root };
    assert.equal(envelope.taskId, undefined, "fixture: legacy wire 无 taskId");
    await runWorkerOnce({ workerEnvelope: envelope, deps });

    const finalMessages = seen.at(-1);
    assert.ok(finalMessages);
    // Reads still succeed (no id only affects ledger writes, never blocks reads).
    const readResult = toolResultText(finalMessages, "c1");
    assert.ok(
      readResult !== undefined && !readResult.startsWith("[execution_failed]"),
      `read_file 无 id 仍应可执行，实际: ${readResult}`
    );
    const writeResult = toolResultText(finalMessages, "c2");
    assert.ok(
      writeResult !== undefined &&
        writeResult.startsWith(
          "[execution_failed] [write_file] refusing to overwrite a non-empty file"
        ),
      `无 id 的非空覆写必须 fail-closed，实际: ${writeResult}`
    );
    assert.equal(await readFile(target, "utf8"), "original\n");
  });
});
