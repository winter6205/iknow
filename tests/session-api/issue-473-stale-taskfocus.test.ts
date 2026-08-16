/**
 * #473 regression: verify-loop must NOT consume the stale taskFocus as the
 * current task.
 *
 * Repro (issue #473): task A completes → `taskFocus.text = A` (seeded once,
 * immutable by OQ2 design). New task B arrives → the verify seam's
 * three-segment fallback `goal.text ?? taskFocus.text ?? query` hit the
 * stale taskFocus segment, so the verify-loop's first `runFn` round fed the
 * model task A's text instead of B — the evidence gate saw A's (already
 * sufficient) evidence and short-circuited PASS without ever executing B.
 *
 * Fix direction 3 (issue #473): verify userText = `goal.text ?? query` —
 * the stable taskFocus stays out of the verify input. taskFocus keeps its
 * compact-boundary rendering + `/goal status` roles; its lifecycle is
 * UNCHANGED by this fix (the OQ2 guard below asserts taskFocus is NOT
 * switched per query, so the fix can not silently drift into direction 1).
 *
 * Fixture note: taskFocus is pre-seeded via store.save (the exact state
 * "task A completed → taskFocus.text = A"). Relying on hub's own seed path
 * is unsafe here because the mocked runVerifyLoop feeds a literal text into
 * the real harness run(), which conditionalSave would then seed into
 * taskFocus. Pre-seeding also matches goal-seam.test.ts's fixture pattern.
 * The seed path itself is covered by hub-goal.test.ts.
 *
 * Mock seam: `vi.mock("../../src/harness/verify/index.ts")` captures the
 * verify-loop opts (same pattern as goal-seam.test.ts) — this test asserts
 * the userText the verify loop RECEIVES, which is exactly the value the
 * first runFn round feeds the model.
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

import { SessionHub } from "../../src/session-api/hub.ts";
import {
  CURRENT_SCHEMA_VERSION,
  resolveProjectSessionDir,
  SessionStore,
  type TaskFocusState,
} from "../../src/session-api/store/index.ts";
import { assistantResult, makeDeps } from "../cli/_fixtures.ts";
import type { VerifyConfig } from "../../src/harness/verify/types.ts";

let baseDir: string;
let store: SessionStore;

beforeAll(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "iknow-hub-issue473-"));
  resolveProjectSessionDir(baseDir, process.cwd());
  store = new SessionStore(baseDir);
});

afterAll(async () => {
  await rm(baseDir, { recursive: true, force: true });
});

afterEach(() => {
  runVerifyLoopMock.mockClear();
});

function makeHub(): SessionHub {
  const verifyConfig: VerifyConfig = { command: "/bin/true" };
  return new SessionHub({
    store,
    deps: makeDeps([assistantResult({ texts: ["ok"] })]),
    verifyConfig,
  });
}

/** Seed taskFocus = task A directly (the "task A completed" state). */
async function seedTaskFocusA(id: string): Promise<void> {
  const now = "2026-01-01T00:00:00.000Z";
  const file = await store.load(id);
  const taskFocus: TaskFocusState = {
    text: "Build a C compiler",
    updatedAt: now,
    history: [{ text: "Build a C compiler", updatedAt: now }],
  };
  await store.save({
    id,
    file: { ...file, taskFocus } as Parameters<SessionStore["save"]>[0]["file"],
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

describe("#473: verify userText must not be masked by stale taskFocus (hub seam)", () => {
  it("new task B after completed task A → verify userText === B (NOT stale taskFocus A)", async () => {
    const hub = makeHub();
    const { session } = await hub.createSession();
    const id = session.conversation_id;
    // Precondition: task A completed → taskFocus.text = A.
    await seedTaskFocusA(id);
    const afterA = await store.load(id);
    assert.equal(
      afterA.taskFocus?.text,
      "Build a C compiler",
      "precondition: taskFocus seeded from task A"
    );
    assert.equal(afterA.goal, undefined, "precondition: no pinned goal");
    // Turn — new task B: verify must execute/verify B, not re-verify A.
    await hub.postMessage({ conversationId: id, text: "Write the test suite" });
    expect(runVerifyLoopMock).toHaveBeenCalledTimes(1);
    assert.equal(
      capturedUserText(),
      "Write the test suite",
      "#473: stale taskFocus (task A) must NOT mask the new task B"
    );
  });

  it("taskFocus lifecycle is unchanged by the fix (no per-query switching — direction 1 guard)", async () => {
    const hub = makeHub();
    const { session } = await hub.createSession();
    const id = session.conversation_id;
    await seedTaskFocusA(id);
    await hub.postMessage({ conversationId: id, text: "Write the test suite" });
    const afterB = await store.load(id);
    // OQ2: taskFocus is the stable focus anchor — a plain new query does NOT
    // switch it (locked by hub-goal.test.ts "does NOT re-seed on subsequent
    // turns"; re-asserted here so the #473 fix stays direction 3).
    assert.equal(afterB.taskFocus?.text, "Build a C compiler");
    assert.equal(afterB.taskFocus?.history?.length, 1);
  });

  it("pinned goal still wins over the current query (goal-pinned sessions keep mission focus)", async () => {
    const hub = makeHub();
    const { session } = await hub.createSession();
    const id = session.conversation_id;
    await hub.postMessage({
      conversationId: id,
      text: "## GOAL: ship the parser",
    });
    runVerifyLoopMock.mockClear();
    await hub.postMessage({ conversationId: id, text: "continue" });
    expect(runVerifyLoopMock).toHaveBeenCalledTimes(1);
    assert.equal(
      capturedUserText(),
      "ship the parser",
      "pinned goal must keep binding verify userText after the #473 fix"
    );
  });

  it("fresh session without taskFocus → userText === query (byte-identical baseline)", async () => {
    const hub = makeHub();
    const { session } = await hub.createSession();
    await hub.postMessage({
      conversationId: session.conversation_id,
      text: "build the thing",
    });
    expect(runVerifyLoopMock).toHaveBeenCalledTimes(1);
    assert.equal(capturedUserText(), "build the thing");
  });
});
