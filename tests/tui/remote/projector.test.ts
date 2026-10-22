/**
 * Seat projector tests (spec specs/remote-sync.md §4.4, §5.5-§5.7).
 *
 * The projector is the seam where three TUI surfaces become one ordered,
 * sequenced stream. The cases pin the behaviors a reconnect or a switch
 * depends on: the active-conversation filter, the tool-call hold and its four
 * release points, one announcement / resolution per approval, the snapshot
 * shape, and the ring window.
 *
 * Everything is deterministic: a fake hub and sink, the real ask bridge, an
 * injected clock, and a fake `loadTranscript` over synthetic session content.
 */
import { describe, expect, jest, test } from "bun:test";
import type {
  AnthropicNativeMessage,
  StopReason,
} from "../../../src/harness/model-adapter/types.js";
import type { HarnessStreamEvent } from "../../../src/harness/stream.js";
import type { AskUserOutcome } from "../../../src/harness/permission/types.js";
import type {
  SeatEvent,
  SeatEventBody,
} from "../../../src/remote-api/protocol.js";
import type { TurnOutcomeView } from "../../../src/session-api/contract.js";
import type { HubEvent } from "../../../src/session-api/hub.js";
import {
  createTuiAskUserBridge,
  type TuiAskSettledBy,
  type TuiAskUserBridge,
  type TuiPendingAsk,
} from "../../../src/tui/ask-user.js";
import type { TuiToolEvent } from "../../../src/tui/deps.js";
import {
  createSeatProjector,
  RESOLVED_ASKS_LIMIT,
  type SeatProjector,
} from "../../../src/tui/remote/projector.js";
import type { TuiLoadedSessionFile } from "../../../src/tui/session-state.js";

const NOW = "2026-01-01T00:00:00.000Z";

// -- fakes --------------------------------------------------------------------

interface FakeHub {
  readonly hub: {
    subscribeEvents(listener: (event: HubEvent) => void): () => void;
  };
  emit(event: HubEvent): void;
  listeners(): number;
}

