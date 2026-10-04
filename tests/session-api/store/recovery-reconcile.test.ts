/**
 * Per-file reconciliation: the byte-comparison table that decides whether a
 * recorded file effect is VERIFIED, cleanly not-replaced, or needs an
 * operator. Driven through the production entry point so every `file_intent`
 * record and every `code-snapshots/` blob is real.
 *
 * Real temporary store, real workspace files, real blobs. No mock of the
 * store, the codec, or the filesystem.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "vitest";

import {
  captureCodeSnapshot,
  codeSnapshotDir,
  codeSnapshotSha,
} from "../../../src/session-api/store/code-snapshot-store.ts";
import {
  CURRENT_SCHEMA_VERSION,
  NATIVE_STATE_FORMAT_VERSION,
  recoverSession,
  resolveConversationDir,
  resolveProjectSessionDir,
  SessionStore,
  type SessionFileV1,
} from "../../../src/session-api/store/index.ts";
import type {
  FileIntentTarget,
  RecoveredFileOperation,
  SessionFileIntentRecord,
} from "../../../src/session-api/store/index.ts";
import { reduceOperationFacts } from "../../../src/session-api/store/recovery-reconcile.ts";

let baseDir: string;
let taskRoot: string;
let projectDir: string;
let store: SessionStore;
const liveRootIdentity = "/live/main-checkout";

const sessionDirFor = (id: string): string =>
  resolveConversationDir({ projectDir, conversationId: id });

beforeEach(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "iknow-reconcile-"));
  taskRoot = await mkdtemp(join(tmpdir(), "iknow-reconcile-taskroot-"));
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
const toolUseMsg = (id: string, name = "write_file") => ({
  role: "assistant" as const,
  content: [
    { type: "tool_use" as const, id, name, input: { file_path: "a.ts" } },
  ],
});
const toolResultMsg = (id: string, isError = false) => ({
  role: "user" as const,
  content: [
    {
      type: "tool_result" as const,
      tool_use_id: id,
      content: [{ type: "text" as const, text: isError ? "boom" : "ok" }],
      ...(isError ? { is_error: true } : {}),
    },
  ],
});

/** A new-format session with one published state at e1 (user + assistant). */
async function seed(id: string): Promise<void> {
  await store.save({ id, file: sampleFile(id) });
  await store.appendEvents({
    id,
    events: [userMsg("q"), { role: "assistant" as const, content: [] }],
  });
  await store.appendNativeState({
    id,
    anchorEventId: "e1",
    boundary: "tool_batch",
    snapshot: {
      boundary: "tool_batch",
      messages: [userMsg("q")] as never,
    },
  });
}

/** One real captured target: real pre/post blobs in this session's
 *  `code-snapshots/`, real relative path under the live taskRoot. */
async function target(
  id: string,
  over: Partial<FileIntentTarget> = {}
): Promise<FileIntentTarget> {
  const folder = sessionDirFor(id);
  const absentBefore = over.absentBefore === true;
  return {
    relPath: "a.ts",
    rootIdentity: liveRootIdentity,
    absentBefore,
    preimageSha: await captureCodeSnapshot(folder, "OLD"),
    postimageSha: await captureCodeSnapshot(folder, "NEW"),
    ...over,
  };
}

const put = (relPath: string, body: string) =>
  writeFile(join(taskRoot, relPath), body, "utf8");

const recover = (id: string) =>
  recoverSession({ store, conversationId: id, taskRoot, liveRootIdentity });

/** The single operation of a one-intent fixture. */
const onlyOperation = (
  operations: ReadonlyArray<RecoveredFileOperation>
): RecoveredFileOperation => {
  assert.equal(operations.length, 1, "fixture must hold exactly one operation");
  return operations[0]!;
};

const verdictFor = (
  op: RecoveredFileOperation,
  relPath: string
): { state: string; reason?: string } => {
  const t = op.targets.find((x) => x.relPath === relPath);
  assert.ok(t, `no target verdict for ${relPath}`);
  return t.state === "needs_handling"
    ? { state: t.state, reason: t.reason }
    : { state: t.state };
};

