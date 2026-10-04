/**
 * `RuntimePersistenceBinder` host adapter — the F1 join between the harness's
 * runtime persistence requests and the session store's ADR-0136 records.
 *
 * Real temporary store, real filesystem. Every write is re-read through a
 * NEWLY CONSTRUCTED store, so a passing case proves the bytes are durable
 * rather than merely in memory. No stubbed store errors: the write-failure
 * cases make a real append fail.
 */
import assert from "node:assert/strict";
import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "vitest";

import { createRuntimePersistenceBinder } from "../../../src/session-api/store/runtime-persistence-host.ts";
import type { RuntimePersistenceHostDeps } from "../../../src/session-api/store/runtime-persistence-host.ts";
import {
  CURRENT_SCHEMA_VERSION,
  parseSessionJsonl,
  resolveConversationDir,
  SessionStore,
  type SessionFileV1,
  type SessionNativeStateRecord,
  type SessionOperationFactRecord,
  type SessionTailRecord,
} from "../../../src/session-api/store/index.ts";
import {
  isNativeStatePortError,
  type NativeStateMessage,
  type NativeStatePortErrorCode,
} from "../../../src/shared/native-state-port.ts";
import type {
  RuntimeSavedStateBoundary,
  RuntimeSavedStateRequest,
} from "../../../src/shared/runtime-persistence.ts";
import { toNativeStateBoundary } from "../../../src/shared/native-state-port.ts";

let baseDir: string;
let store: SessionStore;

beforeEach(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "iknow-rp-host-"));
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

/** A session with one committed user event, so it has a persisted head. */
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

const message = (text: string): NativeStateMessage => ({
  role: "user",
  content: [{ type: "text", text }],
});

const request = (
  boundary: RuntimeSavedStateBoundary,
  over: Partial<RuntimeSavedStateRequest<NativeStateMessage>> = {}
): RuntimeSavedStateRequest<NativeStateMessage> => ({
  boundary,
  turnId: "t-1",
  messages: [message("hello")],
  ...over,
});

/**
 * A re-entrant `serialize` double: run inline when the queue slot is already
 * held, serialize through a promise chain otherwise. This is the rule the hub
 * queue must follow, and it is what makes "a publication issued from inside a
 * turn" resolvable instead of a deadlock. `maxDepth` is asserted so a case can
 * prove the binder never asks for a second slot.
 */
function reentrantSerialize(): {
  readonly serialize: RuntimePersistenceHostDeps["serialize"];
  readonly maxDepth: () => number;
} {
  let depth = 0;
  let highest = 0;
  let tail: Promise<unknown> = Promise.resolve();
  const serialize = <T>(
    _conversationId: string,
    work: () => Promise<T>
  ): Promise<T> => {
    if (depth > 0) return work();
    depth++;
    highest = Math.max(highest, depth);
    const run = tail.then(work);
    tail = run.then(
      () => {
        depth--;
      },
      () => {
        depth--;
      }
    );
    return run;
  };
  return { serialize, maxDepth: () => highest };
}

function binderWith(overrides: Partial<RuntimePersistenceHostDeps> = {}): {
  readonly binder: ReturnType<typeof createRuntimePersistenceBinder>;
  readonly queue: ReturnType<typeof reentrantSerialize>;
} {
  const queue = reentrantSerialize();
  const binder = createRuntimePersistenceBinder({
    store,
    serialize: queue.serialize,
    shouldPublish: () => true,
    ...overrides,
  });
  return { binder, queue };
}

async function tailRecords(
  id: string
): Promise<ReadonlyArray<SessionTailRecord>> {
  return parseSessionJsonl(await readFile(jsonlFor(id), "utf8")).records;
}

const nativeStates = async (
  id: string
): Promise<ReadonlyArray<SessionNativeStateRecord>> =>
  (await tailRecords(id)).filter(
    (rec): rec is SessionNativeStateRecord => rec.type === "native_state"
  );

