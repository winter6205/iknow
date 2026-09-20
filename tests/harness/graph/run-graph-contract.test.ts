/**
 * Contract locks (ADR-0052 / ADR-0065 / ADR-0067).
 *
 * Four blocks, each pinning one invariant:
 *
 *   - No outer-loop attempt gate (ADR-0052): many consecutive legal residual
 *     subgraph submissions (≥3) all run to completion — there is no "Nth
 *     outer loop" failure that could ever be written into behavior. Uses a
 *     real `SubAgentManager` (fake spawn + fake child, same pattern as
 *     run-graph-residual.test.ts), mixing chained and fan-out submissions.
 *   - Blocking + no `wait` (ADR-0065): inputSchema keeps
 *     `additionalProperties: false`, root properties are exactly {nodes}, and
 *     the whole schema has no `wait`; calling the handler directly with
 *     `wait` → typed rejection, zero spawns (the readNodes direct-call
 *     defense layer). Blocking semantics are pinned by the existing executor
 *     tests (handler awaits runGraph before condensing) plus
 *     `aci.isConcurrencySafe === false`.
 *   - onFailure has two defense layers: phase-1's "reject on sight of the
 *     failure marker" (ADR-0067, phase-1 scoped) is superseded — `onFailure`
 *     is now a declared property, and legal shapes (target present in this
 *     batch's nodes) pass both layers; illegal shapes (non-string value,
 *     unknown or frozen target) get typed rejection, zero spawns. The root
 *     surface is unchanged: a root-level `onFailure` is still rejected.
 *     Validation details live in run-graph-onfailure-validate.test.ts.
 *   - Tool description: DESCRIPTION must teach the model the residual-subgraph
 *     semantics (submit only nodes still to run, terminal ids freeze,
 *     cross-call deps may omit completed nodes, unfinished ids are
 *     resubmittable after cancel).
 */

import { describe, expect, it } from "vitest";

import type { SubAgentManager } from "../../../src/harness/subagent/manager.ts";
import { createRunGraphTool } from "../../../src/harness/graph/run-graph-tool.ts";
import { createLiveGraphLedgerHost } from "../../../src/harness/graph/ledger.ts";
import { ToolExecutionError } from "../../../src/harness/errors.ts";
import { createRegistry } from "../../../src/harness/tools/registry.ts";
import type { ToolDef } from "../../../src/harness/tools/types.ts";
import {
  makeManager,
  settle,
  ok,
  waitForChildren,
  parseCondensed as parse,
} from "./_fake-manager.ts";

const CONV = "conv-t4";

// ── No outer-loop attempt gate (ADR-0052) ──────────────────────────────

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
      // Each segment spawns only its own submitted node — frozen upstreams never rerun.
      expect(children).toHaveLength(before + 1);
      settle(children[before]!, ok(step.output));
      const out = parse(await pending);
      expect(out.nodes).toEqual([
        { id: step.id, status: "done", output: step.output },
      ]);
      // Data flows along edges: this segment's task receives the previous
      // segment's output (except the first).
      if (i > 0) {
        expect(children[before]!.written.join("")).toContain(
          chain[i - 1]!.output
        );
      }
    }

    // All four segments green → ledger froze all four ids — no "Nth outer
    // loop" rejection exists.
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

    // Precondition: a done (segment 1).
    const first = tool.handler(
      { nodes: [{ id: "a", task: "ta" }] },
      { conversationId: CONV }
    );
    await waitForChildren(children, 1);
    settle(children[0]!, ok("A-OUT"));
    await first;

    // Segment 2: fan out b, c (both deps [a], a omitted) → same-wave concurrency.
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

    // Segment 3: join node d (deps [b, c]) → receives both upstream outputs.
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

    // Segment 4: keep submitting e — later segments still run (no gate exists).
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

