/**
 * Plan T3: chat host auto-continue + three stop classes.
 * runVerifyLoop is mocked so each call is one host auto-turn.
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

const { runVerifyLoopMock } = vi.hoisted(() => {
  const fn = vi.fn();
  return { runVerifyLoopMock: fn };
});

vi.mock("../../src/harness/verify/index.ts", async () => {
  const actual = await vi.importActual<
    typeof import("../../src/harness/verify/index.ts")
  >("../../src/harness/verify/index.ts");
  return { ...actual, runVerifyLoop: runVerifyLoopMock };
});

import { processChatLine } from "../../src/cli/chat-session.ts";
import {
  CURRENT_SCHEMA_VERSION,
  pinGoal,
  SessionStore,
  type GoalState,
  type SessionFileV1,
} from "../../src/session-api/store/index.ts";
import { assistantResult, makeCtx } from "./_fixtures.ts";
import type { VerifyConfig } from "../../src/harness/verify/types.ts";
import type { RunResult } from "../../src/harness/index.ts";

let baseDir: string;
let store: SessionStore;

beforeAll(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "iknow-chat-auto-goal-"));
  store = new SessionStore(baseDir);
});

afterAll(async () => {
  await rm(baseDir, { recursive: true, force: true });
});

afterEach(() => {
  runVerifyLoopMock.mockReset();
});

async function seedGoal(id: string, goal: GoalState): Promise<void> {
  const now = "2026-01-01T00:00:00.000Z";
  const file: SessionFileV1 = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    conversation_id: id,
    messages: [],
    jsonMode: false,
    turnCount: 0,
    updatedAt: now,
    title: "",
    cwd: process.cwd(),
    sanitized_at: now,
    checkpoints: [],
    goal,
  };
  await store.save({ id, file });
}

function stubVerify(outcome: string, records: unknown[] = []) {
  runVerifyLoopMock.mockImplementation(async (opts: unknown) => {
    const o = opts as {
      runFn: (
        text: string,
        extra?: unknown
      ) => Promise<{ result: RunResult; trace: unknown }>;
    };
    const r = await o.runFn("ignored", {});
    return {
      result: r.result,
      trace: r.trace,
      rounds: 1,
      enabled: true,
      outcome,
      records,
    };
  });
}

function chatCtx(id: string, nResponses: number) {
  const responses = Array.from({ length: nResponses }, (_, i) =>
    assistantResult({ texts: [`turn-${i + 1}`] })
  );
  const ctx = makeCtx({
    responses,
    checkpointStore: store,
    stateOverrides: { conversationId: id },
  });
  const verifyConfig: VerifyConfig = { command: "" };
  return { ...ctx, verifyConfig };
}

describe("chat auto-goal host loop (plan T3)", () => {
  it("auto-continues when judge is not done, then stops on passed", async () => {
    const id = "chat-auto-continue";
    await seedGoal(
      id,
      pinGoal({
        current: undefined,
        text: "ship parser",
        now: "2026-01-01T00:00:00.000Z",
      })
    );
    let n = 0;
    runVerifyLoopMock.mockImplementation(async (opts: unknown) => {
      n += 1;
      const o = opts as {
        runFn: (
          text: string,
          extra?: unknown
        ) => Promise<{ result: RunResult; trace: unknown }>;
      };
      const r = await o.runFn("ignored", {});
      return {
        result: r.result,
        trace: r.trace,
        rounds: 1,
        enabled: true,
        outcome: n === 1 ? "failed" : "passed",
        records: [],
      };
    });
    const ctx = chatCtx(id, 4);
    const r = await processChatLine({ line: "go", ctx });
    assert.equal(r.ranQuery, true);
    expect(runVerifyLoopMock).toHaveBeenCalledTimes(2);
  });

  it("Impossible clears goal", async () => {
    const id = "chat-impossible";
    await seedGoal(
      id,
      pinGoal({
        current: undefined,
        text: "impossible task",
        now: "2026-01-01T00:00:00.000Z",
      })
    );
    stubVerify("failed", [{ reason: "Impossible: cannot satisfy the goal" }]);
    const ctx = chatCtx(id, 3);
    await processChatLine({ line: "go", ctx });
    expect(runVerifyLoopMock).toHaveBeenCalledTimes(1);
    const loaded = await store.load(id);
    expect(loaded.goal).toBeUndefined();
  });

  it("3 idle completed-without-tool_use stops and leaves goal", async () => {
    const id = "chat-idle";
    await seedGoal(
      id,
      pinGoal({
        current: undefined,
        text: "keep talking",
        now: "2026-01-01T00:00:00.000Z",
      })
    );
    stubVerify("failed");
    const ctx = chatCtx(id, 6);
    await processChatLine({ line: "go", ctx });
    expect(runVerifyLoopMock).toHaveBeenCalledTimes(3);
    const loaded = await store.load(id);
    expect(loaded.goal?.text).toBe("keep talking");
    expect(loaded.goal?.idleCompletedStreak).toBe(3);
  });

  it("/goal --max-turns 1: second auto-continue does not run", async () => {
    const id = "chat-max-turns-1";
    stubVerify("failed");
    const ctx = chatCtx(id, 4);
    const pin = await processChatLine({
      line: "/goal --max-turns 1 ship parser",
      ctx,
    });
    expect(pin.stderr).toBeUndefined();
    expect(runVerifyLoopMock).toHaveBeenCalledTimes(1);
    const loaded = await store.load(id);
    expect(loaded.goal?.text).toBe("ship parser");
    expect(loaded.goal?.maxTurns).toBe(1);
  });

  it("/goal clear then next turn is HITL", async () => {
    const id = "chat-clear-hitl";
    await seedGoal(
      id,
      pinGoal({
        current: undefined,
        text: "was auto",
        now: "2026-01-01T00:00:00.000Z",
      })
    );
    const ctx = chatCtx(id, 2);
    const cleared = await processChatLine({ line: "/goal clear", ctx });
    expect(cleared.output).toContain("goal cleared");
    stubVerify("passed");
    await processChatLine({ line: "hello", ctx });
    const last = runVerifyLoopMock.mock.calls.at(-1)?.[0] as {
      completionMode?: string;
    };
    expect(last.completionMode).toBe("hitl");
    const loaded = await store.load(id);
    expect(loaded.goal).toBeUndefined();
  });
});
