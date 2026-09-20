/** @jsxImportSource @opentui/react */
/**
 * Markdown → OpenTUI element tree.
 *
 * Semantics follow archive/tui-ink/src/markdown.tsx (importing that archive is
 * forbidden): marked.lexer parsing is kept, only the render mapping is
 * rewritten —
 *  - Inline styles go through <text>/<span> fg / attributes (TextAttributes
 *    bitmask): strong→BOLD, em→ITALIC, del→STRIKETHROUGH,
 *    codespan→fg=palette.code; link / image render anchor text only (the TUI
 *    does not show URLs).
 *  - Fenced code blocks: dark-gray fill + syntax highlighting (VSCode dark+
 *    four colors), no border / no language label, 1-space padding left and
 *    right, wrapMode="none" (over-wide lines are not folded), blank lines do
 *    not collapse; colors come from tuiPalette.codeBlockBg / codeDefault /
 *    syntaxXxx.
 *  - Block spacing SSOT: top-level container `gap={1}` — exactly one blank
 *    line between adjacent blocks. Block-level elements never carry vertical
 *    margins themselves (per-token margins would stack with gap into 2 blanks).
 *  - Tables: adaptive column-width compression + clipOneLineVisual semantic
 *    truncation (CJK counted by display width); over-wide tables squeeze into
 *    the container, and what still cannot fit is clipped whole-row — never
 *    overflow.
 *  - Empty boundary: empty-string / whitespace-only input renders an empty box
 *    (no blank-line ghost).
 *
 * Unlike the ink version, this file no longer produces a line-ledger API (the
 * line-count mirror was dropped wholesale) — scrolling is delegated to
 * <scrollbox>; Markdown only converts marked tokens into an OpenTUI element
 * tree.
 */
// Under the OpenTUI JSX namespace, JSX.Element = ReactNode — component return
// types use ReactNode (narrowing to ReactElement would clash with the
// namespace's Element type).
import type { ReactNode } from "react";
import { useMemo, useRef } from "react";
import stringWidth from "string-width";
import { TextAttributes } from "@opentui/core";
import { padEndVisual } from "./visual.js";
import { panguSpacing, panguSpacingKeepingCodespans } from "./pangu.js";
import { marked, type MarkedToken, type Token, type Tokens } from "marked";
import { tuiPalette } from "./theme.js";
import { clipFenceDisplayLines } from "./fence-display-cap.js";
import { previewOverflowLabel } from "./tool-summary.js";
import { splitStreamingMarkdown } from "../shared/streaming-block-freeze.js";

// -- Visual-width utilities (table compression / truncation; SSOT = string-width) ---

/** Clip one line to a visual width, ending with … when too long
 *  (clipOneLineVisual semantics; CJK counts as 2 columns). */
function clipVisual(s: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (stringWidth(s) <= maxWidth) return s;
  const budget = maxWidth - 1;
  let acc = "";
  let w = 0;
  for (const ch of s) {
    const cw = stringWidth(ch);
    if (w + cw > budget) break;
    acc += ch;
    w += cw;
  }
  return `${acc}…`;
}

// -- Inline tokens (marked inline tokens recursed into text/span fragments) --

function renderInline(
  tokens: ReadonlyArray<Token> | undefined,
  keyPrefix: string
): ReactNode[] {
  const nodes: ReactNode[] = [];
  let k = 0;
  for (const t of tokens ?? []) {
    const key = `${keyPrefix}-${k++}`;
    switch (t.type) {
      case "text":
        // On soft breaks / nesting, marked attaches child tokens to text
        // tokens — recurse first.
        if (t.tokens !== undefined) {
          nodes.push(...renderInline(t.tokens, key));
          break;
        }
        // Pangu spacing: render-time transform only, never written back to
        // session data.
        nodes.push(panguSpacing(t.text));
        break;
      case "strong":
        nodes.push(<strong key={key}>{renderInline(t.tokens, key)}</strong>);
        break;
      case "em":
        nodes.push(<em key={key}>{renderInline(t.tokens, key)}</em>);
        break;
      case "del":
        // OpenTUI has no built-in del element — use the span attributes bitmask.
        nodes.push(
          <span key={key} attributes={TextAttributes.STRIKETHROUGH}>
            {renderInline(t.tokens, key)}
          </span>
        );
        break;
      case "codespan":
        nodes.push(
          <span key={key} fg={tuiPalette.code}>
            {t.text}
          </span>
        );
        break;
      case "link":
      case "image":
        // The TUI does not show URLs: render anchor text / alt text only.
        nodes.push(...renderInline(t.tokens, key));
        break;
      case "html":
        nodes.push(
          <span key={key} attributes={TextAttributes.DIM}>
            {t.text}
          </span>
        );
        break;
      case "br":
        // LineBreakProps carries only id (no key) — positional order is
        // already stable, no key needed.
        nodes.push(<br />);
        break;
      case "escape":
        nodes.push(t.text);
        break;
      default: {
        // Generic fallback (marked extension tokens): recurse if there are
        // child tokens, otherwise take text.
        const g = t as Tokens.Generic;
        nodes.push(
          g.tokens !== undefined ? renderInline(g.tokens, key) : (g.text ?? "")
        );
      }
    }
  }
  return nodes;
}

