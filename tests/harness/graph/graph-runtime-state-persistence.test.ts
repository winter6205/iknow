/**
 * run_graph runtime-state persistence: the per-node graph facts the handler
 * emits through the shared port (spec §2 item 5 "Graph progress", SC15).
 *
 * The defect this pins: node outcomes used to reach the ledger in ONE pass
 * after the whole graph converged, so a kill anywhere inside the scheduler lost
 * every node that had already settled. Facts must therefore appear per settled
 * node, awaited at that node's own settlement point, and a node that was
 * dispatched but never settled must be distinguishable from one that was never
 * submitted at all.
 *
 * Real `SubAgentManager` + fake children (shared `_fake-manager.ts` fixture):
 * the manager is the thing under observation, so it stays real and only the
 * child process is faked. The persistence seam is a recording binder — the
 * real contract, implemented in the test — so the assertions are about the
 * facts the handler actually appended and their order, not about call counts on
 * a mocked sink.
 *
 * Not proven here: the fresh-process reopen half of SC15. Rebuilding a graph
 * state from these facts is the session host's (plan A) authority; this layer
 * only proves what it hands over and when. `graph-reopen-dispatch.test.ts`
 * covers the other half — a reopened session not re-dispatching a node these
 * facts already recorded as settled.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createRunGraphTool } from "../../../src/harness/graph/run-graph-tool.ts";
import { createLiveGraphLedgerHost } from "../../../src/harness/graph/ledger.ts";
import type { AnthropicNativeMessage } from "../../../src/harness/model-adapter/types.ts";
import type {
  RuntimeGraphNodeFact,
  RuntimeOperationFact,
  RuntimePersistenceBinder,
  RuntimePersistenceSink,
} from "../../../src/shared/runtime-persistence.js";
import {
  makeManager,
  settle,
  ok,
  fail,
  waitForChildren,
  parseCondensed,
  type FakeChild,
} from "./_fake-manager.ts";

const CONV = "conv-runtime-state";

/** Identify a child by its task text — spawn order inside one wave is not the settlement order. */
function childByTask(children: FakeChild[], taskMarker: string): FakeChild {
  const hit = children.find((c) => c.written.join("").includes(taskMarker));
  expect(hit, `no child with task marker "${taskMarker}"`).toBeDefined();
  return hit!;
}

async function until(predicate: () => boolean): Promise<void> {
  if (predicate()) return;
  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      }
    }, 1);
  });
}

function deferred(): {
  readonly promise: Promise<void>;
  readonly release: () => void;
} {
  let release!: () => void;
  const promise = new Promise<void>((r) => {
    release = r;
  });
  return { promise, release };
}

interface Recorder {
  /** Facts in append order — the order the host's writer queue receives them. */
  readonly facts: ReadonlyArray<RuntimeGraphNodeFact>;
  /** Facts whose append is in flight (entered but not yet recorded). */
  readonly entered: ReadonlyArray<RuntimeGraphNodeFact>;
  readonly sink: RuntimePersistenceSink<AnthropicNativeMessage>;
  readonly binder: RuntimePersistenceBinder<AnthropicNativeMessage>;
}

interface RecorderOpts {
  /** `bind()` resolves undefined — a host that wired no session. */
  readonly unwired?: boolean;
  /** Runs inside each append, before it is recorded: reject or block there. */
  readonly onAppend?: (fact: RuntimeGraphNodeFact) => Promise<void> | void;
}

function makeRecorder(opts: RecorderOpts = {}): Recorder {
  const facts: RuntimeGraphNodeFact[] = [];
  const entered: RuntimeGraphNodeFact[] = [];
  const sink: RuntimePersistenceSink<AnthropicNativeMessage> = {
    publishSavedState: async () => {
      // The graph tool records per-node facts only; a full-state publication
      // from this path would be a second, competing authority.
      throw new Error("run_graph must not publish a full state");
    },
    appendOperationFact: async (
      fact: RuntimeOperationFact<AnthropicNativeMessage>
    ) => {
      if (fact.kind !== "graph_node") {
        throw new Error(`unexpected fact kind from run_graph: ${fact.kind}`);
      }
      entered.push(fact);
      await opts.onAppend?.(fact);
      facts.push(fact);
    },
  };
  return {
    get facts() {
      return facts;
    },
    get entered() {
      return entered;
    },
    sink,
    binder: { bind: () => (opts.unwired === true ? undefined : sink) },
  };
}

// ── Per-node settlement, not per-batch ─────────────────────────────────

