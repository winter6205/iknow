/**
 * Remote seat protocol, version 1 (spec specs/remote-sync.md §5).
 *
 * Host-neutral on purpose (ADR-0149 §4): nothing here imports the TUI, so a
 * later standalone daemon can serve the same wire format. Wire messages are
 * plain JSON objects; this module owns their names, the frame cap and the
 * client-line validation that turns untrusted input into typed messages.
 *
 * Security: validation error messages name the offending *field*, never its
 * value — the server never echoes client payloads back or into logs.
 */
import type { ApprovalOutcome } from "../harness/permission/types.js";

/** Highest protocol version this process speaks (spec §5.2). */
export const REMOTE_PROTOCOL_VERSION = 1;

/** Protocol versions the server accepts, ascending. */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly number[] = [
  REMOTE_PROTOCOL_VERSION,
];

/** Max frame length; a longer line is `frame_too_large` (spec §5.1). */
export const MAX_LINE_BYTES = 1024 * 1024;

/** Approval answer carried by `answer_approval` and `approval_resolved`. */
export type AnswerChoice = "once" | "always" | "reject";

/** Error codes on `result { ok: false }` and server `error` frames. */
export type RemoteErrorCode =
  | "frame_too_large"
  | "unknown_type"
  | "unsupported_protocol"
  | "slow_consumer"
  | "empty_text"
  | "not_active"
  | "not_ready"
  | "not_pending"
  | "bad_request";

/** Outcome of a host operation: a value or a typed failure (spec §5.4). */
export type RemoteOperation<T> =
  | { ok: true; value: T }
  | { ok: false; code: RemoteErrorCode; message: string };

/** Typed error for protocol misuse in-process (no generic `Error` in new code). */
export class RemoteProtocolError extends Error {
  readonly code: RemoteErrorCode;

