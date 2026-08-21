/**
 * #458 T6 → #605 T2: /goal 三面 runtime 集成测试 — 真实 SessionStore
 * (temp dir) + fresh conversationId（不预存 session 文件）。
 *
 * 按项目测试规范（commands handler 集成测试必须接真实 store +
 * fresh conversationId）覆盖 typed-error catch 契约：fresh 上
 * not_found = 合法态（非错误，stderr 静默 + 友好 output），与 schema_invalid
 * 真实故障在 catch 处分流（禁止 instanceof Error 平铺）。
 *
 * 覆盖：
 *  - happy path: fresh + pin → 落盘 goal.status="active" && goal.text=args
 *  - fresh + status → not_found 合法态 → output「未设置 goal」
 *  - fresh + clear → not_found 合法态 → output「无 goal 可清」，无副作用
 *  - 已有 + status → 回显 goal.text (taskFocus 段已随 T2 退休)
 *  - 已有 + clear → goal === undefined (taskFocus 不参与双清)
 *  - pin 超长（>2000）→ validateGoalText 非 null → stderr 错误，不落盘
 *  - schema_invalid 真实故障 → stderr `${kind}: ${conversation_id}`
 *
 * #605 T2 调整:taskFocus 字段已退休 — 不再 seed / clear / 回显;legacy
 * 盘文件上 taskFocus key 被 sanitize-drop 剥离后字段恒缺席。
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

// Legacy on-disk shape (the runtime type was retired in #605 T2). The
// fixture mirrors what pre-T2 disk files carried so the chat-session
// consumer-side "taskFocus present on disk but absent after load"
// assertion stays meaningful as a sanitize-drop contract test.
interface LegacyTaskFocusState {
  text: string;
  updatedAt: string;
  history?: ReadonlyArray<{ text: string; updatedAt: string }>;
}

/** 预置带 legacy taskFocus key 的 goal 会话文件 (#605 T2 后 sanitize-drop
 *  加载 → 字段恒缺席)。本 fixture 用 inline 构造保留 schema 兼容回归。*/
async function seedGoalFile(store: SessionStore, id: string): Promise<void> {
  const now = new Date().toISOString();
  const file: SessionFileV1 = {
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
    goal: pinGoal({ current: undefined, text: "pinned-goal-text", now }),
    // legacy taskFocus key — 加载时被 sanitize-drop 剥离。
    taskFocus: {
      text: "focused-task-text",
      updatedAt: now,
      history: [{ text: "focused-task-text", updatedAt: now }],
    } satisfies LegacyTaskFocusState as unknown as SessionFileV1["goal"],
  };
  await store.save({ id, file });
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
    // #605 T2:taskFocus 字段不再写入。
    expect(
      (file as unknown as Record<string, unknown>)["taskFocus"]
    ).toBeUndefined();
  });

  it("fresh + status → not_found 合法态：output「未设置 goal」，stderr 静默", async () => {
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
    expect(r.output).toBe("未设置 goal");
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

  it("已有 + status → 回显当前 goal.text (legacy taskFocus key 被 sanitize-drop)", async () => {
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
    // #605 T2:legacy taskFocus key 加载时被剥离,status 输出不再包含 taskFocus 段。
    expect(r.output).not.toContain("focused-task-text");
    expect(r.output).not.toContain("taskFocus");
  });

  it("已有 + clear → goal === undefined (taskFocus 不再参与双清)", async () => {
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
    expect(
      (after as unknown as Record<string, unknown>)["taskFocus"]
    ).toBeUndefined();
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
      title: "",
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
