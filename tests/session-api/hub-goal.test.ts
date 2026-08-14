/**
 * #408 T2: hub seeds the session-level goal on the first user message.
 *
 * Seed seam: `conditionalSave` materializes the new SessionFileV1 after
 * `run()` and is the natural place to seed `goal` from `extractGoal(result.messages)`
 * when `session.goal` is still absent. The goal is seeded exactly once — a
 * re-pin (T3) is the only way to overwrite it.
 */
import { afterAll, beforeAll, describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionHub } from "../../src/session-api/hub.ts";
import {
  CURRENT_SCHEMA_VERSION,
  resolveProjectSessionDir,
  SessionStore,
  type SessionFileV1,
} from "../../src/session-api/store/index.ts";
import { assistantResult, makeDeps } from "../cli/_fixtures.ts";

let baseDir: string;
let sessionDir: string;
let store: SessionStore;

beforeAll(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "iknow-hub-goal-"));
  sessionDir = resolveProjectSessionDir(baseDir, process.cwd());
  store = new SessionStore(baseDir);
});

afterAll(async () => {
  await rm(baseDir, { recursive: true, force: true });
});

function makeHub(): SessionHub {
  return new SessionHub({
    store,
    deps: makeDeps([assistantResult({ texts: ["ack"] })]),
  });
}

describe("goal seed — first postMessage on a fresh session (#408 T2)", () => {
  it("seeds goal.text === first user message text, source === user_initial, status === active", async () => {
    const hub = makeHub();
    const { session } = await hub.createSession();
    await hub.postMessage({
      conversationId: session.conversation_id,
      text: "Build a C compiler",
    });
    const loaded: SessionFileV1 = await store.load(session.conversation_id);
    assert.ok(loaded.goal, "expected goal to be seeded");
    assert.equal(loaded.goal!.text, "Build a C compiler");
    assert.equal(loaded.goal!.source, "user_initial");
    assert.equal(loaded.goal!.status, "active");
    // createdAt === updatedAt — both = now from conditionalSave.
    assert.equal(loaded.goal!.createdAt, loaded.goal!.updatedAt);
    assert.match(loaded.goal!.createdAt, /^\d{4}-\d{2}-\d{2}T/);
    // history is omitted on a fresh seed (additive optional field).
    assert.equal(loaded.goal!.history, undefined);
  });

  it("seeds a long goal without 80-char truncation (full intent preserved)", async () => {
    const long =
      "Implement an LLVM-style compiler with type inference, codegen, and lifetime analysis across the whole project";
    const hub = makeHub();
    const { session } = await hub.createSession();
    await hub.postMessage({
      conversationId: session.conversation_id,
      text: long,
    });
    const loaded = await store.load(session.conversation_id);
    assert.equal(loaded.goal?.text, long);
  });

  it("trims leading/trailing whitespace from the seeded goal text", async () => {
    const hub = makeHub();
    const { session } = await hub.createSession();
    await hub.postMessage({
      conversationId: session.conversation_id,
      text: "  Build a C compiler  ",
    });
    const loaded = await store.load(session.conversation_id);
    assert.equal(loaded.goal?.text, "Build a C compiler");
  });

  it("does NOT re-seed on subsequent turns (goal persists across turns)", async () => {
    const deps = makeDeps([
      assistantResult({ texts: ["first reply"] }),
      assistantResult({ texts: ["second reply"] }),
    ]);
    const hub = new SessionHub({ store, deps });
    const { session } = await hub.createSession();
    await hub.postMessage({
      conversationId: session.conversation_id,
      text: "Build a C compiler",
    });
    const after1 = await store.load(session.conversation_id);
    const firstGoal = after1.goal;
    assert.ok(firstGoal);
    await hub.postMessage({
      conversationId: session.conversation_id,
      text: "now test it",
    });
    const after2 = await store.load(session.conversation_id);
    assert.deepEqual(after2.goal, firstGoal, "goal preserved byte-identical");
    assert.equal(after2.goal?.text, "Build a C compiler");
    assert.equal(after2.goal?.source, "user_initial");
    assert.equal(after2.goal?.status, "active");
  });
});

describe("goal seed — no user message → no goal (#408 T2 acceptance #3)", () => {
  it("does not seed goal when first user message is a pure tool_result message", async () => {
    // Edge case: synthetic session that bypasses createSession/postMessage
    // and loads directly. Goal seed requires a user message with a text
    // block; tool_result-only user messages are skipped by extractGoal.
    const id = "no-user-text";
    await store.save({
      id,
      file: {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        conversation_id: id,
        messages: [
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "x", content: [] }],
          },
        ],
        jsonMode: false,
        turnCount: 0,
        updatedAt: new Date().toISOString(),
        summary: "",
        cwd: process.cwd(),
        sanitized_at: new Date().toISOString(),
        checkpoints: [],
      },
    });
    const loaded = await store.load(id);
    assert.equal(loaded.goal, undefined);
  });
});

describe("sanitize — goal absent on a v4 file loaded by v5 (sanitize backfill)", () => {
  it("v4 file (no goal field) loads with goal: undefined", async () => {
    const id = "v4-no-goal";
    await store.save({
      id,
      file: {
        schemaVersion: 4,
        conversation_id: id,
        messages: [],
        jsonMode: false,
        turnCount: 0,
        updatedAt: new Date().toISOString(),
        summary: "",
        cwd: process.cwd(),
        sanitized_at: new Date().toISOString(),
        checkpoints: [],
      },
    });
    const loaded = await store.load(id);
    assert.equal(loaded.schemaVersion, CURRENT_SCHEMA_VERSION);
    assert.equal(loaded.goal, undefined);
  });
});
