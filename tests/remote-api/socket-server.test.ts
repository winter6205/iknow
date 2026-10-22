/**
 * Remote seat socket server tests (spec specs/remote-sync.md §5.1-§5.4, §5.7).
 *
 * Why real sockets: the seat's contract is mostly filesystem and stream
 * behaviour — parent-dir/socket modes, stale-socket takeover, live-holder
 * detection, framing, per-connection back-pressure — none of which a mocked
 * socket would exercise. Every case uses a temp directory (never the real
 * data dir) and a fake host, so no session or trace data is involved.
 *
 * Async ordering uses explicit latches (resolve a promise from a data event);
 * the timeouts below only guard against a hung case, they are not the
 * synchronization source.
 */
import { afterEach, describe, it, vi } from "vitest";
import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type Socket } from "node:net";
import { createNdjsonDecoder } from "../../src/remote-api/codec.ts";
import {
  MAX_LINE_BYTES,
  encodeNdjsonMessage,
  type RemoteEventMessage,
  type RemoteResultMessage,
  type RemoteServerMessage,
  type RemoteWelcomeMessage,
  type SeatEvent,
  type SeatEventBody,
  type Snapshot,
} from "../../src/remote-api/protocol.ts";
import { createSeatEventRing } from "../../src/remote-api/ring.ts";
import {
  startRemoteSeatServer,
  type RemoteOperation,
  type RemoteSeatHost,
  type RemoteSeatServer,
  type RemoteSeatSubscribeReply,
} from "../../src/remote-api/socket-server.ts";

const WAIT_MS = 5000;
const TIME = "2026-01-01T00:00:00.000Z";
const EMPTY_SNAPSHOT: Snapshot = {
  seq: 0,
  active: null,
  pendingApprovals: [],
  openToolCalls: [],
  transcriptTail: [],
};

// -- temp dir + cleanup -------------------------------------------------------

interface SeatFixture {
  readonly baseDir: string;
  readonly socketPath: string;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    if (cleanup) await cleanup();
  }
});

async function createFixture(): Promise<SeatFixture> {
  const baseDir = await mkdtemp(join(tmpdir(), "iknow-remote-seat-"));
  cleanups.push(() => rm(baseDir, { recursive: true, force: true }));
  return { baseDir, socketPath: join(baseDir, "run", "remote.sock") };
}

async function startSeat(
  fixture: SeatFixture,
  host: RemoteSeatHost
): Promise<RemoteSeatServer> {
  const result = await startRemoteSeatServer({
    socketPath: fixture.socketPath,
    host,
  });
  if (!result.ok) {
    throw new Error(`seat did not start: ${result.reason} ${result.message}`);
  }
  const server = result.server;
  cleanups.push(() => server.close());
  return server;
}

// -- message narrowing --------------------------------------------------------

function asResult(message: RemoteServerMessage): RemoteResultMessage {
  if (message.type !== "result") {
    throw new Error(`expected a result, got ${message.type}`);
  }
  return message;
}

/** Success fields as a plain record: the payload is a union per request type. */
function successFields(message: RemoteServerMessage): Record<string, unknown> {
  const result = asResult(message);
  assert.equal(result.ok, true);
  return result as unknown as Record<string, unknown>;
}

function failureFields(message: RemoteServerMessage): {
  code: string;
  message: string;
} {
  const result = asResult(message);
  assert.equal(result.ok, false);
  return (result as unknown as { error: { code: string; message: string } })
    .error;
}

function serverError(message: RemoteServerMessage): {
  code: string;
  supported?: readonly number[];
} {
  if (message.type !== "error") {
    throw new Error(`expected a server error, got ${message.type}`);
  }
  return { code: message.code, supported: message.supported };
}

// -- fake host ----------------------------------------------------------------

interface FakeHostOptions {
  instanceId?: string;
  pid?: number;
  maxEvents?: number;
  sendMessage?: (args: {
    text: string;
    conversationId?: string;
  }) => Promise<RemoteOperation<{ status: "sent" | "queued" }>>;
  answerApproval?: (args: {
    toolUseId: string;
    answer: "once" | "always" | "reject";
  }) => Promise<RemoteOperation<Record<string, never>>>;
  abort?: () => Promise<RemoteOperation<{ interrupted: boolean }>>;
  /** Runs inside subscribe, after the sink is registered, before it returns. */
  onSubscribe?: (emit: (body: SeatEventBody) => SeatEvent) => void;
  /** Snapshot-mode reply comes from this async read, not the live ring. */
  asyncSnapshot?: Snapshot;
  /** Fresh live-sink teardown returned by every accepted subscribe. */
  makeUnsubscribe?: () => () => void;
  /** Full subscribe override for tests that control when a reply settles. */
  subscribeDelegate?: (
    args: { instanceId?: string; sinceSeq?: number },
    deliver: (event: SeatEvent) => void
  ) => Promise<RemoteSeatSubscribeReply>;
}

