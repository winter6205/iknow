/**
 * ADR-0136 §4 on the serve wire: `GET /api/v1/sessions/:id` is the
 * session-ENTRY surface, so the response's `session.recovery` carries the
 * recovery classification. No new route, no SSE channel, no export command —
 * the field rides the existing summary the web host already consumes.
 *
 * Real hub + real store + real HTTP listener on 127.0.0.1:0; the model is the
 * scripted stub.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "vitest";

import { SessionHub } from "../../src/session-api/hub.ts";
import {
  listenSessionServer,
  type ListeningServer,
} from "../../src/session-api/http.ts";
import { SessionStore } from "../../src/session-api/store/index.ts";
import { assistantResult, makeDeps } from "../cli/_fixtures.ts";

let baseDir: string;
let taskRoot: string;
let listening: ListeningServer;
let origin: string;

beforeEach(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "iknow-http-recovery-"));
  taskRoot = await mkdtemp(join(tmpdir(), "iknow-http-recovery-root-"));
  const store = new SessionStore(baseDir, taskRoot);
  const hub = new SessionHub({
    store,
    workspaceRoot: taskRoot,
    deps: makeDeps([assistantResult({ texts: ["answered"] })]),
  });
  await hub.bindWorkspace(taskRoot);
  listening = await listenSessionServer({ hub, host: "127.0.0.1", port: 0 });
  origin = `http://${listening.host}:${listening.port}`;
});

afterEach(async () => {
  await listening.close();
  await rm(baseDir, { recursive: true, force: true });
  await rm(taskRoot, { recursive: true, force: true });
});

const getJson = async (
  path: string
): Promise<{ status: number; body: Record<string, unknown> }> => {
  const res = await fetch(`${origin}${path}`);
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
  };
};

const createSession = async (): Promise<string> => {
  const res = await fetch(`${origin}/api/v1/sessions`, { method: "POST" });
  const body = (await res.json()) as {
    session: { conversation_id: string };
  };
  return body.session.conversation_id;
};

describe("serve wire: session-entry recovery", () => {
  it("reports no_published_state before a turn and recovered after one", async () => {
    const id = await createSession();

    const before = await getJson(`/api/v1/sessions/${id}`);
    assert.equal(before.status, 200);
    const beforeSession = before.body.session as {
      recovery?: { status: string };
    };
    assert.deepEqual(beforeSession.recovery, {
      status: "no_published_state",
      operations: [],
    });

    const posted = await fetch(`${origin}/api/v1/sessions/${id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hello over http" }),
    });
    assert.equal(posted.status, 200);

    const after = await getJson(`/api/v1/sessions/${id}`);
    const afterSession = after.body.session as {
      recovery?: { status: string };
    };
    assert.deepEqual(afterSession.recovery, {
      status: "recovered",
      operations: [],
    });
  });

  it("keeps the list projection free of the recovery field", async () => {
    const id = await createSession();
    await fetch(`${origin}/api/v1/sessions/${id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hello" }),
    });
    const list = await getJson("/api/v1/sessions");
    const sessions = list.body.sessions as ReadonlyArray<
      Record<string, unknown>
    >;
    assert.equal(sessions.length, 1);
    assert.equal(
      sessions[0]?.recovery,
      undefined,
      "entry status is not stamped onto a non-entry projection"
    );
  });
});
