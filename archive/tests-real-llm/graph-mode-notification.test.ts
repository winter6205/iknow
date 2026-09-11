/**
 * Real-LLM golden set: graph mode notification steers first-tool choice.
 *
 * Same three fixtures as tests/harness/graph/graph-mode-notification.test.ts.
 * Graph mode is ON for every fixture (switch notification + per-hop presence
 * are the model-visible text under test), and a stub Executor records tool
 * dispatches while letting non-delegation tools run for real.
 *
 * HAS_KEY missing → describe.skip + Not run (do not fail CI without key).
 */

import { afterAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadIknowEnv } from "../../src/config/env.ts";
import { buildHarnessEngine } from "../../src/harness/build-engine.ts";
import { createGraphModeContext } from "../../src/harness/graph/mode.ts";
import { createNoAskUser } from "../../src/harness/permission/ask-user.ts";
import { run } from "../../src/harness/loop-engine.ts";
import { MaxTurnsExceeded } from "../../src/harness/errors.ts";
import type {
  Executor,
  ToolCall,
  ToolExecutionResult,
} from "../../src/harness/tools/types.ts";
import {
  GRAPH_NOTIFICATION_FIXTURES,
  type GraphNotificationFixtureId,
} from "../../tests/harness/graph/graph-mode-notification.fixtures.ts";

const env = loadIknowEnv(process.cwd());
const HAS_KEY =
  typeof env.llm.apiKey === "string" &&
  env.llm.apiKey.length > 0 &&
  env.llm.apiKey !== "your-api-key" &&
  !env.llm.apiKey.startsWith("YOUR_");
if (!HAS_KEY) console.log("[SKIP] LLM key not set; Not run");

const runOrSkip = HAS_KEY ? describe : describe.skip;

const DELEGATION_TOOLS = new Set(["run_graph", "spawn_subagent"]);

runOrSkip("graph mode notification golden set (real-LLM)", () => {
  const roots: string[] = [];
  const shutdowns: Array<() => Promise<void>> = [];
  afterAll(async () => {
    await Promise.all(shutdowns.splice(0).map((f) => f()));
    await Promise.all(
      roots.splice(0).map((r) => rm(r, { recursive: true, force: true }))
    );
  });

  for (const fixture of GRAPH_NOTIFICATION_FIXTURES) {
    it(
      fixture.title,
      async () => {
        const { firstTool } = await runFixture(fixture.id, {
          roots,
          shutdowns,
        });
        expect(firstTool, `first delegation tool for ${fixture.id}`).toBe(
          fixture.expectedFirstTool
        );
      },
      360_000
    );
  }
});

async function runFixture(
  id: GraphNotificationFixtureId,
  io: { roots: string[]; shutdowns: Array<() => Promise<void>> }
): Promise<{ firstTool: string | undefined }> {
  const fixture = GRAPH_NOTIFICATION_FIXTURES.find((f) => f.id === id);
  if (fixture === undefined) throw new Error(`missing fixture: ${id}`);

  const root = await mkdtemp(join(tmpdir(), `iknow-graph-golden-${id}-`));
  io.roots.push(root);
  await mkdir(join(root, ".iknow"), { recursive: true });

  // Graph mode ON before the engine is built: the first round's assembly
  // snapshot is already on, so the switch notification is not the seam
  // under test — the presence line is, exactly as in a live session where
  // the operator turned graph on earlier.
  const graphMode = createGraphModeContext({ enabled: true });

  const built = await buildHarnessEngine({
    env,
    askUser: createNoAskUser(),
    surface: "chat",
    userHome: join(root, "home"),
    cwd: root,
    graphMode,
  });
  if (built.shutdown) io.shutdowns.push(built.shutdown);

  const dispatched: string[] = [];
  const deps = {
    ...built.deps,
    // run_graph / spawn_subagent were already registered at engine-build
    // time (the chat surface constructs a manager internally); the executor
    // hook below is what keeps any dispatch from reaching a real worker.
    // Non-delegation tools run for real: a fixture that answers from its
    // own knowledge still has to show its first delegation call, so the
    // verdict stays about tool choice.
    executor: recordingExecutor(built.deps.executor, dispatched),
    maxTurns: 8,
  };

  let finalText = "";
  try {
    const { result } = await run(fixture.userPrompt, deps);
    finalText = result.finalText ?? "";
  } catch (err) {
    if (!(err instanceof MaxTurnsExceeded)) throw err;
    // The verdict only needs the first delegation dispatch, which is
    // recorded before the turn that would exceed the budget.
  }

  // Verdict is about which delegation entry point the model picked, not
  // about tool ordering: a read-only call before delegating is orthogonal
  // to the graph text under test.
  const firstTool = dispatched.find((n) => DELEGATION_TOOLS.has(n));
  if (firstTool === undefined) {
    // A model that skips delegation and answers from its own knowledge is
    // a steering failure too, not a test-harness problem: give it its own
    // diagnostic instead of a bare "never delegated".
    expect(
      dispatched.length,
      `${id}: no tool dispatched at all; final text was: ${finalText.slice(0, 400)}`
    ).toBeGreaterThan(0);
    expect(
      firstTool,
      `${id}: tools ran (${dispatched.join(",")}) but none was a delegation entry point — the model likely answered without delegating; final text: ${finalText.slice(0, 400)}`
    ).toBeDefined();
  }
  return { firstTool };
}

/**
 * Records every dispatched tool in order, stubbing only the delegation
 * entry points (their real handlers spawn processes; the golden set is
 * about which one the model picks, not about running a graph here).
 */
function recordingExecutor(inner: Executor, dispatched: string[]): Executor {
  return {
    executeAll: async (
      calls,
      signal,
      timeoutMs,
      conversationId,
      onSettled,
      turnId,
      onStream
    ) => {
      const out: Array<ToolExecutionResult | undefined> = Array.from(
        { length: calls.length },
        () => undefined
      );
      const pending: ToolCall[] = [];
      const pendingIndex: number[] = [];
      for (let i = 0; i < calls.length; i++) {
        const call = calls[i]!;
        dispatched.push(call.name);
        if (DELEGATION_TOOLS.has(call.name)) {
          out[i] = {
            kind: "ok",
            toolUseId: call.id,
            payload: [
              { type: "text", text: "golden-set delegation stub: recorded" },
            ],
          };
        } else {
          pending.push(call);
          pendingIndex.push(i);
        }
      }
      if (pending.length > 0) {
        const innerResults = await inner.executeAll(
          pending,
          signal,
          timeoutMs,
          conversationId,
          undefined,
          turnId,
          onStream
        );
        for (let j = 0; j < pending.length; j++) {
          out[pendingIndex[j]!] = innerResults[j]!;
        }
      }
      const settled = out.map((r, i) => {
        if (r === undefined) {
          throw new Error(`recording executor missing result at index ${i}`);
        }
        return r;
      });
      for (let i = 0; i < settled.length; i++) {
        await onSettled?.(settled[i]!, i);
      }
      return settled;
    },
  };
}
