/**
 * T4 — parent-visible envelope locator (SC4).
 * Wire names: `task_id`, `tmp_root`; success has no `product_roster` (or empty).
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, it, vi } from "vitest";

import { workerFenceTmpPath } from "../../src/harness/sandbox/fence-tmp.ts";
import { createSubAgentManager } from "../../src/harness/subagent/manager.ts";
import type { SubAgentEnvelope } from "../../src/harness/subagent/envelope.ts";

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

let subagentsDir: string;

beforeEach(() => {
  const root = makeScratch("iknow-t4-env-");
  subagentsDir = join(root, "subagents");
  mkdirSync(subagentsDir, { recursive: true });
});

afterEach(() => {
  for (const path of scratchPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("T4 manager buffer / drain locator (SC4)", () => {
  it("success waitFor + drainCompleted stamp task_id and worker fence-tmp root", async () => {
    const child = makeFakeChild();
    const manager = createSubAgentManager({
      spawn: () => child as unknown as ChildProcess,
      subagentsDir,
    });
    const { taskId } = manager.spawn({ task: "ok" });
    emitEnvelope(child, { status: "ok", summary: "done", result: "done" });
    await flushTwoTicks();

    const env = await manager.waitFor(taskId);
    const pad = workerFenceTmpPath(subagentsDir, taskId);
    assert.equal(env.status, "ok");
    assert.equal(env.task_id, taskId);
    assert.equal(env.tmp_root, pad);
    assert.ok(env.task_id.length > 0);
    assert.ok(env.tmp_root.length > 0);
    assert.ok(
      env.product_roster === undefined || env.product_roster.length === 0
    );

    const drained = manager.drainCompleted();
    assert.equal(drained.length, 1);
    assert.equal(drained[0]!.envelope.task_id, taskId);
    assert.equal(drained[0]!.envelope.tmp_root, pad);
    await manager.shutdown();
  });

  it("mailbox notice carries tmp_root for the worker pad", async () => {
    const child = makeFakeChild();
    const manager = createSubAgentManager({
      spawn: () => child as unknown as ChildProcess,
      subagentsDir,
    });
    const notices: { taskId: string; tmp_root?: string }[] = [];
    manager.subscribe((notice) => {
      notices.push({ taskId: notice.taskId, tmp_root: notice.tmp_root });
    });
    const { taskId } = manager.spawn({ task: "mail" });
    emitEnvelope(child, { status: "ok", summary: "done", result: "done" });
    await flushTwoTicks();
    assert.equal(notices.length, 1);
    assert.equal(notices[0]!.taskId, taskId);
    assert.equal(
      notices[0]!.tmp_root,
      workerFenceTmpPath(subagentsDir, taskId)
    );
    await manager.shutdown();
  });

  it("failure waitFor + drainCompleted stamp the same locator", async () => {
    const child = makeFakeChild();
    const manager = createSubAgentManager({
      spawn: () => child as unknown as ChildProcess,
      subagentsDir,
    });
    const { taskId } = manager.spawn({ task: "fail" });
    emitEnvelope(child, {
      status: "failed",
      reason: "protocolError",
      summary: "bad",
      result: "",
    });
    await flushTwoTicks();

    const env = await manager.waitFor(taskId);
    const pad = workerFenceTmpPath(subagentsDir, taskId);
    assert.equal(env.status, "failed");
    assert.equal(env.task_id, taskId);
    assert.equal(env.tmp_root, pad);

    const drained = manager.drainCompleted();
    assert.equal(drained[0]!.envelope.task_id, taskId);
    assert.equal(drained[0]!.envelope.tmp_root, pad);
    await manager.shutdown();
  });
});
