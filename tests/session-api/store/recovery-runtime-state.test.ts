/**
 * The recovery report's RUNTIME half (ADR-0136 §4, F2 of issue #1182): the
 * selected checkpoint's typed runtime state, and the operation facts folded
 * against it.
 *
 * Real temporary store, real content-addressed bodies, real operation-fact
 * appends — the three poisoned-payload cases are hand-written log lines and
 * bodies and say so, because a production writer REJECTS them (that rejection
 * is the behaviour under test: a payload carrying process-memory material must
 * never be surfaced).
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "vitest";

import {
  CURRENT_SCHEMA_VERSION,
  NATIVE_STATE_FORMAT_VERSION,
  nativeStateBodySha,
  recoverSession,
  resolveConversationDir,
  resolveProjectSessionDir,
  SessionStore,
  type SessionFileV1,
} from "../../../src/session-api/store/index.ts";
import { openSessionWithRecovery } from "../../../src/session-api/recovery-host.ts";
import type { NativeStateSnapshot } from "../../../src/shared/native-state-port.ts";
import type { RuntimeOperationFact } from "../../../src/shared/runtime-persistence.ts";
import type {
  OwnedStopEvidence,
  OwnedWorkerSweepResult,
} from "../../../src/harness/subagent/worker-identity-stop.ts";

type Fact = RuntimeOperationFact<NativeStateSnapshot["messages"][number]>;

let baseDir: string;
let taskRoot: string;
let projectDir: string;
let store: SessionStore;
const liveRootIdentity = "/live/main-checkout";

const sessionDirFor = (id: string): string =>
  resolveConversationDir({ projectDir, conversationId: id });
const jsonlFor = (id: string): string => join(sessionDirFor(id), `${id}.jsonl`);

beforeEach(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "iknow-recovery-runtime-"));
  taskRoot = await mkdtemp(join(tmpdir(), "iknow-recovery-runtime-root-"));
  projectDir = resolveProjectSessionDir(baseDir, taskRoot);
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

const userMsg = (text: string) => ({
  role: "user" as const,
  content: [{ type: "text" as const, text }],
});
const assistantMsg = (text: string) => ({
  role: "assistant" as const,
  content: [{ type: "text" as const, text }],
});

/** Two committed events (ids `e1`, `e2`) and a published state at `e1`. */
async function seed(
  id: string,
  snapshot?: NativeStateSnapshot
): Promise<{ readonly bodySha: string }> {
  await store.save({ id, file: sampleFile(id) });
  await store.appendEvents({
    id,
    events: [userMsg("accepted input"), assistantMsg("acknowledged")],
  });
  const published = await store.appendNativeState({
    id,
    anchorEventId: "e1",
    boundary: "input",
    snapshot: snapshot ?? {
      boundary: "input",
      messages: [userMsg("accepted input")],
    },
  });
  return { bodySha: published.bodySha };
}

const recover = (
  id: string,
  opts: { readonly workerSweep?: OwnedWorkerSweepResult } = {}
) =>
  recoverSession({
    store,
    conversationId: id,
    taskRoot,
    liveRootIdentity,
    ...(opts.workerSweep !== undefined
      ? { workerSweep: opts.workerSweep }
      : {}),
  });

const appendFact = (id: string, factId: string, fact: Fact) =>
  store.appendOperationFact({ id, factId, fact });

const resultMessage = {
  role: "user" as const,
  content: [
    {
      type: "tool_result" as const,
      tool_use_id: "tu-1",
      content: [{ type: "text" as const, text: "ok" }],
    },
  ],
};

const toolFact: Fact = {
  kind: "tool_result",
  toolUseId: "tu-1",
  turnId: "e1",
  batchPosition: 0,
  batchSize: 1,
  resultMessage,
  files: [
    {
      relPath: "a.ts",
      rootIdentity: liveRootIdentity,
      absentBefore: false,
      postimageSha: "ab".repeat(32),
      published: true,
    },
  ],
};

const workerFact: Fact = {
  kind: "worker_progress",
  taskId: "task-1",
  ownership: "background",
  state: "running",
  process: { pid: 4242, startTime: 1000 },
  transcriptPath: "/workers/task-1.jsonl",
  toolUseId: "tu-1",
};

