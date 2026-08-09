/**
 * SessionHub T4 tests: load → run → save pipeline + error mapping + concurrency.
 * Covers 5 boundary classes (empty/negative/overflow/exception/concurrent),
 * 6-row error mapping table, cancelled/timeout stopReason, turnCount accumulation.
 */
import { afterAll, afterEach, beforeAll, describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionHub, mapStoreError } from "../../src/session-api/hub.ts";
import {
  resolveProjectSessionDir,
  SessionStore,
} from "../../src/session-api/store/index.ts";
import type { SessionStoreError } from "../../src/session-api/store/index.ts";
import type { SessionFileV1 } from "../../src/session-api/store/index.ts";
import type {
  AssistantTurnResult,
  HarnessStreamEvent,
  LoopAdapter,
  LoopEngineDeps,
  AnthropicNativeMessage,
} from "../../src/harness/index.ts";
import { createStubModel } from "../../src/harness/stubs/stub-model.ts";
import { createServeAskUser } from "../../src/harness/permission/ask-user.ts";
import { createSessionGrants } from "../../src/harness/permission/session-grants.ts";
import { createStubTool } from "../../src/harness/stubs/stub-tool.ts";
import { createRegistry } from "../../src/harness/tools/registry.ts";
import { createExecutor } from "../../src/harness/tools/executor.ts";
import { assistantResult, makeDeps } from "../cli/_fixtures.ts";
import {
  makeTestLlmEnv,
  startLlmCapture,
  type LlmCapture,
} from "./_helpers/llm-capture.ts";

// -- helpers -----------------------------------------------------------------

/**
 * Adapter whose step() never settles, so the loop engine's run-level timeout
 * (timeoutMs) is the only thing that can stop it. Mirrors the i11 smoke
 * script's never-resolving adapter to deterministically force stopReason=timeout.
 */
const neverResolvingAdapter: LoopAdapter = {
  step: () => new Promise<AssistantTurnResult>(() => {}),
  encodeUserText: (text: string): AnthropicNativeMessage => ({
    role: "user",
    content: [{ type: "text", text }],
  }),
  encodeToolResults: () => [],
};

function sampleFile(opts: {
  readonly id: string;
  readonly overrides?: Partial<SessionFileV1>;
}): SessionFileV1 {
  const { id, overrides = {} } = opts;
  return {
    schemaVersion: 2,
    conversation_id: id,
    summary: "",
    cwd: "/tmp/test",
    sanitized_at: new Date().toISOString(),
    messages: [],
    jsonMode: false,
    turnCount: 0,
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

// -- setup -------------------------------------------------------------------

let baseDir: string;
// Namespaced session dir (default process.cwd()) for direct file manipulation.
let sessionDir: string;
let store: SessionStore;

beforeAll(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "iknow-hub-"));
  sessionDir = resolveProjectSessionDir(baseDir, process.cwd());
  store = new SessionStore(baseDir);
});

afterAll(async () => {
  await rm(baseDir, { recursive: true, force: true });
});

function makeHub(deps: LoopEngineDeps): SessionHub {
  return new SessionHub({ store, deps });
}

