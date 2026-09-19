/**
 * SessionHub T6 test: violation kill-session wiring on the serve/TUI entry.
 *
 * Serve/TUI is long-running, so a mid-tier escalation must NOT set
 * process.exitCode. hard_wall already returns execution_failed to the model;
 * the kill latch must not remap the engine stopReason to protocolError
 * (that persist path drops the assistant delta and undoes ADR-0108 keep).
 * The violation event is still written to the JSONL trace when traceOut is set.
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
  resolveConversationTraceFilePath,
  resolveProjectSessionDir,
  SessionStore,
} from "../../src/session-api/store/index.ts";
import type { LoopAdapter, LoopEngineDeps } from "../../src/harness/index.ts";
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

/** Same denials as makeViolationDeps; abort on the 4th model step (after kill). */
function makeViolationDepsAbortOnFourthStep(
  controller: AbortController
): LoopEngineDeps {
  const base = makeViolationDeps();
  const inner = base.adapter;
  let steps = 0;
  const adapter: LoopAdapter = {
    encodeUserText: (t) => inner.encodeUserText(t),
    encodeToolResults: (r) => inner.encodeToolResults(r),
    async step(state, request, signal) {
      steps += 1;
      if (steps === 4) {
        queueMicrotask(() => controller.abort());
        await new Promise<never>((_, reject) => {
          const fail = (): void => {
            reject(
              new DOMException("This operation was aborted", "AbortError")
            );
          };
          if (signal?.aborted) {
            fail();
            return;
          }
          signal?.addEventListener("abort", fail, { once: true });
        });
      }
      return inner.step(state, request, signal);
    },
  };
  return { ...base, adapter };
}

describe("SessionHub violation kill (serve entry)", () => {
  it("mid-tier escalation keeps engine stopReason and assistant history; does not touch exitCode", async () => {
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
      // Kill latch is observability only: engine completed; remapping to
      // protocolError would drop this assistant delta on persist (SC4).
      assert.equal(res.turn.answer.stopReason, "completed");
      assert.equal(res.turn.answer.finalText, "final answer");
      const loaded = await store.load(convId);
      assert.ok(
        loaded.messages.some((m) => m.role === "assistant"),
        "assistant turns after hard_wall must remain on disk"
      );
      // Serve must never kill the process: exitCode stays 0.
      assert.equal(process.exitCode, 0);
      // T3 (SC6): violation 写 `<projectDir>/<convId>/trace.jsonl`,
      // 与 hub.recordViolationTrace 共派生。读侧复用同一 SSOT,避免漂移。
      const tracePath = resolveConversationTraceFilePath({
        projectDir: store.getProjectDir(),
        conversationId: convId,
      });
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
    } finally {
      process.exitCode = savedExitCode;
    }
  });

  it("Esc after mid-tier latch keeps cancelled persist (does not strip assistant)", async () => {
    const controller = new AbortController();
    const hub = new SessionHub({
      store,
      workspaceRoot: process.cwd(),
      deps: makeViolationDepsAbortOnFourthStep(controller),
      traceOut: traceDir,
    });
    const { session } = await hub.createSession();
    const res = await hub.postMessage({
      conversationId: session.conversation_id,
      text: "do something dangerous then stop",
      signal: controller.signal,
    });
    assert.equal(res.turn.answer.stopReason, "cancelled");
    const loaded = await store.load(session.conversation_id);
    assert.ok(
      loaded.messages.some((m) => m.role === "assistant"),
      "tool rounds before Esc must remain on disk"
    );
    assert.equal(loaded.checkpoints?.[0]?.interruptReason, "cancelled");
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
