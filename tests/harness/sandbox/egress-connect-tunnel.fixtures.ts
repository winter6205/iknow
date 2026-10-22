/**
 * Shared fixtures for the egress CONNECT-tunnel tests — the helpers that
 * open a REAL tunnel through a per-call endpoint's proxy and observe what
 * happens to it.
 *
 * Why a fixtures module: two suites need the same three pieces (a local
 * target server, the tunnel client, the "did the connection die?" probe) and
 * a copy per suite would drift.
 *
 * The target is ALWAYS a local HTTP server on 127.0.0.1 — no test here ever
 * reaches the public internet. The proxy under test is the real one (the
 * endpoint's own `createHttpProxyServer` seam is left un-injected), so the
 * tunnel is a real CONNECT tunnel with the real proxy-auth gate in front of
 * it.
 */

import { createServer } from "node:http";
import { connect, type Socket } from "node:net";

/**
 * A real local HTTP server the CONNECT tunnel reaches.
 */
export interface LocalTarget {
  readonly port: number;
  readonly close: () => Promise<void>;
}

/** Start the local target on an ephemeral loopback port. */
export async function startLocalTarget(): Promise<LocalTarget> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("pong");
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("the local target did not bind a TCP port");
  }
  return {
    port: address.port,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

/** Poll until the predicate holds; throws when the deadline passes. */
export async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  what: string
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Whether the socket is closed (the tunnel was dropped) within the deadline. */
export function waitForClose(
  socket: Socket,
  timeoutMs: number
): Promise<boolean> {
  if (socket.destroyed) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      socket.off("close", onClose);
      resolve(false);
    }, timeoutMs);
    const onClose = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    socket.once("close", onClose);
  });
}

/** The client side of an established CONNECT tunnel. */
export interface ConnectTunnel {
  readonly socket: Socket;
  /** Everything the client received on the socket so far. */
  readonly received: () => string;
}

/**
 * Open a real CONNECT tunnel through the endpoint's proxy to a local target
 * and prove it is LIVE (the target's answer travels back through the tunnel).
 */
export async function openConnectTunnel(args: {
  readonly socketPath: string;
  readonly targetPort: number;
  readonly proxyAuth: string;
}): Promise<ConnectTunnel> {
  const socket = connect({ path: args.socketPath });
  let received = "";
  socket.on("data", (chunk: Buffer) => {
    received += chunk.toString("utf8");
  });
  // The client socket must never raise an unhandled 'error' event.
  socket.on("error", () => {});
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("error", reject);
  });
  socket.write(
    `CONNECT 127.0.0.1:${args.targetPort} HTTP/1.1\r\n` +
      `Host: 127.0.0.1:${args.targetPort}\r\n` +
      `Proxy-Authorization: ${args.proxyAuth}\r\n\r\n`
  );
  await waitFor(
    () => received.includes("200 Connection Established"),
    5000,
    "the CONNECT tunnel to be established"
  );
  // A live tunnel carries payload: the local target answers through it. The
  // request keeps the connection alive (no `Connection: close`) — the tunnel
  // must still be open when the endpoint is disposed.
  socket.write("GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
  await waitFor(
    () => received.includes("pong"),
    5000,
    "the tunnel payload to come back from the local target"
  );
  return { socket, received: () => received };
}

/**
 * The proxy-auth header the endpoint's proxy demands: the token rides the
 * fence spec's proxy URL, and the proxy answers 407 without it.
 */
export function proxyAuthHeader(
  specEnv: Readonly<Record<string, string>>
): string {
  const token = new URL(specEnv.HTTP_PROXY).password;
  return `Basic ${Buffer.from(`iknow:${token}`).toString("base64")}`;
}