describe("run_graph 运行时状态：settle 即落盘（kill 后不丢已结算节点）", () => {
  it("done 节点在自身 settle 时写入 done fact（带 output），同图另一个节点仍在跑 → 无需等整图收敛", async () => {
    const { manager, children } = makeManager();
    const host = createLiveGraphLedgerHost();
    const recorder = makeRecorder();
    const tool = createRunGraphTool({
      manager,
      ledger: host,
      runtimePersistence: recorder.binder,
      isEnabled: () => true,
    });

    const pending = tool.handler(
      {
        nodes: [
          { id: "a", task: "task-alpha" },
          { id: "b", task: "task-beta" },
        ],
      },
      { conversationId: CONV }
    );
    await waitForChildren(children, 2);
    // Nothing settled yet: the kill point still has only the dispatch markers.
    expect(recorder.facts).toEqual([
      { kind: "graph_node", nodeId: "a", status: "running" },
      { kind: "graph_node", nodeId: "b", status: "running" },
    ]);

    settle(childByTask(children, "task-alpha"), ok("ALPHA"));

    // a's outcome is on record while b is still in flight — this is the state a
    // kill in the middle of the wave leaves behind.
    await until(() => recorder.facts.length === 3);
    expect(recorder.facts[2]).toEqual({
      kind: "graph_node",
      nodeId: "a",
      status: "done",
      output: "ALPHA",
    });
    expect(host.ledgerFor(CONV).isFrozen("a")).toBe(false);

    settle(childByTask(children, "task-beta"), ok("BETA"));
    expect(parseCondensed(await pending).nodes).toEqual([
      { id: "a", status: "done", output: "ALPHA" },
      { id: "b", status: "done", output: "BETA" },
    ]);
    expect(recorder.facts[3]).toEqual({
      kind: "graph_node",
      nodeId: "b",
      status: "done",
      output: "BETA",
    });
    await manager.shutdown();
  });

  it("failed 节点写入带 error 的 failed fact（只记状态不足以查询失败原因）", async () => {
    const { manager, children } = makeManager();
    const recorder = makeRecorder();
    const tool = createRunGraphTool({
      manager,
      ledger: createLiveGraphLedgerHost(),
      runtimePersistence: recorder.binder,
      isEnabled: () => true,
    });

    const pending = tool.handler(
      {
        nodes: [
          { id: "a", task: "task-alpha" },
          { id: "boom", task: "task-boom" },
        ],
      },
      { conversationId: CONV }
    );
    await waitForChildren(children, 2);
    settle(childByTask(children, "task-boom"), fail("crashed"));

    await until(() => recorder.facts.length === 3);
    expect(recorder.facts[2]).toEqual({
      kind: "graph_node",
      nodeId: "boom",
      status: "failed",
      error: "[crashed] boom",
    });

    settle(childByTask(children, "task-alpha"), ok("ALPHA"));
    await pending;
    await manager.shutdown();
  });

  it("skipped 节点不写 fact：它从未 dispatch，状态由已记录的上游失败推导", async () => {
    const { manager, children } = makeManager();
    const host = createLiveGraphLedgerHost();
    const recorder = makeRecorder();
    const tool = createRunGraphTool({
      manager,
      ledger: host,
      runtimePersistence: recorder.binder,
      isEnabled: () => true,
    });

    const pending = tool.handler(
      {
        nodes: [
          { id: "boom", task: "task-boom" },
          { id: "after", task: "task-after", deps: ["boom"] },
        ],
      },
      { conversationId: CONV }
    );
    await waitForChildren(children, 1);
    settle(childByTask(children, "task-boom"), fail("crashed"));
    await pending;

    expect(recorder.facts.map((f) => `${f.nodeId}:${f.status}`)).toEqual([
      "boom:running",
      "boom:failed",
    ]);
    // The skipped id never spawned, and the ledger agrees: only the failed id freezes.
    expect(children).toHaveLength(1);
    expect(host.ledgerFor(CONV).frozenIds()).toEqual(["boom"]);
    await manager.shutdown();
  });
});

// ── The dispatch marker is awaited before the spawn ────────────────────

