/**
 * F-4 parentTurnId 填实 — manager 侧写点。
 *
 * `SubAgentDefinition.parentTurnId` 是**父侧独占**字段：它告诉 manager「这个
 * 子代理是哪个 turn 派出去的」。三类生命周期 record（spawn / state_change /
 * stop）都带上它，`?parent_turn_id=` 才能一次捞出某回合派出的全部子代理。
 *
 * 锁三条：
 * 1. def 带 parentTurnId → 三类 record 全部落该值（含 spawn 工厂抛错的失败路径）；
 * 2. def 不带 → 三类 record 上该键缺席（Postel，不落 null / 空串）；
 * 3. parentTurnId **不进 WorkerEnvelope** —— 冻结的 wire 契约一个字节不动。
 */

import assert from "node:assert/strict";
import { describe, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";

import {
  createSubAgentManager,
  type SubAgentDefinition,
  type SubAgentManager,
} from "../../src/harness/subagent/manager.ts";
import type {
  SubAgentEnvelope,
  WorkerEnvelope,
} from "../../src/harness/subagent/envelope.ts";
import type {
  SubagentSpawnRecord,
  SubagentStateChangeRecord,
  SubagentStopRecord,
} from "../../src/harness/trace/types.ts";

interface FakeChild {
  readonly stdout: PassThrough;
  emit: (event: string | symbol, ...args: unknown[]) => boolean;
}

function makeFakeChild(): FakeChild {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: 4242,
    kill: vi.fn(() => true),
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
  }) as unknown as FakeChild;
}

interface Harness {
  readonly manager: SubAgentManager;
  readonly children: FakeChild[];
  readonly payloads: WorkerEnvelope[];
  readonly spawns: SubagentSpawnRecord[];
  readonly stateChanges: SubagentStateChangeRecord[];
  readonly stops: SubagentStopRecord[];
}

function makeHarness(opts: { readonly throwOnSpawn?: boolean } = {}): Harness {
  const children: FakeChild[] = [];
  const payloads: WorkerEnvelope[] = [];
  const spawns: SubagentSpawnRecord[] = [];
  const stateChanges: SubagentStateChangeRecord[] = [];
  const stops: SubagentStopRecord[] = [];

  const trace = {
    recordSubagentSpawn: (r: SubagentSpawnRecord) => {
      spawns.push(r);
      return Promise.resolve(r.id);
    },
    recordSubagentStateChange: (r: SubagentStateChangeRecord) => {
      stateChanges.push(r);
      return Promise.resolve(r.id);
    },
    recordSubagentStop: (r: SubagentStopRecord) => {
      stops.push(r);
      return Promise.resolve(r.id);
    },
  };

  const manager = createSubAgentManager({
    spawn: (_def, _taskId, payload) => {
      payloads.push(payload);
      if (opts.throwOnSpawn) throw new Error("ENOENT no iknow bin");
      const child = makeFakeChild();
      children.push(child);
      return child as unknown as ChildProcess;
    },
    trace: trace as unknown as Parameters<
      typeof createSubAgentManager
    >[0]["trace"],
  });

  return { manager, children, payloads, spawns, stateChanges, stops };
}

function finish(child: FakeChild, envelope: SubAgentEnvelope): void {
  child.stdout.write(JSON.stringify(envelope) + "\n");
  child.emit("exit", 0, null);
}

const flush = (): Promise<void> =>
  new Promise((resolve) => setImmediate(() => resolve()));

const OK: SubAgentEnvelope = { status: "ok", summary: "done", result: "r" };

describe("SubAgentManager — def.parentTurnId 落进三类生命周期 record", () => {
  it("def 带 parentTurnId → spawn / state_change / stop 全部落该值", async () => {
    const h = makeHarness();
    const def: SubAgentDefinition = {
      task: "explore",
      parentTurnId: "turn-77",
    };

    h.manager.spawn(def);
    finish(h.children[0]!, OK);
    await flush();

    assert.equal(h.spawns.length, 1);
    assert.equal(h.spawns[0]!.parentTurnId, "turn-77");
    assert.ok(h.stateChanges.length >= 1);
    for (const sc of h.stateChanges) assert.equal(sc.parentTurnId, "turn-77");
    assert.equal(h.stops.length, 1);
    assert.equal(h.stops[0]!.parentTurnId, "turn-77");
  });

  it("spawn 工厂抛错的失败路径同样落 parentTurnId", async () => {
    const h = makeHarness({ throwOnSpawn: true });

    h.manager.spawn({ task: "explore", parentTurnId: "turn-88" });
    await flush();

    assert.equal(h.spawns.length, 1);
    assert.equal(h.spawns[0]!.parentTurnId, "turn-88");
    assert.equal(h.stops.length, 1);
    assert.equal(h.stops[0]!.parentTurnId, "turn-88");
    assert.equal(h.stops[0]!.reason, "crashed");
  });

  it("def 不带 parentTurnId → 三类 record 上该键缺席 (Postel)", async () => {
    const h = makeHarness();

    h.manager.spawn({ task: "explore" });
    finish(h.children[0]!, OK);
    await flush();

    assert.ok(!("parentTurnId" in h.spawns[0]!));
    for (const sc of h.stateChanges) assert.ok(!("parentTurnId" in sc));
    assert.ok(!("parentTurnId" in h.stops[0]!));
  });

  it("parentTurnId 是父侧独占字段 — 不进 WorkerEnvelope", () => {
    const h = makeHarness();

    h.manager.spawn({ task: "explore", parentTurnId: "turn-99" });

    assert.equal(h.payloads.length, 1);
    assert.ok(
      !("parentTurnId" in h.payloads[0]!),
      "wire envelope 冻结契约不得新增字段"
    );
  });
});
