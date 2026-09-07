/**
 * live-graph-phase1 T4 — 合同锁（spec SC9–SC12 / ADR-0052 / 0065 / 0067）。
 *
 * 四块，各自钉住一条不变式：
 *
 *   - **SC9 无外环次数闸（ADR-0052）**：连续多次（≥3）合法剩余子图提交
 *     全部跑完 —— 不存在「第 N 次外环」这类会写进行为的失败。走真
 *     `SubAgentManager`（fake spawn + 假 child，与 run-graph-residual.test.ts
 *     同模式），链式 + 扇出混合提交。
 *   - **SC10 阻塞 + 无 wait（ADR-0065）**：inputSchema 仍
 *     `additionalProperties: false`、根属性恰为 {nodes}、全 schema 无
 *     `wait`；直调 handler 带 `wait` → typed 拒、零 spawn（readNodes
 *     直调防御层）。阻塞语义由既有 executor 测试（handler await runGraph
 *     后才 condense）+ `aci.isConcurrencySafe === false` 钉住。
 *   - **SC11 阶段 1 拒失败标记（ADR-0067）**：节点带 `onFailure`（或任何
 *     未声明属性）、根带 `onFailure` → typed 拒、零 spawn —— 两道防御
 *     层都要拒：schema 路径（与 executor 同源的 ajv validator）+
 *     readNodes 直调路径。带标记的合法 DAG 绝不当普通 DAG 跑。
 *   - **工具说明（spec Inherits/Changes 末条）**：DESCRIPTION 必须让模型
 *     知道剩余子图语义（只交还要跑的节点、已终态 id 冻结、跨调用 deps
 *     可省略已完成节点、取消后未完成 id 可再交）。
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
import { createLiveGraphLedgerHost } from "../../../src/harness/graph/ledger.ts";
import { ToolExecutionError } from "../../../src/harness/errors.ts";
import { createRegistry } from "../../../src/harness/tools/registry.ts";
import type { ToolDef } from "../../../src/harness/tools/types.ts";

// ── fake manager（与 run-graph-residual.test.ts 同模式） ────────────────

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
}
interface Condensed {
  readonly waveCount: number;
  readonly nodes: ReadonlyArray<CondensedNode>;
}

function parse(raw: unknown): Condensed {
  expect(typeof raw).toBe("string");
  return JSON.parse(raw as string) as Condensed;
}

const CONV = "conv-t4";

// ── SC9：无外环次数闸（ADR-0052） ─────────────────────────────────────

describe("run_graph 合同锁：SC9 连续剩余子图提交无次数闸", () => {
  it("链式 4 段剩余子图提交全部跑完（a→b→c→d），每段恰多 spawn 1 个 child", async () => {
    const { manager, children } = makeManager();
    const host = createLiveGraphLedgerHost();
    const tool = createRunGraphTool({
      manager,
      ledger: host,
      isEnabled: () => true,
    });

    const chain = [
      { id: "a", deps: [] as ReadonlyArray<string>, output: "A-OUT" },
      { id: "b", deps: ["a"], output: "B-OUT" },
      { id: "c", deps: ["b"], output: "C-OUT" },
      { id: "d", deps: ["c"], output: "D-OUT" },
    ];

    for (const [i, step] of chain.entries()) {
      const before = children.length;
      const pending = tool.handler(
        { nodes: [{ id: step.id, task: `task-${step.id}`, deps: step.deps }] },
        { conversationId: CONV }
      );
      await waitForChildren(children, before + 1);
      // 每段只 spawn 本次提交的那个节点 —— 已冻结上游不重演
      expect(children).toHaveLength(before + 1);
      settle(children[before]!, ok(step.output));
      const out = parse(await pending);
      expect(out.nodes).toEqual([
        { id: step.id, status: "done", output: step.output },
      ]);
      // 数据沿边流动：本段 task 文本接到上一段的产出（首段除外）
      if (i > 0) {
        expect(children[before]!.written.join("")).toContain(
          chain[i - 1]!.output
        );
      }
    }

    // 4 段全绿后账本冻结全部 4 个 id —— 没有「第 N 次外环」拒绝
    expect(host.ledgerFor(CONV).frozenIds()).toEqual(["a", "b", "c", "d"]);
    await manager.shutdown();
  });

  it("扇出 + 汇合的剩余子图提交（第 5、6 段）继续全部跑完", async () => {
    const { manager, children } = makeManager();
    const host = createLiveGraphLedgerHost();
    const tool = createRunGraphTool({
      manager,
      ledger: host,
      isEnabled: () => true,
    });

    // 前置：a done（第 1 段）
    const first = tool.handler(
      { nodes: [{ id: "a", task: "ta" }] },
      { conversationId: CONV }
    );
    await waitForChildren(children, 1);
    settle(children[0]!, ok("A-OUT"));
    await first;

    // 第 2 段：扇出 b、c（都 deps [a]，a 省略）→ 同波并发
    const second = tool.handler(
      {
        nodes: [
          { id: "b", task: "tb", deps: ["a"] },
          { id: "c", task: "tc", deps: ["a"] },
        ],
      },
      { conversationId: CONV }
    );
    await waitForChildren(children, 3);
    expect(children).toHaveLength(3);
    settle(children[1]!, ok("B-OUT"));
    settle(children[2]!, ok("C-OUT"));
    const secondOut = parse(await second);
    expect(secondOut.waveCount).toBe(1);

    // 第 3 段：汇合 d（deps [b, c]）→ 接到两边产出
    const third = tool.handler(
      { nodes: [{ id: "d", task: "td", deps: ["b", "c"] }] },
      { conversationId: CONV }
    );
    await waitForChildren(children, 4);
    const dPayload = children[3]!.written.join("");
    expect(dPayload).toContain("B-OUT");
    expect(dPayload).toContain("C-OUT");
    settle(children[3]!, ok("D-OUT"));
    const thirdOut = parse(await third);
    expect(thirdOut.nodes).toEqual([
      { id: "d", status: "done", output: "D-OUT" },
    ]);

    // 第 4 段：继续提交 e —— 第 6 段之外再交也照跑（闸不存在）
    const fourth = tool.handler(
      { nodes: [{ id: "e", task: "te", deps: ["d"] }] },
      { conversationId: CONV }
    );
    await waitForChildren(children, 5);
    settle(children[4]!, ok("E-OUT"));
    expect(parse(await fourth).nodes).toEqual([
      { id: "e", status: "done", output: "E-OUT" },
    ]);

    expect(host.ledgerFor(CONV).frozenIds()).toEqual(["a", "b", "c", "d", "e"]);
    await manager.shutdown();
  });
});

// ── SC10：阻塞 + 无 wait（ADR-0065） ──────────────────────────────────

describe("run_graph 合同锁：SC10 schema 形状 + 无 wait", () => {
  const tool = createRunGraphTool({
    manager: { spawn: () => ({ taskId: "x" }) } as unknown as SubAgentManager,
    isEnabled: () => true,
  });
  const schema = tool.inputSchema as {
    type: string;
    properties: Record<string, unknown>;
    required: string[];
    additionalProperties: boolean;
  };

  it("inputSchema additionalProperties === false，根属性恰为 {nodes}", () => {
    expect(schema.type).toBe("object");
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties)).toEqual(["nodes"]);
    expect(schema.required).toEqual(["nodes"]);
  });

  it("节点属性恰为 {id, task, deps}，节点级 additionalProperties === false", () => {
    const nodes = schema.properties.nodes as {
      items: {
        properties: Record<string, unknown>;
        required: string[];
        additionalProperties: boolean;
      };
    };
    expect(Object.keys(nodes.items.properties)).toEqual(["id", "task", "deps"]);
    expect(nodes.items.required).toEqual(["id", "task"]);
    expect(nodes.items.additionalProperties).toBe(false);
  });

  it("整个 schema 无 wait 属性（ADR-0065：没有图上的 wait:false）", () => {
    expect(JSON.stringify(schema)).not.toContain('"wait"');
  });

  it("ACI 元数据钉住阻塞语义：isConcurrencySafe false + unbounded（与既有测试互证）", () => {
    // ADR-0065：一段图在跑时父代理不能并行干别的 —— executor 层的单例
    // 波次由 isConcurrencySafe=false 保证；handler await settle 后才
    // condense 由 run-graph-executor.test.ts 的波次断言钉住。
    expect(tool.aci.isConcurrencySafe).toBe(false);
    expect(tool.aci.timeoutTier).toBe("unbounded");
  });

  it("直调 handler 带 wait: true → typed 拒绝、零 spawn（readNodes 直调防御层）", async () => {
    const { manager, children } = makeManager();
    const t = createRunGraphTool({ manager, isEnabled: () => true });
    await expect(
      t.handler(
        { nodes: [{ id: "a", task: "ta" }], wait: true },
        { conversationId: CONV }
      )
    ).rejects.toThrow(ToolExecutionError);
    await expect(
      t.handler(
        { nodes: [{ id: "a", task: "ta" }], wait: true },
        { conversationId: CONV }
      )
    ).rejects.toThrow(/wait/);
    expect(children).toHaveLength(0);
    await manager.shutdown();
  });
});

// ── SC11：阶段 1 拒失败标记（ADR-0067） ───────────────────────────────

describe("run_graph 合同锁：SC11 拒失败边标记（两道防御层）", () => {
  /** 与 executor 同源的 schema 路径：registry 构造期编译同一份 inputSchema。 */
  function schemaValidator() {
    const tool = createRunGraphTool({
      manager: { spawn: () => ({ taskId: "x" }) } as unknown as SubAgentManager,
      isEnabled: () => true,
    });
    const registry = createRegistry([tool as unknown as ToolDef]);
    const validate = registry.getValidator("run_graph");
    expect(validate).toBeDefined();
    return validate!;
  }

  it("schema 路径：节点带 onFailure → ajv 拒（additionalProperties）", () => {
    const validate = schemaValidator();
    expect(validate({ nodes: [{ id: "a", task: "ta", onFailure: "b" }] })).toBe(
      false
    );
  });

  it("schema 路径：根带 onFailure → ajv 拒", () => {
    const validate = schemaValidator();
    expect(
      validate({ nodes: [{ id: "a", task: "ta" }], onFailure: "retry" })
    ).toBe(false);
  });

  it("schema 路径：合法 DAG（无额外属性）→ ajv 过（正例对照）", () => {
    const validate = schemaValidator();
    expect(
      validate({
        nodes: [
          { id: "a", task: "ta" },
          { id: "b", task: "tb", deps: ["a"] },
        ],
      })
    ).toBe(true);
  });

  it("直调路径：节点带 onFailure 的合法 DAG → typed 拒、零 spawn（绝不当普通 DAG 跑）", async () => {
    const { manager, children } = makeManager();
    const t = createRunGraphTool({ manager, isEnabled: () => true });
    const input = {
      nodes: [
        { id: "a", task: "ta", onFailure: "b" },
        { id: "b", task: "tb", deps: ["a"] },
      ],
    };
    await expect(t.handler(input, { conversationId: CONV })).rejects.toThrow(
      ToolExecutionError
    );
    await expect(t.handler(input, { conversationId: CONV })).rejects.toThrow(
      /onFailure/
    );
    expect(children).toHaveLength(0);
    await manager.shutdown();
  });

  it("直调路径：根带 onFailure → typed 拒、零 spawn", async () => {
    const { manager, children } = makeManager();
    const t = createRunGraphTool({ manager, isEnabled: () => true });
    const input = { nodes: [{ id: "a", task: "ta" }], onFailure: "retry" };
    await expect(t.handler(input, { conversationId: CONV })).rejects.toThrow(
      ToolExecutionError
    );
    await expect(t.handler(input, { conversationId: CONV })).rejects.toThrow(
      /onFailure/
    );
    expect(children).toHaveLength(0);
    await manager.shutdown();
  });

  it("直调路径：节点的其它未声明属性（例 wait）→ 同样 typed 拒、零 spawn", async () => {
    const { manager, children } = makeManager();
    const t = createRunGraphTool({ manager, isEnabled: () => true });
    await expect(
      t.handler(
        { nodes: [{ id: "a", task: "ta", wait: false }] },
        { conversationId: CONV }
      )
    ).rejects.toThrow(ToolExecutionError);
    expect(children).toHaveLength(0);
    await manager.shutdown();
  });
});

// ── 工具说明：剩余子图语义（spec Inherits/Changes 末条） ─────────────

describe("run_graph 合同锁：DESCRIPTION 覆盖剩余子图语义", () => {
  const tool = createRunGraphTool({
    manager: { spawn: () => ({ taskId: "x" }) } as unknown as SubAgentManager,
    isEnabled: () => true,
  });

  it("说明包含剩余子图 / 账本合并 / 冻结 / 取消四类关键词", () => {
    const d = tool.description.toLowerCase();
    // (a) 只交还要跑的节点（剩余子图）
    expect(d).toContain("residual subgraph");
    // (b) 已终态 id 冻结、再交被拒
    expect(d).toContain("frozen");
    // (c) 跨调用 deps 可省略已完成节点 —— host 合并账本
    expect(d).toContain("ledger");
    expect(d).toContain("omit");
    // (d) 取消后未完成 id 可再交
    expect(d).toContain("cancel");
  });

  it("说明仍保留 graph mode 守门与 spawn_subagent 分工（既有断言不回退）", () => {
    const d = tool.description.toLowerCase();
    expect(d).toContain("graph mode is on");
    expect(d).toContain("spawn_subagent");
    expect(d).not.toContain("src/harness/graph");
  });
});
