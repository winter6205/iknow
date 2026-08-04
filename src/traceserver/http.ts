/**
 * Trace inspection HTTP handler.
 *
 * Routes (all GET):
 *   /api/v1/traces         — query JSONL trace rows (filter + pagination)
 *   /api/v1/traces/fields  — field declaration table (panel column SSOT)
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
import { createJsonlTraceReader } from "./reader.js";
import type { TraceRecordType } from "./types.js";

export interface TracesRequestOpts {
  readonly res: http.ServerResponse;
  readonly url: URL;
  readonly traceFilePath?: string;
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

function parseTraceQuery(url: URL): TraceQuery {
  const p = url.searchParams;
  return {
    conversationId: parseConversationId(p.get("conversation_id")),
    recordType: parseRecordType(p.get("record_type")),
    status: parseStatus(p.get("status")),
    limit: parseLimit(p.get("limit")),
    offset: parseOffset(p.get("offset")),
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

// -- handler -------------------------------------------------------------------

/**
 * Handle GET /api/v1/traces and /api/v1/traces/fields.
 * Throws ValidationError on bad query params (caller maps to 400);
 * TraceReadError on IO failure (caller maps to 500 internal).
 */
export function handleTracesRequest(opts: TracesRequestOpts): void {
  const { res, url, traceFilePath } = opts;
  const pathname = url.pathname;

  if (pathname === "/api/v1/traces/fields") {
    sendJson(res, 200, { fields: TRACE_FIELD_DEFS });
    return;
  }
  if (pathname === "/api/v1/traces") {
    if (!traceFilePath) {
      sendNoTraceFile(res);
      return;
    }
    const query = parseTraceQuery(url);
    const reader = createJsonlTraceReader({ filePath: traceFilePath });
    const result = reader.query(query);
    sendJson(res, 200, {
      records: result.records,
      total: result.total,
      skipped_lines: result.skippedLines,
      truncated: result.truncated,
    });
    return;
  }
  // Unknown /api/v1/traces* path: fall through to the session-api not_found
  // handler by sending a 404 in the shared nested-error shape here.
  sendJson(res, 404, {
    error: { kind: "not_found", message: `no route GET ${pathname}` },
  });
}
