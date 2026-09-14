/**
 * src/tui/tool-summary.ts
 *
 * #343 T4（自 archive/tui-ink/src/tool-summary.ts 迁移，语义不变）：
 * 工具调用摘要行（纯格式化，可单测）：
 *  - 摘要行 = 工具名 + 参数摘要 + 状态；
 *  - 生成/编辑类增强：write_file/edit_file 显示「生成了什么」（路径 + 行数）。
 *
 * T5 (tui-render-optimization)：`summarizePartialInput` — 运行中 partial JSON
 * 文本摘要（parse 成功走 summarizeToolCall，不完整 JSON 原样截断）。
 *
 * D1（specs/tui-human-display.md）拆分：**文本层**（摘要 / 状态行拼装 /
 * 收口助手 / 子代理文案）已搬到中立模块 `src/shared/tool-line.ts` —— CLI
 * 与该模块共用同一实现（CLI import src/tui 是反向分层）。本文件对它们做
 * re-export，既有 TUI 调用方与 tests/tui/* 的 import 路径与字节不变；
 * 本文件保留 TUI 独有的部分：**结果预览**（completedToolPreview /
 * resultToolPreview / toolPreviewRows）与带 settledClass 的显示注册表。
 *
 * 宽度纪律（窄终端修复）：摘要行渲染形态有三种——running 过程行
 * （`Running 1 shell command… · <command>` / `name · detail`）、完成行
 * `name · detail`（failed 才有 `[失败]` 前缀）——行级窗口账目一律按
 * 1 行计。传 `cols` 时按视觉宽度收口（预留最宽装饰），保证各形态单行不折
 * （running bash 前缀较长，拼装后由 `formatToolStatusLine` 整行兜底收口）。
 *
 * 内容可见性：write_file / edit_file 完成后 `completedToolPreview` 产出
 * 截断代码或 diff（UI SSOT）；live box 与历史 `ToolPreviewRows` 共用
 * `CompletedToolPreviewView` 渲染。`toolPreviewRows` 仍是无界 DiffLine
 * 助手（测试锁 create 整文件绿 diff），生产 UI 不直接调用。
 */
import type { AnthropicNativeMessage } from "../harness/model-adapter/types.js";
import {
  BASH_RUNNING_PREFIX,
  SUBAGENT_ROLE_FALLBACK,
  SUBAGENT_TOOL_LABEL,
  TOOL_SUMMARIES,
  clipOneLine,
  clipOneLineVisual,
  formatLiveToolEvent,
  formatThinkingLive,
  formatToolStatusLine,
  isSubagentTool,
  resolveSubagentRoleFromInput,
  subagentDisplayMark,
  summarizePartialInput,
  summarizeToolCall,
  visualWidth,
} from "../shared/tool-line.js";
import { computeDiff, type DiffLine } from "./diff-unified.js";
import { foldBashPreviewLines } from "./progress-tick.js";
import { TOOL_SETTLED_CLASS, type SettledClass } from "./tool-settled.js";

// D1 文本层单源 = src/shared/tool-line.ts（CLI 同源）。re-export 保持既有
// TUI 调用方与 tests/tui/* 的 import 路径不变（字节零变化）。
export {
  BASH_RUNNING_PREFIX,
  SUBAGENT_ROLE_FALLBACK,
  SUBAGENT_TOOL_LABEL,
  clipOneLine,
  clipOneLineVisual,
  formatLiveToolEvent,
  formatThinkingLive,
  formatToolStatusLine,
  isSubagentTool,
  resolveSubagentRoleFromInput,
  subagentDisplayMark,
  summarizePartialInput,
  summarizeToolCall,
  visualWidth,
};

/** ANSI CSI / OSC escape 序列（多见 CSI SGR `\x1b[...m` / OSC `\x1b]...BEL/ST`）。
 *  strip 时一并吞掉终止符（m / K / H / J / BEL / ST = ESC \），保证不会把
 *  转义序列截到一半（spec D4 边界：截断不得切断转义序列中间）。 */
const ANSI_ESCAPE_RE =
  /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

/** 剥 ANSI 转义序列（按字符数返回，保留原字符位置不可见）。 */
export function stripAnsi(s: string): string {
  return s.replace(ANSI_ESCAPE_RE, "");
}

