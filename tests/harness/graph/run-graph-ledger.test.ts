/**
 * live-graph-phase1 T1 — run_graph handler 接到账本（SC1 / SC2）。
 *
 * 走真 `SubAgentManager`（fake spawn + 假 child，与 run-graph-executor.test.ts
 * 同模式）—— 不 mock manager，否则要验的"工具真的驱动 spawn + ledger
 * 真的拦冻结"就被 mock 掉。
 *
 * 五件事（SC1 / SC2 / 冻结种子）：
 *   1. **SC1a**：host 新建 + 工具无任何调用 → 账本未创建；
 *   2. **SC1b**：拓扑非法（环 / 自依赖 / 未知依赖 / 重复 id / 空 nodes）
 *      → typed 拒绝、零 spawn、账本仍未创建（spec 关键边界）；
 *   3. **SC1c**：第一次校验通过的调用 → ledgerFor(conv).exists() === true，
 *      且 frozen 中含本次 done id；
 *   4. **SC2**：再交同一已冻结 id → typed 拒绝、零 spawn；ledger 未受
 *      graph mode 开关影响（host 与 graphAssembly 平行挂在 deps 上，
 *      翻键不销毁账本）—— 这一条由"overlay 关 → on → 再交冻结 id 仍拒"
 *      复合断言；
 *   5. **冻结种子**：skipped 的 id 未冻结（spec Glossary：未冻含 skipped），
 *      后续再交能真 spawn —— T2 完整合并已就位前的最小证明。
 */

import { describe, expect, it } from "vitest";
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

// ── fake manager（与 run-graph-executor.test.ts 同模式） ────────────────

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

import { vi } from "vitest";

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

