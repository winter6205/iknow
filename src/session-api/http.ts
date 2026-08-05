/**
 * Minimal node:http router for Session API + static web UI.
 * 022 T5: nested ApiErrorBody, hub error mapping, GET /sessions list.
 * 183 R3: trace inspection read API was moved to `iknow trace`; this server
 * no longer mounts /api/v1/traces (write-side `--trace-out` on serve/chat/ask
 * remains unchanged).
 * Static-asset serving extracted to `src/web/serve-static.ts` so traceserver
 * can host its own SPA with the same guards; `resolveDefaultWebRoot` is
 * re-exported below for tests that historically imported it from here.
 */
import * as http from "node:http";
import { isIknowError, ValidationError } from "../shared/errors.js";
import { mapStoreError, type SessionHub } from "./hub.js";
import type { SessionStoreError } from "./store/index.js";
import { parseThinkingOverride } from "./thinking-override.js";
import type { ApiErrorBody, HealthResponse } from "./contract.js";
import { getVersion } from "../cli/usage.js";
import {
  resolveDefaultWebRoot,
  serveStaticRequest,
} from "../web/serve-static.js";

export { resolveDefaultWebRoot };

export type SessionHttpServerOptions = {
  hub: SessionHub;
  /** Absolute path to web/ static root. */
  webRoot?: string;
  host?: string;
  port?: number;
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

  return http.createServer((req, res) => {
    void handle({ req, res, hub, webRoot });
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
}

async function handle(opts: HandleOpts): Promise<void> {
  const { req, res, hub, webRoot } = opts;
  try {
    const method = (req.method ?? "GET").toUpperCase();
    const url = new URL(
      req.url ?? "/",
      `http://${req.headers.host ?? "localhost"}`
    );
    const pathname = decodeURIComponent(url.pathname);

    if (method === "GET" && pathname === "/api/v1/health")
      return sendHealth(res);
    if (method === "GET" && isSsePath(pathname)) return sendSseReserved(res);

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

function sendHealth(res: http.ServerResponse): void {
  const body: HealthResponse = {
    ok: true,
    service: "iknow-session-api",
    version: getVersion(),
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
  return false;
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
 * Error instances (e.g. traceserver TraceReadError, which also carries a
 * `kind` property) are excluded: store errors are plain objects, never
 * Error subclasses, so a kind collision must not reroute them here.
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
