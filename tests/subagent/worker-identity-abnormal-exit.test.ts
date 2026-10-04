/**
 * Session-owned worker lifecycle through the manager: identity persistence,
 * abnormal-exit stop, and the pre-continuation death proof (spec
 * `session-checkpoint-architecture.md` §2 item 6 + §4, SC16 / SC17).
 *
 * Real child processes throughout, spawned through the production spawn
 * factory (the `process.argv[1]` swap used by
 * `worktree-gate-propagation.test.ts` / `fs-mode-propagation.test.ts`), so the
 * identity under test is the one a real spawn produces. "Abnormal parent
 * termination" is modelled the way it actually reaches this layer: the spawning
 * manager is dropped WITHOUT `shutdown()` (its children are reachable only
 * through its in-memory handles), and a FRESH manager — empty task map, no
 * child references — reconciles the owned workers from the durable identity
 * records alone.
 *
 * Covered:
 *   1. spawn records (pid, startTime) + ownership + transcript reference, for a
 *      foreground worker and a `wait:false` worker
 *   2. the same identity reaches the parent runtime state as worker facts
 *   3. a fresh manager stops both real children and confirms their ORIGINAL
 *      identities (positive SC16)
 *   4. continuation is blocked while the prior identity is still live, and
 *      permitted once it is confirmed stopped
 *   5. a recycled pid is never signalled and reports not-ours
 *   6. an unconfirmable identity is never signalled, reports needs handling, and
 *      blocks continuation
 *   7. a needs-handling worker stays visibly unsettled — never complete
 *   8. absent binder → no record file, no fact, same worker behavior
 *   9. worker transcripts stay independently readable and are never merged
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "vitest";

import { readProcStartTime } from "../../src/harness/background/proc.ts";
import {
  createSubAgentManager,
  SubAgentResumeError,
  type SubAgentManager,
} from "../../src/harness/subagent/manager.ts";
import { createDefaultSubAgentSpawn } from "../../src/harness/subagent/spawn.ts";
import { workerTranscriptPath } from "../../src/harness/sandbox/fence-tmp.ts";
import {
  readWorkerIdentityRecords,
  writeWorkerIdentityRecord,
  type WorkerIdentityRecord,
} from "../../src/harness/subagent/worker-identity-record.ts";
import { sweepOwnedWorkers } from "../../src/harness/subagent/worker-identity-stop.ts";
import type { AnthropicNativeMessage } from "../../src/harness/model-adapter/types.ts";
import type {
  RuntimePersistenceBinder,
  RuntimeWorkerFact,
} from "../../src/shared/runtime-persistence.ts";

const scratchPaths: string[] = [];
/** Every real pid this file created, reaped in afterEach however the test ends. */
const livePids: number[] = [];
/** tsx loader for the host process — the same one the spawn factory resolves. */
const tsxLoader = createRequire(import.meta.url).resolve("tsx");

afterEach(async () => {
  for (const pid of livePids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // EXIT: already gone — the assertion under test stopped it.
    }
  }
  // A reaped child can still be mid-write (its own transcript pad), so wait
  // for the processes to actually be gone before deleting their directories.
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline && livePids.some(isAlive)) {
    await new Promise((r) => setTimeout(r, 20));
  }
  livePids.length = 0;
  await Promise.all(
    scratchPaths.splice(0).map((path) =>
      rm(path, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      })
    )
  );
});

async function makeScratch(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  scratchPaths.push(path);
  return path;
}

/**
 * A worker that reads its envelope, appends one native message to its OWN
 * transcript, then holds the process open. `.cjs` because it is spawned
 * through the production factory as a plain script entry.
 */
const HOLD_WORKER = `
const fs = require("node:fs");
const path = require("node:path");
let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  if (!buf.includes("\\n")) return;
  const envelope = JSON.parse(buf.split("\\n", 1)[0]);
  if (typeof envelope.transcriptPath === "string") {
    fs.mkdirSync(path.dirname(envelope.transcriptPath), { recursive: true });
    fs.appendFileSync(
      envelope.transcriptPath,
      JSON.stringify({
        role: "user",
        content: [{ type: "text", text: envelope.task }],
      }) + "\\n",
      "utf8"
    );
  }
  setInterval(() => {}, 1000);
});
`;

