/**
 * Trace inspection HTTP handler.
 *
 * Routes (all GET):
 *   /api/v1/traces         — query JSONL trace rows (filter + pagination + poll)
 *   /api/v1/traces/fields  — field declaration table (panel column SSOT)
 *   /api/v1/sessions       — 会话列表 (conversation_id / mtime / size / agent_version)
 *
 * T6 (plans/session-folder-consolidation.md / SC14–SC17): traceDir is the
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
   * trace 目录 (v2 每会话一文件: `<traceDir>/<convId>.jsonl`)。缺省 →
   * /api/v1/traces 返回 404 no trace file configured (与 v0 单文件语义一致)。
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

/** T5 (#358): 非空字符串过滤值 (task_id / parent_turn_id 共用 parseConversationId 形状)。 */
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
 * ?poll=<ms> — 前端轮询间隔 (spec def-ior: 非负整数, 0 = 停轮询)。
 * http.ts 不阻塞也不实现服务端轮询: 本参数只做校验并原样透传,
 * 响应里恒带 `offset` 供前端组织下一轮请求。
 */
function parsePoll(value: string | null): number {
  if (value === null) return 1000; // 缺省 1000ms
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new ValidationError("poll must be a non-negative integer", {
      field: "poll",
    });
  }
  return n;
}

/**
 * ?resume_offset=<n> — 增量轮询恢复字节偏移 (非负整数)。不传 = 0 (从头全读)。
 * 由前端把上一轮响应里的 `offset` 原样传回。
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

// -- 会话文件解析 ---------------------------------------------------------------

/**
 * 由 conversation_id 解析到 trace 文件的读侧路径。Walk 两级树
 * `<baseDir>/projects/<project-slug>/<convId>/trace.jsonl`;`conversation_id`
 * 必须不含路径分隔符（防目录穿越）。未命中 → undefined,调用方转 404。
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
 * Handle GET /api/v1/sessions — 会话目录列表 (SC-R 10 / SC-R 17 / SC-R 18)。
 * traceDir 未配置 → 404 (与 /api/v1/traces 的 no-trace-out 契约一致)；
 * 目录不存在 → listSessions 返回空列表 (非 500)；单个会话 stat ENOENT 已由
 * listSessions 内部跳过。
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
 * v2 下钻 (SC-R 11/12): conversation_id → `<traceDir>/<id>.jsonl`；缺省 →
 * 最近活跃会话 (readdir+stat 按 mtime)，不 400、不混看。
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
    // poll 只做校验并透传——面板据此决定是否发起下一轮请求 (SC-V 26)。
    parsePoll(url.searchParams.get("poll"));

    let conversationId = query.conversationId;
    if (conversationId === undefined) {
      // 缺省 → 最近活跃会话 (SC-R 12)。目录为空 (尚无会话) → 空结果 200。
      conversationId = newestConversationId(traceDir);
      if (conversationId === undefined) {
        sendJson(res, 200, emptyResponseEnvelope());
        return;
      }
    }

    const filePath = sessionFilePath(traceDir, conversationId);
    if (filePath === undefined) {
      // 未命中会话文件夹 → 404 (与 /api/v1/sessions 的 no-trace-out 契约一致)。
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
