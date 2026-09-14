/**
 * T6 — empty / crash / timeout / truncated handoff may attach a short
 * top-level pad roster (SC5). Names only; no file bodies.
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, it, vi } from "vitest";

import { workerFenceTmpPath } from "../../src/harness/sandbox/fence-tmp.ts";
import { drainPendingSubagents } from "../../src/harness/subagent/host-drain.ts";
import { createSubAgentManager } from "../../src/harness/subagent/manager.ts";
import type { SubAgentEnvelope } from "../../src/harness/subagent/envelope.ts";

const SECRET_BODY = "PAD-BODY-MUST-NOT-ENTER-ENVELOPE";
/** The pad roster's own 200-name window (not read_file's contract). */
const PAD_ROSTER_LINE_LIMIT = 200;

interface FakeChild {
  readonly stdin: PassThrough;
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
  readonly kill: ReturnType<typeof vi.fn>;
  emit: (event: string | symbol, ...args: unknown[]) => boolean;
}

function makeFakeChild(): FakeChild {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
    exitCode: null,
    signalCode: null,
    pid: 1000,
  }) as unknown as FakeChild;
}

function emitEnvelope(child: FakeChild, env: SubAgentEnvelope): void {
  child.stdout.write(`${JSON.stringify(env)}\n`);
  child.emit("exit", env.status === "ok" ? 0 : 1, null);
}

function flushTwoTicks(): Promise<void> {
  return new Promise((r) => setImmediate(r)).then(
    () => new Promise((r) => setImmediate(r))
  );
}

const scratchPaths: string[] = [];

function makeScratch(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  scratchPaths.push(path);
  return path;
}

function wirePad(
  subagentsDir: string,
  taskId: string,
  files: ReadonlyArray<{ name: string; body: string }>
): string {
  const pad = workerFenceTmpPath(subagentsDir, taskId);
  mkdirSync(pad, { recursive: true });
  for (const file of files) {
    writeFileSync(join(pad, file.name), file.body, "utf8");
  }
  return pad;
}

function assertRosterNamesOnly(
  env: SubAgentEnvelope,
  expectedNames: readonly string[]
): void {
  assert.ok(env.product_roster !== undefined);
  assert.deepEqual([...env.product_roster].sort(), [...expectedNames].sort());
  const serialized = JSON.stringify(env);
  assert.ok(!serialized.includes(SECRET_BODY));
  for (const name of expectedNames) {
    assert.ok(env.product_roster.includes(name));
  }
}

let subagentsDir: string;

beforeEach(() => {
  const root = makeScratch("iknow-t6-roster-");
  subagentsDir = join(root, "subagents");
  mkdirSync(subagentsDir, { recursive: true });
});

