/**
 * STATIC lock on run_graph's two `undurable` node-failure strings — the model
 * input the plans A/B/C merge introduced.
 *
 * SC26: a node's `error` is not a log line. `condense()` copies it into the
 * condensed report the handler RETURNS, and that return value is the tool
 * result the model reads, so the wording is a versioned prompt artifact: the
 * model decides its next move from whether the node failed or only its outcome
 * failed to become durable. `docs/guides/prompt-development.md` requires such a
 * surface to carry at least a STATIC lock, and the graph row of that roster
 * claims STATIC + trajectory coverage, so these two strings were a gap on a
 * non-Gap row until this file.
 *
 * What is pinned, and why each part: the node id names what is blocked, "was not
 * started" refuses to claim side effects that never ran, "could not be recorded"
 * refuses to claim durability the writer did not give, and the cause stays last
 * so a reword cannot push it out of the sentence. The literals are asserted
 * whole: a reword fails here instead of drifting, because "the work failed" and
 * "the work's outcome is not durable" are different instructions to the model.
 *
 * The recording sink is the real contract implemented in the test, the same shape
 * `graph-runtime-state-persistence.test.ts` uses, so a failure here is a wording
 * change rather than a wiring change: that file already pins which fact is
 * attempted and when, and the two overlap only on the text.
 */
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
  waitForChildren,
  parseCondensed,
} from "./_fake-manager.ts";

const CONV = "conv-undurable-text";

/**
 * A sink that accepts every graph fact except the one `status` named, so the
 * rejection the string under test describes is the only failure on the path.
 * `cause` is thrown as given: an `Error` renders as its message, a typed
 * `{kind, context}` throwable as `kind: context` (see `error-render.ts`).
 */
function sinkRejecting(
  status: RuntimeGraphNodeFact["status"],
  cause: unknown
): RuntimePersistenceBinder<AnthropicNativeMessage> {
  const sink: RuntimePersistenceSink<AnthropicNativeMessage> = {
    // Not on the path under test: run_graph appends per-node facts only.
    publishSavedState: async () => {
      throw new Error("run_graph must not publish a full state");
    },
    appendOperationFact: async (
      fact: RuntimeOperationFact<AnthropicNativeMessage>
    ) => {
      if (fact.kind !== "graph_node") {
        throw new Error(`unexpected fact kind from run_graph: ${fact.kind}`);
      }
      if (fact.status === status) throw cause;
    },
  };
  return { bind: () => sink };
}

describe("run_graph undurable-fact text (STATIC lock)", () => {
  it("says the node was not started when its dispatch could not be recorded", async () => {
    const { manager, children } = makeManager();
    const tool = createRunGraphTool({
      manager,
      ledger: createLiveGraphLedgerHost(),
      runtimePersistence: sinkRejecting("running", "writer queue closed"),
      isEnabled: () => true,
    });

    // Awaiting resolves rather than throwing: a node-level failure is data in
    // the returned condensed report, and that report is the tool result.
    const out = parseCondensed(
      await tool.handler(
        { nodes: [{ id: "a", task: "task-alpha" }] },
        { conversationId: CONV }
      )
    );

    expect(out.nodes).toEqual([
      {
        id: "a",
        status: "failed",
        error:
          'run_graph: node "a" was not started because its dispatch could not be recorded: writer queue closed',
      },
    ]);
    // The string's claim is the behavior: no dispatch marker, no side effect.
    expect(children).toHaveLength(0);
    await manager.shutdown();
  });

  it("keeps the finished status and says the outcome could not be recorded", async () => {
    const { manager, children } = makeManager();
    const tool = createRunGraphTool({
      manager,
      ledger: createLiveGraphLedgerHost(),
      runtimePersistence: sinkRejecting("done", "writer queue closed"),
      isEnabled: () => true,
    });

    const pending = tool.handler(
      { nodes: [{ id: "boom", task: "task-boom" }] },
      { conversationId: CONV }
    );
    await waitForChildren(children, 1);
    settle(children[0]!, ok("BOOM"));
    const out = parseCondensed(await pending);

    // "finished as done" must survive verbatim: the node's work did succeed, so
    // reporting it as merely failed would invite a repeat of an effect that
    // already happened.
    expect(out.nodes[0]?.status).toBe("failed");
    expect(out.nodes[0]?.error).toBe(
      'run_graph: node "boom" finished as done but that outcome could not be recorded: writer queue closed'
    );
    await manager.shutdown();
  });

  it("appends the writer cause last, behind the durable clause", async () => {
    // A typed throwable is rendered `kind: context` by formatNodeError; the
    // durable clause has to stay the first thing the model reads, so the cause
    // is asserted as the sentence's suffix rather than a substring anywhere in
    // it — a reword that moved the cause to the front fails here.
    const { manager } = makeManager();
    const tool = createRunGraphTool({
      manager,
      ledger: createLiveGraphLedgerHost(),
      runtimePersistence: sinkRejecting("running", {
        kind: "writer_queue_closed",
        context: { conversationId: CONV },
      }),
      isEnabled: () => true,
    });

    const out = parseCondensed(
      await tool.handler(
        { nodes: [{ id: "a", task: "task-alpha" }] },
        { conversationId: CONV }
      )
    );

    expect(out.nodes[0]?.error).toBe(
      'run_graph: node "a" was not started because its dispatch could not be recorded: writer_queue_closed: {"conversationId":"conv-undurable-text"}'
    );
    await manager.shutdown();
  });
});
