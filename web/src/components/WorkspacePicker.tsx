/**
 * WorkspacePicker popover shell.
 *
 * History: the file was 319 lines with two long methods (WorkspacePicker 122 /
 * WorkspaceBrowser 103). Extracted:
 *  - the recents list → `WorkspacePicker/recents-list.tsx`.
 *  - the path-picker sub-panel → `WorkspacePicker/path-picker-panel.tsx`.
 *  - the subdir browser (with Breadcrumbs / SubdirList) →
 *    `WorkspacePicker/workspace-browser.tsx`.
 *
 * The picker is a popover — the parent layer (ChatHeader / App)
 * anchors the popover shell at the WorkspaceChip's right (`absolute top-full
 * right-0 mt-1 z-50`). The shell owns only (a) the `role="dialog"` /
 * `aria-modal` / `aria-labelledby` trio (a11y red line) and (b) the embedded
 * PickerHeader + RecentsList + PathPickerPanel composition. RecentsList /
 * PathPickerPanel / WorkspaceBrowser are untouched (subcomponent contract
 * unchanged: recents onClick ends with `onClose()`; bind success also `onClose()`).
 *
 * pickRecent / submit / trust toggle contracts unchanged: the spec rule
 * "switch root = new session" is handled by App-layer handleCreateInWorkspace
 * (this shell only binds, never newSession — aligned with default resolution B).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { resolveBrowserRoot } from "../lib/workspace-browser";
import type { WorkspaceSubdirEntry } from "../api/client";
import { PathPickerPanel } from "./WorkspacePicker/path-picker-panel";
import { RecentsList } from "./WorkspacePicker/recents-list";

export type { WorkspaceBrowserProps } from "./WorkspacePicker/workspace-browser";

export type WorkspacePickerProps = {
  readonly recents: ReadonlyArray<string>;
  readonly currentRoot: string | null;
  readonly onBind: (
    path: string,
    opts?: { confirmTrust?: boolean }
  ) => Promise<void>;
  readonly onClose: () => void;
  readonly onNotice: (text: string) => void;
  /**
   * Subdir prober. Injected rather than importing api so
   * tests can stub it via vi.stubGlobal("fetch"). Browse failures (422 /
   * network) throw through the `SessionApiError` channel; caught here →
   * onNotice, never blocking bind.
   */
  readonly onBrowseSubdirs: (
    root: string,
    signal?: AbortSignal
  ) => Promise<ReadonlyArray<WorkspaceSubdirEntry>>;
};

/**
 * Build the bind request payload (empty / whitespace-only input → null;
 * shared by unit tests and the component).
 */
export function buildBindPayload(
  input: string,
  confirming: boolean
): { path: string; confirmTrust: boolean } | null {
  const path = input.trim();
  if (!path) return null;
  return { path, confirmTrust: confirming };
}

/**
 * Bind payload for a recents list-item click. Recents come
 * from `GET /api/v1/workspaces`, all trusted roots — no second trust confirmation needed.
 */
export function pickRecentForBind(root: string): {
  path: string;
  confirmTrust: boolean;
} {
  return { path: root, confirmTrust: false };
}

/**
 * WorkspacePicker popover title — the aria-labelledby anchor. `sr-only` keeps
 * the title reachable to screen readers without taking visual space for sighted users.
 */
const POPOVER_TITLE_ID = "workspace-picker-title";

/**
 * WorkspacePicker popover shell — the trio (role / aria-modal / aria-labelledby) +
 * PickerHeader + RecentsList + PathPickerPanel two-level collapse.
 *
 * With recents.length === 0 the path picker starts expanded
 * (first-run guidance); with recents non-empty it stays collapsed until the user
 * clicks the CTA.
 *
 * Mount behavior: auto-open lives in App-layer useWorkspaceActions;
 * setWorkspaceOpen(true) mounts this shell. The shell's `useEffect` moves focus
 * to the first focusable element (first recents item / path input, one of the
 * two), satisfying the a11y rule "after auto-open, focus enters the popover".
 */
