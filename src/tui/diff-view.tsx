/** @jsxImportSource @opentui/react */
/**
 * src/tui/diff-view.tsx
 *
 * #343 T4（自 archive/tui-ink/src/diff-view.tsx 迁移 ink → OpenTUI）：
 * 统一 diff 渲染器 —— 把 `computeDiff`（diff-unified.ts）产出的 `DiffLine[]`
 * 按终端宽度渲染成红绿 diff 预览。只做渲染、不做算法。
 *
 * 宽度分档（行号 + 颜色）：
 *  - cols >= 80：双列行号（oldNo | newNo）+ 红绿；
 *  - 40 <= cols < 80：单列行号（oldNo 优先 + │ 分隔）+ 红绿；
 *  - cols < 40：折叠为仅 `add` 行（无行号、无 del / hunk 头）——窄终端降级，
 *    不抛错、不溢出。
 *
 * 行文本（DiffLine.text）已带统一 diff 前缀（` ` / `-` / `+`），本层只排
 * 行号列 + 上色。hunk 头（`@@ -A,B +C,D @@`，kind ctx）无行号，整行 dim。
 *
 * 着色（OpenTUI 版）：add/del 行 fg 上语义色 + 外层 `<box width={cols}>`
 * 铺 backgroundColor 整行遮罩（bgAdd/bgDel）；tests/tui/diff-view.test.tsx
 * 用 captureSpans 实测 fg/bg RGBA（归档 ink 时代 skip 的上色契约落地）。
 */
import type { ReactNode } from "react";
import type { DiffLine } from "./diff-unified.js";
import { tuiPalette } from "./theme.js";

function pad3(n: number | undefined): string {
  return n === undefined ? "   " : String(n).padStart(3);
}

/** hunk 头判定（`@@` 起始的 ctx 行）。 */
function isHunkHeader(line: DiffLine): boolean {
  return line.kind === "ctx" && line.text.startsWith("@@");
}

/** 单行渲染字符串（纯函数，供测试直接断言文本形状）。 */
export function diffRowText(line: DiffLine, cols: number): string {
  // 窄终端降级：仅 add 行，无行号。
  if (cols < 40) return line.kind === "add" ? line.text : "";
  if (isHunkHeader(line)) return line.text;
  if (line.kind === "ctx") return line.text;
  if (cols >= 80) {
    const old = pad3(line.oldNo);
    const nw = pad3(line.newNo);
    return `${old} ${nw} │ ${line.text}`;
  }
  // 单列：oldNo 优先，del/add 用 newNo 兜底。
  const n = line.oldNo ?? line.newNo;
  const num = n === undefined ? "   " : String(n).padStart(3);
  return `${num} │ ${line.text}`;
}

/**
 * DiffLine[] → 可见平文本行（按 cols 折叠；空文本 drop）。
 *
 * 行账 SSOT：`liveToolPreviewRows`（live tail 行账预测）与 `<DiffView>`
 * 渲染都走 `diffRowText` 这同一套按 cols 折叠规则 —— 折叠规则只在此
 * 汇聚，杜绝多处内联分叉（行账 parity）。
 */
export function diffRowTexts(
  rows: readonly DiffLine[],
  cols: number
): string[] {
  return rows.map((r) => diffRowText(r, cols)).filter((t) => t !== "");
}

/**
 * 单行整行背景遮罩色（按 kind + hunk 头）。
 *
 * 只作用于 JSX 渲染层：add/del 返回淡色底，ctx/hunk 头返回 undefined
 * （透明）。**不**经 diffRowText / diffRowTexts 文本投影（那是行账 SSOT，
 * 绝不能改）。任何终端宽度都生效：窄终端折叠为 add-only 行时 add 行同样
 * 上绿底。
 */
function rowBgColor(line: DiffLine): string | undefined {
  if (isHunkHeader(line)) return undefined;
  switch (line.kind) {
    case "add":
      return tuiPalette.bgAdd;
    case "del":
      return tuiPalette.bgDel;
    default:
      return undefined;
  }
}

/** 单行颜色（按 kind + hunk 头）。 */
function rowColor(line: DiffLine): string {
  if (isHunkHeader(line)) return tuiPalette.dim;
  switch (line.kind) {
    case "add":
      return tuiPalette.add;
    case "del":
      return tuiPalette.del;
    default:
      return tuiPalette.dim;
  }
}

/** 单个 diff 行渲染：空文本 → 不占行；否则整行盒（遮罩铺满 cols）+ 文本
 *  （wrapMode none = 超宽截断不折行，行账 1 行）。 */
export function DiffRow(props: {
  readonly line: DiffLine;
  readonly cols: number;
}): ReactNode {
  const text = diffRowText(props.line, props.cols);
  if (text === "") return null;
  const bg = rowBgColor(props.line);
  return (
    <box
      width={props.cols}
      overflow="hidden"
      {...(bg === undefined ? {} : { backgroundColor: bg })}
    >
      <text fg={rowColor(props.line)} wrapMode="none">
        {text}
      </text>
    </box>
  );
}

/** 折叠窄终端：仅保留 add 行（无行号无 hunk 头）。 */
function foldNarrow(rows: readonly DiffLine[]): readonly DiffLine[] {
  return rows.filter((r) => r.kind === "add");
}

/** diff 预览容器：按 cols 分档渲染行列表。 */
export function DiffView(props: {
  readonly rows: readonly DiffLine[];
  readonly cols: number;
}): ReactNode {
  const rows = props.cols < 40 ? foldNarrow(props.rows) : props.rows;
  return (
    <box flexDirection="column">
      {rows.map((line, i) => (
        <DiffRow key={i} line={line} cols={props.cols} />
      ))}
    </box>
  );
}
