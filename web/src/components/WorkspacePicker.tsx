/**
 * serve-workspace T8 — WorkspacePicker 改成 popover shell。
 *
 * 历史: 该文件原 319 行, WorkspacePicker 122 行 / WorkspaceBrowser 103 行,
 * 两个长方法 (H3 / M4)。T7a 把:
 *  - recents 列表抽到 `WorkspacePicker/recents-list.tsx`。
 *  - path picker 子面板抽到 `WorkspacePicker/path-picker-panel.tsx`。
 *  - 子目录浏览器 (含 Breadcrumbs / SubdirList 子组件) 抽到
 *    `WorkspacePicker/workspace-browser.tsx`。
 *
 * T8 review: picker 改 popover — 父层 (ChatHeader / App) 把 popover shell
 * 锚定在 WorkspaceChip 右侧 (`absolute top-full right-0 mt-1 z-50`)。
 * shell 只负责 (a) `role="dialog"` / `aria-modal` / `aria-labelledby`
 * 三件套 (a11y 红线) 与 (b) 内嵌 PickerHeader + RecentsList + PathPickerPanel
 * composition。RecentsList / PathPickerPanel / WorkspaceBrowser 完全不重写
 * (T7a 子组件契约不变: recents onClick 末尾 `onClose()`, bind 成功也
 * `onClose()`)。
 *
 * pickRecent / submit / trust toggle 三条契约不变: spec §Commands 5 "换根 =
 * 新会话" 由 App 层 handleCreateInWorkspace 负责 (本 shell 只 bind 不 newSession,
 * 与默认决议 B 对齐)。
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
 * WorkspacePicker popover 标题 — a11y labelledby 锚点。`sr-only` 让
 * 标题对屏幕阅读器可达，对 sighted 用户不占视觉空间。
 */
const POPOVER_TITLE_ID = "workspace-picker-title";

/**
 * WorkspacePicker popover shell — 三件套 (role / aria-modal / aria-labelledby) +
 * PickerHeader + RecentsList + PathPickerPanel 二级折叠。
 *
 * T5 既有行为: recents.length === 0 时 path picker 默认展开 (用户首次引导)；
 * recents 非空时 path picker 折叠, 由用户点 CTA 展开。
 *
 * T8 mount 行为: auto-open (T5) 在 App 层 useWorkspaceActions 里, setWorkspaceOpen(true)
 * 触发本 shell 挂载。本 shell 的 `useEffect` 把焦点送到第一个可聚焦元素
 * (recents 首项 / path input 二选一), 满足 a11y "auto-open 后焦点进 popover"。
 */
export function WorkspacePicker(props: WorkspacePickerProps) {
  const initialBase = resolveBrowserRoot(props.currentRoot);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const [showPathPicker, setShowPathPicker] = useState(
    props.recents.length === 0
  );

  // T8 a11y: 挂载后第一项自动 focus (auto-open 路径)。recents 非空 → 首项
  // recent button; recents 空 → path picker input。Effect 同步触发
  // (queueMicrotask 替代 setTimeout 0, 避免测试时间敏感)。
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

  // M2 (review fix): focus trap — Tab 在 popover 内循环。
  // - 焦点所有权: WorkspacePicker 拥有 trap (里头有可见的 focusable 元素);
  //   usePopoverDismiss 拥有 Esc / outside-click / focus-return (见
  //   use-workspace-actions.ts 注释)。两者职责分明。
  // - aria-modal="true" 保留: 文件声明模态,trap 是真实行为。
  // - 实现: 在 dialog 上挂 keydown,仅 key === "Tab" 时拦截;读 row.querySelectorAll
  //   找 tabbable 元素,焦点在边缘时回卷。
  // - `tabbable` 选择器: 匹配 native focusable + 通过 [tabindex] 显式打开的子节点。
  //   `<button>` / `<input>` 默认 tabbable,disabled 不算。
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
      // Popover shell — 父层 (App/ChatHeader) 用 `absolute top-full right-0 mt-1 z-50`
      // 包本组件, shell 自身只管内容 + 边框 + shadow。
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
 * WorkspacePicker 顶部行：标题 + 关闭按钮。无状态纯展示。
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
