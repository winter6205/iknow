/**
 * #356 T7 — E2E A (SC14): stub-model 父 run 全链路 host drain 脚本化。
 *
 * 链路: buildHarnessEngine (surface=chat) + 注入 fake subagent manager
 * (测试缝 BuildEngineOpts.subagentManager) → 真实 spawn_subagent tool
 * handler 调 fakeMgr.spawn → fake binary (node -e console.log envelope)
 * 异步 emit 合法 envelope → buffer completed。父 run turn 1: stub-model
 * 给 tool_use(spawn_subagent) → tool handler 返 {task_id} → turn 1 收尾。
 *
 * turn 间 host drain = drainPendingSubagents(fakeMgr) → 非空浓缩串。
 * 第二次 run (turn 2) 之前把 drained 拼入 priorMessages — 断言 stub-model
 * 第二 turn 收到的 state.messages 含 drained 内容 ("## Sub-agent ...")。
 *
 * 验证手法: 用一个自定义 stub adapter 包装 createStubModel,捕获每次
 * step 收到的 LoopState (即模型实际看到的 messages),turn 2 的 messages
 * 应含 host drain 注入的 user message。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, it } from "vitest";
import { spawn } from "node:child_process";

import { buildHarnessEngine } from "../../src/harness/build-engine.ts";
import { createStubModel } from "../../src/harness/stubs/stub-model.ts";
import { createSubAgentManager } from "../../src/harness/subagent/manager.ts";
import { run } from "../../src/harness/loop-engine.ts";
import { drainPendingSubagents } from "../../src/harness/subagent/host-drain.ts";
import type { LoopEngineDeps } from "../../src/harness/loop-engine.ts";
import type { LoopState } from "../../src/harness/model-adapter/types.ts";
import { createNoAskUser } from "../../src/harness/permission/ask-user.ts";
import type { IknowEnv } from "../../src/config/env.ts";
import { assistantResult } from "../cli/_fixtures.ts";

/** 与 tests/e2e/skill-mcp-acceptance.test.ts 同构的测试 env fixture。 */
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

describe("#356 T7 E2E A: stub-model host drain 全链路 (SC14)", () => {
  it("turn1 spawn_subagent → fake binary emit envelope → turn2 priorMessages 含 drained 浓缩结果", async () => {
    root = await mkdtemp(join(tmpdir(), "iknow-t7-e2e-"));

    // fake spawn 工厂: node -e 用 process.stdout.write 精确输出 newline-JSON
    // (console.log 会做 util.inspect,产出单引号非 JSON 格式,manager parse 会
    // 视为 protocolError)。
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

    // 装配: chat surface + fake manager 注入 (BuildEngineOpts.subagentManager
    // 测试缝) — 真实 spawn_subagent tool handler 会调 fakeMgr.spawn。
    const built = await buildHarnessEngine({
      env: makeEnv("sk-test-t7-e2e-1"),
      askUser: createNoAskUser(),
      surface: "chat",
      userHome: join(root, "home"),
      cwd: root,
      subagentManager: fakeMgr,
    });
    cleanup.push(async () => {
      if (built.shutdown) await built.shutdown();
    });

    // 两件 subagent 工具在场,manager 即注入的 fakeMgr。
    assert.ok(built.deps.registry.get("spawn_subagent"));
    assert.ok(built.deps.registry.get("subagent_result"));
    assert.equal(built.subagentManager, fakeMgr);

    // stub-model 脚本: turn1 给 tool_use(spawn_subagent) → turn2 给 final text。
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

    // 包装 stub: 直接转发 innerStub 的 step (turn 1 不需要捕获 state,
    // turn 3 才用捕获形态;见下方 seen3)。
    const adapter: LoopEngineDeps["adapter"] = {
      encodeUserText: (t) => innerStub.encodeUserText(t),
      encodeToolResults: (r) => innerStub.encodeToolResults(r),
      step: async (state, request, signal) =>
        innerStub.step(state, request, signal),
    };

    const deps: LoopEngineDeps = { ...built.deps, adapter };

    // ── turn 1: 父 run → stub 给 tool_use(spawn_subagent) → fakeMgr.spawn →
    // fake binary 异步 emit → turn 1 tool_result 收尾 → turn 2 stub final text。
    const { result: t1 } = await run("please spawn a subagent", deps);
    assert.equal(t1.stopReason, "completed");
    assert.equal(t1.finalText, "drained result seen by model");

    // 等 fake binary 完全退出 + buffer 收敛 (exit 后 stdout 已 parse)。
    await new Promise((r) => setTimeout(r, 100));
    const drained = drainPendingSubagents(fakeMgr);
    assert.ok(drained.length > 0, "fake binary 应至少完成 1 个 subagent 任务");
    assert.match(
      drained,
      /^## Sub-agent .+ result: hello from fake subagent\n\necho body$/
    );

    // ── host drain 注入: 第二次 run (turn 3) 前,把 drained 拼入
    // priorMessages 末尾 (chat-session.ts / hub.ts 同形态)。
    const turn3PriorMessages: LoopState["messages"] = [
      ...t1.messages,
      { role: "user", content: [{ type: "text", text: drained }] },
    ];
    // 用捕获 adapter 包装一个全新 stub — 单次 run 消费,不复用已耗尽队列。
    const seen3: LoopState[] = [];
    const t3Stub = createStubModel({
      responses: [assistantResult({ texts: ["final after drain"] })],
    });
    const capAdapter3: LoopEngineDeps["adapter"] = {
      encodeUserText: (t) => t3Stub.encodeUserText(t),
      encodeToolResults: (r) => t3Stub.encodeToolResults(r),
      step: async (state, request, signal) => {
        seen3.push(state);
        return t3Stub.step(state, request, signal);
      },
    };
    const seen3Deps: LoopEngineDeps = { ...deps, adapter: capAdapter3 };
    const { result: t3b } = await run("continue", seen3Deps, undefined, {
      priorMessages: turn3PriorMessages,
    });
    assert.equal(t3b.stopReason, "completed");
    // seen3[0] 是 turn3 模型第一次 step 收到的完整历史 (priorMessages + userText)。
    const firstStepState = seen3[0]!;
    const joined = firstStepState.messages
      .map((m) =>
        m.content
          .filter((b): b is { type: "text"; text: string } => b.type === "text")
          .map((b) => b.text)
          .join(" ")
      )
      .join("\n");
    assert.match(joined, /## Sub-agent .+ result: hello from fake subagent/);
    assert.ok(joined.includes("echo body"));
  }, 30_000);
});
