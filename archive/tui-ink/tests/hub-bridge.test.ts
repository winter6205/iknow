/**
 * tests/tui/hub-bridge.test.ts
 *
 * #146 hub-bridge（α 直连）：
 *  - lazy create：draft 首条消息前不建档；ensureSession(undefined) 建档、
 *    ensureSession(id) 原样返回；启动即退出不留空壳（SC 1）；
 *  - in-flight 登记簿：soleId 归因语义（0/1/N）；postMessage 进出登记、
 *    失败路径也 unmark；
 *  - postMessage 回执投影（finalText / stopReason / turnCount）；
 *  - T3 上下文用量：bridge.contextWindow 默认 200000、可 override；postMessage
 *    回执的 lastUsage 透传（wire 有 → state 有；wire 无 → null）。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createInflightRegistry,
  createTuiBridge,
} from "../../src/tui/hub-bridge.js";
import { assistantResult, makeDeps } from "../cli/_fixtures.js";
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
    ).rejects.toMatchObject({ kind: "not_found" });
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

describe("hub-bridge contextWindow（T3）", () => {
  it("默认 200000（与 loop-engine compress 默认同源）", () => {
    const bridge = createTuiBridge({
      deps: makeDeps([]),
      inflight: createInflightRegistry(),
    });
    expect(bridge.contextWindow).toBe(200_000);
  });

  it("override 生效", () => {
    const bridge = createTuiBridge({
      deps: makeDeps([]),
      inflight: createInflightRegistry(),
      contextWindow: 128_000,
    });
    expect(bridge.contextWindow).toBe(128_000);
  });
});

describe("hub-bridge postMessage lastUsage（T3）", () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "iknow-tui-bridge-usage-"));
  });
  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  it("wire 带 lastUsage → bridge.postMessage 透传；其它字段不变", async () => {
    const usage = {
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationInputTokens: 200,
      cacheReadInputTokens: 300,
    };
    const bridge = createTuiBridge({
      dataDir: baseDir,
      deps: makeDeps([assistantResult({ texts: ["你好"], usage })]),
      inflight: createInflightRegistry(),
    });
    const id = await bridge.ensureSession(undefined);
    const result = await bridge.postMessage({
      conversationId: id,
      text: "你好",
    });
    expect(result.lastUsage).toEqual(usage);
    // 既有字段不受影响。
    expect(result.finalText).toBe("你好");
    expect(result.stopReason).toBe("completed");
    expect(result.turnCount).toBe(1);
  });

  it("wire 无 lastUsage → null（等价 RunResult.lastUsage=null 语义）", async () => {
    const bridge = createTuiBridge({
      dataDir: baseDir,
      deps: makeDeps([assistantResult({ texts: ["你好"] })]),
      inflight: createInflightRegistry(),
    });
    const id = await bridge.ensureSession(undefined);
    const result = await bridge.postMessage({
      conversationId: id,
      text: "你好",
    });
    expect(result.lastUsage).toBeNull();
  });
});

describe("hub-bridge compactSession（/compact）", () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "iknow-tui-bridge-compact-"));
  });
  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  it("长会话 → compacted=true；短会话 → compacted=false（幂等）", async () => {
    // 4 个 assistant 应答 → 8 条消息 > DEFAULT_KEEP_RECENT=6 → 实际压缩。
    const bridge = createTuiBridge({
      dataDir: baseDir,
      deps: makeDeps(
        Array.from({ length: 4 }, (_, i) =>
          assistantResult({ texts: [`answer ${i}`] })
        )
      ),
      inflight: createInflightRegistry(),
    });
    const id = await bridge.ensureSession(undefined);
    for (let i = 0; i < 4; i++) {
      await bridge.postMessage({ conversationId: id, text: `q${i}` });
    }

    const compacted = await bridge.compactSession(id);
    expect(compacted).toBe(true);

    // 短会话（1 turn = 2 条）→ 无需压缩。
    const id2 = await bridge.ensureSession(undefined);
    await bridge.postMessage({ conversationId: id2, text: "hi" });
    expect(await bridge.compactSession(id2)).toBe(false);
  });

  it("missing session → 抛错（not_found 透传）", async () => {
    const bridge = createTuiBridge({
      dataDir: baseDir,
      deps: makeDeps([]),
      inflight: createInflightRegistry(),
    });
    await expect(bridge.compactSession("no-such-id")).rejects.toThrow();
  });
});