describe("askUser inlet", () => {
  it("throws at construction when neither deps nor askUser is injected", () => {
    assert.throws(
      () => new SessionHub({ store }),
      /ask_inlet_missing: SessionHub requires AskUser or pre-built deps \(#162 \/ SC18\)/
    );
  });
});

// -- mapStoreError (6-row contract table) ------------------------------------

describe("mapStoreError — 6-row error mapping contract", () => {
  const cases: Array<{
    err: SessionStoreError;
    status: number;
    kind: string;
  }> = [
    {
      err: { kind: "not_found", conversation_id: "x" },
      status: 404,
      kind: "not_found",
    },
    {
      err: { kind: "parse_failed", conversation_id: "x", reason: "r" },
      status: 422,
      kind: "parse_failed",
    },
    {
      err: { kind: "schema_invalid", conversation_id: "x", field: "f" },
      status: 422,
      kind: "schema_invalid",
    },
    {
      err: { kind: "write_failed", conversation_id: "x", cause: "c" },
      status: 500,
      kind: "write_failed",
    },
    {
      err: { kind: "concurrent_write", conversation_id: "x" },
      status: 409,
      kind: "concurrent_write",
    },
    {
      err: { kind: "io_error", conversation_id: "x", cause: "c" },
      status: 500,
      kind: "io_error",
    },
  ];

  for (const { err, status, kind } of cases) {
    it(`${kind} → ${status}`, () => {
      const mapped = mapStoreError(err);
      assert.equal(mapped.status, status);
      assert.equal(mapped.body.error.kind, kind);
      assert.equal(typeof mapped.body.error.message, "string");
      assert.ok(mapped.body.error.message.length > 0);
    });
  }
});

// -- createSession -----------------------------------------------------------

describe("createSession", () => {
  it("writes v2 metadata to disk", async () => {
    const hub = makeHub(makeDeps([]));
    const { session } = await hub.createSession();
    const raw = JSON.parse(
      await (
        await import("node:fs/promises")
      ).readFile(join(sessionDir, `${session.conversation_id}.json`), "utf8")
    );
    assert.equal(raw.schemaVersion, 2);
    assert.equal(raw.summary, "");
    assert.equal(typeof raw.cwd, "string");
    assert.equal(typeof raw.sanitized_at, "string");
  });

  it("creates a session file and returns summary", async () => {
    const deps = makeDeps([]);
    const hub = makeHub(deps);
    const res = await hub.createSession();
    assert.ok(res.session.conversation_id.length > 0);
    assert.equal(res.session.turn_count, 0);
    assert.deepEqual(res.turns, []);
    // File exists on disk
    const loaded = await store.load(res.session.conversation_id);
    assert.equal(loaded.turnCount, 0);
    assert.deepEqual(loaded.messages, []);
  });
});

// -- boundary class 1: empty (new session first run) -------------------------

describe("boundary: empty — new session first run", () => {
  it("postMessage on fresh session produces completed turn", async () => {
    const deps = makeDeps([assistantResult({ texts: ["hello world"] })]);
    const hub = makeHub(deps);
    const { session } = await hub.createSession();
    const res = await hub.postMessage({
      conversationId: session.conversation_id,
      text: "hi",
    });
    assert.equal(res.turn.query, "hi");
    assert.equal(res.turn.answer.finalText, "hello world");
    assert.equal(res.turn.answer.stopReason, "completed");
    assert.equal(res.turn.answer.turnCount, 1);
    assert.equal(res.session.turn_count, 1);
  });
});

// -- #196 /profile done 首启完成钩子（web 端）----------------------------------

describe("/profile done — web bootstrap completion hook", () => {
  async function withIsolatedHome<T>(
    fn: (homeDir: string) => Promise<T>
  ): Promise<T> {
    const origHome = process.env.HOME;
    const homeDir = await mkdtemp(join(tmpdir(), "iknow-profile-home-"));
    process.env.HOME = homeDir;
    try {
      return await fn(homeDir);
    } finally {
      process.env.HOME = origHome;
      await rm(homeDir, { recursive: true, force: true });
    }
  }

  it("flips bootstrap_seeded and returns a system-style turn (no model call)", async () => {
    await withIsolatedHome(async (homeDir) => {
      const { initializeIknowWorkspace, readIknowState } =
        await import("../../src/harness/identity/index.ts");
      await initializeIknowWorkspace();
      const hub = makeHub(makeDeps([]));
      const { session } = await hub.createSession();
      const res = await hub.postMessage({
        conversationId: session.conversation_id,
        text: "/profile done",
      });
      assert.match(res.turn.answer.finalText, /首启引导完成/);
      assert.equal(res.turn.answer.stopReason, "completed");
      const state = await readIknowState(join(homeDir, ".iknow"));
      assert.equal(state.bootstrap_seeded, true);
    });
  });

  it("is case-insensitive (slash command normalization)", async () => {
    await withIsolatedHome(async () => {
      const { initializeIknowWorkspace } =
        await import("../../src/harness/identity/index.ts");
      await initializeIknowWorkspace();
      const hub = makeHub(makeDeps([]));
      const { session } = await hub.createSession();
      const res = await hub.postMessage({
        conversationId: session.conversation_id,
        text: "/Profile DONE",
      });
      assert.match(res.turn.answer.finalText, /首启引导完成/);
    });
  });

  it("writeIknowState write failure → ValidationError with typed kind/path/cause", async () => {
    // 让 ~/.iknow 是已存在的常规文件(非目录),让 mkdir ~/.iknow 抛 io_error
    // 触发 typed IknowIdentityError。
    await withIsolatedHome(async (homeDir) => {
      const fs = await import("node:fs/promises");
      // 预先创建 ~/.iknow 为常规文件,阻断 mkdir。
      await fs.writeFile(join(homeDir, ".iknow"), "blocker", "utf8");
      const hub = makeHub(makeDeps([]));
      const { session } = await hub.createSession();
      await assert.rejects(
        () =>
          hub.postMessage({
            conversationId: session.conversation_id,
            text: "/profile done",
          }),
        (err: unknown) => {
          const e = err as { code?: string; message?: string };
          assert.equal(e.code, "VALIDATION");
          assert.match(e.message ?? "", /无法标记首启完成/);
          // 不应是 [object Object]（typed union 已展开）
          assert.doesNotMatch(e.message ?? "", /\[object Object\]/);
          return true;
        }
      );
    });
  });
});

// -- boundary class 2: negative (not_found / parse_failed) -------------------

describe("boundary: negative", () => {
  it("postMessage on missing session → not_found", async () => {
    const deps = makeDeps([]);
    const hub = makeHub(deps);
    await assert.rejects(
      () => hub.postMessage({ conversationId: "nonexistent-id", text: "hi" }),
      (err: unknown) => {
        const e = err as SessionStoreError;
        assert.equal(e.kind, "not_found");
        return true;
      }
    );
  });

  it("postMessage on corrupt file → parse_failed", async () => {
    const deps = makeDeps([]);
    const hub = makeHub(deps);
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, "corrupt-conv.json"), "{not-json", "utf8");
    await assert.rejects(
      () => hub.postMessage({ conversationId: "corrupt-conv", text: "hi" }),
      (err: unknown) => {
        const e = err as SessionStoreError;
        assert.equal(e.kind, "parse_failed");
        return true;
      }
    );
  });
});

// -- boundary class 3: overflow (multi-step + large messages) ----------------

