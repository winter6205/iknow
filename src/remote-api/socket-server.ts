/**
 * Remote seat socket server, protocol version 1 (spec specs/remote-sync.md
 * §5.1-§5.7, ADR-0149 §4).
 *
 * Host-neutral: the server owns transport, framing, handshake, request
 * dispatch and per-connection back-pressure; the host owns session state,
 * the event ring and the catch-up/snapshot decision. Nothing here imports the
 * TUI, so a later standalone daemon can reuse it unchanged.
 *
 * Authentication is the filesystem (§5.3): the parent dir must be a real
 * directory owned by the process uid with no group/other bits, and the socket
 * is chmod 0600 right after listen and re-checked. No token is exchanged.
 *
 * Security: client lines are validated before dispatch, error messages name
 * fields and never echo payloads, and nothing about a message is logged.
 */
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  unlinkSync,
  type Stats,
} from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import { createNdjsonDecoder, type NdjsonDecoder } from "./codec.js";
import {
  MAX_LINE_BYTES,
  REMOTE_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  encodeNdjsonMessage,
  negotiateProtocolVersion,
  parseClientLine,
  type AnswerChoice,
  type RemoteAbortRequest,
  type RemoteAnswerApprovalRequest,
  type RemoteClientRequest,
  type RemoteGoodbyeMessage,
  type RemoteHelloMessage,
  type RemoteOperation,
  type RemotePingRequest,
  type RemoteResultPayload,
  type RemoteSendMessageRequest,
  type RemoteServerMessage,
  type RemoteSubscribeRequest,
  type RemoteSuccessResult,
  type SeatEvent,
  type Snapshot,
} from "./protocol.js";

/** Per-connection write queue cap; overflow is `slow_consumer` (§5.7). */
const WRITE_QUEUE_LIMIT_BYTES = 8 * 1024 * 1024;

/** Grace for flushing `goodbye` before a stuck client's socket is destroyed. */
const GOODBYE_GRACE_MS = 500;

/** Probe timeout for an existing socket: connected but silent counts as live. */
const HOLDER_PROBE_TIMEOUT_MS = 1000;

const PROBE_CLIENT_NAME = "iknow-remote-seat-probe";
const PROBE_CLIENT_VERSION = "0";

/** Connect errors that prove nobody is listening on the socket file. */
const STALE_CONNECT_ERRORS: ReadonlySet<string> = new Set([
  "ENOENT",
  "ECONNREFUSED",
  "ENOTSOCK",
  "EINVAL",
  "EPROTOTYPE",
]);

// -- public host contract (pinned; later modules import these names) ----------

export type { RemoteOperation } from "./protocol.js";

/** Result of a subscribe decision: a replay window or a fresh snapshot. */
export type RemoteSeatSubscribeReply =
  | {
      mode: "catchup";
      fromSeq: number;
      events: readonly SeatEvent[];
      /**
       * Live-sink teardown. The server calls it exactly once per connection:
       * on disconnect, on server close, or when a newer subscribe supersedes.
       */
      unsubscribe?: () => void;
    }
  | { mode: "snapshot"; snapshot: Snapshot; unsubscribe?: () => void };

export interface RemoteSeatHost {
  readonly instanceId: string;
  readonly pid: number;
  readonly cwd: string;
  readonly iknowVersion: string;
  snapshot(): Snapshot | Promise<Snapshot>;
  subscribe(
    args: { instanceId?: string; sinceSeq?: number },
    deliver: (event: SeatEvent) => void
  ): Promise<RemoteSeatSubscribeReply>;
  sendMessage(args: {
    text: string;
    conversationId?: string;
  }): Promise<RemoteOperation<{ status: "sent" | "queued" }>>;
  answerApproval(args: {
    toolUseId: string;
    answer: AnswerChoice;
  }): Promise<RemoteOperation<Record<string, never>>>;
  abort(): Promise<RemoteOperation<{ interrupted: boolean }>>;
}

export type RemoteSeatStartResult =
  | { ok: true; server: RemoteSeatServer }
  | {
      ok: false;
      reason: "unsafe_path" | "held" | "listen_failed";
      message: string;
      holderPid?: number;
    };

export interface RemoteSeatServer {
  readonly socketPath: string;
  readonly instanceId: string;
  close(): Promise<void>;
}

export interface RemoteSeatServerOptions {
  readonly socketPath: string;
  readonly host: RemoteSeatHost;
  /** Non-fatal seat notice for the TUI; never carries payloads. */
  readonly onNotice?: (text: string) => void;
}

