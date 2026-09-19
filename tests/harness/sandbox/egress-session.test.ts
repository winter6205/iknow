/**
 * Tests for `egress/session.ts` — T4 egress session lifecycle（ADR-0107 换装后形态）。
 *
 * 钉住的不变式（来自 ADR-0097「代理生命周期 / dispose 契约」+ spec §Ownership /
 * dispose contract + spec §Failure paths + specs/egress-ssh-bridge.md T1/T3 +
 * ADR-0107 §Decision 5）：
 *   - start 成功 → spec.env 含 HTTP_PROXY / HTTPS_PROXY / ALL_PROXY / NO_PROXY
 *     与 http_proxy / https_proxy / all_proxy / no_proxy 小写别名；
 *     代理 URL 嵌 auth userinfo（O1 清偿：宿主代理配了 proxyAuthToken，
 *     无 userinfo 的 URL 在沙箱内 CONNECT 必 407 死路）；
 *   - spec.unixSocketPath = 工厂返回路径，且代理 server **直接 listen 该
 *     unix socket**（ADR-0107：宿主无 socat 桥、无 TCP —— session 存续期
 *     socket 文件真实在场，dispose 后消失）；
 *   - spec.sandboxLocalPort = 沙箱内固定监听号（T1：解除宿主/沙箱同号巧合
 *     耦合）；
 *   - spec.relayAssetsDir = 自带中继资产目录（fence `--ro-bind` 目标）；
 *   - spec.innerBridgeScript = 逐字内层中继前导（`<node> <中继脚本> <sock>
 *     <port> &` + trap kill EXIT，换装对应旧 socat TCP-LISTEN 单桥形态）；
 *   - 中继产品依赖缺席（resolver 返 undefined）→ typed
 *     `EgressRelayUnavailableError`，指引是**本产品依赖**且**绝不含
 *     socat/apt 装包字样**（ADR-0107 SC13 换装对应验收）；
 *   - dispose 幂等：重复调用不抛、不报错；
 *   - 异常路径释放：resolver 缺席时 dispose 无副作用（无 session 可清理）；
 *   - 每 session token 独立（防宿主其他进程直连绕过 filter）。
 *
 * 注入策略：relayResolver / socketPathFactory / createHttpProxyServer 全部
 * 入参化，让本测试不依赖宿主 node 布局与资产落位；代理 server 真起（裸
 * node:http listen unix socket）。
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

/** 固定假中继路径集 —— 单测不查宿主存在性（resolver seam 直给）。 */
function fakeRelay(dir: string): EgressRelayPaths {
  const relayDir = join(dir, "vendor", "egress-relay");
  return {
    nodePath: "/test-root/bin/node",
    relayDir,
    bridgeScriptPath: join(relayDir, "egress-tcp-relay.mjs"),
    connectScriptPath: join(relayDir, "egress-http-connect.mjs"),
  };
}