const facts = async (
  id: string
): Promise<ReadonlyArray<SessionOperationFactRecord>> =>
  (await tailRecords(id)).filter(
    (rec): rec is SessionOperationFactRecord => rec.type === "operation_fact"
  );

/** A settled tool call: the fact variant the batch boundary produces. */
const toolFact = (toolUseId: string) => ({
  kind: "tool_result" as const,
  toolUseId,
  turnId: "t-1",
  batchPosition: 0,
  batchSize: 2,
  resultMessage: message(`result of ${toolUseId}`),
});

const rejectsWithCode = async (
  work: () => Promise<unknown>,
  code: NativeStatePortErrorCode
): Promise<void> => {
  await assert.rejects(
    work,
    (err: unknown) =>
      isNativeStatePortError(err) &&
      err.code === code &&
      err instanceof Error &&
      err.message.length > 0,
    `expected a typed ${code} rejection`
  );
};

/** Make the transcript append fail for real (EACCES on the file itself), which
 *  drives the store's own `write_failed` path — no injected error. Root can
 *  write a read-only file, so the case is skipped there. */
const isRoot = process.getuid?.() === 0;

/** Block the publication's immutable-body write for real: a plain file where
 *  the body directory must be, so `mkdir` fails however privileged the runner
 *  is. The record append never happens — the body write is first. */
async function blockBodyWrite(id: string): Promise<void> {
  await mkdir(join(sessionDirFor(id), "blobs"), { recursive: true });
  await writeFile(
    join(sessionDirFor(id), "blobs", "native"),
    "not-a-dir",
    "utf8"
  );
}

describe("createRuntimePersistenceBinder — bind", () => {
  it("(a) a blank session id binds nothing, so 'no session' and 'not wired' take one no-op path", () => {
    const { binder } = binderWith();
    assert.equal(binder.bind(undefined), undefined);
    assert.equal(binder.bind(""), undefined);
    assert.equal(binder.bind("   "), undefined);
  });

  it("(b) a known session binds a sink that really publishes", async () => {
    const id = "bind-ok";
    await seedChain(id);
    const { binder } = binderWith();
    const sink = binder.bind(id);
    assert.ok(sink, "a known session must bind a sink");
    await sink.publishSavedState(request("accepted_input"));
    assert.equal((await nativeStates(id)).length, 1);
  });
});

describe("createRuntimePersistenceBinder — boundary vocabulary", () => {
  const cases: ReadonlyArray<
    readonly [RuntimeSavedStateBoundary, SessionNativeStateRecord["boundary"]]
  > = [
    ["accepted_input", "input"],
    ["tool_batch_settled", "tool_batch"],
    ["compacted", "compaction"],
    ["terminal_turn", "terminal"],
  ];

  for (const [runtimeBoundary, storedBoundary] of cases) {
    it(`(map) ${runtimeBoundary} lands one native_state record as "${storedBoundary}"`, async () => {
      const id = `map-${runtimeBoundary}`;
      await seedChain(id);
      const { binder } = binderWith();
      const sink = binder.bind(id);
      assert.ok(sink);
      await sink.publishSavedState(request(runtimeBoundary));

      const records = await nativeStates(id);
      assert.equal(records.length, 1);
      assert.equal(records[0]!.boundary, storedBoundary);
      assert.equal(toNativeStateBoundary(runtimeBoundary), storedBoundary);
    });
  }

  it("(narrow) an unmapped boundary throws instead of passing through", () => {
    assert.throws(() =>
      toNativeStateBoundary(
        "never_published" as unknown as RuntimeSavedStateBoundary
      )
    );
  });
});

