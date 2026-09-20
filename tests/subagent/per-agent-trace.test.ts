/**
 * ADR-0071 Decision 1 + ADR-0035 same-day amendment — sub-agent records nest
 * under the parent conversation folder.
 *
 * SC8 + L2 + operator patch: each sub-agent's lifecycle / content trace lands
 * at `<parent conversation dir>/subagents/agent-<taskId>.jsonl` with a
 * `.meta.json` containing at least `{agentType, toolUseId, spawnDepth}`.
 *
 * Acceptance (this file):
 *   1. two concurrent sub-agents → two files under subagents/; the filename
 *      set == the taskIds returned by the two spawns (never a random-UUID
 *      aggregate file, never a conversationId:"subagent" literal aggregate file).
 *   2. each file carries the three lifecycle record kinds (subagent_spawn /
 *      subagent_state_change / subagent_stop) and line 1's `subagent_id` == taskId.
 *   3. each file has a sibling `.meta.json` with at least `agentType`;
 *      toolUseId / spawnDepth keys omitted per Postel when absent.
 *   4. new worker stderr lands at `subagents/<taskId>/stderr.log`
 *      (legacy `subagents/stderr/<taskId>.log` is not migrated).
 *   5. `agent-*` never appears directly at the project root (the identity
 *      layer `<baseDir>/projects/<slug>` must not contain agent-* dirs; spec
 *      SC8 acceptance wording).
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

// stub process exit is sufficient — equivalent to real signals via node:os.
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
  // simulate the parent conversation dir = <baseDir>/projects/<slug>/<conversationId>
  projectSlugDir = join(tempRoot, "projects", "demo-slug");
  projectDir = join(projectSlugDir, "conv-123");
  subagentsDir = join(projectDir, "subagents");
  // mkdir the parent dir — the manager only creates subagents/ itself; the parent must pre-exist
  mkdirSync(projectDir, { recursive: true });
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

function makeManager(opts: {
  readonly subagentsDir?: string | undefined;
  /** hub-form assembly option — pass projectDir only and the manager derives
   *  the per-conversation leaf. Mutually exclusive with subagentsDir. */
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
      // never the "subagent" literal (the retired fake conversationId scope).
      assert.notEqual(id, "subagent");
      // taskId is a uuid; the worker content trace used randomUUID() back when
      // the L2 fake scope did not exist — now each task gets its own uuid file name.
      assert.match(
        id,
        /^[0-9a-f-]{36}$/i,
        `taskId should look like uuid, got ${id}`
      );
    }
    assert.notEqual(first.taskId, second.taskId, "并发两个子代理必须不同 id");

    await manager.shutdown();

    // filename set == taskId set (operator-patch assertion)
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
    // line 1's subagent_id == taskId
    assert.equal(lines[0]?.subagent_id, taskId);
    // the spawn row's task_id == taskId too (single-emit guard)
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
    // spawnDepth is never absent now — v1 forbids nesting, plain spawns always
    // record 1 (see the dedicated assertions in the M6 describe below).
  });

  it("stderr.log 落在 subagents/<taskId>/, 跟随 subagentsDir", async () => {
    const { manager, spawned } = makeManager({ subagentsDir });
    const { taskId } = manager.spawn({ task: "crash" });
    // crashed exit + stderr burst → manager emitStop writes the stderr pointer.
    // PassThrough stderr must be end()ed to fire close — otherwise
    // waitForStderrClose inside the manager never resolves, settleCrash's
    // await blocks, and the test times out.
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
    // without subagentsDir, no subagents dir should be created
    assert.equal(
      existsSync(subagentsDir),
      false,
      `subagentsDir 缺席时不该建 ${subagentsDir}`
    );
    // queryBuffer still works (it does not depend on disk persistence)
    assert.equal(manager.queryBuffer(taskId).status, "ok");
    await manager.shutdown();
  });

  it("两次并发 spawn 文件名去重(同名 taskId 不会写同一文件)", async () => {
    const { manager, spawned } = makeManager({ subagentsDir });
    const a = manager.spawn({ task: "a" });
    const b = manager.spawn({ task: "b" });
    // distinct taskIds are guaranteed by manager.randomUUID
    assert.notEqual(a.taskId, b.taskId);
    emitOk(spawned[0]!, "r");
    emitOk(spawned[1]!, "r");
    await flushTwoTicks();
    await manager.shutdown();
  });

  it("def.toolUseId → manager 写盘 .meta.json 的 toolUseId 字段", async () => {
    // Pass def.toolUseId directly to mimic the wire shape after the executor
    // assembles ctx.toolUseId (= call.id) into the def literal. The
    // spawn-subagent-tool handler already forwards ctx.toolUseId into def
    // (see src/harness/subagent/spawn-subagent-tool.ts's
    // ...(ctx?.toolUseId !== undefined ? { toolUseId: ... } : {}));
    // manager.writeMetaOnce consumes def.toolUseId and persists it once.
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
   * The hub serve path is assembled (one engine shared across sessions) with
   * only the assembly-time root projectDir (`<baseDir>/projects/<slug>`);
   * when def.conversationId is present at spawn time, the manager moves the
   * target to the per-conversation leaf `<projectDir>/<convId>/subagents/`,
   * matching SessionStore.delete's lifetime boundary (it deletes the whole
   * `<convId>/` conversation folder) — sub-agent records die with the
   * conversation, leaving no orphans at the project layer. Same shape as
   * todo-write's resolveConversationTodoPath.
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

    // per-conversation leaf
    const convSubagentsDir = join(projectSlugDir, convId, "subagents");
    assert.ok(
      existsSync(workerRecordPath(convSubagentsDir, taskId)),
      `expected lifecycle trace under per-conversation leaf ${convSubagentsDir}`
    );
    assert.ok(
      existsSync(workerMetaPath(convSubagentsDir, taskId)),
      `expected meta under per-conversation leaf ${convSubagentsDir}`
    );
    // the flat project-level dir (no convId) produces no files — no orphans at the project layer
    const flatDir = join(projectSlugDir, "subagents");
    const flatEntries = existsSync(flatDir) ? readdirSync(flatDir) : [];
    assert.deepEqual(
      flatEntries,
      [],
      `项目层平铺 ${flatDir} 必须保持空 (无孤儿), got ${flatEntries.join(",")}`
    );
    // and the per-conv leaf must not nest another misplaced layer (double-subagents defense).
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
    // when the assembled path already contains the convId segment, a present
    // def.conversationId must not nest another one — prevents the malformed
    // `.../subagents/<convId>/subagents/` shape.
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
    // v1 forbids nesting → the manager always writes spawnDepth 1 (seam kept for future nested dispatch).
    assert.equal(
      meta.spawnDepth,
      1,
      "普通 spawn 的 meta.spawnDepth 必须恒为 1 (v1 禁嵌套)"
    );
    // explicit def.spawnDepth wins (a deeper manager will pass it through once nested dispatch is enabled).
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

    // project identity root = `<baseDir>/projects/<slug>` (mirrors the spec
    // SC8 acceptance wording: no `agent-*` dirs at the top of the merged
    // `~/.iknow/projects/**/` layout).
    const entries = readdirSync(projectSlugDir);
    const agentDirs = entries.filter((e) => e.startsWith("agent-"));
    assert.deepEqual(
      agentDirs,
      [],
      `agent-* must not exist at ${projectSlugDir}`
    );
    // sub-agent records live under <convId>/subagents/, not flat beside the project slug
    const listed = listSubagentRecordPaths(subagentsDir);
    assert.ok(
      listed.length >= 1,
      `expected nested agent-*.jsonl under ${subagentsDir}, got ${listed.join(",")}`
    );
  });
});
