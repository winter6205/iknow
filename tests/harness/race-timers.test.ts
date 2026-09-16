/**
 * #742 T1:模型调用双钟(idle 重置钟 + 有限硬顶)的纯 helper 套件。
 *
 * 这一层只钉 helper 自身的合同:哪些流事件重置 idle、两根钟各自到点、
 * cancel 之后不再触发、非正值等价关闭。loop-engine 侧的 StopReason /
 * cancelKind 归属由 `model-idle-hardcap.test.ts` 钉。
 */

import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  observeModelIdle,
  resetsModelIdle,
  resolveModelClocks,
  startRaceTimers,
} from "../../src/harness/race-timers.ts";
import type { HarnessStreamEvent } from "../../src/harness/stream.ts";

const sleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

const THINKING: HarnessStreamEvent = { type: "thinking_delta", text: "t" };

describe("#742 T1 race-timers: idle 重置事件闭集", () => {
  it("四类模型输出增量重置 idle", () => {
    assert.equal(resetsModelIdle({ type: "thinking_delta", text: "t" }), true);
    assert.equal(resetsModelIdle({ type: "text_delta", text: "a" }), true);
    assert.equal(
      resetsModelIdle({ type: "tool_call_start", name: "bash", id: "u1" }),
      true
    );
    assert.equal(
      resetsModelIdle({ type: "tool_input_delta", id: "u1", partialJson: "{" }),
      true
    );
  });

  it("compaction_* 与其余宿主事件都不重置 idle", () => {
    const nonResetting: ReadonlyArray<HarnessStreamEvent> = [
      { type: "compaction_started", droppedCount: 3 },
      { type: "compaction_completed", summaryLen: 10, durationMs: 5 },
      { type: "compaction_failed", reason: "empty_response", durationMs: 5 },
      { type: "compaction_cancelled" },
      { type: "compaction_text_delta", text: "summary" },
      { type: "stop_summary", text: "done" },
      { type: "agent_status", lastTool: "idle", openTodoLines: [] },
    ];
    for (const event of nonResetting) {
      assert.equal(
        resetsModelIdle(event),
        false,
        `${event.type} 不得重置 idle`
      );
    }
  });
});

describe("#742 T1 race-timers: 两根钟", () => {
  it("idle 缺席时只剩硬顶(stream=off 单钟语义)", async () => {
    const fired: string[] = [];
    const timers = startRaceTimers({
      hardCapMs: 40,
      idleTimeoutMs: undefined,
      onExpire: (source) => fired.push(source),
    });
    assert.equal(timers.idleEnabled, false);
    await sleep(90);
    timers.cancel();
    assert.deepEqual(fired, ["hardCap"]);
  });

  it("持续增量把 idle 钟推后,硬顶未到则不触发", async () => {
    const fired: string[] = [];
    const timers = startRaceTimers({
      hardCapMs: 5_000,
      idleTimeoutMs: 150,
      onExpire: (source) => fired.push(source),
    });
    assert.equal(timers.idleEnabled, true);
    for (let i = 0; i < 10; i++) {
      await sleep(20);
      timers.noteStreamEvent(THINKING);
    }
    timers.cancel();
    assert.deepEqual(fired, []);
  });

  it("增量之后静默满 idle → onExpire(idle)", async () => {
    const fired: string[] = [];
    const timers = startRaceTimers({
      hardCapMs: 5_000,
      idleTimeoutMs: 50,
      onExpire: (source) => fired.push(source),
    });
    await sleep(15);
    timers.noteStreamEvent(THINKING);
    await sleep(120);
    timers.cancel();
    assert.deepEqual(fired, ["idle"]);
  });

  it("compaction_text_delta 不重置 idle → 仍然 onExpire(idle)", async () => {
    const fired: string[] = [];
    const timers = startRaceTimers({
      hardCapMs: 5_000,
      idleTimeoutMs: 60,
      onExpire: (source) => fired.push(source),
    });
    for (let i = 0; i < 8; i++) {
      await sleep(15);
      timers.noteStreamEvent({ type: "compaction_text_delta", text: "s" });
    }
    timers.cancel();
    assert.deepEqual(fired, ["idle"]);
  });

  it("硬顶到点即使仍有增量 → onExpire(hardCap)", async () => {
    const fired: string[] = [];
    const timers = startRaceTimers({
      hardCapMs: 60,
      idleTimeoutMs: 5_000,
      onExpire: (source) => fired.push(source),
    });
    for (let i = 0; i < 10; i++) {
      await sleep(15);
      timers.noteStreamEvent(THINKING);
    }
    timers.cancel();
    assert.deepEqual(fired, ["hardCap"]);
  });

  it("onExpire 至多触发一次,到点后 noteStreamEvent 不复活 idle", async () => {
    const fired: string[] = [];
    const timers = startRaceTimers({
      hardCapMs: 40,
      idleTimeoutMs: 20,
      onExpire: (source) => fired.push(source),
    });
    await sleep(120);
    timers.noteStreamEvent(THINKING);
    await sleep(60);
    timers.cancel();
    assert.equal(fired.length, 1);
  });

  it("cancel() 之后两根钟都不再触发", async () => {
    const fired: string[] = [];
    const timers = startRaceTimers({
      hardCapMs: 30,
      idleTimeoutMs: 20,
      onExpire: (source) => fired.push(source),
    });
    timers.cancel();
    timers.noteStreamEvent(THINKING);
    await sleep(90);
    assert.deepEqual(fired, []);
  });

  it("非正值等价关闭:hardCapMs<=0 去硬顶,idleTimeoutMs<=0 去 idle", async () => {
    const noHardCap: string[] = [];
    const a = startRaceTimers({
      hardCapMs: 0,
      idleTimeoutMs: 40,
      onExpire: (source) => noHardCap.push(source),
    });
    const noIdle: string[] = [];
    const b = startRaceTimers({
      hardCapMs: 5_000,
      idleTimeoutMs: -1,
      onExpire: (source) => noIdle.push(source),
    });
    assert.equal(b.idleEnabled, false);
    await sleep(90);
    a.cancel();
    b.cancel();
    assert.deepEqual(noHardCap, ["idle"]);
    assert.deepEqual(noIdle, []);
  });
});