describe("run_graph 运行时状态：dispatch 标记先于副作用", () => {
  it("running fact 落盘前子进程不启动：被阻塞的标记 ⇒ 零 spawn", async () => {
    const gate = deferred();
    const { manager, children } = makeManager();
    const recorder = makeRecorder({
      onAppend: async (fact) => {
        if (fact.status === "running") await gate.promise;
      },
    });
    const tool = createRunGraphTool({
      manager,
      ledger: createLiveGraphLedgerHost(),
      runtimePersistence: recorder.binder,
      isEnabled: () => true,
    });

    const pending = tool.handler(
      { nodes: [{ id: "a", task: "task-alpha" }] },
      { conversationId: CONV }
    );
    await until(() => recorder.entered.length === 1);
    // The marker is in flight and nothing has been submitted yet: a kill here
    // leaves a dispatched-or-not answerable question rather than silent work.
    expect(children).toHaveLength(0);
    expect(recorder.facts).toHaveLength(0);

    gate.release();
    await waitForChildren(children, 1);
    settle(children[0]!, ok("ALPHA"));
    await pending;
    expect(recorder.facts.map((f) => f.status)).toEqual(["running", "done"]);
    await manager.shutdown();
  });
});

// ── Settlement order is recorded; freeze semantics are untouched ───────

describe("run_graph 运行时状态：结算顺序与冻结集合", () => {
  it("后声明的节点先 settle → fact 按结算顺序，冻结集合仍按提交顺序", async () => {
    const { manager, children } = makeManager();
    const host = createLiveGraphLedgerHost();
    const recorder = makeRecorder();
    const tool = createRunGraphTool({
      manager,
      ledger: host,
      runtimePersistence: recorder.binder,
      isEnabled: () => true,
    });

    const pending = tool.handler(
      {
        nodes: [
          { id: "a", task: "task-alpha" },
          { id: "b", task: "task-beta" },
        ],
      },
      { conversationId: CONV }
    );
    await waitForChildren(children, 2);
    // b settles first: its terminal fact must precede a's.
    settle(childByTask(children, "task-beta"), ok("BETA-OUT"));
    await until(() => recorder.facts.length === 3);
    expect(recorder.facts[2]?.nodeId).toBe("b");
    settle(childByTask(children, "task-alpha"), ok("ALPHA-OUT"));
    await pending;

    expect(recorder.facts).toEqual([
      { kind: "graph_node", nodeId: "a", status: "running" },
      { kind: "graph_node", nodeId: "b", status: "running" },
      { kind: "graph_node", nodeId: "b", status: "done", output: "BETA-OUT" },
      { kind: "graph_node", nodeId: "a", status: "done", output: "ALPHA-OUT" },
    ]);
    // Freeze semantics are unchanged by the fact stream: submission order,
    // both ids frozen, outputs still readable for a residual merge.
    const ledger = host.ledgerFor(CONV);
    expect(ledger.frozenIds()).toEqual(["a", "b"]);
    expect(ledger.statusOf("a")).toBe("done");
    expect(ledger.outputOf("a")).toBe("ALPHA-OUT");
    expect(ledger.outputOf("b")).toBe("BETA-OUT");
    await manager.shutdown();
  });
});

// ── A fact append that fails is a real failure ─────────────────────────

describe("run_graph 运行时状态：写不下来的事实是真实失败", () => {
  it("结算事实写失败 → 该节点按 failed 报出（原因写明未落盘），依赖它的节点不执行", async () => {
    const { manager, children } = makeManager();
    const host = createLiveGraphLedgerHost();
    const recorder = makeRecorder({
      onAppend: async (fact) => {
        if (fact.status === "done") throw new Error("writer queue closed");
      },
    });
    const tool = createRunGraphTool({
      manager,
      ledger: host,
      runtimePersistence: recorder.binder,
      isEnabled: () => true,
    });

    const pending = tool.handler(
      {
        nodes: [
          { id: "a", task: "task-alpha" },
          { id: "d", task: "task-down", deps: ["a"] },
        ],
      },
      { conversationId: CONV }
    );
    await waitForChildren(children, 1);
    settle(childByTask(children, "task-alpha"), ok("ALPHA"));
    const out = parseCondensed(await pending);

    // No silent swallow: the node's own success cannot be claimed, and the
    // error says the outcome was not recorded rather than pretending it failed.
    expect(out.nodes[0]?.status).toBe("failed");
    expect(out.nodes[0]?.error).toContain("could not be recorded");
    expect(out.nodes[0]?.error).toContain("writer queue closed");
    // Dependent execution never started on unrecorded state.
    expect(out.nodes[1]?.status).toBe("skipped");
    expect(children).toHaveLength(1);
    expect(host.ledgerFor(CONV).frozenIds()).toEqual(["a"]);
    await manager.shutdown();
  });

  it("dispatch 标记写失败 → 零 spawn（没有证据就没有副作用）", async () => {
    const { manager, children } = makeManager();
    const recorder = makeRecorder({
      onAppend: async (fact) => {
        if (fact.status === "running") throw new Error("writer queue closed");
      },
    });
    const tool = createRunGraphTool({
      manager,
      runtimePersistence: recorder.binder,
      isEnabled: () => true,
    });

    const out = parseCondensed(
      await tool.handler(
        { nodes: [{ id: "a", task: "task-alpha" }] },
        { conversationId: CONV }
      )
    );
    expect(children).toHaveLength(0);
    expect(out.nodes).toEqual([
      {
        id: "a",
        status: "failed",
        error: expect.stringContaining("was not started"),
      },
    ]);
    await manager.shutdown();
  });
});

