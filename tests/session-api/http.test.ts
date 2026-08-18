/**
 * Session API HTTP integration tests (022 T5).
 *
 * Boots a real node:http listener on 127.0.0.1:0, exercises 7 endpoints
 * with fetch, and asserts nested ApiErrorBody shape for error responses.
 *
 * Covers:
 *   - GET /api/v1/health
 *   - POST /api/v1/sessions (create)
 *   - GET /api/v1/sessions (list — new in T5)
 *   - GET /api/v1/sessions/:id (projected turns)
 *   - POST /api/v1/sessions/:id/messages
 *   - POST /api/v1/sessions/:id/reset
 *   - POST /api/v1/sessions/:id/commands → 404 (route removed in T5)
 *   - Error shape: not_found (404) / validation (400)
 */
import { afterEach, beforeEach, describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SessionHub,
  type SessionHubOptions,
} from "../../src/session-api/hub.ts";
import {
  listenSessionServer,
  resolveDefaultWebRoot,
  type ListeningServer,
  type SessionHttpServerOptions,
} from "../../src/session-api/http.ts";
import { SessionStore } from "../../src/session-api/store/index.ts";
import { createPermissionModeContext } from "../../src/harness/permission/modes.ts";
import type { AssistantTurnResult } from "../../src/harness/index.ts";
import { assistantResult, makeDeps } from "../cli/_fixtures.ts";
import {
  makeTestLlmEnv,
  startLlmCapture,
  type LlmCapture,
} from "./_helpers/llm-capture.ts";

// -- per-test server lifecycle ------------------------------------------------

let baseDir: string;
let listening: ListeningServer;
let origin: string;

async function startServer(
  responses: AssistantTurnResult[],
  hubOpts?: Omit<SessionHubOptions, "store" | "deps">
): Promise<void> {
  baseDir = await mkdtemp(join(tmpdir(), "iknow-http-"));
  const store = new SessionStore(baseDir);
  const hub = new SessionHub({
    store,
    deps: makeDeps(responses),
    ...hubOpts,
  });
  listening = await listenSessionServer({ hub, host: "127.0.0.1", port: 0 });
  origin = `http://${listening.host}:${listening.port}`;
}

beforeEach(async () => {
  await startServer([
    assistantResult({ texts: ["hello"] }),
    assistantResult({ texts: ["second answer"] }),
  ]);
});

afterEach(async () => {
  await listening.close();
  await rm(baseDir, { recursive: true, force: true });
});

// -- helpers ------------------------------------------------------------------

async function getJson(
  path: string
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${origin}${path}`);
  const body = await res.json();
  return { status: res.status, body };
}

async function postJson(opts: {
  readonly path: string;
  readonly payload: unknown;
}): Promise<{ status: number; body: unknown }> {
  const { path, payload } = opts;
  const res = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: payload === undefined ? "" : JSON.stringify(payload),
  });
  const body = await res.json();
  return { status: res.status, body };
}

function assertNestedError(opts: {
  readonly body: unknown;
  readonly kind: string;
}): void {
  const { body, kind } = opts;
  const b = body as {
    error?: {
      kind?: string;
      message?: string;
      field?: string;
      conversation_id?: string;
    };
  };
  assert.ok(b.error, "body must have top-level `error` object");
  assert.equal(b.error!.kind, kind);
  assert.equal(typeof b.error!.message, "string");
  assert.ok(b.error!.message.length > 0, "message must be non-empty");
}

async function createSession(): Promise<string> {
  const { status, body } = await postJson({
    path: "/api/v1/sessions",
    payload: {},
  });
  assert.equal(status, 201);
  return (body as { session: { conversation_id: string } }).session
    .conversation_id;
}

/** 以指定 listen 选项（model / permissionMode）重启服务器。 */
async function restartWithOptions(
  opts: Pick<SessionHttpServerOptions, "model" | "permissionMode">
): Promise<void> {
  await listening.close();
  await rm(baseDir, { recursive: true, force: true });
  baseDir = await mkdtemp(join(tmpdir(), "iknow-http-restart-"));
  const store = new SessionStore(baseDir);
  const hub = new SessionHub({
    store,
    deps: makeDeps([assistantResult({ texts: ["x"] })]),
  });
  listening = await listenSessionServer({
    hub,
    host: "127.0.0.1",
    port: 0,
    ...opts,
  });
  origin = `http://${listening.host}:${listening.port}`;
}

