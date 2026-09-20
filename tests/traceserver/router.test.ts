/**
 * `createTraceRouter` factory tests (ADR-0020 D1.5).
 *
 * The factory returns `(req, res) => Promise<boolean>`: true = handled
 * (response written), false = non-trace route (the caller keeps dispatching).
 * Tested directly with lightweight req/res stand-ins, bypassing
 * `http.createServer` (the handler only calls writeHead/end, never pipes streams).
 *
 * Categories (S2 defensive contract, boundary classes):
 *   - happy: /api/v1/traces, /traces/fields, /traces/sessions hits return true
 *   - negative: non-trace paths / POST → false, response untouched
 *   - empty: no traceDir → /api/v1/traces hits but 404 "no trace file configured"
 *   - concurrent: two factory instances have independent closures (no traceDir cross-talk)
 *   - exception: invalid query → mapped to 400 by the router's internal sendError (never thrown to the caller)
 */
import { afterEach, describe, expect, it } from "vitest";
import * as http from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTraceRouter } from "../../src/traceserver/serve.ts";

// -- req/res stand-ins (handler only uses writeHead/end, no pipe) -------------

interface FakeRes {
  statusCode: number;
  headers: Record<string, string | number | readonly string[]>;
  body: string;
  ended: boolean;
  writeHead(
    status: number,
    headers?: Record<string, string | number | readonly string[]>
  ): FakeRes;
  end(payload?: string): FakeRes;
}

function makeRes(): FakeRes {
  const res: FakeRes = {
    statusCode: 0,
    headers: {},
    body: "",
    ended: false,
    writeHead(status, headers) {
      this.statusCode = status;
      if (headers) Object.assign(this.headers, headers);
      return this;
    },
    end(payload) {
      this.body = payload ?? "";
      this.ended = true;
      return this;
    },
  };
  return res;
}

function makeReq(method: string, url: string): http.IncomingMessage {
  return {
    method,
    url,
    headers: { host: "localhost" },
  } as unknown as http.IncomingMessage;
}

function asServerResponse(res: FakeRes): http.ServerResponse {
  return res as unknown as http.ServerResponse;
}

// -- fixtures ------------------------------------------------------------------

const tmpDirs: string[] = [];
/**
 * T6 (SC16): all sessions sit at
 *   `<dir>/projects/<slug>/<convId>/trace.jsonl`.
 */
const TEST_PROJECT_SLUG = "test-project-router";

function mkTmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs.length = 0;
});

function writeSession(dir: string, convId: string): void {
  mkdirSync(join(dir, "projects", TEST_PROJECT_SLUG, convId), {
    recursive: true,
  });
  writeFileSync(
    join(dir, "projects", TEST_PROJECT_SLUG, convId, "trace.jsonl"),
    JSON.stringify({
      conversation_id: convId,
      record_type: "turn",
      turn_id: "t-0",
      turn_index: 0,
      started_at: "2026-08-17T01:00:00.000Z",
      ended_at: "2026-08-17T01:00:01.000Z",
      duration_ms: 1000,
      llm_call_ids: [],
      tool_call_ids: [],
      decision: "completed",
      status: "ok",
    }) + "\n",
    "utf8"
  );
}

// -- hit routes: return true and write the response --------------------------------

describe("createTraceRouter — 命中路由返 true", () => {
  it("GET /api/v1/traces → true + 200 records 形态", async () => {
    const dir = mkTmp("router-hit-");
    writeSession(dir, "c1");
    const router = createTraceRouter({ traceDir: dir });
    const res = makeRes();
    const handled = await router(
      makeReq("GET", "/api/v1/traces"),
      asServerResponse(res)
    );
    expect(handled).toBe(true);
    expect(res.ended).toBe(true);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { records: unknown[]; total: number };
    expect(Array.isArray(body.records)).toBe(true);
    expect(body.total).toBe(1);
  });

  it("GET /api/v1/traces/fields → true + fields 数组", async () => {
    const router = createTraceRouter({});
    const res = makeRes();
    const handled = await router(
      makeReq("GET", "/api/v1/traces/fields"),
      asServerResponse(res)
    );
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { fields: unknown[] };
    expect(Array.isArray(body.fields)).toBe(true);
    expect(body.fields.length).toBeGreaterThan(0);
  });

  it("GET /api/v1/traces/sessions → true + sessions 列表", async () => {
    const dir = mkTmp("router-sessions-");
    writeSession(dir, "c1");
    const router = createTraceRouter({ traceDir: dir });
    const res = makeRes();
    const handled = await router(
      makeReq("GET", "/api/v1/traces/sessions"),
      asServerResponse(res)
    );
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      sessions: Array<{ conversation_id: string }>;
    };
    expect(body.sessions.map((s) => s.conversation_id)).toEqual(["c1"]);
  });
});