afterEach(() => {
  for (const path of scratchPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("T6 empty handoff pad roster (SC5)", () => {
  it("empty summary and result attach top-level names, not file bodies", async () => {
    const child = makeFakeChild();
    const manager = createSubAgentManager({
      spawn: () => child as unknown as ChildProcess,
      subagentsDir,
    });
    const { taskId } = manager.spawn({ task: "empty" });
    wirePad(subagentsDir, taskId, [
      { name: "notes.md", body: SECRET_BODY },
      { name: "sketch.txt", body: `${SECRET_BODY}-2` },
    ]);
    emitEnvelope(child, { status: "ok", summary: "", result: "" });
    await flushTwoTicks();

    const env = await manager.waitFor(taskId);
    assertRosterNamesOnly(env, ["notes.md", "sketch.txt"]);

    const drained = manager.drainCompleted();
    assert.equal(drained.length, 1);
    assertRosterNamesOnly(drained[0]!.envelope, ["notes.md", "sketch.txt"]);

    const text = await drainPendingSubagents(manager);
    assert.match(text, /notes\.md/);
    assert.match(text, /sketch\.txt/);
    assert.doesNotMatch(text, new RegExp(SECRET_BODY));
    await manager.shutdown();
  });

  it("success with a non-empty handoff still omits product_roster", async () => {
    const child = makeFakeChild();
    const manager = createSubAgentManager({
      spawn: () => child as unknown as ChildProcess,
      subagentsDir,
    });
    const { taskId } = manager.spawn({ task: "ok" });
    wirePad(subagentsDir, taskId, [{ name: "notes.md", body: SECRET_BODY }]);
    emitEnvelope(child, { status: "ok", summary: "done", result: "done" });
    await flushTwoTicks();

    const env = await manager.waitFor(taskId);
    assert.ok(
      env.product_roster === undefined || env.product_roster.length === 0
    );
    assert.ok(!JSON.stringify(env).includes(SECRET_BODY));
    await manager.shutdown();
  });

  it("crash terminal attaches top-level names without bodies", async () => {
    const child = makeFakeChild();
    const manager = createSubAgentManager({
      spawn: () => child as unknown as ChildProcess,
      subagentsDir,
    });
    const { taskId } = manager.spawn({ task: "crash" });
    wirePad(subagentsDir, taskId, [{ name: "dump.bin", body: SECRET_BODY }]);
    child.stderr.end();
    child.emit("exit", 1, null);
    const env = await manager.waitFor(taskId);
    assert.equal(env.status, "failed");
    assert.equal(env.reason, "crashed");
    assertRosterNamesOnly(env, ["dump.bin"]);
    await manager.shutdown();
  });

  it("timeout terminal attaches top-level names without bodies", async () => {
    vi.useFakeTimers();
    try {
      const child = makeFakeChild();
      const manager = createSubAgentManager({
        spawn: () => child as unknown as ChildProcess,
        subagentsDir,
      });
      const { taskId } = manager.spawn({ task: "slow", timeoutMs: 50 });
      wirePad(subagentsDir, taskId, [
        { name: "partial.md", body: SECRET_BODY },
      ]);
      await vi.advanceTimersByTimeAsync(50);
      const env = await manager.waitFor(taskId);
      assert.equal(env.status, "failed");
      assert.equal(env.reason, "timeout");
      assertRosterNamesOnly(env, ["partial.md"]);
      await manager.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });

  it("truncated terminal attaches top-level names without bodies", async () => {
    const child = makeFakeChild();
    const manager = createSubAgentManager({
      spawn: () => child as unknown as ChildProcess,
      subagentsDir,
    });
    const { taskId } = manager.spawn({ task: "long" });
    wirePad(subagentsDir, taskId, [{ name: "huge.md", body: SECRET_BODY }]);
    const longResult = "x".repeat(20_001);
    emitEnvelope(child, {
      status: "ok",
      summary: "folded",
      result: longResult,
    });
    await flushTwoTicks();

    const env = await manager.waitFor(taskId);
    assert.equal(env.truncated, true);
    assertRosterNamesOnly(env, ["huge.md"]);
    await manager.shutdown();
  });

  it("roster caps at the pad's own 200-name window", async () => {
    const child = makeFakeChild();
    const manager = createSubAgentManager({
      spawn: () => child as unknown as ChildProcess,
      subagentsDir,
    });
    const { taskId } = manager.spawn({ task: "many" });
    const files = Array.from({ length: PAD_ROSTER_LINE_LIMIT + 1 }, (_, i) => ({
      name: `n${String(i).padStart(3, "0")}.txt`,
      body: SECRET_BODY,
    }));
    wirePad(subagentsDir, taskId, files);
    emitEnvelope(child, { status: "ok", summary: "", result: "" });
    await flushTwoTicks();

    const env = await manager.waitFor(taskId);
    assert.equal(env.product_roster?.length, PAD_ROSTER_LINE_LIMIT);
    assert.ok(!JSON.stringify(env).includes(SECRET_BODY));
    await manager.shutdown();
  });
});
