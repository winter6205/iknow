import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionHub } from "../../src/session-api/hub.ts";
import { SessionStore } from "../../src/session-api/store/index.ts";
import type { SubAgentManager } from "../../src/harness/subagent/manager.ts";
import type { SubagentInfo } from "../../src/harness/subagent/manager.ts";
import { createSubAgentMailbox } from "../../src/harness/subagent/mailbox.ts";
import { assistantResult, makeDeps } from "../cli/_fixtures.ts";

/**
 * plans/session-fg-handoff-interrupt Locked sentence 3 / T5 ——
 * `SessionHub.abortSessionForegroundWork` 的扇出语义（SSOT 层）。
 *
 * 命题（每条对应票面验收的一个面）：
 *   - 只扇 `conversationId` 本会话的行（其它会话的前景 worker 不动）；
 *   - 只扇 `foreground === true` 的行（`wait:false` 后景不动 —— 该标志是
 *     「父侧 in-band 等待」population，Postel：false / 缺席一律不杀）；
 *   - 只扇 live（starting | running）行，且返回值是**真正**被 abort 的
 *     taskId（abortTask 返回 false 的竞态终态不列入）；
 *   - 返回本会话 live 前景 taskId，供调用方归因。
 *
 * 为什么用真 SessionHub（而不是 fake）：hub 的 conversationId 解析 +
 * 无 manager 空数组语义是产品路径的一部分；manager fake 只保留本票不测的
 * 部分（spawn / waitFor）。真 manager 的 abortTask 行为归
 * tests/subagent/manager.test.ts。
 */

interface ManagerRig {
  readonly manager: SubAgentManager;
  readonly abortCalls: string[];
  setRows: (rows: ReadonlyArray<SubagentInfo>) => void;
}

function makeManagerRig(
  initialRows: ReadonlyArray<SubagentInfo>,
  abortResults: Record<string, boolean> = {}
): ManagerRig {
  let rows = initialRows;
  const abortCalls: string[] = [];
  const mailbox = createSubAgentMailbox();
  const manager: SubAgentManager = {
    spawn: () => ({ taskId: "unused" }),
    queryBuffer: () => ({ status: "not_found" }),
    waitFor: async () => {
      throw new Error("unused");
    },
    shutdown: async () => {},
    drainCompleted: () => [],
    listActive: () => [],
    abortTask: (taskId) => {
      abortCalls.push(taskId);
      return abortResults[taskId] ?? true;
    },
    getCapacity: () => 15,
    listSubagents: (conversationId?: string) =>
      conversationId === undefined
        ? rows
        : rows.filter((row) => row.conversationId === conversationId),
    subscribe: mailbox.subscribe,
  };
  return {
    manager,
    abortCalls,
    setRows: (next) => {
      rows = next;
    },
  };
}

function info(
  taskId: string,
  overrides: Partial<SubagentInfo> & Pick<SubagentInfo, "state">
): SubagentInfo {
  return {
    taskId,
    taskPreview: taskId,
    startedAt: "2026-09-17T00:00:00.000Z",
    ...overrides,
  };
}

const FORE_RUNNING = (taskId: string, conversationId: string): SubagentInfo =>
  info(taskId, { state: "running", conversationId, foreground: true });

async function makeHub(
  managerRig: ManagerRig
): Promise<{ readonly hub: SessionHub; readonly baseDir: string }> {
  const baseDir = await mkdtemp(join(tmpdir(), "iknow-fg-fanout-"));
  const store = new SessionStore(baseDir, process.cwd());
  const hub = new SessionHub({
    store,
    deps: makeDeps([assistantResult({ texts: ["ok"] })]),
    subagentManager: managerRig.manager,
    surface: "serve",
    injectedEngineRoot: baseDir,
  });
  await hub.bindWorkspace(baseDir);
  return { hub, baseDir };
}

