/**
 * T5 (plans/session-folder-consolidation.md / ADR-0071 Decision 1 +
 * ADR-0035 同日 Amendment) — 子代理记录嵌套进父会话文件夹。
 *
 * SC8 + L2 + 操作员补丁:每个子代理的 lifecycle / content trace 都落
 * `<父会话文件夹>/subagents/agent-<taskId>.jsonl`,配 `.meta.json`,
 * meta 至少含 `{agentType, toolUseId, spawnDepth}`。
 *
 * Acceptance (本文件):
 *   1. 并发两个子代理 → subagents/ 下两个文件,文件名集合 == 两次 spawn
 *      返回的 taskId 集合(绝无随机 UUID 聚合单文件,绝无 conversationId:"subagent"
 *      字面聚合单文件)。
 *   2. 每个文件含 lifecycle 三类记录 (subagent_spawn / subagent_state_change /
 *      subagent_stop) 且第一行的 `subagent_id` == taskId。
 *   3. 每个文件旁有 `.meta.json`,至少含 `agentType`;toolUseId / spawnDepth
 *      缺席时按 Postel 省略对应键。
 *   4. subagents/ 下的 stderr/ 子目录承载 per-task stderr pointer
 *      (ADR-0035 同日 Amendment)。
 *   5. `agent-*` 不直接出现在项目根(项目身份层级 = `<baseDir>/projects/<slug>`
 *      顶层不能有 agent-* 目录;spec SC8 acceptance 写法)。
 */

import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, it, vi } from "vitest";

import { createSubAgentManager } from "../../src/harness/subagent/manager.ts";
import type { SubAgentManager } from "../../src/harness/subagent/manager.ts";
import type { SubAgentEnvelope } from "../../src/harness/subagent/envelope.ts";

interface FakeChild {
  readonly stdin: PassThrough;
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
  readonly kill: ReturnType<typeof vi.fn>;
  readonly exitCode: number | null;
  readonly signalCode: Nodejs.Signals | null;
  readonly pid: number;
  emit: (event: string | symbol, ...args: unknown[]) => boolean;
}

// stub process exit is sufficient — signals via node:os 等价。
type NodejsSignals = NodeJS.Signals;

function makeFakeChild(): FakeChild {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  return Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr,
    kill: vi.fn(() => true),
    exitCode: null as number | null,
    signalCode: null as NodejsSignals | null,
    pid: 1000,
  }) as unknown as FakeChild;
}

function emitOk(child: FakeChild, body: string): void {
  const env: SubAgentEnvelope = {
    status: "ok",
    summary: body,
    result: body,
  };
  child.stdout.write(JSON.stringify(env) + "\n");
  child.emit("exit", 0, null);
}

function flushTwoTicks(): Promise<void> {
  return new Promise((r) => setImmediate(r)).then(
    () => new Promise((r) => setImmediate(r))
  );
}

let tempRoot: string;
let subagentsDir: string;
let projectDir: string;
let projectSlugDir: string;

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "iknow-per-agent-"));
  // 模拟父会话文件夹 = <baseDir>/projects/<slug>/<conversationId>
  projectSlugDir = join(tempRoot, "projects", "demo-slug");
  projectDir = join(projectSlugDir, "conv-123");
  subagentsDir = join(projectDir, "subagents");
  // mkdir 父文件夹 —— manager 写盘只建 subagents/, 父文件夹需先存在
  mkdirSync(projectDir, { recursive: true });
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

function makeManager(opts: {
  readonly subagentsDir: string | undefined;
  readonly sandboxRoot?: string;
}): {
  readonly manager: SubAgentManager;
  readonly spawned: FakeChild[];
} {
  const spawned: FakeChild[] = [];
  const manager = createSubAgentManager({
    spawn: () => {
      const c = makeFakeChild();
      spawned.push(c);
      return c as unknown as ChildProcess;
    },
    sandboxRoot: opts.sandboxRoot ?? tempRoot,
    ...(opts.subagentsDir !== undefined
      ? { subagentsDir: opts.subagentsDir }
      : {}),
  });
  return { manager, spawned };
}