function createFakeHub(): FakeHub {
  const listeners = new Set<(event: HubEvent) => void>();
  return {
    hub: {
      subscribeEvents: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    emit: (event) => {
      for (const listener of [...listeners]) listener(event);
    },
    listeners: () => listeners.size,
  };
}

interface FakeSink {
  readonly sink: {
    subscribe(listener: (event: TuiToolEvent) => void): () => void;
  };
  emit(event: TuiToolEvent): void;
  listeners(): number;
}

function createFakeSink(): FakeSink {
  const listeners = new Set<(event: TuiToolEvent) => void>();
  return {
    sink: {
      subscribe: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    emit: (event) => {
      for (const listener of [...listeners]) listener(event);
    },
    listeners: () => listeners.size,
  };
}

type SettledListener = Parameters<TuiAskUserBridge["onSettled"]>[0];

interface SettlementBridge {
  readonly bridge: TuiAskUserBridge;
  /** Deliver a settlement directly (repeatable) to test duplicate suppression. */
  settle(ask: TuiPendingAsk, by?: TuiAskSettledBy): void;
}

function createSettlementBridge(): SettlementBridge {
  const listeners = new Set<SettledListener>();
  const bridge: TuiAskUserBridge = {
    ask: async () => ({ kind: "cancelled" }),
    resolveAsk: () => false,
    pending: () => undefined,
    pendingAll: () => [],
    pendingCount: () => 0,
    subscribe: () => () => undefined,
    onSettled: (callback) => {
      listeners.add(callback);
      return () => {
        listeners.delete(callback);
      };
    },
  };
  const settle = (ask: TuiPendingAsk, by: TuiAskSettledBy = "local"): void => {
    for (const listener of [...listeners]) {
      listener(ask, { kind: "approved" }, by, "once");
    }
  };
  return { bridge, settle };
}

function pendingAsk(id: string, toolUseId: string): TuiPendingAsk {
  return {
    id,
    tool: "Bash",
    summaryHint: "run a command",
    toolUseId,
    input: {},
  };
}

// -- harness ------------------------------------------------------------------

interface HarnessOptions {
  readonly transcripts?: ReadonlyMap<string, TuiLoadedSessionFile>;
  readonly askBridge?: TuiAskUserBridge;
}

interface Harness {
  readonly projector: SeatProjector;
  readonly hub: FakeHub;
  readonly sink: FakeSink;
  readonly askBridge: TuiAskUserBridge;
  readonly events: SeatEvent[];
  readonly loaded: string[];
}

function createHarness(options: HarnessOptions = {}): Harness {
  const hub = createFakeHub();
  const sink = createFakeSink();
  const askBridge = options.askBridge ?? createTuiAskUserBridge();
  const events: SeatEvent[] = [];
  const loaded: string[] = [];
  const projector = createSeatProjector({
    instanceId: "seat-test",
    hub: hub.hub,
    askBridge,
    toolEventSink: sink.sink,
    loadTranscript: async (conversationId) => {
      loaded.push(conversationId);
      const file = options.transcripts?.get(conversationId);
      if (file === undefined) throw new Error("transcript missing");
      return file;
    },
    now: () => NOW,
  });
  projector.subscribeLive((event) => {
    events.push(event);
  });
  return { projector, hub, sink, askBridge, events, loaded };
}

function activate(
  harness: Harness,
  conversationId: string | null,
  extra: { readonly running?: boolean; readonly queued?: number } = {}
): void {
  harness.projector.setActive({
    conversationId,
    running: extra.running ?? true,
    queued: extra.queued ?? 0,
  });
}

function emitStream(
  harness: Harness,
  conversationId: string,
  turnId: string,
  event: HarnessStreamEvent
): void {
  harness.hub.emit({ kind: "stream", conversationId, turnId, event });
}

function startCall(
  harness: Harness,
  conversationId: string,
  turnId: string,
  toolUseId: string,
  name = "Bash"
): void {
  emitStream(harness, conversationId, turnId, {
    type: "tool_call_start",
    name,
    id: toolUseId,
  });
}

function inputDelta(
  harness: Harness,
  conversationId: string,
  turnId: string,
  toolUseId: string,
  partialJson: string
): void {
  emitStream(harness, conversationId, turnId, {
    type: "tool_input_delta",
    id: toolUseId,
    partialJson,
  });
}

function endTurn(
  harness: Harness,
  conversationId: string,
  turnId: string,
  outcome: TurnOutcomeView
): void {
  harness.hub.emit({ kind: "turn_ended", conversationId, turnId, outcome });
}

function kinds(events: readonly SeatEvent[]): string[] {
  return events.map((event) => event.event.kind);
}

type ToolCallBody = Extract<SeatEventBody, { kind: "tool_call" }>;

function toolCalls(events: readonly SeatEvent[]): ToolCallBody[] {
  const out: ToolCallBody[] = [];
  for (const event of events) {
    if (event.event.kind === "tool_call") out.push(event.event);
  }
  return out;
}

function makeAsk(
  bridge: TuiAskUserBridge,
  toolUseId: string,
  conversationId: string | undefined,
  input: unknown = { command: "ls" },
  tool = "Bash"
): Promise<boolean | AskUserOutcome> {
  return bridge.ask({
    tool,
    input,
    summaryHint: "run a command",
    toolUseId,
    ...(conversationId !== undefined ? { conversationId } : {}),
  });
}

function sessionFile(
  conversationId: string,
  messages: ReadonlyArray<AnthropicNativeMessage>,
  title = `title ${conversationId}`
): TuiLoadedSessionFile {
  return {
    schemaVersion: 5,
    conversation_id: conversationId,
    messages,
    jsonMode: false,
    turnCount: 0,
    updatedAt: NOW,
    title,
    cwd: "/tmp/project",
    sanitized_at: NOW,
  };
}

function textMessage(
  role: "user" | "assistant",
  text: string
): AnthropicNativeMessage {
  return { role, content: [{ type: "text", text }] };
}

function knownStop(stopReason: StopReason): TurnOutcomeView {
  return { terminal: "known", stopReason };
}

// -- active-conversation filter ----------------------------------------------

describe("active conversation filter", () => {
  test("forwards the active conversation only, with the message origin", () => {
    const h = createHarness();
    activate(h, "c1");
    h.projector.start();

    h.hub.emit({
      kind: "user_message",
      conversationId: "c1",
      text: "from the phone",
      origin: "remote",
    });
    h.hub.emit({
      kind: "user_message",
      conversationId: "c2",
      text: "background",
      origin: "local",
    });
    emitStream(h, "c2", "turn-b", { type: "text_delta", text: "hidden" });
    emitStream(h, "c1", "turn-a", { type: "text_delta", text: "hello" });
    emitStream(h, "c1", "turn-a", { type: "thinking_delta", text: "hmm" });
    // The stream's approval copies are not the projection's approval source.
    emitStream(h, "c1", "turn-a", {
      type: "approval_pending",
      toolUseId: "toolu_x",
      tool: "Bash",
    });
    // Host UI state is not projected in v1.
    emitStream(h, "c1", "turn-a", {
      type: "agent_status",
      lastTool: "idle",
      openTodoLines: [],
    });
    emitStream(h, "c1", "turn-a", {
      type: "context_usage",
      phase: "post_call",
      source: "measured",
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        cacheCreationInputTokens: null,
        cacheReadInputTokens: null,
      },
    });

    expect(kinds(h.events)).toEqual(["user_message", "text", "thinking"]);
    expect(h.events[0]?.event).toEqual({
      kind: "user_message",
      text: "from the phone",
      origin: "remote",
    });
    expect(h.events.map((event) => event.conversationId)).toEqual([
      "c1",
      "c1",
      "c1",
    ]);
    expect(h.events.map((event) => event.seq)).toEqual([1, 2, 3]);
    expect(h.events.every((event) => event.time === NOW)).toBe(true);
  });

  test("a draft active conversation matches no hub event", () => {
    const h = createHarness();
    activate(h, null);
    h.projector.start();

    emitStream(h, "c1", "turn-a", { type: "text_delta", text: "hidden" });
    h.hub.emit({
      kind: "user_message",
      conversationId: "c1",
      text: "hidden",
      origin: "local",
    });

    expect(h.events).toEqual([]);
  });

  test("not running yet: nothing is emitted or retained", () => {
    const h = createHarness();
    activate(h, "c1");
    emitStream(h, "c1", "turn-a", { type: "text_delta", text: "hidden" });
    expect(h.events).toEqual([]);
    expect(h.projector.latestSeq).toBe(0);
  });
});

// -- active switches ----------------------------------------------------------

describe("active switches", () => {
  test("the first state is a baseline; only a conversation change emits", () => {
    const h = createHarness();
    activate(h, "c1");
    h.projector.start();
    expect(h.events).toEqual([]);

    activate(h, "c1", { running: false, queued: 3 });
    expect(h.events).toEqual([]);

    activate(h, "c2");
    expect(h.events).toHaveLength(1);
    expect(h.events[0]?.event).toEqual({
      kind: "active_changed",
      conversationId: "c2",
    });
    expect(h.events[0]?.conversationId).toBe("c2");

    // A detour through "no active state" is not itself a switch, and coming
    // back to the same conversation is not one either.
    h.projector.setActive(undefined);
    activate(h, "c2");
    expect(h.events).toHaveLength(1);

    activate(h, null);
    expect(h.events).toHaveLength(2);
    expect(h.events[1]?.event).toEqual({
      kind: "active_changed",
      conversationId: null,
    });
    expect(h.events[1]?.conversationId).toBeUndefined();
  });

  test("retires outgoing held calls; late outgoing events cannot corrupt it", async () => {
    const h = createHarness();
    activate(h, "c1");
    h.projector.start();
    startCall(h, "c1", "t1", "toolu_old");
    inputDelta(h, "c1", "t1", "toolu_old", '{"command":"ls"}');

    activate(h, "c2", { queued: 1 });
    expect(kinds(h.events)).toEqual(["active_changed"]);

    // Late callbacks of the outgoing turn: no call, no turn bracket, and the
    // retired call must not be re-buffered by its late delta.
    inputDelta(h, "c1", "t1", "toolu_old", ',"cwd":"/tmp"}');
    emitStream(h, "c1", "t1", {
      type: "agent_status",
      lastTool: "idle",
      openTodoLines: [],
    });
    endTurn(h, "c1", "t1", knownStop("completed"));

    startCall(h, "c2", "t2", "toolu_new", "Edit");
    endTurn(h, "c2", "t2", knownStop("completed"));

    expect(kinds(h.events)).toEqual([
      "active_changed",
      "tool_call",
      "turn_ended",
    ]);
    expect(toolCalls(h.events).map((call) => call.toolUseId)).toEqual([
      "toolu_new",
    ]);
    expect(toolCalls(h.events)[0]?.input).toEqual({});
    expect(toolCalls(h.events)[0]?.inputPartial).toBe(true);

    const snapshot = await h.projector.snapshot();
    expect(snapshot.openToolCalls).toEqual([]);
  });
});

// -- turn bracket -------------------------------------------------------------

describe("turn bracket", () => {
  test("maps completed / cancelled / failed endings", () => {
    const cases: ReadonlyArray<{
      readonly outcome: TurnOutcomeView;
      readonly expected: SeatEventBody;
    }> = [
      {
        outcome: knownStop("completed"),
        expected: {
          kind: "turn_ended",
          turnId: "t1",
          status: "completed",
          stopReason: "completed",
        },
      },
      {
        outcome: knownStop("cancelled"),
        expected: {
          kind: "turn_ended",
          turnId: "t1",
          status: "cancelled",
          stopReason: "cancelled",
        },
      },
      {
        outcome: knownStop("nonSuccessStop"),
        expected: {
          kind: "turn_ended",
          turnId: "t1",
          status: "failed",
          stopReason: "nonSuccessStop",
        },
      },
      {
        outcome: { terminal: "unknown" },
        expected: { kind: "turn_ended", turnId: "t1", status: "failed" },
      },
    ];

    for (const entry of cases) {
      const h = createHarness();
      activate(h, "c1");
      h.projector.start();
      h.hub.emit({ kind: "turn_started", conversationId: "c1", turnId: "t1" });
      endTurn(h, "c1", "t1", entry.outcome);
      expect(h.events.map((event) => event.event)).toEqual([
        { kind: "turn_started", turnId: "t1" },
        entry.expected,
      ]);
    }
  });

  test("turn_ended flushes the held call first", () => {
    const h = createHarness();
    activate(h, "c1");
    h.projector.start();
    startCall(h, "c1", "t1", "toolu_1");
    inputDelta(h, "c1", "t1", "toolu_1", '{"command":"ls"}');
    expect(h.events).toEqual([]);

    endTurn(h, "c1", "t1", knownStop("completed"));

    expect(kinds(h.events)).toEqual(["tool_call", "turn_ended"]);
    expect(toolCalls(h.events)[0]).toEqual({
      kind: "tool_call",
      toolUseId: "toolu_1",
      name: "Bash",
      input: { command: "ls" },
    });
    expect(h.events[1]?.event).toEqual({
      kind: "turn_ended",
      turnId: "t1",
      status: "completed",
      stopReason: "completed",
    });
    // The turn is closed: a later flush point finds nothing to emit.
    emitStream(h, "c1", "t1", {
      type: "agent_status",
      lastTool: "idle",
      openTodoLines: [],
    });
    expect(h.events).toHaveLength(2);
  });

  test("a turn bracket of a non-active conversation is dropped", () => {
    const h = createHarness();
    activate(h, "c1");
    h.projector.start();
    h.hub.emit({ kind: "turn_started", conversationId: "c2", turnId: "t2" });
    endTurn(h, "c2", "t2", knownStop("completed"));
    expect(h.events).toEqual([]);
  });
});

// -- tool-call hold -----------------------------------------------------------

describe("tool-call hold", () => {
  test("an approval releases the call with the ask's input", async () => {
    const h = createHarness();
    activate(h, "c1");
    h.projector.start();
    startCall(h, "c1", "t1", "toolu_1");
    inputDelta(h, "c1", "t1", "toolu_1", '{"command":"ls"}');
    expect(h.events).toEqual([]);

    const settled = makeAsk(h.askBridge, "toolu_1", "c1", {
      command: "ls",
      cwd: "/tmp/project",
    });

    expect(kinds(h.events)).toEqual(["tool_call", "approval_pending"]);
    expect(toolCalls(h.events)[0]).toEqual({
      kind: "tool_call",
      toolUseId: "toolu_1",
      name: "Bash",
      input: { command: "ls", cwd: "/tmp/project" },
    });

    h.askBridge.resolveAsk("ask-1", true, "remote");
    await expect(settled).resolves.toEqual({ kind: "approved" });
  });

  test("a tool result releases the call, then reports resultKind", () => {
    const h = createHarness();
    activate(h, "c1");
    h.projector.start();
    startCall(h, "c1", "t1", "toolu_1");
    inputDelta(h, "c1", "t1", "toolu_1", '{"command":"ls"}');

    h.sink.emit({
      conversationId: "c1",
      toolName: "Bash",
      toolUseId: "toolu_1",
      kind: "ok",
      input: { command: "ls" },
      message: "done",
    });

    expect(kinds(h.events)).toEqual(["tool_call", "tool_result"]);
    expect(h.events[1]?.event).toEqual({
      kind: "tool_result",
      toolUseId: "toolu_1",
      resultKind: "ok",
      message: "done",
    });
  });

  test("the next agent_status releases the call without forwarding", () => {
    const h = createHarness();
    activate(h, "c1");
    h.projector.start();
    startCall(h, "c1", "t1", "toolu_1");
    inputDelta(h, "c1", "t1", "toolu_1", '{"command":"ls"}');

    emitStream(h, "c1", "t1", {
      type: "agent_status",
      lastTool: "Bash",
      openTodoLines: [],
    });

    expect(kinds(h.events)).toEqual(["tool_call"]);
    expect(toolCalls(h.events)[0]?.input).toEqual({ command: "ls" });
  });

  test("an unparsed delta prefix becomes an empty partial input", () => {
    const h = createHarness();
    activate(h, "c1");
    h.projector.start();
    startCall(h, "c1", "t1", "toolu_1");
    inputDelta(h, "c1", "t1", "toolu_1", '{"command":');
    endTurn(h, "c1", "t1", knownStop("completed"));

    expect(toolCalls(h.events)[0]).toEqual({
      kind: "tool_call",
      toolUseId: "toolu_1",
      name: "Bash",
      input: {},
      inputPartial: true,
    });
  });

  test("an input over 64 KiB is cut and flagged", () => {
    const h = createHarness();
    activate(h, "c1");
    h.projector.start();
    startCall(h, "c1", "t1", "toolu_1");
    inputDelta(
      h,
      "c1",
      "t1",
      "toolu_1",
      JSON.stringify({ command: "x".repeat(70 * 1024) })
    );
    endTurn(h, "c1", "t1", knownStop("completed"));

    const call = toolCalls(h.events)[0];
    expect(call?.inputTruncated).toBe(true);
    expect(call?.inputPartial).toBeUndefined();
    expect(typeof call?.input).toBe("string");
    expect(Buffer.byteLength(call?.input as string, "utf8")).toBe(64 * 1024);
  });

  test("a tool result without a call id addresses nothing and is dropped", () => {
    const h = createHarness();
    activate(h, "c1");
    h.projector.start();
    h.sink.emit({
      conversationId: "c1",
      toolName: "Bash",
      kind: "ok",
      input: {},
    });
    expect(h.events).toEqual([]);
  });
});

// -- approvals ----------------------------------------------------------------

describe("approvals", () => {
  test("announces each pending ask once, for every conversation", () => {
    const h = createHarness();
    activate(h, "c1");
    h.projector.start();

    void makeAsk(h.askBridge, "toolu_1", "c1", { command: "ls" });
    void makeAsk(h.askBridge, "toolu_2", "c2", { path: "a.ts" }, "Edit");

    const pending = h.events.filter(
      (event) => event.event.kind === "approval_pending"
    );
    expect(pending.map((event) => event.event)).toEqual([
      {
        kind: "approval_pending",
        toolUseId: "toolu_1",
        tool: "Bash",
        summaryHint: "run a command",
        input: { command: "ls" },
        conversationId: "c1",
      },
      {
        kind: "approval_pending",
        toolUseId: "toolu_2",
        tool: "Edit",
        summaryHint: "run a command",
        input: { path: "a.ts" },
        conversationId: "c2",
      },
    ]);
    // The non-active conversation is carried on the envelope as well.
    expect(pending.map((event) => event.conversationId)).toEqual(["c1", "c2"]);
  });

  test("resolves once, naming the side that answered and the answer", async () => {
    const h = createHarness();
    activate(h, "c1");
    h.projector.start();
    const once = makeAsk(h.askBridge, "toolu_1", "c1");
    const always = makeAsk(h.askBridge, "toolu_2", "c1");
    const rejected = makeAsk(h.askBridge, "toolu_3", "c1");

    h.askBridge.resolveAsk("ask-1", true, "remote", "once");
    await expect(once).resolves.toEqual({ kind: "approved" });
    h.askBridge.resolveAsk("ask-2", true, "local", "always");
    await expect(always).resolves.toEqual({ kind: "approved" });
    h.askBridge.resolveAsk("ask-3", false, "local", "reject");
    await expect(rejected).resolves.toEqual({ kind: "declined" });

    const resolved = h.events.filter(
      (event) => event.event.kind === "approval_resolved"
    );
    expect(resolved.map((event) => event.event)).toEqual([
      {
        kind: "approval_resolved",
        toolUseId: "toolu_1",
        outcome: "approved",
        answer: "once",
        by: "remote",
      },
      {
        kind: "approval_resolved",
        toolUseId: "toolu_2",
        outcome: "approved",
        answer: "always",
        by: "local",
      },
      {
        kind: "approval_resolved",
        toolUseId: "toolu_3",
        outcome: "declined",
        answer: "reject",
        by: "local",
      },
    ]);
  });

  test("first answer wins: the losing answer emits nothing", async () => {
    const h = createHarness();
    activate(h, "c1");
    h.projector.start();
    const settled = makeAsk(h.askBridge, "toolu_1", "c1");

    expect(h.askBridge.resolveAsk("ask-1", true, "remote")).toBe(true);
    await expect(settled).resolves.toEqual({ kind: "approved" });
    expect(h.askBridge.resolveAsk("ask-1", false, "local")).toBe(false);

    expect(
      h.events.filter((event) => event.event.kind === "approval_resolved")
    ).toHaveLength(1);
  });

  test("a system ending reports by system and no answer", async () => {
    const h = createHarness();
    activate(h, "c1");
    h.projector.start();
    const controller = new AbortController();
    const settled = h.askBridge.ask({
      tool: "Bash",
      input: { command: "ls" },
      summaryHint: "run a command",
      toolUseId: "toolu_1",
      conversationId: "c1",
      signal: controller.signal,
    });

    controller.abort();
    await expect(settled).resolves.toEqual({ kind: "cancelled" });

    expect(
      h.events
        .filter((event) => event.event.kind === "approval_resolved")
        .map((event) => event.event)
    ).toEqual([
      {
        kind: "approval_resolved",
        toolUseId: "toolu_1",
        outcome: "cancelled",
        by: "system",
      },
    ]);
  });

  test("a timeout settles as a system ending without an answer", async () => {
    jest.useFakeTimers();
    try {
      const bridge = createTuiAskUserBridge({ timeoutMs: 5_000 });
      const h = createHarness({ askBridge: bridge });
      activate(h, "c1");
      h.projector.start();
      const settled = makeAsk(bridge, "toolu_1", "c1");

      jest.advanceTimersByTime(5_000);
      await expect(settled).resolves.toEqual({
        kind: "timeout",
        afterMs: 5_000,
      });

      expect(
        h.events
          .filter((event) => event.event.kind === "approval_resolved")
          .map((event) => event.event)
      ).toEqual([
        {
          kind: "approval_resolved",
          toolUseId: "toolu_1",
          outcome: "timeout",
          by: "system",
        },
      ]);
    } finally {
      jest.useRealTimers();
    }
  });

  test("an ask queued before start is announced on start", async () => {
    const bridge = createTuiAskUserBridge();
    const h = createHarness({ askBridge: bridge });
    const settled = makeAsk(bridge, "toolu_1", "c1");

    activate(h, "c1");
    h.projector.start();
    expect(kinds(h.events)).toEqual(["approval_pending"]);

    bridge.resolveAsk("ask-1", true);
    await expect(settled).resolves.toEqual({ kind: "approved" });
    expect(kinds(h.events)).toEqual(["approval_pending", "approval_resolved"]);
  });

  test("a duplicate settlement is suppressed; the remembered ids are FIFO-bounded", () => {
    const fake = createSettlementBridge();
    const h = createHarness({ askBridge: fake.bridge });
    activate(h, "c1");
    h.projector.start();
    const resolvedCount = (): number =>
      h.events.filter((event) => event.event.kind === "approval_resolved")
        .length;

    const first = pendingAsk("ask-1", "toolu_1");
    fake.settle(first);
    fake.settle(first);
    expect(resolvedCount()).toBe(1);

    const last = pendingAsk(`ask-${RESOLVED_ASKS_LIMIT + 1}`, "toolu_last");
    for (let index = 2; index <= RESOLVED_ASKS_LIMIT + 1; index += 1) {
      fake.settle(
        index === RESOLVED_ASKS_LIMIT + 1
          ? last
          : pendingAsk(`ask-${index}`, `toolu_${index}`)
      );
    }
    expect(resolvedCount()).toBe(RESOLVED_ASKS_LIMIT + 1);

    // The oldest id was evicted, so it may report again; the newest is still
    // remembered and stays suppressed.
    fake.settle(first);
    expect(resolvedCount()).toBe(RESOLVED_ASKS_LIMIT + 2);
    fake.settle(last);
    expect(resolvedCount()).toBe(RESOLVED_ASKS_LIMIT + 2);
  });
});

// -- snapshot -----------------------------------------------------------------

describe("snapshot", () => {
  test("carries seq, title, every approval, open calls and the text tail", async () => {
    const messages: AnthropicNativeMessage[] = [
      { role: "system", content: [{ type: "text", text: "system prompt" }] },
      textMessage("user", "first"),
      textMessage("assistant", "answer"),
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "toolu_done", name: "Bash", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_done", content: "ok" },
        ],
      },
    ];
    for (let index = 1; index <= 25; index += 1) {
      messages.push(
        textMessage("user", `u${index}`),
        textMessage("assistant", `a${index}`)
      );
    }
    messages.push({
      role: "assistant",
      content: [{ type: "thinking", thinking: "hidden", signature: "sig" }],
    });
    const h = createHarness({
      transcripts: new Map([["c1", sessionFile("c1", messages, "Fix it")]]),
    });
    activate(h, "c1", { queued: 2 });
    h.projector.start();
    h.hub.emit({
      kind: "user_message",
      conversationId: "c1",
      text: "go",
      origin: "local",
    });
    emitStream(h, "c1", "t1", { type: "text_delta", text: "working" });
    startCall(h, "c1", "t1", "toolu_open", "Edit");
    inputDelta(h, "c1", "t1", "toolu_open", '{"path":"a.ts"}');
    void makeAsk(h.askBridge, "toolu_ask", "c1");
    void makeAsk(h.askBridge, "toolu_other", "c2");

    const snapshot = await h.projector.snapshot();

    expect(snapshot.seq).toBe(4);
    expect(snapshot.seq).toBe(h.projector.latestSeq);
    expect(snapshot.active).toEqual({
      conversationId: "c1",
      title: "Fix it",
      running: true,
      queued: 2,
    });
    expect(snapshot.pendingApprovals).toEqual([
      {
        toolUseId: "toolu_ask",
        tool: "Bash",
        summaryHint: "run a command",
        input: { command: "ls" },
        conversationId: "c1",
      },
      {
        toolUseId: "toolu_other",
        tool: "Bash",
        summaryHint: "run a command",
        input: { command: "ls" },
        conversationId: "c2",
      },
    ]);
    expect(snapshot.openToolCalls).toEqual([
      { toolUseId: "toolu_open", name: "Edit", input: { path: "a.ts" } },
    ]);
    expect(snapshot.transcriptTail).toHaveLength(20);
    expect(snapshot.transcriptTail[0]).toEqual({ role: "user", text: "u16" });
    expect(snapshot.transcriptTail[19]).toEqual({
      role: "assistant",
      text: "a25",
    });
    expect(
      snapshot.transcriptTail.every((entry) => entry.text.length > 0)
    ).toBe(true);
    // System, tool and thinking blocks are not transcript-tail content.
    const tailTexts = snapshot.transcriptTail.map((entry) => entry.text);
    expect(tailTexts).not.toContain("system prompt");
    expect(tailTexts).not.toContain("hidden");
    expect(h.loaded).toEqual(["c1"]);

    // Events after the snapshot boundary follow it.
    emitStream(h, "c1", "t1", { type: "text_delta", text: "later" });
    expect(h.projector.latestSeq).toBe(snapshot.seq + 1);
  });

  test("a missing transcript omits title and tail but keeps the rest", async () => {
    const h = createHarness();
    activate(h, "c1");
    h.projector.start();
    emitStream(h, "c1", "t1", { type: "text_delta", text: "hi" });

    const snapshot = await h.projector.snapshot();

    expect(snapshot.active).toEqual({
      conversationId: "c1",
      running: true,
      queued: 0,
    });
    expect(snapshot.active !== null && "title" in snapshot.active).toBe(false);
    expect(snapshot.transcriptTail).toEqual([]);
    expect(snapshot.seq).toBe(1);
  });

  test("no active conversation: active null, no transcript read", async () => {
    const h = createHarness();
    const snapshot = await h.projector.snapshot();
    expect(snapshot.active).toBeNull();
    expect(snapshot.transcriptTail).toEqual([]);
    expect(h.loaded).toEqual([]);

    activate(h, null);
    const draft = await h.projector.snapshot();
    expect(draft.active).toEqual({
      conversationId: null,
      running: true,
      queued: 0,
    });
    expect(h.loaded).toEqual([]);
  });
});

