/**
 * Reconstructing one logical sub-agent task from what survived a host restart.
 *
 * The unit under test is the reader that turns a durable identity record plus
 * the worker's OWN transcript into a task entry, because after an abnormal host
 * exit the manager's in-memory map is gone and that entry is all a continuation
 * has to work from.
 *
 * Covered:
 *   1. a trusted record + transcript reconstruct an honest entry: the real task
 *      id, agent type, ownership, recorded state, and the transcript's own
 *      progress
 *   2. a TORN record is `untrusted`, never `absent` — the distinction that
 *      decides whether a caller may say "no such task"
 *   3. a torn trailing transcript append is reported as interrupted progress and
 *      is NOT counted as a committed record
 *   4. the transcript is never rewritten: reconstruction is read-only
 *   5. a missing transcript is an honest "no progress", not an invented one
 *   6. an unreadable meta yields no agent type rather than a guessed one
 *   7. the resume fields carry ownership and agent type, and invent nothing
 */
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";

import {
  rehydrateWorkerTask,
  rehydratedResumeFields,
  isTerminalWorkerState,
  type WorkerTaskRehydration,
  type WorkerTranscriptProgress,
} from "../../src/harness/subagent/worker-fact-rehydration.ts";
import {
  readWorkerIdentityRecords,
  writeWorkerIdentityRecord,
} from "../../src/harness/subagent/worker-identity-record.ts";
import {
  createSubAgentManager,
  SubAgentResumeError,
  type SubAgentManager,
} from "../../src/harness/subagent/manager.ts";
import { createDefaultSubAgentSpawn } from "../../src/harness/subagent/spawn.ts";
import {
  workerMetaPath,
  workerTranscriptPath,
} from "../../src/harness/sandbox/fence-tmp.ts";

const scratchPaths: string[] = [];

async function makeScratch(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  scratchPaths.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(
    scratchPaths
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true, maxRetries: 5 }))
  );
});

/**
 * The reconstructed entry's transcript progress, or an assertion failure. The
 * `&&` idiom would widen to `false` and lose the narrowing, so the union is
 * collapsed here once instead of at every use.
 */
function progressOf(entry: WorkerTaskRehydration): WorkerTranscriptProgress {
  assert.equal(entry.kind, "reconstructed");
  if (entry.kind !== "reconstructed") {
    throw new Error("unreachable: the kind was just asserted");
  }
  return entry.task.progress;
}

function recordFile(dir: string, taskId: string): string {
  return join(dir, taskId, `process-${taskId}.json`);
}

function transcriptFile(dir: string, taskId: string): string {
  return workerTranscriptPath(dir, taskId);
}

function writeTranscript(dir: string, taskId: string, lines: string[]): string {
  const path = transcriptFile(dir, taskId);
  writeFileSync(path, lines.map((l) => `${l}\n`).join(""), "utf8");
  return path;
}

