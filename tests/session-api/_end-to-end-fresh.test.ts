/**
 * #458 T8: fresh conversation 端到端 — 真实 SessionHub + 真实 SessionStore
 * (temp dir) + chat-session /goal 三面 slash 共享同一 store 与 conversationId。
 *
 * 与 `goal-slash-runtime.test.ts` (T6) 不重复:T6 是 chat-session 单独
 * 路径的 /goal 三面单元;本文件是 serve 形态 SessionHub 与 chat 形态
 * processChatLine 共享持久化的端到端集成,覆盖:
 *
 * typed-error catch 契约分流:not_found 合法态 (fresh conversation + /goal status)
 * vs schema_invalid 真实故障 (畸形 session 文件 + /goal status 渲染
 * `${kind}: ${conversation_id}`)。真实 SessionStore + fresh conversationId
 * (不预存 session 文件),严格遵循 test.md 命令 handler 集成测试规范。
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processChatLine } from "../../src/cli/chat-session.ts";
import {
  CURRENT_SCHEMA_VERSION,
  resolveConversationDir,
  resolveProjectSessionDir,
  SessionStore,
  type SessionFileV1,
} from "../../src/session-api/store/index.ts";
import { makeCtx } from "../cli/_fixtures.ts";

const tempDirs: string[] = [];

async function storeFor(): Promise<{
  readonly store: SessionStore;
  readonly baseDir: string;
}> {
  const baseDir = await mkdtemp(join(tmpdir(), "iknow-end-to-end-fresh-"));
  tempDirs.push(baseDir);
  return { store: new SessionStore(baseDir, process.cwd()), baseDir };
}

afterAll(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

describe("typed-error catch 契约 (fresh conversation + 真实 SessionStore)", () => {
  it("not_found 合法态: 永未 create 的 conversationId + /goal status → output 友好, stderr 静默", async () => {
    const { store } = await storeFor();
    const id = "never-created-conversationId";
    // 不调 createSession → store.load(id) → not_found typed error。
    // 代码层应把它判为「fresh conversation 合法态」而非故障 (test.md)。
    const r = await processChatLine({
      line: "/goal status",
      ctx: makeCtx({
        responses: [],
        checkpointStore: store,
        stateOverrides: { conversationId: id },
      }),
    });
    expect(r.output).toContain("未设置 goal");
    expect(r.stderr).toBeUndefined();
    // store 仍空:load 抛出被 catch 截获,无副作用。
    expect(await store.list()).toEqual([]);
  });

  it("schema_invalid 真实故障: 畸形 session 文件 + /goal status → stderr `${kind}: ${conversation_id}`", async () => {
    const { store, baseDir } = await storeFor();
    const id = "schema-invalid-fresh";
    const dir = resolveConversationDir({
      projectDir: resolveProjectSessionDir(baseDir, process.cwd()),
      conversationId: id,
    });
    await mkdir(dir, { recursive: true });
    const now = new Date().toISOString();
    // 畸形 goal: text 字段为 number → isValidGoal false → sanitize 抛
    // schema_invalid typed error → 渲染契约 `${kind}: ${conversation_id}`。
    const bad: SessionFileV1 = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      conversation_id: id,
      messages: [],
      jsonMode: false,
      turnCount: 0,
      updatedAt: now,
      title: "",
      cwd: process.cwd(),
      sanitized_at: now,
      checkpoints: [],
      // 故意畸形:goal.text 应为 string,这里写 number。
      goal: { text: 123 } as unknown as SessionFileV1["goal"],
    };
    await writeFile(join(dir, `${id}.json`), JSON.stringify(bad), "utf8");
    const r = await processChatLine({
      line: "/goal status",
      ctx: makeCtx({
        responses: [],
        checkpointStore: store,
        stateOverrides: { conversationId: id },
      }),
    });
    expect(r.output).toBe("");
    expect(r.stderr).toBe(`schema_invalid: ${id}`);
  });
});
