/**
 * Tests for `egress/session.ts` — egress session lifecycle in its post-ADR-0107
 * shape.
 *
 * Pinned invariants (from ADR-0097's proxy lifecycle / dispose contract, the
 * spec's ownership/dispose and failure-path sections, specs/egress-ssh-bridge.md,
 * and ADR-0107 Decision 5):
 *   - start succeeds → spec.env carries HTTP_PROXY / HTTPS_PROXY / ALL_PROXY /
 *     NO_PROXY plus the lowercase aliases; the proxy URL embeds auth userinfo
 *     (with proxyAuthToken configured, a userinfo-less URL would dead-end at
 *     CONNECT with 407 inside the sandbox);
 *   - spec.unixSocketPath = the factory-returned path and the proxy server
 *     listens directly on that unix socket (ADR-0107: no host socat bridge, no
 *     TCP — the socket file really exists while the session lives and disappears
 *     after dispose);
 *   - spec.sandboxLocalPort = the fixed in-sandbox listen port (breaking the
 *     old host/sandbox same-port coincidence coupling);
 *   - spec.relayAssetsDir = the bundled relay asset dir (the fence `--ro-bind` target);
 *   - spec.innerBridgeScript = the verbatim inner relay preamble (`<node> <relay
 *     script> <sock> <port> &` + trap kill EXIT), the rework counterpart of the
 *     old single socat TCP-LISTEN bridge;
 *   - relay product dependency missing (resolver returns undefined) → typed
 *     `EgressRelayUnavailableError` whose guidance names **this product
 *     dependency** and never mentions socat/apt installation (ADR-0107);
 *   - dispose is idempotent: repeated calls neither throw nor error;
 *   - failure-path release: with the resolver absent, dispose has no side
 *     effects (nothing to clean up);
 *   - one independent token per session (prevents other host processes from
 *     bypassing the filter via direct connection).
 *
 * Injection strategy: relayResolver / socketPathFactory / createHttpProxyServer
 * are all parameterized so the test depends on neither the host node layout nor
 * asset placement; the proxy server is real (plain node:http listening on a
 * unix socket).
 */

import {
  mkdtempSync,
  rmSync,
  existsSync,
  writeFileSync,
  statSync,
} from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildInnerBridgeScript,
  buildProxyEnv,
  createEgressSession,
  EgressRelayUnavailableError,
  SANDBOX_HTTP_PROXY_PORT,
  wrapCommandWithInnerBridge,
  type EgressSession,
} from "../../../src/harness/sandbox/egress/session.js";
import type { EgressRelayPaths } from "../../../src/harness/sandbox/egress/relay-assets.js";

const scratchPaths: string[] = [];

function scratchDir(): string {
  const d = mkdtempSync(join(tmpdir(), "iknow-egress-test-"));
  scratchPaths.push(d);
  return d;
}

afterEach(() => {
  for (const p of scratchPaths.splice(0)) {
    rmSync(p, { recursive: true, force: true });
  }
});

/** Fixed fake relay path set — unit tests never probe host existence (resolver seam given directly). */
function fakeRelay(dir: string): EgressRelayPaths {
  const relayDir = join(dir, "vendor", "egress-relay");
  return {
    nodePath: "/test-root/bin/node",
    relayDir,
    bridgeScriptPath: join(relayDir, "egress-tcp-relay.mjs"),
    connectScriptPath: join(relayDir, "egress-http-connect.mjs"),
  };
}

/** While the session lives, the unix socket really answers one proxied request (proof of real listen). */
function probeSocketReply(socketPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = connect({ path: socketPath });
    let head = "";
    const timer = setTimeout(
      () => reject(new Error("egress unix socket reply timeout")),
      2000
    );
    sock.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    sock.on("data", (chunk) => {
      head += chunk.toString("latin1");
      if (head.includes("\r\n")) {
        clearTimeout(timer);
        sock.destroy();
        resolve(head);
      }
    });
    sock.on("connect", () => {
      sock.write("GET http://filtered.invalid/ HTTP/1.1\r\nHost: x\r\n\r\n");
    });
  });
}

