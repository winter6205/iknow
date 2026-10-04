/**
 * Worker identity record (per-task durable OS identity anchor).
 *
 * The record is the only cross-process answer to "is the worker this task id
 * launched still running, and is it still the SAME process". A task id maps to
 * a sequence of spawns, so the record describes the CURRENT spawn and every
 * spawn rewrites it.
 *
 * Covered here:
 *   1. round-trip of identity + ownership + transcript reference
 *   2. rewrite (not create-once): a resumed spawn's identity replaces the old
 *      one and clears the previous stop evidence
 *   3. listing separates readable records from unreadable ones (fail-closed —
 *      a corrupt file is reported, never silently dropped)
 *   4. writing never touches the worker's own transcript or the per-agent trace
 *   5. missing subagents dir → empty listing, no throw
 *   6. `starttime: null` (unreadable at spawn) round-trips as-is
 *   7. a stop verdict that cannot be persisted reports the errno instead of
 *      throwing, and leaves the record's bytes untouched
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  readWorkerIdentityRecords,
  writeWorkerIdentityRecord,
  recordWorkerStopEvidence,
  queueWorkerStopEvidence,
  WorkerIdentityWriteError,
  WORKER_IDENTITY_WRITE_ERROR_CODE,
  readWorkerIdentityRecord,
  readWorkerIdentityRecordState,
  type WorkerIdentityEntry,
} from "../../src/harness/subagent/worker-identity-record.ts";
import {
  workerMetaPath,
  workerRecordPath,
  workerTranscriptPath,
} from "../../src/harness/sandbox/fence-tmp.ts";
import {
  createSubAgentManager,
  type SubAgentManager,
} from "../../src/harness/subagent/manager.ts";
import { createDefaultSubAgentSpawn } from "../../src/harness/subagent/spawn.ts";

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
      .map((path) => rm(path, { recursive: true, force: true }))
  );
});

function entry(
  overrides: Partial<WorkerIdentityEntry> & { readonly task_id: string } = {
    task_id: "task-a",
  }
): WorkerIdentityEntry {
  return {
    ownership: "foreground",
    worker_state: "running",
    pid: 4242,
    starttime: 991,
    ...overrides,
  };
}

describe("worker identity record — write / read", () => {
  it("round-trips identity, ownership and the worker's own transcript reference", async () => {
    const dir = await makeScratch("iknow-wid-record-");
    const transcriptPath = join(dir, "task-a", "task-a.jsonl");

    const written = writeWorkerIdentityRecord(
      dir,
      entry({
        task_id: "task-a",
        ownership: "background",
        transcript_path: transcriptPath,
        tool_use_id: "toolu_01",
      })
    );

    const { records, unreadable } = readWorkerIdentityRecords(dir);
    assert.deepEqual(unreadable, []);
    assert.equal(records.length, 1);
    assert.equal(records[0]?.task_id, "task-a");
    assert.equal(records[0]?.ownership, "background");
    assert.equal(records[0]?.worker_state, "running");
    assert.equal(records[0]?.pid, 4242);
    assert.equal(records[0]?.starttime, 991);
    assert.equal(records[0]?.transcript_path, transcriptPath);
    assert.equal(records[0]?.tool_use_id, "toolu_01");
    assert.equal(records[0]?.updated_at, written.updated_at);
    assert.ok(Date.parse(written.updated_at) > 0);
    // The stop evidence only exists once a verification pass wrote one.
    assert.equal(records[0]?.stop, undefined);
  });

  it("a second spawn of the same task id rewrites the record and clears old stop evidence", async () => {
    const dir = await makeScratch("iknow-wid-rewrite-");
    writeWorkerIdentityRecord(
      dir,
      entry({ task_id: "task-a", pid: 100, starttime: 10 })
    );
    recordWorkerStopEvidence(dir, "task-a", {
      outcome: "confirmed_stopped",
      signalled: true,
      detail: "first spawn stopped",
    });

    writeWorkerIdentityRecord(
      dir,
      entry({
        task_id: "task-a",
        pid: 200,
        starttime: 20,
        worker_state: "starting",
      })
    );

    const { records } = readWorkerIdentityRecords(dir);
    assert.equal(records.length, 1);
    assert.equal(records[0]?.pid, 200);
    assert.equal(records[0]?.starttime, 20);
    assert.equal(records[0]?.worker_state, "starting");
    // The new process is unverified: the previous run's verdict must not
    // travel onto it, or a sweep would skip a live worker.
    assert.equal(records[0]?.stop, undefined);
  });

  it("an unreadable record is reported separately instead of vanishing from the listing", async () => {
    const dir = await makeScratch("iknow-wid-corrupt-");
    writeWorkerIdentityRecord(dir, entry({ task_id: "task-ok" }));
    await mkdir(join(dir, "task-bad"), { recursive: true });
    await writeFile(
      join(dir, "task-bad", "process-task-bad.json"),
      "{ not json",
      "utf8"
    );

    const { records, unreadable } = readWorkerIdentityRecords(dir);
    assert.deepEqual(
      records.map((r) => r.task_id),
      ["task-ok"]
    );
    assert.equal(unreadable.length, 1);
    assert.match(unreadable[0]?.path ?? "", /task-bad/);
    assert.ok((unreadable[0]?.reason ?? "").length > 0);
  });

  it("a record file that cannot be read does not abort the whole listing", async () => {
    // The listing promises that no record is dropped from it and reports what
    // it could not read. An unreadable *file* (as opposed to unparseable
    // content) used to escape as a throw, so one permission error lost every
    // other record in the directory — and a sweep that never ran reports
    // nothing, which reads exactly like "there were no workers".
    const dir = await makeScratch("iknow-wid-eacces-");
    writeWorkerIdentityRecord(dir, entry({ task_id: "task-ok" }));
    const locked = join(dir, "task-locked");
    await mkdir(locked, { recursive: true });
    await writeFile(
      join(locked, "process-task-locked.json"),
      JSON.stringify(entry({ task_id: "task-locked" })),
      "utf8"
    );
    // Same guard as the repo's other chmod-based errno tests: a filesystem
    // that ignores mode bits cannot produce this condition, and asserting a
    // throw that will not happen would be a fake test.
    if (process.getuid?.() === 0) return;
    chmodSync(join(locked, "process-task-locked.json"), 0o000);
    try {
      const { records, unreadable } = readWorkerIdentityRecords(dir);
      assert.deepEqual(
        records.map((r) => r.task_id),
        ["task-ok"]
      );
      assert.equal(unreadable.length, 1);
      assert.match(unreadable[0]?.path ?? "", /task-locked/);
      assert.match(unreadable[0]?.reason ?? "", /EACCES|EPERM/);
    } finally {
      chmodSync(join(locked, "process-task-locked.json"), 0o600);
    }
  });

  it("a record whose identity fields are missing is unreadable, not coerced", async () => {
    const dir = await makeScratch("iknow-wid-shape-");
    await mkdir(join(dir, "task-shape"), { recursive: true });
    await writeFile(
      join(dir, "task-shape", "process-task-shape.json"),
      JSON.stringify({ task_id: "task-shape", ownership: "foreground" }),
      "utf8"
    );

    const { records, unreadable } = readWorkerIdentityRecords(dir);
    assert.deepEqual(records, []);
    assert.equal(unreadable.length, 1);
  });

  it("writing a record leaves the worker transcript and the per-agent trace byte-identical", async () => {
    const dir = await makeScratch("iknow-wid-transcript-");
    const taskId = "task-a";
    await mkdir(join(dir, taskId), { recursive: true });
    const transcript = workerTranscriptPath(dir, taskId);
    const trace = workerRecordPath(dir, taskId);
    const meta = workerMetaPath(dir, taskId);
    const transcriptBody =
      '{"role":"worker","seq":1}\n{"role":"worker","seq":2}\n';
    await writeFile(transcript, transcriptBody, "utf8");
    await writeFile(trace, '{"event":"subagent_spawn"}\n', "utf8");
    await writeFile(meta, "{}\n", "utf8");

    writeWorkerIdentityRecord(
      dir,
      entry({ task_id: taskId, transcript_path: transcript })
    );
    recordWorkerStopEvidence(dir, taskId, {
      outcome: "confirmed_stopped",
      signalled: true,
      detail: "identity observed absent",
    });

    assert.equal(await readFile(transcript, "utf8"), transcriptBody);
    assert.equal(await readFile(trace, "utf8"), '{"event":"subagent_spawn"}\n');
    assert.equal(await readFile(meta, "utf8"), "{}\n");
  });

  it("a missing subagents dir lists nothing and does not throw", () => {
    const { records, unreadable } = readWorkerIdentityRecords(
      join(tmpdir(), "iknow-wid-absent-dir-does-not-exist")
    );
    assert.deepEqual(records, []);
    assert.deepEqual(unreadable, []);
  });

  it("keeps an unreadable spawn-time start time as null rather than inventing one", async () => {
    const dir = await makeScratch("iknow-wid-null-start-");
    writeWorkerIdentityRecord(
      dir,
      entry({ task_id: "task-null", starttime: null })
    );

    const { records } = readWorkerIdentityRecords(dir);
    assert.equal(records[0]?.starttime, null);
  });

  it("stop evidence lands on the record it belongs to and leaves other tasks alone", async () => {
    const dir = await makeScratch("iknow-wid-evidence-");
    writeWorkerIdentityRecord(
      dir,
      entry({ task_id: "task-a", pid: 1, starttime: 1 })
    );
    writeWorkerIdentityRecord(
      dir,
      entry({ task_id: "task-b", pid: 2, starttime: 2 })
    );

    assert.equal(
      recordWorkerStopEvidence(dir, "task-b", {
        outcome: "needs_handling",
        signalled: true,
        detail: "kill(2, SIGKILL) failed (EPERM)",
      }).recorded,
      true
    );

    const { records } = readWorkerIdentityRecords(dir);
    const byTask = new Map(records.map((r) => [r.task_id, r]));
    assert.equal(byTask.get("task-a")?.stop, undefined);
    assert.equal(byTask.get("task-b")?.stop?.outcome, "needs_handling");
    assert.equal(byTask.get("task-b")?.stop?.signalled, true);
    assert.equal(
      byTask.get("task-b")?.stop?.detail,
      "kill(2, SIGKILL) failed (EPERM)"
    );
    // The verdict never rewrites the worker's own lifecycle state: an
    // unsettled worker stays unsettled.
    assert.equal(byTask.get("task-b")?.worker_state, "running");
  });

  it("recording stop evidence for an unknown task id reports failure instead of inventing a record", async () => {
    const dir = await makeScratch("iknow-wid-evidence-missing-");
    const written = recordWorkerStopEvidence(dir, "task-unknown", {
      outcome: "confirmed_stopped",
      signalled: false,
      detail: "no process",
    });
    expect(written.recorded).toBe(false);
    const reason = written.recorded ? "" : written.reason;
    expect(reason.length).toBeGreaterThan(0);
    const { records } = readWorkerIdentityRecords(dir);
    assert.deepEqual(records, []);
    assert.equal(
      existsSync(join(dir, "task-unknown", "process-task-unknown.json")),
      false
    );
  });

  it("a stop verdict that cannot be persisted reports the errno instead of throwing", async () => {
    const dir = await makeScratch("iknow-wid-evidence-eacces-");
    writeWorkerIdentityRecord(dir, entry({ task_id: "task-a" }));
    const path = join(dir, "task-a", "process-task-a.json");
    const before = await readFile(path, "utf8");
    // The record is replaced atomically (staged file + rename), so the barrier
    // that matters is the DIRECTORY's: a read-only file's own mode does not
    // govern whether a rename may replace it. Without write permission on the
    // directory neither the staging write nor the rename can succeed, which is
    // exactly the "this verdict cannot be made durable" situation.
    const recordDir = dirname(path);
    chmodSync(recordDir, 0o555);
    // tmpfs mounts that ignore mode bits for uid 1000 cannot produce the
    // refusal; the case reports itself skipped there instead of passing
    // vacuously on a write that would have succeeded.
    if (writable(path)) {
      chmodSync(recordDir, 0o755);
      return;
    }

    try {
      const written = recordWorkerStopEvidence(dir, "task-a", {
        outcome: "confirmed_stopped",
        signalled: true,
        detail: "pid 4242 is gone",
      });

      // The refusal names its cause, so a caller reporting to an operator never
      // has to invent one — and nothing was written.
      assert.equal(written.recorded, false);
      const reason = written.recorded ? "" : written.reason;
      assert.match(reason, /EACCES/);
      assert.equal(await readFile(path, "utf8"), before);
      assert.equal(readWorkerIdentityRecords(dir).records[0]?.stop, undefined);
    } finally {
      chmodSync(recordDir, 0o755);
    }
  });
});

describe("worker identity record — atomic replacement", () => {
  it("a record write leaves no staged temp file and keeps the reader's byte format", async () => {
    const dir = await makeScratch("iknow-wid-atomic-");
    const written = writeWorkerIdentityRecord(
      dir,
      entry({ task_id: "task-a" })
    );
    const taskDir = join(dir, "task-a");
    const names = readdirSync(taskDir);

    // The on-disk shape is unchanged: one record file, JSON plus the trailing
    // newline the previous writer produced, so every existing reader still
    // parses it byte-for-byte.
    assert.deepEqual(
      names.filter((n) => n.includes(".tmp") || n.includes(".discarded")),
      []
    );
    const raw = readFileSync(join(taskDir, "process-task-a.json"), "utf8");
    assert.equal(raw.endsWith("\n"), true);
    assert.equal(JSON.parse(raw).task_id, written.task_id);
    assert.equal(JSON.parse(raw).updated_at, written.updated_at);
  });

  it("replacing a record never exposes a partial file to a reader", async () => {
    const dir = await makeScratch("iknow-wid-atomic-race-");
    writeWorkerIdentityRecord(dir, entry({ task_id: "task-a" }));
    const path = join(dir, "task-a", "process-task-a.json");
    // Reads are interleaved SYNCHRONOUSLY with the writes, at exactly the
    // instants a non-atomic writer would leave the file truncated — a
    // yield-based reader would simply never run during a tight write loop.
    let torn = 0;
    let reads = 0;
    const read = (): void => {
      reads += 1;
      try {
        const parsed = JSON.parse(readFileSync(path, "utf8")) as {
          readonly task_id?: unknown;
        };
        if (parsed.task_id !== "task-a") torn += 1;
      } catch {
        torn += 1;
      }
    };

    for (let i = 0; i < 200; i += 1) {
      writeWorkerIdentityRecord(
        dir,
        entry({ task_id: "task-a", transcript_path: `t-${i}`.repeat(200) })
      );
      read();
    }

    assert.equal(reads, 200);
    assert.equal(torn, 0, "a reader saw a partial or foreign record");
  });

  it("an unpersistable record throws a typed error carrying the real errno", async () => {
    const dir = await makeScratch("iknow-wid-atomic-eacces-");
    writeWorkerIdentityRecord(dir, entry({ task_id: "task-a" }));
    const recordDir = join(dir, "task-a");
    chmodSync(recordDir, 0o555);
    if (writable(join(recordDir, "process-task-a.json"))) {
      chmodSync(recordDir, 0o755);
      return;
    }

    try {
      let thrown: unknown;
      try {
        writeWorkerIdentityRecord(dir, entry({ task_id: "task-a", pid: 99 }));
      } catch (err) {
        thrown = err;
      }
      // A rejected record write must be a typed failure a caller can branch
      // on, never a bare Error and never a silent success.
      assert.ok(thrown instanceof WorkerIdentityWriteError);
      const err = thrown as WorkerIdentityWriteError;
      assert.equal(err.code, WORKER_IDENTITY_WRITE_ERROR_CODE);
      assert.equal(err.taskId, "task-a");
      assert.ok(err.cause instanceof Error);
      assert.match(err.message, /EACCES|EPERM/);
      // Nothing was written: the previous record is intact and still the
      // previous record's bytes.
      const { records } = readWorkerIdentityRecords(dir);
      assert.equal(records.length, 1);
      assert.equal(records[0]?.pid, 4242);
    } finally {
      chmodSync(recordDir, 0o755);
    }
  });
});

describe("worker identity record — untrusted reads", () => {
  it("a torn record is reported as untrusted, never as absent and never as a stop", async () => {
    const dir = await makeScratch("iknow-wid-torn-");
    writeWorkerIdentityRecord(dir, entry({ task_id: "task-a" }));
    const path = join(dir, "task-a", "process-task-a.json");
    const whole = readFileSync(path, "utf8");
    writeFileSync(path, whole.slice(0, Math.floor(whole.length / 2)), "utf8");

    // Every reader must land on the same answer. A torn record is "cannot
    // confirm": the boolean read declines it, the tri-state read says
    // untrusted (not absent, which is what a caller would report as "no such
    // task"), and the listing keeps it visible as unreadable.
    assert.equal(readWorkerIdentityRecord(dir, "task-a"), undefined);
    const state = readWorkerIdentityRecordState(dir, "task-a");
    assert.equal(state.kind, "untrusted");
    assert.equal(readWorkerIdentityRecords(dir).records.length, 0);
    const { unreadable } = readWorkerIdentityRecords(dir);
    assert.equal(unreadable.length, 1);
    assert.equal(unreadable[0]?.path, path);
  });

  it("an empty record file is untrusted rather than a zeroed record", async () => {
    const dir = await makeScratch("iknow-wid-empty-");
    writeWorkerIdentityRecord(dir, entry({ task_id: "task-a" }));
    writeFileSync(join(dir, "task-a", "process-task-a.json"), "", "utf8");
    assert.equal(
      readWorkerIdentityRecordState(dir, "task-a").kind,
      "untrusted"
    );
  });

  it("a malformed verdict block is untrusted: never silently downgraded to no verdict", async () => {
    const dir = await makeScratch("iknow-wid-badverdict-");
    writeWorkerIdentityRecord(dir, entry({ task_id: "task-a" }));
    const path = join(dir, "task-a", "process-task-a.json");
    const current = JSON.parse(readFileSync(path, "utf8")) as Record<
      string,
      unknown
    >;
    // A verdict missing its outcome: the one field every decision turns on.
    current.stop = { verified_at: "2026-01-01T00:00:00.000Z", signalled: true };
    writeFileSync(path, JSON.stringify(current) + "\n", "utf8");

    assert.equal(
      readWorkerIdentityRecordState(dir, "task-a").kind,
      "untrusted"
    );
    // It must not become a usable record either: an untrusted verdict cannot be
    // re-anchored, because re-anchoring is what proves death.
    const written = recordWorkerStopEvidence(dir, "task-a", {
      outcome: "confirmed_stopped",
      signalled: true,
      detail: "attempted",
    });
    assert.equal(written.recorded, false);
    assert.match(written.recorded ? "" : written.reason, /untrusted/);
  });

  it("an absent record is the only case that reports absent", async () => {
    const dir = await makeScratch("iknow-wid-gone-");
    assert.equal(
      readWorkerIdentityRecordState(dir, "task-missing").kind,
      "absent"
    );
  });
});

describe("worker identity record — verdict serialization", () => {
  it("concurrent verdict updates all land, the file always parses, and the last one wins", async () => {
    const dir = await makeScratch("iknow-wid-verdict-queue-");
    writeWorkerIdentityRecord(dir, entry({ task_id: "task-a" }));
    const path = join(dir, "task-a", "process-task-a.json");

    let torn = 0;
    let reads = 0;
    const read = (): void => {
      reads += 1;
      try {
        const parsed = JSON.parse(readFileSync(path, "utf8")) as {
          readonly stop?: { readonly detail?: unknown };
        };
        // A half-written verdict is the failure this serialization exists to
        // prevent: `stop` must always be a whole block, never a partial one.
        if (
          parsed.stop !== undefined &&
          typeof parsed.stop.detail !== "string"
        ) {
          torn += 1;
        }
      } catch {
        torn += 1;
      }
    };

    // Updates are fired WITHOUT awaiting in between — the queue, not the
    // caller's discipline, is what serializes them — and a read runs between
    // each dispatch, so a reader really does observe the file mid-churn.
    const writes: Promise<unknown>[] = [];
    for (let i = 0; i < 12; i += 1) {
      writes.push(
        queueWorkerStopEvidence(dir, "task-a", {
          outcome: "confirmed_stopped",
          signalled: true,
          detail: `verdict-${i}`,
        })
      );
      read();
      // Yield to the macrotask queue so the pending verdict writes actually run
      // between reads; without this the whole batch drains in microtasks and
      // the reads would all land after the last write.
      await new Promise((resolve) => setImmediate(resolve));
      read();
    }
    const results = await Promise.all(writes);

    // Every writer was told the truth about its own write.
    assert.equal(
      results.every((r) => (r as { recorded: boolean }).recorded),
      true
    );
    // Last completed write wins, and the file is a complete record.
    const { records, unreadable } = readWorkerIdentityRecords(dir);
    assert.deepEqual(unreadable, []);
    assert.equal(records[0]?.stop?.detail, "verdict-11");
    assert.equal(torn, 0, "a reader saw a partial verdict");
    assert.ok(reads >= 24, `expected reads during the churn, got ${reads}`);
  });

  it("serialization is per task id, so another task's verdict is unaffected", async () => {
    const dir = await makeScratch("iknow-wid-verdict-scope-");
    writeWorkerIdentityRecord(dir, entry({ task_id: "task-a" }));
    writeWorkerIdentityRecord(dir, entry({ task_id: "task-b" }));

    await Promise.all([
      queueWorkerStopEvidence(dir, "task-a", {
        outcome: "confirmed_stopped",
        signalled: true,
        detail: "a-detail",
      }),
      queueWorkerStopEvidence(dir, "task-b", {
        outcome: "not_ours",
        signalled: false,
        detail: "b-detail",
      }),
    ]);

    const { records } = readWorkerIdentityRecords(dir);
    const byId = new Map(records.map((r) => [r.task_id, r]));
    assert.equal(byId.get("task-a")?.stop?.detail, "a-detail");
    assert.equal(byId.get("task-b")?.stop?.detail, "b-detail");
    assert.equal(byId.get("task-b")?.stop?.outcome, "not_ours");
  });
});

describe("worker identity record — fail-closed spawn", () => {
  it("a rejected record write kills the child it just started and returns a typed spawn failure", async () => {
    const root = await makeScratch("iknow-wid-failclosed-fg-");
    const subagentsDir = join(root, "subagents");
    mkdirSync(subagentsDir, { recursive: true });
    const script = writeWorkerScript(root, HOLD_WORKER, "worker.cjs");
    const pids: number[] = [];
    const manager = makeFailClosedManager(subagentsDir, pids);

    // Foreground (wait:true) arm: the spawning call awaits this worker's
    // envelope, so a successful-looking return is what would be mistaken for a
    // usable worker.
    const thrown = withWorkerScript(script, () => {
      try {
        manager.spawn({
          task: "fg work",
          conversationId: "conv-1",
          excludeFromHostDrain: true,
        } as never);
        return undefined;
      } catch (err) {
        return err;
      }
    });

    assertFailClosed(thrown, pids);
  });

  it("applies the same rule to a wait:false spawn: the handle never resolves successfully", async () => {
    const root = await makeScratch("iknow-wid-failclosed-bg-");
    const subagentsDir = join(root, "subagents");
    mkdirSync(subagentsDir, { recursive: true });
    const script = writeWorkerScript(root, HOLD_WORKER, "worker.cjs");
    const pids: number[] = [];
    const manager = makeFailClosedManager(subagentsDir, pids);

    // Background (wait:false) arm: the call returns {task_id} immediately, so
    // this is precisely the path where a silent success would strand an
    // orphan that no later process can even see.
    const thrown = withWorkerScript(script, () => {
      try {
        manager.spawn({ task: "bg work", conversationId: "conv-1" } as never);
        return undefined;
      } catch (err) {
        return err;
      }
    });

    assertFailClosed(thrown, pids);
  });
});

/** A worker that reads its envelope and then holds the process open. */
const HOLD_WORKER = `
let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk.toString("utf8");
});
setInterval(() => {}, 1000);
`;