const sweepProving = (taskId: string): OwnedWorkerSweepResult => ({
  workers: [
    {
      taskId,
      ownership: "background",
      pid: 4242,
      state: "confirmed_stopped",
      signalled: true,
      detail: "gone",
      cleanup: { state: "confirmed_stopped", pid: 4242 },
    },
  ],
  unreadable: [],
  unrecorded: [],
  excluded: [],
});

/** An explicit "this host owns no worker" sweep result. */
const NO_WORKERS_TO_SWEEP: OwnedWorkerSweepResult = {
  workers: [],
  unreadable: [],
  unrecorded: [],
  excluded: [],
};

/** A sweep that proved nothing about the worker. */
const sweepUnproved: OwnedWorkerSweepResult = {
  ...sweepProving("task-1"),
  workers: [
    {
      ...sweepProving("task-1").workers[0]!,
      state: "needs_handling",
      signalled: false,
      cleanup: {
        state: "unconfirmed",
        reason: "signal_refused",
        pid: 4242,
        detail: "pid did not match the owned worker",
      } satisfies OwnedStopEvidence,
    },
  ],
};

/** Append a hand-written tail line. A production writer rejects the payloads
 *  the poisoned cases use, so they cannot be produced through the store. */
async function appendRawRecord(id: string, record: unknown): Promise<void> {
  const path = jsonlFor(id);
  await writeFile(
    path,
    `${await readFile(path, "utf8")}${JSON.stringify(record)}\n`,
    "utf8"
  );
}

/** Publish a state from hand-written bytes plus a hand-written record. */
async function publishRawBody(id: string, snapshot: unknown): Promise<string> {
  const bytes = Buffer.from(JSON.stringify(snapshot), "utf8");
  const bodySha = nativeStateBodySha(bytes);
  await mkdir(join(sessionDirFor(id), "blobs", "native"), { recursive: true });
  await writeFile(join(sessionDirFor(id), "blobs", "native", bodySha), bytes);
  await appendRawRecord(id, {
    type: "native_state",
    anchorEventId: "e1",
    bodySha,
    boundary: "input",
    messageCount: 1,
    createdAt: new Date().toISOString(),
  });
  return bodySha;
}