// -- filesystem authentication (§5.3) -----------------------------------------

function isPrivateDirectory(dir: string): boolean {
  let info: Stats;
  try {
    info = lstatSync(dir);
  } catch {
    // EXIT: a missing/unreadable parent cannot be proven private.
    return false;
  }
  // lstat: a symlink to a private dir is not a directory here, by design.
  if (!info.isDirectory()) return false;
  const uid =
    typeof process.getuid === "function" ? process.getuid() : undefined;
  if (uid !== undefined && info.uid !== uid) return false;
  return (info.mode & 0o077) === 0;
}

/** Create the parent dir 0700 when missing, then prove it is private. */
function prepareParentDir(dir: string): boolean {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    // EXIT: unwritable parent is reported as an unsafe path, not a throw.
    return false;
  }
  return isPrivateDirectory(dir);
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    // EXIT: ENOENT (and unreadable paths) mean "nothing to reclaim/remove".
    return false;
  }
}

function removeSocketFile(socketPath: string): void {
  try {
    unlinkSync(socketPath);
  } catch {
    // EXIT: best-effort teardown; an already-gone socket file is not an error.
  }
}

// -- live holder probe (§5.3 step 2) ------------------------------------------

interface HolderProbe {
  readonly live: boolean;
  readonly pid?: number;
}

function readHolderAnswer(line: string): HolderProbe {
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed === "object" && parsed !== null) {
      const record = parsed as Record<string, unknown>;
      if (record["type"] === "welcome" && typeof record["pid"] === "number") {
        return { live: true, pid: record["pid"] };
      }
    }
  } catch {
    // EXIT: a holder that answers with non-JSON is still a live process.
    return { live: true };
  }
  return { live: true };
}

/**
 * Ask whoever owns `socketPath` for a `welcome`. A refused connect means the
 * file is stale; an answer (welcome or protocol error) means a live seat, and
 * a connected-but-silent peer is treated as live — never unlink a socket that
 * something might still be serving.
 */
function probeHolder(socketPath: string): Promise<HolderProbe> {
  return new Promise<HolderProbe>((resolve) => {
    const socket = connect(socketPath);
    const decoder = createNdjsonDecoder({ maxLineBytes: 64 * 1024 });
    let timer: NodeJS.Timeout | undefined;
    let settled = false;
    const settle = (probe: HolderProbe): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      socket.removeAllListeners("data");
      socket.removeAllListeners("connect");
      socket.on("error", () => {
        // EXIT: teardown of the probe socket; the answer is already decided.
      });
      socket.destroy();
      resolve(probe);
    };
    timer = setTimeout(() => settle({ live: true }), HOLDER_PROBE_TIMEOUT_MS);
    socket.on("connect", () => {
      socket.write(
        encodeNdjsonMessage({
          type: "hello",
          protocol: [REMOTE_PROTOCOL_VERSION],
          client: { name: PROBE_CLIENT_NAME, version: PROBE_CLIENT_VERSION },
        })
      );
    });
    socket.on("data", (chunk: Buffer) => {
      for (const line of decoder.push(chunk).lines) {
        if (line.trim().length === 0) continue;
        settle(readHolderAnswer(line));
        return;
      }
    });
    socket.on("error", (err: NodeJS.ErrnoException) => {
      const code = typeof err.code === "string" ? err.code : "";
      settle({ live: !STALE_CONNECT_ERRORS.has(code) });
    });
    socket.on("close", () => settle({ live: true }));
  });
}

// -- listen -------------------------------------------------------------------

type ListenResult =
  { ok: true; server: Server } | { ok: false; message: string };

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "listen failed";
}

/**
 * Bind the socket with `umask 0177`, then chmod 0600 and re-check. A failed
 * chmod/re-check never keeps a half-configured listener alive.
 */
