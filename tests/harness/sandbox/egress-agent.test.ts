/**
 * Tests for `egress/agent.ts` — the session-resident egress agent and the
 * per-call endpoints it hands out.
 *
 * Pinned invariants (plan T4 "出口代理会话级常驻" + T5 "按调用子 socket",
 * reconciled by the agent/endpoint split):
 *   - the expensive profile (relay resolution, durable CA load + trust-bundle
 *     write, credential mint, proxy auth token, ssh-agent check) is loaded
 *     ONCE per agent, no matter how many calls use it;
 *   - every call gets its OWN unix socket (path carries the one-shot call id,
 *     mode 0600), its OWN proxy-server instance (its own filter closure) and
 *     its OWN violation sink — a violation is attributed to exactly the call
 *     that produced it;
 *   - the agent starts lazily (nothing is loaded before the first call) and
 *     the start is idempotent under concurrency (one in-flight start);
 *   - a failing profile load is fail-closed: the typed error reaches the
 *     caller and NO endpoint is created (never a silent direct connection);
 *   - the agent-level sink holds only records produced outside a call — it
 *     never mixes calls together.
 *
 * Injection strategy follows `egress-session.test.ts` / `egress-session-
 * credential.test.ts`: the relay resolver, the socket path factory, the proxy
 * server factory and the CA loader are the module's documented test seams.
 * The agent module itself is never mocked.
 */

import {
  existsSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  openConnectTunnel,
  proxyAuthHeader,
  startLocalTarget,
  waitForClose,
  type LocalTarget,
} from "./egress-connect-tunnel.fixtures.js";
import {
  createEgressAgent,
  EgressAgentDisposedError,
  type EgressAgent,
} from "../../../src/harness/sandbox/egress/agent.js";
import {
  EgressRelayUnavailableError,
  type EgressCallPolicy,
  type EgressCredentialResources,
} from "../../../src/harness/sandbox/egress/session.js";
import type { EgressRelayPaths } from "../../../src/harness/sandbox/egress/relay-assets.js";
import type { EgressCredentialRoster } from "../../../src/harness/sandbox/egress/credential-assembly.js";
import type { EgressCaLoad } from "../../../src/harness/sandbox/egress/ca-store.js";
import type {
  HttpProxyServerOptions,
  MitmCA,
} from "../../../src/harness/sandbox/egress/upstream.js";

const scratchPaths: string[] = [];
const agents: EgressAgent[] = [];
const localTargets: LocalTarget[] = [];

function scratchDir(): string {
  const d = mkdtempSync(join(tmpdir(), "iknow-egress-agent-test-"));
  scratchPaths.push(d);
  return d;
}

afterEach(async () => {
  for (const a of agents.splice(0)) await a.dispose();
  for (const t of localTargets.splice(0)) await t.close();
  for (const p of scratchPaths.splice(0)) {
    rmSync(p, { recursive: true, force: true });
  }
});

/** Fixed fake relay path set — the resolver seam means the host layout is never probed. */
function fakeRelay(): EgressRelayPaths {
  const relayDir = "/test-root/vendor/egress-relay";
  return {
    nodePath: "/test-root/bin/node",
    relayDir,
    bridgeScriptPath: join(relayDir, "egress-tcp-relay.mjs"),
    connectScriptPath: join(relayDir, "egress-http-connect.mjs"),
  };
}

/**
 * Capture the filter closure each endpoint installs — the seam is the module's
 * own `createHttpProxyServer` injection point, so the captured callback is the
 * real decision closure the endpoint built (no re-implementation here).
 */
interface CapturedFilter {
  readonly filter: (port: number, host: string) => Promise<boolean> | boolean;
}

function captureFilters(): {
  readonly seam: (
    opts: HttpProxyServerOptions
  ) => ReturnType<typeof createServer>;
  readonly captured: CapturedFilter[];
} {
  const captured: CapturedFilter[] = [];
  const seam = (
    opts: HttpProxyServerOptions
  ): ReturnType<typeof createServer> => {
    captured.push({ filter: opts.filter as CapturedFilter["filter"] });
    return createServer();
  };
  return { seam, captured };
}

