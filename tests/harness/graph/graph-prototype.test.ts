/**
 * PROTOTYPE — Self-written Graph 多任务编排：graph-prototype.test.ts。
 *
 * 集成测试：≥2 nodes 的 graph 走真 SubAgentManager（fake spawn 工厂 +
 * 假 child）+ createSubAgentNodeExecutor + runGraph，验证：
 *   1. ≥2 节点并发执行（同 wave 内 Promise.all）；
 *   2. 节点成功 → envelope.result 作为 NodeOutcome.output；
 *   3. 节点失败 → 失败分支下游被 skipped，独立分支不受影响；
 *   4. trace 三类事件（subagent_spawn / subagent_state_change / subagent_stop）
 *      全部落盘（≥2 节点 × 3 类 ≥ 6 行）；
 *   5. **trace double-track 基线（test.md:55-58）**：NoopTraceService 注入时
 *      runGraph 的可观测行为（statuses / results / waveCount）与带 trace 形态
 *      deepEqual — 证明 trace 是观察面，不参与业务判定。
 *
 * 边界：与 tests/subagent/manager-trace.test.ts 同模式（fake spawn + fake
 * child）。本测试额外验证 runGraph ↔ SubAgentManager 的 seam 桥接正确，
 * 不重做 manager 自身的单测职责。
 */

import assert from "node:assert/strict";
import { describe, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";

import {
  createSubAgentManager,
  type SubAgentManager,
} from "../../../src/harness/subagent/manager.ts";
import type { SubAgentEnvelope } from "../../../src/harness/subagent/envelope.ts";
import { createJsonlTraceService } from "../../../src/harness/trace/jsonl.ts";
import { createNoopTraceService } from "../../../src/harness/trace/noop.ts";
import {
  createSubAgentNodeExecutor,
  type NodePlan,
} from "../../../src/harness/graph/node-executor.ts";
import { runGraph } from "../../../src/harness/graph/scheduler.ts";
import type { GraphSpec } from "../../../src/harness/graph/types.ts";

// ─── fake ChildProcess ────────────────────────────────────────────────────

interface FakeChild {
  readonly stdin: PassThrough;
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
  readonly pid: number;
  readonly kill: ReturnType<typeof vi.fn>;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  emit: (event: string | symbol, ...args: unknown[]) => boolean;
  once: (event: string | symbol, ...args: unknown[]) => unknown;
}

function makeFakeChild(): FakeChild {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const kill = vi.fn(() => true);
  return Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr,
    pid: 12345,
    kill,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
  }) as unknown as FakeChild;
}

function okEnvelope(result: string): SubAgentEnvelope {
  return { status: "ok", summary: "done", result };
}

function failEnvelope(
  summary: string,
  reason:
    "crashed" | "maxTurnsExceeded" | "timeout" | "protocolError" = "crashed"
): SubAgentEnvelope {
  return { status: "failed", summary, reason, result: "" };
}

function emitEnvelope(child: FakeChild, env: SubAgentEnvelope): void {
  child.stdout.write(JSON.stringify(env) + "\n");
  child.emit("exit", 0, null);
}

// ─── 测试工厂 ────────────────────────────────────────────────────────────
//
// 直接用 makeManagerWithTrace 内联 closure 装配 fake spawn，避免暴露工厂函数
// 接口面。子代理生命周期由 manager 闭包接管，caller 按 children[] 顺序
// emitEnvelope(taskResults[i]) 即可。

function makeManagerWithTrace(
  trace: ReturnType<typeof createJsonlTraceService>
): {
  manager: SubAgentManager;
  children: FakeChild[];
} {
  const children: FakeChild[] = [];
  const manager = createSubAgentManager({
    spawn: () => {
      const c = makeFakeChild();
      children.push(c);
      return c as unknown as ChildProcess;
    },
    trace,
  });
  return { manager, children };
}

async function flushMicrotasks(): Promise<void> {
  // safeTrace + writeLine 的双层 microtask flush。
  await new Promise((resolve) => setImmediate(resolve));
  await Promise.resolve();
}