async function listenOnSocket(socketPath: string): Promise<ListenResult> {
  const server = createServer();
  const previousUmask = process.umask(0o177);
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => {
        server.off("listening", onListening);
        reject(err);
      };
      const onListening = (): void => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(socketPath);
    });
  } catch (err) {
    // EXIT: the bind failed; a socket file we did not create is left untouched.
    server.close(() => {
      // EXIT: nothing to release on a server that never listened.
    });
    return { ok: false, message: errorMessage(err) };
  } finally {
    process.umask(previousUmask);
  }
  const fail = (message: string): ListenResult => {
    server.close(() => {
      // EXIT: listener teardown on a mode failure; the failure is returned.
    });
    removeSocketFile(socketPath);
    return { ok: false, message };
  };
  try {
    chmodSync(socketPath, 0o600);
    const info = lstatSync(socketPath);
    if (!info.isSocket() || (info.mode & 0o777) !== 0o600) {
      // A re-check mismatch is a typed start failure, not a thrown Error.
      return fail("socket mode re-check failed");
    }
  } catch (err) {
    // EXIT: chmod / lstat faults become the same typed start failure.
    return fail(errorMessage(err));
  }
  return { ok: true, server };
}

// -- connections --------------------------------------------------------------

interface SeatConnection {
  readonly socket: Socket;
  readonly decoder: NdjsonDecoder;
  phase: "awaiting_hello" | "ready";
  queuedBytes: number;
  /** Highest event seq already written to this connection. */
  lastWrittenSeq: number;
  /** Bumped per subscribe so an older sink stops forwarding. */
  subscription: number;
  /** Live-sink teardown from the accepted subscribe reply, if any. */
  unsubscribe: (() => void) | undefined;
  /** Id of a subscribe still awaiting its host reply. */
  pendingSubscribeId: string | undefined;
  closed: boolean;
}

interface SeatRuntime {
  readonly host: RemoteSeatHost;
  readonly server: Server;
  readonly connections: Set<SeatConnection>;
  readonly sockets: Set<Socket>;
}

type WriteOutcome = "sent" | "invalid";

/** Host-provided live-sink teardown; a throwing host must not break the loop. */
function callUnsubscribe(unsubscribe: (() => void) | undefined): void {
  if (unsubscribe === undefined) return;
  try {
    unsubscribe();
  } catch {
    // EXIT: teardown faults are the host's; the server keeps its own state.
  }
}

/** Release the connection's live sink exactly once. */
function detachSubscription(conn: SeatConnection): void {
  const unsubscribe = conn.unsubscribe;
  conn.unsubscribe = undefined;
  callUnsubscribe(unsubscribe);
}

function markClosed(conn: SeatConnection): void {
  conn.closed = true;
  conn.pendingSubscribeId = undefined;
  detachSubscription(conn);
}

/**
 * A frame write failed while the socket was still open. Closing the connection
 * is what keeps the event stream gap-free: the client reconnects with its last
 * seq and catches up instead of silently missing the dropped frame.
 */
function terminateConnection(runtime: SeatRuntime, conn: SeatConnection): void {
  if (conn.closed) return;
  markClosed(conn);
  conn.socket.destroy();
  runtime.connections.delete(conn);
}

function buildSuccessResult(
  id: string,
  payload: RemoteResultPayload
): RemoteSuccessResult {
  return Object.assign(
    { type: "result" as const, id, ok: true as const },
    payload
  );
}

function writeFrame(
  conn: SeatConnection,
  message: RemoteServerMessage
): WriteOutcome {
  if (conn.closed || !conn.socket.writable) return "invalid";
  let frame: string;
  try {
    frame = encodeNdjsonMessage(message);
  } catch {
    // EXIT: an unserializable host value must not kill the connection loop.
    return "invalid";
  }
  const size = Buffer.byteLength(frame, "utf8");
  if (conn.queuedBytes + size > WRITE_QUEUE_LIMIT_BYTES) {
    dropSlowConsumer(conn);
    return "invalid";
  }
  conn.queuedBytes += size;
  conn.socket.write(frame, () => {
    conn.queuedBytes -= size;
  });
  return "sent";
}

/** End this connection after one last frame; other clients are untouched. */
function closeConnection(
  conn: SeatConnection,
  message: RemoteServerMessage
): void {
  if (conn.closed) return;
  markClosed(conn);
  let frame: string | undefined;
  try {
    frame = encodeNdjsonMessage(message);
  } catch {
    // EXIT: nothing left to send; the FIN below still closes the connection.
    frame = undefined;
  }
  if (frame === undefined) conn.socket.end();
  else conn.socket.end(frame);
}

function dropSlowConsumer(conn: SeatConnection): void {
  if (conn.closed) return;
  markClosed(conn);
  conn.socket.end(
    encodeNdjsonMessage({
      type: "error",
      code: "slow_consumer",
      message: "write queue overflow; reconnect and catch up",
    })
  );
}