/** Inline tokens → plain text (for table cell compression; delimiters take no column). */
function flattenInline(tokens: ReadonlyArray<Token> | undefined): string {
  let out = "";
  for (const t of tokens ?? []) {
    switch (t.type) {
      case "text":
        out += t.tokens !== undefined ? flattenInline(t.tokens) : t.text;
        break;
      case "strong":
      case "em":
      case "del":
      case "link":
      case "image":
        out += flattenInline(t.tokens);
        break;
      case "codespan":
      case "escape":
      case "html":
        out += t.text;
        break;
      case "br":
        out += "\n";
        break;
      default: {
        const g = t as Tokens.Generic;
        out +=
          g.tokens !== undefined ? flattenInline(g.tokens) : (g.text ?? "");
      }
    }
  }
  return out;
}

// -- Fenced code block rendering: dark-gray fill + syntax highlighting (VSCode dark+ four colors) --

/** Pure token kind + text. Produced by tokenizeCodeLine and consumed by
 *  CodeBlockLine; split out so unit tests can assert CodeToken[] against the
 *  regex / capture-group logic without rendering JSX. */
export type CodeTokenKind =
  "plain" | "comment" | "string" | "number" | "keyword";

export interface CodeToken {
  readonly kind: CodeTokenKind;
  readonly text: string;
}

/** Coarse syntax tokenizer for fenced code blocks (zero lexer dependency;
 *  ported from scripts/codeblock-preview/_render.tsx with its TOKEN_RE +
 *  capture-group coloring semantics). Rule order: comment → string → number →
 *  keyword, so `//abc` is never grabbed by `abc` as a keyword first. The `g`
 *  flag plus a local lastIndex reset avoids cross-call pollution. */
export function tokenizeCodeLine(line: string): CodeToken[] {
  const out: CodeToken[] = [];
  let last = 0;
  CODE_TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CODE_TOKEN_RE.exec(line)) !== null) {
    const start = m.index;
    if (start > last) {
      out.push({ kind: "plain", text: line.slice(last, start) });
    }
    if (m[1] !== undefined) out.push({ kind: "comment", text: m[1] });
    else if (m[2] !== undefined) out.push({ kind: "string", text: m[2] });
    else if (m[3] !== undefined) out.push({ kind: "number", text: m[3] });
    else if (m[4] !== undefined) out.push({ kind: "keyword", text: m[4] });
    last = start + m[0].length;
  }
  if (last < line.length) {
    out.push({ kind: "plain", text: line.slice(last) });
  }
  return out;
}

/** Syntax token regex: comment / string / number / keyword (the keyword list
 *  is a fixed set aligned with VSCode dark+ defaults). */
const CODE_TOKEN_RE =
  /(\/\/.*$)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\b\d+\b)|(\b(?:export|function|const|return|if|else|let|var|new|import|from|class|interface|type|extends|async|await|true|false|null|undefined)\b)/g;

/** TextAttributes for comment tokens: dim + italic (VSCode dark+ comment look). */
const COMMENT_ATTRS = TextAttributes.DIM | TextAttributes.ITALIC;

/** Single-line render (blank lines still get the fill without collapsing /
 *  diff +/- reuses palette.add/del / everything else goes through
 *  tokenizeCodeLine + palette). `bg` covers the whole line; `fg` applies only
 *  to plain spans. */
