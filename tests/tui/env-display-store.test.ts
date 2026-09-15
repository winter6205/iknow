/**
 * tests/tui/env-display-store.test.ts
 *
 * env-display-store.ts 单测（bun:test；无 React 依赖 —— 与 thinking-override
 * 同策略，独立模块规避 app.tsx import 链拉起渲染器）。
 *
 * 契约核心：两次 publish 之间 get() 必须返回**同一对象身份** ——
 * `useSyncExternalStore` 用 Object.is 比较 getSnapshot 的返回值，每次现造新
 * 对象会被判成「变了」并触发无限重渲染。其余用例钉住发布序号单调、退订幂等、
 * listener 异常隔离，以及「通知期间变更订阅集合」的快照语义（复制后再遍历）。
 */
import { describe, expect, test } from "bun:test";
import {
  createEnvDisplayStore,
  type EnvDisplaySnapshot,
} from "../../src/tui/env-display-store.js";

/** defaultThinking 最小投影（thinking-gate.ts 的 DefaultThinkingShape）。 */
const ADAPTIVE_HIGH = { mode: "adaptive", effort: "high" } as const;
const OFF_EMPTY = { mode: "off", effort: "" } as const;

describe("get: 初始快照与身份稳定", () => {
  test("未 publish 时返回 seed 快照（version 0），且原样保留 seed 字段", () => {
    const store = createEnvDisplayStore({
      model: "minimax-cn/MiniMax-M3",
      defaultThinking: ADAPTIVE_HIGH,
    });

    const snapshot = store.get();

    expect(snapshot.model).toBe("minimax-cn/MiniMax-M3");
    expect(snapshot.defaultThinking).toBe(ADAPTIVE_HIGH);
    expect(snapshot.version).toBe(0);
  });

  test("无 publish 间隔时两次 get() 返回同一对象身份", () => {
    const store = createEnvDisplayStore({
      model: "minimax-cn/MiniMax-M3",
      defaultThinking: ADAPTIVE_HIGH,
    });

    expect(store.get()).toBe(store.get());
  });

  test("publish 之后再次 get() 仍稳定（同一身份，直到下次 publish）", () => {
    const store = createEnvDisplayStore({
      model: "a/one",
      defaultThinking: undefined,
    });

    store.publish({ model: "b/two", defaultThinking: OFF_EMPTY });
    const afterPublish = store.get();

    expect(store.get()).toBe(afterPublish);
  });
});

describe("publish: 发布序号与快照替换", () => {
  test("通知订阅者并产出新身份快照：version 0 → 1", () => {
    const store = createEnvDisplayStore({
      model: "a/one",
      defaultThinking: undefined,
    });
    const before = store.get();
    const calls: number[] = [];
    store.subscribe(() => {
      calls.push(store.get().version);
    });

    store.publish({ model: "b/two", defaultThinking: OFF_EMPTY });

    expect(calls).toEqual([1]);
    const after = store.get();
    expect(after).not.toBe(before);
    expect(after.model).toBe("b/two");
    expect(after.defaultThinking).toBe(OFF_EMPTY);
    expect(after.version).toBe(1);
  });

  test("连续两次 publish：version 单调 0 → 1 → 2", () => {
    const store = createEnvDisplayStore({
      model: "a/one",
      defaultThinking: undefined,
    });
    const versions: number[] = [store.get().version];

    store.publish({ model: "b/two", defaultThinking: undefined });
    versions.push(store.get().version);
    store.publish({ model: "c/three", defaultThinking: undefined });
    versions.push(store.get().version);

    expect(versions).toEqual([0, 1, 2]);
  });

  test("同值重发也推进 version（发布序号是唯一变化信号）", () => {
    const store = createEnvDisplayStore({
      model: "a/one",
      defaultThinking: OFF_EMPTY,
    });
    const before = store.get();

    store.publish({ model: "a/one", defaultThinking: OFF_EMPTY });
    const after = store.get();

    expect(after).not.toBe(before);
    expect(after.model).toBe("a/one");
    expect(after.defaultThinking).toBe(OFF_EMPTY);
    expect(after.version).toBe(1);
  });

  test("defaultThinking: undefined 原样 round-trip，不伪造基线", () => {
    const store = createEnvDisplayStore({
      model: undefined,
      defaultThinking: ADAPTIVE_HIGH,
    });

    store.publish({ model: "b/two", defaultThinking: undefined });
    const snapshot = store.get();

    expect(snapshot.defaultThinking).toBeUndefined();
    expect(snapshot.model).toBe("b/two");
    // 模型缺失与基线缺失是两个独立维度，缺 baseline 不得回填 off/adaptive。
    store.publish({ model: undefined, defaultThinking: undefined });
    expect(store.get().model).toBeUndefined();
    expect(store.get().defaultThinking).toBeUndefined();
  });
});

