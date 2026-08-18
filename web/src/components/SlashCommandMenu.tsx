import type { SlashCandidate } from "../lib/slash";

export type SlashCommandMenuProps = {
  readonly candidates: ReadonlyArray<SlashCandidate>;
  readonly selectedIndex: number;
  readonly onPick: (name: string) => void;
};

export function SlashCommandMenu({
  candidates,
  selectedIndex,
  onPick,
}: SlashCommandMenuProps) {
  if (candidates.length === 0) return null;
  const selected = Math.max(0, Math.min(selectedIndex, candidates.length - 1));
  return (
    <ul
      role="listbox"
      aria-label="命令补全"
      className="mb-1 flex flex-col gap-0.5 rounded-panel border border-ink-3/30 bg-surface p-1 shadow-bubble"
    >
      {candidates.map((c, i) => (
        <li
          key={`${c.kind}:${c.name}`}
          role="option"
          aria-selected={i === selected}
        >
          <button
            type="button"
            tabIndex={-1}
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
