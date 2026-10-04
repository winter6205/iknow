/**
 * ADR-0136 §3 item 2 + §4: the hub publishes the accepted-input native state
 * BEFORE the first model request, and the session-entry surfaces classify the
 * recovery outcome on the wire (SC1a, SC2, SC6, SC7, SC23, SC27).
 *
 * Real `SessionStore` over a real temp tree, the real hub, the real
 * filesystem. The model is the only stub: a scripted stub adapter behind a
 * call counter, so "publication failed → no model request" is an observation,
 * not an inference. Failures are injected on the real filesystem (a file
 * where the body directory must be; a deleted body blob), never by mocking
 * the store.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, it } from "vitest";

import { SessionHub } from "../../src/session-api/hub.ts";
import {
  messageEventId,
  NATIVE_STATE_FORMAT_VERSION,
  parseSessionJsonl,
  resolveConversationDir,
  resolveProjectSessionDir,
  SESSION_JSONL_EXT,
  SessionStore,
  type SessionFileV1,
  type SessionNativeStateRecord,
} from "../../src/session-api/store/index.ts";
import { RECOVERY_IN_PROGRESS_LABEL } from "../../src/session-api/store/recovery-status.ts";
import type {
  AssistantTurnResult,
  LoopEngineDeps,
} from "../../src/harness/index.ts";
import { isNativeStatePortError } from "../../src/shared/native-state-port.ts";
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
  baseDir = await mkdtemp(join(tmpdir(), "iknow-hub-input-ckpt-"));
  taskRoot = await mkdtemp(join(tmpdir(), "iknow-hub-input-ckpt-root-"));
  projectDir = resolveProjectSessionDir(baseDir, taskRoot);
  store = new SessionStore(baseDir, taskRoot);
});

afterEach(async () => {
  await rm(baseDir, { recursive: true, force: true });
  await rm(taskRoot, { recursive: true, force: true });
});

/** The scripted stub model behind a call counter — the only stub here. */
function countingDeps(responses: AssistantTurnResult[]): {
  readonly deps: LoopEngineDeps;
  readonly modelCalls: () => number;
} {
  const base = makeDeps(responses);
  let calls = 0;
  const step = base.adapter.step.bind(base.adapter);
  return {
    deps: {
      ...base,
      adapter: {
        ...base.adapter,
        step: (...args: Parameters<typeof step>) => {
          calls += 1;
          return step(...args);
        },
      },
    },
    modelCalls: () => calls,
  };
}

const makeHub = (deps: LoopEngineDeps): SessionHub =>
  new SessionHub({ store, deps, workspaceRoot: taskRoot });

const nativeStateRecords = async (
  id: string
): Promise<ReadonlyArray<SessionNativeStateRecord>> => {
  const log = parseSessionJsonl(await readFile(jsonlFor(id), "utf8"));
  return log.records.filter(
    (r): r is SessionNativeStateRecord => r.type === "native_state"
  );
};

/** Real records at ONE boundary, counted off disk — never off a mocked port. */
const nativeStateRecordsAt = async (
  id: string,
  boundary: SessionNativeStateRecord["boundary"]
): Promise<ReadonlyArray<SessionNativeStateRecord>> =>
  (await nativeStateRecords(id)).filter((r) => r.boundary === boundary);

const boundariesOf = async (id: string): Promise<ReadonlyArray<string>> =>
  (await nativeStateRecords(id)).map((r) => r.boundary);

/** Every byte under the session folder, for the SC27 before/after compare. */
async function treeBytes(root: string): Promise<ReadonlyMap<string, string>> {
  const out = new Map<string, string>();
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else out.set(relative(root, full), await readFile(full, "utf8"));
    }
  };
  await walk(root);
  return out;
}

