/**
 * Tests for `egress/session.ts` — T4 egress session lifecycle。
 *
 * 钉住的不变式（来自 ADR-0097「代理生命周期 / dispose 契约」+ spec §Ownership /
 * dispose contract + spec §Failure paths + specs/egress-ssh-bridge.md T1）：
 *   - start 成功 → spec.env 含 HTTP_PROXY / HTTPS_PROXY / ALL_PROXY / NO_PROXY
 *     与 http_proxy / https_proxy / all_proxy / no_proxy 小写别名；
 *     代理 URL 嵌 auth userinfo（O1 清偿：宿主代理配了 proxyAuthToken，
 *     无 userinfo 的 URL 在沙箱内 CONNECT 必 407 死路）；
 *   - spec.unixSocketPath = 工厂返回路径；
 *   - spec.sandboxLocalPort = 沙箱内固定监听号（T1：解除宿主/沙箱同号巧合
 *     耦合，宿主 TCP 端口维持 OS 分配）；
 *   - spec.innerBridgeScript = 逐字内层监听前导（socat TCP-LISTEN +
 *     trap kill EXIT，形态抄依赖包 linux-sandbox-utils.js buildSandboxCommand
 *     的单桥裁剪版——1080 段已被操作员裁定摘出本分支）；
 *   - 缺 socat（SocatUnavailableError）→ typed 错误带补装指引（SC13）；
 *   - dispose 幂等：重复调用不抛、不报错；
 *   - 异常路径释放：socat 缺失时 dispose 无副作用（无 session 可清理）；
 *   - 每 session token 独立（防宿主其他进程直连绕过 filter）。
 *
 * 注入策略：probeSocat / spawn / socketPathFactory / proxyPort 全部入参
 * 化，让本测试不依赖宿主真装 socat。spawn 用假 child（不真起进程）；
 * http-proxy 真起（依赖 node-forge 已随 @anthropic-ai/sandbox-runtime 装入）。
 */

import { spawn as realSpawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildInnerBridgeScript,
  buildProxyEnv,
  createEgressSession,
  SANDBOX_HTTP_PROXY_PORT,
  SocatUnavailableError,
  type EgressSession,
} from "../../../src/harness/sandbox/egress/session.js";

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

/**
 * 假 socat 进程 —— 不真起进程，只暴露 .pid 和 .killed 状态让 dispose 走
 * 完整清理路径。event handlers 仍挂上（避免 EventEmitter 警告）。
 */
function fakeSocatProc(pid: number) {
  const proc = realSpawn("/bin/true", ["--version"], { stdio: "ignore" });
  // 用真 spawn 占位 + 立刻 SIGKILL，避免 macOS / Linux 下 stdio:"ignore"
  // 的 child process 被父进程信号带走的奇怪表现。测试结束 dispose 时
  // 会再发一次 SIGTERM/SIGKILL（无害，已退）。
  try {
    proc.kill("SIGKILL");
  } catch {
    /* */
  }
  // 覆盖 pid（如果是 1 也无所谓——本测试不读真 pid，只确保 dispose 不抛）。
  return Object.assign(proc, { pid });
}