export interface ToolSummaryLine {
  readonly toolName: string;
  readonly detail: string;
  /** ok | failed | unknown（tool_result 未到达，如 cancelled 中断）。 */
  readonly status: "ok" | "failed" | "unknown";
}

function inputRecord(input: unknown): Record<string, unknown> {
  return typeof input === "object" && input !== null
    ? (input as Record<string, unknown>)
    : {};
}

function countLines(s: unknown): number {
  if (typeof s !== "string" || s.length === 0) return 0;
  return s.split("\n").length;
}

/** #693 T4 D4:工具显示注册表 — 「摘要 + 结果预览」一体声明。
 *
 *  D7 把「工具状态行文案」与「结果预览函数」同置一处，让「新增一种工具
 *  的显示」只需在 TOOL_DISPLAYS 加一条声明，而不是散改三处（live +
 *  历史 + 结果预览）。每个 tool 一行：summary 函数 + preview 函数（无
 *  预览需求 → 字段缺席；read_file 等明确「不显示预览」的工具亦按字段
 *  缺席处理，见 spec D4 边界）。
 *
 *  preview 函数签名：`(rec, resultText?) => ResultPreview`。
 *  `rec` = tool_use input 投影；`resultText` = tool_result 文本（live 路径
 *  缺省，因 live 走 run.stdout / run.stderr 旁路；历史路径必传 —
 *  来源 = `toolResultTextMap(session.messages)`）。
 */
interface ToolDisplay {
  /** 摘要声明：引用 shared TOOL_SUMMARIES 的同一函数对象（不是复制文本）——
   *  CLI 与 TUI 的 detail 文本单源，注册表只把它纳入「一体声明」行。 */
  readonly summary: (rec: Record<string, unknown>) => string;
  /** 运行中摘要（可选）。字段缺席 = 运行态与落定态同文案；声明它的工具，
   *  其落定摘要含「只有 input 齐了才可信的量」（write_file 的行数）——
   *  运行中 input 是流式半成品，该量必须省略而不是显示成 0。 */
  readonly runningSummary?: (rec: Record<string, unknown>) => string;
  /** 落定态三分类（spec D2：缺声明非法 —— 接口必填 + 测试拒绝）。 */
  readonly settledClass: SettledClass;
  readonly preview?: (
    rec: Record<string, unknown>,
    resultText?: string,
    stdout?: string,
    stderr?: string
  ) => ResultPreview;
}

function bashPreview(
  _rec: Record<string, unknown>,
  resultText?: string,
  stdout?: string,
  stderr?: string
): ResultPreview {
  // live 路径：stdout/stderr 旁路优先（未走模型 tool_result 编码；
  // 也不依赖历史 tool_result 文本反序列化 JSON）。缺省回退到 resultText
  // 的 JSON envelope（历史路径）。
  let bashStdout = stdout;
  let bashStderr = stderr;
  if (
    bashStdout === undefined &&
    bashStderr === undefined &&
    resultText !== undefined
  ) {
    try {
      const parsed = JSON.parse(resultText) as Record<string, unknown>;
      if (typeof parsed.stdout === "string") bashStdout = parsed.stdout;
      if (typeof parsed.stderr === "string") bashStderr = parsed.stderr;
    } catch {
      // EXIT: 非 JSON 形态(理论上 bash 不会产出,保留防御)→ 整段 resultText
      // 视为 stdout 显示的退路。不抛、不再尝试其它形态 —— 历史路径的
      // tool_result 文本就是可展示的最真实料,展示层降级到全文而非空预览。
      bashStdout = resultText;
    }
  }
  const streams: string[] = [];
  if (typeof bashStdout === "string" && bashStdout.length > 0)
    streams.push(bashStdout);
  if (typeof bashStderr === "string" && bashStderr.length > 0)
    streams.push(bashStderr);
  if (streams.length === 0) return EMPTY_RESULT_PREVIEW;
  const merged = streams.join("\n");
  if (!isRenderableOutput(merged)) return EMPTY_RESULT_PREVIEW;
  const lines = foldBashPreviewLines(merged);
  if (lines.length === 0) return EMPTY_RESULT_PREVIEW;
  const { visible, hiddenLineCount } = takeTailWindow(lines);
  if (visible.length === 0) return EMPTY_RESULT_PREVIEW;
  return { kind: "result", lines: visible, hiddenLineCount };
}