// ── Blocking + no wait (ADR-0065) ──────────────────────────────────────

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

  it("节点属性恰为 {id, task, deps, onFailure}，节点级 additionalProperties === false", () => {
    const nodes = schema.properties.nodes as {
      items: {
        properties: Record<string, unknown>;
        required: string[];
        additionalProperties: boolean;
      };
    };
    expect(Object.keys(nodes.items.properties)).toEqual([
      "id",
      "task",
      "deps",
      "onFailure",
    ]);
    expect(nodes.items.required).toEqual(["id", "task"]);
    expect(nodes.items.additionalProperties).toBe(false);
  });

  it("整个 schema 无 wait 属性（ADR-0065：没有图上的 wait:false）", () => {
    expect(JSON.stringify(schema)).not.toContain('"wait"');
  });

  it("ACI 元数据钉住阻塞语义：isConcurrencySafe false + unbounded（与既有测试互证）", () => {
    // ADR-0065: while one graph segment runs, the parent agent must not work
    // in parallel — the executor-layer single wave is guaranteed by
    // isConcurrencySafe=false; handler-await-before-condense is pinned by the
    // wave assertions in run-graph-executor.test.ts.
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

// ── onFailure two defense layers (supersedes ADR-0067's reject-on-sight) ─

describe("run_graph 合同锁：SC11 onFailure schema + 直调兜底（两道防御层）", () => {
  /** Same schema source as the executor: the registry compiles the one inputSchema at construction. */
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

  it("schema 路径：节点合法 onFailure（string + 目标在本批 ids）→ ajv 过", () => {
    const validate = schemaValidator();
    expect(
      validate({
        nodes: [
          { id: "a", task: "ta", onFailure: "b" },
          { id: "b", task: "tb", deps: ["a"] },
        ],
      })
    ).toBe(true);
  });

  it("schema 路径：节点合法 self-onFailure → ajv 过（Changes：自己合法）", () => {
    const validate = schemaValidator();
    expect(validate({ nodes: [{ id: "a", task: "ta", onFailure: "a" }] })).toBe(
      true
    );
  });

  it("schema 路径：节点 onFailure 非 string（数组 / 数字）→ ajv 拒", () => {
    const validate = schemaValidator();
    expect(
      validate({ nodes: [{ id: "a", task: "ta", onFailure: ["b"] }] })
    ).toBe(false);
    expect(validate({ nodes: [{ id: "a", task: "ta", onFailure: 42 }] })).toBe(
      false
    );
  });

  it("schema 路径：根带 onFailure → ajv 拒（根面 still closed）", () => {
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

  it("直调路径：合法 onFailure DAG → 通过 readNodes + 校验，跑 deps-DAG", async () => {
    const { manager, children } = makeManager();
    const t = createRunGraphTool({ manager, isEnabled: () => true });
    const input = {
      nodes: [
        { id: "a", task: "ta", onFailure: "b" },
        { id: "b", task: "tb", deps: ["a"] },
      ],
    };
    const pending = t.handler(input, { conversationId: CONV });
    // b waits for a to settle before spawning; settle in order.
    await waitForChildren(children, 1);
    settle(children[0]!, ok("A-OUT"));
    await waitForChildren(children, 2);
    settle(children[1]!, ok("B-OUT"));
    const out = parse(await pending);
    expect(out.nodes).toEqual([
      { id: "a", status: "done", output: "A-OUT" },
      { id: "b", status: "done", output: "B-OUT" },
    ]);
    await manager.shutdown();
  });

  it("直调路径：根带 onFailure → typed 拒、零 spawn（根面仍闭合）", async () => {
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

// ── Tool description: residual-subgraph semantics ───────────────────────

describe("run_graph 合同锁：DESCRIPTION 覆盖剩余子图语义", () => {
  const tool = createRunGraphTool({
    manager: { spawn: () => ({ taskId: "x" }) } as unknown as SubAgentManager,
    isEnabled: () => true,
  });

  it("说明包含剩余子图 / 账本合并 / 冻结 / 取消四类关键词", () => {
    const d = tool.description.toLowerCase();
    // (a) submit only the nodes still to run (residual subgraph)
    expect(d).toContain("residual subgraph");
    // (b) terminal ids freeze; resubmission is rejected
    expect(d).toContain("frozen");
    // (c) cross-call deps may omit completed nodes — the host merges the ledger
    expect(d).toContain("ledger");
    expect(d).toContain("omit");
    // (d) unfinished ids are resubmittable after cancel
    expect(d).toContain("cancel");
  });

  it("说明仍保留 graph mode 守门与 spawn_subagent 分工（既有断言不回退）", () => {
    const d = tool.description.toLowerCase();
    expect(d).toContain("graph mode is on");
    expect(d).toContain("spawn_subagent");
    expect(d).not.toContain("src/harness/graph");
  });

  it("说明不把无边并行当 run_graph 用例（与通知文分工同向）", () => {
    // Division-of-labor SSOT = graph/notification.ts: run_graph's use case is
    // "an ordered split of interdependent work"; single or dependency-free
    // multi-task goes to spawn_subagent ("a graph with no edges buys nothing
    // over parallel spawns"). If the description invited edge-less parallel
    // work instead, the model would pick the wrong entry point while graph
    // mode is ON — this pins the same direction as the SSOT so regressions do
    // not rely solely on real-model trajectory sets.
    const d = tool.description.toLowerCase();
    expect(d).not.toContain("or parallel sub-agent work");
    expect(d).toContain("no ordering");
    expect(d).toContain("no edges");
  });
});