describe("recoverSession carries the selected checkpoint's runtime state", () => {
  it("(a) assembly, loop position, graph, workers and terminal come back with their real values", async () => {
    const id = "runtime-full";
    const graphNodes = [
      {
        kind: "graph_node" as const,
        nodeId: "node-a",
        status: "done" as const,
        output: "42",
      },
    ];
    const workers = [workerFact] as const;
    const toolResults = [toolFact] as const;
    await seed(id, {
      boundary: "input",
      messages: [userMsg("accepted input")],
      assembly: {
        systemPrefix: "PREFIX",
      },
      toolResults: [...toolResults],
      graphNodes: [...graphNodes],
      workers: [...workers],
      terminal: { stopReason: "end_turn" },
      runtimeFacts: { compactionMarker: "c1" },
    });

    const report = await recover(id);
    assert.equal(report.status.status, "recovered");
    assert.deepEqual(report.runtime, {
      assembly: {
        systemPrefix: "PREFIX",
      },
      toolResults: [...toolResults],
      graphNodes: [...graphNodes],
      workers: [...workers],
      terminal: { stopReason: "end_turn" },
      runtimeFacts: { compactionMarker: "c1" },
    });
  });

  it("(b) a checkpoint with no runtime state reports absent, not synthesized defaults", async () => {
    const id = "runtime-absent";
    await seed(id);

    const report = await recover(id);
    assert.equal(
      report.runtime,
      null,
      "absent runtime state must not arrive as an empty object a reader would read as 'nothing was running'"
    );
    assert.equal(report.operationFacts?.workers.length, 0);
    assert.equal(report.operationFacts?.graphNodes.length, 0);
  });

  it("(c) a persisted credential is rejected on read and never surfaced", async () => {
    const id = "runtime-credential";
    await store.save({ id, file: sampleFile(id) });
    await store.appendEvents({ id, events: [userMsg("q"), assistantMsg("a")] });
    await publishRawBody(id, {
      boundary: "input",
      messages: [userMsg("q")],
      runtimeFacts: { apiKey: "not-a-real-key" },
    });

    const report = await recover(id);
    assert.equal(report.status.status, "blocked");
    assert.equal(
      report.status.status === "blocked" && report.status.reason,
      "published_state_body_schema_invalid"
    );
    assert.equal(report.runtime, null);
    assert.ok(
      report.status.status === "blocked" &&
        report.status.detail.includes("apiKey"),
      "the blocked detail names the refused field"
    );
    assert.ok(
      !JSON.stringify(report).includes("not-a-real-key"),
      "the refused value must not reach the report at all"
    );
  });

  it("(d) a persisted live process handle is rejected on read", async () => {
    const id = "runtime-handle";
    await store.save({ id, file: sampleFile(id) });
    await store.appendEvents({ id, events: [userMsg("q"), assistantMsg("a")] });
    await publishRawBody(id, {
      boundary: "input",
      messages: [userMsg("q")],
      workers: [
        {
          kind: "worker_progress",
          taskId: "task-1",
          ownership: "background",
          state: "running",
          process: { pid: 1, startTime: 2, childProcessHandle: "handle-1" },
        },
      ],
    });

    const report = await recover(id);
    assert.equal(report.status.status, "blocked");
    assert.equal(report.runtime, null);
    assert.ok(
      report.status.status === "blocked" &&
        report.status.detail.includes("workers[0].process"),
      `a process value carrying anything but identity is refused on read, got: ${
        report.status.status === "blocked"
          ? report.status.detail
          : "not blocked"
      }`
    );
  });

  it("(e) a persisted process-memory permission grant is rejected on read", async () => {
    const id = "runtime-grant";
    await store.save({ id, file: sampleFile(id) });
    await store.appendEvents({ id, events: [userMsg("q"), assistantMsg("a")] });
    await publishRawBody(id, {
      boundary: "input",
      messages: [userMsg("q")],
      runtimeFacts: { permissionGrants: ["write_file"] },
    });

    const report = await recover(id);
    assert.equal(report.status.status, "blocked");
    assert.equal(report.runtime, null);
    assert.ok(
      report.status.status === "blocked" &&
        report.status.detail.includes("permissionGrants"),
      "a process-memory grant is refused on read, not restored (SC18)"
    );
  });
});