/**
 * transport-continue-persist T1 / spec inv 1:`hadVisibleDelta` 是「到点后
 * 还能不能自动重发整次调用」的唯一判据 —— 到点时刻它必须是**到点前**的
 * 累积值,且只被模型输出增量闭集置位。
 */
describe("transport-continue-persist T1: hadVisibleDelta", () => {
  it("起表即为 false(还没出字)", () => {
    const timers = startRaceTimers({
      hardCapMs: 5_000,
      idleTimeoutMs: 150,
      onExpire: () => undefined,
    });
    assert.equal(timers.hadVisibleDelta, false);
    timers.cancel();
  });

  it("idle 关闭(非流式臂)也照记增量 — 判据与 idle 是否启用无关", () => {
    const timers = startRaceTimers({
      hardCapMs: 5_000,
      idleTimeoutMs: undefined,
      onExpire: () => undefined,
    });
    assert.equal(timers.hadVisibleDelta, false);
    timers.noteStreamEvent(THINKING);
    assert.equal(timers.hadVisibleDelta, true);
    timers.cancel();
  });

  it("四类输出增量任一都置位(与 resetsModelIdle 同闭集)", () => {
    const events: ReadonlyArray<HarnessStreamEvent> = [
      { type: "thinking_delta", text: "t" },
      { type: "text_delta", text: "a" },
      { type: "tool_call_start", name: "bash", id: "u1" },
      { type: "tool_input_delta", id: "u1", partialJson: "{" },
    ];
    for (const event of events) {
      const timers = startRaceTimers({
        hardCapMs: 5_000,
        idleTimeoutMs: 150,
        onExpire: () => undefined,
      });
      timers.noteStreamEvent(event);
      assert.equal(timers.hadVisibleDelta, true, `${event.type} 必须置位`);
      timers.cancel();
    }
  });

  it("闭集外事件(compaction_* / stop_summary / agent_status)不置位", () => {
    const timers = startRaceTimers({
      hardCapMs: 5_000,
      idleTimeoutMs: 150,
      onExpire: () => undefined,
    });
    const nonVisible: ReadonlyArray<HarnessStreamEvent> = [
      { type: "compaction_started", droppedCount: 3 },
      { type: "compaction_completed", summaryLen: 10, durationMs: 5 },
      { type: "compaction_failed", reason: "empty_response", durationMs: 5 },
      { type: "compaction_cancelled" },
      { type: "compaction_text_delta", text: "summary" },
      { type: "stop_summary", text: "done" },
      { type: "agent_status", lastTool: "idle", openTodoLines: [] },
    ];
    for (const event of nonVisible) {
      timers.noteStreamEvent(event);
      assert.equal(timers.hadVisibleDelta, false, `${event.type} 不得算作出字`);
    }
    timers.cancel();
  });

  it("到点回调里读到的是到点前的累积值(可见)", async () => {
    let snapshot: boolean | undefined;
    const timers = startRaceTimers({
      hardCapMs: 5_000,
      idleTimeoutMs: 40,
      onExpire: () => {
        snapshot = timers.hadVisibleDelta;
      },
    });
    timers.noteStreamEvent(THINKING);
    await sleep(90);
    assert.equal(snapshot, true);
    timers.cancel();
  });

  it("到点回调里读到的是到点前的累积值(不可见)", async () => {
    let snapshot: boolean | undefined;
    const timers = startRaceTimers({
      hardCapMs: 5_000,
      idleTimeoutMs: 40,
      onExpire: () => {
        snapshot = timers.hadVisibleDelta;
      },
    });
    await sleep(90);
    assert.equal(snapshot, false);
    timers.cancel();
  });

  it("cancel 之后照记但不复活 idle — 判据已无裁决力(回合已定)", async () => {
    const fired: string[] = [];
    const timers = startRaceTimers({
      hardCapMs: 5_000,
      idleTimeoutMs: 150,
      onExpire: (source) => fired.push(source),
    });
    timers.cancel();
    timers.noteStreamEvent(THINKING);
    // 标记照记(noteStreamEvent 不因 stopped 改变语义),但钟不复活、不再到点。
    assert.equal(timers.hadVisibleDelta, true);
    await sleep(200);
    assert.deepEqual(fired, []);
  });
});

