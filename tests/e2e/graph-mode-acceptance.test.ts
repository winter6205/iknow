/**
 * Graph mode e2e: "a graph, not one spawn", through the full wiring chain
 * (`buildHarnessEngine` + real `SubAgentManager` + JSONL trace). The model
 * side is a stub: turn 1 emits `run_graph` (two nodes, one dep edge), turn 2
 * finishes with the condensed result. Deliberately **not** calling the
 * execution layer from the host — what must be proven is that after entering
 * graph mode the model really has the tool and the handler isEnabled gate
 * correctly guards it while graph is off.
 *
 * Four assertions:
 *   1. with graph off promptTools still contains run_graph (resident) and
 *      the system text never contains `run_graph` — orchestration guidance
 *      was withdrawn from system and appended to the messages tail as a
 *      one-line `<graph_mode>` text (stable KV-cache prefix + the single
 *      model-facing channel for graph state);
 *   2. one `run_graph` starts **2** workers — not a single spawn;
 *   3. upstream output really reaches the downstream node's task text
 *      (data flows along the dep edge);
 *   4. spawn / state_change / stop events are all present in the JSONL
 *      (observation floor).
 *
 * No real LLM key needed — the keyless live path is a separate concern;
 * this stub path must stay green.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, it } from "vitest";

import { buildHarnessEngine } from "../../src/harness/build-engine.ts";
import { createStubModel } from "../../src/harness/stubs/stub-model.ts";
import { createSubAgentManager } from "../../src/harness/subagent/manager.ts";
import type { SubAgentDefinition } from "../../src/harness/subagent/manager.ts";
import { run } from "../../src/harness/loop-engine.ts";
import type { LoopEngineDeps } from "../../src/harness/loop-engine.ts";
import { createNoAskUser } from "../../src/harness/permission/ask-user.ts";
import { createJsonlTraceService } from "../../src/harness/trace/jsonl.ts";
import { createGraphModeContext } from "../../src/harness/graph/mode.ts";
import type { IknowEnv } from "../../src/config/env.ts";
import { assistantResult } from "../cli/_fixtures.ts";

const cleanup: Array<() => Promise<void> | void> = [];

afterAll(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

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
    // ADR-0019 roots: unset in these tests, so the resolver falls back to cwd
    // (each case runs inside its own temp root).
    workspaceRoot: undefined,
    productRoot: undefined,
  };
}

function parseJsonl(filePath: string): Array<Record<string, unknown>> {
  return readFileSync(filePath, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** Upstream node's output — whether it shows up in the downstream task is the dep-edge test. */
const UPSTREAM_OUTPUT = "FACT-42";

/**
 * Fake worker: really spawns subprocesses (the manager's process model is not
 * mocked) and picks its envelope from the received task — upstream emits
 * FACT-42, downstream copies it back.
 */
function makeWorkerSpawn(
  tasks: string[]
): (def: SubAgentDefinition) => ReturnType<typeof spawn> {
  return (def: SubAgentDefinition) => {
    // def.task is optional on SubAgentDefinition (the spawn_subagent tool owns
    // writing it); a missing task degrades to "" exactly like the manager's own
    // buildWorkerPayload fallback.
    const task = def.task ?? "";
    tasks.push(task);
    const isUpstream = task.startsWith("collect");
    const envelope = JSON.stringify({
      status: "ok",
      summary: isUpstream ? "collected" : "written",
      result: isUpstream
        ? UPSTREAM_OUTPUT
        : `report cites ${task.includes(UPSTREAM_OUTPUT) ? UPSTREAM_OUTPUT : "nothing"}`,
    });
    return spawn(
      process.execPath,
      ["-e", `process.stdout.write(${JSON.stringify(envelope + "\n")})`],
      { stdio: ["pipe", "pipe", "pipe"] }
    );
  };
}

