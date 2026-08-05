/**
 * `iknow trace` standalone HTTP server (#183).
 *
 * Hosts the read-only trace inspection API on its own process so JSONL reads
 * no longer share a process with the LLM streaming session hub. Routes:
 *   GET /api/v1/health            -> { ok, service, version }
 *   GET /api/v1/traces[?...]      -> delegated to handleTracesRequest
 *   GET /api/v1/traces/fields     -> delegated to handleTracesRequest
 *
 * Error mapping (S3):
 *   ValidationError  -> 400 validation
 *   TraceReadError   -> 500 internal (no fs detail leak)
 *   unknown          -> 500 internal
 */
import * as http from "node:http";
import * as path from "node:path";
import { isIknowError, ValidationError } from "../shared/errors.js";
import { TraceReadError } from "./types.js";
import { handleTracesRequest } from "./http.js";
import { getVersion } from "../cli/usage.js";

export interface TraceServeOptions {
  /** Absolute or CWD-relative path to the JSONL trace file (writer side). */
  readonly traceOut?: string;
  readonly host?: string;
  readonly port?: number;
  /** Cap bytes per read; defaults to MAX_TRACE_BYTES. */
  readonly maxBytes?: number;
}

export interface TraceListeningServer {
  readonly server: http.Server;
  readonly host: string;
  readonly port: number;
  readonly close: () => Promise<void>;
}

/**
 * Start the standalone trace inspection HTTP server. Port 0 yields an
 * OS-assigned ephemeral port (reflected on the returned handle).
 */
export function startTraceServe(
  opts: TraceServeOptions = {}
): Promise<TraceListeningServer> {
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 24881;
  const traceFilePath = opts.traceOut ? path.resolve(opts.traceOut) : undefined;

  const server = http.createServer((req, res) => {
    void handleRequest({ req, res, traceFilePath, maxBytes: opts.maxBytes });
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

interface HandleRequestOpts {
  readonly req: http.IncomingMessage;
  readonly res: http.ServerResponse;
  readonly traceFilePath?: string;
  readonly maxBytes?: number;
}

async function handleRequest(opts: HandleRequestOpts): Promise<void> {
  const { req, res, traceFilePath, maxBytes } = opts;
  try {
    const method = (req.method ?? "GET").toUpperCase();
    const url = new URL(
      req.url ?? "/",
      `http://${req.headers.host ?? "localhost"}`
    );
    const pathname = url.pathname;

    if (method === "GET" && pathname === "/api/v1/health") {
      return sendHealth(res);
    }
    if (method === "GET" && pathname.startsWith("/api/v1/traces")) {
      return handleTracesRequest({
        res,
        url,
        traceFilePath,
        ...(maxBytes !== undefined ? { maxBytes } : {}),
      });
    }
    sendJson(res, 404, {
      error: { kind: "not_found", message: `no route GET ${pathname}` },
    });
  } catch (err) {
    sendError({ res, err });
  }
}

function sendHealth(res: http.ServerResponse): void {
  sendJson(res, 200, {
    ok: true,
    service: "iknow-trace",
    version: getVersion(),
  });
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