function sendFrame(
  runtime: SeatRuntime,
  conn: SeatConnection,
  message: RemoteServerMessage
): void {
  if (conn.closed) return;
  if (writeFrame(conn, message) === "invalid") {
    terminateConnection(runtime, conn);
  }
}

function forwardEvent(
  runtime: SeatRuntime,
  conn: SeatConnection,
  event: SeatEvent
): void {
  if (conn.closed) return;
  // No gap, no duplicate: replay and live delivery share one cursor.
  if (event.seq <= conn.lastWrittenSeq) return;
  if (writeFrame(conn, { type: "event", ...event }) === "sent") {
    // The cursor claims delivery, so it advances only for an accepted frame.
    conn.lastWrittenSeq = event.seq;
    return;
  }
  // The event was dropped: close so the client reconnects and catches up
  // rather than continuing from a cursor that claims this event was sent.
  terminateConnection(runtime, conn);
}

// -- request handling ---------------------------------------------------------

function sendOperationResult<T extends RemoteResultPayload>(
  runtime: SeatRuntime,
  conn: SeatConnection,
  id: string,
  operation: RemoteOperation<T>
): void {
  if (operation.ok) {
    sendFrame(runtime, conn, buildSuccessResult(id, operation.value));
    return;
  }
  sendFrame(runtime, conn, {
    type: "result",
    id,
    ok: false,
    error: { code: operation.code, message: operation.message },
  });
}

async function handleSubscribe(
  runtime: SeatRuntime,
  conn: SeatConnection,
  request: RemoteSubscribeRequest
): Promise<void> {
  // §5.1: every request is answered exactly once. A subscribe still awaiting
  // its host reply is answered here before the newer one takes over.
  const supersededId = conn.pendingSubscribeId;
  if (supersededId !== undefined) {
    conn.pendingSubscribeId = undefined;
    sendFrame(runtime, conn, {
      type: "result",
      id: supersededId,
      ok: false,
      error: {
        code: "bad_request",
        message: "superseded by a newer subscribe",
      },
    });
    if (conn.closed) return;
  }
  // The previous generation's live sink is dead once a newer subscribe lands.
  detachSubscription(conn);
  conn.subscription += 1;
  const generation = conn.subscription;
  conn.pendingSubscribeId = request.id;
  const settlePending = (): void => {
    if (conn.pendingSubscribeId === request.id) {
      conn.pendingSubscribeId = undefined;
    }
  };
  // A host may deliver live events synchronously from inside subscribe (or
  // while it awaits its snapshot); keep them back until the result and the
  // replay are on the wire (§5.5 ordering).
  const pending: SeatEvent[] = [];
  let buffering = true;
  const deliver = (event: SeatEvent): void => {
    if (conn.closed || conn.subscription !== generation) return;
    if (buffering) {
      pending.push(event);
      return;
    }
    forwardEvent(runtime, conn, event);
  };
  let reply: RemoteSeatSubscribeReply;
  try {
    reply = await runtime.host.subscribe(
      {
        ...(request.instanceId !== undefined
          ? { instanceId: request.instanceId }
          : {}),
        ...(request.sinceSeq !== undefined
          ? { sinceSeq: request.sinceSeq }
          : {}),
      },
      deliver
    );
  } catch {
    // EXIT: a failing host must not leave this connection attached to a dead
    // generation or crash the server; the client gets a correlated failure.
    const stillCurrent = !conn.closed && conn.subscription === generation;
    conn.subscription += 1;
    // A superseded subscribe was already answered when the newer one arrived;
    // answering here too would break the once-only contract.
    if (!stillCurrent) return;
    settlePending();
    sendFrame(runtime, conn, {
      type: "result",
      id: request.id,
      ok: false,
      error: { code: "bad_request", message: "request failed" },
    });
    return;
  }
  // A newer subscribe (or a close) superseded this one while it was awaiting:
  // release the sink it returned, and let the newer generation own the cursor.
  if (conn.closed || conn.subscription !== generation) {
    callUnsubscribe(reply.unsubscribe);
    return;
  }
  settlePending();
  conn.unsubscribe = reply.unsubscribe;
  if (reply.mode === "catchup") {
    conn.lastWrittenSeq = reply.fromSeq;
    sendFrame(
      runtime,
      conn,
      buildSuccessResult(request.id, {
        mode: "catchup",
        fromSeq: reply.fromSeq,
      })
    );
    for (const event of reply.events) {
      if (conn.closed) return;
      forwardEvent(runtime, conn, event);
    }
  } else {
    conn.lastWrittenSeq = reply.snapshot.seq;
    sendFrame(
      runtime,
      conn,
      buildSuccessResult(request.id, {
        mode: "snapshot",
        snapshot: reply.snapshot,
      })
    );
  }
  buffering = false;
  for (const event of pending.splice(0)) {
    if (conn.closed) return;
    forwardEvent(runtime, conn, event);
  }
}

