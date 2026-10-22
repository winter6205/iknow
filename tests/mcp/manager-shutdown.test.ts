import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createMcpManager,
  type McpClientHandle,
} from "../../src/harness/mcp/manager.ts";
import type { McpServerConfig } from "../../src/harness/mcp/config.ts";

const roots: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children) {
    if (!hasExited(child)) child.kill("SIGKILL");
    if (!hasExited(child)) await waitForExit(child, 1_000);
  }
  children.length = 0;
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true }))
  );
});

describe("MCP manager shutdown ownership", () => {
  it("bounds a hung client close and stops its owned stdio child", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-mcp-shutdown-"));
    roots.push(root);
    const child = await spawnSignalChild(false);
    const manager = createMcpManager({
      workspaceRoot: root,
      config: [stdioServer("hung")],
      registerExternal: () => {},
      createClient: () => ownedHandle(child, () => new Promise<void>(() => {})),
    });
    await manager.start({ firstTurnReadyTimeoutMs: 1_000 });

    const shutdownResult = await Promise.race([
      manager.shutdown().then(
        () => "resolved" as const,
        (error: unknown) => ({ kind: "rejected" as const, error })
      ),
      delay(2_000).then(() => "timed-out" as const),
    ]);

    expect(shutdownResult).not.toBe("timed-out");
    expect(shutdownResult).not.toBe("resolved");
    if (shutdownResult === "timed-out" || shutdownResult === "resolved") return;
    expect(shutdownResult.error).toMatchObject({ name: "McpShutdownError" });
    expect(await waitForExit(child, 1_000)).toBe(true);
  });

  it("starts peer closes after synchronous throws and rejected closes", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-mcp-shutdown-"));
    roots.push(root);
    const thrownChild = await spawnSignalChild(false);
    const rejectedChild = await spawnSignalChild(false);
    const closeCalls = new Map<string, number>();
    const manager = createMcpManager({
      workspaceRoot: root,
      config: [stdioServer("thrower"), stdioServer("rejecter")],
      registerExternal: () => {},
      createClient: (server) => {
        const child = server.name === "thrower" ? thrownChild : rejectedChild;
        return ownedHandle(child, () => {
          closeCalls.set(server.name, (closeCalls.get(server.name) ?? 0) + 1);
          if (server.name === "thrower")
            throw new Error("synthetic close failure");
          return Promise.reject(new Error("synthetic close failure"));
        });
      },
    });
    await manager.start({ firstTurnReadyTimeoutMs: 1_000 });

    await expect(manager.shutdown()).rejects.toMatchObject({
      name: "McpShutdownError",
      failures: [
        { server: "rejecter", reason: "client_close_failed" },
        { server: "thrower", reason: "client_close_failed" },
      ],
    });

    expect(closeCalls).toEqual(
      new Map([
        ["rejecter", 1],
        ["thrower", 1],
      ])
    );
    expect(await waitForExit(thrownChild, 1_000)).toBe(true);
    expect(await waitForExit(rejectedChild, 1_000)).toBe(true);
  });

  it("closes normally, memoizes shutdown, and leaves an independent child alive", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-mcp-shutdown-"));
    roots.push(root);
    const ownedChild = await spawnSignalChild(false);
    const independentChild = await spawnSignalChild(false);
    let closeCalls = 0;
    const manager = createMcpManager({
      workspaceRoot: root,
      config: [stdioServer("owned")],
      registerExternal: () => {},
      createClient: () =>
        ownedHandle(ownedChild, async () => {
          closeCalls += 1;
        }),
    });
    await manager.start({ firstTurnReadyTimeoutMs: 1_000 });

    const firstShutdown = manager.shutdown();
    expect(manager.shutdown()).toBe(firstShutdown);
    await firstShutdown;
    expect(manager.shutdown()).toBe(firstShutdown);

    expect(closeCalls).toBe(1);
    expect(await waitForExit(ownedChild, 1_000)).toBe(true);
    expect(hasExited(independentChild)).toBe(false);
  });

  it("kills an owned child that ignores TERM without signaling an independent child", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-mcp-shutdown-"));
    roots.push(root);
    const stubbornChild = await spawnSignalChild(true);
    const independentChild = await spawnSignalChild(true);
    const manager = createMcpManager({
      workspaceRoot: root,
      config: [stdioServer("stubborn")],
      registerExternal: () => {},
      createClient: () => ownedHandle(stubbornChild, async () => {}),
    });
    await manager.start({ firstTurnReadyTimeoutMs: 1_000 });

    await manager.shutdown();

    expect(await waitForExit(stubbornChild, 1_000)).toBe(true);
    expect(hasExited(independentChild)).toBe(false);
  });
});

function stdioServer(name: string): McpServerConfig {
  return {
    name,
    kind: "stdio",
    source: "user",
    status: "enabled",
    entry: { command: process.execPath, args: [] },
  };
}

function ownedHandle(
  child: ChildProcess,
  close: () => Promise<void>
): McpClientHandle {
  const handle: McpClientHandle & { readonly _stdioPid: number | undefined } = {
    connect: async () => {},
    listTools: async () => [],
    callTool: async () => ({ result: { content: [] } }),
    close,
    onListChanged: () => {},
    onClose: () => {},
    listResources: async () => ({ resources: [] }),
    readResource: async () => ({ contents: [] }),
    _stdioPid: child.pid,
  };
  return handle;
}

async function spawnSignalChild(ignoreTerm: boolean): Promise<ChildProcess> {
  const termHandler = ignoreTerm
    ? "process.on('SIGTERM', () => {});"
    : "process.on('SIGTERM', () => process.exit(0));";
  const child = spawn(
    process.execPath,
    [
      "-e",
      `${termHandler} process.stdout.write('ready\\n'); setInterval(() => {}, 1000);`,
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  children.push(child);
  const ready = await new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => finish(false), 2_000);
    const finish = (value: boolean): void => {
      clearTimeout(timeout);
      child.stdout?.off("data", onData);
      child.off("exit", onExit);
      child.off("error", onError);
      resolve(value);
    };
    const onData = (chunk: Buffer): void => {
      if (chunk.toString().includes("ready")) finish(true);
    };
    const onExit = (): void => finish(false);
    const onError = (): void => finish(false);
    child.stdout?.on("data", onData);
    child.once("exit", onExit);
    child.once("error", onError);
  });
  if (!ready) throw new Error("test child did not become ready");
  return child;
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function waitForExit(
  child: ChildProcess,
  timeoutMs: number
): Promise<boolean> {
  if (hasExited(child)) return true;
  return new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => finish(false), timeoutMs);
    const finish = (exited: boolean): void => {
      clearTimeout(timeout);
      child.off("exit", onExit);
      child.off("error", onError);
      resolve(exited);
    };
    const onExit = (): void => finish(true);
    const onError = (): void => finish(false);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
