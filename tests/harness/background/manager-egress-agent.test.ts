/**
 * The background task opens its per-task endpoint from the session-resident
 * egress agent (plan T4/T5, D5/D6).
 *
 * Pinned invariants:
 *   - a background task creates a per-task ENDPOINT from the shared agent, and
 *     the session-level half (the profile) is loaded ONCE for N tasks;
 *   - the per-task policy drops the credential roster (the roster is
 *     session-level) but keeps the rest of the decision input;
 *   - the endpoint is released when the task settles (the same release channel
 *     the per-task session used);
 *   - S4: with the fence RETIRED the seam is skipped wholesale — the agent is
 *     never asked for an endpoint (its own `createCallEndpoint` records no
 *     call) and the task still starts, fence-free.
 *
 * The agent module is never mocked: the real `createEgressAgent` runs with
 * its own documented seams (relay resolver, socket path factory).
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createBackgroundTaskManager,
  type BackgroundSpawnRequest,
} from "../../../src/harness/background/manager.js";
import { resolveTasksDir } from "../../../src/harness/background/paths.js";
import {
  createEgressAgent,
  type EgressAgent,
} from "../../../src/harness/sandbox/egress/agent.js";
import type { EgressRelayPaths } from "../../../src/harness/sandbox/egress/relay-assets.js";
import type { ChildProcess } from "node:child_process";

const scratch: string[] = [];
const agents: EgressAgent[] = [];

function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "iknow-bg-agent-"));
  scratch.push(dir);
  return dir;
}

function fakeRelay(): EgressRelayPaths {
  const relayDir = "/test-root/vendor/egress-relay";
  return {
    nodePath: "/test-root/bin/node",
    relayDir,
    bridgeScriptPath: join(relayDir, "egress-tcp-relay.mjs"),
    connectScriptPath: join(relayDir, "egress-http-connect.mjs"),
  };
}

/** Fake ChildProcess (event-driven settle). */
function makeFakeChild(pid: number): EventEmitter & Record<string, unknown> {
  const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
  child.pid = pid;
  child.kill = (): boolean => true;
  child.exitCode = null;
  child.signalCode = null;
  return child;
}

