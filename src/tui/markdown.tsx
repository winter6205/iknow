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
 * #279 项 1：块解析从手写 parseBlocks 换成 **marked.lexer**（GFM 完备：
 * del / 嵌套列表 / HTML 块 / setext 标题等旧正则解析覆盖不到的结构）。
 * 行内渲染对 marked inline tokens（text/em/strong/codespan/link/del/html/…）
 * 递归展开为 <Text> 片段。流式草稿喂**半截 markdown**（未闭合 fence / 半截
 * 表格）：marked 对未闭合 fence 同样吞到文末（与旧 parseFence 等价），
 * 半截表格（有分隔行）仍成 table token——流式行为不回退。
 *
 * 行账契约：markdown-lines.ts（markdownToLines）逐 token 镜像本文件
 * renderToken 的物理行产出（fence 边框 / h1 marginTop / bullet 记号 / CJK
 * 视觉宽度），parity 由 tests/tui/chat-view.test.tsx 锁死。flattenList /
 * flattenInline 为两模块共享 SSOT。
 */
import type { ReactElement, ReactNode } from "react";
import { Box, Text } from "ink";
import { marked, type MarkedToken, type Token, type Tokens } from "marked";
import { padEndVisual, visualWidth } from "./banner.js";
import { tuiPalette } from "./theme.js";

type Nodes = ReadonlyArray<ReactNode>;

// -- 行内 tokens（marked inline token 递归渲染 / 扁平化） ---------------------

/**
 * 行内 tokens → ink <Text> 片段数组（递归）。text/em/strong/codespan/link/
 * del/html/escape/br 等逐一映射；text token 含软换行（"\n"）时按行拆成独立
 * <Text>——与旧逐行段落渲染的折行行为对齐（行账 SSOT 同构）。
 */
export function renderInlineTokens(
  tokens: ReadonlyArray<Token> | undefined,
  keyPrefix: string
): Nodes {
  const nodes: ReactNode[] = [];
  let k = 0;
  for (const t of tokens ?? []) {
    const key = `${keyPrefix}-${k++}`;
    switch (t.type) {
      case "text": {
        // marked 在软换行 / 嵌套场景给 text token 挂子 tokens，优先递归。
        if (t.tokens !== undefined) {
          nodes.push(...renderInlineTokens(t.tokens, key));
          break;
        }
        for (const [si, seg] of t.text.split("\n").entries()) {
          nodes.push(
            <Text key={`${key}-s${si}`} wrap="wrap">
              {seg}
            </Text>
          );
        }
        break;
      }
      case "strong":
        nodes.push(
          <Text key={key} bold wrap="wrap">
            {renderInlineTokens(t.tokens, key)}
          </Text>
        );
        break;
      case "em":
        nodes.push(
          <Text key={key} italic wrap="wrap">
            {renderInlineTokens(t.tokens, key)}
          </Text>
        );
        break;
      case "del":
        nodes.push(
          <Text key={key} strikethrough wrap="wrap">
            {renderInlineTokens(t.tokens, key)}
          </Text>
        );
        break;
      case "codespan":
        nodes.push(
          <Text key={key} color={tuiPalette.code} wrap="wrap">
            {t.text}
          </Text>
        );
        break;
      case "link":
      case "image":
        // TUI 不展示 URL：只渲锚文本 / alt 文本。
        nodes.push(
          <Text key={key} wrap="wrap">
            {renderInlineTokens(t.tokens, key)}
          </Text>
        );
        break;
      case "html":
        nodes.push(
          <Text key={key} dimColor wrap="wrap">
            {t.text}
          </Text>
        );
        break;
      case "br":
        nodes.push(
          <Text key={key} wrap="wrap">
            {"\n"}
          </Text>
        );
        break;
      case "escape":
        nodes.push(
          <Text key={key} wrap="wrap">
            {t.text}
          </Text>
        );
        break;
      default: {
        // Generic 兜底：有子 tokens 递归，否则取 text。marked 18 的
        // Token = MarkedToken | Generic（Generic 带 [index: string]: any
        // 索引签名），switch 无法从 Token 收窄——default 按 Generic 访问
        // 可选字段（Generic.type: string 保留进入此分支的可能性）。
        const g = t as Tokens.Generic;
        nodes.push(
          <Text key={key} wrap="wrap">
            {g.tokens !== undefined
              ? renderInlineTokens(g.tokens, key)
              : (g.text ?? "")}
          </Text>
        );
      }
    }
  }
  return nodes;
}

/**
 * 行内 tokens → 纯文本（定界符不占列：颜色 / 粗斜体是属性不是字符）。
 * markdown-lines.ts 行账用——与 renderInlineTokens 的可见文本严格同构。
 */
export function flattenInline(tokens: ReadonlyArray<Token> | undefined): string {
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
        out += g.tokens !== undefined ? flattenInline(g.tokens) : (g.text ?? "");
      }
    }
  }
  return out;
}

// -- 列表扁平化（嵌套 list 展开为行序列） -------------------------------------

export interface MdFlatItem {
  readonly depth: number;
  readonly marker: string;
  readonly tokens: ReadonlyArray<Token>;
}

/**
 * marked list token → 扁平行序列（嵌套子列表按深度展开，顺序 = 渲染顺序：
 * 父项后紧跟其子列表）。ordered 按 list.start 起编号；marker：无序 `•`、
 * 有序 `N.`——与旧 parseList 视觉一致。行账（markdown-lines.ts）同源消费。
 */