describe("worker fact rehydration", () => {
  it("reconstructs an honest entry from a trusted record and the worker's own transcript", async () => {
    const dir = await makeScratch("iknow-rehydrate-ok-");
    writeWorkerIdentityRecord(dir, {
      task_id: "task-ok",
      ownership: "background",
      worker_state: "running",
      pid: 4242,
      starttime: 99,
      session_id: "conv-1",
      tool_use_id: "toolu_1",
    });
    writeWorkerIdentityRecord(dir, {
      task_id: "task-fg",
      ownership: "foreground",
      worker_state: "completed",
      pid: 4243,
      starttime: 100,
      session_id: "conv-1",
    });
    writeMeta(dir, "task-fg", { agentType: "reviewer" });
    writeTranscript(dir, "task-fg", [
      JSON.stringify({ role: "user", content: "do it" }),
      JSON.stringify({ role: "assistant", content: "done" }),
    ]);

    const ok = rehydrateWorkerTask(dir, "task-ok");
    assert.equal(ok.kind, "reconstructed");
    assert.equal(ok.kind === "reconstructed" && ok.task.task_id, "task-ok");
    assert.equal(
      ok.kind === "reconstructed" && ok.task.ownership,
      "background"
    );
    assert.equal(ok.kind === "reconstructed" && ok.task.state, "running");
    assert.equal(ok.kind === "reconstructed" && ok.task.session_id, "conv-1");
    assert.equal(ok.kind === "reconstructed" && ok.task.tool_use_id, "toolu_1");
    // The recorded state is the last transition the DEAD process published; it
    // is not upgraded to terminal just because the host is gone.
    assert.equal(
      ok.kind === "reconstructed" && isTerminalWorkerState(ok.task.state),
      false
    );

    const fg = rehydrateWorkerTask(dir, "task-fg");
    assert.equal(fg.kind === "reconstructed" && fg.task.agentType, "reviewer");
    assert.equal(fg.kind === "reconstructed" && fg.task.progress.committed, 2);
    assert.equal(
      fg.kind === "reconstructed" && fg.task.progress.lastRole,
      "assistant"
    );
    assert.equal(
      fg.kind === "reconstructed" && isTerminalWorkerState(fg.task.state),
      true
    );
  });

  it("a torn record is untrusted, never absent — a caller may only claim absence when nothing was written", async () => {
    const dir = await makeScratch("iknow-rehydrate-torn-");
    writeWorkerIdentityRecord(dir, {
      task_id: "task-torn",
      ownership: "background",
      worker_state: "running",
      pid: 5150,
      starttime: 7,
    });
    const path = recordFile(dir, "task-torn");
    const whole = readFileSync(path, "utf8");
    // Exactly what an interrupted write leaves behind: valid prefix, no end.
    writeFileSync(path, whole.slice(0, Math.floor(whole.length / 2)), "utf8");

    const result = rehydrateWorkerTask(dir, "task-torn");
    assert.equal(result.kind, "untrusted");
    assert.notEqual(result.kind, "absent");
    // "Cannot confirm" must never be reachable as "the worker is stopped".
    if (result.kind === "untrusted") {
      assert.ok(result.reason.length > 0);
    }
  });

  it("a record with a valid shape but a missing identity field is untrusted, not coerced", async () => {
    const dir = await makeScratch("iknow-rehydrate-nopid-");
    // Written directly rather than through the writer, so the fixture is a
    // hand-shaped file with a missing field and nothing else wrong with it.
    mkdirSync(join(dir, "task-nopid"), { recursive: true });
    writeFileSync(
      recordFile(dir, "task-nopid"),
      JSON.stringify({
        task_id: "task-nopid",
        ownership: "background",
        worker_state: "running",
        updated_at: new Date().toISOString(),
      }) + "\n",
      "utf8"
    );
    const result = rehydrateWorkerTask(dir, "task-nopid");
    assert.equal(result.kind, "untrusted");
  });

  it("a torn trailing transcript append is reported as interrupted and is not counted as progress", async () => {
    const dir = await makeScratch("iknow-rehydrate-tear-");
    writeWorkerIdentityRecord(dir, {
      task_id: "task-tt",
      ownership: "background",
      worker_state: "running",
      pid: 700,
      starttime: 3,
    });
    const path = writeTranscript(dir, "task-tt", [
      JSON.stringify({ role: "user", content: "go" }),
      JSON.stringify({ role: "assistant", content: "work" }),
    ]);
    // Half an append: the writer died mid-record.
    writeFileSync(path, `${readFileSync(path, "utf8")}{"role":"assist`, "utf8");

    const progress = progressOf(rehydrateWorkerTask(dir, "task-tt"));
    assert.equal(progress.committed, 2);
    assert.equal(progress.lastRole, "assistant");
    assert.equal(progress.interrupted, true);
  });

  it("reconstruction never rewrites the worker's transcript", async () => {
    const dir = await makeScratch("iknow-rehydrate-ro-");
    writeWorkerIdentityRecord(dir, {
      task_id: "task-ro",
      ownership: "foreground",
      worker_state: "failed",
      pid: 800,
      starttime: 4,
    });
    const path = writeTranscript(dir, "task-ro", [
      JSON.stringify({ role: "user", content: "q" }),
    ]);
    const before = await readFile(path, "utf8");

    rehydrateWorkerTask(dir, "task-ro");
    rehydrateWorkerTask(dir, "task-ro");

    // The worker's own append-only history stays independently readable and
    // byte-identical; a reader that "repaired" it would destroy the evidence.
    assert.equal(await readFile(path, "utf8"), before);
  });

  it("a missing transcript is honest no-progress rather than an invented state", async () => {
    const dir = await makeScratch("iknow-rehydrate-nott-");
    writeWorkerIdentityRecord(dir, {
      task_id: "task-nott",
      ownership: "background",
      worker_state: "running",
      pid: 900,
      starttime: 5,
    });
    const result = rehydrateWorkerTask(dir, "task-nott");
    assert.equal(result.kind, "reconstructed");
    const progress = progressOf(result);
    assert.equal(progress.present, false);
    assert.equal(progress.committed, 0);
    // The entry still names the transcript the continuation gate will require.
    assert.equal(
      result.kind === "reconstructed" && result.task.transcript_path,
      transcriptFile(dir, "task-nott")
    );
  });

  it("a task with no record at all is the only case that reports absent", async () => {
    const dir = await makeScratch("iknow-rehydrate-none-");
    const result = rehydrateWorkerTask(dir, "task-never");
    assert.equal(result.kind, "absent");
  });

  it("an unreadable meta leaves the agent type absent instead of guessed", async () => {
    const dir = await makeScratch("iknow-rehydrate-meta-");
    writeWorkerIdentityRecord(dir, {
      task_id: "task-meta",
      ownership: "background",
      worker_state: "running",
      pid: 1000,
      starttime: 6,
    });
    writeFileSync(workerMetaPath(dir, "task-meta"), "{not json", "utf8");
    const result = rehydrateWorkerTask(dir, "task-meta");
    assert.equal(
      result.kind === "reconstructed" && result.task.agentType,
      undefined
    );
  });

  it("the resume fields carry the reconstructed identity and invent no configuration", () => {
    const base = {
      task_id: "task-r",
      record: {
        task_id: "task-r",
        ownership: "background" as const,
        worker_state: "running" as const,
        pid: 1,
        starttime: 1,
        updated_at: "2026-01-01T00:00:00.000Z",
      },
      state: "running" as const,
      ownership: "background" as const,
      session_id: "conv-9",
      transcript_path: "/tmp/t.jsonl",
      agentType: "explore",
      progress: { committed: 1, interrupted: false, present: true },
    };
    const fields = rehydratedResumeFields(base);
    assert.equal(fields.conversationId, "conv-9");
    assert.equal(fields.role, "explore");
    // Background ownership is the absence of the drain-exclusion bit, and it
    // must not be invented in the other direction either.
    assert.equal(fields.excludeFromHostDrain, undefined);
    // maxTurns / timeoutMs / sandboxRoot are not recorded per task, so a
    // reconstructed entry must leave them absent rather than guess.
    assert.equal(Object.keys(fields).includes("maxTurns"), false);

    const fg = rehydratedResumeFields({
      ...base,
      ownership: "foreground",
    });
    assert.equal(fg.excludeFromHostDrain, true);
  });

  it("leaves no staged temp file behind next to a record it wrote", async () => {
    const dir = await makeScratch("iknow-rehydrate-tmp-");
    writeWorkerIdentityRecord(dir, {
      task_id: "task-tmp",
      ownership: "background",
      worker_state: "running",
      pid: 1100,
      starttime: 7,
    });
    const taskDir = join(dir, "task-tmp");
    const leftovers = readdirSync(taskDir).filter((name) =>
      name.includes(".tmp")
    );
    assert.deepEqual(leftovers, []);
    assert.equal(existsSync(recordFile(dir, "task-tmp")), true);
  });
});