// -- miss: return false and leave the response unwritten -----------------------------

describe("createTraceRouter — 非 trace 路由返 false", () => {
  it("GET /api/v1/health → false（mounted health 归 session-api）", async () => {
    const router = createTraceRouter({});
    const res = makeRes();
    const handled = await router(
      makeReq("GET", "/api/v1/health"),
      asServerResponse(res)
    );
    expect(handled).toBe(false);
    expect(res.ended).toBe(false);
  });

  it("GET / → false（SPA 归 caller 静态层）", async () => {
    const router = createTraceRouter({});
    const res = makeRes();
    expect(await router(makeReq("GET", "/"), asServerResponse(res))).toBe(
      false
    );
    expect(res.ended).toBe(false);
  });

  it("GET /trace → false（trace SPA 归 caller 静态层，不走 router）", async () => {
    const router = createTraceRouter({});
    const res = makeRes();
    expect(await router(makeReq("GET", "/trace"), asServerResponse(res))).toBe(
      false
    );
    expect(res.ended).toBe(false);
  });

  it("POST /api/v1/traces → false（router 只接 GET）", async () => {
    const router = createTraceRouter({});
    const res = makeRes();
    expect(
      await router(makeReq("POST", "/api/v1/traces"), asServerResponse(res))
    ).toBe(false);
    expect(res.ended).toBe(false);
  });
});

// -- empty: no traceDir --------------------------------------------------------------

describe("createTraceRouter — empty（无 traceDir）", () => {
  it("GET /api/v1/traces → true + 404 no trace file configured", async () => {
    const router = createTraceRouter({});
    const res = makeRes();
    const handled = await router(
      makeReq("GET", "/api/v1/traces"),
      asServerResponse(res)
    );
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body) as {
      error: { kind: string; message: string };
    };
    expect(body.error.kind).toBe("not_found");
    expect(body.error.message).toBe("no trace file configured");
  });

  it("GET /api/v1/traces/sessions → true + 404 no trace file configured", async () => {
    const router = createTraceRouter({});
    const res = makeRes();
    const handled = await router(
      makeReq("GET", "/api/v1/traces/sessions"),
      asServerResponse(res)
    );
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(404);
  });
});

// -- concurrent: two instances, closures isolated ----------------------------------

describe("createTraceRouter — concurrent（实例隔离）", () => {
  it("两个 factory 各自 traceDir 不串", async () => {
    const dirA = mkTmp("router-iso-a-");
    const dirB = mkTmp("router-iso-b-");
    writeSession(dirA, "a1");
    writeSession(dirB, "b1");
    const routerA = createTraceRouter({ traceDir: dirA });
    const routerB = createTraceRouter({ traceDir: dirB });

    const resA = makeRes();
    const resB = makeRes();
    const [handledA, handledB] = await Promise.all([
      routerA(
        makeReq("GET", "/api/v1/traces/sessions"),
        asServerResponse(resA)
      ),
      routerB(
        makeReq("GET", "/api/v1/traces/sessions"),
        asServerResponse(resB)
      ),
    ]);
    expect(handledA).toBe(true);
    expect(handledB).toBe(true);
    const bodyA = JSON.parse(resA.body) as {
      sessions: Array<{ conversation_id: string }>;
    };
    const bodyB = JSON.parse(resB.body) as {
      sessions: Array<{ conversation_id: string }>;
    };
    expect(bodyA.sessions.map((s) => s.conversation_id)).toEqual(["a1"]);
    expect(bodyB.sessions.map((s) => s.conversation_id)).toEqual(["b1"]);
  });
});

// -- exception: invalid query → router's internal error envelope, not thrown to caller --

describe("createTraceRouter — exception（错误信封内收）", () => {
  it("limit=-1 → true + 400 validation（field=limit）", async () => {
    const dir = mkTmp("router-err-");
    writeSession(dir, "c1");
    const router = createTraceRouter({ traceDir: dir });
    const res = makeRes();
    const handled = await router(
      makeReq("GET", "/api/v1/traces?limit=-1"),
      asServerResponse(res)
    );
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as {
      error: { kind: string; field?: string };
    };
    expect(body.error.kind).toBe("validation");
    expect(body.error.field).toBe("limit");
  });

  it("conversation_id 含路径分隔符 → true + 400 validation", async () => {
    const dir = mkTmp("router-err2-");
    writeSession(dir, "c1");
    const router = createTraceRouter({ traceDir: dir });
    const res = makeRes();
    const handled = await router(
      makeReq("GET", "/api/v1/traces?conversation_id=..%2Fevil"),
      asServerResponse(res)
    );
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as {
      error: { kind: string; field?: string };
    };
    expect(body.error.kind).toBe("validation");
    expect(body.error.field).toBe("conversation_id");
  });
});
