/**
 * `run_graph` handler wired to the real execution layer.
 *
 * Uses a real `SubAgentManager` (fake spawn + fake child, same pattern as
 * graph-prototype.test.ts) because the point is exactly "the tool really
 * drives the manager" — a fake manager would mock away what needs proving.
 * Four things:
 *   1. A graph with dep edges runs wave by wave; upstream output really
 *      reaches the downstream task text;
 *   2. Invalid topology → typed rejection with **zero spawns** (validation
 *      precedes any spawn);
 *   3. Node failure → downstream skipped, independent branches keep running,
 *      result is still one condensed payload;
 *   4. Hitting the manager's concurrency cap → the existing
 *      `SubAgentCapacityError`; no per-graph budget is invented.
 */
import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";

import {
  createSubAgentManager,
  type SubAgentManager,
} from "../../../src/harness/subagent/manager.ts";
import type { SubAgentEnvelope } from "../../../src/harness/subagent/envelope.ts";
import { createRunGraphTool } from "../../../src/harness/graph/run-graph-tool.ts";
import { ToolExecutionError } from "../../../src/harness/errors.ts";

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
  /** Payload accumulated on stdin (the manager's worker payload). */
  readonly written: string[];
}

function makeFakeChild(): FakeChild {
  const stdin = new PassThrough();
  const written: string[] = [];
  stdin.on("data", (chunk: Buffer) => written.push(chunk.toString("utf8")));
  return Object.assign(new EventEmitter(), {
    stdin,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: 4242,
    kill: vi.fn(() => true),
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    written,
  }) as unknown as FakeChild;
}

function makeManager(opts: { readonly maxConcurrentWorkers?: number } = {}): {
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
    ...(opts.maxConcurrentWorkers !== undefined
      ? { maxConcurrentWorkers: opts.maxConcurrentWorkers }
      : {}),
  });
  return { manager, children };
}

function settle(child: FakeChild, envelope: SubAgentEnvelope): void {
  child.stdout.write(JSON.stringify(envelope) + "\n");
  child.emit("exit", 0, null);
}

function ok(result: string): SubAgentEnvelope {
  return { status: "ok", summary: "done", result };
}

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

interface CondensedNode {
  readonly id: string;
  readonly status: string;
  readonly output?: string;
  readonly error?: string;
  readonly reason?: string;
}
interface Condensed {
  readonly waveCount: number;
  readonly nodes: ReadonlyArray<CondensedNode>;
}

function parse(raw: unknown): Condensed {
  expect(typeof raw).toBe("string");
  return JSON.parse(raw as string) as Condensed;
}

describe("run_graph handler — 带 dep 边的图", () => {
  it("按波次跑完；上游产出进下游 task；返回浓缩结果", async () => {
    const { manager, children } = makeManager();
    const tool = createRunGraphTool({ manager, isEnabled: () => true });

    const pending = tool.handler({
      nodes: [
        { id: "research", task: "collect the facts" },
        { id: "write", task: "write it up", deps: ["research"] },
      ],
    });

    // wave 0 is research only — nodes with deps must wait, never start in the same wave.
    await waitForChildren(children, 1);
    expect(children).toHaveLength(1);
    settle(children[0]!, ok("FACT-42"));

    await waitForChildren(children, 2);
    const downstreamPayload = children[1]!.written.join("");
    expect(downstreamPayload).toContain("write it up");
    // Data flows along edges: the upstream result must appear in the
    // downstream worker's payload, or "having deps" is mere ordering with no
    // information transfer.
    expect(downstreamPayload).toContain("FACT-42");
    settle(children[1]!, ok("DRAFT"));

    const out = parse(await pending);
    expect(out.waveCount).toBe(2);
    expect(out.nodes).toEqual([
      { id: "research", status: "done", output: "FACT-42" },
      { id: "write", status: "done", output: "DRAFT" },
    ]);
    await manager.shutdown();
  });

  it("无 dep 的两个节点同波并发（图不是串行队列）", async () => {
    const { manager, children } = makeManager();
    const tool = createRunGraphTool({ manager, isEnabled: () => true });
    const pending = tool.handler({
      nodes: [
        { id: "a", task: "task-a" },
        { id: "b", task: "task-b" },
      ],
    });
    await waitForChildren(children, 2);
    expect(children).toHaveLength(2);
    settle(children[0]!, ok("A"));
    settle(children[1]!, ok("B"));
    const out = parse(await pending);
    expect(out.waveCount).toBe(1);
    expect(out.nodes.map((n) => n.status)).toEqual(["done", "done"]);
    await manager.shutdown();
  });

  it("根节点 task 不被改写（与单次 spawn_subagent 同字节）", async () => {
    const { manager, children } = makeManager();
    const tool = createRunGraphTool({ manager, isEnabled: () => true });
    const pending = tool.handler({
      nodes: [{ id: "solo", task: "just do it" }],
    });
    await waitForChildren(children, 1);
    const payload = children[0]!.written.join("");
    expect(payload).toContain('"task":"just do it"');
    settle(children[0]!, ok("done"));
    await pending;
    await manager.shutdown();
  });
});

