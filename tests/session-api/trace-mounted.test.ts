/**
 * ADR-0020 (plan T3): `iknow serve` MOUNTS the trace read API (inverts the
 * retired #183 guard `trace-mount-removed.test.ts`). Mounted surface:
 *   GET /api/v1/traces            → 200 records envelope
 *   GET /api/v1/traces/sessions   → 200 session list (ADR-0020 D1.1 rename)
 *   GET /api/v1/health            → 200 (session-api health unchanged)
 *   GET /api/v1/sessions          → chat sessions route NOT regressed
 *   GET /trace + /trace/*         → trace.html SPA (stripPrefix mount)
 *   GET /                         → index.html NOT regressed
 *
 * 5 boundary classes (plan §T3 acceptance, new cases):
 *   - concurrent: /api/v1/traces + /trace 并发各自 200
 *   - exception: traceDir 指向普通文件 → TraceReadError → 500 信封
 *     `trace file read failed`（wire 无 fs 路径/errno）；
 *     POST /api/v1/traces → 404（router 只接 GET，static 层拒 /api）
 */
import { afterEach, beforeEach, describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionHub } from "../../src/session-api/hub.ts";
import {
  listenSessionServer,
  type ListeningServer,
} from "../../src/session-api/http.ts";
import { SessionStore } from "../../src/session-api/store/index.ts";
import { makeDeps } from "../cli/_fixtures.ts";

let baseDir: string;
let traceDir: string;
let listening: ListeningServer;
let origin: string;

/** 写一个单会话 trace 目录（v2 每会话一文件）。 */
async function writeSession(dir: string, convId: string): Promise<void> {
  await writeFile(
    join(dir, `${convId}.jsonl`),
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

beforeEach(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "iknow-trace-mounted-"));
  traceDir = await mkdtemp(join(tmpdir(), "iknow-trace-mounted-trace-"));
  await writeSession(traceDir, "c1");
  const store = new SessionStore(baseDir, process.cwd());
  const hub = new SessionHub({ store, deps: makeDeps([]) });
  listening = await listenSessionServer({
    hub,
    host: "127.0.0.1",
    port: 0,
    trace: { traceDir },
  });
  origin = `http://${listening.host}:${listening.port}`;
});

afterEach(async () => {
  await listening.close();
  await rm(baseDir, { recursive: true, force: true });
  await rm(traceDir, { recursive: true, force: true });
});

