/**
 * Real-LLM golden set: the <agent_status> reconcile line steers the model's
 * first tool after a pivot instruction arrives (spec
 * agent-status-instruction-echo T5 / SC7; incident basis ee13c787).
 *
 * Same fixtures as tests/harness/agent-status-instruction.fixtures.ts.
 * Fixed input: a stale todo ledger seeded at `<todoDir>/todos.md` (read with
 * `conversationId: undefined` — the legacy shared-root form the bar resolves
 * through) + the pivot prompt as the fresh real user message. The real chat
 * engine builds the per-hop bar, so hop one already carries the
 * `instruction:` echo and the one-time reconcile line.
 *
 * Decidable verdict: the FIRST dispatched tool of the run is `todo_write`
 * (reconcile the ledger before pursuing the new direction), not a
 * new-direction tool and not silence.
 *
 * HAS_KEY missing → describe.skip + Not run (do not fail CI without key;
 * offline green in the sibling lock does NOT substitute for this arm).
 */

import { afterAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadIknowEnv } from "../../src/config/env.ts";
import { buildHarnessEngine } from "../../src/harness/build-engine.ts";
import { createNoAskUser } from "../../src/harness/permission/ask-user.ts";
import { run } from "../../src/harness/loop-engine.ts";
import { MaxTurnsExceeded } from "../../src/harness/errors.ts";
import type { Executor } from "../../src/harness/tools/types.ts";
import type { HarnessStreamEvent } from "../../src/harness/stream.ts";
import {
  AGENT_STATUS_INSTRUCTION_FIXTURES,
  agentStatusFixtureById,
  type AgentStatusInstructionFixtureId,
} from "../../tests/harness/agent-status-instruction.fixtures.ts";

const env = loadIknowEnv(process.cwd());
const HAS_KEY =
  typeof env.llm.apiKey === "string" &&
  env.llm.apiKey.length > 0 &&
  env.llm.apiKey !== "your-api-key" &&
  !env.llm.apiKey.startsWith("YOUR_");
if (!HAS_KEY) console.log("[SKIP] LLM key not set; Not run");

const runOrSkip = HAS_KEY ? describe : describe.skip;

type AgentStatusEvent = HarnessStreamEvent & { type: "agent_status" };

runOrSkip("agent_status pivot reconcile golden set (real-LLM)", () => {
  const roots: string[] = [];
  const shutdowns: Array<() => Promise<void>> = [];
  afterAll(async () => {
    await Promise.all(shutdowns.splice(0).map((f) => f()));
    await Promise.all(
      roots.splice(0).map((r) => rm(r, { recursive: true, force: true }))
    );
  });

  for (const fixture of AGENT_STATUS_INSTRUCTION_FIXTURES) {
    it(
      fixture.title,
      async () => {
        const { firstTool, dispatched, finalText, statusEvents } =
          await runFixture(fixture.id, { roots, shutdowns });
        // Fixed-input precondition (decidable only if the model actually saw
        // the bar): first-hop snapshot carries the one-time reconcile line,
        // the verbatim instruction echo, and the non-empty stale ledger. A
        // miss here is harness wiring, not steering — keep it distinguishable
        // from the verdict failure below.
        const firstBar = statusEvents[0];
        expect(firstBar, `${fixture.id}: no agent_status event emitted`).toBeDefined();
        expect(
          firstBar!.reconcile,
          `${fixture.id}: first bar must carry the reconcile marker`
        ).toBe(true);
        expect(
          typeof firstBar!.instruction === "string" &&
            firstBar!.instruction.length > 0,
          `${fixture.id}: first bar must echo the pivot instruction`
        ).toBe(true);
        expect(
          firstBar!.openTodoLines.length,
          `${fixture.id}: first bar must carry the seeded stale ledger`
        ).toBeGreaterThan(0);
        // A model that dispatches nothing at all is a steering failure too,
        // not a harness problem: give it its own diagnostic.
        expect(
          dispatched.length,
          `${fixture.id}: no tool dispatched at all; final text was: ${finalText.slice(0, 400)}`
        ).toBeGreaterThan(0);
        expect(
          firstTool,
          `${fixture.id}: first dispatched tool must be ${fixture.expectedFirstTool} (reconcile the ledger first); dispatched order: ${dispatched.join(",")}`
        ).toBe(fixture.expectedFirstTool);
      },
      360_000
    );
  }
});

async function runFixture(
  id: AgentStatusInstructionFixtureId,
  io: { roots: string[]; shutdowns: Array<() => Promise<void>> }
): Promise<{
  firstTool: string | undefined;
  dispatched: string[];
  finalText: string;
  statusEvents: AgentStatusEvent[];
}> {
  const fixture = agentStatusFixtureById(id);

  const root = await mkdtemp(join(tmpdir(), `iknow-as-golden-${id}-`));
  io.roots.push(root);
  await mkdir(join(root, ".iknow"), { recursive: true });
  await writeFile(join(root, "todos.md"), fixture.staleLedger, "utf8");

  const built = await buildHarnessEngine({
    env,
    askUser: createNoAskUser(),
    surface: "chat",
    userHome: join(root, "home"),
    cwd: root,
    // Same gate the live chat surface drives: todoDir registers todo_write
    // AND assembles deps.agentStatus (build-engine 同门纪律) — without it the
    // bar would inject but the tool named by the reconcile line would not
    // exist, making the verdict structurally unachievable.
    todoDir: root,
  });
  if (built.shutdown) io.shutdowns.push(built.shutdown);

  const dispatched: string[] = [];
  const statusEvents: AgentStatusEvent[] = [];
  const deps = {
    ...built.deps,
    executor: recordingExecutor(built.deps.executor, dispatched),
    // conversationId undefined → readOpenTodoLines resolves the seeded
    // shared-root ledger `<todoDir>/todos.md`.
    conversationId: undefined,
    maxTurns: 4,
  };

  let finalText = "";
  try {
    const { result } = await run(fixture.pivotPrompt, deps, undefined, {
      onStream: (event) => {
        if (event.type === "agent_status") statusEvents.push(event);
      },
    });
    finalText = result.finalText ?? "";
  } catch (err) {
    if (!(err instanceof MaxTurnsExceeded)) throw err;
    // The verdict only needs the first dispatch, recorded before any turn
    // that could exceed the budget.
  }

  return { firstTool: dispatched[0], dispatched, finalText, statusEvents };
}

/**
 * Records every dispatched tool in order and lets all tools run for real:
 * the verdict is about the model's first move under the reconcile line, so
 * nothing is stubbed here.
 */
function recordingExecutor(inner: Executor, dispatched: string[]): Executor {
  return {
    executeAll: (calls, ...rest) => {
      for (const call of calls) dispatched.push(call.name);
      return inner.executeAll(calls, ...rest);
    },
  };
}
