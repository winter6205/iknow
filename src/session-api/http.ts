/**
 * Minimal node:http router for Session API + static web UI.
 * Nested ApiErrorBody, hub error mapping, GET /sessions list.
 * ADR-0020: the trace inspection read API is MOUNTED in-process (reverses
 * the earlier standalone split): `opts.trace` mounts `/api/v1/traces*` via
 * traceserver's createTraceRouter + the trace SPA under `/trace`; write-side
 * `--trace-out` on serve/chat/ask remains unchanged.
 * Static-asset serving extracted to `src/web/serve-static.ts` so traceserver
 * can host its own SPA with the same guards; `resolveDefaultWebRoot` is
 * re-exported below for tests that historically imported it from here.
 */
import * as http from "node:http";
import { isIknowError, ValidationError } from "../shared/errors.js";
import {
  isWorkspaceRootError,
  renderWorkspaceRootError,
  type WorkspaceRootError,
} from "../config/workspace-root.js";
import { DEFAULT_STRATEGY_CONTEXT_WINDOW } from "../config/env.js";
import { isWorkspacesRecentsError } from "../config/workspaces-recents.js";
import { mapStoreError, type SessionHub } from "./hub.js";
import type { SessionStoreError } from "./store/index.js";
import { listSubdirectories } from "./browse-workspaces.js";
import { parseThinkingOverride } from "./thinking-override.js";
import type {
  ApiErrorBody,
  FsModeResponse,
  GraphModeResponse,
  HealthResponse,
  PermissionModeResponse,
  PutWorkspaceRequest,
  WorkspaceResponse,
  WorkspacesResponse,
} from "./contract.js";
import { getVersion } from "../cli/usage.js";
import {
  nextShiftTabMode,
  type PermissionModeContext,
} from "../harness/permission/modes.js";
import {
  applyGraphCommand,
  formatGraphStatus,
  type GraphModeContext,
} from "../harness/graph/mode.js";
import {
  applyFsModeCommand,
  formatFsModeStatus,
  type FsModeContext,
} from "../harness/sandbox/fs-mode.js";
import { createTraceRouter } from "../traceserver/serve.js";
import {
  resolveDefaultWebRoot,
  serveStaticRequest,
} from "../web/serve-static.js";

export { resolveDefaultWebRoot };

/** Default strategy context-window (ADR-0100): health's display denominator
 *  references the same constant from the env layer. */
export const DEFAULT_CONTEXT_WINDOW = DEFAULT_STRATEGY_CONTEXT_WINDOW;

