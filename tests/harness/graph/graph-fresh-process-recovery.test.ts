/**
 * SC15 — live graph state, across an abnormal host exit, in fresh processes.
 *
 * The shape of the claim: a real graph host settles at least one node
 * successfully and one with failure, is SIGKILLed while a third node is still
 * running, and a SECOND real process — a fresh store, a fresh ledger, a fresh
 * sub-agent manager — must not re-dispatch a settled node and must not read the
 * interrupted node as settled.
 *
 * Both processes are real. The node "workers" are real child processes started
 * by the production spawn factory, so "was it dispatched?" is answered by
 * whether a process was started, not by a counter on a fake manager.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "vitest";

import {
  parseSessionJsonl,
  type SessionOperationFactRecord,
} from "../../../src/session-api/store/jsonl.ts";
import type { RuntimeGraphNodeFact } from "../../../src/shared/runtime-persistence.ts";
import {
  createCrashHost,
  disposeAllCrashHosts,
  realLogBytes,
  runHostToCompletion,
  runHostToCrashPoint,
  runRoleInFreshProcess,
  type CrashHost,
} from "../../session-api/crash/crash-harness.ts";

/** Two real hosts and one real manager with real children. */
const CRASH_TEST_TIMEOUT = 240_000;

interface ReopenGraphResult {
  /** The durable per-node view the fresh process reduced from the real log. */
  readonly graphNodes: ReadonlyArray<{
    readonly nodeId: string;
    readonly state: "settled" | "in_flight";
    readonly status?: string;
    readonly outcome?: string;
    readonly output?: string;
  }>;
  /** The live ledger's own view, read back from the ledger the reopen seeded. */
  readonly seededLedger: ReadonlyArray<{
    readonly nodeId: string;
    readonly frozen: boolean;
    readonly status: string | null;
    readonly output: string | undefined;
  }>;
  /** The whole graph re-submitted to the seeded ledger. */
  readonly resubmit: {
    readonly accepted: boolean;
    readonly error: string | null;
    /** Task text of every node that submission dispatched, in order. */
    readonly spawned: ReadonlyArray<string>;
  };
  /** The interrupted node submitted on its own. */
  readonly rescue: {
    readonly beta: string;
    /** Task text of every node the fresh process dispatched, in order. */
    readonly spawned: ReadonlyArray<string>;
  };
}

const graphFacts = (raw: string): ReadonlyArray<RuntimeGraphNodeFact> =>
  parseSessionJsonl(raw)
    .records.filter(
      (r): r is SessionOperationFactRecord => r.type === "operation_fact"
    )
    .map((r) => r.fact as unknown as RuntimeGraphNodeFact)
    .filter((f) => f.kind === "graph_node");

let host: CrashHost;

afterEach(async () => {
  await disposeAllCrashHosts();
});