// -- endpoint 1: health -------------------------------------------------------

describe("GET /api/v1/health", () => {
  it("returns 200 with service + version + contextWindow", async () => {
    const { status, body } = await getJson("/api/v1/health");
    assert.equal(status, 200);
    const b = body as {
      ok: boolean;
      service: string;
      version: string;
      contextWindow: number;
    };
    assert.equal(b.ok, true);
    assert.equal(b.service, "iknow-session-api");
    assert.equal(typeof b.version, "string");
    // contextWindow: positive integer (default 200_000 unless env overridden).
    assert.equal(typeof b.contextWindow, "number");
    assert.ok(Number.isInteger(b.contextWindow));
    assert.ok(b.contextWindow > 0);
  });

  it("respects listenSessionServer contextWindow override", async () => {
    // Stop the default server, restart with an override, assert.
    await listening.close();
    await rm(baseDir, { recursive: true, force: true });
    baseDir = await mkdtemp(join(tmpdir(), "iknow-http-cw-"));
    const store = new SessionStore(baseDir);
    const hub = new SessionHub({
      store,
      deps: makeDeps([assistantResult({ texts: ["x"] })]),
    });
    listening = await listenSessionServer({
      hub,
      host: "127.0.0.1",
      port: 0,
      contextWindow: 128_000,
    });
    origin = `http://${listening.host}:${listening.port}`;
    const { body } = await getJson("/api/v1/health");
    const b = body as { contextWindow: number };
    assert.equal(b.contextWindow, 128_000);
  });

  it("health 带 model 选项时透传模型名", async () => {
    await restartWithOptions({ model: "some-model-route-id" });
    const { body } = await getJson("/api/v1/health");
    assert.equal((body as { model?: string }).model, "some-model-route-id");
  });

  it("health 无 model 选项时字段缺席（byte-stable）", async () => {
    const { body } = await getJson("/api/v1/health");
    assert.equal("model" in (body as Record<string, unknown>), false);
  });
});

// -- endpoint: permission mode -------------------------------------------------

