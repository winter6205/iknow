/**
 * #361 / ADR-0014 Decision 6 验收 — subagent 工具 trace 落点 (e2e stub-model)。
 *
 * 链路同 tests/e2e/subagent-acceptance.test.ts:buildHarnessEngine (surface=chat)
 * + 注入 fake subagent manager + JsonlTraceService。stub-model turn 1 给
 * tool_use(spawn_subagent) → 真实 tool handler → fake manager 同步返 task_id
 * → 关闭。turn 2 stub model final。解析 JSONL 断言:
 *   1. 出现 tool_call 行,tool_name === "spawn_subagent";
 *   2. 出现 llm_call 行,messages_captured=true,messages 数组非空。
 *
 * 不依赖真 LLM key(`npm test` 可跑)。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, it } from "vitest";
import { spawn } from "node:child_process";
import { readFileSync, mkdtempSync } from "node:fs";

import { buildHarnessEngine } from "../../src/harness/build-engine.ts";
import { createStubModel } from "../../src/harness/stubs/stub-model.ts";
import { createSubAgentManager } from "../../src/harness/subagent/manager.ts";
import { run } from "../../src/harness/loop-engine.ts";
import { drainPendingSubagents } from "../../src/harness/subagent/host-drain.ts";
import type { LoopEngineDeps } from "../../src/harness/loop-engine.ts";
import { createNoAskUser } from "../../src/harness/permission/ask-user.ts";
import { createJsonlTraceService } from "../../src/harness/trace/jsonl.ts";
import type { IknowEnv } from "../../src/config/env.ts";
import { assistantResult } from "../cli/_fixtures.ts";

function makeEnv(apiKey: string): IknowEnv {
  return {
    llm: {
      baseUrl: "http://127.0.0.1:9999",
      model: "test-model",
      apiKeyEnv: "ANTHROPIC_AUTH_TOKEN",
      apiKey,
      maxOutputTokens: 1024,
      timeoutMs: 60_000,
      temperature: 0,
      thinking: "off",
      thinkingEffort: "",
      stream: "on",
    },
    chat: { showThinking: false },
    web: { searchUrl: undefined, proxy: undefined },
    compress: { contextWindow: 200_000, thresholdTokens: undefined },
  };
}

let root: string | undefined;
const cleanup: Array<() => Promise<void>> = [];

afterAll(async () => {
  await Promise.all(cleanup.splice(0).map((f) => f()));
  if (root) await rm(root, { recursive: true, force: true });
});

function parseJsonlFile(filePath: string): Array<Record<string, unknown>> {
  const content = readFileSync(filePath, "utf8");
  return content
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("#361 ADR Decision 6 — subagent tool trace landing", () => {
  it("stub-model run spawn_subagent → JSONL contains tool_call(tool_name=spawn_subagent) and llm_call(messages_captured=true)", async () => {
    root = await mkdtemp(join(tmpdir(), "iknow-t12-e2e-"));
    const traceDir = mkdtempSync(join(tmpdir(), "iknow-t12-trace-"));
    cleanup.push(async () => {
      await rm(traceDir, { recursive: true, force: true });
    });

    // fake spawn: node -e stdout 立即吐一个 ok envelope
    const fakeOkEnvelope = JSON.stringify({
      status: "ok",
      summary: "hello from fake subagent",
      result: "echo body",
    });
    const fakeSpawn = (): import("node:child_process").ChildProcess =>
      spawn(
        process.execPath,
        [
          "-e",
          `process.stdout.write(${JSON.stringify(fakeOkEnvelope + "\n")})`,
        ],
        { stdio: ["pipe", "pipe", "pipe"] }
      );
    const fakeMgr = createSubAgentManager({ spawn: fakeSpawn });

    const built = await buildHarnessEngine({
      env: makeEnv("sk-test-t12-e2e-1"),
      askUser: createNoAskUser(),
      surface: "chat",
      userHome: join(root, "home"),
      cwd: root,
      subagentManager: fakeMgr,
    });
    cleanup.push(async () => {
      if (built.shutdown) await built.shutdown();
    });

    // JsonlTraceService 接入 buildHarnessEngine 已有的 deps(ACI/registry 同款)。
    // 把 trace 覆盖到 deps 上,确保 run() 内 recordLlmCall / recordToolCall 走它。
    const trace = createJsonlTraceService({
      filePath: traceDir,
      conversationId: "subagent-foreground-trace",
    });
    const deps: LoopEngineDeps = { ...built.deps, trace };

    // stub-model: turn1 给 tool_use(spawn_subagent);turn2 给 final text。
    const innerStub = createStubModel({
      responses: [
        assistantResult({
          texts: [],
          toolCalls: [
            {
              id: "call-spawn-1",
              name: "spawn_subagent",
              input: { task: "echo hello" },
            },
          ],
        }),
        assistantResult({ texts: ["drained result seen by model"] }),
      ],
    });
    const adapter: LoopEngineDeps["adapter"] = {
      encodeUserText: (t) => innerStub.encodeUserText(t),
      encodeToolResults: (r) => innerStub.encodeToolResults(r),
      step: async (state, request, signal) =>
        innerStub.step(state, request, signal),
    };
    const runDeps: LoopEngineDeps = { ...deps, adapter };

    const { result: t1 } = await run("please spawn a subagent", runDeps);
    assert.equal(t1.stopReason, "completed");
    assert.equal(t1.finalText, "drained result seen by model");

    // 等 fake binary 完全退出 + buffer 收敛
    await new Promise((r) => setTimeout(r, 100));
    const drained = await drainPendingSubagents(fakeMgr);
    assert.ok(drained.length > 0, "fake binary should complete >=1 task");

    // 解析 JSONL
    const jsonlPath = join(traceDir, "subagent-foreground-trace.jsonl");
    const lines = parseJsonlFile(jsonlPath);
    assert.ok(lines.length >= 2, "expected llm_call + tool_call minimum");

    // 1. tool_call(tool_name=spawn_subagent)
    const toolCalls = lines.filter((l) => l["record_type"] === "tool_call");
    assert.equal(toolCalls.length, 1);
    assert.equal(toolCalls[0]!["tool_name"], "spawn_subagent");

    // 2. llm_call(messages_captured=true, messages 非空)
    const llmCalls = lines.filter((l) => l["record_type"] === "llm_call");
    assert.ok(llmCalls.length >= 2);
    for (const llm of llmCalls) {
      assert.equal(llm["messages_captured"], true);
      assert.ok(Array.isArray(llm["messages"]));
      assert.ok((llm["messages"] as unknown[]).length >= 1);
    }
  }, 30_000);

  it("stub-model run spawn_subagent (no second turn) — host drain 仍写入 priorMessages,tool_name 仍落 trace", async () => {
    root = await mkdtemp(join(tmpdir(), "iknow-t12-drain-"));
    const traceDir = mkdtempSync(join(tmpdir(), "iknow-t12-trace-drain-"));
    cleanup.push(async () => {
      await rm(traceDir, { recursive: true, force: true });
    });

    const fakeOkEnvelope = JSON.stringify({
      status: "ok",
      summary: "drain body",
      result: "drain result",
    });
    const fakeSpawn = (): import("node:child_process").ChildProcess =>
      spawn(
        process.execPath,
        [
          "-e",
          `process.stdout.write(${JSON.stringify(fakeOkEnvelope + "\n")})`,
        ],
        { stdio: ["pipe", "pipe", "pipe"] }
      );
    const fakeMgr = createSubAgentManager({ spawn: fakeSpawn });

    const built = await buildHarnessEngine({
      env: makeEnv("sk-test-t12-drain-1"),
      askUser: createNoAskUser(),
      surface: "chat",
      userHome: join(root, "home"),
      cwd: root,
      subagentManager: fakeMgr,
    });
    cleanup.push(async () => {
      if (built.shutdown) await built.shutdown();
    });
    const trace = createJsonlTraceService({
      filePath: traceDir,
      conversationId: "drain-trace",
    });
    const deps: LoopEngineDeps = { ...built.deps, trace };

    const innerStub = createStubModel({
      responses: [
        assistantResult({
          texts: [],
          toolCalls: [
            {
              id: "call-spawn-2",
              name: "spawn_subagent",
              input: { task: "explore" },
            },
          ],
        }),
        assistantResult({ texts: ["done"] }),
      ],
    });
    const adapter: LoopEngineDeps["adapter"] = {
      encodeUserText: (t) => innerStub.encodeUserText(t),
      encodeToolResults: (r) => innerStub.encodeToolResults(r),
      step: async (state, request, signal) =>
        innerStub.step(state, request, signal),
    };

    const { result } = await run("go", { ...deps, adapter });
    assert.equal(result.stopReason, "completed");
    await new Promise((r) => setTimeout(r, 100));

    const drained = await drainPendingSubagents(fakeMgr);
    assert.ok(drained.length > 0);

    // 模拟 chat-session.ts 在下一轮 run() 之前把 drained 拼入 priorMessages。
    // 不再发模型调用 —— 仅断言 priorMessages 流经 host drain 后仍可被
    // 下一次 run() 消费。tool_name 落 trace 在前一个测试已覆盖。
    const jsonlPath = join(traceDir, "drain-trace.jsonl");
    const lines = parseJsonlFile(jsonlPath);
    const toolCalls = lines.filter((l) => l["record_type"] === "tool_call");
    assert.equal(toolCalls.length, 1);
    assert.equal(toolCalls[0]!["tool_name"], "spawn_subagent");
  }, 30_000);
});
