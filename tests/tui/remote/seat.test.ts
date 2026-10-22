/**
 * Remote seat assembly tests (spec specs/remote-sync.md §3.1, §4.5-§4.6, §5;
 * plan tasks 4 and 6).
 *
 * Every case uses a temp data dir and synthetic event content; the repository
 * `data/` dir and real session dirs are never touched. The socket cases use a
 * real Unix socket and a real NDJSON client, because the contract under test
 * is transport + filesystem behavior, not a mock's shape.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type Socket } from "node:net";
import { createNdjsonDecoder } from "../../../src/remote-api/codec.js";
import type {
  RemoteServerMessage,
  RemoteWelcomeMessage,
  SeatEvent,
  Snapshot,
} from "../../../src/remote-api/protocol.js";
import type { HubEvent } from "../../../src/session-api/hub.js";
import type { TurnOutcomeView } from "../../../src/session-api/contract.js";
import { createTuiAskUserBridge } from "../../../src/tui/ask-user.js";
import type { TuiToolEvent } from "../../../src/tui/deps.js";
import {
  createRemoteInputPort,
  type RemoteInputBindings,
  type RemoteInputPort,
} from "../../../src/tui/remote/input-port.js";
import {
  createSeatProjector,
  type ProjectionActiveState,
} from "../../../src/tui/remote/projector.js";
import {
  createRemoteSeatLifecycle,
  createSeatHost,
  isRemoteSeatConfigured,
  startRemoteSeat,
  type RemoteSeatHandle,
  type StartRemoteSeatOptions,
} from "../../../src/tui/remote/seat.js";
import type { TuiLoadedSessionFile } from "../../../src/tui/session-state.js";

const NOW = "2026-01-01T00:00:00.000Z";
const CWD = "/tmp/iknow-seat-test-cwd";
const MAX_LINE_BYTES = 1024 * 1024;

// -- temp dirs ----------------------------------------------------------------

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    if (cleanup) await cleanup();
  }
});

function createDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "iknow-seat-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function socketPathOf(dataDir: string): string {
  return join(dataDir, "run", "remote.sock");
}

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
    listeners: () => listeners.size,
  };
}

function syntheticTranscript(conversationId: string): TuiLoadedSessionFile {
  return {
    schemaVersion: 5,
    conversation_id: conversationId,
    messages: [],
    jsonMode: false,
    turnCount: 0,
    updatedAt: NOW,
    title: `title ${conversationId}`,
    cwd: CWD,
    sanitized_at: NOW,
  };
}

interface BindingsLog {
  readonly sends: string[];
  readonly approvals: Array<{ toolUseId: string; answer: string }>;
  aborts: number;
}

function bindInputPort(port: RemoteInputPort): BindingsLog {
  const log: BindingsLog = { sends: [], approvals: [], aborts: 0 };
  const bindings: RemoteInputBindings = {
    getActiveConversationId: () => "c1",
    sendMessage: (text) => {
      log.sends.push(text);
      return "sent";
    },
    answerApproval: (toolUseId, answer) => {
      log.approvals.push({ toolUseId, answer });
      return "ok";
    },
    abort: () => {
      log.aborts += 1;
      return { interrupted: true };
    },
  };
  cleanups.push(port.bind(bindings));
  return log;
}

interface Harness {
  readonly options: StartRemoteSeatOptions;
  readonly hub: FakeHub;
  readonly sink: FakeSink;
  readonly askBridge: ReturnType<typeof createTuiAskUserBridge>;
  readonly port: RemoteInputPort;
  readonly log: BindingsLog;
  readonly notices: string[];
}

function createHarness(
  settings: StartRemoteSeatOptions["settings"],
  overrides: Partial<StartRemoteSeatOptions> = {}
): Harness {
  const dataDir = createDataDir();
  const hub = createFakeHub();
  const sink = createFakeSink();
  const askBridge = createTuiAskUserBridge();
  const port = createRemoteInputPort();
  const log = bindInputPort(port);
  const notices: string[] = [];
  const options: StartRemoteSeatOptions = {
    settings,
    dataDir,
    cwd: CWD,
    hub: hub.hub,
    askBridge,
    toolEventSink: sink.sink,
    loadTranscript: async (conversationId) =>
      syntheticTranscript(conversationId),
    inputPort: port,
    onNotice: (text) => notices.push(text),
    ...overrides,
  };
  return { options, hub, sink, askBridge, port, log, notices };
}

async function start(
  harness: Harness,
  overrides: Partial<StartRemoteSeatOptions> = {}
): Promise<RemoteSeatHandle> {
  const handle = await startRemoteSeat({ ...harness.options, ...overrides });
  cleanups.push(() => handle.stop());
  return handle;
}

function active(conversationId: string): ProjectionActiveState {
  return { conversationId, running: true, queued: 0 };
}

function knownStop(
  stopReason: "completed" | "cancelled" | "timeout"
): TurnOutcomeView {
  return { terminal: "known", stopReason };
}

// -- test client --------------------------------------------------------------

interface TestClient {
  readonly socket: Socket;
  send(value: unknown): void;
  next(
    match?: (message: RemoteServerMessage) => boolean
  ): Promise<RemoteServerMessage>;
  readonly closed: Promise<void>;
}

function createClient(socketPath: string): TestClient {
  const socket = connect(socketPath);
  const decoder = createNdjsonDecoder({ maxLineBytes: MAX_LINE_BYTES });
  const messages: RemoteServerMessage[] = [];
  let cursor = 0;
  let wake: (() => void) | undefined;
  const closed = new Promise<void>((resolve) => {
    socket.once("close", () => resolve());
  });
  socket.on("data", (chunk: Buffer) => {
    for (const line of decoder.push(chunk).lines) {
      if (line.trim().length === 0) continue;
      messages.push(JSON.parse(line) as RemoteServerMessage);
    }
    wake?.();
    wake = undefined;
  });
  socket.on("error", () => {
    // A destroyed client is an expected end in the stop case.
  });
  const next = async (
    match?: (message: RemoteServerMessage) => boolean
  ): Promise<RemoteServerMessage> => {
    for (;;) {
      while (cursor < messages.length) {
        const message = messages[cursor] as RemoteServerMessage;
        cursor += 1;
        if (match === undefined || match(message)) return message;
      }
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("timed out waiting for a seat frame")),
          5000
        );
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
  };
  return {
    socket,
    send: (value) => socket.write(`${JSON.stringify(value)}\n`),
    next,
    closed,
  };
}

async function handshake(client: TestClient): Promise<RemoteWelcomeMessage> {
  client.send({
    type: "hello",
    protocol: [1],
    client: { name: "seat-test-client", version: "0.0.0" },
  });
  const message = await client.next((m) => m.type === "welcome");
  if (message.type !== "welcome") throw new Error("expected welcome");
  return message;
}

function successFields(message: RemoteServerMessage): Record<string, unknown> {
  if (message.type !== "result")
    throw new Error(`expected result, got ${message.type}`);
  if (!message.ok)
    throw new Error(`expected success, got ${message.error.code}`);
  return message as unknown as Record<string, unknown>;
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

// -- configuration ------------------------------------------------------------

describe("isRemoteSeatConfigured", () => {
  test("enabled or a publishable notify section needs assembly; nothing else does", () => {
    expect(isRemoteSeatConfigured(undefined)).toBe(false);
    expect(isRemoteSeatConfigured({})).toBe(false);
    expect(isRemoteSeatConfigured({ enabled: false })).toBe(false);
    expect(
      isRemoteSeatConfigured({ notify: { url: "https://ntfy.example.test" } })
    ).toBe(false);
    expect(
      isRemoteSeatConfigured({ notify: { topic: "iknow-test-topic" } })
    ).toBe(false);
    expect(isRemoteSeatConfigured({ enabled: true })).toBe(true);
    expect(
      isRemoteSeatConfigured({
        notify: { url: "https://ntfy.example.test", topic: "iknow-test-topic" },
      })
    ).toBe(true);
  });
});

// -- disabled / enabled -------------------------------------------------------

describe("startRemoteSeat lifecycle", () => {
  test("disabled and no notify: no socket path and no socket file", async () => {
    const harness = createHarness({});
    const handle = await start(harness);
    expect(handle.socketPath).toBeUndefined();
    expect(existsSync(socketPathOf(harness.options.dataDir))).toBe(false);
    expect(harness.hub.listeners()).toBe(0);
  });

  test("enabled: private dir / socket modes, handshake, snapshot, bound inputs", async () => {
    const harness = createHarness({ enabled: true });
    const handle = await start(harness);
    const dataDir = harness.options.dataDir;
    const runDir = join(dataDir, "run");
    const socketPath = socketPathOf(dataDir);
    expect(handle.socketPath).toBe(socketPath);
    expect(statSync(runDir).mode & 0o777).toBe(0o700);
    const socketInfo = statSync(socketPath);
    expect(socketInfo.isSocket()).toBe(true);
    expect(socketInfo.mode & 0o777).toBe(0o600);

    handle.setActive(active("c1"));
    const client = createClient(socketPath);
    cleanups.push(() => {
      client.socket.destroy();
    });
    const welcome = await handshake(client);
    expect(welcome.protocol).toBe(1);
    expect(welcome.instanceId).toBe(handle.instanceId);
    expect(welcome.pid).toBe(process.pid);
    expect(welcome.cwd).toBe(CWD);
    expect(welcome.iknowVersion.length).toBeGreaterThan(0);

    client.send({ type: "subscribe", id: "s1" });
    const subscribeFields = successFields(
      await client.next((m) => m.type === "result")
    );
    expect(subscribeFields["mode"]).toBe("snapshot");
    const snapshot = subscribeFields["snapshot"] as Snapshot;
    expect(snapshot.active?.conversationId).toBe("c1");
    expect(snapshot.active?.title).toBe("title c1");

    harness.hub.emit({
      kind: "stream",
      conversationId: "c1",
      turnId: "turn-1",
      event: { type: "text_delta", text: "live line" },
    });
    const live = await client.next((m) => m.type === "event");
    if (live.type !== "event") throw new Error("expected a live event");
    expect(live.seq).toBeGreaterThan(snapshot.seq);
    expect(live.event).toEqual({ kind: "text", delta: "live line" });

    client.send({ type: "send_message", id: "m1", text: "from the phone" });
    const sendFields = successFields(
      await client.next((m) => m.type === "result")
    );
    expect(sendFields["status"]).toBe("sent");
    expect(harness.log.sends).toEqual(["from the phone"]);

    client.send({ type: "abort", id: "a1" });
    const abortFields = successFields(
      await client.next((m) => m.type === "result")
    );
    expect(abortFields["interrupted"]).toBe(true);
    expect(harness.log.aborts).toBe(1);
  });

  // -- notify-only ------------------------------------------------------------

  test("notify-only: no socket; turn end and approval each publish exactly once", async () => {
    const posts: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (
      input: Parameters<typeof fetch>[0],
      init?: RequestInit
    ): Promise<Response> => {
      posts.push({ url: String(input), init: init ?? {} });
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    const clock = { now: 1000 };
    const harness = createHarness(
      {
        notify: {
          url: "https://ntfy.example.test",
          topic: "iknow-test-topic",
          turnEndMinMs: 0,
        },
      },
      { fetchImpl, now: () => clock.now }
    );
    const handle = await start(harness);
    expect(handle.socketPath).toBeUndefined();
    expect(existsSync(socketPathOf(harness.options.dataDir))).toBe(false);

    handle.setActive(active("c1"));
    harness.hub.emit({
      kind: "turn_started",
      conversationId: "c1",
      turnId: "turn-1",
    });
    clock.now = 1500;
    harness.hub.emit({
      kind: "turn_ended",
      conversationId: "c1",
      turnId: "turn-1",
      outcome: knownStop("completed"),
    });
    await flush();
    expect(posts.length).toBe(1);
    expect(posts[0]?.url).toBe("https://ntfy.example.test/iknow-test-topic");
    expect(posts[0]?.init.body).toBe("completed");
    const headers = posts[0]?.init.headers as Record<string, string>;
    expect(headers.Title).toBe("iknow: turn finished");

    void harness.askBridge.ask({
      tool: "Bash",
      input: { command: "ls" },
      summaryHint: "run a command",
      toolUseId: "toolu_1",
      conversationId: "c1",
    });
    await flush();
    expect(posts.length).toBe(2);
    expect(posts[1]?.init.body).toBe("Bash is waiting for approval");
    const approvalHeaders = posts[1]?.init.headers as Record<string, string>;
    expect(approvalHeaders.Title).toBe("iknow: approval needed");
    const pending = harness.askBridge.pendingAll();
    expect(pending.length).toBe(1);
    harness.askBridge.resolveAsk(pending[0]!.id, false);
  });

  // -- held / stale -----------------------------------------------------------

  test("catch-up replays retained events for this instance; another instance gets a snapshot", async () => {
    const harness = createHarness({ enabled: true });
    const handle = await start(harness);
    handle.setActive(active("c1"));
    harness.hub.emit({
      kind: "stream",
      conversationId: "c1",
      turnId: "turn-1",
      event: { type: "text_delta", text: "one" },
    });
    harness.hub.emit({
      kind: "stream",
      conversationId: "c1",
      turnId: "turn-1",
      event: { type: "text_delta", text: "two" },
    });

    const client = createClient(socketPathOf(harness.options.dataDir));
    cleanups.push(() => {
      client.socket.destroy();
    });
    await handshake(client);
    client.send({
      type: "subscribe",
      id: "s-catchup",
      instanceId: handle.instanceId,
      sinceSeq: 1,
    });
    const fields = successFields(await client.next((m) => m.type === "result"));
    expect(fields["mode"]).toBe("catchup");
    expect(fields["fromSeq"]).toBe(1);
    const replayed = await client.next((m) => m.type === "event");
    if (replayed.type !== "event") throw new Error("expected a replayed event");
    expect(replayed.seq).toBe(2);
    expect(replayed.event).toEqual({ kind: "text", delta: "two" });

    harness.hub.emit({
      kind: "stream",
      conversationId: "c1",
      turnId: "turn-1",
      event: { type: "text_delta", text: "three" },
    });
    const live = await client.next((m) => m.type === "event");
    if (live.type !== "event") throw new Error("expected a live event");
    expect(live.seq).toBe(3);
    expect(live.event).toEqual({ kind: "text", delta: "three" });

    const other = createClient(socketPathOf(harness.options.dataDir));
    cleanups.push(() => {
      other.socket.destroy();
    });
    await handshake(other);
    other.send({
      type: "subscribe",
      id: "s-other",
      instanceId: "another-instance",
      sinceSeq: 3,
    });
    const otherFields = successFields(
      await other.next((m) => m.type === "result")
    );
    expect(otherFields["mode"]).toBe("snapshot");
    expect((otherFields["snapshot"] as Snapshot).seq).toBe(3);
  });

  test("held seat: the second start reports the holder pid and the first keeps working", async () => {
    const first = createHarness({ enabled: true });
    const firstHandle = await start(first);
    const second = createHarness(
      { enabled: true },
      { dataDir: first.options.dataDir }
    );
    const secondHandle = await start(second);

    expect(secondHandle.socketPath).toBeUndefined();
    expect(second.notices.join("\n")).toContain(String(process.pid));

    const client = createClient(socketPathOf(first.options.dataDir));
    cleanups.push(() => {
      client.socket.destroy();
    });
    await handshake(client);
    client.send({ type: "ping", id: "p1" });
    const fields = successFields(await client.next((m) => m.type === "result"));
    expect(fields).toEqual({ type: "result", id: "p1", ok: true });
    expect(firstHandle.socketPath).toBe(socketPathOf(first.options.dataDir));
  });

  test("stale socket file: reclaimed and noticed", async () => {
    const harness = createHarness({ enabled: true });
    const dataDir = harness.options.dataDir;
    mkdirSync(join(dataDir, "run"), { mode: 0o700 });
    writeFileSync(socketPathOf(dataDir), "");
    const handle = await start(harness);
    expect(harness.notices.join("\n")).toContain("stale");
    expect(handle.socketPath).toBe(socketPathOf(dataDir));
    expect(statSync(socketPathOf(dataDir)).isSocket()).toBe(true);
  });

  test("unsafe run directory: notice, no socket, no throw", async () => {
    const harness = createHarness({ enabled: true });
    mkdirSync(join(harness.options.dataDir, "run"), { mode: 0o755 });
    const handle = await start(harness);
    expect(handle.socketPath).toBeUndefined();
    expect(existsSync(socketPathOf(harness.options.dataDir))).toBe(false);
    expect(harness.notices.join("\n")).toContain("private directory");
  });

  // -- stop -------------------------------------------------------------------

  test("stop sends goodbye, unlinks the socket and is safe twice", async () => {
    const harness = createHarness({ enabled: true });
    const handle = await start(harness);
    const socketPath = socketPathOf(harness.options.dataDir);
    const client = createClient(socketPath);
    cleanups.push(() => {
      client.socket.destroy();
    });
    await handshake(client);

    await handle.stop();
    const goodbye = await client.next((m) => m.type === "goodbye");
    expect(goodbye).toMatchObject({ type: "goodbye", reason: "tui_exit" });
    expect(existsSync(socketPath)).toBe(false);
    await handle.stop();
    expect(existsSync(socketPath)).toBe(false);
  });
});

// -- seat host live delivery --------------------------------------------------

/** The reply's cleanup, pinned as present on both subscribe branches. */
function unsubscribeOf(reply: {
  readonly unsubscribe?: () => void;
}): () => void {
  const unsubscribe = reply.unsubscribe;
  if (unsubscribe === undefined) {
    throw new Error("subscribe reply is missing unsubscribe");
  }
  return unsubscribe;
}

