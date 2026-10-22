/**
 * tests/harness/sandbox/egress-proxy-connect-407.test.ts
 *
 * The egress HTTP proxy's 407 challenge frame (ADR-0097; plan
 * `perf-c-fence-egress` Task 8 — "git over HTTPS through the egress proxy:
 * fix the 407 CONNECT response frame").
 *
 * Why the frame's framing matters: git's transport is libcurl, whose default
 * `http.proxyAuthMethod=anyauth` sends the **first** CONNECT *without*
 * credentials and, on a 407, retries *with* credentials. HTTP/1.1 keep-alive
 * semantics make libcurl reuse the same connection for that retry — but the
 * upstream proxy closes the socket right after answering 407, so git fails
 * with `Proxy CONNECT aborted`. The curl CLI is unaffected: its credentials
 * ride in the proxy URL userinfo, so its first CONNECT already carries them.
 *
 * The upstream package (0.0.76, `dist/sandbox/http-proxy.js:219-223` +
 * `:192-206`) answers a credential-less CONNECT with a header-only 407 frame
 * — neither `Content-Length` nor `Connection: close` — and then closes the
 * socket. The fix lives in the adapter layer
 * (`src/harness/sandbox/egress/upstream.ts`): the challenge frame declares an
 * empty body and a finished connection, so the client reconnects and retries.
 *
 * Pinned here (real proxy, real filter, raw TCP client — nothing mocked):
 *   - no credentials → 407 carrying `Content-Length: 0` + `Connection: close`,
 *     empty body (the client can reconnect and retry with credentials);
 *   - wrong credentials → still 407, same framing (auth is NOT relaxed);
 *   - correct credentials → 200 Connection Established;
 *   - a denied domain → 403 (the allowlist still governs; the fix did not
 *     reorder the checks);
 *   - the 403 and 200 frames are byte-identical to the unpatched upstream's
 *     (the rewrite is confined to the 407 challenge frame).
 */

import net from "node:net";
import type { AddressInfo } from "node:net";
import type { Server as HttpServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createHttpProxyServer as createRawUpstreamProxy } from "@anthropic-ai/sandbox-runtime/dist/sandbox/http-proxy.js";
import {
  createHttpProxyServer,
  type HttpProxyServerOptions,
} from "../../../src/harness/sandbox/egress/upstream.js";
import { decideEgress } from "../../../src/harness/sandbox/egress/domain-matcher.js";

/** Synthetic per-test proxy token (a test fixture, not a credential). */
const TOKEN = "connect-407-frame-token";

type ProxyFactory = (options: HttpProxyServerOptions) => HttpServer;

/** Teardown handles of the current test (proxies + the fake upstream). */
const cleanups: (() => Promise<void>)[] = [];

/**
 * Start a local TCP listener standing in for the outside site — the CONNECT
 * tunnel only needs the TCP handshake to succeed for the proxy to answer 200.
 * Binds 127.0.0.1 only (never 0.0.0.0).
 */
