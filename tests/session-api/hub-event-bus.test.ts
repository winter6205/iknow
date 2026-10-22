/**
 * SessionHub event bus (spec remote-sync §4.1): every stream event of
 * postMessage / continueSession / compactSession reaches subscribers in
 * addition to the caller's onStream, plus user_message (with its origin) and
 * exactly one turn_started / turn_ended pair per accepted turn. Compaction is
 * correlated but is not a turn. Listener faults are isolated; unsubscribe
 * removes the listener; the caller's onStream contract is unchanged.
 */
import { afterAll, beforeAll, describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionHub } from "../../src/session-api/hub.ts";
import type { HubEvent } from "../../src/session-api/hub.ts";
import {
  CURRENT_SCHEMA_VERSION,
  SessionStore,
} from "../../src/session-api/store/index.ts";
import type { SessionFileV1 } from "../../src/session-api/store/index.ts";
import type {
  AnthropicNativeMessage,
  HarnessStreamEvent,
  LoopEngineDeps,
} from "../../src/harness/index.ts";
import type { SubAgentManager } from "../../src/harness/subagent/manager.ts";
import { assistantResult, makeDeps } from "../cli/_fixtures.ts";

let baseDir: string;
let store: SessionStore;

beforeAll(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "iknow-hub-event-bus-"));
  store = new SessionStore(baseDir, process.cwd());
});

afterAll(async () => {
  await rm(baseDir, { recursive: true, force: true });
});

function makeHub(deps: LoopEngineDeps): SessionHub {
  return new SessionHub({ store, deps, workspaceRoot: process.cwd() });
}

/** Record every bus event this hub publishes, in order. */
function collect(hub: SessionHub): HubEvent[] {
  const events: HubEvent[] = [];
  hub.subscribeEvents((event) => events.push(event));
  return events;
}

function streamEvents(events: readonly HubEvent[]): HarnessStreamEvent[] {
  return events.flatMap((event) =>
    event.kind === "stream" ? [event.event] : []
  );
}

function kinds(events: readonly HubEvent[]): string[] {
  return events.map((event) => event.kind);
}

/** The host-scripted stream events, without the engine's own occupancy beat
 *  (ADR-0118: the engine publishes its per-call context reading on the same
 *  channel). */
function scriptedStreamEvents(
  events: readonly HarnessStreamEvent[]
): HarnessStreamEvent[] {
  return events.filter((event) => event.type !== "context_usage");
}

function userText(text: string): AnthropicNativeMessage {
  return { role: "user", content: [{ type: "text", text }] };
}

function assistantText(text: string): AnthropicNativeMessage {
  return { role: "assistant", content: [{ type: "text", text }] };
}

/** Seed one session file directly (continue / compact need a pre-existing shape). */
async function seed(
  id: string,
  messages: ReadonlyArray<AnthropicNativeMessage>
): Promise<void> {
  const file: SessionFileV1 = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    conversation_id: id,
    title: "",
    cwd: "/tmp/test",
    sanitized_at: new Date().toISOString(),
    messages,
    jsonMode: false,
    turnCount: 0,
    updatedAt: new Date().toISOString(),
    checkpoints: [],
    workspaceRoot: process.cwd(),
  };
  await store.save({ id, file });
}