export function WorkspacePicker(props: WorkspacePickerProps) {
  const initialBase = resolveBrowserRoot(props.currentRoot);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const [showPathPicker, setShowPathPicker] = useState(
    props.recents.length === 0
  );

  // Auto-focus the first item on mount (auto-open path). Non-empty
  // recents → first recent button; empty recents → path picker input. Effect
  // fires synchronously (queueMicrotask instead of setTimeout 0 to avoid
  // timing sensitivity in tests).
  useEffect(() => {
    const root = dialogRef.current;
    if (!root) return;
    queueMicrotask(() => {
      const target = root.querySelector<HTMLButtonElement | HTMLInputElement>(
        '[data-ws-picker-autofocus="true"]'
      );
      target?.focus();
    });
  }, []);

  // Focus trap — Tab cycles inside the popover.
  // - Focus ownership: WorkspacePicker owns the trap (it contains the visible
  //   focusable elements); usePopoverDismiss owns Esc / outside-click /
  //   focus-return (see use-workspace-actions.ts comments). Clear split of duties.
  // - aria-modal="true" stays: the file declares modality, the trap is real behavior.
  // - Implementation: keydown on the dialog, intercepted only for key === "Tab";
  //   querySelectorAll finds tabbable elements, wrapping focus at the edges.
  // - `tabbable` selector: native focusables + children explicitly opened via
  //   [tabindex]. `<button>` / `<input>` are tabbable by default; disabled ones are not.
  const handleDialogKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key !== "Tab") return;
    const root = dialogRef.current;
    if (!root) return;
    const tabbable = Array.from(
      root.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )
    ).filter((el) => !el.hasAttribute("disabled") && el.tabIndex !== -1);
    if (tabbable.length === 0) return;
    const first = tabbable[0]!;
    const last = tabbable[tabbable.length - 1]!;
    const active = document.activeElement;
    if (e.shiftKey) {
      if (active === first || !root.contains(active)) {
        e.preventDefault();
        last.focus();
      }
    } else {
      if (active === last || !root.contains(active)) {
        e.preventDefault();
        first.focus();
      }
    }
  }, []);

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={POPOVER_TITLE_ID}
      onKeyDown={handleDialogKeyDown}
      // Popover shell — the parent layer (App/ChatHeader) wraps this component
      // with `absolute top-full right-0 mt-1 z-50`; the shell itself handles only content + border + shadow.
      className="w-[22rem] max-w-[calc(100vw-2rem)] border border-line bg-surface text-[12px] text-ink-2 shadow-bubble"
    >
      <h2 id={POPOVER_TITLE_ID} className="sr-only">
        工作空间选择
      </h2>
      <div className="border-b border-ink-3/30 bg-surface px-3 py-2">
        <PickerHeader onClose={props.onClose} />
      </div>
      <div className="px-3 py-2">
        <RecentsList
          recents={props.recents}
          currentRoot={props.currentRoot}
          onBind={props.onBind}
          onClose={props.onClose}
        />
        <PathPickerToggle
          expanded={showPathPicker}
          onToggle={() => setShowPathPicker((s) => !s)}
        />
        {showPathPicker ? (
          <PathPickerPanel
            initialBase={initialBase}
            initialInput={props.currentRoot ?? ""}
            onBind={props.onBind}
            onClose={props.onClose}
            onNotice={props.onNotice}
            onBrowseSubdirs={props.onBrowseSubdirs}
          />
        ) : null}
      </div>
    </div>
  );
}

/**
 * WorkspacePicker top row: title + close button. Stateless pure display.
 */
function PickerHeader({ onClose }: { onClose: () => void }) {
  return (
    <div className="flex items-center justify-between">
      <span className="font-medium text-ink">选择工作空间根</span>
      <button type="button" className="text-ink-3" onClick={onClose}>
        关闭
      </button>
    </div>
  );
}

/** 「选择路径新建工作空间」("choose a path to create a new workspace") collapsed CTA — controls the path picker's expanded state. */
function PathPickerToggle({
  expanded,
  onToggle,
}: {
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-expanded={expanded}
      aria-controls="ws-path-picker-panel"
      onClick={onToggle}
      className="mt-2 flex items-center gap-1 text-ink-3 hover:text-ink"
    >
      <span aria-hidden="true">{expanded ? "▾" : "▸"}</span>
      <span>选择路径新建工作空间</span>
    </button>
  );
}