// ── Unwired host: identical behavior, zero facts ───────────────────────

describe("run_graph 运行时状态：未接持久化时零行为变化", () => {
  it("binder 缺席 与 bind() 返回 undefined → 都不写任何 fact，结果与账本不变", async () => {
    for (const mode of ["no-binder", "unwired-binder"] as const) {
      const { manager, children } = makeManager();
      const host = createLiveGraphLedgerHost();
      const recorder = makeRecorder({ unwired: true });
      const tool = createRunGraphTool({
        manager,
        ledger: host,
        ...(mode === "unwired-binder"
          ? { runtimePersistence: recorder.binder }
          : {}),
        isEnabled: () => true,
      });

      const pending = tool.handler(
        { nodes: [{ id: "a", task: "task-alpha" }] },
        { conversationId: CONV }
      );
      await waitForChildren(children, 1);
      settle(children[0]!, ok("ALPHA"));
      const out = parseCondensed(await pending);

      expect(out.nodes).toEqual([{ id: "a", status: "done", output: "ALPHA" }]);
      expect(host.ledgerFor(CONV).frozenIds()).toEqual(["a"]);
      expect(recorder.facts).toHaveLength(0);
      expect(recorder.entered).toHaveLength(0);
      await manager.shutdown();
    }
  });
});

// ── destroy() is still the end of ledger state ─────────────────────────

describe("run_graph 运行时状态：destroy 后账本不被复活", () => {
  it("调用进行中 destroy → 已结算节点不回到冻结集合，事实照旧写完", async () => {
    const { manager, children } = makeManager();
    const host = createLiveGraphLedgerHost();
    const ledger = host.ledgerFor(CONV);
    const recorder = makeRecorder();
    const tool = createRunGraphTool({
      manager,
      ledger: host,
      runtimePersistence: recorder.binder,
      isEnabled: () => true,
    });

    const pending = tool.handler(
      {
        nodes: [
          { id: "a", task: "task-alpha" },
          { id: "b", task: "task-beta" },
        ],
      },
      { conversationId: CONV }
    );
    await waitForChildren(children, 2);
    settle(childByTask(children, "task-alpha"), ok("ALPHA"));
    await until(() => recorder.facts.length === 3);

    // Session reset while the graph is still running.
    host.destroy(CONV);
    settle(childByTask(children, "task-beta"), ok("BETA"));
    await pending;

    expect(ledger.exists()).toBe(false);
    expect(ledger.frozenIds()).toEqual([]);
    // Durability is the host's, not the ledger's: the in-flight call's
    // remaining fact is still appended, and no append can bring a frozen id back.
    expect(recorder.facts.map((f) => `${f.nodeId}:${f.status}`)).toEqual([
      "a:running",
      "b:running",
      "a:done",
      "b:done",
    ]);
    await manager.shutdown();
  });
});

// ── One settlement decision, two projections ───────────────────────────

/**
 * The ledger freeze and the durable fact are two projections of ONE settlement
 * decision, so the three rules (a caller-side cancel keeps only `done`; only a
 * string output travels; a never-ran `skipped` records nothing) must be
 * decided once. Each row below declares that decision once and then asserts
 * BOTH projections against it, so a rule that drifts into only one of them
 * fails as a table row instead of as a comment nobody re-reads.
 *
 * A non-string `output` is not among the rows: the wire envelope schema types
 * `result` as a string (envelope.ts PARENT_SCHEMA), so that output shape is
 * unreachable through the manager and its rule is pinned structurally below.
 */
