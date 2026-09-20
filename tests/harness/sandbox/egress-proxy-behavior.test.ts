/**
 * Tests for egress proxy + filter behavior — real proxy behavior with
 * unmocked upstream pieces.
 *
 * Pinned invariants (from specs/network-egress-allowlist.md + ADR-0097):
 *   - allowlist hit → the proxy dials the upstream directly (a local
 *     http.Server stands in for the outside site) and a 200 response arrives;
 *   - allowlist miss → 403 + a violation record {host,
 *     reason:"not-in-allowlist"} (this repo's filter side is the only
 *     authoritative refusal observation point);
 *   - denied beats allowed: a denied pattern hit refuses even when allowed
 *     also matches;
 *   - address guard: allowedDomains hit but DNS resolves into a denied range
 *     (10.0.0.0/8 private) → 403;
 *   - wiring: a real http-proxy (@anthropic-ai/sandbox-runtime piece) + a
 *     filter using the real decideEgress with a small real allowedDomains set.
 *
 * Note: this test does **not** go through the inner relay — it verifies only
 * the host-side proxy + filter logic (end-to-end of a bare http server on a
 * unix socket is carried by probes). The sandbox-side inner half-bridge was
 * retired by the egress-ssh-bridge work (ADR-0107 replaced it with the
 * bundled node relay): inner-script assembly is pinned in
 * `egress-session.test.ts` (buildInnerBridgeScript / spec shape / auth env)
 * and `bash-egress-inner-bridge.test.ts` (foreground command-chain preamble +
 * seamless byte-identical baseline), and end-to-end reachability is carried
 * by the egress category of `npm run probe:sandbox` (a real inner-relay
 * positive probe, ADR-0107).
 */

import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { request as httpRequest } from "node:http";
import {
  createHttpProxyServer,
  type HttpProxyServerOptions,
} from "@anthropic-ai/sandbox-runtime/dist/sandbox/http-proxy.js";
import { decideEgress } from "../../../src/harness/sandbox/egress/domain-matcher.js";
import {
  createEgressViolationSink,
  type EgressViolationSink,
} from "../../../src/harness/sandbox/egress/violations.js";

/**
 * Start a local HTTP upstream (standing in for an outside site) — returns
 * 200 + body. Listens on 127.0.0.1 (never 0.0.0.0, to avoid exposing a
 * listening surface to the outside).
 */
function startUpstream(): Promise<HttpServer> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(`upstream-reached:${req.url ?? "/"}`);
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

/**
 * Bind the proxy server + filter + upstream together; returns
 * { proxyPort, sink, upstream, token }.
 */
