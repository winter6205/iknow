/**
 * T4: chat REPL `--resume <id>` 续跑 —— `seedResumeMessages` 辅助 + 续跑接线。
 *
 * 覆盖(ACR 4 + #222 六类边界):
 *   1. empty:resumeId 未设 → 零 IO,空 messages,行为与 T2 完全一致;
 *   2. negative:not_found / parse_failed / schema_invalid / io_error 全部
 *      typed 错误 → 守卫:返回空 messages + 触发 warn 回调,但**保留
 *      conversationId 锚点**,使后续 turn 的 checkpoint 写回同一 `<id>.jsonl`;
 *   3. overflow / concurrent:同 conversationId 多次 completed → turnCount
 *      累计到 prior+N,消息累计;cancelled-带-turnCount=1 → checkpoint 序列
 *      在既有索引后继续 append;
 *   4. exception:未知 throw(非 typed)→ 原样重抛,绝不静默吞咽;
 *   + 成功路径:load 命中 → state.messages == file.messages;首轮续跑经
 *     processChatLine 完成 → file.turnCount = prior + 1,messages 累计,
 *     checkpoints 保序。
 *
 * 设计:`runChatSession` 本身是 TTY/管道入口(integration-heavy,不可单元测),
 * 但其核心 IO(`store.load` 一次 + 写入 state)被抽取到纯辅助 `seedResumeMessages`,
 * 便于单测。续跑接线(state.messages = seed 结果)则通过 processChatLine
 * 间接验证 —— prior 视图一致即可证。
 */
import { afterAll, afterEach, beforeEach, describe, it, vi } from "vitest";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  persistChatSessionCheckpoint,
  processChatLine,
  seedResumeMessages,
} from "../../src/cli/chat-session.ts";
import {
  resolveConversationDir,
  resolveProjectSessionDir,
  SessionStore,
} from "../../src/session-api/store/index.ts";
import type {
  AnthropicNativeMessage,
  RunResult,
} from "../../src/harness/index.ts";
import { assistantResult, makeCtx } from "./_fixtures.ts";

// -- fixtures ----------------------------------------------------------------

const text = (t: string) => ({ type: "text" as const, text: t });
const userMsg = (t: string): AnthropicNativeMessage => ({
  role: "user",
  content: [text(t)],
});
const assistantMsg = (t: string): AnthropicNativeMessage => ({
  role: "assistant",
  content: [text(t)],
});

const tempDirs: string[] = [];
async function storeFor(): Promise<SessionStore> {
  const tmp = await mkdtemp(join(tmpdir(), "iknow-chat-resume-"));
  tempDirs.push(tmp);
  return new SessionStore(tmp, process.cwd());
}

