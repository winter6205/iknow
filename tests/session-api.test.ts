/**
 * Session HTTP API + hub (host surface).
 */
import { describe, it, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createSeededStore } from "../src/fixtures/seed-kb.ts";
import { createSession } from "../src/agent-loop/session.ts";
import { loadIknowEnv } from "../src/config/env.ts";
import { SessionHub } from "../src/session-api/hub.ts";
import { listenSessionServer } from "../src/session-api/http.ts";
import { MAX_MESSAGE_CHARS } from "../src/session-api/contract.ts";
import { parseArgs } from "../src/cli/parse-args.ts";
import { usageText } from "../src/cli/usage.ts";
import type { RuntimeBundle } from "../src/cli/runtime.ts";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const webDistIndex = path.join(repoRoot, "web", "dist", "index.html");

function testBundle(): RuntimeBundle {
  const store = createSeededStore();
  const env = loadIknowEnv();
  return {
    store,
    vectorIndex: undefined,
    env,
    session: createSession("employee"),
  };
}

describe("parseArgs serve", () => {
  it("parses serve with port and host", () => {
    const p = parseArgs(["serve", "--port", "9191", "--host", "0.0.0.0"]);
    assert.equal(p.command, "serve");
    assert.equal(p.port, 9191);
    assert.equal(p.host, "0.0.0.0");
  });

  it("usage mentions serve", () => {
    assert.match(usageText(), /serve/);
  });
});

describe("SessionHub", () => {
  it("create + message returns G2 snapshot_id", async () => {
    const hub = new SessionHub({
      bundle: testBundle(),
      defaultMode: "deterministic",
    });
    const created = await hub.createSession({ mode: "deterministic" });
    assert.ok(created.session.conversation_id);
    assert.equal(created.turns.length, 0);

    const msg = await hub.postMessage(
      created.session.conversation_id,
      "退款政策是什么",
    );
    assert.ok(msg.turn.answer.snapshot_id);
    assert.ok(Array.isArray(msg.turn.answer.source_spans));
    assert.ok(Array.isArray(msg.turn.answer.tool_calls));
    assert.equal(msg.session.turn_count, 1);
    assert.ok(msg.turn.human_text);
  });

  it("rejects empty and overlong messages", async () => {
    const hub = new SessionHub({ bundle: testBundle() });
    const { session } = await hub.createSession();
    await assert.rejects(
      () => hub.postMessage(session.conversation_id, "   "),
      /non-empty/,
    );
    await assert.rejects(
      () =>
        hub.postMessage(
          session.conversation_id,
          "x".repeat(MAX_MESSAGE_CHARS + 1),
        ),
      /max length/,
    );
  });

  it("unknown session is not found", async () => {
    const hub = new SessionHub({ bundle: testBundle() });
    assert.throws(() => hub.getSession("does-not-exist"), /not found/);
  });

  it("reset clears turns", async () => {
    const hub = new SessionHub({ bundle: testBundle() });
    const { session } = await hub.createSession();
    await hub.postMessage(session.conversation_id, "请假流程");
    const reset = await hub.resetSession(session.conversation_id);
    assert.equal(reset.session.turn_count, 0);
    assert.equal(reset.turns.length, 0);
  });

  it("command help and status work", async () => {
    const hub = new SessionHub({ bundle: testBundle() });
    const { session } = await hub.createSession();
    const help = await hub.postCommand(session.conversation_id, "help");
    assert.equal(help.effect, "help");
    assert.match(help.message, /status/i);
    const st = await hub.postCommand(session.conversation_id, "status");
    assert.equal(st.effect, "info");
  });

  it("concurrent create yields distinct ids", async () => {
    const hub = new SessionHub({ bundle: testBundle() });
    const batch = await Promise.all([
      hub.createSession(),
      hub.createSession(),
      hub.createSession(),
    ]);
    const ids = new Set(batch.map((b) => b.session.conversation_id));
    assert.equal(ids.size, 3);
  });
});

describe("Session HTTP server", () => {
  let close: (() => Promise<void>) | undefined;
  let base = "";

  beforeAll(async () => {
    const hub = new SessionHub({ bundle: testBundle() });
    const listening = await listenSessionServer({
      hub,
      host: "127.0.0.1",
      port: 0,
    });
    close = listening.close;
    base = `http://${listening.host}:${listening.port}`;
  });

  afterAll(async () => {
    if (close) await close();
  });

  it("health ok", async () => {
    const res = await fetch(`${base}/api/v1/health`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; service: string };
    assert.equal(body.ok, true);
    assert.equal(body.service, "iknow-session-api");
  });

  it("create session and post message via HTTP", async () => {
    const createRes = await fetch(`${base}/api/v1/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "deterministic", role: "employee" }),
    });
    assert.equal(createRes.status, 201);
    const created = (await createRes.json()) as {
      session: { conversation_id: string };
    };
    const id = created.session.conversation_id;

    const msgRes = await fetch(`${base}/api/v1/sessions/${id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "公司的退款政策" }),
    });
    assert.equal(msgRes.status, 200);
    const msg = (await msgRes.json()) as {
      turn: { answer: { snapshot_id: string } };
    };
    assert.ok(msg.turn.answer.snapshot_id);

    const emptyRes = await fetch(`${base}/api/v1/sessions/${id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "" }),
    });
    assert.equal(emptyRes.status, 400);

    const missing = await fetch(`${base}/api/v1/sessions/nope/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hi" }),
    });
    assert.equal(missing.status, 404);

    const sse = await fetch(`${base}/api/v1/sessions/${id}/events`);
    assert.equal(sse.status, 501);
  });

  it("serves web index (Vite dist when present)", async () => {
    // Soft skip when production build is absent so API tests still pass in CI
    // without a prior `npm run web:build`.
    if (!fs.existsSync(webDistIndex)) {
      assert.ok(true, "skip static index: web/dist/index.html missing");
      return;
    }
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /iknow|root|Knowledge/i);
  });
});
