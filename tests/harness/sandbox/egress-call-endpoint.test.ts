/**
 * Tests for the per-call egress endpoint — the socket half of the
 * agent/endpoint split (`egress/session.ts` endpoint builder +
 * `egress/agent.ts` agent).
 *
 * Pinned invariants:
 *   - the endpoint owns a fresh unix socket: after `dispose()` the path is not
 *     connectable AND the socket file is gone; a second `dispose()` is a no-op
 *     (finally-safe, idempotent);
 *   - the endpoint's teardown DROPS its connections: a CONNECT tunnel that is
 *     still open when `dispose()` runs is torn down (the client socket sees the
 *     connection go away) — the socket FILE being gone is not the proof;
 *   - the endpoint's fence spec points at ITS OWN socket: `unixSocketPath` is
 *     the endpoint's path and `innerBridgeScript` embeds that same path plus
 *     the fixed in-fence port — while `env` / `binds` stay the session-level
 *     (agent) values, so two endpoints of one agent differ in exactly two
 *     fields;
 *   - the compatibility path (`createEgressSession`) still produces a working
 *     session with today's observable shape (socket live while the session
 *     lives, released on dispose).
 *
 * Injection strategy follows `egress-session.test.ts`: the relay resolver and
 * the socket path factory are the module's documented test seams.
 */

import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  type EgressAgent,
} from "../../../src/harness/sandbox/egress/agent.js";
import {
  createEgressSession,
  SANDBOX_HTTP_PROXY_PORT,
  type EgressCallEndpoint,
  type EgressCallPolicy,
  type EgressSession,
} from "../../../src/harness/sandbox/egress/session.js";
import type { EgressRelayPaths } from "../../../src/harness/sandbox/egress/relay-assets.js";

const scratchPaths: string[] = [];
const agents: EgressAgent[] = [];
const endpoints: EgressCallEndpoint[] = [];
const sessions: EgressSession[] = [];
const localTargets: LocalTarget[] = [];

function scratchDir(): string {
  const d = mkdtempSync(join(tmpdir(), "iknow-egress-endpoint-test-"));
  scratchPaths.push(d);
  return d;
}

afterEach(async () => {
  for (const e of endpoints.splice(0)) await e.dispose();
  for (const s of sessions.splice(0)) await s.dispose();
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

function policy(overrides: Partial<EgressCallPolicy> = {}): EgressCallPolicy {
  return {
    allowedDomains: ["github.com"],
    deniedDomains: [],
    commandLabel: "test:endpoint",
    ...overrides,
  };
}

/** Connect to a unix socket path — resolves to false when the path is refused. */
function canConnect(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect({ path: socketPath });
    const settle = (result: boolean): void => {
      sock.destroy();
      resolve(result);
    };
    sock.once("connect", () => settle(true));
    sock.once("error", () => settle(false));
  });
}