describe("subscribe/unsubscribe: 投递语义与幂等", () => {
  test("退订后不再收到投递", () => {
    const store = createEnvDisplayStore({
      model: "a/one",
      defaultThinking: undefined,
    });
    let calls = 0;
    const unsubscribe = store.subscribe(() => {
      calls += 1;
    });

    store.publish({ model: "b/two", defaultThinking: undefined });
    unsubscribe();
    store.publish({ model: "c/three", defaultThinking: undefined });

    expect(calls).toBe(1);
  });

  test("多 listener 按订阅顺序各收到恰好一次", () => {
    const store = createEnvDisplayStore({
      model: "a/one",
      defaultThinking: undefined,
    });
    const order: string[] = [];
    store.subscribe(() => order.push("first"));
    store.subscribe(() => order.push("second"));
    store.subscribe(() => order.push("third"));

    store.publish({ model: "b/two", defaultThinking: undefined });

    expect(order).toEqual(["first", "second", "third"]);
  });

  test("退订幂等：返回的 unsubscribe 可重复调用，且与触发次数无关", () => {
    const store = createEnvDisplayStore({
      model: "a/one",
      defaultThinking: undefined,
    });
    let calls = 0;
    const unsubscribe = store.subscribe(() => {
      calls += 1;
    });

    store.publish({ model: "b/two", defaultThinking: undefined });
    unsubscribe();
    unsubscribe();
    store.publish({ model: "c/three", defaultThinking: undefined });
    unsubscribe();

    expect(calls).toBe(1);
  });
});

describe("listener 异常隔离", () => {
  test("A 抛异常不阻断 B，且 publish 不向外抛（TUI 不得因显示层 listener 崩溃）", () => {
    const store = createEnvDisplayStore({
      model: "a/one",
      defaultThinking: undefined,
    });
    const received: string[] = [];
    store.subscribe(() => {
      throw new Error("listener A boom");
    });
    store.subscribe(() => received.push("B"));

    expect(() => {
      store.publish({ model: "b/two", defaultThinking: undefined });
    }).not.toThrow();
    expect(received).toEqual(["B"]);

    // 一次抛异常不得污染 store 状态：后续 publish 照常投递。
    store.publish({ model: "c/three", defaultThinking: undefined });
    expect(received).toEqual(["B", "B"]);
    expect(store.get().version).toBe(2);
  });
});

describe("通知期间变更订阅集合：复制后遍历（快照语义）", () => {
  test("listener 在通知中自退订：本次照常收到，下次不再收到", () => {
    const store = createEnvDisplayStore({
      model: "a/one",
      defaultThinking: undefined,
    });
    const calls: string[] = [];
    const unsubscribeSelf = store.subscribe(() => {
      calls.push("A");
      unsubscribeSelf();
    });
    store.subscribe(() => calls.push("B"));

    store.publish({ model: "b/two", defaultThinking: undefined });
    expect(calls).toEqual(["A", "B"]);

    store.publish({ model: "c/three", defaultThinking: undefined });
    expect(calls).toEqual(["A", "B", "B"]);
  });

  test("listener 在通知中移除尚未轮到的 listener：本次遍历不受影响", () => {
    const store = createEnvDisplayStore({
      model: "a/one",
      defaultThinking: undefined,
    });
    const calls: string[] = [];
    let unsubscribeLater = (): void => {};
    store.subscribe(() => {
      calls.push("A");
      unsubscribeLater();
    });
    unsubscribeLater = store.subscribe(() => calls.push("B"));

    store.publish({ model: "b/two", defaultThinking: undefined });
    // 复制后遍历：B 虽已被删除，本次通知仍按发布时刻的订阅集合投递。
    expect(calls).toEqual(["A", "B"]);

    store.publish({ model: "c/three", defaultThinking: undefined });
    // A 仍在订阅：B 的移除只影响后续发布，不得让 A 少收一次。
    expect(calls).toEqual(["A", "B", "A"]);
  });

  test("listener 在通知中新增订阅：不收到本次在途发布，下次才收到", () => {
    const store = createEnvDisplayStore({
      model: "a/one",
      defaultThinking: undefined,
    });
    const calls: string[] = [];
    store.subscribe(() => {
      calls.push("A");
      if (calls.length === 1) store.subscribe(() => calls.push("late"));
    });

    store.publish({ model: "b/two", defaultThinking: undefined });
    expect(calls).toEqual(["A"]);

    store.publish({ model: "c/three", defaultThinking: undefined });
    // 第二次通知：late 已在集合中，按订阅顺序排在 A 之后。
    expect(calls).toEqual(["A", "A", "late"]);
  });
});

describe("快照字段只读性与类型面", () => {
  test("快照不含 version 之外的派生字段（omit-version 输入形状）", () => {
    const store = createEnvDisplayStore({
      model: "a/one",
      defaultThinking: undefined,
    });

    store.publish({ model: "b/two", defaultThinking: ADAPTIVE_HIGH });

    const snapshot: EnvDisplaySnapshot = store.get();
    expect(Object.keys(snapshot).sort()).toEqual([
      "defaultThinking",
      "model",
      "version",
    ]);
  });
});
