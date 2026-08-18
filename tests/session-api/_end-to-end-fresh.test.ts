/**
 * #458 T8: fresh conversation 端到端 — 真实 SessionHub + 真实 SessionStore
 * (temp dir) + chat-session /goal 三面 slash 共享同一 store 与 conversationId。
 *
 * 与 `goal-slash-runtime.test.ts` (T6) 不重复:T6 是 chat-session 单独
 * 路径的 /goal 三面单元;本文件是 serve 形态 SessionHub 与 chat 形态
 * processChatLine 共享持久化的端到端集成,覆盖:
 *
 *   a. 全生命周期:createSession → 首条 postMessage 走 SC2 seed path
 *      (taskFocus 从 query 落盘) → /goal status 回显 → /goal pin → /goal
 *      status 同时回显 goal + taskFocus → /goal clear 双清 → 再 postMessage
 *      让 SC2 重新 seed (formula 回落到 query)。
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
  it("全生命周期: create → seed taskFocus → /goal status → pin → status → clear → re-seed", async () => {
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
    expect(loaded.taskFocus).toBeUndefined();
    expect(loaded.messages).toEqual([]);

    // (1) hub.postMessage 首条 → SC2 seed path:taskFocus 从 query 落盘。
    const r1 = await hub.postMessage({
      conversationId: id,
      text: "Build a C compiler",
    });
    expect(r1.turn.answer.stopReason).toBe("completed");
    loaded = await store.load(id);
    expect(loaded.goal).toBeUndefined();
    expect(loaded.taskFocus?.text).toBe("Build a C compiler");
    // seedTaskFocus 无 current 时仍把本次文本记入 history[0]
    // (新文本进 history, cap 5)—— 与 T2 纯函数语义一致。
    expect(loaded.taskFocus?.history).toHaveLength(1);
    expect(loaded.taskFocus?.history![0]?.text).toBe("Build a C compiler");

    // (2) processChatLine /goal status → 回显 taskFocus (无 goal 段)。
    const s1 = await processChatLine({
      line: "/goal status",
      ctx: makeCtx({
        responses: [],
        checkpointStore: store,
        stateOverrides: { conversationId: id },
      }),
    });
    expect(s1.output).toContain("Build a C compiler");
    expect(s1.output).toContain("taskFocus");
    expect(s1.output).not.toContain("goal: ");
    expect(s1.stderr).toBeUndefined();

    // (3) /goal pin → user_pin 落盘,taskFocus 保留(SC2 seed 一次)。
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
    expect(loaded.taskFocus?.text).toBe("Build a C compiler");

    // (4) /goal status 同时回显 goal + taskFocus(优先级 goal > taskFocus)。
    const s3 = await processChatLine({
      line: "/goal status",
      ctx: makeCtx({
        responses: [],
        checkpointStore: store,
        stateOverrides: { conversationId: id },
      }),
    });
    expect(s3.output).toContain("goal: write a type checker");
    expect(s3.output).toContain("taskFocus: Build a C compiler");
    expect(s3.stderr).toBeUndefined();

    // (5) /goal clear → 双清 (goal + taskFocus 同步,SC)。
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
    expect(loaded.taskFocus).toBeUndefined();

    // (6) postMessage 再来一条 → taskFocus 重新 seed(SC2:absent → seed)。
    // 数据侧公式 goal.text ?? taskFocus.text ?? query = query (两者皆无);
    // verify-loop userText seam(现状:goal.text ?? query)也直接 = query。
    // 注意:conditionalSave 的 seed 文本来自 extractGoal(result.messages) —
    // 永远取会话内第一条 user text(权威历史首条),而非本次 query;
    // clear 之后历史仍在,故 re-seed 文本 = 首条 "Build a C compiler"。
    const r2 = await hub.postMessage({
      conversationId: id,
      text: "follow-up after clear",
    });
    expect(r2.turn.answer.stopReason).toBe("completed");
    loaded = await store.load(id);
    expect(loaded.goal).toBeUndefined();
    expect(loaded.taskFocus?.text).toBe("Build a C compiler");
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
    expect(r.output).toContain("未设置 goal / taskFocus");
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
