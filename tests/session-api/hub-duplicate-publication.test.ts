/**
 * ADR-0150: one terminal sub-agent result reaches the conversation at most once
 * per `(conversation, task, terminal generation)`. The digest is acknowledged by
 * the host write that actually carries it — never by "the first write of any
 * kind", never on resolve — and released when no write carried it.
 *
 * ADR-0136 §3 (kept here, same fixture): ONE publisher per boundary. The hub
 * commits the accepted input; the engine publishes the boundary.
 *
 * The fake manager below is NOT a mock of the delivery seam: it delegates to the
 * real `createDeliveryLedger()`, so claim / acknowledge / release are the
 * production semantics. Every assertion counts real records parsed off disk in a
 * real session file, so a second producer cannot hide behind a stub.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, vi } from "vitest";

import { SessionHub } from "../../src/session-api/hub.ts";
import { createDeliveryLedger } from "../../src/harness/subagent/delivery-ledger.ts";
import {
  parseSessionJsonl,
  pinGoal,
  resolveConversationDir,
  resolveProjectSessionDir,
  SESSION_JSONL_EXT,
  SessionStore,
  type SessionFileV1,
  type SessionNativeStateRecord,
} from "../../src/session-api/store/index.ts";
import type { LoopEngineDeps } from "../../src/harness/index.ts";
import type { NativeStateMessage } from "../../src/shared/native-state-port.ts";
import type { SubAgentEnvelope } from "../../src/harness/subagent/envelope.ts";
import type { SubAgentManager } from "../../src/harness/subagent/manager.ts";
import { assistantResult, makeDeps } from "../cli/_fixtures.ts";

let baseDir: string;
let taskRoot: string;
let projectDir: string;
let store: SessionStore;

const conversationDir = (id: string): string =>
  resolveConversationDir({ projectDir, conversationId: id });
const jsonlFor = (id: string): string =>
  join(conversationDir(id), `${id}${SESSION_JSONL_EXT}`);

beforeEach(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "iknow-hub-dup-pub-"));
  taskRoot = await mkdtemp(join(tmpdir(), "iknow-hub-dup-pub-root-"));
  projectDir = resolveProjectSessionDir(baseDir, taskRoot);
  store = new SessionStore(baseDir, taskRoot);
});

afterEach(async () => {
  vi.restoreAllMocks();
  // A turn that is still finishing can write into the session directory while
  // the temp tree is removed; retry so the cleanup does not race it.
  await rm(baseDir, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 50,
  });
  await rm(taskRoot, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 50,
  });
});

/** Real native_state records off disk, in file order. */
const publishedRecords = async (
  id: string
): Promise<ReadonlyArray<SessionNativeStateRecord>> => {
  const log = parseSessionJsonl(await readFile(jsonlFor(id), "utf8"));
  return log.records.filter(
    (r): r is SessionNativeStateRecord => r.type === "native_state"
  );
};

const atBoundary = (
  records: ReadonlyArray<SessionNativeStateRecord>,
  boundary: SessionNativeStateRecord["boundary"]
): ReadonlyArray<SessionNativeStateRecord> =>
  records.filter((r) => r.boundary === boundary);

/** The published body read back through the store's own reader. */
const readNativeBody = async (
  id: string,
  record: SessionNativeStateRecord
): Promise<ReadonlyArray<NativeStateMessage>> => {
  const body = await store.readPublishedNativeStateBody({
    id,
    bodySha: record.bodySha,
  });
  return body.messages;
};

/** The digest prefix for one task, the substring `writeCarriesDigest` matches. */
const digestFor = (taskId: string): string => `## Sub-agent ${taskId} result`;

/**
 * How often `needle` appears in the PERSISTED history (the chain the store's
 * own reader projects), counted per text block.
 */
async function digestCountOnDisk(id: string, needle: string): Promise<number> {
  const file = await store.load(id);
  let count = 0;
  for (const message of file.messages) {
    for (const block of message.content) {
      if (block.type === "text" && block.text.includes(needle)) count += 1;
    }
  }
  return count;
}