/** session 存续期内 unix socket 上真有一次可应答的代理连接（真 listen 证据）。 */
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
    // ADR-0107 §Decision 5：指引 = 本产品依赖，**绝不含 socat/apt 装包字样**
    // （旧「Install socat … apt install」文案随换装退役，反向钉死不回潮）。
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
      // ADR-0107：宿主侧不再 spawn 任何桥进程 —— 代理 server 本体
      // listen unix socket，session 存续期 socket 在场且可应答。
      expect(session.spec.unixSocketPath).toMatch(/\.sock$/);
      expect(existsSync(session.spec.unixSocketPath)).toBe(true);
      const reply = await probeSocketReply(session.spec.unixSocketPath);
      // 无 Proxy-Authorization 的请求被上游 checkAuth 拒 → 状态行回来即
      // 证明「裸 http Server 直接听在 unix socket 上」的换装形态成立。
      expect(reply).toMatch(/^HTTP\/1\.[01] (403|407)/);

      // spec 形状
      // T1（O3 同号耦合解除）：sandboxLocalPort 是「沙箱内固定监听号」，
      // 恒等于常量。
      expect(session.spec.sandboxLocalPort).toBe(SANDBOX_HTTP_PROXY_PORT);
      expect(SANDBOX_HTTP_PROXY_PORT).toBe(3128);
      // 中继资产目录进 spec（fence ro-bind 消费面）。
      expect(session.spec.relayAssetsDir).toBe(relay.relayDir);

      // env 含 HTTP_PROXY 三键 + 小写别名 + NO_PROXY；URL 嵌 auth userinfo
      // （O1 清偿：token = session 的 randomBytes(32) hex，经 checkAuth 的
      // Basic 密码位校验；用户名固定 label）。
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

      // T3（ADR-0107 新冻结形态 + review Low 引号统一）：GIT_SSH_COMMAND 的
      // ProxyCommand = 自带 CONNECT 隧道件，token 不进 argv（从 HTTP_PROXY
      // env 走）；node / 脚本路径逐一走 shellSingleQuote（与
      // buildInnerBridgeScript 同策略），外层双引号由 git split_cmdline
      // 剥除、内层单引号由 ssh ProxyCommand 的 /bin/sh 处理。
      expect(env.GIT_SSH_COMMAND).toMatch(
        /^ssh -F \/dev\/null -o ControlMaster=no -o ControlPath=none -o ProxyCommand="'\/test-root\/bin\/node' '.+egress-http-connect\.mjs' %h %p"$/
      );
      expect(env.GIT_SSH_COMMAND).not.toMatch(/socat|proxyauth/i);

      // 内层中继前导逐字形状：单桥（node 中继 3128 → unix socket）+ trap kill
      // EXIT。不断言围栏内真监听（那是 probe:sandbox 端到端分支的职责）。
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
      // 1080 / SOCKS 段已被操作员裁定摘出本分支（子弹 2），不得出现。
      expect(session.spec.innerBridgeScript).not.toContain("1080");

      // session id 是 16 hex chars
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
    // 第一次 dispose 不抛 + 真收资源（server 关闭、socket 删除）
    await session.dispose();
    expect(existsSync(sockPath)).toBe(false);
    // 第二、三次同样不抛（finally-safe）
    await session.dispose();
    await session.dispose();
  });

  it("cleans up stale socket on startup (spec §Failure paths)", async () => {
    // 预置一个 stale socket 文件 —— 模拟上次会话未释放。
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
      socketPathFactory: () => stalePath, // 注入固定路径（与 stale 一致）
    });
    try {
      // session 起来了即说明 stale 被清掉且 listen 成功占位（不抛 = 真换装
      // 了 socket 文件 —— 旧空文件不存在监听语义）。
      expect(session.spec.unixSocketPath).toBe(stalePath);
      const reply = await probeSocketReply(stalePath);
      expect(reply).toMatch(/^HTTP\/1\.[01] /);
    } finally {
      await session.dispose();
    }
  });

  it("tightens the unix socket to 0600 after listen (local exposure hardening)", async () => {
    // review 修复（安全 Medium）：socket 落共享 /tmp，node 默认 mode =
    // 0777 & ~umask（常为 0755/0777），本地他用户可 connect。token 经
    // bwrap --setenv argv 短暂全局可见（/proc cmdline，已知残余面，见
    // session.ts 威胁模型注释），所以 socket 文件权限是 filter 旁路的
    // **唯一有效防线** —— 必须收紧到仅 owner 可读写。
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
    // 仅观察 sandboxLocalPort + id + token（经 env URL 露出）不同；
    // server 侧 proxyAuthToken 不经 spec 暴露，行为不变形。
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
      // token 独立：两 session 的代理 URL userinfo 必不同（防跨 session
      // 直连绕过 filter）。
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
    // 逐字符 = specs/egress-ssh-bridge.md §T3 新冻结形态：`-F /dev/null`
    // （assumption 4：围栏内 /etc/ssh/ssh_config.d 报 Bad owner or
    // permissions）、mux 中和、ProxyCommand = 自带 CONNECT 隧道件（token
    // 不进串，经 HTTP_PROXY env 同源）。
    const env = buildProxyEnv(3128, "t0k3n", relay);
    expect(env.GIT_SSH_COMMAND).toBe(
      "ssh -F /dev/null -o ControlMaster=no -o ControlPath=none " +
        `-o ProxyCommand="'/test-root/bin/node' '${relay.connectScriptPath}' %h %p"`
    );
  });

  it("proxy URLs track sandboxLocalPort (no hardcoded port drift)", () => {
    // 旧形态的端口跟随钉子（ProxyCommand 内 proxyport=）随 ADR-0107 换装
    // 移到三键 URL：端口漂移会让代理 env 与内层中继脱钩，同样必须红。
    const env = buildProxyEnv(3129, "t0k3n", relay);
    expect(env.HTTP_PROXY).toContain("@127.0.0.1:3129");
    expect(env.NO_PROXY).toBe("127.0.0.1,localhost");
  });
});

describe("buildInnerBridgeScript", () => {
  it("pins the single-bridge leading script verbatim (T1 前导形态，0107 换装)", () => {
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
      ].join("\n")
    );
  });

  it("shell-quotes hostile node / relay / socket paths so the chain stays one command", () => {
    const script = buildInnerBridgeScript(
      "/usr/bi'n/node",
      "/opt/ev'il/egress-tcp-relay.mjs",
      "/tmp/it's-a-sock.sock"
    );
    // 单引号包裹 + 内部 `'` 以 `'\''` 断开重开（POSIX 标准 escape 形态）。
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
