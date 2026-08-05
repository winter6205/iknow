/**
 * `iknow trace` static-serve + trace SPA hosting tests.
 *
 * Covers the end-to-end wiring through `startTraceServe({ webRoot })`
 * (`src/traceserver/serve.ts`) which delegates static serving to the shared
 * helper `serveStaticRequest` (`src/web/serve-static.ts`). Mirrors the
 * chat-side coverage in `tests/session-api/http.test.ts` ("static file
 * serving" block) but for the trace process:
 *
 *   - GET /                      -> trace.html (200, text/html)
 *   - GET /assets/<file>.js      -> 200 + correct MIME (text/javascript)
 *   - GET /some/spa/route        -> SPA fallback -> trace.html (200)
 *   - GET /api/v1/health         -> API priority: 200 JSON (static must NOT
 *                                    shadow health)
 *   - missing fallbackHtml       -> helper returns false -> 404 JSON
 *   - GET /api/v1/health         -> helper returns false (API priority)
 *
 * Categories (S2 defensive contract):
 *   - normal path: root + asset + SPA fallback + API
 *   - failure path: unknown-extension fallback, missing fallbackHtml -> 404
 *   - boundary: webRoot with no trace.html (helper returns false)
 *   - empty input: API path must not be served as static
 *
 * Why no "helper direct" block driving a fake res: `pipeFile` uses
 * `fs.createReadStream().pipe(res)`, which calls `res.write(chunk)` per
 * chunk — a fake res without `write`/`on('error')` leaves the underlying
 * read stream unconsumed and emits unhandled ENOENT errors. The real
 * `http.ServerResponse` (via `startTraceServe` + `fetch`) is the only
 * honest surface for these tests.
 *
 * 403 traversal guard: `serveStaticRequest`'s `path.resolve` + `startsWith`
 * check IS the path-traversal defense, but both undici's `fetch` and the
 * server-side `new URL(req.url)` NORMALIZE `%2e%2e` / `..` segments BEFORE
 * the helper runs, so the 403 branch is defense-in-depth unreachable via
 * HTTP. Mirrors the session-api precedent (`tests/session-api/http.test.ts`
 * L584-593): assert the safe outcome instead — a traversal attempt
 * collapses to a path inside webRoot and SPA-falls-back to trace.html (200),
 * never leaking a file outside webRoot.
 *
 * Temp dirs are created via fs.mkdtempSync + os.tmpdir, cleaned up in
 * afterEach (webRoot) and afterAll (process-level tempDirs bookkeeping).
 */
import { afterEach, describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  serveStaticRequest,
  resolveDefaultWebRoot,
} from "../../src/web/serve-static.ts";
import {
  startTraceServe,
  type TraceListeningServer,
} from "../../src/traceserver/serve.ts";

// -- bookkeeping --------------------------------------------------------------

const tempDirs: string[] = [];
let listening: TraceListeningServer | undefined;
let origin: string;

function makeWebRoot(prefix: string, withTraceHtml = true): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(root);
  if (withTraceHtml) {
    writeFileSync(
      join(root, "trace.html"),
      '<!doctype html><title>iknow trace</title><div id="root">trace-spa</div>',
      "utf8"
    );
  }
  return root;
}

