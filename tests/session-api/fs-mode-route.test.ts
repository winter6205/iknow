/**
 * ADR-0092 — the serve entry's `/config` equivalent.
 *
 * serve has neither keyboard nor command line, so the carrier for
 * `/config [status|fs global|fs workspace]` is `GET/POST /api/v1/fs-mode`:
 * the wire carries a pre-split args array, and semantics plus wording go
 * through the same `applyFsModeCommand` in `harness/sandbox/fs-mode.ts` —
 * one value domain across all three entries. The holder is the same
 * instance the hub uses, so the next assembly after a flip sees the new
 * mode (round semantics are guarded by hub-side tests).
 *
 * Missing holder → both endpoints 404 (same pattern as unmounted
 * graph-mode / permission-mode). This file mirrors
 * `graph-mode-route.test.ts` (mirror discipline).
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
  createFsModeContext,
  type FsModeContext,
} from "../../src/harness/sandbox/fs-mode.ts";
import { assistantResult, makeDeps } from "../cli/_fixtures.ts";

let listening: ListeningServer | undefined;
let baseDir: string | undefined;

afterEach(async () => {
  if (listening) await listening.close();
  listening = undefined;
  if (baseDir) await rm(baseDir, { recursive: true, force: true });
  baseDir = undefined;
});

async function start(fsMode?: FsModeContext): Promise<string> {
  baseDir = await mkdtemp(join(tmpdir(), "iknow-fs-route-"));
  const hub = new SessionHub({
    store: new SessionStore(baseDir, process.cwd()),
    deps: makeDeps([assistantResult({ texts: ["ok"] })]),
    ...(fsMode ? { fsMode } : {}),
  });
  listening = await listenSessionServer({
    hub,
    host: "127.0.0.1",
    port: 0,
    ...(fsMode ? { fsMode } : {}),
  });
  return `http://${listening.host}:${listening.port}`;
}

async function post(
  origin: string,
  payload: unknown
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${origin}/api/v1/fs-mode`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: payload === undefined ? "" : JSON.stringify(payload),
  });
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
  };
}

describe("GET/POST /api/v1/fs-mode", () => {
  it("GET 读当前档；POST fs workspace|fs global 翻同一 holder 并回一行文案", async () => {
    const fsMode = createFsModeContext();
    const origin = await start(fsMode);

    const got = await fetch(`${origin}/api/v1/fs-mode`);
    assert.equal(got.status, 200);
    const initial = (await got.json()) as Record<string, unknown>;
    assert.equal(initial["mode"], "global");
    assert.equal(typeof initial["message"], "string");

    const toWorkspace = await post(origin, { args: ["fs", "workspace"] });
    assert.equal(toWorkspace.status, 200);
    assert.equal(toWorkspace.body["mode"], "workspace");
    assert.match(String(toWorkspace.body["message"]), /已切换/);
    // Same holder: what HTTP flips is exactly the instance the hub reads.
    assert.equal(fsMode.get(), "workspace");

    const toGlobal = await post(origin, { args: ["fs", "global"] });
    assert.equal(toGlobal.body["mode"], "global");
    assert.match(String(toGlobal.body["message"]), /已切换/);
    assert.equal(fsMode.get(), "global");
  });

  it("空 body / status → 只回状态，不改 holder", async () => {
    const fsMode = createFsModeContext("workspace");
    const origin = await start(fsMode);

    const empty = await post(origin, {});
    assert.equal(empty.status, 200);
    assert.equal(empty.body["mode"], "workspace");
    assert.equal(fsMode.get(), "workspace");

    const status = await post(origin, { args: ["status"] });
    assert.equal(status.body["mode"], "workspace");
    assert.equal(fsMode.get(), "workspace");
  });

  it("非法 args → 400 validation + usage，不改 holder", async () => {
    const fsMode = createFsModeContext();
    const origin = await start(fsMode);

    const bad = await post(origin, { args: ["maybe"] });
    assert.equal(bad.status, 400);
    const err = bad.body["error"] as { kind?: string; message?: string };
    assert.equal(err.kind, "validation");
    assert.match(String(err.message), /Usage: \/config/);
    assert.equal(fsMode.get(), "global");

    const notArray = await post(origin, { args: "workspace" });
    assert.equal(notArray.status, 400);
    assert.equal(fsMode.get(), "global");
  });

  it("holder 缺席（未接 fs holder）→ GET / POST 都 404", async () => {
    const origin = await start(undefined);
    const got = await fetch(`${origin}/api/v1/fs-mode`);
    assert.equal(got.status, 404);
    const posted = await post(origin, { args: ["fs", "workspace"] });
    assert.equal(posted.status, 404);
  });

  it("非 GET/POST（如 PUT / DELETE）→ 404，且不误伤 holder", async () => {
    const fsMode = createFsModeContext("workspace");
    const origin = await start(fsMode);
    for (const method of ["PUT", "DELETE"]) {
      const res = await fetch(`${origin}/api/v1/fs-mode`, { method });
      assert.equal(res.status, 404, `${method} 必须 404`);
    }
    assert.equal(fsMode.get(), "workspace");
  });
});
