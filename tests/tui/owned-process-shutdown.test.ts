import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterEach, describe, test } from "bun:test";
import { resolveTasksDir } from "../../src/harness/background/paths.js";

interface FixtureEvent {
  readonly kind: string;
  readonly [key: string]: unknown;
}

interface FixtureChild {
  readonly child: ChildProcess;
  readonly events: FixtureEvent[];
  readonly stderr: string[];
  readonly send: (line: string) => void;
  readonly waitForEvent: (
    kind: string,
    predicate?: (event: FixtureEvent) => boolean,
    timeoutMs?: number
  ) => Promise<FixtureEvent>;
  readonly waitForExit: (timeoutMs?: number) => Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>;
}

interface TestRoot {
  readonly root: string;
  readonly dataDir: string;
  readonly workspaceRoot: string;
}

const fixturePath = join(
  import.meta.dir,
  "fixtures",
  "owned-process-shutdown.ts"
);
const testRoots: TestRoot[] = [];
const fixtureChildren: FixtureChild[] = [];

afterEach(async () => {
  const children = fixtureChildren.splice(0);
  for (const child of children) {
    child.send("quit");
  }
  for (const root of testRoots) {
    await killRecordedTaskGroups(root);
  }
  for (const child of children) {
    await stopFixtureChild(child);
  }
  await Promise.all(
    testRoots
      .splice(0)
      .map((root) => rm(root.root, { recursive: true, force: true }))
  );
});

