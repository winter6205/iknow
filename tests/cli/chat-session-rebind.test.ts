/**
 * Review High-1 (2026-08-29, plans/worktree-isolation-on-mutate.md) — CLI
 * chat 入口的 per-turn 引擎重建缝。
 *
 * chat REPL 的 deps 在 runChatSession 装配一次；T3 门禁 rebind 后会话文件
 * 的 workspaceRoot 指向 task worktree，下一回合必须以该根重建 deps
 * （rebuildDeps 缝，cli.ts 提供），否则 mutate 会被 stale 引擎永久拦下。
 * 钉死三条：
 *   1. 会话文件 workspaceRoot 变化 → 查询行开跑前以新根重建并重包
 *      （violation executor + conversationId + commitMessages 语义保持）；
 *   2. 根未变化 / 无 workspaceRoot / 文件缺席 → 不重建（零额外行为）；
 *   3. 重建失败 → 可见 stderr + 保持旧 deps（mutate 仍 fail-closed）。
 */
import { describe, expect, it } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { processChatLine } from "../../src/cli/chat-session.ts";
import { SessionStore, CURRENT_SCHEMA_VERSION } from "../../src/session-api/store/index.ts";
import type { SessionFileV1 } from "../../src/session-api/store/index.ts";
import {
  assistantResult,
  makeCtx,
  makeDeps,
} from "./_fixtures.ts";

const roots: string[] = [];

function makeStoreDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "iknow-chat-rebind-"));
  roots.push(dir);
  return dir;
}

function makeSessionFile(id: string, workspaceRoot: string): SessionFileV1 {
  const now = new Date().toISOString();
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    conversation_id: id,
    messages: [],
    jsonMode: true,
    turnCount: 0,
    updatedAt: now,
    title: "",
    cwd: workspaceRoot,
    sanitized_at: now,
    checkpoints: [],
    workspaceRoot,
  };
}

afterEachCleanup();
function afterEachCleanup(): void {
  process.on("exit", () => {
    for (const r of roots) rmSync(r, { recursive: true, force: true });
  });
}

describe("chat-session rebind 重建缝（review High-1）", () => {
  it("会话文件 workspaceRoot 变化 → 查询行开跑前以新根重建 deps 并保持包装语义", async () => {
    const dir = makeStoreDir();
    const store = new SessionStore(dir);
    const conversationId = "conv-rebind-1";
    const mainRoot = join(dir, "main");
    const wtRoot = join(mainRoot, ".iknow", "worktrees", conversationId);
    await store.save({ id: conversationId, file: makeSessionFile(conversationId, mainRoot) });

    const ctx = makeCtx({
      responses: [assistantResult({ texts: ["turn-1"] })],
      stateOverrides: { conversationId },
    });
    ctx.checkpointStore = store;
    ctx.engineRoot = mainRoot;
    const rebuiltDeps = makeDeps([assistantResult({ texts: ["rebuilt"] })]);
    const rebuilds: string[] = [];
    ctx.rebuildDeps = async (root) => {
      rebuilds.push(root);
      return rebuiltDeps;
    };

    // 模拟 T3 rebind 已落盘（上一回合门禁拦下 + store.save workspaceRoot）
    const file = await store.load(conversationId);
    await store.save({
      id: conversationId,
      file: { ...file, workspaceRoot: wtRoot },
    });

    const r = await processChatLine({ line: "q", ctx });
    assert.equal(r.quit, false);
    assert.equal(r.ranQuery, true);

    assert.deepEqual(rebuilds, [wtRoot]);
    assert.equal(ctx.engineRoot, wtRoot);
    // 重包语义：不是 rebuiltDeps 原样（conversationId 已收敛 / 包装层生效）
    assert.notEqual(ctx.deps, rebuiltDeps);
    assert.equal(ctx.deps.conversationId, conversationId);
    assert.equal(ctx.deps.adapter, rebuiltDeps.adapter);
  });

  it("runChatSession 为重建装配 wrapRebuiltDeps（violation/commit 包装与初始装配同源）", () => {
    // 结构性钉子：runChatSession 必须把 wrapChatDeps 交给重建缝，否则
    // rebuilt 引擎会丢 violation counter 与 commitMessages 钩子。
    const src = readFileSync(
      join(import.meta.dirname, "..", "..", "src", "cli", "chat-session.ts"),
      "utf8"
    );
    expect(src.includes("wrapRebuiltDeps: wrapChatDeps")).toBe(true);
  });

  it("根未变化 / 无 workspaceRoot / 会话文件缺席 → 不重建", async () => {
    const dir = makeStoreDir();
    const store = new SessionStore(dir);
    const conversationId = "conv-rebind-2";
    const mainRoot = join(dir, "main");
    await store.save({ id: conversationId, file: makeSessionFile(conversationId, mainRoot) });

    const ctx = makeCtx({
      responses: [assistantResult({ texts: ["turn-1"] })],
      stateOverrides: { conversationId },
    });
    ctx.checkpointStore = store;
    ctx.engineRoot = mainRoot;
    let rebuilds = 0;
    ctx.rebuildDeps = async () => {
      rebuilds += 1;
      return ctx.deps;
    };

    // workspaceRoot 与 engineRoot 相同（serve bind 写主根的形态）
    await processChatLine({ line: "q", ctx });
    assert.equal(rebuilds, 0);

    // 会话文件缺席（not_found）
    ctx.state.conversationId = "conv-unknown";
    await processChatLine({ line: "q2", ctx });
    assert.equal(rebuilds, 0);
  });

  it("重建失败 → 可见 stderr，保持旧 deps，回合仍完成", async () => {
    const dir = makeStoreDir();
    const store = new SessionStore(dir);
    const conversationId = "conv-rebind-3";
    const mainRoot = join(dir, "main");
    const wtRoot = join(mainRoot, ".iknow", "worktrees", conversationId);
    await store.save({ id: conversationId, file: makeSessionFile(conversationId, mainRoot) });

    const ctx = makeCtx({
      responses: [assistantResult({ texts: ["turn-1"] })],
      stateOverrides: { conversationId },
    });
    ctx.checkpointStore = store;
    ctx.engineRoot = mainRoot;
    ctx.rebuildDeps = async () => {
      throw new Error("rebuild exploded");
    };
    const file = await store.load(conversationId);
    await store.save({
      id: conversationId,
      file: { ...file, workspaceRoot: wtRoot },
    });

    // refresh 的可见降级走 process.stderr（writeErr SSOT）—— 拦截捕获
    const chunks: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    (process as { stderr: { write: unknown } }).stderr.write = (
      chunk: string | Uint8Array
    ) => {
      chunks.push(String(chunk));
      return true;
    };
    let r;
    try {
      r = await processChatLine({ line: "q", ctx });
    } finally {
      process.stderr.write = origWrite;
    }
    assert.equal(r.ranQuery, true);
    assert.equal(ctx.engineRoot, mainRoot); // 未切换
    assert.ok(
      chunks.join("").includes("引擎重建失败"),
      "重建失败必须可见（stderr）"
    );
  });
});