async function runHostOperation(
  runtime: SeatRuntime,
  conn: SeatConnection,
  id: string,
  operation: () => Promise<void>
): Promise<void> {
  try {
    await operation();
  } catch {
    // EXIT: a throwing host must not crash the server; the client gets a
    // correlated failure instead of a silent hang.
    sendFrame(runtime, conn, {
      type: "result",
      id,
      ok: false,
      error: { code: "bad_request", message: "request failed" },
    });
  }
}

async function handleSendMessage(
  runtime: SeatRuntime,
  conn: SeatConnection,
  request: RemoteSendMessageRequest
): Promise<void> {
  const operation = await runtime.host.sendMessage({
    text: request.text,
    ...(request.conversationId !== undefined
      ? { conversationId: request.conversationId }
      : {}),
  });
  sendOperationResult(runtime, conn, request.id, operation);
}

async function handleAnswerApproval(
  runtime: SeatRuntime,
  conn: SeatConnection,
  request: RemoteAnswerApprovalRequest
): Promise<void> {
  const operation = await runtime.host.answerApproval({
    toolUseId: request.toolUseId,
    answer: request.answer,
  });
  sendOperationResult(runtime, conn, request.id, operation);
}

async function handleAbort(
  runtime: SeatRuntime,
  conn: SeatConnection,
  request: RemoteAbortRequest
): Promise<void> {
  const operation = await runtime.host.abort();
  sendOperationResult(runtime, conn, request.id, operation);
}

function handlePing(
  runtime: SeatRuntime,
  conn: SeatConnection,
  request: RemotePingRequest
): void {
  sendFrame(runtime, conn, buildSuccessResult(request.id, {}));
}

async function handleRequest(
  runtime: SeatRuntime,
  conn: SeatConnection,
  request: RemoteClientRequest
): Promise<void> {
  switch (request.type) {
    case "subscribe":
      await handleSubscribe(runtime, conn, request);
      return;
    case "ping":
      handlePing(runtime, conn, request);
      return;
    case "send_message":
      await runHostOperation(runtime, conn, request.id, () =>
        handleSendMessage(runtime, conn, request)
      );
      return;
    case "answer_approval":
      await runHostOperation(runtime, conn, request.id, () =>
        handleAnswerApproval(runtime, conn, request)
      );
      return;
    case "abort":
      await runHostOperation(runtime, conn, request.id, () =>
        handleAbort(runtime, conn, request)
      );
      return;
  }
}

function handleHello(
  runtime: SeatRuntime,
  conn: SeatConnection,
  message: RemoteHelloMessage
): void {
  if (conn.phase === "ready") {
    sendFrame(runtime, conn, {
      type: "error",
      code: "bad_request",
      message: "hello already received",
    });
    return;
  }
  const version = negotiateProtocolVersion(message.protocol);
  if (version === undefined) {
    closeConnection(conn, {
      type: "error",
      code: "unsupported_protocol",
      message: "no common protocol version",
      supported: SUPPORTED_PROTOCOL_VERSIONS,
    });
    return;
  }
  conn.phase = "ready";
  sendFrame(runtime, conn, {
    type: "welcome",
    protocol: version,
    instanceId: runtime.host.instanceId,
    pid: runtime.host.pid,
    iknowVersion: runtime.host.iknowVersion,
    cwd: runtime.host.cwd,
  });
}

function handleLine(
  runtime: SeatRuntime,
  conn: SeatConnection,
  line: string
): void {
  const parsed = parseClientLine(line);
  if (!parsed.ok) {
    sendFrame(runtime, conn, {
      type: "error",
      code: parsed.code,
      message: parsed.message,
    });
    return;
  }
  if (parsed.message.type === "hello") {
    handleHello(runtime, conn, parsed.message);
    return;
  }
  if (conn.phase !== "ready") {
    sendFrame(runtime, conn, {
      type: "error",
      code: "bad_request",
      message: "hello required before requests",
    });
    return;
  }
  void handleRequest(runtime, conn, parsed.message);
}

