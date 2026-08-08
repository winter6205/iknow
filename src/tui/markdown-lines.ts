/**
 * src/tui/markdown-lines.ts — markdown 文本 → 物理显示行 SSOT（#189 修复）。
 *
 * 动机：`measureMessage`（行级窗口账目）此前用 `wrapText(text, cols)` 按
 * **字符数**估 assistant text 行数，但实际渲染走 `<Markdown>`，行账系统性
 * 错位（fence 边框行、h1 marginTop、bullet 记号、CJK 视觉宽度全未计入）
 * ——窗口起点算错，滚动渲染漂移。
 *
 * #279 项 1：块解析随 markdown.tsx 换成 **marked.lexer**（GFM 完备）。
 * 本模块逐 token 镜像 markdown.tsx renderToken 的物理行产出（不渲染颜色，
 * 只产出行文本）：
 *  - fence（code token）：`┌─┐` 边框 2 行 + lang 行（有 lang 时）+ 内容行，
 *    `│ ` 前缀；内容宽 cols-4（Box width=cols − 边框 2 − paddingX 2），
 *    超宽折行（wrap-ansi，与渲染侧 Text 默认 wrap="wrap" 同源）。
 *    未闭合 fence marked 吞到文末（与渲染同源）。
 *  - table：header + rows cell（行内 tokens 扁平化）padEndVisual(max+2) 以
 *    `│` 连接，超宽按视觉宽度折行。
 *  - heading：h1（depth=1）前置 1 空行（marginTop=1）；文本按视觉宽度折行。
 *  - blockquote：`│ ` 前缀，内容（已剥 `> `）逐行按 cols-2 折行。
 *  - list：flattenList 扁平行（嵌套按深度展开）`• `/`N.` marker +
 *    depth*2 左移，内容按剩余宽度折行。
 *  - space / hr：单个 `" "`（与 renderToken 的 `<Text> </Text>` 对齐）。
 *  - html：逐行原文（颜色不占列），空体占位 `" "`。
 *  - paragraph：行内 tokens 扁平化（`**bold**` / `` `code` `` / `~~del~~`
 *    等的定界符不占列——颜色属性不占列），再按视觉宽度折行。
 *
 * 折行直接调 **wrap-ansi**（与 ink `wrap="wrap"` 的 wrapText 同参调用：
 * `{trim: false, hard: true}`——词边界折行、超宽单词硬切、CJK 按 string-width
 * 占 2 列），而非 text.ts 的 `wrapTextVisual`（硬切）：硬切在窄宽度 ASCII
 * 散文上少算行数（wrap="wrap" 按整词换行），行账与渲染漂移。
 * 与 `<Markdown>` 实际渲染的等价由 parity 测试锁死。
 */
import { marked, type MarkedToken, type Tokens } from "marked";
import wrapAnsi from "wrap-ansi";
import { flattenInline, flattenList } from "./markdown.js";
import { padEndVisual, visualWidth } from "./banner.js";

/**
 * 词感知折行（SSOT 对齐渲染）：与 ink Text `wrap="wrap"` 走同一
 * wrap-ansi 调用（wrap-text.js：`{trim: false, hard: true}`）——整词换行、
 * 长单词硬切、不 trim 首尾空格。空串返回 [""]（至少占 1 行）；cols <= 0
 * 返回 [s]（与 wrapTextVisual 边界约定一致）。
 */
export function wrapAnsiLines(s: string, cols: number): string[] {
  if (s.length === 0) return [""];
  if (cols <= 0) return [s];
  return wrapAnsi(s, cols, { trim: false, hard: true }).split("\n");
}

function fenceLines(tok: Tokens.Code, cols: number): string[] {
  const inner = Math.max(1, cols - 4); // 边框 2 + paddingX 2
  const border = `┌${"─".repeat(Math.max(1, cols - 2))}┐`;
  const bottom = `└${"─".repeat(Math.max(1, cols - 2))}┘`;
  const out: string[] = [border];
  // lang 与 renderToken 同源：去尾、取首词（info string 只展示语言名）。
  const lang = ((tok.lang ?? "").trim().split(/\s+/)[0] ?? "").trim();
  if (lang !== "") {
    out.push(`│ ${lang}`);
  }
  const bodyLines = tok.text === "" ? [] : tok.text.split("\n");
  for (const l of bodyLines) {
    // 空行渲染为 "│ │"（renderToken 用 " " 占位）；超宽行按内容宽硬折。
    const body = l === "" ? " " : l;
    for (const part of wrapAnsiLines(body, inner)) {
      out.push(`│ ${part}`);
    }
  }
  out.push(bottom);
  return out;
}