describe("boundary: overflow — multi-step tool loop", () => {
  it("accumulates messages across tool calls", async () => {
    const deps = makeDeps([
      assistantResult({
        texts: [],
        toolCalls: [{ id: "t1", name: "noop", input: {} }],
      }),
      assistantResult({ texts: ["done"] }),
    ]);
    const hub = makeHub(deps);
    const { session } = await hub.createSession();
    const res = await hub.postMessage({
      conversationId: session.conversation_id,
      text: "do stuff",
    });
    assert.equal(res.turn.answer.stopReason, "completed");
    assert.equal(res.turn.answer.turnCount, 2);
    // File should have user + assistant(tool_use) + user(tool_result) + assistant(text) = 4 messages
    const loaded = await store.load(session.conversation_id);
    assert.equal(loaded.messages.length, 4);
    assert.equal(loaded.turnCount, 2);
  });
});

// -- boundary class 4: exception (cancelled / timeout) -----------------------

describe("boundary: exception — cancelled signal", () => {
  it("cancelled → stopReason=cancelled, file messages unchanged", async () => {
    // Stub model with delay so we can abort mid-flight
    const tool = createStubTool({ name: "noop", next: () => ({}) });
    const registry = createRegistry([tool]);
    const executor = createExecutor(registry);
    const adapter = createStubModel({
      responses: [assistantResult({ texts: ["should not appear"] })],
      delayMs: 500,
    });
    const deps: LoopEngineDeps = { adapter, executor, registry, maxTurns: 5 };
    const hub = makeHub(deps);
    const { session } = await hub.createSession();

    const controller = new AbortController();
    // Abort after 50ms
    setTimeout(() => controller.abort(), 50);

    const res = await hub.postMessage({
      conversationId: session.conversation_id,
      text: "will be cancelled",
      signal: controller.signal,
    });
    assert.equal(res.turn.answer.stopReason, "cancelled");
    assert.equal(res.turn.answer.finalText, "");
    // File must NOT be updated (cancelled → no save)
    const loaded = await store.load(session.conversation_id);
    assert.equal(loaded.messages.length, 0);
    assert.equal(loaded.turnCount, 0);
  });
});

describe("boundary: exception — run-level timeout", () => {
  it("timeoutMs fires → stopReason=timeout (strict, no disjunction)", async () => {
    // Never-resolving adapter + timeoutMs: 1 → loop engine races the model
    // step against the timer; timer wins deterministically.
    const tool = createStubTool({ name: "noop", next: () => ({}) });
    const registry = createRegistry([tool]);
    const executor = createExecutor(registry);
    const deps: LoopEngineDeps = {
      adapter: neverResolvingAdapter,
      executor,
      registry,
      maxTurns: 5,
      timeoutMs: 1,
      // plan T4:异常停收尾摘要 re-uses 同一 never-resolving adapter;缩短摘要
      // 独立超时,避免该测试被 15s default 拖成超时。
      summaryTimeoutMs: 1,
    };
    const hub = makeHub(deps);
    const { session } = await hub.createSession();
    const res = await hub.postMessage({
      conversationId: session.conversation_id,
      text: "trigger timeout",
    });
    assert.equal(res.turn.answer.stopReason, "timeout");
  });
});

describe("boundary: exception — tool timeout persists execution_failed", () => {
  it("toolTimeoutMs → file contains is_error tool_result from executor", async () => {
    // A hanging tool forces the executor to return execution_failed (is_error=true);
    // that failure block must be persisted to the session file (spec L238).
    const tool = createStubTool({
      name: "slow",
      next: () => new Promise(() => {}), // never resolves
    });
    const registry = createRegistry([tool]);
    const executor = createExecutor(registry);
    const adapter = createStubModel({
      responses: [
        assistantResult({
          texts: [],
          toolCalls: [{ id: "t1", name: "slow", input: {} }],
        }),
        assistantResult({ texts: ["after timeout"] }),
      ],
    });
    const deps: LoopEngineDeps = {
      adapter,
      executor,
      registry,
      maxTurns: 5,
      toolTimeoutMs: 1,
    };
    const hub = makeHub(deps);
    const { session } = await hub.createSession();
    await hub.postMessage({
      conversationId: session.conversation_id,
      text: "trigger tool timeout",
    });
    // File IS saved (timeout → save per 裁决#8)
    const loaded = await store.load(session.conversation_id);
    assert.ok(loaded.messages.length > 0, "file must be saved on tool timeout");
    // Look for the executor-encoded execution_failed tool_result (is_error=true).
    // stopReason is not asserted here: the loop may stop on the tool failure
    // (timeout) or recover via the model — only persistence is the contract.
    const hasExecFailed = loaded.messages.some(
      (m) =>
        m.role === "user" &&
        m.content.some(
          (b) =>
            b.type === "tool_result" && "is_error" in b && b.is_error === true
        )
    );
    assert.ok(
      hasExecFailed,
      "timeout must persist execution_failed tool_result"
    );
  });
});

// -- boundary class 5: concurrent (same-id serialization) --------------------

describe("boundary: concurrent — same-id serialization", () => {
  it("Promise.all on same id serializes execution", async () => {
    const callOrder: number[] = [];
    let callCount = 0;
    const tool = createStubTool({ name: "noop", next: () => ({}) });
    const registry = createRegistry([tool]);
    const executor = createExecutor(registry);
    // Two responses for two sequential calls
    const adapter = createStubModel({
      responses: [
        assistantResult({ texts: ["first"] }),
        assistantResult({ texts: ["second"] }),
      ],
    });
    const deps: LoopEngineDeps = { adapter, executor, registry, maxTurns: 5 };
    const hub = makeHub(deps);
    const { session } = await hub.createSession();

    const [r1, r2] = await Promise.all([
      hub.postMessage({
        conversationId: session.conversation_id,
        text: "msg1",
      }),
      hub.postMessage({
        conversationId: session.conversation_id,
        text: "msg2",
      }),
    ]);
    // Both succeed (serialized, not concurrent corruption)
    assert.equal(r1.turn.answer.stopReason, "completed");
    assert.equal(r2.turn.answer.stopReason, "completed");
    // turnCount accumulates: first run = 1, second run = 1, total = 2
    const loaded = await store.load(session.conversation_id);
    assert.equal(loaded.turnCount, 2);
  });
});

