/**
 * D-α V1 graph mode T5 —— 「这是一张图，不是一次 spawn」的 e2e（spec SC5）。
 *
 * 走完整装配链（`buildHarnessEngine` + 真 `SubAgentManager` + JSONL trace），
 * 模型侧是 stub：第一回合发 `run_graph`（两个节点、一条 dep 边），第二回合
 * 收浓缩结果收尾。刻意**不**由 host 直接调执行层 —— 要证的正是「用户进了
 * graph mode 之后，模型手上确实有这件工具 + handler isEnabled gate 在
 * graph 关时正确守门」。
 *
 * ADR-0041 / plans/model-prefix-layering.md B3 后的断言四件：
 *   1. graph 关着时 promptTools 仍含 run_graph(常驻)，system 文本永远不含
 *      `run_graph` —— 编排指引文已撤出 system,改走 loop-engine 消息尾追加
 *      `<graph_mode>` 单行文本(KV cache 前缀稳定 + 模型面看图状态唯一通道);
 *   2. 一次 `run_graph` 起了 **2 个** worker —— 不是一次 spawn;
 *   3. 上游产出真的进了下游节点的 task 文本(dep 边有数据在流);
 *   4. JSONL 里 spawn / state_change / stop 三事件齐全(SC5 观测地板)。
 *
 * 不依赖真 LLM key —— 缺 key 的 live 路径是另一回事，本条 stub 路径必须绿。
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
import type { SubAgentTaskDef } from "../../src/harness/subagent/manager.ts";
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
  };
}

function parseJsonl(filePath: string): Array<Record<string, unknown>> {
  return readFileSync(filePath, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** 上游节点的产出 —— 下游 task 里能否看见它，就是「有没有 dep 边」的判据。 */
const UPSTREAM_OUTPUT = "FACT-42";

/**
 * 假 worker：真起子进程（manager 的进程模型不 mock），按收到的 task 决定
 * 吐什么信封 —— 上游吐 FACT-42，下游把它抄回来。
 */
function makeWorkerSpawn(
  tasks: string[]
): (def: SubAgentTaskDef) => ReturnType<typeof spawn> {
  return (def: SubAgentTaskDef) => {
    tasks.push(def.task);
    const isUpstream = def.task.startsWith("collect");
    const envelope = JSON.stringify({
      status: "ok",
      summary: isUpstream ? "collected" : "written",
      result: isUpstream
        ? UPSTREAM_OUTPUT
        : `report cites ${def.task.includes(UPSTREAM_OUTPUT) ? UPSTREAM_OUTPUT : "nothing"}`,
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

    // 用户还没进 graph mode —— holder 默认关。
    const graphMode = createGraphModeContext();
    const built = await buildHarnessEngine({
      env: makeEnv("sk-test-graph-e2e"),
      askUser: createNoAskUser(),
      surface: "chat",
      userHome: join(root, "home"),
      cwd: root,
      subagentManager: manager,
      graphMode,
    });
    cleanup.push(async () => {
      if (built.shutdown) await built.shutdown();
    });
    const graphAssembly = built.graphAssembly;
    assert.ok(graphAssembly, "graphMode 在场时必须透出装配快照");

    // ① 关着的那次 run():工具面仍含 run_graph(常驻,handler isEnabled 缺省
    // 恒关守门);system 文本永远不含 `run_graph`(编排段已撤出,B3 关键边界)。
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

    // 用户 Shift+Tab / `/graph on` —— 下一次装配生效(同 round 工具面不变,
    // 翻键只影响 handler isEnabled 闭包透传)。
    graphMode.setEnabled(true);
    graphAssembly.beginRound();
    const toolsOn = (built.deps.promptTools?.() ?? []).map((t) => t.name);
    assert.ok(
      toolsOn.includes("run_graph"),
      `graph 开着仍露 run_graph(handler 接受调通):${toolsOn.join(",")}`
    );
    // ADR-0041 SC5:翻图 system 字节保持 —— 内容(开图编排指引)走 messages
    // 尾部追加的 `<graph_mode>` 单行文本(loop-engine appendGraphModeChange),
    // 不再进 system 段。
    const systemOn = (await built.deps.system?.()) ?? "";
    assert.equal(systemOn, systemOff, "graph 翻转不破坏 system 字节");
    assert.ok(
      !systemOn.includes("run_graph"),
      `graph 开着 system 仍不该含 run_graph:${systemOn}`
    );
    // 编排段不得把模块路径写进模型 prompt(spec Boundaries)。
    assert.ok(!systemOn.includes("src/harness/graph"));

    // ② 模型这一回合发 run_graph：两节点、一条 dep 边。
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

    // ③ 两个 worker（不是一次 spawn），且上游产出进了下游 task。
    assert.equal(tasks.length, 2, `expected 2 spawns, got ${tasks.length}`);
    assert.equal(tasks[0], "collect the facts");
    assert.ok(
      tasks[1]!.includes(UPSTREAM_OUTPUT),
      `下游 task 必须带上游产出:${tasks[1]}`
    );

    // 浓缩结果回到父代理这一回合。
    const joined = seenToolResults.join("\n");
    assert.match(joined, /research/);
    assert.match(joined, new RegExp(UPSTREAM_OUTPUT));

    // ④ trace 三事件（spawn / state_change / stop），且 run_graph 落 tool_call。
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
    // 图里没有一次 spawn_subagent —— 编排走的是 run_graph 这条路。
    assert.ok(!toolCalls.includes("spawn_subagent"));
  }, 60_000);
});