function CodeBlockLine(props: {
  readonly line: string;
  readonly lang: string;
  readonly bg: string;
  readonly fg: string;
}): ReactNode {
  const { line, lang, bg, fg } = props;
  // Blank line: `{" "}` holds one cell + the box fill covers the row; line
  // height does not collapse (box padding + 1 text line = 1 physical row).
  if (line === "") {
    return (
      <text bg={bg} wrapMode="none">
        {" "}
      </text>
    );
  }
  // diff blocks: a leading +/- is colored with palette.add/del and the rest
  // keeps the default text color (diff lines get no syntax highlighting, only
  // the sign).
  if (lang === "diff" && (line[0] === "+" || line[0] === "-")) {
    const sign = line[0]!;
    return (
      <text bg={bg} wrapMode="none">
        <span fg={sign === "+" ? tuiPalette.add : tuiPalette.del} bg={bg}>
          {sign}
        </span>
        <span fg={fg} bg={bg}>
          {line.slice(1)}
        </span>
      </text>
    );
  }
  const tokens = tokenizeCodeLine(line);
  return (
    <text bg={bg} wrapMode="none">
      {tokens.map((t, i) => {
        const color =
          t.kind === "comment"
            ? tuiPalette.syntaxComment
            : t.kind === "string"
              ? tuiPalette.syntaxString
              : t.kind === "number"
                ? tuiPalette.syntaxNumber
                : t.kind === "keyword"
                  ? tuiPalette.syntaxKeyword
                  : fg;
        const attrs =
          t.kind === "comment" ? COMMENT_ATTRS : TextAttributes.NONE;
        return (
          <span key={i} fg={color} bg={bg} attributes={attrs}>
            {t.text}
          </span>
        );
      })}
    </text>
  );
}

/** Fenced code block container: no border / no title; lang is still accepted
 *  but never drawn (a `ts │`-style prefix was a rejected candidate). The
 *  visual contract is box backgroundColor + 1 padding each side; the blank
 *  line between blocks comes from the `Markdown` container gap, so the code
 *  block carries no vertical margin (it would stack with gap into 2 blanks). */
export function CodeBlock(props: {
  readonly lang: string;
  readonly lines: readonly string[];
}): ReactNode {
  const clip = clipFenceDisplayLines(props.lines);
  return (
    <box flexDirection="column">
      <box
        flexDirection="column"
        backgroundColor={tuiPalette.codeBlockBg}
        paddingLeft={1}
        paddingRight={1}
      >
        {clip.visible.map((l, i) => (
          <CodeBlockLine
            key={i}
            line={l}
            lang={props.lang}
            bg={tuiPalette.codeBlockBg}
            fg={tuiPalette.codeDefault}
          />
        ))}
      </box>
      {clip.hiddenLineCount > 0 ? (
        <text fg={tuiPalette.dim} wrapMode="none">
          {previewOverflowLabel(clip.hiddenLineCount)}
        </text>
      ) : null}
    </box>
  );
}

// -- Block rendering (heading / table / list / quote / html / paragraph) --

/**
 * Over-wide table compression with adaptive column widths: natural width =
 * widest cell per column; when the row cannot fit `budget`, iteratively shave
 * the widest column (floor 1) and clip cells with clipVisual; in extremely
 * narrow containers (columns × minimum width still over budget) the whole row
 * is clipped as a last resort — a frame never overflows.
 */
function Table(props: {
  readonly rows: string[][];
  readonly budget: number;
}): ReactNode {
  const cols = Math.max(...props.rows.map((r) => r.length));
  const widths: number[] = new Array<number>(cols).fill(0);
  for (const row of props.rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i], stringWidth(cell));
    });
  }
  // Row width = Σ column widths + 1 space each side per column + (cols-1) │ separators.
  const overhead = cols * 2 + (cols - 1);
  while (widths.reduce((a, b) => a + b, 0) + overhead > props.budget) {
    let mi = 0;
    for (let i = 1; i < widths.length; i++) {
      if (widths[i] > widths[mi]) mi = i;
    }
    if (widths[mi] <= 1) break;
    widths[mi] -= 1;
  }
  return (
    <box flexDirection="column">
      {props.rows.map((row, ri) => {
        const isHeader = ri === 0;
        const line = row
          .map((cell, ci) => {
            const w = widths[ci] ?? 1;
            return ` ${padEndVisual(clipVisual(cell, w), w)} `;
          })
          .join("│");
        return (
          <text
            key={ri}
            fg={isHeader ? tuiPalette.table : tuiPalette.text}
            attributes={isHeader ? TextAttributes.BOLD : TextAttributes.NONE}
          >
            {clipVisual(line, props.budget)}
          </text>
        );
      })}
    </box>
  );
}

