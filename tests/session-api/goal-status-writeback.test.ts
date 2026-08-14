/**
 * #408 T5: status write-back on verify-loop terminal outcome.
 *
 * The hub is the ONLY writer of goal.status. When the verify-loop returns
 * a terminal `outcome` of "passed" or "aborted", the hub writes back
 * goal.status = "achieved" / "aborted" respectively via the existing
 * conditionalSave path. failed / unstable / escalated / disabled leave
 * goal.status unchanged (still "active"). runVerifyLoop never sets
 * goal.status itself (verified by a grep on its body — no `goal` refs).
 *
 * Stub runVerifyLoop via vi.mock and vary its returned `outcome`.
 */
import { afterAll, beforeAll, describe, it, vi } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { runVerifyLoopMock, setOutcome } = vi.hoisted(() => {
  let outcome: string = "passed";
  const fn = vi.fn(async (opts: unknown) => {
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
    const r = await o.runFn("whatever", {});
    return {
      result: r.result,
      trace: r.trace,
      rounds: 0,
      enabled: true,
      outcome,
      records: [],
    };
  });
  return {
    runVerifyLoopMock: fn,
    setOutcome: (o: string) => {
      outcome = o;
    },
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
  baseDir = await mkdtemp(join(tmpdir(), "iknow-hub-goalstatus-"));
  resolveProjectSessionDir(baseDir, process.cwd());
  store = new SessionStore(baseDir);
});

afterAll(async () => {
  await rm(baseDir, { recursive: true, force: true });
});

const activeGoal: GoalState = {
  text: "Type-system-validate-LSP",
  source: "user_initial",
  status: "active",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

async function seedSession(id: string, goal: GoalState): Promise<void> {
  await store.save({
    id,
    file: {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      conversation_id: id,
      messages: [],
      jsonMode: false,
      turnCount: 0,
      updatedAt: "2026-01-01T00:00:00.000Z",
      summary: "",
      cwd: process.cwd(),
      sanitized_at: "2026-01-01T00:00:00.000Z",
      checkpoints: [],
      goal,
    } as SessionFileV1,
  });
}

function makeHub(): SessionHub {
  const verifyConfig: VerifyConfig = { command: "/bin/true" };
  return new SessionHub({
    store,
    deps: makeDeps([assistantResult({ texts: ["ok"] })]),
    verifyConfig,
  });
}

async function load(id: string): Promise<SessionFileV1> {
  return store.load(id);
}

describe("goal.status write-back on verify-loop outcome (#408 T5)", () => {
  it("outcome 'passed' → goal.status === 'achieved'", async () => {
    setOutcome("passed");
    const id = "t5-passed";
    await seedSession(id, activeGoal);
    const hub = makeHub();
    await hub.postMessage({ conversationId: id, text: "test it" });
    const after = await load(id);
    assert.equal(after.goal?.status, "achieved");
    assert.equal(after.goal?.text, "Type-system-validate-LSP");
  });

  it("outcome 'aborted' → goal.status === 'aborted'", async () => {
    setOutcome("aborted");
    const id = "t5-aborted";
    await seedSession(id, activeGoal);
    const hub = makeHub();
    await hub.postMessage({ conversationId: id, text: "test it" });
    const after = await load(id);
    assert.equal(after.goal?.status, "aborted");
  });

  it("outcome 'failed' / 'unstable' / 'escalated' → goal.status unchanged (active)", async () => {
    for (const outcome of ["failed", "unstable", "escalated"]) {
      setOutcome(outcome);
      const id = `t5-${outcome}`;
      await seedSession(id, activeGoal);
      const hub = makeHub();
      await hub.postMessage({ conversationId: id, text: "test it" });
      const after = await load(id);
      assert.equal(
        after.goal?.status,
        "active",
        `outcome ${outcome} must NOT change status`
      );
    }
  });

  it("outcome 'disabled' → goal.status unchanged (active)", async () => {
    setOutcome("disabled");
    const id = "t5-disabled";
    await seedSession(id, activeGoal);
    const hub = makeHub();
    await hub.postMessage({ conversationId: id, text: "test it" });
    const after = await load(id);
    assert.equal(after.goal?.status, "active");
  });

  it("fresh session: T2 seeds the goal (text from first user message), write-back fires on passed", async () => {
    // Integration of T2 (seed) + T5 (write-back): on a fresh session, the
    // first user message seeds the goal via T2's conditionalSave path,
    // then T5's verify-outcome write-back promotes status to 'achieved'.
    // The goal text equals the first user message text that T2 seeded.
    setOutcome("passed");
    const id = "t5-fresh-session";
    // Create empty session file (no goal yet).
    await store.save({
      id,
      file: {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        conversation_id: id,
        messages: [],
        jsonMode: false,
        turnCount: 0,
        updatedAt: "2026-01-01T00:00:00.000Z",
        summary: "",
        cwd: process.cwd(),
        sanitized_at: "2026-01-01T00:00:00.000Z",
        checkpoints: [],
      } as SessionFileV1,
    });
    const hub = makeHub();
    await hub.postMessage({ conversationId: id, text: "Build a thing" });
    const after = await load(id);
    assert.ok(after.goal, "T2 must seed the goal");
    assert.equal(after.goal?.status, "achieved", "T5 must promote to achieved");
    // Goal text was seeded from extractGoal(result.messages); the stub's
    // hardcoded runFn input is what reaches the model, so we don't assert
    // on the exact text (T4's seam test covers that bound).
  });
});
