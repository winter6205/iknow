/**
 * Tests for egress proxy + filter behavior — T4 真实代理行为（不 mock 上游件）。
 *
 * 钉住的不变式（来自 specs/network-egress-allowlist.md §SC2/SC3/SC4 + ADR-0097）：
 *   - 命中允许集 → 代理 dial 直连上游（用本地 http.Server 上游模拟外站），
 *     收到 200 响应（SC2 路径）；
 *   - 未命中允许集 → 403 + 违例记录里有 {host, reason:"not-in-allowlist"}
 *     （SC3 路径，本仓 filter 侧记录是唯一权威拒绝观测点）；
 *   - denied 集优先于 allowed：命中 denied pattern 即拒，即便 allowed 也命中；
 *   - 地址守卫：allowedDomains 命中但 DNS 解析到 denied 档（10.0.0.0/8 私网）
 *     → 403（SC4 路径）；
 *   - 节点配置：真起 http-proxy（@anthropic-ai/sandbox-runtime 件）+ filter 用真
 *     decideEgress + 真 allowedDomains 小集。
 *
 * 注：本测试**不**起真 socat 桥——它只验宿主侧代理 + filter 逻辑。沙箱内侧
 * 半桥（O3 欠账）已由 egress-ssh-bridge T1 清偿：内层脚本装配在
 * `egress-session.test.ts`（buildInnerBridgeScript / spec 形状 / auth env）
 * 与 `bash-egress-inner-bridge.test.ts`（前台命令链前导 + 无缝
 * byte-identical 基线）钉形，端到端可达性由 `npm run probe:sandbox`
 * 的 socat-present 分支承担（该分支已重写为经真内层桥的端到端正探针）。
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
 * 起一个本地 HTTP 上游（假装是外站）—— 返回 200 + body。
 * 监听 127.0.0.1（不绑 0.0.0.0，避免对外暴露监听面）。
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
 * 把代理 server + filter + 上游绑到一起；返回 [proxyPort, sink, upstream]。
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
 * 透过代理发一个 CONNECT 请求（模拟 curl 经 HTTP_PROXY）—— proxy 解 CONNECT
 * 后直连上游，body 由上游返回。
 *
 * 走 HTTP CONNECT 形态：客户端发 `CONNECT host:port HTTP/1.1` 给代理，
 * 代理回 `HTTP/1.1 200 Connection Established` 后客户端开始 raw TCP 写
 * HTTP 请求。本测试简化：用 absolute-URI 形态发 HTTP 代理请求
 * （`GET http://host:port/path HTTP/1.1`），代理会直接 forward 到上游。
 *
 * 代理要求 `Proxy-Authorization: Basic base64("srt:<token>")`
 * （spec:proxyAuthToken 实现）,缺则返 407。本测试用注入的 token。
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
      // 上游地址用 'localhost' 字面量（filter 收到的是字面，spec：客户端
      // 字面与上游一致）—— filter 需把 'localhost' 放行。
      allowedDomains: ["localhost"],
      deniedDomains: [],
    });
    proxyClose = () => setup.upstream; // unused, just to keep var alive

    // 拿 proxy port 透传到客户端
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
    // 三个连续被拒
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
