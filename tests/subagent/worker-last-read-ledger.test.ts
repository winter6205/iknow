/**
 * Worker 装配 × last-read 账本（ADR-0084 / specs/aci-file-search-surface.md D1）。
 *
 * 不变式（spec D1「子代理新 conversation 空表」的装配层含义）：
 *   - 子代理是**独立** conversation：worker 按 envelope.taskId 拿自己的一份
 *     **空桶**，不共享父会话的账本条目；
 *   - 于是 worker 内「先 `read_file` 同一文件、再 `write_file`」必须成功
 *     （那次读入了它自己的桶）；
 *   - 没读过的非空文件仍拒（typed `last_read_required`），字节不变；
 *   - 桶是**空的**起点：只因为读过 a.ts 就放行 b.ts 的覆写是错的。
 *
 * 走真实装配：`createWorkerDeps` → `createDefaultAciRegistry` →
 * `createAciExecutor`，再经 `runWorkerOnce` 跑真 loop-engine（stub-model
 * 脚本化 read→write 两跳）。刻意不 stub 账本、不直调 handler —— 否则
 * 「装配层漏传 conversationId」这条缺陷会被测试自己绕过去。
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

/** 测试用 minimal IknowEnv — createWorkerDeps 路径类型要求，不真发请求。 */
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
 * stub-model 包装：每次 step 入口抓一份 messages 快照。
 *
 * loop-engine 的 RunResult 不回传工具结果，`runWorkerOnce` 的 envelope 也不
 * 带它们 —— 想断言「write_file 是被拒还是被放行」，只能从权威历史里读那条
 * tool_result（模型实际看到的就是它）。
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

/** 从权威历史里取某个 tool_use_id 的 tool_result 文本（模型可见判据）。 */
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

/** hermetic worker 装配缝：scratch root + scratch home + noop trace。 */
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
// A. conversationId 接线 —— 子代理拿到自己的 id（不是父会话的，不伪造）
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
    // 与 trace 的契约不同:file-mode 要求 traceFilePath + taskId 配对
    // (缺席则装配期 fail-loud),而账本只需要 taskId。这条锁住「不把账本
    // 挂在 traceFilePath 分支里」——否则只传 taskId 的 caller 会静默没 id。
    const root = await makeScratch("worker-last-read-wire-");
    const adapter = createStubModel({ responses: [] });

    const deps = await createWorkerDeps(
      workerOpts(root, adapter, { taskId: TASK_ID })
    );

    assert.equal(deps.conversationId, TASK_ID);
  });

  it("两次装配 = 两份独立账本 host：上一次 worker 的读不残留到下一次", async () => {
    // worker 每次 spawn 都是新进程 + 新 registry，故每份 host 各自从空表开始
    // —— spec「子代理新 conversation 空表」里「空」的那一半。若 host 是进程级
    // 单例（或挂在模块级常量上），下面第二次装配会因上一次的读而放行，变红。
    const root = await makeScratch("worker-last-read-fresh-");
    const target = join(root, "a.ts");
    await writeFile(target, "original\n");

    // 第一次装配：真读入账（走完整装配路径,不直调 handler）。
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

    // 第二次装配：同一 TASK_ID、同一路径 —— 但这是另一次 spawn，桶重新是空的。
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
// B. SC1 在 worker 装配路径上成立 —— 先读后写放行
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
// C. SC3 在 worker 装配路径上成立 —— 未读非空文件仍拒（typed 文案 + 字节不变）
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
// D. legacy envelope（无 taskId）—— 无 id → 非空覆写 fail-closed（spec D1 不变）
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
    // 读仍然成功（无 id 只影响入账，不拒绝读）。
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
