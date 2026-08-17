/**
 * serveStaticRequest `stripPrefix` unit coverage (ADR-0020 D1.2, plan T3).
 *
 * pipeFile 走 fs.createReadStream().pipe(res)，fake res 无法承接（与
 * tests/traceserver/serve-static.test.ts:23-29 同一结论），因此用最小
 * node:http server 直挂 serveStaticRequest 实测。
 *
 * 5 boundary classes (plan §T3 stripPrefix 行):
 *   - empty: /trace（strip 后余空）→ trace.html 200
 *   - overflow: /trace/<4096 字符路径> → SPA fallback 不 crash
 *   - exception: /trace/%2e%2e/index.html → 归一化后仍在 webRoot 内，
 *     不泄漏 webRoot 之外文件（与 http.test.ts traversal 同款安全断言）
 */
import { afterEach, beforeEach, describe, it } from "vitest";
import assert from "node:assert/strict";
import * as http from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveStaticRequest } from "../../src/web/serve-static.ts";

let webRoot: string;
let server: http.Server;
let origin: string;

beforeEach(async () => {
  webRoot = await mkdtemp(join(tmpdir(), "iknow-strip-prefix-"));
  await mkdir(join(webRoot, "assets"), { recursive: true });
  await writeFile(
    join(webRoot, "trace.html"),
    "<!doctype html><title>trace</title>",
    "utf8"
  );
  await writeFile(
    join(webRoot, "index.html"),
    "<!doctype html><title>chat</title>",
    "utf8"
  );
  await writeFile(join(webRoot, "assets", "a.js"), "console.log('a');", "utf8");

  server = http.createServer((req, res) => {
    const url = new URL(
      req.url ?? "/",
      `http://${req.headers.host ?? "localhost"}`
    );
    const handled = serveStaticRequest({
      res,
      webRoot,
      pathname: decodeURIComponent(url.pathname),
      fallbackHtml: "trace.html",
      stripPrefix: "/trace",
    });
    if (!handled) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { kind: "not_found" } }));
    }
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  origin = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  await rm(webRoot, { recursive: true, force: true });
});

describe("serveStaticRequest stripPrefix", () => {
  it("GET /trace（strip 后余空）→ trace.html 200", async () => {
    const res = await fetch(`${origin}/trace`);
    assert.equal(res.status, 200);
    assert.ok((await res.text()).includes("<title>trace</title>"));
  });

  it("GET /trace/assets/a.js → strip 后命中资产文件", async () => {
    const res = await fetch(`${origin}/trace/assets/a.js`);
    assert.equal(res.status, 200);
    assert.ok((await res.text()).includes("console.log('a');"));
    assert.ok(
      (res.headers.get("content-type") ?? "").includes("text/javascript")
    );
  });

  it("GET /trace/unknown/route → SPA fallback trace.html", async () => {
    const res = await fetch(`${origin}/trace/unknown/route`);
    assert.equal(res.status, 200);
    assert.ok((await res.text()).includes("<title>trace</title>"));
  });

  it("overflow: /trace/<4096 字符路径> → SPA fallback 不 crash", async () => {
    const res = await fetch(`${origin}/trace/${"x".repeat(4096)}`);
    assert.equal(res.status, 200);
    assert.ok((await res.text()).includes("<title>trace</title>"));
  });
});

// -- exception: traversal 守卫（直调 fake res —— 403 路径不走 pipeFile） --------

describe("serveStaticRequest stripPrefix — traversal defense-in-depth", () => {
  it("stripped path 解析出 webRoot → 403 且不泄漏细节（直调，不经 URL 归一化）", () => {
    const writes: Array<{ status: number; body: string }> = [];
    const res = {
      status: 0,
      writeHead(status: number) {
        this.status = status;
        return this;
      },
      end(payload?: string) {
        writes.push({ status: this.status, body: payload ?? "" });
        return this;
      },
    } as unknown as http.ServerResponse;
    const handled = serveStaticRequest({
      res,
      webRoot,
      pathname: "/trace/../secret.txt",
      fallbackHtml: "trace.html",
      stripPrefix: "/trace",
    });
    assert.equal(handled, true);
    assert.equal(writes.length, 1);
    assert.equal(writes[0]!.status, 403);
    const body = JSON.parse(writes[0]!.body) as {
      error: { kind: string; message: string };
    };
    assert.equal(body.error.kind, "internal");
    assert.ok(!body.error.message.includes("secret"));
  });

  it("HTTP-encoded traversal 被 URL 归一化挡在 mount 之外（安全结果）", async () => {
    // WHATWG URL 把 %2e%2e 当 dot segment 归一化：/trace/%2e%2e/index.html
    // → /index.html，已不在 /trace mount 下 → 本 harness 返 404（session
    // server 则会落回 chat SPA fallback）——两种结局都不泄漏 webRoot 外文件。
    const res = await fetch(`${origin}/trace/%2e%2e/index.html`);
    assert.equal(res.status, 404);
  });
});