function writeMeta(
  dir: string,
  taskId: string,
  meta: Record<string, unknown>
): void {
  writeFileSync(
    workerMetaPath(dir, taskId),
    JSON.stringify(meta) + "\n",
    "utf8"
  );
}

/**
 * A worker that appends one record to its OWN transcript, then holds the
 * process open. `.cjs` because it is started through the production spawn
 * factory as a plain script entry.
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
      JSON.stringify({ role: "user", content: [{ type: "text", text: envelope.task }] }) + "\\n",
      "utf8"
    );
  }
});
setInterval(() => {}, 1000);
`;

function writeWorkerScript(root: string, source: string, name: string): string {
  const path = join(root, name);
  writeFileSync(path, source, "utf8");
  return path;
}

function withWorkerScript<T>(script: string, run: () => T): T {
  const original = process.argv[1];
  process.argv[1] = script;
  try {
    return run();
  } finally {
    process.argv[1] = original;
  }
}

function makeManager(subagentsDir: string): SubAgentManager {
  const base = createDefaultSubAgentSpawn();
  return createSubAgentManager({
    spawn: (def, taskId, payload) => base(def, taskId, payload),
    subagentsDir,
    sandboxRoot: subagentsDir,
    // The production host always wires this; without it no record is written
    // and there is nothing for a later process to reconstruct from.
    runtimePersistence: {
      bind: () => ({
        publishSavedState: async () => {},
        appendOperationFact: async () => {},
      }),
    },
  });
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitUntilGone(pid: number, capMs = 5000): Promise<void> {
  const deadline = Date.now() + capMs;
  while (Date.now() < deadline && isAlive(pid)) {
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(isAlive(pid), false, `pid ${pid} is still alive`);
}

/**
 * One abnormal host: a manager that started a worker, then was abandoned.
 *
 * Waits for the worker to commit its first transcript record before returning,
 * because the rehydration case under test needs a worker that got as far as
 * persisting progress — killing it mid-handshake would test a worker that never
 * wrote anything.
 */