describe("createRuntimePersistenceBinder — publishSavedState", () => {
  it("(a) the gate=false writes nothing and raises nothing (SC23: old bytes stay untouched)", async () => {
    const id = "gated";
    await seedChain(id);
    const before = await readFile(jsonlFor(id), "utf8");
    const { binder } = binderWith({ shouldPublish: () => false });

    const sink = binder.bind(id);
    assert.ok(sink);
    await sink.publishSavedState(request("accepted_input"));

    assert.equal(await readFile(jsonlFor(id), "utf8"), before);
  });

  it("(b) an async gate is honored", async () => {
    const id = "gated-async";
    await seedChain(id);
    const { binder } = binderWith({ shouldPublish: async () => false });
    const sink = binder.bind(id);
    assert.ok(sink);
    await sink.publishSavedState(request("accepted_input"));
    assert.equal((await nativeStates(id)).length, 0);
  });

  it("(c) a headless session skips the publication and writes nothing", async () => {
    // A silent host wake as the session's first activity reaches the input
    // boundary with nothing committed yet. A record anchored to a non-existent
    // event is unresolvable for any reader, and the same context is published
    // at the next boundary with a real anchor, so the skip loses nothing.
    const id = "no-head";
    await store.save({ id, file: sampleFile(id) });
    const { binder } = binderWith();
    const sink = binder.bind(id);
    assert.ok(sink);

    await sink.publishSavedState(request("accepted_input"));
    assert.equal((await nativeStates(id)).length, 0);
  });

  it("(c2) once the session has a head, the same publication lands and blocks on failure", async () => {
    // The skip is scoped to a chain-less session. A head exists → the anchor
    // resolves, the record lands, and a real write failure stays a PERSIST_FAILED.
    const id = "with-head";
    await seedChain(id);
    const { binder } = binderWith();
    const sink = binder.bind(id);
    assert.ok(sink);

    await sink.publishSavedState(request("accepted_input"));
    assert.equal((await nativeStates(id)).length, 1);
  });

  it("(d) an unknown session is a typed pre-write rejection, not a persist failure", async () => {
    const { binder } = binderWith();
    const sink = binder.bind("no-such-session");
    assert.ok(sink);
    await rejectsWithCode(
      () => sink.publishSavedState(request("accepted_input")),
      "VALIDATION"
    );
  });

  it("(e) a publication issued from INSIDE the queue resolves (re-entrancy, no deadlock)", async () => {
    const id = "reentrant";
    await seedChain(id);
    const { binder, queue } = binderWith();
    const sink = binder.bind(id);
    assert.ok(sink);

    // The hub runs a whole turn inside the queue slot, so a publication issued
    // from inside a turn must not wait for the slot it already holds.
    const published = await Promise.race([
      queue.serialize(id, async () => {
        await sink.publishSavedState(request("accepted_input"));
        return "published";
      }),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("DEADLOCK")), 2000)
      ),
    ]);

    assert.equal(published, "published");
    assert.equal((await nativeStates(id)).length, 1);
    assert.equal(queue.maxDepth(), 1, "one queue slot, never a second lock");
  });

  it("(f) an aborted host fails fast with PERSIST_FAILED and writes nothing", async () => {
    const id = "aborted";
    await seedChain(id);
    const before = await readFile(jsonlFor(id), "utf8");
    const controller = new AbortController();
    controller.abort();
    const { binder } = binderWith({ signal: controller.signal });
    const sink = binder.bind(id);
    assert.ok(sink);

    await rejectsWithCode(
      () => sink.publishSavedState(request("accepted_input")),
      "PERSIST_FAILED"
    );
    assert.equal(await readFile(jsonlFor(id), "utf8"), before);
  });

  it("(g) a store write failure surfaces as PERSIST_FAILED and appends no record", async () => {
    const id = "write-failed";
    await seedChain(id);
    await blockBodyWrite(id);
    const { binder } = binderWith();
    const sink = binder.bind(id);
    assert.ok(sink);

    await rejectsWithCode(
      () => sink.publishSavedState(request("accepted_input")),
      "PERSIST_FAILED"
    );
    assert.equal(
      (await nativeStates(id)).length,
      0,
      "a failed body write must leave the record un-appended"
    );
  });

  it("(h) a rejected request surfaces as VALIDATION and publishes nothing", async () => {
    const id = "invalid-request";
    await seedChain(id);
    const before = await readFile(jsonlFor(id), "utf8");
    const { binder } = binderWith();
    const sink = binder.bind(id);
    assert.ok(sink);

    await rejectsWithCode(
      () =>
        sink.publishSavedState(
          request("accepted_input", {
            messages: [{ role: "user", content: "not-an-array" } as never],
          })
        ),
      "VALIDATION"
    );
    assert.equal(await readFile(jsonlFor(id), "utf8"), before);
  });

  it("(i) typed runtime state is persisted, and an unknown turnId stays absent", async () => {
    const id = "typed-state";
    await seedChain(id);
    const { binder } = binderWith();
    const sink = binder.bind(id);
    assert.ok(sink);

    await sink.publishSavedState(
      request("terminal_turn", {
        turnId: null,
        assembly: { systemPrefix: "sys" },
        terminal: { stopReason: "completed" },
        graphNodes: [{ kind: "graph_node", nodeId: "n1", status: "done" }],
        workers: [
          {
            kind: "worker_progress",
            taskId: "w1",
            ownership: "background",
            state: "needs_handling",
            process: { pid: 42, startTime: null },
          },
        ],
        toolResults: [
          {
            kind: "tool_result",
            toolUseId: "tu-1",
            batchPosition: 0,
            batchSize: 1,
            resultMessage: message("done"),
          },
        ],
      })
    );

    const records = await nativeStates(id);
    const reopened = new SessionStore(baseDir, process.cwd());
    const body = await reopened.readPublishedNativeStateBody({
      id,
      bodySha: records[0]!.bodySha,
    });
    assert.equal(body.assembly?.systemPrefix, "sys");
    // Assembly carries only what the engine actually resolved; the host adds
    // no field of its own, so an unresolved input cannot reappear as a default.
    assert.deepEqual(Object.keys(body.assembly ?? {}), ["systemPrefix"]);
    assert.equal(body.terminal?.stopReason, "completed");
    assert.equal(body.graphNodes?.[0]?.nodeId, "n1");
    assert.equal(body.workers?.[0]?.state, "needs_handling");
    assert.equal(body.workers?.[0]?.process?.startTime, null);
    assert.equal(body.toolResults?.[0]?.toolUseId, "tu-1");
    assert.ok(!("turnId" in body), "turnId: null means absent, never a value");
  });

  it("(j) a publication that resolved no assembly persists no assembly key", async () => {
    const id = "no-assembly";
    await seedChain(id);
    const { binder } = binderWith();
    const sink = binder.bind(id);
    assert.ok(sink);

    await sink.publishSavedState(request("terminal_turn"));
    const records = await nativeStates(id);
    const reopened = new SessionStore(baseDir, process.cwd());
    const body = await reopened.readPublishedNativeStateBody({
      id,
      bodySha: records[0]!.bodySha,
    });
    // Absent, not `{}` and not a field per default: a reader must be able to
    // tell "the run resolved none" from "the run resolved an empty value".
    assert.ok(
      !("assembly" in body),
      "no resolved prefix means no assembly claim"
    );
  });
});

