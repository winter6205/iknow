/**
 * T5 (ADR-0071 Decision 1 +
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
 *   4. 新 worker stderr 落在 `subagents/<taskId>/stderr.log`
 *      （旧 `subagents/stderr/<taskId>.log` 不迁）。
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
import {
  listSubagentRecordPaths,
  workerMetaPath,
  workerRecordPath,
  workerStderrPath,
} from "../../src/harness/sandbox/fence-tmp.ts";

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
  readonly subagentsDir?: string | undefined;
  /** review-fix (M5):hub 形态装配件 —— 仅传 projectDir,manager 内派生
   *  per-conversation 叶子。与 subagentsDir 互斥共用。 */
  readonly projectDir?: string | undefined;
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
    ...(opts.projectDir !== undefined ? { projectDir: opts.projectDir } : {}),
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
      const filePath = workerRecordPath(subagentsDir, id);
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
    const files = listSubagentRecordPaths(subagentsDir).map((p) => {
      const nestedId = p.split("/").at(-2);
      return nestedId ?? p;
    });
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

    const filePath = workerRecordPath(subagentsDir, taskId);
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

    const metaPath = workerMetaPath(subagentsDir, taskId);
    assert.ok(existsSync(metaPath), `expected ${metaPath}`);
    const meta = JSON.parse(readFileSync(metaPath, "utf8")) as Record<
      string,
      unknown
    >;
    assert.equal(meta.agentType, "explore");
  });

  it("meta 含 toolUseId 时落盘, 缺席时省略; spawnDepth 显式值落盘 (Postel + M6 显式优先)", async () => {
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
      readFileSync(workerMetaPath(subagentsDir, withId.taskId), "utf8")
    ) as Record<string, unknown>;
    assert.equal(metaWith.toolUseId, "tool_use_abc");
    assert.equal(metaWith.spawnDepth, 2);

    const metaWithout = JSON.parse(
      readFileSync(workerMetaPath(subagentsDir, noId.taskId), "utf8")
    ) as Record<string, unknown>;
    assert.equal(
      "toolUseId" in metaWithout,
      false,
      "toolUseId must be omitted"
    );
    // review-fix (M6): spawnDepth 不再缺席 —— v1 禁嵌套,普通 spawn 恒为 1
    // (见下方 M6 describe 的专用断言)。
  });

  it("stderr.log 落在 subagents/<taskId>/, 跟随 subagentsDir", async () => {
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

    const stderrPath = workerStderrPath(subagentsDir, taskId);
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

    const metaPath = workerMetaPath(subagentsDir, taskId);
    const meta = JSON.parse(readFileSync(metaPath, "utf8")) as Record<
      string,
      unknown
    >;
    assert.equal(meta.toolUseId, "toolu_wire_id_abc");
    assert.equal(meta.agentType, "general-purpose");
  });
});