function fail(error: string): SubAgentEnvelope {
  return {
    status: "failed",
    summary: "boom",
    reason: error,
    result: "",
  };
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

const CONV = "conv-t1";

// ── SC1：账本创建时机 ──────────────────────────────────────────────────

describe("run_graph handler + ledger：SC1 账本创建时机", () => {
  it("host 新建 + 无任何调用 → 任何会话账本 exists() 为 false", () => {
    const host = createLiveGraphLedgerHost();
    expect(host.size()).toBe(0);
    expect(host.ledgerFor(CONV).exists()).toBe(false);
  });

  it("拓扑非法（环 / 自依赖 / 未知依赖 / 重复 id / 空 nodes）→ typed 拒绝 + 零 spawn + 账本仍未创建", async () => {
    const cases: Array<{
      readonly label: string;
      readonly input: unknown;
      readonly pattern: RegExp;
    }> = [
      {
        label: "环",
        input: {
          nodes: [
            { id: "a", task: "ta", deps: ["b"] },
            { id: "b", task: "tb", deps: ["a"] },
          ],
        },
        pattern: /cycle/,
      },
      {
        label: "自依赖",
        input: { nodes: [{ id: "a", task: "ta", deps: ["a"] }] },
        pattern: /depends on itself/,
      },
      {
        label: "未知依赖",
        input: { nodes: [{ id: "a", task: "ta", deps: ["ghost"] }] },
        pattern: /unknown node "ghost"/,
      },
      {
        label: "重复 id",
        input: {
          nodes: [
            { id: "a", task: "ta" },
            { id: "a", task: "tb" },
          ],
        },
        pattern: /duplicate node id/,
      },
      {
        label: "空 nodes",
        input: { nodes: [] },
        pattern: /non-empty array/,
      },
    ];
    for (const { input, pattern } of cases) {
      const { manager, children } = makeManager();
      const host = createLiveGraphLedgerHost();
      const tool = createRunGraphTool({
        manager,
        ledger: host,
        isEnabled: () => true,
      });
      await expect(tool.handler(input)).rejects.toThrow(ToolExecutionError);
      await expect(tool.handler(input)).rejects.toThrow(pattern);
      expect(children).toHaveLength(0);
      // 关键边界：验证失败绝不创建账本（spec SC1 + ASSUMPTIONS #4）。
      expect(host.ledgerFor(CONV).exists()).toBe(false);
      await manager.shutdown();
    }
  });

  it("第一次校验通过的调用 → ledgerFor(conv).exists() === true + 冻结 done id", async () => {
    const { manager, children } = makeManager();
    const host = createLiveGraphLedgerHost();
    const tool = createRunGraphTool({
      manager,
      ledger: host,
      isEnabled: () => true,
    });

    const pending = tool.handler(
      { nodes: [{ id: "a", task: "ta" }] },
      { conversationId: CONV }
    );

    await waitForChildren(children, 1);
    settle(children[0]!, ok("A"));

    await pending;

    const ledger = host.ledgerFor(CONV);
    expect(ledger.exists()).toBe(true);
    expect(ledger.isFrozen("a")).toBe(true);
    expect(ledger.frozenIds()).toEqual(["a"]);
    await manager.shutdown();
  });

  it("两个节点一条边：上游 done + 下游 done 都冻结", async () => {
    const { manager, children } = makeManager();
    const host = createLiveGraphLedgerHost();
    const tool = createRunGraphTool({
      manager,
      ledger: host,
      isEnabled: () => true,
    });

    const pending = tool.handler(
      {
        nodes: [
          { id: "u", task: "u" },
          { id: "d", task: "d", deps: ["u"] },
        ],
      },
      { conversationId: CONV }
    );

    await waitForChildren(children, 1);
    settle(children[0]!, ok("U"));
    await waitForChildren(children, 2);
    settle(children[1]!, ok("D"));

    await pending;

    const ledger = host.ledgerFor(CONV);
    expect(ledger.isFrozen("u")).toBe(true);
    expect(ledger.isFrozen("d")).toBe(true);
    expect(ledger.frozenIds()).toEqual(["u", "d"]);
    await manager.shutdown();
  });
});

// ── SC2：关 overlay 不毁账本 ────────────────────────────────────────────

describe("run_graph handler + ledger：SC2 关 overlay 不毁账本", () => {
  it("账本建立后关掉 graph mode 再开：已冻结 id 仍被 typed 拒绝、零 spawn", async () => {
    const { manager, children } = makeManager();
    const host = createLiveGraphLedgerHost();

    // 模拟 graphMode holder / graphAssembly 平行挂在 deps 上 ——
    // graphAssembly.enabled() 翻 false / true，账本不受影响。
    let graphOn = true;
    const tool = createRunGraphTool({
      manager,
      ledger: host,
      isEnabled: () => graphOn,
    });

    // 第一段图：跑通 → 冻结 a
    const first = tool.handler(
      { nodes: [{ id: "a", task: "ta" }] },
      { conversationId: CONV }
    );
    await waitForChildren(children, 1);
    settle(children[0]!, ok("A"));
    await first;
    expect(host.ledgerFor(CONV).isFrozen("a")).toBe(true);

    // 关 overlay → handler 拒绝（与原 SPEC ADR-0041 行为一致）
    graphOn = false;
    await expect(
      tool.handler(
        { nodes: [{ id: "b", task: "tb" }] },
        { conversationId: CONV }
      )
    ).rejects.toThrow(/graph mode is off/i);
    // 关键：关 overlay 期间账本未消失
    expect(host.ledgerFor(CONV).exists()).toBe(true);
    expect(host.ledgerFor(CONV).isFrozen("a")).toBe(true);

    // 开 overlay → 再交已冻结 a → typed 拒绝、零 spawn（spec SC2 核心）
    graphOn = true;
    const childrenBefore = children.length;
    await expect(
      tool.handler(
        { nodes: [{ id: "a", task: "ta-again" }] },
        { conversationId: CONV }
      )
    ).rejects.toThrow(ToolExecutionError);
    await expect(
      tool.handler(
        { nodes: [{ id: "a", task: "ta-again" }] },
        { conversationId: CONV }
      )
    ).rejects.toThrow(/frozen/i);
    expect(children).toHaveLength(childrenBefore);

    await manager.shutdown();
  });

  it("再交未冻结的 id：在已存在账本上继续走 done → 冻结追加", async () => {
    const { manager, children } = makeManager();
    const host = createLiveGraphLedgerHost();
    const tool = createRunGraphTool({
      manager,
      ledger: host,
      isEnabled: () => true,
    });

    // 第一段：冻结 a
    const first = tool.handler(
      { nodes: [{ id: "a", task: "ta" }] },
      { conversationId: CONV }
    );
    await waitForChildren(children, 1);
    settle(children[0]!, ok("A"));
    await first;

    // 第二段：交未冻结 b —— 真 spawn（不是只交 a 那种 typed 拒绝路径）
    const second = tool.handler(
      { nodes: [{ id: "b", task: "tb" }] },
      { conversationId: CONV }
    );
    await waitForChildren(children, 2);
    settle(children[1]!, ok("B"));
    await second;

    const ledger = host.ledgerFor(CONV);
    expect(ledger.isFrozen("a")).toBe(true);
    expect(ledger.isFrozen("b")).toBe(true);
    expect(ledger.frozenIds()).toEqual(["a", "b"]);
    await manager.shutdown();
  });
});

// ── 冻结种子：failed 冻结、skipped 不冻 ────────────────────────────────

describe("run_graph handler + ledger：冻结语义种子（done 冻 / failed 冻 / skipped 不冻）", () => {
  it("failed id 同样冻结（spec Glossary：done/failed 均冻）", async () => {
    const { manager, children } = makeManager();
    const host = createLiveGraphLedgerHost();
    const tool = createRunGraphTool({
      manager,
      ledger: host,
      isEnabled: () => true,
    });

    const pending = tool.handler(
      { nodes: [{ id: "boom", task: "will fail" }] },
      { conversationId: CONV }
    );
    await waitForChildren(children, 1);
    settle(children[0]!, fail("crashed"));
    await pending;

    const ledger = host.ledgerFor(CONV);
    expect(ledger.isFrozen("boom")).toBe(true);
    expect(ledger.frozenIds()).toEqual(["boom"]);

    // 再交 boom → typed 拒绝、零 spawn
    const childrenBefore = children.length;
    await expect(
      tool.handler(
        { nodes: [{ id: "boom", task: "retry" }] },
        { conversationId: CONV }
      )
    ).rejects.toThrow(ToolExecutionError);
    expect(children).toHaveLength(childrenBefore);
    await manager.shutdown();
  });

  it("skipped id 未冻结（spec Glossary：skipped 不冻）→ 后续再交可 spawn", async () => {
    const { manager, children } = makeManager();
    const host = createLiveGraphLedgerHost();
    const tool = createRunGraphTool({
      manager,
      ledger: host,
      isEnabled: () => true,
    });

    // 上游失败 → 下游 skipped
    const pending = tool.handler(
      {
        nodes: [
          { id: "boom", task: "fail" },
          { id: "after", task: "needs boom", deps: ["boom"] },
        ],
      },
      { conversationId: CONV }
    );
    await waitForChildren(children, 1);
    settle(children[0]!, fail("crashed"));
    await pending;

    const ledger = host.ledgerFor(CONV);
    expect(ledger.isFrozen("boom")).toBe(true);
    expect(ledger.isFrozen("after")).toBe(false);
    expect(ledger.frozenIds()).toEqual(["boom"]);

    // 再交 after（未冻结）→ 真 spawn（T2 完整合并的种子）
    const second = tool.handler(
      { nodes: [{ id: "after", task: "retry" }] },
      { conversationId: CONV }
    );
    await waitForChildren(children, 2);
    settle(children[1]!, ok("DONE"));
    await second;
    expect(ledger.isFrozen("after")).toBe(true);
    await manager.shutdown();
  });
});

// ── 不接 host 的回归：旧调用方零行为变化 ────────────────────────────────

describe("run_graph handler：未接 host 时零行为变化", () => {
  it("host 缺席 → 工具照常跑通、不冻结任何 id（不在账本位置报错）", async () => {
    const { manager, children } = makeManager();
    const tool = createRunGraphTool({ manager, isEnabled: () => true });

    const pending = tool.handler(
      { nodes: [{ id: "a", task: "ta" }] },
      { conversationId: CONV }
    );
    await waitForChildren(children, 1);
    settle(children[0]!, ok("A"));
    await pending;

    // 无 host：不冻结、但 handler 不抛 —— 与 V1 行为字节一致
    expect(children).toHaveLength(1);
    await manager.shutdown();
  });
});