describe("GET /api/v1/traces on session server (ADR-0020 mounted)", () => {
  it("returns 200 with the records envelope", async () => {
    const res = await fetch(`${origin}/api/v1/traces`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      records: Array<{ conversation_id: string }>;
      total: number;
    };
    assert.ok(Array.isArray(body.records));
    assert.equal(body.total, 1);
    assert.equal(body.records[0]!.conversation_id, "c1");
  });

  it("returns 200 fields table for /api/v1/traces/fields", async () => {
    const res = await fetch(`${origin}/api/v1/traces/fields`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { fields: unknown[] };
    assert.ok(Array.isArray(body.fields));
    assert.ok(body.fields.length > 0);
  });

  it("returns 200 session list at /api/v1/traces/sessions (D1.1 rename)", async () => {
    const res = await fetch(`${origin}/api/v1/traces/sessions`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      sessions: Array<{ conversation_id: string }>;
    };
    assert.deepEqual(
      body.sessions.map((s) => s.conversation_id),
      ["c1"]
    );
  });

  it("session server still serves /api/v1/health", async () => {
    const res = await fetch(`${origin}/api/v1/health`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { service: string };
    assert.equal(body.service, "iknow-session-api");
  });

  it("chat GET /api/v1/sessions is NOT regressed (distinct from trace sessions)", async () => {
    const res = await fetch(`${origin}/api/v1/sessions`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { sessions: unknown[] };
    // chat session list comes from the SessionStore (empty here), not the
    // trace dir — proves the two routes are not conflated.
    assert.deepEqual(body.sessions, []);
  });

  it("POST /api/v1/traces → 404 (router accepts GET only)", async () => {
    const res = await fetch(`${origin}/api/v1/traces`, { method: "POST" });
    assert.equal(res.status, 404);
  });

  it("concurrent /api/v1/traces + /trace SPA both succeed", async () => {
    const [apiRes, spaRes] = await Promise.all([
      fetch(`${origin}/api/v1/traces`),
      fetch(`${origin}/trace`),
    ]);
    assert.equal(apiRes.status, 200);
    assert.equal(spaRes.status, 200);
  });
});

describe("mounted trace error envelope (exception class)", () => {
  it("traceDir pointing at a regular file → 500 without fs detail leak", async () => {
    const badTrace = join(
      await mkdtemp(join(tmpdir(), "iknow-trace-bad-")),
      "not-a-dir.jsonl"
    );
    await writeFile(badTrace, "{}\n", "utf8");
    const store = new SessionStore(
      await mkdtemp(join(tmpdir(), "iknow-trace-bad-store-")),
      process.cwd()
    );
    const hub = new SessionHub({ store, deps: makeDeps([]) });
    const bad = await listenSessionServer({
      hub,
      host: "127.0.0.1",
      port: 0,
      trace: { traceDir: badTrace },
    });
    try {
      const res = await fetch(`http://${bad.host}:${bad.port}/api/v1/traces`);
      assert.equal(res.status, 500);
      const body = (await res.json()) as {
        error: { kind: string; message: string };
      };
      assert.equal(body.error.kind, "internal");
      assert.equal(body.error.message, "trace file read failed");
      // no fs detail leak: neither the path nor errno reaches the wire
      assert.ok(!body.error.message.includes(badTrace));
      assert.ok(!body.error.message.includes("ENOTDIR"));
    } finally {
      await bad.close();
    }
  });
});

describe("mounted /trace SPA (stripPrefix static mount)", () => {
  let spaServer: ListeningServer;
  let spaOrigin: string;
  let webRoot: string;

  beforeEach(async () => {
    webRoot = await mkdtemp(join(tmpdir(), "iknow-trace-spa-"));
    await writeFile(
      join(webRoot, "index.html"),
      "<!doctype html><title>chat</title>",
      "utf8"
    );
    await writeFile(
      join(webRoot, "trace.html"),
      "<!doctype html><title>trace</title>",
      "utf8"
    );
    const store = new SessionStore(
      await mkdtemp(join(tmpdir(), "iknow-trace-spa-store-")),
      process.cwd()
    );
    const hub = new SessionHub({ store, deps: makeDeps([]) });
    spaServer = await listenSessionServer({
      hub,
      host: "127.0.0.1",
      port: 0,
      webRoot,
      trace: { traceDir },
    });
    spaOrigin = `http://${spaServer.host}:${spaServer.port}`;
  });

  afterEach(async () => {
    await spaServer.close();
    await rm(webRoot, { recursive: true, force: true });
  });

  it("GET /trace → trace.html 200 text/html", async () => {
    const res = await fetch(`${spaOrigin}/trace`);
    assert.equal(res.status, 200);
    assert.ok((res.headers.get("content-type") ?? "").includes("text/html"));
    assert.ok((await res.text()).includes("<title>trace</title>"));
  });

  it("GET /trace/deep/link → SPA fallback to trace.html", async () => {
    const res = await fetch(`${spaOrigin}/trace/deep/link`);
    assert.equal(res.status, 200);
    assert.ok((await res.text()).includes("<title>trace</title>"));
  });

  it("GET / still serves index.html (chat root not regressed)", async () => {
    const res = await fetch(`${spaOrigin}/`);
    assert.equal(res.status, 200);
    assert.ok((await res.text()).includes("<title>chat</title>"));
  });

  it("GET /some/spa/route still falls back to index.html (chat SPA scope)", async () => {
    const res = await fetch(`${spaOrigin}/some/spa/route`);
    assert.equal(res.status, 200);
    assert.ok((await res.text()).includes("<title>chat</title>"));
  });
});
