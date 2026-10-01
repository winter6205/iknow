/**
 * SessionHub T6 test: violation kill-session wiring on the serve/TUI entry.
 *
 * Serve/TUI is long-running, so a mid-tier escalation must NOT set
 * process.exitCode. ADR-0135 additionally requires the third confirmed
 * violation to interrupt the current turn only: the turn stops as
 * `cancelled` with a structured security cause, the session survives, and
 * the next user turn starts its streak at zero. The violation event is still
 * written to the JSONL trace when traceOut is set.
 *
 * The serve product path injects agentVersion → a session root record
 * (carrying the agent_version field) is written at run end. This file is
 * where the serve-path integration assertion lives.
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
  // Per-session independent files: traceOut is a directory, violation
  // writes <traceDir>/<convId>.jsonl.
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
      // Second user turn: proves the session is retained and that its own
      // streak starts at zero. The stub model is a FIFO queue, so this
      // response is reached by the follow-up turn ONLY if the third denial
      // really did prevent a further model request in the first turn.
      assistantResult({ texts: ["second turn"] }),
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
  it("the third confirmed violation interrupts the turn, retains the session, and starts the next turn at zero", async () => {
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
      // ADR-0135 / SC11: the third confirmed violation interrupts THIS turn.
      // The stop reason is the existing `cancelled` (ADR-0029's closed set is
      // untouched) — the previous contract, which ran the model to a
      // `completed` answer after the threshold, is exactly what the spec
      // rejects. The session is retained, which is the other half of it.
      assert.equal(res.turn.answer.stopReason, "cancelled");
      const loaded = await store.load(convId);
      assert.ok(
        loaded.messages.some((m) => m.role === "assistant"),
        "assistant turns before the interruption must remain on disk"
      );
      // The interruption is structured, not just a stop: the live DTO
      // carries the cause and the per-item cleanup list.
      const liveOutcome = res.turn.answer.outcome;
      const liveInterruption =
        liveOutcome?.terminal === "known"
          ? liveOutcome.securityInterruption
          : undefined;
      assert.ok(
        liveInterruption !== undefined,
        "the turn answer carries the security cause"
      );
      assert.equal(liveInterruption?.tier, "mid");
      assert.equal(liveInterruption?.tool, "dangerous");
      assert.equal(liveInterruption?.confirmedViolations, 3);
      assert.deepEqual(liveInterruption?.cleanup, []);

      // Session retained: a follow-up turn still runs on the same session.
      const followUp = await hub.postMessage({
        conversationId: convId,
        text: "are you still there?",
      });
      assert.equal(followUp.turn.answer.stopReason, "completed");
      // Reaching this response is itself the proof that turn 1 stopped after
      // its third denial: the queue had exactly three denial waves before it,
      // so a 4th in-turn model request would have consumed this answer.
      assert.equal(followUp.turn.answer.finalText, "second turn");
      // A new user turn starts its streak at zero: its own outcome carries
      // no security cause even though the session already had three denials.
      const followOutcome = followUp.turn.answer.outcome;
      assert.equal(
        followOutcome?.terminal === "known"
          ? followOutcome.securityInterruption
          : undefined,
        undefined,
        "the count must not leak into the next user turn"
      );
      // Serve must never kill the process: exitCode stays 0.
      assert.equal(process.exitCode, 0);
      // Violation writes `<projectDir>/<convId>/trace.jsonl`, derived
      // jointly with hub.recordViolationTrace. The read side reuses the same
      // SSOT to avoid drift.
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
      // Integration assertion: every session root record written at run end
      // carries the agent_version injected by serve. One per postMessage, so
      // this test's two turns produce two.
      const allLines = raw.trim().split("\n");
      const roots = allLines.filter((l) =>
        l.includes('"record_type":"session"')
      );
      assert.equal(
        roots.length,
        2,
        `expected one session root record per turn, got: ${allLines.join(" | ")}`
      );
      for (const line of roots) {
        const root = JSON.parse(line) as Record<string, unknown>;
        assert.equal(root["conversation_id"], convId);
        assert.equal(root["agent_version"], getVersion());
      }
      // The interrupted turn's own trace records the security cause, the
      // confirmed count and the (here empty) cleanup list — this is the
      // evidence T8's trace work correlates (SC12).
      const violations = allLines.filter((l) =>
        l.includes('"record_type":"violation"')
      );
      // Two records exist for one escalation: the operator notification
      // (`tier: "mid-escalation"`) and the structured interruption report
      // (`tier: "mid"` + cleanup). The report is the one carrying the cause.
      const cause = violations
        .map((l) => JSON.parse(l) as { detail?: Record<string, unknown> })
        .map((v) => v.detail ?? {})
        .find(
          (d) => d["confirmedViolations"] !== undefined && "cleanup" in d
        );
      assert.ok(cause !== undefined, "a structured cause record was written");
      assert.equal(cause?.["tier"], "mid");
      assert.equal(cause?.["confirmedViolations"], 3);
      assert.deepEqual(cause?.["cleanup"], []);
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
