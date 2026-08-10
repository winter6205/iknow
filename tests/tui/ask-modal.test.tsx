/** @jsxImportSource @opentui/react */
/**
 * tests/tui/ask-modal.test.tsx
 *
 * #343 T4：权限 ask modal 安全契约（specs/security-guardrails —— y/n/a =
 * once/always/reject，行为与归档版一致）。T4 层覆盖组件 + 桥接接线：
 *  - y/n/a 三键直选 → resolveAsk 真放行/拒绝（promise 落值断言）；
 *  - a → resolve true + always 信号上抛（宿主登记 session 层规则的接缝）；
 *  - ↑↓ 移动选中标记 + Enter 选中当前项（每个分支的回调与选中态断言）；
 *  - Esc 收起 → modal 消失、ask 保持 pending（退回兼容路径仍可 resolve）；
 *  - ask-user 桥接纯语义：approve/deny、超时 fail-closed、未知 id、FIFO、
 *    subscribe 通知计数。
 *
 * 注：sessionGrants 登记 + policy 级放行在 app.tsx 接线（T6），此处断言
 * always 信号到达宿主回调（契约接缝不漂移）。
 */
import { describe, expect, test } from "bun:test";
import { useEffect, useRef, useState } from "react";
import { useKeyboard } from "@opentui/react";
import { testRender } from "@opentui/react/test-utils";
import {
  ModalHost,
  PERMISSION_ANSWERS,
  modalKeyEventOf,
  reduceModalKey,
  type PermissionAnswer,
} from "../../src/tui/modal.js";
import {
  createTuiAskUserBridge,
  type TuiAskUserBridge,
} from "../../src/tui/ask-user.js";

/** 轮询式帧等待（mockInput 字节经 stdin 异步解析）。 */
async function untilFrame(
  setup: Awaited<ReturnType<typeof testRender>>,
  pred: (frame: string) => boolean,
  ms = 3000
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    await new Promise((r) => setTimeout(r, 15));
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    if (pred(frame)) return frame;
  }
  throw new Error(`untilFrame timeout:\n${setup.captureCharFrame()}`);
}

