/** @jsxImportSource @opentui/react */
/**
 * tests/tui/ask-modal.test.tsx
 *
 * Permission ask modal security contract: y/n/a = once/always/reject,
 * behavior aligned with the archived version. Coverage: component + bridge wiring:
 *  - y/n/a direct keys → resolveAsk truly approves/rejects (typed outcome asserted);
 *  - a → approve + always signal raised (seam for the host to register
 *    session-level rules);
 *  - ↑↓ move the selection marker + Enter picks the current item (callback and
 *    selection state asserted per branch);
 *  - Esc dismisses → modal gone, ask stays pending (compat path can still resolve);
 *  - ask-user bridge pure semantics: approve/deny, a configured timeout ends
 *    as {kind:"timeout"}, NO default timeout (ADR-0147 R4), abort →
 *    {kind:"cancelled"}, unknown id, FIFO, subscribe notification counts;
 *  - NO default timeout, deterministically: under Bun fake timers an
 *    unconfigured bridge arms zero timers and stays pending past 5 s / 60 s /
 *    10 min, while a configured bridge settles at its own deadline;
 *  - pending() is call-addressed: it carries the inlet's toolUseId and
 *    optional conversationId (ADR-0147 R1).
 *
 * Note: sessionGrants registration + policy-level approval is wired in
 * app.tsx; here we only assert the always signal reaches the host callback
 * (the contract seam must not drift). The modal names the call it is asking
 * about (`call <short toolUseId>`, ADR-0147 R1) once the pending view carries
 * the id.
 */
import { describe, expect, jest, test } from "bun:test";
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
import type { AskUserOutcome } from "../../src/harness/permission/types.js";

/** Polling frame wait (mockInput bytes parse asynchronously via stdin). */
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

/** Wait for the ask promise to settle: must keep calling renderOnce while
 * waiting — mock stdin bytes are only parsed and dispatched during render
 * passes, so a bare await would never see the keys reach the handler. */
async function awaitAsk(
  setup: Awaited<ReturnType<typeof testRender>>,
  promise: Promise<boolean | AskUserOutcome>,
  ms = 3000
): Promise<boolean | AskUserOutcome> {
  let done = false;
  let value: boolean | AskUserOutcome = false;
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
 * Permission ask modal wiring harness (a shrunk isomorph of the app-level
 * wiring): bridge.pending → ModalHost(permission), key routing through the
 * reduceModalKey pure function, select branches land resolveAsk per
 * once/always/reject.
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
  // New ask appears → reset selection / dismissed state (via useEffect to keep render pure).
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
        toolUseId: pending.toolUseId,
        selectedIndex: selected,
      }}
      cols={80}
    />
  );
}

const askCtx = {
  tool: "bash",
  input: { command: "ls" },
  summaryHint: "ls",
  toolUseId: "toolu_modal_1",
  conversationId: "conv-modal",
};

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
): Promise<{ readonly promise: Promise<boolean | AskUserOutcome> }> {
  // Note: never return the ask promise for the caller to await — awaiting
  // flattens Promise<Promise<...>> and dead-waits before keys land.
  const promise = bridge.ask(askCtx);
  await untilFrame(setup, (f) => f.includes("允许执行 bash？"));
  return { promise };
}