describe("abortSessionForegroundWork — 本会话前景扇出", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(
      dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
    );
  });

  it("running-fg 父 + 本会话两个 live 前景子代理 → 两个都被 abort，返回其 taskId", async () => {
    const rig = makeManagerRig([
      FORE_RUNNING("t1", "conv-a"),
      FORE_RUNNING("t2", "conv-a"),
    ]);
    const { hub, baseDir } = await makeHub(rig);
    dirs.push(baseDir);

    expect(hub.abortSessionForegroundWork("conv-a")).toEqual(["t1", "t2"]);
    expect(rig.abortCalls).toEqual(["t1", "t2"]);
  });

  it("父 idle 但仍有本会话 live 前景子代理 → 同样停（返回值非空）", async () => {
    const rig = makeManagerRig([FORE_RUNNING("late", "conv-a")]);
    const { hub, baseDir } = await makeHub(rig);
    dirs.push(baseDir);

    // hub 层不看父 turn 的 runState（那是 app 的字段）；这里钉的是
    // 「无父 aborter 在场时扇出仍然工作」的下半段契约。
    expect(hub.abortSessionForegroundWork("conv-a")).toEqual(["late"]);
    expect(rig.abortCalls).toEqual(["late"]);
  });

  it("后景 wait:false（foreground 缺席）同会话 → 不 abort", async () => {
    const rig = makeManagerRig([
      info("bg", { state: "running", conversationId: "conv-a" }),
      info("fg", {
        state: "running",
        conversationId: "conv-a",
        foreground: true,
      }),
    ]);
    const { hub, baseDir } = await makeHub(rig);
    dirs.push(baseDir);

    expect(hub.abortSessionForegroundWork("conv-a")).toEqual(["fg"]);
    expect(rig.abortCalls).toEqual(["fg"]);
  });

  it("其它会话的 live 前景 worker → 不 abort（running-bg 不是本会话前台）", async () => {
    const rig = makeManagerRig([FORE_RUNNING("other", "conv-b")]);
    const { hub, baseDir } = await makeHub(rig);
    dirs.push(baseDir);

    expect(hub.abortSessionForegroundWork("conv-a")).toEqual([]);
    expect(rig.abortCalls).toEqual([]);
  });

  it("终态前景行不重复 abort；abortTask 回 false 的竞态行不进返回值", async () => {
    const rig = makeManagerRig(
      [
        info("done", {
          state: "completed",
          conversationId: "conv-a",
          foreground: true,
          endedAt: "2026-09-17T00:00:01.000Z",
        }),
        info("race", {
          state: "running",
          conversationId: "conv-a",
          foreground: true,
        }),
      ],
      { race: false }
    );
    const { hub, baseDir } = await makeHub(rig);
    dirs.push(baseDir);

    expect(hub.abortSessionForegroundWork("conv-a")).toEqual([]);
    expect(rig.abortCalls).toEqual(["race"]);
  });

  it("judge / graph-node 同 population（role 在场）→ 同一扇出命中，无 role carve-out", async () => {
    // 票面明示：扇出选中**全部** foreground 行，judge / graph-node 不豁免。
    // 它们的 def 与 wait:true 的 spawn_subagent 同走 excludeFromHostDrain
    // （manager.ts 的 foreground 注释），故此处以 role 在场但 conversationId
    // 在场的行钉「选目标只看 foreground，不看 role」。
    //
    // 结构性边界（不在本方法内可修）：生产里 judge
    // (run-classifier-adapter.ts) 与 graph-node (graph/node-executor.ts) 的
    // def **不填 conversationId**，因此会话作用域的 listSubagents(id) 看不见
    // 它们 —— 那不是 role carve-out，而是上游缺 conversationId 传播。修它要
    // 动 harness/graph + harness/verify（本票 ownership 之外）。
    const rig = makeManagerRig([
      info("judge", {
        state: "running",
        conversationId: "conv-a",
        foreground: true,
        role: "judge",
      }),
      info("node", {
        state: "running",
        conversationId: "conv-a",
        foreground: true,
        role: "general-purpose",
      }),
    ]);
    const { hub, baseDir } = await makeHub(rig);
    dirs.push(baseDir);

    expect(hub.abortSessionForegroundWork("conv-a")).toEqual(["judge", "node"]);
    expect(rig.abortCalls).toEqual(["judge", "node"]);
  });

  it("无 manager（ask 形态）→ 空数组，不抛错", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "iknow-fg-fanout-none-"));
    dirs.push(baseDir);
    const store = new SessionStore(baseDir, process.cwd());
    const hub = new SessionHub({
      store,
      deps: makeDeps([assistantResult({ texts: ["ok"] })]),
      surface: "ask",
    });

    expect(hub.abortSessionForegroundWork("conv-a")).toEqual([]);
  });
});
