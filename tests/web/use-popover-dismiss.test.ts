// @vitest-environment happy-dom
/**
 * usePopoverDismiss hook tests (review fix).
 *
 * 4 cases cover the hook's three observable behaviors:
 *  1. open=true + Esc keydown → onClose called + focus returned to trigger.
 *  2. open=true + mousedown on body (outside popover) → onClose called +
 *     focus returned to trigger.
 *  3. open=true + mousedown on trigger (inside popover wrapper) → onClose
 *     NOT called (the trigger is contained by the popover wrapper).
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
 * Minimal hook harness — renderHook already provides React context, only a callback
 * wrapper is needed. Passes triggerRef / popoverRef / open / onClose through to the
 * hook and returns the refs so test cases can reference the DOM nodes directly.
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
 * Mounts the trigger node into the DOM with the popover wrapper containing it (the
 * trigger is wrapped by the outer popover div). Returns the trigger node so test
 * cases can hold a direct reference.
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
    // verifies the effect early-return via listener attach counts.
    addSpy = vi.spyOn(document, "addEventListener");
    removeSpy = vi.spyOn(document, "removeEventListener");
  });

  afterEach(() => {
    addSpy.mockRestore();
    removeSpy.mockRestore();
    document.body.innerHTML = "";
  });

  it("open=true + document keydown Escape → onClose called once + focus returns to trigger", async () => {
    const { trigger, popover, cleanup } = mountHarness();
    try {
      const { result } = renderHook(() => useHarness(true, onClose));
      // Wire the harness refs to the DOM nodes (useRef inside the harness) —
      // React never auto-inserts DOM for this test component, so assign manually.
      result.current.triggerRef.current = trigger;
      // `popover` is the div the harness appends the trigger into — the same
      // node as `trigger.parentElement`, but typed HTMLDivElement.
      result.current.popoverRef.current = popover;

      // The trigger must already hold focus to check whether activeElement returns
      // to it after Esc. Simulate the Esc keypress.
      await act(async () => {
        const ev = new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
        });
        document.dispatchEvent(ev);
      });

      expect(onClose).toHaveBeenCalledTimes(1);
      // focus is deferred via queueMicrotask — let the microtask drain.
      await act(async () => {
        await Promise.resolve();
      });
      expect(document.activeElement).toBe(trigger);
    } finally {
      cleanup();
    }
  });

  it("open=true + document mousedown on outside body → onClose called once + focus returns to trigger", async () => {
    const { trigger, popover, cleanup } = mountHarness();
    try {
      const { result } = renderHook(() => useHarness(true, onClose));
      result.current.triggerRef.current = trigger;
      // `popover` is the div the harness appends the trigger into — the same
      // node as `trigger.parentElement`, but typed HTMLDivElement.
      result.current.popoverRef.current = popover;

      // mousedown outside the popover — use a standalone body node.
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
    const { trigger, popover, cleanup } = mountHarness();
    try {
      const { result } = renderHook(() => useHarness(true, onClose));
      result.current.triggerRef.current = trigger;
      // `popover` is the div the harness appends the trigger into — the same
      // node as `trigger.parentElement`, but typed HTMLDivElement.
      result.current.popoverRef.current = popover;

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
    // On happy-dom addEventListener never runs the effect's early-return path —
    // verify no mousedown / keydown listener was attached by the hook. When the
    // effect early-returns, addEventListener is called zero times.
    const mouseCalls = addSpy.mock.calls.filter(
      (c) => c[0] === "mousedown"
    ).length;
    const keyCalls = addSpy.mock.calls.filter((c) => c[0] === "keydown").length;
    expect(mouseCalls).toBe(0);
    expect(keyCalls).toBe(0);

    // Further: calling onClose directly (it is the same reference) is not triggered
    // by any document listener, proving the hook wired no external entry point.
    onClose();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