describe("TUI process ownership and bounded shutdown", () => {
  test("two TUI owners share session visibility while confirmed quit stops only its own process groups", async () => {
    const root = await makeTestRoot("iknow-owned-process-cross-owner-");
    const ids = {
      a: ["synthetic-owner-a-main", "synthetic-owner-a-switched"],
      b: ["synthetic-owner-b-main"],
    };
    const allIds = [...ids.a, ...ids.b].sort();
    const ownerA = launchFixture([
      "owner",
      "A",
      root.dataDir,
      root.workspaceRoot,
      JSON.stringify(ids.a),
      JSON.stringify(ids.b),
      JSON.stringify([
        { conversationId: ids.a[0], immuneDescendant: true },
        { conversationId: ids.a[1], immuneDescendant: false },
      ]),
    ]);
    const ownerB = launchFixture([
      "owner",
      "B",
      root.dataDir,
      root.workspaceRoot,
      JSON.stringify(ids.b),
      JSON.stringify(ids.a),
      JSON.stringify([{ conversationId: ids.b[0], immuneDescendant: false }]),
    ]);

    const [readyA, readyB] = await Promise.all([
      ownerA.waitForEvent("ready"),
      ownerB.waitForEvent("ready"),
    ]);
    const tasksA = taskIdentities(readyA);
    const tasksB = taskIdentities(readyB);
    assert.deepEqual(readyA.visibleSessionIds, allIds);
    assert.deepEqual(readyB.visibleSessionIds, allIds);
    assert.equal(
      tasksA.length,
      2,
      "owner A holds work from the active and switched conversations"
    );
    assert.equal(tasksB.length, 1);
    await Promise.all([...tasksA, ...tasksB].map(waitForInitialHeartbeat));
    assert.equal(
      tasksA.every((task) => activeGroupMembers(task.pgid).length > 0),
      true
    );
    assert.equal(
      tasksB.every((task) => activeGroupMembers(task.pgid).length > 0),
      true
    );

    const heartbeatBeforeCancel = await Promise.all(
      [...tasksA, ...tasksB].map(readHeartbeatLength)
    );
    ownerA.send("cancel");
    const cancelled = await ownerA.waitForEvent("cancelled");
    assert.equal(Array.isArray(cancelled.liveTasks), true);
    assert.equal((cancelled.liveTasks as unknown[]).length, 2);
    await Promise.all(
      [...tasksA, ...tasksB].map((task, index) =>
        waitForHeartbeatAdvance(task, heartbeatBeforeCancel[index] ?? 0)
      )
    );
    assert.equal(
      tasksA.every((task) => activeGroupMembers(task.pgid).length > 0),
      true
    );
    assert.equal(
      tasksB.every((task) => activeGroupMembers(task.pgid).length > 0),
      true
    );
    assert.equal(
      ownerA.events.some((event) => event.kind === "shutdown-report"),
      false
    );

    ownerA.send("quit");
    const shutdownEvent = await ownerA.waitForEvent("shutdown-report");
    const report = shutdownEvent.report as {
      readonly cleanupConfirmed: boolean;
      readonly pendingOperations: ReadonlyArray<string>;
      readonly failedOperations: ReadonlyArray<string>;
    };
    assert.equal(report.cleanupConfirmed, true);
    assert.deepEqual(report.pendingOperations, []);
    assert.deepEqual(report.failedOperations, []);
    const exitA = await ownerA.waitForExit(8_000);
    assert.equal(
      exitA.code,
      0,
      `owner A exited unexpectedly: ${JSON.stringify(exitA)}`
    );

    const heartbeatBeforeASettles = await Promise.all(
      tasksA.map(readHeartbeatLength)
    );
    const beforeBProgress = await Promise.all(tasksB.map(readHeartbeatLength));
    await Promise.all(
      tasksB.map((task, index) =>
        waitForHeartbeatAdvance(task, beforeBProgress[index] ?? 0)
      )
    );
    assert.equal(
      isPidActive(readyB.pid as number),
      true,
      "owner B must outlive owner A"
    );

    ownerB.send("snapshot");
    const snapshotB = await ownerB.waitForEvent("snapshot");
    assert.deepEqual(snapshotB.visibleSessionIds, allIds);
    assert.equal((snapshotB.liveTasks as unknown[]).length, 1);
    assert.equal(
      (snapshotB.liveTasks as Array<{ conversation_id: string }>)[0]
        ?.conversation_id,
      ids.b[0]
    );

    const stubbornTask = tasksA.find((task) => task.managerIndex === 0);
    assert.ok(stubbornTask);
    const heartbeatAdvancedAfterOwnerExit = await didHeartbeatAdvance(
      stubbornTask,
      heartbeatBeforeASettles[0] ?? 0,
      350
    );
    const lingeringMembers = activeGroupMembers(stubbornTask.pgid);
    assert.equal(
      lingeringMembers.length === 0 && !heartbeatAdvancedAfterOwnerExit,
      true,
      `owner A exited but its shutdown left executing process-group members ` +
        `(${formatMembers(lingeringMembers)}); heartbeat advanced=${heartbeatAdvancedAfterOwnerExit}`
    );
    const settledAHeartbeats = await Promise.all(
      tasksA.map(readHeartbeatLength)
    );
    assert.deepEqual(
      settledAHeartbeats,
      heartbeatBeforeASettles,
      "A-owned task output must stop advancing after its process groups drain"
    );

    ownerB.send("quit");
    const exitB = await ownerB.waitForExit(8_000);
    assert.equal(
      exitB.code,
      0,
      `owner B exited unexpectedly: ${JSON.stringify(exitB)}`
    );
    await Promise.all(tasksB.map((task) => waitForGroupQuiescent(task.pgid)));
  }, 25_000);

  test("shutdown reaps a TERM-immune child after its direct leader exits", async () => {
    const root = await makeTestRoot("iknow-owned-process-leader-exit-");
    const sessionId = "synthetic-leader-exit-session";
    const owner = launchFixture([
      "owner",
      "A",
      root.dataDir,
      root.workspaceRoot,
      JSON.stringify([sessionId]),
      JSON.stringify([]),
      JSON.stringify([
        {
          conversationId: sessionId,
          immuneDescendant: true,
          leaderExitMs: 250,
        },
      ]),
    ]);

    const ready = await owner.waitForEvent("ready");
    const [task] = taskIdentities(ready);
    assert.ok(task);
    await waitForInitialHeartbeat(task);
    await owner.waitForEvent("task-exited");
    assert.equal(activeGroupMembers(task.pgid).length > 0, true);
    owner.send("quit");
    const reportEvent = await owner.waitForEvent("shutdown-report");
    assert.equal(
      (reportEvent.report as { readonly cleanupConfirmed: boolean })
        .cleanupConfirmed,
      true
    );
    const exit = await owner.waitForExit(3_000);
    assert.equal(exit.code, 0);

    const lingeringMembers = activeGroupMembers(task.pgid);
    const heartbeatAfterOwnerExit = await readHeartbeatLength(task);
    const heartbeatAdvancedAfterQuit = await didHeartbeatAdvance(
      task,
      heartbeatAfterOwnerExit,
      350
    );
    assert.equal(
      lingeringMembers.length === 0 && !heartbeatAdvancedAfterQuit,
      true,
      `the task leader exited before quit, so shutdown skipped its still-running child: ` +
        `${formatMembers(lingeringMembers)}; heartbeat advanced=${heartbeatAdvancedAfterQuit}`
    );
  }, 20_000);

  test("a pending cleanup owner cannot keep its TUI process alive past the watchdog", async () => {
    const root = await makeTestRoot("iknow-owned-process-stuck-cleanup-");
    const noticePath = join(root.root, "watchdog-notice.json");
    const child = launchFixture(["watchdog", "stuck", noticePath]);
    const event = await child.waitForEvent("shutdown-report");
    const report = event.report as {
      readonly cleanupConfirmed: boolean;
      readonly timedOut: boolean;
      readonly pendingOperations: ReadonlyArray<string>;
    };
    assert.equal(report.cleanupConfirmed, false);
    assert.equal(report.timedOut, true);
    assert.deepEqual(report.pendingOperations, ["stuck cleanup"]);
    const exit = await child.waitForExit(3_000);
    assert.equal(exit.code, 1);
    assert.deepEqual(JSON.parse(await readFile(noticePath, "utf8")), report);
  }, 5_000);

  test("a clean cleanup still forces exit when a referenced handle remains", async () => {
    const root = await makeTestRoot("iknow-owned-process-residual-handle-");
    const noticePath = join(root.root, "watchdog-notice.json");
    const child = launchFixture(["watchdog", "residual", noticePath]);
    const event = await child.waitForEvent("shutdown-report");
    const report = event.report as {
      readonly cleanupConfirmed: boolean;
      readonly timedOut: boolean;
    };
    assert.equal(report.cleanupConfirmed, true);
    assert.equal(report.timedOut, false);
    const exit = await child.waitForExit(3_000);
    assert.equal(exit.code, 1);
    assert.deepEqual(JSON.parse(await readFile(noticePath, "utf8")), report);
  }, 5_000);
});

