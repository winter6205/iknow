/**
 * src/tui/theme.ts
 *
 * TUI 调色板 token（纯 TS，不依赖 react）。
 *
 * #343 T1：从 archive/tui-ink/src/theme.ts 原值搬入（V7 定案 V3_PAIR.dark），
 * 字段语义不变；新增 logoInk / logoGold 两个 banner 专属色 = banner 渐变端点
 * （e2 黄昏魔法石：logoInk #1a1d6e 深蓝紫 → logoGold #ffafaf 粉金，对角线
 * 插值 c 权重 0.6 / r 权重 0.4，算法见 banner.ts eyeGradientCells）。
 *
 * 围栏代码块 c4（深灰底 + 语法高亮）的 codeBlockBg / codeDefault / syntaxXxx
 * 颜色固化：搬自 scripts/codeblock-preview/_render.tsx（c4 参考实现），hex
 * 与 VSCode dark+ 默认配色一一对应。行内 codespan 仍走 `code` #66b8ae（不动）。
 *
 * 色彩纪律：NO_COLOR / 终端能力降级交给 OpenTUI 渲染器处理（hex ColorInput
 * 由渲染器按终端能力降级），应用层不手写 ANSI。
 */

export interface TuiPalette {
  /** 主强调色（banner / 焦点 / 品牌呼应）。 */
  readonly accent: string;
  /** 正文（最高对比）。原型 fg。 */
  readonly text: string;
  /** 次级文字（dim 用）。原型 muted。 */
  readonly dim: string;
  /** 边框。 */
  readonly border: string;
  /** 选中行语义色（配 inverse 反白使用，k9s 模式）。 */
  readonly selected: string;
  /** 前台运行指示。 */
  readonly running: string;
  /** 后台运行标记。 */
  readonly bgRunning: string;
  /** 错误。原型 danger。 */
  readonly error: string;
  /** markdown：H1 标题。 */
  readonly h1: string;
  /** markdown：H2/H3 标题（原型 Heading 组件 h1→h1, else→h2）。 */
  readonly h2: string;
  /** markdown：行内 codespan（围栏代码块**不用**，块内走 codeDefault + 语法高亮四色）。 */
  readonly code: string;
  /** markdown：围栏代码块整块底色（VSCode dark+ 编辑区 #1e1e1e）。 */
  readonly codeBlockBg: string;
  /** markdown：围栏代码块默认字色（未匹配语法 token 的 plain 文本）。 */
  readonly codeDefault: string;
  /** markdown：围栏代码块语法高亮——注释（VSCode dark+ 绿，配合 DIM|ITALIC）。 */
  readonly syntaxComment: string;
  /** markdown：围栏代码块语法高亮——字符串（VSCode dark+ 橙）。 */
  readonly syntaxString: string;
  /** markdown：围栏代码块语法高亮——数字（VSCode dark+ 浅青）。 */
  readonly syntaxNumber: string;
  /** markdown：围栏代码块语法高亮——关键字（VSCode dark+ 紫）。 */
  readonly syntaxKeyword: string;
  /** markdown：引用块。 */
  readonly quote: string;
  /** markdown：表格表头。 */
  readonly table: string;
  /** markdown：列表项符号。 */
  readonly bullet: string;
  /** unified diff：新增行（git 风格绿）。 */
  readonly add: string;
  /** unified diff：删除行（git 风格红）。 */
  readonly del: string;
  /** unified diff：新增行整行背景遮罩（GitHub dark add-bg 风格淡绿）。 */
  readonly bgAdd: string;
  /** unified diff：删除行整行背景遮罩（GitHub dark del-bg 风格淡红）。 */
  readonly bgDel: string;
  /** banner 渐变起点（e2 黄昏魔法石深蓝紫 #1a1d6e，对角线插值 c 权重 0.6）。 */
  readonly logoInk: string;
  /** banner 渐变终点（e2 黄昏魔法石粉金 #ffafaf，对角线插值 r 权重 0.4）。 */
  readonly logoGold: string;
}

export const tuiPalette: TuiPalette = Object.freeze({
  accent: "#e8e4d8",
  text: "#e6e4dc",
  dim: "#8a877e",
  border: "#605d55",
  selected: "#e6e4dc",
  running: "#d9a343",
  bgRunning: "#7d8a82",
  error: "#c95d47",
  h1: "#e8e4d8",
  h2: "#c9c4b6",
  code: "#66b8ae",
  codeBlockBg: "#1e1e1e",
  codeDefault: "#d4d4d4",
  syntaxComment: "#6a9955",
  syntaxString: "#ce9178",
  syntaxNumber: "#b5cea8",
  syntaxKeyword: "#c586c0",
  quote: "#8a877e",
  table: "#d9a343",
  bullet: "#7d8a82",
  add: "#2ea043",
  del: "#d73a49",
  bgAdd: "#1f3d2b",
  bgDel: "#3d1f24",
  logoInk: "#1a1d6e",
  logoGold: "#ffafaf",
});