interface FakeHost {
  readonly host: RemoteSeatHost;
  readonly instanceId: string;
  emit(body: SeatEventBody): SeatEvent;
  /** Deliver a hand-built event straight to live sinks, bypassing the ring. */
  live(event: SeatEvent): void;
  readonly calls: {
    sendMessage: Array<{ text: string; conversationId?: string }>;
    answerApproval: Array<{ toolUseId: string; answer: string }>;
    abort: number;
  };
}

function createFakeHost(opts: FakeHostOptions = {}): FakeHost {
  const instanceId = opts.instanceId ?? "inst_test";
  const ring = createSeatEventRing(
    opts.maxEvents !== undefined ? { maxEvents: opts.maxEvents } : {}
  );
  const sinks = new Set<(event: SeatEvent) => void>();
  const calls: FakeHost["calls"] = {
    sendMessage: [],
    answerApproval: [],
    abort: 0,
  };

  const emit = (body: SeatEventBody): SeatEvent => {
    const event = ring.push({ time: TIME, event: body });
    for (const sink of sinks) sink(event);
    return event;
  };

  const live = (event: SeatEvent): void => {
    for (const sink of sinks) sink(event);
  };

  const snapshot = (): Snapshot | Promise<Snapshot> => {
    if (opts.asyncSnapshot !== undefined) {
      return Promise.resolve(opts.asyncSnapshot);
    }
    return {
      seq: ring.latestSeq,
      active: null,
      pendingApprovals: [],
      openToolCalls: [],
      transcriptTail: [],
    };
  };

  const host: RemoteSeatHost = {
    instanceId,
    pid: opts.pid ?? 4242,
    cwd: "/tmp/fake-cwd",
    iknowVersion: "0.1.0",
    snapshot,
    async subscribe(args, deliver) {
      if (opts.subscribeDelegate) return opts.subscribeDelegate(args, deliver);
      sinks.add(deliver);
      opts.onSubscribe?.(emit);
      const unsubscribe = opts.makeUnsubscribe?.();
      const oldest = ring.oldestSeq ?? ring.latestSeq + 1;
      if (
        args.instanceId === instanceId &&
        args.sinceSeq !== undefined &&
        args.sinceSeq >= oldest - 1
      ) {
        return {
          mode: "catchup",
          fromSeq: args.sinceSeq,
          events: ring.replaySince(args.sinceSeq),
          ...(unsubscribe !== undefined ? { unsubscribe } : {}),
        };
      }
      const snapshotReply: RemoteSeatSubscribeReply = {
        mode: "snapshot",
        snapshot: await snapshot(),
        ...(unsubscribe !== undefined ? { unsubscribe } : {}),
      };
      return snapshotReply;
    },
    async sendMessage(args) {
      calls.sendMessage.push(args);
      if (opts.sendMessage) return opts.sendMessage(args);
      return { ok: true, value: { status: "sent" } };
    },
    async answerApproval(args) {
      calls.answerApproval.push(args);
      if (opts.answerApproval) return opts.answerApproval(args);
      return { ok: true, value: {} };
    },
    async abort() {
      calls.abort += 1;
      if (opts.abort) return opts.abort();
      return { ok: true, value: { interrupted: true } };
    },
  };

  return { host, instanceId, emit, live, calls };
}

// -- test client --------------------------------------------------------------

interface TestClient {
  readonly socket: Socket;
  send(value: unknown): void;
  sendRaw(line: string): void;
  next(
    match?: (message: RemoteServerMessage) => boolean
  ): Promise<RemoteServerMessage>;
  received(): readonly RemoteServerMessage[];
  readonly closed: Promise<void>;
}

function createClient(socketPath: string): TestClient {
  const socket = connect(socketPath);
  const decoder = createNdjsonDecoder({ maxLineBytes: MAX_LINE_BYTES });
  const messages: RemoteServerMessage[] = [];
  const waiters: Array<() => void> = [];
  let cursor = 0;
  const closed = new Promise<void>((resolve) => {
    socket.once("close", () => resolve());
  });
  socket.on("data", (chunk: Buffer) => {
    for (const line of decoder.push(chunk).lines) {
      if (line.trim().length === 0) continue;
      messages.push(JSON.parse(line) as RemoteServerMessage);
    }
    while (waiters.length > 0) {
      const wake = waiters.shift();
      if (wake) wake();
    }
  });
  socket.on("error", () => {
    // A destroyed socket is an expected end in the slow-consumer / close cases.
  });

  const waitForArrival = (): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const wake = (): void => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        const index = waiters.indexOf(wake);
        if (index >= 0) waiters.splice(index, 1);
        reject(new Error("timed out waiting for a server message"));
      }, WAIT_MS);
      waiters.push(wake);
    });

  return {
    socket,
    closed,
    received(): readonly RemoteServerMessage[] {
      return messages.slice();
    },
    send(value: unknown): void {
      socket.write(encodeNdjsonMessage(value));
    },
    sendRaw(line: string): void {
      socket.write(line);
    },
    async next(
      match: (message: RemoteServerMessage) => boolean = () => true
    ): Promise<RemoteServerMessage> {
      for (;;) {
        for (let index = cursor; index < messages.length; index += 1) {
          const message = messages[index];
          if (message && match(message)) {
            cursor = index + 1;
            return message;
          }
        }
        await waitForArrival();
      }
    },
  };
}

