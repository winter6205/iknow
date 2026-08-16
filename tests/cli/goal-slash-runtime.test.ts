/**
 * #458 T6: /goal 三面 runtime 集成测试 — 真实 SessionStore（temp dir）
 * + fresh conversationId（不预存 session 文件）。
 *
 * 按项目测试规范（commands handler 集成测试必须接真实 store +
 * fresh conversationId）覆盖 typed-error catch 契约：fresh 上
 * not_found = 合法态（非错误，stderr 静默 + 友好 output），与 schema_invalid
 * 真实故障在 catch 处分流（禁止 instanceof Error 平铺）。
 *
 * 覆盖：
 *  - happy path: fresh + pin → 落盘 goal.status="active" && goal.text=args
 *  - fresh + status → not_found 合法态 → output「未设置 goal / taskFocus」
 *  - fresh + clear → not_found 合法态 → output「无 goal 可清」，无副作用
 *  - 已有 + status → 回显 goal.text + taskFocus
 *  - 已有 + clear → goal === undefined && taskFocus === undefined
 *  - pin 超长（>2000）→ validateGoalText 非 null → stderr 错误，不落盘
 *  - schema_invalid 真实故障 → stderr `${kind}: ${conversation_id}`
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processChatLine } from "../../src/cli/chat-session.ts";
import {
  CURRENT_SCHEMA_VERSION,
  pinGoal,
  resolveProjectSessionDir,
  seedTaskFocus,
  SessionStore,
  type SessionFileV1,
} from "../../src/session-api/store/index.ts";
import { makeCtx } from "./_fixtures.ts";

const tempDirs: string[] = [];
async function storeFor(): Promise<{ store: SessionStore; baseDir: string }> {
  const baseDir = await mkdtemp(join(tmpdir(), "iknow-goal-slash-"));
  tempDirs.push(baseDir);
  return { store: new SessionStore(baseDir, process.cwd()), baseDir };
}

afterAll(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

/** 预置 goal + taskFocus 齐备的会话文件，供 status / clear 三面集成。 */
async function seedGoalFile(
  store: SessionStore,
  id: string
): Promise<SessionFileV1> {
  const now = new Date().toISOString();
  const file: SessionFileV1 = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    conversation_id: id,
    messages: [],
    jsonMode: false,
    turnCount: 0,
    updatedAt: now,
    summary: "",
    cwd: process.cwd(),
    sanitized_at: now,
    checkpoints: [],
    goal: pinGoal({ current: undefined, text: "pinned-goal-text", now }),
    taskFocus: seedTaskFocus({
      current: undefined,
      nextText: "focused-task-text",
      now,
    }),
  };
  await store.save({ id, file });
  return file;
}

describe("/goal 三面 runtime（真实 SessionStore + fresh conversationId）", () => {
  it("happy path: fresh conversationId + pin → 落盘 goal.status=active && goal.text=args (user_pin)", async () => {
    const { store } = await storeFor();
    const id = "fresh-pin";
    const ctx = makeCtx({
      responses: [],
      checkpointStore: store,
      stateOverrides: { conversationId: id },
    });
    const r = await processChatLine({
      line: "/goal write a type checker",
      ctx,
    });
    expect(r.quit).toBe(false);
    expect(r.output).toBe("goal pinned: write a type checker");
    expect(r.stderr).toBeUndefined();
    const file = await store.load(id);
    expect(file.goal?.status).toBe("active");
    expect(file.goal?.source).toBe("user_pin");
    expect(file.goal?.text).toBe("write a type checker");
  });

  it("fresh + status → not_found 合法态：output「未设置 goal / taskFocus」，stderr 静默", async () => {
    const { store } = await storeFor();
    const id = "fresh-status";
    const ctx = makeCtx({
      responses: [],
      checkpointStore: store,
      stateOverrides: { conversationId: id },
    });
    const r = await processChatLine({ line: "/goal status", ctx });
    expect(r.quit).toBe(false);
    expect(r.stderr).toBeUndefined();
    expect(r.output).toContain("未设置 goal / taskFocus");
    expect(await store.list()).toEqual([]);
  });

  it("fresh + clear → not_found 合法态：output「无 goal 可清」，无副作用", async () => {
    const { store } = await storeFor();
    const id = "fresh-clear";
    const ctx = makeCtx({
      responses: [],
      checkpointStore: store,
      stateOverrides: { conversationId: id },
    });
    const r = await processChatLine({ line: "/goal clear", ctx });
    expect(r.quit).toBe(false);
    expect(r.stderr).toBeUndefined();
    expect(r.output).toContain("无 goal 可清");
    expect(await store.list()).toEqual([]);
  });

  it("已有 + status → 回显当前 goal.text + taskFocus", async () => {
    const { store } = await storeFor();
    const id = "existing-status";
    await seedGoalFile(store, id);
    const ctx = makeCtx({
      responses: [],
      checkpointStore: store,
      stateOverrides: { conversationId: id },
    });
    const r = await processChatLine({ line: "/goal status", ctx });
    expect(r.quit).toBe(false);
    expect(r.stderr).toBeUndefined();
    expect(r.output).toContain("pinned-goal-text");
    expect(r.output).toContain("focused-task-text");
  });

  it("已有 + clear → goal === undefined && taskFocus === undefined", async () => {
    const { store } = await storeFor();
    const id = "existing-clear";
    await seedGoalFile(store, id);
    const ctx = makeCtx({
      responses: [],
      checkpointStore: store,
      stateOverrides: { conversationId: id },
    });
    const r = await processChatLine({ line: "/goal clear", ctx });
    expect(r.quit).toBe(false);
    expect(r.stderr).toBeUndefined();
    expect(r.output).toContain("goal cleared");
    const after = await store.load(id);
    expect(after.goal).toBeUndefined();
    expect(after.taskFocus).toBeUndefined();
  });

  it("pin 超长（>2000）→ validateGoalText 非 null → stderr 错误，不落盘（SC5）", async () => {
    const { store } = await storeFor();
    const id = "fresh-overflow";
    const ctx = makeCtx({
      responses: [],
      checkpointStore: store,
      stateOverrides: { conversationId: id },
    });
    const longText = "x".repeat(2001);
    const r = await processChatLine({ line: `/goal ${longText}`, ctx });
    expect(r.quit).toBe(false);
    expect(r.output).toBe("");
    expect(r.stderr).toContain("exceeds 2000");
    await expect(store.load(id)).rejects.toMatchObject({ kind: "not_found" });
  });

  it("typed-error 契约：schema_invalid 真实故障 → stderr `${kind}: ${conversation_id}`", async () => {
    const { store, baseDir } = await storeFor();
    const id = "schema-invalid";
    const dir = resolveProjectSessionDir(baseDir, process.cwd());
    await mkdir(dir, { recursive: true });
    const now = new Date().toISOString();
    // 畸形 goal：text 字段为 number → isValidGoal false → sanitize 抛 schema_invalid。
    const bad = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      conversation_id: id,
      messages: [],
      jsonMode: false,
      turnCount: 0,
      updatedAt: now,
      summary: "",
      cwd: process.cwd(),
      sanitized_at: now,
      checkpoints: [],
      goal: { text: 123 },
    };
    await writeFile(join(dir, `${id}.json`), JSON.stringify(bad), "utf8");
    const ctx = makeCtx({
      responses: [],
      checkpointStore: store,
      stateOverrides: { conversationId: id },
    });
    const r = await processChatLine({ line: "/goal status", ctx });
    expect(r.output).toBe("");
    expect(r.stderr).toBe(`schema_invalid: ${id}`);
  });
});
