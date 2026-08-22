/**
 * T5 (spec #120 SC 8 = the sole acceptance criterion of #120 Q6): cross-entry
 * consistency for the shared session pool.
 *
 * Scenario (spec Testing Strategy Integration — Integration class):
 *   1. hub A createSession + postMessage N rounds (N = 2)
 *   2. hub B loads the same conversation via an INDEPENDENT SessionStore
 *      instance and asserts that the 8 named fields are all equal to the
 *      on-disk JSON produced by hub A.
 *   3. hub B continues to run round N+1 against the same file and saves.
 *   4. hub A re-reads and asserts that round N+1 is in (messages length
 *      and turnCount both incremented, and the new assistant text is
 *      visible via both store.load and hub.getSession).
 *
 * Shared-pool semantics: hub A and hub B each own a private SessionStore
 * instance (modeling two separate processes such as serve + TUI), but both
 * stores are constructed with the same (baseDir, cwd) so resolveProjectSessionDir
 * lands them in the same project directory and they read/write the same files.
 *
 * Known boundary (out of scope for this test): cross-instance / cross-process
 * concurrent writes. spec #120 Open Question 3 = "no file locks this cycle";
 * tmp/rename guarantees no half-written file but the last writer may stomp a
 * concurrent turn. That gap is recorded as a known boundary, NOT tested here.
 */
import { afterAll, beforeAll, describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionHub } from "../../src/session-api/hub.ts";
import {
  CURRENT_SCHEMA_VERSION,
  parseSessionJsonl,
  resolveProjectSessionDir,
  SESSION_JSONL_EXT,
  SessionStore,
} from "../../src/session-api/store/index.ts";
import type { SessionFileV1 } from "../../src/session-api/store/index.ts";
import { assistantResult, makeDeps } from "../cli/_fixtures.ts";

// -- setup -------------------------------------------------------------------

const N = 2; // spec requires N >= 2; 2 keeps the test compact while exercising the round-trip.

let baseDir: string;
let cwd: string;
/** Shared project session directory resolved from (baseDir, cwd). */
let sessionDir: string;

/** Each hub holds an independent store instance (two entry points sharing one pool). */
let storeA: SessionStore;
let storeB: SessionStore;
let hubA: SessionHub;
let hubB: SessionHub;

let conversationId: string;
/** Raw JSON snapshot of the session file after hub A's N rounds — the SSOT
 *  for "A's on-disk values" that hub B must equal. */
let diskAfterA: Record<string, unknown>;

beforeAll(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "iknow-cross-entry-"));
  cwd = process.cwd();
  sessionDir = resolveProjectSessionDir(baseDir, cwd);

  storeA = new SessionStore(baseDir, cwd);
  storeB = new SessionStore(baseDir, cwd);

  // Hub A owns N scripted responses (one text-only assistant turn per round).
  // Hub B owns 1 scripted response for the N+1th round.
  hubA = new SessionHub({
    store: storeA,
    deps: makeDeps([
      assistantResult({ texts: ["assistant-A-round-1"] }),
      assistantResult({ texts: ["assistant-A-round-2"] }),
    ]),
  });
  hubB = new SessionHub({
    store: storeB,
    deps: makeDeps([assistantResult({ texts: ["assistant-B-round-N+1"] })]),
  });
});

afterAll(async () => {
  await rm(baseDir, { recursive: true, force: true });
});

/** Read the raw JSON on disk — the authoritative baseline for "A's on-disk values". */
async function readDisk(id: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(sessionDir, `${id}.json`), "utf8"));
}

/** Convenience: take only the 8 fields the spec names for equality. */
function project(file: SessionFileV1): {
  messages: SessionFileV1["messages"];
  conversation_id: string;
  turnCount: number;
  title: string;
  cwd: string;
  schemaVersion: number;
  updatedAt: string;
  jsonMode: boolean;
} {
  return {
    messages: file.messages,
    conversation_id: file.conversation_id,
    turnCount: file.turnCount,
    title: file.title,
    cwd: file.cwd,
    schemaVersion: file.schemaVersion,
    updatedAt: file.updatedAt,
    jsonMode: file.jsonMode,
  };
}

// -- Q6 scenario --------------------------------------------------------------

