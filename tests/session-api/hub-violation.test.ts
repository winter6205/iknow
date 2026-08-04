/**
 * SessionHub T6 test: violation kill-session wiring on the serve entry.
 *
 * Serve is long-running, so a violation kill must NOT set process.exitCode;
 * instead the turn reports stopReason=protocolError (OQ4 frozen shape) and
 * the violation event is written to the JSONL trace when traceOut is set.
 */
import { afterAll, beforeAll, describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionHub } from "../../src/session-api/hub.ts";
import {
  resolveProjectSessionDir,
  SessionStore,
} from "../../src/session-api/store/index.ts";
import type { LoopEngineDeps } from "../../src/harness/index.ts";
import { createStubModel } from "../../src/harness/stubs/stub-model.ts";
import { createStubTool } from "../../src/harness/stubs/stub-tool.ts";
import { createRegistry } from "../../src/harness/tools/registry.ts";
import { createExecutor } from "../../src/harness/tools/executor.ts";
import { ToolExecutionError } from "../../src/harness/errors.ts";
import { assistantResult } from "../cli/_fixtures.ts";

let baseDir: string;
let store: SessionStore;
let tracePath: string;

beforeAll(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "iknow-hub-violation-"));
  // Reference the namespaced dir so the store is rooted under baseDir.
  resolveProjectSessionDir(baseDir, process.cwd());
  store = new SessionStore(baseDir);
  tracePath = join(baseDir, "violation-trace.jsonl");
});

afterAll(async () => {
  await rm(baseDir, { recursive: true, force: true });
});

/**
 * Build deps whose tool always fails with a mid-tier denial. The stub model
 * issues 4 tool calls then a final text, so the loop drives the counter past
 * the mid threshold (3) and the kill fires mid-turn.
 */
function makeViolationDeps(): LoopEngineDeps {
  // ToolExecutionError keeps its message through the executor's sanitize
  // (a plain Error would be masked as "tool execution failed").
  const tool = createStubTool({
    name: "dangerous",
    next: () => {
      throw new ToolExecutionError("[hard_wall] dangerous command rejected");
    },
  });
  const registry = createRegistry([tool]);
  const executor = createExecutor(registry);
  const toolCall = { id: "u1", name: "dangerous", input: {} };
  const adapter = createStubModel({
    responses: [
      assistantResult({ texts: [], toolCalls: [toolCall] }),
      assistantResult({ texts: [], toolCalls: [{ ...toolCall, id: "u2" }] }),
      assistantResult({ texts: [], toolCalls: [{ ...toolCall, id: "u3" }] }),
      assistantResult({ texts: [], toolCalls: [{ ...toolCall, id: "u4" }] }),
      assistantResult({ texts: ["final answer"] }),
    ],
  });
  return { adapter, executor, registry, maxTurns: 8 };
}

describe("SessionHub violation kill (serve entry)", () => {
  it("mid-tier escalation surfaces protocolError and does not touch exitCode", async () => {
    const savedExitCode = process.exitCode;
    process.exitCode = 0;
    try {
      const hub = new SessionHub({
        store,
        deps: makeViolationDeps(),
        traceOut: tracePath,
      });
      const { session } = await hub.createSession();
      const res = await hub.postMessage({
        conversationId: session.conversation_id,
        text: "do something dangerous",
      });
      // The kill must propagate protocolError as the stop reason (OQ4 shape).
      assert.equal(res.turn.answer.stopReason, "protocolError");
      // Serve must never kill the process: exitCode stays 0.
      assert.equal(process.exitCode, 0);
      // The violation event is written to the JSONL trace.
      assert.equal(existsSync(tracePath), true);
      const raw = await readFile(tracePath, "utf8");
      const lines = raw
        .trim()
        .split("\n")
        .filter((l) => l.includes('"record_type":"violation"'));
      assert.ok(lines.length >= 1, `expected violation record, got: ${raw}`);
      assert.match(lines[0] ?? "", /"conversation_id":"[^"]+"/);
      assert.match(lines[0] ?? "", /hard_wall/);
    } finally {
      process.exitCode = savedExitCode;
    }
  });

  it("non-violation turns keep their natural stop reason", async () => {
    const tool = createStubTool({ name: "noop", next: () => ({}) });
    const registry = createRegistry([tool]);
    const executor = createExecutor(registry);
    const adapter = createStubModel({
      responses: [assistantResult({ texts: ["hello world"] })],
    });
    const deps: LoopEngineDeps = { adapter, executor, registry, maxTurns: 5 };
    const hub = new SessionHub({ store, deps });
    const { session } = await hub.createSession();
    const res = await hub.postMessage({
      conversationId: session.conversation_id,
      text: "hi",
    });
    // Stub model completes with stopReason "completed" (not protocolError).
    assert.equal(res.turn.answer.stopReason, "completed");
    assert.equal(res.turn.answer.finalText, "hello world");
  });
});