/** The same, plus a terminal result envelope on stdout while the process stays alive. */
const RESULT_THEN_HOLD_WORKER = HOLD_WORKER.replace(
  "  setInterval(() => {}, 1000);",
  `  process.stdout.write(
    JSON.stringify({ status: "ok", summary: "done", result: "ok result" }) + "\\n"
  );
  setInterval(() => {}, 1000);`
);

function writeWorkerScript(root: string, source: string, name: string): string {
  const path = join(root, name);
  // Synchronous: the spawn factory reads process.argv[1] at spawn time.
  writeFileSync(path, source, "utf8");
  return path;
}

/**
 * The abnormal host, as a real process.
 *
 * One script with two roles, the same shape the real entry has: the worker arm
 * is what the production spawn factory starts (it re-enters this file with
 * `--subagent-worker`), the host arm owns a REAL manager, starts one foreground
 * and one `wait:false` worker, prints what it started, and then dies through
 * `process.exit` — no `shutdown()`, no `abortTask`, no exit handler, exactly
 * the path an abnormal host termination takes.
 *
 * It loads the harness modules by absolute path under the tsx loader the test
 * process already resolves, so the manager it drives is the production one.
 */
function writeHostScript(root: string): string {
  const managerModule = resolveHarness("src/harness/subagent/manager.ts");
  const spawnModule = resolveHarness("src/harness/subagent/spawn.ts");
  return writeWorkerScript(
    root,
    `
if (process.argv.includes("--subagent-worker")) {
  // Worker arm: the entry the production spawn factory starts. Deliberately
  // before any harness require, because this process runs WITHOUT the tsx
  // loader (the factory builds a plain entry + flag for a .cjs script).
  ${HOLD_WORKER}
} else {
  const fs = require("node:fs");
  const { createSubAgentManager } = require(${JSON.stringify(managerModule)});
  const { createDefaultSubAgentSpawn } = require(${JSON.stringify(spawnModule)});
  const [subagentsDir, script] = process.argv.slice(2);
  const base = createDefaultSubAgentSpawn();
  const started = [];
  const manager = createSubAgentManager({
    spawn: (def, taskId, payload) => {
      const child = base(def, taskId, payload);
      started.push({ taskId, pid: child.pid });
      return child;
    },
    subagentsDir,
    sandboxRoot: subagentsDir,
    // The production host always wires this; without it no identity is
    // recorded and there is nothing for a recovery process to reconcile.
    runtimePersistence: {
      bind: () => ({
        publishSavedState: async () => {},
        appendOperationFact: async () => {},
      }),
    },
  });
  for (const def of [
    { task: "foreground work", excludeFromHostDrain: true },
    { task: "background work" },
  ]) {
    const original = process.argv[1];
    process.argv[1] = script;
    try {
      manager.spawn({ ...def, conversationId: "conv-1" });
    } finally {
      process.argv[1] = original;
    }
  }
  // Synchronous write: process.exit below must not truncate the receipt.
  fs.writeSync(1, JSON.stringify({ started }) + "\\n");
  // Abnormal termination: the child handles stay in this dying process and
  // the workers stay running.
  setTimeout(() => process.exit(0), 400);
}
`,
    "host.cjs"
  );
}

/**
 * Absolute path of a harness module, resolved from this test file so the host
 * script loads the SAME source the test process is exercising.
 */
function resolveHarness(relative: string): string {
  return fileURLToPath(
    new URL(relative, import.meta.url.replace(/tests.*$/, ""))
  );
}