/** 阻塞等待 children 数量到 target（避免 emit 时 spawn 还未同步入栈）。 */
async function waitForChildren(
  children: FakeChild[],
  target: number
): Promise<void> {
  if (children.length >= target) return;
  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      if (children.length >= target) {
        clearInterval(timer);
        resolve();
      }
    }, 1);
  });
}

// ─── 1. ≥2 节点并发执行 + 成功路径 ────────────────────────────────────────

describe("graph prototype integration (≥2 nodes concurrent)", () => {
  it("2 nodes parallel → both done, output = envelope.result", async () => {
    const scratchDir = mkdtempSync(join(tmpdir(), "iknow-graph-proto-"));
    try {
      const trace = createJsonlTraceService({
        filePath: scratchDir,
        conversationId: "conv-graph-proto",
      });
      const { manager, children } = makeManagerWithTrace(trace);
      const plans: Record<string, NodePlan> = {
        a: { task: "task-a" },
        b: { task: "task-b" },
      };
      const exec = createSubAgentNodeExecutor({ manager, plans });
      const spec: GraphSpec = {
        nodes: [
          { id: "a", deps: [] },
          { id: "b", deps: [] },
        ],
      };
      const runPromise = runGraph(spec, exec);
      // 两个 children 同时挂起 → emit 双 done。
      emitEnvelope(children[0]!, okEnvelope("result-a"));
      emitEnvelope(children[1]!, okEnvelope("result-b"));
      const out = await runPromise;

      await flushMicrotasks();

      assert.equal(out.statuses.a, "done");
      assert.equal(out.statuses.b, "done");
      assert.equal(out.waveCount, 1);
      const rA = out.results.a;
      assert.ok(rA?.status === "done");
      if (rA?.status === "done") {
        assert.equal(rA.output, "result-a");
      }
      const rB = out.results.b;
      assert.ok(rB?.status === "done");
      if (rB?.status === "done") {
        assert.equal(rB.output, "result-b");
      }

      // 真实 JSONL 至少 6 行 subagent_*（2 spawn + 2 state_change + 2 stop）。
      const filePath = join(scratchDir, "conv-graph-proto.jsonl");
      const lines = readFileSync(filePath, "utf8").split("\n").filter(Boolean);
      const subagentLines = lines
        .map((l) => JSON.parse(l).record_type as string)
        .filter((t) => t.startsWith("subagent_"));
      assert.ok(
        subagentLines.length >= 6,
        `expected ≥6 subagent_* lines for 2 nodes, got ${subagentLines.length} (${subagentLines.join(",")})`
      );
    } finally {
      rmSync(scratchDir, { recursive: true, force: true });
    }
  });
});

// ─── 2. 失败 skip 下游 + 独立分支不受影响 ─────────────────────────────────

describe("graph prototype integration (failure skip downstream)", () => {
  it("branch A fail → A-leaves skipped, branch B done", async () => {
    const scratchDir = mkdtempSync(join(tmpdir(), "iknow-graph-proto-fail-"));
    try {
      const trace = createJsonlTraceService({
        filePath: scratchDir,
        conversationId: "conv-graph-fail",
      });
      const { manager, children } = makeManagerWithTrace(trace);
      const plans: Record<string, NodePlan> = {
        "root-a": { task: "task-root-a" },
        "leaf-a": { task: "task-leaf-a" },
        "root-b": { task: "task-root-b" },
        "leaf-b": { task: "task-leaf-b" },
      };
      const exec = createSubAgentNodeExecutor({ manager, plans });
      const spec: GraphSpec = {
        nodes: [
          { id: "root-a", deps: [] },
          { id: "leaf-a", deps: ["root-a"] },
          { id: "root-b", deps: [] },
          { id: "leaf-b", deps: ["root-b"] },
        ],
      };
      const runPromise = runGraph(spec, exec);

      // wave 0 spawns root-a + root-b；emitter 顺序按 children 入栈序
      // （spec 输入序 → root-a 在前 → root-b 在后）。
      await waitForChildren(children, 2);
      emitEnvelope(children[0]!, failEnvelope("root-a boom"));
      emitEnvelope(children[1]!, okEnvelope("root-b ok"));
      // leaf-a 因 root-a 失败被 skipped（scheduler findFailedUpstream），
      // 不会 spawn。leaf-b 等 root-b done 后进 wave 1。
      await waitForChildren(children, 3);
      emitEnvelope(children[2]!, okEnvelope("leaf-b ok"));
      const out = await runPromise;

      await flushMicrotasks();

      assert.equal(out.statuses["root-a"], "failed");
      assert.equal(out.statuses["leaf-a"], "skipped");
      assert.equal(out.statuses["root-b"], "done");
      assert.equal(out.statuses["leaf-b"], "done");
      // leaf-a 不 spawn（被 skipped）→ 实际只有 3 个 children。
      assert.equal(children.length, 3, "leaf-a 不应被 spawn");
    } finally {
      rmSync(scratchDir, { recursive: true, force: true });
    }
  });
});