describe("createSeatHost live delivery", () => {
  test("a released client no longer receives projector events; the next one does", async () => {
    const hub = createFakeHub();
    const sink = createFakeSink();
    const askBridge = createTuiAskUserBridge();
    const projector = createSeatProjector({
      instanceId: "seat-host-test",
      hub: hub.hub,
      askBridge,
      toolEventSink: sink.sink,
      loadTranscript: async (conversationId) =>
        syntheticTranscript(conversationId),
      now: () => NOW,
    });
    projector.setActive(active("c1"));
    projector.start();
    cleanups.push(() => projector.stop());

    const host = createSeatHost({
      instanceId: "seat-host-test",
      cwd: CWD,
      projector,
      inputPort: createRemoteInputPort(),
    });
    const first: SeatEvent[] = [];
    const second: SeatEvent[] = [];
    const firstReply = await host.subscribe({}, (event) => first.push(event));
    const secondReply = await host.subscribe({}, (event) => second.push(event));
    expect(firstReply.mode).toBe("snapshot");
    expect(secondReply.mode).toBe("snapshot");

    unsubscribeOf(firstReply)();
    hub.emit({
      kind: "user_message",
      conversationId: "c1",
      text: "synthetic reconnect message",
      origin: "remote",
    });
    expect(first).toEqual([]);
    expect(second.map((event) => event.event.kind)).toEqual(["user_message"]);

    // The catch-up branch carries the same cleanup; the snapshot client was
    // released too, so neither sees the next event.
    unsubscribeOf(secondReply)();
    const third: SeatEvent[] = [];
    const catchup = await host.subscribe(
      { instanceId: "seat-host-test", sinceSeq: 0 },
      (event) => third.push(event)
    );
    expect(catchup.mode).toBe("catchup");
    unsubscribeOf(catchup)();
    hub.emit({
      kind: "user_message",
      conversationId: "c1",
      text: "synthetic after release",
      origin: "local",
    });
    expect(first).toEqual([]);
    expect(second).toHaveLength(1);
    expect(third).toEqual([]);
  });
});

