/**
 * #408 T4: verify-loop seam — userText = goal.text ?? query.
 *
 * runVerifyLoop is stubbed via vi.mock so we can capture its
 * `options.userText` and assert the seam binds to `session.goal.text`
 * when present (falling back to `query` when absent or empty). The
 * hub itself imports runVerifyLoop statically; vitest hoists vi.mock
 * to intercept that import.
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

// Stub runVerifyLoop BEFORE importing the hub. vi.mock is hoisted to the
// top of the file, so the mock fn + captured state must be declared via
// vi.hoisted to be initialized before the factory runs.
const { runVerifyLoopMock, getLastVerifyLoopOpts } = vi.hoisted(() => {
  let lastOpts: unknown = undefined;
  const fn = vi.fn(async (opts: unknown) => {
    lastOpts = opts;
    // Disable outcome: the test seam returns passed after a single round.
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

import { SessionHub } from "../../src/session-api/hub.ts";
import {
  CURRENT_SCHEMA_VERSION,
  resolveProjectSessionDir,
  SessionStore,
  type GoalState,
  type SessionFileV1,
} from "../../src/session-api/store/index.ts";
import { assistantResult, makeDeps } from "../cli/_fixtures.ts";
import type { VerifyConfig } from "../../src/harness/verify/types.ts";

let baseDir: string;
let store: SessionStore;

beforeAll(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "iknow-hub-goalseam-"));
  resolveProjectSessionDir(baseDir, process.cwd());
  store = new SessionStore(baseDir);
});

afterAll(async () => {
  await rm(baseDir, { recursive: true, force: true });
});

afterEach(() => {
  runVerifyLoopMock.mockClear();
});

async function seedSession(opts: {
  readonly id: string;
  readonly goal?: GoalState;
}): Promise<void> {
  const base = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    conversation_id: opts.id,
    messages: [],
    jsonMode: false,
    turnCount: 0,
    updatedAt: "2026-01-01T00:00:00.000Z",
    summary: "",
    cwd: process.cwd(),
    sanitized_at: "2026-01-01T00:00:00.000Z",
    checkpoints: [],
  } satisfies Omit<SessionFileV1, "goal">;
  await store.save({
    id: opts.id,
    file:
      opts.goal !== undefined
        ? ({ ...base, goal: opts.goal } as SessionFileV1)
        : (base as SessionFileV1),
  });
}

function makeHub(): SessionHub {
  // verifyConfig present → runVerifyLoop is invoked. The command is
  // irrelevant because runVerifyLoop itself is stubbed; the mock just
  // captures the userText and calls runFn directly.
  const verifyConfig: VerifyConfig = { command: "/bin/true" };
  return new SessionHub({
    store,
    deps: makeDeps([assistantResult({ texts: ["ok"] })]),
    verifyConfig,
  });
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

describe("verify-loop seam: userText = goal.text ?? query (#408 T4)", () => {
  it("session carrying goal.text binds userText === goal.text (NOT current query)", async () => {
    const id = "goal-bearing";
    await seedSession({
      id,
      goal: {
        text: "Type-system-validate-LSP",
        source: "user_initial",
        status: "active",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    });
    const hub = makeHub();
    const res = await hub.postMessage({
      conversationId: id,
      text: "test it",
    });
    assert.equal(res.turn.answer.stopReason, "completed");
    expect(runVerifyLoopMock).toHaveBeenCalledTimes(1);
    assert.equal(
      capturedUserText(),
      "Type-system-validate-LSP",
      "session goal must bind to verify-loop userText"
    );
  });

  it("session without goal → userText === query (byte-identical to pre-#408)", async () => {
    const id = "no-goal-baseline";
    await seedSession({ id });
    const hub = makeHub();
    const res = await hub.postMessage({
      conversationId: id,
      text: "build the thing",
    });
    assert.equal(res.turn.answer.stopReason, "completed");
    expect(runVerifyLoopMock).toHaveBeenCalledTimes(1);
    assert.equal(capturedUserText(), "build the thing");
  });

  it("goal.text === '' falls back to query (defensive — empty goal must NOT be re-fed)", async () => {
    const id = "empty-goal-text";
    await seedSession({
      id,
      goal: {
        text: "",
        source: "user_initial",
        status: "active",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    });
    const hub = makeHub();
    const res = await hub.postMessage({
      conversationId: id,
      text: "non-empty query",
    });
    assert.equal(res.turn.answer.stopReason, "completed");
    expect(runVerifyLoopMock).toHaveBeenCalledTimes(1);
    assert.equal(capturedUserText(), "non-empty query");
  });

  it("goal persists across the turn (no overwrite from conditionalSave's seed path)", async () => {
    const id = "goal-persistence";
    await seedSession({
      id,
      goal: {
        text: "Type-system-validate-LSP",
        source: "user_initial",
        status: "active",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    });
    const hub = makeHub();
    await hub.postMessage({
      conversationId: id,
      text: "test it",
    });
    const after = await store.load(id);
    assert.equal(after.goal?.text, "Type-system-validate-LSP");
    assert.equal(after.goal?.source, "user_initial");
  });
});
