/**
 * Hoist App-layer workspace handlers into one hook
 * so ChatApp's main file converges to ≤ 200 lines:
 *  - `handleNewSession`: unbound → open the picker; bound → newSession + bumpSidebar.
 *  - `handleCreateInWorkspace`: rebind root + newSession; failures go to chat.pushNotice.
 *  - `handleSelect`: switch to the target session + bumpSidebar.
 *
 * With auto-binding of the default workspace on entry, `ws.bound`
 * is always truthy, so the earlier `autoOpenedRef` + one-shot effect became dead code
 * and was removed. The unbound branch in `handleNewSession` stays — it still
 * guides the picker after a rare manual unbind.
 *
 * Popover dismissal (Esc / outside-click) + focus-return to the chip live
 * in the separate `usePopoverDismiss` hook so this file's body only concerns
 * the handler trio.
 *
 * Behavioral contract: 100% equivalent to the original inline handlers; only the carrier changed.
 */
import type { Dispatch, RefObject, SetStateAction } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { useSessionChat } from "./useSessionChat";
import type { useWorkspace } from "./useWorkspace";

type ChatApi = ReturnType<typeof useSessionChat>;
type WsApi = ReturnType<typeof useWorkspace>;

export type UseWorkspaceActionsResult = {
  /** Picker visibility — shared by the CTA / chip / /workspace entry points. */
  readonly workspaceOpen: boolean;
  /**
   * Open / close the picker. The parameter is React's
   * `SetStateAction<boolean>`, accepting both `true` / `false` and the
   * `(prev) => !prev` toggle form (needed by the second-click-on-chip behavior).
   */
  readonly setWorkspaceOpen: Dispatch<SetStateAction<boolean>>;
  /** Sidebar list refresh signal — bumped after lifecycle events. */
  readonly sidebarSignal: number;
  readonly bumpSidebar: () => void;
  /** Create a new session: unbound guides the picker; bound goes straight to newSession + bumpSidebar. */
  readonly handleNewSession: () => Promise<void>;
  /** Sidebar group-header "+" button: create a session inside the given workspace. */
  readonly handleCreateInWorkspace: (root: string) => Promise<void>;
  /** Sidebar session switch. */
  readonly handleSelect: (id: string) => Promise<void>;
};

/**
 * The popover-dismiss effect trio.
 *
 *  - `open === false` → the effect returns early: no listeners, no focus grabs.
 *  - `open === true`:
 *      a. document `mousedown` — a hit outside the popover → close + focus trigger.
 *      b. document `keydown` — Esc → close + focus trigger.
 *
 * Independent of the picker child's own onClick / onKeyDown — the popover
 * embeds no focus trap (low coupling) and only triggers dismissal. focus-return
 * happens in the effect (avoiding React 18 warnings from focusing during render).
 *
 * a11y red line: after Esc closes, focus must return to the trigger (chip
 * button) so keyboard users can keep operating the page (spec a11y red line).
 *
 * A parent-inline `onClose` is a new closure each render;
 * placing it in deps would re-attach the effect every render (mousedown +
 * keydown × 2 listeners). Wrap it in a ref and call ref.current() in the
 * handlers — deps converge to `[open, triggerRef, popoverRef]`, safe for
 * stable-identity memo consumers.
 *
 * The trigger (chip) is already wrapped by the outer popover
 * container (ChatHeader's `<div ref={workspacePopoverRef}>` wraps chip +
 * popover together), so the trigger.contains check is fully subsumed by
 * popover.contains — removed to shrink the surface. Callers must preserve
 * that containment (as this App does).
 */
export function usePopoverDismiss(
  open: boolean,
  triggerRef: RefObject<HTMLElement | null>,
  popoverRef: RefObject<HTMLElement | null>,
  onClose: () => void
): void {
  // Wrap onClose in a ref — handlers always read the latest closure while
  // the effect itself never depends on its identity, avoiding re-attach.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const handleMouseDown = (e: MouseEvent) => {
      const target = e.target;
      if (!(target instanceof Node)) return;
      // The trigger is contained by popoverRef (see the App.tsx ref
      // topology); the triggerRef.contains check was removed to shrink the
      // surface, behavior equivalent.
      if (popoverRef.current?.contains(target)) return;
      onCloseRef.current();
      // Return focus to the trigger on the next tick, avoiding an ordering
      // conflict with mouseup.
      queueMicrotask(() => triggerRef.current?.focus());
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onCloseRef.current();
      queueMicrotask(() => triggerRef.current?.focus());
    };
    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, triggerRef, popoverRef]);
}

export function useWorkspaceActions(
  chat: ChatApi,
  ws: WsApi
): UseWorkspaceActionsResult {
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [sidebarSignal, setSidebarSignal] = useState(0);
  const bumpSidebar = useCallback(() => setSidebarSignal((n) => n + 1), []);

  /**
   * Clicking "new session" while unbound opens the picker to guide
   * root selection (spec: unbound cannot send a turn). With entry auto-bind,
   * ws.bound defaults to truthy, so this fires only after a manual
   * unbind — a minority path but still meaningful, so kept.
   * ws.bound: the backend hub.createSession takes this.boundRoot (= ws.root)
   * for the new session, so no extra workspaceRoot parameter is needed
   * (backend extension point).
   */
  const handleNewSession = useCallback(async () => {
    if (!ws.bound) {
      setWorkspaceOpen(true);
      return;
    }
    await chat.newSession();
    bumpSidebar();
  }, [chat, bumpSidebar, ws.bound]);

  /**
   * Sidebar group-header "+" callback — create a session inside the given
   * workspace. Flow: bind to the target root first, then newSession; the
   * backend createSession writes this.boundRoot into the new session.
   * Failures fall back to chat.pushNotice.
   */
  const handleCreateInWorkspace = useCallback(
    async (root: string) => {
      try {
        if (!ws.bound || ws.root !== root) {
          // Group roots are read from existing session files, so they are
          // always trusted — no confirmTrust needed. bindWorkspace also always
          // succeeds when recentsHome is absent (legacy).
          await ws.bind(root);
        }
        await chat.newSession();
        bumpSidebar();
      } catch (e) {
        chat.pushNotice(
          `在 ${root} 内新建会话失败：${
            e instanceof Error ? e.message : String(e)
          }`
        );
      }
    },
    [chat, ws, bumpSidebar]
  );

  /**
   * Sidebar session switch. setConversation may switch to a session not yet in
   * the cached list (e.g. just-created entries still propagating); refresh
   * sidebar to be safe.
   */
  const handleSelect = useCallback(
    async (id: string) => {
      await chat.setConversation(id);
      bumpSidebar();
    },
    [chat, bumpSidebar]
  );

  return {
    workspaceOpen,
    setWorkspaceOpen,
    sidebarSignal,
    bumpSidebar,
    handleNewSession,
    handleCreateInWorkspace,
    handleSelect,
  };
}