describe("createEgressSession — lifecycle", () => {
  it("fails typed (EgressRelayUnavailableError) when relay deps are missing", async () => {
    let err: unknown;
    try {
      await createEgressSession({
        policy: {
          allowedDomains: ["github.com"],
          deniedDomains: [],
          commandLabel: "test",
        },
        relayResolver: () => undefined,
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(EgressRelayUnavailableError);
    const e = err as EgressRelayUnavailableError;
    expect(e.detail).toContain("egress relay");
    // ADR-0107 Decision 5: guidance = this product dependency, and it must never
    // mention socat/apt installation (the old "Install socat … apt install" text
    // retired with the rework; pinned in reverse so it cannot return).
    expect(e.message).toMatch(/iknow|install root/i);
    expect(e.message).not.toMatch(/socat/i);
    expect(e.message).not.toMatch(/\bapt\b/i);
  });

  it("starts an HTTP proxy listening directly on the unix socket (no host bridge)", async () => {
    const dir = scratchDir();
    const relay = fakeRelay(dir);
    const session = await createEgressSession({
      policy: {
        allowedDomains: ["github.com"],
        deniedDomains: [],
        commandLabel: "test:start",
      },
      relayResolver: () => relay,
      socketPathFactory: (id) => join(dir, `egress-${id}.sock`),
    });
    try {
      // ADR-0107: the host side spawns no bridge process at all — the proxy
      // server itself listens on the unix socket, which exists and answers for
      // the session's lifetime.
      expect(session.spec.unixSocketPath).toMatch(/\.sock$/);
      expect(existsSync(session.spec.unixSocketPath)).toBe(true);
      const reply = await probeSocketReply(session.spec.unixSocketPath);
      // a request without Proxy-Authorization is rejected by the upstream
      // checkAuth → getting a status line back proves the reworked shape: a bare
      // http Server listening directly on the unix socket.
      expect(reply).toMatch(/^HTTP\/1\.[01] (403|407)/);

      // spec shape: sandboxLocalPort is the fixed in-sandbox listen port (the
      // host/sandbox same-port coupling is gone) and always equals the constant.
      expect(session.spec.sandboxLocalPort).toBe(SANDBOX_HTTP_PROXY_PORT);
      expect(SANDBOX_HTTP_PROXY_PORT).toBe(3128);
      // the relay assets dir enters the spec (consumed as the fence ro-bind target).
      expect(session.spec.relayAssetsDir).toBe(relay.relayDir);

      // env carries the proxy keys + lowercase aliases + NO_PROXY; the URL embeds
      // auth userinfo (token = the session's randomBytes(32) hex, checked at the
      // Basic password position by checkAuth; the username is a fixed label).
      const env = session.spec.env;
      expect(env.HTTP_PROXY).toMatch(
        /^http:\/\/iknow:[0-9a-f]{64}@127\.0\.0\.1:3128$/
      );
      expect(env.HTTPS_PROXY).toBe(env.HTTP_PROXY);
      expect(env.ALL_PROXY).toBe(env.HTTP_PROXY);
      expect(env.NO_PROXY).toContain("127.0.0.1");
      expect(env.NO_PROXY).toContain("localhost");
      expect(env.http_proxy).toBe(env.HTTP_PROXY);
      expect(env.https_proxy).toBe(env.HTTPS_PROXY);
      expect(env.no_proxy).toBe(env.NO_PROXY);

      // GIT_SSH_COMMAND under ADR-0107's frozen form: ProxyCommand = the bundled
      // CONNECT tunnel piece, token kept out of argv (carried via the HTTP_PROXY
      // env); node / script paths each go through shellSingleQuote (same policy as
      // buildInnerBridgeScript); git split_cmdline strips the outer double quotes
      // and ssh ProxyCommand's /bin/sh handles the inner single quotes.
      expect(env.GIT_SSH_COMMAND).toMatch(
        /^ssh -F \/dev\/null -o ControlMaster=no -o ControlPath=none -o ProxyCommand="'\/test-root\/bin\/node' '.+egress-http-connect\.mjs' %h %p"$/
      );
      expect(env.GIT_SSH_COMMAND).not.toMatch(/socat|proxyauth/i);

      // verbatim shape of the inner relay preamble: single bridge (node relay on
      // 3128 → unix socket) + trap kill EXIT. No assertion of real in-fence
      // listening (that is the probe:sandbox end-to-end branch's job).
      expect(session.spec.innerBridgeScript).toBe(
        buildInnerBridgeScript(
          relay.nodePath,
          relay.bridgeScriptPath,
          session.spec.unixSocketPath
        )
      );
      expect(session.spec.innerBridgeScript).toContain("egress-tcp-relay.mjs");
      expect(session.spec.innerBridgeScript).toContain(" 3128 ");
      expect(session.spec.innerBridgeScript).toContain(
        'trap "kill %1 2>/dev/null; exit" EXIT'
      );
      // The 1080/SOCKS stage was cut from this line by operator decision and must not appear.
      expect(session.spec.innerBridgeScript).not.toContain("1080");

      // the session id is 16 hex chars
      expect(session.id).toMatch(/^[0-9a-f]{16}$/);
    } finally {
      await session.dispose();
    }
  });

  it("dispose releases the socket (idempotent, safe in finally)", async () => {
    const dir = scratchDir();
    const session = await createEgressSession({
      policy: {
        allowedDomains: ["github.com"],
        deniedDomains: [],
        commandLabel: "test:dispose",
      },
      relayResolver: () => fakeRelay(dir),
      socketPathFactory: (id) => join(dir, `egress-${id}.sock`),
    });
    const sockPath = session.spec.unixSocketPath;
    expect(existsSync(sockPath)).toBe(true);
    // first dispose does not throw and really reclaims resources (server closed, socket removed)
    await session.dispose();
    expect(existsSync(sockPath)).toBe(false);
    // second and third calls likewise do not throw (finally-safe)
    await session.dispose();
    await session.dispose();
  });

  it("cleans up stale socket on startup (spec §Failure paths)", async () => {
    // pre-place a stale socket file — simulating a previous session that never released it.
    const dir = scratchDir();
    const stalePath = join(dir, "egress-stale.sock");
    writeFileSync(stalePath, "");

    const session = await createEgressSession({
      policy: {
        allowedDomains: ["github.com"],
        deniedDomains: [],
        commandLabel: "test:stale",
      },
      relayResolver: () => fakeRelay(dir),
      socketPathFactory: () => stalePath, // fixed injected path (same as the stale file)
    });
    try {
      // the session coming up already proves the stale file was cleared and the
      // listen took its place (no throw = the socket file was really replaced —
      // the old empty file carried no listening semantics).
      expect(session.spec.unixSocketPath).toBe(stalePath);
      const reply = await probeSocketReply(stalePath);
      expect(reply).toMatch(/^HTTP\/1\.[01] /);
    } finally {
      await session.dispose();
    }
  });

  it("tightens the unix socket to 0600 after listen (local exposure hardening)", async () => {
    // the socket lands in shared /tmp and node's default mode is 0777 & ~umask
    // (often 0755/0777), so other local users could connect. The token is briefly
    // globally visible via bwrap --setenv argv (/proc cmdline; a known residual
    // surface, see the threat-model note in session.ts), so the socket file mode
    // is the only effective defense against filter bypass — it must be tightened
    // to owner read/write only.
    const dir = scratchDir();
    const session = await createEgressSession({
      policy: {
        allowedDomains: ["github.com"],
        deniedDomains: [],
        commandLabel: "test:socket-mode",
      },
      relayResolver: () => fakeRelay(dir),
      socketPathFactory: (id) => join(dir, `egress-${id}.sock`),
    });
    try {
      const mode = statSync(session.spec.unixSocketPath).mode & 0o777;
      expect(mode).toBe(0o600);
    } finally {
      await session.dispose();
    }
  });

  it("generates a fresh token per session (isolation between concurrent sessions)", async () => {
    // only observe that sandboxLocalPort + id + token (surfaced via the env URL)
    // differ; the server-side proxyAuthToken is not exposed through spec, so no
    // behavior is distorted.
    const dir = scratchDir();
    const session1: EgressSession = await createEgressSession({
      policy: {
        allowedDomains: ["github.com"],
        deniedDomains: [],
        commandLabel: "test:concurrent-1",
      },
      relayResolver: () => fakeRelay(dir),
      socketPathFactory: (id) => join(dir, `e1-${id}.sock`),
    });
    const session2: EgressSession = await createEgressSession({
      policy: {
        allowedDomains: ["github.com"],
        deniedDomains: [],
        commandLabel: "test:concurrent-2",
      },
      relayResolver: () => fakeRelay(dir),
      socketPathFactory: (id) => join(dir, `e2-${id}.sock`),
    });
    try {
      expect(session1.id).not.toBe(session2.id);
      expect(session1.spec.unixSocketPath).not.toBe(
        session2.spec.unixSocketPath
      );
      // per-session token independence: the two proxy URLs' userinfo must differ
      // (blocks cross-session direct-connection filter bypass).
      expect(new URL(session1.spec.env.HTTP_PROXY).password).not.toBe(
        new URL(session2.spec.env.HTTP_PROXY).password
      );
    } finally {
      await Promise.all([session1.dispose(), session2.dispose()]);
    }
  });
});

describe("buildProxyEnv", () => {
  const relay = fakeRelay("/test-root");

  it("exposes upper and lower-case aliases with auth userinfo (O1 407 死路清偿)", () => {
    const env = buildProxyEnv(3128, "t0k3n", relay);
    const url = "http://iknow:t0k3n@127.0.0.1:3128";
    expect(env.HTTP_PROXY).toBe(url);
    expect(env.HTTPS_PROXY).toBe(url);
    expect(env.ALL_PROXY).toBe(url);
    expect(env.http_proxy).toBe(url);
    expect(env.https_proxy).toBe(url);
    expect(env.all_proxy).toBe(url);
    expect(env.NO_PROXY).toContain("127.0.0.1");
    expect(env.no_proxy).toBe(env.NO_PROXY);
  });

  it("appends extra NO_PROXY entries", () => {
    const env = buildProxyEnv(3128, "t0k3n", relay, [
      "internal.example",
      "10.0.0.0/8",
    ]);
    expect(env.NO_PROXY).toContain("internal.example");
    expect(env.NO_PROXY).toContain("10.0.0.0/8");
  });

  it("injects GIT_SSH_COMMAND verbatim per ADR-0107 re-skinned T3 form", () => {
    // character-exact = the frozen form in specs/egress-ssh-bridge.md: `-F /dev/null`
    // (assumption 4: inside the fence, /etc/ssh/ssh_config.d errors "Bad owner or
    // permissions"), mux neutralized, ProxyCommand = the bundled CONNECT tunnel
    // piece (token stays out of the string, arriving via the HTTP_PROXY env from
    // the same source).
    const env = buildProxyEnv(3128, "t0k3n", relay);
    expect(env.GIT_SSH_COMMAND).toBe(
      "ssh -F /dev/null -o ControlMaster=no -o ControlPath=none " +
        `-o ProxyCommand="'/test-root/bin/node' '${relay.connectScriptPath}' %h %p"`
    );
  });

  it("proxy URLs track sandboxLocalPort (no hardcoded port drift)", () => {
    // the old form's port-following pin (proxyport= inside ProxyCommand) moved to
    // the three URL keys with the ADR-0107 rework: port drift would decouple the
    // proxy env from the inner relay just as badly, so it must still go red.
    const env = buildProxyEnv(3129, "t0k3n", relay);
    expect(env.HTTP_PROXY).toContain("@127.0.0.1:3129");
    expect(env.NO_PROXY).toBe("127.0.0.1,localhost");
  });
});

describe("buildInnerBridgeScript", () => {
  it("pins the single-bridge leading script verbatim (T1 前导形态，0107 换装 + 就绪轮询)", () => {
    const script = buildInnerBridgeScript(
      "/usr/bin/node",
      "/opt/iknow/vendor/egress-relay/egress-tcp-relay.mjs",
      "/tmp/e-abc.sock"
    );
    expect(script).toBe(
      [
        "'/usr/bin/node' '/opt/iknow/vendor/egress-relay/egress-tcp-relay.mjs' " +
          "'/tmp/e-abc.sock' 3128 >/dev/null 2>&1 &",
        'trap "kill %1 2>/dev/null; exit" EXIT',
        // the readiness poll absorbs the node relay's cold-start race (observed:
        // the first bare curl hit ECONNREFUSED exit 7); a failed probe must not
        // block the user's command (fail-closed is preserved).
        "for _ in $(seq 1 50); do (exec 3<>/dev/tcp/127.0.0.1/3128) " +
          "2>/dev/null && break; sleep 0.1; done",
      ].join("\n")
    );
  });

  it("就绪轮询端口跟随 sandboxPort 入参（非硬编码 3128）", () => {
    const script = buildInnerBridgeScript(
      "/usr/bin/node",
      "/opt/iknow/vendor/egress-relay/egress-tcp-relay.mjs",
      "/tmp/e-abc.sock",
      4128
    );
    expect(script).toContain("/dev/tcp/127.0.0.1/4128");
    expect(script).toContain("'/tmp/e-abc.sock' 4128 >/dev/null 2>&1 &");
  });

  it("shell-quotes hostile node / relay / socket paths so the chain stays one command", () => {
    const script = buildInnerBridgeScript(
      "/usr/bi'n/node",
      "/opt/ev'il/egress-tcp-relay.mjs",
      "/tmp/it's-a-sock.sock"
    );
    // single-quote wrapping with inner `'` closed-and-reopened as `'\''` (the POSIX standard escape form).
    expect(script).toContain(`'/usr/bi'\\''n/node'`);
    expect(script).toContain(`'/opt/ev'\\''il/egress-tcp-relay.mjs'`);
    expect(script).toContain(`'/tmp/it'\\''s-a-sock.sock'`);
  });
});

describe("wrapCommandWithInnerBridge — 内层前导单点 helper (review Medium 收敛)", () => {
  const spec = {
    unixSocketPath: "/tmp/x.sock",
    sandboxLocalPort: 3128,
    env: {},
    innerBridgeScript: "BRIDGE",
    relayAssetsDir: "/test-root/vendor/egress-relay",
  } satisfies import("../../../src/harness/sandbox/egress/session.js").EgressFenceSpec;

  it("spec 缺席（undefined）→ 返回原命令 byte-identical（invariant 3 无缝=无桥）", () => {
    expect(wrapCommandWithInnerBridge(undefined, "git push")).toBe("git push");
    expect(wrapCommandWithInnerBridge(undefined, "")).toBe("");
  });

  it("spec 在场 → `<innerBridgeScript>\\n<command>` 单点形态（三消费面共用）", () => {
    expect(wrapCommandWithInnerBridge(spec, "git push")).toBe(
      "BRIDGE\ngit push"
    );
  });
});
