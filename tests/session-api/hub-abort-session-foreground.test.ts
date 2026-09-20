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
 * `SessionHub.abortSessionForegroundWork` fan-out semantics (SSOT layer).
 *
 * Propositions:
 *   - Only rows of `conversationId`'s own conversation are fanned out
 *     (foreground workers of other conversations stay untouched);
 *   - Only `foreground === true` rows are fanned out (`wait:false`
 *     background stays untouched — the flag marks the "parent-side in-band
 *     wait" population; Postel: false / absent are never killed);
 *   - Only live (starting | running) rows are fanned out, and the return
 *     value is the **actually** aborted taskIds (race-terminal rows where
 *     abortTask returned false are excluded);
 *   - Returns this conversation's live foreground taskIds for caller
 *     attribution.
 *
 * Why a real SessionHub (not a fake): hub's conversationId resolution plus
 * the no-manager empty-array semantics are part of the product path; the
 * manager fake only covers what this layer does not test (spawn /
 * waitFor). Real manager abortTask behavior belongs to
 * tests/subagent/manager.test.ts.
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

    // The hub layer does not inspect the parent turn's runState (that is an
    // app field); this pins the lower half of the contract: fan-out still
    // works with no parent aborter present.
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
    // The fan-out selects **all** foreground rows; judge / graph-node are
    // not exempt. Their defs share excludeFromHostDrain with wait:true
    // spawn_subagent (see manager.ts's foreground comment), so rows here
    // carry role + conversationId to pin "target selection looks only at
    // foreground, never at role".
    //
    // Structural boundary (not fixable inside this method): in production,
    // judge (run-classifier-adapter.ts) and graph-node (graph/
    // node-executor.ts) defs do NOT fill conversationId, so
    // conversation-scoped listSubagents(id) cannot see them — that is not a
    // role carve-out but missing upstream conversationId propagation.
    // Fixing it would touch harness/graph + harness/verify, outside this
    // test's ownership.
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
