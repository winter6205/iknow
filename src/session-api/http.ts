/**
 * Minimal node:http router for Session API + static web UI.
 * 022 T5: nested ApiErrorBody, hub error mapping, GET /sessions list.
 * ADR-0020: the trace inspection read API is MOUNTED in-process (reverses
 * #183 R3's standalone split): `opts.trace` mounts `/api/v1/traces*` via
 * traceserver's createTraceRouter + the trace SPA under `/trace`; write-side
 * `--trace-out` on serve/chat/ask remains unchanged.
 * Static-asset serving extracted to `src/web/serve-static.ts` so traceserver
 * can host its own SPA with the same guards; `resolveDefaultWebRoot` is
 * re-exported below for tests that historically imported it from here.
 */
import * as http from "node:http";
import { isIknowError, ValidationError } from "../shared/errors.js";
import { mapStoreError, type SessionHub } from "./hub.js";
import type { SessionStoreError } from "./store/index.js";
import { parseThinkingOverride } from "./thinking-override.js";
import type {
  ApiErrorBody,
  HealthResponse,
  PermissionModeResponse,
} from "./contract.js";
import { getVersion } from "../cli/usage.js";
import {
  nextShiftTabMode,
  type PermissionModeContext,
} from "../harness/permission/modes.js";
import { createTraceRouter } from "../traceserver/serve.js";
import {
  resolveDefaultWebRoot,
  serveStaticRequest,
} from "../web/serve-static.js";

export { resolveDefaultWebRoot };

/** 上下文窗口缺省（token）：与 loop-engine 默认同源（200000）。 */
export const DEFAULT_CONTEXT_WINDOW = 200_000;

export type SessionHttpServerOptions = {
  hub: SessionHub;
  /** Absolute path to web/ static root. */
  webRoot?: string;
  host?: string;
  port?: number;
  /** 上下文窗口大小（token）。缺省 200000（与 loop-engine 默认同源）。
   *  HealthResponse 字段；由 serve.ts 从 loadIknowEnv().compress.contextWindow 透传。 */
  contextWindow?: number;
  /** 模型路由 ID（settings.llm.model）。HealthResponse 字段；
   *  由 serve.ts 透传；缺席 → health 不带 model（byte-stable）。 */
  model?: string;
  /** 可变 permission mode holder（与 hub 共用同一 context 实例）。
   *  在场 → GET/POST /api/v1/permission-mode 可用；缺席 → 两端点 404。 */
  permissionMode?: PermissionModeContext;
  /**
   * ADR-0020: mount the trace inspection read API in-process. When present,
   * `/api/v1/traces*` routes (incl. `/api/v1/traces/sessions`) and the
   * `/trace` SPA become available on this server's port.
   */
  trace?: {
    /** Absolute path to the trace directory (write-side traceOut). */
    traceDir?: string;
    /** Per-read byte cap forwarded to the JSONL reader. */
    maxBytes?: number;
  };
};

export type ListeningServer = {
  server: http.Server;
  host: string;
  port: number;
  close: () => Promise<void>;
};

export function createSessionHttpServer(
  opts: SessionHttpServerOptions
): http.Server {
  const hub = opts.hub;
  const webRoot = opts.webRoot ?? resolveDefaultWebRoot();
  const contextWindow = opts.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  // ADR-0020: build the trace router once (per server) when trace mounting
  // is requested; undefined otherwise keeps handle() dispatch branch-free.
  const traceRouter =
    opts.trace !== undefined
      ? createTraceRouter({
          ...(opts.trace.traceDir !== undefined
            ? { traceDir: opts.trace.traceDir }
            : {}),
          ...(opts.trace.maxBytes !== undefined
            ? { maxBytes: opts.trace.maxBytes }
            : {}),
        })
      : undefined;

  return http.createServer((req, res) => {
    void handle({
      req,
      res,
      hub,
      webRoot,
      contextWindow,
      model: opts.model,
      permissionMode: opts.permissionMode,
      traceRouter,
    });
  });
}