afterEach(async () => {
  for (const agent of agents.splice(0)) await agent.dispose();
  for (const dir of scratch.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("background task — 共享 agent 的按任务端点 (T4/T5)", () => {
  it("两个任务各开一个端点,profile 只加载一次;任务 settle 时端点被释放", async () => {
    const socketDir = scratchDir();
    let profileLoads = 0;
    const real = createEgressAgent({
      relayResolver: () => {
        profileLoads += 1;
        return fakeRelay();
      },
      socketPathFactory: (id) => join(socketDir, `bg-${id}.sock`),
      createHttpProxyServer: () => createServer(),
    });
    agents.push(real);

    const root = scratchDir();
    const specs: unknown[] = [];
    const children: EventEmitter[] = [];
    const manager = createBackgroundTaskManager({
      tasksDir: resolveTasksDir({
        dataDir: root,
        projectIdentityRoot: root,
      }),
      spawn: async (req: BackgroundSpawnRequest) => {
        specs.push(req.egressSpec);
        const child = makeFakeChild(4242 + children.length);
        children.push(child);
        return child as unknown as ChildProcess;
      },
      egressAgent: real,
    });

    const policy = {
      allowedDomains: ["example.com"],
      deniedDomains: [],
      commandLabel: "background:test",
      // The roster is session-level — a per-task policy must not carry one.
      credentials: { files: [], envVars: [] },
    };
    await manager.spawn({ command: "true", cwd: ".", egressPolicy: policy });
    await manager.spawn({ command: "true", cwd: ".", egressPolicy: policy });

    // One endpoint per task …
    expect(specs).toHaveLength(2);
    const socketPaths = specs.map(
      (spec) => (spec as { unixSocketPath: string }).unixSocketPath
    );
    expect(new Set(socketPaths).size).toBe(2);
    for (const path of socketPaths) expect(existsSync(path)).toBe(true);
    // … while the session-level half is loaded exactly once.
    expect(profileLoads).toBe(1);

    // The task settles → its endpoint is released (the socket is gone).
    children[0]!.emit("exit", 0, null);
    await new Promise<void>((r) => setImmediate(r));
    expect(existsSync(socketPaths[0]!)).toBe(false);
    // The other task's endpoint is untouched.
    expect(existsSync(socketPaths[1]!)).toBe(true);

    children[1]!.emit("exit", 0, null);
    await new Promise<void>((r) => setImmediate(r));
    expect(existsSync(socketPaths[1]!)).toBe(false);
  });

  it("S4: fence 退役的任务不启动代理 —— agent 的 createCallEndpoint 从未被调用,任务照常启动", async () => {
    const socketDir = scratchDir();
    let opened = 0;
    const real = createEgressAgent({
      relayResolver: () => fakeRelay(),
      socketPathFactory: (id) => join(socketDir, `bg-retired-${id}.sock`),
      createHttpProxyServer: () => createServer(),
    });
    agents.push(real);
    // The agent's own observable: the wrapper only counts the calls the
    // manager makes — the agent module itself is not mocked.
    const agent: EgressAgent = {
      id: real.id,
      violationSink: real.violationSink,
      ensureStarted: () => real.ensureStarted(),
      createCallEndpoint: async (policy) => {
        opened += 1;
        return await real.createCallEndpoint(policy);
      },
      dispose: () => real.dispose(),
    };

    const root = scratchDir();
    const specs: unknown[] = [];
    const children: EventEmitter[] = [];
    const manager = createBackgroundTaskManager({
      tasksDir: resolveTasksDir({
        dataDir: root,
        projectIdentityRoot: root,
      }),
      spawn: async (req: BackgroundSpawnRequest) => {
        specs.push(req.egressSpec);
        const child = makeFakeChild(5252 + children.length);
        children.push(child);
        return child as unknown as ChildProcess;
      },
      egressAgent: agent,
    });

    const result = await manager.spawn({
      command: "true",
      cwd: ".",
      fenceRetiredAtSpawn: true,
      egressPolicy: {
        allowedDomains: ["example.com"],
        deniedDomains: [],
        commandLabel: "background:retired",
        credentials: { files: [], envVars: [] },
      },
    });

    // The task started, fence-free …
    expect(result.status).toBe("ok");
    expect(children).toHaveLength(1);
    // … and the agent was never touched: no endpoint for a retired fence.
    expect(opened).toBe(0);
    // No proxy spec rode into the spawn request (no netns → no seam).
    expect(specs[0]).toBeUndefined();
  });

  it("已释放的 agent: spawn 以类型化错误失败(不静默降级成离线任务)", async () => {
    const socketDir = scratchDir();
    const real = createEgressAgent({
      relayResolver: () => fakeRelay(),
      socketPathFactory: (id) => join(socketDir, `bg-released-${id}.sock`),
      createHttpProxyServer: () => createServer(),
    });
    agents.push(real);
    // The agent is released BEFORE the spawn: the manager meets a LIFECYCLE
    // fault (not a start failure), so the spawn must fail typed instead of
    // degrading into a task that silently runs without its egress seam.
    await real.dispose();

    const root = scratchDir();
    const children: EventEmitter[] = [];
    const manager = createBackgroundTaskManager({
      tasksDir: resolveTasksDir({
        dataDir: root,
        projectIdentityRoot: root,
      }),
      spawn: async () => {
        const child = makeFakeChild(6262 + children.length);
        children.push(child);
        return child as unknown as ChildProcess;
      },
      egressAgent: real,
    });

    const result = await manager.spawn({
      command: "true",
      cwd: ".",
      egressPolicy: {
        allowedDomains: ["example.com"],
        deniedDomains: [],
        commandLabel: "background:released",
        credentials: { files: [], envVars: [] },
      },
    });

    expect(result.status).toBe("spawn_error");
    if (result.status !== "spawn_error") return;
    // The typed refusal carries the released agent's id.
    expect(result.error.kind).toBe("egress_agent_released");
    if (result.error.kind !== "egress_agent_released") return;
    expect(result.error.agent_id).toBe(real.id);
    // The task was NOT spawned: no child process, no silently offline task.
    expect(children).toHaveLength(0);
  });
});