describe("Q6 cross-entry consistency: shared pool, two independent SessionHub entry points", () => {
  it("Step 1 — hub A: createSession + N rounds of postMessage", async () => {
    const created = await hubA.createSession({ json_mode: true });
    conversationId = created.session.conversation_id;
    assert.ok(conversationId.length > 0, "conversation_id must be non-empty");
    assert.equal(created.session.turn_count, 0);
    assert.equal(created.session.json_mode, true);

    // Round 1
    const r1 = await hubA.postMessage({
      conversationId,
      text: "alpha-query",
    });
    assert.equal(r1.turn.answer.stopReason, "completed");
    assert.equal(r1.turn.answer.finalText, "assistant-A-round-1");
    assert.equal(r1.turn.answer.turnCount, 1);
    assert.equal(r1.session.turn_count, 1);

    // Round 2
    const r2 = await hubA.postMessage({
      conversationId,
      text: "beta-query",
    });
    assert.equal(r2.turn.answer.stopReason, "completed");
    assert.equal(r2.turn.answer.finalText, "assistant-A-round-2");
    assert.equal(r2.turn.answer.turnCount, 1);
    assert.equal(r2.session.turn_count, 2);

    // Snapshot A's on-disk values (SSOT for equality in Step 2).
    diskAfterA = await readDisk(conversationId);

    // Sanity: assertions on the fields themselves so the equality step below
    // is comparing concrete, meaningful values (not just blind deepEqual).
    assert.equal(diskAfterA["schemaVersion"], CURRENT_SCHEMA_VERSION);
    assert.equal(diskAfterA["conversation_id"], conversationId);
    assert.equal(diskAfterA["turnCount"], 2);
    assert.equal(diskAfterA["title"], "alpha-query");
    assert.equal(diskAfterA["cwd"], process.cwd());
    assert.equal(diskAfterA["jsonMode"], true);
    const messagesLen = (diskAfterA["messages"] as unknown[]).length;
    assert.equal(messagesLen, 2 * N);
  });

  it("Step 2 — hub B (independent store): 8-field equality with A's on-disk values", async () => {
    // hub B reads via its OWN store.getSession path (hub-level, exercising
    // store.load + sanitize on a freshly-instantiated SessionStore).
    const got = await hubB.getSession(conversationId);
    assert.equal(got.session.conversation_id, conversationId);
    assert.equal(got.session.turn_count, N);
    assert.equal(got.session.json_mode, true);
    assert.equal(got.turns.length, N);
    assert.equal(got.turns[0]!.query, "alpha-query");
    assert.equal(got.turns[0]!.answer.finalText, "assistant-A-round-1");
    assert.equal(got.turns[1]!.query, "beta-query");
    assert.equal(got.turns[1]!.answer.finalText, "assistant-A-round-2");

    // The 8 fields named by the spec, loaded through hub B's independent store
    // (= the other entry point) versus the raw on-disk JSON written by hub A.
    const loadedByB = await storeB.load(conversationId);
    const fromB = project(loadedByB);
    const fromDisk = {
      messages: diskAfterA["messages"] as SessionFileV1["messages"],
      conversation_id: diskAfterA["conversation_id"] as string,
      turnCount: diskAfterA["turnCount"] as number,
      title: diskAfterA["title"] as string,
      cwd: diskAfterA["cwd"] as string,
      schemaVersion: diskAfterA["schemaVersion"] as number,
      updatedAt: diskAfterA["updatedAt"] as string,
      jsonMode: diskAfterA["jsonMode"] as boolean,
    };
    assert.deepEqual(fromB, fromDisk, "hub B's load vs A's disk JSON");

    // Cross-entry equivalence: the two store instances (A and B) must agree
    // field-for-field (proves the shared-pool read path is deterministic).
    const loadedByA = await storeA.load(conversationId);
    assert.deepEqual(project(loadedByA), fromB);
  });

  it("Step 3 — hub B: continues with round N+1 against the same file", async () => {
    const r = await hubB.postMessage({
      conversationId,
      text: "gamma-query",
    });
    assert.equal(r.turn.answer.stopReason, "completed");
    assert.equal(r.turn.answer.finalText, "assistant-B-round-N+1");
    assert.equal(r.turn.answer.turnCount, 1);
    assert.equal(r.session.turn_count, N + 1);
  });

  it("Step 4 — hub A re-reads: round N+1 visible via both store and hub.getSession", async () => {
    // Re-load via hub A's store: messages length and turnCount both incremented.
    const loadedByA = await storeA.load(conversationId);
    assert.equal(loadedByA.turnCount, N + 1);
    assert.equal(loadedByA.messages.length, 2 * (N + 1));
    const lastAssistant = [...loadedByA.messages]
      .reverse()
      .find((m) => m.role === "assistant");
    assert.ok(lastAssistant, "expected an assistant message after N+1 rounds");
    assert.ok(
      lastAssistant.content.some(
        (b) => b.type === "text" && b.text === "assistant-B-round-N+1"
      ),
      "new assistant text must be visible from hub A"
    );

    // Append-only discipline: round N+1 must preserve the prior N rounds as
    // a prefix (Q6 invariant — history is immutable, only appended).
    const priorMessagesPrefix = (diskAfterA["messages"] as unknown[]).map((m) =>
      JSON.parse(JSON.stringify(m))
    );
    const newPrefix = loadedByA.messages.slice(0, priorMessagesPrefix.length);
    assert.deepEqual(
      newPrefix,
      priorMessagesPrefix,
      "B's save must preserve A's history as an append-only prefix"
    );

    // Equivalent read through hub A's getSession (wire path) — covers the
    // hub-level re-read alongside the store-level re-read.
    const gotByA = await hubA.getSession(conversationId);
    assert.equal(gotByA.session.turn_count, N + 1);
    assert.equal(gotByA.turns.length, N + 1);
    assert.equal(
      gotByA.turns[N]!.query,
      "gamma-query",
      "hub A's hub-level read must surface hub B's round N+1"
    );
    assert.equal(gotByA.turns[N]!.answer.finalText, "assistant-B-round-N+1");

    // updatedAt must reflect the latest write (> the snapshot timestamp).
    const diskAfterB = await readDisk(conversationId);
    assert.ok(
      (diskAfterB["updatedAt"] as string) > (diskAfterA["updatedAt"] as string),
      "hub B's save must bump updatedAt past hub A's last write"
    );
  });
});