async function handshake(
  client: TestClient,
  protocol: readonly number[] = [1]
): Promise<RemoteServerMessage> {
  client.send({
    type: "hello",
    protocol,
    client: { name: "seat-test", version: "0.0.0" },
  });
  return client.next((message) => message.type === "welcome");
}

async function nextEvent(client: TestClient): Promise<RemoteEventMessage> {
  const message = await client.next((m) => m.type === "event");
  if (message.type !== "event") throw new Error("unreachable");
  return message;
}

function delta(text: string): SeatEventBody {
  return { kind: "text", delta: text };
}

/** Counts teardown calls; `waitFor` resolves from the call, not the clock. */
interface Counter {
  readonly count: number;
  make(): () => void;
  waitFor(target: number): Promise<void>;
}

function createCounter(): Counter {
  let count = 0;
  const waiters: Array<{ target: number; wake: () => void }> = [];
  const fire = (): void => {
    count += 1;
    for (const waiter of [...waiters]) {
      if (count >= waiter.target) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.wake();
      }
    }
  };
  return {
    get count() {
      return count;
    },
    make: () => fire,
    waitFor(target: number): Promise<void> {
      if (count >= target) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const wake = (): void => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          const index = waiters.findIndex((item) => item.wake === wake);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error(`counter did not reach ${target}`));
        }, WAIT_MS);
        waiters.push({ target, wake });
      });
    },
  };
}

