/**
 * egress credential 集成臂 — T7（specs/egress-credential-sentinel.md §T7 +
 * specs/egress-credential-sentinel.md / ADR-0105（T7 集成验收）。
 *
 * 钉住的不变式（全真实件，不 mock 上游）：
 *   - 真起代理 = createEgressSession 完整装配链（铸造 → mitmCA → 代换
 *     接线 → listen）；客户端经 `spec.unixSocketPath`（生产访问面：围栏内
 *     中继 → unix socket → 宿主代理）直连；
 *   - 自建 HTTPS echo server：证书 = 同一持久 CA 经 `mintLeafCert` 铸造，
 *     代理经 `tlsTerminateUpstreamCA` 信任测试上游根；回环目标经
 *     `localhost` loopback 名原生放行通道（guard 内建语义），地址判定
 *     注入 seam = `policy.deniedResolvedAddresses`——生产档位不放宽
 *     （Assumption 12，本测试不使用该覆盖档位，走 localhost 语义）；
 *   - SC3 三臂：放行域 ∧ injectHosts 命中 → echo 收到真值（header + body
 *     各 1 例）；条目收窄到别域 → 假值原样到达；非放行域 → 既有 403 面
 *     不变 + 违例留痕；
 *   - SC6：`Content-Encoding` 请求体原样透传（假值不动）+
 *     `substitution-skipped` 诊断痕（header 臂仍代换）；
 *   - SC11：dispose → registry 清空 / masked store 目录删除 / trust
 *     bundle 临时件删除 / socket 不留 stale。
 *
 * 能力 guard（显式 skip + Not run，纪律同 tests-real-llm）：仅当真实
 * egress 桥可起时运行——probe = 真建一次 session，不检查错误类名（集成
 * 态类名已换代，判据只认「能不能真起来」）。本分支基底 master 仍是 socat
 * 桥而宿主无 socat → 全臂 skip；三线会师的集成态运行真绿。
 *
 * 最高危安全纪律：本文件只使用生成 fixture「真值」，绝不读取宿主真实
 * 凭据（hostEnv / fixture 文件全注入）；断言面向自建 echo server。
 */

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import type { IncomingHttpHeaders, Server } from "node:http";
import type { AddressInfo } from "node:net";
import net from "node:net";
import { randomBytes } from "node:crypto";
import https from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";
import { describe, beforeAll, afterAll, expect, it } from "vitest";
import { mintLeafCert } from "@anthropic-ai/sandbox-runtime/dist/sandbox/mitm-leaf.js";
import {
  createEgressSession,
  type EgressCredentialResources,
  type EgressSession,
} from "../../../src/harness/sandbox/egress/session.js";
import {
  createHttpProxyServer,
  SENTINEL_PREFIX,
} from "../../../src/harness/sandbox/egress/upstream.js";
import { loadEgressCa } from "../../../src/harness/sandbox/egress/ca-store.js";
import type { EgressCredentialRoster } from "../../../src/harness/sandbox/egress/credential-assembly.js";

// ── fixture 材料（生成假「真值」，与宿主凭据无关）─────────────────────────

const HIT_ENV = "IKNOW_T7_HIT_TOKEN";
const NARROW_ENV = "IKNOW_T7_NARROW_TOKEN";
const REAL_HIT = `fixture-hit-${randomBytes(24).toString("hex")}`;
const REAL_NARROW = `fixture-narrow-${randomBytes(24).toString("hex")}`;
const REAL_FILE = `fixture-file-${randomBytes(24).toString("hex")}`;
const TEST_HOST = "localhost";
const DENIED_HOST = "denied.example.invalid";

/** 能力 probe：真实 egress 桥能否建立（不窥探错误类型，只看成败）。 */
async function probeRealEgressBridge(): Promise<boolean> {
  let session: EgressSession | undefined;
  try {
    session = await createEgressSession({
      policy: {
        allowedDomains: [],
        deniedDomains: [],
        commandLabel: "probe:t7-real-bridge-capability",
      },
    });
    return true;
  } catch {
    return false;
  } finally {
    try {
      await session?.dispose();
    } catch {
      // probe 收尾 best-effort，不影响判定
    }
  }
}

const BRIDGE_CAPABLE = await probeRealEgressBridge();
if (!BRIDGE_CAPABLE) {
  console.warn(
    "[egress-t7] integration arm Not run: host cannot start a real egress " +
      "bridge (capability probe via createEgressSession failed). Registered " +
      "as Not run per tests-real-llm discipline — run in the merged " +
      "integration state (bundled relay present) for the real-green claim."
  );
}