const TOOL_DISPLAYS: Readonly<Record<string, ToolDisplay>> = {
  // settledClass 值取自 tool-settled.ts 的 D8 分类表、summary 取自 shared
  // TOOL_SUMMARIES（两处均为单一来源，注册表只复用不复制；summary +
  // preview? + settledClass 同置一行，spec D7）。
  write_file: {
    summary: TOOL_SUMMARIES.write_file!.summary,
    runningSummary: TOOL_SUMMARIES.write_file!.runningSummary,
    settledClass: TOOL_SETTLED_CLASS.write_file!,
  },
  edit_file: {
    summary: TOOL_SUMMARIES.edit_file!.summary,
    settledClass: TOOL_SETTLED_CLASS.edit_file!,
  },
  bash: {
    summary: TOOL_SUMMARIES.bash!.summary,
    preview: bashPreview,
    settledClass: TOOL_SETTLED_CLASS.bash!,
  },
  read_file: {
    summary: TOOL_SUMMARIES.read_file!.summary,
    settledClass: TOOL_SETTLED_CLASS.read_file!,
  },
  grep: {
    summary: TOOL_SUMMARIES.grep!.summary,
    settledClass: TOOL_SETTLED_CLASS.grep!,
  },
  glob: {
    summary: TOOL_SUMMARIES.glob!.summary,
    settledClass: TOOL_SETTLED_CLASS.glob!,
  },
  web_search: {
    summary: TOOL_SUMMARIES.web_search!.summary,
    settledClass: TOOL_SETTLED_CLASS.web_search!,
  },
  web_fetch: {
    summary: TOOL_SUMMARIES.web_fetch!.summary,
    settledClass: TOOL_SETTLED_CLASS.web_fetch!,
  },
  memory_recall: {
    summary: TOOL_SUMMARIES.memory_recall!.summary,
    settledClass: TOOL_SETTLED_CLASS.memory_recall!,
  },
  memory_save: {
    summary: TOOL_SUMMARIES.memory_save!.summary,
    settledClass: TOOL_SETTLED_CLASS.memory_save!,
  },
  tool_search: {
    summary: TOOL_SUMMARIES.tool_search!.summary,
    settledClass: TOOL_SETTLED_CLASS.tool_search!,
  },
  // D6（spec specs/tui-tool-settled-appearance.md）：skill 是 accent 类 ——
  // 只点名着色（`skill <name>`），不把 skill 正文摊成结果预览浅色预览；
  // 声明无 preview 字段（resultToolPreview 走 empty）。
  skill: {
    summary: TOOL_SUMMARIES.skill!.summary,
    settledClass: TOOL_SETTLED_CLASS.skill!,
  },
  // disclosure-index-align T2: skill_search 已删（spec ADR-0046 / SC5）。
  // 历史 tool_result 可能仍含该名 → 走默认 placeholder（已不在 TOOL_SUMMARIES），
  // 行为与未注册工具一致（无显示声明即 retract 兜底）。
  // 子代理两件（spec D8 三类之外）：settledClass 取核内显式声明的 "subagent"
  // —— 不用 `!` 兜底，声明缺失/谎报在编译期或跨核闸失败。
  spawn_subagent: {
    summary: TOOL_SUMMARIES.spawn_subagent!.summary,
    runningSummary: TOOL_SUMMARIES.spawn_subagent!.runningSummary,
    settledClass: TOOL_SETTLED_CLASS.spawn_subagent,
  },
  subagent_result: {
    summary: TOOL_SUMMARIES.subagent_result!.summary,
    settledClass: TOOL_SETTLED_CLASS.subagent_result,
  },
  lsp_definition: {
    summary: TOOL_SUMMARIES.lsp_definition!.summary,
    settledClass: TOOL_SETTLED_CLASS.lsp_definition!,
  },
  lsp_references: {
    summary: TOOL_SUMMARIES.lsp_references!.summary,
    settledClass: TOOL_SETTLED_CLASS.lsp_references!,
  },
  lsp_hover: {
    summary: TOOL_SUMMARIES.lsp_hover!.summary,
    settledClass: TOOL_SETTLED_CLASS.lsp_hover!,
  },
  lsp_go_to_implementation: {
    summary: TOOL_SUMMARIES.lsp_go_to_implementation!.summary,
    settledClass: TOOL_SETTLED_CLASS.lsp_go_to_implementation!,
  },
  lsp_prepare_call_hierarchy: {
    summary: TOOL_SUMMARIES.lsp_prepare_call_hierarchy!.summary,
    settledClass: TOOL_SETTLED_CLASS.lsp_prepare_call_hierarchy!,
  },
  lsp_incoming_calls: {
    summary: TOOL_SUMMARIES.lsp_incoming_calls!.summary,
    settledClass: TOOL_SETTLED_CLASS.lsp_incoming_calls!,
  },
  lsp_outgoing_calls: {
    summary: TOOL_SUMMARIES.lsp_outgoing_calls!.summary,
    settledClass: TOOL_SETTLED_CLASS.lsp_outgoing_calls!,
  },
  lsp_diagnostics: {
    summary: TOOL_SUMMARIES.lsp_diagnostics!.summary,
    settledClass: TOOL_SETTLED_CLASS.lsp_diagnostics!,
  },
  lsp_document_symbol: {
    summary: TOOL_SUMMARIES.lsp_document_symbol!.summary,
    settledClass: TOOL_SETTLED_CLASS.lsp_document_symbol!,
  },
  lsp_workspace_symbol: {
    summary: TOOL_SUMMARIES.lsp_workspace_symbol!.summary,
    settledClass: TOOL_SETTLED_CLASS.lsp_workspace_symbol!,
  },
  // bash_output / bash_stop / todo_write / list_mcp_resources / read_mcp_resource /
  // query_trace:host 工具 / 无内容可预览 —— 仅 summary 声明,无 preview
  // (CLI 与 TUI 同字节,模型视野与现状一致)。
  bash_output: {
    summary: TOOL_SUMMARIES.bash_output!.summary,
    settledClass: TOOL_SETTLED_CLASS.bash_output!,
  },
  bash_stop: {
    summary: TOOL_SUMMARIES.bash_stop!.summary,
    settledClass: TOOL_SETTLED_CLASS.bash_stop!,
  },
  todo_write: {
    summary: TOOL_SUMMARIES.todo_write!.summary,
    settledClass: TOOL_SETTLED_CLASS.todo_write!,
  },
  list_mcp_resources: {
    summary: TOOL_SUMMARIES.list_mcp_resources!.summary,
    settledClass: TOOL_SETTLED_CLASS.list_mcp_resources!,
  },
  read_mcp_resource: {
    summary: TOOL_SUMMARIES.read_mcp_resource!.summary,
    settledClass: TOOL_SETTLED_CLASS.read_mcp_resource!,
  },
  query_trace: {
    summary: TOOL_SUMMARIES.query_trace!.summary,
    settledClass: TOOL_SETTLED_CLASS.query_trace!,
  },
  // task worktree 生命周期五件（spec D8）：enter/exit/create/remove 点名
  // 着色（accent），list 是查询类（retract）。人读表述随 D1 改英文并点名新
  // 注册名（specs/create-worktree-tools.md D5）—— 文本在 shared
  // TOOL_SUMMARIES 声明，CLI 侧无注册表可查，同源才不漂移。
  // 这五件在 TUI surface 属 host 缝条件化装配（deps-tools 期望集剥除），
  // 显示声明仍常驻 —— 渲染注册表完备性与装配条件化解耦。
  "create-worktree": {
    summary: TOOL_SUMMARIES["create-worktree"]!.summary,
    settledClass: TOOL_SETTLED_CLASS["create-worktree"]!,
  },
  "enter-worktree": {
    summary: TOOL_SUMMARIES["enter-worktree"]!.summary,
    settledClass: TOOL_SETTLED_CLASS["enter-worktree"]!,
  },
  "exit-worktree": {
    summary: TOOL_SUMMARIES["exit-worktree"]!.summary,
    settledClass: TOOL_SETTLED_CLASS["exit-worktree"]!,
  },
  "remove-worktree": {
    summary: TOOL_SUMMARIES["remove-worktree"]!.summary,
    settledClass: TOOL_SETTLED_CLASS["remove-worktree"]!,
  },
  "list-worktrees": {
    summary: TOOL_SUMMARIES["list-worktrees"]!.summary,
    settledClass: TOOL_SETTLED_CLASS["list-worktrees"]!,
  },
};

