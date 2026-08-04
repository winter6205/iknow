/**
 * tests/tui/hub-bridge.test.ts
 *
 * #146 hub-bridge（α 直连）：
 *  - lazy create：draft 首条消息前不建档；ensureSession(undefined) 建档、
 *    ensureSession(id) 原样返回；启动即退出不留空壳（SC 1）；
 *  - in-flight 登记簿：soleId 归因语义（0/1/N）；postMessage 进出登记、
 *    失败路径也 unmark；
 *  - postMessage 回执投影（finalText / stopReason / turnCount）。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createInflightRegistry,
  createTuiBridge,
} from "../../src/tui/hub-bridge.js";
import { assistantResult, makeDeps } from "../cli/_fixtures.js";
import { createNoAskUser } from "../../src/harness/permission/ask-user.js";
import { readdir } from "node:fs/promises";
import { resolveProjectSessionDir } from "../../src/session-api/store/session-store.js";

describe("inflight registry", () => {
  it("soleId：空 → undefined；单会话 → 该 id；多会话 → undefined", () => {
    const reg = createInflightRegistry();
    expect(reg.soleId()).toBeUndefined();
    reg.mark("a");
    expect(reg.soleId()).toBe("a");
    reg.mark("b");
    expect(reg.soleId()).toBeUndefined();
    reg.unmark("b");
    expect(reg.soleId()).toBe("a");
    reg.unmark("a");
    expect(reg.soleId()).toBeUndefined();
  });

  it("ids() 返回快照副本", () => {
    const reg = createInflightRegistry();
    reg.mark("x");
    const snap = reg.ids();
    reg.unmark("x");
    expect(snap.has("x")).toBe(true);
    expect(reg.ids().has("x")).toBe(false);
  });
});

describe("hub-bridge lazy create（SC 1）", () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "iknow-tui-bridge-"));
  });
  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  function makeBridge(responses: Parameters<typeof makeDeps>[0]) {
    const inflight = createInflightRegistry();
    return createTuiBridge({
      dataDir: baseDir,
      deps: makeDeps(responses),
      inflight,
    });
  }

  it("启动（仅构造 bridge）不建档：池目录为空", async () => {
    makeBridge([]);
    const dir = resolveProjectSessionDir(baseDir, process.cwd());
    let entries: string[] = [];
    try {
      entries = await readdir(dir);
    } catch {
      entries = []; // 目录尚不存在 = 未建档
    }
    expect(entries).toHaveLength(0);
  });

  it("ensureSession(undefined) → 建档返回 conversation_id", async () => {
    const bridge = makeBridge([]);
    const id = await bridge.ensureSession(undefined);
    expect(id).toMatch(/[0-9a-f-]{36}/);
    expect(await bridge.ensureSession(id)).toBe(id);
  });

  it("ensureSession(已建档 id) → 原样返回，不新建", async () => {
    const bridge = makeBridge([]);
    const created = await bridge.hub.createSession();
    const id = created.session.conversation_id;
    expect(await bridge.ensureSession(id)).toBe(id);
  });
});

describe("hub-bridge postMessage", () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "iknow-tui-bridge-post-"));
  });
  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  it("回执投影：finalText / stopReason / turnCount；inflight 进出自清", async () => {
    const inflight = createInflightRegistry();
    const bridge = createTuiBridge({
      dataDir: baseDir,
      deps: makeDeps([assistantResult({ texts: ["你好，世界"] })]),
      inflight,
    });
    const id = await bridge.ensureSession(undefined);
    const result = await bridge.postMessage({
      conversationId: id,
      text: "你好",
    });
    expect(result.conversationId).toBe(id);
    expect(result.finalText).toBe("你好，世界");
    expect(result.stopReason).toBe("completed");
    expect(result.turnCount).toBe(1);
    expect(inflight.ids().size).toBe(0); // 结束后清空
    // 落盘可读回（共享池纪律）
    const file = await bridge.loadSessionFile(id);
    expect(file.turnCount).toBe(1);
    expect(file.summary).toBe("你好");
  });

  it("postMessage 失败也 unmark（异常路径不留 inflight）", async () => {
    const inflight = createInflightRegistry();
    const bridge = createTuiBridge({
      dataDir: baseDir,
      deps: makeDeps([]),
      inflight,
    });
    await expect(
      bridge.postMessage({ conversationId: "no-such-id", text: "x" })
    ).rejects.toBeTruthy();
    expect(inflight.ids().size).toBe(0);
  });

  it("listSessions 代理 store.list()（过滤空会话）", async () => {
    const bridge = createTuiBridge({
      dataDir: baseDir,
      deps: makeDeps([assistantResult({ texts: ["答复"] })]),
      inflight: createInflightRegistry(),
    });
    // 仅建档不发消息 → list 不可见（lazy create 双保险）
    await bridge.hub.createSession();
    expect(await bridge.listSessions()).toHaveLength(0);
    // 发一条 → 可见且带 summary
    const id = await bridge.ensureSession(undefined);
    await bridge.postMessage({ conversationId: id, text: "第一个问题" });
    const list = await bridge.listSessions();
    expect(list).toHaveLength(1);
    expect(list[0]!.summary).toBe("第一个问题");
  });
});