/** Generated fake credentials + a fake CA whose trust bundle really exists on disk. */
function credentialFixture(): {
  readonly roster: EgressCredentialRoster;
  readonly caLoad: EgressCaLoad;
} {
  const dir = scratchDir();
  const bundlePath = join(dir, "bundle.pem");
  writeFileSync(
    bundlePath,
    "-----BEGIN CERTIFICATE-----\nZmFrZQo=\n-----END CERTIFICATE-----\n"
  );
  const hostsPath = join(dir, "hosts.yml");
  writeFileSync(hostsPath, "github.com:\n  oauth_token: gho_FAKEfile\n");
  const ca = {
    trustBundlePath: bundlePath,
    keyPath: join(dir, "ca-key.pem"),
  } as unknown as MitmCA;
  return {
    roster: {
      files: [
        {
          path: hostsPath,
          extract: "oauth_token:\\s*(\\S+)",
          injectHosts: ["github.com"],
        },
      ],
      envVars: [{ name: "GH_TOKEN", injectHosts: ["github.com"] }],
    },
    caLoad: {
      ca,
      state: {
        certPath: join(dir, "cert.pem"),
        keyPath: ca.keyPath,
        action: "loaded",
        notice: null,
      },
    },
  };
}

/** A per-call policy — the call-scoped half of the egress decision input. */
function policy(overrides: Partial<EgressCallPolicy> = {}): EgressCallPolicy {
  return {
    allowedDomains: ["github.com"],
    deniedDomains: [],
    commandLabel: "test:agent",
    ...overrides,
  };
}

describe("egress agent — 会话级常驻 (T4)", () => {
  it("同一个 agent 连续 3 次建端点：CA / 铸造各只发生一次", async () => {
    const fixture = credentialFixture();
    const dir = scratchDir();
    let caLoads = 0;
    let mints = 0;
    const agent = createEgressAgent({
      credentials: fixture.roster,
      relayResolver: () => fakeRelay(),
      loadEgressCa: () => {
        caLoads += 1;
        return fixture.caLoad;
      },
      hostEnv: { GH_TOKEN: "gho_FAKEenv" },
      onCredentialMint: () => {
        mints += 1;
      },
      socketPathFactory: (id) => join(dir, `agent-${id}.sock`),
      createHttpProxyServer: () => createServer(),
    });
    agents.push(agent);

    const endpoints = [];
    for (let i = 0; i < 3; i++) {
      endpoints.push(await agent.createCallEndpoint(policy()));
    }

    // The expensive profile is loaded exactly once for the whole session.
    expect(caLoads).toBe(1);
    expect(mints).toBe(1);

    // Three DIFFERENT sockets, each carrying its own one-shot call id.
    const paths = endpoints.map((e) => e.socketPath);
    expect(new Set(paths).size).toBe(3);
    const ids = endpoints.map((e) => e.id);
    expect(new Set(ids).size).toBe(3);
    for (const endpoint of endpoints) {
      expect(endpoint.id).toMatch(/^[0-9a-f]{16}$/);
      expect(endpoint.socketPath).toContain(endpoint.id);
    }

    // Each socket is tightened to owner-only (node's default for a unix
    // socket is 0777 & ~umask — the explicit chmod is the only defense).
    for (const endpoint of endpoints) {
      expect(existsSync(endpoint.socketPath)).toBe(true);
      expect(statSync(endpoint.socketPath).mode & 0o777).toBe(0o600);
    }

    // Each call owns its own sink (never a shared buffer).
    const sinks = new Set(endpoints.map((e) => e.violationSink));
    expect(sinks.size).toBe(3);

    for (const endpoint of endpoints) await endpoint.dispose();
  });

  it("懒启动：建 agent 不加载任何 profile，第一个调用才加载", async () => {
    const fixture = credentialFixture();
    let caLoads = 0;
    const agent = createEgressAgent({
      credentials: fixture.roster,
      relayResolver: () => fakeRelay(),
      loadEgressCa: () => {
        caLoads += 1;
        return fixture.caLoad;
      },
      hostEnv: { GH_TOKEN: "gho_FAKEenv" },
      socketPathFactory: (id) => join(scratchDir(), `lazy-${id}.sock`),
      createHttpProxyServer: () => createServer(),
    });
    agents.push(agent);

    expect(caLoads).toBe(0);
    await agent.ensureStarted();
    expect(caLoads).toBe(1);
    // A second explicit start is a no-op (idempotent).
    await agent.ensureStarted();
    expect(caLoads).toBe(1);
  });
});