describe("D-α V1 graph mode e2e — 图不是单次 spawn（SC5）", () => {
  it("进 graph mode 后模型用 run_graph 编排两节点一条边；trace 三事件齐全", async () => {
    const root = mkdtempSync(join(tmpdir(), "iknow-graph-e2e-"));
    const traceDir = mkdtempSync(join(tmpdir(), "iknow-graph-e2e-trace-"));
    cleanup.push(() => {
      rmSync(root, { recursive: true, force: true });
      rmSync(traceDir, { recursive: true, force: true });
    });

    const trace = createJsonlTraceService({
      filePath: traceDir,
      conversationId: "graph-e2e",
    });
    const tasks: string[] = [];
    const manager = createSubAgentManager({
      spawn: makeWorkerSpawn(tasks),
      trace,
    });
    cleanup.push(async () => {
      await manager.shutdown();
    });

    // User has not entered graph mode — holder defaults to off.
    const graphMode = createGraphModeContext();
    const built = await buildHarnessEngine({
      env: makeEnv("sk-test-graph-e2e"),
      askUser: createNoAskUser(),
      surface: "chat",
      userHome: join(root, "home"),
      cwd: root,
      subagentManager: manager,
      graphMode,
      // This file verifies graph mode's run() liveness and tool surface, not
      // overflow eviction / index downgrade (dedicated tests:
      // build-engine-tool-overflow.test.ts, disclosure-index-align/).
      // countTokens bypassed during wiring; seam semantics are on
      // BuildEngineOpts.skipCountTokens.
      skipCountTokens: true,
    });
    cleanup.push(async () => {
      if (built.shutdown) await built.shutdown();
    });
    const graphAssembly = built.graphAssembly;
    assert.ok(graphAssembly, "graphMode 在场时必须透出装配快照");

    // ① run() while graph is off: tool surface still has run_graph (resident;
    // the handler isEnabled gate keeps it shut by default); system text never
    // contains `run_graph` (orchestration withdrawn — the key boundary).
    graphAssembly.beginRound();
    const toolsOff = (built.deps.promptTools?.() ?? []).map((t) => t.name);
    assert.ok(
      toolsOff.includes("run_graph"),
      `run_graph 必须常驻注册表,handler isEnabled gate 单独守门:${toolsOff.join(",")}`
    );
    const systemOff = (await built.deps.system?.()) ?? "";
    assert.ok(
      !systemOff.includes("run_graph"),
      `graph 关着 system 不该有编排段(B3 关键边界,内容已撤出):${systemOff}`
    );

    // User presses Shift+Tab / `/graph on` — takes effect on the next
    // assembly (this round's tool surface is unchanged; the flag only feeds
    // the handler isEnabled closure).
    graphMode.setEnabled(true);
    graphAssembly.beginRound();
    const toolsOn = (built.deps.promptTools?.() ?? []).map((t) => t.name);
    assert.ok(
      toolsOn.includes("run_graph"),
      `graph 开着仍露 run_graph(handler 接受调通):${toolsOn.join(",")}`
    );
    // System bytes stay stable across the graph toggle: the content
    // (graph-on orchestration guidance) travels in the one-line
    // `<graph_mode>` text appended to the messages tail
    // (loop-engine appendGraphModeChange), never in the system prompt.
    const systemOn = (await built.deps.system?.()) ?? "";
    assert.equal(systemOn, systemOff, "graph 翻转不破坏 system 字节");
    assert.ok(
      !systemOn.includes("run_graph"),
      `graph 开着 system 仍不该含 run_graph:${systemOn}`
    );
    // Orchestration guidance must not leak module paths into the model prompt.
    assert.ok(!systemOn.includes("src/harness/graph"));

    // ② This turn the model emits run_graph: two nodes, one dep edge.
    const stub = createStubModel({
      responses: [
        assistantResult({
          texts: [],
          toolCalls: [
            {
              id: "call-run-graph-1",
              name: "run_graph",
              input: {
                nodes: [
                  { id: "research", task: "collect the facts" },
                  {
                    id: "write",
                    task: "write the report",
                    deps: ["research"],
                  },
                ],
              },
            },
          ],
        }),
        assistantResult({ texts: ["graph settled"] }),
      ],
    });
    const seenToolResults: string[] = [];
    const adapter: LoopEngineDeps["adapter"] = {
      encodeUserText: (t) => stub.encodeUserText(t),
      encodeToolResults: (results) => {
        for (const r of results) seenToolResults.push(JSON.stringify(r));
        return stub.encodeToolResults(results);
      },
      step: async (state, request, signal) => stub.step(state, request, signal),
    };

    const { result } = await run("orchestrate the work", {
      ...built.deps,
      trace,
      adapter,
    });
    assert.equal(result.stopReason, "completed");
    assert.equal(result.finalText, "graph settled");

    // ③ Two workers (not one spawn), and upstream output reached the downstream task.
    assert.equal(tasks.length, 2, `expected 2 spawns, got ${tasks.length}`);
    assert.equal(tasks[0], "collect the facts");
    assert.ok(
      tasks[1]!.includes(UPSTREAM_OUTPUT),
      `下游 task 必须带上游产出:${tasks[1]}`
    );

    // The condensed result comes back into the parent agent's turn.
    const joined = seenToolResults.join("\n");
    assert.match(joined, /research/);
    assert.match(joined, new RegExp(UPSTREAM_OUTPUT));

    // ④ Three trace events (spawn / state_change / stop), and run_graph lands as a tool_call.
    const lines = parseJsonl(join(traceDir, "graph-e2e.jsonl"));
    const byType = (t: string): Array<Record<string, unknown>> =>
      lines.filter((l) => l["record_type"] === t);
    assert.equal(byType("subagent_spawn").length, 2);
    assert.ok(byType("subagent_state_change").length >= 2);
    assert.equal(byType("subagent_stop").length, 2);
    const toolCalls = byType("tool_call").map((l) => l["tool_name"]);
    assert.ok(
      toolCalls.includes("run_graph"),
      `tool_call 应含 run_graph:${toolCalls.join(",")}`
    );
    // No single spawn_subagent in the trace — orchestration went through run_graph.
    assert.ok(!toolCalls.includes("spawn_subagent"));
  }, 60_000);
});
