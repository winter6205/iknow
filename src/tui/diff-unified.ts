/**
 * src/tui/diff-unified.ts
 *
 * #343 T4（自 archive/tui-ink/src/diff-unified.ts 迁移，语义不变）：
 * 统一 diff（jsdiff）纯函数 —— 把 old/new 文本算成逐行 `DiffLine[]`，
 * TUI 红绿 diff 预览（diff-view.tsx）只做渲染、不做算法。
 *
 * 契约（与 git diff --unified=3 对齐，实测同构）：
 *  - 行文本带统一 diff 前缀：`ctx` → 前导空格、`del` → `-`、`add` → `+`；
 *  - hunk 头 `@@ -A,B +C,D @@`（每 hunk 首行，kind `ctx`，无行号）——
 *    它是 `oldNo`/`newNo` 的起点锚（diff-view 靠它排行号列）；
 *  - `oldNo` 在 `del`/`ctx` 行递增，`newNo` 在 `add`/`ctx` 行递增，
 *    每个 hunk 独立从 oldStart/newStart 起算；
 *  - 无行尾换行标记 `\ No newline at end of file` 以 `ctx` 行保留；
 *  - 双双空输入 → 空数组；单边空 → 纯 add / 纯 del 一个 hunk。
 *
 * 错误契约：jsdiff 任何异常统一包装为 typed `DiffError`（带 `code`），
 * 不外泄 raw Error —— 渲染层按 instanceof 判级，不碰栈文本。
 */
import { structuredPatch } from "diff";

export type DiffRowKind = "add" | "del" | "ctx";

export interface DiffLine {
  readonly kind: DiffRowKind;
  readonly oldNo?: number;
  readonly newNo?: number;
  readonly text: string;
}

/** jsdiff 失败时抛出的 typed 错误：`code` 给调用方程序化判级。 */
export class DiffError extends Error {
  constructor(
    message: string,
    readonly code?: string
  ) {
    super(message);
    this.name = "DiffError";
  }
}

/** hunk 头行（`@@ -A,B +C,D @@`）：有 kind/无行号，行号计数起点。 */
function hunkHeaderText(
  oldStart: number,
  oldLines: number,
  newStart: number,
  newLines: number
): string {
  return `@@ -${oldStart},${oldLines} +${newStart},${newLines} @@`;
}

/**
 * old/new 文本 → 逐行统一 diff。`cols` 保留给渲染层（窄终端折叠），
 * 本层是纯函数，与终端宽度无关——忽略该参数。
 *
 * 空输入契约：双双空 → `[]`；单边空 → 单 hunk 的纯 add / 纯 del。
 *
 * @throws {DiffError} jsdiff 内部异常时（code `JS_DIFF_FAILED`）。
 */
export function computeDiff(
  _filePath: string,
  oldContent: string,
  newContent: string,
  _cols?: number
): readonly DiffLine[] {
  if (oldContent === "" && newContent === "") return [];

  let patch;
  try {
    patch = structuredPatch(
      _filePath,
      _filePath,
      oldContent,
      newContent,
      "",
      "",
      { context: 3 }
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new DiffError(`jsdiff failed: ${msg}`, "JS_DIFF_FAILED");
  }

  const rows: DiffLine[] = [];
  for (const hunk of patch.hunks) {
    rows.push({
      kind: "ctx",
      text: hunkHeaderText(
        hunk.oldStart,
        hunk.oldLines,
        hunk.newStart,
        hunk.newLines
      ),
    });
    // hunk 内行号从 hunk 起点起算，独立于上一 hunk（unified diff 语义）。
    let oldNo = hunk.oldStart;
    let newNo = hunk.newStart;
    for (const line of hunk.lines) {
      if (line.length > 0 && line[0] === "-") {
        rows.push({ kind: "del", oldNo, text: line });
        oldNo += 1;
      } else if (line.length > 0 && line[0] === "+") {
        rows.push({ kind: "add", newNo, text: line });
        newNo += 1;
      } else {
        // ctx（前导空格）与 `\ No newline at end of file` 标记都算 ctx。
        rows.push({ kind: "ctx", oldNo, newNo, text: line });
        if (line.startsWith(" ")) {
          oldNo += 1;
          newNo += 1;
        }
      }
    }
  }
  return rows;
}