describe("review-fix M5 — def.conversationId 派生 per-conversation 子目录 (两段式缝)", () => {
  /**
   * hub serve 路径装配期(单 engine 跨会话共享)只给装配期根 projectDir
   * (`<baseDir>/projects/<slug>`);spawn 期 def.conversationId 在场时,
   * manager 把落点移到 per-conversation 叶子
   * `<projectDir>/<convId>/subagents/`,与 SessionStore.delete(整删
   * `<convId>/` 会话文件夹)的寿命边界一致 —— 会话删除时子代理记录同灭,
   * 不在项目层留孤儿。与 todo-write 的 resolveConversationTodoPath 同构。
   */
  it("def.conversationId 在场 → 记录落 <projectDir>/<convId>/subagents/, 项目层平铺不落盘", async () => {
    const { manager, spawned } = makeManager({ projectDir: projectSlugDir });
    const convId = "conv-abc-123";
    const { taskId } = manager.spawn({
      task: "scoped",
      conversationId: convId,
    });
    emitOk(spawned[0]!, "r");
    await flushTwoTicks();
    await manager.shutdown();

    // per-conversation 叶子
    const convSubagentsDir = join(projectSlugDir, convId, "subagents");
    assert.ok(
      existsSync(workerRecordPath(convSubagentsDir, taskId)),
      `expected lifecycle trace under per-conversation leaf ${convSubagentsDir}`
    );
    assert.ok(
      existsSync(workerMetaPath(convSubagentsDir, taskId)),
      `expected meta under per-conversation leaf ${convSubagentsDir}`
    );
    // 项目层平铺(无 convId)不产生任何文件 —— 项目层无孤儿
    const flatDir = join(projectSlugDir, "subagents");
    const flatEntries = existsSync(flatDir) ? readdirSync(flatDir) : [];
    assert.deepEqual(
      flatEntries,
      [],
      `项目层平铺 ${flatDir} 必须保持空 (无孤儿), got ${flatEntries.join(",")}`
    );
    // 且 per-conv 叶子目录不含 "agent-" 之外的错层(双层 subagents 防御)。
    assert.equal(
      existsSync(join(convSubagentsDir, "subagents")),
      false,
      "不得嵌出双层 subagents"
    );
  });

  it("projectDir 装配 + def.conversationId 缺席 → 退回项目层平铺 <projectDir>/subagents/", async () => {
    const { manager, spawned } = makeManager({ projectDir: projectSlugDir });
    const { taskId } = manager.spawn({ task: "legacy-flat" });
    emitOk(spawned[0]!, "r");
    await flushTwoTicks();
    await manager.shutdown();
    const flatDir = join(projectSlugDir, "subagents");
    assert.ok(
      existsSync(workerRecordPath(flatDir, taskId)),
      "无 conversationId 时退回项目层平铺"
    );
  });

  it("subagentsDir 装配(两段式缝的 cli/TUI 形态)→ def.conversationId 不再嵌第二层 convId", async () => {
    // 装配件已含 convId 段时,spawn 期 def.conversationId 在场也直接用
    // 装配件 —— 防止嵌出 `.../subagents/<convId>/subagents/` 错形。
    const { manager, spawned } = makeManager({ subagentsDir });
    const { taskId } = manager.spawn({
      task: "cli-form",
      conversationId: "conv-abc-123",
    });
    emitOk(spawned[0]!, "r");
    await flushTwoTicks();
    await manager.shutdown();
    assert.ok(
      existsSync(workerRecordPath(subagentsDir, taskId)),
      "subagentsDir 装配形态优先,直接落装配件"
    );
    assert.equal(
      existsSync(join(subagentsDir, "conv-abc-123")),
      false,
      "不得在装配件下嵌 convId 第二层"
    );
  });

  it("def.conversationId 缺席 → 退回装配期根平铺 (legacy manager 直造 byte-stable)", async () => {
    const { manager, spawned } = makeManager({ subagentsDir });
    const { taskId } = manager.spawn({ task: "legacy" });
    emitOk(spawned[0]!, "r");
    await flushTwoTicks();
    await manager.shutdown();
    assert.ok(
      existsSync(workerRecordPath(subagentsDir, taskId)),
      "无 conversationId 时退回装配期根"
    );
  });

  it("普通 spawn 的 .meta.json 至少含 agentType + spawnDepth (M6: v1 禁嵌套恒为 1)", async () => {
    const { manager, spawned } = makeManager({ subagentsDir });
    const { taskId } = manager.spawn({ task: "t", role: "explore" });
    emitOk(spawned[0]!, "r");
    await flushTwoTicks();
    await manager.shutdown();
    const meta = JSON.parse(
      readFileSync(workerMetaPath(subagentsDir, taskId), "utf8")
    ) as Record<string, unknown>;
    assert.equal(meta.agentType, "explore");
    // v1 禁嵌套 → manager 侧 spawnDepth 恒写 1 (seam 留给将来嵌套派发)。
    assert.equal(
      meta.spawnDepth,
      1,
      "普通 spawn 的 meta.spawnDepth 必须恒为 1 (v1 禁嵌套)"
    );
    // 显式 def.spawnDepth 优先 (嵌套派发将来解开时从深层 manager 透传)。
  });

  it("def.spawnDepth 显式值覆盖 v1 常量 (嵌套 seam 保留)", async () => {
    const { manager, spawned } = makeManager({ subagentsDir });
    const { taskId } = manager.spawn({ task: "t", spawnDepth: 3 });
    emitOk(spawned[0]!, "r");
    await flushTwoTicks();
    await manager.shutdown();
    const meta = JSON.parse(
      readFileSync(workerMetaPath(subagentsDir, taskId), "utf8")
    ) as Record<string, unknown>;
    assert.equal(meta.spawnDepth, 3);
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
    const listed = listSubagentRecordPaths(subagentsDir);
    assert.ok(
      listed.length >= 1,
      `expected nested agent-*.jsonl under ${subagentsDir}, got ${listed.join(",")}`
    );
  });
});
