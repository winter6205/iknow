import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { writeFileSync, writeSync } from "node:fs";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { CliRenderEvents, createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { createBackgroundTaskManager } from "../../../src/harness/background/manager.js";
import { resolveTasksDir } from "../../../src/harness/background/paths.js";
import { createPermissionModeContext } from "../../../src/harness/permission/index.js";
import { createSessionGrants } from "../../../src/harness/permission/session-grants.js";
import type { SessionHub } from "../../../src/session-api/hub.js";
import { createTuiAskUserBridge } from "../../../src/tui/ask-user.js";
import { createToolEventSink, TuiApp } from "../../../src/tui/app.js";
import {
  createInflightRegistry,
  type TuiBridge,
} from "../../../src/tui/hub-bridge.js";
import { createDraftSession } from "../../../src/tui/session-state.js";
import {
  createTuiShutdownCoordinator,
  scheduleTuiExitWatchdog,
} from "../../../src/tui/shutdown.js";
import { SessionStore } from "../../../src/session-api/store/session-store.js";
import { CURRENT_SCHEMA_VERSION } from "../../../src/session-api/store/schema.js";
import type { SessionFileV1 } from "../../../src/session-api/store/schema.js";

interface TaskSpec {
  readonly conversationId: string;
  readonly immuneDescendant: boolean;
  readonly leaderExitMs?: number;
}

interface TaskIdentity {
  readonly taskId: string;
  readonly managerIndex: number;
  readonly conversationId: string;
  readonly pgid: number;
  readonly leaderPidFile: string;
  readonly descendantPidFile: string;
  readonly heartbeatPath: string;
}

interface OwnerConfig {
  readonly owner: string;
  readonly dataDir: string;
  readonly workspaceRoot: string;
  readonly sessionIds: ReadonlyArray<string>;
  readonly peerIds: ReadonlyArray<string>;
  readonly taskSpecs: ReadonlyArray<TaskSpec>;
}

interface OwnedTask {
  readonly manager: ReturnType<typeof createBackgroundTaskManager>;
  readonly identity: TaskIdentity;
}

type FixtureEvent = Readonly<Record<string, unknown>>;

function emit(event: FixtureEvent): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

async function runOwner(args: ReadonlyArray<string>): Promise<void> {
  const config = parseOwnerArgs(args);
  const store = new SessionStore(config.dataDir, config.workspaceRoot);
  const tasksDir = resolveTasksDir({
    dataDir: config.dataDir,
    projectIdentityRoot: config.workspaceRoot,
  });
  const runtimeDir = join(
    config.dataDir,
    "owned-process-fixture",
    config.owner
  );
  await mkdir(runtimeDir, { recursive: true });
  await saveSyntheticSessions(store, config.workspaceRoot, config.sessionIds);
  const tasks = await launchOwnerTasks({ ...config, tasksDir, runtimeDir });
  await waitUntilSharedSessionsVisible(store, [
    ...config.sessionIds,
    ...config.peerIds,
  ]);
  const stopWatching = { value: false };
  const watchSessions = watchSharedSessions(store, stopWatching, [
    ...config.sessionIds,
    ...config.peerIds,
  ]);

  emit({
    kind: "ready",
    owner: config.owner,
    pid: process.pid,
    sessionIds: config.sessionIds,
    visibleSessionIds: visibleSessionIds(await store.list()),
    tasks: tasks.map((task) => task.identity),
    liveTasks: tasks.flatMap((task) => task.manager.listLiveTasks()),
  });

  try {
    await waitForOwnedLeaderExits(config, tasks);
    await runOwnerControlLoop(config.owner, store, tasks);
  } finally {
    stopWatching.value = true;
    await watchSessions;
  }
}

function parseOwnerArgs(args: ReadonlyArray<string>): OwnerConfig {
  if (args.length !== 6) {
    throw new Error(
      "owner mode requires owner, dataDir, workspaceRoot, session ids, peer ids, and task specs"
    );
  }
  const [
    owner,
    dataDir,
    workspaceRoot,
    sessionIdsJson,
    peerIdsJson,
    taskSpecsJson,
  ] = args;
  return {
    owner: owner!,
    dataDir: dataDir!,
    workspaceRoot: workspaceRoot!,
    sessionIds: JSON.parse(sessionIdsJson!) as ReadonlyArray<string>,
    peerIds: JSON.parse(peerIdsJson!) as ReadonlyArray<string>,
    taskSpecs: JSON.parse(taskSpecsJson!) as ReadonlyArray<TaskSpec>,
  };
}

async function saveSyntheticSessions(
  store: SessionStore,
  workspaceRoot: string,
  sessionIds: ReadonlyArray<string>
): Promise<void> {
  for (const sessionId of sessionIds) {
    const now = new Date().toISOString();
    const file: SessionFileV1 = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      conversation_id: sessionId,
      title: `Synthetic ${sessionId}`,
      cwd: workspaceRoot,
      sanitized_at: now,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "synthetic question" }],
        },
        {
          role: "assistant",
          content: [{ type: "text", text: `synthetic reply for ${sessionId}` }],
        },
      ],
      jsonMode: false,
      turnCount: 1,
      updatedAt: now,
      checkpoints: [],
    };
    await store.save({ id: sessionId, file });
  }
}