afterAll(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

type InterruptReasonLit =
  "cancelled" | "maxTurns" | "process" | "protocolError" | "timeout";

/** Build a v3 session file matching schema (CURRENT_SCHEMA_VERSION=3). */
function seededFile(opts: {
  readonly id: string;
  readonly messages: ReadonlyArray<AnthropicNativeMessage>;
  readonly turnCount: number;
  readonly checkpoints?: ReadonlyArray<{
    readonly turnIndex: number;
    readonly messagesCount: number;
    readonly interruptedAt: string;
    readonly interruptReason: InterruptReasonLit;
  }>;
}): Parameters<SessionStore["save"]>[0]["file"] {
  return {
    schemaVersion: 3,
    conversation_id: opts.id,
    messages: opts.messages,
    jsonMode: false,
    turnCount: opts.turnCount,
    updatedAt: "2026-08-11T00:00:00.000Z",
    title: "",
    cwd: process.cwd(),
    sanitized_at: "2026-08-11T00:00:00.000Z",
    checkpoints: opts.checkpoints ?? [],
  };
}

function buildResult(opts: {
  readonly stopReason: RunResult["stopReason"];
  readonly messages: ReadonlyArray<AnthropicNativeMessage>;
  readonly turnCount?: number;
}): RunResult {
  return {
    finalText: null,
    messages: opts.messages,
    turnCount: opts.turnCount ?? 1,
    stopReason: opts.stopReason,
    lastUsage: null,
  };
}

// -- stderr capture (spyOn) --------------------------------------------------

/**
 * `seedResumeMessages` 的 warn 回调内部走 `writeErr` → `process.stderr.write`。
 * vitest spyOn 与 tui/run-errors.test.ts 同源(bun:test 版),跨文件复用稳定模式。
 */
// Capture stderr.write spy. vi.spyOn's generic resolution with
// `process.stderr.write` overloads is brittle: TS picks an overload
// whose method-key constraint defaults to array-method keys, so the
// helper's constraint fails even though the runtime call is sound. We
// type it via the concrete return type of the actual `vi.spyOn(...)`
// assignment in `beforeEach`, then consume `mock.calls` / `mockRestore`
// without further re-derivation.
import type { MockInstance } from "vitest";
let stderrSpy: MockInstance<typeof process.stderr.write>;

function capturedStderr(): string {
  return stderrSpy.mock.calls
    .map((call) =>
      typeof call[0] === "string"
        ? call[0]
        : Buffer.from(call[0] as Uint8Array).toString("utf8")
    )
    .join("");
}

beforeEach(() => {
  stderrSpy = vi.spyOn(process.stderr, "write");
});
afterEach(() => {
  stderrSpy.mockRestore();
});

// -- seedResumeMessages (纯 IO 辅助) ----------------------------------------

describe("seedResumeMessages — T4 seed helper", () => {
  it("resumeId 未设 → 空 messages,无 warn (empty-class 零 IO)", async () => {
    const r = await seedResumeMessages({ store: undefined, id: undefined });
    assert.deepEqual(r.messages, []);
    assert.equal(r.warn, undefined);
  });

  it("load 命中 → messages 严格匹配文件,无 warn", async () => {
    const s = await storeFor();
    const id = "hit";
    const messages = [userMsg("q1"), assistantMsg("a1")];
    await s.save({ id, file: seededFile({ id, messages, turnCount: 1 }) });

    const r = await seedResumeMessages({ store: s, id });
    assert.deepEqual(r.messages, messages);
    assert.equal(r.warn, undefined);
  });

  it("not_found → messages=[],warn 回调触发且文案含 [not_found] 与 id", async () => {
    const s = await storeFor();
    const r = await seedResumeMessages({ store: s, id: "ghost" });
    assert.deepEqual(r.messages, []);
    assert.equal(typeof r.warn, "function");
    r.warn!();
    const text = capturedStderr();
    assert.match(text, /恢复会话 ghost 失败/);
    assert.match(text, /\[not_found\]/);
    assert.match(text, /仍锚定 ghost/);
  });

  it("parse_failed → 写入垃圾 JSON 后 warn 触发 [parse_failed]", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "iknow-chat-resume-corrupt-"));
    tempDirs.push(tmp);
    const s = new SessionStore(tmp, process.cwd());
    const id = "corrupt";
    const dir = resolveConversationDir({
      projectDir: resolveProjectSessionDir(tmp, process.cwd()),
      conversationId: id,
    });
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${id}.json`), "{not json", "utf8");

    const r = await seedResumeMessages({ store: s, id });
    assert.deepEqual(r.messages, []);
    assert.equal(typeof r.warn, "function");
    r.warn!();
    const text = capturedStderr();
    assert.match(text, /\[parse_failed\]/);
    assert.match(text, new RegExp(id));
  });

  it("schema_invalid → schemaVersion=99 → warn 触发 [schema_invalid]", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "iknow-chat-resume-schema-"));
    tempDirs.push(tmp);
    const s = new SessionStore(tmp, process.cwd());
    const id = "bad-schema";
    const dir = resolveConversationDir({
      projectDir: resolveProjectSessionDir(tmp, process.cwd()),
      conversationId: id,
    });
    await mkdir(dir, { recursive: true });
    // future schemaVersion → validateSessionFile returns "schemaVersion" →
    // sanitize throws → load re-throws schema_invalid.
    await writeFile(
      join(dir, `${id}.json`),
      JSON.stringify({ schemaVersion: 99, conversation_id: id }),
      "utf8"
    );

    const r = await seedResumeMessages({ store: s, id });
    assert.deepEqual(r.messages, []);
    assert.equal(typeof r.warn, "function");
    r.warn!();
    const text = capturedStderr();
    assert.match(text, /\[schema_invalid\]/);
  });

  it("io_error → project session dir 是普通文件 → readFile 走非 ENOENT 分支", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "iknow-chat-resume-io-"));
    tempDirs.push(tmp);
    const s = new SessionStore(tmp, process.cwd());
    const id = "io-err";
    const projectDir = resolveProjectSessionDir(tmp, process.cwd());
    const convDir = resolveConversationDir({
      projectDir,
      conversationId: id,
    });
    // 把 conversation subfolder 替换成一个普通文件:readFile 解析其子路径时
    // ENOTDIR → store.readRaw 把 ENOENT 之外的失败映射为 io_error。
    await mkdir(join(tmp, "projects"), { recursive: true });
    await mkdir(projectDir, { recursive: true });
    await writeFile(convDir, "blocker", "utf8");

    const r = await seedResumeMessages({ store: s, id });
    assert.deepEqual(r.messages, []);
    assert.equal(typeof r.warn, "function");
    r.warn!();
    assert.match(capturedStderr(), /\[io_error\]/);
  });

  // -- per-root 池兜底（TUI 退出 resume 提示接线） ---------------------------
  //
  // TUI 会话落 <workspaceRoot>/.iknow（ADR-0019 per-root 锚点），而 chat
  // checkpoint 池 = ~/.iknow。/quit 打印的 `iknow --resume <id>` 必须能找到
  // TUI 建的会话：default 池 not_found 时以 fallbackStore（per-root 池）重试。

  it("default 池 not_found → fallbackStore(per-root 池)命中,无 warn", async () => {
    const defaultPool = await storeFor();
    const rootPool = await storeFor();
    const id = "tui-born";
    const messages = [userMsg("hello"), assistantMsg("ok")];
    await rootPool.save({
      id,
      file: seededFile({ id, messages, turnCount: 1 }),
    });

    const r = await seedResumeMessages({
      store: defaultPool,
      id,
      fallbackStore: rootPool,
    });
    assert.deepEqual(r.messages, messages);
    assert.equal(r.warn, undefined);
  });

  it("default 池命中 → 不查 fallbackStore（legacy 会话零变化）", async () => {
    const defaultPool = await storeFor();
    const rootPool = await storeFor();
    const id = "chat-born";
    const messages = [userMsg("q"), assistantMsg("a")];
    await defaultPool.save({
      id,
      file: seededFile({ id, messages, turnCount: 1 }),
    });

    const r = await seedResumeMessages({
      store: defaultPool,
      id,
      fallbackStore: rootPool,
    });
    assert.deepEqual(r.messages, messages);
    assert.equal(r.warn, undefined);
  });

  it("两池都 not_found → messages=[],warn 报 not_found（不静默）", async () => {
    const defaultPool = await storeFor();
    const rootPool = await storeFor();
    const r = await seedResumeMessages({
      store: defaultPool,
      id: "ghost",
      fallbackStore: rootPool,
    });
    assert.deepEqual(r.messages, []);
    assert.equal(typeof r.warn, "function");
    r.warn!();
    assert.match(capturedStderr(), /\[not_found\]/);
  });

  it("fallbackStore 缺席 → 行为与既有完全一致（not_found warn）", async () => {
    const defaultPool = await storeFor();
    const r = await seedResumeMessages({ store: defaultPool, id: "ghost" });
    assert.deepEqual(r.messages, []);
    assert.equal(typeof r.warn, "function");
  });

  it("未知异常(防御性)→ 原样重抛,绝不静默吞咽", async () => {
    // 构造一个形状上满足 SessionStore.load 但抛裸 Error 的 fake,模拟
    // store 契约外的不寻常故障。强转为 unknown-SessionStore 仅限测试。
    const fake = {
      load: () => Promise.reject(new Error("explosion")),
    } as unknown as SessionStore;
    await assert.rejects(
      () => seedResumeMessages({ store: fake, id: "x" }),
      (err: unknown) => err instanceof Error && err.message === "explosion"
    );
  });
});

// -- runChatSession-equivalent wiring:seed + processChatLine -----------------

describe("resume 续跑集成(seed 步骤 + processChatLine 接线)", () => {
  it("成功:resume turnCount=3 文件 → 首轮 completed 后 turnCount=4,messages 累计,checkpoints 保序", async () => {
    const s = await storeFor();
    const id = "resume-completed";
    const seededMessages = [
      userMsg("q1"),
      assistantMsg("a1"),
      userMsg("q2"),
      assistantMsg("a2"),
      userMsg("q3"),
      assistantMsg("a3"),
    ];
    const seededCheckpoint = {
      turnIndex: 2,
      messagesCount: 4,
      interruptedAt: "2026-08-10T00:00:00.000Z",
      interruptReason: "process" as InterruptReasonLit,
    };
    await s.save({
      id,
      file: seededFile({
        id,
        messages: seededMessages,
        turnCount: 3,
        checkpoints: [seededCheckpoint],
      }),
    });

    // seed 步骤 —— 与 runChatSession 内同源,验证 state.messages 严格匹配。
    const seeded = await seedResumeMessages({ store: s, id });
    assert.equal(seeded.messages.length, 6);
    assert.deepEqual(
      [...seeded.messages],
      seededMessages,
      "state.messages 必须严格匹配文件 messages"
    );

    // 构造与 runChatSession 同形态的 ctx(state.messages = seed 结果)。
    const ctx = makeCtx({
      responses: [assistantResult({ texts: ["a4"] })],
      checkpointStore: s,
      workspaceRoot: process.cwd(),
      stateOverrides: {
        conversationId: id,
        messages: Object.freeze([...seeded.messages]),
      },
    });
    const r = await processChatLine({ line: "q4", ctx });
    assert.equal(r.ranQuery, true);

    // 累计:3 (seeded) + 1 (completed) = 4。completed 不 append checkpoint。
    const file = await s.load(id);
    assert.equal(file.turnCount, 4, "completed 续跑必须累计 turnCount");
    assert.equal(file.messages.length, 8, "messages 累计到 8");
    assert.equal(file.checkpoints?.length, 1, "completed 不 append checkpoint");
    assert.deepEqual(
      file.checkpoints?.[0],
      // #622 T5 (spec D3): checkpoint 以 event id 为权威锚点 —— save/load
      // 从 messagesCount=4 派生出链上第 4 个事件 e3。
      { ...seededCheckpoint, anchorEventId: "e3" },
      "既有 checkpoints 必须保序不丢"
    );
  });

  it("成功(resume + cancelled-turn 累计 turnIndex=4):prior turnCount=3 → checkpoint 从既有序列继续", async () => {
    // 端到端验证 `session.turnCount + result.turnCount` 在 resume 上下文中
    // 仍镜像 hub.ts:739 累计约定。结果 turnCount=1 → turnIndex=3+1=4。
    const s = await storeFor();
    const id = "resume-cancelled";
    const seeded = [
      userMsg("q1"),
      assistantMsg("a1"),
      userMsg("q2"),
      assistantMsg("a2"),
      userMsg("q3"),
      assistantMsg("a3"),
    ];
    const priorCheckpoint = {
      turnIndex: 2,
      messagesCount: 4,
      interruptedAt: "2026-08-10T00:00:00.000Z",
      interruptReason: "process" as InterruptReasonLit,
    };
    await s.save({
      id,
      file: seededFile({
        id,
        messages: seeded,
        turnCount: 3,
        checkpoints: [priorCheckpoint],
      }),
    });

    // 模拟一轮 cancelled(模型产生 partial 后被中断)的后置落盘。prior =
    // 文件既有 messages。
    await persistChatSessionCheckpoint({
      store: s,
      conversationId: id,
      jsonMode: false,
      result: buildResult({
        stopReason: "cancelled",
        messages: [...seeded, userMsg("q4"), assistantMsg("partial a4")],
        turnCount: 1,
      }),
      priorMessages: seeded,
    });

    const file = await s.load(id);
    assert.equal(
      file.turnCount,
      4,
      "累计 turnCount = prior(3) + result.turnCount(1) = 4"
    );
    assert.equal(file.messages.length, 8, "messages 含 partial assistant");
    assert.equal(file.checkpoints?.length, 2, "既有 + 新增 = 2");
    const latest = file.checkpoints?.[1];
    assert.equal(latest?.turnIndex, 4, "累计 turnIndex = 3 + 1 = 4");
    assert.equal(latest?.messagesCount, 8, "messagesCount cumulative");
    assert.equal(latest?.interruptReason, "cancelled");
    // 既有 checkpoint 保序不丢（T5: 派生 anchorEventId=e3，见上例注释）。
    assert.deepEqual(file.checkpoints?.[0], {
      ...priorCheckpoint,
      anchorEventId: "e3",
    });
  });

  it("not_found → seed 返空 + 锚点保留;后续 completed 写回同一 <id>.jsonl(anchor-preserved 验收)", async () => {
    const s = await storeFor();
    const id = "anchor-keep";
    // 文件不存在(seed 必走 not_found 分支)。
    const seeded = await seedResumeMessages({ store: s, id });
    assert.deepEqual(seeded.messages, []);
    assert.equal(typeof seeded.warn, "function");
    seeded.warn!();
    assert.match(capturedStderr(), new RegExp(`恢复会话 ${id} 失败`));

    // state.messages = [], conversationId = id(锚点保留)。运行一轮
    // completed → 应当写到 <id>.json,而不是碎片化成新 UUID。
    const ctx = makeCtx({
      responses: [assistantResult({ texts: ["hello"] })],
      checkpointStore: s,
      workspaceRoot: process.cwd(),
      stateOverrides: {
        conversationId: id,
        messages: Object.freeze([...seeded.messages]),
      },
    });
    await processChatLine({ line: "hi", ctx });
    const file = await s.load(id);
    assert.equal(file.turnCount, 1);
    assert.equal(file.conversation_id, id, "写回同一 <id>.json,锚点保留");
  });

  it("resume 文件 checkpoints=null(畸形)→ seed 空 + warn [schema_invalid] + 锚点保留", async () => {
    // 5-category boundary:exception 的深树 —— v3 文件 `checkpoints: null`
    // 是畸形(生产裁决「never silently coerce」,schema.ts:94-96,绝不归一化)。
    // load 抛 typed schema_invalid(field="checkpoints")→ seed 走 typed
    // 守卫:空 messages + warn 触发且含 [schema_invalid] + 锚点保留(id 不丢)。
    // 绝不裸 Error、绝不静默吞。
    const tmp = await mkdtemp(join(tmpdir(), "iknow-chat-resume-cpnull-"));
    tempDirs.push(tmp);
    const s = new SessionStore(tmp, process.cwd());
    const id = "cp-null";
    const dir = resolveConversationDir({
      projectDir: resolveProjectSessionDir(tmp, process.cwd()),
      conversationId: id,
    });
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, `${id}.json`),
      JSON.stringify({
        schemaVersion: 3,
        conversation_id: id,
        messages: [userMsg("q1"), assistantMsg("a1")],
        jsonMode: false,
        turnCount: 1,
        updatedAt: "2026-08-11T00:00:00.000Z",
        title: "q1",
        cwd: "",
        sanitized_at: "2026-08-11T00:00:00.000Z",
        checkpoints: null,
      }),
      "utf8"
    );

    const seeded = await seedResumeMessages({ store: s, id });
    assert.deepEqual(seeded.messages, []);
    assert.equal(typeof seeded.warn, "function");
    seeded.warn!();
    const text = capturedStderr();
    assert.match(text, new RegExp(`恢复会话 ${id} 失败`));
    assert.match(text, /\[schema_invalid\]/);
    assert.match(text, new RegExp(`仍锚定 ${id}`));

    // 锚点保留:后续 completed 写回同一 <id>.jsonl,重建为干净 v5 文件。
    const ctx = makeCtx({
      responses: [assistantResult({ texts: ["hello"] })],
      checkpointStore: s,
      workspaceRoot: process.cwd(),
      stateOverrides: {
        conversationId: id,
        messages: Object.freeze([...seeded.messages]),
      },
    });
    await processChatLine({ line: "hi", ctx });
    const file = await s.load(id);
    assert.equal(file.conversation_id, id, "写回同一 <id>.json,锚点保留");
    assert.equal(file.turnCount, 1);
    assert.deepEqual(file.checkpoints, [], "重建文件 checkpoints 归一为 []");
  });

  it("concurrent / duplicate commit:resume → 2 completed turns → turnCount = prior + 2", async () => {
    const s = await storeFor();
    const id = "repeat-after-resume";
    const seeded = [
      userMsg("q1"),
      assistantMsg("a1"),
      userMsg("q2"),
      assistantMsg("a2"),
    ];
    const priorCheckpoint = {
      turnIndex: 2,
      messagesCount: 4,
      interruptedAt: "2026-08-10T00:00:00.000Z",
      interruptReason: "process" as InterruptReasonLit,
    };
    await s.save({
      id,
      file: seededFile({
        id,
        messages: seeded,
        turnCount: 2,
        checkpoints: [priorCheckpoint],
      }),
    });

    // 两轮 completed —— 复用同一 store + conversationId,直接模拟重复 commit。
    await persistChatSessionCheckpoint({
      store: s,
      conversationId: id,
      jsonMode: false,
      result: buildResult({
        stopReason: "completed",
        messages: [...seeded, userMsg("q3"), assistantMsg("a3")],
        turnCount: 1,
      }),
      priorMessages: seeded,
    });
    const afterFirst = await s.load(id);
    const messagesAfter1 = [...afterFirst.messages];
    await persistChatSessionCheckpoint({
      store: s,
      conversationId: id,
      jsonMode: false,
      result: buildResult({
        stopReason: "completed",
        messages: [...messagesAfter1, userMsg("q4"), assistantMsg("a4")],
        turnCount: 1,
      }),
      priorMessages: messagesAfter1,
    });

    const file = await s.load(id);
    assert.equal(file.turnCount, 4, "累计 turnCount = prior(2) + 2 = 4");
    assert.equal(file.messages.length, 8);
    // completed 不 append checkpoint → 既有 1 条保留不变;若要增长,需经
    // cancelled(已在「resume-cancelled」用例覆盖 turnIndex 累计)。
    assert.equal(
      file.checkpoints?.length,
      1,
      "completed 重复 commit 不增长 checkpoints(既有保序)"
    );
    // T5: 派生 anchorEventId=e3（messagesCount=4 → 链上第 4 个事件）。
    assert.deepEqual(file.checkpoints?.[0], {
      ...priorCheckpoint,
      anchorEventId: "e3",
    });
  });
});
