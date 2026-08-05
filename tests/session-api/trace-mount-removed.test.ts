/**
 * Spec #183 R3: `iknow serve` no longer mounts /api/v1/traces (the read API
 * is moved to `iknow trace`). TraceOut on serve remains valid for the WRITE
 * side, but the HTTP handler must return 404 for the read routes.
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
let listening: ListeningServer;
let origin: string;

beforeEach(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "iknow-trace-moved-"));
  const tmp = await mkdtemp(join(tmpdir(), "iknow-trace-moved-trace-"));
  const traceFile = join(tmp, "trace.jsonl");
  await writeFile(traceFile, "{}\n", "utf8");
  const store = new SessionStore(baseDir);
  const hub = new SessionHub({ store, deps: makeDeps([]) });
  // traceFilePath is intentionally no longer part of SessionHttpServerOptions;
  // passing it must be a type error (compile) — at runtime we just omit it.
  listening = await listenSessionServer({
    hub,
    host: "127.0.0.1",
    port: 0,
  });
  origin = `http://${listening.host}:${listening.port}`;
});

afterEach(async () => {
  await listening.close();
  await rm(baseDir, { recursive: true, force: true });
});

describe("GET /api/v1/traces on session server", () => {
  it("returns 404 not_found (reader moved to iknow trace)", async () => {
    const res = await fetch(`${origin}/api/v1/traces`);
    assert.equal(res.status, 404);
    const body = (await res.json()) as { error: { kind: string } };
    assert.equal(body.error.kind, "not_found");
  });

  it("returns 404 not_found for /api/v1/traces/fields", async () => {
    const res = await fetch(`${origin}/api/v1/traces/fields`);
    assert.equal(res.status, 404);
    const body = (await res.json()) as { error: { kind: string } };
    assert.equal(body.error.kind, "not_found");
  });

  it("session server still serves /api/v1/health", async () => {
    const res = await fetch(`${origin}/api/v1/health`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { service: string };
    assert.equal(body.service, "iknow-session-api");
  });
});
