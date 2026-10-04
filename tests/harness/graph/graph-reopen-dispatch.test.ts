/**
 * Reopen dispatch: the restored graph node state must REACH the scheduler
 * (issue #1182 F1, spec §2.5 "completed or failed nodes must not be re-run
 * merely because the process restarted", SC15).
 *
 * The defect this pins: recovery reduced the durable graph facts into a
 * per-node view, attached it to the report — and nothing consumed it. The live
 * ledger is not persisted, so a reopened session started from an empty frozen
 * set and a resubmitted graph re-dispatched nodes that had already settled.
 *
 * The crash is modelled the way a kill leaves the log: a published state, then
 * the graph facts the dead process had written for its nodes. Real store on
 * disk, real `recoverSession` reducer, real ledger host, real `run_graph`
 * handler over a real `SubAgentManager` with fake children — the dispatch
 * decision is the thing under observation, so everything above it stays real
 * and no reducer or ledger is mocked.
 *
 * Proves: a `done` node is not re-dispatched, its output still feeds a
 * downstream node that omits it (the derived-continuation rule, derived from
 * validated graph state + existing scheduler semantics — no `nextNodeIds`), a
 * `failed` node is not re-dispatched either, and a node whose last fact is
 * `running` is neither settled nor failed and stays dispatchable.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createRunGraphTool } from "../../../src/harness/graph/run-graph-tool.ts";
import {
  createLiveGraphLedgerHost,
  seedRestoredGraphNodes,
  type LiveGraphLedgerHost,
} from "../../../src/harness/graph/ledger.ts";
import type { NativeStateSnapshot } from "../../../src/shared/native-state-port.ts";
import {
  CURRENT_SCHEMA_VERSION,
  NATIVE_STATE_FORMAT_VERSION,
  recoverSession,
  SessionStore,
  type SessionFileV1,
} from "../../../src/session-api/store/index.ts";
import type { RuntimeGraphNodeFact } from "../../../src/shared/runtime-persistence.ts";
import {
  makeManager,
  settle,
  ok,
  waitForChildren,
  parseCondensed,
  type FakeChild,
} from "./_fake-manager.ts";

const CONV = "conv-reopen-dispatch";
const liveRootIdentity = "/live/main-checkout";

let baseDir: string;
let taskRoot: string;
let store: SessionStore;

beforeEach(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "iknow-reopen-dispatch-"));
  taskRoot = await mkdtemp(join(tmpdir(), "iknow-reopen-dispatch-root-"));
  store = new SessionStore(baseDir, taskRoot);
});

afterEach(async () => {
  await rm(baseDir, { recursive: true, force: true });
  await rm(taskRoot, { recursive: true, force: true });
});

const sampleFile = (id: string): SessionFileV1 =>
  ({
    schemaVersion: CURRENT_SCHEMA_VERSION,
    conversation_id: id,
    title: "",
    cwd: taskRoot,
    sanitized_at: new Date().toISOString(),
    messages: [],
    jsonMode: false,
    turnCount: 0,
    updatedAt: new Date().toISOString(),
    checkpoints: [],
    nativeStateFormat: NATIVE_STATE_FORMAT_VERSION,
  }) as SessionFileV1;

/** A published state, so recovery has a selected body for facts to anchor to. */
async function publishState(id: string): Promise<void> {
  await store.save({ id, file: sampleFile(id) });
  await store.appendEvents({
    id,
    events: [
      { role: "user", content: [{ type: "text", text: "go" }] },
      { role: "assistant", content: [{ type: "text", text: "on it" }] },
    ],
  });
  const snapshot: NativeStateSnapshot = {
    boundary: "input",
    messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
  };
  await store.appendNativeState({
    id,
    anchorEventId: "e1",
    boundary: "input",
    snapshot,
  });
}

/** What a killed graph process had already written for its nodes. */
async function appendNodeFact(
  id: string,
  fact: RuntimeGraphNodeFact
): Promise<void> {
  await store.appendOperationFact({
    id,
    // Same factId shape the persistence host derives, so a re-dispatch of the
    // same status is a duplicate rather than a second transition.
    factId: `graph_node:${fact.nodeId}:${fact.status}`,
    fact,
  });
}

/** The real reducer, on a real store, returning the restored per-node view. */
async function restoredNodes(
  id: string,
  host: LiveGraphLedgerHost
): Promise<ReadonlyArray<{ nodeId: string; state: string }>> {
  const report = await recoverSession({
    store,
    conversationId: id,
    taskRoot,
    liveRootIdentity,
  });
  const view = report.operationFacts?.graphNodes ?? [];
  seedRestoredGraphNodes(host.ledgerFor(CONV), view);
  return view;
}