interface SettlementRow {
  /** The node whose settlement this row is about. */
  readonly subject: string;
  /** Progress status the caller-side abort is anchored on. */
  readonly anchorStatus: string;
  readonly nodes: ReadonlyArray<{
    readonly id: string;
    readonly task: string;
    readonly deps?: ReadonlyArray<string>;
  }>;
  /** Settles the one child that spawns; omitted = no child spawns at all. */
  readonly settle?: (children: FakeChild[]) => void;
  /** When the caller's abort lands relative to the subject's settlement. */
  readonly cancel: "none" | "after-settle" | "in-flight";
  /** Ledger view of the subject: `frozen: false` = the settlement is unreal. */
  readonly ledger: {
    readonly frozen: boolean;
    readonly output: string | undefined;
  };
  /** The subject's settlement fact, or null when a settlement records none. */
  readonly fact: RuntimeGraphNodeFact | null;
}

const A_THEN_B: SettlementRow["nodes"] = [
  { id: "a", task: "task-alpha" },
  { id: "b", task: "task-beta", deps: ["a"] },
];

const SETTLEMENT_ROWS: ReadonlyArray<SettlementRow> = [
  {
    subject: "a",
    anchorStatus: "done",
    nodes: [{ id: "a", task: "task-alpha" }],
    settle: (cs) => settle(childByTask(cs, "task-alpha"), ok("ALPHA")),
    cancel: "none",
    ledger: { frozen: true, output: "ALPHA" },
    fact: { kind: "graph_node", nodeId: "a", status: "done", output: "ALPHA" },
  },
  {
    subject: "a",
    anchorStatus: "failed",
    nodes: [{ id: "a", task: "task-alpha" }],
    settle: (cs) => settle(childByTask(cs, "task-alpha"), fail("crashed")),
    cancel: "none",
    ledger: { frozen: true, output: undefined },
    fact: {
      kind: "graph_node",
      nodeId: "a",
      status: "failed",
      error: "[crashed] boom",
    },
  },
  {
    subject: "after",
    anchorStatus: "skipped",
    nodes: [
      { id: "boom", task: "task-boom" },
      { id: "after", task: "task-after", deps: ["boom"] },
    ],
    settle: (cs) => settle(childByTask(cs, "task-boom"), fail("crashed")),
    cancel: "none",
    ledger: { frozen: false, output: undefined },
    fact: null,
  },
  {
    subject: "a",
    anchorStatus: "done",
    nodes: A_THEN_B,
    settle: (cs) => settle(childByTask(cs, "task-alpha"), ok("ALPHA")),
    cancel: "after-settle",
    ledger: { frozen: true, output: "ALPHA" },
    fact: { kind: "graph_node", nodeId: "a", status: "done", output: "ALPHA" },
  },
  {
    subject: "a",
    anchorStatus: "failed",
    nodes: A_THEN_B,
    settle: (cs) => settle(childByTask(cs, "task-alpha"), fail("crashed")),
    cancel: "in-flight",
    ledger: { frozen: false, output: undefined },
    fact: null,
  },
  {
    // The one deliberate asymmetry: this failure settled while nothing was
    // cancelled, so the fact stream records it; the abort arrives afterwards
    // and the ledger's cancel rule declines to freeze it. Facts are
    // conservative observations, the ledger's cancel rule is a resubmission
    // policy — if the two projections are ever made identical, THIS row fails.
    subject: "a",
    anchorStatus: "failed",
    nodes: A_THEN_B,
    settle: (cs) => settle(childByTask(cs, "task-alpha"), fail("crashed")),
    cancel: "after-settle",
    ledger: { frozen: false, output: undefined },
    fact: {
      kind: "graph_node",
      nodeId: "a",
      status: "failed",
      error: "[crashed] boom",
    },
  },
];

