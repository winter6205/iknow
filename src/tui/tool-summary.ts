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
 * 用户看不到写了什么代码。`toolPreviewRows` 产出统一 diff 预览行
 * （computeDiff 单源，T5），message-rows、MessageBlocks、live-tool-preview
 * 共用单源保持行账一致。
 */
import type { AnthropicNativeMessage } from "../harness/model-adapter/types.js";
import { visualWidth } from "./banner.js";
import { clipOneLine, clipOneLineVisual } from "./text.js";
import { computeDiff, type DiffLine } from "./diff-unified.js";

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

/**
 * 工具内容预览行（内容可见性，#298 T5 统一 diff 版）：edit_file / write_file
 * 调用 `computeDiff`（diff-unified.ts）产出逐行 `DiffLine[]`（带行号 + kind，
 * 供 diff-view.tsx 上色/排行号）。其余工具 / 无内容 → 空数组。
 *
 * `opts.oldContent / opts.newContent`（T4 side-channel）：live 运行完成事件
 * 携带读盘前后全文（与 model tool_result 严格分离）→ 精确 diff。缺省（历史
 * 持久化消息，meta 在 model 边界被丢弃）回退 intent-diff：
 *  - edit_file：input.old_str / input.new_str 片段 diff；
 *  - write_file：old 视为空串 → 纯 add；
 *  - 其余工具：空数组（无 diff 预览，保持历史行账）。
 *
 * SSOT：message-rows.ts（行账 + 裁剪路径）与 message-blocks.tsx（全可见
 * 路径）、live-tool-preview.tsx（live tail）共用本函数，行账与渲染不漂移。
 */
export function toolPreviewRows(
  name: string,
  input: unknown,
  _cols: number,
  opts?: { readonly oldContent?: string; readonly newContent?: string }
): readonly DiffLine[] {
  const rec = inputRecord(input);
  if (name === "edit_file" || name === "write_file") {
    let oldContent = opts?.oldContent;
    let newContent = opts?.newContent;
    if (oldContent === undefined || newContent === undefined) {
      if (name === "edit_file") {
        const o = rec.old_str;
        const n = rec.new_str;
        if (typeof o !== "string" || typeof n !== "string") return [];
        oldContent = o;
        newContent = n;
      } else {
        // write_file：old 视为空串（新文件 / 覆盖写都按纯新增展示）。
        const c = rec.content;
        if (typeof c !== "string") return [];
        oldContent = "";
        newContent = c;
      }
    }
    return computeDiff(name, oldContent, newContent);
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