describe("accepted-input checkpoint (SC2, R1)", () => {
  it("stamps the new-format marker on a created session and keeps it absent on an old-format one", async () => {
    const { deps } = countingDeps([assistantResult({ texts: ["ok"] })]);
    const hub = makeHub(deps);
    await hub.bindWorkspace(taskRoot);
    const { session } = await hub.createSession();
    const file = await store.load(session.conversation_id);
    assert.equal(file.nativeStateFormat, NATIVE_STATE_FORMAT_VERSION);
    const header = parseSessionJsonl(
      await readFile(jsonlFor(session.conversation_id), "utf8")
    ).header;
    assert.equal(header.nativeStateFormat, NATIVE_STATE_FORMAT_VERSION);
  });

  it("publishes the input boundary anchored at the accepted input's own event, before any model request", async () => {
    const { deps, modelCalls } = countingDeps([
      assistantResult({ texts: ["answered"] }),
    ]);
    const hub = makeHub(deps);
    await hub.bindWorkspace(taskRoot);
    const { session } = await hub.createSession();
    const id = session.conversation_id;

    await hub.postMessage({ conversationId: id, text: "remember this" });
    assert.equal(modelCalls(), 1);

    const records = await nativeStateRecordsAt(id, "input");
    assert.equal(records.length, 1, "one accepted message, one input state");
    const record = records[0]!;
    assert.equal(record.boundary, "input");
    // The engine is the sole producer of the input boundary, and it publishes
    // the other boundaries of the same turn exactly once each.
    assert.deepEqual(await boundariesOf(id), ["input", "terminal"]);

    // The anchor is the accepted input's OWN event, and it is on the head
    // chain (the only authority selection consults). Selection itself resolves
    // to the turn's last boundary, whose anchor is that same chain.
    const fresh = new SessionStore(baseDir, taskRoot);
    const selection = await fresh.loadPublishedNativeState({ id });
    assert.ok(selection.selected, "the published state is selectable");
    const terminal = (await nativeStateRecordsAt(id, "terminal"))[0]!;
    assert.equal(selection.selected.anchorEventId, terminal.anchorEventId);
    assert.ok(
      selection.messageEventIds.includes(terminal.anchorEventId),
      "anchor is on the head chain"
    );
    assert.ok(
      selection.messageEventIds.includes(record.anchorEventId),
      "the input boundary's own anchor is on the head chain too"
    );
    const anchored = parseSessionJsonl(await readFile(jsonlFor(id), "utf8"));
    const anchorEvent = anchored.events.find(
      (e) => e.id === record.anchorEventId
    );
    assert.equal(anchorEvent?.message.role, "user");

    // The body is the exact native sequence at that boundary: the session's
    // own committed chain up to and including the accepted input.
    const body = await fresh.readPublishedNativeStateBody({
      id,
      bodySha: record.bodySha,
    });
    assert.equal(body.boundary, "input");
    assert.equal(body.messages.length, record.messageCount);
    const chain = parseSessionJsonl(await readFile(jsonlFor(id), "utf8"));
    const head = chain.events;
    const upToAnchor = head.slice(
      0,
      head.findIndex((e) => e.id === record.anchorEventId) + 1
    );
    assert.deepEqual(
      body.messages,
      upToAnchor.map((e) => e.message)
    );
    assert.equal(
      body.messages.at(-1)?.content[0]?.type === "text"
        ? (body.messages.at(-1)!.content[0] as { text: string }).text
        : "",
      "remember this"
    );
    // No turn identity is synthesized at a boundary that has none.
    assert.equal(body.turnId, undefined);
    assert.equal(body.runtimeFacts, undefined);
  });

  it("surfaces a publication failure and issues no model request (dependent call blocked)", async () => {
    const { deps, modelCalls } = countingDeps([
      assistantResult({ texts: ["must not run"] }),
    ]);
    const hub = makeHub(deps);
    await hub.bindWorkspace(taskRoot);
    const { session } = await hub.createSession();
    const id = session.conversation_id;

    // Real FS fault: a regular file where the body pool directory must be, so
    // the required body write cannot complete.
    await writeFile(
      join(conversationDir(id), "blobs"),
      "not a directory",
      "utf8"
    );

    await assert.rejects(
      () => hub.postMessage({ conversationId: id, text: "persist me" }),
      (err: unknown) => {
        assert.ok(
          isNativeStatePortError(err),
          `expected NativeStatePortError, got ${String(err)}`
        );
        assert.equal(err.code, "PERSIST_FAILED");
        return true;
      }
    );
    assert.equal(
      modelCalls(),
      0,
      "no model request after a failed publication"
    );
    assert.equal(
      (await nativeStateRecords(id)).length,
      0,
      "nothing is published when the body write fails"
    );
    // The accepted input itself is durable (ADR-0136 keeps the input but never
    // resends the request automatically).
    const log = parseSessionJsonl(await readFile(jsonlFor(id), "utf8"));
    assert.ok(
      log.events.some((e) =>
        e.message.content.some(
          (b) => b.type === "text" && b.text === "persist me"
        )
      ),
      "the accepted input is committed to the session log"
    );
  });

  it("gates publication on the format: an old-format session is neither published to nor relabelled", async () => {
    const { deps } = countingDeps([
      assistantResult({ texts: ["ok"] }),
      assistantResult({ texts: ["ok"] }),
    ]);
    const hub = makeHub(deps);
    await hub.bindWorkspace(taskRoot);
    const newFormat = (await hub.createSession()).session.conversation_id;
    const id = (await hub.createSession()).session.conversation_id;

    // Fixture: an old-format session (the field is absent — the only way a
    // session is old-format, since `save` never stamps it).
    const oldFile: SessionFileV1 = { ...(await store.load(id)) };
    delete (oldFile as { nativeStateFormat?: number }).nativeStateFormat;
    await store.save({ id, file: oldFile });

    // Identical turn in both sessions: only the new-format one publishes.
    await hub.postMessage({ conversationId: id, text: "old format turn" });
    await hub.postMessage({
      conversationId: newFormat,
      text: "new format turn",
    });

    assert.equal((await store.load(id)).nativeStateFormat, undefined);
    assert.equal(
      (await nativeStateRecords(id)).length,
      0,
      "no native state is written into an old-format session"
    );
    assert.equal(
      (await nativeStateRecordsAt(newFormat, "input")).length,
      1,
      "the same turn in a new-format session publishes its input boundary"
    );
  });
});