/** Run the host script to its abnormal death; return what it said it started. */
async function runHostUntilDead(
  hostScript: string,
  subagentsDir: string
): Promise<ReadonlyArray<{ taskId: string; pid: number }>> {
  const child = spawn(
    process.execPath,
    ["--import", tsxLoader, hostScript, subagentsDir, hostScript],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  let out = "";
  let err = "";
  child.stdout.on("data", (c: Buffer) => {
    out += c.toString("utf8");
  });
  child.stderr.on("data", (c: Buffer) => {
    err += c.toString("utf8");
  });
  const code = await new Promise<number | null>((resolvePromise) => {
    child.once("error", () => resolvePromise(null));
    child.once("close", resolvePromise);
  });
  assert.equal(code, 0, `host exited abnormally: ${err}`);
  const parsed = JSON.parse(out.trim().split("\n")[0] ?? "{}") as {
    started?: ReadonlyArray<{ taskId: string; pid: number }>;
  };
  assert.equal((parsed.started ?? []).length, 2, `host started: ${out}${err}`);
  return parsed.started as ReadonlyArray<{ taskId: string; pid: number }>;
}

interface RecordingSink {
  readonly binder: RuntimePersistenceBinder<AnthropicNativeMessage>;
  readonly facts: RuntimeWorkerFact[];
  readonly boundSessions: string[];
}

function makeRecordingSink(): RecordingSink {
  const facts: RuntimeWorkerFact[] = [];
  const boundSessions: string[] = [];
  return {
    facts,
    boundSessions,
    binder: {
      bind: (sessionId) => {
        boundSessions.push(sessionId ?? "<none>");
        return {
          publishSavedState: async () => {},
          appendOperationFact: async (fact) => {
            if (fact.kind === "worker_progress") facts.push(fact);
          },
        };
      },
    },
  };
}

function makeManager(
  subagentsDir: string,
  sink: RecordingSink | undefined,
  onSpawn?: (pid: number | undefined) => void
): SubAgentManager {
  const base = createDefaultSubAgentSpawn();
  return createSubAgentManager({
    spawn: (def, taskId, payload) => {
      const child = base(def, taskId, payload);
      onSpawn?.(child.pid);
      return child;
    },
    subagentsDir,
    sandboxRoot: subagentsDir,
    ...(sink !== undefined ? { runtimePersistence: sink.binder } : {}),
  });
}

/** Run a manager call that spawns, with a scratch worker entry (argv[1] swap). */
function withWorkerScript<T>(workerScript: string, run: () => T): T {
  const originalArgv1 = process.argv[1];
  process.argv[1] = workerScript;
  try {
    return run();
  } finally {
    process.argv[1] = originalArgv1;
  }
}

/** Spawn through the production factory with a scratch worker entry. */
function spawnRealWorker(
  manager: SubAgentManager,
  workerScript: string,
  def: Record<string, unknown>
): string {
  return withWorkerScript(
    workerScript,
    () => manager.spawn(def as never).taskId
  );
}

/** Resume through the production factory with a scratch worker entry. */
function resumeRealWorker(
  manager: SubAgentManager,
  workerScript: string,
  taskId: string,
  def: Record<string, unknown>
): string {
  return withWorkerScript(workerScript, () => {
    const resume = manager.resumeTask;
    assert.ok(resume, "the manager must expose resumeTask");
    return resume(taskId, def as never).taskId;
  });
}

function recordsOf(subagentsDir: string): Map<string, WorkerIdentityRecord> {
  return new Map(
    readWorkerIdentityRecords(subagentsDir).records.map((r) => [r.task_id, r])
  );
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitUntil(
  predicate: () => boolean,
  capMs = 8000
): Promise<boolean> {
  const deadline = Date.now() + capMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return predicate();
}

function requireRecord(
  subagentsDir: string,
  taskId: string
): WorkerIdentityRecord {
  const record = recordsOf(subagentsDir).get(taskId);
  assert.ok(record, `no identity record for ${taskId}`);
  livePids.push(record.pid);
  return record;
}

async function newHost(
  prefix: string,
  workerSource: string
): Promise<{
  readonly manager: SubAgentManager;
  readonly subagentsDir: string;
  readonly workerScript: string;
}> {
  return newHostIn(await makeScratch(prefix), workerSource);
}

async function newHostIn(
  root: string,
  workerSource: string
): Promise<{
  readonly manager: SubAgentManager;
  readonly subagentsDir: string;
  readonly workerScript: string;
}> {
  const subagentsDir = join(root, "subagents");
  await mkdir(subagentsDir, { recursive: true });
  return {
    manager: makeManager(subagentsDir, undefined),
    subagentsDir,
    workerScript: writeWorkerScript(root, workerSource, "worker.cjs"),
  };
}

describe("worker identity through the manager", () => {
  it("records (pid, startTime), ownership and the transcript reference for a foreground and a wait:false worker", async () => {
    const host = await newHost("iknow-wid-mgr-", HOLD_WORKER);
    const sink = makeRecordingSink();
    const manager = makeManager(host.subagentsDir, sink);

    const foreground = spawnRealWorker(manager, host.workerScript, {
      task: "foreground work",
      excludeFromHostDrain: true,
      conversationId: "conv-1",
      toolUseId: "toolu_fg",
    });
    const background = spawnRealWorker(manager, host.workerScript, {
      task: "background work",
      conversationId: "conv-1",
      toolUseId: "toolu_bg",
    });

    for (const taskId of [foreground, background]) {
      const record = requireRecord(host.subagentsDir, taskId);
      assert.ok(isAlive(record.pid), "the recorded pid must be a live child");
      // A real /proc pairing, not a copied number.
      assert.equal(record.starttime, readProcStartTime(record.pid));
      assert.equal(
        record.transcript_path,
        workerTranscriptPath(host.subagentsDir, taskId)
      );
      assert.ok(["starting", "running"].includes(record.worker_state));
    }

    const records = recordsOf(host.subagentsDir);
    assert.equal(records.get(foreground)?.ownership, "foreground");
    assert.equal(records.get(background)?.ownership, "background");
    assert.equal(records.get(foreground)?.tool_use_id, "toolu_fg");
    assert.equal(records.get(background)?.tool_use_id, "toolu_bg");
    assert.notEqual(records.get(foreground)?.pid, records.get(background)?.pid);

    for (const taskId of [foreground, background]) {
      const forTask = sink.facts.filter((f) => f.taskId === taskId);
      assert.deepEqual(
        forTask.map((f) => f.state),
        ["starting", "running"]
      );
      const first = forTask[0];
      assert.equal(first?.process?.pid, records.get(taskId)?.pid);
      assert.equal(first?.process?.startTime, records.get(taskId)?.starttime);
      assert.equal(
        first?.transcriptPath,
        workerTranscriptPath(host.subagentsDir, taskId)
      );
      assert.equal(first?.ownership, records.get(taskId)?.ownership);
    }
    // The binder is resolved per session id, not once globally.
    assert.ok(sink.boundSessions.includes("conv-1"));
  });

  it("an abnormal parent termination leaves both real children, and a fresh manager stops them by identity", async () => {
    const root = await makeScratch("iknow-wid-abnormal-");
    const subagentsDir = join(root, "subagents");
    await mkdir(subagentsDir, { recursive: true });
    const hostScript = writeHostScript(root);

    // The host is a REAL separate process: it owns a real manager, starts a
    // foreground and a wait:false worker, then dies without shutdown(),
    // abortTask or any other cleanup — the abnormal-exit case. Its exit
    // handlers die with it, so nothing in the recovery process can observe the
    // children leaving.
    const owned = await runHostUntilDead(hostScript, subagentsDir);
    const identities = new Map(
      owned.map(({ taskId, pid }) => {
        livePids.push(pid);
        assert.ok(isAlive(pid), "an abandoned worker must outlive its host");
        const starttime = readProcStartTime(pid);
        assert.notEqual(starttime, undefined);
        return [taskId, { pid, starttime: starttime as number }] as const;
      })
    );
    const before = recordsOf(subagentsDir);
    for (const [taskId, identity] of identities) {
      assert.equal(before.get(taskId)?.pid, identity.pid);
      assert.equal(before.get(taskId)?.starttime, identity.starttime);
    }
    assert.deepEqual(owned.map((o) => before.get(o.taskId)?.ownership).sort(), [
      "background",
      "foreground",
    ]);

    // Recovery: a manager in THIS process, with an empty task map and no child
    // references at all.
    const sink = makeRecordingSink();
    const recovery = makeManager(subagentsDir, sink);
    const swept = await recovery.stopOwnedWorkers?.();
    assert.ok(swept, "the manager must expose the owned-worker stop path");
    assert.deepEqual(swept?.unreadable, []);
    assert.equal(swept?.workers.length, 2);

    for (const worker of swept?.workers ?? []) {
      assert.equal(worker.state, "confirmed_stopped");
      assert.equal(worker.signalled, true);
      // The verdict is about the ORIGINAL identity, and the process behind it
      // is really gone.
      assert.equal(worker.pid, identities.get(worker.taskId)?.pid);
      assert.equal(await waitUntil(() => !isAlive(worker.pid)), true);
    }

    const after = recordsOf(subagentsDir);
    for (const [taskId, identity] of identities) {
      const record = after.get(taskId);
      assert.equal(record?.pid, identity.pid);
      assert.equal(record?.starttime, identity.starttime);
      assert.equal(record?.stop?.outcome, "confirmed_stopped");
      assert.equal(record?.stop?.signalled, true);
      // The host died without a terminal record, so the worker stays unsettled
      // on disk: a confirmed stop is not a completion.
      assert.equal(record?.worker_state, "running");
    }
    // Recovery appends only the two proven stops — never a completion it did
    // not observe.
    assert.equal(sink.facts.filter((f) => f.state === "completed").length, 0);
    assert.equal(sink.facts.filter((f) => f.state === "stopped").length, 2);
  });
  it("blocks continuation while the prior identity is live, and permits it once confirmed stopped", async () => {
    const host = await newHost("iknow-wid-continue-", RESULT_THEN_HOLD_WORKER);
    const sink = makeRecordingSink();
    const manager = makeManager(host.subagentsDir, sink);

    const taskId = spawnRealWorker(manager, host.workerScript, {
      task: "first turn",
      conversationId: "conv-1",
    });
    const first = requireRecord(host.subagentsDir, taskId);
    // The worker reported a terminal result but its process is still there:
    // exactly the case where "the task looks dead" must not be enough.
    assert.equal(
      await waitUntil(() => manager.queryBuffer(taskId).status === "ok"),
      true
    );
    assert.equal(
      existsSync(workerTranscriptPath(host.subagentsDir, taskId)),
      true
    );
    assert.equal(isAlive(first.pid), true);

    assert.throws(
      () => manager.resumeTask?.(taskId, { task: "second turn" }),
      (err: unknown) => {
        assert.ok(err instanceof SubAgentResumeError);
        assert.equal(err.kind, "prior_process_unconfirmed");
        return true;
      }
    );
    assert.equal(isAlive(first.pid), true, "the refusal signals nothing");

    // Once the identity is provably gone, continuation proceeds — under the
    // SAME external handle, with a new process identity.
    const stopped = (await sweepOwnedWorkers(host.subagentsDir)).workers.find(
      (w) => w.taskId === taskId
    );
    assert.equal(stopped?.state, "confirmed_stopped");
    assert.equal(await waitUntil(() => !isAlive(first.pid)), true);

    const resumed = resumeRealWorker(manager, host.workerScript, taskId, {
      task: "second turn",
    });
    assert.equal(resumed, taskId, "the external handle stays the task id");
    const second = requireRecord(host.subagentsDir, taskId);
    assert.notEqual(second.pid, first.pid);
    assert.equal(second.starttime, readProcStartTime(second.pid));
    assert.equal(second.stop, undefined, "the new process is unverified");
    assert.notEqual(manager.queryBuffer(taskId).status, "not_found");
  });

  it("never signals a recycled pid and reports it as not-ours", async () => {
    const root = await makeScratch("iknow-wid-recycled-");
    const host = await newHostIn(root, HOLD_WORKER);
    const sink = makeRecordingSink();
    const manager = makeManager(host.subagentsDir, sink);

    const taskId = spawnRealWorker(manager, host.workerScript, {
      task: "recycled",
      conversationId: "conv-1",
    });
    const record = requireRecord(host.subagentsDir, taskId);
    assert.equal(isAlive(record.pid), true);

    // The pid now carries a different start time: the kernel handed it to
    // someone else. Point the record at that other process and re-sweep.
    writeWorkerIdentityRecord(host.subagentsDir, {
      ...record,
      starttime: (record.starttime as number) + 1,
    });

    // The reopened session's root is passed explicitly here: the per-
    // conversation layout derives it from the session, not from assembly.
    const recovery = makeManager(join(root, "no-such-assembly-dir"), sink);
    const worker = (
      await recovery.stopOwnedWorkers?.({ subagentsDir: host.subagentsDir })
    )?.workers.find((w) => w.taskId === taskId);
    assert.equal(worker?.state, "not_ours");
    assert.equal(worker?.signalled, false);
    assert.equal(worker?.cleanup.state, "not_started");
    assert.equal(isAlive(record.pid), true, "the occupant is left alone");
  });

  it("an unconfirmable identity is never signalled, reports needs handling, and blocks continuation", async () => {
    const host = await newHost(
      "iknow-wid-unconfirmable-",
      RESULT_THEN_HOLD_WORKER
    );
    const sink = makeRecordingSink();
    const manager = makeManager(host.subagentsDir, sink);

    const taskId = spawnRealWorker(manager, host.workerScript, {
      task: "unconfirmable",
      conversationId: "conv-1",
    });
    const record = requireRecord(host.subagentsDir, taskId);
    assert.equal(
      await waitUntil(() => manager.queryBuffer(taskId).status === "ok"),
      true
    );
    // The identity the record carries can no longer be matched against the OS.
    writeWorkerIdentityRecord(host.subagentsDir, {
      ...record,
      starttime: null,
    });

    const recovery = makeManager(host.subagentsDir, sink);
    const worker = (await recovery.stopOwnedWorkers?.())?.workers.find(
      (w) => w.taskId === taskId
    );
    assert.equal(worker?.state, "needs_handling");
    assert.equal(worker?.signalled, false);
    assert.equal(worker?.cleanup.state, "unconfirmed");
    assert.equal(
      isAlive(record.pid),
      true,
      "an unprovable target is not signalled"
    );

    // Visible on the durable record, and the worker's own state is untouched.
    const stored = recordsOf(host.subagentsDir).get(taskId);
    assert.equal(stored?.stop?.outcome, "needs_handling");
    assert.equal(stored?.worker_state, "running");

    assert.throws(
      () => manager.resumeTask?.(taskId, { task: "next" }),
      (err: unknown) => {
        assert.ok(err instanceof SubAgentResumeError);
        assert.equal(err.kind, "prior_process_unconfirmed");
        return true;
      }
    );
    assert.equal(isAlive(record.pid), true);
  });

  it("without a binder no identity record is written and workers behave as before", async () => {
    const host = await newHost("iknow-wid-no-binder-", RESULT_THEN_HOLD_WORKER);
    const spawned: number[] = [];
    const manager = makeManager(host.subagentsDir, undefined, (pid) => {
      if (pid !== undefined) spawned.push(pid);
    });

    const taskId = spawnRealWorker(manager, host.workerScript, {
      task: "no binder",
      conversationId: "conv-1",
    });
    livePids.push(...spawned);
    assert.equal(
      await waitUntil(() => manager.queryBuffer(taskId).status === "ok"),
      true
    );

    assert.deepEqual(readWorkerIdentityRecords(host.subagentsDir), {
      records: [],
      unreadable: [],
    });
    // Only the pre-existing per-agent files and the worker's own transcript.
    for (const entry of await readdir(join(host.subagentsDir, taskId))) {
      assert.ok(
        !entry.startsWith("process-"),
        `unexpected identity record beside the worker files: ${entry}`
      );
    }
  });

  it("keeps each worker transcript independently readable and out of the parent record", async () => {
    const host = await newHost("iknow-wid-transcript-", HOLD_WORKER);
    const sink = makeRecordingSink();
    const manager = makeManager(host.subagentsDir, sink);

    const first = spawnRealWorker(manager, host.workerScript, {
      task: "first",
      conversationId: "conv-1",
    });
    const second = spawnRealWorker(manager, host.workerScript, {
      task: "second",
      conversationId: "conv-1",
    });
    requireRecord(host.subagentsDir, first);
    requireRecord(host.subagentsDir, second);
    assert.equal(
      await waitUntil(
        () =>
          existsSync(workerTranscriptPath(host.subagentsDir, first)) &&
          existsSync(workerTranscriptPath(host.subagentsDir, second))
      ),
      true
    );

    const firstBody = await readFile(
      workerTranscriptPath(host.subagentsDir, first),
      "utf8"
    );
    const secondBody = await readFile(
      workerTranscriptPath(host.subagentsDir, second),
      "utf8"
    );
    // Each transcript holds only its own worker's events, in its own file.
    assert.match(firstBody, /"first"/);
    assert.doesNotMatch(firstBody, /"second"/);
    assert.match(secondBody, /"second"/);
    assert.doesNotMatch(secondBody, /"first"/);

    // Neither the identity record nor the stop pass merges worker events into
    // the parent-side per-agent trace.
    const traceBody = await readFile(
      join(host.subagentsDir, first, `agent-${first}.jsonl`),
      "utf8"
    );
    assert.doesNotMatch(traceBody, /"text":"first"/);
  });
});
