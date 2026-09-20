/**
 * run_graph → host graph-progress snapshots.
 *
 * Progress is accumulated only via onWave/onNode then emitted through
 * safeEmitStream; tests never read the session JSONL.
 */
import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";

import { createSubAgentManager } from "../../../src/harness/subagent/manager.ts";
import type { SubAgentEnvelope } from "../../../src/harness/subagent/envelope.ts";
import { createRunGraphTool } from "../../../src/harness/graph/run-graph-tool.ts";
import { ToolExecutionError } from "../../../src/harness/errors.ts";
import type { HarnessStreamEvent } from "../../../src/harness/stream.ts";
import { createRegistry } from "../../../src/harness/tools/registry.ts";
import { createExecutor } from "../../../src/harness/tools/executor.ts";
import type { ToolDef } from "../../../src/harness/tools/types.ts";

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

function makeManager() {
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

function graphEvents(
  events: ReadonlyArray<HarnessStreamEvent>
): Array<HarnessStreamEvent & { type: "graph_progress" }> {
  return events.filter(
    (e): e is HarnessStreamEvent & { type: "graph_progress" } =>
      e.type === "graph_progress"
  );
}

describe("run_graph handler 推 graph_progress", () => {
  it("有图：onWave 后 host 读到 running 快照；onNode 后变 done；结束发 null", async () => {
    const { manager, children } = makeManager();
    const tool = createRunGraphTool({ manager, isEnabled: () => true });
    const events: HarnessStreamEvent[] = [];
    const pending = tool.handler(
      {
        nodes: [
          { id: "research", task: "collect" },
          { id: "write", task: "draft", deps: ["research"] },
        ],
      },
      {
        onStream: (e) => {
          events.push(e);
        },
      }
    );

    await waitForChildren(children, 1);
    const firstLive = graphEvents(events).find((e) => e.snapshot !== null);
    expect(firstLive).toBeDefined();
    expect(
      firstLive!.snapshot!.nodes.find((n) => n.id === "research")!.status
    ).toBe("running");
    expect(
      firstLive!.snapshot!.nodes.find((n) => n.id === "write")!.status
    ).toBe("pending");

    settle(children[0]!, { status: "ok", summary: "done", result: "FACT" });
    await waitForChildren(children, 2);
    const afterFirst = graphEvents(events)
      .map((e) => e.snapshot)
      .filter((s) => s !== null)
      .find((s) => s.nodes.find((n) => n.id === "research")?.status === "done");
    expect(afterFirst).toBeDefined();

    settle(children[1]!, { status: "ok", summary: "done", result: "DRAFT" });
    await pending;
    const all = graphEvents(events);
    expect(all.at(-1)?.snapshot).toBeNull();
    const lastLive = [...all].reverse().find((e) => e.snapshot !== null)!;
    expect(lastLive.snapshot!.nodes.map((n) => n.status)).toEqual([
      "done",
      "done",
    ]);
    expect(
      lastLive.snapshot!.nodes.find((n) => n.id === "write")!.deps
    ).toEqual(["research"]);
    await manager.shutdown();
  });

  it("非法拓扑：零 spawn、不发 graph_progress", async () => {
    const { manager, children } = makeManager();
    const tool = createRunGraphTool({ manager, isEnabled: () => true });
    const events: HarnessStreamEvent[] = [];
    await expect(
      tool.handler(
        {
          nodes: [
            { id: "a", task: "ta", deps: ["b"] },
            { id: "b", task: "tb", deps: ["a"] },
          ],
        },
        { onStream: (e) => events.push(e) }
      )
    ).rejects.toThrow(ToolExecutionError);
    expect(children).toHaveLength(0);
    expect(graphEvents(events)).toHaveLength(0);
    await manager.shutdown();
  });

  it("观察者 throw 不反流：handler 仍跑完", async () => {
    const { manager, children } = makeManager();
    const tool = createRunGraphTool({ manager, isEnabled: () => true });
    const pending = tool.handler(
      { nodes: [{ id: "solo", task: "just" }] },
      {
        onStream: () => {
          throw new Error("host UI exploded");
        },
      }
    );
    await waitForChildren(children, 1);
    settle(children[0]!, { status: "ok", summary: "done", result: "ok" });
    await expect(pending).resolves.toContain("solo");
    await manager.shutdown();
  });

  it("ctx.signal abort → typed 取消，末事件 snapshot 为 null", async () => {
    const { manager, children } = makeManager();
    const tool = createRunGraphTool({ manager, isEnabled: () => true });
    const events: HarnessStreamEvent[] = [];
    const controller = new AbortController();
    const pending = tool.handler(
      {
        nodes: [
          { id: "a", task: "ta" },
          { id: "b", task: "tb", deps: ["a"] },
        ],
      },
      {
        signal: controller.signal,
        onStream: (e) => events.push(e),
      }
    );
    await waitForChildren(children, 1);
    controller.abort();
    await expect(pending).rejects.toThrow(/cancel/i);
    const gp = graphEvents(events);
    expect(gp.length).toBeGreaterThan(0);
    expect(gp.at(-1)?.snapshot).toBeNull();
    await manager.shutdown();
  }, 15_000);
});

describe("Executor 把 onStream 透进 ToolExecutionContext", () => {
  it("executeAll 第 7 参出现在 handler ctx.onStream", async () => {
    const seen: unknown[] = [];
    const probe: ToolDef = {
      name: "probe",
      description: "probe",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
      handler: (_input, ctx) => {
        seen.push(ctx?.onStream);
        return "ok";
      },
    };
    const exec = createExecutor(createRegistry([probe]));
    const onStream = (): void => undefined;
    await exec.executeAll(
      [{ id: "c1", name: "probe", input: {} }],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      onStream
    );
    expect(seen[0]).toBe(onStream);
  });
});
