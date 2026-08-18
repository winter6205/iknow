import type { WebRewindTarget } from "../lib/rewind-targets";

export type RewindPickerProps = {
  readonly targets: ReadonlyArray<WebRewindTarget>;
  readonly selectedIndex: number;
  readonly confirming: boolean;
  readonly onSelect: (index: number) => void;
  readonly onConfirm: () => void;
  readonly onClose: () => void;
};

export function RewindPicker(props: RewindPickerProps) {
  const t = props.targets[props.selectedIndex];
  return (
    <div className="border-b border-ink-3/30 bg-surface px-3 py-2 text-[12px]">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-medium text-ink">回退锚点</span>
        <button type="button" className="text-ink-3" onClick={props.onClose}>
          取消
        </button>
      </div>
      {props.targets.length === 0 ? (
        <p className="text-ink-3">Nothing to rewind to yet.</p>
      ) : (
        <ul className="flex max-h-40 flex-col gap-0.5 overflow-y-auto">
          {props.targets.map((target, i) => (
            <li key={target.keepTurns}>
              <button
                type="button"
                className={`w-full truncate rounded-pill px-2 py-1 text-left font-mono ${
                  i === props.selectedIndex
                    ? "bg-accent-soft"
                    : "hover:bg-accent-soft/50"
                }`}
                onClick={() => props.onSelect(i)}
              >
                keepTurns={target.keepTurns} · {target.label}
              </button>
            </li>
          ))}
        </ul>
      )}
      {t !== undefined ? (
        <div className="mt-2 flex gap-2">
          {props.confirming ? (
            <button
              type="button"
              className="text-accent"
              onClick={props.onConfirm}
            >
              确认回退到 keepTurns={t.keepTurns}
            </button>
          ) : (
            <button
              type="button"
              className="text-accent"
              onClick={props.onConfirm}
            >
              选择此锚点
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}