interface FakeEntry {
  readonly conversationId: string;
  readonly taskId: string;
  readonly terminalSeq: number;
  readonly envelope: SubAgentEnvelope;
}

interface FakeDeliveryManager {
  readonly manager: SubAgentManager;
  /** Size of every claim this manager handed out, in call order. */
  readonly claimSizes: number[];
  /** Append one terminal generation; a second call for the same task is a resume. */
  complete(opts: {
    readonly conversationId: string;
    readonly taskId: string;
    readonly summary: string;
    readonly result?: string;
  }): void;
}

/**
 * A manager whose delivery seam is the real ledger. `terminalSeq` is a
 * manager-global monotonic counter, as in the production manager.
 */
function createFakeDeliveryManager(): FakeDeliveryManager {
  const ledger = createDeliveryLedger();
  const entries: FakeEntry[] = [];
  const claimSizes: number[] = [];
  let terminalSeq = 0;

  const scoped = (conversationId?: string): FakeEntry[] =>
    entries.filter(
      (entry) =>
        conversationId === undefined || entry.conversationId === conversationId
    );

  const manager: SubAgentManager = {
    spawn: () => ({ taskId: "unused" }),
    queryBuffer: () => ({ status: "not_found" }),
    waitFor: async () => {
      throw new Error("unused");
    },
    shutdown: async () => {
      entries.length = 0;
      ledger.clear();
    },
    drainCompleted: (conversationId, opts) => {
      const rows = scoped(conversationId);
      const visible =
        opts?.includeDelivered === true ? rows : ledger.undelivered(rows);
      return visible.map((entry) => ({
        taskId: entry.taskId,
        envelope: entry.envelope,
      }));
    },
    claimCompleted: (conversationId) => {
      const claims = ledger.claim(scoped(conversationId));
      claimSizes.push(claims.length);
      return claims;
    },
    acknowledgeDeliveries: (claims) => ledger.acknowledge(claims),
    releaseDeliveries: (claims) => ledger.release(claims),
    listActive: () => [],
    abortTask: () => false,
    getCapacity: () => 15,
    listSubagents: () => [],
    subscribe: () => () => {},
  };

  return {
    manager,
    claimSizes,
    complete: ({ conversationId, taskId, summary, result }) => {
      terminalSeq += 1;
      entries.push({
        conversationId,
        taskId,
        terminalSeq,
        envelope: { status: "ok", summary, result: result ?? summary },
      });
    },
  };
}

/**
 * Wrap the adapter so every model request's prior context is recorded. Used by
 * "did the model actually see the digest this run?" assertions.
 */
function recordModelInputs(deps: LoopEngineDeps): {
  readonly deps: LoopEngineDeps;
  readonly seen: string[][];
} {
  const seen: string[][] = [];
  return {
    seen,
    deps: {
      ...deps,
      adapter: {
        ...deps.adapter,
        step: async (...args) => {
          seen.push(
            args[0].messages.map((message) =>
              message.content
                .filter(
                  (block): block is { type: "text"; text: string } =>
                    block.type === "text"
                )
                .map((block) => block.text)
                .join("")
            )
          );
          return deps.adapter.step(...args);
        },
      },
    },
  };
}

