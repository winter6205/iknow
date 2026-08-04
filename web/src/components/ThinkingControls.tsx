import { FOCUS_RING } from "../lib/ui";
import {
  EFFORT_LABELS,
  EFFORT_OPTIONS,
  type ThinkingEffort,
  type ThinkingSettings,
} from "../lib/thinking-settings";

export type ThinkingControlsProps = {
  settings: ThinkingSettings;
  /** Parent owns persistence; called with the full next settings object. */
  onChange: (next: ThinkingSettings) => void;
  disabled?: boolean;
};

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

// Compact one-row control above the Composer (footer area): a 深度思考 toggle
// + an effort segmented picker that is inert while thinking is off. Same
// pill/chip visual language as Composer and SessionSidebar.
export function ThinkingControls({
  settings,
  onChange,
  disabled = false,
}: ThinkingControlsProps) {
  const { enabled, effort } = settings;

  return (
    <div
      role="group"
      aria-label="思考模式设置"
      className="mx-auto flex w-full max-w-[var(--chat-max)] flex-wrap items-center justify-end gap-x-3 gap-y-1.5 px-4 pt-2"
    >
      {/* Toggle: switch visual = 34×20 pill, thumb travels on checked state. */}
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        aria-label="深度思考"
        disabled={disabled}
        onClick={() => onChange({ ...settings, enabled: !enabled })}
        className={cx(
          "flex items-center gap-2 rounded-pill text-[12px] leading-none text-ink-2 transition-colors duration-150 ease-[var(--ease-soft)] hover:text-ink disabled:opacity-45",
          FOCUS_RING
        )}
      >
        <span className="font-medium">深度思考</span>
        <span
          aria-hidden="true"
          className={cx(
            "relative inline-flex h-[20px] w-[34px] shrink-0 items-center rounded-pill border transition-colors duration-150 ease-[var(--ease-soft)]",
            enabled ? "border-accent bg-accent" : "border-ink-3/30 bg-bg"
          )}
        >
          <span
            className={cx(
              "absolute h-[14px] w-[14px] rounded-full bg-surface shadow-chip transition-[left] duration-150 ease-[var(--ease-soft)]",
              enabled ? "left-[16px]" : "left-[3px]"
            )}
          />
        </span>
      </button>

      {/* Effort segmented picker — disabled while thinking is off. */}
      <div
        role="radiogroup"
        aria-label="思考强度"
        className={cx(
          "flex items-center gap-px rounded-pill border border-line bg-bg p-[2px]",
          !enabled && "pointer-events-none opacity-45"
        )}
      >
        {EFFORT_OPTIONS.map((value) => (
          <EffortOption
            key={value === "" ? "auto" : value}
            value={value}
            selected={enabled && value === effort}
            disabled={disabled || !enabled}
            onSelect={() => onChange({ enabled: true, effort: value })}
          />
        ))}
      </div>
    </div>
  );
}

function EffortOption({
  value,
  selected,
  disabled,
  onSelect,
}: {
  value: ThinkingEffort;
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  const label = EFFORT_LABELS[value];
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onSelect}
      className={cx(
        "rounded-pill px-[9px] py-[3px] font-mono text-[11px] leading-[1.5] transition-colors duration-150 ease-[var(--ease-soft)]",
        selected
          ? "bg-surface font-medium text-accent shadow-chip"
          : "text-ink-3 hover:text-ink",
        FOCUS_RING
      )}
    >
      {label}
    </button>
  );
}
