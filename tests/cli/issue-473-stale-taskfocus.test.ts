/**
 * #473 regression (chat path): verify-loop must NOT consume the stale
 * taskFocus as the current task. Hub-side twin:
 * tests/session-api/issue-473-stale-taskfocus.test.ts.
 *
 * Repro (issue #473): task A completed → `taskFocus.text = A`. New task B
 * arrives → `resolveVerifyUserText`'s fallback hit the stale taskFocus, so
 * the verify-loop's first runFn round fed the model task A instead of B.
 *
 * Fix direction 3 (issue #473): userText = `goal.text ?? query` — the
 * stable taskFocus stays out of the verify input; its lifecycle is
 * unchanged (per-query switching is direction 1, rejected by OQ2).
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { runVerifyLoopMock, getLastVerifyLoopOpts } = vi.hoisted(() => {
  let lastOpts: unknown = undefined;
  const fn = vi.fn(async (opts: unknown) => {
    lastOpts = opts;
    const o = opts as {
      runFn: (
        text: string,
        o?: unknown
      ) => Promise<{
        result: {
          readonly finalText: string | null;
          readonly messages: ReadonlyArray<unknown>;
          readonly turnCount: number;
          readonly stopReason: "completed" | "maxTurns" | "cancelled";
          readonly lastUsage: null;
        };
        trace: unknown;
      }>;
    };
    const r = await o.runFn("ignored-then-overridden-by-userText", {});
    return {
      result: r.result,
      trace: r.trace,
      rounds: 0,
      enabled: true,
      outcome: "passed",
      records: [],
    };
  });
  return {
    runVerifyLoopMock: fn,
    getLastVerifyLoopOpts: () => lastOpts,
  };
});

vi.mock("../../src/harness/verify/index.ts", async () => {
  const actual = await vi.importActual<
    typeof import("../../src/harness/verify/index.ts")
  >("../../src/harness/verify/index.ts");
  return {
    ...actual,
    runVerifyLoop: runVerifyLoopMock,
  };
});

import { processChatLine } from "../../src/cli/chat-session.ts";
import {
  CURRENT_SCHEMA_VERSION,
  SessionStore,
  type TaskFocusState,
} from "../../src/session-api/store/index.ts";
import { assistantResult, makeCtx } from "./_fixtures.ts";
import type { VerifyConfig } from "../../src/harness/verify/types.ts";

let baseDir: string;
let store: SessionStore;

beforeAll(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "iknow-chat-issue473-"));
  store = new SessionStore(baseDir);
});

afterAll(async () => {
  await rm(baseDir, { recursive: true, force: true });
});

afterEach(() => {
  runVerifyLoopMock.mockClear();
});

/** Seed taskFocus = task A directly (the "task A completed" state). */
async function seedTaskFocusA(id: string): Promise<void> {
  const now = "2026-01-01T00:00:00.000Z";
  const file = await store.load(id);
  const taskFocus: TaskFocusState = {
    text: "Build a C compiler",
    updatedAt: now,
    history: [{ text: "Build a C compiler", updatedAt: now }],
  };
  await store.save({ id, file: { ...file, taskFocus } });
}

function capturedUserText(): string {
  const opts = getLastVerifyLoopOpts() as { userText?: unknown } | undefined;
  assert.ok(opts !== undefined, "runVerifyLoop was not called");
  assert.equal(
    typeof opts.userText,
    "string",
    `expected string userText, got ${typeof opts.userText}`
  );
  return opts.userText as string;
}

const verifyConfig: VerifyConfig = { command: "/bin/true" };

describe("#473: verify userText must not be masked by stale taskFocus (chat seam)", () => {
  it("new task B after completed task A → verify userText === B (NOT stale taskFocus A)", async () => {
    const id = "issue473-chat-stale-mask";
    // Precondition: task A completed → taskFocus.text = A (session file must
    // exist first — minimal file, same shape as chat-session-user-text).
    const now = "2026-01-01T00:00:00.000Z";
    await store.save({
      id,
      file: {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        conversation_id: id,
        messages: [],
        jsonMode: false,
        turnCount: 0,
        updatedAt: now,
        summary: "",
        cwd: process.cwd(),
        sanitized_at: now,
        checkpoints: [],
      },
    });
    await seedTaskFocusA(id);
    const ctx = makeCtx({
      responses: [assistantResult({ texts: ["ok"] })],
      stateOverrides: { conversationId: id },
      checkpointStore: store,
    });
    const r = await processChatLine({
      line: "Write the test suite",
      ctx: { ...ctx, verifyConfig },
    });
    assert.equal(r.ranQuery, true);
    expect(runVerifyLoopMock).toHaveBeenCalledTimes(1);
    assert.equal(
      capturedUserText(),
      "Write the test suite",
      "#473: stale taskFocus (task A) must NOT mask the new task B"
    );
  });

  it("pinned goal still wins over the current query (goal-pinned sessions keep mission focus)", async () => {
    const id = "issue473-chat-goal-wins";
    const ctx = makeCtx({
      responses: [assistantResult({ texts: ["ok"] })],
      stateOverrides: { conversationId: id },
      checkpointStore: store,
    });
    // Pin via ## GOAL: through the hub-free chat path: /goal is a slash
    // command; here we pin directly through the store (goal-pin.test.ts
    // covers the hub pin path). goal.text must bind userText.
    const now = "2026-01-01T00:00:00.000Z";
    await store.save({
      id,
      file: {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        conversation_id: id,
        messages: [],
        jsonMode: false,
        turnCount: 0,
        updatedAt: now,
        summary: "",
        cwd: process.cwd(),
        sanitized_at: now,
        checkpoints: [],
        goal: {
          text: "ship the parser",
          source: "user_pin",
          status: "active",
          createdAt: now,
          updatedAt: now,
          history: [],
        },
      },
    });
    const r = await processChatLine({
      line: "continue",
      ctx: { ...ctx, verifyConfig },
    });
    assert.equal(r.ranQuery, true);
    expect(runVerifyLoopMock).toHaveBeenCalledTimes(1);
    assert.equal(
      capturedUserText(),
      "ship the parser",
      "pinned goal must keep binding verify userText after the #473 fix"
    );
  });
});