describe("session-entry recovery status (R3)", () => {
  it("reports no_published_state for a new session that has taken no turn", async () => {
    const { deps, modelCalls } = countingDeps([]);
    const hub = makeHub(deps);
    await hub.bindWorkspace(taskRoot);
    const { session } = await hub.createSession();
    const view = await hub.getSession(session.conversation_id);
    assert.deepEqual(view.session.recovery, {
      status: "no_published_state",
      operations: [],
    });
    assert.equal(modelCalls(), 0, "entry recovery issues no model request");
  });

  it("reports recovered after a turn, with the saved context counted", async () => {
    const { deps, modelCalls } = countingDeps([
      assistantResult({ texts: ["answered"] }),
    ]);
    const hub = makeHub(deps);
    await hub.bindWorkspace(taskRoot);
    const { session } = await hub.createSession();
    const id = session.conversation_id;
    await hub.postMessage({ conversationId: id, text: "first input" });

    const view = await hub.getSession(id);
    assert.deepEqual(view.session.recovery, {
      status: "recovered",
      operations: [],
    });
    assert.equal(modelCalls(), 1, "only the turn's own request, none on entry");
    // The rewind head is untouched by recovery.
    assert.deepEqual(
      view.turns.map((t) => t.query),
      ["first input"]
    );
  });

  it("shows the in-progress label as a transient while the recovery promise is in flight", async () => {
    const labels: string[] = [];
    const { deps } = countingDeps([assistantResult({ texts: ["answered"] })]);
    const hub = new SessionHub({
      store,
      deps,
      workspaceRoot: taskRoot,
      onRecoveryProgress: (label) => labels.push(label),
    });
    await hub.bindWorkspace(taskRoot);
    const { session } = await hub.createSession();
    const id = session.conversation_id;
    await hub.postMessage({ conversationId: id, text: "hello" });

    const view = await hub.getSession(id);
    assert.deepEqual(labels, [RECOVERY_IN_PROGRESS_LABEL]);
    // The transient never resolves as a status.
    assert.notEqual(view.session.recovery?.status, RECOVERY_IN_PROGRESS_LABEL);
    assert.equal(view.session.recovery?.status, "recovered");
  });

  it("reports blocked (fail-closed) when the selected state's body is gone", async () => {
    const { deps } = countingDeps([assistantResult({ texts: ["answered"] })]);
    const hub = makeHub(deps);
    await hub.bindWorkspace(taskRoot);
    const { session } = await hub.createSession();
    const id = session.conversation_id;
    await hub.postMessage({ conversationId: id, text: "hello" });

    // The SELECTED publication's body is the one recovery must fail closed on.
    const selected = await store.loadPublishedNativeState({ id });
    assert.ok(selected.selected, "the turn published a selectable state");
    await rm(
      join(conversationDir(id), "blobs", "native", selected.selected.bodySha),
      { force: true }
    );

    const view = await hub.getSession(id);
    const status = view.session.recovery;
    assert.equal(status?.status, "blocked");
    assert.equal(
      status?.status === "blocked" ? status.reason : "",
      "published_state_body_missing"
    );
  });

  it("reports unsupported_format for an old-format session and leaves its bytes alone", async () => {
    const { deps } = countingDeps([]);
    const hub = makeHub(deps);
    await hub.bindWorkspace(taskRoot);
    const { session } = await hub.createSession();
    const id = session.conversation_id;
    const oldFile = { ...(await store.load(id)) };
    delete (oldFile as { nativeStateFormat?: number }).nativeStateFormat;
    await store.save({ id, file: oldFile });
    const before = await readFile(jsonlFor(id), "utf8");

    const view = await hub.getSession(id);
    assert.deepEqual(view.session.recovery, {
      status: "unsupported_format",
      operations: [],
    });
    assert.equal(
      await readFile(jsonlFor(id), "utf8"),
      before,
      "opening an old-format session rewrites nothing"
    );
  });

  it("reports needs handling with the affected operation", async () => {
    const { deps } = countingDeps([]);
    const hub = makeHub(deps);
    await hub.bindWorkspace(taskRoot);
    const { session } = await hub.createSession();
    const id = session.conversation_id;
    // Fixture: a published state plus a post-anchor intent whose recorded root
    // identity is not this host's live root (ADR-0121 skip → operator needed).
    await store.appendEvents({
      id,
      events: [
        { role: "user", content: [{ type: "text", text: "write a.ts" }] },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tu-1",
              name: "write_file",
              input: { file_path: "a.ts" },
            },
          ],
        },
      ],
    });
    // The published state sits at the INPUT boundary (the user event), so the
    // later intent is genuinely post-anchor and must be reconciled.
    const anchor = (await store.readHead(id))!;
    await store.appendNativeState({
      id,
      anchorEventId: messageEventId(0),
      boundary: "input",
      snapshot: {
        boundary: "input",
        messages: [
          { role: "user", content: [{ type: "text", text: "write a.ts" }] },
        ],
      },
    });
    assert.ok(anchor);
    await writeFile(join(taskRoot, "a.ts"), "live bytes", "utf8");
    await store.appendFileIntent({
      id,
      toolUseId: "tu-1",
      captured: true,
      targets: [
        {
          relPath: "a.ts",
          rootIdentity: "/some/other/root",
          absentBefore: true,
          preimageSha: "0".repeat(64),
          postimageSha: "1".repeat(64),
        },
      ],
    });

    const view = await hub.getSession(id);
    const status = view.session.recovery;
    assert.equal(status?.status, "needs handling");
    if (status?.status === "needs handling") {
      assert.equal(status.handling.length, 1);
      assert.equal(status.handling[0]?.toolUseId, "tu-1");
      assert.equal(status.handling[0]?.relPath, "a.ts");
      assert.equal(status.handling[0]?.reason, "root_identity_mismatch");
    }
    // The live file is never rewritten by recovery.
    assert.equal(await readFile(join(taskRoot, "a.ts"), "utf8"), "live bytes");
  });
});

