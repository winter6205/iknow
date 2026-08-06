/**
 * src/tui/markdown-lines.ts — markdown 文本 → 物理显示行 SSOT（#189 修复）。
 *
 * 动机：`measureMessage`（行级窗口账目）此前用 `wrapText(text, cols)` 按
 * **字符数**估 assistant text 行数，但实际渲染走 `<Markdown>`（parseBlocks：
 * heading/fence/table/quote/list/blank/paragraph），行账系统性错位（fence
 * 边框行、h1 marginTop、bullet 记号、CJK 视觉宽度全未计入）——窗口起点算
 * 错，滚动渲染漂移（PR #219 合入后实测仍不达标的根因）。
 *
 * 本模块把 `parseBlocks` 的 AST 投影成**物理行字符串数组**，逐块镜像
 * markdown.tsx renderBlock 的行产出（不渲染颜色，只产出行文本）：
 *  - fence：`┌─┐` 边框 2 行 + lang 行（有 lang 时）+ 内容行，`│ ` 前缀；
 *    内容宽 cols-4（Box width=cols − 边框 2 − paddingX 2），超宽硬折。
 *  - table：每行 cell padEndVisual(max+2) 以 `│` 连接，超宽按视觉宽度折行。
 *  - heading：h1 前置 1 空行（marginTop=1）；文本按视觉宽度折行。
 *  - quote：`│ ` 前缀，内容按 cols-2 折行。
 *  - list：`• `/`N.` marker + indent*2 左移，内容按剩余宽度折行。
 *  - blank：单个 `" "`（与 renderBlock 的 `<Text> </Text>` 对齐）。
 *  - paragraph：先行内记号剥离（`**bold**` / `` `code` `` / `*it*` / `_it_`
 *    的标记符不占列——颜色属性不占列），再按视觉宽度折行。
 *
 * 折行统一走 text.ts 的 `wrapTextVisual`（banner.js visualWidth SSOT，
 * CJK 按 2 列计）。与 `<Markdown>` 实际渲染的等价由 parity 测试锁死。
 */
import { parseBlocks, type MdBlock } from "./markdown.js";
import { padEndVisual, visualWidth } from "./banner.js";
import { wrapTextVisual } from "./text.js";

/** 行内格式记号剥离：`**`、`` ` ``、成对 `*` / `_` 的定界符不占显示列。 */
export function stripInlineMarkers(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/_([^_]+)_/g, "$1");
}

function fenceLines(
  block: Extract<MdBlock, { type: "fence" }>,
  cols: number
): string[] {
  const inner = Math.max(1, cols - 4); // 边框 2 + paddingX 2
  const border = `┌${"─".repeat(Math.max(1, cols - 2))}┐`;
  const bottom = `└${"─".repeat(Math.max(1, cols - 2))}┘`;
  const out: string[] = [border];
  if (block.lang !== "") {
    out.push(`│ ${block.lang}`);
  }
  for (const l of block.lines) {
    // 空行渲染为 "│ │"（renderBlock 用 " " 占位）；超宽行按内容宽硬折。
    const body = l === "" ? " " : l;
    for (const part of wrapTextVisual(body, inner)) {
      out.push(`│ ${part}`);
    }
  }
  out.push(bottom);
  return out;
}

function tableLines(
  block: Extract<MdBlock, { type: "table" }>,
  cols: number
): string[] {
  const widths: number[] = [];
  for (const row of block.rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, visualWidth(cell));
    });
  }
  const out: string[] = [];
  for (const row of block.rows) {
    const joined = row
      .map((cell, ci) => padEndVisual(cell, (widths[ci] ?? 0) + 2))
      .join("│");
    // 超宽表行会被 ink 默认 wrap 折行——与渲染对齐。
    for (const part of wrapTextVisual(joined, cols)) {
      out.push(part);
    }
  }
  return out;
}

function quoteLines(
  block: Extract<MdBlock, { type: "quote" }>,
  cols: number
): string[] {
  const out: string[] = [];
  for (const l of block.lines) {
    const body = l === "" ? " " : l;
    for (const part of wrapTextVisual(body, Math.max(1, cols - 2))) {
      out.push(`│ ${part}`);
    }
  }
  return out;
}

function listLines(
  block: Extract<MdBlock, { type: "list" }>,
  cols: number
): string[] {
  const out: string[] = [];
  for (const it of block.items) {
    const indent = "  ".repeat(it.indent);
    const prefix = `${indent}${it.marker} `;
    const rest = Math.max(1, cols - prefix.length);
    const parts = wrapTextVisual(stripInlineMarkers(it.content), rest);
    parts.forEach((part, pi) => {
      out.push(pi === 0 ? `${prefix}${part}` : `${indent}  ${part}`);
    });
  }
  return out;
}

/** 顶层：markdown 文本 → 物理行数组（与 `<Markdown>` 渲染行数逐行对齐）。 */
export function markdownToLines(text: string, cols: number): string[] {
  const width = Math.max(1, cols);
  const out: string[] = [];
  for (const block of parseBlocks(text)) {
    switch (block.type) {
      case "fence":
        out.push(...fenceLines(block, width));
        break;
      case "table":
        out.push(...tableLines(block, width));
        break;
      case "heading": {
        // h1 marginTop=1：ink 会折叠空 `<Text>{""}</Text>`，占位用空格行。
        if (block.level === 1) out.push(" ");
        out.push(...wrapTextVisual(stripInlineMarkers(block.text), width));
        break;
      }
      case "quote":
        out.push(...quoteLines(block, width));
        break;
      case "list":
        out.push(...listLines(block, width));
        break;
      case "blank":
        out.push(" ");
        break;
      case "paragraph":
        out.push(...wrapTextVisual(stripInlineMarkers(block.text), width));
        break;
    }
  }
  return out;
}