/** 单源：根据工具名 + input + resultText 产结果预览（行级尾部 tail + ANSI 透传）。
 *  无 preview 声明 / 无 resultText / 空输出 → `{ kind: "empty" }`。 */
export function resultToolPreview(
  name: string,
  input: unknown,
  opts?: {
    readonly resultText?: string;
    readonly stdout?: string;
    readonly stderr?: string;
  }
): ResultPreview {
  const display = TOOL_DISPLAYS[name];
  if (display === undefined || display.preview === undefined) {
    return EMPTY_RESULT_PREVIEW;
  }
  const rec = inputRecord(input);
  return display.preview(rec, opts?.resultText, opts?.stdout, opts?.stderr);
}

/** 注册表覆盖性：列出当前 TOOL_DISPLAYS 注册的所有工具名（供测试用）。 */
export function registeredToolDisplayNames(): ReadonlyArray<string> {
  return Object.keys(TOOL_DISPLAYS);
}

/** 显示注册表的 settledClass 查询（供测试闸用）：未注册名缺省 retract，
 *  与 TOOL_SETTLED_CLASS 兜底一致。 */
export function settledClassOfDisplay(name: string): SettledClass {
  return TOOL_DISPLAYS[name]?.settledClass ?? "retract";
}

/**
 * D5（spec specs/tui-tool-settled-appearance.md）：失败一行短错误。
 * 单源截断：折叠空白 → `clipOneLineVisual` 按视觉宽度收口（窄终端单行
 * 不折），带 `…` 省略号 —— 不把长回执（如 `[worktree_isolation]`）摊成
 * 多行。空文本 → 空串（渲染层不画空错误行）。
 */
