/**
 * #408 T3: goal re-pin via `## GOAL:` text in postMessage.
 *
 * parseGoalCommand detects the leading `## GOAL: <text>` marker in the
 * postMessage input. When present with non-empty text, the hub pins the
 * session-level goal (history[0] = superseded prior) and runs the model
 * with the stripped text as the query. When present with empty text, it
 * is a no-op (goal unchanged, no history entry). When the marker appears
 * mid-message (`hello ## GOAL: x`), the whole text is treated as a normal
 * query — no pin.
 *
 * The `/goal` slash command's wire-shape is verified in slash.ts's own
 * unit-style coverage; the persistence seam is chat-session's
 * processSlash, which calls the same `pinGoal()` pure helper.
 */
import { afterAll, beforeAll, describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionHub } from "../../src/session-api/hub.ts";
import {
  resolveProjectSessionDir,
  SessionStore,
} from "../../src/session-api/store/index.ts";
import { assistantResult, makeDeps } from "../cli/_fixtures.ts";

let baseDir: string;
let store: SessionStore;

beforeAll(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "iknow-hub-goalpin-"));
  resolveProjectSessionDir(baseDir, process.cwd());
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

describe("## GOAL: re-pin (#408 T3 acceptance #1)", () => {
  it("overwrites goal.text, source === user_pin, prior pushed to history[0] with status === superseded", async () => {
    const hub = makeHub();
    const { session } = await hub.createSession();

    // Seed an initial goal via T2 path: empty-session first postMessage.
    await hub.postMessage({
      conversationId: session.conversation_id,
      text: "Build a C compiler",
    });
    const after1 = await store.load(session.conversation_id);
    assert.equal(after1.goal?.text, "Build a C compiler");
    assert.equal(after1.goal?.source, "user_initial");
    assert.equal(after1.goal?.history, undefined);

    // Re-pin via ## GOAL: with non-empty text.
    await hub.postMessage({
      conversationId: session.conversation_id,
      text: "## GOAL: write a type checker",
    });
    const after2 = await store.load(session.conversation_id);
    assert.equal(after2.goal?.text, "write a type checker");
    assert.equal(after2.goal?.source, "user_pin");
    assert.equal(after2.goal?.status, "active");
    assert.ok(after2.goal?.history);
    assert.equal(after2.goal!.history!.length, 1);
    assert.equal(after2.goal!.history![0]!.text, "Build a C compiler");
    assert.equal(after2.goal!.history![0]!.source, "user_initial");
    assert.equal(after2.goal!.history![0]!.status, "superseded");
    // updatedAt advances after re-pin.
    assert.match(after2.goal!.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.ok(
      after2.goal!.updatedAt >= after1.goal!.updatedAt,
      "updatedAt advanced"
    );
  });

  it("accumulates history monotonically across multiple re-pins", async () => {
    const hub = makeHub();
    const { session } = await hub.createSession();
    await hub.postMessage({
      conversationId: session.conversation_id,
      text: "Build a compiler",
    });
    await hub.postMessage({
      conversationId: session.conversation_id,
      text: "## GOAL: write a lexer",
    });
    await hub.postMessage({
      conversationId: session.conversation_id,
      text: "## GOAL: write a parser",
    });
    const loaded = await store.load(session.conversation_id);
    assert.equal(loaded.goal?.text, "write a parser");
    assert.equal(loaded.goal?.source, "user_pin");
    assert.ok(loaded.goal?.history);
    assert.equal(loaded.goal!.history!.length, 2);
    assert.equal(loaded.goal!.history![0]!.text, "write a lexer");
    assert.equal(loaded.goal!.history![0]!.status, "superseded");
    assert.equal(loaded.goal!.history![1]!.text, "Build a compiler");
    assert.equal(loaded.goal!.history![1]!.source, "user_initial");
    assert.equal(loaded.goal!.history![1]!.status, "superseded");
  });

  it("re-pin before any seeded goal still produces source=user_pin with no prior history", async () => {
    const hub = makeHub();
    const { session } = await hub.createSession();
    await hub.postMessage({
      conversationId: session.conversation_id,
      text: "## GOAL: write a type checker",
    });
    const loaded = await store.load(session.conversation_id);
    assert.equal(loaded.goal?.text, "write a type checker");
    assert.equal(loaded.goal?.source, "user_pin");
    assert.deepEqual(loaded.goal!.history ?? [], []);
  });
});

describe("## GOAL: empty → no-op (#408 T3 acceptance #3)", () => {
  it("empty ## GOAL: rejects (empty query) and leaves goal unchanged", async () => {
    const hub = makeHub();
    const { session } = await hub.createSession();
    // Seed a goal first so we can verify it's unchanged.
    await hub.postMessage({
      conversationId: session.conversation_id,
      text: "Build a C compiler",
    });
    const before = await store.load(session.conversation_id);

    await assert.rejects(
      () =>
        hub.postMessage({
          conversationId: session.conversation_id,
          text: "## GOAL:",
        }),
      (err: unknown) => {
        // validateText("") throws ValidationError("message text must be non-empty").
        const e = err as { message?: string };
        return (
          typeof e.message === "string" &&
          e.message.includes("message text must be non-empty")
        );
      },
      "empty ## GOAL: must reject (no goal text to run)"
    );
    const after = await store.load(session.conversation_id);
    assert.deepEqual(after.goal, before.goal);
  });
});

describe("## GOAL: mid-message → no-op, normal query (#408 T3 acceptance #4)", () => {
  it("'hello ## GOAL: x' is NOT a pin directive; whole text is the query and seeds via T2", async () => {
    const hub = makeHub();
    const { session } = await hub.createSession();
    const res = await hub.postMessage({
      conversationId: session.conversation_id,
      text: "hello ## GOAL: x",
    });
    // The model ran with the full text as the query.
    assert.equal(res.turn.query, "hello ## GOAL: x");
    // The goal was seeded via the T2 path (source=user_initial, full text),
    // NOT pinned via T3 (source would be user_pin if directive matched).
    const loaded = await store.load(session.conversation_id);
    assert.equal(loaded.goal?.source, "user_initial");
    assert.equal(loaded.goal?.text, "hello ## GOAL: x");
    assert.equal(loaded.goal?.history, undefined);
  });
});