describe("createRuntimePersistenceBinder — appendOperationFact", () => {
  it("(a) a settled fact lands one record carrying the derived anchor and base", async () => {
    const id = "fact";
    const head = await seedChain(id);
    const { binder } = binderWith();
    const sink = binder.bind(id);
    assert.ok(sink);
    await sink.publishSavedState(request("accepted_input"));
    await sink.appendOperationFact(toolFact("tu-1"));

    const records = await facts(id);
    assert.equal(records.length, 1);
    assert.equal(records[0]!.anchorEventId, head);
    assert.equal(
      records[0]!.baseBodySha,
      (await nativeStates(id))[0]!.bodySha,
      "the base is the last state this sink published"
    );
    assert.equal(records[0]!.turnId, "t-1");
  });

  it("(b) a repeated factId is deduped, not double-appended", async () => {
    const id = "fact-dedup";
    await seedChain(id);
    const { binder } = binderWith();
    const sink = binder.bind(id);
    assert.ok(sink);

    await sink.appendOperationFact(toolFact("tu-1"));
    await sink.appendOperationFact(toolFact("tu-1"));
    await sink.appendOperationFact(toolFact("tu-1"));

    assert.equal((await facts(id)).length, 1);
  });

  it("(c) arrival order is preserved across an interleaved publication", async () => {
    const id = "fact-order";
    await seedChain(id);
    const { binder } = binderWith();
    const sink = binder.bind(id);
    assert.ok(sink);

    await sink.appendOperationFact(toolFact("tu-1"));
    await sink.appendOperationFact(toolFact("tu-2"));
    await sink.publishSavedState(request("tool_batch_settled"));
    await sink.appendOperationFact(toolFact("tu-3"));

    const order = (await facts(id)).map((rec) =>
      rec.fact.kind === "tool_result" ? rec.fact.toolUseId : "other"
    );
    assert.deepEqual(order, ["tu-1", "tu-2", "tu-3"]);
    const raw = await readFile(jsonlFor(id), "utf8");
    assert.ok(
      raw.indexOf("tu-1") < raw.indexOf("tu-3"),
      "the append position is the order; a later publication must not move a fact"
    );
  });

  it("(d) the gate=false skips the fact as well as the publication", async () => {
    const id = "fact-gated";
    await seedChain(id);
    const { binder } = binderWith({ shouldPublish: () => false });
    const sink = binder.bind(id);
    assert.ok(sink);
    await sink.appendOperationFact(toolFact("tu-1"));
    assert.equal((await facts(id)).length, 0);
  });

  it("(e) no persisted head is a typed pre-write rejection (VALIDATION)", async () => {
    const id = "fact-no-head";
    await store.save({ id, file: sampleFile(id) });
    const { binder } = binderWith();
    const sink = binder.bind(id);
    assert.ok(sink);
    await rejectsWithCode(
      () => sink.appendOperationFact(toolFact("tu-1")),
      "VALIDATION"
    );
  });

  it.skipIf(isRoot)(
    "(f) a store append failure surfaces as PERSIST_FAILED",
    async () => {
      const id = "fact-write-failed";
      await seedChain(id);
      await chmod(jsonlFor(id), 0o400);
      const { binder } = binderWith();
      const sink = binder.bind(id);
      assert.ok(sink);
      await rejectsWithCode(
        () => sink.appendOperationFact(toolFact("tu-1")),
        "PERSIST_FAILED"
      );
    }
  );

  it("(g) a fact carrying a live handle is VALIDATION and writes nothing", async () => {
    const id = "fact-handle";
    await seedChain(id);
    const before = await readFile(jsonlFor(id), "utf8");
    const { binder } = binderWith();
    const sink = binder.bind(id);
    assert.ok(sink);

    await rejectsWithCode(
      () =>
        sink.appendOperationFact({
          kind: "worker_progress",
          taskId: "w1",
          ownership: "foreground",
          state: "running",
          process: { pid: 7, startTime: 1, kill: () => undefined },
        } as never),
      "VALIDATION"
    );
    assert.equal(await readFile(jsonlFor(id), "utf8"), before);
  });

  it("(h) worker progress with a read-only process identity is accepted", async () => {
    const id = "fact-worker";
    await seedChain(id);
    const { binder } = binderWith();
    const sink = binder.bind(id);
    assert.ok(sink);

    await sink.appendOperationFact({
      kind: "worker_progress",
      taskId: "w1",
      ownership: "background",
      state: "running",
      process: { pid: 4242, startTime: 987654 },
    });

    const [record] = await facts(id);
    assert.equal(record?.fact.kind, "worker_progress");
    assert.equal(
      record?.fact.kind === "worker_progress" && record.fact.process?.pid,
      4242
    );
  });

  it("(i) a fact appended from inside the queue resolves (re-entrancy)", async () => {
    const id = "fact-reentrant";
    await seedChain(id);
    const { binder, queue } = binderWith();
    const sink = binder.bind(id);
    assert.ok(sink);

    await Promise.race([
      queue.serialize(id, () => sink.appendOperationFact(toolFact("tu-1"))),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("DEADLOCK")), 2000)
      ),
    ]);

    assert.equal((await facts(id)).length, 1);
  });
});

