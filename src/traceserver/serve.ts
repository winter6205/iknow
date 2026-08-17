/**
 * Trace inspection HTTP layer (#183 standalone → ADR-0020 mountable router).
 *
 * Two surfaces:
 *
 * 1. `createTraceRouter(opts)` — the reusable mountable router (ADR-0020 D1.5).
 *    Returns `(req, res) => Promise<boolean>`: `true` = handled (response
 *    written), `false` = not a trace route (caller keeps dispatching). Mounted
 *    by `iknow serve` (src/session-api/http.ts) at `/api/v1/traces*` on the
 *    shared 8787 port; also used by the standalone shell below. Routes:
 *      GET /api/v1/traces             -> delegated to handleTracesRequest
 *      GET /api/v1/traces/fields      -> delegated to handleTracesRequest
 *      GET /api/v1/traces/sessions    -> delegated to handleSessionsRequest
 *                                        (ADR-0020 D1.1: sessions live under
 *                                        the traces prefix in mounted mode to
 *                                        avoid colliding with chat sessions)
 *    The router does NOT serve /api/v1/health or static files — mounted mode
 *    gets health from session-api and the trace SPA from the caller's static
 *    layer (`/trace` mount, ADR-0020 D1.2). Error mapping lives here (S3):
 *      ValidationError -> 400 validation
 *      TraceReadError  -> 500 internal (no fs detail leak)
 *      unknown         -> 500 internal
 *
 * 2. `startTraceServe(opts)` — the standalone `iknow trace --separate` shell.
 *    Owns its own http.Server, health endpoint, trace SPA static hosting, and
 *    the back-compat `/api/v1/sessions` alias (one release, ADR-0020 D1.1).
 *
 * v2 目录语义: traceOut 是「每会话一文件」的目录 `<traceDir>/<convId>.jsonl`
 * (写侧 T2 jsonl.ts 目录语义)。serve 仅解析并透传 traceDir, 路由/解析都在
 * http.ts。
 */
import * as http from "node:http";
import * as path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isIknowError, ValidationError } from "../shared/errors.js";
import { TraceReadError } from "./types.js";
import { handleTracesRequest, handleSessionsRequest } from "./http.js";
import {
  resolveDefaultWebRoot,
  serveStaticRequest,
} from "../web/serve-static.js";

/** ADR-0020 D1.5: injectable router dependencies (no CLI-module reverse import). */
export interface TraceRouterOptions {
  /** Absolute path to the trace directory (writer-side traceOut). */
  readonly traceDir?: string;
  /** Cap bytes per read; defaults to the reader's MAX_TRACE_BYTES. */
  readonly maxBytes?: number;
  /** Version string for standalone health (injected by the caller). */
  readonly version?: string;
}

export type TraceRouter = (
  req: http.IncomingMessage,
  res: http.ServerResponse
) => Promise<boolean>;

/**
 * Create a mountable trace router (ADR-0020 D1.5). Pure factory — no server,
 * no shared mutable state; each call yields an independent closure so the
 * router is safe to mount in-process alongside the session API.
 */
export function createTraceRouter(opts: TraceRouterOptions = {}): TraceRouter {
  const traceDir = opts.traceDir;
  const maxBytes = opts.maxBytes;

  return async (req, res) => {
    const method = (req.method ?? "GET").toUpperCase();
    if (method !== "GET") return false;

    let url: URL;
    try {
      url = new URL(
        req.url ?? "/",
        `http://${req.headers.host ?? "localhost"}`
      );
    } catch {
      return false;
    }
    const pathname = url.pathname;

    if (pathname === "/api/v1/traces/sessions") {
      try {
        handleSessionsRequest({
          res,
          url,
          ...(traceDir !== undefined ? { traceDir } : {}),
          ...(maxBytes !== undefined ? { maxBytes } : {}),
        });
      } catch (err) {
        sendError({ res, err });
      }
      return true;
    }
    if (pathname.startsWith("/api/v1/traces")) {
      try {
        handleTracesRequest({
          res,
          url,
          ...(traceDir !== undefined ? { traceDir } : {}),
          ...(maxBytes !== undefined ? { maxBytes } : {}),
        });
      } catch (err) {
        sendError({ res, err });
      }
      return true;
    }
    return false;
  };
}

export interface TraceServeOptions {
  /** Absolute or CWD-relative path to the trace directory (writer side). */
  readonly traceOut?: string;
  readonly host?: string;
  readonly port?: number;
  /** Cap bytes per read; defaults to MAX_TRACE_BYTES. */
  readonly maxBytes?: number;
  /** Root directory for the trace inspection SPA (trace.html). */
  readonly webRoot?: string;
  /** Version for /api/v1/health; injected by the caller (ADR-0020 D1.4). */
  readonly version?: string;
}