// -- turnCount accumulation --------------------------------------------------

describe("turnCount accumulation across multiple postMessage calls", () => {
  it("two rounds → session.turnCount = round1 + round2", async () => {
    const deps = makeDeps([
      assistantResult({ texts: ["answer 1"] }),
      assistantResult({ texts: ["answer 2"] }),
    ]);
    const hub = makeHub(deps);
    const { session } = await hub.createSession();

    const r1 = await hub.postMessage({
      conversationId: session.conversation_id,
      text: "q1",
    });
    assert.equal(r1.session.turn_count, 1);
    assert.equal(r1.turn.answer.turnCount, 1);

    const r2 = await hub.postMessage({
      conversationId: session.conversation_id,
      text: "q2",
    });
    assert.equal(r2.session.turn_count, 2);
    assert.equal(r2.turn.answer.turnCount, 1); // per-run turnCount starts at 0

    const loaded = await store.load(session.conversation_id);
    assert.equal(loaded.turnCount, 2);
  });
});

// -- protocolError / emptyFinalResponse → no save ----------------------------

describe("drop-context stop reasons do not save", () => {
  it("protocolError → file unchanged", async () => {
    // Exhaust stub responses → ProtocolError → stopReason=protocolError
    const deps = makeDeps([]); // no responses → first step throws ProtocolError
    const hub = makeHub(deps);
    const { session } = await hub.createSession();
    const res = await hub.postMessage({
      conversationId: session.conversation_id,
      text: "trigger protocol error",
    });
    assert.equal(res.turn.answer.stopReason, "protocolError");
    const loaded = await store.load(session.conversation_id);
    assert.equal(loaded.messages.length, 0);
    assert.equal(loaded.turnCount, 0);
  });

  it("emptyFinalResponse → file unchanged", async () => {
    const deps = makeDeps([
      assistantResult({ texts: [], toolCalls: [], supplierStop: "success" }),
    ]); // empty → emptyFinalResponse
    const hub = makeHub(deps);
    const { session } = await hub.createSession();
    const res = await hub.postMessage({
      conversationId: session.conversation_id,
      text: "trigger empty",
    });
    assert.equal(res.turn.answer.stopReason, "emptyFinalResponse");
    const loaded = await store.load(session.conversation_id);
    assert.equal(loaded.messages.length, 0);
    assert.equal(loaded.turnCount, 0);
  });
});

// -- getSession / resetSession / listSessions --------------------------------

describe("getSession", () => {
  it("returns summary with projected turns (no raw messages)", async () => {
    const deps = makeDeps([assistantResult({ texts: ["hi"] })]);
    const hub = makeHub(deps);
    const { session } = await hub.createSession();
    await hub.postMessage({
      conversationId: session.conversation_id,
      text: "hello",
    });
    const res = await hub.getSession(session.conversation_id);
    assert.equal(res.session.conversation_id, session.conversation_id);
    assert.equal(res.session.turn_count, 1);
    // turns projection: one TurnDto with the user query + assistant finalText.
    assert.equal(res.turns.length, 1);
    assert.equal(res.turns[0]!.query, "hello");
    assert.equal(res.turns[0]!.answer.finalText, "hi");
    assert.equal(res.turns[0]!.answer.stopReason, "completed");
    assert.equal(res.turns[0]!.answer.turnCount, 1);
    // Projection must not contain raw AnthropicNativeMessage / content blocks.
    const raw = res.turns[0] as unknown as Record<string, unknown>;
    assert.equal(raw["messages"], undefined);
    assert.equal(raw["content"], undefined);
  });
});

describe("resetSession", () => {
  it("clears messages and resets turnCount", async () => {
    const deps = makeDeps([assistantResult({ texts: ["hi"] })]);
    const hub = makeHub(deps);
    const { session } = await hub.createSession();
    await hub.postMessage({
      conversationId: session.conversation_id,
      text: "hello",
    });
    const res = await hub.resetSession(session.conversation_id);
    assert.equal(res.session.turn_count, 0);
    const loaded = await store.load(session.conversation_id);
    assert.equal(loaded.messages.length, 0);
    assert.equal(loaded.turnCount, 0);
  });
});

// -- compactSession ----------------------------------------------------------
// 边界类覆盖：正常压缩（> keepRecent 触发裁剪）、幂等 no-op（低于阈值不落盘）、
// 空会话 no-op、missing session → not_found。DEFAULT_KEEP_RECENT=6，每 turn 2
// 条消息（user+assistant），4 turns = 8 条 → 触发裁剪。

