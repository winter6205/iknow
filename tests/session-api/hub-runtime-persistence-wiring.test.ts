/**
 * ADR-0136 §3 at the composition root: the session hub IS the host for
 * harness runtime persistence. These tests pin the four properties that only
 * exist once the hub is the one hosting it:
 *
 *   1. the hub's own binder is the one the engine assembly receives, and both
 *      of its consumers (the loop's publications, a worker's fact) land in the
 *      session store;
 *   2. each of the four boundaries is published exactly once per turn;
 *   3. the writer queue is re-entrant, so a publication issued from inside the
 *      slot a turn already holds resolves, while a genuinely concurrent caller
 *      for the same conversation still queues;
 *   4. a rejected required write blocks the execution that depends on it, and a
 *      going-down host fails a publication instead of queueing it.
 *
 * Real `SessionStore` over a real temp tree. Every record is counted off disk
 * after parsing the real JSONL, so a second producer cannot hide.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, vi } from "vitest";

import type { NativeStateMessage } from "../../src/shared/native-state-port.ts";
import { isNativeStatePortError } from "../../src/shared/native-state-port.ts";
import type { RuntimePersistenceBinder } from "../../src/shared/runtime-persistence.ts";
import type { LoopEngineDeps } from "../../src/harness/index.ts";
import { assistantResult, makeDeps, makeNative } from "../cli/_fixtures.ts";
import { createNoAskUser } from "../../src/harness/permission/index.ts";

/** Options the hub hands `buildHarnessEngine`, captured for the wiring asserts. */
const assembly = vi.hoisted(() => ({
  options: [] as ReadonlyArray<{
    runtimePersistence?: RuntimePersistenceBinder<NativeStateMessage>;
  }>,
  deps: undefined as LoopEngineDeps | undefined,
}));

vi.mock("../../src/harness/build-engine.ts", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../../src/harness/build-engine.ts")>();
  return {
    ...original,
    // Only the assembly call is intercepted: the hub's wiring of the options is
    // what is under test, and the real loop still runs on the stub deps.
    buildHarnessEngine: async (
      opts: Parameters<typeof original.buildHarnessEngine>[0]
    ) => {
      assembly.options = [...assembly.options, opts];
      return { deps: assembly.deps };
    },
  };
});

import { SessionHub } from "../../src/session-api/hub.ts";
import {
  parseSessionJsonl,
  resolveConversationDir,
  resolveProjectSessionDir,
  SESSION_JSONL_EXT,
  SessionStore,
} from "../../src/session-api/store/index.ts";
import type {
  SessionNativeStateRecord,
  SessionOperationFactRecord,
} from "../../src/session-api/store/index.ts";

let baseDir: string;
let taskRoot: string;
let projectDir: string;
let store: SessionStore;

const conversationDir = (id: string): string =>
  resolveConversationDir({ projectDir, conversationId: id });
const jsonlFor = (id: string): string =>
  join(conversationDir(id), `${id}${SESSION_JSONL_EXT}`);

beforeEach(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "iknow-hub-persist-wire-"));
  taskRoot = await mkdtemp(join(tmpdir(), "iknow-hub-persist-wire-root-"));
  projectDir = resolveProjectSessionDir(baseDir, taskRoot);
  store = new SessionStore(baseDir, taskRoot);
  assembly.options = [];
  assembly.deps = undefined;
});

afterEach(async () => {
  await rm(baseDir, { recursive: true, force: true });
  await rm(taskRoot, { recursive: true, force: true });
});

const publishedRecords = async (
  id: string
): Promise<ReadonlyArray<SessionNativeStateRecord>> => {
  const log = parseSessionJsonl(await readFile(jsonlFor(id), "utf8"));
  return log.records.filter(
    (r): r is SessionNativeStateRecord => r.type === "native_state"
  );
};

const boundariesOf = async (id: string): Promise<ReadonlyArray<string>> =>
  (await publishedRecords(id)).map((r) => r.boundary);

const factRecords = async (
  id: string
): Promise<ReadonlyArray<SessionOperationFactRecord>> => {
  const log = parseSessionJsonl(await readFile(jsonlFor(id), "utf8"));
  return log.records.filter(
    (r): r is SessionOperationFactRecord => r.type === "operation_fact"
  );
};

/** Fail loudly instead of hanging: a deadlocked writer queue is a regression
 *  this suite must report, not one it waits out. */
const withDeadline = async <T>(
  work: Promise<T>,
  label: string,
  ms = 5_000
): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(new Error(`deadlock: ${label} did not settle in ${ms}ms`)),
          ms
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

const deferred = (): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

/** The hub's writer queue, reached the way a same-module test reaches it. */
const queueOf = (
  hub: InstanceType<typeof SessionHub>
): (<T>(opts: {
  readonly conversationId: string;
  readonly work: () => Promise<T>;
}) => Promise<T>) =>
  (
    hub as unknown as {
      serialize: <T>(opts: {
        readonly conversationId: string;
        readonly work: () => Promise<T>;
      }) => Promise<T>;
    }
  ).serialize.bind(hub);

