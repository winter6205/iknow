/**
 * Regression coverage for the interactive chat host's busy → idle transition.
 *
 * A terminal notice received during a parent turn must remain pending and
 * start the silent wake as soon as that turn becomes idle, without another
 * user line.
 *
 * ADR-0150 (exactly-once delivery): the wake and query rounds CLAIM a
 * terminal generation and acknowledge it only when a checkpoint write that
 * actually carries the digest lands. A failed, skipped (`none`) or
 * non-carrier (`partial_user_only`) save releases the claim, so a later round
 * offers the result again — and no second round re-publishes a delivered one.
 */
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AnthropicNativeMessage,
  AssistantTurnResult,
  LoopEngineDeps,
} from "../../src/harness/index.ts";
import type { SubAgentManager } from "../../src/harness/subagent/manager.ts";
import type { SubAgentTerminalNotice } from "../../src/harness/subagent/mailbox.ts";
import {
  createDeliveryLedger,
  deliveryKey,
  type ClaimedDelivery,
} from "../../src/harness/subagent/delivery-ledger.ts";
import type { SubAgentEnvelope } from "../../src/harness/subagent/envelope.ts";
import { formatDrainedResults } from "../../src/harness/subagent/host-drain.ts";
import { deriveProjectIdentityRoot } from "../../src/harness/session-roots.ts";
import {
  CURRENT_SCHEMA_VERSION,
  resolveConversationDir,
  SessionStore,
} from "../../src/session-api/store/index.ts";
import {
  processChatLine,
  runChatSubagentWake,
  type ChatLineContext,
} from "../../src/cli/chat-session.ts";
import {
  assistantResult as fixtureAssistantResult,
  makeCtx,
  makeDeps,
} from "./_fixtures.ts";

const mockState = vi.hoisted(() => ({
  readline: {
    createInterface: vi.fn(),
  },
  sessionIo: {
    clearErrLine: vi.fn(),
    isInteractive: vi.fn(() => true),
    writeErr: vi.fn(),
    writeOut: vi.fn(),
  },
}));

vi.mock("node:readline", () => mockState.readline);
vi.mock("../../src/cli/session-io.ts", () => mockState.sessionIo);

class FakeReadline extends EventEmitter {
  readonly pause = vi.fn();
  readonly prompt = vi.fn();
  readonly resume = vi.fn();
  readonly setPrompt = vi.fn();

  close(): void {
    this.emit("close");
  }
}

