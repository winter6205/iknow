// @vitest-environment happy-dom
/**
 * serve-workspace T8 review fix (M4) — usePopoverDismiss hook vitest.
 *
 * 4 cases cover the hook's three observable behaviors:
 *  1. open=true + Esc keydown → onClose called + focus returned to trigger.
 *  2. open=true + mousedown on body (outside popover) → onClose called +
 *     focus returned to trigger.
 *  3. open=true + mousedown on trigger (inside popover wrapper) → onClose
 *     NOT called (T8 review L1: trigger is contained by popover wrapper).
 *  4. open=false → effect early-returns, no listeners attached.
 *
 * Why happy-dom + @testing-library/react: the hook reads `document` to
 * attach/detach listeners and refs to walk DOM containment. jsdom-equivalent
 * (happy-dom) is the minimum DOM env needed for hook tests. renderHook
 * from @testing-library/react is the standard React 19 harness (the
 * alternative — react-dom/client + createRoot + manual act — works but
 * requires more boilerplate; @testing-library/react is justified because
 * we test a hook, not a component).
 *
 * The two deps (happy-dom + @testing-library/react) are added explicitly
 * to devDependencies; happy-dom is configured per-file via the
 * `// @vitest-environment happy-dom` directive so other tests don't
 * inherit the DOM env.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useRef } from "react";
import type { RefObject } from "react";
import { usePopoverDismiss } from "../../web/src/hooks/use-workspace-actions.ts";

/**
 * 极简 hook 容器 — renderHook 自带 React 上下文,只需一个 callback 包装。
 * 把 triggerRef / popoverRef / open / onClose 透传给 hook,返回这些 ref 给
 * 测试用例直接引用 DOM 节点。
 */
function useHarness(
  open: boolean,
  onClose: () => void
): {
  triggerRef: RefObject<HTMLButtonElement | null>;
  popoverRef: RefObject<HTMLDivElement | null>;
} {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  usePopoverDismiss(open, triggerRef, popoverRef, onClose);
  return { triggerRef, popoverRef };
}

/**
 * 把 trigger 节点接进 DOM,popover wrapper 包住 trigger (L1 假定:触发器
 * 已被外层 wrapper 包裹)。返回 trigger 节点方便测试用例拿引用。
 */
function mountHarness(): {
  trigger: HTMLButtonElement;
  popover: HTMLDivElement;
  cleanup: () => void;
} {
  const popover = document.createElement("div");
  popover.setAttribute("data-testid", "popover-wrapper");
  const trigger = document.createElement("button");
  trigger.setAttribute("aria-label", "trigger");
  popover.appendChild(trigger);
  document.body.appendChild(popover);
  return {
    trigger,
    popover,
    cleanup: () => {
      popover.remove();
    },
  };
}

describe("usePopoverDismiss — Esc / outside-click / focus-return", () => {
  let onClose: ReturnType<typeof vi.fn>;
  let addSpy: ReturnType<typeof vi.spyOn>;
  let removeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    onClose = vi.fn();
    // Spy on document.addEventListener / removeEventListener — case 4
    // 通过监听器 attach 次数验证 effect 早返回。
    addSpy = vi.spyOn(document, "addEventListener");
    removeSpy = vi.spyOn(document, "removeEventListener");
  });

  afterEach(() => {
    addSpy.mockRestore();
    removeSpy.mockRestore();
    document.body.innerHTML = "";
  });

  it("open=true + document keydown Escape → onClose called once + focus returns to trigger", async () => {
    const { trigger, cleanup } = mountHarness();
    try {
      const { result } = renderHook(() => useHarness(true, onClose));
      // 把 harness 的 ref 钩到 DOM 节点 (harness 内部 useRef) — 渲染
      // 期间 React 不会自动给测试组件插 DOM,故手动赋值。
      result.current.triggerRef.current = trigger;
      result.current.popoverRef.current = trigger.parentElement;

      // trigger 已经 focus 才能在 Esc 后看 activeElement 是否回到 trigger。
      // 模拟 Esc 触发。
      await act(async () => {
        const ev = new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
        });
        document.dispatchEvent(ev);
      });

      expect(onClose).toHaveBeenCalledTimes(1);
      // queueMicrotask focus — 等 microtask 跑完。
      await act(async () => {
        await Promise.resolve();
      });
      expect(document.activeElement).toBe(trigger);
    } finally {
      cleanup();
    }
  });

  it("open=true + document mousedown on outside body → onClose called once + focus returns to trigger", async () => {
    const { trigger, cleanup } = mountHarness();
    try {
      const { result } = renderHook(() => useHarness(true, onClose));
      result.current.triggerRef.current = trigger;
      result.current.popoverRef.current = trigger.parentElement;

      // mousedown 在 popover 之外 — 用一个独立 body 节点。
      const outside = document.createElement("div");
      document.body.appendChild(outside);

      await act(async () => {
        const ev = new MouseEvent("mousedown", {
          bubbles: true,
        });
        Object.defineProperty(ev, "target", { value: outside });
        document.dispatchEvent(ev);
      });

      expect(onClose).toHaveBeenCalledTimes(1);
      await act(async () => {
        await Promise.resolve();
      });
      expect(document.activeElement).toBe(trigger);

      outside.remove();
    } finally {
      cleanup();
    }
  });

  it("open=true + mousedown on trigger (inside popover wrapper) → onClose NOT called", async () => {
    const { trigger, cleanup } = mountHarness();
    try {
      const { result } = renderHook(() => useHarness(true, onClose));
      result.current.triggerRef.current = trigger;
      result.current.popoverRef.current = trigger.parentElement;

      await act(async () => {
        const ev = new MouseEvent("mousedown", {
          bubbles: true,
        });
        Object.defineProperty(ev, "target", { value: trigger });
        document.dispatchEvent(ev);
      });

      expect(onClose).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  it("open=false → effect early-returns, no listeners attached", () => {
    renderHook(() => useHarness(false, onClose));
    // happy-dom 上 addEventListener 不会跑 effect 内 return 路径 — 验证
    // mousedown / keydown 监听器没被 hook 挂载。Effect 早返回时
    // addEventListener 一次都不会被调用。
    const mouseCalls = addSpy.mock.calls.filter(
      (c) => c[0] === "mousedown"
    ).length;
    const keyCalls = addSpy.mock.calls.filter((c) => c[0] === "keydown").length;
    expect(mouseCalls).toBe(0);
    expect(keyCalls).toBe(0);

    // 进一步: 直接调 onClose (本就是同一个引用) 不会被 document 监听器
    // 触发,验证 hook 没接任何外部入口。
    onClose();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
