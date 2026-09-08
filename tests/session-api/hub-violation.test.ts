/**
 * SessionHub T6 test: violation kill-session wiring on the serve entry.
 *
 * Serve is long-running, so a violation kill must NOT set process.exitCode;
 * instead the turn reports stopReason=protocolError (OQ4 frozen shape) and
 * the violation event is written to the JSONL trace when traceOut is set.
 *
 * SC-W 6/7 (v2): serve 产品路径注入 agentVersion → run 末尾写 session 根记录
 * (含 agent_version 字段)。本文件是 serve 产品路径集成断言的落点。
 */
import { afterAll, beforeAll, describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionHub } from "../../src/session-api/hub.ts";
import { getVersion } from "../../src/cli/usage.ts";
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
let traceDir: string;
let convId: string;

beforeAll(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "iknow-hub-violation-"));
  // Reference the namespaced dir so the store is rooted under baseDir.
  resolveProjectSessionDir(baseDir, process.cwd());
  store = new SessionStore(baseDir, process.cwd());
  // T2 每会话独立文件: traceOut 是目录, violation 写 <traceDir>/<convId>.jsonl。
  traceDir = baseDir;
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
        workspaceRoot: process.cwd(),
        deps: makeViolationDeps(),
        traceOut: traceDir,
      });
      const { session } = await hub.createSession();
      convId = session.conversation_id;
      const res = await hub.postMessage({
        conversationId: convId,
        text: "do something dangerous",
      });
      // The kill must propagate protocolError as the stop reason (OQ4 shape).
      assert.equal(res.turn.answer.stopReason, "protocolError");
      // Serve must never kill the process: exitCode stays 0.
      assert.equal(process.exitCode, 0);
      // The violation event is written to the per-session JSONL trace.
      const tracePath = join(traceDir, `${convId}.jsonl`);
      assert.equal(existsSync(tracePath), true);
      const raw = await readFile(tracePath, "utf8");
      const lines = raw
        .trim()
        .split("\n")
        .filter((l) => l.includes('"record_type":"violation"'));
      assert.ok(lines.length >= 1, `expected violation record, got: ${raw}`);
      assert.match(lines[0] ?? "", /"conversation_id":"[^"]+"/);
      assert.match(lines[0] ?? "", /hard_wall/);
      // SC-W 6/7 集成断言:run 末尾写 session 根记录,含 serve 注入的 agent_version。
      const allLines = raw.trim().split("\n");
      const roots = allLines.filter((l) =>
        l.includes('"record_type":"session"')
      );
      assert.equal(
        roots.length,
        1,
        `expected exactly 1 session root record, got: ${allLines.join(" | ")}`
      );
      const root = JSON.parse(roots[0]!) as Record<string, unknown>;
      assert.equal(root["conversation_id"], convId);
      assert.equal(root["agent_version"], getVersion());
      // 注:violation kill 是 hub 层后处理,只重映射 DTO 的 stopReason;run 实际
      // 停因仍是 completed,故 session 根 status 为 "ok" —— 不在此断言状态。
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
    const hub = new SessionHub({ store, deps, workspaceRoot: process.cwd() });
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
