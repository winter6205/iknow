import { FOCUS_RING } from "../lib/ui";

export type WorkspaceChipProps = {
  readonly bound: boolean;
  readonly root: string | null;
  readonly onOpen: () => void;
};

/**
 * POSIX + Windows 兼容的 basename 提取。根目录（trim 后空串）原样返回：
 * "/" 这种"无 basename"输入在 chip 上展示成 "/"比空字符串更可读。
 */
export function basename(p: string): string {
  const trimmed = p.replace(/[/\\]+$/, "");
  if (trimmed === "") return p;
  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return idx < 0 ? trimmed : trimmed.slice(idx + 1);
}

/**
 * 顶栏右侧元数据簇：bound 态显示绑定根的 basename（点击重开 picker），
 * unbound 态显示警告色 CTA "选择工作空间"。两个态都用 button — 让 chip
 * 不仅是状态指示，也提供 picker 入口（避免再做一个 button）。
 */
export function WorkspaceChip({ bound, root, onOpen }: WorkspaceChipProps) {
  if (bound && root) {
    return (
      <button
        type="button"
        onClick={onOpen}
        title={`工作空间：${root}`}
        aria-label="工作空间已绑定，点击选择其他"
        className={`flex items-center gap-1.5 rounded-pill border border-ink-3/30 bg-surface px-2 py-1 font-mono text-[11px] text-ink-2 transition-colors duration-200 ease-[var(--ease-soft)] hover:border-ink-3 hover:text-ink ${FOCUS_RING}`}
      >
        <span aria-hidden="true">📁</span>
        <span className="max-w-[10rem] truncate">{basename(root)}</span>
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={onOpen}
      title="尚未绑定工作空间"
      aria-label="未绑定工作空间，点击选择"
      className={`flex items-center gap-1.5 rounded-pill border border-warn/40 bg-warn-soft px-2.5 py-1 text-[12px] font-medium text-warn transition-colors duration-200 ease-[var(--ease-soft)] hover:bg-warn hover:text-ink ${FOCUS_RING}`}
    >
      <span aria-hidden="true">⚠</span>
      <span>选择工作空间</span>
    </button>
  );
}
