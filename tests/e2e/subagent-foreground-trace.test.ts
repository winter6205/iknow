/**
 * ADR-0014 Decision 6 acceptance — subagent tool trace landing (e2e stub-model).
 *
 * Same chain as tests/e2e/subagent-acceptance.test.ts: buildHarnessEngine
 * (surface=chat) + injected fake subagent manager + JsonlTraceService.
 * stub-model turn 1 yields tool_use(spawn_subagent, wait:false) → real tool
 * handler → fake manager returns task_id synchronously → close. Turn 2 stub
 * final. Parse the JSONL and assert:
 *   1. a tool_call line with tool_name === "spawn_subagent" appears;
 *   2. llm_call lines with messages_captured=true and a non-empty messages array appear.
 *
 * No real LLM key required (`npm test` covers it).
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
import { awaitAllTasksTerminal } from "../_helpers/await-terminal.ts";
import { run } from "../../src/harness/loop-engine.ts";
import { drainPendingSubagents } from "../../src/harness/subagent/host-drain.ts";
import type { LoopEngineDeps } from "../../src/harness/loop-engine.ts";
import type { LoopState } from "../../src/harness/model-adapter/types.ts";
import { createNoAskUser } from "../../src/harness/permission/ask-user.ts";
import { createJsonlTraceService } from "../../src/harness/trace/jsonl.ts";
import type { IknowEnv } from "../../src/config/env.ts";
import { assistantResult } from "../cli/_fixtures.ts";

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

function parseJsonlFile(filePath: string): Array<Record<string, unknown>> {
  const content = readFileSync(filePath, "utf8");
  return content
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("#361 ADR Decision 6 — subagent tool trace landing", () => {
  it("stub-model run spawn_subagent (wait:false, host drain) → JSONL contains tool_call(tool_name=spawn_subagent) and llm_call(messages_captured=true)", async () => {
    root = await mkdtemp(join(tmpdir(), "iknow-t12-e2e-"));
    const traceDir = mkdtempSync(join(tmpdir(), "iknow-t12-trace-"));
    cleanup.push(async () => {
      await rm(traceDir, { recursive: true, force: true });
    });

    // fake spawn: node -e writes one ok envelope to stdout immediately
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
      // This file verifies subagent trace wiring, not overflow eviction or
      // index downgrade (dedicated tests: build-engine-tool-overflow.test.ts,
      // disclosure-index-align/). countTokens bypassed during wiring; seam
      // semantics are on BuildEngineOpts.skipCountTokens.
      skipCountTokens: true,
    });
    cleanup.push(async () => {
      if (built.shutdown) await built.shutdown();
    });

    // Attach JsonlTraceService to buildHarnessEngine's existing deps (same
    // pattern as ACI/registry). Override trace on deps so recordLlmCall /
    // recordToolCall inside run() go through it.
    const trace = createJsonlTraceService({
      filePath: traceDir,
      conversationId: "subagent-foreground-trace",
    });
    const deps: LoopEngineDeps = { ...built.deps, trace };

    // stub-model: turn1 yields tool_use(spawn_subagent, wait:false); turn2
    // final text. Background arm = envelopes still go through host drain
    // (foreground wait:true channel exclusion is tested separately).
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

    // wait:false returns {task_id} at once, so run() may finish before the fake binary emits.
    // Sync contract: tests/_helpers/await-terminal.ts (using the drain read
    // side as sync would defeat what this file asserts).
    await awaitAllTasksTerminal(fakeMgr);

    const drained = await drainPendingSubagents(fakeMgr);
    assert.ok(drained.length > 0, "background task should be drained");

    // Parse the JSONL
    const jsonlPath = join(traceDir, "subagent-foreground-trace.jsonl");
    const lines = parseJsonlFile(jsonlPath);
    assert.ok(lines.length >= 2, "expected llm_call + tool_call minimum");

    // 1. tool_call(tool_name=spawn_subagent)
    const toolCalls = lines.filter((l) => l["record_type"] === "tool_call");
    assert.equal(toolCalls.length, 1);
    assert.equal(toolCalls[0]!["tool_name"], "spawn_subagent");

    // 2. llm_call(messages_captured=true, non-empty messages)
    const llmCalls = lines.filter((l) => l["record_type"] === "llm_call");
    assert.ok(llmCalls.length >= 2);
    for (const llm of llmCalls) {
      assert.equal(llm["messages_captured"], true);
      assert.ok(Array.isArray(llm["messages"]));
      assert.ok((llm["messages"] as unknown[]).length >= 1);
    }
  }, 30_000);

  it("stub-model run spawn_subagent (wait:false, no second turn) — host drain 仍写入 priorMessages,tool_name 仍落 trace", async () => {
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
      skipCountTokens: true, // same as above: trace/drain only, not overflow / index downgrade.
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
              input: { task: "explore", wait: false },
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

    // wait:false does not block run; wait for the fake binary to finish emitting before reading drain.
    // Sync contract: tests/_helpers/await-terminal.ts.
    await awaitAllTasksTerminal(fakeMgr);

    const drained = await drainPendingSubagents(fakeMgr);
    // This line pins the **background arm** (wait:false): host drain still
    // hands over the condensed envelope and writes it into the next run()'s
    // priorMessages (same splice as chat-session.ts). The foreground arm
    // (wait:true) delivers via the same-step tool_result and never enters
    // drain — covered by
    // tests/subagent/foreground-drain-exclusion.test.ts, not repeated here.
    assert.ok(drained.length > 0, "background task should still be drained");

    // Mimic chat-session.ts splicing drained into priorMessages before the next run().
    // No further model call — only assert priorMessages, after flowing through
    // host drain, remain consumable by the next run(). tool_name landing is
    // already covered by the previous test.
    const priorMessages: LoopState["messages"] = [
      { role: "user", content: [{ type: "text", text: drained }] },
    ];
    const joined = priorMessages
      .map((m) =>
        m.content
          .filter((b): b is { type: "text"; text: string } => b.type === "text")
          .map((b) => b.text)
          .join(" ")
      )
      .join("\n");
    assert.match(joined, /## Sub-agent .+ result: drain body/);

    const jsonlPath = join(traceDir, "drain-trace.jsonl");
    const lines = parseJsonlFile(jsonlPath);
    const toolCalls = lines.filter((l) => l["record_type"] === "tool_call");
    assert.equal(toolCalls.length, 1);
    assert.equal(toolCalls[0]!["tool_name"], "spawn_subagent");
  }, 30_000);
});