async function launchOwnerTasks(
  config: OwnerConfig & {
    readonly tasksDir: string;
    readonly runtimeDir: string;
  }
): Promise<ReadonlyArray<OwnedTask>> {
  const tasks: OwnedTask[] = [];
  for (let index = 0; index < config.taskSpecs.length; index += 1) {
    const spec = config.taskSpecs[index]!;
    tasks.push(await launchOwnerTask(config, spec, index));
  }
  return tasks;
}

async function launchOwnerTask(
  config: OwnerConfig & {
    readonly tasksDir: string;
    readonly runtimeDir: string;
  },
  spec: TaskSpec,
  managerIndex: number
): Promise<OwnedTask> {
  const leaderPidFile = join(
    config.runtimeDir,
    `manager-${managerIndex}-leader.pid`
  );
  const descendantPidFile = join(
    config.runtimeDir,
    `manager-${managerIndex}-descendant.pid`
  );
  const heartbeatPath = join(
    config.runtimeDir,
    `manager-${managerIndex}-heartbeat`
  );
  const manager = createBackgroundTaskManager({
    tasksDir: config.tasksDir,
    spawn: async () => {
      const command = workerCommand({
        leaderPidFile,
        descendantPidFile,
        heartbeatPath,
        immuneDescendant: spec.immuneDescendant,
        ...(spec.leaderExitMs !== undefined
          ? { leaderExitMs: spec.leaderExitMs }
          : {}),
      });
      return spawn("/bin/sh", ["-c", command], {
        cwd: config.workspaceRoot,
        detached: true,
        stdio: "ignore",
      });
    },
  });
  const result = await manager.spawn({
    command: `synthetic-${config.owner}-manager-${managerIndex}`,
    cwd: config.workspaceRoot,
    conversationId: spec.conversationId,
  });
  if (result.status !== "ok") {
    throw new Error(
      `synthetic background launch failed for manager ${managerIndex}: ${result.error.context}`
    );
  }
  const record = JSON.parse(
    await readFile(result.log_path.replace(/\.log$/, ".json"), "utf8")
  ) as { readonly pgid: number };
  await Promise.all([
    waitForFile(leaderPidFile),
    waitForFile(descendantPidFile),
    waitForFile(heartbeatPath),
  ]);
  return {
    manager,
    identity: {
      taskId: result.task_id,
      managerIndex,
      conversationId: spec.conversationId,
      pgid: record.pgid,
      leaderPidFile,
      descendantPidFile,
      heartbeatPath,
    },
  };
}

async function waitForOwnedLeaderExits(
  config: OwnerConfig,
  tasks: ReadonlyArray<OwnedTask>
): Promise<void> {
  for (const [index, spec] of config.taskSpecs.entries()) {
    if (spec.leaderExitMs === undefined) continue;
    const task = tasks[index];
    if (task === undefined) continue;
    await waitForManagerTaskStatus(
      task.manager,
      task.identity.taskId,
      "exited"
    );
    emit({
      kind: "task-exited",
      owner: config.owner,
      taskId: task.identity.taskId,
      pgid: task.identity.pgid,
    });
  }
}

