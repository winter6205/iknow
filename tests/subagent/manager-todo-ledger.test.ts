/**
 * ADR-0085 / SC9 — `manager.buildWorkerPayload` 在 spawn 期把**父会话账本
 * 锚点**落进 worker envelope（`todoLedger: { projectDir, conversationId }`）。
 *
 * 契约（ADR-0085「同一主会话内子代理与父共用账本」）：
 *   - worker 可读取与更新父账本；添加仅父会话（工具侧 typed 拒绝，见
 *     `worker-tool-surface.test.ts` 的 SC9 描述块）。
 *   - 锚点数据源 = host 注入的 `opts.todoDir`（与主 loop registry 同一值）
 *     + `def.conversationId`（父会话 id）——**不**从 trace 文件布局反推
 *     （fragile coupling），落值与 `resolveConversationTodoPath`
 *     （todo-write.ts SSOT）同一对 (projectDir, conversationId)。
 *   - 缺 `opts.todoDir` 或缺 `def.conversationId` → 整个字段省略（旧 wire
 *     形态，worker 工具面不含 todo_write，byte-stable）。
 *
 * Isolation: 真实 tmp 目录做 sandboxRoot 锚点；spawn 用 fake child，
 * 无真实子进程。
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
    // 落线是「数据搬运」：路径分段清洗只发生在消费端（工具 handler 的
    // resolveConversationTodoPath），此处不得发明第二套形状。
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
    // 空 conversationId 会被 resolveConversationTodoPath 解释成 legacy 根账本
    // —— 那会让 worker 读到一个非会话账本，语义错位；装配层直接不发锚点。
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