describe("recoverSession folds the operation facts", () => {
  it("(a) a settled tool result on a selected base contributes its message and per-file associations", async () => {
    const id = "fact-tool";
    await seed(id);
    await appendFact(id, "f-tool", toolFact);

    const report = await recover(id);
    assert.equal(report.status.status, "recovered");
    const facts = report.operationFacts!;
    assert.equal(facts.toolResults.length, 1);
    assert.deepEqual(facts.toolResults[0], {
      factId: "f-tool",
      toolUseId: "tu-1",
      batchPosition: 0,
      batchSize: 1,
      turnId: "e1",
      resultMessage,
      files: [
        {
          relPath: "a.ts",
          rootIdentity: liveRootIdentity,
          absentBefore: false,
          postimageSha: "ab".repeat(32),
          published: true,
        },
      ],
    });
    assert.deepEqual(facts.unanchored, []);
    assert.equal(
      report.savedMessageCount,
      1,
      "a fact accounts for progress; it does not enter the restored context"
    );
  });

  it("(b) a done node keeps its output and a failed node keeps its error", async () => {
    const id = "fact-graph-settled";
    await seed(id);
    await appendFact(id, "f-done", {
      kind: "graph_node",
      nodeId: "node-a",
      status: "done",
      output: "42",
    });
    await appendFact(id, "f-failed", {
      kind: "graph_node",
      nodeId: "node-b",
      status: "failed",
      error: "boom",
    });

    const nodes = (await recover(id)).operationFacts!.graphNodes;
    assert.deepEqual(nodes, [
      {
        factId: "f-done",
        nodeId: "node-a",
        state: "settled",
        status: "done",
        output: "42",
        transitions: 1,
      },
      {
        factId: "f-failed",
        nodeId: "node-b",
        state: "settled",
        status: "failed",
        error: "boom",
        transitions: 1,
      },
    ]);
  });

  it("(c) a running node is in flight with an unknown outcome, never a settled failure", async () => {
    const id = "fact-graph-running";
    await seed(id);
    await appendFact(id, "f-running", {
      kind: "graph_node",
      nodeId: "node-c",
      status: "running",
    });

    const nodes = (await recover(id)).operationFacts!.graphNodes;
    assert.deepEqual(nodes, [
      {
        factId: "f-running",
        nodeId: "node-c",
        state: "in_flight",
        outcome: "unknown",
        transitions: 1,
      },
    ]);
    assert.notEqual(
      nodes[0]!.state,
      "settled",
      "a dispatched node must not read as done or as failed"
    );
  });

  it("(d) a fact whose base is null is unanchored, not merged", async () => {
    const id = "fact-no-base";
    await store.save({ id, file: sampleFile(id) });
    await store.appendEvents({ id, events: [userMsg("q"), assistantMsg("a")] });
    // appended before any publication: there is no base state to anchor to
    await appendFact(id, "f-orphan", toolFact);
    await store.appendNativeState({
      id,
      anchorEventId: "e1",
      boundary: "input",
      snapshot: { boundary: "input", messages: [userMsg("q")] },
    });

    const facts = (await recover(id)).operationFacts!;
    assert.deepEqual(facts.toolResults, []);
    assert.deepEqual(facts.unanchored, [
      {
        factId: "f-orphan",
        kind: "tool_result",
        reason: "no_base_state",
        baseBodySha: null,
      },
    ]);
  });

  it("(e) a fact whose base was not selected is unanchored, not merged", async () => {
    const id = "fact-unselected-base";
    const first = await seed(id);
    await appendFact(id, "f-stale", toolFact);
    // A second publication on the same anchor supersedes the first, so the
    // fact's base is a body selection did not choose.
    const second = await store.appendNativeState({
      id,
      anchorEventId: "e1",
      boundary: "input",
      snapshot: {
        boundary: "input",
        messages: [userMsg("accepted input"), assistantMsg("echo")],
      },
    });
    assert.notEqual(second.bodySha, first.bodySha);

    const facts = (await recover(id)).operationFacts!;
    assert.deepEqual(facts.toolResults, []);
    assert.deepEqual(facts.unanchored, [
      {
        factId: "f-stale",
        kind: "tool_result",
        reason: "base_state_not_selected",
        baseBodySha: first.bodySha,
      },
    ]);
    assert.equal(facts.unanchored[0]?.baseBodySha !== second.bodySha, true);
  });

  it("(f) a fact payload carrying a live handle is rejected on read, never folded", async () => {
    const id = "fact-poisoned";
    const { bodySha } = await seed(id);
    await appendRawRecord(id, {
      type: "operation_fact",
      factId: "f-poisoned",
      anchorEventId: "e1",
      baseBodySha: bodySha,
      fact: { ...workerFact, permissionGrant: "always-allow" },
      createdAt: new Date().toISOString(),
    });

    const report = await recover(id);
    const facts = report.operationFacts!;
    assert.deepEqual(facts.workers, []);
    assert.equal(facts.rejected.length, 1);
    assert.equal(facts.rejected[0]?.factId, "f-poisoned");
    assert.equal(facts.rejected[0]?.field, "permissionGrant");
    assert.ok(
      !JSON.stringify(report).includes("always-allow"),
      "the refused value must not reach the report"
    );
  });

  it("(g) the reducer is idempotent and a repeated factId is counted once", async () => {
    const id = "fact-idempotent";
    const { bodySha } = await seed(id);
    await appendFact(id, "f-tool", toolFact);
    await appendRawRecord(id, {
      type: "operation_fact",
      factId: "f-tool",
      anchorEventId: "e1",
      baseBodySha: bodySha,
      fact: toolFact,
      createdAt: new Date().toISOString(),
    });

    const first = await recover(id);
    const second = await recover(id);
    assert.deepEqual(second.operationFacts, first.operationFacts);
    const facts = first.operationFacts!;
    assert.equal(facts.toolResults.length, 1, "one factId, one entry");
    assert.deepEqual(facts.duplicateFactIds, ["f-tool"]);
  });
});

