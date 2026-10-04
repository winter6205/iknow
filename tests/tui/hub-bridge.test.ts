/**
 * tests/tui/hub-bridge.test.ts (bun:test)
 *
 * hub-bridge (direct hub wiring):
 *  - lazy create: no session file before the first message; ensureSession(undefined)
 *    creates one, ensureSession(id) returns it unchanged; start-then-quit leaves no
 *    empty shell;
 *  - in-flight registry: soleId attribution semantics (0/1/N); postMessage marks on
 *    entry and unmarks even on the failure path;
 *  - postMessage receipt projection (finalText / stopReason / turnCount);
 *  - context usage: bridge.contextWindow defaults to the strategy budget-window
 *    SSOT (`DEFAULT_STRATEGY_CONTEXT_WINDOW`), overridable; postMessage passes
 *    lastUsage through (wire has it → state has it; wire lacks it → null).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createInflightRegistry,
  createTuiBridge,
} from "../../src/tui/hub-bridge.js";
import { DEFAULT_STRATEGY_CONTEXT_WINDOW } from "../../src/config/env.js";
import { assistantResult, makeDeps } from "../cli/_fixtures.js";
import { ValidationError } from "../../src/shared/errors.js";
import {
  CURRENT_SCHEMA_VERSION,
  NATIVE_STATE_FORMAT_VERSION,
  resolveSubagentTraceDir,
  SessionStore,
} from "../../src/session-api/store/index.js";
import { deriveProjectIdentityRoot } from "../../src/harness/session-roots.js";
import { writeWorkerIdentityRecord } from "../../src/harness/subagent/worker-identity-record.js";
import type { AnthropicNativeMessage } from "../../src/harness/model-adapter/types.js";
import type { SessionFileV1 } from "../../src/session-api/store/schema.js";
import { resolveProjectSessionDir } from "../../src/session-api/store/session-store.js";
import { createStubModel } from "../../src/harness/stubs/stub-model.js";
import type { LoopEngineDeps } from "../../src/harness/loop-engine.js";
import type { LoopState } from "../../src/harness/model-adapter/types.js";
import type { SubAgentManager } from "../../src/harness/subagent/manager.js";
import type { SubAgentTerminalNotice } from "../../src/harness/subagent/mailbox.js";
import { createSubAgentMailbox } from "../../src/harness/subagent/mailbox.js";
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
      workspaceRoot: baseDir,
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
      entries = []; // directory absent = nothing was stored
    }
    expect(entries).toHaveLength(0);
  });

  test("ensureSession(undefined) → 建档返回 conversation_id", async () => {
    const bridge = makeBridge([]);
    const id = await bridge.ensureSession(undefined);
    expect(id).toMatch(/[0-9a-f-]{36}/);
    expect(await bridge.ensureSession(id)).toBe(id);
  });

  test("ensureSession(undefined) persists the bridge workspaceRoot", async () => {
    const bridge = createTuiBridge({
      dataDir: baseDir,
      workspaceRoot: baseDir,
      deps: makeDeps([]),
      inflight: createInflightRegistry(),
    });

    const id = await bridge.ensureSession(undefined);
    const file = await bridge.loadSessionFile(id);
    expect(file.workspaceRoot).toBe(baseDir);
    expect(file.cwd).toBe(baseDir);
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
      workspaceRoot: baseDir,
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
    expect(inflight.ids().size).toBe(0); // cleared after completion
    // persisted and readable back (shared-pool discipline)
    const file = await bridge.loadSessionFile(id);
    expect(file.turnCount).toBe(1);
    expect(file.title).toBe("你好");
  });

  test("postMessage 失败也 unmark（异常路径不留 inflight）", async () => {
    const inflight = createInflightRegistry();
    const bridge = createTuiBridge({
      dataDir: baseDir,
      workspaceRoot: baseDir,
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
      workspaceRoot: baseDir,
      deps: makeDeps([assistantResult({ texts: ["答复"] })]),
      inflight: createInflightRegistry(),
    });
    // created but no message sent → invisible in list (second layer of lazy create)
    await bridge.hub.createSession();
    expect(await bridge.listSessions()).toHaveLength(0);
    // one message sent → visible, with title
    const id = await bridge.ensureSession(undefined);
    await bridge.postMessage({ conversationId: id, text: "第一个问题" });
    const list = await bridge.listSessions();
    expect(list).toHaveLength(1);
    expect(list[0]!.title).toBe("第一个问题");
  });
});

describe("hub-bridge contextWindow（T3）", () => {
  test("默认与策略预算窗口 SSOT 同源（不从本测重新钉数字）", () => {
    const bridge = createTuiBridge({
      deps: makeDeps([]),
      inflight: createInflightRegistry(),
    });
    expect(bridge.contextWindow).toBe(DEFAULT_STRATEGY_CONTEXT_WINDOW);
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
      workspaceRoot: baseDir,
      deps: makeDeps([assistantResult({ texts: ["你好"], usage })]),
      inflight: createInflightRegistry(),
    });
    const id = await bridge.ensureSession(undefined);
    const result = await bridge.postMessage({
      conversationId: id,
      text: "你好",
    });
    expect(result.lastUsage).toEqual(usage);
    // Pre-existing fields unaffected.
    expect(result.finalText).toBe("你好");
    expect(result.stopReason).toBe("completed");
    expect(result.turnCount).toBe(1);
  });

  test("wire 无 lastUsage → null（等价 RunResult.lastUsage=null 语义）", async () => {
    const bridge = createTuiBridge({
      dataDir: baseDir,
      workspaceRoot: baseDir,
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
    // 4 assistant replies → 8 messages > DEFAULT_KEEP_RECENT=6 → real compaction.
    const bridge = createTuiBridge({
      dataDir: baseDir,
      workspaceRoot: baseDir,
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

    // Short session (1 turn = 2 messages) → nothing to compact.
    const id2 = await bridge.ensureSession(undefined);
    await bridge.postMessage({ conversationId: id2, text: "hi" });
    expect((await bridge.compactSession(id2)).compacted).toBe(false);
  });

  test("missing session → 抛错（not_found 透传）", async () => {
    const bridge = createTuiBridge({
      dataDir: baseDir,
      workspaceRoot: baseDir,
      deps: makeDeps([]),
      inflight: createInflightRegistry(),
    });
    await expect(bridge.compactSession("no-such-id")).rejects.toThrow();
  });

  // bridge.compactSession passes opts.signal / opts.onStream through to
  // SessionHub.compactSession → runFullCompact; the host receives the lifecycle
  // event sequence. Cancellation semantics (returns compacted=false, session
  // untouched) are already covered in hub.test.ts.
  test("opts.signal / opts.onStream 透传到 hub(返回 boolean 不变)", async () => {
    const bridge = createTuiBridge({
      dataDir: baseDir,
      workspaceRoot: baseDir,
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
    // stub empty_response → the compaction_started + compaction_failed sequence must appear.
    expect(events).toContain("compaction_started");
    expect(events).toContain("compaction_failed");
  });

  // A pre-aborted signal → runFullCompact exits early with signal_aborted → hub
  // takes the keep-state path → bridge returns compacted=false (same shape as
  // cancellation) and writes nothing to disk.
  test("pre-aborted signal → compacted=false,会话保持原样", async () => {
    const bridge = createTuiBridge({
      dataDir: baseDir,
      workspaceRoot: baseDir,
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
      cwd: baseDir,
      sanitized_at: new Date().toISOString(),
      messages: [...messages],
      jsonMode: false,
      turnCount: 1,
      updatedAt: new Date().toISOString(),
      checkpoints: [],
      workspaceRoot: baseDir,
    };
  }

  test("empty session → ValidationError nothing_pending；不调 encodeUserText", async () => {
    const inner = makeDeps([assistantResult({ texts: ["should-not-run"] })]);
    let encodeCount = 0;
    const inflight = createInflightRegistry();
    const bridge = createTuiBridge({
      dataDir: baseDir,
      workspaceRoot: baseDir,
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
      workspaceRoot: baseDir,
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
    // subagentManager is a standalone parameter (no longer passed via deps.subagentManager).
    // Verified: the hub internally holds the injected manager and consumes it during
    // postMessage via drainPendingSubagents. Technique: hand-rolled fake manager
    // (drainCompleted returns 1 completed entry) + capturing adapter to assert the
    // condensed section appears in state.messages received by stub-model's first turn.
    // If the hub did not hold the manager → drain takes the undefined path → no
    // injection → the assertion fails.
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
      // Interface gained read-only enumeration surfaces — fake completes them to stay structurally compatible.
      getCapacity: () => 15,
      listSubagents: () => [],
      subscribe: () => () => {},
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
      workspaceRoot: baseDir,
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
    expect(joined).toContain("t3 fake subagent");
  });

  test("terminal wake runs silently and does not create typed input history", async () => {
    let completed: ReadonlyArray<{
      readonly taskId: string;
      readonly envelope: {
        readonly status: "ok";
        readonly summary: string;
        readonly result: string;
      };
    }> = [];
    let subscriber: ((notice: SubAgentTerminalNotice) => void) | undefined;
    const manager = {
      spawn: () => ({ taskId: "wake-task" }),
      queryBuffer: () => ({ status: "not_found" as const }),
      waitFor: async () => {
        throw new Error("unused");
      },
      shutdown: async () => {},
      drainCompleted: () => completed,
      listActive: () => [],
      abortTask: () => false,
      listSubagents: () => [],
      subscribe: (listener: (notice: SubAgentTerminalNotice) => void) => {
        subscriber = listener;
        return () => {
          subscriber = undefined;
        };
      },
      getCapacity: () => 15,
    } as SubAgentManager;
    const bridge = createTuiBridge({
      dataDir: baseDir,
      workspaceRoot: baseDir,
      deps: makeDeps([assistantResult({ texts: ["woken"] })]),
      inflight: createInflightRegistry(),
      subagentManager: manager,
    });
    const id = await bridge.ensureSession(undefined);
    completed = [
      {
        taskId: "wake-task",
        envelope: {
          status: "ok",
          summary: "done",
          result: "result",
        },
      },
    ];
    subscriber?.({
      taskId: "wake-task",
      status: "ok",
      summary: "done",
      result: "result",
    });

    const result = await bridge.wakeFromSubagent(id);

    expect(result?.finalText).toBe("woken");
    const file = await bridge.loadSessionFile(id);
    const drain = file.messages.find((message) =>
      message.content.some(
        (block) =>
          block.type === "text" &&
          block.text.startsWith("## Sub-agent wake-task result:")
      )
    );
    expect(drain).toBeDefined();
    expect(
      file.messages
        .filter((message) => message.role === "user")
        .some((message) =>
          message.content.some(
            (block) => block.type === "text" && block.text === "woken"
          )
        )
    ).toBe(false);
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

  // Shared local HTTP capture server: sits in the LLM endpoint position and
  // records the request bodies the SDK actually sends. withThinkingOverride uses
  // the real adapter (via overrideEnv pointing at the capture origin), so the
  // wire's thinking / output_config fields are assertable — stronger than the
  // stub-model path: the bridge stripping thinking fields surfaces right here
  // (request lacks thinking, or capture is never reached at all, e.g. fallback throws).
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
      workspaceRoot: baseDir,
      deps: makeDeps([]),
      inflight,
      // overrideEnv passes through exactly as in run.tsx: the override rebuilds
      // the adapter with this env and never falls back to process.env. Tests use
      // it to pin baseUrl at the capture server.
      overrideEnv: makeTestLlmEnv({ baseUrl: capture.origin }),
    });
    const id = await bridge.ensureSession(undefined);
    const result = await bridge.postMessage({
      conversationId: id,
      text: "think hard",
      thinking: { mode: "adaptive", effort: "high" },
    });
    // The request really went out, exactly once; wire fields forwarded verbatim by the hub.
    expect(capture.bodies.length).toBe(1);
    const body = capture.bodies[0] as Record<string, unknown>;
    expect(body.thinking).toEqual({ type: "adaptive" });
    expect(body.output_config).toEqual({ effort: "high" });
    // Receipt projects normally; inflight marks/unmarks cleanly.
    expect(result.finalText).toBe("ok");
    expect(result.stopReason).toBe("completed");
    expect(inflight.ids().size).toBe(0);
  });

  test("thinking: { mode: 'off' } → wire 请求无 thinking / output_config 字段", async () => {
    capture = await startLlmCapture(MINIMAL_SDK_MESSAGE);
    const inflight = createInflightRegistry();
    const bridge = createTuiBridge({
      dataDir: baseDir,
      workspaceRoot: baseDir,
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
      workspaceRoot: baseDir,
      deps: makeDeps([assistantResult({ texts: ["cached reply"] })]),
      inflight: createInflightRegistry(),
      overrideEnv: makeTestLlmEnv({ baseUrl: capture.origin }),
    });
    const id = await bridge.ensureSession(undefined);
    const result = await bridge.postMessage({
      conversationId: id,
      text: "no override",
    });
    // Cached path uses the stub adapter → requests must not reach the capture server.
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
        workspaceRoot: baseDir,
        deps: makeDeps([]),
        inflight: createInflightRegistry(),
        // baseUrl pinned at the capture server: pass-through works → the hub's override path connects to capture.
        overrideEnv: makeTestLlmEnv({ baseUrl: cap.origin }),
      });
      const id = await bridge.ensureSession(undefined);
      await bridge.postMessage({
        conversationId: id,
        text: "override env",
        thinking: { mode: "off" },
      });
      // If overrideEnv were not passed through, withThinkingOverride would fall
      // back to loadIknowEnv() → hit the real endpoint (not capture) or throw
      // ValidationError → capture would receive no request.
      expect(cap.bodies.length).toBe(1);
    } finally {
      await cap.close();
    }
  });

  test("不传 overrideEnv → 无 override 字段注入，既有路径行为不变", async () => {
    const inflight = createInflightRegistry();
    const bridge = createTuiBridge({
      dataDir: baseDir,
      workspaceRoot: baseDir,
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
// -- settings-hot-reload: envProvider + onEnvChange wiring ---------------------------------

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
        workspaceRoot: baseDir,
        // deps must be injected (SessionHub construction guard: deps required
        // when askUser is absent); the first postMessage uses the injected stub
        // (no network), and only after reloadFromEnv does the envProvider-rebuilt
        // real adapter take over — exactly the minimal hot-reload surface.
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
      // reloadFromEnv first builds the adapter from the current envProvider (model-t4-1) → capture.
      await bridge.hub.reloadFromEnv();
      await bridge.postMessage({ conversationId: id, text: "hi" });
      expect(cap.bodies.length).toBe(1);
      // Change model → reloadFromEnv → the next postMessage carries a different wire model.
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
        workspaceRoot: baseDir,
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

// -- listSubagents projection ----------------------------------------------------

describe("hub-bridge listSubagents 投影（#358 T7）", () => {
  test("无 subagentManager → listSubagents 恒返回空数组", () => {
    const bridge = createTuiBridge({
      deps: makeDeps([]),
      inflight: createInflightRegistry(),
    });
    // Stable empty across calls — independent of hub internal state.
    expect(bridge.listSubagents()).toEqual([]);
    expect(bridge.listSubagents()).toEqual([]);
  });

  test("注入 fake manager → listSubagents 透传 manager.listSubagents() 投影", () => {
    // Same hand-rolled fake-SubAgentManager pattern (all interface fields) as the
    // subagentManager pass-through describe above. Verifies:
    // bridge.listSubagents() == manager.listSubagents() (byte-stable).
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
      getCapacity: () => 15,
      waitFor: () => Promise.reject(new Error("not used")),
      shutdown: () => Promise.resolve(),
      abortTask: () => false,
      listActive: () => [],
      drainCompleted: () => [],
      listSubagents: () => projection,
      subscribe: () => () => {},
    };
    const bridge = createTuiBridge({
      deps: makeDeps([]),
      inflight: createInflightRegistry(),
      subagentManager: fakeMgr,
    });
    expect(bridge.listSubagents()).toBe(projection);
  });

  test("list 与 terminal subscription 都按 parent conversationId 过滤", () => {
    const mailbox = createSubAgentMailbox();
    const sessionATask = {
      taskId: "session-a-task",
      state: "completed" as const,
      taskPreview: "A",
      startedAt: "2026-08-31T00:00:00.000Z",
    };
    const sessionBTask = {
      taskId: "session-b-task",
      state: "completed" as const,
      taskPreview: "B",
      startedAt: "2026-08-31T00:00:00.000Z",
    };
    const manager: SubAgentManager = {
      spawn: () => ({ taskId: "unused" }),
      queryBuffer: () => ({ status: "not_found" }),
      getCapacity: () => 15,
      waitFor: async () => {
        throw new Error("unused");
      },
      shutdown: async () => {},
      drainCompleted: () => [],
      listActive: () => [],
      abortTask: () => false,
      listSubagents: (conversationId) =>
        conversationId === "session-a"
          ? [sessionATask]
          : [sessionATask, sessionBTask],
      subscribe: mailbox.subscribe,
    };
    const bridge = createTuiBridge({
      deps: makeDeps([]),
      inflight: createInflightRegistry(),
      subagentManager: manager,
    });
    const notices: string[] = [];
    const unsubscribe = bridge.subscribeSubagentTerminal(
      (notice) => notices.push(notice.taskId),
      "session-a"
    );

    expect(bridge.listSubagents("session-a")).toEqual([sessionATask]);
    mailbox.publish({
      taskId: "session-a-task",
      conversationId: "session-a",
      status: "ok",
      summary: "done",
      result: "result",
    });
    mailbox.publish({
      taskId: "session-b-task",
      conversationId: "session-b",
      status: "ok",
      summary: "done",
      result: "result",
    });

    expect(notices).toEqual(["session-a-task"]);
    unsubscribe();
  });
});

// ---------------------------------------------------------------------------
// engineRoot + buildEngine forwarding — after a rebind, per-turn engine
// rebuild takes effect on the deps-injected host (TUI)
// ---------------------------------------------------------------------------

describe("hub-bridge engineRoot / buildEngine 转发（review High-1）", () => {
  function ensure(
    hub: ReturnType<typeof createTuiBridge>["hub"],
    root?: string
  ): Promise<LoopEngineDeps> {
    return (
      hub as unknown as {
        ensureDeps: (root?: string) => Promise<LoopEngineDeps>;
      }
    ).ensureDeps.bind(hub)(root);
  }

  test("注入 deps + engineRoot：启动根返回注入 deps；rebind 根走 buildEngine 缝", async () => {
    const injected = makeDeps([assistantResult({ texts: ["injected"] })]);
    const rebuilt = makeDeps([assistantResult({ texts: ["rebuilt"] })]);
    const builtAt: string[] = [];
    const bridge = createTuiBridge({
      deps: injected,
      inflight: createInflightRegistry(),
      engineRoot: "/main",
      buildEngine: async (root) => {
        builtAt.push(root);
        return { deps: rebuilt };
      },
    });

    // Startup root: injected deps returned as-is (today's behavior unchanged)
    expect(await ensure(bridge.hub, "/main")).toBe(injected);
    expect(builtAt).toEqual([]);

    // Root of a rebound task worktree: per-root rebuild via the buildEngine seam
    const reboundRoot = "/main/.iknow/worktrees/conv-1";
    expect(await ensure(bridge.hub, reboundRoot)).toBe(rebuilt);
    expect(builtAt).toEqual([reboundRoot]);
  });

  test("未传 engineRoot：注入分支保持今日短路语义（不重建）", async () => {
    const injected = makeDeps([assistantResult({ texts: ["injected"] })]);
    let built = 0;
    const bridge = createTuiBridge({
      deps: injected,
      inflight: createInflightRegistry(),
      buildEngine: async (root) => {
        built += 1;
        return { deps: injected, builtAt: root };
      },
    });
    expect(await ensure(bridge.hub, "/anywhere/.iknow/worktrees/conv-2")).toBe(
      injected
    );
    expect(built).toBe(0);
  });
});

describe("hub-bridge subagent manager aggregation across rebind", () => {
  function makeRebindManager(label: string): {
    readonly manager: SubAgentManager;
    readonly publish: () => void;
  } {
    const mailbox = createSubAgentMailbox();
    const manager: SubAgentManager = {
      spawn: () => ({ taskId: `${label}-spawned` }),
      queryBuffer: () => ({ status: "not_found" }),
      getCapacity: () => 15,
      waitFor: async () => {
        throw new Error("unused");
      },
      shutdown: async () => {},
      drainCompleted: () => [],
      listActive: () => [],
      abortTask: () => false,
      listSubagents: () => [
        {
          taskId: `${label}-task`,
          state: "running",
          taskPreview: label,
          startedAt: "2026-08-31T00:00:00.000Z",
        },
      ],
      subscribe: mailbox.subscribe,
    };
    return {
      manager,
      publish: () =>
        mailbox.publish({
          taskId: `${label}-task`,
          status: "ok",
          summary: "done",
          result: "result",
        }),
    };
  }

  test("uses the aggregate subscription and list projection after a rebind", async () => {
    const oldManager = makeRebindManager("before");
    const newManager = makeRebindManager("after");
    const bridge = createTuiBridge({
      deps: makeDeps([]),
      inflight: createInflightRegistry(),
      engineRoot: "/main",
      subagentManager: oldManager.manager,
      buildEngine: async () => ({
        deps: makeDeps([]),
        subagentManager: newManager.manager,
      }),
    });
    const notices: string[] = [];
    const unsubscribe = bridge.subscribeSubagentTerminal((notice) => {
      notices.push(notice.taskId);
    });

    const reboundRoot = "/main/.iknow/worktrees/rebound";
    await (
      bridge.hub as unknown as {
        ensureDeps: (root?: string) => Promise<LoopEngineDeps>;
      }
    ).ensureDeps(reboundRoot);
    newManager.publish();

    expect(notices).toEqual(["after-task"]);
    expect(bridge.listSubagents().map(({ taskId }) => taskId)).toEqual([
      "before-task",
      "after-task",
    ]);
    unsubscribe();
  });
});

// -- abortSessionForegroundWork fan-out (this session's foreground only) --------------------

describe("hub-bridge abortSessionForegroundWork（本会话前景扇出）", () => {
  test("无 subagentManager → 空数组（不抛错）", () => {
    const bridge = createTuiBridge({
      deps: makeDeps([]),
      inflight: createInflightRegistry(),
    });
    expect(bridge.abortSessionForegroundWork("conv-a")).toEqual([]);
  });

  test("透传 hub：只 abort 本会话 live 前景行，后景 / 其它会话不动", () => {
    const rows = [
      {
        taskId: "fg",
        state: "running" as const,
        taskPreview: "前景",
        startedAt: "2026-09-17T00:00:00.000Z",
        conversationId: "conv-a",
        foreground: true,
      },
      {
        taskId: "bg",
        state: "running" as const,
        taskPreview: "后景",
        startedAt: "2026-09-17T00:00:00.000Z",
        conversationId: "conv-a",
      },
      {
        taskId: "other-session",
        state: "running" as const,
        taskPreview: "别的会话",
        startedAt: "2026-09-17T00:00:00.000Z",
        conversationId: "conv-b",
        foreground: true,
      },
    ];
    const killed: string[] = [];
    const manager: SubAgentManager = {
      spawn: () => ({ taskId: "unused" }),
      queryBuffer: () => ({ status: "not_found" }),
      getCapacity: () => 15,
      waitFor: async () => {
        throw new Error("unused");
      },
      shutdown: async () => {},
      drainCompleted: () => [],
      listActive: () => [],
      abortTask: (taskId) => {
        killed.push(taskId);
        return true;
      },
      listSubagents: (conversationId) =>
        conversationId === undefined
          ? rows
          : rows.filter((row) => row.conversationId === conversationId),
      subscribe: () => () => {},
    };
    const bridge = createTuiBridge({
      deps: makeDeps([]),
      inflight: createInflightRegistry(),
      subagentManager: manager,
    });

    expect(bridge.abortSessionForegroundWork("conv-a")).toEqual(["fg"]);
    expect(killed).toEqual(["fg"]);
  });
});

/**
 * F5 of issue #1182's repair round: the TUI entry surface called
 * `openSessionWithRecovery` with no `sweepOwnedWorkers`, so `workerSweep` was
 * undefined on every TUI reopen and no unprovable stop was ever reported. The
 * field is now REQUIRED on the shared contract, so the omission is a compile
 * error; what these cases pin is that the sweep the bridge passes is really the
 * session's own and really runs BEFORE the report.
 */
