/**
 * parentTurnId back-fill — end-to-end acceptance (stub-model, no real LLM key needed).
 *
 * The only test that proves the slot is really filled: one chain carries a
 * real loop-engine turn, the real `spawn_subagent` tool, real SubAgentManager
 * instrumentation, and a real JSONL file; finally the traceserver reader
 * queries back by `parentTurnId`.
 *
 * Asserts two things:
 * 1. `parent_turn_id` on the three subagent record types === the `turn_id` of
 *    a turn row in the same JSONL (both sides share one source, not
 *    independently written strings);
 * 2. `reader.query({ parentTurnId })` retrieves exactly those rows by that value.
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
import type { LoopEngineDeps } from "../../src/harness/loop-engine.ts";
import { createNoAskUser } from "../../src/harness/permission/ask-user.ts";
import { createJsonlTraceService } from "../../src/harness/trace/jsonl.ts";
import { createJsonlTraceReader } from "../../src/traceserver/reader.ts";
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
    mcp: { connectTimeoutMs: 60_000 },
    subagent: { taskTimeoutMs: undefined },
    // ADR-0019 roots: unset here, so the resolver falls back to cwd (each case
    // runs inside its own temp root).
    workspaceRoot: undefined,
    productRoot: undefined,
  };
}

let root: string | undefined;
const cleanup: Array<() => Promise<void>> = [];

afterAll(async () => {
  await Promise.all(cleanup.splice(0).map((f) => f()));
  if (root) await rm(root, { recursive: true, force: true });
});

function parseJsonlFile(filePath: string): Array<Record<string, unknown>> {
  return readFileSync(filePath, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("F-4 — subagent record 的 parent_turn_id 挂回真实 turn_id", () => {
  it("stub-model 一回合 spawn_subagent → 三类 subagent record 与 turn 行同 id，traceserver 可按 parentTurnId 反查", async () => {
    root = await mkdtemp(join(tmpdir(), "iknow-f4-e2e-"));
    const traceDir = mkdtempSync(join(tmpdir(), "iknow-f4-trace-"));
    cleanup.push(async () => {
      await rm(traceDir, { recursive: true, force: true });
    });

    const conversationId = "f4-parent-turn-id";
    const trace = createJsonlTraceService({
      filePath: traceDir,
      conversationId,
    });

    // fake worker: emits one ok envelope then exits -> manager runs its full lifecycle.
    const okEnvelope = JSON.stringify({
      status: "ok",
      summary: "fake subagent done",
      result: "subagent body",
    });
    const fakeSpawn = (): import("node:child_process").ChildProcess =>
      spawn(
        process.execPath,
        ["-e", `process.stdout.write(${JSON.stringify(okEnvelope + "\n")})`],
        { stdio: ["pipe", "pipe", "pipe"] }
      );
    // manager and loop-engine share one trace instance -> one JSONL file.
    const fakeMgr = createSubAgentManager({ spawn: fakeSpawn, trace });

    const built = await buildHarnessEngine({
      env: makeEnv("sk-test-f4-e2e-1"),
      askUser: createNoAskUser(),
      surface: "chat",
      userHome: join(root, "home"),
      cwd: root,
      subagentManager: fakeMgr,
      // This file verifies parent turn id propagation, not overflow eviction
      // or index downgrade (dedicated tests: build-engine-tool-overflow.test.ts,
      // disclosure-index-align/). countTokens bypassed during wiring; seam
      // semantics are on BuildEngineOpts.skipCountTokens.
      skipCountTokens: true,
    });
    cleanup.push(async () => {
      if (built.shutdown) await built.shutdown();
    });

    const innerStub = createStubModel({
      responses: [
        assistantResult({
          texts: [],
          toolCalls: [
            {
              id: "call-spawn-f4",
              name: "spawn_subagent",
              input: { title: "trace me", task: "trace me" },
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
    const deps: LoopEngineDeps = { ...built.deps, trace, adapter };

    const { result } = await run("go", deps);
    assert.equal(result.stopReason, "completed");
    // manager instrumentation is fire-and-forget (safeTrace); wait for it to flush to disk.
    await new Promise((r) => setTimeout(r, 200));

    const jsonlPath = join(traceDir, `${conversationId}.jsonl`);
    const rows = parseJsonlFile(jsonlPath);

    const subagentRows = rows.filter((r) =>
      String(r["record_type"] ?? "").startsWith("subagent_")
    );
    assert.ok(
      subagentRows.length >= 3,
      `expected spawn + state_change + stop, got ${subagentRows.length}`
    );

    const parentTurnIds = new Set(
      subagentRows.map((r) => r["parent_turn_id"] as string | undefined)
    );
    assert.equal(
      parentTurnIds.size,
      1,
      `all subagent rows share one parent turn, got ${[...parentTurnIds].join(",")}`
    );
    const parentTurnId = [...parentTurnIds][0];
    assert.equal(typeof parentTurnId, "string");

    // The id must genuinely be some turn row's turn_id in this same JSONL — the whole point of reverse tracing.
    const turnRows = rows.filter((r) => r["record_type"] === "turn");
    assert.ok(turnRows.length >= 1);
    const matched = turnRows.filter((r) => r["turn_id"] === parentTurnId);
    assert.equal(
      matched.length,
      1,
      `parent_turn_id ${parentTurnId} must join to exactly one turn row`
    );
    // The turn that spawned the subagent is the turn that executed the tool.
    assert.ok(
      Array.isArray(matched[0]!["tool_call_ids"]) &&
        (matched[0]!["tool_call_ids"] as unknown[]).length >= 1
    );

    // Reader side: traceserver's exact parentTurnId filter retrieves the same batch of rows.
    const reader = createJsonlTraceReader({ filePath: jsonlPath });
    const queried = reader.query({ parentTurnId: parentTurnId as string });
    assert.equal(queried.total, subagentRows.length);
    for (const r of queried.records) {
      assert.ok(String(r["record_type"] ?? "").startsWith("subagent_"));
      assert.equal(r["parent_turn_id"], parentTurnId);
    }
    const types = new Set(queried.records.map((r) => r["record_type"]));
    for (const t of [
      "subagent_spawn",
      "subagent_state_change",
      "subagent_stop",
    ]) {
      assert.ok(types.has(t), `query result must include ${t}`);
    }
  }, 30_000);
});