afterEach(async () => {
  if (listening) await listening.close();
  listening = undefined;
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

// -- helpers ------------------------------------------------------------------

function writeAsset(root: string, rel: string, body: string): void {
  const abs = join(root, rel);
  const slash = abs.lastIndexOf("/");
  if (slash > root.length) {
    mkdirSync(abs.slice(0, slash), { recursive: true });
  }
  writeFileSync(abs, body, "utf8");
}

async function startServerWithWebRoot(webRoot: string): Promise<void> {
  const out = await startTraceServe({
    host: "127.0.0.1",
    port: 0,
    webRoot,
  });
  listening = out;
  origin = `http://${out.host}:${out.port}`;
}

// =========================================================================
// End-to-end: startTraceServe({ webRoot }) hosts the trace SPA
// =========================================================================

describe("startTraceServe — static SPA hosting (webRoot)", () => {
  it("serves trace.html for GET /", async () => {
    const root = makeWebRoot("iknow-trace-e2e-root-");
    await startServerWithWebRoot(root);
    const res = await fetch(`${origin}/`);
    assert.equal(res.status, 200);
    assert.ok(
      (res.headers.get("content-type") ?? "").includes("text/html"),
      `expected text/html, got ${res.headers.get("content-type")}`
    );
    const body = await res.text();
    assert.ok(
      body.includes('<div id="root">') || body.includes("trace-spa"),
      `expected trace.html marker, got: ${body.slice(0, 80)}`
    );
  });

  it("serves /assets/*.js with the text/javascript MIME", async () => {
    const root = makeWebRoot("iknow-trace-e2e-js-");
    writeAsset(root, "assets/main.js", "console.log('asset');");
    await startServerWithWebRoot(root);
    const res = await fetch(`${origin}/assets/main.js`);
    assert.equal(res.status, 200);
    assert.ok(
      (res.headers.get("content-type") ?? "").includes("text/javascript"),
      `expected text/javascript, got ${res.headers.get("content-type")}`
    );
    const body = await res.text();
    assert.ok(body.includes("console.log('asset')"));
  });

  it("SPA-falls-back to trace.html for unknown non-/api paths", async () => {
    const root = makeWebRoot("iknow-trace-e2e-spa-");
    await startServerWithWebRoot(root);
    const res = await fetch(`${origin}/some/spa/route`);
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.ok(
      body.includes("iknow trace") || body.includes("trace-spa"),
      "SPA fallback must serve trace.html"
    );
  });

  it("collapses path-traversal attempts to SPA fallback (defense-in-depth)", async () => {
    // Path traversal 403 is unreachable via HTTP because undici's fetch and
    // the server-side `new URL(req.url)` normalize `%2e%2e` / `..` segments
    // before serveStaticRequest runs (mirror of session-api http.test.ts
    // L584-593). We assert the safe outcome: traversal collapses to a path
    // inside webRoot and SPA-falls-back to trace.html (200), never leaking
    // a file outside webRoot.
    const root = makeWebRoot("iknow-trace-e2e-trav-");
    await startServerWithWebRoot(root);
    const res = await fetch(`${origin}/%2e%2e/secret`);
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.ok(
      body.includes("iknow trace") || body.includes("trace-spa"),
      "traversal must collapse into webRoot and SPA-fall-back"
    );
  });

  it("does NOT shadow /api/v1/health (API priority over static)", async () => {
    // Critical regression guard: trace process static SPA must not eat the
    // health endpoint. With a populated webRoot + trace.html, /api/v1/health
    // must still return the JSON health body.
    const root = makeWebRoot("iknow-trace-e2e-api-");
    await startServerWithWebRoot(root);
    const res = await fetch(`${origin}/api/v1/health`);
    assert.equal(res.status, 200);
    assert.ok(
      (res.headers.get("content-type") ?? "").includes("application/json"),
      "health must be JSON, not static text/html"
    );
    const body = (await res.json()) as { ok: boolean; service: string };
    assert.equal(body.ok, true);
    assert.equal(body.service, "iknow-trace");
  });

  it("returns 404 JSON when webRoot has no trace.html (helper returns false)", async () => {
    // No trace.html under webRoot → SPA fallback fails → helper returns
    // false → server-level 404 JSON (the "no route" branch in serve.ts).
    const root = makeWebRoot("iknow-trace-e2e-empty-", false);
    await startServerWithWebRoot(root);
    const res = await fetch(`${origin}/`);
    assert.equal(res.status, 404);
    assert.ok(
      (res.headers.get("content-type") ?? "").includes("application/json")
    );
    const body = (await res.json()) as { error?: { kind?: string } };
    assert.equal(body.error?.kind, "not_found");
  });
});

// =========================================================================
// Direct serveStaticRequest unit tests — no-response paths only
//
// Why this block exists: prove the helper's `return false` contract
// (caller-404 + API-priority) without spinning up an HTTP server. These
// paths do NOT call `pipeFile`, so a minimal fake res with `writeHead` + `end`
// suffices. Pipe-based paths (root /, asset, SPA fallback) are exercised
// by the e2e block above via real `startTraceServe + fetch`.
// =========================================================================

describe("serveStaticRequest — helper direct (no-response paths)", () => {
  it("returns FALSE for /api paths (API priority contract)", () => {
    // /api short-circuits at L63-65 without writing any response. A fake
    // res with no `write`/`on` is safe here — only `writeHead`/`end` would
    // be called, and neither happens on this code path.
    const root = makeWebRoot("iknow-trace-helper-api-");
    let resWriteHeadCalled = false;
    let resEndCalled = false;
    const fakeRes = {
      writeHead(): void {
        resWriteHeadCalled = true;
      },
      end(): void {
        resEndCalled = true;
      },
    } as unknown as Parameters<typeof serveStaticRequest>[0]["res"];
    const handled = serveStaticRequest({
      res: fakeRes,
      webRoot: root,
      pathname: "/api/v1/health",
      fallbackHtml: "trace.html",
    });
    assert.equal(handled, false, "/api must NOT be served as static");
    assert.equal(
      resWriteHeadCalled,
      false,
      "helper must not write any response on /api"
    );
    assert.equal(resEndCalled, false);
  });

  it("returns FALSE when fallbackHtml is missing under webRoot (caller 404)", () => {
    // No trace.html written → SPA fallback can't kick in → helper returns
    // false with NO response sent (L101). A fake res with just writeHead/end
    // is safe — neither is called on this code path.
    const root = makeWebRoot("iknow-trace-helper-empty-", false);
    let resWriteHeadCalled = false;
    let resEndCalled = false;
    const fakeRes = {
      writeHead(): void {
        resWriteHeadCalled = true;
      },
      end(): void {
        resEndCalled = true;
      },
    } as unknown as Parameters<typeof serveStaticRequest>[0]["res"];
    const handled = serveStaticRequest({
      res: fakeRes,
      webRoot: root,
      pathname: "/anything",
      fallbackHtml: "trace.html",
    });
    assert.equal(
      handled,
      false,
      "must signal caller-404 (handled=false) when fallbackHtml absent"
    );
    assert.equal(
      resWriteHeadCalled,
      false,
      "helper must not write any response on missing-fallback path"
    );
    assert.equal(resEndCalled, false);
  });
});

// =========================================================================
// resolveDefaultWebRoot (cross-checks the helper contract from trace side)
// =========================================================================

describe("resolveDefaultWebRoot (from trace import)", () => {
  it("returns an absolute path ending in web/dist or web", () => {
    const root = resolveDefaultWebRoot();
    assert.ok(root.length > 0);
    const norm = root.replace(/\\/g, "/");
    assert.ok(
      norm.endsWith("web/dist") || norm.endsWith("web"),
      `unexpected webRoot: ${root}`
    );
  });
});
