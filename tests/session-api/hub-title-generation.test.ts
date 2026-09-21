/**
 * ADR-0113 session-list-title: integration tests for hub-side lite title
 * generation trigger semantics. Real SessionStore (temp dir) + stub deps +
 * stub titleGenerator. One describe per trigger case:
 *   (a) first completed + substantive user msg → fire-and-forget, never
 *       blocks the main turn;
 *   (b) lite (generator) absent → never triggers, no error;
 *   (c) generator throws / returns undefined → log-and-continue, title stays
 *       placeholder;
 *   (d) title event already exists → second completed writes no second event
 *       (in-process gate + cross-hub disk gate);
 *   (e) small-talk-only → no generation; a later completed turn with a
 *       substantive question does generate.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionHub } from "../../src/session-api/hub.ts";
import {
  extractTitle,
  resolveConversationDir,
  resolveProjectSessionDir,
  SessionStore,
} from "../../src/session-api/store/index.ts";
import { makeDeps, assistantResult } from "../cli/_fixtures.ts";
import type {
  TitleGenerator,
  TitleSource,
} from "../../src/session-api/title-generation.ts";

let baseDir: string;
let store: SessionStore;
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "iknow-hub-title-"));
  store = new SessionStore(baseDir, process.cwd());
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  warnSpy.mockRestore();
  await rm(baseDir, { recursive: true, force: true });
});

async function titleEventsOf(conversationId: string): Promise<string[]> {
  const dir = resolveConversationDir({
    projectDir: resolveProjectSessionDir(baseDir, process.cwd()),
    conversationId,
  });
  const files = await readdirNames(dir);
  const jsonl = files.find((f) => f.endsWith(".jsonl"));
  if (jsonl === undefined) return [];
  const raw = await readFile(join(dir, jsonl), "utf8");
  const titles: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      const rec = JSON.parse(line) as { type?: string; text?: string };
      if (rec.type === "title" && typeof rec.text === "string") {
        titles.push(rec.text);
      }
    } catch {
      // Ignore non-JSON lines (counting view local to this test; real parsing is in the store).
    }
  }
  return titles;
}

async function readdirNames(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

function makeHubWith(titleGenerator?: TitleGenerator): SessionHub {
  return new SessionHub({
    store,
    deps: makeDeps([
      assistantResult({ texts: ["好的，开始处理"] }),
      assistantResult({ texts: ["第二轮回复"] }),
      assistantResult({ texts: ["第三轮回复"] }),
    ]),
    workspaceRoot: process.cwd(),
    ...(titleGenerator !== undefined ? { titleGenerator } : {}),
  });
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// -- (a) fire-and-forget ------------------------------------------------------

describe("(a) 第一次 completed + 实质 user → 异步生成不挡主回合", () => {
  it("postMessage 在生成未完成时即返回;生成完成后标题事件落盘", async () => {
    const gate = deferred<string | undefined>();
    const sources: TitleSource[] = [];
    const gen: TitleGenerator = (source) => {
      sources.push(source);
      return gate.promise;
    };
    const hub = makeHubWith(gen);
    const { session } = await hub.createSession();

    // Generator has not settled yet — postMessage must still return (if the hub awaited generation, this await would hang to timeout).
    const res = await hub.postMessage({
      conversationId: session.conversation_id,
      text: "帮我重构登录模块并补齐单元测试",
    });
    expect(res.turn.answer.stopReason).toBe("completed");
    // Title event not yet on disk — proves the main turn was not blocked by generation.
    expect(await titleEventsOf(session.conversation_id)).toEqual([]);

    gate.resolve("登录模块重构");
    await expect
      .poll(async () => await titleEventsOf(session.conversation_id), {
        timeout: 3000,
      })
      .toEqual(["登录模块重构"]);
    const loaded = await store.load(session.conversation_id);
    expect(loaded.title).toBe("登录模块重构");
    // Generator invoked exactly once, input contains the substantive user query
    expect(sources.length).toBe(1);
    expect(sources[0].userQueries).toEqual(["帮我重构登录模块并补齐单元测试"]);
  });
});

// -- (b) lite (generator) absent -------------------------------------------------

describe("(b) lite 缺席 → 完全不触发,无报错", () => {
  it("未注入 titleGenerator 的 hub 正常 completed,无标题事件、无 warn", async () => {
    const hub = makeHubWith(undefined);
    const { session } = await hub.createSession();
    const res = await hub.postMessage({
      conversationId: session.conversation_id,
      text: "写一个贪吃蛇游戏",
    });
    expect(res.turn.answer.stopReason).toBe("completed");
    expect(await titleEventsOf(session.conversation_id)).toEqual([]);
    const loaded = await store.load(session.conversation_id);
    expect(loaded.title).toBe(extractTitle(loaded.messages));
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

// -- (c) generation fails → log-and-continue, placeholder kept --------------------

describe("(c) 生成抛错 / 无结果 → 静默 log-and-continue", () => {
  it("generator 抛异常:postMessage 正常返回,标题留占位,一次 warn", async () => {
    const gen: TitleGenerator = () => {
      throw new Error("lite down");
    };
    const hub = makeHubWith(gen);
    const { session } = await hub.createSession();
    const res = await hub.postMessage({
      conversationId: session.conversation_id,
      text: "调研一下 bwrap 沙箱的逃逸面",
    });
    expect(res.turn.answer.stopReason).toBe("completed");
    await expect
      .poll(() => warnSpy.mock.calls.length, { timeout: 3000 })
      .toBeGreaterThan(0);
    expect(await titleEventsOf(session.conversation_id)).toEqual([]);
    const loaded = await store.load(session.conversation_id);
    expect(loaded.title).toBe(extractTitle(loaded.messages));
  });

  it("generator resolve undefined(超时/空响应形态):占位保留,一次 warn", async () => {
    const gen: TitleGenerator = async () => undefined;
    const hub = makeHubWith(gen);
    const { session } = await hub.createSession();
    await hub.postMessage({
      conversationId: session.conversation_id,
      text: "把导出功能改成流式",
    });
    await expect
      .poll(() => warnSpy.mock.calls.length, { timeout: 3000 })
      .toBeGreaterThan(0);
    expect(await titleEventsOf(session.conversation_id)).toEqual([]);
    const loaded = await store.load(session.conversation_id);
    expect(loaded.title).toBe(extractTitle(loaded.messages));
  });
});

// -- (d) title event exists → no second write -------------------------------------

describe("(d) 已有标题事件 → 跳过", () => {
  it("第二次 completed 不再调用生成器、不写第二条事件", async () => {
    let calls = 0;
    const gen: TitleGenerator = async () => {
      calls += 1;
      return "重构登录模块";
    };
    const hub = makeHubWith(gen);
    const { session } = await hub.createSession();
    await hub.postMessage({
      conversationId: session.conversation_id,
      text: "帮我重构登录模块",
    });
    await expect
      .poll(() => titleEventsOf(session.conversation_id), { timeout: 3000 })
      .toEqual(["重构登录模块"]);

    await hub.postMessage({
      conversationId: session.conversation_id,
      text: "再补一段导出功能",
    });
    // let any wrongly-triggered async tail finish
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toBe(1);
    expect(await titleEventsOf(session.conversation_id)).toEqual([
      "重构登录模块",
    ]);
  });

  it("跨进程形态:新 hub 实例见磁盘已有标题事件 → 生成器不被调用", async () => {
    const first: TitleGenerator = async () => "已有标题";
    const hubA = makeHubWith(first);
    const { session } = await hubA.createSession();
    await hubA.postMessage({
      conversationId: session.conversation_id,
      text: "先把列表标题功能做出来",
    });
    await expect
      .poll(() => titleEventsOf(session.conversation_id), { timeout: 3000 })
      .toEqual(["已有标题"]);

    let calls = 0;
    const second: TitleGenerator = async () => {
      calls += 1;
      return "不该出现";
    };
    const hubB = makeHubWith(second);
    await hubB.postMessage({
      conversationId: session.conversation_id,
      text: "再加一轮新的对话内容",
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toBe(0);
    expect(await titleEventsOf(session.conversation_id)).toEqual(["已有标题"]);
  });

  it("check-then-act 同槽位:预筛通过后标题事件才落盘 → 槽位内复检拦截第二条", async () => {
    // Invariant: the authoritative hasTitleEvent check and appendTitle run
    // sequentially inside the same serialize work callback. If an external
    // title event lands during generation (after the pre-screen read empty),
    // the in-slot re-check before writing must see it and skip — exactly one
    // event on disk.
    const gate = deferred<string | undefined>();
    let genStarted = false;
    const gen: TitleGenerator = () => {
      genStarted = true;
      return gate.promise;
    };
    const hub = makeHubWith(gen);
    const { session } = await hub.createSession();
    await hub.postMessage({
      conversationId: session.conversation_id,
      text: "让标题判定和写入落在同一个槽位里",
    });
    await vi.waitFor(() => expect(genStarted).toBe(true));
    // Hub's out-of-queue pre-screen has just concluded "no title event"; write one now.
    await store.appendTitle({ id: session.conversation_id, text: "期间写入" });
    gate.resolve("不该出现的第二条");
    await new Promise((r) => setTimeout(r, 50));
    expect(await titleEventsOf(session.conversation_id)).toEqual(["期间写入"]);
  });
});

// -- (e) small-talk gate -----------------------------------------------------------

describe("(e) 寒暄-only → 不生成;后续实质提问才生成", () => {
  it("首条为寒暄:生成器不被调用;第二条实质提问 completed 后调用一次", async () => {
    let calls = 0;
    const gen: TitleGenerator = async (source) => {
      calls += 1;
      // small talk never enters the prompt: only substantive queries
      expect(source.userQueries).toEqual(["帮我把侧栏标题渲染改完"]);
      return "侧栏标题渲染";
    };
    const hub = makeHubWith(gen);
    const { session } = await hub.createSession();
    await hub.postMessage({
      conversationId: session.conversation_id,
      text: "你好",
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toBe(0);
    expect(await titleEventsOf(session.conversation_id)).toEqual([]);

    await hub.postMessage({
      conversationId: session.conversation_id,
      text: "帮我把侧栏标题渲染改完",
    });
    await expect
      .poll(() => titleEventsOf(session.conversation_id), { timeout: 3000 })
      .toEqual(["侧栏标题渲染"]);
    expect(calls).toBe(1);
  });
});

// -- hub-side sanitize (guards against multi-line / oversized generator output) ------

describe("hub 落盘前统一 sanitize", () => {
  it("生成器返回多行超长文本 → 落盘为单行 ≤80 字", async () => {
    const gen: TitleGenerator = async () =>
      `登录模块\n重构方案\n${"补".repeat(100)}`;
    const hub = makeHubWith(gen);
    const { session } = await hub.createSession();
    await hub.postMessage({
      conversationId: session.conversation_id,
      text: "设计一套登录模块重构的完整方案",
    });
    await expect
      .poll(() => titleEventsOf(session.conversation_id), { timeout: 3000 })
      .toEqual([`登录模块 重构方案 ${"补".repeat(70)}`]);
  });
});