describe("reconciliation: bytes match the expected postimage (SC11)", () => {
  it("(a) a target whose bytes equal the postimage is a VERIFIED effect even with no tool result", async () => {
    const id = "verified-no-result";
    await seed(id);
    const t = await target(id);
    await store.appendEvents({ id, events: [toolUseMsg("tu-1")] });
    await store.appendFileIntent({
      id,
      toolUseId: "tu-1",
      captured: true,
      targets: [t],
    });
    await put("a.ts", "NEW");

    const report = await recover(id);
    const op = onlyOperation(report.operations);
    assert.equal(verdictFor(op, "a.ts").state, "verified_effect");
    assert.equal(
      op.settlement,
      "unknown",
      "file agreement never proves whole-tool success"
    );
    assert.equal(op.needsOperatorAction, true);
    assert.equal(
      report.status.status,
      "needs handling",
      "an unknown whole-tool result still needs an operator decision"
    );
  });

  it("(b) with a settled success result the same bytes are still what proves the effect", async () => {
    const id = "verified-with-result";
    await seed(id);
    const t = await target(id);
    await store.appendEvents({
      id,
      events: [toolUseMsg("tu-1"), toolResultMsg("tu-1")],
    });
    await store.appendFileIntent({
      id,
      toolUseId: "tu-1",
      captured: true,
      targets: [t],
    });
    await put("a.ts", "NEW");

    const report = await recover(id);
    const op = onlyOperation(report.operations);
    assert.equal(op.settlement, "settled_success");
    assert.equal(verdictFor(op, "a.ts").state, "verified_effect");
    assert.equal(op.needsOperatorAction, false);
    assert.equal(report.status.status, "recovered");
  });
});

describe("reconciliation: bytes still equal the preimage", () => {
  it("(a) an existing file at its preimage is a clean non-replacement, not a failure", async () => {
    const id = "preimage";
    await seed(id);
    const t = await target(id);
    await store.appendEvents({ id, events: [toolUseMsg("tu-1")] });
    await store.appendFileIntent({
      id,
      toolUseId: "tu-1",
      captured: true,
      targets: [t],
    });
    await put("a.ts", "OLD");

    const report = await recover(id);
    const op = onlyOperation(report.operations);
    assert.equal(verdictFor(op, "a.ts").state, "not_replaced");
    assert.equal(op.settlement, "unknown");
    assert.equal(op.needsOperatorAction, true);
  });

  it("(b) a path that was absent and is still absent is the preimage case, not a verified write", async () => {
    const id = "absent-still-absent";
    await seed(id);
    const t = await target(id, { absentBefore: true });
    await store.appendEvents({ id, events: [toolUseMsg("tu-1")] });
    await store.appendFileIntent({
      id,
      toolUseId: "tu-1",
      captured: true,
      targets: [t],
    });

    const report = await recover(id);
    const op = onlyOperation(report.operations);
    assert.equal(verdictFor(op, "a.ts").state, "not_replaced");
    await assert.rejects(
      readFile(join(taskRoot, "a.ts"), "utf8"),
      "the fixture must leave the created path absent"
    );
  });
});