export function clipErrorLine(text: string, cols: number): string {
  if (text.length === 0) return "";
  return clipOneLineVisual(text, Math.max(1, cols - 2));
}

/** 新建文件（write create preview）可见窗：正文前 10 行（spec D3）。
 *  **不是**编辑 diff 的帽 —— 编辑/覆盖已有文件的 diff 不截断。 */
export const WRITE_CREATE_PREVIEW_WINDOW = 10;

/** 兼容别名：既有调用方/测试引用的 `TOOL_PREVIEW_WINDOW` 现等于新建窗 10。
 *  编辑 diff 不再共用该帽（D4：diff 全量可见）。 */
export const TOOL_PREVIEW_WINDOW = WRITE_CREATE_PREVIEW_WINDOW;

/** #693 T4 D4:结果预览（bash / skill）可见窗（尾部 tail，截断即折叠）。
 *  行数 SSOT = docs/CONTEXT.md **result preview**（"取 bash 尾部最多 3 行"）：
 *  操作员裁定 3 行，write/edit 窗不在本常量管辖（各自独立帽）。 */
export const RESULT_PREVIEW_WINDOW = 3;

/** 新建预览溢出文案：`+N more lines`（N = 被截去的行数）。人读合同
 *  （spec D3 / docs/CONTEXT.md write create preview / fence display cap）
 *  钉死英文形态；围栏 32 行帽与新建 10 行帽共用本标签，两条渲染路径
 *  （markdown fence / html）与完成态预览不再各写一份文案。 */
export function previewOverflowLabel(hiddenLineCount: number): string {
  return `+${hiddenLineCount} more lines`;
}

/** 语义别名：新建预览溢出（D3）。保留独立名让完成态预览的调用点读到意图，
 *  字节与 `previewOverflowLabel` 一致（同一 SSOT 函数）。 */
export const writePreviewOverflowLabel = previewOverflowLabel;

/** #693 T4 D4:结果预览溢出文案。`… +N 行`（N = 被截去的行数）—— 与
 *  write/edit 溢出对齐意图（藏尾部行数），但 spec D4 钉死为
 *  `… +N 行` 形态（首行前置），把测试摘要/git 结果通常在末尾这一信号
 *  显式给到读者。 */
export function resultPreviewOverflowLabel(hiddenLineCount: number): string {
  return `… +${hiddenLineCount} 行`;
}