// ─── 3. trace double-track 基线 ──────────────────────────────────────────

describe("graph prototype integration (trace double-track baseline)", () => {
  it("NoopTraceService 注入 → runGraph 行为与带 trace 形态 deepEqual", async () => {
    // 带 trace
    const scratchDir = mkdtempSync(join(tmpdir(), "iknow-graph-noop-"));
    try {
      const trace = createJsonlTraceService({
        filePath: scratchDir,
        conversationId: "conv-graph-noop",
      });
      const withTrace = makeManagerWithTrace(trace);
      const plans: Record<string, NodePlan> = {
        a: { task: "task-a" },
        b: { task: "task-b" },
        c: { task: "task-c", def: { disallowedTools: ["x"] } },
      };
      const execW = createSubAgentNodeExecutor({
        manager: withTrace.manager,
        plans,
      });
      const spec: GraphSpec = {
        nodes: [
          { id: "a", deps: [] },
          { id: "b", deps: [] },
          { id: "c", deps: ["a", "b"] },
        ],
      };
      const pW = runGraph(spec, execW);
      await waitForChildren(withTrace.children, 2);
      emitEnvelope(withTrace.children[0]!, okEnvelope("a"));
      emitEnvelope(withTrace.children[1]!, okEnvelope("b"));
      await waitForChildren(withTrace.children, 3);
      emitEnvelope(withTrace.children[2]!, okEnvelope("c"));
      const outWithTrace = await pW;
      await flushMicrotasks();

      // Noop trace
      const noopChildren: FakeChild[] = [];
      const noopMgr = createSubAgentManager({
        spawn: () => {
          const c = makeFakeChild();
          noopChildren.push(c);
          return c as unknown as ChildProcess;
        },
        trace: createNoopTraceService(),
      });
      const execN = createSubAgentNodeExecutor({ manager: noopMgr, plans });
      const pN = runGraph(spec, execN);
      await waitForChildren(noopChildren, 2);
      emitEnvelope(noopChildren[0]!, okEnvelope("a"));
      emitEnvelope(noopChildren[1]!, okEnvelope("b"));
      await waitForChildren(noopChildren, 3);
      emitEnvelope(noopChildren[2]!, okEnvelope("c"));
      const outNoop = await pN;

      // 业务可观测面 deepEqual（trace 只是观察面，不参与判定）。
      assert.equal(outWithTrace.waveCount, outNoop.waveCount);
      assert.deepEqual(
        Object.keys(outWithTrace.statuses).sort(),
        Object.keys(outNoop.statuses).sort()
      );
      assert.deepEqual(
        Object.values(outWithTrace.statuses).sort(),
        Object.values(outNoop.statuses).sort()
      );
      for (const id of Object.keys(outWithTrace.results)) {
        const w = outWithTrace.results[id];
        const n = outNoop.results[id];
        assert.equal(w?.status, n?.status);
        if (w?.status === "done" && n?.status === "done") {
          assert.equal(w.output, n.output);
        }
      }
    } finally {
      rmSync(scratchDir, { recursive: true, force: true });
    }
  });
});