// -- TUI lifetime wrapper -----------------------------------------------------

describe("createRemoteSeatLifecycle", () => {
  test("a start that resolves after stop was requested stops immediately", async () => {
    const harness = createHarness({ enabled: true });
    const stops: string[] = [];
    let resolveStart!: (handle: RemoteSeatHandle) => void;
    const pending = new Promise<RemoteSeatHandle>((resolve) => {
      resolveStart = resolve;
    });
    const lifecycle = createRemoteSeatLifecycle(
      {
        settings: harness.options.settings,
        dataDir: harness.options.dataDir,
        cwd: CWD,
        hub: harness.hub.hub,
        askBridge: harness.askBridge,
        toolEventSink: harness.sink.sink,
        loadTranscript: harness.options.loadTranscript,
        inputPort: harness.port,
      },
      () => pending
    );
    lifecycle.startAfterMount();
    await lifecycle.stop();
    expect(stops).toEqual([]);

    resolveStart({
      instanceId: "fake-instance",
      socketPath: undefined,
      setActive: () => undefined,
      stop: async () => {
        stops.push("stop");
      },
    });
    await flush();
    expect(stops).toEqual(["stop"]);
    await lifecycle.stop();
    expect(stops).toEqual(["stop"]);
  });

  test("buffers the latest projection state and notices until sinks are bound", async () => {
    const harness = createHarness({ enabled: true });
    const applied: Array<ProjectionActiveState | undefined> = [];
    const lifecycle = createRemoteSeatLifecycle(
      {
        settings: harness.options.settings,
        dataDir: harness.options.dataDir,
        cwd: CWD,
        hub: harness.hub.hub,
        askBridge: harness.askBridge,
        toolEventSink: harness.sink.sink,
        loadTranscript: harness.options.loadTranscript,
        inputPort: harness.port,
      },
      async (options) => {
        options.onNotice?.("remote seat: buffered notice");
        return {
          instanceId: "fake-instance",
          socketPath: undefined,
          setActive: (state) => {
            applied.push(state);
          },
          stop: async () => undefined,
        };
      }
    );
    const first = active("c1");
    lifecycle.setProjectionActive(first);
    lifecycle.startAfterMount();
    await flush();
    expect(applied).toEqual([first]);

    const lines: string[] = [];
    const unbind = lifecycle.registerNoticeSink((line) => lines.push(line));
    expect(lines).toEqual(["remote seat: buffered notice"]);
    unbind();
    lifecycle.setProjectionActive(active("c2"));
    expect(applied).toEqual([first, active("c2")]);
  });
});