// -- lifecycle and ring -------------------------------------------------------

describe("lifecycle and ring", () => {
  test("unsubscribe stops delivery for that consumer only", () => {
    const h = createHarness();
    const other: SeatEvent[] = [];
    const unsubscribe = h.projector.subscribeLive((event) => other.push(event));
    activate(h, "c1");
    h.projector.start();
    emitStream(h, "c1", "t1", { type: "text_delta", text: "one" });
    unsubscribe();
    emitStream(h, "c1", "t1", { type: "text_delta", text: "two" });

    expect(kinds(h.events)).toEqual(["text", "text"]);
    expect(other.map((event) => event.event)).toEqual([
      { kind: "text", delta: "one" },
    ]);
  });

  test("stop clears the live delivery set; a restart does not revive old subscribers", () => {
    const h = createHarness();
    activate(h, "c1");
    h.projector.start();
    emitStream(h, "c1", "t1", { type: "text_delta", text: "before" });
    expect(kinds(h.events)).toEqual(["text"]);

    h.projector.stop();
    h.projector.start();
    emitStream(h, "c1", "t1", { type: "text_delta", text: "after" });
    expect(kinds(h.events)).toEqual(["text"]);
  });

  test("stop unsubscribes and drops late events; the ring stays readable", () => {
    const h = createHarness();
    activate(h, "c1");
    h.projector.start();
    emitStream(h, "c1", "t1", { type: "text_delta", text: "before" });
    const seqBefore = h.projector.latestSeq;

    h.projector.stop();
    expect(h.hub.listeners()).toBe(0);
    expect(h.sink.listeners()).toBe(0);

    emitStream(h, "c1", "t1", { type: "text_delta", text: "after" });
    void makeAsk(h.askBridge, "toolu_1", "c1");

    expect(kinds(h.events)).toEqual(["text"]);
    expect(h.projector.latestSeq).toBe(seqBefore);
    expect(h.projector.replaySince(0)).toHaveLength(1);
  });

  test("replaySince returns the retained window in order", () => {
    const h = createHarness();
    activate(h, "c1");
    h.projector.start();
    for (const delta of ["a", "b", "c"]) {
      emitStream(h, "c1", "t1", { type: "text_delta", text: delta });
    }

    expect(h.projector.oldestSeq).toBe(1);
    expect(h.projector.latestSeq).toBe(3);
    expect(h.projector.replaySince(0).map((event) => event.seq)).toEqual([
      1, 2, 3,
    ]);
    expect(h.projector.replaySince(2).map((event) => event.seq)).toEqual([3]);
    expect(h.projector.replaySince(3)).toEqual([]);
  });

  test("the ring keeps the last 2000 events", () => {
    const h = createHarness();
    activate(h, "c1");
    h.projector.start();
    for (let index = 0; index < 2005; index += 1) {
      emitStream(h, "c1", "t1", { type: "text_delta", text: `d${index}` });
    }

    expect(h.projector.latestSeq).toBe(2005);
    expect(h.projector.oldestSeq).toBe(6);
    expect(h.projector.replaySince(0)).toHaveLength(2000);
    expect(h.projector.replaySince(0)[0]?.seq).toBe(6);
  });
});