describe("reconciliation: nothing may be guessed", () => {
  it("(a) bytes matching neither image need handling and stay untouched", async () => {
    const id = "neither";
    await seed(id);
    const t = await target(id);
    await store.appendEvents({ id, events: [toolUseMsg("tu-1")] });
    await store.appendFileIntent({
      id,
      toolUseId: "tu-1",
      captured: true,
      targets: [t],
    });
    await put("a.ts", "DRIFTED BY A HUMAN");

    const report = await recover(id);
    const op = onlyOperation(report.operations);
    assert.deepEqual(verdictFor(op, "a.ts"), {
      state: "needs_handling",
      reason: "bytes_match_neither",
    });
    assert.equal(
      await readFile(join(taskRoot, "a.ts"), "utf8"),
      "DRIFTED BY A HUMAN",
      "the drifted bytes are left exactly as found"
    );
  });

  it("(b) a file that existed before and is now gone is missing, never a delete", async () => {
    const id = "vanished";
    await seed(id);
    const t = await target(id);
    await store.appendEvents({ id, events: [toolUseMsg("tu-1")] });
    await store.appendFileIntent({
      id,
      toolUseId: "tu-1",
      captured: true,
      targets: [t],
    });

    const report = await recover(id);
    const op = onlyOperation(report.operations);
    assert.deepEqual(verdictFor(op, "a.ts"), {
      state: "needs_handling",
      reason: "target_missing",
    });
  });

  it("(c) a captured:false intent is unverified evidence and needs handling", async () => {
    const id = "capture-disabled";
    await seed(id);
    const t = await target(id, { preimageSha: undefined });
    await store.appendEvents({ id, events: [toolUseMsg("tu-1")] });
    await store.appendFileIntent({
      id,
      toolUseId: "tu-1",
      captured: false,
      targets: [t],
    });
    await put("a.ts", "NEW");

    const report = await recover(id);
    const op = onlyOperation(report.operations);
    assert.deepEqual(verdictFor(op, "a.ts"), {
      state: "needs_handling",
      reason: "capture_disabled",
    });
    assert.equal(
      report.status.status === "needs handling" &&
        report.status.handling[0]?.toolUseId,
      "tu-1"
    );
  });

  it("(d) a captured:false intent never claims a verified effect even if bytes match", async () => {
    const id = "capture-disabled-match";
    await seed(id);
    const t = await target(id, { preimageSha: undefined });
    await store.appendEvents({
      id,
      events: [toolUseMsg("tu-1"), toolResultMsg("tu-1")],
    });
    await store.appendFileIntent({
      id,
      toolUseId: "tu-1",
      captured: false,
      targets: [t],
    });
    await put("a.ts", "NEW");

    const report = await recover(id);
    const op = onlyOperation(report.operations);
    assert.equal(op.settlement, "settled_success");
    assert.equal(verdictFor(op, "a.ts").state, "needs_handling");
  });

  it("(e) a root identity mismatch is reported and performs no write", async () => {
    const id = "root-mismatch";
    await seed(id);
    const t = await target(id, { rootIdentity: "/some/other/checkout" });
    await store.appendEvents({ id, events: [toolUseMsg("tu-1")] });
    await store.appendFileIntent({
      id,
      toolUseId: "tu-1",
      captured: true,
      targets: [t],
    });
    await put("a.ts", "NEW");

    const report = await recover(id);
    const op = onlyOperation(report.operations);
    assert.deepEqual(verdictFor(op, "a.ts"), {
      state: "needs_handling",
      reason: "root_identity_mismatch",
    });
    assert.equal(await readFile(join(taskRoot, "a.ts"), "utf8"), "NEW");
  });

  it("(f) a required body that cannot be read is never guessed around", async () => {
    const id = "body-gone";
    await seed(id);
    const t = await target(id);
    await store.appendEvents({ id, events: [toolUseMsg("tu-1")] });
    await store.appendFileIntent({
      id,
      toolUseId: "tu-1",
      captured: true,
      targets: [t],
    });
    // remove only the preimage blob; the recorded postimage still resolves
    await rm(
      join(sessionDirFor(id), "code-snapshots", t.preimageSha as string)
    );
    await put("a.ts", "OLD");

    const report = await recover(id);
    const op = onlyOperation(report.operations);
    assert.deepEqual(verdictFor(op, "a.ts"), {
      state: "needs_handling",
      reason: "body_missing",
    });
  });
});

