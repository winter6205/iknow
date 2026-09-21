/**
 * E2E A: stub-model scripted full chain of the parent run's host drain.
 *
 * Chain: buildHarnessEngine (surface=chat) + injected fake subagent manager
 * (test seam BuildEngineOpts.subagentManager) → the real spawn_subagent tool
 * handler calls fakeMgr.spawn → the fake binary (node -e console.log envelope)
 * asynchronously emits a valid envelope → buffer completed. Parent run turn 1:
 * stub-model yields tool_use(spawn_subagent, wait:false) → tool handler
 * returns {task_id} → turn 1 closes.
 *
 * This case exercises the **background (wait:false)** arm: only background
 * envelopes enter the host drain (foreground-arm terminal-channel exclusion:
 * tests/subagent/foreground-drain-exclusion.test.ts).
 *
 * Between-turn host drain = drainPendingSubagents(fakeMgr) → non-empty
 * condensed string. Before the next run, splice drained into priorMessages —
 * assert the stub-model's next turn receives state.messages containing the
 * drained content ("## Sub-agent ...").
 *
 * Technique: a custom stub adapter wraps createStubModel and captures the
 * LoopState each step receives (i.e. the messages the model actually sees);
 * that turn's messages should include the user message injected by the host drain.
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
import { awaitAllTasksTerminal } from "../_helpers/await-terminal.ts";
import { run } from "../../src/harness/loop-engine.ts";
import { drainPendingSubagents } from "../../src/harness/subagent/host-drain.ts";
import type { LoopEngineDeps } from "../../src/harness/loop-engine.ts";
import type { LoopState } from "../../src/harness/model-adapter/types.ts";
import { createNoAskUser } from "../../src/harness/permission/ask-user.ts";
import type { IknowEnv } from "../../src/config/env.ts";
import { assistantResult } from "../cli/_fixtures.ts";

/** Test env fixture mirroring tests/e2e/skill-mcp-acceptance.test.ts. */
function makeEnv(apiKey: string): IknowEnv {
  return {
    llm: {
      baseUrl: "http://127.0.0.1:9999",
      model: "test-model",
      fallback: [],
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
    // MCP connection timeout (default 60_000).
    mcp: { connectTimeoutMs: 60_000 },
    // Subagent config arm (build-engine reads taskTimeoutMs).
    subagent: { taskTimeoutMs: undefined },
  };
}

let root: string | undefined;
const cleanup: Array<() => Promise<void>> = [];

afterAll(async () => {
  await Promise.all(cleanup.splice(0).map((f) => f()));
  if (root) await rm(root, { recursive: true, force: true });
});

describe("#356 T7 E2E A: stub-model host drain 全链路 (SC14)", () => {
  it("turn1 spawn_subagent (wait:false) → fake binary emit envelope → host drain → turn2 priorMessages 含 drained 浓缩结果", async () => {
    root = await mkdtemp(join(tmpdir(), "iknow-t7-e2e-"));

    // fake spawn factory: node -e writes exact newline-JSON via
    // process.stdout.write (console.log runs util.inspect, producing
    // single-quoted non-JSON output that the manager parses as protocolError).
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

    // Wiring: chat surface + injected fake manager (test seam
    // BuildEngineOpts.subagentManager) — the real spawn_subagent tool handler calls fakeMgr.spawn.
    const built = await buildHarnessEngine({
      env: makeEnv("sk-test-t7-e2e-1"),
      askUser: createNoAskUser(),
      surface: "chat",
      userHome: join(root, "home"),
      cwd: root,
      subagentManager: fakeMgr,
      // This file verifies the subagent tool handler / fake manager wiring, not
      // overflow eviction or index downgrade (dedicated tests:
      // build-engine-tool-overflow.test.ts, disclosure-index-align/).
      // countTokens bypassed during wiring; seam semantics are on
      // BuildEngineOpts.skipCountTokens.
      skipCountTokens: true,
    });
    cleanup.push(async () => {
      if (built.shutdown) await built.shutdown();
    });

    // Both subagent tools present; manager is the injected fakeMgr.
    assert.ok(built.deps.registry.get("spawn_subagent"));
    assert.ok(built.deps.registry.get("subagent_result"));
    assert.equal(built.subagentManager, fakeMgr);

    // stub-model script: turn1 yields tool_use(spawn_subagent, wait:false),
    // turn2 final text. wait:false = background arm; envelopes still go
    // through host drain (foreground wait:true channel exclusion is tested
    // separately in tests/subagent/foreground-drain-exclusion.test.ts).
    const innerStub = createStubModel({
      responses: [
        assistantResult({
          texts: [],
          toolCalls: [
            {
              id: "call-spawn-1",
              name: "spawn_subagent",
              input: { task: "echo hello", wait: false },
            },
          ],
        }),
        assistantResult({ texts: ["drained result seen by model"] }),
      ],
    });

    // Wrapper stub: forwards innerStub's step directly (no state capture
    // needed on turn 1; the capture form is used on turn 3, see seen3 below).
    const adapter: LoopEngineDeps["adapter"] = {
      encodeUserText: (t) => innerStub.encodeUserText(t),
      encodeToolResults: (r) => innerStub.encodeToolResults(r),
      step: async (state, request, signal) =>
        innerStub.step(state, request, signal),
    };

    const deps: LoopEngineDeps = { ...built.deps, adapter };

    // ── turn 1: parent run → stub yields tool_use(spawn_subagent, wait:false)
    // → fakeMgr.spawn → fake binary emits async → turn 1 closes with
    // tool_result → turn 2 stub final text.
    const { result: t1 } = await run("please spawn a subagent", deps);
    assert.equal(t1.stopReason, "completed");
    assert.equal(t1.finalText, "drained result seen by model");

    // wait:false returns {task_id} at once, so run() may finish before the fake binary emits.
    // Sync contract: tests/_helpers/await-terminal.ts (do not use the drain read side as sync).
    await awaitAllTasksTerminal(fakeMgr);

    const drained = await drainPendingSubagents(fakeMgr);
    assert.ok(drained.length > 0, "后景任务应被 host drain 收走");
    assert.match(
      drained,
      /^## Sub-agent .+ result: hello from fake subagent(?:\n\nhello from fake subagent)?$/
    );

    // ── host drain injection: before the next run (turn 3), append drained to
    // priorMessages (same shape as chat-session.ts / hub.ts).
    const turn3PriorMessages: LoopState["messages"] = [
      ...t1.messages,
      { role: "user", content: [{ type: "text", text: drained }] },
    ];
    // Wrap a fresh stub in a capturing adapter — consumed by a single run; never reuse the drained queue.
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
    // seen3[0] is the full history the turn-3 model's first step received (priorMessages + userText).
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
    assert.ok(!joined.includes("echo body"));
  }, 30_000);
});
