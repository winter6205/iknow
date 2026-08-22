/**
 * #458 T2/T5 (SC2) + #605 T2 退休字段后:hub **不再 seed** `taskFocus`,
 * sanitize 也不再迁移 `user_initial` 到 `taskFocus`;盘上遗留的
 * legacy taskFocus key 在 load 时无条件 drop。goal 仍由 `## GOAL:`
 * / `/goal <text>` 写入(用户固定锚,model 不可写),first postMessage
 * 在无 goal / 无 taskFocus 状态下 goal 也保持 undefined。
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
  resolveProjectSessionDir,
  SessionStore,
} from "../../src/session-api/store/index.ts";
import { assistantResult, makeDeps } from "../cli/_fixtures.ts";

let baseDir: string;
let store: SessionStore;

beforeAll(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "iknow-hub-goal-"));
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
        title: "",
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

describe("post-#605 T2: legacy taskFocus key is dropped on load (sanitize)", () => {
  it("well-formed legacy taskFocus: load → dropped, goal unchanged", async () => {
    const id = "legacy-taskfocus-drop";
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
        taskFocus: {
          text: "stale",
          updatedAt: "2026-08-13T00:00:00.000Z",
        },
      } as unknown as Parameters<typeof store.save>[0]["file"],
    });
    const loaded = await store.load(id);
    assert.equal(
      (loaded as unknown as Record<string, unknown>)["taskFocus"],
      undefined,
      "sanitize must drop legacy taskFocus key"
    );
    assert.equal(loaded.goal, undefined);
  });

  it("fresh postMessage leaves no taskFocus on disk (no-seed contract)", async () => {
    const hub = makeHub();
    const { session } = await hub.createSession();
    await hub.postMessage({
      conversationId: session.conversation_id,
      text: "Build a C compiler",
    });
    const loaded = await store.load(session.conversation_id);
    assert.equal(
      (loaded as unknown as Record<string, unknown>)["taskFocus"],
      undefined,
      "no-seed path: fresh postMessage must not write taskFocus"
    );
    assert.equal(loaded.goal, undefined);
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
