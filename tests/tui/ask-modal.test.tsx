/** @jsxImportSource @opentui/react */
/**
 * tests/tui/ask-modal.test.tsx
 *
 * Permission ask modal security contract: y/n/a = once/always/reject,
 * behavior aligned with the archived version. Coverage: component + bridge wiring:
 *  - y/n/a direct keys → resolveAsk truly approves/rejects (promise value asserted);
 *  - a → resolve true + always signal raised (seam for the host to register
 *    session-level rules);
 *  - ↑↓ move the selection marker + Enter picks the current item (callback and
 *    selection state asserted per branch);
 *  - Esc dismisses → modal gone, ask stays pending (compat path can still resolve);
 *  - ask-user bridge pure semantics: approve/deny, timeout fail-closed,
 *    unknown id, FIFO, subscribe notification counts.
 *
 * Note: sessionGrants registration + policy-level approval is wired in
 * app.tsx; here we only assert the always signal reaches the host callback
 * (the contract seam must not drift).
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

/** Non-React assertion wait (promise settlement / callback counts). */
async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("until timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Wait for the ask promise to settle: must keep calling renderOnce while
 * waiting — mock stdin bytes are only parsed and dispatched during render
 * passes, so a bare await would never see the keys reach the handler. */
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
  // Note: never return the ask promise for the caller to await — awaiting
  // flattens Promise<Promise<boolean>> and dead-waits before keys land.
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
    // n can still reject afterwards (ignore does not pollute state).
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
    // modal dismissed: option rows gone, compat hint present.
    expect(setup.captureCharFrame()).not.toContain("总是允许（本会话）");
    expect(setup.captureCharFrame()).toContain("输入 y/a/n");
    // ask unresolved (host can still use the compat path before fail-closed).
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

  test("pending() 视图字段集 = {id, tool, summaryHint}（ADR-0097 单链批准面）", async () => {
    const bridge = createTuiAskUserBridge();
    const promise = bridge.ask(askCtx);
    const info = bridge.pending()!;
    // No second approval-axis field rewritten per input — the TUI render surface therefore has a single marker branch.
    expect(Object.keys(info).sort()).toEqual(["id", "summaryHint", "tool"]);
    expect(info.tool).toBe("bash");
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
    await expect(promise).resolves.toBe(false);
    expect(bridge.resolveAsk(id, true)).toBe(false);
  });

  test("an already-aborted signal does not enqueue a TUI ask", async () => {
    const bridge = createTuiAskUserBridge({ timeoutMs: 30 });
    const controller = new AbortController();
    controller.abort();

    const promise = bridge.ask({ ...askCtx, signal: controller.signal });

    expect(bridge.pendingCount()).toBe(0);
    await expect(promise).resolves.toBe(false);
  });

  test("one abort clears multiple pending TUI asks", async () => {
    const bridge = createTuiAskUserBridge({ timeoutMs: 1_000 });
    const controller = new AbortController();
    const promises = [1, 2, 3].map((n) =>
      bridge.ask({
        ...askCtx,
        tool: `tool-${n}`,
        signal: controller.signal,
      })
    );

    expect(bridge.pendingCount()).toBe(3);
    controller.abort();

    expect(bridge.pendingCount()).toBe(0);
    await expect(Promise.all(promises)).resolves.toEqual([false, false, false]);
  });

  test("approval that settles first wins a TUI abort race", async () => {
    const bridge = createTuiAskUserBridge({ timeoutMs: 1_000 });
    const controller = new AbortController();
    const promise = bridge.ask({ ...askCtx, signal: controller.signal });
    const id = bridge.pending()!.id;

    expect(bridge.resolveAsk(id, true)).toBe(true);
    controller.abort();

    await expect(promise).resolves.toBe(true);
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