describe("egress call endpoint — 子 socket 生命周期 (T5)", () => {
  it("dispose 后子 socket 不可连接且文件消失；重复 dispose 是 no-op", async () => {
    const dir = scratchDir();
    const agent = createEgressAgent({
      relayResolver: () => fakeRelay(),
      socketPathFactory: (id) => join(dir, `ep-${id}.sock`),
      createHttpProxyServer: () => createServer(),
    });
    agents.push(agent);

    const endpoint = await agent.createCallEndpoint(policy());
    endpoints.push(endpoint);
    const socketPath = endpoint.socketPath;

    // While the call lives the socket is really there and listening.
    expect(existsSync(socketPath)).toBe(true);
    expect(statSync(socketPath).mode & 0o777).toBe(0o600);
    expect(await canConnect(socketPath)).toBe(true);

    await endpoint.dispose();

    // Gone from disk AND not connectable any more.
    expect(existsSync(socketPath)).toBe(false);
    expect(await canConnect(socketPath)).toBe(false);

    // Idempotent: a second (and third) dispose neither throws nor warns.
    await endpoint.dispose();
    await endpoint.dispose();
  });

  it("dispose 时活跃的 CONNECT 隧道被断开(连接被 drop,不只是删文件)", async () => {
    const dir = scratchDir();
    const target = await startLocalTarget();
    localTargets.push(target);
    // The REAL proxy (no injected factory) — the tunnel is a real CONNECT
    // tunnel, not a stubbed server.
    const agent = createEgressAgent({
      relayResolver: () => fakeRelay(),
      socketPathFactory: (id) => join(dir, `tunnel-${id}.sock`),
    });
    agents.push(agent);

    const endpoint = await agent.createCallEndpoint(
      policy({ allowedDomains: ["127.0.0.1"] })
    );
    endpoints.push(endpoint);
    const socketPath = endpoint.socketPath;

    // The proxy token rides the fence spec's proxy URL — the client must
    // authenticate with it (the proxy answers 407 otherwise).
    const tunnel = await openConnectTunnel({
      socketPath,
      targetPort: target.port,
      proxyAuth: proxyAuthHeader(endpoint.spec.env),
    });
    // The tunnel is live: the local target answered through it.
    expect(tunnel.received()).toContain("pong");
    // The exact frames the client observed on the wire: the tunnel
    // establishment and the local target's answer travelling back.
    expect(tunnel.received()).toContain(
      "HTTP/1.1 200 Connection Established\r\n\r\n"
    );
    expect(tunnel.received()).toContain("HTTP/1.1 200 OK");

    await endpoint.dispose();

    // The socket file is gone …
    expect(existsSync(socketPath)).toBe(false);
    // … AND the live tunnel is dropped: the client socket is closed. A
    // surviving tunnel would keep the client socket open.
    expect(await waitForClose(tunnel.socket, 2000)).toBe(true);
    tunnel.socket.destroy();
  });

  it("每个端点的 spec 指向自己的 socket；env / binds 保持会话级", async () => {
    const dir = scratchDir();
    const agent = createEgressAgent({
      relayResolver: () => fakeRelay(),
      socketPathFactory: (id) => join(dir, `spec-${id}.sock`),
      createHttpProxyServer: () => createServer(),
    });
    agents.push(agent);

    const first = await agent.createCallEndpoint(policy({ commandLabel: "a" }));
    const second = await agent.createCallEndpoint(
      policy({ commandLabel: "b" })
    );
    endpoints.push(first, second);

    // The spec points at the endpoint's own socket.
    expect(first.spec.unixSocketPath).toBe(first.socketPath);
    expect(second.spec.unixSocketPath).toBe(second.socketPath);
    expect(first.spec.unixSocketPath).not.toBe(second.spec.unixSocketPath);

    // The in-fence bridge script embeds that same socket path + the fixed
    // in-fence port (the port is per-fence, each call gets a fresh netns).
    expect(first.spec.innerBridgeScript).toContain(first.socketPath);
    expect(first.spec.innerBridgeScript).toContain(
      String(SANDBOX_HTTP_PROXY_PORT)
    );
    expect(first.spec.sandboxLocalPort).toBe(SANDBOX_HTTP_PROXY_PORT);
    expect(second.spec.innerBridgeScript).toContain(second.socketPath);
    expect(second.spec.innerBridgeScript).not.toContain(first.socketPath);

    // env / binds are the session-level (agent) values — identical across the
    // two endpoints of the same agent.
    expect(first.spec.env).toEqual(second.spec.env);
    expect(first.spec.env.HTTP_PROXY).toMatch(
      /^http:\/\/iknow:[0-9a-f]{64}@127\.0\.0\.1:3128$/
    );
    expect(first.spec.binds).toEqual(second.spec.binds);
  });
});

describe("egress compatibility path — createEgressSession 仍然可用", () => {
  it("产出与今天同形的会话：socket 存活 + spec 形状 + dispose 释放", async () => {
    const dir = scratchDir();
    const relay = fakeRelay();
    const session = await createEgressSession({
      policy: {
        allowedDomains: ["github.com"],
        deniedDomains: [],
        commandLabel: "test:compat",
      },
      relayResolver: () => relay,
      socketPathFactory: (id) => join(dir, `compat-${id}.sock`),
    });
    sessions.push(session);

    expect(session.id).toMatch(/^[0-9a-f]{16}$/);
    expect(session.spec.unixSocketPath).toMatch(/\.sock$/);
    expect(existsSync(session.spec.unixSocketPath)).toBe(true);
    expect(session.spec.sandboxLocalPort).toBe(SANDBOX_HTTP_PROXY_PORT);
    expect(session.spec.relayAssetsDir).toBe(relay.relayDir);
    expect(session.spec.env.HTTP_PROXY).toMatch(
      /^http:\/\/iknow:[0-9a-f]{64}@127\.0\.0\.1:3128$/
    );
    expect(session.violationSink.size()).toBe(0);

    const socketPath = session.spec.unixSocketPath;
    await session.dispose();
    expect(existsSync(socketPath)).toBe(false);
    // Idempotent.
    await session.dispose();
  });
});
