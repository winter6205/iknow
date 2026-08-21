/**
 * #458 T8 → #605 T2: fresh conversation 端到端 — 真实 SessionHub + 真实
 * SessionStore (temp dir) + chat-session /goal 三面 slash 共享同一 store
 * 与 conversationId。
 *
 * 与 `goal-slash-runtime.test.ts` (T6) 不重复:T6 是 chat-session 单独
 * 路径的 /goal 三面单元;本文件是 serve 形态 SessionHub 与 chat 形态
 * processChatLine 共享持久化的端到端集成,覆盖:
 *
 *   a. 全生命周期:createSession → 首条 postMessage (无 taskFocus seed) →
 *      /goal status 回显 → /goal pin → /goal status 回显 → /goal clear →
 *      再 postMessage (无 taskFocus re-seed)。
 *   b. 真实 SessionStore + fresh conversationId (不预存 session 文件),
 *      严格遵循 test.md 命令 handler 集成测试规范。
 *   c. typed-error catch 契约分流:not_found 合法态 (fresh conversation
 *      + /goal status) vs schema_invalid 真实故障 (畸形 session 文件
 *      + /goal status 渲染 `${kind}: ${conversation_id}`)。
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processChatLine } from "../../src/cli/chat-session.ts";
import { SessionHub } from "../../src/session-api/hub.ts";
import {
  CURRENT_SCHEMA_VERSION,
  resolveProjectSessionDir,
  SessionStore,
  type SessionFileV1,
} from "../../src/session-api/store/index.ts";
import { assistantResult, makeCtx, makeDeps } from "../cli/_fixtures.ts";

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

describe("fresh conversation 端到端 (SessionHub + chat-session 共享 store)", () => {
  it("全生命周期: create → postMessage (no taskFocus seed) → /goal status → pin → status → clear", async () => {
    const { store } = await storeFor();
    const hub = new SessionHub({
      store,
      // 两次 hub.postMessage 各消费一个 scripted response。
      deps: makeDeps([
        assistantResult({ texts: ["ack-1"] }),
        assistantResult({ texts: ["ack-2"] }),
      ]),
    });
    const { session } = await hub.createSession();
    const id = session.conversation_id;

    // (0) 刚 createSession:盘上文件存在但 messages/goal/taskFocus 全空。
    let loaded = await store.load(id);
    expect(loaded.goal).toBeUndefined();
    expect(
      (loaded as unknown as Record<string, unknown>)["taskFocus"]
    ).toBeUndefined();
    expect(loaded.messages).toEqual([]);

    // (1) hub.postMessage 首条 → 落盘 messages,但 conditionalSave 不再 seed
    // taskFocus (#605 T2 退休字段)。goal 仍 undefined。
    const r1 = await hub.postMessage({
      conversationId: id,
      text: "Build a C compiler",
    });
    expect(r1.turn.answer.stopReason).toBe("completed");
    loaded = await store.load(id);
    expect(loaded.goal).toBeUndefined();
    expect(
      (loaded as unknown as Record<string, unknown>)["taskFocus"]
    ).toBeUndefined();

    // (2) processChatLine /goal status → 仅回显 goal (无 taskFocus 段)。
    const s1 = await processChatLine({
      line: "/goal status",
      ctx: makeCtx({
        responses: [],
        checkpointStore: store,
        stateOverrides: { conversationId: id },
      }),
    });
    expect(s1.output).toBe("未设置 goal");
    expect(s1.output).not.toContain("taskFocus");
    expect(s1.stderr).toBeUndefined();

    // (3) /goal pin → user_pin 落盘,taskFocus 字段仍缺席。
    const s2 = await processChatLine({
      line: "/goal write a type checker",
      ctx: makeCtx({
        responses: [],
        checkpointStore: store,
        stateOverrides: { conversationId: id },
      }),
    });
    expect(s2.output).toBe("goal pinned: write a type checker");
    expect(s2.stderr).toBeUndefined();
    loaded = await store.load(id);
    expect(loaded.goal?.text).toBe("write a type checker");
    expect(loaded.goal?.source).toBe("user_pin");
    expect(loaded.goal?.status).toBe("active");
    expect(
      (loaded as unknown as Record<string, unknown>)["taskFocus"]
    ).toBeUndefined();

    // (4) /goal status 回显 goal (taskFocus 段已随 T2 退休)。
    const s3 = await processChatLine({
      line: "/goal status",
      ctx: makeCtx({
        responses: [],
        checkpointStore: store,
        stateOverrides: { conversationId: id },
      }),
    });
    expect(s3.output).toBe("goal: write a type checker");
    expect(s3.output).not.toContain("taskFocus");
    expect(s3.stderr).toBeUndefined();

    // (5) /goal clear → goal 清空 (taskFocus 不再参与双清,SC)。
    const s4 = await processChatLine({
      line: "/goal clear",
      ctx: makeCtx({
        responses: [],
        checkpointStore: store,
        stateOverrides: { conversationId: id },
      }),
    });
    expect(s4.output).toBe("goal cleared");
    expect(s4.stderr).toBeUndefined();
    loaded = await store.load(id);
    expect(loaded.goal).toBeUndefined();
    expect(
      (loaded as unknown as Record<string, unknown>)["taskFocus"]
    ).toBeUndefined();

    // (6) postMessage 再来一条 → 仍无 taskFocus (seed 路径已退)。
    const r2 = await hub.postMessage({
      conversationId: id,
      text: "follow-up after clear",
    });
    expect(r2.turn.answer.stopReason).toBe("completed");
    loaded = await store.load(id);
    expect(loaded.goal).toBeUndefined();
    expect(
      (loaded as unknown as Record<string, unknown>)["taskFocus"]
    ).toBeUndefined();
  });
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
    expect(r.output).toBe("未设置 goal");
    expect(r.stderr).toBeUndefined();
    // store 仍空:load 抛出被 catch 截获,无副作用。
    expect(await store.list()).toEqual([]);
  });

  it("schema_invalid 真实故障: 畸形 session 文件 + /goal status → stderr `${kind}: ${conversation_id}`", async () => {
    const { store, baseDir } = await storeFor();
    const id = "schema-invalid-fresh";
    const dir = resolveProjectSessionDir(baseDir, process.cwd());
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
