/**
 * tests/session-api/max-turns-serve.test.ts
 *
 * plan T6: serve 入口适配 MaxTurnsExceeded throw + stop_summary 呈现。
 *
 * 覆盖:
 *   1. SessionHub.postMessage 带 deps.maxTurns=1 + looping responses →
 *      turn.stopReason="maxTurns"、turn.answer.turnCount=err.turnsRan、
 *      turn.answer.stopSummary=...;throw 路径不调 conditionalSave(turnCount /
 *      checkpoints 不变),但 #620 T3 起 turn 内 commit 把部分进度(assistant
 *      tool_use + tool_result)即时落盘 —— 文件不再 byte-stable;
 *   2. serve 侧 IKNOW_LLM_MAX_TURNS env 流经 ensureDeps → deps.maxTurns
 *      (验证既有 env→deps 接线,不走 CLI flag)。
 */
import { afterAll, beforeAll, describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionHub } from "../../src/session-api/hub.ts";
import { SessionStore } from "../../src/session-api/store/index.ts";
import type { LoopEngineDeps } from "../../src/harness/index.ts";
import { createStubTool } from "../../src/harness/stubs/stub-tool.ts";
import { createRegistry } from "../../src/harness/tools/registry.ts";
import { createExecutor } from "../../src/harness/tools/executor.ts";
import { createStubModel } from "../../src/harness/stubs/stub-model.ts";
import { createNoAskUser } from "../../src/harness/permission/ask-user.ts";
import { assistantResult } from "../cli/_fixtures.ts";
import { installTestSettingsSource } from "../_helpers/install-test-settings-source.ts";

let baseDir: string;
let store: SessionStore;
let settingsSource: ReturnType<typeof installTestSettingsSource>;

beforeAll(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "iknow-max-turns-serve-"));
  store = new SessionStore(baseDir, process.cwd());
  // #164 第二阶段：IKNOW_LLM_MODEL 已退役，serve 装配的 loadIknowEnv() 需要
  // settings.llm.model 来源 → HOME 重定向到 tmp（settings.json 含 model + apiKey）。
  settingsSource = installTestSettingsSource();
});

afterAll(async () => {
  await rm(baseDir, { recursive: true, force: true });
  settingsSource.restore();
});

/**
 * maxTurns=1 的 deps:第 1 轮 tool-call 用掉预算 → 第 2 轮 step 入口 throw;
 * 摘要 epilogue 消费第 2 条 scripted 响应(摘要轮不计 maxTurns)。
 */
function makeMaxTurnsDeps(): LoopEngineDeps {
  const tool = createStubTool({ name: "noop", next: () => ({}) });
  const registry = createRegistry([tool]);
  const executor = createExecutor(registry);
  const adapter = createStubModel({
    responses: [
      assistantResult({
        texts: [],
        toolCalls: [{ id: "t1", name: "noop", input: {} }],
      }),
      assistantResult({ texts: ["serve 收尾摘要：已达上限"], toolCalls: [] }),
    ],
  });
  return { adapter, executor, registry, maxTurns: 1 };
}