  constructor(code: RemoteErrorCode, message: string) {
    super(message);
    this.name = "RemoteProtocolError";
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// -- seat events (spec §5.6) ---------------------------------------------------

/** Event payloads, one per `kind`. */
export type SeatEventBody =
  | { kind: "active_changed"; conversationId: string | null; title?: string }
  | { kind: "user_message"; text: string; origin: "local" | "remote" }
  | { kind: "turn_started"; turnId: string }
  | {
      kind: "turn_ended";
      turnId: string;
      status: "completed" | "cancelled" | "failed";
      stopReason?: string;
    }
  | { kind: "text"; delta: string }
  | { kind: "thinking"; delta: string }
  | {
      kind: "tool_call";
      toolUseId: string;
      name: string;
      input: unknown;
      inputPartial?: boolean;
      inputTruncated?: boolean;
    }
  /**
   * `kind` is the envelope discriminant, so a tool result's own status (the
   * TUI sink's ok / validation_failed / tool_not_found / execution_failed)
   * travels as `resultKind` — one JSON object cannot carry `kind` twice.
   */
  | {
      kind: "tool_result";
      toolUseId: string;
      resultKind: string;
      message?: string;
    }
  | {
      kind: "approval_pending";
      toolUseId: string;
      tool: string;
      summaryHint: string;
      input: unknown;
      conversationId?: string;
    }
  | {
      kind: "approval_resolved";
      toolUseId: string;
      outcome: ApprovalOutcome;
      answer?: AnswerChoice;
      by: "local" | "remote" | "system";
    }
  | { kind: "notice"; text: string };

/**
 * Envelope. `conversationId` is absent (not `null`) when the event belongs to
 * no conversation; the ring and the server forward the envelope verbatim.
 */
export interface SeatEvent {
  seq: number;
  time: string;
  conversationId?: string;
  event: SeatEventBody;
}

// -- snapshot (spec §5.5) ------------------------------------------------------

/** The active conversation; `conversationId` is `null` for a draft session. */
export interface SnapshotActive {
  conversationId: string | null;
  title?: string;
  running: boolean;
  queued: number;
}

/** One approval the TUI modal is currently showing. */
export interface PendingApprovalView {
  toolUseId: string;
  tool: string;
  summaryHint: string;
  input: unknown;
  conversationId?: string;
}

/** One tool call whose result has not arrived yet. */
export interface OpenToolCall {
  toolUseId: string;
  name: string;
  input: unknown;
}

/** One user / assistant text line of the active conversation's tail. */
export interface TranscriptTailEntry {
  role: "user" | "assistant";
  text: string;
}

export interface Snapshot {
  seq: number;
  active: SnapshotActive | null;
  pendingApprovals: readonly PendingApprovalView[];
  openToolCalls: readonly OpenToolCall[];
  transcriptTail: readonly TranscriptTailEntry[];
}

// -- client -> server (spec §5.2, §5.4) ----------------------------------------

export interface RemoteHelloMessage {
  type: "hello";
  id?: string;
  protocol: readonly number[];
  client: { name: string; version: string };
}

export interface RemoteSubscribeRequest {
  type: "subscribe";
  id: string;
  instanceId?: string;
  sinceSeq?: number;
}

export interface RemoteSendMessageRequest {
  type: "send_message";
  id: string;
  text: string;
  conversationId?: string;
}

export interface RemoteAnswerApprovalRequest {
  type: "answer_approval";
  id: string;
  toolUseId: string;
  answer: AnswerChoice;
}

export interface RemoteAbortRequest {
  type: "abort";
  id: string;
}

export interface RemotePingRequest {
  type: "ping";
  id: string;
}

/** Requests answered exactly once by a `result` frame. */
export type RemoteClientRequest =
  | RemoteSubscribeRequest
  | RemoteSendMessageRequest
  | RemoteAnswerApprovalRequest
  | RemoteAbortRequest
  | RemotePingRequest;

export type RemoteClientMessage = RemoteHelloMessage | RemoteClientRequest;

// -- server -> client (spec §5.1-§5.4) -----------------------------------------

export interface RemoteWelcomeMessage {
  type: "welcome";
  protocol: number;
  instanceId: string;
  pid: number;
  iknowVersion: string;
  cwd: string;
}

/** Successful result payloads; `{}` (ping, answer_approval) adds no fields. */
export type RemoteResultPayload =
  | Record<string, never>
  | { status: "sent" | "queued" }
  | { interrupted: boolean }
  | { mode: "catchup"; fromSeq: number }
  | { mode: "snapshot"; snapshot: Snapshot };

export type RemoteSuccessResult = {
  type: "result";
  id: string;
  ok: true;
} & RemoteResultPayload;

export interface RemoteFailureResult {
  type: "result";
  id: string;
  ok: false;
  error: { code: RemoteErrorCode; message: string };
}

export type RemoteResultMessage = RemoteSuccessResult | RemoteFailureResult;

export type RemoteEventMessage = SeatEvent & { type: "event" };

export interface RemoteGoodbyeMessage {
  type: "goodbye";
  reason: "tui_exit";
}

export interface RemoteServerErrorMessage {
  type: "error";
  code: RemoteErrorCode;
  message: string;
  /** Present on `unsupported_protocol` only. */
  supported?: readonly number[];
}

export type RemoteServerMessage =
  | RemoteWelcomeMessage
  | RemoteResultMessage
  | RemoteEventMessage
  | RemoteGoodbyeMessage
  | RemoteServerErrorMessage;

// -- encoding ------------------------------------------------------------------

/**
 * One NDJSON frame: JSON plus the terminating `\n`. A value JSON cannot
 * represent raises `RemoteProtocolError` instead of sending `"undefined"`.
 */
export function encodeNdjsonMessage(value: unknown): string {
  let text: string;
  try {
    const encoded: unknown = JSON.stringify(value);
    if (typeof encoded !== "string") {
      throw new RemoteProtocolError(
        "bad_request",
        "message is not JSON-serializable"
      );
    }
    text = encoded;
  } catch (err) {
    if (err instanceof RemoteProtocolError) throw err;
    // EXIT: only circular structures / BigInt reach here; the caller turns this
    // into a typed failure instead of crashing the connection loop.
    throw new RemoteProtocolError(
      "bad_request",
      "message is not JSON-serializable"
    );
  }
  return `${text}\n`;
}

// -- client line validation ----------------------------------------------------

/** A rejected client line: `bad_request` or `unknown_type` (§5.1). */
export interface ClientLineFailure {
  ok: false;
  code: "bad_request" | "unknown_type";
  message: string;
}

export type ClientLineParseResult =
  { ok: true; message: RemoteClientMessage } | ClientLineFailure;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function badRequest(message: string): ClientLineFailure {
  return { ok: false, code: "bad_request", message };
}

function readId(
  raw: Record<string, unknown>,
  required: true
): { ok: true; id: string } | ClientLineFailure;
function readId(
  raw: Record<string, unknown>,
  required: false
): { ok: true; id?: string } | ClientLineFailure;
function readId(
  raw: Record<string, unknown>,
  required: boolean
): { ok: true; id?: string } | ClientLineFailure {
  const value = raw["id"];
  if (value === undefined && !required) return { ok: true };
  if (!isNonEmptyString(value))
    return badRequest("id must be a non-empty string");
  return { ok: true, id: value };
}

function readOptionalString(
  raw: Record<string, unknown>,
  field: string
): { ok: true; value?: string } | ClientLineFailure {
  const value = raw[field];
  if (value === undefined) return { ok: true };
  if (!isNonEmptyString(value)) {
    return badRequest(`${field} must be a non-empty string`);
  }
  return { ok: true, value };
}

function parseHello(raw: Record<string, unknown>): ClientLineParseResult {
  const protocol = raw["protocol"];
  if (!Array.isArray(protocol) || !protocol.every(isInteger)) {
    return badRequest("hello.protocol must be an array of integers");
  }
  const client = raw["client"];
  if (
    !isRecord(client) ||
    !isNonEmptyString(client["name"]) ||
    typeof client["version"] !== "string"
  ) {
    return badRequest("hello.client must be { name, version }");
  }
  const id = readId(raw, false);
  if (!id.ok) return id;
  return {
    ok: true,
    message: {
      type: "hello",
      ...(id.id !== undefined ? { id: id.id } : {}),
      protocol: protocol as readonly number[],
      client: { name: client["name"], version: client["version"] },
    },
  };
}

function parseSubscribe(raw: Record<string, unknown>): ClientLineParseResult {
  const id = readId(raw, true);
  if (!id.ok) return id;
  const instanceId = readOptionalString(raw, "instanceId");
  if (!instanceId.ok) return instanceId;
  const sinceSeq = raw["sinceSeq"];
  if (sinceSeq !== undefined && (!isInteger(sinceSeq) || sinceSeq < 0)) {
    return badRequest("sinceSeq must be a non-negative integer");
  }
  return {
    ok: true,
    message: {
      type: "subscribe",
      id: id.id,
      ...(instanceId.value !== undefined
        ? { instanceId: instanceId.value }
        : {}),
      ...(sinceSeq !== undefined ? { sinceSeq: sinceSeq as number } : {}),
    },
  };
}

function parseSendMessage(raw: Record<string, unknown>): ClientLineParseResult {
  const id = readId(raw, true);
  if (!id.ok) return id;
  const text = raw["text"];
  if (typeof text !== "string") return badRequest("text must be a string");
  const conversationId = readOptionalString(raw, "conversationId");
  if (!conversationId.ok) return conversationId;
  return {
    ok: true,
    message: {
      type: "send_message",
      id: id.id,
      text,
      ...(conversationId.value !== undefined
        ? { conversationId: conversationId.value }
        : {}),
    },
  };
}

function parseAnswerApproval(
  raw: Record<string, unknown>
): ClientLineParseResult {
  const id = readId(raw, true);
  if (!id.ok) return id;
  const toolUseId = raw["toolUseId"];
  if (!isNonEmptyString(toolUseId)) {
    return badRequest("toolUseId must be a non-empty string");
  }
  const answer = raw["answer"];
  if (answer !== "once" && answer !== "always" && answer !== "reject") {
    return badRequest('answer must be "once", "always" or "reject"');
  }
  return {
    ok: true,
    message: { type: "answer_approval", id: id.id, toolUseId, answer },
  };
}

function parseIdOnly(
  raw: Record<string, unknown>,
  type: "abort" | "ping"
): ClientLineParseResult {
  const id = readId(raw, true);
  if (!id.ok) return id;
  return { ok: true, message: { type, id: id.id } };
}

/**
 * Validate one client line. Unknown top-level `type` → `unknown_type`; a known
 * type with a malformed body (and any non-object line) → `bad_request`.
 */
export function parseClientLine(line: string): ClientLineParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    // EXIT: a syntactically broken line is a client bug, not a server fault.
    return badRequest("line is not valid JSON");
  }
  if (!isRecord(raw)) return badRequest("line must be a JSON object");
  const type = raw["type"];
  if (typeof type !== "string") return badRequest("missing message type");
  switch (type) {
    case "hello":
      return parseHello(raw);
    case "subscribe":
      return parseSubscribe(raw);
    case "send_message":
      return parseSendMessage(raw);
    case "answer_approval":
      return parseAnswerApproval(raw);
    case "abort":
      return parseIdOnly(raw, "abort");
    case "ping":
      return parseIdOnly(raw, "ping");
    default:
      // The type string itself is not echoed back: a bogus type is untrusted
      // input and the server never writes client payloads.
      return {
        ok: false,
        code: "unknown_type",
        message: "unknown message type",
      };
  }
}

/** Highest version both sides speak, or `undefined` when there is none. */
export function negotiateProtocolVersion(
  clientVersions: readonly number[]
): number | undefined {
  let highest: number | undefined;
  for (const version of clientVersions) {
    if (!SUPPORTED_PROTOCOL_VERSIONS.includes(version)) continue;
    if (highest === undefined || version > highest) highest = version;
  }
  return highest;
}
