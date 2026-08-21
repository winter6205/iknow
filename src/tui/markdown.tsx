/** @jsxImportSource @opentui/react */
/**
 * src/tui/markdown.tsx
 *
 * Markdown → OpenTUI 元素树（#343 T2，ink 版重写；issue #321 / 决策 #325）。
 *
 * 语义沿用 archive/tui-ink/src/markdown.tsx（禁止 import 该归档）：
 * marked.lexer 解析保留，只重写渲染映射——
 *  - 行内样式走 `<text>`/`<span>` 的 fg / attributes（TextAttributes bitmask，
 *    #325 决策 2）：strong→BOLD、em→ITALIC、del→STRIKETHROUGH、
 *    codespan→fg=palette.code；link / image 只渲锚文本（TUI 不展示 URL）。
 *  - 围栏代码块 c4 定案：深灰底 + 语法高亮（VSCode dark+ 四色）、无边框 /
 *    无语言标签（语言标签是 c5 候选，c4 不画）、左右各 1 空格 padding、
 *    wrapMode="none" 超宽不折行、空行不塌缩、marginTop/Bottom=1 块间空
 *    一行；颜色由 tuiPalette.codeBlockBg / codeDefault / syntaxXxx 提供。
 *  - 表格：自适应列宽压缩 + clipOneLineVisual 语义截断（CJK 按视觉宽度），
 *    超宽表格压到容器宽度内，压不下时整行兜底裁切——不溢出。
 *  - empty 边界：空字符串 / 纯空白输入渲染空 box（不留空行残影，
 *    spec Testing Strategy）。
 *
 * 与 ink 版的差异：本文件不再产出行账 API（行计数镜像、行账 SSOT
 * 整套随 #325 整条删除）——滚动交 `<scrollbox>`（T3），Markdown 渲染
 * 仅负责把 marked token 转 OpenTUI 元素树。
 */
// OpenTUI JSX 命名空间下 JSX.Element = ReactNode——组件返回类型统一用
// ReactNode（ReactElement 收窄会与命名空间 Element 类型冲突）。
import type { ReactNode } from "react";
import stringWidth from "string-width";
import { TextAttributes } from "@opentui/core";
import { padEndVisual } from "./visual.js";
import { marked, type MarkedToken, type Token, type Tokens } from "marked";
import { tuiPalette } from "./theme.js";

// -- 视觉宽度工具（表格压缩 / 截断专用；SSOT = string-width） ---------

/** 按视觉宽度截断单行，超长以 … 收尾（clipOneLineVisual 语义，CJK 占 2 列）。 */
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

// -- 行内 tokens（marked inline token 递归 → text/span 片段） ----------

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
        // marked 在软换行 / 嵌套场景给 text token 挂子 tokens，优先递归。
        if (t.tokens !== undefined) {
          nodes.push(...renderInline(t.tokens, key));
          break;
        }
        nodes.push(t.text);
        break;
      case "strong":
        nodes.push(<strong key={key}>{renderInline(t.tokens, key)}</strong>);
        break;
      case "em":
        nodes.push(<em key={key}>{renderInline(t.tokens, key)}</em>);
        break;
      case "del":
        // OpenTUI 无 del 内置元素——走 span attributes bitmask。
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
        // TUI 不展示 URL：只渲锚文本 / alt 文本。
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
        // LineBreakProps 只含 id（无 key）——位置序已稳定，不需要 key。
        nodes.push(<br />);
        break;
      case "escape":
        nodes.push(t.text);
        break;
      default: {
        // Generic 兜底（marked 扩展 token）：有子 tokens 递归，否则取 text。
        const g = t as Tokens.Generic;
        nodes.push(
          g.tokens !== undefined ? renderInline(g.tokens, key) : (g.text ?? "")
        );
      }
    }
  }
  return nodes;
}

/** 行内 tokens → 纯文本（表格单元格压缩用；定界符不占列）。 */
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

// -- 围栏代码块 c4 渲染：深灰底 + 语法高亮（VSCode dark+ 四色） -------

/** 纯 token 类型 + 文本。tokenizeCodeLine 产出 → CodeBlockLine 消费，
 *  拆分是为单测正则 / 捕获组逻辑时不必渲染 JSX（直接断言 CodeToken[]）。 */
export type CodeTokenKind =
  "plain" | "comment" | "string" | "number" | "keyword";

export interface CodeToken {
  readonly kind: CodeTokenKind;
  readonly text: string;
}

/** c4 围栏代码块语法粗 tokenizer（零 lexer 依赖；搬自
 *  scripts/codeblock-preview/_render.tsx 的 TOKEN_RE + 捕获组分色语义）。
 *  规则顺序：comment → string → number → keyword，确保 `//abc` 不会被
 *  `abc` 抢先匹配成 keyword。`g` flag + 局部 lastIndex 重置避免跨调用污染。 */
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

/** 语法 token 正则：注释 / 字符串 / 数字 / 关键字（keyword 列表 = c4 定稿，
 *  跟 VSCode dark+ default 对齐）。 */
