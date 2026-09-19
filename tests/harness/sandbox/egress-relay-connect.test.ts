/**
 * tests/harness/sandbox/egress-relay-connect.test.ts
 *
 * `vendor/egress-relay/egress-http-connect.mjs`（GIT_SSH_COMMAND 的
 * ProxyCommand 隧道件，ADR-0107 冻结形态）的**挂死面**脚本级钉子
 * （review 修复 [Medium]）。
 *
 * 钉住的不变式：
 *   - CONNECT 响应头**解析完成前**代理半关闭（FIN，无 close 前的完整头）
 *     → 子进程必须带诊断退出非零，绝不挂 stdin 永不退出 ——
 *     ProxyCommand 挂死 = ssh/git push 无限 hang；
 *   - 代理直接 RST（destroy）→ 非零退出（既有 error 面回归）；
 *   - 隧道建立成功后代理发完数据再 FIN → stdout **完整不截断**且
 *     exit 0（退出路径先 flush stdout，write 回调 / end 后再退）。
 *
 * 驱动方式：真 spawn（node 运行时 = process.execPath）+ node:net 假代理，
 * 全部 loopback，不出网。
 */
import { spawn } from "node:child_process";
import { createServer, type Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const CONNECT_SCRIPT = fileURLToPath(
  new URL("../../../vendor/egress-relay/egress-http-connect.mjs", import.meta.url)
);

interface ChildResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** 起一个 loopback 假代理，onClient 决定对每条连接的行为；返回端口。 */
function startFakeProxy(onClient: (sock: Socket) => void): Promise<{
  port: number;
  close: () => Promise<void>;
  connections: () => number;
}> {
  return new Promise((resolve) => {
    let conns = 0;
    const open = new Set<Socket>();
    const server = createServer((sock) => {
      conns++;
      open.add(sock);
      sock.on("close", () => open.delete(sock));
      onClient(sock);
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr === null || typeof addr === "string") {
        throw new Error("fake proxy failed to bind");
      }
      resolve({
        port: addr.port,
        connections: () => conns,
        close: () =>
          new Promise<void>((r) => {
            // server.end() 后的半开 socket 在 node 里不自动销毁（实测），
            // close 回调会永挂 —— 显式销毁全部连接再关 listen 端口。
            for (const s of open) s.destroy();
            open.clear();
            server.close(() => r());
          }),
      });
    });
  });
}

function runChild(port: number, holdStdin: boolean): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [CONNECT_SCRIPT, "example.test", "22"],
      {
        env: {
          HTTP_PROXY: `http://iknow:t0k3n@127.0.0.1:${port}`,
        },
        stdio: [holdStdin ? "pipe" : "ignore", "pipe", "pipe"],
      }
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("latin1");
    child.stderr.setEncoding("latin1");
    child.stdout.on("data", (c: string) => (stdout += c));
    child.stderr.on("data", (c: string) => (stderr += c));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("egress-http-connect did not exit within 5s (hang)"));
    }, 5000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

afterAll(() => undefined);

describe("egress-http-connect.mjs — pre-header hang surfaces (review Medium)", () => {
  it("proxy half-close (FIN without any header) → diagnose + nonzero exit, no hang", async () => {
    const proxy = await startFakeProxy((sock) => {
      sock.end(); // 优雅 FIN，零字节
    });
    try {
      const r = await runChild(proxy.port, true);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toMatch(/before CONNECT response completed/);
    } finally {
      await proxy.close();
    }
  });

  it("proxy sends partial header line then FIN → nonzero exit, no hang", async () => {
    const proxy = await startFakeProxy((sock) => {
      sock.on("data", () => {
        sock.write("HTTP/1.1 200 Conne");
        sock.end();
      });
    });
    try {
      const r = await runChild(proxy.port, true);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toMatch(/before CONNECT response completed/);
    } finally {
      await proxy.close();
    }
  });

  it("proxy hard-destroys before any header → nonzero exit", async () => {
    const proxy = await startFakeProxy((sock) => {
      sock.destroy();
    });
    try {
      const r = await runChild(proxy.port, true);
      expect(r.code).not.toBe(0);
    } finally {
      await proxy.close();
    }
  });

  it("established tunnel: proxy data + FIN → stdout complete (flushed) + exit 0", async () => {
    const payload = "SSH-2.0-fake-banner\r\n";
    const proxy = await startFakeProxy((sock) => {
      sock.once("data", (req) => {
        expect(req.toString("latin1")).toMatch(/^CONNECT example\.test:22 HTTP\/1\.1/);
        sock.write(
          "HTTP/1.1 200 Connection established\r\n\r\n" + payload
        );
        sock.end();
      });
    });
    try {
      const r = await runChild(proxy.port, true);
      expect(r.code).toBe(0);
      expect(r.stdout).toBe(payload);
    } finally {
      await proxy.close();
    }
  });
});