/** 非 React 断言等待（promise 落值 / 回调计数）。 */
async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("until timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** 等 ask promise 落值：必须边等边 renderOnce —— mock stdin 字节只在渲染
 *  pass 里被解析派发，裸 await promise 会让按键永远送不到 handler。 */
async function awaitAsk(
  setup: Awaited<ReturnType<typeof testRender>>,
  promise: Promise<boolean>,
  ms = 3000
): Promise<boolean> {
  let done = false;
  let value = false;
  void promise.then((v) => {
    done = true;
    value = v;
  });
  const start = Date.now();
  while (!done) {
    if (Date.now() - start > ms) throw new Error("awaitAsk timeout");
    await new Promise((r) => setTimeout(r, 15));
    await setup.renderOnce();
  }
  return value;
}

export interface AskRecorder {
  readonly resolved: Array<{ approved: boolean; answer: PermissionAnswer }>;
  readonly alwaysTools: string[];
}

function makeRecorder(): AskRecorder {
  return { resolved: [], alwaysTools: [] };
}

/**
 * 权限 ask modal 接线 harness（T6 app 接线的同构缩小版）：
 * bridge.pending → ModalHost(permission)，键路由走 reduceModalKey 纯函数，
 * select 分支按 once/always/reject 落 resolveAsk。
 */
function AskHarness(props: {
  readonly bridge: TuiAskUserBridge;
  readonly recorder: AskRecorder;
}) {
  const [, setTick] = useState(0);
  const [selected, setSelected] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const lastId = useRef<string | undefined>(undefined);

  useEffect(
    () => props.bridge.subscribe(() => setTick((t) => t + 1)),
    [props.bridge]
  );

  const pending = props.bridge.pending();
  // 新 ask 出现 → 选中态 / 收起态复位（useEffect 保证不破坏渲染期纯净）。
  useEffect(() => {
    if (pending?.id !== lastId.current) {
      lastId.current = pending?.id;
      setSelected(0);
      setDismissed(false);
    }
  }, [pending?.id]);

  useKeyboard((e) => {
    const ask = props.bridge.pending();
    if (ask === undefined || dismissed) return;
    const action = reduceModalKey(modalKeyEventOf(e), {
      options: PERMISSION_ANSWERS,
      selectedIndex: selected,
    });
    if (action.type === "move") {
      setSelected(action.index);
      return;
    }
    if (action.type === "select") {
      const answer = action.value as PermissionAnswer;
      const approved = answer !== "reject";
      props.bridge.resolveAsk(ask.id, approved);
      props.recorder.resolved.push({ approved, answer });
      if (answer === "always") props.recorder.alwaysTools.push(ask.tool);
      return;
    }
    if (action.type === "dismiss") setDismissed(true);
  });

  if (pending === undefined || dismissed) {
    return (
      <text fg="#8a877e">{pending === undefined ? "" : "输入 y/a/n"}</text>
    );
  }
  return (
    <ModalHost
      modal={{
        kind: "permission",
        tool: pending.tool,
        summaryHint: pending.summaryHint,
        selectedIndex: selected,
      }}
      cols={80}
    />
  );
}

const askCtx = { tool: "bash", input: { command: "ls" }, summaryHint: "ls" };

async function mount(recorder: AskRecorder, bridge = createTuiAskUserBridge()) {
  const setup = await testRender(
    <AskHarness bridge={bridge} recorder={recorder} />,
    { width: 80, height: 24, exitOnCtrlC: false }
  );
  await setup.renderOnce();
  return { setup, bridge };
}

async function askAndWaitModal(
  setup: Awaited<ReturnType<typeof testRender>>,
  bridge: TuiAskUserBridge
): Promise<{ readonly promise: Promise<boolean> }> {
  // 注意：不能把 ask promise 直接作为 async 返回值让调用方 await ——
  // await 会展平 Promise<Promise<boolean>>，在按键落值前就死等 resolve。
  const promise = bridge.ask(askCtx);
  await untilFrame(setup, (f) => f.includes("允许执行 bash？"));
  return { promise };
}

describe("权限 ask modal：y/n/a 三键直选（安全契约）", () => {
  test("y 直选 → ask 放行（resolve true），modal 消失", async () => {
    const recorder = makeRecorder();
    const { setup, bridge } = await mount(recorder);
    const { promise } = await askAndWaitModal(setup, bridge);
    await setup.mockInput.typeText("y");
    expect(await awaitAsk(setup, promise)).toBe(true);
    expect(recorder.resolved).toEqual([{ approved: true, answer: "once" }]);
    await untilFrame(setup, (f) => !f.includes("允许执行 bash？"));
    await setup.renderer.destroy();
  });

  test("n 直选 → ask 拒绝（resolve false）", async () => {
    const recorder = makeRecorder();
    const { setup, bridge } = await mount(recorder);
    const { promise } = await askAndWaitModal(setup, bridge);
    await setup.mockInput.typeText("n");
    expect(await awaitAsk(setup, promise)).toBe(false);
    expect(recorder.resolved).toEqual([{ approved: false, answer: "reject" }]);
    await setup.renderer.destroy();
  });

  test("a 直选 → 放行 + always 信号上抛（session 层规则接缝）", async () => {
    const recorder = makeRecorder();
    const { setup, bridge } = await mount(recorder);
    const { promise } = await askAndWaitModal(setup, bridge);
    await setup.mockInput.typeText("a");
    expect(await awaitAsk(setup, promise)).toBe(true);
    expect(recorder.resolved).toEqual([{ approved: true, answer: "always" }]);
    expect(recorder.alwaysTools).toEqual(["bash"]);
    await setup.renderer.destroy();
  });

  test("大写 hotkey 同样生效（Y → once）", async () => {
    const recorder = makeRecorder();
    const { setup, bridge } = await mount(recorder);
    const { promise } = await askAndWaitModal(setup, bridge);
    await setup.mockInput.typeText("Y");
    expect(await awaitAsk(setup, promise)).toBe(true);
    expect(recorder.resolved).toEqual([{ approved: true, answer: "once" }]);
    await setup.renderer.destroy();
  });

  test("无匹配字符 → ignore，modal 保持且未 resolve", async () => {
    const recorder = makeRecorder();
    const { setup, bridge } = await mount(recorder);
    const { promise } = await askAndWaitModal(setup, bridge);
    await setup.mockInput.typeText("x");
    await untilFrame(setup, (f) => f.includes("允许执行 bash？"));
    expect(recorder.resolved).toHaveLength(0);
    expect(bridge.pendingCount()).toBe(1);
    // 之后仍可用 n 拒绝（ignore 不污染状态）。
    await setup.mockInput.typeText("n");
    expect(await awaitAsk(setup, promise)).toBe(false);
    await setup.renderer.destroy();
  });
});

describe("权限 ask modal：↑↓ + Enter 导航选择", () => {
  test("↓ 移动选中标记（❯ [y] → ❯ [a] → ❯ [n]），↑ 回移且顶端 clamp", async () => {
    const recorder = makeRecorder();
    const { setup, bridge } = await mount(recorder);
    await askAndWaitModal(setup, bridge);
    let frame = setup.captureCharFrame();
    expect(frame).toContain("❯ [y]");
    setup.mockInput.pressArrow("down");
    frame = await untilFrame(setup, (f) => f.includes("❯ [a]"));
    expect(frame).not.toContain("❯ [y]");
    setup.mockInput.pressArrow("down");
    frame = await untilFrame(setup, (f) => f.includes("❯ [n]"));
    // 底端 clamp：再 ↓ 仍在 [n]。
    setup.mockInput.pressArrow("down");
    await new Promise((r) => setTimeout(r, 50));
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("❯ [n]");
    // ↑ 回移到 [a]，连续 ↑ 在 [y] clamp。
    setup.mockInput.pressArrow("up");
    await untilFrame(setup, (f) => f.includes("❯ [a]"));
    setup.mockInput.pressArrow("up");
    await untilFrame(setup, (f) => f.includes("❯ [y]"));
    setup.mockInput.pressArrow("up");
    await new Promise((r) => setTimeout(r, 50));
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("❯ [y]");
    await bridge.resolveAsk(bridge.pending()!.id, false);
    await setup.renderer.destroy();
  });

  test("↓↓ + Enter → 选中「拒绝」（resolve false）", async () => {
    const recorder = makeRecorder();
    const { setup, bridge } = await mount(recorder);
    const { promise } = await askAndWaitModal(setup, bridge);
    setup.mockInput.pressArrow("down");
    await untilFrame(setup, (f) => f.includes("❯ [a]"));
    setup.mockInput.pressArrow("down");
    await untilFrame(setup, (f) => f.includes("❯ [n]"));
    setup.mockInput.pressEnter();
    expect(await awaitAsk(setup, promise)).toBe(false);
    expect(recorder.resolved).toEqual([{ approved: false, answer: "reject" }]);
    await setup.renderer.destroy();
  });

  test("↓ + Enter → 选中「总是允许」（resolve true + always 信号）", async () => {
    const recorder = makeRecorder();
    const { setup, bridge } = await mount(recorder);
    const { promise } = await askAndWaitModal(setup, bridge);
    setup.mockInput.pressArrow("down");
    await untilFrame(setup, (f) => f.includes("❯ [a]"));
    setup.mockInput.pressEnter();
    expect(await awaitAsk(setup, promise)).toBe(true);
    expect(recorder.resolved).toEqual([{ approved: true, answer: "always" }]);
    expect(recorder.alwaysTools).toEqual(["bash"]);
    await setup.renderer.destroy();
  });

  test("初始 Enter（无导航）→ 选中默认第一项 once", async () => {
    const recorder = makeRecorder();
    const { setup, bridge } = await mount(recorder);
    const { promise } = await askAndWaitModal(setup, bridge);
    setup.mockInput.pressEnter();
    expect(await awaitAsk(setup, promise)).toBe(true);
    expect(recorder.resolved).toEqual([{ approved: true, answer: "once" }]);
    await setup.renderer.destroy();
  });
});

describe("权限 ask modal：Esc 收起（兼容路径）", () => {
  test("Esc → modal 消失、ask 保持 pending；后续 resolveAsk 仍生效", async () => {
    const recorder = makeRecorder();
    const { setup, bridge } = await mount(recorder);
    const { promise } = await askAndWaitModal(setup, bridge);
    setup.mockInput.pressEscape();
    await untilFrame(setup, (f) => !f.includes("允许执行 bash？"));
    // modal 收起：三选项行消失，兼容提示出现。
    expect(setup.captureCharFrame()).not.toContain("总是允许（本会话）");
    expect(setup.captureCharFrame()).toContain("输入 y/a/n");
    // ask 未被 resolve（fail-closed 前宿主仍可走兼容路径）。
    expect(bridge.pendingCount()).toBe(1);
    expect(recorder.resolved).toHaveLength(0);
    const id = bridge.pending()!.id;
    expect(bridge.resolveAsk(id, true)).toBe(true);
    await expect(promise).resolves.toBe(true);
    await setup.renderer.destroy();
  });

  test("Esc 收起后不再响应 y/n/a（modal 已摘除）", async () => {
    const recorder = makeRecorder();
    const { setup, bridge } = await mount(recorder);
    const { promise } = await askAndWaitModal(setup, bridge);
    setup.mockInput.pressEscape();
    await untilFrame(setup, (f) => f.includes("输入 y/a/n"));
    await setup.mockInput.typeText("y");
    await new Promise((r) => setTimeout(r, 80));
    await setup.renderOnce();
    expect(recorder.resolved).toHaveLength(0);
    expect(bridge.pendingCount()).toBe(1);
    await bridge.resolveAsk(bridge.pending()!.id, false);
    await expect(promise).resolves.toBe(false);
    await setup.renderer.destroy();
  });
});

describe("createTuiAskUserBridge（queue-based + fail-closed）", () => {
  test("resolveAsk(true/false) 显式放行 / 拒绝", async () => {
    const bridge = createTuiAskUserBridge();
    const p1 = bridge.ask(askCtx);
    expect(bridge.pendingCount()).toBe(1);
    expect(bridge.pending()?.tool).toBe("bash");
    expect(bridge.resolveAsk(bridge.pending()!.id, true)).toBe(true);
    await expect(p1).resolves.toBe(true);
    const p2 = bridge.ask(askCtx);
    expect(bridge.resolveAsk(bridge.pending()!.id, false)).toBe(true);
    await expect(p2).resolves.toBe(false);
    expect(bridge.pendingCount()).toBe(0);
  });

  test("超时 fail-closed（无显式 resolve → false）", async () => {
    const bridge = createTuiAskUserBridge({ timeoutMs: 30 });
    const promise = bridge.ask(askCtx);
    await expect(promise).resolves.toBe(false);
    expect(bridge.pendingCount()).toBe(0);
  });

  test("未知 / 已决 id → resolveAsk 返回 false", async () => {
    const bridge = createTuiAskUserBridge();
    const promise = bridge.ask(askCtx);
    const id = bridge.pending()!.id;
    bridge.resolveAsk(id, true);
    await promise;
    expect(bridge.resolveAsk(id, true)).toBe(false);
    expect(bridge.resolveAsk("ask-nope", true)).toBe(false);
  });

  test("多个 ask 排队：pending() 返回最早一个（FIFO）", async () => {
    const bridge = createTuiAskUserBridge();
    const p1 = bridge.ask(askCtx);
    const p2 = bridge.ask({ ...askCtx, tool: "write_file" });
    expect(bridge.pendingCount()).toBe(2);
    expect(bridge.pending()?.tool).toBe("bash");
    bridge.resolveAsk(bridge.pending()!.id, true);
    await p1;
    expect(bridge.pending()?.tool).toBe("write_file");
    bridge.resolveAsk(bridge.pending()!.id, false);
    await p2;
  });

  test("subscribe：enqueue / settle 各通知一次；退订后不再通知", async () => {
    const bridge = createTuiAskUserBridge();
    let calls = 0;
    const unsub = bridge.subscribe(() => {
      calls += 1;
    });
    const promise = bridge.ask(askCtx); // enqueue → +1
    expect(calls).toBe(1);
    bridge.resolveAsk(bridge.pending()!.id, true); // settle → +1
    await promise;
    expect(calls).toBe(2);
    unsub();
    const p2 = bridge.ask(askCtx);
    bridge.resolveAsk(bridge.pending()!.id, false);
    await p2;
    expect(calls).toBe(2);
  });
});