export function flattenList(
  list: Tokens.List,
  depth = 0,
  out: MdFlatItem[] = []
): MdFlatItem[] {
  let num = typeof list.start === "number" ? list.start : 1;
  for (const item of list.items) {
    const marker = list.ordered ? `${num}.` : "•";
    const inline: Token[] = [];
    const nested: Tokens.List[] = [];
    for (const tk of item.tokens) {
      if (tk.type === "list") {
        // marked 18 的 Generic（type: string）使 `tk.type === "list"` 不排他；
        // 剥 Generic 联合。无扩展时 Generic 恒为假，断言安全。
        nested.push(tk as Tokens.List);
      } else if (tk.type === "space") {
        // loose 项间的空行 token：旧渲染无对应行，跳过（不产生空行）。
        continue;
      } else {
        // paragraph / text / html 等携带行内 tokens 的块：拼为该项的行内内容。
        // loose 项多段落之间插空格分隔（否则 "a"+"b" 粘成 "ab"）；
        // 两侧（renderInlineTokens / flattenInline）共享同一 tokens 序列。
        if (inline.length > 0) {
          inline.push({ type: "text", raw: " ", text: " " });
        }
        inline.push(tk);
      }
    }
    out.push({ depth, marker, tokens: inline });
    if (list.ordered) num += 1;
    for (const sub of nested) {
      flattenList(sub, depth + 1, out);
    }
  }
  return out;
}

// -- 块渲染 ------------------------------------------------------------------

function Heading(props: {
  readonly level: number;
  readonly tokens: ReadonlyArray<Token>;
  readonly keyId: number;
}): ReactElement {
  const color = props.level === 1 ? tuiPalette.h1 : tuiPalette.h2;
  return (
    <Box marginTop={props.level === 1 ? 1 : 0}>
      <Text bold color={color} wrap="wrap">
        {renderInlineTokens(props.tokens, `h-${props.keyId}`)}
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

function renderToken(tok: Token, key: number): ReactNode {
  // marked 18：Token = MarkedToken | Tokens.Generic（Generic.type: string 非
  // 字面量 + [index: string]: any 索引签名）——switch 无法从 Token 收窄。先
  // 剥掉 Generic 恢复字面量收窄；Generic 由 default 分支防御处理（marked
  // 扩展 token 时才会出现）。剥完 Generic 后 case 分支不再需要 as 断言。
  const t = tok as MarkedToken;
  switch (t.type) {
    case "space":
      // ink 折叠空 <Text>{""}</Text>——占位空格行与旧 blank 块一致。
      return <Text key={key}> </Text>;
    case "heading":
      return <Heading key={key} keyId={key} level={t.depth} tokens={t.tokens} />;
    case "code": {
      // 未闭合 fence：marked 与旧 parseFence 同行为——吞到文末（流式安全）。
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
      return <Table key={key} rows={rows} />;
    }
    case "blockquote": {
      // 引用体：marked 已剥 `> ` 前缀；软换行保留 \n——逐行 dim italic 渲染，
      // 与旧 quote 块逐行渲染同构（行账按行镜像）。
      const lines = t.text.split("\n");
      return (
        <Box key={key} flexDirection="row">
          <Text color={tuiPalette.quote}>│ </Text>
          <Box flexDirection="column">
            {lines.map((b, bi) => (
              <Text key={bi} dimColor italic wrap="wrap">
                {b === "" ? " " : b}
              </Text>
            ))}
          </Box>
        </Box>
      );
    }
    case "list": {
      const items = flattenList(t);
      return (
        <Box key={key} flexDirection="column">
          {items.map((it, ii) => (
            <Box key={ii} paddingLeft={it.depth * 2}>
              <Text color={tuiPalette.bullet}>{it.marker} </Text>
              <Text wrap="wrap">
                {renderInlineTokens(it.tokens, `li-${key}-${ii}`)}
              </Text>
            </Box>
          ))}
        </Box>
      );
    }
    case "hr":
      // 旧解析无 hr——占位空格行（不为分隔线引入新行高，行账不漂）。
      return <Text key={key}> </Text>;
    case "html": {
      const body = t.text.replace(/\n+$/, "");
      if (body === "") return <Text key={key}> </Text>;
      return (
        <Box key={key} flexDirection="column">
          {body.split("\n").map((l, li) => (
            <Text key={li} wrap="wrap">
              {l === "" ? " " : l}
            </Text>
          ))}
        </Box>
      );
    }
    case "paragraph":
      return (
        <Text key={key} wrap="wrap">
          {renderInlineTokens(t.tokens, `p-${key}`)}
        </Text>
      );
    default: {
      // Generic 兜底（marked 扩展 token）：带索引签名，访问 tokens/text 任意字段。
      const g = t as Tokens.Generic;
      return (
        <Text key={key} wrap="wrap">
          {g.tokens !== undefined
            ? renderInlineTokens(g.tokens, `g-${key}`)
            : (g.text ?? "")}
        </Text>
      );
    }
  }
}

/** 主渲染器：markdown 文本 → ink 节点。 */
export function Markdown(props: {
  readonly text: string;
  readonly width: number;
}): ReactElement {
  // lexer 边界剥 Generic（marked 18：Generic.type: string + 索引签名干扰
  // switch 收窄），renderToken / renderInlineTokens 内 switch 已自然收窄；
  // Generic 由 renderToken default 兜底（无扩展时不可达，但保留防御）。
  const tokens = marked.lexer(props.text) as MarkedToken[];
  // 原型未处理 width：交给 ink——根 Box 限宽 + 文本 wrap="wrap" 折行不溢出。
  return (
    <Box flexDirection="column" width={props.width}>
      {tokens.length === 0 ? (
        // 空文本：旧 parseBlocks 产 blank 块——占位空格行（至少 1 行）。
        <Text> </Text>
      ) : (
        tokens.map((t, i) => renderToken(t, i))
      )}
    </Box>
  );
}