/** #693 T4 D4:工具结果预览（bash / skill 等子进程输出）。live 路径走
 *  `run.stdout / run.stderr` 旁路；历史路径走 `toolResultTextMap` 投影到
 *  bash JSON envelope 的 `output` 字段。ANSI 透传：保留转义序列，只在
 *  「可见性判定（是否空）」与「溢出行数计算」上按 ANSI 剥离后宽度计数，
 *  实际行内容原样透传。
 *
 *  边界（spec D4 钉死）：
 *   - 输出为空 / 全空白 / ANSI strip 后为空 → `{ kind: "empty" }`；
 *   - 截取文本「尾部」RESULT_PREVIEW_WINDOW 行（3 行封顶），首行 +N
 *     标记溢出；
 *   - 单行直接显示 1 行（不强制 3 行格式）；
 *   - ANSI 序列按剥离后宽度计数（`string-width` 内建 ANSI 处理），
 *     截断不得切断转义序列中间 —— 因行内不再二次裁剪（行级截断只按
 *     行数，不按视觉宽度），该约束天然成立；
 *   - 失败由渲染层在 ToolSummaryRow 外层包 error 色 token 体现；
 *     preview 文本本身不变（spec：「失败时内容照常显示但整体标红」）。 */
export type ResultPreview =
  | { readonly kind: "empty" }
  | {
      readonly kind: "result";
      readonly lines: readonly string[];
      readonly hiddenLineCount: number;
    };

const EMPTY_RESULT_PREVIEW: ResultPreview = { kind: "empty" };

/** 尾部取 N 行 + 溢出计数。lines.length <= N → 整段透传。 */
function takeTailWindow(lines: readonly string[]): {
  readonly visible: readonly string[];
  readonly hiddenLineCount: number;
} {
  if (lines.length <= RESULT_PREVIEW_WINDOW) {
    return { visible: lines, hiddenLineCount: 0 };
  }
  const tail = lines.slice(lines.length - RESULT_PREVIEW_WINDOW);
  return {
    visible: tail,
    hiddenLineCount: lines.length - RESULT_PREVIEW_WINDOW,
  };
}

/** 单源：从「可能含 ANSI 的输出」判定是否应渲染预览块。空 / 全空白 /
 *  ANSI strip 后为空 → 视为空（不渲染空块）。 */
function isRenderableOutput(s: string): boolean {
  if (s.length === 0) return false;
  // 整段全空白：visible 仅空白 / 换行 / ANSI 序列。
  const stripped = stripAnsi(s);
  if (stripped.trim().length === 0) return false;
  // ANSI strip 后空（理论上上述已覆盖；保留以防 ANSI 序列独占整段）。
  if (stripped.length === 0) return false;
  return true;
}

export type CompletedToolPreview =
  | { readonly kind: "empty" }
  | {
      /** write create preview：新建文件正文前 10 行 + `+N more lines`。 */
      readonly kind: "code";
      readonly lines: readonly string[];
      readonly hiddenLineCount: number;
    }
  | {
      /** edit diff preview：本次改动 diff，**不截断**（D4）。 */
      readonly kind: "diff";
      readonly rows: readonly DiffLine[];
      readonly hiddenLineCount: number;
    }
  | {
      /** 挤档（spec D5）：视图被多写/子代理挤住时，写/改只留标题行的
       *  `Wrote N lines to <path>`，正文预览整段让位（不是被截断）。 */
      readonly kind: "squeeze";
      readonly line: string;
    };

const EMPTY_COMPLETED_PREVIEW: CompletedToolPreview = { kind: "empty" };

function splitContentLines(content: string): readonly string[] {
  if (content.length === 0) return [];
  const lines = content.split("\n");
  return lines[lines.length - 1] === "" ? lines.slice(0, -1) : lines;
}

/** 可见窗截断（仅用于 **write create preview**；编辑 diff 不截断）。 */
function truncateWindow<T>(items: readonly T[]): {
  readonly visible: readonly T[];
  readonly hiddenLineCount: number;
} {
  if (items.length <= WRITE_CREATE_PREVIEW_WINDOW) {
    return { visible: items, hiddenLineCount: 0 };
  }
  return {
    visible: items.slice(0, WRITE_CREATE_PREVIEW_WINDOW),
    hiddenLineCount: items.length - WRITE_CREATE_PREVIEW_WINDOW,
  };
}