export type SessionHttpServerOptions = {
  hub: SessionHub;
  /** Absolute path to web/ static root. */
  webRoot?: string;
  host?: string;
  port?: number;
  /** Strategy context-window size in tokens; denominator for usage display.
   *  Default `DEFAULT_STRATEGY_CONTEXT_WINDOW = 256_000` (ADR-0100).
   *  HealthResponse field; serve.ts passes it through from
   *  loadIknowEnv().compress.contextWindow. */
  contextWindow?: number;
  /** Model routing ID (settings.llm.model). HealthResponse field; passed
   *  through by serve.ts; absent → health omits model (byte-stable). */
  model?: string;
  /** Trace write-failure counter reader; health returns 0 when absent. */
  traceWriteFailures?: number | (() => number);
  /** Mutable permission-mode holder (same context instance as the hub).
   *  Present → GET/POST /api/v1/permission-mode; absent → both endpoints 404. */
  permissionMode?: PermissionModeContext;
  /** ADR-0030: mutable graph-overlay holder (same instance as the hub).
   *  Present → GET/POST /api/v1/graph-mode; absent → both endpoints 404. */
  graphMode?: GraphModeContext;
  /** ADR-0092: mutable fs-isolation-mode holder (same instance as the hub).
   *  Present → GET/POST /api/v1/fs-mode; absent → both endpoints 404. */
  fsMode?: FsModeContext;
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
      traceWriteFailures: opts.traceWriteFailures,
      permissionMode: opts.permissionMode,
      graphMode: opts.graphMode,
      fsMode: opts.fsMode,
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
  /** HealthResponse model field (omitted from the payload when absent). */
  readonly model?: string;
  readonly traceWriteFailures?: number | (() => number);
  /** Mutable permission-mode holder (absent → permission-mode endpoint 404). */
  readonly permissionMode?: PermissionModeContext;
  /** Mutable graph-overlay holder (absent → graph-mode endpoint 404). */
  readonly graphMode?: GraphModeContext;
  /** ADR-0092: mutable fs-isolation holder (absent → fs-mode endpoint 404). */
  readonly fsMode?: FsModeContext;
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
    traceWriteFailures,
    permissionMode,
    graphMode,
    fsMode,
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
      return sendHealth(res, contextWindow, model, traceWriteFailures);
    if (method === "GET" && isSsePath(pathname)) return sendSseReserved(res);

    if (method === "GET" && pathname === "/api/v1/skills") {
      return sendJson({
        res,
        status: 200,
        body: { skills: await hub.listSkills() },
      });
    }
    const skillMatch = pathname.match(/^\/api\/v1\/skills\/([^/]+)$/);
    if (method === "GET" && skillMatch) {
      const name = decodeURIComponent(skillMatch[1]!);
      return sendJson({
        res,
        status: 200,
        body: await hub.loadSkillBody(name),
      });
    }
    if (method === "GET" && pathname === "/api/v1/mcp") {
      return sendJson({
        res,
        status: 200,
        body: { servers: await hub.listMcpServers() },
      });
    }
    if (method === "POST" && pathname === "/api/v1/mcp/reload") {
      await readJsonBody(req);
      return sendJson({
        res,
        status: 200,
        body: { servers: await hub.reloadMcp() },
      });
    }
    if (method === "GET" && pathname === "/api/v1/mcp/tools") {
      return sendJson({
        res,
        status: 200,
        body: { tools: await hub.listMcpTools() },
      });
    }

    // The three holder routes (permission-mode / graph-mode / fs-mode) share
    // one shape: a single dispatch replaces three if-blocks (complexity
    // ratchet — every branch added to handle() must be paid back). Handler-
    // level validation semantics (invalid graph args, browse 422) are
    // unchanged; their catches live in each handler.
    const holderRoute = matchHolderRoute(pathname);
    if (holderRoute !== undefined) {
      return await holderRoute({
        method,
        req,
        res,
        permissionMode,
        graphMode,
        fsMode,
      });
    }

    // Workspace picker bind state + recents/trust roster.
    if (pathname === "/api/v1/workspace") {
      if (method === "GET") {
        return sendJson({
          res,
          status: 200,
          body: hub.getWorkspaceState() satisfies WorkspaceResponse,
        });
      }
      if (method === "PUT") {
        const parsed = parsePutWorkspaceBody(await readJsonBody(req));
        const root = await hub.bindWorkspace(parsed.path, {
          confirmTrust: parsed.confirmTrust,
        });
        return sendJson({
          res,
          status: 200,
          body: { bound: true, root } satisfies WorkspaceResponse,
        });
      }
      return sendMethodNotAllowed(res, method, pathname);
    }
    if (method === "GET" && pathname === "/api/v1/workspaces") {
      return sendJson({
        res,
        status: 200,
        body: {
          workspaces: (await hub.listTrustedWorkspaces()).map((root) => ({
            root,
          })),
        } satisfies WorkspacesResponse,
      });
    }
    // Subdirectory probe for the workspace picker breadcrumb. Pure-function
    // gated; any failure (missing / empty / relative / not_found / not_a_dir /
    // EACCES) collapses to a typed 422 `validation` so the SPA's caller
    // contract is predictable.
    if (pathname === "/api/v1/workspaces/browse") {
      if (method !== "GET") {
        return sendMethodNotAllowed(res, method, pathname);
      }
      return handleBrowseWorkspaces(req, res, url);
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
  model?: string,
  traceWriteFailures?: number | (() => number)
): void {
  const body: HealthResponse = {
    ok: true,
    service: "iknow-session-api",
    version: getVersion(),
    contextWindow,
    traceWriteFailures:
      typeof traceWriteFailures === "function"
        ? traceWriteFailures()
        : (traceWriteFailures ?? 0),
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

/** Route context for the three holder-backed mode endpoints. */
type HolderRouteContext = {
  method: string;
  req: http.IncomingMessage;
  res: http.ServerResponse;
  permissionMode?: PermissionModeContext;
  graphMode?: GraphModeContext;
  fsMode?: FsModeContext;
};

/**
 * Handler signature shared by the three holder routes.
 *
 * Contract: all three are `await`ed inside handle()'s try, so a thrown
 * ValidationError lands in handle()'s catch → sendError (invalid args → 400).
 * A bare `return promise` would reject outside the try: the response is never
 * written and the request hangs — dispatch sites must keep `return await`.
 */
type HolderRoute = (ctx: HolderRouteContext) => Promise<void>;

/**
 * pathname → holder-route handler (no match → undefined).
 *
 * The route table is data, not branches: handle() pays one null check per
 * request, so a fourth holder endpoint adds no branch count (complexity
 * ratchet). Lookups use `Map.get` — `in` counts as a complexity branch,
 * `get` does not.
 */
const HOLDER_ROUTES: ReadonlyMap<string, HolderRoute> = new Map<
  string,
  HolderRoute
>([
  ["/api/v1/permission-mode", handlePermissionModeRoute],
  ["/api/v1/graph-mode", handleGraphModeRoute],
  ["/api/v1/fs-mode", handleFsModeRoute],
]);

function matchHolderRoute(pathname: string): HolderRoute | undefined {
  return HOLDER_ROUTES.get(pathname);
}

/**
 * GET → current mode; POST (empty body) → cycle via SSOT nextShiftTabMode
 * (same mapping as TUI/REPL) and write back to the shared holder so the hub
 * picks it up at runtime immediately. Holder absent / other methods → 404.
 */
async function handlePermissionModeRoute(
  ctx: HolderRouteContext
): Promise<void> {
  const { method, req, res, permissionMode } = ctx;
  const pathname = "/api/v1/permission-mode";
  if (permissionMode === undefined) {
    return sendNotFound({ res, method, pathname });
  }
  if (method === "GET") {
    const body: PermissionModeResponse = { mode: permissionMode.get() };
    return sendJson({ res, status: 200, body });
  }
  if (method === "POST") {
    await readJsonBody(req); // drain body (may be empty); toggling takes no params
    const next = nextShiftTabMode(permissionMode.get());
    permissionMode.set(next);
    const body: PermissionModeResponse = { mode: next };
    return sendJson({ res, status: 200, body });
  }
  return sendNotFound({ res, method, pathname });
}

/**
 * Extract `args` from the POST body: default = empty array (equivalent to a
 * bare holder query).
 *
 * Shared verbatim by /graph-mode and /fs-mode: value ranges and copy each
 * live in their own SSOT, but the body shape is one wire contract — do not
 * duplicate it per route.
 */
function parseHolderArgs(body: unknown): ReadonlyArray<string> {
  if (body === undefined || body === null) return [];
  if (typeof body !== "object") {
    throw new ValidationError("body must be a JSON object");
  }
  const raw = (body as { args?: unknown }).args;
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.some((a) => typeof a !== "string")) {
    throw new ValidationError("args must be an array of strings", {
      field: "args",
    });
  }
  return raw as ReadonlyArray<string>;
}

/**
 * GET → current overlay state; POST (body `{ args }`) → SSOT
 * `applyGraphCommand` (same value range and copy as chat/TUI `/graph`).
 * Invalid args are a typed rejection (ValidationError → 400) and the holder
 * stays untouched — guessing user intent on the serve side is worse than an
 * error. Holder absent / other methods → 404.
 */
async function handleGraphModeRoute(ctx: HolderRouteContext): Promise<void> {
  const { method, req, res, graphMode } = ctx;
  const pathname = "/api/v1/graph-mode";
  if (graphMode === undefined) return sendNotFound({ res, method, pathname });
  if (method === "GET") {
    const body: GraphModeResponse = {
      enabled: graphMode.get().enabled,
      message: formatGraphStatus(graphMode.get()),
    };
    return sendJson({ res, status: 200, body });
  }
  if (method === "POST") {
    const args = parseHolderArgs(await readJsonBody(req));
    const applied = applyGraphCommand(graphMode, args);
    if (!applied.ok) throw new ValidationError(applied.text, { field: "args" });
    const body: GraphModeResponse = {
      enabled: graphMode.get().enabled,
      message: applied.text,
    };
    return sendJson({ res, status: 200, body });
  }
  return sendNotFound({ res, method, pathname });
}

/**
 * GET → current fs isolation mode; POST (body `{ args }`) → SSOT
 * `applyFsModeCommand` (same value range and copy as chat/TUI `/config`).
 * Invalid args are a typed rejection (ValidationError → 400) and the holder
 * stays untouched — guessing user intent on the serve side is worse than an
 * error. Holder absent / other methods → 404.
 *
 * Same as graph: this handler's ValidationError must land in handle()'s catch
 * (400) — dispatch keeps `return await`, see HolderRoute.
 */
async function handleFsModeRoute(ctx: HolderRouteContext): Promise<void> {
  const { method, req, res, fsMode } = ctx;
  const pathname = "/api/v1/fs-mode";
  if (fsMode === undefined) return sendNotFound({ res, method, pathname });
  if (method === "GET") {
    const body: FsModeResponse = {
      mode: fsMode.get(),
      message: formatFsModeStatus(fsMode.get()),
    };
    return sendJson({ res, status: 200, body });
  }
  if (method === "POST") {
    const args = parseHolderArgs(await readJsonBody(req));
    const applied = applyFsModeCommand(fsMode, args);
    if (!applied.ok) throw new ValidationError(applied.text, { field: "args" });
    const body: FsModeResponse = {
      mode: fsMode.get(),
      message: applied.text,
    };
    return sendJson({ res, status: 200, body });
  }
  return sendNotFound({ res, method, pathname });
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
    // Parse + validate the optional per-turn thinking override; invalid
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
  if (method === "GET" && rest === "/rewind-targets") {
    sendJson({
      res,
      status: 200,
      body: await hub.listRewindTargets(id),
    });
    return true;
  }
  if (method === "POST" && rest === "/rewind") {
    const head = extractHeadField(await readJsonBody(req));
    sendJson({
      res,
      status: 200,
      body: await hub.rewindSession(id, head),
    });
    return true;
  }
  // POST /compact — manual compaction (HTTP side of the web compact button /
  // TUI /compact). Body may be empty; missing/empty body ≡ {} (compaction
  // itself takes no params). Bind the req close event to an AbortController:
  // client disconnect → signal aborted → hub keeps state and responds
  // cancelled:true.
  if (method === "POST" && rest === "/compact") {
    await readJsonBody(req); // drain body (may be empty); compaction takes no params
    const compactController = new AbortController();
    req.once("close", () => compactController.abort());
    sendJson({
      res,
      status: 200,
      body: await hub.compactSession(id, { signal: compactController.signal }),
    });
    return true;
  }
  // POST /continue — resume after a HITL skip-append (HTTP side of CLI/TUI/Web
  // /continue). Mirrors POST /compact: body may be empty; no busy_stop_first
  // (the hub serializes/queues). Do not fake continue with an empty POST /messages.
  if (method === "POST" && rest === "/continue") {
    await readJsonBody(req);
    const continueController = new AbortController();
    req.once("close", () => continueController.abort());
    sendJson({
      res,
      status: 200,
      body: await hub.continueSession(id, {
        signal: continueController.signal,
      }),
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
  // GET /sessions/:id/subagents — read-only sub-agent status projection
  // (running/completed/failed unified). The hub gates on session existence
  // first (unknown session → typed 404 via the existing sendError mapping);
  // the {subagents:[...]} wrapper mirrors the {asks:[...]} precedent.
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

function extractHeadField(raw: unknown): string | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ValidationError("body must be a JSON object with head");
  }
  if (!Object.prototype.hasOwnProperty.call(raw, "head")) {
    throw new ValidationError("body must be a JSON object with head");
  }
  const head = (raw as Record<string, unknown>).head;
  if (head === null) return null;
  if (typeof head !== "string" || head.length === 0) {
    throw new ValidationError("head must be a non-empty event id or null");
  }
  return head;
}

function extractTextField(raw: unknown): string {
  if (!raw || typeof raw !== "object") return "";
  const o = raw as Record<string, unknown>;
  return "text" in o ? String(o.text ?? "") : "";
}

/** Extract the optional `thinking` field raw value (validation happens
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

/** Parse PUT /api/v1/workspace body. */
function parsePutWorkspaceBody(raw: unknown): PutWorkspaceRequest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ValidationError("body must be a JSON object");
  }
  const o = raw as Record<string, unknown>;
  const path = o["path"];
  if (typeof path !== "string") {
    throw new ValidationError("path must be a string", { field: "path" });
  }
  return {
    path,
    confirmTrust: Boolean(o["confirmTrust"]),
  };
}

/**
 * Handle `GET /api/v1/workspaces/browse?root=<abs>`.
 * The query-string root is forwarded as-is to `listSubdirectories`;
 * every failure collapses to 422 typed validation. Kept tiny to keep
 * the route table's complexity budget under control.
 */
function handleBrowseWorkspaces(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL
): void {
  const root = url.searchParams.get("root");
  if (root === null || root === "") {
    return sendJson({
      res,
      status: 422,
      body: {
        error: {
          kind: "validation",
          message: "root query parameter is required",
          field: "root",
        },
      } satisfies ApiErrorBody,
    });
  }
  void listSubdirectories(root).then((result) => {
    if (result.ok) {
      sendJson({
        res,
        status: 200,
        body: { entries: result.entries },
      });
      return;
    }
    // Every failure mode is a single 422 validation envelope so the SPA
    // never has to branch on a second layer of status codes.
    sendJson({
      res,
      status: 422,
      body: {
        error: {
          kind: "validation",
          message: result.message,
          field: "root",
        },
      } satisfies ApiErrorBody,
    });
  });
}

/** 405 for exact path with the wrong method. */
function sendMethodNotAllowed(
  res: http.ServerResponse,
  method: string,
  pathname: string
): void {
  sendJson({
    res,
    status: 405,
    body: {
      error: {
        kind: "internal",
        message: `method ${method} not allowed on ${pathname}`,
      },
    } satisfies ApiErrorBody,
  });
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
 * Recents/trust file errors → HTTP status + fixed wire message.
 * Mirrors the store error map's data-table shape; entries must NOT
 * carry a conversation_id (recents errors are home/file-level).
 */
const RECENTS_ERROR_MAP = {
  parse_failed: {
    status: 422,
    message: "workspaces.json is not valid JSON",
  },
  io_error: {
    status: 500,
    message: "IO error on workspaces.json",
  },
  concurrent_write: {
    status: 409,
    message: "concurrent write conflict on workspaces.json",
  },
} as const;

/**
 * Centralized error → nested ApiErrorBody mapping.
 * Precedence: WorkspaceRootError → 400 validation; recents errors → typed
 * status; SessionStoreError → typed store error; ValidationError → 400
 * validation; IknowError NOT_FOUND → 404 not_found; everything else → 500.
 */
interface SendErrorOpts {
  readonly res: http.ServerResponse;
  readonly err: unknown;
}

function sendError(opts: SendErrorOpts): void {
  const { res, err } = opts;
  // WorkspaceRootError MUST be checked before the SessionStoreError guard —
  // the `not_found` kind exists in both unions with different HTTP targets (400 validation vs 404 not_found). The
  // resolver's not_found is ADR-0023 EXIT.
  if (isWorkspaceRootError(err)) {
    const werr = err as WorkspaceRootError;
    sendJson({
      res,
      status: 400,
      body: {
        error: {
          kind: "validation",
          message: renderWorkspaceRootError(werr),
          field: "path",
        },
      } satisfies ApiErrorBody,
    });
    return;
  }
  // Recents/trust IO errors are plain objects with overlapping kinds
  // (parse_failed / concurrent_write) that the SessionStoreError guard would
  // otherwise misclassify. Map each kind to
  // its own status; messages are fixed text (no conversation_id — these
  // errors are file-level, not session-level).
  if (isWorkspacesRecentsError(err)) {
    const entry = RECENTS_ERROR_MAP[err.kind];
    sendJson({
      res,
      status: entry.status,
      body: {
        error: {
          kind: err.kind,
          message: entry.message,
        },
      } satisfies ApiErrorBody,
    });
    return;
  }
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