/**
 * A fact's derived id must name the EVENT, not the (entity, state) pair. The
 * store drops a repeated id and a reader reads an entity's last fact as its
 * current state, so a pair-shaped id silently swallows a second real
 * transition — the resumed worker being the expensive case, because a resume
 * reuses the same `taskId` for a NEW process.
 */
describe("createRuntimePersistenceBinder — fact identity per event", () => {
  const workerFact = (
    state: "starting" | "running" | "completed",
    process: { pid: number; startTime: number }
  ) => ({
    kind: "worker_progress" as const,
    taskId: "task-9",
    ownership: "background" as const,
    state,
    process,
  });

  it("(a) a worker resumed under the same taskId keeps both rounds' facts", async () => {
    const id = "fact-resumed-worker";
    await seedChain(id);
    const { binder } = binderWith();
    const sink = binder.bind(id);
    assert.ok(sink);

    // Round 1 completes; round 2 is the same logical worker resumed as a new
    // process, so its first two transitions are the ones a pair-shaped id
    // dropped — leaving round 1's `completed` standing as the answer while the
    // worker is live.
    const first = { pid: 100, startTime: 5 };
    const second = { pid: 200, startTime: 9 };
    for (const state of ["starting", "running", "completed"] as const) {
      await sink.appendOperationFact(workerFact(state, first));
    }
    for (const state of ["starting", "running", "completed"] as const) {
      await sink.appendOperationFact(workerFact(state, second));
    }

    const records = await facts(id);
    assert.equal(
      records.length,
      6,
      "no transition of a live worker is discarded"
    );
    assert.equal(
      new Set(records.map((rec) => rec.factId)).size,
      6,
      "two real transitions of one worker to one state must not share an id"
    );
    assert.deepEqual(
      records.map((rec) =>
        rec.fact.kind === "worker_progress" ? rec.fact.state : "other"
      ),
      ["starting", "running", "completed", "starting", "running", "completed"],
      "arrival order survives, so the log reads as the chronology it is"
    );
    // What a reader actually derives: the LAST fact of the task, not the first.
    const last = records.at(-1)!.fact;
    assert.equal(
      last.kind === "worker_progress" && last.process?.pid,
      200,
      "the current state of the task is the resumed process's, not round 1's"
    );
  });

  it("(b) a retried append of one event is still deduped", async () => {
    const id = "fact-retry-dedup";
    await seedChain(id);
    const { binder } = binderWith();
    const sink = binder.bind(id);
    assert.ok(sink);

    const event = workerFact("running", { pid: 100, startTime: 5 });
    await sink.appendOperationFact(event);
    await sink.appendOperationFact({ ...event });
    await sink.appendOperationFact({ ...event });
    await sink.appendOperationFact(
      workerFact("completed", { pid: 100, startTime: 5 })
    );

    assert.equal(
      (await facts(id)).length,
      2,
      "a repeated append of one event must not be doubled"
    );
  });

  it("(c) a repeated state of one live process is one event, not two", async () => {
    const id = "fact-same-process";
    await seedChain(id);
    const { binder } = binderWith();
    const sink = binder.bind(id);
    assert.ok(sink);

    // The documented limit of the discriminator: within ONE process a repeat of
    // the same state carries no new information for a reader, so it dedupes.
    // This is not the resumed case — that is (a), where the identity differs.
    await sink.appendOperationFact(
      workerFact("running", { pid: 100, startTime: 5 })
    );
    await sink.appendOperationFact(
      workerFact("running", { pid: 100, startTime: 5 })
    );
    assert.equal((await facts(id)).length, 1);
  });

  it("(d) a worker fact with no recorded identity keeps the pair-shaped id", async () => {
    const id = "fact-no-identity";
    await seedChain(id);
    const { binder } = binderWith();
    const sink = binder.bind(id);
    assert.ok(sink);

    await sink.appendOperationFact({
      kind: "worker_progress",
      taskId: "task-0",
      ownership: "foreground",
      state: "starting",
    });
    await sink.appendOperationFact({
      kind: "worker_progress",
      taskId: "task-0",
      ownership: "foreground",
      state: "starting",
    });

    assert.equal(
      (await facts(id)).length,
      1,
      "with no instance discriminator in the payload, a repeat is the only reading"
    );
  });

  it("(e) two freezes of one graph node are two events, and a repeat is one", async () => {
    const id = "fact-node-refreeze";
    await seedChain(id);
    const { binder } = binderWith();
    const sink = binder.bind(id);
    assert.ok(sink);

    // The live graph ledger allows a second freeze of one id (back-edges, "last
    // write wins"), so two different settled outputs are two events and both
    // must land — the reader's current output is the second one.
    await sink.appendOperationFact({
      kind: "graph_node",
      nodeId: "n1",
      status: "done",
      output: "first output",
    });
    await sink.appendOperationFact({
      kind: "graph_node",
      nodeId: "n1",
      status: "done",
      output: "first output",
    });
    await sink.appendOperationFact({
      kind: "graph_node",
      nodeId: "n1",
      status: "done",
      output: "second output",
    });

    const records = await facts(id);
    assert.equal(
      records.length,
      2,
      "the identical re-append dedupes, the new one lands"
    );
    const last = records.at(-1)!.fact;
    assert.equal(
      last.kind === "graph_node" ? last.output : undefined,
      "second output"
    );
  });
});