function resolveWriteEditPair(
  name: string,
  rec: Record<string, unknown>,
  opts?: {
    readonly oldContent?: string;
    readonly newContent?: string;
  }
): { readonly oldContent: string; readonly newContent: string } | null {
  let oldContent = opts?.oldContent;
  let newContent = opts?.newContent;
  if (oldContent === undefined || newContent === undefined) {
    if (name === "edit_file") {
      const o = rec.old_str;
      const n = rec.new_str;
      if (typeof o !== "string" || typeof n !== "string") return null;
      oldContent = o;
      newContent = n;
    } else if (name === "write_file") {
      const c = rec.content;
      if (typeof c !== "string") return null;
      // 无 side-channel 旧内容 → 视为新建（纯 add）。历史路径没有读盘前的
      // 旧内容（meta 在 model 边界被丢弃），该假设由调用方显式传
      // oldContent 才被推翻。
      if (oldContent === undefined) oldContent = "";
      newContent = c;
    } else {
      return null;
    }
  }
  return { oldContent, newContent };
}

function hasPreviewPath(rec: Record<string, unknown>): boolean {
  return typeof rec.path === "string" && rec.path.length > 0;
}

/**
 * 完成态 write/edit 预览分类（specs/tui-human-display.md D3–D5）：
 *  - **新建**（write_file 且旧内容为空）→ `kind: "code"`，正文前 10 行 +
 *    `+N more lines`（`WRITE_CREATE_PREVIEW_WINDOW`）；
 *  - **覆盖已有文件 / edit_file** → `kind: "diff"`，本次改动 diff **不截断**
 *    （hiddenLineCount 恒 0；D4 明令不套新建那 10 行帽）；
 *  - **挤档**（调用方显式声明视图被挤，如子代理并排）→ `kind: "squeeze"`，
 *    正文预览让位，只留标题行 `Wrote N lines to <path>`（由调用方拼装）。
 *
 *  非 write/edit、缺 path、空正文（无 diff 行且非新建正文）→ `{ kind: "empty" }`。
 *  不读工作区；权威数据 = input + 旁路 old/newContent。
 */
export function completedToolPreview(
  name: string,
  input: unknown,
  opts?: {
    /** 写盘前旧内容（write_file 覆盖判定 → diff 基线）。 */
    readonly oldContent?: string;
    readonly newContent?: string;
    /** 挤档：视图被多写/子代理挤住 → 正文预览整段让位（D5）。
     *  **尚未接线**：D5 是「可」权限不是硬要求，主会话默认走 D3/D4；
     *  当前无调用方传本值时该分支不可达，待拥挤信号（同轮多写 /
     *  子代理挤视图）在渲染层可用后再接。 */
    readonly squeezed?: boolean;
  }
): CompletedToolPreview {
  if (name !== "write_file" && name !== "edit_file") {
    return EMPTY_COMPLETED_PREVIEW;
  }
  const rec = inputRecord(input);
  if (!hasPreviewPath(rec)) return EMPTY_COMPLETED_PREVIEW;
  if (opts?.squeezed === true) {
    return {
      kind: "squeeze",
      line: squeezeWriteSummary(input, opts.newContent),
    };
  }
  const pair = resolveWriteEditPair(name, rec, opts);
  if (pair === null) return EMPTY_COMPLETED_PREVIEW;
  if (name === "write_file" && pair.oldContent === "") {
    const { visible, hiddenLineCount } = truncateWindow(
      splitContentLines(pair.newContent)
    );
    if (visible.length === 0) return EMPTY_COMPLETED_PREVIEW;
    return { kind: "code", lines: visible, hiddenLineCount };
  }
  // D4：编辑/覆盖画本次改动 diff，不截断（hiddenLineCount 恒 0）。
  const rows = toolPreviewRows(name, rec, 0, {
    oldContent: pair.oldContent,
    newContent: pair.newContent,
  });
  if (rows.length === 0) return EMPTY_COMPLETED_PREVIEW;
  return { kind: "diff", rows, hiddenLineCount: 0 };
}

/**
 * 无界 DiffLine 助手（非生产 UI SSOT）：edit_file / write_file 调用
 * `computeDiff` 产出完整 `DiffLine[]`。其余工具 / 无内容 → 空数组。
 * 生产完成态预览走 `completedToolPreview`（create 保持代码行，diff 再截断
 * 本函数的结果）；测试仍用本函数锁 write_file create 的整文件绿 diff。
 *
 * `opts.oldContent / opts.newContent`（side-channel）：live 运行完成事件
 * 携带读盘前后全文（与 model tool_result 严格分离）→ 精确 diff。缺省（历史
 * 持久化消息，meta 在 model 边界被丢弃）回退 intent-diff：
 *  - edit_file：input.old_str / input.new_str 片段 diff；
 *  - write_file：old 视为空串 → 纯 add；
 *  - 其余工具：空数组。
 */
