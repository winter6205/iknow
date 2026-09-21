/**
 * The serve entry's `/graph` equivalent.
 *
 * serve has neither a keyboard nor a command line, so the carrier for
 * `/graph on|off|status` is `POST /api/v1/graph-mode`: the wire carries the
 * already-split args array, and semantics plus wording go through the same
 * `applyGraphCommand` in `harness/graph/mode.ts` — one value domain across
 * all three entries. The holder is the same instance the hub uses, so the
 * flip only enters assembly on the next postMessage (round semantics are
 * guarded by hub-side tests).
 *
 * Missing holder → both endpoints 404 (same pattern as an unmounted
 * permission-mode).
 */
import { afterEach, describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionHub } from "../../src/session-api/hub.ts";
import { SessionStore } from "../../src/session-api/store/index.ts";
import {
  listenSessionServer,
  type ListeningServer,
} from "../../src/session-api/http.ts";
import {
  createGraphModeContext,
  type GraphModeContext,
} from "../../src/harness/graph/mode.ts";
import { assistantResult, makeDeps } from "../cli/_fixtures.ts";

let listening: ListeningServer | undefined;
let baseDir: string | undefined;

afterEach(async () => {
  if (listening) await listening.close();
  listening = undefined;
  if (baseDir) await rm(baseDir, { recursive: true, force: true });
  baseDir = undefined;
});

async function start(graphMode?: GraphModeContext): Promise<string> {
  baseDir = await mkdtemp(join(tmpdir(), "iknow-graph-route-"));
  const hub = new SessionHub({
    store: new SessionStore(baseDir, process.cwd()),
    deps: makeDeps([assistantResult({ texts: ["ok"] })]),
    ...(graphMode ? { graphMode } : {}),
  });
  listening = await listenSessionServer({
    hub,
    host: "127.0.0.1",
    port: 0,
    ...(graphMode ? { graphMode } : {}),
  });
  return `http://${listening.host}:${listening.port}`;
}

async function post(
  origin: string,
  payload: unknown
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${origin}/api/v1/graph-mode`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: payload === undefined ? "" : JSON.stringify(payload),
  });
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
  };
}

describe("GET/POST /api/v1/graph-mode", () => {
  it("GET 读当前状态；POST on|off 翻同一 holder 并回一行文案", async () => {
    const graphMode = createGraphModeContext();
    const origin = await start(graphMode);

    const got = await fetch(`${origin}/api/v1/graph-mode`);
    assert.equal(got.status, 200);
    const initial = (await got.json()) as Record<string, unknown>;
    assert.equal(initial["enabled"], false);
    assert.equal(typeof initial["message"], "string");

    const on = await post(origin, { args: ["on"] });
    assert.equal(on.status, 200);
    assert.equal(on.body["enabled"], true);
    assert.match(String(on.body["message"]), /on/);
    // Same holder: what HTTP flips is exactly what the hub reads.
    assert.equal(graphMode.get().enabled, true);

    const off = await post(origin, { args: ["off"] });
    assert.equal(off.body["enabled"], false);
    assert.equal(graphMode.get().enabled, false);
  });

  it("空 body / status → 只回状态，不改 holder", async () => {
    const graphMode = createGraphModeContext({ enabled: true });
    const origin = await start(graphMode);

    const empty = await post(origin, {});
    assert.equal(empty.status, 200);
    assert.equal(empty.body["enabled"], true);
    assert.equal(graphMode.get().enabled, true);

    const status = await post(origin, { args: ["status"] });
    assert.equal(status.body["enabled"], true);
    assert.equal(graphMode.get().enabled, true);
  });

  it("非法 args → 400 validation + usage，不改 holder", async () => {
    const graphMode = createGraphModeContext();
    const origin = await start(graphMode);

    const bad = await post(origin, { args: ["maybe"] });
    assert.equal(bad.status, 400);
    const err = bad.body["error"] as { kind?: string; message?: string };
    assert.equal(err.kind, "validation");
    assert.match(String(err.message), /Usage: \/graph/);
    assert.equal(graphMode.get().enabled, false);

    const notArray = await post(origin, { args: "on" });
    assert.equal(notArray.status, 400);
    assert.equal(graphMode.get().enabled, false);
  });

  it("holder 缺席（未接 overlay）→ GET / POST 都 404", async () => {
    const origin = await start(undefined);
    const got = await fetch(`${origin}/api/v1/graph-mode`);
    assert.equal(got.status, 404);
    const posted = await post(origin, { args: ["on"] });
    assert.equal(posted.status, 404);
  });
});
