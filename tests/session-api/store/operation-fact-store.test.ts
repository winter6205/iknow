/**
 * The `operation_fact` record at the STORE level (ADR-0136 / F2): one appended
 * fact is one record, the anchor and base are derived from the log rather than
 * the caller, a repeated factId is deduped, arrival order survives a later
 * publication, and the record is neither projected into the session file nor
 * selectable as a checkpoint.
 *
 * Real temporary store, real filesystem; every assertion re-reads a NEWLY
 * CONSTRUCTED store.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "vitest";

import {
  CURRENT_SCHEMA_VERSION,
  parseSessionJsonl,
  resolveConversationDir,
  SessionStore,
  type AppendOperationFactInput,
  type SessionFileV1,
  type SessionNativeStateRecord,
  type SessionOperationFactRecord,
} from "../../../src/session-api/store/index.ts";
import type { NativeStateMessage } from "../../../src/shared/native-state-port.ts";
import type { SessionStoreError } from "../../../src/session-api/store/errors.ts";

let baseDir: string;
let store: SessionStore;

beforeEach(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "iknow-fact-store-"));
  store = new SessionStore(baseDir, process.cwd());
});

afterEach(async () => {
  await rm(baseDir, { recursive: true, force: true });
});

const sessionDirFor = (id: string): string =>
  resolveConversationDir({
    projectDir: store.getProjectDir(),
    conversationId: id,
  });

const jsonlFor = (id: string): string => join(sessionDirFor(id), `${id}.jsonl`);

const sampleFile = (id: string): SessionFileV1 => ({
  schemaVersion: CURRENT_SCHEMA_VERSION,
  conversation_id: id,
  title: "",
  cwd: "/tmp/test",
  sanitized_at: new Date().toISOString(),
  messages: [],
  jsonMode: false,
  turnCount: 0,
  updatedAt: new Date().toISOString(),
  checkpoints: [],
});

async function seedChain(id: string): Promise<string> {
  await store.save({ id, file: sampleFile(id) });
  await store.appendEvents({
    id,
    events: [{ role: "user", content: [{ type: "text", text: "go" }] }],
  });
  const head = parseSessionJsonl(await readFile(jsonlFor(id), "utf8")).head;
  assert.ok(head !== null, "fixture must have a persisted head");
  return head;
}

const toolResultMessage = (text: string): NativeStateMessage => ({
  role: "user",
  content: [
    {
      type: "tool_result",
      tool_use_id: "tu-1",
      content: [{ type: "text", text }],
    },
  ],
});

const toolFactInput = (
  factId: string,
  toolUseId: string
): AppendOperationFactInput => ({
  id: "",
  factId,
  fact: {
    kind: "tool_result",
    toolUseId,
    batchPosition: 0,
    batchSize: 2,
    resultMessage: toolResultMessage(`result of ${toolUseId}`),
  },
  turnId: "t-1",
});

const factRecords = async (
  id: string
): Promise<ReadonlyArray<SessionOperationFactRecord>> =>
  parseSessionJsonl(await readFile(jsonlFor(id), "utf8")).records.filter(
    (rec): rec is SessionOperationFactRecord => rec.type === "operation_fact"
  );

const nativeStateRecords = async (
  id: string
): Promise<ReadonlyArray<SessionNativeStateRecord>> =>
  parseSessionJsonl(await readFile(jsonlFor(id), "utf8")).records.filter(
    (rec): rec is SessionNativeStateRecord => rec.type === "native_state"
  );

describe("SessionStore.appendOperationFact — one fact, one record", () => {
  it("(a) an append lands exactly one record carrying the derived anchor and base", async () => {
    const id = "one-fact";
    const head = await seedChain(id);
    await store.appendNativeState({
      id,
      anchorEventId: head,
      boundary: "input",
      snapshot: {
        boundary: "input",
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      },
    });
    const base = (await nativeStateRecords(id))[0]!.bodySha;

    await store.appendOperationFact({ ...toolFactInput("f-1", "tu-1"), id });

    const records = await factRecords(id);
    assert.equal(records.length, 1);
    assert.equal(records[0]!.factId, "f-1");
    assert.equal(records[0]!.anchorEventId, head);
    assert.equal(records[0]!.baseBodySha, base);
    assert.equal(records[0]!.turnId, "t-1");
    assert.equal(records[0]!.fact.kind, "tool_result");
    assert.ok(
      !("turnId" in records[0]!.fact),
      "the record's turn is the record's field, not a copy inside the fact"
    );
  });

  it("(b) the input carries no anchor or base: the store resolves both from the log", async () => {
    const id = "derived";
    await seedChain(id);
    const input = toolFactInput("f-1", "tu-1");
    assert.ok(
      !("anchorEventId" in input) && !("baseBodySha" in input),
      "a caller-supplied anchor would be a second authority over the chain"
    );
    await store.appendOperationFact({ ...input, id });
    const [record] = await factRecords(id);
    assert.equal(
      record?.baseBodySha,
      null,
      "no publication yet → null, not a guess"
    );
  });

  it("(c) a repeated factId is deduped, not double-appended", async () => {
    const id = "dedup";
    await seedChain(id);
    const input = { ...toolFactInput("f-1", "tu-1"), id };
    await store.appendOperationFact(input);
    await store.appendOperationFact(input);
    await store.appendOperationFact(input);
    assert.equal((await factRecords(id)).length, 1);
  });

  it("(c2) two transitions of one worker to the same state are two records", async () => {
    // The store's dedupe is by id and nothing else, so a second REAL transition
    // survives exactly when its id differs — which is the host adapter's job to
    // get right. Here the store half: distinct ids, same (entity, state), both
    // land and the last one is what a reader sees as current.
    const id = "worker-repeat-state";
    await seedChain(id);
    const workerFact = (
      state: "running" | "completed",
      process: { pid: number; startTime: number }
    ) => ({
      kind: "worker_progress" as const,
      taskId: "task-9",
      ownership: "background" as const,
      state,
      process,
    });
    await store.appendOperationFact({
      id,
      factId: "w-1",
      fact: workerFact("running", { pid: 100, startTime: 5 }),
    });
    await store.appendOperationFact({
      id,
      factId: "w-1",
      fact: workerFact("running", { pid: 100, startTime: 5 }),
    });
    await store.appendOperationFact({
      id,
      factId: "w-2",
      fact: workerFact("running", { pid: 200, startTime: 9 }),
    });

    const records = await factRecords(id);
    assert.equal(
      records.length,
      2,
      "the repeat of one event dedupes, the new one lands"
    );
    assert.equal(records.at(-1)!.factId, "w-2");
  });

  it("(d) two facts of one turn are two records (the turn is not the fact identity)", async () => {
    const id = "two-calls";
    await seedChain(id);
    await store.appendOperationFact({ ...toolFactInput("f-1", "tu-1"), id });
    await store.appendOperationFact({ ...toolFactInput("f-2", "tu-2"), id });
    const records = await factRecords(id);
    assert.equal(records.length, 2);
    assert.deepEqual(
      records.map((rec) =>
        rec.fact.kind === "tool_result" ? rec.fact.toolUseId : ""
      ),
      ["tu-1", "tu-2"]
    );
  });

  it("(e) arrival order is preserved across an interleaved publication", async () => {
    const id = "order";
    const head = await seedChain(id);
    await store.appendOperationFact({ ...toolFactInput("f-1", "tu-1"), id });
    await store.appendOperationFact({ ...toolFactInput("f-2", "tu-2"), id });
    await store.appendNativeState({
      id,
      anchorEventId: head,
      boundary: "tool_batch",
      snapshot: {
        boundary: "tool_batch",
        messages: [
          { role: "user", content: [{ type: "text", text: "after" }] },
        ],
      },
    });
    await store.appendOperationFact({ ...toolFactInput("f-3", "tu-3"), id });

    const raw = await readFile(jsonlFor(id), "utf8");
    assert.ok(
      raw.indexOf("f-1") < raw.indexOf("f-2") &&
        raw.indexOf("f-2") < raw.indexOf("f-3"),
      "the append position is the load-bearing order"
    );
    const records = await factRecords(id);
    assert.equal(
      records[2]!.baseBodySha,
      (await nativeStateRecords(id))[0]!.bodySha
    );
  });

  it("(f) all three fact variants persist", async () => {
    const id = "variants";
    await seedChain(id);
    await store.appendOperationFact({
      id,
      factId: "v-1",
      fact: {
        kind: "graph_node",
        nodeId: "n1",
        status: "done",
        output: "42",
      },
    });
    await store.appendOperationFact({
      id,
      factId: "v-2",
      fact: {
        kind: "worker_progress",
        taskId: "w1",
        ownership: "background",
        state: "needs_handling",
        process: { pid: 99, startTime: null },
        transcriptPath: "/tmp/w1.jsonl",
        toolUseId: "tu-spawn",
      },
    });
    await store.appendOperationFact({ ...toolFactInput("v-3", "tu-3"), id });

    const records = await factRecords(id);
    assert.deepEqual(
      records.map((rec) => rec.fact.kind),
      ["graph_node", "worker_progress", "tool_result"]
    );
    const worker = records[1]!;
    assert.equal(worker.fact.kind, "worker_progress");
    if (worker.fact.kind === "worker_progress") {
      assert.equal(worker.fact.state, "needs_handling");
      assert.equal(worker.fact.process?.startTime, null);
    }
  });

  it("(g) a tool_result fact carries its per-file associations", async () => {
    const id = "files";
    await seedChain(id);
    await store.appendOperationFact({
      id,
      factId: "f-files",
      fact: {
        kind: "tool_result",
        toolUseId: "tu-write",
        batchPosition: 0,
        batchSize: 1,
        resultMessage: toolResultMessage("written"),
        files: [
          {
            relPath: "a.ts",
            rootIdentity: "/root",
            absentBefore: false,
            preimageSha: "a".repeat(64),
            postimageSha: "b".repeat(64),
            published: true,
          },
        ],
      },
    });
    const [record] = await factRecords(id);
    assert.equal(record?.fact.kind, "tool_result");
    if (record?.fact.kind === "tool_result") {
      assert.equal(record.fact.files?.[0]?.relPath, "a.ts");
      assert.equal(record.fact.files?.[0]?.published, true);
    }
  });
});

describe("SessionStore.appendOperationFact — typed rejections", () => {
  const storeError = async (
    id: string,
    input: AppendOperationFactInput
  ): Promise<SessionStoreError> => {
    try {
      await store.appendOperationFact({ ...input, id });
    } catch (err) {
      return err as SessionStoreError;
    }
    throw new Error("expected the append to be rejected");
  };

  it("(a) a session with no persisted head has no anchor to append after", async () => {
    const id = "no-head";
    await store.save({ id, file: sampleFile(id) });
    const err = await storeError(id, toolFactInput("f-1", "tu-1"));
    assert.equal(err.kind, "schema_invalid");
    assert.equal(
      (err as { field?: string }).field,
      "anchorEventId",
      "never a synthetic anchor"
    );
  });

  it("(b) an empty factId is a pre-write rejection", async () => {
    const id = "empty-fact-id";
    await seedChain(id);
    const before = await readFile(jsonlFor(id), "utf8");
    const err = await storeError(id, toolFactInput("", "tu-1"));
    assert.equal(err.kind, "schema_invalid");
    assert.equal((err as { field?: string }).field, "factId");
    assert.equal(await readFile(jsonlFor(id), "utf8"), before);
  });

  it("(c) an unknown fact kind is rejected before any append", async () => {
    const id = "unknown-kind";
    await seedChain(id);
    const before = await readFile(jsonlFor(id), "utf8");
    const err = await storeError(id, {
      id,
      factId: "f-1",
      fact: { kind: "not_a_kind" } as never,
    });
    assert.equal(err.kind, "schema_invalid");
    assert.equal((err as { field?: string }).field, "fact");
    assert.equal(await readFile(jsonlFor(id), "utf8"), before);
  });

  it("(d) a state this code does not produce is rejected (a union member must be listed)", async () => {
    const id = "unknown-status";
    await seedChain(id);
    const err = await storeError(id, {
      id,
      factId: "f-1",
      fact: {
        kind: "graph_node",
        nodeId: "n1",
        status: "not_a_status",
      } as never,
    });
    assert.equal((err as { field?: string }).field, "fact");
  });

  it("(e) an unknown session is not_found, not a silent append", async () => {
    const err = await storeError(
      "no-such-session",
      toolFactInput("f-1", "tu-1")
    );
    assert.equal(err.kind, "not_found");
  });
});

describe("SessionStore.appendOperationFact — the record is never a checkpoint", () => {
  it("(a) a fact is absent from the session file projection", async () => {
    const id = "offchain";
    await seedChain(id);
    await store.appendOperationFact({ ...toolFactInput("f-1", "tu-1"), id });

    const reopened = new SessionStore(baseDir, process.cwd());
    const projection = JSON.stringify(await reopened.load(id));
    assert.ok(!projection.includes("operation_fact"));
    assert.ok(!projection.includes("tu-1"));
    assert.ok(!projection.includes("f-1"));
  });

  it("(b) a fact is not selected as a published state, and carries no checkpoint marker", async () => {
    const id = "not-a-checkpoint";
    const head = await seedChain(id);
    await store.appendOperationFact({ ...toolFactInput("f-1", "tu-1"), id });

    const reopened = new SessionStore(baseDir, process.cwd());
    const selection = await reopened.loadPublishedNativeState({ id });
    assert.equal(selection.selected, null, "a fact publishes no state");
    assert.equal(selection.anchorIndex, -1);
    assert.equal(selection.fileIntents.length, 0);

    // Publishing a real state afterwards must select THAT one, not the fact.
    await reopened.appendNativeState({
      id,
      anchorEventId: head,
      boundary: "input",
      snapshot: {
        boundary: "input",
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      },
    });
    const after = await reopened.loadPublishedNativeState({ id });
    assert.equal(after.selected?.boundary, "input");
    assert.equal(
      (await factRecords(id)).length,
      1,
      "publishing a state never rewrites or drops a fact"
    );
  });

  it("(c) a fact survives every later save (append-only, never rewritten)", async () => {
    const id = "append-only";
    await seedChain(id);
    await store.appendOperationFact({ ...toolFactInput("f-1", "tu-1"), id });
    const firstRecord = (await factRecords(id))[0];

    await store.save({
      id,
      file: {
        ...sampleFile(id),
        messages: [
          { role: "user", content: [{ type: "text", text: "go" }] },
          { role: "assistant", content: [{ type: "text", text: "ok" }] },
        ],
      },
    });

    const after = (await factRecords(id))[0];
    assert.deepEqual(after, firstRecord, "the fact line is byte-identical");
  });

  it("(d) a hand-written valid fact line reads back as a record with an empty fact set", async () => {
    const id = "hand-written";
    const head = await seedChain(id);
    const line = JSON.stringify({
      type: "operation_fact",
      factId: "f-1",
      anchorEventId: head,
      baseBodySha: null,
      turnId: "t-1",
      createdAt: new Date().toISOString(),
      fact: {
        kind: "graph_node",
        nodeId: "n1",
        status: "skipped",
      },
    });
    await store.save({ id, file: sampleFile(id) });
    await writeFile(
      jsonlFor(id),
      `${await readFile(jsonlFor(id), "utf8")}${line}\n`,
      "utf8"
    );

    const log = parseSessionJsonl(await readFile(jsonlFor(id), "utf8"));
    const fact = log.records.find(
      (rec): rec is SessionOperationFactRecord => rec.type === "operation_fact"
    );
    assert.equal(fact?.factId, "f-1");
    assert.equal(fact?.anchorEventId, head);
    assert.equal(
      log.maxEventIndex,
      0,
      "an off-chain record never moves the message chain"
    );
  });
});