/** Resolve when the server closes the connection; the clock only guards. */
function waitForServerClose(client: TestClient): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("connection stayed open after a dropped event"));
    }, WAIT_MS);
    void client.closed.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** Let detached async continuations settle (two turns is the file's pattern). */
async function flushTicks(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

// -- ownership and modes ------------------------------------------------------

describe("startRemoteSeatServer ownership and modes", () => {
  it("creates the parent dir 0700 and the socket 0600 owned by the uid", async () => {
    const fixture = await createFixture();
    const fake = createFakeHost();
    const server = await startSeat(fixture, fake.host);

    const dirInfo = await stat(join(fixture.baseDir, "run"));
    assert.equal(dirInfo.isDirectory(), true);
    assert.equal(dirInfo.mode & 0o777, 0o700);
    assert.equal(dirInfo.uid, process.getuid?.());

    const socketInfo = await stat(fixture.socketPath);
    assert.equal(socketInfo.isSocket(), true);
    assert.equal(socketInfo.mode & 0o777, 0o600);
    assert.equal(socketInfo.uid, process.getuid?.());

    assert.equal(server.socketPath, fixture.socketPath);
    assert.equal(server.instanceId, fake.instanceId);

    await server.close();
    assert.equal(existsSync(fixture.socketPath), false);
  });

  it("refuses a symlinked parent dir without creating a socket", async () => {
    const fixture = await createFixture();
    const realDir = join(fixture.baseDir, "real");
    const linkDir = join(fixture.baseDir, "link");
    await mkdir(realDir, { mode: 0o700 });
    await symlink(realDir, linkDir);

    const result = await startRemoteSeatServer({
      socketPath: join(linkDir, "remote.sock"),
      host: createFakeHost().host,
    });
    assert.equal(result.ok ? "ok" : result.reason, "unsafe_path");
    assert.equal(existsSync(join(realDir, "remote.sock")), false);
  });

  it("refuses a parent dir with group or other bits", async () => {
    const fixture = await createFixture();
    const runDir = join(fixture.baseDir, "run");
    await mkdir(runDir, { mode: 0o700 });
    await chmod(runDir, 0o770);

    const result = await startRemoteSeatServer({
      socketPath: join(runDir, "remote.sock"),
      host: createFakeHost().host,
    });
    assert.equal(result.ok ? "ok" : result.reason, "unsafe_path");
    assert.equal(existsSync(join(runDir, "remote.sock")), false);
  });

  it("refuses a parent dir owned by another uid", async () => {
    const fixture = await createFixture();
    const realGetuid = process.getuid;
    assert.ok(realGetuid !== undefined);
    const uid = realGetuid();
    // §5.3 step 1: a dir whose owner is not the process uid is unsafe.
    const spy = vi
      .spyOn(process as { getuid: () => number }, "getuid")
      .mockReturnValue(uid + 1);
    try {
      const result = await startRemoteSeatServer({
        socketPath: fixture.socketPath,
        host: createFakeHost().host,
      });
      assert.equal(result.ok ? "ok" : result.reason, "unsafe_path");
      assert.equal(
        existsSync(join(fixture.baseDir, "run", "remote.sock")),
        false
      );
    } finally {
      spy.mockRestore();
    }
  });

  it("keeps the socket private even when the data dir itself is world-readable", async () => {
    // spec §5.3: the privacy boundary is `<dataDir>/run` (0700) and the
    // socket (0600); the data dir above it is not part of the check.
    const fixture = await createFixture();
    await chmod(fixture.baseDir, 0o755);

    await startSeat(fixture, createFakeHost().host);
    const runInfo = await stat(join(fixture.baseDir, "run"));
    assert.equal(runInfo.mode & 0o777, 0o700);
    assert.equal((await stat(fixture.socketPath)).mode & 0o777, 0o600);
  });

  it("reclaims a stale socket file and serves the handshake", async () => {
    const fixture = await createFixture();
    const runDir = join(fixture.baseDir, "run");
    await mkdir(runDir, { mode: 0o700 });
    await writeFile(fixture.socketPath, "");

    const fake = createFakeHost();
    const notices: string[] = [];
    const result = await startRemoteSeatServer({
      socketPath: fixture.socketPath,
      host: fake.host,
      onNotice: (text) => notices.push(text),
    });
    if (!result.ok) throw new Error(`seat did not start: ${result.reason}`);
    cleanups.push(() => result.server.close());
    assert.deepEqual(notices, ["remote seat: reclaimed a stale socket"]);

    const client = createClient(fixture.socketPath);
    const welcome = (await handshake(client)) as RemoteWelcomeMessage;
    assert.equal(welcome.protocol, 1);
    assert.equal(welcome.instanceId, fake.instanceId);
    client.socket.destroy();
  });

  it("refuses a path held by a live seat and reports the holder pid", async () => {
    const fixture = await createFixture();
    const first = createFakeHost({ pid: 7777 });
    const server = await startSeat(fixture, first.host);

    const second = await startRemoteSeatServer({
      socketPath: fixture.socketPath,
      host: createFakeHost({ pid: 8888 }).host,
    });
    if (second.ok) throw new Error("expected the seat to be held");
    assert.equal(second.reason, "held");
    assert.equal(second.holderPid, 7777);

    // The holding seat keeps working.
    const client = createClient(fixture.socketPath);
    await handshake(client);
    client.socket.destroy();
    await server.close();
  });
});

// -- handshake and framing ----------------------------------------------------

describe("handshake and framing", () => {
  it("negotiates the highest common version", async () => {
    const fixture = await createFixture();
    await startSeat(fixture, createFakeHost().host);

    const client = createClient(fixture.socketPath);
    const welcome = (await handshake(client, [2, 1])) as RemoteWelcomeMessage;
    assert.equal(welcome.protocol, 1);
    assert.equal(welcome.pid, 4242);
    assert.equal(welcome.iknowVersion, "0.1.0");
    assert.equal(welcome.cwd, "/tmp/fake-cwd");
    client.socket.destroy();
  });

  it("rejects an unsupported protocol version and closes", async () => {
    const fixture = await createFixture();
    await startSeat(fixture, createFakeHost().host);

    const client = createClient(fixture.socketPath);
    client.send({
      type: "hello",
      protocol: [7],
      client: { name: "seat-test", version: "0.0.0" },
    });
    const error = serverError(await client.next((m) => m.type === "error"));
    assert.equal(error.code, "unsupported_protocol");
    assert.deepEqual(error.supported, [1]);
    await client.closed;
  });

  it("keeps the connection open for an unknown type", async () => {
    const fixture = await createFixture();
    await startSeat(fixture, createFakeHost().host);

    const client = createClient(fixture.socketPath);
    await handshake(client);
    client.send({ type: "no_such_type", id: "x" });
    const error = serverError(await client.next((m) => m.type === "error"));
    assert.equal(error.code, "unknown_type");

    client.send({ type: "ping", id: "p1" });
    const fields = successFields(await client.next((m) => m.type === "result"));
    assert.deepEqual(Object.keys(fields).sort(), ["id", "ok", "type"]);
    assert.equal(fields["id"], "p1");
    client.socket.destroy();
  });

  it("rejects a malformed known request and keeps the connection open", async () => {
    const fixture = await createFixture();
    const fake = createFakeHost();
    await startSeat(fixture, fake.host);

    const client = createClient(fixture.socketPath);
    await handshake(client);
    client.send({ type: "send_message", id: "m1" });
    const error = serverError(await client.next((m) => m.type === "error"));
    assert.equal(error.code, "bad_request");
    assert.equal(fake.calls.sendMessage.length, 0);

    client.send({ type: "ping", id: "p2" });
    const fields = successFields(await client.next((m) => m.type === "result"));
    assert.equal(fields["id"], "p2");
    client.socket.destroy();
  });

  it("requires hello before requests", async () => {
    const fixture = await createFixture();
    await startSeat(fixture, createFakeHost().host);

    const client = createClient(fixture.socketPath);
    client.send({ type: "ping", id: "early" });
    const error = serverError(await client.next((m) => m.type === "error"));
    assert.equal(error.code, "bad_request");

    const welcome = await handshake(client);
    assert.equal(welcome.type, "welcome");
    client.socket.destroy();
  });

  it("closes only the connection that sends an oversized line", async () => {
    const fixture = await createFixture();
    await startSeat(fixture, createFakeHost().host);

    const oversized = createClient(fixture.socketPath);
    await handshake(oversized);
    const healthy = createClient(fixture.socketPath);
    await handshake(healthy);

    oversized.sendRaw("x".repeat(MAX_LINE_BYTES + 32));
    const error = serverError(await oversized.next((m) => m.type === "error"));
    assert.equal(error.code, "frame_too_large");
    await oversized.closed;

    healthy.send({ type: "ping", id: "still-here" });
    const fields = successFields(
      await healthy.next((m) => m.type === "result")
    );
    assert.equal(fields["id"], "still-here");
    healthy.socket.destroy();
  });
});

// -- subscribe / snapshot / catch-up -----------------------------------------

describe("subscribe, snapshot and catch-up", () => {
  it("sends a snapshot when no cursor is given and then live events", async () => {
    const fixture = await createFixture();
    const fake = createFakeHost();
    await startSeat(fixture, fake.host);

    const client = createClient(fixture.socketPath);
    await handshake(client);
    client.send({ type: "subscribe", id: "s1" });
    const fields = successFields(await client.next((m) => m.type === "result"));
    assert.equal(fields["mode"], "snapshot");
    const snapshot = fields["snapshot"] as Snapshot;
    assert.equal(snapshot.seq, 0);
    assert.equal(snapshot.active, null);

    fake.emit(delta("live"));
    const event = await nextEvent(client);
    assert.equal(event.seq, 1);
    assert.deepEqual(event.event, { kind: "text", delta: "live" });
    assert.equal(event.time, TIME);
    assert.equal(event.conversationId, undefined);
    client.socket.destroy();
  });

  it("awaits an async host snapshot in snapshot mode", async () => {
    const fixture = await createFixture();
    const expected: Snapshot = {
      seq: 0,
      active: {
        conversationId: "c_async",
        title: "Async snapshot",
        running: true,
        queued: 2,
      },
      pendingApprovals: [
        {
          toolUseId: "toolu_waiting",
          tool: "Bash",
          summaryHint: "run a command",
          input: { command: "ls" },
          conversationId: "c_async",
        },
      ],
      openToolCalls: [
        { toolUseId: "toolu_open", name: "Edit", input: { path: "a.ts" } },
      ],
      transcriptTail: [{ role: "assistant", text: "from the async read" }],
    };
    const fake = createFakeHost({ asyncSnapshot: expected });
    await startSeat(fixture, fake.host);

    const client = createClient(fixture.socketPath);
    await handshake(client);
    client.send({ type: "subscribe", id: "s-async" });
    const fields = successFields(await client.next((m) => m.type === "result"));
    assert.equal(fields["mode"], "snapshot");
    assert.deepEqual(fields["snapshot"], expected);
    client.socket.destroy();
  });

  it("replays from the cursor in catchup mode, then live events", async () => {
    const fixture = await createFixture();
    const fake = createFakeHost({ maxEvents: 8 });
    await startSeat(fixture, fake.host);
    fake.emit({ kind: "notice", text: "a" });
    fake.emit({ kind: "notice", text: "b" });
    fake.emit({ kind: "notice", text: "c" });

    const client = createClient(fixture.socketPath);
    await handshake(client);
    client.send({
      type: "subscribe",
      id: "s2",
      instanceId: fake.instanceId,
      sinceSeq: 1,
    });
    const fields = successFields(await client.next((m) => m.type === "result"));
    assert.equal(fields["mode"], "catchup");
    assert.equal(fields["fromSeq"], 1);

    const first = await nextEvent(client);
    const second = await nextEvent(client);
    assert.deepEqual([first.seq, second.seq], [2, 3]);

    fake.emit(delta("after"));
    const live = await nextEvent(client);
    assert.equal(live.seq, 4);
    assert.deepEqual(live.event, { kind: "text", delta: "after" });
    client.socket.destroy();
  });

  it("falls back to a snapshot for another instance or a stale cursor", async () => {
    const fixture = await createFixture();
    const fake = createFakeHost({ maxEvents: 2 });
    await startSeat(fixture, fake.host);
    fake.emit(delta("1"));
    fake.emit(delta("2"));
    fake.emit(delta("3"));

    const otherInstance = createClient(fixture.socketPath);
    await handshake(otherInstance);
    otherInstance.send({
      type: "subscribe",
      id: "s3",
      instanceId: "someone-else",
      sinceSeq: 3,
    });
    const otherFields = successFields(
      await otherInstance.next((m) => m.type === "result")
    );
    assert.equal(otherFields["mode"], "snapshot");
    otherInstance.socket.destroy();

    const tooOld = createClient(fixture.socketPath);
    await handshake(tooOld);
    tooOld.send({
      type: "subscribe",
      id: "s4",
      instanceId: fake.instanceId,
      sinceSeq: 0,
    });
    const oldFields = successFields(
      await tooOld.next((m) => m.type === "result")
    );
    assert.equal(oldFields["mode"], "snapshot");
    assert.equal((oldFields["snapshot"] as Snapshot).seq, 3);
    tooOld.socket.destroy();
  });

  it("writes the result and replay before a live event that arrives during subscribe", async () => {
    const fixture = await createFixture();
    const fake = createFakeHost({
      maxEvents: 8,
      onSubscribe: (emit) => {
        emit(delta("during-subscribe"));
      },
    });
    await startSeat(fixture, fake.host);
    fake.emit(delta("a"));
    fake.emit(delta("b"));
    fake.emit(delta("c"));

    const client = createClient(fixture.socketPath);
    await handshake(client);
    client.send({
      type: "subscribe",
      id: "s5",
      instanceId: fake.instanceId,
      sinceSeq: 1,
    });

    const fields = successFields(await client.next((m) => m.type === "result"));
    assert.equal(fields["mode"], "catchup");
    const order: number[] = [];
    for (let i = 0; i < 3; i += 1) order.push((await nextEvent(client)).seq);
    assert.deepEqual(order, [2, 3, 4]);

    const live = fake.emit(delta("after"));
    const forwarded = await nextEvent(client);
    assert.equal(forwarded.seq, live.seq);
    client.socket.destroy();
  });
});

// -- live delivery integrity --------------------------------------------------

describe("live delivery integrity", () => {
  it("closes a connection instead of skipping an event it cannot write", async () => {
    const fixture = await createFixture();
    const counter = createCounter();
    const fake = createFakeHost({ makeUnsubscribe: counter.make });
    await startSeat(fixture, fake.host);

    const client = createClient(fixture.socketPath);
    await handshake(client);
    client.send({ type: "subscribe", id: "s1" });
    successFields(await client.next((m) => m.type === "result"));

    fake.live({ seq: 1, time: TIME, event: delta("one") });
    assert.equal((await nextEvent(client)).seq, 1);

    // BigInt cannot be JSON-encoded, so this frame is rejected while the
    // socket is still open. The cursor must not advance past it: the
    // connection is closed so the client reconnects and catches up.
    fake.live({
      seq: 2,
      time: TIME,
      event: {
        kind: "tool_call",
        toolUseId: "toolu_bad",
        name: "bash",
        input: 1n,
      },
    });
    fake.live({ seq: 3, time: TIME, event: delta("three") });

    await waitForServerClose(client);
    assert.deepEqual(
      client
        .received()
        .filter((message) => message.type === "event")
        .map((message) => (message.type === "event" ? message.seq : 0)),
      [1]
    );
    await counter.waitFor(1);
    assert.equal(counter.count, 1);
  });

  it("unsubscribes a live sink exactly once when the client disconnects", async () => {
    const fixture = await createFixture();
    const counter = createCounter();
    const fake = createFakeHost({ makeUnsubscribe: counter.make });
    const server = await startSeat(fixture, fake.host);

    const client = createClient(fixture.socketPath);
    await handshake(client);
    client.send({ type: "subscribe", id: "s1" });
    successFields(await client.next((m) => m.type === "result"));
    assert.equal(counter.count, 0);

    client.socket.destroy();
    await counter.waitFor(1);
    assert.equal(counter.count, 1);

    await server.close();
    assert.equal(counter.count, 1);
  });

  it("unsubscribes the old sink when a newer subscribe supersedes it", async () => {
    const fixture = await createFixture();
    const counter = createCounter();
    const fake = createFakeHost({ makeUnsubscribe: counter.make });
    await startSeat(fixture, fake.host);

    const client = createClient(fixture.socketPath);
    await handshake(client);
    client.send({ type: "subscribe", id: "s1" });
    successFields(await client.next((m) => m.type === "result"));
    assert.equal(counter.count, 0);

    client.send({ type: "subscribe", id: "s2" });
    successFields(await client.next((m) => m.type === "result"));
    await counter.waitFor(1);
    assert.equal(counter.count, 1);

    client.socket.destroy();
    await counter.waitFor(2);
    assert.equal(counter.count, 2);
  });

  it("unsubscribes a live sink on server close", async () => {
    const fixture = await createFixture();
    const counter = createCounter();
    const fake = createFakeHost({ makeUnsubscribe: counter.make });
    const server = await startSeat(fixture, fake.host);

    const client = createClient(fixture.socketPath);
    await handshake(client);
    client.send({ type: "subscribe", id: "s1" });
    successFields(await client.next((m) => m.type === "result"));

    await server.close();
    await counter.waitFor(1);
    assert.equal(counter.count, 1);
    await client.closed;
  });

  it("answers a superseded subscribe once and ignores its late reply", async () => {
    const fixture = await createFixture();
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let calls = 0;
    const fake = createFakeHost({
      subscribeDelegate: async () => {
        calls += 1;
        if (calls === 1) await firstGate;
        return { mode: "snapshot", snapshot: EMPTY_SNAPSHOT };
      },
    });
    await startSeat(fixture, fake.host);

    const client = createClient(fixture.socketPath);
    await handshake(client);
    client.send({ type: "subscribe", id: "s1" });
    client.send({ type: "subscribe", id: "s2" });

    const superseded = asResult(await client.next((m) => m.type === "result"));
    assert.equal(superseded.id, "s1");
    assert.equal(superseded.ok, false);
    assert.deepEqual(superseded.ok ? undefined : superseded.error, {
      code: "bad_request",
      message: "superseded by a newer subscribe",
    });

    const second = successFields(await client.next((m) => m.type === "result"));
    assert.equal(second["id"], "s2");

    // A normal completion clears the pending id: this later subscribe must
    // not produce a second answer for s2.
    client.send({ type: "subscribe", id: "s3" });
    const third = successFields(await client.next((m) => m.type === "result"));
    assert.equal(third["id"], "s3");

    releaseFirst?.();
    await flushTicks();
    const late = client
      .received()
      .filter((message) => message.type === "result" && message.id === "s1");
    assert.equal(late.length, 1);
    client.socket.destroy();
  });

  it("does not answer a superseded subscribe twice when its host call fails late", async () => {
    const fixture = await createFixture();
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let calls = 0;
    const fake = createFakeHost({
      subscribeDelegate: async () => {
        calls += 1;
        if (calls === 1) {
          await firstGate;
          throw new Error("synthetic late host failure");
        }
        return { mode: "snapshot", snapshot: EMPTY_SNAPSHOT };
      },
    });
    await startSeat(fixture, fake.host);

    const client = createClient(fixture.socketPath);
    await handshake(client);
    client.send({ type: "subscribe", id: "s1" });
    client.send({ type: "subscribe", id: "s2" });

    const superseded = asResult(await client.next((m) => m.type === "result"));
    assert.equal(superseded.id, "s1");
    assert.equal(superseded.ok, false);
    successFields(await client.next((m) => m.type === "result"));

    releaseFirst?.();
    await flushTicks();
    const s1Results = client
      .received()
      .filter((message) => message.type === "result" && message.id === "s1");
    assert.equal(s1Results.length, 1);
    client.socket.destroy();
  });
});

// -- requests without a subscription -----------------------------------------

describe("requests without a subscription", () => {
  it("maps host success and error results", async () => {
    const fixture = await createFixture();
    let failNext = false;
    const fake = createFakeHost({
      sendMessage: async () =>
        failNext
          ? { ok: false, code: "not_ready", message: "input port not bound" }
          : { ok: true, value: { status: "queued" } },
      abort: async () => ({ ok: true, value: { interrupted: false } }),
    });
    await startSeat(fixture, fake.host);

    const client = createClient(fixture.socketPath);
    await handshake(client);

    client.send({ type: "send_message", id: "m1", text: "hello" });
    const fields = successFields(await client.next((m) => m.type === "result"));
    assert.equal(fields["status"], "queued");
    assert.deepEqual(fake.calls.sendMessage, [{ text: "hello" }]);

    failNext = true;
    client.send({
      type: "send_message",
      id: "m2",
      text: "later",
      conversationId: "c_1",
    });
    const failure = failureFields(
      await client.next((m) => m.type === "result")
    );
    assert.equal(failure.code, "not_ready");
    assert.deepEqual(fake.calls.sendMessage[1], {
      text: "later",
      conversationId: "c_1",
    });

    client.send({
      type: "answer_approval",
      id: "a1",
      toolUseId: "toolu_1",
      answer: "always",
    });
    successFields(await client.next((m) => m.type === "result"));
    assert.deepEqual(fake.calls.answerApproval, [
      { toolUseId: "toolu_1", answer: "always" },
    ]);

    client.send({ type: "abort", id: "b1" });
    const aborted = successFields(
      await client.next((m) => m.type === "result")
    );
    assert.equal(aborted["interrupted"], false);
    assert.equal(fake.calls.abort, 1);
    client.socket.destroy();
  });

  it("answers each request in one chunk exactly once, correlated by id", async () => {
    const fixture = await createFixture();
    const fake = createFakeHost();
    await startSeat(fixture, fake.host);

    const client = createClient(fixture.socketPath);
    await handshake(client);
    client.sendRaw(
      encodeNdjsonMessage({ type: "ping", id: "a" }) +
        encodeNdjsonMessage({ type: "abort", id: "b" }) +
        encodeNdjsonMessage({ type: "ping", id: "c" })
    );

    const ids: unknown[] = [];
    for (let i = 0; i < 3; i += 1) {
      const fields = successFields(
        await client.next((m) => m.type === "result")
      );
      ids.push(fields["id"]);
    }
    // Each id is answered exactly once; a host operation may finish later
    // than the next request, so the order follows completion, not arrival.
    assert.deepEqual(ids.sort(), ["a", "b", "c"]);
    assert.equal(fake.calls.abort, 1);

    // Nothing else is pending for those ids.
    client.send({ type: "ping", id: "d" });
    const next = successFields(await client.next((m) => m.type === "result"));
    assert.equal(next["id"], "d");
    client.socket.destroy();
  });

  it("rejects an invalid approval answer before calling the host", async () => {
    const fixture = await createFixture();
    const fake = createFakeHost();
    await startSeat(fixture, fake.host);

    const client = createClient(fixture.socketPath);
    await handshake(client);
    client.send({
      type: "answer_approval",
      id: "a1",
      toolUseId: "toolu_1",
      answer: "maybe",
    });
    const error = serverError(await client.next((m) => m.type === "error"));
    assert.equal(error.code, "bad_request");
    assert.equal(fake.calls.answerApproval.length, 0);
    client.socket.destroy();
  });
});

// -- back-pressure ------------------------------------------------------------

describe("back-pressure", () => {
  it("drops only the slow consumer and keeps the other client live", async () => {
    const fixture = await createFixture();
    const fake = createFakeHost();
    await startSeat(fixture, fake.host);

    const slow = createClient(fixture.socketPath);
    await handshake(slow);
    slow.send({ type: "subscribe", id: "slow" });
    successFields(await slow.next((m) => m.type === "result"));

    const healthy = createClient(fixture.socketPath);
    await handshake(healthy);
    healthy.send({ type: "subscribe", id: "healthy" });
    successFields(await healthy.next((m) => m.type === "result"));

    // The slow client stops reading; the healthy one acknowledges the last seq
    // of every batch, so it can never accumulate a backlog of its own.
    slow.socket.pause();
    const payload = "y".repeat(80_000);
    let expectedSeq = 0;
    for (let batch = 0; batch < 16; batch += 1) {
      for (let i = 0; i < 10; i += 1) fake.emit(delta(payload));
      expectedSeq += 10;
      const seen = await healthy.next(
        (m) => m.type === "event" && m.seq === expectedSeq
      );
      assert.equal(seen.type, "event");
    }

    slow.socket.resume();
    const overflow = serverError(await slow.next((m) => m.type === "error"));
    assert.equal(overflow.code, "slow_consumer");
    await slow.closed;

    // The healthy client is untouched by the drop.
    fake.emit(delta("after-drop"));
    const after = await healthy.next(
      (m) => m.type === "event" && m.seq === expectedSeq + 1
    );
    assert.equal(after.type, "event");
    assert.equal((after as RemoteEventMessage).seq, expectedSeq + 1);
    healthy.socket.destroy();
  });
});

// -- close --------------------------------------------------------------------

describe("close", () => {
  it("sends goodbye to every connection, removes the socket and is idempotent", async () => {
    const fixture = await createFixture();
    const server = await startSeat(fixture, createFakeHost().host);

    const first = createClient(fixture.socketPath);
    const second = createClient(fixture.socketPath);
    await handshake(first);
    await handshake(second);

    await server.close();

    for (const client of [first, second]) {
      const goodbye = await client.next((m) => m.type === "goodbye");
      if (goodbye.type !== "goodbye") throw new Error("unreachable");
      assert.equal(goodbye.reason, "tui_exit");
      await client.closed;
    }
    assert.equal(existsSync(fixture.socketPath), false);

    await server.close();
  });
});
