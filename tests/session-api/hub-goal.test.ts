/**
 * #458 T2/T5 (SC2): hub seeds taskFocus (NOT goal) on the first user message.
 *
 * Seed seam: `conditionalSave` materializes the new SessionFileV1 after
 * `run()` and is the natural place to seed `taskFocus` from
 * `extractGoal(result.messages)` when `session.taskFocus` is still absent.
 * The taskFocus is seeded exactly once — a re-pin (`## GOAL:` / `/goal`) or
 * `seedTaskFocus` switch is the only way to overwrite it. `goal` is no longer
 * seeded by the hub: after a fresh seed `goal === undefined` while
 * `taskFocus.text` carries the first user message text.
 *
 * The `## GOAL:` path additionally gates goal text through
 * `validateGoalText` (2000-char cap) before the pin reaches the store.
 */
import { afterAll, beforeAll, describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionHub } from "../../src/session-api/hub.ts";
import {
  CURRENT_SCHEMA_VERSION,
  MAX_GOAL_CHARS,
  MAX_TASK_FOCUS_CHARS,
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

describe("taskFocus seed — first postMessage on a fresh session (#458 T2 SC2)", () => {
  it("seeds taskFocus.text === first user message text; goal stays undefined", async () => {
    const hub = makeHub();
    const { session } = await hub.createSession();
    await hub.postMessage({
      conversationId: session.conversation_id,
      text: "Build a C compiler",
    });
    const loaded: SessionFileV1 = await store.load(session.conversation_id);
    // SC2: hub no longer seeds `goal` — the deterministic task focus replaces
    // the goal seed path.
    assert.equal(loaded.goal, undefined, "goal must NOT be seeded");
    assert.ok(loaded.taskFocus, "expected taskFocus to be seeded");
    assert.equal(loaded.taskFocus!.text, "Build a C compiler");
    // createdAt === updatedAt — both = now from conditionalSave (taskFocus
    // carries only text/updatedAt/history).
    assert.match(loaded.taskFocus!.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
    // Fresh seed: history[0] = the just-seeded entry (T1 OQ2 algorithm —
    // switch condition prepends the prior focus to history; here the prior
    // focus is undefined, so history carries the new entry only).
    assert.ok(loaded.taskFocus!.history);
    assert.equal(loaded.taskFocus!.history!.length, 1);
    assert.equal(loaded.taskFocus!.history![0]!.text, "Build a C compiler");
  });

  it("seeds a long taskFocus truncated to MAX_TASK_FOCUS_CHARS (500)", async () => {
    const long = "x".repeat(MAX_TASK_FOCUS_CHARS + 50);
    const hub = makeHub();
    const { session } = await hub.createSession();
    await hub.postMessage({
      conversationId: session.conversation_id,
      text: long,
    });
    const loaded = await store.load(session.conversation_id);
    assert.ok(long.length > MAX_TASK_FOCUS_CHARS, "fixture must exceed cap");
    assert.equal(loaded.taskFocus?.text, long.slice(0, MAX_TASK_FOCUS_CHARS));
  });

  it("trims leading/trailing whitespace from the seeded taskFocus text", async () => {
    const hub = makeHub();
    const { session } = await hub.createSession();
    await hub.postMessage({
      conversationId: session.conversation_id,
      text: "  Build a C compiler  ",
    });
    const loaded = await store.load(session.conversation_id);
    assert.equal(loaded.taskFocus?.text, "Build a C compiler");
  });

  it("does NOT re-seed on subsequent turns (taskFocus persists across turns)", async () => {
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
    const firstFocus = after1.taskFocus;
    assert.ok(firstFocus);
    await hub.postMessage({
      conversationId: session.conversation_id,
      text: "now test it",
    });
    const after2 = await store.load(session.conversation_id);
    assert.deepEqual(
      after2.taskFocus,
      firstFocus,
      "taskFocus preserved byte-identical"
    );
    assert.equal(after2.taskFocus?.text, "Build a C compiler");
  });
});

describe("taskFocus seed — no user message → no taskFocus (#458 T2 acceptance #3)", () => {
  it("does not seed taskFocus when first user message is a pure tool_result message", async () => {
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
    assert.equal(loaded.taskFocus, undefined);
  });
});

describe("sanitize — goal/taskFocus absent on a v4 file loaded by v5 (sanitize backfill)", () => {
  it("v4 file (no goal/taskFocus field) loads with both undefined", async () => {
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
    assert.equal(loaded.taskFocus, undefined);
  });
});

describe("## GOAL: validateGoalText (#458 T5 SC5)", () => {
  it("rejects an over-long ## GOAL: directive with ValidationError, no pin persisted", async () => {
    const hub = makeHub();
    const { session } = await hub.createSession();
    const overlong = "x".repeat(MAX_GOAL_CHARS + 1);
    await assert.rejects(
      () =>
        hub.postMessage({
          conversationId: session.conversation_id,
          text: `## GOAL: ${overlong}`,
        }),
      (err: unknown) => {
        const e = err as { message?: string; details?: unknown };
        return (
          typeof e.message === "string" &&
          e.message.includes("rejected:") &&
          e.message.includes(`${MAX_GOAL_CHARS} chars`) &&
          (e.details as { field?: string } | undefined)?.field === "goal_text"
        );
      },
      "over-long ## GOAL: must throw ValidationError with field goal_text"
    );
    const loaded = await store.load(session.conversation_id);
    assert.equal(loaded.goal, undefined, "rejected pin must not persist");
  });

  it("accepts a ## GOAL: directive at the 2000-char cap", async () => {
    const hub = makeHub();
    const { session } = await hub.createSession();
    const atCap = "y".repeat(MAX_GOAL_CHARS);
    const res = await hub.postMessage({
      conversationId: session.conversation_id,
      text: `## GOAL: ${atCap}`,
    });
    assert.equal(res.turn.answer.stopReason, "completed");
    const loaded = await store.load(session.conversation_id);
    assert.equal(loaded.goal?.text, atCap);
    assert.equal(loaded.goal?.source, "user_pin");
  });
});
