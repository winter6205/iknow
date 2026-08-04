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
