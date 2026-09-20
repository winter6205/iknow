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

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={cx(
        "h-3 w-3 transition-transform duration-150 ease-[var(--ease-soft)]",
        open && "rotate-180"
      )}
    >
      <path d="m6 9 6 6 6-6" />
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
        "flex items-center gap-2.5 rounded-[8px] px-2 py-1.5 text-left font-mono text-[11px] leading-none transition-colors duration-150 ease-[var(--ease-soft)]",
        selected
          ? "bg-bg text-accent"
          : "text-ink-3 hover:bg-bg hover:text-ink",
        FOCUS_RING
      )}
    >
      <span
        aria-hidden="true"
        className={cx(
          "inline-flex h-[14px] w-[14px] shrink-0 items-center justify-center rounded-full border transition-colors duration-150 ease-[var(--ease-soft)]",
          selected ? "border-accent" : "border-ink-3/30"
        )}
      >
        {selected ? (
          <span className="h-[6px] w-[6px] rounded-full bg-accent" />
        ) : null}
      </span>
      {label}
    </button>
  );
}

// SWR rationale: the trigger never steals focus (textarea keeps it); on Escape focus returns to the trigger.
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
        <span
          aria-hidden="true"
          className="text-[12px] font-medium leading-none"
        >
          {enabled ? "思考" : "快速"}
        </span>
        <ChevronIcon open={open} />
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
              "mt-2.5 flex flex-col gap-0.5",
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