describe("egress agent — 违规归属 (T5)", () => {
  it("违规调用与合规调用并发：违例只落在违规调用的 sink 上", async () => {
    const { seam, captured } = captureFilters();
    const dir = scratchDir();
    const agent = createEgressAgent({
      relayResolver: () => fakeRelay(),
      socketPathFactory: (id) => join(dir, `attr-${id}.sock`),
      createHttpProxyServer: seam,
    });
    agents.push(agent);

    const violating = await agent.createCallEndpoint(
      policy({
        allowedDomains: ["allowed.example"],
        commandLabel: "test:violating",
      })
    );
    const compliant = await agent.createCallEndpoint(
      policy({
        allowedDomains: ["good.example"],
        commandLabel: "test:compliant",
      })
    );
    expect(captured).toHaveLength(2);

    const [violatingFilter, compliantFilter] = captured.map((c) => c.filter);

    // Concurrent drive — the two calls overlap in time.
    const [violatingResult, compliantResult] = await Promise.all([
      violatingFilter(443, "evil.example"),
      compliantFilter(443, "good.example"),
    ]);

    expect(violatingResult).toBe(false);
    expect(compliantResult).toBe(true);

    // Attribution: the violation lands in the violating call's sink ONLY.
    expect(violating.violationSink.size()).toBe(1);
    const [record] = violating.violationSink.drain();
    expect(record!.host).toBe("evil.example");
    expect(record!.command).toBe("test:violating");
    expect(compliant.violationSink.size()).toBe(0);
    expect(compliant.violationSink.drain()).toHaveLength(0);

    await violating.dispose();
    await compliant.dispose();
  });

  it("agent 级 sink 不混入任何调用的违例", async () => {
    const { seam } = captureFilters();
    const agent = createEgressAgent({
      relayResolver: () => fakeRelay(),
      socketPathFactory: (id) => join(scratchDir(), `sink-${id}.sock`),
      createHttpProxyServer: seam,
    });
    agents.push(agent);

    const endpoint = await agent.createCallEndpoint(
      policy({ allowedDomains: ["allowed.example"] })
    );
    const agentSink = agent.violationSink;
    expect(agentSink).toBeDefined();
    // Before any call the agent sink is empty; a call's violation never lands
    // in it (the agent sink only carries profile-lifecycle records, of which
    // there are none today).
    expect(agentSink.size()).toBe(0);
    await endpoint.dispose();
  });
});

describe("egress agent — 启动失败 fail-closed (T4/D7)", () => {
  it("relay 依赖缺失：类型化错误到达调用方，且不产生任何端点", async () => {
    const { seam, captured } = captureFilters();
    const agent = createEgressAgent({
      relayResolver: () => undefined,
      socketPathFactory: (id) => join(scratchDir(), `fail-${id}.sock`),
      createHttpProxyServer: seam,
    });
    agents.push(agent);

    await expect(agent.createCallEndpoint(policy())).rejects.toBeInstanceOf(
      EgressRelayUnavailableError
    );
    // No endpoint, no proxy server instance, no socket.
    expect(captured).toHaveLength(0);
  });

  it("启动失败后可重试：第二次尝试成功拿到端点", async () => {
    let attempts = 0;
    const agent = createEgressAgent({
      relayResolver: () => {
        attempts += 1;
        return attempts === 1 ? undefined : fakeRelay();
      },
      socketPathFactory: (id) => join(scratchDir(), `retry-${id}.sock`),
      createHttpProxyServer: () => createServer(),
    });
    agents.push(agent);

    await expect(agent.createCallEndpoint(policy())).rejects.toBeInstanceOf(
      EgressRelayUnavailableError
    );
    // The failed start is not cached as a permanent state: the next attempt
    // starts a fresh profile load.
    const endpoint = await agent.createCallEndpoint(policy());
    expect(attempts).toBe(2);
    expect(existsSync(endpoint.socketPath)).toBe(true);
    await endpoint.dispose();
  });

  it("并发的首次调用只启动一个 profile（共享同一个 in-flight 启动）", async () => {
    let caLoads = 0;
    const fixture = credentialFixture();
    const agent = createEgressAgent({
      credentials: fixture.roster,
      relayResolver: () => fakeRelay(),
      loadEgressCa: () => {
        caLoads += 1;
        return fixture.caLoad;
      },
      hostEnv: { GH_TOKEN: "gho_FAKEenv" },
      socketPathFactory: (id) => join(scratchDir(), `race-${id}.sock`),
      createHttpProxyServer: () => createServer(),
    });
    agents.push(agent);

    const [a, b, c] = await Promise.all([
      agent.createCallEndpoint(policy()),
      agent.createCallEndpoint(policy()),
      agent.createCallEndpoint(policy()),
    ]);
    expect(caLoads).toBe(1);
    expect(new Set([a.socketPath, b.socketPath, c.socketPath]).size).toBe(3);
    await a.dispose();
    await b.dispose();
    await c.dispose();
  });

  it("agent 释放时仍活着的端点的隧道被断开(端点先拆,再释放凭据层)", async () => {
    const dir = scratchDir();
    const target = await startLocalTarget();
    localTargets.push(target);
    // The REAL proxy (no injected factory) — the tunnel is a real CONNECT
    // tunnel, not a stubbed server.
    const agent = createEgressAgent({
      relayResolver: () => fakeRelay(),
      socketPathFactory: (id) => join(dir, `agent-tunnel-${id}.sock`),
    });
    agents.push(agent);

    const endpoint = await agent.createCallEndpoint(
      policy({ allowedDomains: ["127.0.0.1"] })
    );
    const socketPath = endpoint.socketPath;
    const tunnel = await openConnectTunnel({
      socketPath,
      targetPort: target.port,
      proxyAuth: proxyAuthHeader(endpoint.spec.env),
    });
    expect(tunnel.received()).toContain("pong");

    // The agent's dispose tears down the endpoints it still holds …
    await agent.dispose();

    expect(existsSync(socketPath)).toBe(false);
    // … and the live tunnel goes with them.
    expect(await waitForClose(tunnel.socket, 2000)).toBe(true);
    tunnel.socket.destroy();
  });

  it("agent 释放后再建端点 → 类型化错误（不放行直连）", async () => {
    const agent = createEgressAgent({
      relayResolver: () => fakeRelay(),
      socketPathFactory: (id) => join(scratchDir(), `disposed-${id}.sock`),
      createHttpProxyServer: () => createServer(),
    });
    const endpoint = await agent.createCallEndpoint(policy());
    await endpoint.dispose();
    await agent.dispose();
    await expect(agent.createCallEndpoint(policy())).rejects.toBeInstanceOf(
      EgressAgentDisposedError
    );
  });
});