describe("repeated session entry (SC27)", () => {
  it("adds no record, republishes nothing, and changes no byte on a second open", async () => {
    const { deps, modelCalls } = countingDeps([
      assistantResult({ texts: ["answered"] }),
    ]);
    const hub = makeHub(deps);
    await hub.bindWorkspace(taskRoot);
    const { session } = await hub.createSession();
    const id = session.conversation_id;
    await hub.postMessage({ conversationId: id, text: "hello" });

    const first = await hub.getSession(id);
    const before = await treeBytes(conversationDir(id));
    const second = await hub.getSession(id);
    const after = await treeBytes(conversationDir(id));

    assert.deepEqual(after, before, "a second open changes no byte");
    assert.deepEqual(second.session.recovery, first.session.recovery);
    assert.deepEqual(await boundariesOf(id), ["input", "terminal"]);
    assert.equal(modelCalls(), 1, "no extra model request on re-entry");
  });

  it("keeps a needs-handling session at needs handling with the same items", async () => {
    const { deps, modelCalls } = countingDeps([]);
    const hub = makeHub(deps);
    await hub.bindWorkspace(taskRoot);
    const { session } = await hub.createSession();
    const id = session.conversation_id;
    await store.appendEvents({
      id,
      events: [
        { role: "user", content: [{ type: "text", text: "write a.ts" }] },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tu-1",
              name: "write_file",
              input: { file_path: "a.ts" },
            },
          ],
        },
      ],
    });
    await store.appendNativeState({
      id,
      anchorEventId: messageEventId(0),
      boundary: "input",
      snapshot: {
        boundary: "input",
        messages: [
          { role: "user", content: [{ type: "text", text: "write a.ts" }] },
        ],
      },
    });
    await store.appendFileIntent({
      id,
      toolUseId: "tu-1",
      captured: true,
      targets: [
        {
          relPath: "a.ts",
          rootIdentity: "/some/other/root",
          absentBefore: true,
          preimageSha: "0".repeat(64),
          postimageSha: "1".repeat(64),
        },
      ],
    });

    const first = await hub.getSession(id);
    const before = await treeBytes(conversationDir(id));
    const second = await hub.getSession(id);
    const after = await treeBytes(conversationDir(id));

    assert.equal(first.session.recovery?.status, "needs handling");
    assert.deepEqual(second.session.recovery, first.session.recovery);
    assert.deepEqual(after, before, "no repeated file mutation or record");
    assert.equal(modelCalls(), 0);
  });
});