describe("hub event bus — postMessage", () => {
  it("fans stream events out to subscribers and the caller, with one turn bracket", async () => {
    const scripted: HarnessStreamEvent[] = [
      { type: "text_delta", text: "hel" },
      { type: "text_delta", text: "lo" },
    ];
    const hub = makeHub(
      makeDeps([assistantResult({ texts: ["hello"] })], {
        streamEventsByStep: [scripted],
      })
    );
    const { session } = await hub.createSession();
    const conversationId = session.conversation_id;
    const events = collect(hub);
    const callerEvents: HarnessStreamEvent[] = [];

    const response = await hub.postMessage({
      conversationId,
      text: "ping",
      origin: "remote",
      onStream: (event) => callerEvents.push(event),
    });

    assert.equal(response.turn.answer.finalText, "hello");
    // user_message → turn_started → stream… → turn_ended, exactly one turn.
    assert.equal(events[0]?.kind, "user_message");
    const first = events[0];
    assert.ok(first?.kind === "user_message");
    assert.equal(first.conversationId, conversationId);
    assert.equal(first.text, "ping");
    assert.equal(first.origin, "remote");
    assert.equal(events[1]?.kind, "turn_started");

    const started = events[1];
    assert.ok(started?.kind === "turn_started");
    assert.equal(started.conversationId, conversationId);
    assert.ok(started.turnId.length > 0);

    const ended = events[events.length - 1];
    assert.ok(ended?.kind === "turn_ended");
    assert.equal(ended.conversationId, conversationId);
    assert.equal(ended.turnId, started.turnId);
    assert.equal(ended.outcome.terminal, "known");
    assert.ok(ended.outcome.terminal === "known");
    assert.equal(ended.outcome.stopReason, "completed");

    assert.equal(
      kinds(events).filter((kind) => kind === "turn_started").length,
      1
    );
    assert.equal(
      kinds(events).filter((kind) => kind === "turn_ended").length,
      1
    );
    // Every forwarded event carries the one turn id, and the caller's onStream
    // saw exactly the same events (the bus is additive, not a replacement).
    for (const event of events) {
      if (event.kind === "stream") assert.equal(event.turnId, started.turnId);
    }
    assert.deepEqual(streamEvents(events), callerEvents);
    assert.deepEqual(scriptedStreamEvents(callerEvents), scripted);
  });

  it("defaults the origin to local", async () => {
    const hub = makeHub(makeDeps([assistantResult({ texts: ["ok"] })]));
    const { session } = await hub.createSession();
    const events = collect(hub);
    await hub.postMessage({
      conversationId: session.conversation_id,
      text: "typed",
    });
    const message = events[0];
    assert.ok(message?.kind === "user_message");
    assert.equal(message.origin, "local");
  });

  it("reports turn_ended once with terminal unknown when the turn rejects", async () => {
    const hub = makeHub(makeDeps([]));
    const events = collect(hub);
    await assert.rejects(() =>
      hub.postMessage({ conversationId: "missing-session", text: "hi" })
    );
    assert.equal(events[0]?.kind, "user_message");
    assert.equal(events[1]?.kind, "turn_started");
    const ended = events[events.length - 1];
    assert.ok(ended?.kind === "turn_ended");
    assert.deepEqual(ended.outcome, { terminal: "unknown" });
    assert.equal(
      kinds(events).filter((kind) => kind === "turn_ended").length,
      1
    );
  });

  it("reports the settled stop reason for a failed turn", async () => {
    // No scripted response → the first step raises ProtocolError; the hub
    // settles with its own terminal outcome (not a rejection).
    const hub = makeHub(makeDeps([]));
    const { session } = await hub.createSession();
    const events = collect(hub);
    const response = await hub.postMessage({
      conversationId: session.conversation_id,
      text: "fail me",
    });
    assert.equal(response.turn.answer.stopReason, "protocolError");
    const ended = events[events.length - 1];
    assert.ok(ended?.kind === "turn_ended");
    assert.ok(ended.outcome.terminal === "known");
    assert.equal(ended.outcome.stopReason, "protocolError");
  });

  it("reports the settled stop reason for a cancelled turn", async () => {
    const hub = makeHub(
      makeDeps([assistantResult({ texts: ["late"] })], { delayMs: 400 })
    );
    const { session } = await hub.createSession();
    const events = collect(hub);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const response = await hub.postMessage({
      conversationId: session.conversation_id,
      text: "interrupt me",
      signal: controller.signal,
    });
    assert.equal(response.turn.answer.stopReason, "cancelled");
    const ended = events[events.length - 1];
    assert.ok(ended?.kind === "turn_ended");
    assert.ok(ended.outcome.terminal === "known");
    assert.equal(ended.outcome.stopReason, "cancelled");
  });

  it("subscribers do not change hostStreamPresent (no pre-call probe without onStream)", async () => {
    const inner = makeDeps([assistantResult({ texts: ["one"] })]);
    let countCalls = 0;
    const deps: LoopEngineDeps = {
      ...inner,
      adapter: {
        ...inner.adapter,
        countTokens: async () => {
          countCalls += 1;
          return { inputTokens: 7 };
        },
      },
    };
    const hub = makeHub(deps);
    const { session } = await hub.createSession();
    const events = collect(hub);

    await hub.postMessage({
      conversationId: session.conversation_id,
      text: "no caller stream",
    });
    assert.equal(countCalls, 0);

    await hub.postMessage({
      conversationId: session.conversation_id,
      text: "caller stream",
      onStream: () => {},
    });
    assert.ok(countCalls > 0);
    assert.equal(
      kinds(events).filter((kind) => kind === "stream").length > 0,
      true
    );
  });
});