describe("hub-bridge openSession 扫本会话 worker（ADR-0136 §4 / SC16-17）", () => {
  let baseDir: string;

  const deadPid = (): number => {
    // A pid that has already exited: the sweep's own probe confirms the stop,
    // so the worker it accounts for needs no handling.
    const gone = spawnSync("sh", ["-c", "exit 0"], { encoding: "utf8" });
    if (gone.pid === undefined) throw new Error("no pid to record");
    return gone.pid;
  };

  /** A session with a published state and one recorded worker fact, plus (unless
   *  `record` is absent) a real identity record for that worker under the
   *  sweep's own root. */
  async function seedWorker(
    id: string,
    record?: { readonly pid: number; readonly starttime: number }
  ): Promise<SessionStore> {
    const projectIdentityRoot = deriveProjectIdentityRoot({ cwd: baseDir });
    const store = new SessionStore(baseDir, projectIdentityRoot);
    await store.save({
      id,
      file: {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        conversation_id: id,
        title: "",
        cwd: baseDir,
        sanitized_at: new Date().toISOString(),
        messages: [],
        jsonMode: false,
        turnCount: 0,
        updatedAt: new Date().toISOString(),
        checkpoints: [],
        nativeStateFormat: NATIVE_STATE_FORMAT_VERSION,
      } as SessionFileV1,
    });
    await store.appendEvents({
      id,
      events: [
        { role: "user", content: [{ type: "text", text: "go" }] },
        { role: "assistant", content: [{ type: "text", text: "ok" }] },
      ],
    });
    await store.appendNativeState({
      id,
      anchorEventId: "e1",
      boundary: "input",
      snapshot: {
        boundary: "input",
        messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      },
    });
    await store.appendOperationFact({
      id,
      factId: "f-worker",
      fact: {
        kind: "worker_progress",
        taskId: "task-1",
        ownership: "background",
        state: "running",
        ...(record !== undefined
          ? { process: { pid: record.pid, startTime: record.starttime } }
          : {}),
        transcriptPath: "/workers/task-1.jsonl",
      },
    });
    if (record !== undefined) {
      const subagentsDir = resolveSubagentTraceDir({
        projectDir: store.getProjectDir(),
        conversationId: id,
      });
      writeWorkerIdentityRecord(subagentsDir, {
        task_id: "task-1",
        ownership: "background",
        worker_state: "running",
        pid: record.pid,
        starttime: record.starttime,
        transcript_path: join(subagentsDir, "task-1.jsonl"),
        session_id: id,
      });
    }
    return store;
  }

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "iknow-tui-sweep-"));
  });
  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  const open = (id: string) =>
    createTuiBridge({
      dataDir: baseDir,
      workspaceRoot: baseDir,
      deps: makeDeps([]),
      inflight: createInflightRegistry(),
    }).openSession(id);

  test("扫到停透证明的 worker → 报告 recovered（无 sweep 时必是 needs handling）", async () => {
    const id = "tui-sweep-proven";
    await seedWorker(id, { pid: deadPid(), starttime: 1 });

    const { recovery } = await open(id);

    expect(recovery.status).toEqual({ status: "recovered" });
    expect(recovery.operationFacts?.workers[0]?.needsHandling).toBe(false);
    expect(recovery.operationFacts?.workers[0]?.stopEvidence).toEqual({
      state: "confirmed_stopped",
      pid: recovery.operationFacts?.workers[0]?.process?.pid,
    });
  });

  test("扫不到的 worker → 报告 needs handling，绝不谎称已停", async () => {
    const id = "tui-sweep-unproved";
    // A recorded worker with no identity record on disk: the sweep has nothing
    // to verify, so the report must keep it unsettled (ADR-0136 §4 / SC17)
    // rather than read the missing evidence as a stop.
    await seedWorker(id);

    const { recovery } = await open(id);

    expect(recovery.status).toEqual({
      status: "needs handling",
      handling: [],
      workers: ["task-1"],
    });
    expect(recovery.operationFacts?.workers[0]?.needsHandling).toBe(true);
    expect(recovery.operationFacts?.workers[0]?.stopEvidence).toBeNull();
  });
});