async function crashedHost(
  prefix: string,
  def: Record<string, unknown> = {}
): Promise<{
  readonly subagentsDir: string;
  readonly script: string;
  readonly taskId: string;
  readonly pid: number;
  readonly recordBytes: string;
}> {
  const root = await makeScratch(prefix);
  const subagentsDir = join(root, "subagents");
  mkdirSync(subagentsDir, { recursive: true });
  const script = writeWorkerScript(root, HOLD_WORKER, "worker.cjs");
  const manager = makeManager(subagentsDir);
  const taskId = withWorkerScript(
    script,
    () =>
      manager.spawn({
        task: "first turn",
        conversationId: "conv-1",
        ...def,
      } as never).taskId
  );
  const records = readWorkerIdentityRecords(subagentsDir).records;
  const record = records.find((r) => r.task_id === taskId);
  assert.ok(record, "the spawn must have recorded an identity");
  const recordBytes = readFileSync(recordFile(subagentsDir, taskId), "utf8");
  const deadline = Date.now() + 8000;
  while (
    Date.now() < deadline &&
    !existsSync(transcriptFile(subagentsDir, taskId))
  ) {
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.ok(
    existsSync(transcriptFile(subagentsDir, taskId)),
    "the worker must have committed its first transcript record"
  );
  return { subagentsDir, script, taskId, pid: record.pid, recordBytes };
}

/**
 * A second session root holding only what the CRASHED host had on disk at the
 * moment of its death: the record it wrote at dispatch, and the worker's own
 * transcript. Nothing here is reachable from a live manager, which is what
 * makes it a faithful restart — a manager that stays alive while its worker
 * dies would observe the exit and rewrite the record, so the reconstruction
 * case must be reconstructed from the snapshot instead.
 */
async function restartedCopy(
  host: {
    readonly subagentsDir: string;
    readonly taskId: string;
    readonly recordBytes: string;
  },
  prefix: string
): Promise<string> {
  const root = await makeScratch(prefix);
  const subagentsDir = join(root, "subagents");
  mkdirSync(join(subagentsDir, host.taskId), { recursive: true });
  writeFileSync(
    recordFile(subagentsDir, host.taskId),
    host.recordBytes,
    "utf8"
  );
  writeFileSync(
    transcriptFile(subagentsDir, host.taskId),
    readFileSync(transcriptFile(host.subagentsDir, host.taskId), "utf8"),
    "utf8"
  );
  return subagentsDir;
}

describe("continuation from a reconstructed entry (simulated host restart)", () => {
  it("continues a task that exists only on disk instead of answering not_found", async () => {
    const host = await crashedHost("iknow-rehydrate-restart-ok-");
    // The host dies abnormally: the worker is orphaned and then killed, so the
    // next process finds a record and a transcript but no in-memory task.
    process.kill(host.pid, "SIGKILL");
    await waitUntilGone(host.pid);

    const reopened = makeManager(host.subagentsDir);
    // Proof the map really is empty, so the continuation below can only have
    // come from the reconstructed entry.
    assert.deepEqual(
      reopened.listSubagents().map((i) => i.taskId),
      []
    );

    const resume = reopened.resumeTask;
    assert.ok(resume, "the manager must expose resumeTask");
    const taskId = withWorkerScript(
      host.script,
      () =>
        resume(host.taskId, {
          task: "second turn",
          conversationId: "conv-1",
        } as never).taskId
    );

    // Same external handle, and a REAL live task again — the reconstruction
    // produced an entry, not a fake settled one.
    assert.equal(taskId, host.taskId);
    assert.deepEqual(
      reopened.listSubagents().map((i) => i.taskId),
      [host.taskId]
    );
    reopened.abortTask(host.taskId);
    const record = readWorkerIdentityRecords(host.subagentsDir).records.find(
      (r) => r.task_id === host.taskId
    );
    await waitUntilGone(record?.pid ?? -1);
  });

  it("the reconstructed entry carries the honest progress and recorded state", async () => {
    const host = await crashedHost("iknow-rehydrate-restart-state-");
    process.kill(host.pid, "SIGKILL");
    await waitUntilGone(host.pid);
    // Read the record the crashed host left at dispatch, not one this still
    // living manager rewrote after observing the worker's crash.
    const subagentsDir = await restartedCopy(
      host,
      "iknow-rehydrate-state-copy-"
    );

    const entry = rehydrateWorkerTask(subagentsDir, host.taskId);
    assert.equal(entry.kind, "reconstructed");
    if (entry.kind !== "reconstructed") return;
    // Progress is the worker's OWN committed transcript, not a guess.
    assert.equal(entry.task.progress.present, true);
    assert.equal(entry.task.progress.committed, 1);
    assert.equal(entry.task.progress.lastRole, "user");
    assert.equal(entry.task.progress.interrupted, false);
    // Ownership and recorded state are the ones on disk.
    assert.equal(entry.task.ownership, "background");
    assert.equal(entry.task.session_id, "conv-1");
    // The host died while it was running, so the entry is NOT terminal.
    assert.equal(isTerminalWorkerState(entry.task.state), false);
  });

  it("refuses a task whose death cannot be proven, without claiming it never existed", async () => {
    const host = await crashedHost("iknow-rehydrate-restart-live-");
    // The worker is left ALIVE: a fresh process cannot prove it stopped, so
    // continuation must be blocked — and must not be reported as unknown.
    const reopened = makeManager(host.subagentsDir);
    const resume = reopened.resumeTask;
    assert.ok(resume);

    let thrown: unknown;
    try {
      withWorkerScript(host.script, () =>
        resume(host.taskId, { task: "second turn" } as never)
      );
    } catch (err) {
      thrown = err;
    }

    assert.ok(thrown instanceof SubAgentResumeError);
    const err = thrown as SubAgentResumeError;
    assert.equal(err.taskId, host.taskId);
    // "cannot confirm" is its own kind; `not_found` would tell the model the
    // task does not exist and send it off to spawn a duplicate.
    assert.equal(err.kind, "prior_process_unconfirmed");
    assert.notEqual(err.kind, "not_found");
    assert.ok((err.detail ?? "").length > 0, "the refusal must name a reason");

    process.kill(host.pid, "SIGKILL");
    await waitUntilGone(host.pid);
  });

  it("refuses a task whose record is torn, on the same unprovable surface", async () => {
    const host = await crashedHost("iknow-rehydrate-restart-torn-");
    process.kill(host.pid, "SIGKILL");
    await waitUntilGone(host.pid);
    const path = recordFile(host.subagentsDir, host.taskId);
    const whole = readFileSync(path, "utf8");
    writeFileSync(path, whole.slice(0, Math.floor(whole.length / 2)), "utf8");

    const reopened = makeManager(host.subagentsDir);
    const resume = reopened.resumeTask;
    assert.ok(resume);

    let thrown: unknown;
    try {
      withWorkerScript(host.script, () =>
        resume(host.taskId, { task: "second turn" } as never)
      );
    } catch (err) {
      thrown = err;
    }

    assert.ok(thrown instanceof SubAgentResumeError);
    const err = thrown as SubAgentResumeError;
    // A record that exists and cannot be read is "cannot confirm", never
    // "there is no such task" and never "it is fine to proceed".
    assert.equal(err.kind, "prior_process_unconfirmed");
    assert.match(err.detail ?? "", /untrusted/);
  });

  it("a task with no record and no transcript is still honestly not_found", async () => {
    const root = await makeScratch("iknow-rehydrate-restart-none-");
    const subagentsDir = join(root, "subagents");
    mkdirSync(subagentsDir, { recursive: true });
    const reopened = makeManager(subagentsDir);
    const resume = reopened.resumeTask;
    assert.ok(resume);

    assert.throws(
      () => resume("task-never-existed", { task: "hi" } as never),
      (err: unknown) =>
        err instanceof SubAgentResumeError && err.kind === "not_found"
    );
  });
});
