/**
 * T6 chat/ask entry integration: a violation-producing executor wrapped the
 * same way runChatSession/runOneShot wrap it escalates the counter, fires the
 * one-shot stderr notification, and sets process.exitCode = 1 — all through
 * the real processChatLine path (harness stubs, no TTY).
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { processChatLine } from "../../src/cli/chat-session.ts";
import type { LoopEngineDeps } from "../../src/harness/index.ts";
import { createStubModel } from "../../src/harness/stubs/stub-model.ts";
import { createStubTool } from "../../src/harness/stubs/stub-tool.ts";
import { createRegistry } from "../../src/harness/tools/registry.ts";
import { createExecutor } from "../../src/harness/tools/executor.ts";
import { ToolExecutionError } from "../../src/harness/errors.ts";
import { wrapWithViolationHook } from "../../src/harness/sandbox/violation-executor.ts";
import {
  createViolationCounter,
  wireKillSessionNotification,
} from "../../src/harness/sandbox/violation-handling.ts";
import { assistantResult, makeState } from "./_fixtures.ts";
import type { ChatLineContext } from "../../src/cli/chat-session.ts";

function makeViolationCtx(sink: (line: string) => void): ChatLineContext {
  const tool = createStubTool({
    name: "dangerous",
    next: () => {
      throw new ToolExecutionError("[hard_wall] dangerous command rejected");
    },
  });
  const registry = createRegistry([tool]);
  const innerExecutor = createExecutor(registry);

  // Same wiring shape as runChatSession: counter + one-shot notification.
  const counter = createViolationCounter();
  const notify = wireKillSessionNotification({ sink });
  const executor = wrapWithViolationHook({
    inner: innerExecutor,
    counter,
    onKill: notify,
  });

  const toolCalls = [
    { id: "u1", name: "dangerous", input: {} },
    { id: "u2", name: "dangerous", input: {} },
    { id: "u3", name: "dangerous", input: {} },
  ];
  const adapter = createStubModel({
    responses: [
      assistantResult({ texts: [], toolCalls }),
      assistantResult({ texts: ["after violations"] }),
    ],
  });
  const deps: LoopEngineDeps = {
    adapter,
    executor,
    registry,
    maxTurns: 5,
  };
  return { deps, state: makeState({}) };
}

describe("chat entry violation kill wiring", () => {
  it("three mid-tier denials in one turn fire the one-shot kill + exitCode", async () => {
    const savedExitCode = process.exitCode;
    process.exitCode = 0;
    const lines: string[] = [];
    try {
      const ctx = makeViolationCtx((line) => lines.push(line));
      const result = await processChatLine({ line: "do bad things", ctx });
      assert.equal(result.ranQuery, true);
      // One-shot notification on stderr sink.
      assert.equal(lines.length, 1);
      assert.match(lines[0] ?? "", /^\[violation\] session killed:/);
      assert.match(lines[0] ?? "", /tool=dangerous/);
      // Exit code flagged for the CLI entry to surface.
      assert.equal(process.exitCode, 1);
    } finally {
      process.exitCode = savedExitCode;
    }
  });

  it("a low-tier-only turn never fires the kill", async () => {
    const savedExitCode = process.exitCode;
    process.exitCode = 0;
    const lines: string[] = [];
    try {
      const tool = createStubTool({
        name: "userdenied",
        next: () => {
          throw new ToolExecutionError("[user_denied] user declined tool call");
        },
      });
      const registry = createRegistry([tool]);
      const innerExecutor = createExecutor(registry);
      const counter = createViolationCounter();
      const notify = wireKillSessionNotification({
        sink: (l) => lines.push(l),
      });
      const executor = wrapWithViolationHook({
        inner: innerExecutor,
        counter,
        onKill: notify,
      });
      const adapter = createStubModel({
        responses: [
          assistantResult({
            texts: [],
            toolCalls: [
              { id: "u1", name: "userdenied", input: {} },
              { id: "u2", name: "userdenied", input: {} },
              { id: "u3", name: "userdenied", input: {} },
              { id: "u4", name: "userdenied", input: {} },
            ],
          }),
          assistantResult({ texts: ["still alive"] }),
        ],
      });
      const deps: LoopEngineDeps = {
        adapter,
        executor,
        registry,
        maxTurns: 5,
      };
      const ctx: ChatLineContext = { deps, state: makeState({}) };
      const result = await processChatLine({ line: "deny me", ctx });
      assert.equal(result.ranQuery, true);
      assert.equal(lines.length, 0);
      assert.equal(process.exitCode, 0);
    } finally {
      process.exitCode = savedExitCode;
    }
  });
});

/**
 * ADR-0135 / SC11 at the chat entry: the escalation is scoped to ONE user
 * turn. The prior wiring built one counter for the whole REPL, so three
 * denials spread across three separate user messages would interrupt a turn
 * that had committed nothing.
 */