describe("#742 T1 observeModelIdle: 包装观察者", () => {
  it("原样转发宿主回调(顺序 + 载荷),并重置 idle", async () => {
    const fired: string[] = [];
    const timers = startRaceTimers({
      hardCapMs: 5_000,
      idleTimeoutMs: 150,
      onExpire: (source) => fired.push(source),
    });
    const seen: HarnessStreamEvent[] = [];
    const observer = observeModelIdle(timers, (event) => seen.push(event));
    for (let i = 0; i < 10; i++) {
      await sleep(20);
      observer!({ type: "text_delta", text: `d${i}` });
    }
    timers.cancel();
    assert.deepEqual(fired, []);
    assert.equal(seen.length, 10);
    assert.deepEqual(seen[0], { type: "text_delta", text: "d0" });
    assert.deepEqual(seen[9], { type: "text_delta", text: "d9" });
  });

  it("宿主回调抛异常被吞咽,且那次增量已经重置 idle", async () => {
    const fired: string[] = [];
    const timers = startRaceTimers({
      hardCapMs: 5_000,
      idleTimeoutMs: 150,
      onExpire: (source) => fired.push(source),
    });
    const observer = observeModelIdle(timers, () => {
      throw new Error("observer blew up");
    });
    for (let i = 0; i < 10; i++) {
      await sleep(20);
      assert.doesNotThrow(() => observer!(THINKING));
    }
    timers.cancel();
    assert.deepEqual(fired, []);
  });

  it("宿主未订阅时 wrapper 仍在场(否则 adapter 无处上报增量)", () => {
    const timers = startRaceTimers({
      hardCapMs: 5_000,
      idleTimeoutMs: 150,
      onExpire: () => undefined,
    });
    const observer = observeModelIdle(timers, undefined);
    assert.equal(typeof observer, "function");
    assert.doesNotThrow(() => observer!(THINKING));
    timers.cancel();
  });

  it("idle 不在场时原样返回宿主回调(引用不变)", () => {
    const timers = startRaceTimers({
      hardCapMs: 5_000,
      idleTimeoutMs: undefined,
      onExpire: () => undefined,
    });
    const host = (): void => undefined;
    assert.equal(observeModelIdle(timers, host), host);
    assert.equal(observeModelIdle(timers, undefined), undefined);
    timers.cancel();
  });
});

describe("#742 T1 resolveModelClocks: 只有流式臂拿双钟", () => {
  it("非流式臂:idle 关闭,硬顶 = 今日单钟", () => {
    assert.deepEqual(
      resolveModelClocks({
        modelTimeoutMs: 300_000,
        streamingArm: false,
        idleTimeoutMs: 120_000,
        hardCapMs: 900_000,
      }),
      { hardCapMs: 300_000, idleTimeoutMs: undefined }
    );
  });

  it("流式臂:idle 生效,硬顶取覆盖值", () => {
    assert.deepEqual(
      resolveModelClocks({
        modelTimeoutMs: 300_000,
        streamingArm: true,
        idleTimeoutMs: 120_000,
        hardCapMs: 900_000,
      }),
      { hardCapMs: 900_000, idleTimeoutMs: 120_000 }
    );
  });

  it("流式臂但未配硬顶:回落今日单钟(不放大到无限)", () => {
    assert.deepEqual(
      resolveModelClocks({
        modelTimeoutMs: 300_000,
        streamingArm: true,
        idleTimeoutMs: undefined,
        hardCapMs: undefined,
      }),
      { hardCapMs: 300_000, idleTimeoutMs: undefined }
    );
  });
});
