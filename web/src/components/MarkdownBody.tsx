import "highlight.js/styles/github.css";
import type { ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { CodeBlock } from "./CodeBlock";

export type MarkdownBodyProps = {
  text: string;
};

// Flatten React children back to a plain string. Used to derive the raw code
// text from the highlighted hljs span tree (rehype-highlight wraps tokens in
// spans but preserves the original text content).
function textOf(children: ReactNode): string {
  if (
    children === null ||
    children === undefined ||
    typeof children === "boolean"
  )
    return "";
  if (typeof children === "string") return children;
  if (typeof children === "number") return String(children);
  if (Array.isArray(children)) return children.map(textOf).join("");
  return "";
}

// Block-level code carries a language-* class from the markdown fence (or
// rehype-highlight's auto-detection). Multi-line text also implies a block —
// covers indented code blocks that ship without a className.
function isBlockCode(className: string | undefined, text: string): boolean {
  return /language-/.test(className ?? "") || text.includes("\n");
}

// Use `pre` as a transparent wrapper so CodeBlock can own the pre surface.
// react-markdown otherwise nests <pre><pre> when code renders its own root.
const COMPONENTS: Components = {
  pre: ({ children }) => <>{children}</>,
  code: ({ node: _ignored, className, children }) => {
    const rawText = textOf(children).replace(/\n$/, "");
    if (isBlockCode(className, rawText)) {
      return (
        <CodeBlock code={rawText} className={className}>
          {children}
        </CodeBlock>
      );
    }
    return (
      <code className="rounded-[6px] border border-line bg-bg px-[5px] py-px font-mono text-[0.84em] text-ink-2">
        {children}
      </code>
    );
  },
  p: ({ node: _ignored, ...rest }) => (
    <p {...rest} className="m-0 mb-[10px] text-ink leading-[1.7] last:mb-0" />
  ),
  ul: ({ node: _ignored, ...rest }) => (
    <ul
      {...rest}
      className="m-0 mb-[10px] flex list-disc flex-col gap-[3px] pl-[22px] last:mb-0 marker:text-ink-3"
    />
  ),
  ol: ({ node: _ignored, ...rest }) => (
    <ol
      {...rest}
      className="m-0 mb-[10px] flex list-decimal flex-col gap-[3px] pl-[22px] last:mb-0 marker:text-ink-3"
    />
  ),
  li: ({ node: _ignored, ...rest }) => (
    <li {...rest} className="m-0 pl-[2px] leading-[1.7]" />
  ),
  a: ({ node: _ignored, ...rest }) => (
    <a
      {...rest}
      target="_blank"
      rel="noopener noreferrer"
      className="font-medium text-accent underline decoration-accent/40 underline-offset-[3px] transition-colors duration-150 ease-[var(--ease-soft)] hover:decoration-accent"
    />
  ),
  h1: ({ node: _ignored, ...rest }) => (
    <h1
      {...rest}
      className="m-0 mt-[14px] mb-[8px] text-[1.28em] font-semibold leading-[1.35] first:mt-0"
    />
  ),
  h2: ({ node: _ignored, ...rest }) => (
    <h2
      {...rest}
      className="m-0 mt-[14px] mb-[8px] text-[1.18em] font-semibold leading-[1.35] first:mt-0"
    />
  ),
  h3: ({ node: _ignored, ...rest }) => (
    <h3
      {...rest}
      className="m-0 mt-[12px] mb-[6px] text-[1.06em] font-semibold leading-[1.4] first:mt-0"
    />
  ),
  h4: ({ node: _ignored, ...rest }) => (
    <h4
      {...rest}
      className="m-0 mt-[12px] mb-[6px] text-[1em] font-semibold leading-[1.4] first:mt-0"
    />
  ),
  blockquote: ({ node: _ignored, ...rest }) => (
    <blockquote
      {...rest}
      className="m-0 mb-[10px] border-l-[3px] border-accent/35 pl-[12px] text-ink-2 last:mb-0"
    />
  ),
  hr: ({ node: _ignored, ...rest }) => (
    <hr {...rest} className="my-[16px] border-0 border-t border-line" />
  ),
  table: ({ node: _ignored, ...rest }) => (
    <div className="my-[12px] -mx-1 overflow-x-auto rounded-panel border border-line first:mt-0 last:mb-0">
      <table {...rest} className="m-0 w-full border-collapse text-[0.92em]" />
    </div>
  ),
  th: ({ node: _ignored, ...rest }) => (
    <th
      {...rest}
      className="border-b border-line bg-bg px-[10px] py-[6px] text-left font-semibold text-ink"
    />
  ),
  td: ({ node: _ignored, ...rest }) => (
    <td
      {...rest}
      className="border-b border-line/70 px-[10px] py-[6px] align-top text-ink last:border-b-0"
    />
  ),
  strong: ({ node: _ignored, ...rest }) => (
    <strong {...rest} className="font-semibold text-ink" />
  ),
  em: ({ node: _ignored, ...rest }) => (
    <em {...rest} className="italic text-ink" />
  ),
  img: ({ node: _ignored, alt, src, ...rest }) => (
    <img
      {...rest}
      alt={alt ?? ""}
      src={src}
      loading="lazy"
      className="my-[8px] max-w-full rounded-panel border border-line"
    />
  ),
};

// Renders assistant markdown. GFM tables + autolink via remark-gfm; fenced and
// inline code via rehype-highlight; visual tokens driven from Tailwind classes.
export function MarkdownBody({ text }: MarkdownBodyProps) {
  return (
    <Markdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeHighlight]}
      components={COMPONENTS}
    >
      {text}
    </Markdown>
  );
}
