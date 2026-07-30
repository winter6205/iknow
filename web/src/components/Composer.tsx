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

export type ComposerProps = {
  disabled?: boolean;
  sending?: boolean;
  onSend: (text: string) => void | Promise<void>;
  placeholder?: string;
};

// Auto-grow cap: ~10 lines of text-md with leading-snug plus padding.
// Past this, the textarea grows no further and scrolls internally.
const MAX_HEIGHT_PX = 240;

export function Composer({
  disabled = false,
  sending = false,
  onSend,
  placeholder = "输入问题…（Enter 发送，Shift+Enter 换行）",
}: ComposerProps) {
  const [value, setValue] = useState("");
  const fieldId = useId();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const locked = disabled || sending;

  // Auto-grow: collapse height then expand to scrollHeight, capped at MAX_HEIGHT_PX.
  // Past the cap the textarea scrolls internally (overflow-y-auto).
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
      className="flex flex-col gap-2 border-t border-line bg-bg px-4 pt-3 pb-4"
      onSubmit={onSubmit}
      aria-label="消息输入"
    >
      <label className="sr-only" htmlFor={fieldId}>
        消息
      </label>
      <textarea
        id={fieldId}
        ref={textareaRef}
        value={value}
        disabled={locked}
        placeholder={placeholder}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
        className="mx-auto block w-full max-w-[var(--chat-max)] resize-none overflow-y-auto rounded-card border border-line bg-surface px-3 py-2.5 leading-snug text-ink placeholder:text-ink-3 transition-colors duration-200 ease-[var(--ease-soft)] focus:border-accent focus:outline-none focus:ring-[3px] focus:ring-accent-soft disabled:opacity-60"
      />
      <div className="mx-auto flex w-full max-w-[var(--chat-max)] items-center justify-between gap-3">
        <span className="text-xs text-ink-3">
          Enter 发送 · Shift+Enter 换行
        </span>
        <button
          type="submit"
          disabled={locked || !value.trim()}
          aria-busy={sending}
          className={`inline-flex items-center justify-center gap-2 rounded-pill bg-accent px-5 py-2 text-sm font-semibold text-surface shadow-chip transition-all duration-200 ease-[var(--ease-soft)] hover:bg-accent/90 ${FOCUS_RING} disabled:cursor-not-allowed disabled:opacity-50`}
        >
          {sending ? (
            <>
              <span
                aria-hidden="true"
                className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-surface/40 border-t-surface"
              />
              发送中…
            </>
          ) : (
            "发送"
          )}
        </button>
      </div>
    </form>
  );
}