describe("one publisher per boundary (ADR-0136 §3)", () => {
  it("publishes exactly one input state for one accepted user message", async () => {
    const hub = new SessionHub({
      store,
      deps: makeDeps([assistantResult({ texts: ["ok"] })]),
      workspaceRoot: taskRoot,
    });
    await hub.bindWorkspace(taskRoot);
    const { session } = await hub.createSession();
    const id = session.conversation_id;

    await hub.postMessage({ conversationId: id, text: "remember this" });

    const records = await publishedRecords(id);
    assert.equal(
      atBoundary(records, "input").length,
      1,
      "the hub commits the input; the engine publishes it once"
    );
    assert.deepEqual(
      records.map((r) => r.boundary),
      ["input", "terminal"],
      "each boundary of the turn appears exactly once"
    );
  });

  it("publishes exactly one input state for a subagent wake", async () => {
    const fake = createFakeDeliveryManager();
    const hub = new SessionHub({
      store,
      deps: makeDeps([
        assistantResult({ texts: ["ok"] }),
        assistantResult({ texts: ["woken"] }),
      ]),
      workspaceRoot: taskRoot,
      subagentManager: fake.manager,
    });
    await hub.bindWorkspace(taskRoot);
    const { session } = await hub.createSession();
    const id = session.conversation_id;
    await hub.postMessage({ conversationId: id, text: "start a task" });
    const before = await publishedRecords(id);
    assert.equal(
      atBoundary(before, "input").length,
      1,
      "the first turn's input"
    );

    fake.complete({
      conversationId: id,
      taskId: "wake-task",
      summary: "worker summary",
    });
    await hub.wakeFromSubagent({ conversationId: id });

    const after = await publishedRecords(id);
    const fresh = after.slice(before.length);
    assert.deepEqual(
      fresh.map((r) => r.boundary),
      ["input", "terminal"],
      "the wake adds one input state and one terminal state, no duplicates"
    );
    // The wake's published context is the one the model actually received: the
    // drained digest is in the body.
    const body = await readNativeBody(id, fresh[0]!);
    assert.ok(
      body.some(
        (m) =>
          m.role === "user" &&
          m.content.some(
            (b) => b.type === "text" && b.text.includes("worker summary")
          )
      ),
      "the wake's published context carries the subagent digest"
    );
    assert.equal(
      await digestCountOnDisk(id, digestFor("wake-task")),
      1,
      "the wake delivered the digest once"
    );
  });

  it("writes nothing at all into an old-format session", async () => {
    const hub = new SessionHub({
      store,
      deps: makeDeps([assistantResult({ texts: ["ok"] })]),
      workspaceRoot: taskRoot,
    });
    await hub.bindWorkspace(taskRoot);
    const { session } = await hub.createSession();
    const id = session.conversation_id;
    // Fixture: the only way a session is old-format is the field's absence,
    // since `save` never stamps it.
    const oldFile: SessionFileV1 = { ...(await store.load(id)) };
    delete (oldFile as { nativeStateFormat?: number }).nativeStateFormat;
    await store.save({ id, file: oldFile });

    await hub.postMessage({ conversationId: id, text: "legacy turn" });

    assert.deepEqual(await publishedRecords(id), []);
    assert.equal((await store.load(id)).nativeStateFormat, undefined);
    // The previous host wrote no native-state pool for this session, and neither
    // does this one: the gate skips the pool entirely rather than writing an
    // empty one.
    assert.equal(
      (await readdir(conversationDir(id))).includes("blobs"),
      false,
      "no body pool is created for a session the gate skips"
    );
  });
});

