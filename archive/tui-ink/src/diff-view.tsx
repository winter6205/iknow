/**
 * src/tui/diff-view.tsx
 *
 * #298 T5 统一 diff 渲染器：把 `computeDiff`（diff-unified.ts）产出的
 * `DiffLine[]` 按终端宽度渲染成红绿 diff 预览。只做渲染、不做算法。
 *
 * 宽度分档（行号 + 颜色）：
 *  - cols >= 80：双列行号（oldNo | newNo）+ 红绿；
 *  - 40 <= cols < 80：单列行号（oldNo 优先 + │ 分隔）+ 红绿；
 *  - cols < 40：折叠为仅 `add` 行（无行号、无 del / hunk 头）——窄终端降级，
 *    不抛错、不溢出。
 *
 * 行文本（DiffLine.text）已带统一 diff 前缀（` ` / `-` / `+`），本层只排
 * 行号列 + 上色。hunk 头（`@@ -A,B +C,D @@`，kind ctx）无行号，整行 dim。
 */
import { Box, Text } from "ink";
import type { ReactElement } from "react";
import type { DiffLine } from "./diff-unified.js";
import { tuiPalette } from "./theme.js";

function pad3(n: number | undefined): string {
  return n === undefined ? "   " : String(n).padStart(3);
}

/** 内容行文本（含 diff 前缀）。hunk 头整行 dim。 */
function isHunkHeader(line: DiffLine): boolean {
  return line.kind === "ctx" && line.text.startsWith("@@");
}

/** 单行渲染字符串（纯函数，供 diff-view.test 直接断言文本形状）。 */
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
 * 行账 SSOT：message-rows（裁剪路径）与 live-tool-preview（live tail）都
 * 用本函数做「预测览行数」，`<DiffView>` 渲染同一套折叠规则 —— 折叠规则
 * 只在此汇聚，杜绝 3 处内联 `.map(diffRowText).filter(t !== "")` 分叉
 * （#298 review-Medium：#189 行账 parity 风险）。
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
 * （透明、不产 `48` 背景序列）。**不**经 diffRowText / diffRowTexts 文本
 * 投影（那是 message-rows / live-tool-preview 的行账 SSOT，#189 parity，
 * 绝不能改）。
 *
 * 任何终端宽度都生效：遮罩是纯渲染层产物，不影响行账文本；窄终端
 * （cols<40）折叠为 add-only 行时 add 行同样上绿底。
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

/** 单个 diff 行渲染。 */
export function DiffRow(props: {
  readonly line: DiffLine;
  readonly cols: number;
}): ReactElement {
  const text = diffRowText(props.line, props.cols);
  if (text === "") return <></>;
  const bg = rowBgColor(props.line);
  return (
    <Box width={bg === undefined ? undefined : props.cols} backgroundColor={bg}>
      <Text color={rowColor(props.line)} wrap="truncate" backgroundColor={bg}>
        {text}
      </Text>
    </Box>
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
}): ReactElement {
  const rows = props.cols < 40 ? foldNarrow(props.rows) : props.rows;
  return (
    <Box flexDirection="column">
      {rows.map((line, i) => (
        <DiffRow key={i} line={line} cols={props.cols} />
      ))}
    </Box>
  );
}