async function runOwnerControlLoop(
  owner: string,
  store: SessionStore,
  tasks: ReadonlyArray<OwnedTask>
): Promise<void> {
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of input) {
    const shouldExit = await handleOwnerCommand(line, owner, store, tasks);
    if (!shouldExit) continue;
    input.close();
    process.stdin.destroy();
    return;
  }
}

async function handleOwnerCommand(
  line: string,
  owner: string,
  store: SessionStore,
  tasks: ReadonlyArray<OwnedTask>
): Promise<boolean> {
  const liveTasks = (): ReadonlyArray<unknown> =>
    tasks.flatMap((task) => task.manager.listLiveTasks());
  if (line === "cancel") {
    emit({
      kind: "cancelled",
      owner,
      pid: process.pid,
      liveTasks: liveTasks(),
    });
    return false;
  }
  if (line === "snapshot") {
    emit({
      kind: "snapshot",
      owner,
      pid: process.pid,
      visibleSessionIds: visibleSessionIds(await store.list()),
      liveTasks: liveTasks(),
    });
    return false;
  }
  if (line !== "quit") return false;

  const shutdown = createTuiShutdownCoordinator(8_000);
  const report = await shutdown.begin(
    tasks.map((task, index) => ({
      name:
        index === 0
          ? "initial background manager"
          : `rebuilt background manager ${index}`,
      stop: () => task.manager.shutdown(),
    }))
  );
  emit({ kind: "shutdown-report", owner, report });
  process.exitCode = report.cleanupConfirmed ? 0 : 1;
  return true;
}

async function runWatchdog(args: ReadonlyArray<string>): Promise<void> {
  const mode = args[0];
  const noticePath = args[1];
  if (mode !== "stuck" && mode !== "residual") {
    throw new Error("watchdog mode must be stuck or residual");
  }
  if (noticePath === undefined) {
    throw new Error("watchdog mode requires a notice path");
  }

  let retainedHandle: ReturnType<typeof setInterval> | undefined;
  if (mode === "stuck" || mode === "residual") {
    retainedHandle = setInterval(() => undefined, 1000);
  }
  const coordinator = createTuiShutdownCoordinator(80);
  const operations =
    mode === "stuck"
      ? [
          {
            name: "stuck cleanup",
            stop: () => new Promise<void>(() => undefined),
          },
        ]
      : [];
  const report = await coordinator.begin(operations);
  emit({ kind: "shutdown-report", mode, report });
  // EXIT: this child deliberately retains a live interval to model a renderer
  // or native handle that stays referenced after TUI shutdown.
  scheduleTuiExitWatchdog(report, {
    delayMs: 60,
    onProcessStillAlive: (pendingReport) => {
      writeFileSync(noticePath, JSON.stringify(pendingReport), "utf8");
    },
  });
  void retainedHandle;
}