const CODE_TOKEN_RE =
  /(\/\/.*$)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\b\d+\b)|(\b(?:export|function|const|return|if|else|let|var|new|import|from|class|interface|type|extends|async|await|true|false|null|undefined)\b)/g;

/** 注释 token 的 TextAttributes：dim + italic（VSCode dark+ 注释视觉）。 */
const COMMENT_ATTRS = TextAttributes.DIM | TextAttributes.ITALIC;

/** 单行渲染（空行铺背景不塌缩 / diff +/- 复用 palette.add/del / 其它走
 *  tokenizeCodeLine + 调色）。`bg` 全行铺，`fg` 仅作用于 plain span。 */
function CodeBlockLine(props: {
  readonly line: string;
  readonly lang: string;
  readonly bg: string;
  readonly fg: string;
}): ReactNode {
  const { line, lang, bg, fg } = props;
  // 空行：`{" "}` 占一格 + box 背景铺满整行；行高不塌缩（box padding
  // + 1 行文本 = 1 物理行高）。
  if (line === "") {
    return (
      <text bg={bg} wrapMode="none">
        {" "}
      </text>
    );
  }
  // diff 代码块：行首 +/- 用 palette.add/del 上色，其余保持默认字色
  // （参考预览 c4 不对 diff 行做语法高亮，只标 +/- 符号）。
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

/** c4 围栏代码块容器：无 border / 无 title；lang 保留接收但 c4 不画
 *  （c5 才在前置画 `ts │`，c4 定稿不画）。box backgroundColor + 左右 1
 *  padding + 块间 margin 1 行的视觉契约。`compact` 去掉垂直 margin，供
 *  工具卡内嵌预览，避免行账多 2 空行。 */
export function CodeBlock(props: {
  readonly lang: string;
  readonly lines: readonly string[];
  readonly compact?: boolean;
}): ReactNode {
  return (
    <box
      flexDirection="column"
      backgroundColor={tuiPalette.codeBlockBg}
      paddingLeft={1}
      paddingRight={1}
      marginTop={props.compact ? 0 : 1}
      marginBottom={props.compact ? 0 : 1}
    >
      {props.lines.map((l, i) => (
        <CodeBlockLine
          key={i}
          line={l}
          lang={props.lang}
          bg={tuiPalette.codeBlockBg}
          fg={tuiPalette.codeDefault}
        />
      ))}
    </box>
  );
}

// -- 块渲染（heading / table / list / quote / html / paragraph）--------

/**
 * 表格超宽压缩（#325 自适应列宽）：自然列宽 = 各列最宽单元格；行预算
 * `budget` 装不下时迭代削最宽列（下限 1 列），单元格按 clipVisual 截断；
 * 极端窄容器（列数 × 最小宽仍超预算）整行兜底裁切——帧内绝不溢出。
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
  // 行宽 = Σ 列宽 + 每列左右各 1 空格 + (cols-1) 个 │ 分隔。
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
 * marked list → 扁平行序列递归渲染（嵌套子列表按深度缩进展开，顺序 =
 * 渲染顺序：父项后紧跟其子列表）。ordered 按 list.start 起编号；marker：
 * 无序 `•`、有序 `N.`——与归档 ink 版视觉一致。
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
        // loose 项多段落之间插空格分隔（否则 "a"+"b" 粘成 "ab"）。
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
  // marked 18：Token = MarkedToken | Tokens.Generic（Generic.type: string 非
  // 字面量 + 索引签名）——先剥 Generic 恢复 switch 收窄，default 防御兜底。
  const t = tok as MarkedToken;
  switch (t.type) {
    case "space":
    case "hr":
      // 不留空行残影：空 token 不产行。
      return null;
    case "heading":
      return (
        <text
          key={key}
          marginTop={t.depth === 1 ? 1 : 0}
          fg={t.depth === 1 ? tuiPalette.h1 : tuiPalette.h2}
          attributes={TextAttributes.BOLD}
          wrapMode="word"
        >
          {renderInline(t.tokens, `h-${key}`)}
        </text>
      );
    case "code": {
      // 未闭合 fence：marked 吞到文末（流式草稿半截 markdown 安全）。
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
                {b === "" ? " " : b}
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
      return (
        <box key={key} flexDirection="column">
          {body.split("\n").map((l, li) => (
            <text key={li} attributes={TextAttributes.DIM} wrapMode="word">
              {l === "" ? " " : l}
            </text>
          ))}
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

/** 主渲染器：markdown 文本 → OpenTUI 元素树。 */
export function Markdown(props: {
  readonly text: string;
  readonly width: number;
}): ReactNode {
  const tokens = marked.lexer(props.text) as MarkedToken[];
  return (
    <box flexDirection="column" width={props.width}>
      {tokens
        .filter((t) => t.type !== "space")
        .map((t, i) => renderToken(t, i, props.width))}
    </box>
  );
}
