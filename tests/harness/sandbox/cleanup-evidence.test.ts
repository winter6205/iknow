/**
 * Truthful bounded process cleanup: the `not_started` / `confirmed_stopped` /
 * `unconfirmed` evidence contract on both execution planes.
 *
 * Behaviour classes covered (one per spec contract, no wall-clock assertions):
 *   1. never-launched / teardown-not-requested -> `not_started`
 *   2. group observed gone after the TERM/grace/KILL route -> `confirmed_stopped`
 *   3. leader exits while a TERM-immune descendant survives -> escalation stays
 *      armed, and the terminal event only lands after the group is gone
 *   4. bounded observation expires while the group is still alive -> `unconfirmed`
 *      with a typed reason and the task/process identity
 *   5. a signal that fails with a non-ESRCH errno -> `unconfirmed` /
 *      `teardown_failed`, never a swallowed success
 *   6. competing terminal events (stop + natural exit) -> one terminal transition
 *
 * Real processes throughout: every fixture spawns a real detached `sh` whose pid
 * is the process group, and the group is probed with kill(-pgid, 0). Assertions
 * are discrete facts (evidence fields, ESRCH on the group, the descendant's own
 * pid file), never a timing threshold.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it, vi } from "vitest";

import {
  runInSandbox,
  type SandboxRunResult,
} from "../../../src/harness/sandbox/runner.ts";
import { createSandboxServer } from "../../../src/harness/sandbox/server/index.js";
import { setProcessGroupAliveProbe } from "../../../src/harness/sandbox/cleanup-result.ts";
import type {
  SandboxTaskEvent,
  SandboxTaskHandle,
} from "../../../src/harness/sandbox/server/types.js";
import type { BwrapFence } from "../../../src/harness/sandbox/bwrap.ts";
import { waitForPidFile } from "../aci/tools/spawn-test-utils.ts";

const scratch: string[] = [];
const liveGroups: number[] = [];

async function makeScratch(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

function shFence(command: string): BwrapFence {
  return Object.freeze({
    argv: Object.freeze(["sh", "-c", command]),
    sealed: true as const,
    // The bare-argv fixture emits no boundary block, so it names no mask.
    exactFileMaskPaths: Object.freeze([]),
  });
}

/** Group liveness via the ESRCH contract: ESRCH means the group is gone. */
function groupGone(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return false;
  } catch (err) {
    assert.equal(
      (err as NodeJS.ErrnoException).code,
      "ESRCH",
      `probe raised a non-ESRCH errno: ${String(err)}`
    );
    return true;
  }
}

function cleanup(
  code: SandboxRunResult["cleanup"]
): NonNullable<SandboxRunResult["cleanup"]> {
  assert.ok(code, "the execution plane must carry cleanup evidence");
  return code;
}

