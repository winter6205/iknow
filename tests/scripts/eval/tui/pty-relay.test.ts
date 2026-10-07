/**
 * Contract tests for `scripts/eval/tui/pty-relay.py` (#1219).
 *
 * WHY the relay needs its own tests: it is the one component in the measurement
 * path that is not TypeScript, and it sits between the driver and the terminal
 * under test. Two of its guarantees are invisible from the driver side — a
 * stimulus must arrive VERBATIM (no truncation, no re-chunking), and a control
 * verb must report what it claims to report. Both fail silently: a truncated
 * stimulus is reported by the run as a `timeout` for input that was only partly
 * typed, and a verb that prints a constant can never contradict anything.
 *
 * The relay is exercised as the real thing — a real `pty.fork()`, a real
 * process — because mocking its stdin/stdout boundary would mock away the very
 * behaviour under test. No model calls, and no product process: the children
 * here are `cat` and `sh`.
 */
import { afterAll, describe, it } from "vitest";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const RELAY = fileURLToPath(
  new URL("../../../../scripts/eval/tui/pty-relay.py", import.meta.url)
);

const roots: string[] = [];

function makeCwd(): string {
  const root = mkdtempSync(join(tmpdir(), "iknow-pty-relay-"));
  roots.push(root);
  return root;
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** A live relay plus the two streams it owns. */
interface Relay {
  readonly proc: ChildProcess;
  write(data: string): void;
  stdout(): string;
  stderr(): string;
  waitFor(predicate: () => boolean, ms: number): Promise<boolean>;
  /** Ask the relay to stop the child's group, then confirm it is gone. */
  stop(): Promise<void>;
}

function startRelay(command: string, args: readonly string[], cwd: string) {
  const proc = spawn("python3", [RELAY, cwd, command, ...args], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    // Its own group, so a test can never signal the runner's group.
    detached: true,
  });
  let out = "";
  let err = "";
  proc.stdout?.on("data", (chunk: Buffer) => {
    out += chunk.toString("utf8");
  });
  proc.stderr?.on("data", (chunk: Buffer) => {
    err += chunk.toString("utf8");
  });
  const relay: Relay = {
    proc,
    write: (data) => proc.stdin?.write(data),
    stdout: () => out,
    stderr: () => err,
    waitFor: async (predicate, ms) => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        if (predicate()) return true;
        await new Promise((r) => setTimeout(r, 20));
      }
      return predicate();
    },
    stop: async () => {
      try {
        proc.kill("SIGTERM");
      } catch {
        // EXIT: already gone.
      }
      try {
        proc.stdin?.end();
      } catch {
        // EXIT: the pipe is already closed.
      }
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline && proc.exitCode === null) {
        await new Promise((r) => setTimeout(r, 25));
      }
      try {
        process.kill(-(proc.pid ?? -1), "SIGKILL");
      } catch {
        // EXIT: nothing left in the relay's group.
      }
    },
  };
  return relay;
}

function childPidOf(relay: Relay): number {
  const match = /CHILDPID (\d+)/.exec(relay.stdout());
  return match === null ? -1 : Number(match[1]);
}

describe("pty-relay — stdin is forwarded verbatim", () => {
  it("forwards EVERY line of a multi-line stimulus written in one chunk", async () => {
    const cwd = makeCwd();
    // `cat` holds the pty slave open and never exits on its own, so the relay
    // keeps serving until the test stops it.
    const relay = startRelay("cat", [], cwd);
    try {
      assert.ok(
        await relay.waitFor(() => childPidOf(relay) > 0, 5000),
        `the relay must report a child pid; stderr: ${relay.stderr()}`
      );

      // One write, three lines. The relay used to forward only through the
      // FIRST newline and leave the remainder buffered, revisiting it only when
      // more stdin arrived — so `line3` and the terminating CR never reached
      // the child and the stimulus was never submitted.
      relay.write("line1\nline2\nline3\r");

      assert.ok(
        await relay.waitFor(() => relay.stdout().includes("line3"), 5000),
        `the whole stimulus must reach the pty master; stdout: ${JSON.stringify(relay.stdout())}`
      );
      assert.ok(
        await relay.waitFor(() => relay.stdout().includes("line2"), 5000),
        `an intermediate line must not be stranded in the buffer; stdout: ${JSON.stringify(relay.stdout())}`
      );
    } finally {
      await relay.stop();
    }
  });

  it("keeps a stimulus with no newline at all forwarded as one write", async () => {
    const cwd = makeCwd();
    const relay = startRelay("cat", [], cwd);
    try {
      assert.ok(
        await relay.waitFor(() => childPidOf(relay) > 0, 5000),
        `the relay must report a child pid; stderr: ${relay.stderr()}`
      );
      relay.write("no-newline-here\r");

      assert.ok(
        await relay.waitFor(
          () => relay.stdout().includes("no-newline-here"),
          5000
        ),
        `a newline-free stimulus is the normal case and must pass; stdout: ${JSON.stringify(relay.stdout())}`
      );
    } finally {
      await relay.stop();
    }
  });
});

describe("pty-relay — the control vocabulary is only verbs it really honors", () => {
  it("no longer swallows a line as a verb it cannot honor", async () => {
    const cwd = makeCwd();
    const relay = startRelay("cat", [], cwd);
    try {
      assert.ok(
        await relay.waitFor(() => childPidOf(relay) > 0, 5000),
        `the relay must report a child pid; stderr: ${relay.stderr()}`
      );

      // `EXIT-STATUS` documented itself as reporting whether the child had been
      // reaped, but its handler wrote a constant and nothing ever read it — a
      // verb that can never contradict anything. It is gone, so this line is
      // now ordinary stimulus text and must reach the child like any other.
      relay.write("EXIT-STATUS\n");

      assert.ok(
        await relay.waitFor(() => relay.stdout().includes("EXIT-STATUS"), 5000),
        `an unknown line must be forwarded as data, not eaten by a dead verb; stdout: ${JSON.stringify(relay.stdout())}`
      );
    } finally {
      await relay.stop();
    }
  });
});
