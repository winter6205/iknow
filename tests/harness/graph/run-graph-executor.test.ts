/**
 * D-α T4 —— `run_graph` handler 接到已有执行层（spec SC4/SC5）。
 *
 * 走真 `SubAgentManager`（fake spawn + 假 child，与 graph-prototype.test.ts
 * 同模式），因为这一刀要证的正是「工具真的驱动了 manager」，用 fake manager
 * 会把要验的东西 mock 掉。四件事：
 *   1. 带 dep 边的图按波次跑完，上游产出真的进了下游的 task 文本；
 *   2. 拓扑非法 → typed 拒绝且 **零 spawn**（校验在任何 spawn 之前）；
 *   3. 节点失败 → 下游 skipped、独立分支照跑，整体仍是一份浓缩结果；
 *   4. 打满全局 cap 4 → 走既有 `SubAgentCapacityError`，不另起 per-graph budget。
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
  /** 累积写进 stdin 的 payload（manager 的 worker 载荷）。 */
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

function makeManager(): { manager: SubAgentManager; children: FakeChild[] } {
  const children: FakeChild[] = [];
  const manager = createSubAgentManager({
    spawn: () => {
      const c = makeFakeChild();
      children.push(c);
      return c as unknown as ChildProcess;
    },
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
    const tool = createRunGraphTool({ manager });

    const pending = tool.handler({
      nodes: [
        { id: "research", task: "collect the facts" },
        { id: "write", task: "write it up", deps: ["research"] },
      ],
    });

    // wave 0 只有 research —— 有 dep 的节点必须等,不能同波起。
    await waitForChildren(children, 1);
    expect(children).toHaveLength(1);
    settle(children[0]!, ok("FACT-42"));

    await waitForChildren(children, 2);
    const downstreamPayload = children[1]!.written.join("");
    expect(downstreamPayload).toContain("write it up");
    // 数据沿边流动:上游 result 必须出现在下游 worker 的载荷里,否则
    // 「有依赖」只剩排序,没有信息传递。
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
    const tool = createRunGraphTool({ manager });
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
    const tool = createRunGraphTool({ manager });
    const pending = tool.handler({ nodes: [{ id: "solo", task: "just do it" }] });
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
    const tool = createRunGraphTool({ manager });
    await expect(tool.handler({ nodes })).rejects.toThrow(ToolExecutionError);
    await expect(tool.handler({ nodes })).rejects.toThrow(pattern);
    expect(children).toHaveLength(0);
    await manager.shutdown();
  });

  it("空 nodes → typed 拒绝，零 spawn", async () => {
    const { manager, children } = makeManager();
    const tool = createRunGraphTool({ manager });
    await expect(tool.handler({ nodes: [] })).rejects.toThrow(
      /non-empty array/
    );
    expect(children).toHaveLength(0);
    await manager.shutdown();
  });

  it("节点缺 task → typed 拒绝，零 spawn", async () => {
    const { manager, children } = makeManager();
    const tool = createRunGraphTool({ manager });
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
    const tool = createRunGraphTool({ manager });
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
    // 下游没跑 → 只 spawn 了两个节点。
    expect(children).toHaveLength(2);
    await manager.shutdown();
  });
});

describe("run_graph handler — 调用侧取消", () => {
  it("ctx.signal abort → typed 拒绝（归因调用侧），不再起新节点", async () => {
    const { manager, children } = makeManager();
    const tool = createRunGraphTool({ manager });
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
    // 上游被打断 → 下游那一波不该再 spawn。
    expect(children).toHaveLength(1);
    // 被 abort 的任务已进 kill 链，shutdown 要等 SIGKILL 兜底（5s）走完 ——
    // 故本例的超时放宽到 15s，其余用例都在毫秒级。
    await manager.shutdown();
  }, 15_000);
});

describe("run_graph handler — 共用全局 cap 4（不另起 per-graph budget）", () => {
  it("同波 5 个节点 → 第 5 个走既有 SubAgentCapacityError，前 4 个照常", async () => {
    const { manager, children } = makeManager();
    const tool = createRunGraphTool({ manager });
    const pending = tool.handler({
      nodes: ["n1", "n2", "n3", "n4", "n5"].map((id) => ({
        id,
        task: `task-${id}`,
      })),
    });
    await waitForChildren(children, 4);
    // 第 5 个 spawn 被容量拒 —— manager 的 MAX_CONCURRENT_WORKERS 是项目
    // 唯一权威并发上限,图层不复制一份。
    expect(children).toHaveLength(4);
    for (const child of children) settle(child, ok("fine"));

    const out = parse(await pending);
    const byId = new Map(out.nodes.map((n) => [n.id, n]));
    expect(byId.get("n5")!.status).toBe("failed");
    expect(byId.get("n5")!.error?.toLowerCase()).toContain("capacity");
    expect(
      ["n1", "n2", "n3", "n4"].map((id) => byId.get(id)!.status)
    ).toEqual(["done", "done", "done", "done"]);
    await manager.shutdown();
  });
});