export interface TraceListeningServer {
  readonly server: http.Server;
  readonly host: string;
  readonly port: number;
  readonly close: () => Promise<void>;
}

/**
 * Start the standalone trace inspection HTTP server (`iknow trace --separate`).
 * Port 0 yields an OS-assigned ephemeral port (reflected on the returned
 * handle). Composes createTraceRouter + standalone health + SPA static +
 * the back-compat `/api/v1/sessions` alias.
 */
export function startTraceServe(
  opts: TraceServeOptions = {}
): Promise<TraceListeningServer> {
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 24881;
  const traceDir = opts.traceOut ? path.resolve(opts.traceOut) : undefined;
  const webRoot = opts.webRoot ?? resolveDefaultWebRoot();
  const version = opts.version ?? readLocalVersion();
  const router = createTraceRouter({
    ...(traceDir !== undefined ? { traceDir } : {}),
    ...(opts.maxBytes !== undefined ? { maxBytes: opts.maxBytes } : {}),
  });

  const server = http.createServer((req, res) => {
    void handleStandaloneRequest({
      req,
      res,
      router,
      version,
      webRoot,
      traceDir,
      maxBytes: opts.maxBytes,
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      const addr = server.address();
      const boundPort = typeof addr === "object" && addr ? addr.port : port;
      resolve({
        server,
        host,
        port: boundPort,
        close: () =>
          new Promise((res, rej) => {
            server.close((err) => (err ? rej(err) : res()));
          }),
      });
    });
  });
}

interface StandaloneRequestOpts {
  readonly req: http.IncomingMessage;
  readonly res: http.ServerResponse;
  readonly router: TraceRouter;
  readonly version: string;
  readonly webRoot: string;
  readonly traceDir?: string;
  readonly maxBytes?: number;
}

async function handleStandaloneRequest(
  opts: StandaloneRequestOpts
): Promise<void> {
  const { req, res, router, version, webRoot, traceDir, maxBytes } = opts;
  try {
    const method = (req.method ?? "GET").toUpperCase();
    const url = new URL(
      req.url ?? "/",
      `http://${req.headers.host ?? "localhost"}`
    );
    const pathname = url.pathname;

    if (method === "GET" && pathname === "/api/v1/health") {
      sendJson(res, 200, {
        ok: true,
        service: "iknow-trace",
        version,
      });
      return;
    }
    // ADR-0020 D1.1: back-compat alias — standalone keeps the top-level
    // /api/v1/sessions route (mounted mode uses /api/v1/traces/sessions).
    if (method === "GET" && pathname === "/api/v1/sessions") {
      handleSessionsRequest({
        res,
        url,
        ...(traceDir !== undefined ? { traceDir } : {}),
        ...(maxBytes !== undefined ? { maxBytes } : {}),
      });
      return;
    }
    if (await router(req, res)) return;
    if (
      method === "GET" &&
      serveStaticRequest({ res, webRoot, pathname, fallbackHtml: "trace.html" })
    ) {
      return;
    }
    sendJson(res, 404, {
      error: { kind: "not_found", message: `no route GET ${pathname}` },
    });
  } catch (err) {
    sendError({ res, err });
  }
}

const FALLBACK_VERSION = "0.0.0";

/**
 * Standalone-only version reader (ADR-0020 D1.4): traceserver no longer
 * reverse-imports the CLI usage module — mounted mode gets its version from
 * the caller (session-api already reads the package version for its own
 * health). Mirrors the CLI getVersion computation (src/traceserver or
 * dist/traceserver → repo root).
 */
function readLocalVersion(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkgPath = path.join(here, "..", "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
      version?: string;
    };
    if (typeof pkg.version === "string" && pkg.version.length > 0) {
      return pkg.version;
    }
    return FALLBACK_VERSION;
  } catch {
    return FALLBACK_VERSION;
  }
}

interface SendErrorOpts {
  readonly res: http.ServerResponse;
  readonly err: unknown;
}

function sendError(opts: SendErrorOpts): void {
  const { res, err } = opts;
  if (err instanceof ValidationError) {
    const field = err.details?.["field"];
    sendJson(res, 400, {
      error: {
        kind: "validation",
        message: err.message,
        field: typeof field === "string" ? field : undefined,
      },
    });
    return;
  }
  if (err instanceof TraceReadError) {
    // NO fs detail leak — the original message can include fs errno / path.
    sendJson(res, 500, {
      error: {
        kind: "internal",
        message: "trace file read failed",
      },
    });
    return;
  }
  if (isIknowError(err) && err.code === "NOT_FOUND") {
    sendJson(res, 404, {
      error: { kind: "not_found", message: err.message },
    });
    return;
  }
  // 500 fallback: log server-side, never echo unknown messages onto the wire.
  console.error("[traceserver] internal error:", err);
  sendJson(res, 500, {
    error: { kind: "internal", message: "internal server error" },
  });
}

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