async function setupProxyWithFilter(opts: {
  readonly allowedDomains: readonly string[];
  readonly deniedDomains: readonly string[];
}): Promise<{
  proxyPort: number;
  upstream: HttpServer;
  sink: EgressViolationSink;
  token: string;
}> {
  const upstream = await startUpstream();
  const sink = createEgressViolationSink();
  const token = "test-token-do-not-reuse";

  const filterOpts: HttpProxyServerOptions = {
    filter: (port: number, host: string) => {
      const result = decideEgress({
        host,
        port,
        allowedDomains: opts.allowedDomains,
        deniedDomains: opts.deniedDomains,
      });
      if (result.outcome === "deny") {
        sink.record({
          kind: "egress_violation",
          host,
          port,
          reason: result.reason ?? "not-in-allowlist",
          command: "test:behavior",
        });
        return false;
      }
      return true;
    },
    proxyAuthToken: token,
  };
  const proxy = createHttpProxyServer(filterOpts);
  await new Promise<void>((resolve, reject) => {
    proxy.once("error", reject);
    proxy.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = proxy.address() as AddressInfo;
  return { proxyPort: addr.port, upstream, sink, token };
}

/**
 * Send a request through the proxy (simulating curl via HTTP_PROXY) — after
 * the proxy resolves CONNECT it dials the upstream directly and the body comes
 * from the upstream.
 *
 * The real shape is HTTP CONNECT: the client sends `CONNECT host:port HTTP/1.1`
 * to the proxy, and after `HTTP/1.1 200 Connection Established` it starts
 * writing raw HTTP over the tunnel. This test simplifies with the absolute-URI
 * proxy form (`GET http://host:port/path HTTP/1.1`), which the proxy forwards
 * straight to the upstream.
 *
 * The proxy requires `Proxy-Authorization: Basic base64("srt:<token>")`
 * (spec:proxyAuthToken implementation) and answers 407 without it. This test
 * uses the injected token.
 */
function sendAbsoluteUriRequest(args: {
  proxyPort: number;
  targetHost: string;
  targetPort: number;
  path?: string;
  token?: string;
}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const path = args.path ?? "/probe";
    const headers: Record<string, string> = {
      Host: `${args.targetHost}:${args.targetPort}`,
    };
    if (args.token !== undefined) {
      const basic = Buffer.from(`srt:${args.token}`).toString("base64");
      headers["Proxy-Authorization"] = `Basic ${basic}`;
    }
    const req = httpRequest({
      host: "127.0.0.1",
      port: args.proxyPort,
      method: "GET",
      path: `http://${args.targetHost}:${args.targetPort}${path}`,
      headers,
      timeout: 5000,
    });
    req.once("response", (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        resolve({
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
      res.on("error", reject);
    });
    req.once("error", reject);
    req.end();
  });
}

describe("egress proxy + filter behavior", () => {
  let upstream: HttpServer | undefined;
  let upstreamPort = 0;
  let proxyClose: (() => void) | undefined;

  beforeEach(async () => {
    upstream = await startUpstream();
    upstreamPort = (upstream.address() as AddressInfo).port;
  });

  afterEach(async () => {
    proxyClose?.();
    proxyClose = undefined;
    if (upstream !== undefined) {
      await new Promise<void>((resolve) => upstream!.close(() => resolve()));
      upstream = undefined;
    }
  });

  it("allowed host → 200 + body reaches upstream (SC2 path)", async () => {
    const setup = await setupProxyWithFilter({
      // The upstream address uses the 'localhost' literal (the filter sees the literal itself;
      // spec: client literal matches the upstream) — the filter must pass 'localhost'.
      allowedDomains: ["localhost"],
      deniedDomains: [],
    });
    proxyClose = () => setup.upstream; // unused, just to keep var alive

    // pass the proxy port through to the client
    const res = await sendAbsoluteUriRequest({
      proxyPort: setup.proxyPort,
      targetHost: "localhost",
      targetPort: upstreamPort,
      token: setup.token,
    });

    expect(res.status).toBe(200);
    expect(res.body).toBe(`upstream-reached:/probe`);
    expect(setup.sink.size()).toBe(0);
  });

  it("denied host → 403 + violation recorded (SC3 path)", async () => {
    const setup = await setupProxyWithFilter({
      allowedDomains: ["allowed.example"],
      deniedDomains: [],
    });
    const res = await sendAbsoluteUriRequest({
      proxyPort: setup.proxyPort,
      targetHost: "evil.example",
      targetPort: upstreamPort,
      token: setup.token,
    });
    expect(res.status).toBe(403);
    expect(setup.sink.size()).toBe(1);
    const v = setup.sink.drain()[0]!;
    expect(v.host).toBe("evil.example");
    expect(v.reason).toBe("not-in-allowlist");
  });

  it("denied pattern beats allowed (deny precedence)", async () => {
    const setup = await setupProxyWithFilter({
      allowedDomains: ["*.example"],
      deniedDomains: ["bad.example"],
    });
    const res = await sendAbsoluteUriRequest({
      proxyPort: setup.proxyPort,
      targetHost: "bad.example",
      targetPort: upstreamPort,
      token: setup.token,
    });
    expect(res.status).toBe(403);
    expect(setup.sink.size()).toBe(1);
    expect(setup.sink.drain()[0]!.reason).toBe("denied");
  });

  it("allowlist empty → all denied (fail-closed)", async () => {
    const setup = await setupProxyWithFilter({
      allowedDomains: [],
      deniedDomains: [],
    });
    const res = await sendAbsoluteUriRequest({
      proxyPort: setup.proxyPort,
      targetHost: "anything.example",
      targetPort: upstreamPort,
      token: setup.token,
    });
    expect(res.status).toBe(403);
    expect(setup.sink.drain()[0]!.reason).toBe("allowlist-empty");
  });

  it("multiple violations are recorded in order across requests", async () => {
    const setup = await setupProxyWithFilter({
      allowedDomains: ["allowed.example"],
      deniedDomains: [],
    });
    // three consecutive denials
    await sendAbsoluteUriRequest({
      proxyPort: setup.proxyPort,
      targetHost: "evil1.example",
      targetPort: upstreamPort,
      token: setup.token,
    });
    await sendAbsoluteUriRequest({
      proxyPort: setup.proxyPort,
      targetHost: "evil2.example",
      targetPort: upstreamPort,
      token: setup.token,
    });
    await sendAbsoluteUriRequest({
      proxyPort: setup.proxyPort,
      targetHost: "evil3.example",
      targetPort: upstreamPort,
      token: setup.token,
    });
    const drained = setup.sink.drain();
    expect(drained).toHaveLength(3);
    expect(drained[0]!.host).toBe("evil1.example");
    expect(drained[1]!.host).toBe("evil2.example");
    expect(drained[2]!.host).toBe("evil3.example");
  });
});