async function makeTestRoot(prefix: string): Promise<TestRoot> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const dataDir = join(root, "shared-data");
  const workspaceRoot = join(root, "workspace");
  await Promise.all([
    mkdir(dataDir, { recursive: true }),
    mkdir(workspaceRoot, { recursive: true }),
  ]);
  const testRoot = { root, dataDir, workspaceRoot };
  testRoots.push(testRoot);
  return testRoot;
}

function launchFixture(args: ReadonlyArray<string>): FixtureChild {
  const child = spawn(process.execPath, [fixturePath, ...args], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...(process.env.PATH !== undefined ? { PATH: process.env.PATH } : {}),
      HOME: tmpdir(),
      ...(process.env.TMPDIR !== undefined
        ? { TMPDIR: process.env.TMPDIR }
        : {}),
    },
  });
  const events: FixtureEvent[] = [];
  const stderr: string[] = [];
  const wakeups = new Set<() => void>();
  const lineReader = createInterface({
    input: child.stdout!,
    crlfDelay: Infinity,
  });
  lineReader.on("line", (line) => {
    try {
      events.push(JSON.parse(line) as FixtureEvent);
      for (const wake of wakeups) wake();
    } catch {
      stderr.push(`invalid fixture output: ${line}`);
    }
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => stderr.push(chunk));
  const exitPromise = new Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });

  const harness: FixtureChild = {
    child,
    events,
    stderr,
    send: (line) => {
      if (!child.stdin?.destroyed) child.stdin?.write(`${line}\n`);
    },
    waitForEvent: async (kind, predicate = () => true, timeoutMs = 10_000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const found = events.find(
          (event) => event.kind === kind && predicate(event)
        );
        if (found !== undefined) return found;
        if (child.exitCode !== null || child.signalCode !== null) {
          throw new Error(
            `fixture exited before ${kind}; exit=${child.exitCode} signal=${child.signalCode}; stderr=${stderr.join("")}`
          );
        }
        await new Promise<void>((resolve) => {
          const wake = (): void => {
            clearTimeout(timer);
            wakeups.delete(wake);
            resolve();
          };
          const timer = setTimeout(
            wake,
            Math.min(25, Math.max(1, deadline - Date.now()))
          );
          wakeups.add(wake);
        });
      }
      throw new Error(
        `fixture timed out waiting for ${kind}; stderr=${stderr.join("")}`
      );
    },
    waitForExit: async (timeoutMs = 5_000) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          exitPromise,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new Error(
                    `fixture did not exit within ${timeoutMs}ms; stderr=${stderr.join("")}`
                  )
                ),
              timeoutMs
            );
          }),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
  };
  fixtureChildren.push(harness);
  return harness;
}

