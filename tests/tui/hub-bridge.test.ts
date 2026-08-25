/**
 * tests/tui/hub-bridge.test.ts
 *
 * #343 T6-A 测试：从 archive/tui-ink/tests/hub-bridge.test.ts 迁回 tests/tui/，
 * 改写为 bun:test（D2 裁决：tests/tui/ 由 bun:test 驱动）。
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
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createInflightRegistry,
  createTuiBridge,
} from "../../src/tui/hub-bridge.js";
import { assistantResult, makeDeps } from "../cli/_fixtures.js";
import { ValidationError } from "../../src/shared/errors.js";
import { CURRENT_SCHEMA_VERSION } from "../../src/session-api/store/schema.js";
import type { AnthropicNativeMessage } from "../../src/harness/model-adapter/types.js";
import type { SessionFileV1 } from "../../src/session-api/store/schema.js";
import { resolveProjectSessionDir } from "../../src/session-api/store/session-store.js";
import { createStubModel } from "../../src/harness/stubs/stub-model.js";
import type { LoopEngineDeps } from "../../src/harness/loop-engine.js";
import type { LoopState } from "../../src/harness/model-adapter/types.js";
import type { SubAgentManager } from "../../src/harness/subagent/manager.js";
import {
  MINIMAL_SDK_MESSAGE,
  makeTestLlmEnv,
  startLlmCapture,
  type LlmCapture,
} from "../session-api/_helpers/llm-capture.ts";

describe("inflight registry", () => {
  test("soleId：空 → undefined；单会话 → 该 id；多会话 → undefined", () => {
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

  test("ids() 返回快照副本", () => {
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

  test("启动（仅构造 bridge）不建档：池目录为空", async () => {
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

  test("ensureSession(undefined) → 建档返回 conversation_id", async () => {
    const bridge = makeBridge([]);
    const id = await bridge.ensureSession(undefined);
    expect(id).toMatch(/[0-9a-f-]{36}/);
    expect(await bridge.ensureSession(id)).toBe(id);
  });

  test("ensureSession(已建档 id) → 原样返回，不新建", async () => {
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

  test("回执投影：finalText / stopReason / turnCount；inflight 进出自清", async () => {
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
    expect(file.title).toBe("你好");
  });

  test("postMessage 失败也 unmark（异常路径不留 inflight）", async () => {
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

  test("listSessions 代理 store.list()（过滤空会话）", async () => {
    const bridge = createTuiBridge({
      dataDir: baseDir,
      deps: makeDeps([assistantResult({ texts: ["答复"] })]),
      inflight: createInflightRegistry(),
    });
    // 仅建档不发消息 → list 不可见（lazy create 双保险）
    await bridge.hub.createSession();
    expect(await bridge.listSessions()).toHaveLength(0);
    // 发一条 → 可见且带 title
    const id = await bridge.ensureSession(undefined);
    await bridge.postMessage({ conversationId: id, text: "第一个问题" });
    const list = await bridge.listSessions();
    expect(list).toHaveLength(1);
    expect(list[0]!.title).toBe("第一个问题");
  });
});

describe("hub-bridge contextWindow（T3）", () => {
  test("默认 200000（与 loop-engine compress 默认同源）", () => {
    const bridge = createTuiBridge({
      deps: makeDeps([]),
      inflight: createInflightRegistry(),
    });
    expect(bridge.contextWindow).toBe(200_000);
  });

  test("override 生效", () => {
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

  test("wire 带 lastUsage → bridge.postMessage 透传；其它字段不变", async () => {
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

  test("wire 无 lastUsage → null（等价 RunResult.lastUsage=null 语义）", async () => {
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

  test("长会话 → compacted=true；短会话 → compacted=false（幂等）", async () => {
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
    expect(compacted.compacted).toBe(true);

    // 短会话（1 turn = 2 条）→ 无需压缩。
    const id2 = await bridge.ensureSession(undefined);
    await bridge.postMessage({ conversationId: id2, text: "hi" });
    expect((await bridge.compactSession(id2)).compacted).toBe(false);
  });

  test("missing session → 抛错（not_found 透传）", async () => {
    const bridge = createTuiBridge({
      dataDir: baseDir,
      deps: makeDeps([]),
      inflight: createInflightRegistry(),
    });
    await expect(bridge.compactSession("no-such-id")).rejects.toThrow();
  });

  // #548:bridge.compactSession 把 opts.signal / opts.onStream 透传到
  // SessionHub.compactSession → runFullCompact;host 收到 lifecycle 事件序列。
  // 取消语义(返回 compacted=false, 会话保持原样)在 hub.test.ts 已覆盖。
  test("opts.signal / opts.onStream 透传到 hub(返回 boolean 不变)", async () => {
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

    const events: string[] = [];
    const compacted = await bridge.compactSession(id, {
      onStream: (e) => events.push(e.type),
    });
    expect(compacted.compacted).toBe(true);
    // stub empty_response → compaction_started + compaction_failed 序列必出。
    expect(events).toContain("compaction_started");
    expect(events).toContain("compaction_failed");
  });

  // #548:pre-aborted signal → runFullCompact 早退 signal_aborted → hub
  // 走 keep-state 路径 → bridge 返回 compacted=false(取消同形)且不落盘。
  test("pre-aborted signal → compacted=false,会话保持原样", async () => {
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

    const controller = new AbortController();
    controller.abort();
    const compacted = await bridge.compactSession(id, {
      signal: controller.signal,
    });
    expect(compacted.compacted).toBe(false);
    expect(compacted.cancelled).toBe(true);
  });
});

describe("hub-bridge continueSession（T4 /continue）", () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "iknow-tui-bridge-continue-"));
  });
  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  function pendingFile(
    id: string,
    messages: ReadonlyArray<AnthropicNativeMessage>
  ): SessionFileV1 {
    return {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      conversation_id: id,
      title: "do",
      cwd: "/tmp/proj",
      sanitized_at: new Date().toISOString(),
      messages: [...messages],
      jsonMode: false,
      turnCount: 1,
      updatedAt: new Date().toISOString(),
      checkpoints: [],
    };
  }

  test("empty session → ValidationError nothing_pending；不调 encodeUserText", async () => {
    const inner = makeDeps([assistantResult({ texts: ["should-not-run"] })]);
    let encodeCount = 0;
    const inflight = createInflightRegistry();
    const bridge = createTuiBridge({
      dataDir: baseDir,
      deps: {
        ...inner,
        adapter: {
          ...inner.adapter,
          encodeUserText: (t) => {
            encodeCount += 1;
            return inner.adapter.encodeUserText(t);
          },
        },
      },
      inflight,
    });
    const id = await bridge.ensureSession(undefined);
    let thrown: unknown;
    try {
      await bridge.continueSession(id);
    } catch (err) {
      thrown = err;
    }
    expect(thrown instanceof ValidationError).toBe(true);
    const verr = thrown as ValidationError;
    expect(verr.details?.field).toBe("continue");
    expect(verr.message).toContain("nothing_pending");
    expect(encodeCount).toBe(0);
    expect(inflight.ids().size).toBe(0);
  });

  test("P4 tool_result 尾 → skip-append；encodeUserText=0；inflight 进出；同一 conversationId", async () => {
    const inner = makeDeps([assistantResult({ texts: ["continued"] })]);
    let encodeCount = 0;
    const inflight = createInflightRegistry();
    const bridge = createTuiBridge({
      dataDir: baseDir,
      deps: {
        ...inner,
        adapter: {
          ...inner.adapter,
          encodeUserText: (t) => {
            encodeCount += 1;
            return inner.adapter.encodeUserText(t);
          },
        },
      },
      inflight,
    });
    const id = await bridge.ensureSession(undefined);
    await bridge.store.save({
      id,
      file: pendingFile(id, [
        { role: "user", content: [{ type: "text", text: "do" }] },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "t1", name: "noop", input: {} }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
        },
      ]),
    });
    const result = await bridge.continueSession(id);
    expect(result.conversationId).toBe(id);
    expect(result.finalText).toBe("continued");
    expect(result.stopReason).toBe("completed");
    expect(encodeCount).toBe(0);
    expect(inflight.ids().size).toBe(0);
  });
});

describe("hub-bridge subagentManager 透传（#365 T3）", () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "iknow-tui-bridge-sub-"));
  });
  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  test("独立参数注入 → hub 经 host-drain 消费该 manager（drain 结果拼入 run priorMessages）", async () => {
    // #365 T3：subagentManager 是独立参数（不再经 deps.subagentManager 透传）。
    // 验证：hub 内部持有所注入 manager，postMessage 时经 drainPendingSubagents
    // 消费。手法：hand-rolled fake manager（drainCompleted 返回 1 条 completed）+
    // 捕获 adapter 断言 stub-model 第一 turn 收到的 state.messages 含浓缩段。
    // manager 未被 hub 持有 → drain 走 undefined 路径 → 无注入 → 断言失败。
    const fakeMgr: SubAgentManager = {
      spawn: () => ({ taskId: "t3-task" }),
      queryBuffer: () => ({ status: "not_found" }),
      waitFor: () => Promise.reject(new Error("not used")),
      shutdown: () => Promise.resolve(),
      abortTask: () => false,
      listActive: () => [],
      drainCompleted: () => [
        {
          taskId: "t3-task",
          envelope: {
            status: "ok",
            summary: "t3 fake subagent",
            result: "t3 body",
          },
        },
      ],
      // #358 T7: 接口新增只读枚举面 —— fake 补全保持结构兼容。
      listSubagents: () => [],
    };

    const seen: LoopState[] = [];
    const innerStub = createStubModel({
      responses: [assistantResult({ texts: ["final after drain"] })],
    });
    const capAdapter: LoopEngineDeps["adapter"] = {
      encodeUserText: (t) => innerStub.encodeUserText(t),
      encodeToolResults: (r) => innerStub.encodeToolResults(r),
      step: async (state, request, signal) => {
        seen.push(state);
        return innerStub.step(state, request, signal);
      },
    };

    const bridge = createTuiBridge({
      dataDir: baseDir,
      deps: { ...makeDeps([]), adapter: capAdapter },
      inflight: createInflightRegistry(),
      subagentManager: fakeMgr,
    });
    const id = await bridge.ensureSession(undefined);
    await bridge.postMessage({ conversationId: id, text: "继续" });

    const firstStep = seen[0];
    expect(firstStep).toBeDefined();
    const joined = firstStep.messages
      .map((m) =>
        m.content
          .filter((b): b is { type: "text"; text: string } => b.type === "text")
          .map((b) => b.text)
          .join(" ")
      )
      .join("\n");
    expect(joined).toContain("## Sub-agent t3-task result: t3 fake subagent");
    expect(joined).toContain("t3 body");
  });
});

describe("hub-bridge postMessage thinking 透传（T2）", () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "iknow-tui-bridge-thinking-"));
  });
  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  // 共享的 local HTTP capture server：站在 LLM endpoint 位，记录 SDK 实际
  // 发出的请求体。withThinkingOverride 用 real adapter（经 overrideEnv 指向
  // capture origin），故可断言 wire 上的 thinking / output_config 字段 ——
  // 这比 stub-model 路径强：bridge 剥掉 thinking 字段会直接在此暴露
  // （request 无 thinking，或者根本走不到 capture（fallback 抛错））。
  let capture: LlmCapture | undefined;

  afterEach(async () => {
    if (capture) {
      await capture.close();
      capture = undefined;
    }
  });

  test("thinking: { mode: 'adaptive', effort: 'high' } → wire 请求带 thinking + output_config", async () => {
    capture = await startLlmCapture(MINIMAL_SDK_MESSAGE);
    const inflight = createInflightRegistry();
    const bridge = createTuiBridge({
      dataDir: baseDir,
      deps: makeDeps([]),
      inflight,
      // overrideEnv 与 run.tsx 同款透传：override 重建 adapter 时使用该 env，
      // 不回退 process.env（reviewer blocker）。测试用它把 baseUrl 钉到 capture。
      overrideEnv: makeTestLlmEnv({ baseUrl: capture.origin }),
    });
    const id = await bridge.ensureSession(undefined);
    const result = await bridge.postMessage({
      conversationId: id,
      text: "think hard",
      thinking: { mode: "adaptive", effort: "high" },
    });
    // 请求确实发出且只发了一次，wire 字段由 hub 原样转发。
    expect(capture.bodies.length).toBe(1);
    const body = capture.bodies[0] as Record<string, unknown>;
    expect(body.thinking).toEqual({ type: "adaptive" });
    expect(body.output_config).toEqual({ effort: "high" });
    // 回执正常投影；inflight 进出自清。
    expect(result.finalText).toBe("ok");
    expect(result.stopReason).toBe("completed");
    expect(inflight.ids().size).toBe(0);
  });

  test("thinking: { mode: 'off' } → wire 请求无 thinking / output_config 字段", async () => {
    capture = await startLlmCapture(MINIMAL_SDK_MESSAGE);
    const inflight = createInflightRegistry();
    const bridge = createTuiBridge({
      dataDir: baseDir,
      deps: makeDeps([]),
      inflight,
      overrideEnv: makeTestLlmEnv({ baseUrl: capture.origin }),
    });
    const id = await bridge.ensureSession(undefined);
    const result = await bridge.postMessage({
      conversationId: id,
      text: "no thinking",
      thinking: { mode: "off" },
    });
    expect(capture.bodies.length).toBe(1);
    const body = capture.bodies[0] as Record<string, unknown>;
    expect("thinking" in body).toBe(false);
    expect("output_config" in body).toBe(false);
    expect(result.finalText).toBe("ok");
    expect(inflight.ids().size).toBe(0);
  });

  test("不传 thinking → cached stub deps 路径，不发 LLM 请求（capture 零请求）", async () => {
    capture = await startLlmCapture(MINIMAL_SDK_MESSAGE);
    const bridge = createTuiBridge({
      dataDir: baseDir,
      deps: makeDeps([assistantResult({ texts: ["cached reply"] })]),
      inflight: createInflightRegistry(),
      overrideEnv: makeTestLlmEnv({ baseUrl: capture.origin }),
    });
    const id = await bridge.ensureSession(undefined);
    const result = await bridge.postMessage({
      conversationId: id,
      text: "no override",
    });
    // cached path 走 stub adapter → 请求不该打到 capture server。
    expect(result.finalText).toBe("cached reply");
    expect(capture.bodies.length).toBe(0);
  });
});

describe("hub-bridge overrideEnv 透传（T2）", () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "iknow-tui-bridge-overrideenv-"));
  });
  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  test("bridge 把 overrideEnv 透给 hub（capture server 收到请求 = env 生效）", async () => {
    const cap = await startLlmCapture(MINIMAL_SDK_MESSAGE);
    try {
      const bridge = createTuiBridge({
        dataDir: baseDir,
        deps: makeDeps([]),
        inflight: createInflightRegistry(),
        // baseUrl 钉到 capture：透传生效 → hub 的 override 路径连上 capture。
        overrideEnv: makeTestLlmEnv({ baseUrl: cap.origin }),
      });
      const id = await bridge.ensureSession(undefined);
      await bridge.postMessage({
        conversationId: id,
        text: "override env",
        thinking: { mode: "off" },
      });
      // 若 overrideEnv 未透传，withThinkingOverride 回退 loadIknowEnv() → 走
      // 真实 endpoint（非 capture）或抛 ValidationError → capture 收不到请求。
      expect(cap.bodies.length).toBe(1);
    } finally {
      await cap.close();
    }
  });

  test("不传 overrideEnv → 无 override 字段注入，既有路径行为不变", async () => {
    const inflight = createInflightRegistry();
    const bridge = createTuiBridge({
      dataDir: baseDir,
      deps: makeDeps([assistantResult({ texts: ["cached"] })]),
      inflight,
    });
    const id = await bridge.ensureSession(undefined);
    const result = await bridge.postMessage({
      conversationId: id,
      text: "plain",
    });
    expect(result.finalText).toBe("cached");
    expect(inflight.ids().size).toBe(0);
  });
});
// -- settings-hot-reload（T4）:envProvider + onEnvChange 接通 ---------------------------------

describe("hub-bridge envProvider / onEnvChange 透传（T4）", () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "iknow-tui-bridge-envprovider-"));
  });
  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  test("bridge 把 envProvider 透给 hub：reloadFromEnv 用 envProvider() 重建 adapter", async () => {
    const cap = await startLlmCapture(MINIMAL_SDK_MESSAGE);
    try {
      let currentModel = "model-t4-1";
      const bridge = createTuiBridge({
        dataDir: baseDir,
        // deps 必须注入（SessionHub 构造守卫：无 askUser 时必须有 deps）；
        // 首次 postMessage 用注入 stub（不联网），reloadFromEnv 后才走 envProvider
        // 重建真实 adapter —— 这正是 T4 热更新的最小面通路。
        deps: makeDeps([]),
        inflight: createInflightRegistry(),
        envProvider: () =>
          ({
            llm: makeTestLlmEnv({
              baseUrl: cap.origin,
              model: currentModel,
              apiKey: "test-key",
            }).llm,
          }) as import("../../src/config/env.js").IknowEnv,
        onEnvChange: () => {},
      });
      const id = await bridge.ensureSession(undefined);
      // reloadFromEnv 先用当前 envProvider 建 adapter（model-t4-1）→ capture。
      await bridge.hub.reloadFromEnv();
      await bridge.postMessage({ conversationId: id, text: "hi" });
      expect(cap.bodies.length).toBe(1);
      // 改 model → reloadFromEnv → 下次 postMessage wire model 变化。
      currentModel = "model-t4-2";
      await bridge.hub.reloadFromEnv();
      await bridge.postMessage({ conversationId: id, text: "hi again" });
      expect(cap.bodies.length).toBe(2);
      const models = cap.bodies.map((b) => (b as { model?: string }).model);
      expect(models[0]).toBe("model-t4-1");
      expect(models[1]).toBe("model-t4-2");
    } finally {
      await cap.close();
    }
  });

  test("bridge 把 onEnvChange 透给 hub：reloadFromEnv 成功后触发一次", async () => {
    const cap = await startLlmCapture(MINIMAL_SDK_MESSAGE);
    try {
      let currentModel = "model-t4-a";
      const received: string[] = [];
      const bridge = createTuiBridge({
        dataDir: baseDir,
        deps: makeDeps([]),
        inflight: createInflightRegistry(),
        envProvider: () =>
          ({
            llm: makeTestLlmEnv({
              baseUrl: cap.origin,
              model: currentModel,
              apiKey: "test-key",
            }).llm,
          }) as import("../../src/config/env.js").IknowEnv,
        onEnvChange: (env) => received.push(env.llm.model),
      });
      currentModel = "model-t4-b";
      await bridge.hub.reloadFromEnv();
      expect(received).toEqual(["model-t4-b"]);
    } finally {
      await cap.close();
    }
  });
});

// -- listSubagents 投影（#358 T7）----------------------------------------------------

describe("hub-bridge listSubagents 投影（#358 T7）", () => {
  test("无 subagentManager → listSubagents 恒返回空数组", () => {
    const bridge = createTuiBridge({
      deps: makeDeps([]),
      inflight: createInflightRegistry(),
    });
    // 多次调用稳定空 — 不依赖 hub 内部状态。
    expect(bridge.listSubagents()).toEqual([]);
    expect(bridge.listSubagents()).toEqual([]);
  });

  test("注入 fake manager → listSubagents 透传 manager.listSubagents() 投影", () => {
    // 与 hub-bridge subagentManager 透传 describe 同款 fake 模式(hand-rolled
    // SubAgentManager,字段齐 interface)。验证:bridge.listSubagents() ==
    // manager.listSubagents() (byte-stable)。
    const projection = [
      {
        taskId: "t-r",
        state: "running" as const,
        taskPreview: "查找",
        startedAt: new Date().toISOString(),
      },
      {
        taskId: "t-d",
        state: "completed" as const,
        taskPreview: "完成",
        startedAt: new Date(Date.now() - 5000).toISOString(),
        endedAt: new Date().toISOString(),
        summary: "done",
      },
    ];
    const fakeMgr: SubAgentManager = {
      spawn: () => ({ taskId: "x" }),
      queryBuffer: () => ({ status: "not_found" }),
      waitFor: () => Promise.reject(new Error("not used")),
      shutdown: () => Promise.resolve(),
      abortTask: () => false,
      listActive: () => [],
      drainCompleted: () => [],
      listSubagents: () => projection,
    };
    const bridge = createTuiBridge({
      deps: makeDeps([]),
      inflight: createInflightRegistry(),
      subagentManager: fakeMgr,
    });
    expect(bridge.listSubagents()).toBe(projection);
  });
});