function childByTask(children: FakeChild[], taskMarker: string): FakeChild {
  const hit = children.find((c) => c.written.join("").includes(taskMarker));
  expect(hit, `no child with task marker "${taskMarker}"`).toBeDefined();
  return hit!;
}

/** A `done` and a `failed` node, plus one interrupted mid-flight. */
async function seedCrashedGraph(id: string): Promise<void> {
  await publishState(id);
  await appendNodeFact(id, {
    kind: "graph_node",
    nodeId: "alpha",
    status: "running",
  });
  await appendNodeFact(id, {
    kind: "graph_node",
    nodeId: "alpha",
    status: "done",
    output: "ALPHA",
  });
  await appendNodeFact(id, {
    kind: "graph_node",
    nodeId: "gamma",
    status: "running",
  });
  await appendNodeFact(id, {
    kind: "graph_node",
    nodeId: "gamma",
    status: "failed",
    error: "boom",
  });
  // dispatched, never settled: the last transition is the verdict
  await appendNodeFact(id, {
    kind: "graph_node",
    nodeId: "beta",
    status: "running",
  });
}

describe("重开图：恢复的节点状态必须到达调度（settled 不再 dispatch）", () => {
  it("一个 nodeId 只有一条记录，最后一次 transition 即结论（真实 reducer）", async () => {
    const host = createLiveGraphLedgerHost();
    await seedCrashedGraph(CONV);

    const view = await restoredNodes(CONV, host);

    expect(view.map((n) => `${n.nodeId}:${n.state}`)).toEqual([
      "alpha:settled",
      "gamma:settled",
      "beta:in_flight",
    ]);
    const ledger = host.ledgerFor(CONV);
    expect(ledger.statusOf("alpha")).toBe("done");
    expect(ledger.outputOf("alpha")).toBe("ALPHA");
    expect(ledger.statusOf("gamma")).toBe("failed");
    // In flight is neither settled nor failed: an interrupted dispatch has an
    // unknown outcome, and freezing it would read as a failure that never
    // happened.
    expect(ledger.isFrozen("beta")).toBe(false);
    expect(ledger.statusOf("beta")).toBeUndefined();
  });

  it("重开后再提交已 settled 的 node：零 spawn，frozen id 被指名拒绝", async () => {
    const host = createLiveGraphLedgerHost();
    await seedCrashedGraph(CONV);
    await restoredNodes(CONV, host);
    const { manager, children } = makeManager();
    const tool = createRunGraphTool({
      manager,
      ledger: host,
      isEnabled: () => true,
    });

    await expect(
      tool.handler(
        {
          nodes: [
            { id: "alpha", task: "task-alpha" },
            { id: "gamma", task: "task-gamma" },
          ],
        },
        { conversationId: CONV }
      )
    ).rejects.toThrow(/frozen id\(s\) cannot be re-run.*alpha.*gamma/s);
    expect(children).toHaveLength(0);
    await manager.shutdown();
  });

  it("恢复的 done 输出喂给省略它的下游 node：续跑由已验证图状态推导", async () => {
    const host = createLiveGraphLedgerHost();
    await seedCrashedGraph(CONV);
    await restoredNodes(CONV, host);
    const { manager, children } = makeManager();
    const tool = createRunGraphTool({
      manager,
      ledger: host,
      isEnabled: () => true,
    });

    const pending = tool.handler(
      {
        // alpha is omitted — the residual-subgraph shape — but still a dep.
        nodes: [{ id: "downstream", task: "task-downstream", deps: ["alpha"] }],
      },
      { conversationId: CONV }
    );
    await waitForChildren(children, 1);
    expect(children[0]!.written.join("")).toContain("ALPHA");

    settle(childByTask(children, "task-downstream"), ok("DOWN"));
    expect(parseCondensed(await pending).nodes).toEqual([
      { id: "downstream", status: "done", output: "DOWN" },
    ]);
    await manager.shutdown();
  });

  it("最后一条 fact 是 running 的 node 仍可 dispatch：未知结果不是失败", async () => {
    const host = createLiveGraphLedgerHost();
    await seedCrashedGraph(CONV);
    await restoredNodes(CONV, host);
    const { manager, children } = makeManager();
    const tool = createRunGraphTool({
      manager,
      ledger: host,
      isEnabled: () => true,
    });

    const pending = tool.handler(
      { nodes: [{ id: "beta", task: "task-beta" }] },
      { conversationId: CONV }
    );
    await waitForChildren(children, 1);
    settle(childByTask(children, "task-beta"), ok("BETA"));

    expect(parseCondensed(await pending).nodes).toEqual([
      { id: "beta", status: "done", output: "BETA" },
    ]);
    expect(host.ledgerFor(CONV).statusOf("beta")).toBe("done");
    await manager.shutdown();
  });
});