describe("hub event bus — listener isolation and unsubscribe", () => {
  it("swallows listener faults and keeps the turn and the other listeners intact", async () => {
    const hub = makeHub(
      makeDeps([assistantResult({ texts: ["fine"] })], {
        streamEventsByStep: [[{ type: "text_delta", text: "f" }]],
      })
    );
    const { session } = await hub.createSession();
    hub.subscribeEvents(() => {
      throw new Error("broken seat projector");
    });
    const events = collect(hub);

    const response = await hub.postMessage({
      conversationId: session.conversation_id,
      text: "still runs",
    });

    assert.equal(response.turn.answer.finalText, "fine");
    assert.deepEqual(kinds(events), [
      "user_message",
      "turn_started",
      "stream",
      "turn_ended",
    ]);
  });

  it("stops delivery after unsubscribe", async () => {
    const hub = makeHub(
      makeDeps([
        assistantResult({ texts: ["first"] }),
        assistantResult({ texts: ["second"] }),
      ])
    );
    const { session } = await hub.createSession();
    const events: HubEvent[] = [];
    const unsubscribe = hub.subscribeEvents((event) => events.push(event));
    await hub.postMessage({
      conversationId: session.conversation_id,
      text: "one",
    });
    const afterFirst = events.length;
    assert.ok(afterFirst > 0);

    unsubscribe();
    await hub.postMessage({
      conversationId: session.conversation_id,
      text: "two",
    });
    assert.equal(events.length, afterFirst);
  });
});

describe("hub event bus — continueSession", () => {
  it("publishes turn_started once, the continuation stream and turn_ended once", async () => {
    const hub = makeHub(
      makeDeps([assistantResult({ texts: ["resumed"] })], {
        streamEventsByStep: [[{ type: "text_delta", text: "res" }]],
      })
    );
    const conversationId = "continue-bus";
    await seed(conversationId, [
      userText("do"),
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "noop", input: {} }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
      },
    ]);
    const events = collect(hub);
    const callerEvents: HarnessStreamEvent[] = [];

    const response = await hub.continueSession(conversationId, {
      onStream: (event) => callerEvents.push(event),
    });

    assert.equal(response.turn.answer.finalText, "resumed");
    // The bracket is turn_started → stream(s) → turn_ended: the engine's own
    // occupancy beat rides the stream channel next to the scripted one.
    assert.equal(kinds(events)[0], "turn_started");
    assert.equal(kinds(events).at(-1), "turn_ended");
    assert.ok(
      kinds(events)
        .slice(1, -1)
        .every((kind) => kind === "stream")
    );
    const started = events[0];
    const ended = events[events.length - 1];
    assert.ok(started?.kind === "turn_started");
    assert.ok(ended?.kind === "turn_ended");
    assert.equal(started.conversationId, conversationId);
    assert.equal(ended.conversationId, conversationId);
    assert.equal(ended.turnId, started.turnId);
    assert.ok(ended.outcome.terminal === "known");
    assert.equal(ended.outcome.stopReason, "completed");
    assert.deepEqual(callerEvents, streamEvents(events));
    assert.equal(callerEvents[0]?.type, "text_delta");
  });

  it("publishes no turn bracket when the continuity predicate rejects", async () => {
    const hub = makeHub(makeDeps([]));
    const { session } = await hub.createSession();
    const events = collect(hub);
    await assert.rejects(() => hub.continueSession(session.conversation_id));
    assert.deepEqual(events, []);
  });
});

