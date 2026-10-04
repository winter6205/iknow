/**
 * ADR-0136 §3: ONE publisher per boundary. The hub commits the accepted input;
 * the engine publishes the boundary. When both published, one accepted message
 * wrote two `input` states, and the selected one could be the host's
 * pre-compaction copy of a context the engine never sent.
 *
 * Every assertion counts real records parsed off disk in a real session file —
 * no port mock, so a second producer cannot hide behind a stub. The gate cases
 * assert the absence of publication through the store's own state, not through a
 * spy on a seam.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "vitest";

import { SessionHub } from "../../src/session-api/hub.ts";
import {
  parseSessionJsonl,
  resolveConversationDir,
  resolveProjectSessionDir,
  SESSION_JSONL_EXT,
  SessionStore,
  type SessionFileV1,
  type SessionNativeStateRecord,
} from "../../src/session-api/store/index.ts";
import type { NativeStateMessage } from "../../src/shared/native-state-port.ts";
import type { SubAgentEnvelope } from "../../src/harness/subagent/envelope.ts";
import type { SubAgentManager } from "../../src/harness/subagent/manager.ts";
import { createSubAgentMailbox } from "../../src/harness/subagent/mailbox.ts";
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
  await rm(baseDir, { recursive: true, force: true });
  await rm(taskRoot, { recursive: true, force: true });
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

/** A manager holding one completed sub-agent result, as the real manager's
 *  buffer does: drain never consumes, so the digest is delivered at every run
 *  boundary until the manager shuts down. */
function managerWithResult(summary: string): SubAgentManager {
  const mailbox = createSubAgentMailbox();
  const envelope: SubAgentEnvelope = {
    status: "ok",
    summary,
    result: `${summary} result`,
  };
  const buffer: ReadonlyArray<{
    readonly taskId: string;
    readonly envelope: SubAgentEnvelope;
  }> = [{ taskId: "wake-task", envelope }];
  return {
    spawn: () => ({ taskId: "wake-task" }),
    queryBuffer: () => ({ status: "not_found" }),
    waitFor: async () => {
      throw new Error("unused");
    },
    shutdown: async () => {},
    drainCompleted: () => buffer,
    listActive: () => [],
    abortTask: () => false,
    getCapacity: () => 15,
    listSubagents: () => [],
    subscribe: mailbox.subscribe,
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
    const hub = new SessionHub({
      store,
      deps: makeDeps([
        assistantResult({ texts: ["ok"] }),
        assistantResult({ texts: ["woken"] }),
      ]),
      workspaceRoot: taskRoot,
      subagentManager: managerWithResult("worker summary"),
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
