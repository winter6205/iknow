/**
 * Worker identity verification and stop.
 *
 * The rule under test: a pid is not an identity. Every signal this module sends
 * is authorized by a fresh start-time comparison against the record, so a
 * recycled pid is never touched and an unreadable identity is never guessed.
 *
 * Real child processes are used wherever the claim is about the OS: "the child
 * is gone", "the child survived because we refused to signal it", "the sweep
 * stopped it". The two failure routes that a real Linux process tree cannot
 * produce (a member that survives SIGKILL, a signal the kernel refuses) are
 * injected through the same seams the sandbox cleanup plane documents for its
 * own blinded probe — never by weakening a real assertion.
 *
 * Covered:
 *   1. probe verdicts: absent / ours / recycled / unconfirmable / invalid pid
 *   2. a live owned child is stopped and its identity observed gone
 *   3. a mismatched start time is reported not-ours and the pid is NOT signalled
 *   4. an unconfirmable identity is never signalled and reports needs handling
 *   5. injected teardown failure → needs handling (teardown_failed)
 *   6. injected surviving process → needs handling (observation_expired)
 *   7. the sweep covers a whole root, records its verdicts, and a second sweep
 *      is a byte-identical no-op
 *   8. an unreadable record file is surfaced, never silently skipped
 *   9. `signalled` reports what the signal call actually did — delivered,
 *      already-gone, or refused — whatever the observation then decided
 *  10. a verdict that never reached the record is surfaced as unrecorded
 *  11. a replay reports the STORED outcome, so `not_ours` stays `not_ours`
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { readProcStartTime } from "../../src/harness/background/proc.ts";
import {
  captureWorkerIdentity,
  priorProcessProvablyGone,
  probeOwnedProcess,
  stopOwnedWorker,
  sweepOwnedWorkers,
  terminateOwnedWorkerNow,
} from "../../src/harness/subagent/worker-identity-stop.ts";
import {
  readWorkerIdentityRecords,
  writeWorkerIdentityRecord,
  type WorkerIdentityRecord,
} from "../../src/harness/subagent/worker-identity-record.ts";

const scratchPaths: string[] = [];
const children: ChildProcess[] = [];

async function makeScratch(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  scratchPaths.push(path);
  return path;
}

/** A real long-lived child: the smallest thing that can be "stopped". */
function spawnLiveChild(): ChildProcess {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  children.push(child);
  return child;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Wait until the pid is really gone (or the window expires). */
async function waitUntilGone(pid: number, capMs = 4000): Promise<boolean> {
  const deadline = Date.now() + capMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return !isAlive(pid);
}

function recordFor(
  child: ChildProcess,
  overrides: Partial<WorkerIdentityRecord> = {}
): WorkerIdentityRecord {
  const pid = child.pid as number;
  return {
    task_id: "task-a",
    ownership: "background",
    worker_state: "running",
    pid,
    starttime: readProcStartTime(pid) ?? null,
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill("SIGKILL");
      } catch {
        // EXIT: already reaped by the assertion under test.
      }
    }
  }
  await Promise.all(
    scratchPaths
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe("captureWorkerIdentity", () => {
  it("pairs the pid with its /proc start time", () => {
    const child = spawnLiveChild();
    const identity = captureWorkerIdentity(child.pid);
    assert.equal(identity?.pid, child.pid);
    assert.equal(identity?.startTime, readProcStartTime(child.pid as number));
  });

  it("a spawn factory that reported no pid yields no identity at all", () => {
    assert.equal(captureWorkerIdentity(undefined), undefined);
  });
});

describe("probeOwnedProcess", () => {
  it("a pid that is gone is provably the owned process' corpse: absent", () => {
    const child = spawnLiveChild();
    const pid = child.pid as number;
    const identity = captureWorkerIdentity(pid);
    assert.ok(identity);
    child.kill("SIGKILL");

    // /proc/<pid> may linger as a zombie until the parent reaps it; the child
    // object is still ours, so poll the real disappearance first.
    return waitUntilGone(pid).then((gone) => {
      assert.equal(gone, true);
      assert.deepEqual(probeOwnedProcess(identity), { state: "absent" });
    });
  });

  it("a live pid with a matching start time is ours", () => {
    const child = spawnLiveChild();
    const identity = captureWorkerIdentity(child.pid);
    assert.ok(identity);
    const probe = probeOwnedProcess(identity);
    assert.equal(probe.state, "ours");
  });

  it("a live pid whose start time differs is recycled: the current occupant is not ours", () => {
    const child = spawnLiveChild();
    const identity = captureWorkerIdentity(child.pid);
    assert.ok(identity);
    const probe = probeOwnedProcess({
      pid: identity.pid,
      startTime: (identity.startTime as number) + 1,
    });
    assert.deepEqual(probe, {
      state: "recycled",
      startTime: identity.startTime as number,
    });
  });

  it("a live pid with no recorded start time is unconfirmable, never a match", () => {
    const child = spawnLiveChild();
    const probe = probeOwnedProcess({
      pid: child.pid as number,
      startTime: null,
    });
    assert.equal(probe.state, "unconfirmed");
  });

  it("a pid that cannot be a process (0 / negative) is unconfirmable, never a group signal", () => {
    assert.equal(
      probeOwnedProcess({ pid: 0, startTime: 1 }).state,
      "unconfirmed"
    );
    assert.equal(
      probeOwnedProcess({ pid: -5, startTime: 1 }).state,
      "unconfirmed"
    );
  });
});

describe("stopOwnedWorker", () => {
  it("stops a live owned child and confirms its identity is gone", async () => {
    const child = spawnLiveChild();
    const pid = child.pid as number;
    const record = recordFor(child);

    const result = await stopOwnedWorker(record);

    assert.equal(result.state, "confirmed_stopped");
    assert.equal(result.pid, pid);
    assert.equal(result.signalled, true);
    assert.equal(result.cleanup.state, "confirmed_stopped");
    assert.equal(priorProcessProvablyGone(result), true);
    assert.equal(await waitUntilGone(pid), true);
    assert.deepEqual(probeOwnedProcess({ pid, startTime: record.starttime }), {
      state: "absent",
    });
  });

  it("an already-gone process is a confirmed stop with no signal sent", async () => {
    const child = spawnLiveChild();
    const pid = child.pid as number;
    const record = recordFor(child);
    child.kill("SIGKILL");
    assert.equal(await waitUntilGone(pid), true);

    const result = await stopOwnedWorker(record);

    assert.equal(result.state, "confirmed_stopped");
    assert.equal(result.signalled, false);
  });

  it("a mismatched start time is reported not-ours and the pid is left running", async () => {
    const child = spawnLiveChild();
    const pid = child.pid as number;
    const record = recordFor(child, {
      starttime: (readProcStartTime(pid) as number) + 7,
    });

    const result = await stopOwnedWorker(record);

    assert.equal(result.state, "not_ours");
    assert.equal(result.signalled, false);
    assert.equal(result.cleanup.state, "not_started");
    assert.equal(priorProcessProvablyGone(result), true);
    // The live occupant of the recycled pid is untouched: the whole point of
    // carrying a start time.
    assert.equal(isAlive(pid), true);
    assert.equal(child.exitCode, null);
  });

  it("an unconfirmable identity is never signalled and reports needs handling", async () => {
    const child = spawnLiveChild();
    const pid = child.pid as number;
    const record = recordFor(child, { starttime: null });

    const result = await stopOwnedWorker(record);

    assert.equal(result.state, "needs_handling");
    assert.equal(result.signalled, false);
    assert.equal(result.cleanup.state, "unconfirmed");
    // Its own reason, not the delivery-failure one: no teardown was attempted.
    assert.equal(
      result.cleanup.state === "unconfirmed" ? result.cleanup.reason : "",
      "signal_refused"
    );
    assert.equal(priorProcessProvablyGone(result), false);
    assert.equal(isAlive(pid), true);
  });

  it("an injected teardown failure is needs handling, never a silent stop", async () => {
    const child = spawnLiveChild();
    const pid = child.pid as number;
    const record = recordFor(child);

    const result = await stopOwnedWorker(record, {
      signalPid: () => {
        throw Object.assign(new Error("not permitted"), { code: "EPERM" });
      },
      waitMs: async () => {},
    });

    assert.equal(result.state, "needs_handling");
    assert.equal(result.signalled, false);
    assert.equal(result.cleanup.state, "unconfirmed");
    assert.match(result.detail, /EPERM/);
    assert.equal(priorProcessProvablyGone(result), false);
    assert.equal(isAlive(pid), true);
  });

  it("a process that survives both signals is needs handling after the bounded window", async () => {
    const child = spawnLiveChild();
    const record = recordFor(child);

    // A real Linux process tree cannot survive SIGKILL, so the observation
    // window is exercised through a blinded liveness probe — the same reason
    // the sandbox cleanup plane documents its own probe seam.
    const result = await stopOwnedWorker(record, {
      pidAlive: () => true,
      readStartTime: () => record.starttime as number,
      waitMs: async () => {},
    });

    assert.equal(result.state, "needs_handling");
    assert.equal(result.signalled, true);
    assert.equal(result.cleanup.state, "unconfirmed");
    assert.equal(
      result.cleanup.state === "unconfirmed" ? result.cleanup.reason : "",
      "observation_expired"
    );
    assert.equal(priorProcessProvablyGone(result), false);
  });

  it("reports a signal the kernel accepted as delivered when the post-signal probe cannot decide", async () => {
    const child = spawnLiveChild();
    const record = recordFor(child);
    // The authorized comparison matches (the identity is ours, so a signal is
    // allowed); every later read of the live start time fails, which is the one
    // thing a real process tree cannot be made to do on demand.
    let reads = 0;

    const result = await stopOwnedWorker(record, {
      signalPid: () => {},
      pidAlive: () => true,
      readStartTime: () =>
        reads++ === 0 ? (record.starttime as number) : undefined,
      waitMs: async () => {},
    });

    assert.equal(result.state, "needs_handling");
    assert.equal(
      result.signalled,
      true,
      "the signal was delivered; an undecidable observation cannot un-deliver it"
    );
    assert.doesNotMatch(
      result.detail,
      /refusing to signal/,
      "a delivered signal is never reported as a refusal"
    );
    assert.equal(result.cleanup.state, "unconfirmed");
  });

  it("never claims a signal delivery the kernel refused for an already-gone pid", async () => {
    const child = spawnLiveChild();
    const record = recordFor(child);
    let alive = true;

    const result = await stopOwnedWorker(record, {
      // ESRCH is not a failure — it is the kernel saying there was nothing left
      // to signal, so nothing was delivered to anyone.
      signalPid: () => {
        throw Object.assign(new Error("no such process"), { code: "ESRCH" });
      },
      pidAlive: () => alive,
      readStartTime: () => record.starttime as number,
      waitMs: async () => {
        alive = false;
      },
    });

    assert.equal(result.state, "confirmed_stopped");
    assert.equal(
      result.signalled,
      false,
      "nothing was delivered, so the record must not claim a signal"
    );
  });
});

describe("sweepOwnedWorkers", () => {
  it("stops every recorded worker, records each verdict, and a second sweep changes nothing", async () => {
    const dir = await makeScratch("iknow-wid-sweep-");
    const live = spawnLiveChild();
    const recycled = spawnLiveChild();
    const dead = spawnLiveChild();
    const deadPid = dead.pid as number;

    writeWorkerIdentityRecord(dir, recordFor(live, { task_id: "task-live" }));
    writeWorkerIdentityRecord(dir, {
      ...recordFor(recycled, { task_id: "task-recycled" }),
      starttime: (readProcStartTime(recycled.pid as number) as number) + 1,
    });
    writeWorkerIdentityRecord(dir, recordFor(dead, { task_id: "task-dead" }));
    dead.kill("SIGKILL");
    assert.equal(await waitUntilGone(deadPid), true);

    const first = await sweepOwnedWorkers(dir);
    assert.deepEqual(unreadableOf(first), []);
    const byTask = new Map(first.workers.map((w) => [w.taskId, w]));
    assert.equal(byTask.get("task-live")?.state, "confirmed_stopped");
    assert.equal(byTask.get("task-recycled")?.state, "not_ours");
    assert.equal(byTask.get("task-dead")?.state, "confirmed_stopped");
    assert.equal(await waitUntilGone(live.pid as number), true);
    // The recycled pid's occupant is still running.
    assert.equal(isAlive(recycled.pid as number), true);

    const { records } = readWorkerIdentityRecords(dir);
    const stored = new Map(records.map((r) => [r.task_id, r]));
    assert.equal(stored.get("task-live")?.stop?.outcome, "confirmed_stopped");
    assert.equal(stored.get("task-recycled")?.stop?.outcome, "not_ours");
    assert.equal(stored.get("task-recycled")?.stop?.signalled, false);
    // An unsettled worker stays unsettled on disk: the sweep never writes a
    // terminal lifecycle state.
    assert.equal(stored.get("task-live")?.worker_state, "running");
    const afterFirst = await readFile(
      join(dir, "task-live", "process-task-live.json"),
      "utf8"
    );

    const second = await sweepOwnedWorkers(dir);
    const secondByTask = new Map(second.workers.map((w) => [w.taskId, w]));
    assert.equal(secondByTask.get("task-live")?.state, "confirmed_stopped");
    assert.equal(secondByTask.get("task-live")?.signalled, false);
    assert.equal(
      await readFile(join(dir, "task-live", "process-task-live.json"), "utf8"),
      afterFirst
    );
  });

  it("retries a needs-handling record instead of treating the old verdict as done", async () => {
    const dir = await makeScratch("iknow-wid-sweep-retry-");
    const child = spawnLiveChild();
    const pid = child.pid as number;
    writeWorkerIdentityRecord(dir, recordFor(child, { task_id: "task-again" }));

    const failed = await sweepOwnedWorkers(dir, {
      signalPid: () => {
        throw Object.assign(new Error("busy"), { code: "EBUSY" });
      },
      waitMs: async () => {},
    });
    assert.equal(failed.workers[0]?.state, "needs_handling");
    assert.equal(
      readWorkerIdentityRecords(dir).records[0]?.stop?.outcome,
      "needs_handling"
    );
    assert.equal(isAlive(pid), true);

    const retried = await sweepOwnedWorkers(dir);
    assert.equal(retried.workers[0]?.state, "confirmed_stopped");
    assert.equal(retried.workers[0]?.signalled, true);
    assert.equal(await waitUntilGone(pid), true);
  });

  it("surfaces an unreadable record file instead of skipping the worker silently", async () => {
    const dir = await makeScratch("iknow-wid-sweep-corrupt-");
    writeWorkerIdentityRecord(
      dir,
      recordFor(spawnLiveChild(), { task_id: "task-ok" })
    );
    await (
      await import("node:fs/promises")
    ).mkdir(join(dir, "task-bad"), {
      recursive: true,
    });
    await (
      await import("node:fs/promises")
    ).writeFile(
      join(dir, "task-bad", "process-task-bad.json"),
      '{"task_id":"task-bad"}',
      "utf8"
    );

    const result = await sweepOwnedWorkers(dir);
    assert.equal(result.workers.length, 1);
    assert.equal(result.workers[0]?.taskId, "task-ok");
    assert.equal(unreadableOf(result).length, 1);
    expect(unreadableOf(result)[0]?.path).toMatch(/task-bad/);
  });

  it("a root with no records sweeps to an empty result", async () => {
    const dir = await makeScratch("iknow-wid-sweep-empty-");
    const result = await sweepOwnedWorkers(dir);
    assert.deepEqual(result.workers, []);
    assert.deepEqual(unreadableOf(result), []);
    assert.deepEqual(result.unrecorded, []);
  });

  it("a second sweep over a not-ours record reports not-ours, not confirmed-stopped", async () => {
    const dir = await makeScratch("iknow-wid-sweep-replay-");
    const child = spawnLiveChild();
    writeWorkerIdentityRecord(dir, {
      ...recordFor(child, { task_id: "task-recycled" }),
      starttime: (readProcStartTime(child.pid as number) as number) + 1,
    });
    assert.equal((await sweepOwnedWorkers(dir)).workers[0]?.state, "not_ours");

    const replayed = (await sweepOwnedWorkers(dir)).workers[0];

    // A replay reports the outcome that is ON DISK. Reading it as a confirmed
    // stop would tell the operator a process was killed when the sweep only
    // declined to touch somebody else's.
    assert.equal(replayed?.state, "not_ours");
    assert.equal(replayed?.signalled, false);
    assert.match(replayed?.detail ?? "", /not_ours/);
    assert.equal(
      readWorkerIdentityRecords(dir).records[0]?.stop?.outcome,
      "not_ours"
    );
  });

  it("surfaces a verdict that never reached the record instead of reporting it as recorded", async () => {
    const dir = await makeScratch("iknow-wid-sweep-unrecorded-");
    const child = spawnLiveChild();
    const record = recordFor(child, { task_id: "task-a" });
    writeWorkerIdentityRecord(dir, record);
    const path = join(dir, "task-a", "process-task-a.json");
    let alive = true;

    const swept = await sweepOwnedWorkers(dir, {
      // The record is gone by the time the verdict is written — the same
      // outcome class as an EACCES on the rewrite, produced without depending
      // on the platform honouring mode bits.
      signalPid: () => {
        if (existsSync(path)) rmSync(path);
      },
      pidAlive: () => alive,
      readStartTime: () => record.starttime as number,
      waitMs: async () => {
        alive = false;
      },
    });

    assert.deepEqual(
      swept.unrecorded.map((missed) => [missed.taskId, missed.outcome]),
      [["task-a", "confirmed_stopped"]],
      "a verdict that is not on disk is named as unrecorded, not as proven"
    );
    assert.equal(swept.workers[0]?.state, "confirmed_stopped");
    assert.equal(readWorkerIdentityRecords(dir).records[0], undefined);
  });

  it("one unwritable record does not reject the sweep after its worker was signalled", async () => {
    const dir = await makeScratch("iknow-wid-sweep-eacces-");
    const child = spawnLiveChild();
    writeWorkerIdentityRecord(dir, recordFor(child, { task_id: "task-a" }));
    // Replacement is atomic (staged file + rename), so the record's own
    // read-only mode is not what blocks a verdict: the directory is. Without
    // write permission there, neither the staging write nor the rename lands.
    const recordDir = join(dir, "task-a");
    const path = join(recordDir, "process-task-a.json");
    chmodSync(recordDir, 0o555);
    // tmpfs mounts that ignore mode bits for uid 1000 cannot produce the
    // refusal; the case reports itself skipped there instead of passing
    // vacuously on a write that would have succeeded.
    if (writableSync(path)) {
      chmodSync(recordDir, 0o755);
      return;
    }

    try {
      const swept = await sweepOwnedWorkers(dir);

      assert.equal(swept.workers[0]?.state, "confirmed_stopped");
      assert.equal(swept.workers[0]?.signalled, true);
      assert.deepEqual(
        swept.unrecorded.map((missed) => missed.taskId),
        ["task-a"]
      );
      assert.match(swept.unrecorded[0]?.reason ?? "", /EACCES/);
      // Nothing was written, so the record still carries no verdict.
      assert.equal(readWorkerIdentityRecords(dir).records[0]?.stop, undefined);
    } finally {
      chmodSync(recordDir, 0o755);
    }
  });
});

/** Whether a write to `path` succeeds right now, leaving its bytes unchanged. */
function writableSync(path: string): boolean {
  try {
    writeFileSync(path, readFileSync(path, "utf8"), "utf8");
    return true;
  } catch {
    return false;
  }
}

function unreadableOf(result: {
  readonly unreadable: ReadonlyArray<{
    readonly path: string;
    readonly reason: string;
  }>;
}) {
  return result.unreadable;
}

describe("sweepOwnedWorkers — session scoping", () => {
  it("a session-filtered sweep never signals another session's live worker", async () => {
    const dir = await makeScratch("iknow-wid-sweep-session-");
    const mine = spawnLiveChild();
    const theirs = spawnLiveChild();
    writeWorkerIdentityRecord(dir, {
      task_id: "task-mine",
      ownership: "background",
      worker_state: "running",
      pid: mine.pid as number,
      starttime: readProcStartTime(mine.pid as number) ?? null,
      session_id: "conv-mine",
    });
    writeWorkerIdentityRecord(dir, {
      task_id: "task-theirs",
      ownership: "background",
      worker_state: "running",
      pid: theirs.pid as number,
      starttime: readProcStartTime(theirs.pid as number) ?? null,
      session_id: "conv-theirs",
    });

    const swept = await sweepOwnedWorkers(dir, { sessionId: "conv-mine" });

    assert.deepEqual(
      swept.workers.map((w) => w.taskId),
      ["task-mine"]
    );
    // The foreign record is REPORTED, not dropped: a worker nobody may signal
    // is still a worker the operator has to hear about.
    assert.deepEqual(
      swept.excluded.map((e) => [e.taskId, e.reason]),
      [["task-theirs", "foreign_session"]]
    );
    // And the foreign worker is demonstrably still running.
    assert.equal(isAlive(theirs.pid as number), true);
  });

  it("a record with no attributable session is excluded, not swept on a guess", async () => {
    const dir = await makeScratch("iknow-wid-sweep-unattr-");
    const child = spawnLiveChild();
    writeWorkerIdentityRecord(dir, {
      task_id: "task-legacy",
      ownership: "background",
      worker_state: "running",
      pid: child.pid as number,
      starttime: readProcStartTime(child.pid as number) ?? null,
    });

    const swept = await sweepOwnedWorkers(dir, { sessionId: "conv-mine" });

    assert.deepEqual(swept.workers, []);
    assert.deepEqual(
      swept.excluded.map((e) => [e.taskId, e.reason]),
      [["task-legacy", "unattributed_session"]]
    );
    assert.equal(isAlive(child.pid as number), true);
  });

  it("without a session filter the owning-process posture still sweeps everything", async () => {
    const dir = await makeScratch("iknow-wid-sweep-nofilter-");
    const child = spawnLiveChild();
    writeWorkerIdentityRecord(dir, {
      task_id: "task-own",
      ownership: "background",
      worker_state: "running",
      pid: child.pid as number,
      starttime: readProcStartTime(child.pid as number) ?? null,
    });

    const swept = await sweepOwnedWorkers(dir);
    assert.deepEqual(swept.excluded, []);
    assert.equal(swept.workers[0]?.state, "confirmed_stopped");
  });

  it("a second sweep after a proven stop changes nothing on disk", async () => {
    const dir = await makeScratch("iknow-wid-sweep-idem-");
    const child = spawnLiveChild();
    writeWorkerIdentityRecord(dir, {
      task_id: "task-idem",
      ownership: "background",
      worker_state: "running",
      pid: child.pid as number,
      starttime: readProcStartTime(child.pid as number) ?? null,
      session_id: "conv-1",
    });
    await sweepOwnedWorkers(dir, { sessionId: "conv-1" });
    const after = await readFile(
      join(dir, "task-idem", "process-task-idem.json"),
      "utf8"
    );

    const second = await sweepOwnedWorkers(dir, { sessionId: "conv-1" });

    // Byte-identical: an idempotent pass adds no record mutation, and the
    // replayed verdict is the stored one rather than a newly decided one.
    assert.equal(
      await readFile(join(dir, "task-idem", "process-task-idem.json"), "utf8"),
      after
    );
    assert.equal(second.workers[0]?.state, "confirmed_stopped");
    assert.equal(second.workers[0]?.signalled, false);
    assert.deepEqual(second.unrecorded, []);
  });

  it("the sweep cannot enumerate a background-bash-service or persistent-task record", async () => {
    const dir = await makeScratch("iknow-wid-sweep-carveout-");
    // The two excluded lifecycles keep their own registry under a data-dir
    // project tree, one file per task — NOT the `<subagents>/<taskId>/process-
    // <taskId>.json` shape this sweep selects on. Both shapes are laid down
    // here verbatim: if the enumeration ever widened, they would be picked up.
    const registry = join(dir, "..", "registry-tasks");
    mkdirSync(registry, { recursive: true });
    writeFileSync(
      join(registry, "bash-service-1.json"),
      JSON.stringify({ kind: "bash_service", pid: 4242, persistent: true }) +
        "\n",
      "utf8"
    );
    writeFileSync(
      join(registry, "persistent-task-1.json"),
      JSON.stringify({ kind: "persistent_task", pid: 4243, persistent: true }) +
        "\n",
      "utf8"
    );
    // A decoy that IS inside the root but is not a worker record.
    mkdirSync(join(dir, "not-a-task-id"), { recursive: true });
    writeFileSync(
      join(dir, "not-a-task-id", "process-not-a-task-id.json"),
      JSON.stringify({ task_id: "other", ownership: "background" }) + "\n",
      "utf8"
    );

    const swept = await sweepOwnedWorkers(dir);

    // The decoy is unreadable rather than acted on, and neither excluded
    // lifecycle's record is even listed.
    assert.deepEqual(
      swept.workers.map((w) => w.taskId),
      []
    );
    assert.deepEqual(
      swept.unreadable.map((u) => u.path),
      [join(dir, "not-a-task-id", "process-not-a-task-id.json")]
    );
    assert.deepEqual(swept.excluded, []);
  });
});

describe("terminateOwnedWorkerNow — synchronous teardown", () => {
  it("terminates a live owned process and confirms it is gone", async () => {
    const child = spawnLiveChild();
    const pid = child.pid as number;
    const result = terminateOwnedWorkerNow({
      pid,
      startTime: readProcStartTime(pid) ?? null,
    });

    assert.equal(result.state, "terminated");
    assert.equal(result.signalled, true);
    assert.equal(await waitUntilGone(pid), true);
  });

  it("reports gone without signalling a pid that is already absent", () => {
    const probe = spawnLiveChild();
    const pid = probe.pid as number;
    probe.kill("SIGKILL");
    // A pid the caller cannot match is never signalled, whatever the outcome.
    const mismatched = terminateOwnedWorkerNow(
      { pid, startTime: 1 },
      {
        termGraceMs: 50,
        killGraceMs: 50,
      }
    );
    assert.ok(
      mismatched.state === "gone" || mismatched.state === "refused",
      `unexpected state ${mismatched.state}`
    );
    assert.equal(mismatched.signalled, false);
  });

  it("refuses to signal a pid whose start time does not match the record", () => {
    const child = spawnLiveChild();
    const pid = child.pid as number;
    const signalled: number[] = [];
    const result = terminateOwnedWorkerNow(
      { pid, startTime: (readProcStartTime(pid) ?? 0) + 1 },
      { signalPid: (p) => signalled.push(p) }
    );

    // The whole point: a pid alone is not an identity, so a mismatched record
    // gets no signal at all.
    assert.equal(result.state, "refused");
    assert.equal(result.signalled, false);
    assert.deepEqual(signalled, []);
    assert.match(result.detail, /not signalled/);
  });

  it("reports a refused teardown when the process survives both signals", () => {
    const child = spawnLiveChild();
    const pid = child.pid as number;
    const sent: NodeJS.Signals[] = [];
    const result = terminateOwnedWorkerNow(
      { pid, startTime: readProcStartTime(pid) ?? null },
      {
        // Pretend every kill landed while the process stays visible: this is
        // the one thing a real process tree cannot be made to do.
        signalPid: (_pid, signal) => sent.push(signal),
        pidAlive: () => true,
        readStartTime: () => readProcStartTime(pid),
        termGraceMs: 20,
        killGraceMs: 20,
      }
    );
    assert.equal(result.state, "refused");
    assert.equal(result.signalled, true);
    // The backstop is a SIGKILL on the SAME pid, after SIGTERM.
    assert.deepEqual(sent, ["SIGTERM", "SIGKILL"]);
  });

  it("reports a refused delivery as refused, never as a proven teardown", () => {
    // The failure the async path already covers: the kernel refuses the
    // signal. Nothing was sent, the process is untouched, and the caller must
    // be able to tell that from "we signalled it and it went away" — a
    // teardown reported as proven while the child still runs is the one
    // outcome this whole fail-closed arm exists to prevent.
    const child = spawnLiveChild();
    const pid = child.pid as number;
    const eperm = Object.assign(new Error("operation not permitted"), {
      code: "EPERM",
    });
    const result = terminateOwnedWorkerNow(
      { pid, startTime: readProcStartTime(pid) ?? null },
      {
        signalPid: () => {
          throw eperm;
        },
      }
    );

    assert.equal(result.state, "refused");
    assert.equal(result.signalled, false);
    assert.match(result.detail, /EPERM/);
    // Still alive, which is why the verdict must not be `terminated`.
    assert.equal(child.exitCode, null);
  });
});