describe("T5 per-agent trace layout (SC8 / L2 / operator patch)", () => {
  it("concurrent spawn × 2 → subagents/ 下两个文件, 文件名集合 == 两次 spawn 返回的 taskId 集合, 绝无随机 UUID 字面", async () => {
    const { manager, spawned } = makeManager({ subagentsDir });

    const first = manager.spawn({ task: "first task", role: "explore" });
    const second = manager.spawn({ task: "second task" });
    emitOk(spawned[0]!, "first-body");
    emitOk(spawned[1]!, "second-body");
    await flushTwoTicks();

    const taskIds = [first.taskId, second.taskId];
    for (const id of taskIds) {
      const filePath = join(subagentsDir, `agent-${id}.jsonl`);
      assert.ok(existsSync(filePath), `expected ${filePath} on disk`);
      // 绝无 "subagent" 字面感(已退役的 conversationId 假 scope)。
      assert.notEqual(id, "subagent");
      // taskId 形如 uuid;worker content trace 之前用 randomUUID() 是因为
      // L2 假 scope 不存在 — 现在每 task 自带独立 uuid 文件名。
      assert.match(
        id,
        /^[0-9a-f-]{36}$/i,
        `taskId should look like uuid, got ${id}`
      );
    }
    assert.notEqual(first.taskId, second.taskId, "并发两个子代理必须不同 id");

    await manager.shutdown();

    // 文件名集合 == taskId 集合(操作员补丁断言)
    const files = readdirSync(subagentsDir)
      .filter((f) => f.startsWith("agent-") && f.endsWith(".jsonl"))
      .map((f) => f.replace(/^agent-/, "").replace(/\.jsonl$/, ""));
    assert.deepEqual(
      new Set(files),
      new Set(taskIds),
      `on-disk agent-* taskIds ${files.join(",")} != spawn returns ${taskIds.join(",")}`
    );
  });

  it("每个文件含 lifecycle 三类记录, 第一行 subagent_id == taskId", async () => {
    const { manager, spawned } = makeManager({ subagentsDir });
    const { taskId } = manager.spawn({ task: "single" });
    emitOk(spawned[0]!, "r");
    await flushTwoTicks();
    await manager.shutdown();

    const filePath = join(subagentsDir, `agent-${taskId}.jsonl`);
    const lines = readFileSync(filePath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const types = lines.map((l) => l.record_type as string);
    assert.ok(types.includes("subagent_spawn"), types.join(","));
    assert.ok(types.includes("subagent_state_change"), types.join(","));
    assert.ok(types.includes("subagent_stop"), types.join(","));
    // 第一行的 subagent_id == taskId
    assert.equal(lines[0]?.subagent_id, taskId);
    // spawn 行的 task_id 也 == taskId (单点 single-emit 守门)
    const spawnRow = lines.find((l) => l.record_type === "subagent_spawn");
    assert.equal(spawnRow?.task_id, taskId);
  });

  it("每个 spawn 写一次 .meta.json, 至少含 agentType (role=explore)", async () => {
    const { manager, spawned } = makeManager({ subagentsDir });
    const { taskId } = manager.spawn({ task: "t", role: "explore" });
    emitOk(spawned[0]!, "r");
    await flushTwoTicks();
    await manager.shutdown();

    const metaPath = join(subagentsDir, `agent-${taskId}.meta.json`);
    assert.ok(existsSync(metaPath), `expected ${metaPath}`);
    const meta = JSON.parse(readFileSync(metaPath, "utf8")) as Record<
      string,
      unknown
    >;
    assert.equal(meta.agentType, "explore");
  });

  it("meta 含 toolUseId / spawnDepth 时落盘, 缺席时省略(Postel)", async () => {
    const { manager, spawned } = makeManager({ subagentsDir });
    const withId = manager.spawn({
      task: "t1",
      toolUseId: "tool_use_abc",
      spawnDepth: 2,
    });
    const noId = manager.spawn({ task: "t2" });
    emitOk(spawned[0]!, "r");
    emitOk(spawned[1]!, "r");
    await flushTwoTicks();
    await manager.shutdown();

    const metaWith = JSON.parse(
      readFileSync(
        join(subagentsDir, `agent-${withId.taskId}.meta.json`),
        "utf8"
      )
    ) as Record<string, unknown>;
    assert.equal(metaWith.toolUseId, "tool_use_abc");
    assert.equal(metaWith.spawnDepth, 2);

    const metaWithout = JSON.parse(
      readFileSync(join(subagentsDir, `agent-${noId.taskId}.meta.json`), "utf8")
    ) as Record<string, unknown>;
    assert.equal(
      "toolUseId" in metaWithout,
      false,
      "toolUseId must be omitted"
    );
    assert.equal(
      "spawnDepth" in metaWithout,
      false,
      "spawnDepth must be omitted"
    );
  });

  it("stderr/ 子目录承载 per-task stderr pointer, 跟随 subagentsDir", async () => {
    const { manager, spawned } = makeManager({ subagentsDir });
    const { taskId } = manager.spawn({ task: "crash" });
    // crashed exit + stderr burst → manager emitStop 写入 stderr pointer。
    // PassThrough stderr 必须 end() 才能触发 close —— 否则 manager 内
    // waitForStderrClose 永不 resolve,settleCrash await 阻塞,test 超时。
    spawned[0]!.stderr.write("crash details\n");
    spawned[0]!.stderr.end();
    spawned[0]!.emit("exit", 2, null);
    await flushTwoTicks();
    await manager.shutdown();

    const stderrPath = join(subagentsDir, "stderr", `${taskId}.log`);
    assert.ok(
      existsSync(stderrPath),
      `expected stderr pointer at ${stderrPath}`
    );
    assert.match(readFileSync(stderrPath, "utf8"), /crash details/);
  });

  it("manager.subagentsDir 缺席 → 不写盘(现有 NoopTrace 路径保持 byte-stable)", async () => {
    const { manager, spawned } = makeManager({ subagentsDir: undefined });
    const { taskId } = manager.spawn({ task: "noop" });
    emitOk(spawned[0]!, "r");
    await flushTwoTicks();
    // 没 subagentsDir 就不该建出 subagents 目录
    assert.equal(
      existsSync(subagentsDir),
      false,
      `subagentsDir 缺席时不该建 ${subagentsDir}`
    );
    // 仍然能 queryBuffer(queryBuffer 不依赖落盘)
    assert.equal(manager.queryBuffer(taskId).status, "ok");
    await manager.shutdown();
  });

  it("两次并发 spawn 文件名去重(同名 taskId 不会写同一文件)", async () => {
    const { manager, spawned } = makeManager({ subagentsDir });
    const a = manager.spawn({ task: "a" });
    const b = manager.spawn({ task: "b" });
    // 防 taskId 同:manager.randomUUID 保证
    assert.notEqual(a.taskId, b.taskId);
    emitOk(spawned[0]!, "r");
    emitOk(spawned[1]!, "r");
    await flushTwoTicks();
    await manager.shutdown();
  });

  it("def.toolUseId → manager 写盘 .meta.json 的 toolUseId 字段", async () => {
    // 直接传 def.toolUseId 模拟 executor 把 ctx.toolUseId(= call.id)
    // 装配到 def literal 后的 wire 形态。spawn-subagent-tool handler 已经
    // 把 ctx.toolUseId 透传到 def(见 src/harness/subagent/spawn-subagent-
    // tool.ts 的 ...(ctx?.toolUseId !== undefined ? { toolUseId: ... } : {}));
    // manager.writeMetaOnce 消费 def.toolUseId 落盘一次。
    const { manager, spawned } = makeManager({ subagentsDir });
    const { taskId } = manager.spawn({
      task: "t",
      role: "general-purpose",
      toolUseId: "toolu_wire_id_abc",
    });
    emitOk(spawned[0]!, "r");
    await flushTwoTicks();
    await manager.shutdown();

    const metaPath = join(subagentsDir, `agent-${taskId}.meta.json`);
    const meta = JSON.parse(readFileSync(metaPath, "utf8")) as Record<
      string,
      unknown
    >;
    assert.equal(meta.toolUseId, "toolu_wire_id_abc");
    assert.equal(meta.agentType, "general-purpose");
  });
});

describe("T5 spec SC8 acceptance — 项目根顶层不存在 agent-* 目录", () => {
  it("归并后 `<baseDir>/projects/<slug>` 顶层不存在 `agent-*`", async () => {
    const { manager, spawned } = makeManager({ subagentsDir });
    manager.spawn({ task: "x" });
    emitOk(spawned[0]!, "r");
    await flushTwoTicks();
    await manager.shutdown();

    // 项目身份根 = `<baseDir>/projects/<slug>`(模拟 spec SC8 acceptance
    // 写法:归并后 `~/.iknow/projects/**/` 顶层不存在 `agent-*` 目录)。
    const entries = readdirSync(projectSlugDir);
    const agentDirs = entries.filter((e) => e.startsWith("agent-"));
    assert.deepEqual(
      agentDirs,
      [],
      `agent-* must not exist at ${projectSlugDir}`
    );
    // 子代理记录落 <convId>/subagents/ 下, 不在项目 slug 同级平铺
    const subEntries = existsSync(subagentsDir)
      ? readdirSync(subagentsDir)
      : [];
    assert.ok(
      subEntries.some((e) => e.startsWith("agent-") && e.endsWith(".jsonl")),
      `expected agent-*.jsonl in ${subagentsDir}, got ${subEntries.join(",")}`
    );
  });
});
