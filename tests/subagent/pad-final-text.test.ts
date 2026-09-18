/**
 * Locked sentence 2 (plans/session-fg-handoff-interrupt.md) — host 落稿。
 *
 * 不变式：父可见信封仍是短摘要，不是终稿。worker 终态时 **host** 把
 * `task.envelope.result`（host 手里那一份，worker 已在 wire 上折叠过的即
 * 折叠后的文本）写入该 worker pad 的稳定相对路径 `FINAL_TEXT_PAD_NAME`，
 * 信封带 `output_path`（pad 相对路径，供 `subagent_result(tmp_path)` 消费）。
 *
 *   - 终稿长于短信封 → pad 文件可读，内容 === 终态 assistant 正文；
 *   - `truncated: true` 仍是 `status: "ok"`、无 `reason`、文件可读
 *     （截断口径同既有 pad 读，截断**不是**任务失败）；
 *   - 空 / 全空白 result（timeout fallback 形态）→ 不落稿、`output_path` 键缺席、
 *     不伪造空文件；
 *   - pad 写失败（此处用「padRoot 是不可写路径」模拟）→ 信封照常产出、
 *     `output_path` 缺席、任务状态不变、不抛穿 locateEnvelope；
 *   - 回环：用 `output_path` 的值喂 `subagent_result(tmp_path)` 取回正文。
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, it, vi } from "vitest";

import { FINAL_TEXT_PAD_NAME } from "../../src/harness/subagent/envelope.ts";
import type { SubAgentEnvelope } from "../../src/harness/subagent/envelope.ts";
import { createSubAgentManager } from "../../src/harness/subagent/manager.ts";
import { inspectWorkerPad } from "../../src/harness/subagent/pad-inspect.ts";
import { createSubAgentResultTool } from "../../src/harness/subagent/subagent-result-tool.ts";
import { workerFenceTmpPath } from "../../src/harness/sandbox/fence-tmp.ts";

interface FakeChild {
  readonly stdin: PassThrough;
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
  readonly kill: ReturnType<typeof vi.fn>;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  readonly pid: number;
  emit: (event: string | symbol, ...args: unknown[]) => boolean;
}

function makeFakeChild(): FakeChild {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
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
  const root = makeScratch("iknow-pad-final-");
  subagentsDir = join(root, "subagents");
  mkdirSync(subagentsDir, { recursive: true });
});

afterEach(() => {
  for (const path of scratchPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
    rmSync(`${path}.unwritable`, { recursive: true, force: true });
  }
});

describe("host pad final text (Locked sentence 2)", () => {
  it("terminal settle writes the final assistant text to the pad and stamps output_path", async () => {
    const child = makeFakeChild();
    const manager = createSubAgentManager({
      spawn: () => child as unknown as ChildProcess,
      subagentsDir,
    });
    const { taskId } = manager.spawn({ task: "long final" });
    const finalText = "final assistant body\n".repeat(60);
    emitEnvelope(child, {
      status: "ok",
      summary: "short summary",
      result: finalText,
    });
    await flushTwoTicks();

    const env = await manager.waitFor(taskId);
    const pad = workerFenceTmpPath(subagentsDir, taskId);
    assert.equal(env.output_path, FINAL_TEXT_PAD_NAME);

    // 读侧走真实 inspectWorkerPad（subagent_result(tmp_path) 的同一实现）。
    const read = inspectWorkerPad(pad, env.output_path);
    assert.equal(read.status, "read");
    assert.ok(read.status === "read");
    // pad 读带 6 位行号前缀 + 200 行窗口；用窗口内首行认证逐字节一致。
    assert.match(read.content, /^\s*1\tfinal assistant body$/m);
    assert.equal(read.truncated, false);
    assert.ok(read.content.length > "short summary".length);
    await manager.shutdown();
  });

  it("truncated:true stays status ok with no reason, and the pad file is readable", async () => {
    const child = makeFakeChild();
    const manager = createSubAgentManager({
      spawn: () => child as unknown as ChildProcess,
      subagentsDir,
    });
    const { taskId } = manager.spawn({ task: "wire folded" });
    const longResult = "x".repeat(20_001);
    emitEnvelope(child, {
      status: "ok",
      summary: "folded handoff",
      result: longResult,
    });
    await flushTwoTicks();

    const env = await manager.waitFor(taskId);
    assert.equal(env.truncated, true);
    assert.equal(env.status, "ok");
    assert.equal("reason" in env, false);
    assert.equal(env.output_path, FINAL_TEXT_PAD_NAME);

    const pad = workerFenceTmpPath(subagentsDir, taskId);
    // 截断口径同既有 pad 读：文件里是 host 手里那一份 —— worker 已在 wire 上
    // 折叠（>20000 字），host 不试图恢复更长原文，落稿即折叠后的正文。
    const onDisk = readFileSync(join(pad, FINAL_TEXT_PAD_NAME), "utf8");
    assert.ok(onDisk.includes("report folded"));
    assert.ok(onDisk.length <= 20_000);
    assert.equal(statSync(join(pad, FINAL_TEXT_PAD_NAME)).size, onDisk.length);

    const read = inspectWorkerPad(pad, env.output_path!);
    assert.equal(read.status, "read");
    assert.ok(read.status === "read");
    assert.ok(read.content.includes("report folded"));
    await manager.shutdown();
  });

  it("failure with empty result writes no file and omits output_path", async () => {
    const child = makeFakeChild();
    const manager = createSubAgentManager({
      spawn: () => child as unknown as ChildProcess,
      subagentsDir,
    });
    const { taskId } = manager.spawn({ task: "crash" });
    child.stderr.end();
    child.emit("exit", 1, null);
    await flushTwoTicks();

    const env = await manager.waitFor(taskId);
    assert.equal(env.status, "failed");
    assert.equal(env.reason, "crashed");
    assert.equal(env.output_path, undefined);
    assert.equal("output_path" in env, false);

    const pad = workerFenceTmpPath(subagentsDir, taskId);
    assert.equal(existsSync(join(pad, FINAL_TEXT_PAD_NAME)), false);
    const names = existsSync(pad) ? readdirSync(pad) : [];
    assert.ok(
      !names.includes(FINAL_TEXT_PAD_NAME),
      `no fabricated pad file, got ${names.join(",")}`
    );
    await manager.shutdown();
  });

  it("timeout fallback (whitespace-only result) fabricates no empty file", async () => {
    vi.useFakeTimers();
    try {
      const child = makeFakeChild();
      const manager = createSubAgentManager({
        spawn: () => child as unknown as ChildProcess,
        subagentsDir,
      });
      const { taskId } = manager.spawn({ task: "slow", timeoutMs: 50 });
      await vi.advanceTimersByTimeAsync(50);
      const env = await manager.waitFor(taskId);
      assert.equal(env.status, "failed");
      assert.equal(env.reason, "timeout");
      assert.equal("output_path" in env, false);

      const pad = workerFenceTmpPath(subagentsDir, taskId);
      assert.equal(existsSync(join(pad, FINAL_TEXT_PAD_NAME)), false);
      await manager.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });

  it("pad write failure degrades to no output_path without failing the task", async () => {
    const child = makeFakeChild();
    const manager = createSubAgentManager({
      spawn: () => child as unknown as ChildProcess,
      subagentsDir,
    });
    const { taskId } = manager.spawn({ task: "unwritable pad" });
    // 目标文件名被一个**目录**占住 → writeFileSync EISDIR。locateEnvelope
    // 必须吞掉它：信封照常产出、无 output_path、任务状态不变。
    const pad = workerFenceTmpPath(subagentsDir, taskId);
    mkdirSync(join(pad, FINAL_TEXT_PAD_NAME), { recursive: true });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      emitEnvelope(child, { status: "ok", summary: "done", result: "body" });
      await flushTwoTicks();

      const env = await manager.waitFor(taskId);
      assert.equal(env.status, "ok");
      assert.equal(env.summary, "done");
      assert.equal("output_path" in env, false);
      assert.equal(env.task_id, taskId);
      // 真实故障被点名（warn-once 通道），不是静默伪造路径。
      assert.ok(
        warn.mock.calls.some((call) =>
          String(call[0]).includes("final text pad write skipped")
        ),
        `expected a warn trail, got ${JSON.stringify(warn.mock.calls)}`
      );
    } finally {
      warn.mockRestore();
    }
    await manager.shutdown();
  });

  it("round-trips through the model-facing subagent_result reader", async () => {
    const child = makeFakeChild();
    const manager = createSubAgentManager({
      spawn: () => child as unknown as ChildProcess,
      subagentsDir,
    });
    const { taskId } = manager.spawn({ task: "round trip" });
    const finalText = "round-trip final body";
    emitEnvelope(child, {
      status: "ok",
      summary: "short",
      result: finalText,
    });
    await flushTwoTicks();

    const tool = createSubAgentResultTool({ manager });
    const poll = JSON.parse(String(tool.handler({ task_id: taskId }))) as {
      output_path?: string;
    };
    assert.equal(poll.output_path, FINAL_TEXT_PAD_NAME);

    const readBack = JSON.parse(
      String(tool.handler({ task_id: taskId, tmp_path: poll.output_path }))
    ) as { status: string; content?: string };
    assert.equal(readBack.status, "ok");
    assert.match(readBack.content ?? "", /round-trip final body/);
    await manager.shutdown();
  });

  it("terminal notice carries output_path so a drained/woken envelope can read it", async () => {
    const child = makeFakeChild();
    const manager = createSubAgentManager({
      spawn: () => child as unknown as ChildProcess,
      subagentsDir,
    });
    const notices: { taskId: string; output_path?: string }[] = [];
    manager.subscribe((notice) => {
      notices.push({
        taskId: notice.taskId,
        ...(notice.output_path !== undefined
          ? { output_path: notice.output_path }
          : {}),
      });
    });
    const { taskId } = manager.spawn({ task: "wake me" });
    emitEnvelope(child, {
      status: "ok",
      summary: "short",
      result: "woken final body",
    });
    await flushTwoTicks();

    assert.deepEqual(notices, [{ taskId, output_path: FINAL_TEXT_PAD_NAME }]);
    const drained = manager.drainCompleted();
    assert.equal(drained[0]!.envelope.output_path, FINAL_TEXT_PAD_NAME);
    assert.equal(
      existsSync(
        join(
          workerFenceTmpPath(subagentsDir, taskId),
          drained[0]!.envelope.output_path!
        )
      ),
      true
    );
    await manager.shutdown();
  });
});