describe("GET/POST /api/v1/permission-mode", () => {
  it("holder 缺席 → GET/POST 均 404", async () => {
    await restartWithOptions({});
    const got = await getJson("/api/v1/permission-mode");
    assert.equal(got.status, 404);
    const posted = await postJson({
      path: "/api/v1/permission-mode",
      payload: {},
    });
    assert.equal(posted.status, 404);
  });

  it("GET 返回当前 mode；POST 循环 default → full_auto → default", async () => {
    const ctx = createPermissionModeContext("default");
    await restartWithOptions({ permissionMode: ctx });
    const g1 = await getJson("/api/v1/permission-mode");
    assert.equal(g1.status, 200);
    assert.deepEqual(g1.body, { mode: "default" });

    const p1 = await postJson({ path: "/api/v1/permission-mode", payload: {} });
    assert.deepEqual(p1.body, { mode: "full_auto" });
    assert.equal(ctx.get(), "full_auto"); // holder 与响应一致（运行时生效）

    const p2 = await postJson({ path: "/api/v1/permission-mode", payload: {} });
    assert.deepEqual(p2.body, { mode: "default" });
    assert.equal(ctx.get(), "default");
  });

  it("POST 从 plan → full_auto（plan 不是循环目标，SSOT nextShiftTabMode）", async () => {
    const ctx = createPermissionModeContext("plan");
    await restartWithOptions({ permissionMode: ctx });
    const p = await postJson({ path: "/api/v1/permission-mode", payload: {} });
    assert.deepEqual(p.body, { mode: "full_auto" });
  });

  it("POST 空 body（无 Content-Type）也正常消费", async () => {
    const ctx = createPermissionModeContext("default");
    await restartWithOptions({ permissionMode: ctx });
    const res = await fetch(`${origin}/api/v1/permission-mode`, {
      method: "POST",
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { mode: "full_auto" });
  });
});

// -- endpoint 2: create session ----------------------------------------------

describe("POST /api/v1/sessions", () => {
  it("returns 201 with session + empty turns", async () => {
    const { status, body } = await postJson({
      path: "/api/v1/sessions",
      payload: {
        json_mode: false,
      },
    });
    assert.equal(status, 201);
    const b = body as {
      session: { conversation_id: string; mode: string; turn_count: number };
      turns: unknown[];
    };
    assert.equal(typeof b.session.conversation_id, "string");
    assert.ok(b.session.conversation_id.length > 0);
    assert.equal(b.session.turn_count, 0);
    assert.deepEqual(b.turns, []);
  });

  it("returns 400 validation for non-object body", async () => {
    const res = await fetch(`${origin}/api/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "[1,2,3]",
    });
    const body = await res.json();
    assert.equal(res.status, 400);
    assertNestedError({ body, kind: "validation" });
  });
});

// -- endpoint 3: GET /api/v1/sessions (list, new in T5) -----------------------

describe("GET /api/v1/sessions", () => {
  it("returns 200 with { sessions: [...] } for sessions that have a reply", async () => {
    const id = await createSession();
    // A session only appears in the list once it has an assistant reply
    // (issue #96) — post a message so the stub model records one.
    const posted = await postJson({
      path: `/api/v1/sessions/${id}/messages`,
      payload: { text: "hi" },
    });
    assert.equal(posted.status, 200);
    const { status, body } = await getJson("/api/v1/sessions");
    assert.equal(status, 200);
    const b = body as {
      sessions: Array<{ conversation_id: string; summary?: string }>;
    };
    assert.ok(Array.isArray(b.sessions));
    assert.ok(
      b.sessions.some((s) => s.conversation_id === id && s.summary === "hi"),
      "list must include the session that has a reply"
    );
  });

  it("excludes a freshly created session with no reply (issue #96)", async () => {
    const id = await createSession();
    const { status, body } = await getJson("/api/v1/sessions");
    assert.equal(status, 200);
    const b = body as {
      sessions: Array<{ conversation_id: string; summary?: string }>;
    };
    assert.ok(
      !b.sessions.some((s) => s.conversation_id === id),
      "empty session must not be listed"
    );
  });

  it("body shape is { sessions: [...] }, not a GetSessionResponse", async () => {
    const { status, body } = await getJson("/api/v1/sessions");
    assert.equal(status, 200);
    assert.ok("sessions" in (body as Record<string, unknown>));
  });
});

// -- endpoint 4: GET /api/v1/sessions/:id (projected turns) -------------------

describe("GET /api/v1/sessions/:id", () => {
  it("returns 200 with projected TurnDto after postMessage", async () => {
    const id = await createSession();
    const posted = await postJson({
      path: `/api/v1/sessions/${id}/messages`,
      payload: {
        text: "what time is it?",
      },
    });
    assert.equal(posted.status, 200);

    const { status, body } = await getJson(`/api/v1/sessions/${id}`);
    assert.equal(status, 200);
    const b = body as {
      session: { conversation_id: string; turn_count: number };
      turns: Array<{
        query: string;
        answer: { finalText: string; stopReason: string; turnCount: number };
      }>;
    };
    assert.equal(b.session.conversation_id, id);
    assert.equal(b.session.turn_count, 1);
    // Projected turn: query + answer.finalText (NOT raw messages)
    assert.equal(b.turns.length, 1);
    assert.equal(b.turns[0]!.query, "what time is it?");
    assert.equal(b.turns[0]!.answer.finalText, "hello");
    assert.equal(b.turns[0]!.answer.stopReason, "completed");
    // Projection must not leak raw AnthropicNativeMessage / content blocks
    const rawTurn = b.turns[0] as unknown as Record<string, unknown>;
    assert.equal(rawTurn["messages"], undefined, "must not leak raw messages");
    assert.equal(
      rawTurn["content"],
      undefined,
      "must not leak raw content blocks"
    );
  });

  it("returns 404 not_found for missing session (nested shape)", async () => {
    const { status, body } = await getJson(
      "/api/v1/sessions/does-not-exist-id"
    );
    assert.equal(status, 404);
    assertNestedError({ body, kind: "not_found" });
    const b = body as { error: { conversation_id?: string } };
    assert.equal(b.error.conversation_id, "does-not-exist-id");
  });
});

// -- endpoint 5: POST /api/v1/sessions/:id/messages ---------------------------

describe("POST /api/v1/sessions/:id/messages", () => {
  it("returns 200 with PostMessageResponse { session, turn }", async () => {
    const id = await createSession();
    const { status, body } = await postJson({
      path: `/api/v1/sessions/${id}/messages`,
      payload: {
        text: "hi",
      },
    });
    assert.equal(status, 200);
    const b = body as {
      session: { conversation_id: string; turn_count: number };
      turn: {
        query: string;
        answer: { finalText: string; stopReason: string; turnCount: number };
      };
    };
    assert.equal(b.session.conversation_id, id);
    assert.equal(b.session.turn_count, 1);
    assert.equal(b.turn.query, "hi");
    assert.equal(b.turn.answer.finalText, "hello");
    assert.equal(b.turn.answer.stopReason, "completed");
    assert.equal(b.turn.answer.turnCount, 1);
  });

  it("returns 400 validation for empty text (nested shape)", async () => {
    const id = await createSession();
    const { status, body } = await postJson({
      path: `/api/v1/sessions/${id}/messages`,
      payload: {
        text: "   ",
      },
    });
    assert.equal(status, 400);
    assertNestedError({ body, kind: "validation" });
    const b = body as { error: { field?: string } };
    assert.equal(b.error.field, "text");
  });
});

// -- T2: POST /messages thinking override validation -------------------------

describe("POST /api/v1/sessions/:id/messages — thinking override (T2)", () => {
  // Invalid override values are rejected at the HTTP layer before the hub
  // runs; no LLM endpoint is involved for these 400 tests.

  it("valid thinking override {mode:'adaptive',effort:'high'} → 200", async () => {
    // Restart with an overrideEnv backed by a capture server so the override
    // path's real adapter can complete a turn.
    await listening.close();
    await rm(baseDir, { recursive: true, force: true });

    const overrideReplyBody = {
      id: "msg_http_capture",
      type: "message",
      role: "assistant",
      model: "m",
      content: [{ type: "text", text: "override ok" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    let capture: LlmCapture | undefined;
    try {
      capture = await startLlmCapture(overrideReplyBody);
      await startServer([], {
        overrideEnv: makeTestLlmEnv({ baseUrl: capture.origin }),
      });
      const id = await createSession();
      const { status, body } = await postJson({
        path: `/api/v1/sessions/${id}/messages`,
        payload: {
          text: "think hard",
          thinking: { mode: "adaptive", effort: "high" },
        },
      });
      assert.equal(status, 200);
      const b = body as {
        turn: { answer: { finalText: string; stopReason: string } };
      };
      assert.equal(b.turn.answer.finalText, "override ok");
      assert.equal(b.turn.answer.stopReason, "completed");
      // The captured LLM request carries the override params.
      assert.equal(capture.bodies.length, 1);
      const req = capture.bodies[0] as Record<string, unknown>;
      assert.deepEqual(req.thinking, { type: "adaptive" });
      assert.deepEqual(req.output_config, { effort: "high" });
    } finally {
      if (capture) await capture.close();
    }
  });

  it("invalid thinking.mode → 400 validation envelope", async () => {
    const id = await createSession();
    const { status, body } = await postJson({
      path: `/api/v1/sessions/${id}/messages`,
      payload: {
        text: "hi",
        thinking: { mode: "loud" },
      },
    });
    assert.equal(status, 400);
    assertNestedError({ body, kind: "validation" });
    const b = body as { error: { field?: string; message: string } };
    assert.equal(b.error.field, "thinking.mode");
    assert.ok(b.error.message.includes("off"));
    assert.ok(b.error.message.includes("adaptive"));
  });

  it("invalid thinking.effort → 400 validation envelope", async () => {
    const id = await createSession();
    const { status, body } = await postJson({
      path: `/api/v1/sessions/${id}/messages`,
      payload: {
        text: "hi",
        thinking: { mode: "adaptive", effort: "extreme" },
      },
    });
    assert.equal(status, 400);
    assertNestedError({ body, kind: "validation" });
    const b = body as { error: { field?: string } };
    assert.equal(b.error.field, "thinking.effort");
  });

  it("thinking as non-object (string) → 400 validation envelope", async () => {
    const id = await createSession();
    const { status, body } = await postJson({
      path: `/api/v1/sessions/${id}/messages`,
      payload: {
        text: "hi",
        thinking: "off",
      },
    });
    assert.equal(status, 400);
    assertNestedError({ body, kind: "validation" });
  });

  it("no thinking field → 200, behavior unchanged (no thinking/toolCalls keys)", async () => {
    const id = await createSession();
    const { status, body } = await postJson({
      path: `/api/v1/sessions/${id}/messages`,
      payload: {
        text: "hi",
      },
    });
    assert.equal(status, 200);
    const b = body as {
      turn: { answer: Record<string, unknown> };
    };
    assert.equal(b.turn.answer.finalText, "hello");
    assert.equal("thinking" in b.turn.answer, false);
    assert.equal("toolCalls" in b.turn.answer, false);
  });
});

// -- endpoint 6: POST /api/v1/sessions/:id/reset -----------------------------

describe("POST /api/v1/sessions/:id/reset", () => {
  it("returns 200 with cleared session", async () => {
    const id = await createSession();
    await postJson({
      path: `/api/v1/sessions/${id}/messages`,
      payload: { text: "msg" },
    });

    const { status, body } = await postJson({
      path: `/api/v1/sessions/${id}/reset`,
      payload: {},
    });
    assert.equal(status, 200);
    const b = body as {
      session: { conversation_id: string; turn_count: number };
      turns: unknown[];
    };
    assert.equal(b.session.conversation_id, id);
    assert.equal(b.session.turn_count, 0);
    assert.deepEqual(b.turns, []);
  });
});

// -- endpoint 6b: POST /api/v1/sessions/:id/compact --------------------------

describe("POST /api/v1/sessions/:id/compact", () => {
  it("空 body → 200；短会话 → compacted=false（幂等 no-op）", async () => {
    const id = await createSession();
    await postJson({
      path: `/api/v1/sessions/${id}/messages`,
      payload: { text: "msg" },
    });

    const { status, body } = await postJson({
      path: `/api/v1/sessions/${id}/compact`,
      payload: {},
    });
    assert.equal(status, 200);
    const b = body as {
      session: { conversation_id: string; turn_count: number };
      compacted: boolean;
      beforeCount: number;
      afterCount: number;
    };
    assert.equal(b.session.conversation_id, id);
    assert.equal(b.compacted, false);
    assert.equal(b.beforeCount, b.afterCount);
  });

  it("missing session → 404 not_found（nested ApiErrorBody）", async () => {
    const { status, body } = await postJson({
      path: "/api/v1/sessions/does-not-exist/compact",
      payload: {},
    });
    assert.equal(status, 404);
    assertNestedError({ body, kind: "not_found" });
  });
});

// -- endpoint 7: POST /api/v1/sessions/:id/commands (REMOVED) ----------------

describe("POST /api/v1/sessions/:id/commands (removed in T5)", () => {
  it("returns 404 not_found (route physically deleted)", async () => {
    const id = await createSession();
    const { status, body } = await postJson({
      path: `/api/v1/sessions/${id}/commands`,
      payload: {
        command: "help",
      },
    });
    assert.equal(status, 404);
    assertNestedError({ body, kind: "not_found" });
  });
});

// -- error shape (cross-cutting) ---------------------------------------------

describe("nested ApiErrorBody shape", () => {
  it("404 fallback for unknown route uses nested shape", async () => {
    const { status, body } = await getJson("/api/v1/totally/unknown");
    assert.equal(status, 404);
    assertNestedError({ body, kind: "not_found" });
  });
});

// -- SSE reserved route (SC21 coverage) --------------------------------------

describe("GET /api/v1/sessions/:id/events — SSE reserved", () => {
  it("returns 501 with nested internal error", async () => {
    const id = await createSession();
    const { status, body } = await getJson(`/api/v1/sessions/${id}/events`);
    assert.equal(status, 501);
    assertNestedError({ body, kind: "internal" });
    const b = body as { error: { message: string } };
    assert.ok(b.error.message.toLowerCase().includes("sse"));
  });

  it("501 even for a nonexistent session id (route matched before hub)", async () => {
    const { status } = await getJson("/api/v1/sessions/nope-id/events");
    assert.equal(status, 501);
  });
});

// -- parseCreateBody edge cases (SC21 coverage) ------------------------------

describe("POST /api/v1/sessions — parseCreateBody edges", () => {
  it("empty body → 201 (defaults)", async () => {
    const res = await fetch(`${origin}/api/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "",
    });
    assert.equal(res.status, 201);
  });

  it("json_mode boolean is coerced and applied to the session", async () => {
    const { status, body } = await postJson({
      path: "/api/v1/sessions",
      payload: {
        json_mode: true,
      },
    });
    assert.equal(status, 201);
    const b = body as { session: { json_mode: boolean } };
    assert.equal(b.session.json_mode, true);
  });

  it("invalid JSON body → 400 validation", async () => {
    const res = await fetch(`${origin}/api/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not-json",
    });
    const body = await res.json();
    assert.equal(res.status, 400);
    assertNestedError({ body, kind: "validation" });
  });

  it("oversized body (>256KB) → 400 validation", async () => {
    const big = "x".repeat(300 * 1024);
    const res = await fetch(`${origin}/api/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pad: big }),
    });
    const body = await res.json();
    assert.equal(res.status, 400);
    assertNestedError({ body, kind: "validation" });
  });
});

