/**
 * src/tui/theme.ts
 *
 * TUI 调色板 token（纯 TS，不依赖 react / ink）。
 *
 * 来源：原型分支 worktree-tui-design-prototype。V7 定案界面与其余 8 变体共享
 * `V3_PAIR` 色板（tui-prototype/src/theme.ts Palette 接口骨架 +
 * variants/variant7-adaptive.tsx 的 V3_PAIR.dark 数值），本文件只搬深色档
 * （正式实现不做亮色切换；原型 IKNOW_TUI_LIGHT 评审钩子不搬入）。
 * 裁决：#146（V7 布局定案）/ #154（窗口适配）/ #171（banner 支线）。
 *
 * 字段重命名对照（原型 → 正式实现，值不变）：
 * fg→text、muted→dim、danger→error（任务要求的至少 6 个语义色
 * text/dim/border/accent/running/error 中三项需换名，components.tsx 既有
 * 引用 tuiPalette.text / tuiPalette.dim 同此约定）；其余字段名与原型一致
 * （accent / selected / running / bgRunning / h1 / h2 / code / quote / table
 * / bullet / border）。
 *
 * 色彩纪律（原型 BRIEF §3）：NO_COLOR / 非 TTY 下无需手写处理——ink 内部
 * chalk 自动遵循 no-color.org（去色但保留 bold/dim/inverse，层级信息不丢）。
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
  /** markdown：行内 / 围栏代码。 */
  readonly code: string;
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
  quote: "#8a877e",
  table: "#d9a343",
  bullet: "#7d8a82",
  add: "#2ea043",
  del: "#d73a49",
});
