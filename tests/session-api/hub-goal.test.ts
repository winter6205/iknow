/**
 * #458 T2/T5 → #605 T2: hub no longer seeds `session.taskFocus`.
 *
 * Post-#605 T2: the `session.taskFocus` field is retired — no seed path,
 * no clear path, no writer in `conditionalSave`. `conditionalSave` only
 * merges the post-run messages / turnCount / title / updatedAt.
 *
 * This file keeps the `## GOAL:` validation cases and the sanitize-load
 * cases (which now assert no `taskFocus` key on the wire), and removes
 * the seed-on-first-postMessage coverage.
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
  SessionStore,
  type SessionFileV1,
} from "../../src/session-api/store/index.ts";
import { assistantResult, makeDeps } from "../cli/_fixtures.ts";

let baseDir: string;
let store: SessionStore;

beforeAll(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "iknow-hub-goal-"));
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
    // #605 T2: no taskFocus key after a rejected pin.
    assert.equal(
      (loaded as unknown as Record<string, unknown>)["taskFocus"],
      undefined
    );
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
    assert.equal(
      (loaded as unknown as Record<string, unknown>)["taskFocus"],
      undefined
    );
  });
});

describe("post-#605 T2: hub does NOT write session.taskFocus", () => {
  it("a fresh postMessage leaves session.taskFocus undefined on disk", async () => {
    const hub = makeHub();
    const { session } = await hub.createSession();
    await hub.postMessage({
      conversationId: session.conversation_id,
      text: "Build a C compiler",
    });
    const loaded: SessionFileV1 = await store.load(session.conversation_id);
    assert.equal(
      (loaded as unknown as Record<string, unknown>)["taskFocus"],
      undefined,
      "hub must not write taskFocus — the field is retired"
    );
    assert.equal(loaded.goal, undefined, "goal also stays undefined on fresh");
  });

  it("a greeting postMessage still leaves taskFocus undefined (gracefully)", async () => {
    // The greeting-filter predicate moved to turn-projection.ts
    // (shouldSeedTaskFocus); the hub no longer consults it because the
    // seed path is gone. This test pins the no-side-effect contract:
    // even a greeting produces no taskFocus on disk.
    const hub = makeHub();
    const { session } = await hub.createSession();
    await hub.postMessage({
      conversationId: session.conversation_id,
      text: "你好",
    });
    const loaded = await store.load(session.conversation_id);
    assert.equal(
      (loaded as unknown as Record<string, unknown>)["taskFocus"],
      undefined
    );
  });
});

describe("sanitize — legacy taskFocus key is dropped on load", () => {
  it("v5 file with stale taskFocus key loads without emitting taskFocus", async () => {
    const id = "stale-taskfocus";
    await store.save({
      id,
      file: {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        conversation_id: id,
        messages: [],
        jsonMode: false,
        turnCount: 0,
        updatedAt: new Date().toISOString(),
        title: "",
        cwd: process.cwd(),
        sanitized_at: new Date().toISOString(),
        checkpoints: [],
        taskFocus: { text: "stale", updatedAt: "2026-08-13T00:00:00.000Z" },
      } as SessionFileV1,
    });
    const loaded = await store.load(id);
    assert.equal(
      (loaded as unknown as Record<string, unknown>)["taskFocus"],
      undefined,
      "sanitize must drop the legacy taskFocus key"
    );
  });
});