// -- static file serving + SPA fallback (SC21 coverage) ----------------------

describe("static file serving", () => {
  it("serves index.html, assets, SPA fallback, traversal 403, unknown MIME", async () => {
    const staticRoot = await mkdtemp(join(tmpdir(), "iknow-webroot-"));
    let staticServer: ListeningServer | undefined;
    try {
      await writeFile(
        join(staticRoot, "index.html"),
        "<!doctype html><title>iknow</title>",
        "utf8"
      );
      await writeFile(join(staticRoot, "app.js"), "console.log('hi');", "utf8");
      const store = new SessionStore(
        await mkdtemp(join(tmpdir(), "iknow-srv-"))
      );
      const hub = new SessionHub({ store, deps: makeDeps([]) });
      staticServer = await listenSessionServer({
        hub,
        host: "127.0.0.1",
        port: 0,
        webRoot: staticRoot,
      });
      const staticOrigin = `http://${staticServer.host}:${staticServer.port}`;

      // GET / → index.html
      const root = await fetch(`${staticOrigin}/`);
      assert.equal(root.status, 200);
      assert.ok((await root.text()).includes("<title>iknow</title>"));
      assert.ok((root.headers.get("content-type") ?? "").includes("text/html"));

      // GET /app.js → asset MIME
      const asset = await fetch(`${staticOrigin}/app.js`);
      assert.equal(asset.status, 200);
      assert.ok((await asset.text()).includes("console.log"));
      assert.ok(
        (asset.headers.get("content-type") ?? "").includes("text/javascript")
      );

      // SPA fallback: unknown non-/api → index.html
      const spa = await fetch(`${staticOrigin}/some/spa/route`);
      assert.equal(spa.status, 200);
      assert.ok((await spa.text()).includes("<title>iknow</title>"));

      // Path traversal: both undici's fetch and the server-side `new URL()`
      // normalize `%2e%2e` / `..` segments before tryServeStatic runs, so the
      // 403 guard (http.ts:285-289) is defense-in-depth unreachable via HTTP.
      // We assert the safe outcome instead: a traversal attempt collapses to
      // a path inside webRoot and falls back to SPA index.html (200), never
      // leaking a file outside webRoot.
      const trav = await fetch(`${staticOrigin}/%2e%2e/secret`);
      assert.equal(trav.status, 200);
      const travText = await trav.text();
      assert.ok(travText.includes("<title>iknow</title>"));

      // Unknown extension → application/octet-stream
      await writeFile(join(staticRoot, "blob.bin"), "binary", "utf8");
      const bin = await fetch(`${staticOrigin}/blob.bin`);
      assert.equal(bin.status, 200);
      assert.ok(
        (bin.headers.get("content-type") ?? "").includes(
          "application/octet-stream"
        )
      );
    } finally {
      if (staticServer) await staticServer.close();
      await rm(staticRoot, { recursive: true, force: true });
    }
  });
});

// -- resolveDefaultWebRoot (SC21 coverage) -----------------------------------

describe("resolveDefaultWebRoot", () => {
  it("returns an absolute path ending in web/dist or web", () => {
    const root = resolveDefaultWebRoot();
    assert.ok(root.length > 0);
    // Normalize separators so the assertion works on Windows (\) and POSIX (/).
    const norm = root.replace(/\\/g, "/");
    // In this repo web/dist exists (built), so dist wins; guard both shapes.
    assert.ok(
      norm.endsWith("web/dist") || norm.endsWith("web"),
      `unexpected webRoot: ${root}`
    );
  });
});