describe("createRuntimePersistenceBinder — record placement", () => {
  it("(a) a fact never reaches the projected session file and is never a checkpoint", async () => {
    const id = "fact-offchain";
    await seedChain(id);
    const { binder } = binderWith();
    const sink = binder.bind(id);
    assert.ok(sink);
    await sink.publishSavedState(request("accepted_input"));
    await sink.appendOperationFact(toolFact("tu-1"));

    const reopened = new SessionStore(baseDir, process.cwd());
    const projection = JSON.stringify(await reopened.load(id));
    assert.ok(!projection.includes("operation_fact"));
    assert.ok(!projection.includes("tu-1"));

    const selection = await reopened.loadPublishedNativeState({ id });
    assert.equal(selection.selected?.type, "native_state");
    assert.equal(selection.fileIntents.length, 0);
  });

  it("(b) a fact with no publication yet carries a null base, not a guess", async () => {
    const id = "fact-no-base";
    await seedChain(id);
    const { binder } = binderWith();
    const sink = binder.bind(id);
    assert.ok(sink);
    await sink.appendOperationFact({
      kind: "graph_node",
      nodeId: "n1",
      status: "failed",
      error: "boom",
    });

    const log = parseSessionJsonl(await readFile(jsonlFor(id), "utf8"));
    const fact = log.records.find(
      (rec): rec is SessionOperationFactRecord => rec.type === "operation_fact"
    );
    assert.ok(fact, "the fact record must parse back");
    assert.equal(fact.baseBodySha, null);
    assert.equal(
      log.maxEventIndex,
      0,
      "an off-chain record never moves the message chain"
    );
  });

  it("(c) a schema-invalid operation_fact line fails the read closed, it is not dropped", async () => {
    const id = "fact-malformed";
    await seedChain(id);
    const line = JSON.stringify({
      type: "operation_fact",
      factId: "f1",
      anchorEventId: "e0",
      baseBodySha: null,
      createdAt: new Date().toISOString(),
      fact: { kind: "graph_node", nodeId: "n1", status: "not_a_status" },
    });
    await appendFile(jsonlFor(id), `${line}\n`, "utf8");

    await assert.rejects(
      () => new SessionStore(baseDir, process.cwd()).load(id),
      (err: unknown) => (err as { kind?: string }).kind === "schema_invalid"
    );
  });
});
