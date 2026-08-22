/**
 * #458 T8 (SC2 + SC4): `## GOAL:` re-pin via postMessage — post-#605 T2 字段
 * 退休后的纯 goal-pin 语义。
 *
 * #605 T2 后 `session.taskFocus` 整段退休;本文件只覆盖 `## GOAL: <text>`
 * 触发的 user_pin 写路径(re-pin, history 累积, 空 directive 拒绝)。
 * mid-message(`hello ## GOAL: x` 不构成 pin directive)行为由
 * `chat-session-user-text.test.ts` + `chat-session` 自身覆盖,不再在本文件
 * 重复。
 *
 * Fixture:re-pin history-accumulation tests 使用显式 `pinGoal` 构造的
 * `user_pin` 起点,绕过已退役的 first-postMessage seed path。
 */
import { afterAll, beforeAll, describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionHub } from "../../src/session-api/hub.ts";
import {
  CURRENT_SCHEMA_VERSION,
  pinGoal,
  resolveProjectSessionDir,
  SessionStore,
  type SessionFileV1,
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

describe("## GOAL: re-pin via postMessage (#458 T8)", () => {
  it("overwrites goal.text, source === user_pin, prior user_pin goal pushed to history[0] with status === superseded", async () => {
    const hub = makeHub();
    const { session } = await hub.createSession();

    // Pre-existing user_pin goal fixture (T2 seed path no longer creates
    // a goal; construct one explicitly via pinGoal so the re-pin history
    // accumulation invariant holds).
    const now0 = new Date().toISOString();
    await store.save({
      id: session.conversation_id,
      file: {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        conversation_id: session.conversation_id,
        messages: [],
        jsonMode: false,
        turnCount: 0,
        updatedAt: now0,
        title: "",
        cwd: process.cwd(),
        sanitized_at: now0,
        checkpoints: [],
        goal: pinGoal({
          current: undefined,
          text: "Build a C compiler",
          now: now0,
        }),
      } as SessionFileV1,
    });

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
    // Pre-existing user_pin goal carries source user_pin into history.
    assert.equal(after2.goal!.history![0]!.source, "user_pin");
    assert.equal(after2.goal!.history![0]!.status, "superseded");
    // updatedAt advances after re-pin.
    assert.match(after2.goal!.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.ok(after2.goal!.updatedAt >= now0, "updatedAt advanced");
  });

  it("accumulates history monotonically across multiple re-pins", async () => {
    const hub = makeHub();
    const { session } = await hub.createSession();

    // Pre-existing user_pin goal fixture.
    const now0 = new Date().toISOString();
    await store.save({
      id: session.conversation_id,
      file: {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        conversation_id: session.conversation_id,
        messages: [],
        jsonMode: false,
        turnCount: 0,
        updatedAt: now0,
        title: "",
        cwd: process.cwd(),
        sanitized_at: now0,
        checkpoints: [],
        goal: pinGoal({
          current: undefined,
          text: "Build a compiler",
          now: now0,
        }),
      } as SessionFileV1,
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
    // The pre-existing fixture was user_pin, so history[1].source === "user_pin".
    assert.equal(loaded.goal!.history![1]!.source, "user_pin");
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

describe("## GOAL: empty → no-op (#458 T8)", () => {
  it("empty ## GOAL: rejects (empty query) and leaves goal + taskFocus unchanged", async () => {
    const hub = makeHub();
    const { session } = await hub.createSession();
    // First postMessage seeds taskFocus (SC2); goal stays undefined.
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
    // Reject must leave goal state unchanged (no pin persisted).
    assert.deepEqual(after.goal, before.goal);
  });
});