describe("compactSession", () => {
  async function seedTurns(hub: SessionHub, id: string, n: number) {
    for (let i = 0; i < n; i++) {
      await hub.postMessage({ conversationId: id, text: `q${i}` });
    }
  }

  it("实际压缩：8 条消息 → 压缩后消息更少，落盘", async () => {
    const deps = makeDeps(
      Array.from({ length: 4 }, (_, i) =>
        assistantResult({ texts: [`answer ${i}`] })
      )
    );
    const hub = makeHub(deps);
    const { session } = await hub.createSession();
    await seedTurns(hub, session.conversation_id, 4);

    const loaded = await store.load(session.conversation_id);
    assert.equal(loaded.messages.length, 8);

    const res = await hub.compactSession(session.conversation_id);
    assert.equal(res.compacted, true);
    // keepRecent=6 尾窗 + 1 条边界占位符 = 7 条 < 8。
    assert.equal(res.beforeCount, 8);
    assert.equal(res.afterCount, 7);
    // same conversation id，turnCount 不重置。
    assert.equal(res.session.conversation_id, session.conversation_id);
    assert.equal(res.session.turn_count, 4);

    const after = await store.load(session.conversation_id);
    assert.equal(after.messages.length, 7);
    assert.equal(after.turnCount, 4);
  });

  it("幂等 no-op：消息低于压缩窗口 → compacted=false，不落盘、不 bump updatedAt", async () => {
    const deps = makeDeps([assistantResult({ texts: ["hi"] })]);
    const hub = makeHub(deps);
    const { session } = await hub.createSession();
    await hub.postMessage({
      conversationId: session.conversation_id,
      text: "hello",
    });
    const before = await store.load(session.conversation_id);
    assert.equal(before.messages.length, 2);

    const res = await hub.compactSession(session.conversation_id);
    assert.equal(res.compacted, false);
    assert.equal(res.beforeCount, 2);
    assert.equal(res.afterCount, 2);

    const after = await store.load(session.conversation_id);
    assert.equal(after.updatedAt, before.updatedAt); // 未 touch
    assert.equal(after.messages.length, 2);
  });

  it("空会话 → compacted=false no-op", async () => {
    const hub = makeHub(makeDeps([]));
    const { session } = await hub.createSession();
    const res = await hub.compactSession(session.conversation_id);
    assert.equal(res.compacted, false);
    assert.equal(res.beforeCount, 0);
    assert.equal(res.afterCount, 0);
  });

  it("missing session → not_found（mapStoreError 契约）", async () => {
    const hub = makeHub(makeDeps([]));
    await assert.rejects(
      () => hub.compactSession("no-such-id"),
      (err: unknown) => {
        const e = err as { kind?: string };
        return e.kind === "not_found";
      }
    );
  });
});

describe("postMessage summary projection", () => {
  it("recomputes summary instead of preserving a dirty value", async () => {
    const hub = makeHub(makeDeps([assistantResult({ texts: ["answer"] })]));
    const { session } = await hub.createSession();
    const path = join(sessionDir, `${session.conversation_id}.json`);
    const { readFile, writeFile } = await import("node:fs/promises");
    const raw = JSON.parse(await readFile(path, "utf8"));
    raw.summary = "dirty";
    await writeFile(path, JSON.stringify(raw), "utf8");
    await hub.postMessage({
      conversationId: session.conversation_id,
      text: "hello",
    });
    const saved = JSON.parse(await readFile(path, "utf8"));
    assert.equal(saved.summary, "hello");
  });
});

describe("listSessions", () => {
  it("returns metadata for sessions that have a reply", async () => {
    const deps = makeDeps([assistantResult({ texts: ["hi"] })]);
    const hub = makeHub(deps);
    const { session } = await hub.createSession();
    await hub.postMessage({
      conversationId: session.conversation_id,
      text: "hello",
    });
    const list = await hub.listSessions();
    const entry = list.find(
      (e) => e.conversation_id === session.conversation_id
    );
    assert.ok(entry);
    assert.equal(entry.summary, "hello");
  });

  it("excludes a freshly created session with no reply (issue #96)", async () => {
    const deps = makeDeps([]);
    const hub = makeHub(deps);
    const { session } = await hub.createSession();
    const list = await hub.listSessions();
    assert.ok(
      !list.some((e) => e.conversation_id === session.conversation_id),
      "empty session must not be listed"
    );
  });
});

// -- validation --------------------------------------------------------------

describe("postMessage validation", () => {
  it("rejects empty text", async () => {
    const deps = makeDeps([]);
    const hub = makeHub(deps);
    const { session } = await hub.createSession();
    await assert.rejects(
      () =>
        hub.postMessage({
          conversationId: session.conversation_id,
          text: "   ",
        }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok((err as Error).message.includes("non-empty"));
        return true;
      }
    );
  });

  it("rejects text exceeding MAX_MESSAGE_CHARS", async () => {
    const deps = makeDeps([]);
    const hub = makeHub(deps);
    const { session } = await hub.createSession();
    const longText = "x".repeat(8001);
    await assert.rejects(
      () =>
        hub.postMessage({
          conversationId: session.conversation_id,
          text: longText,
        }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok((err as Error).message.includes("max length"));
        return true;
      }
    );
  });
});

// -- T1: wire projection of thinking / toolCalls ------------------------------

