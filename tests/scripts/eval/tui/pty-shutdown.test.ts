/**
 * Real-process shutdown contracts for the PTY relay owner.
 *
 * A disposal promise is the ownership boundary: when it resolves, the relay
 * must have recorded the pty child's waitpid result and both owned processes
 * must be gone. Concurrent callers must share that same completion boundary.
 */
import { afterAll, afterEach, describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PtyCleanupError,
  disposeAllPtySessions,
  isProcessAlive,
  nextTeardownStep,
  openPty,
  type TeardownStep,
} from "../../../../scripts/eval/tui/pty.ts";

const roots: string[] = [];

function makeCwd(): string {
  const root = mkdtempSync(join(tmpdir(), "iknow-pty-shutdown-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await disposeAllPtySessions();
});

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("PtySession shutdown", () => {
  it("waits for the child EXIT report and reaping across concurrent disposal", async () => {
    const session = await openPty({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: makeCwd(),
    });
    const childPid = session.childPid;
    const relayPid = session.relayPid;
    const firstDisposal = session.killGroup("concurrent shutdown contract");
    const concurrentDisposal = session.dispose();

    try {
      assert.equal(
        concurrentDisposal,
        firstDisposal,
        "killGroup and dispose callers share the in-flight shutdown completion"
      );
      await concurrentDisposal;

      const exit = await session.waitExit(0);
      assert.ok(
        exit !== null,
        `shutdown must preserve the relay's waitpid result; relay: ${session.relayLog()}`
      );
      assert.match(
        session.relayLog(),
        /EXIT \S+ \S+/,
        "the relay must report the child's exit before disposal completes"
      );
      assert.equal(
        isProcessAlive(childPid),
        false,
        "the pty child must be reaped"
      );
      assert.equal(isProcessAlive(relayPid), false, "the relay must be reaped");
    } finally {
      await firstDisposal;
      await session.dispose();
    }
  });

  it("all-session disposal waits for a session whose shutdown is already in flight", async () => {
    const session = await openPty({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: makeCwd(),
    });
    const childPid = session.childPid;
    const relayPid = session.relayPid;
    const inFlight = session.dispose();

    try {
      await disposeAllPtySessions();

      const exit = await session.waitExit(0);
      assert.ok(
        exit !== null,
        `all-session cleanup must wait for the in-flight child EXIT; relay: ${session.relayLog()}`
      );
      assert.match(session.relayLog(), /EXIT \S+ \S+/);
      assert.equal(
        isProcessAlive(childPid),
        false,
        "all-session cleanup reaps the child"
      );
      assert.equal(
        isProcessAlive(relayPid),
        false,
        "all-session cleanup reaps the relay"
      );
    } finally {
      await inFlight;
      await disposeAllPtySessions();
    }
  });
});

/**
 * The relay-unresponsive failure path.
 *
 * WHY these cases exist: the escalation that SIGKILLs a relay which has not
 * closed within its reap grace (`killChildAndWaitForRelay` → `signalQuietly
 * (relayPid)`), and the `PtyCleanupError` it feeds, had ZERO test references —
 * so the one code path that runs when teardown has already gone wrong was the
 * one nobody could reach in a test.
 */
describe("the teardown ladder — a pure decision over observations", () => {
  const table: readonly {
    readonly name: string;
    readonly relayClosed: boolean;
    readonly childAlive: boolean;
    readonly relayKillSent: boolean;
    readonly expected: TeardownStep | null;
  }[] = [
    {
      name: "relay closed and nothing left: done",
      relayClosed: true,
      childAlive: false,
      relayKillSent: false,
      expected: null,
    },
    {
      name: "relay closed but the child survived: stop the child directly",
      relayClosed: true,
      childAlive: true,
      relayKillSent: false,
      expected: "stop_child",
    },
    {
      name: "relay still open after EOF: escalate to the relay kill",
      relayClosed: false,
      childAlive: true,
      relayKillSent: false,
      expected: "kill_relay",
    },
    {
      name: "relay still open with no child left: the relay itself is the leak",
      relayClosed: false,
      childAlive: false,
      relayKillSent: false,
      expected: "kill_relay",
    },
    {
      name: "relay kill already sent: do not signal it twice",
      relayClosed: false,
      childAlive: true,
      relayKillSent: true,
      expected: "stop_child",
    },
    {
      name: "relay kill sent and it closed: done",
      relayClosed: true,
      childAlive: false,
      relayKillSent: true,
      expected: null,
    },
  ];

  for (const row of table) {
    it(row.name, () => {
      assert.equal(
        nextTeardownStep({
          relayClosed: row.relayClosed,
          childAlive: row.childAlive,
          relayKillSent: row.relayKillSent,
        }),
        row.expected
      );
    });
  }
});

describe("PtyCleanupError — a teardown that could not be proven", () => {
  it("names every reason it could not prove the cleanup", () => {
    const err = new PtyCleanupError({
      remainingPids: [11, 22],
      relayClosed: false,
      childExitReported: false,
    });

    assert.equal(err.name, "PtyCleanupError");
    assert.deepEqual(err.remainingPids, [11, 22]);
    assert.equal(err.relayClosed, false);
    assert.equal(err.childExitReported, false);
    assert.equal(err.details.length, 3, JSON.stringify(err.details));
    assert.match(err.message, /owned PIDs remain: 11, 22/);
    assert.match(err.message, /relay did not close/);
    assert.match(err.message, /child EXIT was not reported/);
  });

  it("is thrown by dispose() when the relay never reported the child's exit", async () => {
    const session = await openPty({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: makeCwd(),
    });
    const childPid = session.childPid;
    // SIGKILL the relay out from under the session: it dies without reaping, so
    // it can never write its `EXIT ...` line. That is exactly the evidence an
    // unresponsive relay loses, made deterministic by removing the reporter
    // rather than by racing it.
    process.kill(session.relayPid, "SIGKILL");
    assert.equal(
      await waitGone(session.relayPid, 5_000),
      true,
      "the relay must actually be gone for this case to mean anything"
    );

    const failure = await session.dispose().then(
      () => null,
      (err: unknown) => err
    );

    assert.ok(
      failure instanceof PtyCleanupError,
      `an unproven child exit must be reported, never accepted; got: ${String(failure)}`
    );
    assert.equal(
      failure.childExitReported,
      false,
      `the missing EXIT line is the reason; got: ${failure.message}`
    );
    assert.match(failure.message, /child EXIT was not reported/);
    assert.equal(
      isProcessAlive(childPid),
      false,
      "the escalation must still reap the child the dead relay left behind"
    );
  }, 30_000);

  it("escalates past a LIVE relay that cannot process EOF (SIGSTOPped), reports the unproven cleanup, and still reaps the child", async () => {
    // WHY SIGSTOP and not SIGKILL: the sibling case above removes the reporter,
    // which exercises only the "relay already gone" branch. A STOPPED relay is
    // the harder half of the failure space — it is ALIVE (signals accepted,
    // `isProcessAlive` true) but can never process stdin EOF, never kills the
    // child group, and never writes `EXIT`. The teardown ladder must run to its
    // end against it: exhaust RELAY_REAP_GRACE_MS (2s), kill the child group
    // directly, still get no EXIT, then SIGKILL the relay itself.
    const session = await openPty({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: makeCwd(),
    });
    const childPid = session.childPid;
    const relayPid = session.relayPid;
    assert.ok(childPid > 0, "the fixture child must be running");
    process.kill(relayPid, "SIGSTOP");
    // Prove the pre-condition this case is named for: the relay is still
    // ALIVE (a liveness probe cannot tell it apart from a healthy relay) and
    // the child is too, so the escalation really is running against a live
    // surface that is merely unresponsive.
    assert.equal(
      isProcessAlive(relayPid),
      true,
      "a SIGSTOPped relay must still be signalable — that is exactly why it is the harder case"
    );
    assert.equal(
      isProcessAlive(childPid),
      true,
      "the child must still be alive before dispose; the stopped relay will never kill it"
    );

    const failure = await session.dispose().then(
      () => null,
      (err: unknown) => err
    );

    // FIELD CONTRACT, read off pty.ts rather than assumed:
    // - `childExitReported` is FALSE: a stopped relay never writes `EXIT`, so
    //   the child's exit was never reported through the control channel. This
    //   is the evidence the run loses.
    // - `relayClosed` is TRUE: after the ladder SIGKILLs the relay, Node's
    //   'close' handler fires (SIGKILL is not blockable, so the stopped state
    //   does not protect it) and sets `state.closed = true` before
    //   `assertPtyCleanupComplete` reads it.
    // - `remainingPids` is EMPTY: the ladder's `signalGroup` SIGKILLs the child
    //   group directly and waits it gone, and the relay itself is dead — so
    //   although the cleanup is UNPROVEN (no EXIT evidence), nothing actually
    //   survived. The error reports the unprovable claim, not a leak.
    assert.ok(
      failure instanceof PtyCleanupError,
      `a cleanup whose EXIT evidence was never produced must be reported, never accepted; got: ${String(failure)}`
    );
    assert.equal(
      failure.childExitReported,
      false,
      `the stopped relay never reported the child's exit; got: ${failure.message}`
    );
    assert.equal(
      failure.relayClosed,
      true,
      `the relay was SIGKILLed by the ladder and its close event settled before the assertion; got: ${failure.message}`
    );
    assert.deepEqual(
      failure.remainingPids,
      [],
      `the escalation kills the child group directly, so no owned pid actually survives; got: ${failure.message}`
    );
    assert.match(failure.message, /child EXIT was not reported/);
    assert.ok(
      !failure.message.includes("relay did not close"),
      `the relay DID close (via the SIGKILL escalation), so that diagnostic must not fire; got: ${failure.message}`
    );
    assert.ok(
      !failure.message.includes("owned PIDs remain"),
      `no pid survived, so the pid diagnostic must not fire; got: ${failure.message}`
    );

    // The child must be reaped regardless of the unproven cleanup.
    assert.equal(
      isProcessAlive(childPid),
      false,
      "the ladder must kill the child group directly when the relay cannot"
    );
    // Reap bookkeeping for the stopped relay: a SIGSTOPped process cannot run
    // its own exit path, so if the pid lingers as a zombie, SIGCONT it so the
    // kernel can finish the reaping the SIGKILL started. SIGKILL itself works
    // on stopped processes, so this only covers the waitpid race.
    if (isProcessAlive(relayPid)) {
      try {
        process.kill(relayPid, "SIGCONT");
      } catch {
        // EXIT: it died between the probe and the signal.
      }
    }
    assert.equal(
      await waitGone(relayPid, 10_000),
      true,
      `the SIGKILLed relay must eventually be reaped; pid: ${relayPid}`
    );
    assert.equal(
      await waitGone(childPid, 10_000),
      true,
      `the child must eventually be reaped; pid: ${childPid}`
    );
  }, 45_000);
});

describe("waitExit — null settlement clears the ref'd deadline", () => {
  it("settles a parked waitExit with null soon after the relay closes without EXIT, not at the deadline", async () => {
    // WHY: `waitExit` arms a REF'D deadline timer so the process cannot drain
    // out of a pending wait. The repair (issue #1224 requirement 3) makes
    // `notifyExit` clear that timer on the null branch too — a relay that
    // closes without writing `EXIT` is an answer, and the timer must not keep
    // the loop alive for the rest of its window. This case arms the wait,
    // removes the reporter mid-wait (SIGKILL, so no EXIT can ever be written),
    // and asserts the promise settles with `null` WELL BEFORE the deadline:
    // with the bug, the resolution still happens (close handler), but the
    // ref'd timer keeps the process alive for the remaining grace — observable
    // here as a settlement time that approaches the deadline.
    const session = await openPty({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: makeCwd(),
    });
    const deadlineMs = 10_000;
    const parked = session.waitExit(deadlineMs);
    await new Promise((r) => setTimeout(r, 300));
    process.kill(session.relayPid, "SIGKILL");

    const started = Date.now();
    const settled = await parked;
    const settledAfterMs = Date.now() - started;

    assert.equal(
      settled,
      null,
      `a relay that closed without EXIT must settle the waiter with null; got: ${JSON.stringify(settled)} relay log: ${session.relayLog()}`
    );
    assert.ok(
      settledAfterMs < deadlineMs / 2,
      `the null settlement must arrive from the relay's close, not from the deadline timer burning its window; settled ${settledAfterMs}ms after the kill, deadline was ${deadlineMs}ms`
    );
    // The child the dead relay left behind must not survive the case.
    await session.dispose().catch(() => undefined);
    assert.equal(
      await waitGone(session.childPid, 10_000),
      true,
      `the orphaned child must be reaped; pid: ${session.childPid}`
    );
  }, 30_000);
});

async function waitGone(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !isProcessAlive(pid);
}