function handleConnectionData(
  runtime: SeatRuntime,
  conn: SeatConnection,
  chunk: Buffer
): void {
  if (conn.closed) return;
  const decoded = conn.decoder.push(chunk);
  if (decoded.overflow === true) {
    closeConnection(conn, {
      type: "error",
      code: "frame_too_large",
      message: `frame exceeds ${MAX_LINE_BYTES} bytes`,
    });
    runtime.connections.delete(conn);
    return;
  }
  for (const line of decoded.lines) {
    if (conn.closed) return;
    if (line.trim().length === 0) continue;
    handleLine(runtime, conn, line);
  }
}

function registerConnection(runtime: SeatRuntime, socket: Socket): void {
  const conn: SeatConnection = {
    socket,
    decoder: createNdjsonDecoder({ maxLineBytes: MAX_LINE_BYTES }),
    phase: "awaiting_hello",
    queuedBytes: 0,
    lastWrittenSeq: 0,
    subscription: 0,
    unsubscribe: undefined,
    pendingSubscribeId: undefined,
    closed: false,
  };
  runtime.connections.add(conn);
  runtime.sockets.add(socket);
  socket.on("data", (chunk: Buffer) =>
    handleConnectionData(runtime, conn, chunk)
  );
  socket.on("error", () => {
    // EXIT: a peer reset tears the connection down; the close handler below
    // owns the bookkeeping so the server never throws on client faults.
  });
  socket.on("close", () => {
    markClosed(conn);
    runtime.connections.delete(conn);
    runtime.sockets.delete(socket);
  });
}

function createRuntime(server: Server, host: RemoteSeatHost): SeatRuntime {
  const runtime: SeatRuntime = {
    host,
    server,
    connections: new Set<SeatConnection>(),
    sockets: new Set<Socket>(),
  };
  server.on("connection", (socket: Socket) =>
    registerConnection(runtime, socket)
  );
  return runtime;
}

// -- shutdown -----------------------------------------------------------------

async function closeRuntime(
  runtime: SeatRuntime,
  socketPath: string
): Promise<void> {
  const goodbye: RemoteGoodbyeMessage = { type: "goodbye", reason: "tui_exit" };
  for (const conn of runtime.connections) {
    closeConnection(conn, goodbye);
  }
  runtime.connections.clear();
  const listenerClosed = new Promise<void>((resolve) => {
    runtime.server.close(() => resolve());
  });
  let graceTimer: NodeJS.Timeout | undefined;
  const grace = new Promise<void>((resolve) => {
    graceTimer = setTimeout(resolve, GOODBYE_GRACE_MS);
  });
  await Promise.race([listenerClosed, grace]);
  if (graceTimer) clearTimeout(graceTimer);
  // A client that never reads cannot keep the TUI process alive on exit.
  for (const socket of runtime.sockets) socket.destroy();
  await listenerClosed;
  removeSocketFile(socketPath);
}

function createSeatServer(
  runtime: SeatRuntime,
  socketPath: string
): RemoteSeatServer {
  let closing: Promise<void> | undefined;
  return {
    socketPath,
    instanceId: runtime.host.instanceId,
    close(): Promise<void> {
      closing ??= closeRuntime(runtime, socketPath);
      return closing;
    },
  };
}

// -- entry point --------------------------------------------------------------

export async function startRemoteSeatServer(
  opts: RemoteSeatServerOptions
): Promise<RemoteSeatStartResult> {
  const { socketPath } = opts;
  if (!prepareParentDir(dirname(socketPath))) {
    return {
      ok: false,
      reason: "unsafe_path",
      message:
        "socket parent directory is not a private directory owned by this user",
    };
  }
  if (pathExists(socketPath)) {
    const holder = await probeHolder(socketPath);
    if (holder.live) {
      return {
        ok: false,
        reason: "held",
        message:
          holder.pid !== undefined
            ? `remote seat already served by pid ${holder.pid}`
            : "remote seat already served by another process",
        ...(holder.pid !== undefined ? { holderPid: holder.pid } : {}),
      };
    }
    removeSocketFile(socketPath);
    opts.onNotice?.("remote seat: reclaimed a stale socket");
  }
  const listening = await listenOnSocket(socketPath);
  if (!listening.ok) {
    return { ok: false, reason: "listen_failed", message: listening.message };
  }
  const runtime = createRuntime(listening.server, opts.host);
  return { ok: true, server: createSeatServer(runtime, socketPath) };
}