describe("postMessage answer wire fields (T1)", () => {
  it("no thinking parameter + plain text turn → answer has NO thinking/toolCalls keys (byte-stable)", async () => {
    const deps = makeDeps([assistantResult({ texts: ["plain"] })]);
    const hub = makeHub(deps);
    const { session } = await hub.createSession();
    const res = await hub.postMessage({
      conversationId: session.conversation_id,
      text: "hi",
    });
    // Additive fields must be entirely absent, not merely undefined, so the
    // JSON wire bytes match the pre-T1 shape exactly.
    assert.equal("thinking" in res.turn.answer, false);
    assert.equal("toolCalls" in res.turn.answer, false);
    assert.deepEqual(Object.keys(res.turn.answer).sort(), [
      "finalText",
      "stopReason",
      "turnCount",
    ]);
  });

  it("tool-call turn → toolCalls on wire with paired output", async () => {
    const deps = makeDeps([
      assistantResult({
        texts: [],
        toolCalls: [{ id: "t1", name: "noop", input: { a: 1 } }],
      }),
      assistantResult({ texts: ["done"] }),
    ]);
    const hub = makeHub(deps);
    const { session } = await hub.createSession();
    const res = await hub.postMessage({
      conversationId: session.conversation_id,
      text: "call noop",
    });
    const answer = res.turn.answer as unknown as Record<string, unknown>;
    assert.equal("thinking" in answer, false);
    assert.ok(Array.isArray(answer.toolCalls));
    const calls = answer.toolCalls as Array<Record<string, unknown>>;
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.id, "t1");
    assert.equal(calls[0]!.name, "noop");
    assert.equal(calls[0]!.inputPreview, '{"a":1}');
    // stub tool `noop` returns {} → executor serializes to "{}" text block.
    assert.equal(calls[0]!.outputPreview, "{}");
    assert.equal(calls[0]!.isError, false);
    assert.equal(calls[0]!.truncated, false);
  });

  it("thinking turn → thinking entries on wire; empty thinking text skipped", async () => {
    const deps = makeDeps([
      assistantResult({
        texts: ["answered"],
        thinkingBlocks: [
          { type: "thinking", thinking: "step one", signature: "sig1" },
          { type: "thinking", thinking: "", signature: "sig2" },
          { type: "redacted_thinking", data: "blob" },
        ],
      }),
    ]);
    const hub = makeHub(deps);
    const { session } = await hub.createSession();
    const res = await hub.postMessage({
      conversationId: session.conversation_id,
      text: "think please",
    });
    const answer = res.turn.answer as unknown as Record<string, unknown>;
    assert.equal("toolCalls" in answer, false);
    assert.deepEqual(answer.thinking, {
      entries: [{ text: "step one" }],
      redactedCount: 1,
    });
  });
});

// -- context-usage-display: lastUsage wire projection -------------------------

describe("postMessage answer wire fields — lastUsage (context-usage-display)", () => {
  it("assistantResult with usage → answer.lastUsage present (camelCase)", async () => {
    const deps = makeDeps([
      assistantResult({
        texts: ["done"],
        usage: {
          inputTokens: 111,
          outputTokens: 22,
          cacheCreationInputTokens: 5,
          cacheReadInputTokens: 9,
        },
      }),
    ]);
    const hub = makeHub(deps);
    const { session } = await hub.createSession();
    const res = await hub.postMessage({
      conversationId: session.conversation_id,
      text: "x",
    });
    const answer = res.turn.answer as unknown as Record<string, unknown>;
    assert.ok("lastUsage" in answer, "lastUsage key must be present");
    const usage = answer.lastUsage as Record<string, unknown>;
    assert.equal(usage.inputTokens, 111);
    assert.equal(usage.outputTokens, 22);
    assert.equal(usage.cacheCreationInputTokens, 5);
    assert.equal(usage.cacheReadInputTokens, 9);
  });

  it("assistantResult without usage → answer.lastUsage key absent (byte-stable)", async () => {
    const deps = makeDeps([assistantResult({ texts: ["plain"] })]);
    const hub = makeHub(deps);
    const { session } = await hub.createSession();
    const res = await hub.postMessage({
      conversationId: session.conversation_id,
      text: "hi",
    });
    assert.equal("lastUsage" in res.turn.answer, false);
    assert.deepEqual(Object.keys(res.turn.answer).sort(), [
      "finalText",
      "stopReason",
      "turnCount",
    ]);
  });

  it("cache nulls on usage survive to wire", async () => {
    const deps = makeDeps([
      assistantResult({
        texts: ["x"],
        usage: {
          inputTokens: 7,
          outputTokens: 3,
          cacheCreationInputTokens: null,
          cacheReadInputTokens: null,
        },
      }),
    ]);
    const hub = makeHub(deps);
    const { session } = await hub.createSession();
    const res = await hub.postMessage({
      conversationId: session.conversation_id,
      text: "x",
    });
    const answer = res.turn.answer as unknown as Record<string, unknown>;
    const usage = answer.lastUsage as Record<string, unknown>;
    assert.equal(usage.cacheCreationInputTokens, null);
    assert.equal(usage.cacheReadInputTokens, null);
  });
});

// -- T2: per-turn thinking override -------------------------------------------