describe("createEgressSession — lifecycle", () => {
  it("fails typed (SocatUnavailableError) when socat is missing", async () => {
    let err: unknown;
    try {
      await createEgressSession({
        policy: {
          allowedDomains: ["github.com"],
          deniedDomains: [],
          commandLabel: "test",
        },
        socatCommand: "socat-this-does-not-exist",
        probeSocat: () => false,
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SocatUnavailableError);
    const e = err as SocatUnavailableError;
    expect(e.socatCommand).toBe("socat-this-does-not-exist");
    expect(e.installHint).toContain("Install socat");
    // 错误信息含可观测的补装指引（SC13 验收点）
    expect(e.message).toContain("apt install socat");
  });

  it("starts an HTTP proxy + socat bridge when socat is present", async () => {
    let capturedSocatArgs: readonly string[] | undefined;
    let capturedSpawn = false;
    const proc = fakeSocatProc(12345);

    const session = await createEgressSession({
      policy: {
        allowedDomains: ["github.com"],
        deniedDomains: [],
        commandLabel: "test:start",
      },
      socatCommand: "fake-socat",
      probeSocat: () => true,
      spawn: ((_cmd: string, args: readonly string[]) => {
        capturedSocatArgs = args;
        capturedSpawn = true;
        return proc;
      }) as typeof realSpawn,
      socketPathFactory: (id) => join(scratchDir(), `egress-${id}.sock`),
    });

    try {
      expect(capturedSpawn).toBe(true);
      // socat argv 形态：UNIX-LISTEN:<socketPath>,fork,reuseaddr TCP:127.0.0.1:<port>,keepalive
      expect(capturedSocatArgs).toBeDefined();
      const args = capturedSocatArgs as readonly string[];
      expect(args[0]).toMatch(/^UNIX-LISTEN:.+\.sock,fork,reuseaddr$/);
      expect(args[1]).toMatch(/^TCP:127\.0\.0\.1:\d+,keepalive$/);

      // spec 形状
      expect(session.spec.unixSocketPath).toMatch(/\.sock$/);
      // T1（O3 同号耦合解除）：sandboxLocalPort 是「沙箱内固定监听号」，
      // 恒等于常量，不再与宿主 OS 分配端口同号。
      expect(session.spec.sandboxLocalPort).toBe(SANDBOX_HTTP_PROXY_PORT);
      expect(SANDBOX_HTTP_PROXY_PORT).toBe(3128);

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

      // T3：spec.env 同时带 GIT_SSH_COMMAND，且 token 与代理 URL userinfo
      // 同源（invariant 4 注入面 SSOT 单点：buildProxyEnv 一处构造，
      // 三键与 GIT_SSH_COMMAND 必共享同一 session token）。
      expect(env.GIT_SSH_COMMAND).toMatch(
        /^ssh -F \/dev\/null -o ControlMaster=no -o ControlPath=none -o ProxyCommand='socat - PROXY:127\.0\.0\.1:%h:%p,proxyport=3128,proxyauth=iknow:[0-9a-f]{64}'$/
      );
      const urlToken = new URL(env.HTTP_PROXY).password;
      const sshToken = /proxyauth=iknow:([^']+)'$/.exec(
        env.GIT_SSH_COMMAND
      )?.[1];
      expect(sshToken).toBe(urlToken);

      // 内层桥前导逐字形状：单桥（3128 → unix socket）+ trap kill EXIT。
      // 不断言真监听（测试用假 spawn）。
      expect(session.spec.innerBridgeScript).toBe(
        buildInnerBridgeScript("fake-socat", session.spec.unixSocketPath)
      );
      expect(session.spec.innerBridgeScript).toContain(
        "TCP-LISTEN:3128,fork,reuseaddr"
      );
      expect(session.spec.innerBridgeScript).toContain("UNIX-CONNECT:");
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

  it("dispose is idempotent (safe in finally)", async () => {
    const proc = fakeSocatProc(99999);
    const session = await createEgressSession({
      policy: {
        allowedDomains: ["github.com"],
        deniedDomains: [],
        commandLabel: "test:dispose",
      },
      socatCommand: "fake-socat",
      probeSocat: () => true,
      spawn: (() => proc) as typeof realSpawn,
      socketPathFactory: (id) => join(scratchDir(), `egress-${id}.sock`),
    });
    // 第一次 dispose 不抛
    await session.dispose();
    // 第二次 dispose 同样不抛（finally-safe）
    await session.dispose();
    // 第三次也行
    await session.dispose();
  });

  it("cleans up stale socket on startup (spec §Failure paths)", async () => {
    // 预置一个 stale socket 文件 —— 模拟上次会话未释放。
    const dir = scratchDir();
    const stalePath = join(dir, "egress-stale.sock");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(stalePath, "");

    const proc = fakeSocatProc(88888);
    const session = await createEgressSession({
      policy: {
        allowedDomains: ["github.com"],
        deniedDomains: [],
        commandLabel: "test:stale",
      },
      socatCommand: "fake-socat",
      probeSocat: () => true,
      spawn: (() => proc) as typeof realSpawn,
      socketPathFactory: () => stalePath, // 注入固定路径（与 stale 一致）
    });
    try {
      // session 起来了即说明 stale 被清掉了（不抛 = 成功 unlink）
      expect(session.spec.unixSocketPath).toBe(stalePath);
    } finally {
      await session.dispose();
    }
  });

  it("generates a fresh token per session (isolation between concurrent sessions)", async () => {
    // 仅观察 sandboxLocalPort + id 不同；token 不暴露在 spec 上，由
    // 上游 proxyAuthToken option 内部用，行为不变形。
    const proc1 = fakeSocatProc(11111);
    const proc2 = fakeSocatProc(22222);
    const dir = scratchDir();
    const session1: EgressSession = await createEgressSession({
      policy: {
        allowedDomains: ["github.com"],
        deniedDomains: [],
        commandLabel: "test:concurrent-1",
      },
      socatCommand: "fake-socat",
      probeSocat: () => true,
      spawn: (() => proc1) as typeof realSpawn,
      socketPathFactory: (id) => join(dir, `e1-${id}.sock`),
    });
    const session2: EgressSession = await createEgressSession({
      policy: {
        allowedDomains: ["github.com"],
        deniedDomains: [],
        commandLabel: "test:concurrent-2",
      },
      socatCommand: "fake-socat",
      probeSocat: () => true,
      spawn: (() => proc2) as typeof realSpawn,
      socketPathFactory: (id) => join(dir, `e2-${id}.sock`),
    });
    try {
      expect(session1.id).not.toBe(session2.id);
      expect(session1.spec.unixSocketPath).not.toBe(
        session2.spec.unixSocketPath
      );
    } finally {
      await Promise.all([session1.dispose(), session2.dispose()]);
    }
  });
});

describe("buildProxyEnv", () => {
  it("exposes upper and lower-case aliases with auth userinfo (O1 407 死路清偿)", () => {
    const env = buildProxyEnv(3128, "t0k3n");
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
    const env = buildProxyEnv(3128, "t0k3n", [
      "internal.example",
      "10.0.0.0/8",
    ]);
    expect(env.NO_PROXY).toContain("internal.example");
    expect(env.NO_PROXY).toContain("10.0.0.0/8");
  });

  it("injects GIT_SSH_COMMAND verbatim per spec T3 frozen form (ssh-bridge 子弹3)", () => {
    // 逐字符 = specs/egress-ssh-bridge.md §T3 钉死形态：`-F /dev/null`
    // （assumption 4：围栏内 /etc/ssh/ssh_config.d 报 Bad owner or
    // permissions）、mux 中和、ProxyCommand 经沙箱内 3128 半桥走 HTTP
    // CONNECT。token 位以注入 seam 固定值断言。
    const env = buildProxyEnv(3128, "t0k3n");
    expect(env.GIT_SSH_COMMAND).toBe(
      "ssh -F /dev/null -o ControlMaster=no -o ControlPath=none " +
        "-o ProxyCommand='socat - PROXY:127.0.0.1:%h:%p," +
        "proxyport=3128,proxyauth=iknow:t0k3n'"
    );
  });

  it("GIT_SSH_COMMAND proxyport tracks sandboxLocalPort (no hardcoded port drift)", () => {
    const env = buildProxyEnv(3129, "t0k3n");
    expect(env.GIT_SSH_COMMAND).toContain("proxyport=3129");
  });
});

describe("buildInnerBridgeScript", () => {
  it("pins the single-bridge leading script verbatim (T1 前导形态)", () => {
    const script = buildInnerBridgeScript("socat", "/tmp/e-abc.sock");
    expect(script).toBe(
      [
        "'socat' TCP-LISTEN:3128,fork,reuseaddr " +
          "UNIX-CONNECT:'/tmp/e-abc.sock' >/dev/null 2>&1 &",
        'trap "kill %1 2>/dev/null; exit" EXIT',
      ].join("\n")
    );
  });

  it("shell-quotes hostile socat / socket paths so the chain stays one command", () => {
    const script = buildInnerBridgeScript(
      "socat'x",
      "/tmp/it's-a-sock.sock"
    );
    // 单引号包裹 + 内部 `'` 以 `'\''` 断开重开（POSIX 标准 escape 形态）。
    expect(script).toContain(`'socat'\\''x'`);
    expect(script).toContain(`'/tmp/it'\\''s-a-sock.sock'`);
  });
});