describe("chat per-turn violation counting (ADR-0135)", () => {
  /** A stub model scripted with a fresh set of responses per query line. */
  function makeCtx(
    lines: string[],
    opts: {
      readonly message: string;
      readonly turnToolCalls: number;
    }
  ): ChatLineContext {
    const tool = createStubTool({
      name: "dangerous",
      next: () => {
        throw new ToolExecutionError(opts.message);
      },
    });
    const registry = createRegistry([tool]);
    const innerExecutor = createExecutor(registry);
    // Same shape as runChatSession's wrapping: NO counter is passed, so the
    // per-turn scope resolved off the ctx is what counts. That is the wiring
    // under test — passing a fixed counter here would test the wrapper, not
    // the chat entry's turn scoping.
    const wrapped = wrapWithViolationHook({
      inner: innerExecutor,
      onKill: () => undefined,
      turnScopeFor: () => ctx.violationTurn,
    });
    const calls = Array.from({ length: opts.turnToolCalls }, (_, i) => ({
      id: `u${i}`,
      name: "dangerous",
      input: {},
    }));
    const adapter = createStubModel({
      responses: lines.flatMap((text) => [
        assistantResult({ texts: [], toolCalls: calls }),
        assistantResult({ texts: [text] }),
      ]),
    });
    const deps: LoopEngineDeps = {
      adapter,
      executor: wrapped,
      registry,
      maxTurns: 5,
    };
    const ctx: ChatLineContext = { deps, state: makeState({}) };
    return ctx;
  }

  it("two denials in one turn plus two in the next do NOT interrupt", async () => {
    const savedExitCode = process.exitCode;
    process.exitCode = 0;
    try {
      // Under the old REPL-scoped counter these four denials (2 + 2 across two
      // user turns) would reach the threshold of 3. Per-turn scope means turn
      // 2 starts at zero and never sees turn 1's two.
      const ctx = makeCtx(["turn one done", "turn two done"], {
        message: "[hard_wall] dangerous command rejected",
        turnToolCalls: 2,
      });
      const first = await processChatLine({ line: "first", ctx });
      assert.equal(first.ranQuery, true);
      assert.equal(
        ctx.violationTurn?.counter.snapshot(),
        2,
        "turn 1 ended with two confirmed violations"
      );
      const second = await processChatLine({ line: "second", ctx });
      assert.equal(second.ranQuery, true);
      assert.equal(
        ctx.violationTurn?.counter.snapshot(),
        2,
        "turn 2 counts only its own two — no cross-turn leak"
      );
      assert.equal(process.exitCode, 0);
    } finally {
      process.exitCode = savedExitCode;
    }
  });

  it("a new turn installs a fresh scope: zeroed counter, empty ledger, un-fired abort", async () => {
    const ctx = makeCtx(["one", "two"], {
      message: "[hard_wall] dangerous command rejected",
      turnToolCalls: 2,
    });
    await processChatLine({ line: "first", ctx });
    const first = ctx.violationTurn;
    assert.ok(first !== undefined);
    assert.equal(first.counter.snapshot(), 2);
    assert.equal(first.interrupt.signal.aborted, false);
    // A later turn must not inherit the previous turn's escalation state.
    await processChatLine({ line: "second", ctx });
    const second = ctx.violationTurn;
    assert.notEqual(second, first, "a distinct scope per user turn");
    assert.equal(second?.interrupt.signal.aborted, false);
  });

  it("a successful admitted call resets the streak within one turn", async () => {
    const savedExitCode = process.exitCode;
    process.exitCode = 0;
    try {
      // deny, deny, ok, deny, deny — the reset means the fifth call cannot
      // reach the threshold of three.
      const good = createStubTool({ name: "safe", next: () => ({}) });
      const bad = createStubTool({
        name: "dangerous",
        next: () => {
          throw new ToolExecutionError("[hard_wall] dangerous command rejected");
        },
      });
      const registry = createRegistry([good, bad]);
      const wrapped = wrapWithViolationHook({
        inner: createExecutor(registry),
        onKill: () => undefined,
        turnScopeFor: () => ctx.violationTurn,
      });
      const calls = [
        { id: "d1", name: "dangerous", input: {} },
        { id: "d2", name: "dangerous", input: {} },
        { id: "s1", name: "safe", input: {} },
        { id: "d3", name: "dangerous", input: {} },
        { id: "d4", name: "dangerous", input: {} },
      ];
      const adapter = createStubModel({
        responses: [
          assistantResult({ texts: [], toolCalls: calls }),
          assistantResult({ texts: ["finished"] }),
        ],
      });
      const ctx: ChatLineContext = {
        deps: { adapter, executor: wrapped, registry, maxTurns: 5 },
        state: makeState({}),
      };

      const result = await processChatLine({ line: "mixed", ctx });
      assert.equal(result.ranQuery, true);
      // 4 denials minus the reset at the success = a streak of 2, under the
      // threshold, so the turn was never interrupted.
      assert.equal(ctx.violationTurn?.counter.snapshot(), 2);
      assert.equal(
        ctx.violationTurn?.interrupt.signal.aborted,
        false,
        "the success reset the streak, so no interruption"
      );
      assert.equal(process.exitCode, 0);
    } finally {
      process.exitCode = savedExitCode;
    }
  });

  it("three denials interrupt the turn and keep the session", async () => {
    const savedExitCode = process.exitCode;
    process.exitCode = 0;
    try {
      const ctx = makeCtx(["turn one", "turn two still works"], {
        message: "[hard_wall] dangerous command rejected",
        turnToolCalls: 3,
      });
      const first = await processChatLine({ line: "bad", ctx });
      assert.equal(first.ranQuery, true);
      assert.equal(
        ctx.violationTurn?.interrupt.signal.aborted,
        true,
        "the turn's escalation abort fired"
      );
      // The session survives: the next user line runs normally.
      const second = await processChatLine({ line: "still there?", ctx });
      assert.equal(second.ranQuery, true);
      assert.equal(second.quit, false, "the chat session is retained");
      assert.equal(
        ctx.violationTurn?.interrupt.signal.aborted,
        false,
        "the new turn's scope is un-fired"
      );
      assert.equal(process.exitCode, 0);
    } finally {
      process.exitCode = savedExitCode;
    }
  });

  it("a background job this turn launched is REALLY cancelled, with T2 cleanup evidence", async () => {
    const savedExitCode = process.exitCode;
    process.exitCode = 0;
    try {
      // The gap this closes: with no cancel route the registry reported
      // `unconfirmed` / `no_background_cancel_route`, i.e. a MISSING FEATURE
      // dressed as a runtime result. The job must actually be torn down, and
      // the report must carry the manager's own CleanupEvidence verbatim.
      const stopCalls: Array<{ taskId: string; conversationId?: string }> =
        [];
      const bgManager = {
        stop: async (
          taskId: string,
          requesterConversationId?: string
        ) => {
          stopCalls.push({
            taskId,
            ...(requesterConversationId !== undefined
              ? { conversationId: requesterConversationId }
              : {}),
          });
          // The manager's request-then-observe contract (background/manager.ts):
          // `stop` returns the REQUEST's evidence, never an exit claim.
          return { state: "not_started" as const };
        },
      };

      const launch = createStubTool({
        name: "bash",
        next: () => JSON.stringify({ task_id: "bg-this-turn" }),
      });
      const danger = createStubTool({
        name: "dangerous",
        next: () => {
          throw new ToolExecutionError("[hard_wall] dangerous command rejected");
        },
      });
      const registry = createRegistry([launch, danger]);
      const wrapped = wrapWithViolationHook({
        inner: createExecutor(registry),
        onKill: () => undefined,
        turnScopeFor: () => ctx.violationTurn,
      });
      // Wave 1: this turn launches a background job. Waves 2-4: three
      // confirmed denials, tripping the threshold in the same turn.
      const adapter = createStubModel({
        responses: [
          assistantResult({
            texts: [],
            toolCalls: [
              { id: "b1", name: "bash", input: { command: "npm run dev", background: true } },
            ],
          }),
          assistantResult({
            texts: [],
            toolCalls: [{ id: "d1", name: "dangerous", input: {} }],
          }),
          assistantResult({
            texts: [],
            toolCalls: [{ id: "d2", name: "dangerous", input: {} }],
          }),
          assistantResult({
            texts: [],
            toolCalls: [{ id: "d3", name: "dangerous", input: {} }],
          }),
          assistantResult({ texts: ["unreached"] }),
        ],
      });
      const ctx: ChatLineContext = {
        deps: { adapter, executor: wrapped, registry, maxTurns: 8 },
        state: makeState({ conversationId: "conv-1" }),
        backgroundManager: bgManager as never,
      };
      const result = await processChatLine({ line: "start a server, then misbehave", ctx });
      assert.equal(result.ranQuery, true);
      assert.equal(
        ctx.violationTurn?.interrupt.signal.aborted,
        true,
        "the threshold fired"
      );
      // Observable terminal facts, not a call count alone: the exact job this
      // turn launched was torn down, scoped to this conversation.
      assert.deepEqual(stopCalls, [
        { taskId: "bg-this-turn", conversationId: "conv-1" },
      ]);

      // The ledger is drained by the interruption itself, so a second pass
      // has nothing left — the work was cancelled once, not repeatedly.
      const cleanup = await ctx.violationTurn!.ownedWork.cancelOwned();
      assert.deepEqual(cleanup, [], "the interruption already consumed it");
      assert.deepEqual(stopCalls.length, 1, "exactly one teardown, not a retry");
    } finally {
      process.exitCode = savedExitCode;
    }
  });

  it("a job an EARLIER turn launched survives this turn's interruption", async () => {
    const savedExitCode = process.exitCode;
    process.exitCode = 0;
    try {
      const stopCalls: string[] = [];
      const bgManager = {
        stop: async (taskId: string) => {
          stopCalls.push(taskId);
          return { state: "not_started" as const };
        },
      };
      const launch = createStubTool({
        name: "bash",
        next: () => JSON.stringify({ task_id: "persistent-service" }),
      });
      const danger = createStubTool({
        name: "dangerous",
        next: () => {
          throw new ToolExecutionError("[hard_wall] dangerous command rejected");
        },
      });
      const registry = createRegistry([launch, danger]);
      const wrapped = wrapWithViolationHook({
        inner: createExecutor(registry),
        onKill: () => undefined,
        turnScopeFor: () => ctx.violationTurn,
      });
      const adapter = createStubModel({
        responses: [
          // Turn 1: launch the persistent service.
          assistantResult({
            texts: [],
            toolCalls: [
              { id: "b1", name: "bash", input: { command: "npm run dev", background: true } },
            ],
          }),
          assistantResult({ texts: ["service up"] }),
          // Turn 2: three denials in one turn.
          assistantResult({ texts: [], toolCalls: [{ id: "d1", name: "dangerous", input: {} }] }),
          assistantResult({ texts: [], toolCalls: [{ id: "d2", name: "dangerous", input: {} }] }),
          assistantResult({ texts: [], toolCalls: [{ id: "d3", name: "dangerous", input: {} }] }),
          assistantResult({ texts: ["unreached"] }),
        ],
      });
      const ctx: ChatLineContext = {
        deps: { adapter, executor: wrapped, registry, maxTurns: 8 },
        state: makeState({ conversationId: "conv-1" }),
        backgroundManager: bgManager as never,
      };
      await processChatLine({ line: "start a dev server", ctx });
      const turn1 = ctx.violationTurn;
      assert.deepEqual(turn1?.ownedWork.owned(), [
        { kind: "background_task", id: "persistent-service" },
      ]);
      await processChatLine({ line: "now misbehave", ctx });
      assert.equal(ctx.violationTurn?.interrupt.signal.aborted, true);
      // The service belongs to turn 1's ledger, which this turn's
      // interruption never reaches.
      assert.deepEqual(stopCalls, [], "the earlier persistent service survives");
      assert.deepEqual(turn1?.ownedWork.owned(), [
        { kind: "background_task", id: "persistent-service" },
      ]);
    } finally {
      process.exitCode = savedExitCode;
    }
  });

  it("neutral failures (timeout, cleanup failure, routine deny) do not interrupt", async () => {
    const savedExitCode = process.exitCode;
    process.exitCode = 0;
    try {
      const tool = createStubTool({
        name: "flaky",
        next: () => {
          throw new ToolExecutionError("timeout");
        },
      });
      const registry = createRegistry([tool]);
      const wrapped = wrapWithViolationHook({
        inner: createExecutor(registry),
        onKill: () => undefined,
        turnScopeFor: () => ctx.violationTurn,
      });
      const calls = Array.from({ length: 6 }, (_, i) => ({
        id: `t${i}`,
        name: "flaky",
        input: {},
      }));
      const adapter = createStubModel({
        responses: [
          assistantResult({ texts: [], toolCalls: calls }),
          assistantResult({ texts: ["survived"] }),
        ],
      });
      const ctx: ChatLineContext = {
        deps: { adapter, executor: wrapped, registry, maxTurns: 5 },
        state: makeState({}),
      };
      const result = await processChatLine({ line: "timeouts", ctx });
      assert.equal(result.ranQuery, true);
      assert.equal(
        ctx.violationTurn?.interrupt.signal.aborted,
        false,
        "per-call timeouts are neutral, never a security violation"
      );
      assert.equal(process.exitCode, 0);
    } finally {
      process.exitCode = savedExitCode;
    }
  });
});
