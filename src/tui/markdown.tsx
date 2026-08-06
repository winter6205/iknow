/**
 * src/tui/markdown.tsx
 *
 * Markdown → ink 组件树（#146 Q5a=C 完整 markdown 裁决）。
 *
 * 来源：原型分支 worktree-tui-design-prototype
 * `tui-prototype/src/markdown.tsx`。能力原样搬入：标题 H1-H3 / 有序与无序列表
 * （两级缩进）/ 围栏代码块（含 lang 标签）/ 表格 / 引用 / 行内粗斜体与行内 code。
 * 裁决：#146（V7 布局 + Q5a=C 完整 markdown）/ #154（窗口适配，宽度折行）
 * / #171（banner 支线同批视觉资产）。
 *
 * 与原型的差异（正式实现收口）：
 *  - 签名严格收口为 `Markdown({ text, width })`：颜色固定取 ./theme.js 的
 *    tuiPalette（不再接受 palette prop，dark 档为唯一配色）；
 *  - 列宽 / 补白复用 ./banner.js 的 visualWidth / padEndVisual（SSOT；
 *    原型 Table 自带的本地 dwidth 近似版不再保留）；
 *  - 宽度约束：原型未处理 width——按裁决交给 ink——根 Box `width={width}` +
 *    段落 / 行内 / 列表 / 引用文本 `wrap="wrap"`，超宽折行不溢出。围栏代码与
 *    表格保留原型的等宽 / 边框渲染（结构化内容不再 mid-line 折）。
 *
 * 结构（code review 整改）：parseBlocks（文本 → 判别式块 AST）与
 * renderBlock（块 → ink 节点）分离，各块类型解析独立函数；Markdown 只做
 * 组装。解析与渲染行为与拆分前逐字节等价。
 */
import type { ReactElement, ReactNode } from "react";
import { Box, Text } from "ink";
import { padEndVisual, visualWidth } from "./banner.js";
import { tuiPalette } from "./theme.js";

type Nodes = ReadonlyArray<ReactNode>;

/** 行内格式：**bold**、*italic*、_italic_、`code`。返回 <Text> 片段数组。 */
function renderInline(text: string, keyPrefix: string): Nodes {
  const nodes: ReactNode[] = [];
  // 交替匹配粗体 / 行内代码 / 斜体；剩余文本为普通段。
  const pattern = /(\*\*([^*]+)\*\*)|(`([^`]+)`)|(\*([^*]+)\*)|(_([^_]+)_)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = pattern.exec(text)) !== null) {
    if (m.index > last) {
      nodes.push(
        <Text key={`${keyPrefix}-t${k++}`} wrap="wrap">
          {text.slice(last, m.index)}
        </Text>
      );
    }
    if (m[1] !== undefined) {
      nodes.push(
        <Text key={`${keyPrefix}-b${k++}`} bold wrap="wrap">
          {m[2]}
        </Text>
      );
    } else if (m[3] !== undefined) {
      nodes.push(
        <Text key={`${keyPrefix}-c${k++}`} color={tuiPalette.code} wrap="wrap">
          {m[4]}
        </Text>
      );
    } else {
      nodes.push(
        <Text key={`${keyPrefix}-i${k++}`} italic wrap="wrap">
          {(m[6] ?? m[8]) as string}
        </Text>
      );
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) {
    nodes.push(
      <Text key={`${keyPrefix}-t${k}`} wrap="wrap">
        {text.slice(last)}
      </Text>
    );
  }
  return nodes;
}

// -- 块 AST ------------------------------------------------------------------

export type MdBlock =
  | { readonly type: "fence"; readonly lang: string; readonly lines: string[] }
  | { readonly type: "table"; readonly rows: string[][] }
  | { readonly type: "heading"; readonly level: number; readonly text: string }
  | { readonly type: "quote"; readonly lines: string[] }
  | {
      readonly type: "list";
      readonly items: ReadonlyArray<{
        readonly indent: number;
        readonly marker: string;
        readonly content: string;
      }>;
    }
  | { readonly type: "blank" }
  | { readonly type: "paragraph"; readonly text: string };

const LIST_LINE = /^(\s*)(?:([-*])|(\d+)\.)\s+(.*)$/;

/** 围栏代码块：```lang 起，下一个 ``` 止（未闭合则吞到文末）。 */
function parseFence(
  lines: ReadonlyArray<string>,
  i: number,
  lang: string
): { block: MdBlock; next: number } {
  const buf: string[] = [];
  i += 1;
  while (i < lines.length && !(lines[i] as string).startsWith("```")) {
    buf.push(lines[i] as string);
    i += 1;
  }
  i += 1; // 跳过收尾 ```（未闭合时越界，循环自然结束）
  return { block: { type: "fence", lang, lines: buf }, next: i };
}

function splitTableRow(l: string): string[] {
  return l
    .split("|")
    .slice(1, -1)
    .map((c) => c.trim());
}

/** 表格：当前行与下一行都以 | 开头，且下一行为分隔行。 */
function parseTable(
  lines: ReadonlyArray<string>,
  i: number
): { block: MdBlock; next: number } {
  const rows: string[][] = [splitTableRow(lines[i] as string)];
  i += 2; // 跳过表头 + 分隔行
  while (i < lines.length && (lines[i] as string).startsWith("|")) {
    rows.push(splitTableRow(lines[i] as string));
    i += 1;
  }
  return { block: { type: "table", rows }, next: i };
}

