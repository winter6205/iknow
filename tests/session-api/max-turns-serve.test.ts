/**
 * tests/session-api/max-turns-serve.test.ts
 *
 * plan T6: serve 入口适配 MaxTurnsExceeded throw + stop_summary 呈现。
 *
 * 覆盖:
 *   1. SessionHub.postMessage 带 deps.maxTurns=1 + looping responses →
 *      turn.stopReason="maxTurns"、turn.answer.turnCount=err.turnsRan、
 *      turn.answer.stopSummary=...;session 文件不被 touch(前后状态不变);
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

let baseDir: string;
let store: SessionStore;

beforeAll(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "iknow-max-turns-serve-"));
  store = new SessionStore(baseDir);
  // #353 第二阶段：model 无代码默认，serve 装配的 loadIknowEnv() 需要来源。
  process.env.IKNOW_LLM_MODEL = "test-model";
});

afterAll(async () => {
  await rm(baseDir, { recursive: true, force: true });
  delete process.env.IKNOW_LLM_MODEL;
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
  it("maxTurns 超限 → stopReason=maxTurns + stopSummary + 文件不被 touch", async () => {
    const hub = new SessionHub({ store, deps: makeMaxTurnsDeps() });
    const { session } = await hub.createSession();
    // run 前快照
    const before = await store.load(session.conversation_id);
    const beforeJson = JSON.stringify(before);

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

    // 文件不被 touch:throw 路径不调 conditionalSave
    const after = await store.load(session.conversation_id);
    assert.equal(
      JSON.stringify(after),
      beforeJson,
      "session 文件必须保持 run 前状态"
    );
    assert.equal(after.messages.length, 0);
    assert.equal(after.turnCount, 0);
  });

  it("摘要缺失 → stopSummary 字段缺席(byte-stable),stopReason 仍 maxTurns", async () => {
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
      deps: { adapter, executor, registry, maxTurns: 1 },
    });
    const { session } = await hub.createSession();
    const res = await hub.postMessage({
      conversationId: session.conversation_id,
      text: "do it",
    });
    assert.equal(res.turn.answer.stopReason, "maxTurns");
    assert.equal("stopSummary" in res.turn.answer, false);
    // 文件仍不被 touch
    const after = await store.load(session.conversation_id);
    assert.equal(after.messages.length, 0);
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
