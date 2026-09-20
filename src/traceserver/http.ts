/**
 * Trace inspection HTTP handler.
 *
 * Routes (all GET):
 *   /api/v1/traces         — query JSONL trace rows (filter + pagination + poll)
 *   /api/v1/traces/fields  — field declaration table (panel column SSOT)
 *   /api/v1/sessions       — session list (conversation_id / mtime / size / agent_version)
 *
 * ADR-0071: traceDir is the
 * **baseDir**; sessions live at
 * `<baseDir>/projects/<project-slug>/<convId>/trace.jsonl`.
 * Wire params stay snake_case; `conversation_id` walks the project tree via
 * `findConversationTraceFile` (session-discovery.ts). Default routing (no
 * `conversation_id`) keeps using `newestConversationId` so the "most-recent
 * session" panel behavior is unchanged.
 *
 * Dispatch contract: src/session-api/http.ts performs a single prefix check
 * and delegates here; all parsing/validation/response logic lives in this file.
 *
 * Wire contract: request params and response body are snake_case; the
 * /fields payload keeps the camelCase def shape (frontend-internal).
 * Validation failures throw ValidationError (session-api maps it to 400).
 * TraceReadError bubbles up (session-api maps unknown errors to 500 without
 * leaking fs details).
 */
import * as http from "node:http";
import { ValidationError } from "../shared/errors.js";
import { TRACE_RECORD_TYPES, type TraceQuery } from "./types.js";
import { TRACE_FIELD_DEFS } from "./fields.js";
import { emptyResponseEnvelope, toResponseEnvelope } from "./envelope.js";
import { createJsonlTraceReader } from "./reader.js";
import { listSessions, newestConversationId } from "./sessions.js";
import { findConversationTraceFile } from "./session-discovery.js";
import type { TraceRecordType } from "./types.js";

export interface TracesRequestOpts {
  readonly res: http.ServerResponse;
  readonly url: URL;
  /**
   * Trace directory (one file per conversation under the projects tree).
   * Absent -> /api/v1/traces returns 404 no trace file configured (same as
   * the single-file semantics).
   */
  readonly traceDir?: string;
  /**
   * Per-read byte cap forwarded to the JSONL reader. Omit to use the reader
   * default (`MAX_TRACE_BYTES = 8 MiB`). Out-of-range values fall through to
   * the reader's own validation.
   */
  readonly maxBytes?: number;
}

// -- query param parsing (each throws ValidationError with a `field` detail) --

function parseConversationId(value: string | null): string | undefined {
  if (value === null) return undefined;
  if (value.length === 0) {
    throw new ValidationError("conversation_id must be a non-empty string", {
      field: "conversation_id",
    });
  }
  return value;
}

/** Non-empty string filter value (task_id / parent_turn_id share parseConversationId's shape). */
function parseStringParam(
  value: string | null,
  field: string
): string | undefined {
  if (value === null) return undefined;
  if (value.length === 0) {
    throw new ValidationError(`${field} must be a non-empty string`, {
      field,
    });
  }
  return value;
}

function parseRecordType(value: string | null): TraceRecordType | undefined {
  if (value === null) return undefined;
  if (!(TRACE_RECORD_TYPES as ReadonlyArray<string>).includes(value)) {
    throw new ValidationError(
      `record_type must be one of: ${TRACE_RECORD_TYPES.join(", ")}`,
      {
        field: "record_type",
      }
    );
  }
  return value as TraceRecordType;
}

function parseStatus(value: string | null): "ok" | "error" | undefined {
  if (value === null) return undefined;
  if (value !== "ok" && value !== "error") {
    throw new ValidationError("status must be one of: ok, error", {
      field: "status",
    });
  }
  return value;
}

function parseLimit(value: string | null): number | undefined {
  if (value === null) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 200) {
    throw new ValidationError("limit must be an integer in 1..200", {
      field: "limit",
    });
  }
  return n;
}

function parseOffset(value: string | null): number | undefined {
  if (value === null) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new ValidationError("offset must be an integer >= 0", {
      field: "offset",
    });
  }
  return n;
}

/**
 * ?poll=<ms> — frontend polling interval (non-negative integer, 0 = stop
 * polling). http.ts neither blocks nor implements server-side polling: the
 * param is only validated and passed through; responses always carry
 * `offset` so the frontend can build the next request.
 */
function parsePoll(value: string | null): number {
  if (value === null) return 1000; // default 1000ms
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new ValidationError("poll must be a non-negative integer", {
      field: "poll",
    });
  }
  return n;
}

/**
 * ?resume_offset=<n> — incremental-polling resume byte offset (non-negative
 * integer). Absent = 0 (full read from head). The frontend passes the
 * previous response's `offset` back verbatim.
 */