describe("run_graph handler — 拓扑非法零 spawn（SC4）", () => {
  it.each([
    [
      "环",
      [
        { id: "a", task: "ta", deps: ["b"] },
        { id: "b", task: "tb", deps: ["a"] },
      ],
      /cycle/,
    ],
    ["自依赖", [{ id: "a", task: "ta", deps: ["a"] }], /depends on itself/],
    [
      "未知依赖",
      [{ id: "a", task: "ta", deps: ["ghost"] }],
      /unknown node "ghost"/,
    ],
    [
      "重复 id",
      [
        { id: "a", task: "ta" },
        { id: "a", task: "tb" },
      ],
      /duplicate node id/,
    ],
  ])("%s → typed 拒绝，spawn 次数为 0", async (_label, nodes, pattern) => {
    const { manager, children } = makeManager();
    const tool = createRunGraphTool({ manager, isEnabled: () => true });
    await expect(tool.handler({ nodes })).rejects.toThrow(ToolExecutionError);
    await expect(tool.handler({ nodes })).rejects.toThrow(pattern);
    expect(children).toHaveLength(0);
    await manager.shutdown();
  });

  it("空 nodes → typed 拒绝，零 spawn", async () => {
    const { manager, children } = makeManager();
    const tool = createRunGraphTool({ manager, isEnabled: () => true });
    await expect(tool.handler({ nodes: [] })).rejects.toThrow(
      /non-empty array/
    );
    expect(children).toHaveLength(0);
    await manager.shutdown();
  });

  it("节点缺 task → typed 拒绝，零 spawn", async () => {
    const { manager, children } = makeManager();
    const tool = createRunGraphTool({ manager, isEnabled: () => true });
    await expect(tool.handler({ nodes: [{ id: "a" }] })).rejects.toThrow(
      /no valid `task`/
    );
    expect(children).toHaveLength(0);
    await manager.shutdown();
  });
});

describe("run_graph handler — 节点失败沿 deps fail-fast", () => {
  it("失败节点的下游 skipped，独立分支继续", async () => {
    const { manager, children } = makeManager();
    const tool = createRunGraphTool({ manager, isEnabled: () => true });
    const pending = tool.handler({
      nodes: [
        { id: "boom", task: "will fail" },
        { id: "solo", task: "independent" },
        { id: "after", task: "needs boom", deps: ["boom"] },
      ],
    });
    await waitForChildren(children, 2);
    settle(children[0]!, {
      status: "failed",
      summary: "worker blew up",
      reason: "crashed",
      result: "",
    });
    settle(children[1]!, ok("SOLO"));

    const out = parse(await pending);
    const byId = new Map(out.nodes.map((n) => [n.id, n]));
    expect(byId.get("boom")!.status).toBe("failed");
    expect(byId.get("boom")!.error).toContain("worker blew up");
    expect(byId.get("solo")!.status).toBe("done");
    expect(byId.get("after")!.status).toBe("skipped");
    expect(byId.get("after")!.reason).toContain("boom");
    // The downstream never ran → only two spawns.
    expect(children).toHaveLength(2);
    await manager.shutdown();
  });
});

describe("run_graph handler — 调用侧取消", () => {
  it("ctx.signal abort → typed 拒绝（归因调用侧），不再起新节点", async () => {
    const { manager, children } = makeManager();
    const tool = createRunGraphTool({ manager, isEnabled: () => true });
    const controller = new AbortController();
    const pending = tool.handler(
      {
        nodes: [
          { id: "a", task: "ta" },
          { id: "b", task: "tb", deps: ["a"] },
        ],
      },
      { signal: controller.signal }
    );
    await waitForChildren(children, 1);
    controller.abort();
    await expect(pending).rejects.toThrow(/cancel/i);
    // Upstream aborted → the downstream wave must not spawn.
    expect(children).toHaveLength(1);
    // The aborted task entered the kill chain; shutdown waits for the SIGKILL
    // fallback (~5s) — hence this case's 15s timeout; the rest run in ms.
    await manager.shutdown();
  }, 15_000);
});

describe("run_graph handler — 共用全局 cap（不另起 per-graph budget）", () => {
  it("同波超过 cap 的节点 → 超额走既有 SubAgentCapacityError，cap 内照常", async () => {
    const { manager, children } = makeManager({ maxConcurrentWorkers: 4 });
    const tool = createRunGraphTool({ manager, isEnabled: () => true });
    const pending = tool.handler({
      nodes: ["n1", "n2", "n3", "n4", "n5"].map((id) => ({
        id,
        task: `task-${id}`,
      })),
    });
    await waitForChildren(children, 4);
    // The 5th spawn is refused by capacity — the manager's concurrency cap is
    // the project's single authority; the graph layer never duplicates it.
    expect(children).toHaveLength(4);
    for (const child of children) settle(child, ok("fine"));

    const out = parse(await pending);
    const byId = new Map(out.nodes.map((n) => [n.id, n]));
    expect(byId.get("n5")!.status).toBe("failed");
    expect(byId.get("n5")!.error?.toLowerCase()).toContain("capacity");
    expect(["n1", "n2", "n3", "n4"].map((id) => byId.get(id)!.status)).toEqual([
      "done",
      "done",
      "done",
      "done",
    ]);
    await manager.shutdown();
  });
});
