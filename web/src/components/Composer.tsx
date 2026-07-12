import {
  useCallback,
  useId,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import styles from "./Composer.module.css";

export type ComposerProps = {
  disabled?: boolean;
  sending?: boolean;
  onSend: (text: string) => void | Promise<void>;
  placeholder?: string;
};

export function Composer({
  disabled = false,
  sending = false,
  onSend,
  placeholder = "输入问题…（Enter 发送，Shift+Enter 换行）",
}: ComposerProps) {
  const [value, setValue] = useState("");
  const fieldId = useId();
  const locked = disabled || sending;

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
    void submit().catch(() => {
      /* rejections already handled in submit */
    });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit().catch(() => {
        /* rejections already handled in submit */
      });
    }
  };

  return (
    <form className={styles.form} onSubmit={onSubmit} aria-label="消息输入">
      <label className="sr-only" htmlFor={fieldId}>
        消息
      </label>
      <textarea
        id={fieldId}
        className={styles.textarea}
        rows={3}
        value={value}
        disabled={locked}
        placeholder={placeholder}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className={styles.bar}>
        <span className={styles.hint}>Enter 发送 · Shift+Enter 换行</span>
        <button
          type="submit"
          className={styles.send}
          disabled={locked || !value.trim()}
        >
          {sending ? "发送中…" : "发送"}
        </button>
      </div>
    </form>
  );
}