describe("reconciliation: a partially completed multi-file call (SC10)", () => {
  it("(a) keeps the published file, reports the other, and rolls back neither", async () => {
    const id = "partial";
    await seed(id);
    const a = await target(id, { relPath: "a.ts" });
    const b = await target(id, { relPath: "b.ts" });
    await store.appendEvents({ id, events: [toolUseMsg("tu-1")] });
    await store.appendFileIntent({
      id,
      toolUseId: "tu-1",
      captured: true,
      targets: [a, b],
    });
    await mkdir(taskRoot, { recursive: true });
    await put("a.ts", "NEW");
    await put("b.ts", "HALF WRITTEN");

    const report = await recover(id);
    const op = onlyOperation(report.operations);
    assert.equal(verdictFor(op, "a.ts").state, "verified_effect");
    assert.equal(verdictFor(op, "b.ts").reason, "bytes_match_neither");
    assert.equal(await readFile(join(taskRoot, "a.ts"), "utf8"), "NEW");
    assert.equal(
      await readFile(join(taskRoot, "b.ts"), "utf8"),
      "HALF WRITTEN"
    );
  });

  it("(b) one operation per toolUseId: repeated records for the same call are grouped", async () => {
    const id = "grouped";
    await seed(id);
    const a = await target(id, { relPath: "a.ts" });
    const b = await target(id, { relPath: "b.ts" });
    await store.appendEvents({ id, events: [toolUseMsg("tu-1")] });
    await store.appendFileIntent({
      id,
      toolUseId: "tu-1",
      captured: true,
      targets: [a],
    });
    await store.appendFileIntent({
      id,
      toolUseId: "tu-1",
      captured: true,
      targets: [b],
    });
    await put("a.ts", "NEW");
    await put("b.ts", "NEW");

    const report = await recover(id);
    assert.equal(report.operations.length, 1);
    const op = onlyOperation(report.operations);
    assert.deepEqual(
      op.targets.map((t) => t.relPath),
      ["a.ts", "b.ts"]
    );
  });
});

describe("reconciliation: settlement posture (SC12)", () => {
  it("(a) a settled error result stays a settled error, not an unknown", async () => {
    const id = "settled-error";
    await seed(id);
    const t = await target(id);
    await store.appendEvents({
      id,
      events: [toolUseMsg("tu-1"), toolResultMsg("tu-1", true)],
    });
    await store.appendFileIntent({
      id,
      toolUseId: "tu-1",
      captured: true,
      targets: [t],
    });
    await put("a.ts", "OLD");

    const report = await recover(id);
    const op = onlyOperation(report.operations);
    assert.equal(op.settlement, "settled_error");
    assert.equal(
      verdictFor(op, "a.ts").state,
      "not_replaced",
      "an error result is not a verified write"
    );
    assert.equal(
      op.needsOperatorAction,
      false,
      "a settled error with no replacement is not outstanding"
    );
  });

  it("(b) a settled success result does not verify drifted bytes", async () => {
    const id = "success-drift";
    await seed(id);
    const t = await target(id);
    await store.appendEvents({
      id,
      events: [toolUseMsg("tu-1"), toolResultMsg("tu-1")],
    });
    await store.appendFileIntent({
      id,
      toolUseId: "tu-1",
      captured: true,
      targets: [t],
    });
    await put("a.ts", "LATER DRIFT");

    const report = await recover(id);
    const op = onlyOperation(report.operations);
    assert.equal(op.settlement, "settled_success");
    assert.equal(verdictFor(op, "a.ts").reason, "bytes_match_neither");
  });

  it("(c) an out-of-order settled result does not disturb protocol order in the restored context", async () => {
    const id = "out-of-order";
    await seed(id);
    const first = await target(id, { relPath: "a.ts" });
    const second = await target(id, { relPath: "b.ts" });
    await store.appendEvents({
      id,
      events: [toolUseMsg("tu-1"), toolUseMsg("tu-2")],
    });
    await store.appendFileIntent({
      id,
      toolUseId: "tu-1",
      captured: true,
      targets: [first],
    });
    await store.appendFileIntent({
      id,
      toolUseId: "tu-2",
      captured: true,
      targets: [second],
    });
    // tu-2 settles FIRST while tu-1 is still blocked: the second result is on
    // the chain, the first never is.
    await store.appendEvents({ id, events: [toolResultMsg("tu-2")] });
    await put("b.ts", "NEW");
    await put("a.ts", "NEW");

    const report = await recover(id);
    const byId = new Map(report.operations.map((o) => [o.toolUseId, o]));
    assert.equal(byId.get("tu-1")?.settlement, "unknown");
    assert.equal(byId.get("tu-2")?.settlement, "settled_success");
    assert.equal(
      verdictFor(byId.get("tu-1")!, "a.ts").state,
      "verified_effect"
    );
    assert.equal(report.messages.length, 1, "restored context is unaffected");
  });
});