describe("SC15 — live graph state across an abnormal host exit (fresh process)", () => {
  it(
    "SC15: after a real host SIGKILL with one node in flight, a second process re-dispatches only the interrupted node and never a settled one",
    async () => {
      host = await createCrashHost({
        prefix: "iknow-sc15-",
        conversationId: "sc15-graph",
      });
      // The session the graph facts ride on: one published state, so the sink has
      // a real head chain to anchor to.
      await runHostToCompletion({
        host,
        timeoutMs: CRASH_TEST_TIMEOUT,
        request: {
          role: "publish",
          plan: [
            { op: "create", cwd: host.workspaceRoot },
            {
              op: "appendEvents",
              messages: [
                {
                  role: "user",
                  content: [{ type: "text", text: "run the graph" }],
                },
              ],
            },
            {
              op: "appendNativeState",
              anchorEventId: "e0",
              boundary: "input",
              messages: [
                {
                  role: "user",
                  content: [{ type: "text", text: "run the graph" }],
                },
              ],
            },
          ],
        },
      });

      const receipt = await runHostToCrashPoint({
        host,
        crashPoint: "graph_node_in_flight",
        timeoutMs: CRASH_TEST_TIMEOUT,
        request: { role: "graph_host" },
      });
      assert.equal(
        receipt.signal,
        "SIGKILL",
        "the graph host died by a real signal"
      );
      assert.equal(
        receipt.detail.spawned,
        3,
        "all three nodes were really dispatched as child processes"
      );

      // --- the real on-disk facts, read here ---
      const facts = graphFacts(await realLogBytes(host));
      const lastStatusOf = (nodeId: string): string | undefined =>
        facts.filter((f) => f.nodeId === nodeId).at(-1)?.status;
      assert.equal(
        lastStatusOf("alpha"),
        "done",
        "one node settled successfully"
      );
      assert.equal(lastStatusOf("gamma"), "failed", "one node settled failed");
      assert.equal(
        lastStatusOf("beta"),
        "running",
        "the interrupted node's last fact is its dispatch, not an outcome"
      );
      assert.equal(
        facts.some((f) => f.nodeId === "beta" && f.status !== "running"),
        false,
        "the killed host never settled the in-flight node"
      );

      // --- the second real process ---
      const reopened = await runRoleInFreshProcess<ReopenGraphResult>({
        host,
        request: { role: "reopen_graph" },
        timeoutMs: CRASH_TEST_TIMEOUT,
      });

      // The reduced view: settled / in-flight, not a flat status list. Only the
      // fields the criterion turns on are asserted — the reduction also carries a
      // fact id and a transition count, which are not this test's business.
      const byNode = new Map(reopened.graphNodes.map((n) => [n.nodeId, n]));
      assert.deepEqual(
        {
          state: byNode.get("alpha")?.state,
          status: byNode.get("alpha")?.status,
          output: byNode.get("alpha")?.output,
        },
        { state: "settled", status: "done", output: "SETTLED-OUTPUT" },
        "the settled-done node reads back as settled"
      );
      assert.deepEqual(
        {
          state: byNode.get("gamma")?.state,
          status: byNode.get("gamma")?.status,
        },
        { state: "settled", status: "failed" },
        "the settled-failed node reads back as settled"
      );
      assert.deepEqual(
        {
          state: byNode.get("beta")?.state,
          outcome: byNode.get("beta")?.outcome,
        },
        { state: "in_flight", outcome: "unknown" },
        "an interrupted dispatch is in-flight, never settled"
      );

      // The live ledger the reopen seeded, read back from the ledger itself.
      const ledgerByNode = new Map(
        reopened.seededLedger.map((n) => [n.nodeId, n])
      );
      // `output` is absent rather than undefined for the failed node: the
      // cross-process result is JSON, and JSON drops undefined fields.
      assert.deepEqual(
        {
          nodeId: ledgerByNode.get("alpha")?.nodeId,
          frozen: ledgerByNode.get("alpha")?.frozen,
          status: ledgerByNode.get("alpha")?.status,
          output: ledgerByNode.get("alpha")?.output,
        },
        {
          nodeId: "alpha",
          frozen: true,
          status: "done",
          output: "SETTLED-OUTPUT",
        }
      );
      assert.deepEqual(
        {
          nodeId: ledgerByNode.get("gamma")?.nodeId,
          frozen: ledgerByNode.get("gamma")?.frozen,
          status: ledgerByNode.get("gamma")?.status,
        },
        { nodeId: "gamma", frozen: true, status: "failed" }
      );
      assert.equal(
        ledgerByNode.get("beta")?.frozen,
        false,
        "the in-flight node is not frozen"
      );

      // Dispatch evidence: real child processes, real task text. Re-submitting
      // the whole graph is refused for the frozen ids, with zero spawns.
      assert.equal(
        reopened.resubmit.accepted,
        false,
        "the whole graph cannot be re-submitted while settled ids are frozen"
      );
      assert.match(
        reopened.resubmit.error ?? "",
        /alpha/,
        "the refusal names the settled node"
      );
      assert.match(
        reopened.resubmit.error ?? "",
        /gamma/,
        "the refusal names the failed-but-settled node"
      );
      assert.deepEqual(
        reopened.resubmit.spawned,
        [],
        "no settled node was dispatched again"
      );
      // The in-flight node was not treated as settled: on its own it dispatches,
      // and the real child process is the evidence.
      assert.equal(reopened.rescue.beta, "accepted");
      assert.deepEqual(
        reopened.rescue.spawned,
        ["settle:beta-again"],
        "exactly the interrupted node was dispatched"
      );
    },
    CRASH_TEST_TIMEOUT
  );
});