describe("runtime persistence wiring (ADR-0136 §3)", () => {
  it("hands engine assembly the hub's binder, and both consumers reach the store", async () => {
    assembly.deps = makeDeps([assistantResult({ texts: ["ok"] })]);
    const hub = new SessionHub({
      store,
      surface: "serve",
      workspaceRoot: taskRoot,
      askUser: createNoAskUser(),
    });
    await hub.bindWorkspace(taskRoot);
    const { session } = await hub.createSession();
    const id = session.conversation_id;

    await withDeadline(
      hub.postMessage({ conversationId: id, text: "persist me" }),
      "turn under the served engine"
    );

    const binder = assembly.options.at(0)?.runtimePersistence;
    assert.ok(binder, "the engine assembly receives a persistence binder");
    // The loop's own consumer: a boundary publication on disk.
    assert.deepEqual(await boundariesOf(id), ["input", "terminal"]);
    // The worker's consumer, through the same binder the manager is given.
    const sink = binder.bind(id);
    assert.ok(sink, "a session id binds a sink");
    await sink.appendOperationFact({
      kind: "worker_progress",
      taskId: "task-1",
      ownership: "background",
      state: "running",
    });
    const facts = await factRecords(id);
    assert.equal(facts.length, 1, "the worker fact reached the store");
    assert.equal(facts[0]?.fact.kind, "worker_progress");
  });

  it("lands input, tool batch and terminal exactly once for a turn with a tool", async () => {
    const hub = new SessionHub({
      store,
      deps: makeDeps([
        assistantResult({
          texts: ["calling"],
          toolCalls: [{ id: "call-1", name: "noop", input: {} }],
        }),
        assistantResult({ texts: ["done"] }),
      ]),
      workspaceRoot: taskRoot,
    });
    await hub.bindWorkspace(taskRoot);
    const { session } = await hub.createSession();
    const id = session.conversation_id;

    await withDeadline(
      hub.postMessage({ conversationId: id, text: "use a tool" }),
      "turn with a settled tool batch"
    );

    assert.deepEqual(await boundariesOf(id), [
      "input",
      "tool_batch",
      "terminal",
    ]);
  });

  it("lands the compaction boundary exactly once when the loop compacts", async () => {
    const hub = new SessionHub({
      store,
      deps: {
        ...makeDeps([assistantResult({ texts: ["ok"] })]),
        // Threshold far below the estimate → the gate fires on turn 0.
        compress: { contextWindow: 200_000, thresholdTokens: 1 },
      },
      workspaceRoot: taskRoot,
    });
    await hub.bindWorkspace(taskRoot);
    const { session } = await hub.createSession();
    const id = session.conversation_id;
    await store.appendEvents({
      id,
      events: Array.from({ length: 12 }, (_, i) =>
        makeNative({ role: "user", text: `prior-${String(i)}` })
      ),
    });

    await withDeadline(
      hub.postMessage({ conversationId: id, text: "compact me" }),
      "turn whose loop compacts"
    );

    // The compaction gate runs BEFORE the accepted-input publication, so the
    // input state that follows is the post-compaction context — the reason the
    // engine, not the host, publishes this boundary.
    assert.deepEqual(await boundariesOf(id), [
      "compaction",
      "input",
      "terminal",
    ]);
  });

  it("runs a publication issued from inside the slot the caller already holds", async () => {
    const hub = new SessionHub({
      store,
      deps: makeDeps([assistantResult({ texts: ["ok"] })]),
      workspaceRoot: taskRoot,
    });
    await hub.bindWorkspace(taskRoot);
    const { session } = await hub.createSession();
    const queue = queueOf(hub);
    const order: string[] = [];

    await withDeadline(
      queue({
        conversationId: session.conversation_id,
        work: async () => {
          order.push("outer:start");
          // Re-entrant: inline, not chained behind the slot this work holds.
          await queue({
            conversationId: session.conversation_id,
            work: async () => {
              order.push("inner");
            },
          });
          order.push("outer:end");
        },
      }),
      "re-entrant writer queue"
    );

    assert.deepEqual(order, ["outer:start", "inner", "outer:end"]);
  });

  it("still serializes concurrent work per conversation while another runs", async () => {
    const hub = new SessionHub({
      store,
      deps: makeDeps([
        assistantResult({ texts: ["ok"] }),
        assistantResult({ texts: ["ok"] }),
      ]),
      workspaceRoot: taskRoot,
    });
    await hub.bindWorkspace(taskRoot);
    const first = (await hub.createSession()).session.conversation_id;
    const second = (await hub.createSession()).session.conversation_id;
    const queue = queueOf(hub);
    const gate = deferred();
    const order: string[] = [];

    const running = queue({
      conversationId: first,
      work: async () => {
        order.push("first:start");
        await gate.promise;
        order.push("first:end");
      },
    });
    // Another conversation must not wait on the first one's slot.
    await withDeadline(
      queue({
        conversationId: second,
        work: async () => {
          order.push("second");
        },
      }),
      "second conversation"
    );
    assert.deepEqual(order, ["first:start", "second"]);

    // A second caller on the held conversation queues behind it: it arrives
    // from outside the slot, so re-entrancy must not apply to it.
    const queued = queue({
      conversationId: first,
      work: async () => {
        order.push("first:second");
      },
    });
    gate.resolve();
    await withDeadline(Promise.all([running, queued]), "queued same-id work");
    assert.deepEqual(order, [
      "first:start",
      "second",
      "first:end",
      "first:second",
    ]);
  });

  it("exposes a session-scoped owned-worker sweep the open path can call", async () => {
    const hub = new SessionHub({
      store,
      deps: makeDeps([assistantResult({ texts: ["ok"] })]),
      workspaceRoot: taskRoot,
    });
    await hub.bindWorkspace(taskRoot);
    const { session } = await hub.createSession();
    const id = session.conversation_id;
    await withDeadline(
      hub.postMessage({ conversationId: id, text: "no workers here" }),
      "turn before the sweep"
    );

    // The hook resolves the session's own subagents root and filters by the
    // session id, so a session with no worker records reports an empty sweep
    // instead of reaching for any other session's.
    const swept = await withDeadline(
      hub.sweepOwnedWorkersForSession(id),
      "owned-worker sweep"
    );
    assert.deepEqual(swept.workers, []);
    assert.deepEqual(swept.excluded, []);
    assert.deepEqual(await boundariesOf(id), ["input", "terminal"]);
  });

  it("fails a publication issued after shutdown instead of queueing it", async () => {
    assembly.deps = makeDeps([assistantResult({ texts: ["ok"] })]);
    const hub = new SessionHub({
      store,
      surface: "serve",
      workspaceRoot: taskRoot,
      askUser: createNoAskUser(),
    });
    await hub.bindWorkspace(taskRoot);
    const { session } = await hub.createSession();
    const id = session.conversation_id;
    await withDeadline(
      hub.postMessage({ conversationId: id, text: "first" }),
      "pre-shutdown turn"
    );
    const sink = assembly.options.at(0)?.runtimePersistence?.bind(id);
    assert.ok(sink, "a session id binds a sink");

    await hub.shutdown();

    await assert.rejects(
      () =>
        withDeadline(
          sink.publishSavedState({
            boundary: "terminal_turn",
            turnId: null,
            messages: [],
            terminal: { stopReason: "completed" },
          }),
          "post-shutdown publication"
        ),
      (err: unknown) => {
        assert.ok(
          isNativeStatePortError(err) && err.code === "PERSIST_FAILED",
          `expected a fast PERSIST_FAILED, got ${String(err)}`
        );
        return true;
      }
    );
  });

  it("issues no dependent model dispatch after a rejected required write", async () => {
    let calls = 0;
    const base = makeDeps([
      assistantResult({
        texts: ["calling"],
        toolCalls: [{ id: "call-1", name: "noop", input: {} }],
      }),
      assistantResult({ texts: ["must not run"] }),
    ]);
    const step = base.adapter.step.bind(base.adapter);
    let faultedId: (() => string) | undefined;
    const hub = new SessionHub({
      store,
      deps: {
        ...base,
        adapter: {
          ...base.adapter,
          step: async (...args: Parameters<typeof step>) => {
            calls += 1;
            // Real FS fault introduced after the accepted-input publication
            // already landed, so the SETTLED-BATCH write is the one rejected —
            // the second dispatch is the execution that depends on it.
            if (calls === 1 && faultedId !== undefined) {
              const pool = join(conversationDir(faultedId()), "blobs");
              await rm(pool, { recursive: true, force: true });
              await writeFile(pool, "not a directory", "utf8");
            }
            return step(...args);
          },
        },
      },
      workspaceRoot: taskRoot,
    });
    await hub.bindWorkspace(taskRoot);
    const { session } = await hub.createSession();
    faultedId = () => session.conversation_id;

    await assert.rejects(
      () =>
        withDeadline(
          hub.postMessage({ conversationId: faultedId(), text: "persist me" }),
          "turn with a failing publication"
        ),
      (err: unknown) => {
        assert.ok(
          isNativeStatePortError(err),
          `expected the store's typed error, got ${String(err)}`
        );
        return true;
      }
    );
    assert.equal(
      calls,
      1,
      "the first request ran; the one after the rejected write did not"
    );
    assert.deepEqual(
      await boundariesOf(faultedId()),
      ["input"],
      "the accepted input was published; the batch boundary never was"
    );
  });
});