async function runPtyTui(): Promise<void> {
  const root = await mkdtempPtyRoot();
  const dataDir = join(root, "shared-data");
  const workspaceRoot = join(root, "workspace");
  let shutdownPromise:
    | ReturnType<ReturnType<typeof createTuiShutdownCoordinator>["begin"]>
    | undefined;
  let finishPromise: Promise<void> | undefined;
  let destroyRenderer: (() => void) | undefined;
  let stopOwnedWork: () => Promise<void> = async () => undefined;
  let readTaskStatus: () => Promise<string> = async () => "not-started";
  let taskId = "not-started";
  let taskPgid: number | undefined;
  const coordinator = createTuiShutdownCoordinator(8_000);
  const beginShutdown = (): NonNullable<typeof shutdownPromise> => {
    shutdownPromise ??= coordinator.begin([
      { name: "PTY fixture background manager", stop: stopOwnedWork },
    ]);
    return shutdownPromise;
  };
  const finishAfterRendererDestroy = (): Promise<void> => {
    finishPromise ??= (async () => {
      const report = await beginShutdown();
      const status = await readTaskStatus();
      await rm(root, { recursive: true, force: true });
      writeSync(
        1,
        `\r\nOWNED_PROCESS_FIXTURE_EXIT ${JSON.stringify({
          cleanupConfirmed: report.cleanupConfirmed,
          pendingOperations: report.pendingOperations,
          failedOperations: report.failedOperations,
          processId: process.pid,
          taskId,
          pgid: taskPgid,
          taskStatus: status,
        })}\r\n`
      );
      process.exitCode = report.cleanupConfirmed ? 0 : 1;
    })();
    return finishPromise;
  };

  try {
    await Promise.all([
      mkdir(dataDir, { recursive: true }),
      mkdir(workspaceRoot, { recursive: true }),
    ]);
    const tasksDir = resolveTasksDir({
      dataDir,
      projectIdentityRoot: workspaceRoot,
    });
    const runtimeDir = join(root, "runtime");
    await mkdir(runtimeDir, { recursive: true });
    const leaderPidFile = join(runtimeDir, "leader.pid");
    const descendantPidFile = join(runtimeDir, "descendant.pid");
    const heartbeatPath = join(runtimeDir, "heartbeat");
    const manager = createBackgroundTaskManager({
      tasksDir,
      spawn: async () =>
        spawn(
          "/bin/sh",
          [
            "-c",
            workerCommand({
              leaderPidFile,
              descendantPidFile,
              heartbeatPath,
              immuneDescendant: false,
            }),
          ],
          { cwd: workspaceRoot, detached: true, stdio: "ignore" }
        ),
    });
    stopOwnedWork = () => manager.shutdown();
    const task = await manager.spawn({
      command: "synthetic-pty-background-work",
      cwd: workspaceRoot,
      conversationId: "synthetic-pty-session",
    });
    if (task.status !== "ok") {
      throw new Error(
        `synthetic PTY task launch failed: ${task.error.context}`
      );
    }
    taskId = task.task_id;
    const registryPath = task.log_path.replace(/\.log$/, ".json");
    readTaskStatus = async () => {
      const record = JSON.parse(await readFile(registryPath, "utf8")) as {
        readonly status: string;
      };
      return record.status;
    };
    const taskRecord = JSON.parse(
      await readFile(task.log_path.replace(/\.log$/, ".json"), "utf8")
    ) as { readonly pgid: number };
    taskPgid = taskRecord.pgid;

    const bridge = {
      hub: {} as unknown as SessionHub,
      store: undefined as never,
      ensureSession: async (conversationId: string | undefined) =>
        conversationId ?? "synthetic-pty-session",
      postMessage: async ({
        conversationId,
      }: {
        readonly conversationId: string;
      }) => ({
        conversationId,
        finalText: "",
        stopReason: "completed" as const,
        turnCount: 1,
        jsonMode: false,
        lastUsage: null,
      }),
      listSessions: async () => [],
      loadSessionFile: async () => {
        throw new Error("unused: PTY fixture does not open persisted sessions");
      },
      openSession: async () => ({ file: null, recovery: undefined as never }),
      compactSession: async () => ({
        compacted: false,
        reason: "below_token_threshold" as const,
      }),
      continueSession: async () => {
        throw new Error("unused: PTY fixture does not continue sessions");
      },
      rewindSession: async () => ({ file: undefined as never }),
      listRewindTargets: async () => [],
      inflight: createInflightRegistry(),
      contextWindow: 200_000,
      listLiveBackgroundTasks: () => manager.listLiveTasks(),
      listSubagents: () => [],
      abortSubagentTask: () => false,
      abortSessionForegroundWork: () => [],
      subscribeSubagentTerminal: () => () => {},
      wakeFromSubagent: async () => undefined,
    } as unknown as TuiBridge;
    const session = Object.freeze({
      ...createDraftSession(),
      conversationId: "synthetic-pty-session",
      workspaceRoot,
    });

    const renderer = await createCliRenderer({
      exitOnCtrlC: false,
      screenMode: "alternate-screen",
    });
    destroyRenderer = () => {
      if (!renderer.isDestroyed) renderer.destroy();
    };
    const reactRoot = createRoot(renderer);
    renderer.once(CliRenderEvents.DESTROY, () => {
      void finishAfterRendererDestroy().catch((error: unknown) => {
        const detail =
          error instanceof Error
            ? (error.stack ?? error.message)
            : String(error);
        writeSync(2, `PTY fixture shutdown failed: ${detail}\n`);
        process.exitCode = 1;
      });
    });

    reactRoot.render(
      createElement(TuiApp, {
        bridge,
        askBridge: createTuiAskUserBridge(),
        toolEventSink: createToolEventSink(),
        cwd: workspaceRoot,
        dataDir,
        permissionMode: createPermissionModeContext("default"),
        sessionGrants: createSessionGrants(),
        initialSession: session,
        onQuit: () => {
          beginShutdown();
        },
      })
    );
  } catch (error) {
    beginShutdown();
    destroyRenderer?.();
    await finishAfterRendererDestroy();
    throw error;
  }
}