describe("egress agent — 凭据层随 dispose 释放 (T3/T4)", () => {
  it("dispose 释放凭据层：registry 清空 / masked store 删目录 / trust bundle 临时件清理", async () => {
    const fixture = credentialFixture();
    let cred: EgressCredentialResources | undefined;
    const agent = createEgressAgent({
      credentials: fixture.roster,
      relayResolver: () => fakeRelay(),
      loadEgressCa: () => fixture.caLoad,
      hostEnv: { GH_TOKEN: "gho_FAKEenv" },
      onCredentialMint: (c) => {
        cred = c;
      },
      socketPathFactory: (id) => join(scratchDir(), `release-${id}.sock`),
      createHttpProxyServer: () => createServer(),
    });
    agents.push(agent);

    await agent.ensureStarted();
    const minted = cred;
    expect(minted).toBeDefined();
    const storeDir = minted!.mint.store.dirPath;
    expect(storeDir).toBeDefined();
    expect(existsSync(storeDir!)).toBe(true);
    expect(existsSync(fixture.caLoad.ca.trustBundlePath)).toBe(true);
    expect(minted!.mint.registry.size).toBeGreaterThan(0);

    await agent.dispose();

    // The same three observables the legacy per-call session path releases
    // (egress-session-substitution.test.ts "T3 dispose").
    expect(minted!.mint.registry.size).toBe(0);
    expect(existsSync(storeDir!)).toBe(false);
    expect(existsSync(dirname(fixture.caLoad.ca.trustBundlePath))).toBe(false);

    // dispose is idempotent (a repeat call does not throw).
    await agent.dispose();
  });

  it("启动进行中被释放:解析出的凭据层立即释放(不留残留)", async () => {
    const fixture = credentialFixture();
    let cred: EgressCredentialResources | undefined;
    let storeDirAtMint: string | undefined;
    const agent = createEgressAgent({
      credentials: fixture.roster,
      relayResolver: () => fakeRelay(),
      loadEgressCa: () => fixture.caLoad,
      hostEnv: { GH_TOKEN: "gho_FAKEenv" },
      onCredentialMint: (c) => {
        cred = c;
        // The store's dir path is captured at mint time: the release clears
        // the store's own reference, so the path is only observable here.
        storeDirAtMint = c.mint.store.dirPath;
      },
      socketPathFactory: (id) => join(scratchDir(), `inflight-${id}.sock`),
      createHttpProxyServer: () => createServer(),
    });
    agents.push(agent);

    // The start is NOT awaited: the agent is released while the profile is
    // still being resolved. The profile that lands afterwards has no owner,
    // so it must be released on the spot (no credential layer left behind).
    const started = agent.ensureStarted();
    // The rejection handler is attached BEFORE the dispose: the disposal
    // takes the in-flight start over, so `started` can reject while
    // `dispose()` is still running — a rejection nobody listens for yet is an
    // unhandled rejection, and Node kills the process on one.
    const settled = expect(started).rejects.toBeInstanceOf(
      EgressAgentDisposedError
    );
    await agent.dispose();
    await settled;

    const minted = cred;
    expect(minted).toBeDefined();
    expect(minted!.mint.registry.size).toBe(0);
    expect(storeDirAtMint).toBeDefined();
    expect(existsSync(storeDirAtMint!)).toBe(false);
  });
});
