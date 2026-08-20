import type { Ref } from "react";
import { FOCUS_RING } from "../lib/ui";

export type WorkspaceChipProps = {
  /** ws.bound (per-root pick) — 兜底态：未绑定 / 刚换根但 session 还没 refresh。 */
  readonly bound: boolean;
  /** ws.bound 当前根；与 bound 联动。 */
  readonly root: string | null;
  /**
   * serve-workspace T8: 当前 active session 的 workspaceRoot（来自
   * session-list look-up by currentConversationId）。优先级最高 — 一旦
   * 用户切到了一个工作空间, chip 就显示该会话所在的根名, 不再退到
   * unbound 警告色。
   *
   * 显式接受 string | null | undefined: 后端 schema 里 workspaceRoot
   * 是 Postel 加性字段（legacy 文件可缺席 → undefined），UI 层空串 / undefined
   * 同视为「未知」走兜底。
   */
  readonly activeWorkspaceRoot?: string | null;
  readonly onOpen: () => void;
  /**
   * serve-workspace T8: 父层传 chip button ref — popover 关闭时焦点回
   * trigger (a11y 红线: Esc / outside-click 关后焦点必须回到 chip)。
   */
  readonly buttonRef?: Ref<HTMLButtonElement>;
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
 * 顶栏右侧元数据簇（serve-workspace T8 chip awareness）：
 *
 * 显示优先级（高 → 低）：
 *  1. `activeWorkspaceRoot` 非空 → 该 basename + folder icon（folder
 *     color, ink-2, hover 高亮 ink-3），整体保持 current bound 形态。
 *     用户切到了一个工作空间内的会话，chip 即反映会话所在根 — 不再
 *     退到 unbound 警告色（用户反馈 "应该是在那个位置, 显示当前工作
 *     空间的名字"）。
 *  2. 否则 `bound && root` → `basename(root)`（同上视觉），picker 还没
 *     拿到 active session 数据时的兜底态（例如刚绑定还没刷新 list）。
 *  3. 否则 → 警告色 CTA "选择工作空间"（unbound）。
 *
 * 三态都用 `<button>`：chip 既是状态指示，也是 picker 触发入口。
 */
export function WorkspaceChip({
  bound,
  root,
  activeWorkspaceRoot,
  onOpen,
  buttonRef,
}: WorkspaceChipProps) {
  const activeRoot =
    activeWorkspaceRoot && activeWorkspaceRoot.length > 0
      ? activeWorkspaceRoot
      : null;
  const displayRoot = activeRoot ?? (bound && root ? root : null);
  if (displayRoot) {
    return (
      <button
        ref={buttonRef}
        type="button"
        onClick={onOpen}
        title={`工作空间：${displayRoot}`}
        aria-label="工作空间已绑定，点击选择其他"
        className={`flex items-center gap-1.5 rounded-pill border border-ink-3/30 bg-surface px-2 py-1 font-mono text-[11px] text-ink-2 transition-colors duration-200 ease-[var(--ease-soft)] hover:border-ink-3 hover:text-ink ${FOCUS_RING}`}
      >
        <span aria-hidden="true">📁</span>
        <span className="max-w-[10rem] truncate">{basename(displayRoot)}</span>
      </button>
    );
  }
  return (
    <button
      ref={buttonRef}
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
