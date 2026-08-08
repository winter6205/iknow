/**
 * scripts/demo-diff.ts — demo 文件里的代码 diff 功能演示
 *
 * 链路：toolPreviewRows（tool-summary.ts）→ computeDiff（diff-unified.ts）
 *       → diffRowText / DiffView 渲染规则（diff-view.tsx）
 *
 * 场景（全部基于 demo/ 目录真实文件）：
 *  1. edit_file：改 demo/greeter.ts 一处 + 新增一行（unified diff，宽终端双列行号）
 *  2. write_file：整文件写 demo/hello.py（old 视为空 → 纯 add，模拟新文件）
 *  3. 纯删除场景
 *  4. 窄终端 cols=35 折叠（仅 add 行）与宽终端对照
 *
 * 运行：npx tsx scripts/demo-diff.ts
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { toolPreviewRows } from "../src/tui/tool-summary.js";
import { diffRowTexts } from "../src/tui/diff-view.js";
import { tuiPalette } from "../src/tui/theme.js";

const demoDir = resolve(import.meta.dirname, "../demo");
const read = (f: string): string => readFileSync(resolve(demoDir, f), "utf8");

// ANSI 256 色近似 tuiPalette（真实 TUI 在终端里直接上色）。
const color = {
  add: (s: string) => `\u001b[32m${s}\u001b[39m`,
  del: (s: string) => `\u001b[31m${s}\u001b[39m`,
  dim: (s: string) => `\u001b[2m${s}\u001b[22m`,
};

function renderRows(
  title: string,
  rows: ReadonlyArray<{ kind: string; text: string }>,
  cols: number
): void {
  console.log(`\n${title}（cols=${cols}）`);
  console.log("-".repeat(Math.min(cols, 72)));
  for (const r of diffRowTexts(rows as never, cols)) {
    const raw = r.replace(/\u001b/g, "");
    const tag = raw.startsWith("+")
      ? "ADD"
      : raw.startsWith("-")
        ? "DEL"
        : "CTX";
    if (raw.startsWith("+")) console.log(color.add(r));
    else if (raw.startsWith("-")) console.log(color.del(r));
    else if (raw.startsWith("@@")) console.log(color.dim(r));
    else console.log(color.dim(r));
    void tag;
    void color;
  }
}

// ---- 场景 1：edit_file 语义（真实 old/new 片段） ---------------------------
{
  const oldStr = `  if (excitement > 0) {\n    message += "!".repeat(excitement);\n  }\n  return shout ? message.toUpperCase() : message;`;
  const newStr = `  if (excitement > 0) {\n    message += "!".repeat(excitement);\n  }\n  if (shout) {\n    message = message.toUpperCase();\n  }\n  return message;`;
  const rows = toolPreviewRows(
    "edit_file",
    { old_str: oldStr, new_str: newStr },
    100
  );
  renderRows(
    "场景 1 · edit_file：改写 greet() 返回分支（片段 diff）",
    rows,
    100
  );
}

// ---- 场景 2：write_file 语义（旧内容为空 → 纯 add） -------------------------
{
  const content = read("hello.py");
  const rows = toolPreviewRows("write_file", { content }, 100);
  renderRows(
    "场景 2 · write_file：整文件写入 demo/hello.py（纯新增）",
    rows,
    100
  );
}

// ---- 场景 3：纯删除 --------------------------------------------------------
{
  const oldStr = `export interface GreetOptions {\n  /** 称呼，默认 "world" */\n  name?: string;\n  /** 是否大写输出 */\n  shout?: boolean;\n  /** 附加感叹号个数 */\n  excitement?: number;\n}\n`;
  const rows = toolPreviewRows(
    "edit_file",
    { old_str: oldStr, new_str: "" },
    100
  );
  renderRows(
    "场景 3 · edit_file：删除整个 GreetOptions 接口（纯删除）",
    rows,
    100
  );
}

// ---- 场景 4：窄终端折叠对照（cols=35 < 40 → 仅 add 行） --------------------
{
  const rows = toolPreviewRows(
    "edit_file",
    {
      old_str: "name?: string;\n",
      new_str: "name?: string;\n/** 必填称呼 */\nrequired?: boolean;\n",
    },
    35
  );
  renderRows("场景 4 · 窄终端折叠（cols=35 → 仅 add 行、无行号）", rows, 35);
}

// 调色板参考（真实 TUI 颜色，脚本内 ANSI 近似）
console.log(
  `\n真实调色板参考: add=${tuiPalette.add} del=${tuiPalette.del} dim=${tuiPalette.dim}`
);
