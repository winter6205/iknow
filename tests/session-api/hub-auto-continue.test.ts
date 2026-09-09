/**
 * Plan T3: hub postMessage auto-continue + three stop classes.
 * Same session goal fields as CLI slash / chat loop.
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
import type { RunResult } from "../../src/harness/index.ts";

let baseDir: string;
let store: SessionStore;

beforeAll(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "iknow-hub-auto-goal-"));
  resolveProjectSessionDir(baseDir, process.cwd());
  store = new SessionStore(baseDir, process.cwd());
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
    workspaceRoot: process.cwd(),
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

function makeHub(nResponses: number): SessionHub {
  const responses = Array.from({ length: nResponses }, (_, i) =>
    assistantResult({ texts: [`hub-${i + 1}`] })
  );
  const verifyConfig: VerifyConfig = { command: "" };
  return new SessionHub({
    store,
    workspaceRoot: process.cwd(),
    deps: makeDeps(responses),
    verifyConfig,
  });
}

describe("hub auto-goal host loop (plan T3)", () => {
  it("auto-continues when judge is not done, then stops on passed", async () => {
    const hub = makeHub(4);
    const { session } = await hub.createSession();
    await seedGoal(
      session.conversation_id,
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
    await hub.postMessage({
      conversationId: session.conversation_id,
      text: "go",
    });
    expect(runVerifyLoopMock).toHaveBeenCalledTimes(2);
  });

  it("Impossible clears goal", async () => {
    const hub = makeHub(3);
    const { session } = await hub.createSession();
    await seedGoal(
      session.conversation_id,
      pinGoal({
        current: undefined,
        text: "impossible task",
        now: "2026-01-01T00:00:00.000Z",
      })
    );
    stubVerify("failed", [{ reason: "Impossible: cannot satisfy the goal" }]);
    await hub.postMessage({
      conversationId: session.conversation_id,
      text: "go",
    });
    expect(runVerifyLoopMock).toHaveBeenCalledTimes(1);
    const loaded = await store.load(session.conversation_id);
    expect(loaded.goal).toBeUndefined();
  });

  it("3 idle completed-without-tool_use stops and leaves goal", async () => {
    const hub = makeHub(6);
    const { session } = await hub.createSession();
    await seedGoal(
      session.conversation_id,
      pinGoal({
        current: undefined,
        text: "keep talking",
        now: "2026-01-01T00:00:00.000Z",
      })
    );
    stubVerify("failed");
    await hub.postMessage({
      conversationId: session.conversation_id,
      text: "go",
    });
    expect(runVerifyLoopMock).toHaveBeenCalledTimes(3);
    const loaded = await store.load(session.conversation_id);
    expect(loaded.goal?.text).toBe("keep talking");
    expect(loaded.goal?.idleCompletedStreak).toBe(3);
  });

  it("## GOAL: --max-turns 1: second auto-continue does not run", async () => {
    const hub = makeHub(4);
    const { session } = await hub.createSession();
    stubVerify("failed");
    await hub.postMessage({
      conversationId: session.conversation_id,
      text: "## GOAL: --max-turns 1 ship parser",
    });
    expect(runVerifyLoopMock).toHaveBeenCalledTimes(1);
    const loaded = await store.load(session.conversation_id);
    expect(loaded.goal?.text).toBe("ship parser");
    expect(loaded.goal?.maxTurns).toBe(1);
  });

  it("/goal clear then next postMessage is HITL", async () => {
    const hub = makeHub(3);
    const { session } = await hub.createSession();
    await seedGoal(
      session.conversation_id,
      pinGoal({
        current: undefined,
        text: "was auto",
        now: "2026-01-01T00:00:00.000Z",
      })
    );
    await hub.clearGoal(session.conversation_id);
    stubVerify("passed");
    await hub.postMessage({
      conversationId: session.conversation_id,
      text: "hello",
    });
    const last = runVerifyLoopMock.mock.calls.at(-1)?.[0] as {
      completionMode?: string;
    };
    expect(last.completionMode).toBe("hitl");
    const loaded = await store.load(session.conversation_id);
    expect(loaded.goal).toBeUndefined();
  });
});

describe("hub auto-loop store.load typed catch", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("not_found on auto-error load is skipped; original run error surfaces", async () => {
    const hub = makeHub(2);
    const { session } = await hub.createSession();
    await seedGoal(
      session.conversation_id,
      pinGoal({
        current: undefined,
        text: "ship parser",
        now: "2026-01-01T00:00:00.000Z",
      })
    );
    runVerifyLoopMock.mockImplementation(async () => {
      throw new Error("model down");
    });
    const origLoad = store.load.bind(store);
    let n = 0;
    vi.spyOn(store, "load").mockImplementation(async (id: string) => {
      n += 1;
      if (n >= 2) {
        throw { kind: "not_found", conversation_id: id };
      }
      return origLoad(id);
    });
    await expect(
      hub.postMessage({
        conversationId: session.conversation_id,
        text: "go",
      })
    ).rejects.toThrow("model down");
  });

  it("parse_failed on auto-error load is skipped; original run error surfaces", async () => {
    const hub = makeHub(2);
    const { session } = await hub.createSession();
    await seedGoal(
      session.conversation_id,
      pinGoal({
        current: undefined,
        text: "ship parser",
        now: "2026-01-01T00:00:00.000Z",
      })
    );
    runVerifyLoopMock.mockImplementation(async () => {
      throw new Error("model down");
    });
    const origLoad = store.load.bind(store);
    let n = 0;
    vi.spyOn(store, "load").mockImplementation(async (id: string) => {
      n += 1;
      if (n >= 2) {
        throw {
          kind: "parse_failed",
          conversation_id: id,
          reason: "truncated",
        };
      }
      return origLoad(id);
    });
    await expect(
      hub.postMessage({
        conversationId: session.conversation_id,
        text: "go",
      })
    ).rejects.toThrow("model down");
  });

  it("unknown load throw on auto-error is not swallowed", async () => {
    const hub = makeHub(2);
    const { session } = await hub.createSession();
    await seedGoal(
      session.conversation_id,
      pinGoal({
        current: undefined,
        text: "ship parser",
        now: "2026-01-01T00:00:00.000Z",
      })
    );
    runVerifyLoopMock.mockImplementation(async () => {
      throw new Error("model down");
    });
    const origLoad = store.load.bind(store);
    let n = 0;
    vi.spyOn(store, "load").mockImplementation(async (id: string) => {
      n += 1;
      if (n >= 2) {
        throw new Error("disk exploded");
      }
      return origLoad(id);
    });
    await expect(
      hub.postMessage({
        conversationId: session.conversation_id,
        text: "go",
      })
    ).rejects.toThrow("disk exploded");
  });

  it("not_found on auto-continue persist load stops the host loop (T3)", async () => {
    const hub = makeHub(4);
    const { session } = await hub.createSession();
    await seedGoal(
      session.conversation_id,
      pinGoal({
        current: undefined,
        text: "ship parser",
        now: "2026-01-01T00:00:00.000Z",
      })
    );
    stubVerify("failed");
    const origLoad = store.load.bind(store);
    let n = 0;
    vi.spyOn(store, "load").mockImplementation(async (id: string) => {
      n += 1;
      if (n >= 4) {
        throw { kind: "not_found", conversation_id: id };
      }
      return origLoad(id);
    });
    await hub.postMessage({
      conversationId: session.conversation_id,
      text: "go",
    });
    expect(runVerifyLoopMock).toHaveBeenCalledTimes(1);
  });
});