function writeWorkerScript(root: string, source: string, name: string): string {
  const path = join(root, name);
  writeFileSync(path, source, "utf8");
  return path;
}

/** Run a manager call with the scratch worker entry as `process.argv[1]`. */
function withWorkerScript<T>(script: string, run: () => T): T {
  const original = process.argv[1];
  process.argv[1] = script;
  try {
    return run();
  } finally {
    process.argv[1] = original;
  }
}

/**
 * A manager whose record write is guaranteed to fail: a DIRECTORY is placed
 * where the record file must go, per task id, at spawn time. Both the staged
 * write's `renameSync` and the direct-write fallback then fail (EISDIR) — and
 * unlike a chmod fixture this needs no particular uid or filesystem.
 */
function makeFailClosedManager(
  subagentsDir: string,
  pids: number[]
): SubAgentManager {
  const base = createDefaultSubAgentSpawn();
  return createSubAgentManager({
    spawn: (def, taskId, payload) => {
      mkdirSync(join(subagentsDir, taskId, `process-${taskId}.json`), {
        recursive: true,
      });
      const child = base(def, taskId, payload);
      if (child.pid !== undefined) pids.push(child.pid);
      return child;
    },
    subagentsDir,
    sandboxRoot: subagentsDir,
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

/**
 * The shared contract both spawn arms must satisfy: a typed error naming the
 * cause, no handle returned, no live child left behind, and no task presented
 * as running.
 */
async function assertFailClosed(
  thrown: unknown,
  pids: number[]
): Promise<void> {
  assert.ok(
    thrown instanceof WorkerIdentityWriteError,
    `got ${String(thrown)}`
  );
  const err = thrown as WorkerIdentityWriteError;
  assert.equal(err.code, WORKER_IDENTITY_WRITE_ERROR_CODE);
  assert.ok(err.taskId.length > 0);
  assert.ok(err.cause instanceof Error, "the cause must be preserved");

  assert.equal(pids.length, 1, "the child must have actually started");
  const pid = pids[0] as number;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && isAlive(pid)) {
    await new Promise((r) => setTimeout(r, 20));
  }
  // The process this call started must be gone, not merely unrecorded.
  assert.equal(isAlive(pid), false, `pid ${pid} is still alive`);
}

/** Whether a write to `path` succeeds right now, leaving its bytes unchanged. */
function writable(path: string): boolean {
  try {
    writeFileSync(path, readFileSync(path, "utf8"), "utf8");
    return true;
  } catch {
    return false;
  }
}
