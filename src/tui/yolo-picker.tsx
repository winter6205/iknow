/**
 * src/tui/yolo-picker.tsx
 *
 * T5 (specs/yolo-mode.md / ADR-0119): the pure-content module for the `/yolo`
 * **entry** confirmation modal. Same discipline as rewind-picker.tsx: no React,
 * no state — the content projection (yoloEnterConfirmContent), the row
 * accounting (yoloModalRows) and the key routing (reduceYoloConfirmKey) are all
 * pure functions; the state host lives in app.tsx (yoloConfirming:
 * undefined = closed / true = entry confirmation).
 *
 * The asymmetry between directions is deliberate (ADR-0119 ruling 6 + the lock
 * table): **only entry passes through the confirmation modal** (dangerous
 * operation — the fence retires wholesale, and the copy carries the "dangerous
 * operation" wording the plan requires); **exit is immediate**, no modal (leaving
 * is always safe; a refused probe comes back from the controller as ok:false +
 * notice with zero state change). The selected index is always 0: the reducer
 * does not consume ↑↓ (same as the rewind confirm state), and Esc is the key
 * channel for the "cancel" option.
 */
import {
  selectModalRows,
  type ModalKeyEvent,
  type SelectModalContent,
} from "./modal.js";

/**
 * Content of the entry confirmation modal (one SSOT for rendering and row
 * accounting) — dangerous operation: the no-sandbox consequences and how to get
 * back. Key path: Enter -> controller.enter(),
 * Esc -> close the panel with zero change.
 */
export function yoloEnterConfirmContent(): SelectModalContent {
  return {
    title: "启用 yolo 模式？",
    description:
      "危险操作：沙箱围栏将整体退场——bash 不再经 bwrap，网络与文件系统不受限。/yolo 即时退出并恢复进入前快照。",
    options: [
      { value: "execute", label: "启用 yolo" },
      { value: "cancel", label: "取消" },
    ],
    hint: "Enter 确认启用 · Esc 取消",
  };
}

/**
 * Rows the entry confirmation modal occupies (consumed by the chrome row
 * accounting modalRowsForBudget, same shape as rewindModalRows). The selected
 * index is always 0 (the modal has a confirm state only, no selection state).
 */
export function yoloModalRows(cols: number): number {
  return selectModalRows(yoloEnterConfirmContent(), cols, 0);
}

/** Key-routing decision of the confirmation modal (consumed by the host useKeyboard). */
export type YoloKeyAction = "execute" | "cancel" | "ignore";

/**
 * Pure key routing for the confirmation modal (unit-testable). The guard order
 * matches reduceRewindKey's confirm state exactly: ctrl/meta combinations checked
 * first (so app-level keys like Ctrl+C/O are not swallowed) → Esc = cancel →
 * Enter = execute; everything else (including ↑↓ — a confirm state has no
 * selection semantics) is ignore.
 */
export function reduceYoloConfirmKey(event: ModalKeyEvent): YoloKeyAction {
  const { key } = event;
  if (key.ctrl || key.meta) return "ignore";
  if (key.escape) return "cancel";
  if (key.return) return "execute";
  return "ignore";
}
