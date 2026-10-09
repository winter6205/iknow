/**
 * SessionHub T4 tests: load → run → save pipeline + error mapping + concurrency.
 * Covers 5 boundary classes (empty/negative/overflow/exception/concurrent),
 * 6-row error mapping table, cancelled/timeout stopReason, turnCount accumulation.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionHub, mapStoreError } from "../../src/session-api/hub.ts";
import {
  CURRENT_SCHEMA_VERSION,
  MAX_WORKSPACE_ROOT_CHARS,
  parseSessionJsonl,
  resolveConversationDir,
  resolveProjectSessionDir,
  SESSION_JSONL_EXT,
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
import type { SubAgentManager } from "../../src/harness/subagent/manager.ts";
import type { SubAgentTerminalNotice } from "../../src/harness/subagent/mailbox.ts";
import type { SubAgentEnvelope } from "../../src/harness/subagent/envelope.ts";
import { SubagentWakeError } from "../../src/harness/subagent/host-wake.ts";
import { ValidationError } from "../../src/shared/errors.ts";
import { TransportRetryExhaustedError } from "../../src/harness/errors.ts";
import { OUTPUT_LIMIT_NOTICE } from "../../src/session-api/contract.ts";
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

/** Build a single-text user message (for direct conditionalSave tests). */
function userMsg(t: string): AnthropicNativeMessage {
  return { role: "user", content: [{ type: "text", text: t }] };
}

function sampleFile(opts: {
  readonly id: string;
  readonly overrides?: Partial<SessionFileV1>;
}): SessionFileV1 {
  const { id, overrides = {} } = opts;
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    conversation_id: id,
    title: "",
    cwd: "/tmp/test",
    sanitized_at: new Date().toISOString(),
    messages: [],
    jsonMode: false,
    turnCount: 0,
    updatedAt: new Date().toISOString(),
    checkpoints: [],
    workspaceRoot: process.cwd(),
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
  store = new SessionStore(baseDir, process.cwd());
});

afterAll(async () => {
  await rm(baseDir, { recursive: true, force: true });
});

function makeHub(deps: LoopEngineDeps): SessionHub {
  return new SessionHub({ store, deps, workspaceRoot: process.cwd() });
}