describe("SessionHub.postMessage maxTurns (serve entry, plan T6)", () => {
  it("maxTurns 超限 → stopReason=maxTurns + stopSummary;部分进度已落盘,conditionalSave 未运行", async () => {
    const hub = new SessionHub({
      store,
      deps: makeMaxTurnsDeps(),
      workspaceRoot: process.cwd(),
    });
    const { session } = await hub.createSession();
    // run 前快照(用于比较 conditionalSave 负责的最终化字段)
    const before = await store.load(session.conversation_id);

    const res = await hub.postMessage({
      conversationId: session.conversation_id,
      text: "do it",
    });

    // turn 呈现:stopReason + turnCount + stopSummary
    assert.equal(res.turn.answer.stopReason, "maxTurns");
    assert.equal(res.turn.answer.turnCount, 1); // err.turnsRan
    assert.equal(res.turn.answer.finalText, "");
    assert.equal(res.turn.answer.stopSummary, "serve 收尾摘要：已达上限");
    // 摘要字段只在该 turn 上有(不走 completed 正常停)
    assert.equal("stopSummary" in res.turn.answer, true);

    // #620 T3 新契约(spec D4 边跑边写):maxTurns 是被中断 turn,其部分进度
    // 应在盘上 —— turn 内 commit 已把 assistant(tool_use) + tool_result
    // append 进 JSONL;throw 路径仍不调 conditionalSave。
    // #622 T5:首次 engine commit 带上懒提交的 user query,故盘上部分进度
    // 为 [query, assistant, tool_result] 三条。
    const after = await store.load(session.conversation_id);
    assert.equal(after.messages.length, 3);
    const [queryEvt, assistantEvt, toolResultEvt] = after.messages;
    assert.equal(queryEvt!.role, "user");
    assert.equal(queryEvt!.content[0]!.type, "text");
    assert.equal(assistantEvt!.role, "assistant");
    assert.equal(assistantEvt!.content[0]!.type, "tool_use");
    assert.equal(toolResultEvt!.role, "user");
    assert.equal(toolResultEvt!.content[0]!.type, "tool_result");
    // conditionalSave 最终化未运行:turnCount / checkpoints 保持 run 前状态。
    assert.equal(after.turnCount, before.turnCount);
    assert.deepEqual(after.checkpoints, before.checkpoints);
  });

  it("摘要缺失 → stopSummary 字段缺席,stopReason 仍 maxTurns(部分进度已落盘)", async () => {
    const tool = createStubTool({ name: "noop", next: () => ({}) });
    const registry = createRegistry([tool]);
    const executor = createExecutor(registry);
    // 只 script 1 轮:摘要 epilogue 时 stub 响应耗尽 → catch-all 吞 → 无摘要
    const adapter = createStubModel({
      responses: [
        assistantResult({
          texts: [],
          toolCalls: [{ id: "t1", name: "noop", input: {} }],
        }),
      ],
    });
    const hub = new SessionHub({
      store,
      workspaceRoot: process.cwd(),
      deps: { adapter, executor, registry, maxTurns: 1 },
    });
    const { session } = await hub.createSession();
    const res = await hub.postMessage({
      conversationId: session.conversation_id,
      text: "do it",
    });
    assert.equal(res.turn.answer.stopReason, "maxTurns");
    assert.equal("stopSummary" in res.turn.answer, false);
    // #620 T3:turn 内 commit 的部分进度在盘上(assistant tool_use + 其
    // tool_result);conditionalSave 仍未运行 —— turnCount / checkpoints 不变。
    // #622 T5:首次 engine commit 带上懒提交的 user query,故 messages[0]
    // 是 query,assistant / tool_result 顺移。
    const after = await store.load(session.conversation_id);
    assert.equal(after.messages.length, 3);
    assert.equal(after.messages[0]!.role, "user");
    assert.equal(after.messages[0]!.content[0]!.type, "text");
    assert.equal(after.messages[1]!.role, "assistant");
    assert.equal(after.messages[1]!.content[0]!.type, "tool_use");
    assert.equal(after.messages[2]!.role, "user");
    assert.equal(after.messages[2]!.content[0]!.type, "tool_result");
    assert.equal(after.turnCount, 0);
    assert.deepEqual(after.checkpoints, []);
  });

  it("无 stopSummary 的正常 completed turn 不走 maxTurns 分支", async () => {
    const tool = createStubTool({ name: "noop", next: () => ({}) });
    const registry = createRegistry([tool]);
    const executor = createExecutor(registry);
    const adapter = createStubModel({
      responses: [assistantResult({ texts: ["done"], toolCalls: [] })],
    });
    const hub = new SessionHub({
      store,
      workspaceRoot: process.cwd(),
      deps: { adapter, executor, registry, maxTurns: 5 },
    });
    const { session } = await hub.createSession();
    const res = await hub.postMessage({
      conversationId: session.conversation_id,
      text: "hi",
    });
    assert.equal(res.turn.answer.stopReason, "completed");
    assert.equal("stopSummary" in res.turn.answer, false);
    // 正常停保存照常
    const after = await store.load(session.conversation_id);
    assert.equal(after.messages.length, 2);
  });
});

describe("ensureDeps env → deps.maxTurns 接线 (serve 侧, plan T6)", () => {
  it("IKNOW_LLM_MAX_TURNS 流经 ensureDeps 到 deps.maxTurns", async () => {
    const prev = process.env.IKNOW_LLM_MAX_TURNS;
    process.env.IKNOW_LLM_MAX_TURNS = "7";
    process.env.ANTHROPIC_AUTH_TOKEN = "test-key-for-ensure-deps";
    try {
      const hub = new SessionHub({ store, askUser: createNoAskUser() });
      const ensure = (
        hub as unknown as { ensureDeps: () => Promise<LoopEngineDeps> }
      ).ensureDeps.bind(hub);
      const deps = await ensure();
      assert.equal(deps.maxTurns, 7);
    } finally {
      if (prev === undefined) delete process.env.IKNOW_LLM_MAX_TURNS;
      else process.env.IKNOW_LLM_MAX_TURNS = prev;
      delete process.env.ANTHROPIC_AUTH_TOKEN;
    }
  });
});
