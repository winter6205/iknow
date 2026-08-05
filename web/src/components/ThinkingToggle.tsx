import { useEffect, useRef, useState } from "react";
import { FOCUS_RING } from "../lib/ui";
import {
  EFFORT_LABELS,
  EFFORT_OPTIONS,
  type ThinkingEffort,
  type ThinkingSettings,
} from "../lib/thinking-settings";

export type ThinkingToggleProps = {
  settings: ThinkingSettings;
  /** Parent owns persistence; called with the full next settings object. */
  onChange: (next: ThinkingSettings) => void;
  disabled?: boolean;
};

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

function SparkleIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="h-4 w-4"
    >
      <path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6L12 3z" />
      <path d="M19 16l.7 1.8L21.5 18.5l-1.8.7L19 21l-.7-1.8L16.5 18.5l1.8-.7L19 16z" />
    </svg>
  );
}

function Switch({
  checked,
  disabled,
  onToggle,
}: {
  checked: boolean;
  disabled: boolean;
  onToggle: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label="深度思考开关"
      disabled={disabled}
      onClick={() => onToggle(!checked)}
      className={cx(
        "rounded-pill transition-colors duration-150 ease-[var(--ease-soft)] disabled:opacity-45",
        FOCUS_RING
      )}
    >
      <span
        aria-hidden="true"
        className={cx(
          "relative inline-flex h-[20px] w-[34px] shrink-0 items-center rounded-pill border transition-colors duration-150 ease-[var(--ease-soft)]",
          checked ? "border-accent bg-accent" : "border-ink-3/30 bg-bg"
        )}
      >
        <span
          className={cx(
            "absolute h-[14px] w-[14px] rounded-full bg-surface shadow-chip transition-[left] duration-150 ease-[var(--ease-soft)]",
            checked ? "left-[16px]" : "left-[3px]"
          )}
        />
      </span>
    </button>
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

// SWR rationale: trigger 不抢焦（保持 textarea 焦点），Escape 时归还焦点给 trigger。
export function ThinkingToggle({
  settings,
  onChange,
  disabled = false,
}: ThinkingToggleProps) {
  const { enabled, effort } = settings;
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={wrapRef} className="relative shrink-0">
      <button
        ref={triggerRef}
        type="button"
        aria-label="思考模式"
        aria-haspopup="true"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className={cx(
          "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-pill px-2.5 transition-colors duration-150 ease-[var(--ease-soft)] hover:bg-bg disabled:cursor-not-allowed disabled:opacity-45",
          enabled ? "text-accent" : "text-ink-3 hover:text-ink",
          FOCUS_RING
        )}
      >
        <SparkleIcon />
        {enabled ? (
          <span
            aria-hidden="true"
            className="font-mono text-[11px] leading-none text-ink-2"
          >
            深度·{EFFORT_LABELS[effort]}
          </span>
        ) : null}
      </button>
      {open ? (
        <div
          role="dialog"
          aria-label="思考模式设置"
          className="absolute bottom-[calc(100%+8px)] left-0 z-30 min-w-[260px] rounded-[12px] border border-line bg-surface p-3 shadow-bubble"
        >
          <div className="flex items-center justify-between gap-3">
            <span className="text-[12px] font-medium leading-none text-ink">
              深度思考
            </span>
            <Switch
              checked={enabled}
              disabled={disabled}
              onToggle={(v) => onChange({ ...settings, enabled: v })}
            />
          </div>
          <div
            role="radiogroup"
            aria-label="思考强度"
            className={cx(
              "mt-2.5 flex items-center gap-px rounded-pill border border-line bg-bg p-[2px]",
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
      ) : null}
    </div>
  );
}