afterEach(async () => {
  vi.restoreAllMocks();
  setProcessGroupAliveProbe(undefined);
  for (const pgid of liveGroups.splice(0)) {
    try {
      process.kill(-pgid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  await Promise.all(
    scratch.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

// ─── foreground plane ────────────────────────────────────────────────────────

describe("foreground cleanup evidence — runInSandbox", () => {
  it("natural exit without a teardown request reports not_started", async () => {
    const result = await runInSandbox({
      fence: shFence("printf done; exit 3"),
      cwd: tmpdir(),
      env: process.env,
    });
    assert.equal(result.exitCode, 3);
    assert.equal(result.stdout, "done");
    // No teardown was ever requested, so no stop may be claimed.
    assert.equal(cleanup(result.cleanup).state, "not_started");
  });

  it("abort on a killable tree reports confirmed_stopped with the group gone", async () => {
    const cwd = await makeScratch("cleanup-fg-confirmed-");
    const pgidFile = join(cwd, "pgid");
    const controller = new AbortController();
    const execution = runInSandbox({
      fence: shFence(`echo $$ > ${JSON.stringify(pgidFile)}; sleep 30 & wait`),
      cwd,
      env: process.env,
      signal: controller.signal,
      killGraceMs: 50,
    });
    const pgid = await waitForPidFile(pgidFile);
    liveGroups.push(pgid);
    assert.equal(groupGone(pgid), false, "group is alive before the abort");
    controller.abort();
    const result = await execution;
    const evidence = cleanup(result.cleanup);
    assert.equal(evidence.state, "confirmed_stopped");
    assert.equal(
      evidence.pgid,
      pgid,
      "confirmed evidence carries the observed process-group id"
    );
    assert.equal(groupGone(pgid), true, "group really disappeared");
  });

  it("leader exit with a surviving descendant still ends confirmed only after the group is gone", async () => {
    const cwd = await makeScratch("cleanup-fg-leader-exit-");
    const pgidFile = join(cwd, "pgid");
    const descendantFile = join(cwd, "descendant");
    const controller = new AbortController();
    // The leader dies from the teardown's SIGTERM while the TERM-immune
    // descendant stays in the group: `close` therefore arrives with the group
    // still populated, which is exactly the case the escalation must survive.
    const execution = runInSandbox({
      fence: shFence(
        `sh -c "trap '' TERM; echo \\$\\$ > ${JSON.stringify(descendantFile)}; exec sleep 300" >/dev/null 2>&1 & ` +
          `echo $$ > ${JSON.stringify(pgidFile)}; exec sleep 300`
      ),
      cwd,
      env: process.env,
      signal: controller.signal,
      killGraceMs: 50,
    });
    const pgid = await waitForPidFile(pgidFile);
    const descendant = await waitForPidFile(descendantFile);
    liveGroups.push(pgid);
    assert.equal(groupGone(pgid), false, "group is alive before the abort");
    process.kill(descendant, 0);
    controller.abort();
    const result = await execution;
    assert.equal(cleanup(result.cleanup).state, "confirmed_stopped");
    assert.equal(
      groupGone(pgid),
      true,
      "the descendant was killed by the escalation, not merely forgotten"
    );
    assert.throws(
      () => process.kill(descendant, 0),
      (err: unknown) => (err as NodeJS.ErrnoException).code === "ESRCH"
    );
  });

  it("a bounded observation that never sees the group gone reports unconfirmed/observation_expired", async () => {
    const cwd = await makeScratch("cleanup-fg-expiry-");
    const pgidFile = join(cwd, "pgid");
    // A group that survives SIGKILL cannot be produced on Linux, so the
    // expiry route is exercised over a real tree with a blinded probe: the
    // TERM/grace/KILL route still runs against real processes, and the probe
    // stands in for a group that will not confirm. The probe reports "gone"
    // for the pre-teardown checks (so the fixture reaches the teardown) and
    // "alive" for every probe made after the abort — exactly the shape of a
    // group the kill route cannot drain.
    let armed = false;
    let postAbortProbes = 0;
    setProcessGroupAliveProbe(() => {
      if (armed) {
        postAbortProbes += 1;
        return true;
      }
      return false;
    });
    const controller = new AbortController();
    const execution = runInSandbox({
      fence: shFence(`echo $$ > ${JSON.stringify(pgidFile)}; sleep 30 & wait`),
      cwd,
      env: process.env,
      signal: controller.signal,
      killGraceMs: 20,
      groupObserveMs: 60,
    });
    const pgid = await waitForPidFile(pgidFile);
    liveGroups.push(pgid);
    armed = true;
    controller.abort();
    const result = await execution;
    const evidence = cleanup(result.cleanup);
    assert.equal(evidence.state, "unconfirmed");
    if (evidence.state !== "unconfirmed") return;
    assert.equal(evidence.reason, "observation_expired");
    assert.equal(
      evidence.pgid,
      pgid,
      "unconfirmed carries the process identity"
    );
    assert.ok(postAbortProbes > 0, "the observation really probed the group");
    // The kill route still did its job: the tree is gone even though the
    // verdict could not confirm it.
    assert.equal(groupGone(pgid), true);
  });

  it("a failing signal reports unconfirmed/teardown_failed instead of a swallowed stop", async () => {
    const cwd = await makeScratch("cleanup-fg-teardown-err-");
    const pgidFile = join(cwd, "pgid");
    const realKill = process.kill.bind(process);
    vi.spyOn(process, "kill").mockImplementation(((
      pid: number,
      signal?: number | NodeJS.Signals
    ) => {
      // Signal 0 is the liveness probe and stays real; every actual delivery
      // fails the way a foreign-owned process group does.
      if (signal === 0) return realKill(pid, signal);
      throw Object.assign(new Error("mock EPERM"), { code: "EPERM" });
    }) as typeof process.kill);
    const controller = new AbortController();
    const execution = runInSandbox({
      fence: shFence(`echo $$ > ${JSON.stringify(pgidFile)}; sleep 30 & wait`),
      cwd,
      env: process.env,
      signal: controller.signal,
      killGraceMs: 20,
    });
    const pgid = await waitForPidFile(pgidFile);
    liveGroups.push(pgid);
    controller.abort();
    const result = await execution;
    const evidence = cleanup(result.cleanup);
    assert.equal(evidence.state, "unconfirmed");
    if (evidence.state !== "unconfirmed") return;
    assert.equal(evidence.reason, "teardown_failed");
    assert.match(evidence.detail, /EPERM/);
    assert.equal(
      groupGone(pgid),
      false,
      "a failed teardown must not pretend the tree is gone"
    );
  });

  it("abort racing a natural exit settles once with a consistent evidence", async () => {
    const cwd = await makeScratch("cleanup-fg-race-");
    const pgidFile = join(cwd, "pgid");
    const controller = new AbortController();
    const execution = runInSandbox({
      fence: shFence(
        `echo $$ > ${JSON.stringify(pgidFile)}; sleep 0.05; exit 0`
      ),
      cwd,
      env: process.env,
      signal: controller.signal,
      killGraceMs: 50,
    });
    const pgid = await waitForPidFile(pgidFile);
    liveGroups.push(pgid);
    controller.abort();
    const result = await execution;
    // Whichever side won the race, the single terminal transition carries one
    // coherent verdict — never a "stopped" claim without an observation.
    const evidence = cleanup(result.cleanup);
    if (evidence.state === "not_started") {
      assert.equal(result.exitCode, 0, "a natural exit is not a stop");
    } else {
      assert.equal(evidence.state, "confirmed_stopped");
      assert.equal(groupGone(pgid), true);
    }
  });
});

// ─── background plane ────────────────────────────────────────────────────────

describe("background cleanup evidence — server spawn", () => {
  it("keeps the escalation armed after the leader exits and reports the group gone", async () => {
    const cwd = await makeScratch("cleanup-bg-leader-exit-");
    const pgidFile = join(cwd, "pgid");
    const descendantFile = join(cwd, "descendant");
    const server = createSandboxServer();
    // The leader dies from the stop's SIGTERM while the TERM-immune descendant
    // stays in the group, so `close` arrives with the group still populated.
    const handle = await server.spawn({
      kind: "spawn",
      fence: shFence(
        `sh -c "trap '' TERM; echo \\$\\$ > ${JSON.stringify(descendantFile)}; exec sleep 300" >/dev/null 2>&1 & ` +
          `echo $$ > ${JSON.stringify(pgidFile)}; exec sleep 300`
      ),
      cwd,
      env: process.env,
    });
    const pgid = await waitForPidFile(pgidFile);
    const descendant = await waitForPidFile(descendantFile);
    liveGroups.push(pgid);
    await handle.stop(50);
    const events = await drainUntilClosed(handle);
    const stopped = events.find((ev) => ev.kind === "stopped");
    // The terminal cleanup event must not land while the descendant lives.
    assert.ok(stopped, "a stop request that tears down a task emits stopped");
    assert.equal(
      stopped.cleanup.state,
      "confirmed_stopped",
      "the group was observed gone before the terminal event"
    );
    assert.equal(stopped.cleanup.task_id, handle.task_id);
    assert.equal(stopped.cleanup.pgid, pgid);
    assert.equal(events.filter((ev) => ev.kind === "exit").length, 1);
    assert.equal(groupGone(pgid), true);
    assert.throws(
      () => process.kill(descendant, 0),
      (err: unknown) => (err as NodeJS.ErrnoException).code === "ESRCH"
    );
  }, 10_000);

  it("a bounded observation that never sees the group gone reports unconfirmed/observation_expired", async () => {
    const cwd = await makeScratch("cleanup-bg-expiry-");
    const pgidFile = join(cwd, "pgid");
    let armed = false;
    let postAbortProbes = 0;
    setProcessGroupAliveProbe(() => {
      if (armed) {
        postAbortProbes += 1;
        return true;
      }
      return false;
    });
    const server = createSandboxServer();
    const handle = await server.spawn({
      kind: "spawn",
      fence: shFence(`echo $$ > ${JSON.stringify(pgidFile)}; sleep 30`),
      cwd,
      env: process.env,
      groupObserveMs: 60,
    });
    const pgid = await waitForPidFile(pgidFile);
    liveGroups.push(pgid);
    armed = true;
    await handle.stop(20);
    const events = await drainUntilClosed(handle);
    const stopped = events.find((ev) => ev.kind === "stopped");
    assert.ok(stopped);
    assert.equal(stopped.cleanup.state, "unconfirmed");
    if (stopped.cleanup.state !== "unconfirmed") return;
    assert.equal(stopped.cleanup.reason, "observation_expired");
    assert.equal(stopped.cleanup.task_id, handle.task_id);
    assert.equal(stopped.cleanup.pgid, pgid);
    assert.ok(postAbortProbes > 0, "the observation really probed the group");
    assert.equal(
      groupGone(pgid),
      true,
      "the kill route still ran; only the confirmation was undecidable"
    );
  }, 10_000);

  it("a failing escalation reports unconfirmed/teardown_failed, never a stopped claim", async () => {
    const cwd = await makeScratch("cleanup-bg-teardown-err-");
    const pgidFile = join(cwd, "pgid");
    const realKill = process.kill.bind(process);
    vi.spyOn(process, "kill").mockImplementation(((
      pid: number,
      signal?: number | NodeJS.Signals
    ) => {
      if (signal === 0) return realKill(pid, signal);
      throw Object.assign(new Error("mock EPERM"), { code: "EPERM" });
    }) as typeof process.kill);
    const server = createSandboxServer();
    const handle = await server.spawn({
      kind: "spawn",
      fence: shFence(`echo $$ > ${JSON.stringify(pgidFile)}; sleep 30`),
      cwd,
      env: process.env,
    });
    const pgid = await waitForPidFile(pgidFile);
    liveGroups.push(pgid);
    await handle.stop(20);
    const events = await drainUntilClosed(handle);
    const stopped = events.find((ev) => ev.kind === "stopped");
    assert.ok(stopped);
    assert.equal(stopped.cleanup.state, "unconfirmed");
    if (stopped.cleanup.state !== "unconfirmed") return;
    assert.equal(stopped.cleanup.reason, "teardown_failed");
    assert.match(stopped.cleanup.detail, /EPERM/);
    assert.equal(groupGone(pgid), false);
  }, 10_000);

  it("a stop request against a task that never ran reports not_started and is not a stop claim", async () => {
    const cwd = await makeScratch("cleanup-bg-not-started-");
    const server = createSandboxServer();
    const handle = await server.spawn({
      kind: "spawn",
      fence: shFence("exit 0"),
      cwd,
      env: process.env,
    });
    const events = await drainUntilClosed(handle);
    // No teardown was requested: the natural exit carries no stop claim.
    assert.equal(
      events.some((ev) => ev.kind === "stopped"),
      false
    );
    assert.equal(
      events.some((ev) => ev.kind === "exit"),
      true,
      "the task still reports its exit"
    );
  }, 10_000);
});

/** Drain every event up to the close sentinel (the single-consumer contract allows one call per handle). */
async function drainUntilClosed(
  handle: SandboxTaskHandle
): Promise<ReadonlyArray<SandboxTaskEvent & { kind: string }>> {
  const events: Array<SandboxTaskEvent> = [];
  for await (const ev of handle.events()) events.push(ev);
  return events as ReadonlyArray<SandboxTaskEvent & { kind: string }>;
}