async function startUpstreamTcp(): Promise<number> {
  const accepted: net.Socket[] = [];
  const server = net.createServer((socket) => {
    accepted.push(socket);
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  cleanups.push(async () => {
    for (const socket of accepted) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return (server.address() as AddressInfo).port;
}

/**
 * Start the proxy under test (the adapter, or the unpatched upstream package
 * as the byte-level reference) on 127.0.0.1 with the real `decideEgress`
 * filter.
 */
async function startProxy(
  factory: ProxyFactory,
  allowedDomains: readonly string[]
): Promise<number> {
  const options: HttpProxyServerOptions = {
    filter: (port: number, host: string) =>
      decideEgress({ host, port, allowedDomains, deniedDomains: [] })
        .outcome === "allow",
    proxyAuthToken: TOKEN,
  };
  const proxy = factory(options);
  await new Promise<void>((resolve, reject) => {
    proxy.once("error", reject);
    proxy.listen(0, "127.0.0.1", () => resolve());
  });
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        proxy.closeAllConnections?.();
        proxy.close(() => resolve());
      })
  );
  return (proxy.address() as AddressInfo).port;
}

/** A raw CONNECT request; `token` omitted = no `Proxy-Authorization` header. */
function connectRequest(target: string, token?: string): string {
  const lines = [`CONNECT ${target} HTTP/1.1`, `Host: ${target}`];
  if (token !== undefined) {
    const basic = Buffer.from(`srt:${token}`).toString("base64");
    lines.push(`Proxy-Authorization: Basic ${basic}`);
  }
  return `${lines.join("\r\n")}\r\n\r\n`;
}

interface RawExchange {
  /** Every byte the proxy sent, verbatim. */
  readonly raw: string;
  /** The status line + headers, up to and including the blank line. */
  readonly head: string;
  /** The bytes after the header terminator (the body). */
  readonly body: string;
  /** The status line alone. */
  readonly statusLine: string;
}

/**
 * Speak raw HTTP/1.1 to the proxy over a plain TCP socket (no client library
 * that would paper over the framing).
 *
 * `waitForClose` = true waits for the proxy to close the connection (the 407
 * / 403 verdicts end the socket); false returns as soon as the header block
 * is complete (the 200 tunnel response keeps the connection open).
 */
function rawExchange(
  port: number,
  request: string,
  opts: { readonly waitForClose: boolean }
): Promise<RawExchange> {
  return new Promise<RawExchange>((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      const raw = Buffer.concat(chunks).toString("utf8");
      const end = raw.indexOf("\r\n\r\n");
      resolve({
        raw,
        head: end >= 0 ? raw.slice(0, end + 4) : raw,
        body: end >= 0 ? raw.slice(end + 4) : "",
        statusLine: raw.split("\r\n")[0] ?? "",
      });
    };
    socket.on("connect", () => socket.write(request));
    socket.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      if (!opts.waitForClose) {
        if (Buffer.concat(chunks).includes("\r\n\r\n")) {
          finish();
          socket.destroy();
        }
        return;
      }
    });
    socket.on("end", finish);
    socket.on("close", finish);
    socket.on("error", (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

describe("egress proxy CONNECT 407 challenge frame", () => {
  it("CONNECT without credentials → 407 framed as an empty body on a closing connection", async () => {
    const port = await startProxy(createHttpProxyServer, ["localhost"]);

    const res = await rawExchange(port, connectRequest("localhost:443"), {
      waitForClose: true,
    });

    expect(res.statusLine).toBe("HTTP/1.1 407 Proxy Authentication Required");
    // The exact wire bytes: an empty body plus the "this connection is
    // finished" marker, so an anyauth client reconnects and retries.
    expect(res.raw).toBe(
      "HTTP/1.1 407 Proxy Authentication Required\r\n" +
        'Proxy-Authenticate: Basic realm="srt"\r\n' +
        "Content-Length: 0\r\n" +
        "Connection: close\r\n" +
        "\r\n"
    );
    expect(res.head).toMatch(/^content-length: 0$/im);
    expect(res.head).toMatch(/^connection: close$/im);
    expect(res.body).toBe("");
  });

  it("CONNECT with wrong credentials → still 407 with the same close framing (auth is not relaxed)", async () => {
    const port = await startProxy(createHttpProxyServer, ["localhost"]);

    const res = await rawExchange(
      port,
      connectRequest("localhost:443", "not-the-token"),
      { waitForClose: true }
    );

    expect(res.statusLine).toBe("HTTP/1.1 407 Proxy Authentication Required");
    expect(res.head).toMatch(/^content-length: 0$/im);
    expect(res.head).toMatch(/^connection: close$/im);
    expect(res.body).toBe("");
  });

  it("CONNECT with correct credentials on a fresh connection → 200 Connection Established", async () => {
    const upstreamPort = await startUpstreamTcp();
    const port = await startProxy(createHttpProxyServer, ["localhost"]);

    const res = await rawExchange(
      port,
      connectRequest(`localhost:${upstreamPort}`, TOKEN),
      { waitForClose: false }
    );

    expect(res.statusLine).toBe("HTTP/1.1 200 Connection Established");
    expect(res.raw).toBe("HTTP/1.1 200 Connection Established\r\n\r\n");
  });

  it("CONNECT to a denied domain → 403 (the allowlist still governs)", async () => {
    const port = await startProxy(createHttpProxyServer, ["localhost"]);

    const res = await rawExchange(
      port,
      connectRequest("evil.example:443", TOKEN),
      { waitForClose: true }
    );

    expect(res.statusLine).toBe("HTTP/1.1 403 Forbidden");
    expect(res.raw).not.toContain("407");
    expect(res.raw).not.toContain("200 Connection Established");
  });

  it("the rewrite is confined to the 407 frame: 403 and 200 frames stay byte-identical to the unpatched upstream", async () => {
    const upstreamPort = await startUpstreamTcp();
    const patchedPort = await startProxy(createHttpProxyServer, ["localhost"]);
    const rawPort = await startProxy(createRawUpstreamProxy as ProxyFactory, [
      "localhost",
    ]);

    const deniedTarget = "evil.example:443";
    const allowedTarget = `localhost:${upstreamPort}`;

    const patchedDenied = await rawExchange(
      patchedPort,
      connectRequest(deniedTarget, TOKEN),
      { waitForClose: true }
    );
    const rawDenied = await rawExchange(
      rawPort,
      connectRequest(deniedTarget, TOKEN),
      {
        waitForClose: true,
      }
    );
    expect(patchedDenied.raw).toBe(rawDenied.raw);
    expect(patchedDenied.statusLine).toBe("HTTP/1.1 403 Forbidden");

    const patchedAllowed = await rawExchange(
      patchedPort,
      connectRequest(allowedTarget, TOKEN),
      { waitForClose: false }
    );
    const rawAllowed = await rawExchange(
      rawPort,
      connectRequest(allowedTarget, TOKEN),
      { waitForClose: false }
    );
    expect(patchedAllowed.raw).toBe(rawAllowed.raw);
    expect(patchedAllowed.statusLine).toBe(
      "HTTP/1.1 200 Connection Established"
    );
  });
});