export function toolPreviewRows(
  name: string,
  input: unknown,
  _cols: number,
  opts?: {
    readonly oldContent?: string;
    readonly newContent?: string;
  }
): readonly DiffLine[] {
  if (name !== "edit_file" && name !== "write_file") return [];
  const pair = resolveWriteEditPair(name, inputRecord(input), opts);
  if (pair === null) return [];
  return computeDiff(name, pair.oldContent, pair.newContent);
}

/** 挤档标题行（spec D5）：`Wrote N lines to <path>`。N = 本次写入正文的
 *  可见行数；`newContent` 缺席（历史无旁路）→ 省略 N，只留路径。 */
export function squeezeWriteSummary(
  input: unknown,
  newContent?: string
): string {
  const rec = inputRecord(input);
  const path =
    typeof rec.path === "string" && rec.path.length > 0 ? rec.path : "?";
  if (typeof newContent !== "string" || newContent.length === 0) {
    return `Wrote to ${path}`;
  }
  return `Wrote ${countLines(newContent)} lines to ${path}`;
}

/** tool_use_id → is_error 状态映射（tool_result 精确配对，SSOT）。 */
export function toolResultStatusMap(
  messages: ReadonlyArray<AnthropicNativeMessage>
): Map<string, boolean> {
  const map = new Map<string, boolean>();
  for (const msg of messages) {
    for (const block of msg.content) {
      if (block.type === "tool_result") {
        map.set(block.tool_use_id, block.is_error === true);
      }
    }
  }
  return map;
}

/** #693 T4 D4:tool_use_id → tool_result 文本映射（历史结果预览数据源 SSOT）。
 *  - content 是 string → 原样透传（最常见形态：bash JSON envelope / skill 正文）；
 *  - content 是 AnthropicContentBlock[] → 拼所有 text block（按出现顺序,空块跳过）。
 *    block 形态出现于 ACI 链路：handler 复杂返回（如 structured object）的
 *    AnthropicContentBlock[] 编码走 blocks。bash / skill 走 string,故文本分支
 *    实际命中。
 *  - 未配对 tool_result / 既非 string 也非 array → 缺席（consumer 走 empty 预览）。
 */
export function toolResultTextMap(
  messages: ReadonlyArray<AnthropicNativeMessage>
): Map<string, string> {
  const map = new Map<string, string>();
  for (const msg of messages) {
    for (const block of msg.content) {
      if (block.type !== "tool_result") continue;
      const content = block.content;
      if (typeof content === "string") {
        if (content.length > 0) map.set(block.tool_use_id, content);
        continue;
      }
      if (Array.isArray(content)) {
        const parts: string[] = [];
        for (const part of content) {
          if (
            part !== null &&
            typeof part === "object" &&
            "type" in part &&
            (part as { type?: unknown }).type === "text" &&
            "text" in part &&
            typeof (part as { text?: unknown }).text === "string"
          ) {
            const t = (part as { text: string }).text;
            if (t.length > 0) parts.push(t);
          }
        }
        const joined = parts.join("");
        if (joined.length > 0) map.set(block.tool_use_id, joined);
      }
    }
  }
  return map;
}

/**
 * 从权威 messages 投影工具摘要行（resume 渲染 / 单测用）：
 * assistant.tool_use 产出行，tool_result 按 tool_use_id 回填状态。
 */
export function projectToolLines(
  messages: ReadonlyArray<AnthropicNativeMessage>
): ReadonlyArray<ToolSummaryLine> {
  const statusMap = toolResultStatusMap(messages);
  const lines: ToolSummaryLine[] = [];
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    for (const block of msg.content) {
      if (block.type !== "tool_use") continue;
      const { detail } = summarizeToolCall(block.name, block.input);
      const hasResult = statusMap.has(block.id);
      const failed = statusMap.get(block.id) === true;
      lines.push({
        toolName: block.name,
        detail,
        status: !hasResult ? "unknown" : failed ? "failed" : "ok",
      });
    }
  }
  return lines;
}

// 运行中 bash 前缀（BASH_RUNNING_PREFIX）与工具状态行拼装
// （formatToolStatusLine / formatLiveToolEvent）的实现均在
// src/shared/tool-line.ts（CLI 同源），本文件顶部 re-export。