/**
 * marked list → flat row sequence, recursed (nested sublists expand with
 * depth indentation; order = render order: a parent item is immediately
 * followed by its sublist). Ordered lists number from list.start; markers are
 * `•` unordered and `N.` ordered — visually consistent with the archived ink
 * version.
 */
function renderList(list: Tokens.List, key: string, depth: number): ReactNode {
  let num = typeof list.start === "number" ? list.start : 1;
  const rows: ReactNode[] = [];
  for (const item of list.items) {
    const marker = list.ordered ? `${num++}.` : "•";
    const inline: Token[] = [];
    const nested: Tokens.List[] = [];
    for (const tk of item.tokens) {
      if (tk.type === "list") {
        nested.push(tk as Tokens.List);
      } else if (tk.type === "space") {
        continue;
      } else {
        // Loose items hold multiple paragraphs; separate them with a space
        // (otherwise "a"+"b" glue into "ab").
        if (inline.length > 0) {
          inline.push({ type: "text", raw: " ", text: " " });
        }
        inline.push(tk);
      }
    }
    const itemKey = `${key}-i${rows.length}`;
    rows.push(
      <box key={itemKey} paddingLeft={depth * 2} flexDirection="row">
        <text fg={tuiPalette.bullet}>{marker} </text>
        <text wrapMode="word">{renderInline(inline, itemKey)}</text>
      </box>
    );
    for (const sub of nested) {
      rows.push(renderList(sub, `${key}-n${rows.length}`, depth + 1));
    }
  }
  return (
    <box key={key} flexDirection="column">
      {rows}
    </box>
  );
}

function renderToken(tok: Token, key: number, width: number): ReactNode {
  // marked 18: Token = MarkedToken | Tokens.Generic (Generic.type is
  // non-literal string + index signature) — strip Generic first to restore
  // switch narrowing; default branch is a defensive fallback.
  const t = tok as MarkedToken;
  switch (t.type) {
    case "space":
    case "hr":
      // No blank-line ghosts: empty tokens produce no row.
      return null;
    case "heading":
      return (
        <text
          key={key}
          fg={t.depth === 1 ? tuiPalette.h1 : tuiPalette.h2}
          attributes={TextAttributes.BOLD}
          wrapMode="word"
        >
          {renderInline(t.tokens, `h-${key}`)}
        </text>
      );
    case "code": {
      // Unclosed fence: marked swallows to end of input (safe for half-cut
      // streaming drafts).
      const lang = (t.lang ?? "").trim().split(/\s+/)[0] ?? "";
      const lines = t.text === "" ? [] : t.text.split("\n");
      return <CodeBlock key={key} lang={lang} lines={lines} />;
    }
    case "table": {
      const cellText = (c: Tokens.TableCell): string => flattenInline(c.tokens);
      const rows = [
        t.header.map(cellText),
        ...t.rows.map((r) => r.map(cellText)),
      ];
      return <Table key={key} rows={rows} budget={width} />;
    }
    case "blockquote": {
      const lines = t.text.split("\n");
      return (
        <box key={key} flexDirection="row">
          <text fg={tuiPalette.quote}>│ </text>
          <box flexDirection="column">
            {lines.map((b, bi) => (
              <text
                key={bi}
                attributes={TextAttributes.DIM | TextAttributes.ITALIC}
                wrapMode="word"
              >
                {b === "" ? " " : panguSpacingKeepingCodespans(b)}
              </text>
            ))}
          </box>
        </box>
      );
    }
    case "list":
      return renderList(t, `list-${key}`, 0);
    case "html": {
      const body = t.text.replace(/\n+$/, "");
      if (body === "") return null;
      // html blocks go through the same fence-display-cap 32-line limit +
      // overflow label as fenced code — unbounded bodies like <style> /
      // <script> never mount whole.
      const lines = body.split("\n");
      const clip = clipFenceDisplayLines(lines);
      return (
        <box key={key} flexDirection="column">
          {clip.visible.map((l, li) => (
            <text key={li} attributes={TextAttributes.DIM} wrapMode="word">
              {l === "" ? " " : l}
            </text>
          ))}
          {clip.hiddenLineCount > 0 ? (
            <text fg={tuiPalette.dim} wrapMode="none">
              {previewOverflowLabel(clip.hiddenLineCount)}
            </text>
          ) : null}
        </box>
      );
    }
    case "paragraph":
      return (
        <text key={key} wrapMode="word">
          {renderInline(t.tokens, `p-${key}`)}
        </text>
      );
    default: {
      const g = t as Tokens.Generic;
      return (
        <text key={key} wrapMode="word">
          {g.tokens !== undefined
            ? renderInline(g.tokens, `g-${key}`)
            : (g.text ?? "")}
        </text>
      );
    }
  }
}

