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
  disposeAllPtySessions,
  isProcessAlive,
  openPty,
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
