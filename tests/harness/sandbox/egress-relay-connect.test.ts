/**
 * tests/harness/sandbox/egress-relay-connect.test.ts
 *
 * Script-level pins for the hang surfaces of
 * `vendor/egress-relay/egress-http-connect.mjs` — the ProxyCommand tunnel piece
 * behind GIT_SSH_COMMAND in its ADR-0107 frozen shape.
 *
 * Pinned invariants:
 *   - proxy half-close (FIN) before the CONNECT response header is fully parsed
 *     → the child must exit nonzero with a diagnosis, never hang on stdin —
 *     a hung ProxyCommand = ssh/git push hangs indefinitely;
 *   - proxy hard RST (destroy) → nonzero exit (regression on the existing error surface);
 *   - after the tunnel is established, proxy sends its data then FINs → stdout is
 *     complete and untruncated, exit 0 (the exit path flushes stdout first: it exits
 *     only after the write callback / end).
 *
 * Driving style: real spawn (node runtime = process.execPath) plus node:net fake
 * proxies, all loopback — never leaves the machine.
 */
import { spawn } from "node:child_process";
import { createServer, type Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const CONNECT_SCRIPT = fileURLToPath(
  new URL(
    "../../../vendor/egress-relay/egress-http-connect.mjs",
    import.meta.url
  )
);

interface ChildResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Start a loopback fake proxy; onClient decides each connection's behavior; resolves with the port. */
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
            // sockets left half-open after server.end() are not auto-destroyed in
            // node (observed), so the close callback would never fire — explicitly
            // destroy every connection before closing the listen port
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
      sock.end(); // graceful FIN, zero bytes
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
        expect(req.toString("latin1")).toMatch(
          /^CONNECT example\.test:22 HTTP\/1\.1/
        );
        sock.write("HTTP/1.1 200 Connection established\r\n\r\n" + payload);
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