// -- lexer result cache (keyed by text; parsing is width-independent) -----

/**
 * Cache of `marked.lexer` results. The key holds only the text — this file is
 * the sole call site and passes no options; wrapping / compression all happen
 * at render time per width, so parse output is width-independent.
 *
 * Why it is needed: memo only stops re-renders when props are unchanged.
 * Terminal resize (cols change) and viewport unmount—remount (scroll out and
 * back) all push historical text through a fresh parse; in long sessions that
 * is still O(history size).
 *
 * Cap of 256 entries, hits refresh to the tail (LRU): sessions grow without
 * bound, the cache must not. Token arrays are consumed read-only
 * (renderToken never mutates tokens), so they can be shared across renders.
 */
const LEXER_CACHE_LIMIT = 256;
const lexerCache = new Map<string, MarkedToken[]>();

function lexMarkdown(text: string): MarkedToken[] {
  const hit = lexerCache.get(text);
  if (hit !== undefined) {
    lexerCache.delete(text);
    lexerCache.set(text, hit);
    return hit; // EXIT: cache hit
  }
  const tokens = marked.lexer(text) as MarkedToken[];
  lexerCache.set(text, tokens);
  if (lexerCache.size > LEXER_CACHE_LIMIT) {
    const oldest = lexerCache.keys().next();
    if (oldest.done !== true) lexerCache.delete(oldest.value);
  }
  return tokens;
}

function MarkdownStatic(props: {
  readonly text: string;
  readonly width: number;
}): ReactNode {
  const tokens = lexMarkdown(props.text);
  return (
    <box flexDirection="column" width={props.width} gap={1}>
      {tokens
        .filter((t) => t.type !== "space")
        .map((t, i) => renderToken(t, i, props.width))}
    </box>
  );
}

function MarkdownStreaming(props: {
  readonly text: string;
  readonly width: number;
}): ReactNode {
  const boundaryRef = useRef(0);
  const prefixHeldRef = useRef("");
  if (
    props.text.length < boundaryRef.current ||
    !props.text.startsWith(prefixHeldRef.current)
  ) {
    boundaryRef.current = 0;
    prefixHeldRef.current = "";
  }
  const split = splitStreamingMarkdown(props.text, boundaryRef.current);
  boundaryRef.current = split.boundary;
  prefixHeldRef.current = split.prefixRaw;

  const prefixNodes = useMemo(() => {
    if (split.prefixRaw === "") return [];
    return lexMarkdown(split.prefixRaw)
      .filter((t) => t.type !== "space")
      .map((t, i) => renderToken(t, i, props.width));
  }, [split.prefixRaw, props.width]);

  const tailNodes =
    split.tailRaw === ""
      ? []
      : lexMarkdown(split.tailRaw)
          .filter((t) => t.type !== "space")
          .map((t, i) => renderToken(t, prefixNodes.length + i, props.width));

  return (
    <box flexDirection="column" width={props.width} gap={1}>
      {prefixNodes}
      {tailNodes}
    </box>
  );
}

/** Main renderer: markdown text → OpenTUI element tree.
 *  `streaming`: only growing drafts / expanded thinking pin the frozen prefix;
 *  historical text uses the plain full-text cache. */
export function Markdown(props: {
  readonly text: string;
  readonly width: number;
  readonly streaming?: boolean;
}): ReactNode {
  if (props.streaming === true) {
    return <MarkdownStreaming text={props.text} width={props.width} />;
  }
  return <MarkdownStatic text={props.text} width={props.width} />;
}
