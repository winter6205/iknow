/**
 * WorkspacePicker's 「选择路径新建工作空间」
 * ("choose a path to create a new workspace") sub-panel.
 *
 * Extracts this standalone panel — path input + trust
 * toggle + bind button + embedded subdir browser — out of the WorkspacePicker
 * main file. The parent owns only the collapsed state (showPathPicker) and
 * placement; the panel itself holds input / confirming / binding state.
 *
 * Same input / trust / bind controls, same submit() path (buildBindPayload →
 * onBind → onClose / onNotice).
 */
import { useState } from "react";
import { resolveBrowserRoot } from "../../lib/workspace-browser";
import { buildBindPayload } from "../WorkspacePicker";
import { WorkspaceBrowser } from "./workspace-browser";

export function PathPickerPanel({
  initialBase,
  initialInput,
  onBind,
  onClose,
  onNotice,
  onBrowseSubdirs,
}: {
  readonly initialBase: string;
  readonly initialInput: string;
  readonly onBind: (
    path: string,
    opts?: { confirmTrust?: boolean }
  ) => Promise<void>;
  readonly onClose: () => void;
  readonly onNotice: (text: string) => void;
  readonly onBrowseSubdirs: (
    root: string,
    signal?: AbortSignal
  ) => Promise<ReadonlyArray<import("../../api/client").WorkspaceSubdirEntry>>;
}) {
  const [input, setInput] = useState(initialInput);
  const [binding, setBinding] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const submit = async () => {
    const payload = buildBindPayload(input, confirming);
    if (!payload) return;
    setBinding(true);
    try {
      await onBind(payload.path, { confirmTrust: payload.confirmTrust });
      onClose();
    } catch (e) {
      onNotice(`绑定失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBinding(false);
      setConfirming(false);
    }
  };

  // resolveBrowserRoot was already applied by the parent; re-apply as a safety
  // net to keep the panel self-contained.
  const base = resolveBrowserRoot(initialBase);

  return (
    <div id="ws-path-picker-panel" className="mt-1">
      <div className="flex gap-1">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="/abs/path/to/project"
          aria-label="工作空间绝对路径"
          // After the popover mounts, the parent's useEffect focuses the
          // [data-ws-picker-autofocus="true"] anchor — when recents is empty this is
          // the first focus sink; when recents is non-empty but the user manually
          // expanded the path picker, focus may also land here (PathPickerPanel is
          // the target of a deliberate user action, so auto-focus is unsurprising).
          data-ws-picker-autofocus="true"
          className="min-w-0 flex-1 rounded-pill border border-ink-3/30 bg-surface px-2 py-1 font-mono text-[11px] outline-none focus:border-accent"
        />
        <button
          type="button"
          onClick={() => setConfirming((c) => !c)}
          title="首次绑定新绝对路径需先确认信任"
          aria-pressed={confirming}
          className={`rounded-pill px-2 py-1 text-[11px] ${confirming ? "bg-warn text-ink" : "text-ink-3 hover:text-ink"}`}
        >
          信任{confirming ? "✓" : ""}
        </button>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={binding || !input.trim()}
          className="rounded-pill bg-accent px-3 py-1 text-[11px] font-medium text-ink disabled:opacity-50"
        >
          {binding ? "绑定中…" : "绑定"}
        </button>
      </div>
      <WorkspaceBrowser
        initialBase={base}
        onPickSubdir={(p) => setInput(p)}
        onNotice={onNotice}
        onBrowseSubdirs={onBrowseSubdirs}
      />
    </div>
  );
}
