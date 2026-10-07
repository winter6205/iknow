/**
 * Background route: stderr is distinguishable from stdout, and a spawn refusal
 * keeps its identity.
 *
 * The manager merges stdout and stderr into one log file, which every existing
 * consumer reads as `text` — that stays byte-identical here. What was missing is
 * the ability to tell which side a line came from: a task that printed nothing
 * to stdout and 40 KB of stack trace to stderr returned a `text` with no way to
 * classify it. `stderr` is additive, so a reader that only wants the merged tail
 * is unaffected.
 *
 * The second block is the typed-failure half: the manager decides *which*
 * refusal it is, and that identity has to survive the projection into the
 * model-visible error instead of being flattened to prose.
 *
 * File placement note: the behaviour under test lives in
 * `src/harness/background/manager.ts`, but this ticket's test-write scope is
 * `tests/harness/aci/bash-*.test.ts`, so the background-route cases live here.
 *
 * Real file IO, fake processes: the child is an EventEmitter with PassThrough
 * streams, so the manager's own append/settle path runs for real.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChildProcess } from "node:child_process";

// The manager builds its egress session itself; a stub is the only way to make
// dispose throw. Everything else in this file is real file IO.
const releases = vi.hoisted(() => ({ count: 0 }));

vi.mock("../../../src/harness/sandbox/index.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../src/harness/sandbox/index.js")
  >("../../../src/harness/sandbox/index.js");
  return {
    ...actual,
    createEgressSession: vi.fn(async () => ({
      id: "bg-stub-session",
      spec: {
        unixSocketPath: "/tmp/iknow-bg-stub.sock",
        sandboxLocalPort: 0,
        env: {},
        innerBridgeScript: "",
        relayAssetsDir: "/test/iknow/vendor/egress-relay",
      },
      violationSink: {
        record: () => undefined,
        drain: () => [],
        size: () => 0,
        all: () => [],
      },
      dispose: async () => {
        releases.count += 1;
        throw new Error("proxy close EPERM");
      },
    })),
  };
});

import {
  createBackgroundTaskManager,
  type BackgroundTaskManager,
} from "../../../src/harness/background/manager.js";
import { createBashTool } from "../../../src/harness/aci/tools/bash.js";
import { BashBackgroundSpawnError } from "../../../src/harness/aci/tools/bash.js";
import { ToolExecutionError } from "../../../src/harness/errors.js";

const scratch: string[] = [];
afterEach(async () => {
  await Promise.all(
    scratch.splice(0).map((p) => rm(p, { recursive: true, force: true }))
  );
});

async function makeScratch(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

/**
 * Spawn a task carrying a policy (so the manager owns an egress session),
 * settle it, and report how many times that session was released.
 */
async function spawnSettlingTaskWithEgress(tasksDir: string): Promise<number> {
  releases.count = 0;
  const child = makeFakeChild();
  const manager = createBackgroundTaskManager({
    tasksDir,
    spawn: async () => child as unknown as ChildProcess,
  });
  const res = await manager.spawn({
    command: "node server.js",
    cwd: tasksDir,
    env: { PATH: "/usr/bin:/bin" },
    tmpDir: tasksDir,
    egressPolicy: {
      allowedDomains: ["example.com"],
      deniedDomains: [],
      commandLabel: "bg-repeat-stop",
    },
  });
  assert.equal(res.status, "ok");
  child.emit("exit", 0, null);
  // A stop after the task is already terminal is the idempotent no-op arm.
  await manager.stop(res.task_id);
  await manager.stop(res.task_id);
  await new Promise<void>((r) => setImmediate(r));
  const settled = await manager.status(res.task_id);
  assert.equal(settled.status, "exited");
  // One release per settled task: the settle guard ran once, so the repeated
  // stops added none.
  return releases.count;
}

interface FakeChild {
  readonly stdin: PassThrough;
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
  readonly pid: number;
  readonly kill: ReturnType<typeof vi.fn>;
  emit: (event: string, ...args: unknown[]) => boolean;
}

function makeFakeChild(pid = 54321): FakeChild {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid,
    kill: vi.fn(() => true),
  });
}

/** Spawn one task and feed it the given chunks before it exits. */
async function spawnTaskWith(
  tasksDir: string,
  chunks: { readonly stdout?: string; readonly stderr?: string }
): Promise<{ manager: BackgroundTaskManager; task_id: string }> {
  const child = makeFakeChild();
  const manager = createBackgroundTaskManager({
    tasksDir,
    spawn: async () => child as unknown as ChildProcess,
  });
  const res = await manager.spawn({
    command: "node server.js",
    cwd: tasksDir,
    env: { PATH: "/usr/bin:/bin" },
    tmpDir: tasksDir,
  });
  assert.equal(res.status, "ok");
  child.stdout.write(chunks.stdout ?? "");
  child.stderr.write(chunks.stderr ?? "");
  child.emit("exit", 0, null);
  // The settle path drains the queued appends on the read side; give the
  // write chain a turn before asserting.
  await new Promise<void>((r) => setImmediate(r));
  return { manager, task_id: res.task_id };
}