function assistantResult(text: string): AssistantTurnResult {
  const nativeMessage: AnthropicNativeMessage = {
    role: "assistant",
    content: [{ type: "text", text }],
  };
  return {
    nativeMessage,
    projection: { nativeMessage, texts: [text], toolCalls: [] },
    supplierStop: "success",
    needsTools: false,
    hasThinking: false,
    isEmptyFinalResponse: false,
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function managerWithTerminalNotice(): {
  readonly manager: SubAgentManager;
  readonly publish: (notice: SubAgentTerminalNotice) => void;
  readonly markTerminal: () => void;
} {
  const subscribers = new Set<(notice: SubAgentTerminalNotice) => void>();
  let terminal = false;
  const manager = {
    spawn: () => ({ taskId: "unused" }),
    queryBuffer: () => ({ status: "not_found" as const }),
    waitFor: async () => {
      throw new Error("unused");
    },
    shutdown: async () => {},
    drainCompleted: () =>
      terminal
        ? [
            {
              taskId: "child-1",
              envelope: {
                status: "ok" as const,
                summary: "child complete",
                result: "child result",
              },
            },
          ]
        : [],
    listActive: () => [],
    abortTask: () => false,
    getCapacity: () => 15,
    listSubagents: () => [],
    subscribe: (subscriber: (notice: SubAgentTerminalNotice) => void) => {
      subscribers.add(subscriber);
      return () => subscribers.delete(subscriber);
    },
    // No claim seam on purpose: this fixture models a wake-only manager, so
    // host-drain falls back to the read-only path (ADR-0150).
  } as unknown as SubAgentManager;
  return {
    manager,
    markTerminal: () => {
      terminal = true;
    },
    publish: (notice) => {
      for (const subscriber of [...subscribers]) subscriber(notice);
    },
  };
}

describe("interactive chat subagent wake", () => {
  let baseDir: string;
  let workspaceRoot: string;

  beforeEach(async () => {
    // Fresh temp store root + workspace so the wake run commits into a temp
    // tree, never ~/.iknow or the real repo project slug.
    baseDir = await mkdtemp(join(tmpdir(), "iknow-chat-wake-"));
    workspaceRoot = await mkdtemp(join(tmpdir(), "iknow-chat-wake-root-"));
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it("flushes a pending terminal wake when the parent turn becomes idle", async () => {
    const readline = new FakeReadline();
    mockState.readline.createInterface.mockReturnValue(readline);

    const firstStepStarted = deferred<void>();
    const releaseFirstStep = deferred<AssistantTurnResult>();
    const managerFixture = managerWithTerminalNotice();
    const deps = makeDeps([
      fixtureAssistantResult({ texts: ["unused"] }),
      fixtureAssistantResult({ texts: ["unused"] }),
    ]);
    let stepCalls = 0;
    const baseAdapter = deps.adapter;
    // LoopEngineDeps.adapter is readonly; the wrapped adapter is a new deps
    // object handed to runChatSession below, not a mutation of `deps`.
    const wakeDeps = {
      ...deps,
      adapter: {
        ...baseAdapter,
        step: async () => {
          stepCalls += 1;
          if (stepCalls === 1) {
            firstStepStarted.resolve();
            return releaseFirstStep.promise;
          }
          return assistantResult("silent wake answer");
        },
      },
    };

    const { runChatSession } = await import("../../src/cli/chat-session.ts");
    const conversationId = randomUUID();
    const sessionPromise = runChatSession({
      deps: wakeDeps,
      session: {},
      jsonMode: false,
      subagentManager: managerFixture.manager,
      dataDir: baseDir,
      conversationId,
      workspaceRoot,
    });
    await vi.waitFor(() =>
      expect(mockState.readline.createInterface).toHaveBeenCalledTimes(1)
    );
    readline.emit("line", "parent question");
    await firstStepStarted.promise;

    managerFixture.markTerminal();
    managerFixture.publish({
      taskId: "child-1",
      status: "ok",
      summary: "child complete",
      result: "child result",
    });
    releaseFirstStep.resolve(assistantResult("parent answer"));

    await vi.waitFor(() => expect(stepCalls).toBe(2));
    await vi.waitFor(() =>
      expect(mockState.sessionIo.writeOut).toHaveBeenCalledWith(
        expect.stringContaining("silent wake answer")
      )
    );

    readline.close();
    await sessionPromise;

    // Positive isolation proof (issue #1197 cause 1): the wake session
    // committed into the temp dataDir namespace — the exact
    // (resolveServeDataDir(dataDir), deriveProjectIdentityRoot({ cwd })) pair
    // chat-session.ts builds, not ~/.iknow or the real repo project slug.
    // load() is title-agnostic, so this asserts persistence without leaning on
    // list()'s #1197 blank-title filter.
    const reader = new SessionStore(
      baseDir,
      deriveProjectIdentityRoot({ cwd: workspaceRoot })
    );
    const persisted = await reader.load(conversationId);
    const transcriptText = persisted.messages
      .flatMap((message) => message.content)
      .filter((block) => block.type === "text")
      .map((block) => (block as { text: string }).text)
      .join("\n");
    expect(transcriptText).toContain("parent answer");
    expect(transcriptText).toContain("silent wake answer");
  });
});

/* -------------------------------------------------------------------------- *
 * ADR-0150 — exactly-once sub-agent result delivery on the chat side.
 * -------------------------------------------------------------------------- */

const DELIVERY_TASK_ID = "child-1";
/** Parent-visible summary; it is both the digest header and its body. */
const DELIVERY_SUMMARY = "child summary 4f1c9a";

function deliveryEnvelope(): SubAgentEnvelope {
  return {
    status: "ok",
    summary: DELIVERY_SUMMARY,
    result: "child body",
  };
}

/** The exact text the production formatter condenses the fixture into. */
const DELIVERY_DIGEST = formatDrainedResults([
  { taskId: DELIVERY_TASK_ID, envelope: deliveryEnvelope() },
]);

interface DeliveryEntry {
  readonly taskId: string;
  readonly terminalSeq: number;
  readonly envelope: SubAgentEnvelope;
}

interface DeliveryManagerFixture {
  readonly manager: SubAgentManager;
  /** Entries handed out per claim call, in call order (0 = nothing claimable). */
  readonly claimBatches: number[];
  readonly isDelivered: (taskId: string) => boolean;
}

/**
 * A manager view over the REAL delivery ledger (ADR-0150): claim / ack /
 * release are the production code paths; only the task buffer is a fixture.
 */
function makeDeliveryManager(
  entries: ReadonlyArray<DeliveryEntry>
): DeliveryManagerFixture {
  const ledger = createDeliveryLedger();
  const claimBatches: number[] = [];
  const ledgerEntries = (): ReadonlyArray<{
    conversationId: string;
    taskId: string;
    terminalSeq: number;
    envelope: SubAgentEnvelope;
  }> =>
    entries.map((entry) => ({
      conversationId: "",
      taskId: entry.taskId,
      terminalSeq: entry.terminalSeq,
      envelope: entry.envelope,
    }));
  const manager = {
    drainCompleted: (
      _conversationId?: string,
      drainOpts?: { readonly includeDelivered?: boolean }
    ): ReadonlyArray<{ taskId: string; envelope: SubAgentEnvelope }> => {
      const visible =
        drainOpts?.includeDelivered === true
          ? ledgerEntries()
          : ledger.undelivered(ledgerEntries());
      return visible.map(({ taskId, envelope }) => ({ taskId, envelope }));
    },
    claimCompleted: () => {
      const claims = ledger.claim(ledgerEntries());
      claimBatches.push(claims.length);
      return claims;
    },
    acknowledgeDeliveries: (
      claims: ReadonlyArray<ClaimedDelivery<unknown>>
    ): void => {
      ledger.acknowledge(claims);
    },
    releaseDeliveries: (
      claims: ReadonlyArray<ClaimedDelivery<unknown>>
    ): void => {
      ledger.release(claims);
    },
    listActive: () => [],
    waitFor: async (): Promise<SubAgentEnvelope> => {
      throw new Error("delivery fixture: waitFor is not used");
    },
    queryBuffer: () => ({ status: "not_found" as const }),
    shutdown: async () => {},
    spawn: () => ({ taskId: "delivery-fixture" }),
    abortTask: () => false,
    getCapacity: () => 15,
    listSubagents: () => [],
    subscribe: () => () => {},
  } as unknown as SubAgentManager;
  return {
    manager,
    claimBatches,
    isDelivered: (taskId: string) => {
      const entry = entries.find((candidate) => candidate.taskId === taskId);
      return ledger.isDelivered(
        deliveryKey({
          conversationId: "",
          taskId,
          terminalSeq: entry?.terminalSeq ?? 0,
        })
      );
    },
  };
}

/**
 * Record the model-visible history of every MAIN model call. The engine's
 * closing-summary epilogue is a tool-less call (request.tools === undefined)
 * and is excluded — the delivery assertions are about the turn's own call.
 */
function withHistoryCapture(deps: LoopEngineDeps): {
  readonly deps: LoopEngineDeps;
  readonly histories: () => readonly string[];
} {
  const histories: string[] = [];
  const base = deps.adapter;
  return {
    deps: {
      ...deps,
      adapter: {
        ...base,
        step: async (state, request, signal) => {
          if (request.tools !== undefined) {
            histories.push(JSON.stringify(state.messages));
          }
          return base.step(state, request, signal);
        },
      },
    },
    histories: () => histories,
  };
}

function makeDeliveryCtx(opts: {
  readonly conversationId: string;
  readonly manager: SubAgentManager;
  readonly store: SessionStore;
  readonly workspaceRoot: string;
  readonly deps: LoopEngineDeps;
}): ChatLineContext {
  const ctx = makeCtx({
    responses: [],
    stateOverrides: { conversationId: opts.conversationId },
  });
  ctx.deps = opts.deps;
  ctx.checkpointStore = opts.store;
  ctx.workspaceRoot = opts.workspaceRoot;
  ctx.subagentManager = opts.manager;
  return ctx;
}

function conversationDirPath(
  store: SessionStore,
  conversationId: string
): string {
  return resolveConversationDir({
    projectDir: store.getProjectDir(),
    conversationId,
  });
}

function sessionJsonlPath(store: SessionStore, conversationId: string): string {
  return join(
    conversationDirPath(store, conversationId),
    `${conversationId}.jsonl`
  );
}

/**
 * Seed the conversation file. A wake bootstraps no session by itself (the
 * wake's checkpoint call has no workspaceRoot), so the realistic shape is a
 * session that already exists — one parent turn has been persisted.
 */
async function seedSession(opts: {
  readonly store: SessionStore;
  readonly conversationId: string;
  readonly workspaceRoot: string;
}): Promise<void> {
  const now = new Date().toISOString();
  await opts.store.save({
    id: opts.conversationId,
    file: {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      conversation_id: opts.conversationId,
      messages: [],
      jsonMode: false,
      turnCount: 0,
      updatedAt: now,
      title: "",
      cwd: opts.workspaceRoot,
      sanitized_at: now,
      checkpoints: [],
      workspaceRoot: opts.workspaceRoot,
    },
  });
}

/**
 * Message events in the persisted JSONL that carry the digest text. The raw
 * file also repeats the digest in the session record's title, so only the
 * message events are counted.
 */
async function countDigestInJsonl(
  filePath: string,
  digestText: string
): Promise<number> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw err;
  }
  let count = 0;
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    const record = JSON.parse(line) as {
      readonly type?: string;
      readonly message?: {
        readonly content?: ReadonlyArray<{
          readonly type?: string;
          readonly text?: string;
        }>;
      };
    };
    if (record.type !== "message") continue;
    const text = (record.message?.content ?? [])
      .map((block) => block.text ?? "")
      .join("");
    if (text.includes(digestText)) count += 1;
  }
  return count;
}

/** The persisted transcript's joined text ("" when the session is absent). */
async function persistedTranscript(
  store: SessionStore,
  conversationId: string
): Promise<string> {
  try {
    const file = await store.load(conversationId);
    return file.messages
      .flatMap((message) => message.content)
      .filter(
        (block): block is { type: "text"; text: string } =>
          block.type === "text"
      )
      .map((block) => block.text)
      .join("\n");
  } catch {
    return "";
  }
}

describe("chat sub-agent delivery is exactly-once (ADR-0150)", () => {
  let baseDir: string;
  let workspaceRoot: string;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "iknow-chat-wake-"));
    workspaceRoot = await mkdtemp(join(tmpdir(), "iknow-chat-wake-root-"));
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  async function newStore(): Promise<SessionStore> {
    return new SessionStore(
      baseDir,
      deriveProjectIdentityRoot({ cwd: workspaceRoot })
    );
  }

  it("delivers a terminal result to exactly one of two consecutive wake rounds", async () => {
    const store = await newStore();
    const conversationId = randomUUID();
    await seedSession({ store, conversationId, workspaceRoot });
    const delivery = makeDeliveryManager([
      {
        taskId: DELIVERY_TASK_ID,
        terminalSeq: 1,
        envelope: deliveryEnvelope(),
      },
    ]);
    const capture = withHistoryCapture(
      makeDeps([fixtureAssistantResult({ texts: ["wake answer"] })])
    );
    const ctx = makeDeliveryCtx({
      conversationId,
      manager: delivery.manager,
      store,
      workspaceRoot,
      deps: capture.deps,
    });

    const first = await runChatSubagentWake({ ctx });
    const second = await runChatSubagentWake({ ctx });

    expect(first.output).toContain("wake answer");
    expect(second.output).toBe("");
    // The second round published nothing: it never reached the model.
    expect(capture.histories()).toHaveLength(1);
    expect(capture.histories()[0]).toContain(DELIVERY_SUMMARY);
    expect(delivery.claimBatches).toEqual([1]);
    expect(delivery.isDelivered(DELIVERY_TASK_ID)).toBe(true);
    expect(
      await countDigestInJsonl(
        sessionJsonlPath(store, conversationId),
        DELIVERY_DIGEST
      )
    ).toBe(1);
  });

  it("keeps a failed checkpoint save claimable and delivers the result once in a later round", async () => {
    const store = await newStore();
    const conversationId = randomUUID();
    await seedSession({ store, conversationId, workspaceRoot });
    const delivery = makeDeliveryManager([
      {
        taskId: DELIVERY_TASK_ID,
        terminalSeq: 1,
        envelope: deliveryEnvelope(),
      },
    ]);
    const capture = withHistoryCapture(
      makeDeps([
        fixtureAssistantResult({ texts: ["wake answer one"] }),
        fixtureAssistantResult({ texts: ["wake answer two"] }),
      ])
    );
    const ctx = makeDeliveryCtx({
      conversationId,
      manager: delivery.manager,
      store,
      workspaceRoot,
      deps: capture.deps,
    });

    // Occupy the store's temp file path with a directory: the session loads,
    // but the save's write fails for real (write_failed), so no carrier write
    // lands and the claim must go back.
    const path = sessionJsonlPath(store, conversationId);
    await mkdir(`${path}.tmp`, { recursive: true });

    await runChatSubagentWake({ ctx });

    expect(capture.histories()).toHaveLength(1);
    expect(capture.histories()[0]).toContain(DELIVERY_SUMMARY);
    expect(delivery.isDelivered(DELIVERY_TASK_ID)).toBe(false);
    expect(await countDigestInJsonl(path, DELIVERY_DIGEST)).toBe(0);

    // Unblock the store: the next round delivers and acknowledges.
    await rm(`${path}.tmp`, { recursive: true, force: true });
    await runChatSubagentWake({ ctx });

    expect(capture.histories()).toHaveLength(2);
    expect(capture.histories()[1]).toContain(DELIVERY_SUMMARY);
    expect(delivery.isDelivered(DELIVERY_TASK_ID)).toBe(true);
    const persisted = await countDigestInJsonl(path, DELIVERY_DIGEST);
    expect(persisted).toBeGreaterThan(0);

    // The result was delivered once: no further round publishes it.
    const third = await runChatSubagentWake({ ctx });
    expect(third.output).toBe("");
    expect(capture.histories()).toHaveLength(2);
    expect(await countDigestInJsonl(path, DELIVERY_DIGEST)).toBe(persisted);
  });

  it("releases the claim when the round throws and delivers the result again later", async () => {
    const store = await newStore();
    const conversationId = randomUUID();
    await seedSession({ store, conversationId, workspaceRoot });
    const delivery = makeDeliveryManager([
      {
        taskId: DELIVERY_TASK_ID,
        terminalSeq: 1,
        envelope: deliveryEnvelope(),
      },
    ]);
    const baseDeps = makeDeps([
      fixtureAssistantResult({ texts: ["wake answer"] }),
    ]);
    const baseAdapter = baseDeps.adapter;
    let calls = 0;
    const capture = withHistoryCapture({
      ...baseDeps,
      adapter: {
        ...baseAdapter,
        step: async (state, request, signal) => {
          calls += 1;
          if (calls === 1) throw new Error("scripted harness failure");
          return baseAdapter.step(state, request, signal);
        },
      },
    });
    const ctx = makeDeliveryCtx({
      conversationId,
      manager: delivery.manager,
      store,
      workspaceRoot,
      deps: capture.deps,
    });

    const first = await runChatSubagentWake({ ctx });

    expect(first.wakeFailure).toBeDefined();
    // The aborted round released the claim: the result is still claimable.
    expect(delivery.isDelivered(DELIVERY_TASK_ID)).toBe(false);
    expect(
      await countDigestInJsonl(
        sessionJsonlPath(store, conversationId),
        DELIVERY_DIGEST
      )
    ).toBe(0);

    await runChatSubagentWake({ ctx });

    expect(capture.histories()).toHaveLength(2);
    expect(capture.histories()[1]).toContain(DELIVERY_SUMMARY);
    expect(delivery.isDelivered(DELIVERY_TASK_ID)).toBe(true);
    expect(
      await countDigestInJsonl(
        sessionJsonlPath(store, conversationId),
        DELIVERY_DIGEST
      )
    ).toBe(1);
  });

  it("releases the claim when the wake fails before the run", async () => {
    const store = await newStore();
    const conversationId = randomUUID();
    await seedSession({ store, conversationId, workspaceRoot });
    const delivery = makeDeliveryManager([
      {
        taskId: DELIVERY_TASK_ID,
        terminalSeq: 1,
        envelope: deliveryEnvelope(),
      },
    ]);
    const capture = withHistoryCapture(
      makeDeps([fixtureAssistantResult({ texts: ["unused"] })])
    );
    const ctx = makeDeliveryCtx({
      conversationId,
      manager: delivery.manager,
      store,
      workspaceRoot,
      deps: capture.deps,
    });
    // The pre-run window throws. The claim must go back: a claimed entry is
    // invisible to every later read, so a leaked claim loses the generation
    // for the lifetime of the process.
    ctx.graphAssembly = {
      beginRound: () => {
        throw new Error("assembly broken");
      },
      enabled: () => false,
    };

    const result = await runChatSubagentWake({ ctx });

    expect(result.ranQuery).toBe(false);
    expect(result.wakeFailure).toBeDefined();
    expect(delivery.claimBatches).toEqual([1]);
    expect(delivery.isDelivered(DELIVERY_TASK_ID)).toBe(false);
    expect(capture.histories()).toHaveLength(0);
    expect(
      await countDigestInJsonl(
        sessionJsonlPath(store, conversationId),
        DELIVERY_DIGEST
      )
    ).toBe(0);

    // A later wake — with the pre-run window healthy again — delivers it.
    ctx.graphAssembly = undefined;
    await runChatSubagentWake({ ctx });

    expect(capture.histories()).toHaveLength(1);
    expect(capture.histories()[0]).toContain(DELIVERY_SUMMARY);
    expect(delivery.isDelivered(DELIVERY_TASK_ID)).toBe(true);
  });

  it("delivers a cancelled round's digest exactly once", async () => {
    const store = await newStore();
    const conversationId = randomUUID();
    await seedSession({ store, conversationId, workspaceRoot });
    const delivery = makeDeliveryManager([
      {
        taskId: DELIVERY_TASK_ID,
        terminalSeq: 1,
        envelope: deliveryEnvelope(),
      },
    ]);
    const controller = new AbortController();
    controller.abort();
    const capture = withHistoryCapture(
      makeDeps([fixtureAssistantResult({ texts: ["never"] })])
    );
    const ctx = makeDeliveryCtx({
      conversationId,
      manager: delivery.manager,
      store,
      workspaceRoot,
      deps: capture.deps,
    });
    ctx.abortController = controller;

    // The run is cancelled before the model answers, but it still appends
    // the interruption message, so the checkpoint decision is `full`: the
    // digest is persisted with it and must be acknowledged.
    await processChatLine({ line: "query", ctx });

    expect(delivery.claimBatches).toEqual([1]);
    expect(delivery.isDelivered(DELIVERY_TASK_ID)).toBe(true);
    const path = sessionJsonlPath(store, conversationId);
    expect(await countDigestInJsonl(path, DELIVERY_DIGEST)).toBe(1);

    // Nothing re-injects the digest on a later wake.
    ctx.abortController = new AbortController();
    const later = await runChatSubagentWake({ ctx });
    expect(later.output).toBe("");
    expect(delivery.claimBatches).toEqual([1]);
    expect(await countDigestInJsonl(path, DELIVERY_DIGEST)).toBe(1);
  });

  it("acknowledges when no conversation exists to persist into", async () => {
    const store = await newStore();
    const delivery = makeDeliveryManager([
      {
        taskId: DELIVERY_TASK_ID,
        terminalSeq: 1,
        envelope: deliveryEnvelope(),
      },
    ]);
    const capture = withHistoryCapture(
      makeDeps([
        fixtureAssistantResult({ texts: ["wake answer"] }),
        fixtureAssistantResult({ texts: ["wake answer again"] }),
      ])
    );
    const ctx = makeDeliveryCtx({
      conversationId: randomUUID(),
      manager: delivery.manager,
      store,
      workspaceRoot,
      deps: capture.deps,
    });
    // A store exists, but with no conversation id the checkpoint guard writes
    // nothing. Treating that as a durable carrier would release the claim
    // after every run and re-deliver the digest forever.
    ctx.state.conversationId = null;

    await runChatSubagentWake({ ctx });

    expect(capture.histories()).toHaveLength(1);
    expect(delivery.isDelivered(DELIVERY_TASK_ID)).toBe(true);

    const second = await runChatSubagentWake({ ctx });
    expect(second.output).toBe("");
    expect(capture.histories()).toHaveLength(1);
  });

  it("acknowledges a query round with no conversation to persist into", async () => {
    const store = await newStore();
    const delivery = makeDeliveryManager([
      {
        taskId: DELIVERY_TASK_ID,
        terminalSeq: 1,
        envelope: deliveryEnvelope(),
      },
    ]);
    const capture = withHistoryCapture(
      makeDeps([
        fixtureAssistantResult({ texts: ["query answer"] }),
        fixtureAssistantResult({ texts: ["second answer"] }),
      ])
    );
    const ctx = makeDeliveryCtx({
      conversationId: randomUUID(),
      manager: delivery.manager,
      store,
      workspaceRoot,
      deps: capture.deps,
    });
    // The query loop's carrier decision, not the wake's: no conversation id
    // means the checkpoint writes nothing, so the round must acknowledge at
    // settle time instead of releasing and re-delivering every round.
    ctx.state.conversationId = null;

    await processChatLine({ line: "first question", ctx });

    expect(capture.histories()).toHaveLength(1);
    expect(capture.histories()[0]).toContain(DELIVERY_SUMMARY);
    expect(delivery.isDelivered(DELIVERY_TASK_ID)).toBe(true);

    await processChatLine({ line: "second question", ctx });

    // The digest is part of the history from round 1 on (that is the point of
    // delivering it); what must not happen is a second delivery.
    expect(capture.histories()).toHaveLength(2);
    // Round 1 claimed the generation; round 2 still claims, and gets nothing.
    expect(delivery.claimBatches).toEqual([1, 0]);
    expect(
      ctx.state.messages.filter(
        (message) =>
          message.role === "user" &&
          message.content.some(
            (block) =>
              block.type === "text" && block.text.includes("## Sub-agent")
          )
      )
    ).toHaveLength(1);
  });

  it("does not acknowledge a round whose checkpoint decision is none", async () => {
    const store = await newStore();
    const conversationId = randomUUID();
    await seedSession({ store, conversationId, workspaceRoot });
    const delivery = makeDeliveryManager([
      {
        taskId: DELIVERY_TASK_ID,
        terminalSeq: 1,
        envelope: deliveryEnvelope(),
      },
    ]);
    const capture = withHistoryCapture(
      makeDeps([
        // An empty final response after a drain-only history → the run has no
        // turn query to keep, so the decision is "none". The second entry is
        // the engine's tool-less closing-summary epilogue.
        fixtureAssistantResult({ texts: [] }),
        fixtureAssistantResult({ texts: ["closing summary"] }),
        fixtureAssistantResult({ texts: ["wake answer"] }),
      ])
    );
    const ctx = makeDeliveryCtx({
      conversationId,
      manager: delivery.manager,
      store,
      workspaceRoot,
      deps: capture.deps,
    });

    await runChatSubagentWake({ ctx });

    expect(capture.histories()).toHaveLength(1);
    expect(capture.histories()[0]).toContain(DELIVERY_SUMMARY);
    // No write carried the digest → the claim is not acknowledged.
    expect(delivery.isDelivered(DELIVERY_TASK_ID)).toBe(false);
    expect(
      await countDigestInJsonl(
        sessionJsonlPath(store, conversationId),
        DELIVERY_DIGEST
      )
    ).toBe(0);

    await runChatSubagentWake({ ctx });

    expect(capture.histories()).toHaveLength(2);
    expect(capture.histories()[1]).toContain(DELIVERY_SUMMARY);
    expect(delivery.isDelivered(DELIVERY_TASK_ID)).toBe(true);
    expect(
      await countDigestInJsonl(
        sessionJsonlPath(store, conversationId),
        DELIVERY_DIGEST
      )
    ).toBe(1);
  });

  it("does not acknowledge a round whose checkpoint decision is partial_user_only", async () => {
    const store = await newStore();
    const conversationId = randomUUID();
    await seedSession({ store, conversationId, workspaceRoot });
    const delivery = makeDeliveryManager([
      {
        taskId: DELIVERY_TASK_ID,
        terminalSeq: 1,
        envelope: deliveryEnvelope(),
      },
    ]);
    const capture = withHistoryCapture(
      makeDeps([
        // An empty final response after a real user query → the save keeps
        // the user query only (decision "partial_user_only"), and the drain
        // digest is not a turn query. The second entry is the engine's
        // tool-less closing-summary epilogue.
        fixtureAssistantResult({ texts: [] }),
        fixtureAssistantResult({ texts: ["closing summary"] }),
        fixtureAssistantResult({ texts: ["query answer"] }),
      ])
    );
    const ctx = makeDeliveryCtx({
      conversationId,
      manager: delivery.manager,
      store,
      workspaceRoot,
      deps: capture.deps,
    });

    const first = await processChatLine({ line: "first question", ctx });

    expect(first.ranQuery).toBe(true);
    expect(capture.histories()).toHaveLength(1);
    expect(capture.histories()[0]).toContain(DELIVERY_SUMMARY);
    expect(delivery.isDelivered(DELIVERY_TASK_ID)).toBe(false);
    expect(
      await countDigestInJsonl(
        sessionJsonlPath(store, conversationId),
        DELIVERY_DIGEST
      )
    ).toBe(0);
    expect(await persistedTranscript(store, conversationId)).toContain(
      "first question"
    );

    const second = await processChatLine({ line: "second question", ctx });

    expect(second.ranQuery).toBe(true);
    expect(capture.histories()).toHaveLength(2);
    expect(capture.histories()[1]).toContain(DELIVERY_SUMMARY);
    expect(delivery.isDelivered(DELIVERY_TASK_ID)).toBe(true);
    expect(
      await countDigestInJsonl(
        sessionJsonlPath(store, conversationId),
        DELIVERY_DIGEST
      )
    ).toBe(1);
  });

  it("delivers the digest exactly once when a wake and a user query race", async () => {
    const store = await newStore();
    const conversationId = randomUUID();
    await seedSession({ store, conversationId, workspaceRoot });
    const delivery = makeDeliveryManager([
      {
        taskId: DELIVERY_TASK_ID,
        terminalSeq: 1,
        envelope: deliveryEnvelope(),
      },
    ]);
    // The wake and the user query are both in flight: each model call waits
    // on its own latch, so the claim race is resolved by the ledger, not by
    // scheduling luck. The two checkpoint writes stay ordered (the wake's
    // write lands first), which is how the REPL serializes them.
    const wakeGate = deferred<void>();
    const queryGate = deferred<void>();
    const baseDeps = makeDeps([
      fixtureAssistantResult({ texts: ["wake answer"] }),
      fixtureAssistantResult({ texts: ["query answer"] }),
    ]);
    const baseAdapter = baseDeps.adapter;
    const histories: string[] = [];
    let calls = 0;
    const deps: LoopEngineDeps = {
      ...baseDeps,
      adapter: {
        ...baseAdapter,
        step: async (state, request, signal) => {
          calls += 1;
          if (request.tools !== undefined) {
            histories.push(JSON.stringify(state.messages));
          }
          // The wake's call carries the claimed digest; the query's does not
          // (it lost the claim). Gate each on its own latch.
          if (JSON.stringify(state.messages).includes(DELIVERY_SUMMARY)) {
            await wakeGate.promise;
          } else {
            await queryGate.promise;
          }
          return baseAdapter.step(state, request, signal);
        },
      },
    };
    const ctx = makeDeliveryCtx({
      conversationId,
      manager: delivery.manager,
      store,
      workspaceRoot,
      deps,
    });

    const wakeRun = runChatSubagentWake({ ctx });
    const queryRun = processChatLine({ line: "racing question", ctx });

    // The wake claimed the generation; the user query finds it claimed.
    await vi.waitFor(() => expect(calls).toBe(2));
    expect(
      histories.filter((history) => history.includes(DELIVERY_SUMMARY))
    ).toHaveLength(1);

    wakeGate.resolve();
    await wakeRun;
    queryGate.resolve();
    await queryRun;

    // The digest reached the model exactly once, and the loser claimed
    // nothing.
    expect(
      histories.filter((history) => history.includes(DELIVERY_SUMMARY))
    ).toHaveLength(1);
    expect(delivery.claimBatches.filter((count) => count > 0)).toHaveLength(1);
    expect(delivery.claimBatches.reduce((sum, count) => sum + count, 0)).toBe(
      1
    );
    expect(
      await countDigestInJsonl(
        sessionJsonlPath(store, conversationId),
        DELIVERY_DIGEST
      )
    ).toBe(1);
  });

  it("persists the digest text exactly once on a clean run", async () => {
    const store = await newStore();
    const conversationId = randomUUID();
    await seedSession({ store, conversationId, workspaceRoot });
    const delivery = makeDeliveryManager([
      {
        taskId: DELIVERY_TASK_ID,
        terminalSeq: 1,
        envelope: deliveryEnvelope(),
      },
    ]);
    const capture = withHistoryCapture(
      makeDeps([fixtureAssistantResult({ texts: ["wake answer"] })])
    );
    const ctx = makeDeliveryCtx({
      conversationId,
      manager: delivery.manager,
      store,
      workspaceRoot,
      deps: capture.deps,
    });

    await runChatSubagentWake({ ctx });

    const path = sessionJsonlPath(store, conversationId);
    expect(await countDigestInJsonl(path, DELIVERY_DIGEST)).toBe(1);
    const transcript = await persistedTranscript(store, conversationId);
    expect(transcript.split(DELIVERY_DIGEST).length - 1).toBe(1);
    expect(transcript).toContain("wake answer");
  });
});
