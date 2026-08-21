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
 * 宽度纪律（窄终端修复）：摘要行渲染形态有三种——终稿 `[运行中] name · detail`、
 * live 完成行 `name · detail · ok`、live 运行行（T5 含 partial 摘要）——
 * 行级窗口账目一律按 1 行计。传 `cols` 时按视觉宽度收口（预留最宽装饰），
 * 保证三种形态单行不折。
 *
 * 内容可见性：write_file / edit_file 完成后 `completedToolPreview` 产出
 * 截断代码或 diff（UI SSOT）；live box 与历史 `ToolPreviewRows` 共用
 * `CompletedToolPreviewView` 渲染。`toolPreviewRows` 仍是无界 DiffLine
 * 助手（测试锁 create 整文件绿 diff），生产 UI 不直接调用。
 *
 * 文本收口助手（visualWidth / clipOneLine / clipOneLineVisual）：归档时代
 * SSOT 在 text.ts（未入 T4 迁移清单），T4 范围内收敛在本文件导出，供
 * context-bar / list-view 共用；后续弹如需独立 text.ts 再整体搬移。
 */
import stringWidth from "string-width";
import type { AnthropicNativeMessage } from "../harness/model-adapter/types.js";
import { computeDiff, type DiffLine } from "./diff-unified.js";

/** 视觉列宽（CJK / 全角按 2 列，string-width 口径）。 */
export function visualWidth(s: string): number {
  return stringWidth(s);
}

/** 单行裁剪（字符数口径）：折叠空白，超长按字符数截断补 `…`。 */
export function clipOneLine(s: string, max: number): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/**
 * 按**视觉宽度**截断单行（CJK 占 2 列）。保证结果 `visualWidth <= maxWidth`；
 * 省略号预留 1 列。maxWidth <= 0 返回空串。
 */
export function clipOneLineVisual(s: string, maxWidth: number): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  if (maxWidth <= 0) return "";
  if (visualWidth(oneLine) <= maxWidth) return oneLine;
  const budget = maxWidth - 1;
  let acc = "";
  let w = 0;
  for (const ch of oneLine) {
    const cw = visualWidth(ch);
    if (w + cw > budget) break;
    acc += ch;
    w += cw;
  }
  return `${acc}…`;
}

export interface ToolSummaryLine {
  readonly toolName: string;
  readonly detail: string;
  /** ok | failed | unknown（tool_result 未到达，如 cancelled 中断）。 */
  readonly status: "ok" | "failed" | "unknown";
}

const MAX_DETAIL = 80;
/** 装饰预留（两种形态取并集）：终稿行 `[运行中] `（9 列）+ 分隔 ` · `（3 列）
 *  + live 完成行状态后缀 ` · failed`（9 列）= 21。单形态最多用 12，按并集
 *  收口保证任何渲染形态都单行不折。 */
const CHROME_RESERVE = 21;

function inputRecord(input: unknown): Record<string, unknown> {
  return typeof input === "object" && input !== null
    ? (input as Record<string, unknown>)
    : {};
}

function countLines(s: unknown): number {
  if (typeof s !== "string" || s.length === 0) return 0;
  return s.split("\n").length;
}

/** detail 截断：给了 cols 走视觉宽度收口（保证单行不折），否则 legacy 80。 */
function clipDetail(s: string, name: string, cols: number | undefined): string {
  if (cols === undefined) return clipOneLine(s, MAX_DETAIL);
  const budget = Math.max(4, cols - visualWidth(name) - CHROME_RESERVE);
  return clipOneLineVisual(s, Math.min(MAX_DETAIL, budget));
}

/** 字段提取辅助：string 字段（缺失 → fallback），避免逐 case 重复防御。 */
function pickString(
  rec: Record<string, unknown>,
  key: string,
  fallback = "?"
): string {
  const v = rec[key];
  return typeof v === "string" ? v : fallback;
}

