/**
 * verify-loop seam — userText = `goal.text ?? query` (the only formula
 * since the taskFocus field's retirement). Task focus was once provided by
 * a taskFocus segment (a stable anchor, unchanged after first seeding);
 * after its removal from the verify consumer and the field's wholesale
 * retirement, `goal.text ?? query` is the sole formula.
 *
 * This file guards only the CONSUMER-side seam (verify-loop userText
 * binding); the DATA-side three-segment formula retired together with
 * `session.taskFocus` and is no longer described separately.
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
  pinGoal,
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
  store = new SessionStore(baseDir, process.cwd());
});

afterAll(async () => {
  await rm(baseDir, { recursive: true, force: true });
});

afterEach(() => {
  runVerifyLoopMock.mockClear();
});

/** Pre-#605 legacy on-disk shape — runtime type was retired in #605 T2; we
 *  pass this through the `as SessionFileV1` cast below to exercise the
 *  sanitize-drop path (assertion: legacy taskFocus key disappears on load). */
interface LegacyTaskFocusState {
  text: string;
  updatedAt: string;
  history?: ReadonlyArray<{ text: string; updatedAt: string }>;
}

async function seedSession(opts: {
  readonly id: string;
  readonly goal?: GoalState;
  readonly taskFocus?: LegacyTaskFocusState;
}): Promise<void> {
  const now = "2026-01-01T00:00:00.000Z";
  const base = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    conversation_id: opts.id,
    messages: [],
    jsonMode: false,
    turnCount: 0,
    updatedAt: now,
    title: "",
    cwd: process.cwd(),
    sanitized_at: now,
    checkpoints: [],
    workspaceRoot: process.cwd(),
  } satisfies Omit<SessionFileV1, "goal" | "taskFocus">;
  await store.save({
    id: opts.id,
    file:
      opts.goal !== undefined || opts.taskFocus !== undefined
        ? ({
            ...base,
            ...(opts.goal !== undefined ? { goal: opts.goal } : {}),
            ...(opts.taskFocus !== undefined
              ? { taskFocus: opts.taskFocus }
              : {}),
          } as SessionFileV1)
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
    workspaceRoot: process.cwd(),
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

function capturedCompletionMode(): unknown {
  const opts = getLastVerifyLoopOpts() as
    { completionMode?: unknown } | undefined;
  assert.ok(opts !== undefined, "runVerifyLoop was not called");
  return opts.completionMode;
}

describe("verify-loop seam: userText = goal.text ?? query (#408 T4 / #458 T8)", () => {
  it("session carrying user_pin goal.text binds userText === goal.text (NOT current query)", async () => {
    const id = "goal-bearing";
    // #458 T2 (SC4): use user_pin so the goal survives sanitize (user_initial
    // would migrate to taskFocus on load).
    await seedSession({
      id,
      goal: pinGoal({
        current: undefined,
        text: "Type-system-validate-LSP",
        now: "2026-01-01T00:00:00.000Z",
      }),
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
    assert.equal(capturedCompletionMode(), "auto");
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
    assert.equal(capturedCompletionMode(), "hitl");
  });

  it("goal.text === '' falls back to query (defensive — empty goal must NOT be re-fed)", async () => {
    const id = "empty-goal-text";
    await seedSession({
      id,
      goal: {
        text: "",
        source: "user_pin",
        status: "active",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        history: [
          {
            text: "previous-pinned-text",
            source: "user_pin",
            status: "superseded",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
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

  it("user_pin goal persists across the turn (no overwrite from conditionalSave's seed path)", async () => {
    const id = "goal-persistence";
    await seedSession({
      id,
      goal: pinGoal({
        current: undefined,
        text: "Type-system-validate-LSP",
        now: "2026-01-01T00:00:00.000Z",
      }),
    });
    const hub = makeHub();
    await hub.postMessage({
      conversationId: id,
      text: "test it",
    });
    const after = await store.load(id);
    assert.equal(after.goal?.text, "Type-system-validate-LSP");
    assert.equal(after.goal?.source, "user_pin");
  });

  // -- Consumer-side userText formula: `goal.text ?? query`. The taskFocus
  // segment is removed from verify input — taskFocus is a stable focus
  // anchor, and feeding it into verify lets a new task be shadowed by the
  // old focus and mis-verdicted PASS. The empty-goal-skip discipline is
  // unchanged (empty text never feeds verify-loop).

  it("goal absent + taskFocus present → userText === query (taskFocus 不遮蔽当前 query, #473)", async () => {
    const id = "taskfocus-binds";
    await seedSession({
      id,
      taskFocus: {
        text: "TF: implement AST visitors",
        updatedAt: "2026-01-01T00:00:00.000Z",
        history: [],
      },
    });
    const hub = makeHub();
    const res = await hub.postMessage({
      conversationId: id,
      text: "Q",
    });
    assert.equal(res.turn.answer.stopReason, "completed");
    expect(runVerifyLoopMock).toHaveBeenCalledTimes(1);
    assert.equal(
      capturedUserText(),
      "Q",
      "goal 缺席 + taskFocus 在场 → userText 应取当前 query (taskFocus 不进 verify 输入, #473)"
    );
  });

  it("goal.text === '' + taskFocus present → userText === query (空 goal 按缺席算 → 兜底 query, #473)", async () => {
    const id = "empty-goal-taskfocus-binds";
    await seedSession({
      id,
      goal: {
        text: "",
        source: "user_pin",
        status: "active",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        history: [],
      },
      taskFocus: {
        text: "TF takes over empty goal",
        updatedAt: "2026-01-01T00:00:00.000Z",
        history: [],
      },
    });
    const hub = makeHub();
    const res = await hub.postMessage({
      conversationId: id,
      text: "Q",
    });
    assert.equal(res.turn.answer.stopReason, "completed");
    expect(runVerifyLoopMock).toHaveBeenCalledTimes(1);
    assert.equal(
      capturedUserText(),
      "Q",
      "goal.text === '' 跳过第一段 → 兜底 query (taskFocus 不进 verify 输入, #473)"
    );
  });

  it("taskFocus.text === '' → falls back to query (空 taskFocus 不进 verify 输入, #449 B8)", async () => {
    const id = "empty-taskfocus";
    await seedSession({
      id,
      taskFocus: {
        text: "",
        updatedAt: "2026-01-01T00:00:00.000Z",
        history: [],
      },
    });
    const hub = makeHub();
    const res = await hub.postMessage({
      conversationId: id,
      text: "Q",
    });
    assert.equal(res.turn.answer.stopReason, "completed");
    expect(runVerifyLoopMock).toHaveBeenCalledTimes(1);
    assert.equal(capturedUserText(), "Q", "taskFocus.text === '' → 兜底 query");
  });
});