async function runSettlementRow(row: SettlementRow): Promise<void> {
  const { manager, children } = makeManager();
  const host = createLiveGraphLedgerHost();
  const recorder = makeRecorder();
  const tool = createRunGraphTool({
    manager,
    ledger: host,
    runtimePersistence: recorder.binder,
    isEnabled: () => true,
  });
  const controller = new AbortController();
  // Ground truth for "the scheduler has recorded the subject as X": the
  // graph_progress event the handler streams out of the scheduler's own onNode.
  // The abort is issued from inside that stream callback — safeEmitStream calls
  // onStream synchronously — so "after this node's settlement point, before the
  // graph converges" is guaranteed rather than left to microtask ordering
  // (which would let the next wave spawn and leave a child the manager has to
  // reap through its SIGKILL grace period).
  const onStream = (e: unknown): void => {
    if (row.cancel !== "after-settle") return;
    const event = e as {
      type?: string;
      snapshot?: { nodes: ReadonlyArray<{ id: string; status: string }> };
    };
    if (event.type !== "graph_progress") return;
    const settled = event.snapshot?.nodes.some(
      (n) => n.id === row.subject && n.status === row.anchorStatus
    );
    if (settled === true) controller.abort();
  };
  const pending = tool.handler(
    { nodes: row.nodes },
    { signal: controller.signal, conversationId: CONV, onStream }
  );

  if (row.settle !== undefined) {
    await waitForChildren(children, 1);
    if (row.cancel === "in-flight") {
      controller.abort();
      row.settle(children);
    } else {
      row.settle(children);
    }
  }
  if (row.cancel === "none") {
    await pending;
  } else {
    await expect(pending).rejects.toThrow(/cancel/i);
  }

  // The row's one decision, read off both projections.
  const ledger = host.ledgerFor(CONV);
  expect(ledger.isFrozen(row.subject)).toBe(row.ledger.frozen);
  expect(ledger.outputOf(row.subject)).toBe(row.ledger.output);
  const subjectFacts = recorder.facts.filter(
    (f) => f.nodeId === row.subject && f.status !== "running"
  );
  expect(subjectFacts).toEqual(row.fact === null ? [] : [row.fact]);
  await manager.shutdown();
}

describe("run_graph 结算规则单一定义：账本与 fact 同源", () => {
  for (const row of SETTLEMENT_ROWS) {
    it(`两条投影同一决策：${row.subject} / cancel=${row.cancel} / anchor=${row.anchorStatus}`, async () => {
      await runSettlementRow(row);
    }, 15_000);
  }
});

/**
 * The duplication itself is the defect, so the pin is structural: read the
 * module and assert neither projection spells a rule out. Source-text
 * convention as in agent-status-instruction-seam.test.ts / fault-class.test.ts
 * — a shape cannot be observed through the handler, and the string-output rule
 * is unreachable end-to-end (see the SettlementRow header).
 */
const TOOL_SOURCE = readFileSync(
  join(
    import.meta.dirname,
    "..",
    "..",
    "..",
    "src",
    "harness",
    "graph",
    "run-graph-tool.ts"
  ),
  "utf8"
);

/** One top-level function's body, braces balanced from its first brace. */
function functionBody(signature: string): string {
  const start = TOOL_SOURCE.indexOf(signature);
  expect(start).toBeGreaterThan(-1);
  let depth = 0;
  for (
    let i = TOOL_SOURCE.indexOf("{", start);
    i < TOOL_SOURCE.length;
    i += 1
  ) {
    if (TOOL_SOURCE[i] === "{") depth += 1;
    else if (TOOL_SOURCE[i] === "}") {
      depth -= 1;
      if (depth === 0) return TOOL_SOURCE.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces after ${signature}`);
}

describe("run_graph 结算规则：两处投影不再各自重述（结构性钉子）", () => {
  it("freezeResults / settlementFact 只问同一对判定，不自带规则", () => {
    for (const signature of [
      "function freezeResults(",
      "function settlementFact(",
    ]) {
      const body = functionBody(signature);
      expect(body).toContain("isRealSettlement(");
      expect(body).toContain("carriedOutput(");
      // Rule 1 (a cancel keeps only `done`) and rule 2 (only a string output
      // travels) are re-derived here on neither side.
      expect(body).not.toMatch(/cancelled\s*&&/);
      expect(body).not.toMatch(/typeof\b/);
    }
    // The `skipped` left in freezeResults is the forward to the ledger, which
    // owns skipped-no-freeze at its own single point — not a second decision.
    expect(functionBody("function freezeResults(")).toContain(
      'if (result.status === "skipped")'
    );
    // ... while settlementFact asks the predicate and never re-decides it.
    expect(functionBody("function settlementFact(")).not.toContain("skipped");
  });

  it("每条规则只有一份定义、两个调用点", () => {
    const decision = functionBody("function isRealSettlement(");
    expect(decision).toMatch(/cancelled/);
    expect(decision).toContain("skipped");
    expect(functionBody("function carriedOutput(")).toMatch(/typeof/);
    // One definition + two callers. This count is what turns a second copy of
    // a rule into a failing test instead of a comment going stale.
    expect(TOOL_SOURCE.match(/isRealSettlement\(/g) ?? []).toHaveLength(3);
    expect(TOOL_SOURCE.match(/carriedOutput\(/g) ?? []).toHaveLength(3);
  });
});