describe("ADR-0150: sub-agent results are delivered exactly once", () => {
  /** Boot a hub whose manager is the ledger-backed fake. */
  async function boot(opts: {
    readonly deps: LoopEngineDeps;
    readonly fake: FakeDeliveryManager;
  }): Promise<{ readonly hub: SessionHub; readonly id: string }> {
    const hub = new SessionHub({
      store,
      deps: opts.deps,
      workspaceRoot: taskRoot,
      subagentManager: opts.fake.manager,
    });
    await hub.bindWorkspace(taskRoot);
    const created = await hub.createSession();
    return { hub, id: created.session.conversation_id };
  }

  it("case 1: run 1 carries the digest, run 2 neither writes nor shows it", async () => {
    const fake = createFakeDeliveryManager();
    const recorded = recordModelInputs(
      makeDeps([
        assistantResult({ texts: ["one"] }),
        assistantResult({ texts: ["two"] }),
        assistantResult({ texts: ["three"] }),
      ])
    );
    const seen = recorded.seen;
    const { hub, id } = await boot({ deps: recorded.deps, fake });

    await hub.postMessage({ conversationId: id, text: "start" });
    fake.complete({
      conversationId: id,
      taskId: "worker-1",
      summary: "worker one done",
    });

    await hub.postMessage({ conversationId: id, text: "second" });
    assert.equal(
      await digestCountOnDisk(id, digestFor("worker-1")),
      1,
      "run 1 writes the digest once"
    );
    // Occurrences of the digest inside one model request's prior context. A
    // re-injection on a later run would make this 2 (history + fresh digest).
    const occurrencesPerRequest = (): number[] =>
      seen.map(
        (request) =>
          request.filter((text) => text.includes(digestFor("worker-1"))).length
      );
    assert.deepEqual(
      occurrencesPerRequest(),
      [0, 1],
      "run 1's model request carries the digest exactly once"
    );

    await hub.postMessage({ conversationId: id, text: "third" });
    assert.equal(
      await digestCountOnDisk(id, digestFor("worker-1")),
      1,
      "run 2 does not write it again"
    );
    assert.deepEqual(
      occurrencesPerRequest(),
      [0, 1, 1],
      "run 2 sees the committed digest once; it is not re-injected"
    );
    assert.deepEqual(fake.claimSizes, [0, 1, 0], "only run 1 claimed");
  });

  it("case 2: a failed digest-carrying write keeps the result claimable", async () => {
    const fake = createFakeDeliveryManager();
    const { hub, id } = await boot({
      deps: makeDeps([
        assistantResult({ texts: ["one"] }),
        assistantResult({ texts: ["two"] }),
        assistantResult({ texts: ["three"] }),
      ]),
      fake,
    });

    await hub.postMessage({ conversationId: id, text: "start" });
    fake.complete({
      conversationId: id,
      taskId: "worker-retry",
      summary: "retry me",
    });

    // Fail the accepted-input commit — the write that carries the digest.
    const failed = vi
      .spyOn(store, "appendEvents")
      .mockRejectedValueOnce(new Error("commit failed"));
    await assert.rejects(
      hub.postMessage({ conversationId: id, text: "second" }),
      /commit failed/
    );
    failed.mockRestore();

    assert.equal(
      await digestCountOnDisk(id, digestFor("worker-retry")),
      0,
      "nothing carried the digest"
    );
    assert.equal(
      fake.manager.drainCompleted(id).length,
      1,
      "the generation is claimable again"
    );

    await hub.postMessage({ conversationId: id, text: "third" });
    assert.equal(
      await digestCountOnDisk(id, digestFor("worker-retry")),
      1,
      "the retry delivers it exactly once"
    );
    assert.equal(
      fake.manager.drainCompleted(id).length,
      0,
      "and it is delivered now"
    );
  });

  it("case 3: the wake claims once and a second wake publishes nothing", async () => {
    const fake = createFakeDeliveryManager();
    const { hub, id } = await boot({
      deps: makeDeps([
        assistantResult({ texts: ["woken"] }),
        assistantResult({ texts: ["again"] }),
      ]),
      fake,
    });
    fake.complete({
      conversationId: id,
      taskId: "wake-once",
      summary: "wake summary",
    });

    const first = await hub.wakeFromSubagent({ conversationId: id });
    assert.notEqual(first, undefined, "the first wake delivers");
    assert.equal(await digestCountOnDisk(id, digestFor("wake-once")), 1);

    const second = await hub.wakeFromSubagent({ conversationId: id });
    assert.equal(second, undefined, "the claim is consumed");
    assert.equal(
      await digestCountOnDisk(id, digestFor("wake-once")),
      1,
      "the second wake adds no digest"
    );
    assert.deepEqual(fake.claimSizes, [1, 0]);
  });

  it("case 4: a failing wake releases the claim for a later delivery", async () => {
    const fake = createFakeDeliveryManager();
    const { hub, id } = await boot({
      deps: makeDeps([assistantResult({ texts: ["woken"] })]),
      fake,
    });
    fake.complete({
      conversationId: id,
      taskId: "wake-retry",
      summary: "wake retry",
    });

    // Fail the turn before any digest-carrying write happens: the session load
    // at the turn's start. Nothing was written, so nothing acknowledged the
    // claim and the wake must hand it back.
    const failed = vi
      .spyOn(store, "load")
      .mockRejectedValueOnce(new Error("session load failed"));
    await assert.rejects(
      hub.wakeFromSubagent({ conversationId: id }),
      /session load failed/
    );
    failed.mockRestore();

    assert.equal(
      fake.manager.drainCompleted(id).length,
      1,
      "the failed wake returned the generation to the claimable state"
    );
    assert.equal(
      await digestCountOnDisk(id, digestFor("wake-retry")),
      0,
      "nothing carried the digest"
    );

    await hub.wakeFromSubagent({ conversationId: id });
    assert.equal(
      await digestCountOnDisk(id, digestFor("wake-retry")),
      1,
      "the retry delivers it exactly once"
    );
  });

  it("case 5: a concurrent wake and user turn deliver the digest once", async () => {
    const fake = createFakeDeliveryManager();
    const { hub, id } = await boot({
      deps: makeDeps([
        assistantResult({ texts: ["woken"] }),
        assistantResult({ texts: ["answered"] }),
      ]),
      fake,
    });
    fake.complete({
      conversationId: id,
      taskId: "race-task",
      summary: "race summary",
    });

    const wake = hub.wakeFromSubagent({ conversationId: id });
    const turn = hub.postMessage({ conversationId: id, text: "user turn" });
    await Promise.all([wake, turn]);

    assert.equal(
      await digestCountOnDisk(id, digestFor("race-task")),
      1,
      "exactly one digest reached disk"
    );
    assert.equal(
      fake.claimSizes.reduce((total, size) => total + size, 0),
      1,
      "only one of the two contenders claimed the generation"
    );
    assert.equal(
      fake.manager.drainCompleted(id).length,
      0,
      "the generation is delivered, not left claimable"
    );
  });

  it("case 6: an auto-loop iteration >=2 acks at the closing save only", async () => {
    const fake = createFakeDeliveryManager();
    const baseDeps = makeDeps([
      assistantResult({ texts: ["first round"] }),
      assistantResult({ texts: ["second round"] }),
    ]);
    let steps = 0;
    let conversationId = "";
    const deps: LoopEngineDeps = {
      ...baseDeps,
      adapter: {
        ...baseDeps.adapter,
        step: async (...args) => {
          const result = await baseDeps.adapter.step(...args);
          steps += 1;
          // The result lands while iteration 1 is inside its model call, so
          // only iteration 2 can claim it.
          if (steps === 1) {
            fake.complete({
              conversationId,
              taskId: "late-task",
              summary: "late summary",
            });
          }
          return result;
        },
      },
    };
    const hub = new SessionHub({
      store,
      deps,
      workspaceRoot: taskRoot,
      subagentManager: fake.manager,
      verifyConfig: { command: "" },
    });
    await hub.bindWorkspace(taskRoot);
    const created = await hub.createSession();
    const id = created.session.conversation_id;
    conversationId = id;

    const seed = await store.load(id);
    await store.save({
      id,
      file: {
        ...seed,
        goal: pinGoal({
          current: seed.goal,
          text: "keep going",
          now: new Date().toISOString(),
          maxTurns: 2,
        }),
      },
    });

    // Every incremental chain write of the turn. `queryCommitPending` is
    // consumed by iteration 1, so iteration 2's commit events must never carry
    // the digest it claimed — otherwise the closing save is not the write that
    // persisted it.
    const appended: string[][] = [];
    const originalAppend = store.appendEvents.bind(store);
    const appendSpy = vi
      .spyOn(store, "appendEvents")
      .mockImplementation(async (opts) => {
        appended.push(
          opts.events.map((event) =>
            event.content
              .filter(
                (block): block is { type: "text"; text: string } =>
                  block.type === "text"
              )
              .map((block) => block.text)
              .join("")
          )
        );
        await originalAppend(opts);
      });

    await hub.postMessage({ conversationId: id, text: "go" });
    appendSpy.mockRestore();

    assert.ok(
      steps >= 2,
      `the auto loop ran at least two iterations (${steps})`
    );
    assert.deepEqual(
      fake.claimSizes,
      [0, 1],
      "iteration 2 is the claim that sees the late generation"
    );
    assert.equal(
      appended.some((events) =>
        events.some((text) => text.includes(digestFor("late-task")))
      ),
      false,
      "no commit event carried the iteration-2 digest"
    );
    assert.equal(
      await digestCountOnDisk(id, digestFor("late-task")),
      1,
      "the closing save persisted the digest exactly once"
    );
    assert.equal(
      fake.manager.drainCompleted(id).length,
      0,
      "the iteration-2 claim was settled, not left dangling"
    );
    assert.equal(
      fake.manager.drainCompleted(id, { includeDelivered: true }).length,
      1
    );
  });

  it("case 7: a none save leaves the claim claimable", async () => {
    // Scenario: a silent wake on a session with no committed head yet. The
    // engine's accepted-input publication cannot be anchored (headless) and is
    // skipped, the model returns an empty final response so the turn stops
    // before its first commit, and the closing save persists no drain text —
    // the digest is not on disk. No write carries the digest, so the claim
    // must go back to claimable and the next round must offer the result
    // again.
    //
    // Scripted responses: the empty final response ends the first wake with
    // `emptyFinalResponse`, an EXCEPTIONAL stop, so ADR-0011's epilogue summary
    // round makes one more model call — that is the second entry. The third is
    // the second wake's answer.
    const fake = createFakeDeliveryManager();
    const { hub, id } = await boot({
      deps: makeDeps([
        assistantResult({ texts: [] }),
        assistantResult({ texts: ["summary"] }),
        assistantResult({ texts: ["delivered"] }),
      ]),
      fake,
    });
    fake.complete({
      conversationId: id,
      taskId: "none-save",
      summary: "none save",
    });

    const first = await hub.wakeFromSubagent({ conversationId: id });
    assert.notEqual(first, undefined);
    assert.equal(
      await digestCountOnDisk(id, digestFor("none-save")),
      0,
      "a none save writes no digest to the transcript"
    );
    assert.equal(
      fake.manager.drainCompleted(id).length,
      1,
      "the claim went back to claimable"
    );

    await hub.wakeFromSubagent({ conversationId: id });
    assert.equal(
      await digestCountOnDisk(id, digestFor("none-save")),
      1,
      "the later round offers and delivers it once"
    );
  });

  it("case 8: an abort after the digest write keeps it delivered", async () => {
    const fake = createFakeDeliveryManager();
    const baseDeps = makeDeps([assistantResult({ texts: ["never seen"] })]);
    const controller = new AbortController();
    const deps: LoopEngineDeps = {
      ...baseDeps,
      adapter: {
        ...baseDeps.adapter,
        // Abort at the first model request: strictly AFTER the accepted-input
        // commit that carries the digest.
        step: async (...args) => {
          controller.abort();
          return baseDeps.adapter.step(...args);
        },
      },
    };
    const { hub, id } = await boot({ deps, fake });
    fake.complete({
      conversationId: id,
      taskId: "abort-task",
      summary: "abort summary",
    });

    await hub.postMessage({
      conversationId: id,
      text: "go",
      signal: controller.signal,
    });

    assert.equal(
      await digestCountOnDisk(id, digestFor("abort-task")),
      1,
      "the digest write happened before the abort"
    );
    assert.equal(
      fake.manager.drainCompleted(id).length,
      0,
      "the acknowledged claim was not released by the abort"
    );
    assert.equal(
      fake.manager.drainCompleted(id, { includeDelivered: true }).length,
      1,
      "the generation is delivered, not lost"
    );

    await hub.postMessage({ conversationId: id, text: "again" });
    assert.equal(
      await digestCountOnDisk(id, digestFor("abort-task")),
      1,
      "a later turn does not duplicate it"
    );
  });

  it("case 9: a clean run persists the digest text exactly once", async () => {
    const fake = createFakeDeliveryManager();
    const { hub, id } = await boot({
      deps: makeDeps([assistantResult({ texts: ["ok"] })]),
      fake,
    });
    fake.complete({
      conversationId: id,
      taskId: "clean-task",
      summary: "clean summary",
    });

    await hub.postMessage({ conversationId: id, text: "go" });

    assert.equal(
      await digestCountOnDisk(id, digestFor("clean-task")),
      1,
      "the persisted history carries the digest exactly once"
    );
    // The prefix is the SSOT anchor the model-visible projection recognizes.
    assert.ok(
      (await digestCountOnDisk(
        id,
        "## Sub-agent clean-task result: clean summary"
      )) === 1
    );
  });
});
