/**
 * ADR-0119: `SessionStore.rewindablePreimages` — the abandoned segment a
 * rewind would restore.
 *
 * Locked here:
 *   - returns only the current-chain events that carry a preimage AND fall
 *     outside the chain kept under `newHead`, in current-chain order.
 *   - a legacy `.json`-only session (no JSONL) returns empty rather than
 *     throwing — capture is JSONL-only, so there is nothing to restore.
 *   - an unknown `newHead` surfaces as schema_invalid (same as rewindToHead).
 *   - read-only: it never moves the head.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";

import {
  CURRENT_SCHEMA_VERSION,
  resolveConversationDir,
  resolveProjectSessionDir,
  SESSION_JSONL_EXT,
  SessionStore,
} from "../../../src/session-api/store/index.ts";
import type {
  SessionEventRecord,
  SessionStoreError,
} from "../../../src/session-api/store/index.ts";
import type { AnthropicNativeMessage } from "../../../src/harness/index.ts";

let store: SessionStore;
let baseDir: string;
let sessionDir: string;

const text = (t: string): AnthropicNativeMessage => ({
  role: "assistant",
  content: [{ type: "text", text: t }],
});

function event(id: string, parent: string | null, withPreimage: boolean) {
  const rec: SessionEventRecord = {
    type: "message",
    id,
    parent,
    message: text(id),
    ...(withPreimage
      ? {
          codePreimage: {
            relPath: "a.ts",
            rootIdentity: "/root",
            preimageSha: `pre-${id}`,
            postimageSha: `post-${id}`,
          },
        }
      : {}),
  };
  return rec;
}

async function seed(
  id: string,
  events: ReadonlyArray<SessionEventRecord>,
  head: string | null
): Promise<void> {
  const dir = resolveConversationDir({
    projectDir: sessionDir,
    conversationId: id,
  });
  await mkdir(dir, { recursive: true });
  const header = {
    type: "session",
    schemaVersion: CURRENT_SCHEMA_VERSION,
    conversation_id: id,
    title: "",
    cwd: "/tmp",
    sanitized_at: "2026-01-01T00:00:00.000Z",
    jsonMode: false,
    turnCount: 1,
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const lines = [
    JSON.stringify(header),
    ...events.map((e) => JSON.stringify(e)),
    JSON.stringify({ type: "head", id: head }),
  ];
  await writeFile(
    join(dir, `${id}${SESSION_JSONL_EXT}`),
    `${lines.join("\n")}\n`,
    "utf8"
  );
}

beforeAll(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "iknow-rewindable-"));
  sessionDir = resolveProjectSessionDir(baseDir, process.cwd());
  store = new SessionStore(baseDir, process.cwd());
});

afterAll(async () => {
  await rm(baseDir, { recursive: true, force: true });
});

describe("SessionStore.rewindablePreimages", () => {
  it("returns preimage events after the kept head, in chain order", async () => {
    const id = "rp-tail";
    await seed(
      id,
      [
        event("e0", null, false),
        event("e1", "e0", true),
        event("e2", "e1", false),
        event("e3", "e2", true),
      ],
      "e3"
    );
    const out = await store.rewindablePreimages(id, "e1");
    assert.deepEqual(
      out.map((e) => e.id),
      ["e3"],
      "only preimage events after e1 on the kept chain"
    );
  });

  it("newHead=null abandons every preimage event on the chain", async () => {
    const id = "rp-null";
    await seed(id, [event("e0", null, true), event("e1", "e0", true)], "e1");
    const out = await store.rewindablePreimages(id, null);
    assert.deepEqual(
      out.map((e) => e.codePreimage?.preimageSha),
      ["pre-e0", "pre-e1"]
    );
  });

  it("legacy `.json`-only session → empty (no captured refs)", async () => {
    const id = "rp-legacy";
    const dir = resolveConversationDir({
      projectDir: sessionDir,
      conversationId: id,
    });
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, `${id}.json`),
      JSON.stringify({ schemaVersion: CURRENT_SCHEMA_VERSION, messages: [] }),
      "utf8"
    );
    assert.deepEqual(await store.rewindablePreimages(id, "e0"), []);
  });

  it("unknown head → schema_invalid on field head", async () => {
    const id = "rp-unknown";
    await seed(id, [event("e0", null, true)], "e0");
    await assert.rejects(
      () => store.rewindablePreimages(id, "e99"),
      (err: unknown) => {
        const e = err as SessionStoreError & { field?: string };
        return e.kind === "schema_invalid" && e.field === "head";
      }
    );
  });

  it("is read-only: the persisted head is unchanged after a call", async () => {
    const id = "rp-readonly";
    await seed(id, [event("e0", null, true), event("e1", "e0", true)], "e1");
    await store.rewindablePreimages(id, "e0");
    assert.equal(await store.readHead(id), "e1");
  });
});

// ADR-0119: the hub's worker-spawn scan needs the FULL abandoned segment
// (spawn tool_use ids live on events without any preimage), so
// rewindablePreimages is now the codePreimage filter of abandonedEvents.
describe("SessionStore.abandonedEvents", () => {
  it("returns every abandoned event, stamped or not, in current-chain order", async () => {
    const id = "ae-mixed";
    await seed(
      id,
      [
        event("e0", null, false),
        event("e1", "e0", true),
        event("e2", "e1", false),
        event("e3", "e2", true),
      ],
      "e3"
    );
    const out = await store.abandonedEvents(id, "e1");
    assert.deepEqual(
      out.map((e) => e.id),
      ["e2", "e3"]
    );
  });

  it("newHead=null abandons the whole chain", async () => {
    const id = "ae-null";
    await seed(id, [event("e0", null, false), event("e1", "e0", false)], "e1");
    assert.deepEqual(
      (await store.abandonedEvents(id, null)).map((e) => e.id),
      ["e0", "e1"]
    );
  });

  it("rewindablePreimages is exactly the codePreimage filter of abandonedEvents", async () => {
    const id = "ae-filter";
    await seed(
      id,
      [
        event("e0", null, false),
        event("e1", "e0", true),
        event("e2", "e1", false),
        event("e3", "e2", true),
      ],
      "e3"
    );
    const all = await store.abandonedEvents(id, "e0");
    const stamped = await store.rewindablePreimages(id, "e0");
    assert.deepEqual(
      stamped.map((e) => e.id),
      all.filter((e) => e.codePreimage !== undefined).map((e) => e.id)
    );
    assert.deepEqual(
      stamped.map((e) => e.id),
      ["e1", "e3"]
    );
  });
});