describe("reconciliation: chronology this store may not invent", () => {
  it("(a) two writers of one path at the same chain position are ambiguous", async () => {
    const id = "ambiguous";
    await seed(id);
    const a = await target(id, { relPath: "a.ts" });
    const b = await target(id, { relPath: "a.ts" });
    await store.appendEvents({
      id,
      events: [toolUseMsg("tu-1"), toolUseMsg("tu-2")],
    });
    // both intents anchor at the SAME head: the chain cannot order them
    await store.appendFileIntent({
      id,
      toolUseId: "tu-1",
      captured: true,
      targets: [a],
    });
    await store.appendFileIntent({
      id,
      toolUseId: "tu-2",
      captured: true,
      targets: [b],
    });
    await put("a.ts", "NEW");

    const report = await recover(id);
    assert.equal(report.status.status, "needs handling");
    for (const op of report.operations) {
      assert.equal(verdictFor(op, "a.ts").reason, "ambiguous_ordering");
    }
  });

  it("(b) an intent whose writer is not on the selected chain is not attributable", async () => {
    const id = "off-chain-writer";
    await seed(id);
    // move the head past the saved anchor so the intent is post-anchor
    await store.appendEvents({ id, events: [userMsg("later")] });
    const t = await target(id);
    // A production writer records this faithfully; the tool_use it names lives
    // in another transcript (a worker), so the parent chain cannot own it.
    await store.appendFileIntent({
      id,
      toolUseId: "tu-worker-only",
      captured: true,
      targets: [t],
    });
    await put("a.ts", "NEW");

    const report = await recover(id);
    const op = onlyOperation(report.operations);
    assert.deepEqual(verdictFor(op, "a.ts"), {
      state: "needs_handling",
      reason: "writer_not_on_chain",
    });
  });
});

describe("reconciliation scope", () => {
  it("(a) intents at or before the saved anchor are not re-reported", async () => {
    const id = "pre-anchor";
    await store.save({ id, file: sampleFile(id) });
    await store.appendEvents({ id, events: [userMsg("q")] });
    // intent anchored at the head, i.e. the state anchor itself
    const early = await target(id, { relPath: "early.ts" });
    await store.appendFileIntent({
      id,
      toolUseId: "tu-early",
      captured: true,
      targets: [early],
    });
    await store.appendNativeState({
      id,
      anchorEventId: "e0",
      boundary: "input",
      snapshot: { boundary: "input", messages: [userMsg("q")] as never },
    });
    await put("early.ts", "NOT THE POSTIMAGE");

    const report = await recover(id);
    assert.equal(report.operations.length, 0);
    assert.equal(report.status.status, "recovered");
  });
});

