/**
 * tests/session-api/max-turns-serve.test.ts
 *
 * serve entry: adaptation to the MaxTurnsExceeded throw + stop_summary presentation.
 *
 * Covers:
 *   1. SessionHub.postMessage with deps.maxTurns=1 + looping responses →
 *      turn.stopReason="maxTurns", turn.answer.turnCount=err.turnsRan,
 *      turn.answer.stopSummary=...; the throw path never calls
 *      conditionalSave (turnCount / checkpoints unchanged), but since the
 *      mid-turn commit was introduced, partial progress (assistant tool_use +
 *      tool_result) lands on disk as it runs — the file is no longer
 *      byte-stable;
 *   2. the serve-side IKNOW_LLM_MAX_TURNS env flows through ensureDeps into
 *      deps.maxTurns (verifying the existing env→deps wiring, not the CLI flag).
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
  // IKNOW_LLM_MODEL was retired: serve's loadIknowEnv() needs settings.llm.model,
  // so redirect HOME to a tmp dir (settings.json carries model + apiKey).
  settingsSource = installTestSettingsSource();
});

afterAll(async () => {
  await rm(baseDir, { recursive: true, force: true });
  settingsSource.restore();
});

/**
 * maxTurns=1 deps: turn 1's tool-call spends the budget → turn 2 throws at
 * step entry; the summary epilogue consumes the 2nd scripted response
 * (the summary turn is not counted against maxTurns).
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
    // pre-run snapshot (to compare the fields conditionalSave finalizes)
    const before = await store.load(session.conversation_id);

    const res = await hub.postMessage({
      conversationId: session.conversation_id,
      text: "do it",
    });

    // turn presentation: stopReason + turnCount + stopSummary
    assert.equal(res.turn.answer.stopReason, "maxTurns");
    assert.equal(res.turn.answer.turnCount, 1); // err.turnsRan
    assert.equal(res.turn.answer.finalText, "");
    assert.equal(res.turn.answer.stopSummary, "serve 收尾摘要：已达上限");
    // The summary field exists only on this turn (a normal stop does not go through completed)
    assert.equal("stopSummary" in res.turn.answer, true);

    // Contract of "commit while running": maxTurns marks an interrupted turn,
    // so its partial progress must be on disk — the mid-turn commit has
    // appended assistant(tool_use) + tool_result to the JSONL; the throw path
    // still does not call conditionalSave. The first engine commit also carries
    // the lazily-submitted user query, so on-disk progress is
    // [query, assistant, tool_result].
    const after = await store.load(session.conversation_id);
    assert.equal(after.messages.length, 3);
    const [queryEvt, assistantEvt, toolResultEvt] = after.messages;
    assert.equal(queryEvt!.role, "user");
    assert.equal(queryEvt!.content[0]!.type, "text");
    assert.equal(assistantEvt!.role, "assistant");
    assert.equal(assistantEvt!.content[0]!.type, "tool_use");
    assert.equal(toolResultEvt!.role, "user");
    assert.equal(toolResultEvt!.content[0]!.type, "tool_result");
    // conditionalSave finalization did not run: turnCount / checkpoints keep the pre-run state.
    assert.equal(after.turnCount, before.turnCount);
    assert.deepEqual(after.checkpoints, before.checkpoints);
  });

  it("摘要缺失 → stopSummary 字段缺席,stopReason 仍 maxTurns(部分进度已落盘)", async () => {
    const tool = createStubTool({ name: "noop", next: () => ({}) });
    const registry = createRegistry([tool]);
    const executor = createExecutor(registry);
    // Only 1 scripted turn: the summary epilogue exhausts the stub responses → swallowed by the catch-all → no summary
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
    // The mid-turn commit leaves partial progress on disk (assistant tool_use +
    // its tool_result); conditionalSave still has not run — turnCount /
    // checkpoints unchanged. The first engine commit carries the lazily-submitted
    // user query, so messages[0] is the query and assistant / tool_result shift by one.
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
    // a normal stop saves as usual
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