describe("权限 ask modal：y/n/a 三键直选（安全契约）", () => {
  test("y 直选 → ask 放行（approved），modal 消失", async () => {
    const recorder = makeRecorder();
    const { setup, bridge } = await mount(recorder);
    const { promise } = await askAndWaitModal(setup, bridge);
    await setup.mockInput.typeText("y");
    expect(await awaitAsk(setup, promise)).toEqual({ kind: "approved" });
    expect(recorder.resolved).toEqual([{ approved: true, answer: "once" }]);
    await untilFrame(setup, (f) => !f.includes("允许执行 bash？"));
    await setup.renderer.destroy();
  });

  test("n 直选 → ask 拒绝（declined）", async () => {
    const recorder = makeRecorder();
    const { setup, bridge } = await mount(recorder);
    const { promise } = await askAndWaitModal(setup, bridge);
    await setup.mockInput.typeText("n");
    expect(await awaitAsk(setup, promise)).toEqual({ kind: "declined" });
    expect(recorder.resolved).toEqual([{ approved: false, answer: "reject" }]);
    await setup.renderer.destroy();
  });

  test("a 直选 → 放行 + always 信号上抛（session 层规则接缝）", async () => {
    const recorder = makeRecorder();
    const { setup, bridge } = await mount(recorder);
    const { promise } = await askAndWaitModal(setup, bridge);
    await setup.mockInput.typeText("a");
    expect(await awaitAsk(setup, promise)).toEqual({ kind: "approved" });
    expect(recorder.resolved).toEqual([{ approved: true, answer: "always" }]);
    expect(recorder.alwaysTools).toEqual(["bash"]);
    await setup.renderer.destroy();
  });

  test("大写 hotkey 同样生效（Y → once）", async () => {
    const recorder = makeRecorder();
    const { setup, bridge } = await mount(recorder);
    const { promise } = await askAndWaitModal(setup, bridge);
    await setup.mockInput.typeText("Y");
    expect(await awaitAsk(setup, promise)).toEqual({ kind: "approved" });
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
    // n can still reject afterwards (ignore does not pollute state).
    await setup.mockInput.typeText("n");
    expect(await awaitAsk(setup, promise)).toEqual({ kind: "declined" });
    await setup.renderer.destroy();
  });

  test("modal 显示调用身份（call <toolUseId 前 12 位>，ADR-0147 R1）", async () => {
    const recorder = makeRecorder();
    const { setup, bridge } = await mount(recorder);
    const { promise } = await askAndWaitModal(setup, bridge);
    // askCtx.toolUseId = "toolu_modal_1" → the modal names its first 12 chars.
    const frame = setup.captureCharFrame();
    expect(frame).toContain("ls · call toolu_modal_");
    expect(bridge.pending()?.toolUseId).toBe("toolu_modal_1");
    await bridge.resolveAsk(bridge.pending()!.id, false);
    await expect(promise).resolves.toEqual({ kind: "declined" });
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
    // bottom clamp: another ↓ stays on [n].
    setup.mockInput.pressArrow("down");
    await new Promise((r) => setTimeout(r, 50));
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("❯ [n]");
    // ↑ moves back to [a]; repeated ↑ clamps at [y].
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

  test("↓↓ + Enter → 选中「拒绝」（declined）", async () => {
    const recorder = makeRecorder();
    const { setup, bridge } = await mount(recorder);
    const { promise } = await askAndWaitModal(setup, bridge);
    setup.mockInput.pressArrow("down");
    await untilFrame(setup, (f) => f.includes("❯ [a]"));
    setup.mockInput.pressArrow("down");
    await untilFrame(setup, (f) => f.includes("❯ [n]"));
    setup.mockInput.pressEnter();
    expect(await awaitAsk(setup, promise)).toEqual({ kind: "declined" });
    expect(recorder.resolved).toEqual([{ approved: false, answer: "reject" }]);
    await setup.renderer.destroy();
  });

  test("↓ + Enter → 选中「总是允许」（approved + always 信号）", async () => {
    const recorder = makeRecorder();
    const { setup, bridge } = await mount(recorder);
    const { promise } = await askAndWaitModal(setup, bridge);
    setup.mockInput.pressArrow("down");
    await untilFrame(setup, (f) => f.includes("❯ [a]"));
    setup.mockInput.pressEnter();
    expect(await awaitAsk(setup, promise)).toEqual({ kind: "approved" });
    expect(recorder.resolved).toEqual([{ approved: true, answer: "always" }]);
    expect(recorder.alwaysTools).toEqual(["bash"]);
    await setup.renderer.destroy();
  });

  test("初始 Enter（无导航）→ 选中默认第一项 once", async () => {
    const recorder = makeRecorder();
    const { setup, bridge } = await mount(recorder);
    const { promise } = await askAndWaitModal(setup, bridge);
    setup.mockInput.pressEnter();
    expect(await awaitAsk(setup, promise)).toEqual({ kind: "approved" });
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
    // modal dismissed: option rows gone, compat hint present.
    expect(setup.captureCharFrame()).not.toContain("总是允许（本会话）");
    expect(setup.captureCharFrame()).toContain("输入 y/a/n");
    // ask unresolved (host can still use the compat path).
    expect(bridge.pendingCount()).toBe(1);
    expect(recorder.resolved).toHaveLength(0);
    const id = bridge.pending()!.id;
    expect(bridge.resolveAsk(id, true)).toBe(true);
    await expect(promise).resolves.toEqual({ kind: "approved" });
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
    await expect(promise).resolves.toEqual({ kind: "declined" });
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
    await expect(p1).resolves.toEqual({ kind: "approved" });
    const p2 = bridge.ask(askCtx);
    expect(bridge.resolveAsk(bridge.pending()!.id, false)).toBe(true);
    await expect(p2).resolves.toEqual({ kind: "declined" });
    expect(bridge.pendingCount()).toBe(0);
  });

  test("配置超时 → {kind:'timeout', afterMs}（不批准，fail-closed）", async () => {
    const bridge = createTuiAskUserBridge({ timeoutMs: 30 });
    const promise = bridge.ask(askCtx);
    await expect(promise).resolves.toEqual({ kind: "timeout", afterMs: 30 });
    expect(bridge.pendingCount()).toBe(0);
  });

  test("无默认超时：未配置 / timeoutMs:0 在短真实窗口后仍 pending（ADR-0147 R4）", async () => {
    // A real-time 60 s wait is not viable here; the definitive no-default
    // contract is covered by the serve fake-timer test and the absence of a
    // default constant in the source. This test pins the observable shape:
    // no timer fires, the ask stays pending, and an explicit answer still wins.
    for (const bridge of [
      createTuiAskUserBridge(),
      createTuiAskUserBridge({ timeoutMs: 0 }),
    ]) {
      const promise = bridge.ask(askCtx);
      let settled = false;
      void promise.then(() => {
        settled = true;
      });
      await new Promise((r) => setTimeout(r, 80));
      expect(settled).toBe(false);
      expect(bridge.pendingCount()).toBe(1);
      expect(bridge.resolveAsk(bridge.pending()!.id, true)).toBe(true);
      await expect(promise).resolves.toEqual({ kind: "approved" });
    }
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

  test("pending() 携带调用身份（toolUseId / conversationId）且无第二个批准轴字段（ADR-0097 / R1）", async () => {
    const bridge = createTuiAskUserBridge();
    const promise = bridge.ask(askCtx);
    const info = bridge.pending()!;
    // Call identity is additive (ADR-0147 R1); no second approval-axis field
    // rewritten per input — the TUI render surface keeps a single marker branch.
    expect(Object.keys(info).sort()).toEqual([
      "conversationId",
      "id",
      "input",
      "summaryHint",
      "tool",
      "toolUseId",
    ]);
    expect(info.tool).toBe("bash");
    expect(info.toolUseId).toBe("toolu_modal_1");
    expect(info.conversationId).toBe("conv-modal");
    // The call input rides along for consumers with no executor view of the
    // call (spec remote-sync §4.2, the phone approval card).
    expect(info.input).toEqual({ command: "ls" });
    bridge.resolveAsk(info.id, true);
    await promise;
  });

  test("pending() 省略 conversationId 当调用方没有会话（字段集固定）", async () => {
    const bridge = createTuiAskUserBridge();
    const promise = bridge.ask({
      tool: "bash",
      input: {},
      summaryHint: "",
      toolUseId: "toolu_no_conversation",
    });
    const info = bridge.pending()!;
    expect(Object.keys(info).sort()).toEqual([
      "id",
      "input",
      "summaryHint",
      "tool",
      "toolUseId",
    ]);
    expect(info.toolUseId).toBe("toolu_no_conversation");
    expect(info.conversationId).toBeUndefined();
    bridge.resolveAsk(info.id, true);
    await promise;
  });

  test("abort clears a pending ask immediately and ignores a late approval", async () => {
    const bridge = createTuiAskUserBridge({ timeoutMs: 1_000 });
    const controller = new AbortController();
    const promise = bridge.ask({ ...askCtx, signal: controller.signal });
    const id = bridge.pending()!.id;

    controller.abort();

    expect(bridge.pendingCount()).toBe(0);
    await expect(promise).resolves.toEqual({ kind: "cancelled" });
    expect(bridge.resolveAsk(id, true)).toBe(false);
  });

  test("abort without a configured timeout also ends as cancelled", async () => {
    const bridge = createTuiAskUserBridge();
    const controller = new AbortController();
    const promise = bridge.ask({ ...askCtx, signal: controller.signal });
    const id = bridge.pending()!.id;

    controller.abort();

    expect(bridge.pendingCount()).toBe(0);
    await expect(promise).resolves.toEqual({ kind: "cancelled" });
    expect(bridge.resolveAsk(id, true)).toBe(false);
  });

  test("an already-aborted signal does not enqueue a TUI ask", async () => {
    const bridge = createTuiAskUserBridge({ timeoutMs: 30 });
    const controller = new AbortController();
    controller.abort();

    const promise = bridge.ask({ ...askCtx, signal: controller.signal });

    expect(bridge.pendingCount()).toBe(0);
    await expect(promise).resolves.toEqual({ kind: "cancelled" });
  });

  test("an already-aborted signal yields cancelled without a configured timeout too", async () => {
    const bridge = createTuiAskUserBridge();
    const controller = new AbortController();
    controller.abort();

    const promise = bridge.ask({ ...askCtx, signal: controller.signal });

    expect(bridge.pendingCount()).toBe(0);
    await expect(promise).resolves.toEqual({ kind: "cancelled" });
  });

  test("one abort clears multiple pending TUI asks", async () => {
    const bridge = createTuiAskUserBridge({ timeoutMs: 1_000 });
    const controller = new AbortController();
    const promises = [1, 2, 3].map((n) =>
      bridge.ask({
        ...askCtx,
        tool: `tool-${n}`,
        toolUseId: `toolu_multi_${n}`,
        signal: controller.signal,
      })
    );

    expect(bridge.pendingCount()).toBe(3);
    controller.abort();

    expect(bridge.pendingCount()).toBe(0);
    await expect(Promise.all(promises)).resolves.toEqual([
      { kind: "cancelled" },
      { kind: "cancelled" },
      { kind: "cancelled" },
    ]);
  });

  test("approval that settles first wins a TUI abort race", async () => {
    const bridge = createTuiAskUserBridge({ timeoutMs: 1_000 });
    const controller = new AbortController();
    const promise = bridge.ask({ ...askCtx, signal: controller.signal });
    const id = bridge.pending()!.id;

    expect(bridge.resolveAsk(id, true)).toBe(true);
    controller.abort();

    await expect(promise).resolves.toEqual({ kind: "approved" });
    expect(bridge.pendingCount()).toBe(0);
  });

  test("aborting with no pending TUI asks is a no-op", () => {
    const bridge = createTuiAskUserBridge();
    const controller = new AbortController();

    controller.abort();

    expect(bridge.pendingCount()).toBe(0);
    expect(bridge.pending()).toBeUndefined();
  });
});

/** Records settlement of an ask promise without awaiting it (awaiting inside a
 *  fake-timer window would never see a timer-driven settle). */
function trackSettlement<T>(promise: Promise<T>): {
  settled: boolean;
  value?: T;
} {
  const state: { settled: boolean; value?: T } = { settled: false };
  void promise.then((value) => {
    state.settled = true;
    state.value = value;
  });
  return state;
}

/** Drain the microtask queue after a fake-timer advance. Several turns: the
 *  bridge's settle() resolves the ask inside the timer callback, so the flag
 *  only lands after the promise reaction jobs run. */
async function flushMicrotasks(turns = 8): Promise<void> {
  for (let i = 0; i < turns; i += 1) await Promise.resolve();
}

describe("createTuiAskUserBridge：无默认超时的确定性证据（fake timers，ADR-0147 R4）", () => {
  test("未配置 / timeoutMs:0：不 arm 任何定时器，推进 5s / 60.001s / 10.001min 后仍 pending", async () => {
    jest.useFakeTimers();
    try {
      jest.clearAllTimers();
      for (const bridge of [
        createTuiAskUserBridge(),
        createTuiAskUserBridge({ timeoutMs: 0 }),
      ]) {
        expect(jest.getTimerCount()).toBe(0);
        const promise = bridge.ask(askCtx);
        const state = trackSettlement(promise);
        await flushMicrotasks();
        // The load-bearing assertion: arming an ask on an unconfigured bridge
        // creates no timer at all, so no default (60 s, 120 s, 10 min, ...)
        // deadline can ever fire one.
        expect(jest.getTimerCount()).toBe(0);
        expect(state.settled).toBe(false);
        expect(bridge.pendingCount()).toBe(1);

        // 5 s → 60.001 s → 600.001 s of fake time.
        for (const step of [5_000, 55_001, 540_000]) {
          jest.advanceTimersByTime(step);
          await flushMicrotasks();
          expect(state.settled).toBe(false);
          expect(bridge.pendingCount()).toBe(1);
        }

        // Still the same live question, and an explicit answer still wins.
        expect(bridge.pending()?.id).toBe("ask-1");
        expect(bridge.resolveAsk("ask-1", true)).toBe(true);
        await expect(promise).resolves.toEqual({ kind: "approved" });
        expect(bridge.pendingCount()).toBe(0);
      }
    } finally {
      jest.useRealTimers();
    }
  });

  test("配置超时：到期前不结束，到期时以 {kind:'timeout', afterMs} 结束（fake time）", async () => {
    jest.useFakeTimers();
    try {
      jest.clearAllTimers();
      const bridge = createTuiAskUserBridge({ timeoutMs: 5_000 });
      const promise = bridge.ask(askCtx);
      const state = trackSettlement(promise);
      expect(jest.getTimerCount()).toBe(1);

      jest.advanceTimersByTime(4_999);
      await flushMicrotasks();
      expect(state.settled).toBe(false);
      expect(bridge.pendingCount()).toBe(1);

      jest.advanceTimersByTime(1);
      await flushMicrotasks();
      expect(state.settled).toBe(true);
      await expect(promise).resolves.toEqual({
        kind: "timeout",
        afterMs: 5_000,
      });
      expect(bridge.pendingCount()).toBe(0);
      // settle() cleared the timer it armed.
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  test("同一 10 分钟窗口内分叉：未配置的仍 pending，配置 10min 的已 timeout", async () => {
    jest.useFakeTimers();
    try {
      jest.clearAllTimers();
      const unconfigured = createTuiAskUserBridge();
      const configured = createTuiAskUserBridge({ timeoutMs: 600_000 });
      const unbounded = unconfigured.ask(askCtx);
      const bounded = configured.ask(askCtx);
      const unboundedState = trackSettlement(unbounded);
      const boundedState = trackSettlement(bounded);

      jest.advanceTimersByTime(600_000);
      await flushMicrotasks();

      // The configured deadline fired...
      expect(boundedState.settled).toBe(true);
      await expect(bounded).resolves.toEqual({
        kind: "timeout",
        afterMs: 600_000,
      });
      expect(configured.pendingCount()).toBe(0);
      // ...while the unconfigured bridge is untouched by the same 10 minutes.
      expect(unboundedState.settled).toBe(false);
      expect(unconfigured.pendingCount()).toBe(1);
      expect(unconfigured.pending()?.id).toBe("ask-1");

      unconfigured.resolveAsk(unconfigured.pending()!.id, false);
      await expect(unbounded).resolves.toEqual({ kind: "declined" });
    } finally {
      jest.useRealTimers();
    }
  });
});
