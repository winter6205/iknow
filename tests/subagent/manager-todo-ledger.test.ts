/**
 * ADR-0085 — `manager.buildWorkerPayload` writes the **parent session ledger
 * anchor** into the worker envelope at spawn time
 * (`todoLedger: { projectDir, conversationId }`).
 *
 * Contract (ADR-0085 "sub-agents share the parent ledger within one session"):
 *   - worker may read and update the parent ledger; adding is parent-only
 *     (rejected tool-side via typed error, see the SC9 block in
 *     `worker-tool-surface.test.ts`).
 *   - Anchor source = host-injected `opts.todoDir` (same value as the main
 *     loop registry) + `def.conversationId` (parent session id) — **not**
 *     derived from trace file layout (fragile coupling); the written
 *     (projectDir, conversationId) pair matches `resolveConversationTodoPath`
 *     (todo-write.ts SSOT).
 *   - Missing `opts.todoDir` or `def.conversationId` → field omitted entirely
 *     (legacy wire shape, worker tool surface excludes todo_write, byte-stable).
 *
 * Isolation: real tmp dir as sandboxRoot anchor; fake child for spawn,
 * no real subprocess.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, it } from "vitest";

import { createSubAgentManager } from "../../src/harness/subagent/manager.ts";
import type { SubAgentDefinition } from "../../src/harness/subagent/manager.ts";
import type { WorkerEnvelope } from "../../src/harness/subagent/envelope.ts";

let tempRoot: string;

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "iknow-mgr-ledger-"));
});

function makeFakeChild(): ChildProcess {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: () => true,
  }) as unknown as ChildProcess;
}

interface CapturedSpawn {
  readonly def: SubAgentDefinition;
  readonly payload: WorkerEnvelope;
}

function makeManagerCapturingPayload(opts: {
  readonly todoDir?: string;
  readonly parentSandboxRoot: string;
}): {
  readonly manager: ReturnType<typeof createSubAgentManager>;
  readonly calls: CapturedSpawn[];
} {
  const calls: CapturedSpawn[] = [];
  const manager = createSubAgentManager({
    spawn: (def, _taskId, payload) => {
      calls.push({ def, payload });
      return makeFakeChild();
    },
    sandboxRoot: opts.parentSandboxRoot,
    ...(opts.todoDir !== undefined ? { todoDir: opts.todoDir } : {}),
  });
  return { manager, calls };
}

describe("buildWorkerPayload — ADR-0085 SC9 todoLedger 落线", () => {
  it("todoDir + def.conversationId 都在场 → envelope.todoLedger === {projectDir, conversationId}", () => {
    const { manager, calls } = makeManagerCapturingPayload({
      todoDir: "/data/projects/repo-abc123",
      parentSandboxRoot: tempRoot,
    });
    manager.spawn({ task: "share the ledger", conversationId: "conv-parent" });
    assert.deepEqual(calls[0]!.payload.todoLedger, {
      projectDir: "/data/projects/repo-abc123",
      conversationId: "conv-parent",
    });
  });

  it("projectDir 与 conversationId 逐字节透传（不改写、不 sanitize —— sanitize 归 resolveConversationTodoPath）", () => {
    // Wire-through is pure data transport: path-segment sanitization happens
    // only at the consumer (the tool handler's resolveConversationTodoPath);
    // do not invent a second shape here.
    const { manager, calls } = makeManagerCapturingPayload({
      todoDir: "/srv/iknow/projects/my-repo-deadbeef1234",
      parentSandboxRoot: tempRoot,
    });
    manager.spawn({ task: "t", conversationId: "conv-with-dashes" });
    assert.equal(
      calls[0]!.payload.todoLedger?.projectDir,
      "/srv/iknow/projects/my-repo-deadbeef1234"
    );
    assert.equal(
      calls[0]!.payload.todoLedger?.conversationId,
      "conv-with-dashes"
    );
  });

  it("todoDir 缺席 → 字段整个省略（旧 wire 形态，不落半个锚点）", () => {
    const { manager, calls } = makeManagerCapturingPayload({
      parentSandboxRoot: tempRoot,
    });
    manager.spawn({ task: "no ledger", conversationId: "conv-parent" });
    assert.ok(!("todoLedger" in calls[0]!.payload));
  });

  it("def.conversationId 缺席（judge / 直调 manager）→ 字段整个省略", () => {
    const { manager, calls } = makeManagerCapturingPayload({
      todoDir: "/data/projects/repo-abc123",
      parentSandboxRoot: tempRoot,
    });
    manager.spawn({ task: "no conversation" });
    assert.ok(!("todoLedger" in calls[0]!.payload));
  });

  it("def.conversationId 空串 → 字段整个省略（空 id 不得指向根 todos.md）", () => {
    // An empty conversationId would be read by resolveConversationTodoPath as
    // the legacy root ledger — the worker would target a non-session ledger,
    // wrong semantics; the assembly layer simply omits the anchor.
    const { manager, calls } = makeManagerCapturingPayload({
      todoDir: "/data/projects/repo-abc123",
      parentSandboxRoot: tempRoot,
    });
    manager.spawn({ task: "empty conv", conversationId: "" });
    assert.ok(!("todoLedger" in calls[0]!.payload));
  });

  it("多个 def 各有自己的 conversationId → 锚点逐 spawn 独立（不跨会话复用）", () => {
    const { manager, calls } = makeManagerCapturingPayload({
      todoDir: "/data/projects/repo-abc123",
      parentSandboxRoot: tempRoot,
    });
    manager.spawn({ task: "a", conversationId: "conv-aaa" });
    manager.spawn({ task: "b", conversationId: "conv-bbb" });
    assert.equal(calls[0]!.payload.todoLedger?.conversationId, "conv-aaa");
    assert.equal(calls[1]!.payload.todoLedger?.conversationId, "conv-bbb");
  });
});