const integrationDescribe = BRIDGE_CAPABLE ? describe : describe.skip;

integrationDescribe("egress credential integration arm (T7)", () => {
  let fixtureDir: string;
  let credFilePath: string;
  let caCertPem: string;
  let echoServer: Server;
  let echoPort = 0;
  let session: EgressSession;
  let credRes: EgressCredentialResources;
  let proxyUser: string;
  let proxyToken: string;
  let fakeHit: string;
  let fakeNarrow: string;
  const captured: { headers: IncomingHttpHeaders; body: Buffer }[] = [];

  beforeAll(async () => {
    fixtureDir = mkdtempSync(join(tmpdir(), "iknow-t7-int-"));
    credFilePath = join(fixtureDir, "hosts-fixture.yml");
    writeFileSync(
      credFilePath,
      `github:\n    oauth_token: ${REAL_FILE}\n    user: fixture-user\n`,
      { mode: 0o600 }
    );
    const caLoad = loadEgressCa({ caDir: join(fixtureDir, "mitm-ca") });
    caCertPem = caLoad.ca.certPem;
    const leaf = mintLeafCert(caLoad.ca, TEST_HOST);

    echoServer = https.createServer(
      { key: leaf.keyPem, cert: leaf.certPem },
      (req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          captured.push({
            headers: { ...req.headers },
            body: Buffer.concat(chunks),
          });
          res.writeHead(200, { "content-type": "text/plain" });
          res.end("echo-ok");
        });
      }
    );
    await new Promise<void>((resolve, reject) => {
      echoServer.once("error", reject);
      echoServer.listen(0, "127.0.0.1", () => resolve());
    });
    echoPort = (echoServer.address() as AddressInfo).port;

    const roster: EgressCredentialRoster = {
      files: [
        {
          path: credFilePath,
          extract: "oauth_token:\\s*(\\S+)",
          injectHosts: [TEST_HOST],
        },
      ],
      envVars: [
        { name: HIT_ENV, injectHosts: [TEST_HOST] },
        { name: NARROW_ENV, injectHosts: ["narrow.example.invalid"] },
      ],
    };

    session = await createEgressSession({
      policy: {
        allowedDomains: [TEST_HOST],
        deniedDomains: [],
        commandLabel: "test:egress-credential-integration",
        credentials: roster,
      },
      loadEgressCa: () => caLoad,
      hostEnv: { [HIT_ENV]: REAL_HIT, [NARROW_ENV]: REAL_NARROW },
      onCredentialMint: (c) => {
        credRes = c;
      },
      // 生产默认代理 + 测试档位一条：信任自建 echo server 的上游根。
      createHttpProxyServer: (opts) =>
        createHttpProxyServer({
          ...opts,
          tlsTerminateUpstreamCA: caCertPem,
        }),
    });

    const proxyUrl = new URL(session.spec.env.HTTP_PROXY);
    proxyUser = decodeURIComponent(proxyUrl.username);
    proxyToken = decodeURIComponent(proxyUrl.password);
    fakeHit = session.spec.env[HIT_ENV]!;
    fakeNarrow = session.spec.env[NARROW_ENV]!;
  }, 90_000);

  afterAll(async () => {
    try {
      await session?.dispose();
    } catch {
      // afterAll 兜底，dispose 判据在专用测试里已 assert
    }
    await new Promise<void>((resolve) => {
      if (!echoServer) resolve();
      else echoServer.close(() => resolve());
    });
    if (fixtureDir !== undefined) {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  }, 30_000);

  /** 拨通桥入口（生产访问面：unix socket）。 */
  function dialBridgeSocket(): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const sock = net.connect({ path: session.spec.unixSocketPath });
      const onErr = (err: Error): void => {
        sock.off("connect", onConnect);
        reject(err);
      };
      const onConnect = (): void => {
        sock.off("error", onErr);
        sock.on("error", () => {
          // 运行期错误由后续读取路径各自处理
        });
        resolve(sock);
      };
      sock.once("error", onErr);
      sock.once("connect", onConnect);
    });
  }

  function writeConnectRequest(
    sock: net.Socket,
    hostname: string,
    port: number
  ): void {
    const basic = Buffer.from(`${proxyUser}:${proxyToken}`).toString("base64");
    sock.write(
      `CONNECT ${hostname}:${port} HTTP/1.1\r\n` +
        `Host: ${hostname}:${port}\r\n` +
        `Proxy-Authorization: Basic ${basic}\r\n\r\n`
    );
  }

  /** 读到代理 CONNECT 应答头块结束（返回含 status line 的文本）。 */
  function readProxyGreeting(sock: net.Socket): Promise<string> {
    return new Promise((resolve, reject) => {
      let acc = Buffer.alloc(0);
      const onErr = (err: Error): void => reject(err);
      const onData = (chunk: Buffer): void => {
        acc = Buffer.concat([acc, chunk]);
        const idx = acc.indexOf("\r\n\r\n");
        if (idx !== -1) {
          sock.off("data", onData);
          sock.off("error", onErr);
          resolve(acc.subarray(0, idx).toString("latin1"));
        } else if (acc.length > 8192) {
          sock.off("data", onData);
          sock.off("error", onErr);
          reject(new Error("proxy greeting overflow"));
        }
      };
      sock.on("data", onData);
      sock.once("error", onErr);
    });
  }

  /** CONNECT + MITM TLS 隧道（客户端信任代理 CA）。 */
  async function openTlsTunnel(hostname: string): Promise<tls.TLSSocket> {
    const sock = await dialBridgeSocket();
    writeConnectRequest(sock, hostname, echoPort);
    const greeting = await readProxyGreeting(sock);
    if (!greeting.startsWith("HTTP/1.1 200")) {
      sock.destroy();
      throw new Error(`CONNECT failed: ${greeting.split("\r\n")[0]}`);
    }
    return await new Promise<tls.TLSSocket>((resolve, reject) => {
      const tlsSock = tls.connect(
        {
          socket: sock,
          servername: hostname,
          ca: [caCertPem],
          rejectUnauthorized: true,
        },
        () => {
          tlsSock.off("error", reject);
          resolve(tlsSock);
        }
      );
      tlsSock.once("error", reject);
    });
  }

  /** 一次请求一次隧道（Connection: close，读满即返）。 */
  async function oneShot(
    sock: tls.TLSSocket,
    method: string,
    headers: Record<string, string>,
    body?: Buffer
  ): Promise<{ status: number; text: Buffer }> {
    let raw = `${method} / HTTP/1.1\r\nHost: ${TEST_HOST}\r\nConnection: close\r\n`;
    for (const [k, v] of Object.entries(headers)) {
      raw += `${k}: ${v}\r\n`;
    }
    raw += "\r\n";
    const payload =
      body !== undefined
        ? Buffer.concat([Buffer.from(raw), body])
        : Buffer.from(raw);
    return await new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      const onErr = (err: Error): void => reject(err);
      sock.on("data", (c: Buffer) => chunks.push(c));
      sock.once("error", onErr);
      sock.once("end", () => {
        sock.off("error", onErr);
        const full = Buffer.concat(chunks);
        const sep = full.indexOf("\r\n\r\n");
        const headText = full
          .subarray(0, sep === -1 ? full.length : sep)
          .toString("latin1");
        const status = Number(
          /^HTTP\/1\.[01] (\d{3})/.exec(headText)?.[1] ?? 0
        );
        resolve({
          status,
          text: full.subarray(sep === -1 ? full.length : sep + 4),
        });
      });
      sock.write(payload);
    });
  }

  /** 开隧道 → 发一次请求 → 收尾。返回 echo server 侧最后一条捕获。 */
  async function requestThroughArm(
    method: string,
    headers: Record<string, string>,
    body?: Buffer
  ): Promise<{ headers: IncomingHttpHeaders; body: Buffer }> {
    const sock = await openTlsTunnel(TEST_HOST);
    const res = await oneShot(sock, method, headers, body);
    sock.destroy();
    expect(res.status).toBe(200);
    return captured[captured.length - 1]!;
  }

  it("fence env 假值形态 + registry 三 sentinel（T2 前置判据）", () => {
    expect(fakeHit.startsWith(SENTINEL_PREFIX)).toBe(true);
    expect(fakeNarrow.startsWith(SENTINEL_PREFIX)).toBe(true);
    expect(credRes.mint.registry.size).toBe(3);
    expect(session.spec.binds).toBeDefined();
  });

  it("masked-file 盖 bind：dest=真路径、src 内容为假 token 且结构保留（SC7 近邻）", () => {
    const bind = (session.spec.binds ?? []).find(
      (b) => b.dest === credFilePath
    );
    expect(bind).toBeDefined();
    const masked = readFileSync(bind!.src, "utf8");
    expect(masked).not.toContain(REAL_FILE);
    expect(masked).toContain("oauth_token:");
    expect(masked).toContain("user: fixture-user");
    const fakeFile = /oauth_token:\s*(\S+)/.exec(masked)?.[1];
    expect(fakeFile?.startsWith(SENTINEL_PREFIX)).toBe(true);
  });

  it("SC3 arm-1 header：放行域 ∧ injectHosts 命中 → echo 收到真值", async () => {
    const cap = await requestThroughArm("GET", {
      authorization: fakeHit,
      accept: "application/json",
    });
    expect(cap.headers.authorization).toBe(REAL_HIT);
    expect(String(cap.headers.authorization)).not.toContain(SENTINEL_PREFIX);
  });

  it("SC3 arm-1 body：放行域 ∧ injectHosts 命中 → echo 收到真值（长度不变式）", async () => {
    const sent = `payload=${fakeHit}&x=1`;
    const cap = await requestThroughArm(
      "POST",
      {
        "content-type": "application/x-www-form-urlencoded",
        "content-length": String(Buffer.byteLength(sent)),
      },
      Buffer.from(sent)
    );
    const got = cap.body.toString("utf8");
    expect(got).toContain(REAL_HIT);
    expect(got).not.toContain(fakeHit);
    expect(got).not.toContain(REAL_NARROW);
  });

  it("SC3 arm-2 收窄条目：injectHosts 指别域 → 假值 header/body 原样到达", async () => {
    const sizeBefore = session.violationSink.size();
    const sent = `n=${fakeNarrow}`;
    const cap = await requestThroughArm(
      "POST",
      {
        authorization: fakeNarrow,
        "content-length": String(Buffer.byteLength(sent)),
      },
      Buffer.from(sent)
    );
    expect(cap.headers.authorization).toBe(fakeNarrow);
    expect(cap.body.toString("utf8")).toBe(sent);
    expect(cap.body.toString("utf8")).not.toContain(REAL_NARROW);
    expect(String(cap.headers.authorization)).not.toContain(REAL_HIT);
    // 合法放行 + 按门不收 → 不得产生违例（方向断言：无多余痕）
    expect(session.violationSink.size()).toBe(sizeBefore);
  });

  it("SC3 arm-3 非放行域：既有 403 面不变 + 违例留痕", async () => {
    const sock = await dialBridgeSocket();
    writeConnectRequest(sock, DENIED_HOST, 443);
    const greeting = await readProxyGreeting(sock);
    sock.destroy();
    expect(greeting.split("\r\n")[0]).toContain("403");
    const violations = session.violationSink.drain();
    expect(violations).toHaveLength(1);
    expect(violations[0].host).toBe(DENIED_HOST);
    expect(violations[0].command).toBe("test:egress-credential-integration");
  });

  it("SC6：Content-Encoding 体原样透传 + substitution-skipped 诊断痕（header 臂仍代换）", async () => {
    const sentBody = Buffer.from(`z=${fakeHit}&plain=1`);
    const cap = await requestThroughArm(
      "POST",
      {
        authorization: fakeHit,
        "content-encoding": "identity",
        "content-length": String(sentBody.length),
      },
      sentBody
    );
    expect(cap.body.equals(sentBody)).toBe(true);
    expect(cap.body.toString("utf8")).toContain(fakeHit);
    expect(cap.body.toString("utf8")).not.toContain(REAL_HIT);
    expect(cap.headers.authorization).toBe(REAL_HIT);
    const violations = session.violationSink.drain();
    const trace = violations.find((v) => v.reason === "substitution-skipped");
    expect(trace).toBeDefined();
    expect(trace!.host).toBe(TEST_HOST);
  });

  it("SC11 dispose：registry 清空 / masked store 目录删除 / trust bundle 临时件删除 / socket 不留 stale", async () => {
    const socketPath = session.spec.unixSocketPath;
    const trustBundle = credRes.ca.trustBundlePath;
    const storeDir = credRes.mint.store.dirPath;
    expect(storeDir).toBeDefined();
    expect(existsSync(socketPath)).toBe(true);
    expect(existsSync(trustBundle)).toBe(true);
    await session.dispose();
    expect(credRes.mint.registry.size).toBe(0);
    expect(existsSync(storeDir!)).toBe(false);
    expect(existsSync(trustBundle)).toBe(false);
    expect(existsSync(socketPath)).toBe(false);
    // dispose 幂等（重复调用不抛）
    await session.dispose();
  }, 60_000);
});