/** 引用块：连续的 `> ` / `>` 行。 */
function parseQuote(
  lines: ReadonlyArray<string>,
  i: number
): { block: MdBlock; next: number } {
  const buf: string[] = [];
  while (
    i < lines.length &&
    ((lines[i] as string).startsWith("> ") || lines[i] === ">")
  ) {
    buf.push((lines[i] as string).replace(/^>\s?/, ""));
    i += 1;
  }
  return { block: { type: "quote", lines: buf }, next: i };
}

/** 列表（有序 / 无序，支持两级缩进）：连续的列表行收拢为一个块。 */
function parseList(
  lines: ReadonlyArray<string>,
  i: number
): { block: MdBlock; next: number } {
  const items: { indent: number; marker: string; content: string }[] = [];
  while (i < lines.length) {
    const m = (lines[i] as string).match(LIST_LINE);
    if (!m) break;
    items.push({
      indent: Math.floor(m[1].length / 2),
      marker: m[2] === undefined ? `${m[3]}.` : "•",
      content: m[4] as string,
    });
    i += 1;
  }
  return { block: { type: "list", items }, next: i };
}

/** markdown 文本 → 判别式块序列（纯函数，可单测）。 */
export function parseBlocks(text: string): ReadonlyArray<MdBlock> {
  const lines = text.split("\n");
  const out: MdBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as string;

    const fence = line.match(/^```(\S*)/);
    if (fence) {
      const r = parseFence(lines, i, fence[1] as string);
      out.push(r.block);
      i = r.next;
      continue;
    }

    if (
      line.startsWith("|") &&
      i + 1 < lines.length &&
      /^\|[\s:|-]+\|$/.test(lines[i + 1] as string)
    ) {
      const r = parseTable(lines, i);
      out.push(r.block);
      i = r.next;
      continue;
    }

    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      out.push({ type: "heading", level: h[1].length, text: h[2] as string });
      i += 1;
      continue;
    }

    if (line.startsWith("> ") || line === ">") {
      const r = parseQuote(lines, i);
      out.push(r.block);
      i = r.next;
      continue;
    }

    if (LIST_LINE.test(line)) {
      const r = parseList(lines, i);
      out.push(r.block);
      i = r.next;
      continue;
    }

    if (line.trim() === "") {
      out.push({ type: "blank" });
      i += 1;
      continue;
    }

    out.push({ type: "paragraph", text: line });
    i += 1;
  }
  return out;
}

// -- 块渲染 ------------------------------------------------------------------

function Heading(props: {
  readonly level: number;
  readonly text: string;
}): ReactElement {
  const color = props.level === 1 ? tuiPalette.h1 : tuiPalette.h2;
  return (
    <Box marginTop={props.level === 1 ? 1 : 0}>
      <Text bold color={color} wrap="wrap">
        {props.text}
      </Text>
    </Box>
  );
}

function CodeBlock(props: {
  readonly lang: string;
  readonly lines: string[];
}): ReactElement {
  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={tuiPalette.border}
      paddingX={1}
      marginTop={0}
    >
      {props.lang !== "" && <Text dimColor>{props.lang}</Text>}
      {props.lines.map((l, i) => (
        <Text key={i} color={tuiPalette.code}>
          {l === "" ? " " : l}
        </Text>
      ))}
    </Box>
  );
}

function Table(props: { readonly rows: string[][] }): ReactElement {
  // 列宽 = 各列最长内容（用 banner.js 的 visualWidth，含 CJK / braille 处理）。
  const widths: number[] = [];
  for (const row of props.rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, visualWidth(cell));
    });
  }
  return (
    <Box flexDirection="column" marginTop={0}>
      {props.rows.map((row, ri) => {
        const isHeader = ri === 0;
        return (
          <Text
            key={ri}
            bold={isHeader}
            color={isHeader ? tuiPalette.table : tuiPalette.text}
          >
            {row
              .map((cell, ci) => padEndVisual(cell, (widths[ci] ?? 0) + 2))
              .join("│")}
          </Text>
        );
      })}
    </Box>
  );
}

function renderBlock(block: MdBlock, key: number): ReactNode {
  switch (block.type) {
    case "fence":
      return <CodeBlock key={key} lang={block.lang} lines={block.lines} />;
    case "table":
      return <Table key={key} rows={block.rows} />;
    case "heading":
      return <Heading key={key} level={block.level} text={block.text} />;
    case "quote":
      return (
        <Box key={key} flexDirection="row">
          <Text color={tuiPalette.quote}>│ </Text>
          <Box flexDirection="column">
            {block.lines.map((b, bi) => (
              <Text key={bi} dimColor italic wrap="wrap">
                {b === "" ? " " : b}
              </Text>
            ))}
          </Box>
        </Box>
      );
    case "list":
      return (
        <Box key={key} flexDirection="column">
          {block.items.map((it, ii) => (
            <Box key={ii} paddingLeft={it.indent * 2}>
              <Text color={tuiPalette.bullet}>{it.marker} </Text>
              <Text wrap="wrap">
                {renderInline(it.content, `li-${key}-${ii}`)}
              </Text>
            </Box>
          ))}
        </Box>
      );
    case "blank":
      return <Text key={key}> </Text>;
    case "paragraph":
      return (
        <Text key={key} wrap="wrap">
          {renderInline(block.text, `p-${key}`)}
        </Text>
      );
  }
}

/** 主渲染器：markdown 文本 → ink 节点。 */
export function Markdown(props: {
  readonly text: string;
  readonly width: number;
}): ReactElement {
  const blocks = parseBlocks(props.text);
  // 原型未处理 width：交给 ink——根 Box 限宽 + 文本 wrap="wrap" 折行不溢出。
  return (
    <Box flexDirection="column" width={props.width}>
      {blocks.map((b, i) => renderBlock(b, i))}
    </Box>
  );
}
