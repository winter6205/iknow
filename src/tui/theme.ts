/**
 * TUI palette tokens (pure TS, no react dependency).
 *
 * Values ported verbatim from archive/tui-ink/src/theme.ts,
 * field semantics unchanged; logoInk / logoGold are banner-only gradient
 * endpoints (deep blue-violet #1a1d6e → pink-gold #ffafaf, diagonal
 * interpolation weights c 0.6 / r 0.4 — algorithm in banner.ts
 * eyeGradientCells).
 *
 * Fenced code block colors (dark-gray bg + syntax highlight) codeBlockBg /
 * codeDefault / syntaxXxx are ported from the reference renderer in
 * scripts/codeblock-preview/_render.tsx; hexes map 1:1 to VSCode dark+
 * defaults. Inline codespan still uses `code` #66b8ae (unchanged).
 *
 * Color discipline: NO_COLOR / terminal-capability degradation is handled by
 * the OpenTUI renderer (hex ColorInput downgrades by terminal capability);
 * the app layer never hand-writes ANSI.
 */

export interface TuiPalette {
  /** Primary accent (banner / focus / brand echo). */
  readonly accent: string;
  /** Body text (highest contrast). Prototype fg. */
  readonly text: string;
  /** Secondary text (used for dim). Prototype muted. */
  readonly dim: string;
  /** Borders. */
  readonly border: string;
  /** Selected-row semantic color (paired with inverse video, k9s style). */
  readonly selected: string;
  /** Foreground run indicator. */
  readonly running: string;
  /** Background run marker. */
  readonly bgRunning: string;
  /** Errors. Prototype danger. */
  readonly error: string;
  /** markdown: H1 heading. */
  readonly h1: string;
  /** markdown: H2/H3 headings (prototype Heading component h1→h1, else→h2). */
  readonly h2: string;
  /** markdown: inline codespan (fenced blocks do **not** use it; they use codeDefault + 4-color syntax highlight). */
  readonly code: string;
  /** markdown: fenced code block background (VSCode dark+ editor #1e1e1e). */
  readonly codeBlockBg: string;
  /** markdown: fenced code block default text color (plain text unmatched by syntax tokens). */
  readonly codeDefault: string;
  /** markdown: fenced block syntax highlight — comments (VSCode dark+ green, paired with DIM|ITALIC). */
  readonly syntaxComment: string;
  /** markdown: fenced block syntax highlight — strings (VSCode dark+ orange). */
  readonly syntaxString: string;
  /** markdown: fenced block syntax highlight — numbers (VSCode dark+ light cyan). */
  readonly syntaxNumber: string;
  /** markdown: fenced block syntax highlight — keywords (VSCode dark+ purple). */
  readonly syntaxKeyword: string;
  /** markdown: blockquotes. */
  readonly quote: string;
  /** markdown: table header. */
  readonly table: string;
  /** markdown: list bullet marker. */
  readonly bullet: string;
  /** unified diff: added line (git-style green). */
  readonly add: string;
  /** unified diff: deleted line (git-style red). */
  readonly del: string;
  /** unified diff: full-row background mask for added lines (GitHub dark add-bg light green). */
  readonly bgAdd: string;
  /** unified diff: full-row background mask for deleted lines (GitHub dark del-bg light red). */
  readonly bgDel: string;
  /** Message bg: user message block (light gray-blue; not glaring in dark theme, distinct from assistant). */
  readonly userBg: string;
  /** Message bg: assistant message block (darker than userBg, forming the role contrast). */
  readonly assistantBg: string;
  /** banner gradient start (deep blue-violet #1a1d6e; diagonal interpolation c weight 0.6). */
  readonly logoInk: string;
  /** banner gradient end (pink-gold #ffafaf; diagonal interpolation r weight 0.4). */
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
  userBg: "#232323",
  assistantBg: "#1a1a1a",
  logoInk: "#1a1d6e",
  logoGold: "#ffafaf",
});
