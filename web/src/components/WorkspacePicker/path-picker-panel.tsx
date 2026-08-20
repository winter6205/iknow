/**
 * serve-workspace T7a — WorkspacePicker 「选择路径新建工作空间」子 panel。
 *
 * review fix H3 / M4：把"路径输入 + 信任 toggle + bind 按钮 + 内嵌子目录
 * 浏览器"这一段独立面板从 WorkspacePicker 主文件抽出。父组件只负责
 * 折叠态 (showPathPicker) 与 placement；面板自身持有 input / confirming /
 * binding 状态。
 *
 * 行为契约：与原 picker 内联 panel 100% 等价 — 同样的 input / trust /
 * bind 控件，同样的 submit() 路径 (buildBindPayload → onBind → onClose /
 * onNotice)。
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

  // resolveBrowserRoot 在父组件已用过, 这里再次保险, 保持 panel 自洽。
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
