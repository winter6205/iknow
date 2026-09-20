import { useEffect, useRef, useState, type ReactNode } from "react";
import { FOCUS_RING } from "../lib/ui";

export type CodeBlockProps = {
  /** Raw source text (used by the copy button). */
  code: string;
  /** Highlighted children produced by rehype-highlight (hljs spans). */
  children?: ReactNode;
  /** Class names from the markdown code element (keeps hljs/language-*). */
  className?: string;
};

/** navigator.clipboard first; execCommand fallback (non-secure context / old browsers). */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to execCommand path
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

const COPY_RESET_MS = 2000;

/** Derive the language label from the markdown code element's className (language-*). */
export function codeLanguageLabel(className: string | undefined): string {
  const match = className?.match(/language-([\w+#-]+)/);
  return match?.[1] ?? "";
}

// Header row (language label + copy) above the highlighted pre. The hljs
// class names on `className` are preserved so the highlight theme applies.
export function CodeBlock({ code, children, className }: CodeBlockProps) {
  const lang = codeLanguageLabel(className);
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    []
  );

  const onCopy = () => {
    void copyText(code).then((ok) => {
      if (!ok) return;
      setCopied(true);
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(
        () => setCopied(false),
        COPY_RESET_MS
      );
    });
  };

  return (
    <div className="my-[12px] overflow-hidden rounded-panel border border-line bg-[#f1ede2] first:mt-0 last:mb-0">
      <div className="flex items-center justify-between gap-2 border-b border-line px-3.5 py-[5px]">
        <span
          aria-hidden="true"
          className="truncate font-mono text-[10px] uppercase tracking-[0.08em] text-ink-3"
        >
          {lang || "text"}
        </span>
        <button
          type="button"
          onClick={onCopy}
          aria-label="复制代码"
          className={`shrink-0 rounded-pill border px-2 py-[2px] font-mono text-[10px] leading-[1.6] transition-colors duration-150 ease-[var(--ease-soft)] ${
            copied
              ? "border-ok/40 bg-accent-soft text-ok"
              : "border-line text-ink-3 hover:border-ink-3/40 hover:text-ink"
          } ${FOCUS_RING}`}
        >
          {copied ? "已复制" : "复制"}
        </button>
      </div>
      <pre className="m-0 overflow-x-auto px-4 py-3">
        <code
          className={`block font-mono text-[12.5px] leading-[1.65] ${className ?? ""}`}
        >
          {children}
        </code>
      </pre>
    </div>
  );
}
