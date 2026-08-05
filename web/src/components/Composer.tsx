import {
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { FOCUS_RING } from "../lib/ui";
import { ThinkingToggle } from "./ThinkingToggle";
import {
  DEFAULT_THINKING_SETTINGS,
  type ThinkingSettings,
} from "../lib/thinking-settings";

export type ComposerProps = {
  disabled?: boolean;
  sending?: boolean;
  onSend: (text: string) => void | Promise<void>;
  placeholder?: string;
  thinkingSettings?: ThinkingSettings;
  onThinkingChange?: (next: ThinkingSettings) => void;
};

// Auto-grow cap: ~4 lines of text-sm with leading-snug plus padding. Past
// this, the pill scrolls internally — the pill itself never grows taller.
const MAX_HEIGHT_PX = 120;

export function Composer({
  disabled = false,
  sending = false,
  onSend,
  placeholder = "输入问题…",
  thinkingSettings = DEFAULT_THINKING_SETTINGS,
  onThinkingChange = () => {},
}: ComposerProps) {
  const [value, setValue] = useState("");
  const fieldId = useId();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const locked = disabled || sending;

  // Auto-grow the textarea up to MAX_HEIGHT_PX; past the cap the pill scrolls.
  useLayoutEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, MAX_HEIGHT_PX)}px`;
  }, [value]);

  const submit = useCallback(async () => {
    const text = value.trim();
    if (!text || locked) return;
    try {
      await onSend(text);
      setValue("");
    } catch {
      // Keep draft text so the user can retry after a failed send.
    }
  }, [value, locked, onSend]);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void submit();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    }
  };

  return (
    <form
      onSubmit={onSubmit}
      aria-label="消息输入"
      className="mx-auto flex w-full max-w-[var(--chat-max)] items-end gap-2 px-4 pb-5 pt-3"
    >
      <label className="sr-only" htmlFor={fieldId}>
        消息
      </label>
      {/* Pill container — textarea + thinking toggle share one rounded-pill
          border so the trigger visually sits INSIDE the input (not as a
          separate element). textarea drops its own border/bg/radius and
          becomes transparent; the toggle anchors to the right inside the
          container with its own inner padding. Auto-grow still targets the
          textarea; the container itself never grows taller (past
          MAX_HEIGHT_PX the textarea scrolls internally). */}
      <div className="flex min-w-0 flex-1 items-end gap-1 rounded-pill border border-ink-3/30 bg-surface/70 pl-5 pr-1 py-1 transition-colors duration-200 ease-[var(--ease-soft)] focus-within:border-ink-3">
        <textarea
          id={fieldId}
          ref={textareaRef}
          value={value}
          disabled={locked}
          placeholder={placeholder}
          rows={1}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          className="min-w-0 flex-1 resize-none overflow-hidden border-0 bg-transparent py-2 text-sm leading-snug text-ink placeholder:text-ink-3 outline-none transition-colors duration-200 ease-[var(--ease-soft)] disabled:opacity-60"
        />
        <ThinkingToggle
          settings={thinkingSettings}
          onChange={onThinkingChange}
          disabled={locked}
        />
      </div>
      {/* Send button — sits outside the pill on the right, ghost until typing.
          Minimal round button (40×40), accent fill on idle, ink on hover. */}
      <button
        type="submit"
        disabled={locked || !value.trim()}
        aria-busy={sending}
        aria-label="发送"
        className={`inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent text-ink shadow-bubble transition-all duration-200 ease-[var(--ease-soft)] hover:-translate-y-px hover:bg-accent/90 ${FOCUS_RING} disabled:cursor-not-allowed disabled:bg-accent/40 disabled:text-ink disabled:shadow-none`}
      >
        {sending ? (
          <span
            aria-hidden="true"
            className="h-4 w-4 animate-spin rounded-full border-[1.5px] border-ink/30 border-t-ink"
          />
        ) : (
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
            <path d="M21 4 3 11l7 2.5L13 21l8-17z" />
            <path d="m10 13.5 11-9.5" />
          </svg>
        )}
      </button>
    </form>
  );
}
