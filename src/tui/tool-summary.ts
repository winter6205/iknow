/**
 * src/tui/tool-summary.ts
 *
 * #146 Q5b=B 工具调用摘要行（纯格式化，可单测）：
 *  - 摘要行 = 工具名 + 参数摘要 + 状态；
 *  - 生成/编辑类增强：write_file/edit_file 显示「生成了什么」
 *    （路径 + 行数；diff 完整形态留实施细化，受无 emoji 约束）。
 *
 * 宽度纪律（窄终端修复）：摘要行渲染形态有三种——终稿 `[完成] name · detail`、
 * live 完成行 `name · detail · ok`、live 运行行——行级窗口账目一律按 1 行计。
 * 旧实现 detail 固定按 80 字符截断，窄终端下超宽被 ink 折行 → 渲染行多于
 * 账目 → 底部内容被顶出可视区（用户观感「内容跟着工具行折叠进去」）。
 * 现传 `cols` 时按视觉宽度收口（预留最宽装饰：mark `[运行中] ` 9 列 +
 * 分隔 ` · ` 3 列），保证三种形态单行不折。
 *
 * 内容可见性（写代码不展示修复）：write_file / edit_file 完成后仅一行摘要，
 * 用户看不到写了什么代码。`toolPreviewLines` 产出封顶预览行（write 30 /
 * edit old+new 各 10），message-rows 与 MessageBlocks 共用单源保持行账一致。
 */
import type { AnthropicNativeMessage } from "../harness/model-adapter/types.js";
import { visualWidth } from "./banner.js";
import { clipOneLine, clipOneLineVisual } from "./text.js";

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

/** 单个工具调用的参数摘要。`cols` = 终端列宽：提供时 detail 按视觉宽度
 *  收口到「装饰 + 工具名 + detail」单行放得下（窄终端不折行，行账不漂移）。 */
export function summarizeToolCall(
  name: string,
  input: unknown,
  cols?: number
): { detail: string } {
  const rec = inputRecord(input);
  const clip = (s: string): string => clipDetail(s, name, cols);
  switch (name) {
    case "write_file": {
      const path = typeof rec.path === "string" ? rec.path : "?";
      const lines = countLines(rec.content);
      return { detail: clip(`写入 ${path}（${lines} 行）`) };
    }
    case "edit_file": {
      const path = typeof rec.path === "string" ? rec.path : "?";
      const all = rec.replace_all === true;
      return {
        detail: clip(
          `编辑 ${path}${all ? "（全部替换）" : ""}：${String(rec.old_str ?? "")} → ${String(rec.new_str ?? "")}`
        ),
      };
    }
    case "bash":
      return { detail: clip(String(rec.command ?? "")) };
    case "read_file":
      return { detail: clip(`读取 ${String(rec.path ?? "?")}`) };
    case "grep":
      return { detail: clip(`搜索 ${String(rec.pattern ?? "?")}`) };
    case "glob":
      return { detail: clip(`匹配 ${String(rec.pattern ?? "?")}`) };
    default:
      return { detail: clip(JSON.stringify(rec)) };
  }
}

/** write_file 预览封顶行数。 */
const WRITE_PREVIEW_MAX = 30;
/** edit_file old/new 各自预览封顶行数。 */
const EDIT_PREVIEW_MAX = 10;

/**
 * 工具内容预览行（内容可见性）：write_file → 所写代码封顶预览；
 * edit_file → old（`-`）/ new（`+`）片段。每行按视觉宽度截断到 cols-4
 * （`  │ `/`  - ` 前缀 4 列），保证单行不折、行账逐行一致。
 * 其余工具 / 无内容 → 空数组。
 *
 * SSOT：message-rows.ts（行账 + 裁剪路径）与 message-blocks.tsx（全可见
 * 路径）、chat-view.tsx（live tail）共用本函数，行账与渲染不漂移。
 */
export function toolPreviewLines(
  name: string,
  input: unknown,
  cols: number
): string[] {
  const rec = inputRecord(input);
  const inner = Math.max(1, cols - 4);
  const cap = (s: string): string => `  │ ${clipOneLineVisual(s, inner)}`;
  if (name === "write_file") {
    const content = typeof rec.content === "string" ? rec.content : "";
    if (content.length === 0) return [];
    const srcLines = content.split("\n");
    const out: string[] = [];
    for (const l of srcLines.slice(0, WRITE_PREVIEW_MAX)) {
      out.push(cap(l === "" ? " " : l));
    }
    if (srcLines.length > WRITE_PREVIEW_MAX) {
      out.push(`  └ 余 ${srcLines.length - WRITE_PREVIEW_MAX} 行未显示`);
    }
    return out;
  }
  if (name === "edit_file") {
    const out: string[] = [];
    const pushPart = (prefix: string, raw: unknown): void => {
      if (typeof raw !== "string" || raw.length === 0) return;
      const srcLines = raw.split("\n").slice(0, EDIT_PREVIEW_MAX);
      for (const l of srcLines) {
        out.push(`  ${prefix} ${clipOneLineVisual(l === "" ? " " : l, inner)}`);
      }
      const total = raw.split("\n").length;
      if (total > EDIT_PREVIEW_MAX) {
        out.push(`  ${prefix} …（余 ${total - EDIT_PREVIEW_MAX} 行）`);
      }
    };
    pushPart("-", rec.old_str);
    pushPart("+", rec.new_str);
    return out;
  }
  return [];
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
 *  文本拼接全部落在此处,禁止复制 `${name} · ${detail} · ${status}` 模板。
 *
 *  字节规则:
 *   - detail 非空 → `${toolName} · ${detail} · ${status}`
 *   - detail 空   → `${toolName} · ${status}`（省去中间分隔符，避免 `name ·  · status` 残 留）
 *
 *  `detail` 可选 override: 装配层已完成事件携带 precomputed detail
 *  (如 liveToolReducer 落地) 时, 通过显式 detail 跳过 summarizeToolCall 重算,
 *  保证完成事件渲染与 reducer state.detail 字节一致。 */
export function formatLiveToolEvent(opts: {
  readonly toolName: string;
  readonly input: unknown;
  readonly kind: string;
  /** 显式 detail override;提供时跳过 summarizeToolCall 重算。 */
  readonly detail?: string;
}): string {
  const detail =
    opts.detail ?? summarizeToolCall(opts.toolName, opts.input).detail;
  const status = opts.kind === "ok" ? "ok" : "failed";
  if (detail.length === 0) return `${opts.toolName} · ${status}`;
  return `${opts.toolName} · ${detail} · ${status}`;
}