/** 字段提取辅助：number 字段（缺失/非有限数 → null）。 */
function pickNumber(rec: Record<string, unknown>, key: string): number | null {
  const v = rec[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** LSP 工具：共享「file[:line]」模板（definition/references/hover/...）。 */
function lspAt(rec: Record<string, unknown>, name: string): string {
  const file = pickString(rec, "file");
  const line = pickNumber(rec, "line");
  return `LSP ${name.replace("lsp_", "")} ${file}${line !== null ? `:${line}` : ""}`;
}

/** 子代理工具专属显示（与普通工具行区分；主流 Agent 惯例：子代理调用有独立
 *  视觉，不与普通工具共用 `[运行中] name · detail` 形态）。几何字形，无 emoji
 *  （spec #146:86）。 */
export const SUBAGENT_TOOL_LABEL = "子代理";

/** 子代理工具判定：spawn_subagent（派发）+ subagent_result（轮询）。 */
export function isSubagentTool(name: string): boolean {
  return name === "spawn_subagent" || name === "subagent_result";
}

/** 子代理工具状态字形：running → ▣，ok → ✓，failed → ✗。 */
export function subagentDisplayMark(kind: "running" | "ok" | "failed"): string {
  if (kind === "ok") return "✓";
  if (kind === "failed") return "✗";
  return "▣";
}

/** 工具 → 摘要器 lookup table。每项返回未 clip 的 detail 文本。 */
const SUMMARIZERS: Readonly<
  Record<string, (rec: Record<string, unknown>) => string>
> = {
  write_file: (r) =>
    `写入 ${pickString(r, "path")}（${countLines(r.content)} 行）`,
  bash: (r) => pickString(r, "command", ""),
  edit_file: (r) => {
    const all = r.replace_all === true;
    return `编辑 ${pickString(r, "path")}${all ? "（全部替换）" : ""}：${pickString(r, "old_str", "")} → ${pickString(r, "new_str", "")}`;
  },
  read_file: (r) => `读取 ${pickString(r, "path")}`,
  grep: (r) => `搜索 ${pickString(r, "pattern")}`,
  glob: (r) => `匹配 ${pickString(r, "pattern")}`,
  // web / memory / skill / search 类：聚焦首个关键字段，避免 JSON 全文外露。
  web_search: (r) => `搜索 ${pickString(r, "query")}`,
  web_fetch: (r) => `抓取 ${pickString(r, "url")}`,
  memory_recall: (r) => `记忆 召回 ${pickString(r, "query")}`,
  memory_save: (r) => `记忆 写入 ${pickString(r, "title")}`,
  tool_search: (r) => {
    const names = Array.isArray(r.names) ? `names=${r.names.length}` : "";
    return `工具 ${pickString(r, "query", names || "?")}`;
  },
  skill: (r) => `skill ${pickString(r, "name")}`,
  skill_search: (r) => `skill ${pickString(r, "query")}`,
  spawn_subagent: (r) =>
    `派发子代理：${pickString(r, "task", "").slice(0, 60) || "?"}`,
  subagent_result: (r) => `轮询 ${pickString(r, "task_id")}`,
  // LSP 工具集：10 件。8 件共享 file[:line] 模板；documentSymbol / workspaceSymbol 走各自形态。
  lsp_definition: (r) => lspAt(r, "lsp_definition"),
  lsp_references: (r) => lspAt(r, "lsp_references"),
  lsp_hover: (r) => lspAt(r, "lsp_hover"),
  lsp_go_to_implementation: (r) => lspAt(r, "lsp_go_to_implementation"),
  lsp_prepare_call_hierarchy: (r) => lspAt(r, "lsp_prepare_call_hierarchy"),
  lsp_incoming_calls: (r) => lspAt(r, "lsp_incoming_calls"),
  lsp_outgoing_calls: (r) => lspAt(r, "lsp_outgoing_calls"),
  lsp_diagnostics: (r) => lspAt(r, "lsp_diagnostics"),
  lsp_document_symbol: (r) => `LSP documentSymbol ${pickString(r, "file")}`,
  lsp_workspace_symbol: (r) => `LSP workspaceSymbol ${pickString(r, "query")}`,
};

/**
 * 单个工具调用的参数摘要。`cols` = 终端列宽：提供时 detail 按视觉宽度
 * 收口到「装饰 + 工具名 + detail」单行放得下（窄终端不折行，行账不漂移）。
 *
 * lookup table（SUMMARIZERS）dispatch：每个工具独立摘要器，函数体保持
 * ≤10 行 / 圈复杂度 ≤10（complexity-anti-drift）；未知工具走 `(name)`
 * 占位符（2026-08-13 用户反馈 tool fold 不该 JSON 全文外露）。
 */
export function summarizeToolCall(
  name: string,
  input: unknown,
  cols?: number
): { detail: string } {
  const rec = inputRecord(input);
  const clip = (s: string): string => clipDetail(s, name, cols);
  // 真未知工具：仅显示工具名占位，避免 JSON 全文外露
  // （2026-08-13 用户反馈 tool fold 不该把 input args 全 JSON stringify）。
  if (!(name in SUMMARIZERS)) return { detail: clip(`(${name})`) };
  return { detail: clip(SUMMARIZERS[name]!(rec)) };
}

/**
 * T5:运行中 partial JSON 文本的摘要。对逐段累积的 `partialJson` 尽力
 * `JSON.parse`：
 *  - parse 成功 → 走 `summarizeToolCall`（与完成态摘要同源，字节一致）；
 *  - parse 失败（partial 不完整 JSON，如 `{"command":"l`）或 primitive 形态
 *    （null / 数字 / 布尔）→ `clipDetail` 原样截断显示（单源，视觉宽度纪律）；
 *  - 空串 → 空串。
 *
 * 遮蔽说明：partial 里可能含密钥形态，但增量只服务展示层中间态——完成后的
 * 权威完整 input 才进模型；此处仅视觉截断，不接 output mask（风险低，保持
 * 单行收口简单）。
 */
export function summarizePartialInput(
  name: string,
  partialJson: string,
  cols?: number
): string {
  if (partialJson.length === 0) return "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(partialJson);
  } catch {
    parsed = undefined;
  }
  // 不完整 JSON（parse 失败）或 primitive 形态（null / 数字 / 布尔 —— 工具参数
  // 语义上只有 object/array）→ 原样截断显示。截断口径 = clipDetail 单源
  // （与完成态摘要同一视觉宽度纪律，避免预算公式漂移）。
  if (
    parsed === undefined ||
    (typeof parsed !== "object" && typeof parsed !== "boolean")
  ) {
    return clipDetail(partialJson, name, cols);
  }
  return summarizeToolCall(name, parsed, cols).detail;
}

/** 一条 assistant 消息内 `name === "bash"` 的 `tool_use` block 计数（T4）。
 *  折叠摘要「ran N command(s)」的 N 数据源：聚合语义——「某命令跑了几次」
 *  对同一条 assistant 消息内多次调 bash 最有意义，非 per-call。非 bash /
 *  非 assistant 消息一律 0（"ran N commands" 只对 shell 语义成立）。 */
export function countBashCalls(message: AnthropicNativeMessage): number {
  if (message.role !== "assistant") return 0;
  let n = 0;
  for (const block of message.content) {
    if (block.type === "tool_use" && block.name === "bash") n += 1;
  }
  return n;
}

/** ran N command(s) 后缀文案（T4）。逗号全角接在 detail 后；N <= 0 → 空串。
 *  plural：N === 1 → `ran 1 command`；N > 1 → `ran N commands`。 */
export function formatRanSuffix(count: number): string {
  if (count === 1) return "，ran 1 command";
  if (count > 1) return `，ran ${count} commands`;
  return "";
}

/** 完成态 write/edit 预览可见窗（live 完成态与历史共用；截断即折叠）。 */
export const TOOL_PREVIEW_WINDOW = 6;

export type CompletedToolPreview =
  | { readonly kind: "empty" }
  | {
      readonly kind: "code";
      readonly lines: readonly string[];
      readonly hiddenLineCount: number;
    }
  | {
      readonly kind: "diff";
      readonly rows: readonly DiffLine[];
      readonly hiddenLineCount: number;
    };

const EMPTY_COMPLETED_PREVIEW: CompletedToolPreview = { kind: "empty" };

function splitContentLines(content: string): readonly string[] {
  if (content.length === 0) return [];
  const lines = content.split("\n");
  return lines[lines.length - 1] === "" ? lines.slice(0, -1) : lines;
}

function truncateWindow<T>(items: readonly T[]): {
  readonly visible: readonly T[];
  readonly hiddenLineCount: number;
} {
  if (items.length <= TOOL_PREVIEW_WINDOW) {
    return { visible: items, hiddenLineCount: 0 };
  }
  return {
    visible: items.slice(0, TOOL_PREVIEW_WINDOW),
    hiddenLineCount: items.length - TOOL_PREVIEW_WINDOW,
  };
}

function resolveWriteEditPair(
  name: string,
  rec: Record<string, unknown>,
  opts?: { readonly oldContent?: string; readonly newContent?: string }
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
      oldContent = "";
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
 * 完成态 write/edit 预览：分类（新文件→代码行；覆盖/编辑→diff）+ 截断到
 * `TOOL_PREVIEW_WINDOW`。非 write/edit、缺 path、空正文 → `{ kind: "empty" }`。
 * 不读工作区；权威数据 = input + 旁路 old/new。
 */
export function completedToolPreview(
  name: string,
  input: unknown,
  opts?: { readonly oldContent?: string; readonly newContent?: string }
): CompletedToolPreview {
  if (name !== "write_file" && name !== "edit_file") {
    return EMPTY_COMPLETED_PREVIEW;
  }
  const rec = inputRecord(input);
  if (!hasPreviewPath(rec)) return EMPTY_COMPLETED_PREVIEW;
  const pair = resolveWriteEditPair(name, rec, opts);
  if (pair === null) return EMPTY_COMPLETED_PREVIEW;
  if (name === "write_file" && pair.oldContent === "") {
    const { visible, hiddenLineCount } = truncateWindow(
      splitContentLines(pair.newContent)
    );
    if (visible.length === 0) return EMPTY_COMPLETED_PREVIEW;
    return { kind: "code", lines: visible, hiddenLineCount };
  }
  const { visible, hiddenLineCount } = truncateWindow(
    toolPreviewRows(name, rec, 0, {
      oldContent: pair.oldContent,
      newContent: pair.newContent,
    })
  );
  if (visible.length === 0) return EMPTY_COMPLETED_PREVIEW;
  return { kind: "diff", rows: visible, hiddenLineCount };
}

/** 完成态预览截断后的溢出提示（live / 历史共用文案）。 */
export function previewOverflowLabel(hiddenLineCount: number): string {
  return `还有 ${hiddenLineCount} 行`;
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
  opts?: { readonly oldContent?: string; readonly newContent?: string }
): readonly DiffLine[] {
  if (name !== "edit_file" && name !== "write_file") return [];
  const pair = resolveWriteEditPair(name, inputRecord(input), opts);
  if (pair === null) return [];
  return computeDiff(name, pair.oldContent, pair.newContent);
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

/** 运行时 postToolUse 事件的摘要行文案（turn 进行中逐条出现）。
 *  SSOT — 完整运行（postToolUse 已完成 + legacy 字符串行）共用单源，
 *  文本拼接全部落在此处，禁止复制 `${name} · ${detail} · ${status}` 模板。
 *
 *  字节规则:
 *   - 普通工具：detail 非空 → `${toolName} · ${detail} · ${status}`；
 *     detail 空 → `${toolName} · ${status}`（省去中间分隔符，避免残留）。
 *   - 子代理工具（spawn_subagent / subagent_result）独立形态：
 *     detail 非空 → `${mark} ${SUBAGENT_TOOL_LABEL} · ${detail}`；
 *     detail 空 → `${mark} ${SUBAGENT_TOOL_LABEL}`（glyph 已表状态，不拼
 *     尾部 ` · ok/failed`）。
 *
 *  `detail` 可选 override：装配层已完成事件携带 precomputed detail
 *  （如 liveToolReducer 落地）时，通过显式 detail 跳过 summarizeToolCall
 *  重算，保证完成事件渲染与 reducer state.detail 字节一致。
 *
 *  `cols` 透传：提供时 detail 按视觉宽度收口（与 summarizeToolCall 同纪律，
 *  「装饰 + 工具名 + detail」单行放得下，窄终端不折行）；缺省 → legacy 80
 *  字符截断（与既有调用方字节兼容）。 */
export function formatLiveToolEvent(opts: {
  readonly toolName: string;
  readonly input: unknown;
  readonly kind: string;
  /** 显式 detail override；提供时跳过 summarizeToolCall 重算。 */
  readonly detail?: string;
  /** 终端列宽（可选）：提供时 detail 按视觉宽度收口；缺省 legacy 80 截断。 */
  readonly cols?: number;
}): string {
  const detail =
    opts.detail ??
    summarizeToolCall(opts.toolName, opts.input, opts.cols).detail;
  const status = opts.kind === "ok" ? "ok" : "failed";
  // 子代理工具分支（独立视觉，glyph + 子代理标签 + detail，不再拼尾部状态）。
  if (isSubagentTool(opts.toolName)) {
    const mark = subagentDisplayMark(status);
    if (detail.length === 0) return `${mark} ${SUBAGENT_TOOL_LABEL}`;
    return `${mark} ${SUBAGENT_TOOL_LABEL} · ${detail}`;
  }
  if (detail.length === 0) return `${opts.toolName} · ${status}`;
  return `${opts.toolName} · ${detail} · ${status}`;
}