async function mkdtempPtyRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "iknow-owned-process-pty-"));
}

function workerCommand(opts: {
  readonly leaderPidFile: string;
  readonly descendantPidFile: string;
  readonly heartbeatPath: string;
  readonly immuneDescendant: boolean;
  readonly leaderExitMs?: number;
}): string {
  const q = shellQuote;
  const ignoredTerm = opts.immuneDescendant ? "trap '' TERM; " : "";
  const exactLeaderDelay =
    opts.leaderExitMs === undefined
      ? ""
      : `sleep ${opts.leaderExitMs / 1000}; exit 0`;
  return [
    `printf '%s\\n' "$$" > ${q(opts.leaderPidFile)}`,
    `(
      ${ignoredTerm}while :; do
        printf x >> ${q(opts.heartbeatPath)}
        sleep 0.04
      done
    ) &`,
    `printf '%s\\n' "$!" > ${q(opts.descendantPidFile)}`,
    opts.leaderExitMs === undefined ? "wait" : exactLeaderDelay,
  ].join("\n");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function visibleSessionIds(
  entries: ReadonlyArray<{ readonly conversation_id: string }>
): ReadonlyArray<string> {
  return entries.map((entry) => entry.conversation_id).sort();
}

async function waitUntilSharedSessionsVisible(
  store: SessionStore,
  expected: ReadonlyArray<string>
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const seen = new Set(visibleSessionIds(await store.list()));
    if (expected.every((id) => seen.has(id))) return;
    await delay(20);
  }
  throw new Error(
    "the shared SessionStore did not expose every synthetic owner session"
  );
}

async function watchSharedSessions(
  store: SessionStore,
  stop: { value: boolean },
  expected: ReadonlyArray<string>
): Promise<void> {
  while (!stop.value) {
    const seen = new Set(visibleSessionIds(await store.list()));
    if (expected.every((id) => seen.has(id))) {
      emit({
        kind: "shared-sessions-visible",
        visibleSessionIds: [...seen].sort(),
      });
    }
    await delay(100);
  }
}

async function waitForManagerTaskStatus(
  manager: ReturnType<typeof createBackgroundTaskManager>,
  taskId: string,
  expected: "exited"
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const status = await manager.status(taskId);
    if (status.status === expected) return;
    await delay(20);
  }
  throw new Error(`synthetic task ${taskId} did not reach ${expected}`);
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      await readFile(path, "utf8");
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await delay(10);
  }
  throw new Error(`synthetic process did not create ${path}`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const [mode, ...args] = process.argv.slice(2);
try {
  if (mode === "owner") {
    await runOwner(args);
  } else if (mode === "watchdog") {
    await runWatchdog(args);
  } else if (mode === "pty") {
    await runPtyTui();
  } else {
    throw new Error("fixture mode must be owner, watchdog, or pty");
  }
} catch (error) {
  const detail =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${detail}\n`);
  process.exitCode = 1;
}
