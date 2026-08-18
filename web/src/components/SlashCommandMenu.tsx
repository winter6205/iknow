/**
 * web/src/components/SlashCommandMenu.tsx
 *
 * Composer 输入框上方的 slash 命令补全菜单。纯展示：候选列表 + 选中高亮；
 * 键盘导航（↑↓/Enter/Tab/Esc）在 Composer 侧裁决，鼠标点选经 onPick 采纳。
 */
import type { SlashCommand, SlashCommandName } from "../lib/slash";

export type SlashCommandMenuProps = {
  readonly candidates: ReadonlyArray<SlashCommand>;
  readonly selectedIndex: number;
  /** 采纳候选（等价于 Enter/Tab 选中项）。 */
  readonly onPick: (name: SlashCommandName) => void;
};

export function SlashCommandMenu({
  candidates,
  selectedIndex,
  onPick,
}: SlashCommandMenuProps) {
  if (candidates.length === 0) return null;
  const selected = Math.max(
    0,
    Math.min(selectedIndex, candidates.length - 1)
  );
  return (
    <ul
      role="listbox"
      aria-label="命令补全"
      className="mb-1 flex flex-col gap-0.5 rounded-panel border border-ink-3/30 bg-surface p-1 shadow-bubble"
    >
      {candidates.map((c, i) => (
        <li key={c.name} role="option" aria-selected={i === selected}>
          <button
            type="button"
            tabIndex={-1}
            // mousedown（非 click）+ preventDefault：点选不抢 textarea 焦点。
            onMouseDown={(e) => {
              e.preventDefault();
              onPick(c.name);
            }}
            className={`flex w-full items-baseline gap-2 rounded-pill px-2 py-1 text-left ${
              i === selected ? "bg-accent-soft" : "hover:bg-accent-soft/50"
            }`}
          >
            <span className="shrink-0 font-mono text-[11px] text-ink">
              {c.hint}
            </span>
            <span className="min-w-0 truncate text-[11px] text-ink-3">
              {c.description}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