describe("askUser inlet", () => {
  it("throws at construction when neither deps nor askUser is injected", () => {
    assert.throws(
      () => new SessionHub({ store }),
      /ask_inlet_missing: SessionHub requires AskUser or pre-built deps \(#162 \/ SC18\)/
    );
  });
});

describe("SessionHub subagent wake", () => {
  it("starts one silent run after a terminal notice when the session is idle", async () => {
    const subscribers = new Set<(notice: SubAgentTerminalNotice) => void>();
    let completed: ReadonlyArray<{
      readonly taskId: string;
      readonly envelope: SubAgentEnvelope;
    }> = [];
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
      getCapacity: () => 15,
      listSubagents: () => [],
      subscribe: (subscriber: (notice: SubAgentTerminalNotice) => void) => {
        subscribers.add(subscriber);
        return () => subscribers.delete(subscriber);
      },
    } as SubAgentManager;
    const hub = new SessionHub({
      store,
      deps: makeDeps([
        assistantResult({ texts: ["initial"] }),
        assistantResult({ texts: ["woken"] }),
      ]),
      subagentManager: manager,
      surface: "serve",
    });
    await hub.bindWorkspace(process.cwd());
    const created = await hub.createSession();

    await hub.postMessage({
      conversationId: created.session.conversation_id,
      text: "start",
    });
    completed = [
      {
        taskId: "wake-task",
        envelope: {
          status: "ok",
          summary: "worker done",
          result: "worker result",
        },
      },
    ];
    for (const subscriber of [...subscribers]) {
      subscriber({
        taskId: "wake-task",
        conversationId: created.session.conversation_id,
        status: "ok",
        summary: "worker done",
        result: "worker result",
      });
    }

    await vi.waitFor(async () => {
      const file = await store.load(created.session.conversation_id);
      expect(
        file.messages.some((message) =>
          message.content.some(
            (block) =>
              block.type === "text" &&
              block.text.includes("## Sub-agent wake-task result: worker done")
          )
        )
      ).toBe(true);
      expect(
        file.messages.some((message) =>
          message.content.some(
            (block) => block.type === "text" && block.text.includes("woken")
          )
        )
      ).toBe(true);
      // ADR-0112: the drain host commit carries the provenance stamp and survives the persistence chain.
      const drainMsg = file.messages.find((message) =>
        message.content.some(
          (block) =>
            block.type === "text" &&
            block.text.includes("## Sub-agent wake-task result")
        )
      );
      expect(drainMsg?.hostInjected).toBe(true);
    });
  });

  it("rejects a failed silent wake with the real task status instead of a success response", async () => {
    const manager = {
      spawn: () => ({ taskId: "failed-wake-task" }),
      queryBuffer: () => ({
        status: "failed" as const,
        reason: "crashed" as const,
        summary: "worker failed",
      }),
      waitFor: async () => {
        throw new Error("unused");
      },
      shutdown: async () => {},
      drainCompleted: () => [
        {
          taskId: "failed-wake-task",
          envelope: {
            status: "ok" as const,
            summary: "worker completed",
            result: "worker result",
          },
        },
      ],
      listActive: () => [],
      abortTask: () => false,
      getCapacity: () => 15,
      listSubagents: () => [],
      subscribe: () => () => {},
    } as SubAgentManager;
    const hub = new SessionHub({
      store,
      deps: {
        ...makeDeps([]),
        adapter: {
          ...makeDeps([]).adapter,
          step: async () => {
            throw new Error("silent run unavailable");
          },
        },
      },
      subagentManager: manager,
      surface: "serve",
    });
    await hub.bindWorkspace(process.cwd());
    const created = await hub.createSession();

    await assert.rejects(
      () =>
        hub.wakeFromSubagent({
          conversationId: created.session.conversation_id,
        }),
      (error: unknown) =>
        error instanceof SubagentWakeError &&
        error.status === "undelivered" &&
        error.reason === "wakeFailed" &&
        error.taskIds.includes("failed-wake-task") &&
        error.queryable === true &&
        !error.message.includes("completion")
    );
    const loaded = await store.load(created.session.conversation_id);
    assert.equal(loaded.messages.length, 0);
  });

  it("returns undefined without a completion response when the manager has no envelope", async () => {
    const manager = {
      spawn: () => ({ taskId: "unused" }),
      queryBuffer: () => ({ status: "not_found" as const }),
      waitFor: async () => {
        throw new Error("unused");
      },
      shutdown: async () => {},
      drainCompleted: () => [],
      listActive: () => [],
      abortTask: () => false,
      getCapacity: () => 15,
      listSubagents: () => [],
      subscribe: () => () => {},
    } as SubAgentManager;
    const hub = new SessionHub({
      store,
      deps: makeDeps([]),
      subagentManager: manager,
      surface: "serve",
    });
    await hub.bindWorkspace(process.cwd());
    const created = await hub.createSession();

    const result = await hub.wakeFromSubagent({
      conversationId: created.session.conversation_id,
    });

    assert.equal(result, undefined);
    assert.equal(
      (await store.load(created.session.conversation_id)).messages.length,
      0
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
  it("rejects an unbound create before allocating or writing a session file", async () => {
    const isolatedDir = await mkdtemp(
      join(tmpdir(), "iknow-hub-create-unbound-")
    );
    const isolatedStore = new SessionStore(isolatedDir, process.cwd());
    const isolatedHub = new SessionHub({
      store: isolatedStore,
      deps: makeDeps([]),
    });

    try {
      await assert.rejects(
        () => isolatedHub.createSession(),
        (err: unknown) => {
          assert.ok(err instanceof ValidationError);
          assert.equal(err.details?.["field"], "workspaceRoot");
          return true;
        }
      );
      await assert.rejects(
        () => isolatedStore.load("any-created-id"),
        (err: unknown) => (err as { kind?: string }).kind === "not_found"
      );
    } finally {
      await rm(isolatedDir, { recursive: true, force: true });
    }
  });

  for (const [label, workspaceRoot] of [
    ["empty", ""],
    ["relative", "relative/path"],
    ["overflow", "x".repeat(MAX_WORKSPACE_ROOT_CHARS + 1)],
  ] as const) {
    it(`rejects ${label} bound root before writing a session file`, async () => {
      const isolatedDir = await mkdtemp(
        join(tmpdir(), `iknow-hub-create-${label}-`)
      );
      const isolatedStore = new SessionStore(isolatedDir, process.cwd());
      const isolatedHub = new SessionHub({
        store: isolatedStore,
        deps: makeDeps([]),
        workspaceRoot,
      });

      try {
        await assert.rejects(
          () => isolatedHub.createSession(),
          (err: unknown) => {
            assert.ok(err instanceof ValidationError);
            assert.equal(err.details?.["field"], "workspaceRoot");
            return true;
          }
        );
        await assert.rejects(
          () => isolatedStore.load("any-created-id"),
          (err: unknown) => (err as { kind?: string }).kind === "not_found"
        );
      } finally {
        await rm(isolatedDir, { recursive: true, force: true });
      }
    });
  }

  it("writes current-schema metadata to disk", async () => {
    const hub = makeHub(makeDeps([]));
    const { session } = await hub.createSession();
    // #629: createSession writes only the JSONL authority; load it back and
    // assert the header record carries the v5 schema + empty checkpoints.
    const loaded = await store.load(session.conversation_id);
    assert.equal(loaded.schemaVersion, CURRENT_SCHEMA_VERSION);
    assert.equal(loaded.title, "");
    assert.equal(typeof loaded.cwd, "string");
    assert.equal(typeof loaded.sanitized_at, "string");
    assert.deepEqual(loaded.checkpoints, []);
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
    const dir = resolveConversationDir({
      projectDir: sessionDir,
      conversationId: "corrupt-conv",
    });
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "corrupt-conv.json"), "{not-json", "utf8");
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
    // T1: cancelled WITH delta>0 now persists — the user query landed before
    // the abort, so the interrupted turn is recoverable via a checkpoint.
    // On cancelled, the system interrupt message is appended at the end
    // (first-class transcript citizen), so messages length = seed user(1) +
    // system interrupt(1) = 2.
    const loaded = await store.load(session.conversation_id);
    assert.equal(loaded.messages.length, 2);
    assert.equal(loaded.messages[1]!.role, "system");
    assert.equal(loaded.turnCount, 0);
    // A checkpoint record marks the interrupted turn.
    assert.equal(loaded.checkpoints?.length, 1);
    const cp = loaded.checkpoints?.[0];
    assert.equal(cp?.turnIndex, 0);
    assert.equal(cp?.messagesCount, 2);
    assert.equal(cp?.interruptReason, "cancelled");
    assert.equal(typeof cp?.interruptedAt, "string");
    // The pure-function path (shouldPersistCheckpoint with delta=0) is
    // covered by checkpoint.test.ts — here we exercise the realistic
    // cancelled-with-progress hub path.
  });

  it("cancelled + delta>0 → answer.interrupted === true (B1)", async () => {
    // Same induction as the previous case: delayMs ensures the abort lands
    // while the model is in flight, run resolves cancelled, and this turn
    // already appended the user message (delta=1 > 0) → actually persisted.
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
    setTimeout(() => controller.abort(), 50);

    const res = await hub.postMessage({
      conversationId: session.conversation_id,
      text: "will be cancelled",
      signal: controller.signal,
    });
    assert.equal(res.turn.answer.stopReason, "cancelled");
    // interrupted must be present and true (shouldPersistCheckpoint=true).
    assert.equal("interrupted" in res.turn.answer, true);
    assert.equal(res.turn.answer.interrupted, true);
  });

  it("conditionalSave cancelled + delta=0 → 返回 false 且不落盘 (B1)", async () => {
    // On the real hub path run() always appends the user message before
    // abort (delta ≥ 1), so the delta=0 branch can only be tested by
    // feeding a synthetic RunResult straight into conditionalSave —
    // "conditionalSave cancelled + delta=0 → returns false". The private
    // member is narrowed via `hub as unknown as { conditionalSave: (...) =>
    // Promise<boolean> }` (narrowing the same literal type has no runtime
    // stub; the real implementation is called directly).
    const hub = makeHub(makeDeps([]));
    const file = sampleFile({
      id: "b1-delta0",
      overrides: { messages: [userMsg("q")], turnCount: 0, checkpoints: [] },
    });
    const conditionalSave = (
      hub as unknown as {
        conditionalSave(opts: {
          readonly conversationId: string;
          readonly session: SessionFileV1;
          readonly result: {
            readonly finalText: string | null;
            readonly messages: ReadonlyArray<AnthropicNativeMessage>;
            readonly turnCount: number;
            readonly stopReason: string;
            readonly lastUsage: null;
          };
          readonly priorMessages: ReadonlyArray<AnthropicNativeMessage>;
        }): Promise<boolean>;
      }
    ).conditionalSave;
    // cancelled + delta=0 (prior=[q] same length as result.messages) → false, no file write.
    // The destructured method loses `this`; bind the store via .call(hub, …).
    const savedFalse = await conditionalSave.call(hub, {
      conversationId: file.conversation_id,
      session: file,
      result: {
        finalText: null,
        messages: [userMsg("q")], // delta=0
        turnCount: 0,
        stopReason: "cancelled",
        lastUsage: null,
      },
      priorMessages: [userMsg("q")],
    });
    assert.equal(savedFalse, false);
    await assert.rejects(
      () => store.load(file.conversation_id),
      (err: unknown) => (err as { kind?: string }).kind === "not_found",
      "delta=0 不得落盘任何文件"
    );

    // cancelled + delta>0 → true and persisted (consistent with the shouldPersistCheckpoint decision).
    const id2 = "b1-delta1";
    const file2 = sampleFile({
      id: id2,
      overrides: { messages: [], turnCount: 0 },
    });
    const savedTrue = await conditionalSave.call(hub, {
      conversationId: id2,
      session: file2,
      result: {
        finalText: null,
        messages: [userMsg("q")], // delta=1 vs prior []
        turnCount: 0,
        stopReason: "cancelled",
        lastUsage: null,
      },
      priorMessages: [],
    });
    assert.equal(savedTrue, true);
    const persisted = await store.load(id2);
    assert.equal(persisted.messages.length, 1);
    assert.equal(persisted.checkpoints?.[0]?.interruptReason, "cancelled");
  });
});

describe("postMessage answer wire fields — interrupted (B1)", () => {
  it("completed → interrupted 字段缺席(byte-stable)", async () => {
    const hub = makeHub(makeDeps([assistantResult({ texts: ["plain"] })]));
    const { session } = await hub.createSession();
    const res = await hub.postMessage({
      conversationId: session.conversation_id,
      text: "hi",
    });
    assert.equal(res.turn.answer.stopReason, "completed");
    assert.equal("interrupted" in res.turn.answer, false);
    // Key set gains exactly "outcome" (the durable terminal-state view every
    // live answer now carries); nothing else leaks.
    assert.deepEqual(Object.keys(res.turn.answer).sort(), [
      "finalText",
      "outcome",
      "stopReason",
      "turnCount",
    ]);
  });
});

// -- invariant 7: normal typed input keeps the interrupt in the model prior --
// Spec invariant 7 (transport-continue-persist): after Ctrl+C, a NORMALLY
// typed user message must reach the model with the interrupt still in prior.
// Only `/continue` strips a trailing interrupt (invariant 6 / SC3), and that
// strip lives on the continueSession path — this pins the postMessage path so
// a future refactor cannot hoist the strip into shared prior assembly.

describe("invariant 7 — typed input after interrupt keeps the interrupt in prior", () => {
  it("postMessage after an interrupted turn hands adapter.step the interrupt + new text", async () => {
    const interrupt: AnthropicNativeMessage = {
      role: "system",
      content: [{ type: "text", text: "Interrupted by user." }],
    };
    const seeded: AnthropicNativeMessage[] = [
      userMsg("do the thing"),
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "noop", input: {} }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
      },
      interrupt,
    ];
    const inner = makeDeps([assistantResult({ texts: ["resumed"] })]);
    const stepMessages: AnthropicNativeMessage[][] = [];
    const deps: LoopEngineDeps = {
      ...inner,
      adapter: {
        ...inner.adapter,
        step: async (state, request, signal) => {
          stepMessages.push([...state.messages]);
          return inner.adapter.step(state, request, signal);
        },
      },
    };
    const hub = makeHub(deps);
    const { session } = await hub.createSession();
    await store.save({
      id: session.conversation_id,
      file: sampleFile({
        id: session.conversation_id,
        overrides: { messages: seeded, turnCount: 1 },
      }),
    });

    const res = await hub.postMessage({
      conversationId: session.conversation_id,
      text: "carry on",
    });
    assert.equal(res.turn.answer.stopReason, "completed");
    const prior = stepMessages[0] ?? [];
    // The interrupt survives into the model prior — the typed query is not a
    // /continue, so nothing strips it. Ordering matters too: the interrupt
    // precedes the new user text (it is the last thing that happened before).
    const interruptIndex = prior.findIndex(
      (m) =>
        m.role === "system" &&
        m.content.some(
          (b) => b.type === "text" && b.text === "Interrupted by user."
        )
    );
    assert.notEqual(
      interruptIndex,
      -1,
      "interrupt must stay in the typed-input prior"
    );
    const tail = prior[prior.length - 1];
    assert.equal(tail?.role, "user");
    assert.equal(
      tail?.content[0]?.type === "text" ? tail.content[0].text : "",
      "carry on"
    );
    assert.ok(
      interruptIndex < prior.length - 1,
      "interrupt must precede the new typed user message"
    );
    // Disk keeps both the interrupt and the new exchange.
    const loaded = await store.load(session.conversation_id);
    assert.ok(
      loaded.messages.some(
        (m) =>
          m.role === "system" &&
          m.content.some(
            (b) => b.type === "text" && b.text === "Interrupted by user."
          )
      ),
      "disk must keep the interrupt system message"
    );
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
      // The abnormal-stop closing summary re-uses the same never-resolving
      // adapter; shorten the summary's own timeout so this test is not
      // dragged past the 15s default.
      summaryTimeoutMs: 1,
    };
    const hub = makeHub(deps);
    const { session } = await hub.createSession();
    const res = await hub.postMessage({
      conversationId: session.conversation_id,
      text: "trigger timeout",
    });
    assert.equal(res.turn.answer.stopReason, "timeout");
    // T4 (transport-continue-persist): timeout path is UNCHANGED — full
    // persist. The user message from this turn reaches disk (unlike
    // protocolError/emptyFinalResponse, which keep the user but drop the
    // failed assistant).
    const loaded = await store.load(session.conversation_id);
    assert.equal(loaded.messages.length, 1);
    assert.equal(loaded.messages[0]?.role, "user");
    assert.equal(
      loaded.messages[0]?.content[0]?.type === "text"
        ? loaded.messages[0]?.content[0]?.text
        : "",
      "trigger timeout"
    );
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
    // File IS saved (timeout → save).
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

// -- protocolError / emptyFinalResponse → user kept, assistant dropped ------
// Spec invariant 8 / SC4 (transport-continue-persist): the user message from
// a turn that ends in protocolError/emptyFinalResponse is persisted; the
// failed assistant turn is dropped. This block enforces that rule end-to-end
// at the hub boundary.

describe("drop-context stop reasons keep user message only", () => {
  it("protocolError → user message on disk, no assistant turn; checkpoint anchors the kept user message", async () => {
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
    // New invariant: user message is on disk (the failed assistant is not).
    assert.equal(loaded.messages.length, 1);
    assert.equal(loaded.messages[0]?.role, "user");
    assert.equal(
      loaded.messages[0]?.content[0]?.type === "text"
        ? loaded.messages[0]?.content[0]?.text
        : "",
      "trigger protocol error"
    );
    // No assistant turn on disk — only the user message from this turn.
    assert.ok(
      !loaded.messages.some((m) => m.role === "assistant"),
      "failed assistant turn must not reach disk"
    );
    assert.equal(loaded.turnCount, 0);
    // The checkpoint record is deliberate, not incidental: rewind-targets.ts
    // joins `checkpoints` by turnIndex to stamp the picker's anchoredAt, so
    // the kept user message becomes a rewind anchor carrying WHY the turn
    // ended (protocolError) instead of a bare createdAt. `anchorEventId` is
    // derived from messagesCount against the head chain (T5 D3) — it must
    // resolve, or the picker entry would fall back to the raw timestamp.
    assert.equal(loaded.checkpoints?.length, 1);
    const cp = loaded.checkpoints?.[0];
    assert.equal(cp?.interruptReason, "protocolError");
    assert.equal(cp?.messagesCount, 1);
    assert.equal(cp?.turnIndex, 0);
    assert.equal(cp?.anchorEventId, "e0");
    assert.equal(typeof cp?.interruptedAt, "string");
  });

  it("protocolError mid tool loop → tool_result-only continuation is not persisted as an orphan", async () => {
    // The discriminating shape for conditionalSave's partial_user_only arm
    // (hub.ts: `[...diskPrior, ...delta.filter(isTurnQuery)]`): a protocol
    // error that lands AFTER one tool round-trip leaves a delta containing
    // BOTH a genuine user query and a tool_result-only user message. The SSOT
    // predicate (turn-projection.isTurnQuery) keeps only the query; a bare
    // `role === "user"` filter would also keep the tool_result-only message —
    // whose paired assistant tool_use is dropped on this path — and orphan it
    // on disk.
    //
    // Exactly one scripted response (a tool_call) → step 1 appends
    // [assistant(tool_use), user(tool_result)]; step 2 finds the queue empty
    // and throws ProtocolError.
    const deps = makeDeps([
      assistantResult({
        texts: [],
        toolCalls: [{ id: "t1", name: "noop", input: {} }],
      }),
    ]);
    const hub = makeHub(deps);
    const { session } = await hub.createSession();
    const res = await hub.postMessage({
      conversationId: session.conversation_id,
      text: "keep my sentence",
    });
    assert.equal(res.turn.answer.stopReason, "protocolError");
    const loaded = await store.load(session.conversation_id);
    // Exactly the user query — neither the failed assistant tool_use nor the
    // tool_result-only continuation message.
    assert.equal(loaded.messages.length, 1);
    assert.equal(loaded.messages[0]?.role, "user");
    assert.equal(
      loaded.messages[0]?.content[0]?.type === "text"
        ? loaded.messages[0].content[0].text
        : "",
      "keep my sentence"
    );
    assert.ok(
      !loaded.messages.some((m) =>
        m.content.some((b) => b.type === "tool_result")
      ),
      "a tool_result-only user message must not be spliced onto disk as an orphan"
    );
    assert.ok(
      !loaded.messages.some(
        (m) =>
          m.role === "assistant" && m.content.some((b) => b.type === "tool_use")
      ),
      "the failed assistant tool_use must not reach disk"
    );
    // The completed tool round-trip advanced finalState.turnCount; only the
    // failed assistant TEXT turn never entered history.
    assert.equal(loaded.turnCount, 1);
    assert.deepEqual(
      loaded.checkpoints?.map((c) => c.interruptReason),
      ["protocolError"]
    );
  });

  it("emptyFinalResponse → user message on disk, no assistant turn", async () => {
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
    assert.equal(loaded.messages.length, 1);
    assert.equal(loaded.messages[0]?.role, "user");
    assert.equal(
      loaded.messages[0]?.content[0]?.type === "text"
        ? loaded.messages[0]?.content[0]?.text
        : "",
      "trigger empty"
    );
    assert.equal(loaded.turnCount, 0);
  });

  // ADR-0094 SC4-SC5 (viewport API error): hub passes RunResult.apiError
  // through to TurnAnswerDto.apiError (status + message); non-transport
  // failure → field absent (byte-stable). SC4 (transport-continue-persist)
  // keeps the user
  // message on disk for protocolError.
  it("TransportRetryExhaustedError → apiError present in DTO + user message on disk", async () => {
    const apiErrLike = {
      name: "APIError",
      status: 404,
      message:
        '{"error":{"message":"No active credentials for provider: 9router"}}',
    };
    // Build deps whose adapter.step throws TransportRetryExhaustedError.
    const tool = createStubTool({ name: "noop", next: () => ({}) });
    const registry = createRegistry([tool]);
    const executor = createExecutor(registry);
    const failingAdapter: LoopAdapter = {
      encodeUserText: (t: string): AnthropicNativeMessage => ({
        role: "user",
        content: [{ type: "text", text: t }],
      }),
      encodeToolResults: () => [],
      step: async (): Promise<AssistantTurnResult> => {
        throw new TransportRetryExhaustedError(3, apiErrLike);
      },
    };
    const hub = makeHub({
      adapter: failingAdapter,
      executor,
      registry,
      maxTurns: 5,
    });
    const { session } = await hub.createSession();
    const res = await hub.postMessage({
      conversationId: session.conversation_id,
      text: "trigger transport exhausted",
    });
    assert.equal(res.turn.answer.stopReason, "protocolError");
    // apiError field passes through status + message
    assert.deepEqual(res.turn.answer.apiError, {
      status: 404,
      message:
        '{"error":{"message":"No active credentials for provider: 9router"}}',
    });
    // SC4 (transport-continue-persist): user message kept, assistant dropped.
    const loaded = await store.load(session.conversation_id);
    assert.equal(loaded.messages.length, 1);
    assert.equal(loaded.messages[0]?.role, "user");
    assert.equal(
      loaded.messages[0]?.content[0]?.type === "text"
        ? loaded.messages[0]?.content[0]?.text
        : "",
      "trigger transport exhausted"
    );
    assert.equal(loaded.turnCount, 0);
  });

  it("completed → apiError field absent (byte-stable)", async () => {
    const deps = makeDeps([
      assistantResult({
        texts: ["ok"],
        toolCalls: [],
        supplierStop: "success",
      }),
    ]);
    const hub = makeHub(deps);
    const { session } = await hub.createSession();
    const res = await hub.postMessage({
      conversationId: session.conversation_id,
      text: "ok",
    });
    assert.equal(res.turn.answer.stopReason, "completed");
    // Field absent = key not present (byte-stable); must not use res.turn.answer.apiError !== undefined
    assert.equal("apiError" in res.turn.answer, false);
  });
});

// -- getSession / resetSession / listSessions --------------------------------

describe("getSession", () => {
  it("returns title with projected turns (no raw messages)", async () => {
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
// Boundary-class coverage: normal compaction (> keepRecent triggers trimming), idempotent no-op (below threshold, no persist), empty-session no-op, missing session → not_found. DEFAULT_KEEP_RECENT=6, 2 messages per turn (user+assistant), 4 turns = 8 messages → triggers trimming.

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
    // keepRecent=6 tail window + 1 boundary placeholder = 7 messages < 8.
    assert.equal(res.beforeCount, 8);
    assert.equal(res.afterCount, 7);
    // Same conversation id, turnCount is not reset.
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
    assert.equal(after.updatedAt, before.updatedAt); // untouched
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

  it("title 保留 pre-compact 首条 user 意图(review-fix:不被 placeholder/preamble 污染)", async () => {
    // The stub model returns empty for the full-compact prompt → fallback placeholder path.
    // Buggy behavior: title = extractTitle(compacted) = "[compaction boundary..." prefix.
    // Correct behavior: title = extractTitle(before) = first user text ("q0").
    const deps = makeDeps(
      Array.from({ length: 4 }, (_, i) =>
        assistantResult({ texts: [`answer ${i}`] })
      )
    );
    const hub = makeHub(deps);
    const { session } = await hub.createSession();
    await seedTurns(hub, session.conversation_id, 4);
    const res = await hub.compactSession(session.conversation_id);
    assert.equal(res.compacted, true);
    const after = await store.load(session.conversation_id);
    assert.equal(after.title, "q0");
  });

  // opts.onStream passes through to runFullCompact; the host receives the
  // compaction_started / completed sequence; opts.signal not passed → zero
  // behavior change (backward compatible).
  it("opts.onStream 透传:runFullCompact 生命周期事件序列被 host observer 捕获", async () => {
    const deps = makeDeps(
      Array.from({ length: 4 }, (_, i) =>
        assistantResult({ texts: [`answer ${i}`] })
      )
    );
    const hub = makeHub(deps);
    const { session } = await hub.createSession();
    await seedTurns(hub, session.conversation_id, 4);

    const events: string[] = [];
    const res = await hub.compactSession(session.conversation_id, {
      onStream: (e) => events.push(e.type),
    });
    assert.equal(res.compacted, true);
    // The stub model returns empty_response for the full-compact prompt →
    // fallback placeholder; compaction_started + compaction_failed
    // (reason=empty_response) must appear, completed must not (fail does
    // not imply success).
    assert.ok(
      events.includes("compaction_started"),
      "compaction_started 必 emit"
    );
    assert.ok(
      events.includes("compaction_failed"),
      "stub empty_response 走 compaction_failed"
    );
  });

  // Mid-flight opts.signal abort → runFullCompact returns signal_aborted →
  // hub takes the keep-state path (no fallback truncation, no persist, no
  // updatedAt bump) and the response carries cancelled:true — cancel = no
  // change.
  it("opts.signal 中途 abort → compacted=false, cancelled=true,会话保持原样", async () => {
    // 4 turns × 2 msgs = 8 → triggers splitForCompaction (dropped ≠ []),
    // taking the runFullCompact path. stub-model defaults to delayMs=0, no
    // delay; mid-flight abort can still fire — the key timing is microtask
    // first + controller.abort right after. We take the "pre-aborted" path
    // (simpler, more stable): construct an already-aborted signal, and the
    // very first check inside runFullCompact in hub.compactSession returns
    // signal_aborted immediately.
    const deps = makeDeps(
      Array.from({ length: 4 }, (_, i) =>
        assistantResult({ texts: [`answer ${i}`] })
      )
    );
    const hub = makeHub(deps);
    const { session } = await hub.createSession();
    await seedTurns(hub, session.conversation_id, 4);

    const before = await store.load(session.conversation_id);
    const controller = new AbortController();
    controller.abort(); // pre-aborted → runFullCompact early-returns signal_aborted

    const res = await hub.compactSession(session.conversation_id, {
      signal: controller.signal,
    });
    assert.equal(res.compacted, false, "取消不算实际裁剪");
    assert.equal(
      res.cancelled,
      true,
      "cancelled:true 区分于未达阈值的 compacted=false"
    );
    assert.equal(res.beforeCount, before.messages.length);
    assert.equal(res.afterCount, before.messages.length);

    // Session stays as-is: the persisted file is untouched (updatedAt unchanged, messages unchanged).
    const after = await store.load(session.conversation_id);
    assert.equal(after.updatedAt, before.updatedAt, "未 bump updatedAt");
    assert.equal(after.messages.length, before.messages.length, "未裁剪");
    assert.equal(after.turnCount, before.turnCount, "turnCount 不重置");
  });

  // opts.onStream absent → zero behavior change (old call sites intact);
  // on the stub empty_response path the fallback truncation runs, compacted:true.
  it("opts 缺席 → 行为零变化(compat 旧调用点)", async () => {
    const deps = makeDeps(
      Array.from({ length: 4 }, (_, i) =>
        assistantResult({ texts: [`answer ${i}`] })
      )
    );
    const hub = makeHub(deps);
    const { session } = await hub.createSession();
    await seedTurns(hub, session.conversation_id, 4);

    const res = await hub.compactSession(session.conversation_id);
    assert.equal(res.compacted, true);
    assert.equal(res.cancelled, undefined, "未取消时 cancelled 缺席");
  });
});

describe("postMessage title projection", () => {
  it("recomputes title instead of preserving a dirty value", async () => {
    const hub = makeHub(makeDeps([assistantResult({ texts: ["answer"] })]));
    const { session } = await hub.createSession();
    // #629: legacy `.json` mirror is no longer written. Inject a stale title
    // by rewriting the JSONL header record in place (the authority file).
    const path = join(
      resolveConversationDir({
        projectDir: sessionDir,
        conversationId: session.conversation_id,
      }),
      `${session.conversation_id}${SESSION_JSONL_EXT}`
    );
    const raw = await readFile(path, "utf8");
    const lines = raw.split("\n");
    const headerLine = lines[0]!;
    const header = JSON.parse(headerLine) as Record<string, unknown>;
    header["title"] = "dirty";
    lines[0] = JSON.stringify(header);
    await writeFile(path, lines.join("\n"), "utf8");
    await hub.postMessage({
      conversationId: session.conversation_id,
      text: "hello",
    });
    // Reload sees the recomputed title; the JSONL header is the only shape
    // carrying metadata.
    const saved = await store.load(session.conversation_id);
    assert.equal(saved.title, "hello");
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
    assert.equal(entry.title, "hello");
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

  // Machine-assembled skill-load messages (`[skill-load name="<id>"]\n<body>`
  // — the only join shape in TUI app.tsx and Web use-slash-commands.ts)
  // skip the user-input length cap, symmetric with the model-side tool
  // result channel having no character limit. A 78KB SKILL.md loaded in one
  // shot would instantly hit the 8000 cap — without the exemption the
  // skill-load slash path is unusable. It must actually reach the stub
  // model response (no ValidationError thrown).
  it("accepts machine-assembled skill-load message exceeding MAX_MESSAGE_CHARS", async () => {
    const deps = makeDeps([assistantResult({ texts: ["ok"] })]);
    const hub = makeHub(deps);
    const { session } = await hub.createSession();
    const longText = `[skill-load name="foo"]\n${"x".repeat(50_000)}`;
    const res = await hub.postMessage({
      conversationId: session.conversation_id,
      text: longText,
    });
    assert.equal(res.turn.answer.finalText, "ok");
  });

  // Half-cut prefix (no closing double quote) must be rejected even when
  // overlong, otherwise hand-typed malicious text bypasses the 8000-cap
  // exemption.
  it("rejects a half-prefixed long text (no closing quote) (review Medium 3)", async () => {
    const deps = makeDeps([]);
    const hub = makeHub(deps);
    const { session } = await hub.createSession();
    const halfPrefixed = `[skill-load name="${"x".repeat(50_000)}`;
    await assert.rejects(
      () =>
        hub.postMessage({
          conversationId: session.conversation_id,
          text: halfPrefixed,
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
      "outcome",
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
      "outcome",
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

// -- #1079 T5: lastUsage persistence + reopen replay -------------------------

describe("session file persist — lastUsage replay on reopen (#1079 T5)", () => {
  it("successful usage turn → persisted file carries lastUsage; getSession replays it on the last turn", async () => {
    const usage = {
      inputTokens: 12800,
      outputTokens: 7,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: 2048,
    };
    const deps = makeDeps([assistantResult({ texts: ["done"], usage })]);
    const hub = makeHub(deps);
    const { session } = await hub.createSession();
    await hub.postMessage({
      conversationId: session.conversation_id,
      text: "x",
    });
    const file = await store.load(session.conversation_id);
    assert.deepEqual(file.lastUsage, usage);
    const { turns } = await hub.getSession(session.conversation_id);
    assert.ok(turns.length > 0);
    const lastAnswer = turns[turns.length - 1]!.answer as unknown as Record<
      string,
      unknown
    >;
    assert.deepEqual(lastAnswer.lastUsage, usage);
  });

  it("turn without usage → file has no lastUsage key; getSession turns omit it (0% posture)", async () => {
    const deps = makeDeps([assistantResult({ texts: ["plain"] })]);
    const hub = makeHub(deps);
    const { session } = await hub.createSession();
    await hub.postMessage({
      conversationId: session.conversation_id,
      text: "x",
    });
    const file = await store.load(session.conversation_id);
    assert.equal("lastUsage" in file, false);
    const { turns } = await hub.getSession(session.conversation_id);
    const lastAnswer = turns[turns.length - 1]!.answer as unknown as Record<
      string,
      unknown
    >;
    assert.equal("lastUsage" in lastAnswer, false);
  });

  it("a later usage-less turn keeps the earlier persisted reading (never regresses to absent)", async () => {
    const usage = {
      inputTokens: 999,
      outputTokens: 1,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: null,
    };
    const hub = makeHub(makeDeps([assistantResult({ texts: ["a"], usage })]));
    const { session } = await hub.createSession();
    await hub.postMessage({
      conversationId: session.conversation_id,
      text: "first",
    });
    const hub2 = makeHub(makeDeps([assistantResult({ texts: ["b", "c"] })]));
    await hub2.postMessage({
      conversationId: session.conversation_id,
      text: "second",
    });
    const file = await store.load(session.conversation_id);
    assert.deepEqual(file.lastUsage, usage);
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
      workspaceRoot: process.cwd(),
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
      workspaceRoot: process.cwd(),
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
    // No onStream → opts.onStream is undefined; hub passes undefined to run();
    // the stub's onStream is also undefined, so emit is a no-op (no throw in
    // the side-effect path). This case guards the backward-compat contract
    // "zero behavior change without onStream".
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

// -- In-turn commit (write while running) -------------------------------------

describe("T3 (#620): turn 内 commit — hub 注入 commitMessages 钩子", () => {
  it("工具执行时 assistant 事件已落在盘上 JSONL(commit 先于工具,不绕开 serialize 队列)", async () => {
    // The probe tool reads the on-disk JSONL inside runOne: the assistant
    // commit must land before tool execution. Assertions go outside the
    // tool (a throw inside gets swallowed into execution_failed by the
    // executor, which would mask a false green).
    const idRef: { current: string | null } = { current: null };
    const observed: Array<{
      readonly events: number;
      readonly head: string | null;
      readonly lastRole: string;
    }> = [];
    const probe = createStubTool({
      name: "probe",
      next: async () => {
        const raw = await readFile(
          join(
            resolveConversationDir({
              projectDir: sessionDir,
              conversationId: idRef.current ?? "",
            }),
            `${idRef.current}.jsonl`
          ),
          "utf8"
        );
        const log = parseSessionJsonl(raw);
        observed.push({
          events: log.events.length,
          head: log.head,
          lastRole: log.events[log.events.length - 1]?.message.role ?? "none",
        });
        return "observed";
      },
    });
    const registry = createRegistry([probe]);
    const deps: LoopEngineDeps = {
      adapter: createStubModel({
        responses: [
          assistantResult({
            texts: [],
            toolCalls: [{ id: "p1", name: "probe", input: {} }],
          }),
          assistantResult({ texts: ["done"], supplierStop: "success" }),
        ],
      }),
      executor: createExecutor(registry),
      registry,
      maxTurns: 5,
    };
    const hub = makeHub(deps);
    const { session } = await hub.createSession();
    idRef.current = session.conversation_id;

    const res = await hub.postMessage({
      conversationId: session.conversation_id,
      text: "go",
    });
    assert.equal(res.turn.answer.stopReason, "completed");

    // Moment of tool execution: disk holds exactly 2 events — the
    // user query lands with the first engine commit (alignment prerequisite
    // for append-only save), then assistant (with tool_use); head → assistant.
    assert.equal(observed.length, 1);
    assert.equal(observed[0]!.events, 2);
    assert.equal(observed[0]!.lastRole, "assistant");
    assert.equal(observed[0]!.head, "e1");

    // After the closing save rewrites the whole log, the final transcript
    // matches pre-existing behavior (4 messages).
    const loaded = await store.load(session.conversation_id);
    assert.equal(loaded.messages.length, 4);
    const raw = await readFile(
      join(
        resolveConversationDir({
          projectDir: sessionDir,
          conversationId: session.conversation_id,
        }),
        `${session.conversation_id}.jsonl`
      ),
      "utf8"
    );
    const log = parseSessionJsonl(raw);
    assert.equal(log.events.length, 4);
    assert.equal(log.head, "e3");
  });

  it("legacy .json-only 会话:首次 commit 触发 bootstrap 迁出 JSONL,run 正常完成", async () => {
    // Pre-upgrade legacy: disk has only <id>.json (no .jsonl). appendEvents
    // throws write_failed straight on legacy; the hub hook must first
    // full-save into JSONL, then retry — else a legacy session could never
    // run again. The probe tool reads the on-disk JSONL inside runOne to
    // prove bootstrap + commit finished before tool execution (assertions go
    // outside the tool: a throw inside gets swallowed by the executor,
    // masking a false green).
    const id = "legacy-only-t3";
    const dir = resolveConversationDir({
      projectDir: sessionDir,
      conversationId: id,
    });
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, `${id}.json`),
      JSON.stringify(
        sampleFile({
          id,
          overrides: {
            messages: [
              userMsg("old q"),
              { role: "assistant", content: [{ type: "text", text: "old a" }] },
            ],
            turnCount: 1,
          },
        })
      ),
      "utf8"
    );
    const observed: Array<{
      readonly events: number;
      readonly head: string | null;
      readonly roles: string[];
    }> = [];
    const probe = createStubTool({
      name: "probe",
      next: async () => {
        const raw = await readFile(join(dir, `${id}.jsonl`), "utf8");
        const log = parseSessionJsonl(raw);
        observed.push({
          events: log.events.length,
          head: log.head,
          roles: log.events.map((e) => e.message.role),
        });
        return "observed";
      },
    });
    const registry = createRegistry([probe]);
    const deps: LoopEngineDeps = {
      adapter: createStubModel({
        responses: [
          assistantResult({
            texts: [],
            toolCalls: [{ id: "p1", name: "probe", input: {} }],
          }),
          assistantResult({ texts: ["new answer"], supplierStop: "success" }),
        ],
      }),
      executor: createExecutor(registry),
      registry,
      maxTurns: 5,
    };
    const hub = makeHub(deps);
    const res = await hub.postMessage({ conversationId: id, text: "new q" });
    assert.equal(res.turn.answer.stopReason, "completed");

    // Moment of tool execution: legacy migrated to JSONL — old 2 events +
    // this user query + assistant (query lands with the first engine commit),
    // head → new assistant.
    assert.equal(observed.length, 1);
    assert.equal(observed[0]!.events, 4);
    assert.deepEqual(observed[0]!.roles, [
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    assert.equal(observed[0]!.head, "e3");

    // After the closing save: old 2 + new 4 (user query + assistant(tool_use)
    // + user(tool_result) + assistant final); event chain intact, turnCount
    // accumulates.
    const loaded = await store.load(id);
    assert.equal(loaded.messages.length, 6);
    assert.equal(loaded.turnCount, 3);
    const raw = await readFile(join(dir, `${id}.jsonl`), "utf8");
    const log = parseSessionJsonl(raw);
    assert.equal(log.events.length, 6);
    assert.equal(log.head, "e5");
    assert.equal(log.events[0]!.message.role, "user");
    assert.equal(log.events[5]!.message.role, "assistant");
  });
});

// -- rewind moves head, old chain retained -------------------------------------

describe("T5 (#622): hub.rewindSession 移动 head、skipped 链保留", () => {
  const textOf = (m: AnthropicNativeMessage): string => {
    const b = m.content[0];
    return b !== undefined && b.type === "text" ? b.text : "";
  };

  it("rewind → reload head 停在锚点;新 turn 从 rewind 头续链,skipped 分支永留同一份 JSONL", async () => {
    const deps = makeDeps([
      assistantResult({ texts: ["a1"] }),
      assistantResult({ texts: ["a2"] }),
      assistantResult({ texts: ["a3"] }),
    ]);
    const hub = makeHub(deps);
    const { session } = await hub.createSession();
    const id = session.conversation_id;
    await hub.postMessage({ conversationId: id, text: "q1" });
    await hub.postMessage({ conversationId: id, text: "q2" });

    // 2 turns on disk: e0=q1 e1=a1 e2=q2 e3=a2, head e3.
    const jsonlFile = join(
      resolveConversationDir({ projectDir: sessionDir, conversationId: id }),
      `${id}.jsonl`
    );
    const before = parseSessionJsonl(await readFile(jsonlFile, "utf8"));
    assert.equal(before.events.length, 4);
    assert.equal(before.head, "e3");

    const res = await hub.rewindSession(id, "e1");
    assert.equal(res.head, "e1");
    assert.equal(res.session.turn_count, 1);
    assert.equal(res.turns.length, 1);

    // Head moved to the anchor; nothing truncated.
    const mid = parseSessionJsonl(await readFile(jsonlFile, "utf8"));
    assert.equal(mid.head, "e1");
    assert.equal(mid.events.length, 4);

    // New turn after the rewind: skipped branch stays in the SAME file; the
    // new chain parents from the rewound head with fresh ids.
    await hub.postMessage({ conversationId: id, text: "q3" });
    const after = parseSessionJsonl(await readFile(jsonlFile, "utf8"));
    assert.equal(after.events.length, 6);
    const byId = new Map(after.events.map((e) => [e.id, e]));
    assert.ok(byId.has("e2") && byId.has("e3"), "skipped branch retained");
    assert.equal(
      byId.get("e4")?.parent,
      "e1",
      "new chain parents from the rewound head"
    );
    assert.equal(byId.get("e5")?.parent, "e4");
    assert.equal(after.head, "e5");

    const loaded = await store.load(id);
    assert.deepEqual(
      loaded.messages.map((m) => `${m.role}:${textOf(m)}`),
      ["user:q1", "assistant:a1", "user:q3", "assistant:a3"]
    );
    assert.equal(loaded.turnCount, 2);
  });

  it("cross-entry: hub rewind → 独立 SessionStore 实例读到同一 head(#120 Q6)", async () => {
    const deps = makeDeps([
      assistantResult({ texts: ["a1"] }),
      assistantResult({ texts: ["a2"] }),
    ]);
    const hub = makeHub(deps);
    const { session } = await hub.createSession();
    const id = session.conversation_id;
    await hub.postMessage({ conversationId: id, text: "q1" });
    await hub.postMessage({ conversationId: id, text: "q2" });

    await hub.rewindSession(id, "e1");

    // A second store instance over the same pool (another entry point) sees
    // the same head and the same projection.
    const storeB = new SessionStore(baseDir, process.cwd());
    assert.equal(await storeB.readHead(id), "e1");
    const loaded = await storeB.load(id);
    assert.deepEqual(
      loaded.messages.map((m) => `${m.role}:${textOf(m)}`),
      ["user:q1", "assistant:a1"]
    );
    assert.equal(loaded.turnCount, 1);
  });

  it("legacy .json-only 会话:hub.rewindSession 先迁移出 JSONL 再移动 head", async () => {
    const id = "legacy-rewind-t5";
    const dir = resolveConversationDir({
      projectDir: sessionDir,
      conversationId: id,
    });
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, `${id}.json`),
      JSON.stringify(
        sampleFile({
          id,
          overrides: {
            messages: [
              userMsg("q1"),
              {
                role: "assistant",
                content: [{ type: "text", text: "a1" }],
              },
              userMsg("q2"),
              {
                role: "assistant",
                content: [{ type: "text", text: "a2" }],
              },
            ],
            turnCount: 2,
          },
        })
      ),
      "utf8"
    );
    const hub = makeHub(makeDeps([]));
    const res = await hub.rewindSession(id, "e1");
    assert.equal(res.head, "e1");
    assert.equal(res.session.turn_count, 1);
    // Migrated: the jsonl now exists, head at the anchor, all events retained.
    const log = parseSessionJsonl(
      await readFile(join(dir, `${id}.jsonl`), "utf8")
    );
    assert.equal(log.head, "e1");
    assert.equal(log.events.length, 4);
    const loaded = await store.load(id);
    assert.equal(loaded.messages.length, 2);
    assert.equal(loaded.turnCount, 1);
  });
});

// -- T4: durable terminal turn outcome (SC7 / SC14 persistence half) ----------

describe("turn outcome persistence (SC7 / SC14)", () => {
  const outcomeRecords = async (
    id: string
  ): Promise<Array<Record<string, unknown>>> => {
    const dir = resolveConversationDir({
      projectDir: sessionDir,
      conversationId: id,
    });
    const raw = await readFile(join(dir, `${id}${SESSION_JSONL_EXT}`), "utf8");
    return raw
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((r) => r["type"] === "outcome");
  };
  const lastHead = async (id: string): Promise<string | null> =>
    store.readHead(id);

  it("a settled completed turn appends exactly one outcome anchored to the persisted head", async () => {
    const hub = makeHub(makeDeps([assistantResult({ texts: ["hi"] })]));
    const { session } = await hub.createSession();
    const id = session.conversation_id;
    await hub.postMessage({ conversationId: id, text: "hello" });

    const outcomes = await outcomeRecords(id);
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0]!["stopReason"], "completed");
    assert.equal(outcomes[0]!["turnId"], await lastHead(id));

    // Reopen projects the authoritative outcome (known → completed), not a synthesis.
    const res = await hub.getSession(id);
    assert.equal(res.turns.length, 1);
    assert.equal(res.turns[0]!.answer.stopReason, "completed");
    assert.deepEqual(res.turns[0]!.answer.outcome, {
      terminal: "known",
      stopReason: "completed",
    });
  });

  it("reopen with a missing outcome projects unknown and does not synthesize completed (SC7)", async () => {
    // Legacy transcript: messages present, no outcome record at all.
    const id = "outcome-legacy-reopen";
    const dir = resolveConversationDir({
      projectDir: sessionDir,
      conversationId: id,
    });
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, `${id}${SESSION_JSONL_EXT}`),
      [
        JSON.stringify({
          type: "session",
          schemaVersion: CURRENT_SCHEMA_VERSION,
          conversation_id: id,
          title: "q",
          cwd: "/tmp/test",
          sanitized_at: "2026-01-01T00:00:00.000Z",
          jsonMode: false,
          turnCount: 1,
          updatedAt: "2026-01-01T00:00:00.000Z",
          checkpoints: [],
          workspaceRoot: process.cwd(),
        }),
        JSON.stringify({
          type: "message",
          id: "e0",
          parent: null,
          message: userMsg("q"),
        }),
        JSON.stringify({
          type: "message",
          id: "e1",
          parent: "e0",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "a" }],
          },
        }),
        JSON.stringify({ type: "head", id: "e1" }),
      ].join("\n") + "\n",
      "utf8"
    );
    const hub = makeHub(makeDeps([]));
    const res = await hub.getSession(id);
    assert.equal(res.turns.length, 1);
    const answer = res.turns[0]!.answer as unknown as Record<string, unknown>;
    // Unknown is carried independently of StopReason; no fabricated completed.
    assert.deepEqual(answer["outcome"], { terminal: "unknown" });
    assert.equal("stopReason" in answer, false);
  });

  it("/continue settles with no new human message and still appends exactly one outcome (SC7)", async () => {
    const hub = makeHub(makeDeps([assistantResult({ texts: ["continued"] })]));
    const { session } = await hub.createSession();
    const id = session.conversation_id;
    await store.save({
      id,
      file: sampleFile({
        id,
        overrides: {
          turnCount: 1,
          messages: [
            userMsg("do"),
            {
              role: "assistant",
              content: [
                { type: "tool_use", id: "t1", name: "noop", input: {} },
              ],
            },
            {
              role: "user",
              content: [
                { type: "tool_result", tool_use_id: "t1", content: "ok" },
              ],
            },
          ],
        },
      }),
    });

    const res = await hub.continueSession(id);
    assert.equal(res.turn.answer.stopReason, "completed");

    const outcomes = await outcomeRecords(id);
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0]!["stopReason"], "completed");
    // Identity is the turn's terminal message event, not a newly appended query.
    assert.equal(outcomes[0]!["turnId"], await lastHead(id));
    const loaded = await store.load(id);
    assert.equal(loaded.messages.length, 4);
    assert.equal(loaded.messages[3]!.role, "assistant");
  });

  it("injected outcome-append failure surfaces typed persistence failure and never reports completed (SC14)", async () => {
    const hub = makeHub(makeDeps([assistantResult({ texts: ["hi"] })]));
    const { session } = await hub.createSession();
    const id = session.conversation_id;
    const spy = vi.spyOn(store, "appendOutcome").mockRejectedValue({
      kind: "write_failed",
      conversation_id: id,
      cause: "injected",
    } satisfies SessionStoreError);
    try {
      await assert.rejects(
        () => hub.postMessage({ conversationId: id, text: "hello" }),
        (err: unknown) => (err as SessionStoreError).kind === "write_failed"
      );
    } finally {
      spy.mockRestore();
    }
    // The turn is NOT reported completed anywhere; the messages landed but the
    // terminal outcome did not (the crash-before-outcome shape).
    const outcomes = await outcomeRecords(id);
    assert.equal(outcomes.length, 0);
    const res = await hub.getSession(id);
    assert.equal(res.turns.length, 1);
    const answer = res.turns[0]!.answer as unknown as Record<string, unknown>;
    assert.deepEqual(answer["outcome"], { terminal: "unknown" });
    assert.equal("stopReason" in answer, false);
  });
});

// -- T5/T6: settled truncation turn persists its supplier-stop detail ---------

describe("turn outcome supplier-stop detail (output-limit truncation)", () => {
  const outcomeRecordsOf = async (
    id: string
  ): Promise<Array<Record<string, unknown>>> => {
    const dir = resolveConversationDir({
      projectDir: sessionDir,
      conversationId: id,
    });
    const raw = await readFile(join(dir, `${id}${SESSION_JSONL_EXT}`), "utf8");
    return raw
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((r) => r["type"] === "outcome");
  };

  it("a settled truncation turn records nonSuccessStop with detail truncation, live and reopened", async () => {
    const hub = makeHub(
      makeDeps([
        assistantResult({
          texts: ["partial answer cut off"],
          toolCalls: [{ id: "toolu_a", name: "noop", input: {} }],
          supplierStop: "truncation",
        }),
      ])
    );
    const { session } = await hub.createSession();
    const id = session.conversation_id;
    const res = await hub.postMessage({ conversationId: id, text: "go" });

    assert.equal(res.turn.answer.stopReason, "nonSuccessStop");

    const outcomes = await outcomeRecordsOf(id);
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0]!["stopReason"], "nonSuccessStop");
    assert.equal(outcomes[0]!["supplierDetail"], "truncation");
    assert.equal(outcomes[0]!["turnId"], await store.readHead(id));

    const reopened = await hub.getSession(id);
    assert.equal(
      reopened.turns.length,
      1,
      "the closeout opens no new human turn"
    );
    assert.deepEqual(reopened.turns[0]!.answer.outcome, {
      terminal: "known",
      stopReason: "nonSuccessStop",
      supplierDetail: "truncation",
    });
  });

  it("a protocolError stop persists no supplier detail (the field is never synthesized)", async () => {
    const hub = makeHub(
      makeDeps([assistantResult({ texts: ["hi"], supplierStop: "success" })])
    );
    const { session } = await hub.createSession();
    const id = session.conversation_id;
    await hub.postMessage({ conversationId: id, text: "go" });

    const outcomes = await outcomeRecordsOf(id);
    assert.equal(outcomes.length, 1);
    assert.equal("supplierDetail" in outcomes[0]!, false);
  });

  it("injected outcome-append failure on a truncation turn surfaces typed failure and never completes (SC14)", async () => {
    const hub = makeHub(
      makeDeps([
        assistantResult({
          texts: ["partial answer cut off"],
          toolCalls: [{ id: "toolu_a", name: "noop", input: {} }],
          supplierStop: "truncation",
        }),
      ])
    );
    const { session } = await hub.createSession();
    const id = session.conversation_id;
    const spy = vi.spyOn(store, "appendOutcome").mockRejectedValue({
      kind: "write_failed",
      conversation_id: id,
      cause: "injected",
    } satisfies SessionStoreError);
    try {
      await assert.rejects(
        () => hub.postMessage({ conversationId: id, text: "go" }),
        (err: unknown) => (err as SessionStoreError).kind === "write_failed"
      );
    } finally {
      spy.mockRestore();
    }
    const outcomes = await outcomeRecordsOf(id);
    assert.equal(outcomes.length, 0);
    const res = await hub.getSession(id);
    assert.deepEqual(res.turns[0]!.answer.outcome, { terminal: "unknown" });
    assert.notEqual(res.turns[0]!.answer.stopReason, "completed");
  });

  it("output-limit notice rides live and reopened answers byte-identically and never reaches the transcript", async () => {
    const hub = makeHub(
      makeDeps([
        assistantResult({
          texts: ["partial answer cut off"],
          toolCalls: [{ id: "toolu_a", name: "noop", input: {} }],
          supplierStop: "truncation",
        }),
      ])
    );
    const { session } = await hub.createSession();
    const id = session.conversation_id;
    const live = await hub.postMessage({ conversationId: id, text: "go" });

    assert.equal(live.turn.answer.outputLimitNotice, OUTPUT_LIMIT_NOTICE);

    const reopened = await hub.getSession(id);
    assert.equal(reopened.turns.length, 1);
    // One wire string for both surfaces: clients render it verbatim.
    assert.equal(
      reopened.turns[0]!.answer.outputLimitNotice,
      live.turn.answer.outputLimitNotice
    );

    // The notice is a DTO-only projection: no transcript line holds it, so
    // neither the persisted messages nor any model replay can.
    const dir = resolveConversationDir({
      projectDir: sessionDir,
      conversationId: id,
    });
    const raw = await readFile(join(dir, `${id}${SESSION_JSONL_EXT}`), "utf8");
    assert.equal(raw.includes(OUTPUT_LIMIT_NOTICE), false);
  });

  it("known non-truncation stop carries no notice on either surface", async () => {
    const hub = makeHub(
      makeDeps([assistantResult({ texts: ["no"], supplierStop: "refusal" })])
    );
    const { session } = await hub.createSession();
    const id = session.conversation_id;
    const live = await hub.postMessage({ conversationId: id, text: "go" });

    assert.equal("outputLimitNotice" in live.turn.answer, false);
    assert.deepEqual(live.turn.answer.outcome, {
      terminal: "known",
      stopReason: "nonSuccessStop",
      supplierDetail: "refusal",
    });

    const reopened = await hub.getSession(id);
    assert.equal("outputLimitNotice" in reopened.turns[0]!.answer, false);
  });

  it("legacy transcript with no outcome lines: no notice, no stopReason, outcome unknown", async () => {
    const hub = makeHub(makeDeps([]));
    const { session } = await hub.createSession();
    const id = session.conversation_id;
    await store.save({
      id,
      file: sampleFile({
        id,
        overrides: {
          turnCount: 1,
          messages: [
            userMsg("q"),
            { role: "assistant", content: [{ type: "text", text: "a" }] },
          ],
        },
      }),
    });

    const res = await hub.getSession(id);
    const answer = res.turns[0]!.answer as unknown as Record<string, unknown>;
    assert.equal("outputLimitNotice" in answer, false);
    assert.equal("stopReason" in answer, false);
    assert.deepEqual(answer["outcome"], { terminal: "unknown" });
  });
});