function tableLines(tok: Tokens.Table, cols: number): string[] {
  const cellText = (c: Tokens.TableCell): string => flattenInline(c.tokens);
  const rows = [
    tok.header.map(cellText),
    ...tok.rows.map((r) => r.map(cellText)),
  ];
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, visualWidth(cell));
    });
  }
  const out: string[] = [];
  for (const row of rows) {
    const joined = row
      .map((cell, ci) => padEndVisual(cell, (widths[ci] ?? 0) + 2))
      .join("│");
    // 超宽表行会被 ink 默认 wrap 折行——与渲染对齐。
    for (const part of wrapAnsiLines(joined, cols)) {
      out.push(part);
    }
  }
  return out;
}

function quoteLines(tok: Tokens.Blockquote, cols: number): string[] {
  const out: string[] = [];
  for (const l of tok.text.split("\n")) {
    const body = l === "" ? " " : l;
    for (const part of wrapAnsiLines(body, Math.max(1, cols - 2))) {
      out.push(`│ ${part}`);
    }
  }
  return out;
}

function listLines(tok: Tokens.List, cols: number): string[] {
  const out: string[] = [];
  for (const it of flattenList(tok)) {
    const indent = "  ".repeat(it.depth);
    const prefix = `${indent}${it.marker} `;
    const rest = Math.max(1, cols - prefix.length);
    // flattenInline 与渲染侧 renderInlineTokens 的可见文本同构；
    // wrapAnsiLines 词感知折行——与渲染侧 wrap="wrap"（wrap-ansi）同源。
    const parts = wrapAnsiLines(flattenInline(it.tokens), rest);
    parts.forEach((part, pi) => {
      out.push(pi === 0 ? `${prefix}${part}` : `${indent}  ${part}`);
    });
  }
  return out;
}

/** 顶层：markdown 文本 → 物理行数组（与 `<Markdown>` 渲染行数逐行对齐）。 */
export function markdownToLines(text: string, cols: number): string[] {
  const width = Math.max(1, cols);
  // lexer 边界剥 Generic（marked 18：Generic.type: string 非字面量 + 索引签名
  // 使 switch 无法从 Token 收窄）。与 markdown.tsx renderToken 同策略：
  // Generic 由 default 分支防御处理，case 分支获得字面量收窄。
  const tokens = marked.lexer(text) as MarkedToken[];
  // 空文本：marked 产零 token——镜像渲染侧占位空格行（至少 1 行）。
  if (tokens.length === 0) return [" "];
  const out: string[] = [];
  for (const tok of tokens) {
    switch (tok.type) {
      case "space":
      case "hr":
        out.push(" ");
        break;
      case "heading": {
        // h1 marginTop=1：ink 会折叠空 `<Text>{""}</Text>`，占位用空格行。
        if (tok.depth === 1) out.push(" ");
        out.push(...wrapAnsiLines(flattenInline(tok.tokens), width));
        break;
      }
      case "code":
        out.push(...fenceLines(tok, width));
        break;
      case "table":
        out.push(...tableLines(tok, width));
        break;
      case "blockquote":
        out.push(...quoteLines(tok, width));
        break;
      case "list":
        out.push(...listLines(tok, width));
        break;
      case "html": {
        const body = tok.text.replace(/\n+$/, "");
        if (body === "") {
          out.push(" ");
          break;
        }
        for (const l of body.split("\n")) {
          for (const part of wrapAnsiLines(l === "" ? " " : l, width)) {
            out.push(part);
          }
        }
        break;
      }
      case "paragraph":
        out.push(...wrapAnsiLines(flattenInline(tok.tokens), width));
        break;
      default: {
        // Generic 兜底：与 renderToken 的 default 分支同源。
        const g = tok as Tokens.Generic;
        out.push(
          ...wrapAnsiLines(
            g.tokens !== undefined ? flattenInline(g.tokens) : (g.text ?? ""),
            width
          )
        );
      }
    }
  }
  return out;
}