export async function listenSessionServer(
  opts: SessionHttpServerOptions
): Promise<ListeningServer> {
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 8787;
  const server = createSessionHttpServer(opts);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const addr = server.address();
  const boundPort = typeof addr === "object" && addr ? addr.port : port;

  return {
    server,
    host,
    port: boundPort,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

interface HandleOpts {
  readonly req: http.IncomingMessage;
  readonly res: http.ServerResponse;
  readonly hub: SessionHub;
  readonly webRoot: string;
  readonly contextWindow: number;
  /** HealthResponse 模型名字段（缺席 → 不下发）。 */
  readonly model?: string;
  /** 可变 permission mode holder（缺席 → permission-mode 端点 404）。 */
  readonly permissionMode?: PermissionModeContext;
  /** ADR-0020: mounted trace router (undefined = trace not mounted). */
  readonly traceRouter?: (
    req: http.IncomingMessage,
    res: http.ServerResponse
  ) => Promise<boolean>;
}

async function handle(opts: HandleOpts): Promise<void> {
  const {
    req,
    res,
    hub,
    webRoot,
    contextWindow,
    model,
    permissionMode,
    traceRouter,
  } = opts;
  try {
    const method = (req.method ?? "GET").toUpperCase();
    const url = new URL(
      req.url ?? "/",
      `http://${req.headers.host ?? "localhost"}`
    );
    const pathname = decodeURIComponent(url.pathname);

    if (method === "GET" && pathname === "/api/v1/health")
      return sendHealth(res, contextWindow, model);
    if (method === "GET" && isSsePath(pathname)) return sendSseReserved(res);

    // permission mode 读取 / Shift+Tab 循环切换（web 快捷键；holder 缺席 →
    // 404，与 trace 未挂载同模式）。
    if (pathname === "/api/v1/permission-mode") {
      return handlePermissionModeRoute({ method, req, res, permissionMode });
    }

    if (method === "POST" && pathname === "/api/v1/sessions") {
      const createReq = parseCreateBody(await readJsonBody(req));
      return sendJson({
        res,
        status: 201,
        body: await hub.createSession(createReq),
      });
    }

    // List sessions — must precede the /sessions/:id regex (which requires
    // at least one non-slash char after `/sessions/`, so exact match is safe).
    if (method === "GET" && pathname === "/api/v1/sessions") {
      return sendJson({
        res,
        status: 200,
        body: { sessions: await hub.listSessions() },
      });
    }

    const sessionMatch = pathname.match(
      /^\/api\/v1\/sessions\/([^/]+)(\/.*)?$/
    );
    if (sessionMatch) {
      const id = sessionMatch[1]!;
      const rest = sessionMatch[2] ?? "";
      if (await handleSessionRoute({ method, id, rest, req, res, hub })) return;
    }

    // ADR-0020 mounted trace subtree: `/api/v1/traces*` read API + `/trace`
    // SPA. The router maps ValidationError→400 / TraceReadError→500 envelope
    // internally; handle()'s catch remains the backstop for any escape.
    if (method === "GET" && traceRouter) {
      if (await traceRouter(req, res)) return;
      if (
        serveStaticRequest({
          res,
          webRoot,
          pathname,
          fallbackHtml: "trace.html",
          stripPrefix: "/trace",
        })
      )
        return;
    }

    if (
      method === "GET" &&
      serveStaticRequest({ res, webRoot, pathname, fallbackHtml: "index.html" })
    )
      return;
    sendNotFound({ res, method, pathname });
  } catch (err) {
    sendError({ res, err });
  }
}

function sendHealth(
  res: http.ServerResponse,
  contextWindow: number,
  model?: string
): void {
  const body: HealthResponse = {
    ok: true,
    service: "iknow-session-api",
    version: getVersion(),
    contextWindow,
    ...(model !== undefined ? { model } : {}),
  };
  sendJson({ res, status: 200, body });
}

function isSsePath(pathname: string): boolean {
  return /^\/api\/v1\/sessions\/[^/]+\/events$/.test(pathname);
}

function sendSseReserved(res: http.ServerResponse): void {
  sendJson({
    res,
    status: 501,
    body: {
      error: {
        kind: "internal",
        message: "SSE streaming is reserved; not implemented in v0",
      },
    } satisfies ApiErrorBody,
  });
}

interface SendNotFoundOpts {
  readonly res: http.ServerResponse;
  readonly method: string;
  readonly pathname: string;
}

function sendNotFound(opts: SendNotFoundOpts): void {
  const { res, method, pathname } = opts;
  sendJson({
    res,
    status: 404,
    body: {
      error: { kind: "not_found", message: `no route ${method} ${pathname}` },
    } satisfies ApiErrorBody,
  });
}

/** Route context for /api/v1/permission-mode (web Shift+Tab 模式切换)。 */
type PermissionModeRouteContext = {
  method: string;
  req: http.IncomingMessage;
  res: http.ServerResponse;
  permissionMode?: PermissionModeContext;
};

/**
 * GET → 当前 mode；POST（空 body）→ cycle 语义走 SSOT nextShiftTabMode
 * （与 TUI/REPL 同一映射）并写回共享 holder（hub 运行时即时生效）。
 * holder 缺席 / 其它 method → 404。
 */
async function handlePermissionModeRoute(
  ctx: PermissionModeRouteContext
): Promise<void> {
  const { method, req, res, permissionMode } = ctx;
  if (permissionMode === undefined) {
    return sendNotFound({ res, method, pathname: "/api/v1/permission-mode" });
  }
  if (method === "GET") {
    const body: PermissionModeResponse = { mode: permissionMode.get() };
    return sendJson({ res, status: 200, body });
  }
  if (method === "POST") {
    await readJsonBody(req); // 消费 body（允许空）；切换无参数
    const next = nextShiftTabMode(permissionMode.get());
    permissionMode.set(next);
    const body: PermissionModeResponse = { mode: next };
    return sendJson({ res, status: 200, body });
  }
  return sendNotFound({ res, method, pathname: "/api/v1/permission-mode" });
}

/** Route context for /sessions/:id(...) dispatch (keeps param count ≤ 4). */
type RouteContext = {
  method: string;
  id: string;
  rest: string;
  req: http.IncomingMessage;
  res: http.ServerResponse;
  hub: SessionHub;
};

/** Dispatch a /sessions/:id(...) sub-route. Returns true when handled. */
async function handleSessionRoute(ctx: RouteContext): Promise<boolean> {
  const { method, id, rest, req, res, hub } = ctx;
  if (method === "GET" && rest === "") {
    sendJson({ res, status: 200, body: await hub.getSession(id) });
    return true;
  }
  if (method === "POST" && rest === "/messages") {
    const body = await readJsonBody(req);
    const text = extractTextField(body);
    // T2: parse + validate the optional per-turn thinking override; invalid
    // values throw ValidationError → 400 (fail loud, no silent fallback).
    const thinking = parseThinkingOverride(extractThinkingField(body));
    sendJson({
      res,
      status: 200,
      body: await hub.postMessage({ conversationId: id, text, thinking }),
    });
    return true;
  }
  if (method === "POST" && rest === "/reset") {
    const newId = extractBoolField({
      raw: await readJsonBody(req),
      key: "new_id",
    });
    sendJson({
      res,
      status: 200,
      body: await hub.resetSession(id, { new_id: newId }),
    });
    return true;
  }
  // POST /compact — 手动压缩会话（web 压缩按钮 / TUI /compact 的 HTTP 侧）。
  // body 可空；无 body / 空 body 等价 {}（压缩无参数）。
  if (method === "POST" && rest === "/compact") {
    await readJsonBody(req); // 消费 body（允许空），压缩本身无参数
    sendJson({
      res,
      status: 200,
      body: await hub.compactSession(id),
    });
    return true;
  }
  // GET pending ask requests (process-global snapshot). The SPA polls this
  // every ~2s to surface a permission dialog when the harness emits a decision
  // of `ask`.
  if (method === "GET" && rest === "/asks") {
    sendJson({ res, status: 200, body: { asks: hub.listPendingAsks() } });
    return true;
  }
  // #358 T7: GET /sessions/:id/subagents — 只读子代理状态投影(running/
  // completed/failed 合一)。hub 先做会话存在性门(未知会话 → typed 404 via
  // 已有多层 sendError 收编);列表包裹 {subagents:[...]} 镜像 {asks:[...]} 先例。
  if (method === "GET" && rest === "/subagents") {
    sendJson({
      res,
      status: 200,
      body: { subagents: await hub.listSubagentsForSession(id) },
    });
    return true;
  }
  // POST /asks/:askId/resolve — body {decision} ∈ {allow-once|always-allow|deny}.
  // Always 200 with `{resolved}`: true when the ask was still pending and got
  // resolved; false when the id is unknown / already resolved / timed out
  // (fail-closed). `resolved:false` lets the SPA treat the ask as expired
  // without a 404 that would look like a routing error.
  if (
    method === "POST" &&
    rest.startsWith("/asks/") &&
    rest.endsWith("/resolve")
  ) {
    const askId = decodeURIComponent(
      rest.slice("/asks/".length, -"/resolve".length)
    );
    const body = await readJsonBody(req);
    const decision = extractDecisionField(body);
    const ok = hub.resolveAsk(askId, decision);
    sendJson({ res, status: 200, body: { resolved: ok } });
    return true;
  }
  return false;
}

function extractDecisionField(
  raw: unknown
): "allow-once" | "always-allow" | "deny" {
  if (!raw || typeof raw !== "object") {
    throw new ValidationError("body must be a JSON object");
  }
  const o = raw as Record<string, unknown>;
  const d = o.decision;
  if (d === "allow-once" || d === "always-allow" || d === "deny") return d;
  throw new ValidationError(
    "decision must be one of allow-once | always-allow | deny"
  );
}

function parseCreateBody(raw: unknown): {
  json_mode?: boolean;
} {
  if (raw == null || raw === "") {
    return {};
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ValidationError("body must be a JSON object");
  }
  const o = raw as Record<string, unknown>;
  const out: {
    json_mode?: boolean;
  } = {};
  if (o.json_mode != null) {
    out.json_mode = Boolean(o.json_mode);
  }
  return out;
}

function extractTextField(raw: unknown): string {
  if (!raw || typeof raw !== "object") return "";
  const o = raw as Record<string, unknown>;
  return "text" in o ? String(o.text ?? "") : "";
}

/** T2: extract the optional `thinking` field raw value (validation happens
 * in parseThinkingOverride, which throws ValidationError on invalid values). */
function extractThinkingField(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  return "thinking" in o ? o.thinking : undefined;
}

interface ExtractBoolFieldOpts {
  readonly raw: unknown;
  readonly key: string;
}

function extractBoolField(opts: ExtractBoolFieldOpts): boolean {
  const { raw, key } = opts;
  if (!raw || typeof raw !== "object") return false;
  const o = raw as Record<string, unknown>;
  return Boolean(o[key]);
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const size = chunks.reduce((n, c) => n + c.length, 0);
    if (size > 256 * 1024) {
      throw new ValidationError("request body too large");
    }
  }
  if (chunks.length === 0) {
    return null;
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ValidationError("invalid JSON body");
  }
}

interface SendJsonOpts {
  readonly res: http.ServerResponse;
  readonly status: number;
  readonly body: unknown;
}

function sendJson(opts: SendJsonOpts): void {
  const { res, status, body } = opts;
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

/**
 * Type guard for the plain-object SessionStoreError discriminated union.
 * Error instances are excluded — notably traceserver's TraceReadError (which
 * also carries a `kind` property) now flows through the mounted trace router
 * in-process (ADR-0020): store errors are plain objects, never Error
 * subclasses, so a kind collision must not reroute them here.
 */
function isSessionStoreError(err: unknown): err is SessionStoreError {
  if (typeof err !== "object" || err === null) return false;
  if (err instanceof Error) return false;
  const k = (err as { kind?: unknown }).kind;
  return (
    typeof k === "string" &&
    (k === "not_found" ||
      k === "parse_failed" ||
      k === "schema_invalid" ||
      k === "write_failed" ||
      k === "concurrent_write" ||
      k === "io_error")
  );
}

/**
 * Centralized error → nested ApiErrorBody mapping.
 * Precedence: SessionStoreError → typed store error; ValidationError → 400
 * validation; IknowError NOT_FOUND → 404 not_found; everything else → 500.
 */
interface SendErrorOpts {
  readonly res: http.ServerResponse;
  readonly err: unknown;
}

function sendError(opts: SendErrorOpts): void {
  const { res, err } = opts;
  if (isSessionStoreError(err)) {
    const { status, body } = mapStoreError(err);
    sendJson({ res, status, body });
    return;
  }
  if (err instanceof ValidationError) {
    const field = err.details?.["field"];
    sendJson({
      res,
      status: 400,
      body: {
        error: {
          kind: "validation",
          message: err.message,
          field: typeof field === "string" ? field : undefined,
        },
      } satisfies ApiErrorBody,
    });
    return;
  }
  if (isIknowError(err) && err.code === "NOT_FOUND") {
    sendJson({
      res,
      status: 404,
      body: {
        error: { kind: "not_found", message: err.message },
      } satisfies ApiErrorBody,
    });
    return;
  }
  // 500 fallback: raw err.message may leak fs paths / library internals, so
  // only a fixed message goes on the wire; the real error stays server-side.
  console.error("[session-api] internal error:", err);
  sendJson({
    res,
    status: 500,
    body: {
      error: { kind: "internal", message: "internal server error" },
    } satisfies ApiErrorBody,
  });
}