function taskIdentities(event: FixtureEvent): ReadonlyArray<{
  readonly taskId: string;
  readonly managerIndex: number;
  readonly conversationId: string;
  readonly pgid: number;
  readonly leaderPidFile: string;
  readonly descendantPidFile: string;
  readonly heartbeatPath: string;
}> {
  assert.ok(Array.isArray(event.tasks));
  return event.tasks as ReadonlyArray<{
    readonly taskId: string;
    readonly managerIndex: number;
    readonly conversationId: string;
    readonly pgid: number;
    readonly leaderPidFile: string;
    readonly descendantPidFile: string;
    readonly heartbeatPath: string;
  }>;
}

async function waitForInitialHeartbeat(task: {
  readonly heartbeatPath: string;
}): Promise<void> {
  await waitUntil(
    async () => (await readHeartbeatLength(task)) > 0,
    "worker heartbeat start"
  );
}

async function waitForHeartbeatAdvance(
  task: { readonly heartbeatPath: string },
  previousLength: number
): Promise<void> {
  await waitUntil(
    async () => (await readHeartbeatLength(task)) > previousLength,
    "worker heartbeat progress"
  );
}

async function didHeartbeatAdvance(
  task: { readonly heartbeatPath: string },
  previousLength: number,
  observationMs: number
): Promise<boolean> {
  const deadline = Date.now() + observationMs;
  while (Date.now() < deadline) {
    if ((await readHeartbeatLength(task)) > previousLength) return true;
    await delay(20);
  }
  return (await readHeartbeatLength(task)) > previousLength;
}

async function readHeartbeatLength(task: {
  readonly heartbeatPath: string;
}): Promise<number> {
  try {
    return (await readFile(task.heartbeatPath)).byteLength;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

async function waitUntil(
  predicate: () => Promise<boolean>,
  label: string,
  timeoutMs = 2_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(20);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function activeGroupMembers(pgid: number): ReadonlyArray<string> {
  const output = execFileSync("ps", ["-eo", "pid=,pgid=,stat=,comm="], {
    encoding: "utf8",
  });
  return output
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => {
      if (parts.length < 4 || Number(parts[1]) !== pgid) return false;
      const state = parts[2] ?? "";
      return !state.startsWith("Z") && !state.startsWith("X");
    })
    .map((parts) => `${parts[0]}:${parts[2]}:${parts.slice(3).join(" ")}`);
}

async function waitForGroupQuiescent(
  pgid: number,
  timeoutMs = 5_000
): Promise<void> {
  await waitUntil(
    async () => activeGroupMembers(pgid).length === 0,
    `process group ${pgid} to have no executing members`,
    timeoutMs
  );
}

function formatMembers(members: ReadonlyArray<string>): string {
  return members.length === 0 ? "none" : members.join(", ");
}

function isPidActive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    const output = execFileSync("ps", ["-o", "stat=", "-p", String(pid)], {
      encoding: "utf8",
    }).trim();
    return output !== "" && !output.startsWith("Z") && !output.startsWith("X");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function killRecordedTaskGroups(root: TestRoot): Promise<void> {
  const tasksDir = resolveTasksDir({
    dataDir: root.dataDir,
    projectIdentityRoot: root.workspaceRoot,
  });
  let names: string[];
  try {
    names = await readdir(tasksDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const name of names.filter((entry) => entry.endsWith(".json"))) {
    try {
      const record = JSON.parse(
        await readFile(join(tasksDir, name), "utf8")
      ) as {
        readonly pgid?: unknown;
      };
      if (typeof record.pgid === "number") {
        try {
          process.kill(-record.pgid, "SIGKILL");
        } catch {
          // EXIT: cleanup can race with the manager's own terminal signal.
        }
      }
    } catch {
      // EXIT: cleanup does not hide the test result if a partial record was
      // left while its owner was being terminated.
    }
  }
}

async function stopFixtureChild(fixture: FixtureChild): Promise<void> {
  if (fixture.child.exitCode !== null || fixture.child.signalCode !== null)
    return;
  try {
    fixture.child.kill("SIGKILL");
  } catch {
    // EXIT: process exit raced the afterEach cleanup.
  }
  try {
    await fixture.waitForExit(1_000);
  } catch {
    // EXIT: the test process owns no descendant once this fixture is gone.
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