describe("postMessage thinking override (T2)", () => {
  // Capture server stands in for the LLM endpoint; withThinkingOverride builds
  // a real adapter against it, so we can observe the actual request params.
  let capture: LlmCapture | undefined;

  afterEach(async () => {
    if (capture) {
      await capture.close();
      capture = undefined;
    }
  });

  /** The hub tests want a reply whose finalText reads "override reply". */
  const overrideReplyBody = {
    id: "msg_capture",
    type: "message",
    role: "assistant",
    model: "m",
    content: [{ type: "text", text: "override reply" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  };

  it("override → adapter request carries thinking + output_config; reply lands on wire", async () => {
    const cap = await startLlmCapture(overrideReplyBody);
    capture = cap;
    const hub = new SessionHub({
      store,
      deps: makeDeps([]), // stub deps; override path replaces only the adapter
      overrideEnv: makeTestLlmEnv({ baseUrl: cap.origin }),
    });
    const { session } = await hub.createSession();
    const res = await hub.postMessage({
      conversationId: session.conversation_id,
      text: "think hard",
      thinking: { mode: "adaptive", effort: "high" },
    });
    // The request that reached the LLM endpoint carries the override.
    assert.equal(cap.bodies.length, 1);
    const body = cap.bodies[0] as Record<string, unknown>;
    assert.deepEqual(body.thinking, { type: "adaptive" });
    assert.deepEqual(body.output_config, { effort: "high" });
    // Reply flows back through the normal wire projection.
    assert.equal(res.turn.answer.finalText, "override reply");
    assert.equal(res.turn.answer.stopReason, "completed");
  });

  it("no override → cached stub deps used; no LLM request hits the capture server", async () => {
    const cap = await startLlmCapture(overrideReplyBody);
    capture = cap;
    const hub = new SessionHub({
      store,
      deps: makeDeps([assistantResult({ texts: ["cached reply"] })]),
      overrideEnv: makeTestLlmEnv({ baseUrl: cap.origin }),
    });
    const { session } = await hub.createSession();
    const res = await hub.postMessage({
      conversationId: session.conversation_id,
      text: "no override",
    });
    assert.equal(res.turn.answer.finalText, "cached reply");
    assert.equal(cap.bodies.length, 0);
  });
});

// -- T1: history replay (GET session) projects thinking / toolCalls ----------

describe("getSession history replay (T1)", () => {
  it("replayed turns carry thinking/toolCalls; stopReason stays completed", async () => {
    const deps = makeDeps([
      assistantResult({
        texts: [],
        toolCalls: [{ id: "h1", name: "noop", input: {} }],
        thinkingBlocks: [
          { type: "thinking", thinking: "plan h", signature: "s" },
        ],
      }),
      assistantResult({ texts: ["round one done"] }),
      assistantResult({ texts: ["round two done"] }),
    ]);
    const hub = makeHub(deps);
    const { session } = await hub.createSession();
    await hub.postMessage({
      conversationId: session.conversation_id,
      text: "round one",
    });
    await hub.postMessage({
      conversationId: session.conversation_id,
      text: "round two",
    });
    const res = await hub.getSession(session.conversation_id);
    assert.equal(res.turns.length, 2);
    // Turn 1: tool turn with thinking.
    const t1 = res.turns[0]!.answer as unknown as Record<string, unknown>;
    assert.equal(t1.stopReason, "completed");
    assert.deepEqual(t1.thinking, {
      entries: [{ text: "plan h" }],
      redactedCount: 0,
    });
    const calls = t1.toolCalls as Array<Record<string, unknown>>;
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.id, "h1");
    assert.equal(calls[0]!.outputPreview, "{}");
    // Turn 2: plain text turn → additive fields absent.
    const t2 = res.turns[1]!.answer as unknown as Record<string, unknown>;
    assert.equal("thinking" in t2, false);
    assert.equal("toolCalls" in t2, false);
    assert.equal(res.turns[1]!.answer.finalText, "round two done");
  });
});

// -- T3: onStream forwarding from postMessage to run() -----------------------

describe("postMessage onStream forwarding (#188)", () => {
  it("forwards onStream to run(): stub stream events reach the hub caller", async () => {
    const received: HarnessStreamEvent[] = [];
    const hub = makeHub(
      makeDeps([assistantResult({ texts: ["hello world"] })], {
        streamEventsByStep: [
          [
            { type: "text_delta", text: "hello " },
            { type: "text_delta", text: "world" },
          ],
        ],
      })
    );
    const id = (await hub.createSession()).session.conversation_id;
    const resp = await hub.postMessage({
      conversationId: id,
      text: "hi",
      onStream: (e) => received.push(e),
    });
    assert.equal(resp.turn.answer.finalText, "hello world");
    assert.deepEqual(received, [
      { type: "text_delta", text: "hello " },
      { type: "text_delta", text: "world" },
    ]);
  });

  it("without onStream: stub still emits but no caller-side capture (zero behavior change)", async () => {
    // 没传 onStream → opts.onStream 为 undefined;hub 透传 undefined 给 run();
    // stub 的 onStream 也是 undefined,emit 被 no-op(side-effect 内部不抛错)。
    // 此用例守住"无 onStream 时行为零变化"的反向兼容契约。
    const hub = makeHub(
      makeDeps([assistantResult({ texts: ["same"] })], {
        streamEventsByStep: [[{ type: "text_delta", text: "same" }]],
      })
    );
    const id = (await hub.createSession()).session.conversation_id;
    const resp = await hub.postMessage({
      conversationId: id,
      text: "q",
    });
    assert.equal(resp.turn.answer.finalText, "same");
    assert.equal(resp.turn.answer.stopReason, "completed");
  });
});

// -- commit B: listPendingAsks + resolveAsk (three-option web ask UI) --------
//
// These tests construct a SessionHub directly with `deps` (skipping the LLM
// stack) plus an `askHandle` + `sessionGrants`. The hub APIs under test do not
// invoke any LLM or executor, so deps only need to satisfy the constructor
// type — `makeDeps([])` returns a valid LoopEngineDeps.
describe("commit B: SessionHub.listPendingAsks + resolveAsk", () => {
  function makeHubWithHandle(opts: { askTimeoutMs?: number }): {
    hub: SessionHub;
    handle: ReturnType<typeof createServeAskUser>;
    grants: ReturnType<typeof createSessionGrants>;
  } {
    const handle = createServeAskUser({
      timeoutMs: opts.askTimeoutMs ?? 1_000,
    });
    const grants = createSessionGrants();
    const hub = new SessionHub({
      store,
      deps: makeDeps([]),
      askUser: handle.ask,
      askHandle: handle,
      sessionGrants: grants,
    });
    return { hub, handle, grants };
  }

  it("listPendingAsks returns empty array when no asks in flight", () => {
    const { hub } = makeHubWithHandle({});
    assert.deepEqual([...hub.listPendingAsks()], []);
  });

  it("listPendingAsks surfaces active asks", async () => {
    const { hub, handle } = makeHubWithHandle({});
    const pending = handle.ask({
      tool: "bash",
      input: { command: "ls -la" },
      summaryHint: 'bash "ls -la"',
    });
    await Promise.resolve();
    const list = hub.listPendingAsks();
    assert.equal(list.length, 1);
    assert.equal(list[0]!.tool, "bash");
    // Settle so the timer does not leak.
    handle.resolveAsk(list[0]!.id, true);
    await pending;
  });

  it("resolveAsk(allow-once) releases the waiter without mutating session grants", async () => {
    const { hub, handle, grants } = makeHubWithHandle({});
    const pending = handle.ask({
      tool: "edit_file",
      input: {},
      summaryHint: "e",
    });
    await Promise.resolve();
    const id = hub.listPendingAsks()[0]!.id;
    assert.equal(hub.resolveAsk(id, "allow-once"), true);
    assert.equal(grants.list().length, 0);
    assert.equal(await pending, true);
  });

  it("resolveAsk(deny) releases the waiter with false (fail-closed)", async () => {
    const { hub, handle, grants } = makeHubWithHandle({});
    const pending = handle.ask({
      tool: "write_file",
      input: {},
      summaryHint: "w",
    });
    await Promise.resolve();
    const id = hub.listPendingAsks()[0]!.id;
    assert.equal(hub.resolveAsk(id, "deny"), true);
    assert.equal(grants.list().length, 0);
    assert.equal(await pending, false);
  });

  it("resolveAsk(always-allow) writes a session-grants rule scoped to the tool", async () => {
    const { hub, handle, grants } = makeHubWithHandle({});
    const pending = handle.ask({
      tool: "grep",
      input: { pattern: "x" },
      summaryHint: "g",
    });
    await Promise.resolve();
    const id = hub.listPendingAsks()[0]!.id;
    assert.equal(hub.resolveAsk(id, "always-allow"), true);
    const rules = grants.list();
    assert.equal(rules.length, 1);
    const rule = rules[0]!;
    assert.equal(rule.decision, "allow");
    assert.equal(rule.match({ tool: "grep", input: {} }), true);
    assert.equal(rule.match({ tool: "bash", input: {} }), false);
    assert.equal(await pending, true);
  });

  it("resolveAsk with unknown id returns false and does not add a rule", () => {
    const { hub, grants } = makeHubWithHandle({});
    assert.equal(hub.resolveAsk("ask-999", "always-allow"), false);
    assert.equal(grants.list().length, 0);
    assert.equal(hub.resolveAsk("ask-999", "allow-once"), false);
    assert.equal(hub.resolveAsk("ask-999", "deny"), false);
  });

  it("resolveAsk after timeout returns false and does not resurrect the rule", async () => {
    const { hub, handle, grants } = makeHubWithHandle({ askTimeoutMs: 10 });
    const pending = handle.ask({ tool: "bash", input: {}, summaryHint: "b" });
    await Promise.resolve();
    const id = hub.listPendingAsks()[0]!.id;
    // Wait past the fail-closed timeout.
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(hub.resolveAsk(id, "always-allow"), false);
    assert.equal(grants.list().length, 0);
    assert.equal(await pending, false);
  });

  it("session-grants allow rule flips checkPermission(grep) → allow", async () => {
    // End-to-end: write the rule through the hub, then verify it is observed
    // by checkPermission (the policy engine reads sources.session?.rules()
    // fresh per call — no cached invalidation required).
    const { hub, handle, grants } = makeHubWithHandle({});
    const pending = handle.ask({ tool: "grep", input: {}, summaryHint: "g" });
    await Promise.resolve();
    const id = hub.listPendingAsks()[0]!.id;
    hub.resolveAsk(id, "always-allow");
    await pending;

    const rule = grants.list()[0]!;
    const { checkPermission } =
      await import("../../src/harness/permission/policy.ts");
    const out = checkPermission({
      def: {
        name: "grep",
        description: "test",
        inputSchema: { type: "object", additionalProperties: false },
        handler: async () => "ok",
        aci: {
          category: "read-only",
          isConcurrencySafe: true,
          interruptBehavior: "cancel",
          timeoutTier: "default",
        },
      },
      input: { pattern: "x" },
      sources: { code: { kind: "code", rules: [] }, session: grants },
      hardWalls: [],
      defaultByCategory: {
        "read-only": "allow",
        write: "ask",
        execute: "ask",
        collaborate: "ask",
      },
    });
    assert.equal(out.decision, "allow");
    assert.ok(out.reason.includes("session"));
    assert.ok(rule.id.startsWith("session-allow-grep"));
  });
});
