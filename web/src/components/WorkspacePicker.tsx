/**
 * serve-workspace T5/T7a — WorkspacePicker orchestrator (review fix slimming)。
 *
 * 历史: 该文件原 319 行, WorkspacePicker 122 行 / WorkspaceBrowser 103 行,
 * 两个长方法 (H3 / M4)。T7a 把:
 *  - recents 列表抽到 `WorkspacePicker/recents-list.tsx`。
 *  - path picker 子面板抽到 `WorkspacePicker/path-picker-panel.tsx`。
 *  - 子目录浏览器 (含 Breadcrumbs / SubdirList 子组件) 抽到
 *    `WorkspacePicker/workspace-browser.tsx`。
 *
 * 本文件保留纯逻辑 (`buildBindPayload` / `pickRecentForBind`) 与
 * orchestrator (`WorkspacePicker` 顶层 composition — 折叠态 + placement),
 * 由其 <30 行。WorkspaceBrowser 的导出挪到子目录文件里, 这里仅 re-export
 * 以保证外部 import 路径稳定。
 */
import { useState } from "react";
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
   * serve-workspace T3: 子目录探测器。注入而非 import api, 让 Picker
   * 在测试里能用 vi.stubGlobal("fetch") 顶替。browse 失败 (422 / network)
   * 按 `SessionApiError` 通道抛出, 此处 catch → onNotice, 不阻塞 bind。
   */
  readonly onBrowseSubdirs: (
    root: string,
    signal?: AbortSignal
  ) => Promise<ReadonlyArray<WorkspaceSubdirEntry>>;
};

/**
 * 绑定请求载荷构造（空/纯空白输入 → null；供单测与组件共享）。
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
 * serve-workspace T5: recents 列表项点击的 bind 载荷。recents 来自
 * `GET /api/v1/workspaces`, 全部为已信任根, 无需再走 trust 二次确认。
 */
export function pickRecentForBind(root: string): {
  path: string;
  confirmTrust: boolean;
} {
  return { path: root, confirmTrust: false };
}

/**
 * WorkspacePicker 顶部行：标题 + 关闭按钮。无状态纯展示。
 */
function PickerHeader({ onClose }: { onClose: () => void }) {
  return (
    <div className="mb-2 flex items-center justify-between">
      <span className="font-medium text-ink">选择工作空间根</span>
      <button type="button" className="text-ink-3" onClick={onClose}>
        关闭
      </button>
    </div>
  );
}

/** 「选择路径新建工作空间」折叠 CTA — 控制 path picker 展开态。 */
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

/**
 * WorkspacePicker 顶层 composition — recents / path picker 二级折叠 + 关闭。
 */
export function WorkspacePicker(props: WorkspacePickerProps) {
  const initialBase = resolveBrowserRoot(props.currentRoot);
  const [showPathPicker, setShowPathPicker] = useState(
    props.recents.length === 0
  );
  return (
    <div className="border-b border-ink-3/30 bg-surface px-3 py-2 text-[12px]">
      <PickerHeader onClose={props.onClose} />
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
  );
}