describe("background output separates stderr from stdout", () => {
  it("merged text is unchanged and stderr is readable on its own", async () => {
    const tasksDir = await makeScratch("bg-stderr-");
    const { manager, task_id } = await spawnTaskWith(tasksDir, {
      stdout: "listening on :8080\n",
      stderr: "TypeError: cannot read x\n    at handler\n",
    });
    const out = await manager.output(task_id);
    assert.match(out.text, /listening on :8080/);
    assert.match(out.text, /TypeError: cannot read x/, "merged tail unchanged");
    assert.match(out.stderr, /TypeError: cannot read x/);
    assert.doesNotMatch(out.stderr, /listening on :8080/);
  });

  it("a stdout-only task reports no stderr (absent is not 'unknown')", async () => {
    const tasksDir = await makeScratch("bg-stdout-only-");
    const { manager, task_id } = await spawnTaskWith(tasksDir, {
      stdout: "ready\n",
    });
    const out = await manager.output(task_id);
    assert.equal(out.stderr, "");
    assert.equal(out.text, "ready\n");
  });

  it("a stderr-only task still keeps the merged text contract", async () => {
    const tasksDir = await makeScratch("bg-stderr-only-");
    const { manager, task_id } = await spawnTaskWith(tasksDir, {
      stderr: "npm ERR! code E404\n",
    });
    const out = await manager.output(task_id);
    assert.equal(out.text, "npm ERR! code E404\n");
    assert.equal(out.stderr, "npm ERR! code E404\n");
  });
});

describe("background spawn refusal keeps its identity", () => {
  it("the thrown error carries the manager's kind and context", async () => {
    const cwd = await makeScratch("bg-typed-failure-");
    const manager = {
      spawn: vi.fn(async () => ({
        status: "spawn_error" as const,
        error: {
          kind: "concurrency_limit_reached" as const,
          context: "spawn",
          message:
            "8 background tasks are already running; stop one or raise the cap.",
        },
      })),
      status: vi.fn(),
      output: vi.fn(),
      stop: vi.fn(),
      shutdown: vi.fn(),
      registerConversationDeletedListener: vi.fn(),
      onConversationDeleted: vi.fn(),
    } as unknown as BackgroundTaskManager;
    const tool = createBashTool(cwd, { backgroundManager: manager });

    let thrown: unknown;
    try {
      await tool.handler({ command: "sleep 300", background: true });
      thrown = undefined;
    } catch (err) {
      thrown = err;
    }

    assert.ok(
      thrown instanceof BashBackgroundSpawnError,
      "the refusal is a named typed error, not a bare string"
    );
    assert.ok(
      thrown instanceof ToolExecutionError,
      "still a ToolExecutionError for the existing sanitizing seam"
    );
    assert.equal(thrown.kind, "concurrency_limit_reached");
    assert.equal(thrown.context, "spawn");
    // The model-visible message keeps the shape it always had.
    expect(thrown.message).toContain("bash: background spawn failed");
    expect(thrown.message).toContain("concurrency_limit_reached");
    expect(thrown.message).toContain("8 background tasks are already running");
  });
});
/**
 * A release failure on the background route is evidence, not silence.
 *
 * The manager owns the egress session for the life of the task and releases it
 * inside the settle guard. A dispose that throws must not be dropped: the task's
 * own status stays what it was (the teardown fault does not rewrite the
 * outcome), and the cause is reported through the manager's log.
 *
 * The session is mocked at the module boundary because the manager has no
 * injection seam for it — adding one would be a new public input for a case no
 * production caller can hit differently.
 */
describe("background egress release failure is reported", () => {
  it("the settle path logs the release failure and keeps the task's own status", async () => {
    const tasksDir = await makeScratch("bg-release-fail-");
    const lines: string[] = [];
    const child = makeFakeChild();
    const manager = createBackgroundTaskManager({
      tasksDir,
      log: (message: string) => lines.push(message),
      spawn: async () => child as unknown as ChildProcess,
    });
    const res = await manager.spawn({
      command: "node server.js",
      cwd: tasksDir,
      env: { PATH: "/usr/bin:/bin" },
      tmpDir: tasksDir,
      egressPolicy: {
        allowedDomains: ["example.com"],
        deniedDomains: [],
        commandLabel: "bg-release-fail",
      },
    });
    assert.equal(res.status, "ok");
    child.emit("exit", 0, null);
    await new Promise<void>((r) => setImmediate(r));

    const status = await manager.status(res.task_id);
    assert.equal(status.status, "exited");
    assert.equal(status.exit_code, 0);
    expect(lines.join("\n")).toContain(
      "background egress session release failed"
    );
    expect(lines.join("\n")).toContain("proxy close EPERM");
  });
});

/**
 * Input boundary: identity and repetition on the background route.
 *
 *   - Empty: a blank task id is a typed `empty_task_id` refusal, raised before
 *     any record lookup or log read, so no resource is touched.
 *   - Repeated: a stop that races the natural exit (and a second stop after it)
 *     settles once and releases the egress session exactly once.
 *
 * Both are pinning tests — the behaviour is already in place and this keeps it
 * there.
 */
describe("background input boundary — identity and repetition", () => {
  it("an empty task id is refused without touching a task or its log", async () => {
    const tasksDir = await makeScratch("bg-empty-id-");
    const manager = createBackgroundTaskManager({
      tasksDir,
      spawn: async () => makeFakeChild() as unknown as ChildProcess,
    });
    let thrown: unknown;
    try {
      await manager.output("   ");
      thrown = undefined;
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown !== undefined, "a blank task id is refused");
    assert.deepEqual(thrown, {
      kind: "empty_task_id",
      context: "output",
    });
  });

  it("repeated stop settles once and releases the egress session once", async () => {
    const tasksDir = await makeScratch("bg-repeat-stop-");
    const releaseCount = await spawnSettlingTaskWithEgress(tasksDir);
    assert.equal(releaseCount, 1);
  });
});