function parseResumeOffset(value: string | null): number {
  if (value === null) return 0;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new ValidationError("resume_offset must be a non-negative integer", {
      field: "resume_offset",
    });
  }
  return n;
}

function parseTraceQuery(url: URL): TraceQuery {
  const p = url.searchParams;
  return {
    conversationId: parseConversationId(p.get("conversation_id")),
    recordType: parseRecordType(p.get("record_type")),
    status: parseStatus(p.get("status")),
    limit: parseLimit(p.get("limit")),
    offset: parseOffset(p.get("offset")),
    resumeOffset: parseResumeOffset(p.get("resume_offset")),
    taskId: parseStringParam(p.get("task_id"), "task_id"),
    parentTurnId: parseStringParam(p.get("parent_turn_id"), "parent_turn_id"),
    turnId: parseStringParam(p.get("turn_id"), "turn_id"),
  };
}

// -- response helpers (local sendJson — mirrors session-api/http.ts shape) ----

function sendJson(
  res: http.ServerResponse,
  status: number,
  body: unknown
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

function sendNoTraceFile(res: http.ServerResponse): void {
  sendJson(res, 404, {
    error: { kind: "not_found", message: "no trace file configured" },
  });
}

// -- session file resolution -----------------------------------------------------

/**
 * Read-side path from conversation_id to the trace file. Walks the
 * two-level tree `<baseDir>/projects/<project-slug>/<convId>/trace.jsonl`;
 * `conversation_id` must contain no path separators (directory-traversal
 * guard). Miss -> undefined, caller turns it into 404.
 */
function sessionFilePath(
  traceDir: string,
  conversationId: string
): string | undefined {
  if (conversationId.includes("/") || conversationId.includes("\\")) {
    throw new ValidationError(
      "conversation_id must not contain path separators",
      { field: "conversation_id" }
    );
  }
  return findConversationTraceFile(traceDir, conversationId);
}

// -- handlers ------------------------------------------------------------------

/**
 * Handle GET /api/v1/sessions — session directory listing.
 * traceDir unconfigured -> 404 (same no-trace-out contract as
 * /api/v1/traces); missing directory -> listSessions returns an empty list
 * (not 500); single-session stat ENOENT is already skipped inside
 * listSessions.
 */
export function handleSessionsRequest(opts: TracesRequestOpts): void {
  const { res, traceDir } = opts;
  if (!traceDir) {
    sendNoTraceFile(res);
    return;
  }
  const sessions = listSessions(traceDir);
  sendJson(res, 200, { sessions });
}

/**
 * Handle GET /api/v1/traces and /api/v1/traces/fields.
 * Throws ValidationError on bad query params (caller maps to 400);
 * TraceReadError on IO failure (caller maps to 500 internal).
 *
 * Drill-down: conversation_id -> that session's file; absent -> most
 * recently active session (readdir+stat by mtime) — never a 400 and never
 * a mixed view.
 */
export function handleTracesRequest(opts: TracesRequestOpts): void {
  const { res, url, traceDir } = opts;
  const pathname = url.pathname;

  if (pathname === "/api/v1/traces/fields") {
    sendJson(res, 200, { fields: TRACE_FIELD_DEFS });
    return;
  }
  if (pathname === "/api/v1/traces") {
    if (!traceDir) {
      sendNoTraceFile(res);
      return;
    }
    const query = parseTraceQuery(url);
    // poll is only validated and passed through — the panel decides whether
    // to issue the next round based on it.
    parsePoll(url.searchParams.get("poll"));

    let conversationId = query.conversationId;
    if (conversationId === undefined) {
      // Default -> most recently active session. Empty directory (no
      // sessions yet) -> empty result, 200.
      conversationId = newestConversationId(traceDir);
      if (conversationId === undefined) {
        sendJson(res, 200, emptyResponseEnvelope());
        return;
      }
    }

    const filePath = sessionFilePath(traceDir, conversationId);
    if (filePath === undefined) {
      // No matching conversation folder -> 404 (same no-trace-out contract
      // as /api/v1/sessions).
      sendNoTraceFile(res);
      return;
    }
    const reader = createJsonlTraceReader({
      filePath,
      ...(opts.maxBytes !== undefined ? { maxBytes: opts.maxBytes } : {}),
    });
    sendJson(res, 200, toResponseEnvelope(reader.query(query)));
    return;
  }
  // Unknown /api/v1/traces* path: fall through to the session-api not_found
  // handler by sending a 404 in the shared nested-error shape here.
  sendJson(res, 404, {
    error: { kind: "not_found", message: `no route GET ${pathname}` },
  });
}
