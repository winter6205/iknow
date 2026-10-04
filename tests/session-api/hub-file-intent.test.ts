/**
 * ADR-0136 §3 item 4 at the host seam: a real write through the hub's own
 * engine records a DURABLE per-file intent, and a newly constructed store
 * reads it back. `createPreimageCapture` accepted `intentRecorder` as an
 * optional 4th dependency and the host left it unwired, so until now no
 * running host produced a `file_intent` record at all.
 *
 * Real hub, real `buildHarnessEngine` assembly, real tool executor, real
 * files. The model is not involved: the write is driven through the same
 * executor the model drives, so the capture side is exercised without
 * inventing a supplier. Nothing about the worker's own transcript path is
 * touched — that is a separate writer.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "vitest";

import { SessionHub } from "../../src/session-api/hub.ts";
import { SessionStore } from "../../src/session-api/store/index.ts";
import { createNoAskUser } from "../../src/harness/permission/ask-user.ts";
import type { IknowSettings } from "../../src/config/settings.js";
import type { LoopEngineDeps } from "../../src/harness/index.ts";

let baseDir: string;
let taskRoot: string;

beforeEach(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "iknow-hub-file-intent-"));
  taskRoot = await mkdtemp(join(tmpdir(), "iknow-hub-file-intent-root-"));
});

afterEach(async () => {
  await rm(baseDir, { recursive: true, force: true });
  await rm(taskRoot, { recursive: true, force: true });
});

const ensureDeps = (hub: SessionHub, root: string): Promise<LoopEngineDeps> =>
  (
    hub as unknown as { ensureDeps: (root?: string) => Promise<LoopEngineDeps> }
  ).ensureDeps.bind(hub)(root);

/** Real write through the hub's tool executor, the surface the model drives. */
async function writeThroughHub(
  hub: SessionHub,
  conversationId: string,
  toolUseId: string,
  path: string,
  content: string
): Promise<void> {
  const deps = await ensureDeps(hub, taskRoot);
  const [result] = await deps.executor.executeAll(
    [{ id: toolUseId, name: "write_file", input: { path, content } }],
    undefined,
    undefined,
    conversationId
  );
  assert.equal(result.kind, "ok", `write of ${path} did not land`);
}

const makeHub = async (settings?: IknowSettings): Promise<SessionHub> => {
  const store = new SessionStore(baseDir, taskRoot);
  const hub = new SessionHub({
    store,
    askUser: createNoAskUser(),
    workspaceRoot: taskRoot,
    ...(settings !== undefined ? { settings } : {}),
  });
  await hub.bindWorkspace(taskRoot);
  return hub;
};

/** Seed the persisted head the intent must anchor to (real store writes). */
const seedHead = async (
  store: SessionStore,
  conversationId: string
): Promise<void> => {
  await store.appendEvents({
    id: conversationId,
    events: [
      { role: "user", content: [{ type: "text", text: "write it" }] },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tu-seed",
            name: "write_file",
            input: { file_path: "seed.ts" },
          },
        ],
      },
    ],
  });
};

describe("durable file intent through the hub (R4)", () => {
  it("records a per-file intent a newly constructed store reads back", async () => {
    const store = new SessionStore(baseDir, taskRoot);
    const hub = await makeHub();
    const { session } = await hub.createSession();
    const id = session.conversation_id;
    await seedHead(store, id);

    await writeThroughHub(hub, id, "tu-a", "a.ts", "export const a = 1;\n");

    // Durability: read through a NEWLY CONSTRUCTED store over the same pool.
    const reopened = new SessionStore(baseDir, taskRoot);
    const selection = await reopened.loadPublishedNativeState({ id });
    assert.equal(selection.fileIntents.length, 1, "one durable intent record");
    const intent = selection.fileIntents[0]!.record;
    assert.equal(intent.type, "file_intent");
    assert.equal(intent.toolUseId, "tu-a");
    assert.equal(intent.captured, true);
    assert.equal(intent.targets.length, 1, "one association per target");
    const target = intent.targets[0]!;
    assert.equal(target.relPath, "a.ts");
    assert.equal(target.absentBefore, true, "the path did not exist before");
    assert.match(String(target.preimageSha), /^[0-9a-f]{64}$/);
    assert.match(String(target.postimageSha), /^[0-9a-f]{64}$/);
    // The anchor is a real committed event on the head chain.
    assert.ok(selection.messageEventIds.includes(intent.anchorEventId));
    // The write itself landed (the intent did not replace the tool's job).
    assert.equal(
      await readFile(join(taskRoot, "a.ts"), "utf8"),
      "export const a = 1;\n"
    );
  });

  it("keeps one record per target of a repeated write and adds no duplicate", async () => {
    const store = new SessionStore(baseDir, taskRoot);
    const hub = await makeHub();
    const { session } = await hub.createSession();
    const id = session.conversation_id;
    await seedHead(store, id);

    await writeThroughHub(hub, id, "tu-1", "one.ts", "one\n");
    await writeThroughHub(hub, id, "tu-2", "two.ts", "two\n");
    await writeThroughHub(hub, id, "tu-3", "three.ts", "three\n");

    const reopened = new SessionStore(baseDir, taskRoot);
    const { fileIntents } = await reopened.loadPublishedNativeState({ id });
    assert.equal(fileIntents.length, 3, "one record per captured target");
    const byTool = new Map(
      fileIntents.map((i) => [i.record.toolUseId, i.record])
    );
    assert.equal(byTool.size, 3, "no last-write-wins collapse per tool call");
    assert.deepEqual(
      [...byTool.values()].map((r) => r.targets[0]!.relPath).sort(),
      ["one.ts", "three.ts", "two.ts"]
    );
    // Every record keeps its own distinct evidence pair.
    const shas = [...byTool.values()].map(
      (r) => `${r.targets[0]!.preimageSha}/${r.targets[0]!.postimageSha}`
    );
    assert.equal(new Set(shas).size, 3, "no shared or reused association");
  });

  it("records an uncaptured intent (no evidence keys) when capture is disabled", async () => {
    const store = new SessionStore(baseDir, taskRoot);
    const hub = await makeHub({ codeRestore: { enabled: false } });
    const { session } = await hub.createSession();
    const id = session.conversation_id;
    await seedHead(store, id);

    await writeThroughHub(hub, id, "tu-a", "a.ts", "still written\n");

    const reopened = new SessionStore(baseDir, taskRoot);
    const { fileIntents } = await reopened.loadPublishedNativeState({ id });
    assert.equal(fileIntents.length, 1);
    const intent = fileIntents[0]!.record;
    assert.equal(intent.captured, false);
    const target = intent.targets[0]!;
    assert.equal(target.relPath, "a.ts");
    assert.equal(target.absentBefore, true);
    assert.equal(
      target.preimageSha,
      undefined,
      "an uncaptured target claims no evidence"
    );
    assert.equal(target.postimageSha, undefined);
    // Suppression is not a blocked write.
    assert.equal(
      await readFile(join(taskRoot, "a.ts"), "utf8"),
      "still written\n"
    );
  });
});