describe("recoverSession owned-worker stop posture (SC17)", () => {
  it("(a) an unproven stop is reported as needing handling, never as stopped", async () => {
    const id = "worker-unproven";
    await seed(id);
    await appendFact(id, "f-worker", workerFact);

    const withoutSweep = await recover(id);
    const worker = withoutSweep.operationFacts!.workers[0]!;
    assert.equal(worker.needsHandling, true);
    assert.equal(worker.stopEvidence, null);
    assert.deepEqual(withoutSweep.status, {
      status: "needs handling",
      handling: [],
      workers: ["task-1"],
    });

    const withUnprovedSweep = await recover(id, {
      workerSweep: sweepUnproved,
    });
    assert.deepEqual(
      withUnprovedSweep.operationFacts!.workers[0]!.stopEvidence,
      {
        state: "unconfirmed",
        reason: "signal_refused",
        pid: 4242,
        detail: "pid did not match the owned worker",
      }
    );
    assert.equal(
      withUnprovedSweep.operationFacts!.workers[0]!.needsHandling,
      true
    );
  });

  it("(b) proven stop evidence clears the worker and reports ownership, identity and transcript", async () => {
    const id = "worker-proven";
    await seed(id);
    await appendFact(id, "f-worker", workerFact);

    const report = await recover(id, { workerSweep: sweepProving("task-1") });
    assert.deepEqual(report.status, { status: "recovered" });
    assert.deepEqual(report.operationFacts!.workers[0], {
      factId: "f-worker",
      taskId: "task-1",
      ownership: "background",
      state: "running",
      process: { pid: 4242, startTime: 1000 },
      transcriptPath: "/workers/task-1.jsonl",
      toolUseId: "tu-1",
      stopEvidence: { state: "confirmed_stopped", pid: 4242 },
      needsHandling: false,
    });
  });
});

describe("openSessionWithRecovery runs the owned-worker sweep before the report", () => {
  const roots = {
    resolve: () => taskRoot,
    identityOf: () => liveRootIdentity,
  };

  it("(a) the report reflects the post-sweep result, and the sweep sees the conversation id", async () => {
    const id = "sweep-order";
    await seed(id);
    await appendFact(id, "f-worker", workerFact);
    const seen: string[] = [];

    const swept = await openSessionWithRecovery({
      store,
      conversationId: id,
      roots,
      sweepOwnedWorkers: async (conversationId) => {
        seen.push(conversationId);
        return sweepProving("task-1");
      },
    });
    assert.deepEqual(seen, [id]);
    assert.deepEqual(
      swept.status,
      { status: "recovered" },
      "a report built before the sweep would still report needing handling"
    );
    assert.equal(swept.operationFacts!.workers[0]!.needsHandling, false);
  });

  it('(b) an explicit "nothing to sweep" is the unproven report, not an error', async () => {
    const id = "sweep-absent";
    await seed(id);
    await appendFact(id, "f-worker", workerFact);

    const opened = await openSessionWithRecovery({
      store,
      conversationId: id,
      roots,
      // The field is REQUIRED, so "this host owns no worker" is now an
      // explicit statement rather than an omission that reads, in the report,
      // exactly like a sweep that ran and found nothing.
      sweepOwnedWorkers: async () => NO_WORKERS_TO_SWEEP,
    });
    assert.equal(opened.operationFacts!.workers[0]!.needsHandling, true);
    assert.deepEqual(opened.status, {
      status: "needs handling",
      handling: [],
      workers: ["task-1"],
    });
  });
});

describe("recoverSession keeps nothing-to-reconcile (no checkpoint)", () => {
  it("(a) a session with no published state reports no_published_state even with facts on disk", async () => {
    const id = "no-state-with-facts";
    await store.save({ id, file: sampleFile(id) });
    await store.appendEvents({ id, events: [userMsg("q"), assistantMsg("a")] });
    await appendFact(id, "f-worker", workerFact);

    const report = await recover(id);
    assert.equal(report.status.status, "no_published_state");
    assert.equal(report.runtime, null);
    assert.equal(
      report.operationFacts,
      null,
      "facts have no selected state to account against"
    );
    assert.deepEqual(report.messages, []);
    assert.deepEqual(report.operations, []);
  });
});