// -- T5 (#622) cross-entry rewind ----------------------------------------------

describe("T5 (#622) cross-entry rewind: hub head-move is visible to an independent store", () => {
  it("hub rewind → independent store load sees the same head; skipped chain stays in the same JSONL", async () => {
    // A third hub with its own store instance + scripted deps models the
    // rewinding entry point; storeB (independent) models the other reader.
    const storeC = new SessionStore(baseDir, cwd);
    const hubC = new SessionHub({
      store: storeC,
      deps: makeDeps([
        assistantResult({ texts: ["cross-rw-a1"] }),
        assistantResult({ texts: ["cross-rw-a2"] }),
      ]),
    });
    const created = await hubC.createSession({ json_mode: true });
    const id = created.session.conversation_id;
    await hubC.postMessage({ conversationId: id, text: "cross-rw-q1" });
    await hubC.postMessage({ conversationId: id, text: "cross-rw-q2" });

    // Rewind via the hub entry (serialize queue → store.rewindToAnchor):
    // head moves to the turn-0 anchor (e1), the file is NOT truncated.
    const res = await hubC.rewindSession(id, "e1");
    assert.equal(res.head, "e1");
    assert.equal(res.session.turn_count, 1);

    // The OTHER entry point (independent storeB) sees the same head (#120 Q6).
    assert.equal(await storeB.readHead(id), "e1");
    const loadedByB = await storeB.load(id);
    assert.equal(loadedByB.turnCount, 1);
    assert.deepEqual(
      loadedByB.messages.map((m) => m.role),
      ["user", "assistant"]
    );

    // The skipped chain stays in the SAME jsonl: all 4 events retained on disk.
    const log = parseSessionJsonl(
      await readFile(join(sessionDir, `${id}${SESSION_JSONL_EXT}`), "utf8")
    );
    assert.equal(log.events.length, 4);
    assert.equal(log.head, "e1");

    // Wire path agrees too (hub B getSession over the same pool).
    const gotByB = await hubB.getSession(id);
    assert.equal(gotByB.session.turn_count, 1);
    assert.equal(gotByB.turns.length, 1);
    assert.equal(gotByB.turns[0]!.query, "cross-rw-q1");
  });
});