describe("reconcileFileIntents direct contract", () => {
  it("(a) an empty intent list is an empty report, not a failure", async () => {
    const { reconcileFileIntents } =
      await import("../../../src/session-api/store/recovery-reconcile.ts");
    const result = await reconcileFileIntents({
      sessionFolder: sessionDirFor("empty"),
      taskRoot,
      liveRootIdentity,
      intents: [],
      settlements: new Map(),
      onChainToolUseIds: new Set(),
    });
    assert.deepEqual(result.operations, []);
    assert.deepEqual(result.handling, []);
  });

  it("(b) a target whose relPath escapes the live root is not read at all", async () => {
    const { reconcileFileIntents } =
      await import("../../../src/session-api/store/recovery-reconcile.ts");
    const outside = join(taskRoot, "..", "outside.txt");
    await writeFile(outside, "SECRET", "utf8");
    const record: SessionFileIntentRecord = {
      type: "file_intent",
      toolUseId: "tu-escape",
      anchorEventId: "e0",
      captured: true,
      createdAt: new Date().toISOString(),
      targets: [
        {
          relPath: "../outside.txt",
          rootIdentity: liveRootIdentity,
          absentBefore: false,
          preimageSha: codeSnapshotSha("SECRET"),
          postimageSha: codeSnapshotSha("SECRET"),
        },
      ],
    };
    const result = await reconcileFileIntents({
      sessionFolder: sessionDirFor("escape"),
      taskRoot,
      liveRootIdentity,
      intents: [{ record, anchorIndex: 1 }],
      settlements: new Map(),
      onChainToolUseIds: new Set(["tu-escape"]),
    });
    assert.deepEqual(result.handling[0]?.reason, "unresolvable_path");
    assert.equal(await readFile(outside, "utf8"), "SECRET");
  });

  it("(c) a real read fault on a recorded body is not reported as missing evidence", async () => {
    const { reconcileFileIntents } =
      await import("../../../src/session-api/store/recovery-reconcile.ts");
    const id = "blob-io-fault";
    await seed(id);
    const t = await target(id);
    // Real fault: the preimage blob's own path is a directory, so reading it
    // fails with EISDIR. An absent blob is evidence that was never written;
    // an unreadable one is an IO fault, and the two must not read alike.
    const preimage = join(codeSnapshotDir(sessionDirFor(id)), t.preimageSha!);
    await rm(preimage, { force: true });
    await mkdir(preimage);

    const record: SessionFileIntentRecord = {
      type: "file_intent",
      toolUseId: "tu-io",
      anchorEventId: "e1",
      captured: true,
      createdAt: new Date().toISOString(),
      targets: [t],
    };
    await assert.rejects(
      reconcileFileIntents({
        sessionFolder: sessionDirFor(id),
        taskRoot,
        liveRootIdentity,
        intents: [{ record, anchorIndex: 2 }],
        settlements: new Map(),
        onChainToolUseIds: new Set(["tu-io"]),
      }),
      (err: unknown) => {
        assert.equal((err as NodeJS.ErrnoException).code, "EISDIR");
        return true;
      }
    );
  });
});

/* -- operation-fact reduction, as a pure function -------------------------- */

/** A record as the log holds it: the payload is what a sink appended, and
 *  `baseBodySha` names the state it was appended after. */
const factRecord = (
  factId: string,
  baseBodySha: string | null,
  fact: NonNullable<
    Parameters<typeof reduceOperationFacts>[0]["facts"][number]
  >["fact"]
): NonNullable<
  Parameters<typeof reduceOperationFacts>[0]["facts"][number]
> => ({
  type: "operation_fact",
  factId,
  anchorEventId: "e1",
  baseBodySha,
  fact,
  createdAt: "2026-10-03T00:00:00.000Z",
});

