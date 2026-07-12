/**
 * Minimal node:http router for Session API + static web UI.
 */
import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { isIknowError, ValidationError } from "../shared/errors.js";
import { parseCallerRole } from "../shared/schema.js";
import { parseAgentModeCli } from "../interaction/slash.js";
import type { SessionHub } from "./hub.js";
import type { ApiErrorBody, HealthResponse } from "./contract.js";
import { getVersion } from "../cli/usage.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".map": "application/json; charset=utf-8",
};

export function createSessionHttpServer(
  opts: SessionHttpServerOptions,
): http.Server {
  const hub = opts.hub;
  const webRoot =
    opts.webRoot ?? path.resolve(__dirname, "../../web");

  return http.createServer((req, res) => {
    void handle(req, res, hub, webRoot);
  });
}

export async function listenSessionServer(
  opts: SessionHttpServerOptions,
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
  const boundPort =
    typeof addr === "object" && addr ? addr.port : port;

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

async function handle(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  hub: SessionHub,
  webRoot: string,
): Promise<void> {
  try {
    const method = (req.method ?? "GET").toUpperCase();
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const pathname = decodeURIComponent(url.pathname);

    if (method === "GET" && pathname === "/api/v1/health") {
      const body: HealthResponse = {
        ok: true,
        service: "iknow-session-api",
        version: getVersion(),
      };
      return sendJson(res, 200, body);
    }

    // Reserved SSE — explicit 501 so UI can detect.
    if (
      method === "GET" &&
      /^\/api\/v1\/sessions\/[^/]+\/events$/.test(pathname)
    ) {
      return sendJson(res, 501, {
        error: "not_implemented",
        message: "SSE streaming is reserved; not implemented in v0",
        details: { path: pathname },
      } satisfies ApiErrorBody);
    }

    if (method === "POST" && pathname === "/api/v1/sessions") {
      const raw = await readJsonBody(req);
      const createReq = parseCreateBody(raw);
      const out = await hub.createSession(createReq);
      return sendJson(res, 201, out);
    }

    const sessionMatch = pathname.match(
      /^\/api\/v1\/sessions\/([^/]+)(\/.*)?$/,
    );
    if (sessionMatch) {
      const id = sessionMatch[1]!;
      const rest = sessionMatch[2] ?? "";

      if (method === "GET" && rest === "") {
        return sendJson(res, 200, hub.getSession(id));
      }
      if (method === "POST" && rest === "/messages") {
        const raw = await readJsonBody(req);
        const text =
          raw && typeof raw === "object" && "text" in raw
            ? String((raw as { text: unknown }).text ?? "")
            : "";
        const out = await hub.postMessage(id, text);
        return sendJson(res, 200, out);
      }
      if (method === "POST" && rest === "/commands") {
        const raw = await readJsonBody(req);
        const command =
          raw && typeof raw === "object" && "command" in raw
            ? String((raw as { command: unknown }).command ?? "")
            : "";
        const args =
          raw &&
          typeof raw === "object" &&
          "args" in raw &&
          Array.isArray((raw as { args: unknown }).args)
            ? (raw as { args: unknown[] }).args.map(String)
            : [];
        const out = await hub.postCommand(id, command, args);
        return sendJson(res, 200, out);
      }
      if (method === "POST" && rest === "/reset") {
        const raw = await readJsonBody(req);
        let new_id = false;
        if (raw && typeof raw === "object" && "new_id" in raw) {
          new_id = Boolean((raw as { new_id: unknown }).new_id);
        }
        const out = await hub.resetSession(id, { new_id });
        return sendJson(res, 200, out);
      }
    }

    if (method === "GET") {
      const served = tryServeStatic(res, webRoot, pathname);
      if (served) {
        return;
      }
    }

    sendJson(res, 404, {
      error: "not_found",
      message: `no route ${method} ${pathname}`,
    } satisfies ApiErrorBody);
  } catch (err) {
    sendError(res, err);
  }
}

function parseCreateBody(raw: unknown): {
  role?: ReturnType<typeof parseCallerRole>;
  mode?: ReturnType<typeof parseAgentModeCli>;
  json_mode?: boolean;
  embeddings?: boolean;
} {
  if (raw == null || raw === "") {
    return {};
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ValidationError("body must be a JSON object");
  }
  const o = raw as Record<string, unknown>;
  const out: {
    role?: ReturnType<typeof parseCallerRole>;
    mode?: ReturnType<typeof parseAgentModeCli>;
    json_mode?: boolean;
    embeddings?: boolean;
  } = {};
  try {
    if (o.role != null) {
      out.role = parseCallerRole(String(o.role));
    }
    if (o.mode != null) {
      out.mode = parseAgentModeCli(String(o.mode));
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ValidationError(msg);
  }
  if (o.json_mode != null) {
    out.json_mode = Boolean(o.json_mode);
  }
  if (o.embeddings != null) {
    out.embeddings = Boolean(o.embeddings);
  }
  return out;
}

async function readJsonBody(
  req: http.IncomingMessage,
): Promise<unknown> {
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

function tryServeStatic(
  res: http.ServerResponse,
  webRoot: string,
  pathname: string,
): boolean {
  let rel = pathname === "/" ? "/index.html" : pathname;
  if (rel.startsWith("/web/")) {
    rel = rel.slice("/web".length);
  }
  // Prevent path traversal.
  const resolved = path.resolve(webRoot, "." + rel);
  if (!resolved.startsWith(path.resolve(webRoot))) {
    sendJson(res, 403, {
      error: "permission_denied",
      message: "path not allowed",
    } satisfies ApiErrorBody);
    return true;
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    // SPA fallback for bare /
    if (pathname === "/" || pathname === "/index.html") {
      return false;
    }
    return false;
  }
  const ext = path.extname(resolved).toLowerCase();
  const type = MIME[ext] ?? "application/octet-stream";
  res.writeHead(200, {
    "Content-Type": type,
    "Cache-Control": "no-cache",
  });
  fs.createReadStream(resolved).pipe(res);
  return true;
}

function sendJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

function sendError(res: http.ServerResponse, err: unknown): void {
  if (isIknowError(err)) {
    const status =
      err.code === "VALIDATION"
        ? 400
        : err.code === "NOT_FOUND"
          ? 404
          : err.code === "PERMISSION_DENIED"
            ? 403
            : 500;
    sendJson(res, status, {
      error: err.code.toLowerCase(),
      message: err.message,
      details: err.details,
    } satisfies ApiErrorBody);
    return;
  }
  if (err instanceof Error) {
    const validation =
      err.name === "ValidationError" ||
      /invalid|must be|too large|required/i.test(err.message);
    sendJson(res, validation ? 400 : 500, {
      error: validation ? "validation" : "error",
      message: err.message,
    } satisfies ApiErrorBody);
    return;
  }
  sendJson(res, 500, {
    error: "error",
    message: String(err),
  } satisfies ApiErrorBody);
}
