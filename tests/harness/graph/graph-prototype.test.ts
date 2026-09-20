/**
 * PROTOTYPE — multi-task graph orchestration: graph-prototype.test.ts.
 *
 * Integration test: a ≥2-node graph runs through the real SubAgentManager
 * (fake spawn factory + fake child) + createSubAgentNodeExecutor + runGraph,
 * verifying:
 *   1. ≥2 nodes execute concurrently (Promise.all within one wave);
 *   2. node success → envelope.result becomes NodeOutcome.output;
 *   3. node failure → downstream on the failed branch is skipped, independent branches unaffected;
 *   4. all three trace event types (subagent_spawn / subagent_state_change / subagent_stop)
 *      persist (≥2 nodes × 3 types ≥ 6 lines);
 *   5. **trace double-track baseline (test.md rule)**: with NoopTraceService
 *      injected, runGraph's observable behavior (statuses / results /
 *      waveCount) deepEquals the traced form — trace is an observation
 *      surface, never part of business decisions.
 *
 * Boundary: same pattern as tests/subagent/manager-trace.test.ts (fake spawn +
 * fake child). This test additionally verifies the runGraph ↔ SubAgentManager
 * seam bridging, without re-doing the manager's own unit-test duties.
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

// ─── test factory ────────────────────────────────────────────────────────
//
// fake spawn is assembled inline via a closure in makeManagerWithTrace to keep
// the factory surface minimal. The manager closure owns the sub-agent
// lifecycle; callers just emitEnvelope(taskResults[i]) in children[] order.

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
  // Two-layer microtask flush for safeTrace + writeLine.
  await new Promise((resolve) => setImmediate(resolve));
  await Promise.resolve();
}

/** Block until children reaches target (so an emit never races a not-yet-pushed spawn). */
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

// ─── 1. ≥2 nodes concurrent + success path ────────────────────────────────

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
      // Both children are pending at once → emit two dones.
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

      // Real JSONL has at least 6 subagent_* lines (2 spawn + 2 state_change + 2 stop).
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

// ─── 2. failure skips downstream + independent branch unaffected ──────────

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

      // Wave 0 spawns root-a + root-b; emit in children push order
      // (spec input order → root-a first → root-b second).
      await waitForChildren(children, 2);
      emitEnvelope(children[0]!, failEnvelope("root-a boom"));
      emitEnvelope(children[1]!, okEnvelope("root-b ok"));
      // leaf-a is skipped because root-a failed (scheduler findFailedUpstream),
      // so it never spawns. leaf-b enters wave 1 after root-b is done.
      await waitForChildren(children, 3);
      emitEnvelope(children[2]!, okEnvelope("leaf-b ok"));
      const out = await runPromise;

      await flushMicrotasks();

      assert.equal(out.statuses["root-a"], "failed");
      assert.equal(out.statuses["leaf-a"], "skipped");
      assert.equal(out.statuses["root-b"], "done");
      assert.equal(out.statuses["leaf-b"], "done");
      // leaf-a is skipped (never spawned) → only 3 children total.
      assert.equal(children.length, 3, "leaf-a 不应被 spawn");
    } finally {
      rmSync(scratchDir, { recursive: true, force: true });
    }
  });
});

// ─── 3. trace double-track baseline ───────────────────────────────────────

describe("graph prototype integration (trace double-track baseline)", () => {
  it("NoopTraceService 注入 → runGraph 行为与带 trace 形态 deepEqual", async () => {
    // traced run
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

      // Business-observable surface deepEquals (trace is only an observation surface, not part of decisions).
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