describe("reduceOperationFacts", () => {
  it("(a) folds only facts anchored to the selected body, and lists the rest unanchored", () => {
    const graphDone = {
      kind: "graph_node",
      nodeId: "n",
      status: "done",
    } as const;
    const reduced = reduceOperationFacts({
      facts: [
        factRecord("f-1", "sha-selected", graphDone),
        factRecord("f-2", null, graphDone),
        factRecord("f-3", "sha-other", graphDone),
      ],
      selectedBodySha: "sha-selected",
    });
    assert.deepEqual(reduced.graphNodes, [
      {
        factId: "f-1",
        nodeId: "n",
        state: "settled",
        status: "done",
        transitions: 1,
      },
    ]);
    assert.deepEqual(reduced.unanchored, [
      {
        factId: "f-2",
        kind: "graph_node",
        reason: "no_base_state",
        baseBodySha: null,
      },
      {
        factId: "f-3",
        kind: "graph_node",
        reason: "base_state_not_selected",
        baseBodySha: "sha-other",
      },
    ]);
  });

  it("(b) is idempotent: the same log reduces to the same report, and a repeated factId counts once", () => {
    const fact = {
      kind: "graph_node",
      nodeId: "n",
      status: "running",
    } as const;
    const input = {
      facts: [factRecord("f-1", "sha", fact), factRecord("f-1", "sha", fact)],
      selectedBodySha: "sha",
    } as const;
    const once = reduceOperationFacts(input);
    const twice = reduceOperationFacts(input);
    assert.deepEqual(twice, once);
    assert.equal(once.graphNodes.length, 1);
    assert.deepEqual(once.duplicateFactIds, ["f-1"]);
  });

  it("(b2) one entry per nodeId: several transitions reduce to the last one, with the count", () => {
    const reduced = reduceOperationFacts({
      facts: [
        factRecord("f-1", "sha", {
          kind: "graph_node",
          nodeId: "n",
          status: "running",
        }),
        factRecord("f-2", "sha", {
          kind: "graph_node",
          nodeId: "n",
          status: "done",
          output: "42",
        }),
        factRecord("f-3", "sha", {
          kind: "graph_node",
          nodeId: "other",
          status: "failed",
          error: "boom",
        }),
        // re-entered, interrupted again: the LAST transition is the verdict
        factRecord("f-4", "sha", {
          kind: "graph_node",
          nodeId: "n",
          status: "running",
        }),
      ],
      selectedBodySha: "sha",
    });
    assert.deepEqual(reduced.graphNodes, [
      {
        factId: "f-4",
        nodeId: "n",
        state: "in_flight",
        outcome: "unknown",
        transitions: 3,
      },
      {
        factId: "f-3",
        nodeId: "other",
        state: "settled",
        status: "failed",
        error: "boom",
        transitions: 1,
      },
    ]);
  });

  it("(b3) the per-node reduction is idempotent", () => {
    const input = {
      facts: [
        factRecord("f-1", "sha", {
          kind: "graph_node",
          nodeId: "n",
          status: "running",
        }),
        factRecord("f-2", "sha", {
          kind: "graph_node",
          nodeId: "n",
          status: "done",
          output: "42",
        }),
      ],
      selectedBodySha: "sha",
    } as const;
    const once = reduceOperationFacts(input);
    assert.deepEqual(reduceOperationFacts(input), once);
    assert.deepEqual(once.graphNodes, [
      {
        factId: "f-2",
        nodeId: "n",
        state: "settled",
        status: "done",
        output: "42",
        transitions: 2,
      },
    ]);
  });

  it("(c) rejects a fact payload carrying process-memory material instead of folding it", () => {
    const poisoned = {
      kind: "worker_progress",
      taskId: "t",
      ownership: "foreground",
      state: "running",
      permissionGrant: "always-allow",
    } as const;
    const reduced = reduceOperationFacts({
      facts: [factRecord("f-bad", "sha", poisoned)],
      selectedBodySha: "sha",
    });
    assert.deepEqual(reduced.workers, []);
    assert.deepEqual(reduced.rejected, [
      { factId: "f-bad", kind: "worker_progress", field: "permissionGrant" },
    ]);
  });

  it("(d) a post-sweep verdict supplies the stop proof a bare record cannot", () => {
    const fact = {
      kind: "worker_progress",
      taskId: "t",
      ownership: "background",
      state: "running",
      process: { pid: 7, startTime: 1 },
    } as const;
    const records = [factRecord("f-w", "sha", fact)];
    const bare = reduceOperationFacts({
      facts: records,
      selectedBodySha: "sha",
    });
    assert.equal(bare.workers[0]?.needsHandling, true);
    assert.equal(bare.workers[0]?.stopEvidence, null);

    const swept = reduceOperationFacts({
      facts: records,
      selectedBodySha: "sha",
      workerSweep: {
        workers: [
          {
            taskId: "t",
            ownership: "background",
            pid: 7,
            state: "confirmed_stopped",
            signalled: true,
            detail: "gone",
            cleanup: { state: "confirmed_stopped", pid: 7 },
          },
        ],
        unreadable: [],
        unrecorded: [],
        excluded: [],
      },
    });
    assert.equal(swept.workers[0]?.needsHandling, false);
    assert.deepEqual(swept.workers[0]?.stopEvidence, {
      state: "confirmed_stopped",
      pid: 7,
    });
  });
});