describe("hub event bus — compactSession", () => {
  const history: ReadonlyArray<AnthropicNativeMessage> = [
    userText("task 1"),
    assistantText("answer 1"),
    userText("task 2"),
    assistantText("answer 2"),
    userText("task 3"),
    assistantText("answer 3"),
    userText("task 4"),
    assistantText("answer 4"),
  ];

  it("publishes a correlated compaction stream without fabricating a turn", async () => {
    // The stub returns empty text for full-compact rounds by design (it keeps
    // its scripted queue for later turns); this wrapper answers the summary
    // call so the compaction succeeds and emits its completed terminal event.
    const inner = makeDeps([]);
    const deps: LoopEngineDeps = {
      ...inner,
      adapter: {
        ...inner.adapter,
        step: (state, request, signal) =>
          request.tools === undefined
            ? Promise.resolve(
                assistantResult({ texts: ["a summary of the dropped tail"] })
              )
            : inner.adapter.step(state, request, signal),
      },
    };
    const hub = makeHub(deps);
    const conversationId = "compact-bus";
    await seed(conversationId, history);
    const events = collect(hub);
    const callerEvents: HarnessStreamEvent[] = [];

    const response = await hub.compactSession(conversationId, {
      onStream: (event) => callerEvents.push(event),
    });

    assert.equal(response.compacted, true);
    assert.deepEqual(
      kinds(events),
      events.map(() => "stream")
    );
    assert.deepEqual(streamEvents(events), callerEvents);
    assert.ok(
      callerEvents.some((event) => event.type === "compaction_started"),
      `caller sees the compaction lifecycle: ${JSON.stringify(callerEvents)}`
    );
    assert.ok(
      callerEvents.some((event) => event.type === "compaction_completed"),
      `caller sees the compaction lifecycle: ${JSON.stringify(callerEvents)}`
    );
    const turnIds = new Set(
      events.flatMap((event) => (event.kind === "stream" ? [event.turnId] : []))
    );
    assert.equal(turnIds.size, 1);
    const onlyTurnId = [...turnIds][0];
    assert.equal(typeof onlyTurnId, "string");
    assert.ok((onlyTurnId ?? "").length > 0);
    for (const event of events) {
      if (event.kind === "stream")
        assert.equal(event.conversationId, conversationId);
    }
  });

  it("publishes the compaction stream even when the caller passed no onStream", async () => {
    const hub = makeHub(
      makeDeps([assistantResult({ texts: ["another summary"] })])
    );
    const conversationId = "compact-bus-no-caller";
    await seed(conversationId, history);
    const events = collect(hub);

    const response = await hub.compactSession(conversationId);

    assert.equal(response.compacted, true);
    assert.ok(
      streamEvents(events).some((event) => event.type === "compaction_started"),
      "bus subscribers see compaction without a caller stream"
    );
    assert.equal(
      kinds(events).filter((kind) => kind !== "stream").length,
      0,
      "compaction is not bracketed as a turn"
    );
  });
});

describe("hub event bus — silent subagent wake", () => {
  it("publishes the wake's stream and turn events but no user_message", async () => {
    const completed = [
      {
        taskId: "wake-task",
        envelope: {
          status: "ok" as const,
          summary: "worker done",
          result: "worker result",
        },
      },
    ];
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
      subscribe: () => () => {},
    } as unknown as SubAgentManager;
    const hub = new SessionHub({
      store,
      deps: makeDeps([assistantResult({ texts: ["woken"] })], {
        streamEventsByStep: [[{ type: "text_delta", text: "wake" }]],
      }),
      subagentManager: manager,
      workspaceRoot: process.cwd(),
    });
    const { session } = await hub.createSession();
    const events = collect(hub);
    const callerEvents: HarnessStreamEvent[] = [];

    const response = await hub.wakeFromSubagent({
      conversationId: session.conversation_id,
      onStream: (event) => callerEvents.push(event),
    });

    assert.ok(response !== undefined);
    assert.equal(kinds(events)[0], "turn_started");
    assert.equal(kinds(events).at(-1), "turn_ended");
    assert.ok(
      kinds(events)
        .slice(1, -1)
        .every((kind) => kind === "stream")
    );
    assert.deepEqual(streamEvents(events), callerEvents);
    assert.equal(callerEvents[0]?.type, "text_delta");
    const ended = events[events.length - 1];
    assert.ok(ended?.kind === "turn_ended");
    assert.ok(ended.outcome.terminal === "known");
    assert.equal(ended.outcome.stopReason, "completed");
  });
});
