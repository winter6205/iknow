/**
 * src/tui/tool-summary.ts
 *
 * #343 T4（自 archive/tui-ink/src/tool-summary.ts 迁移，语义不变）：
 * 工具调用摘要行（纯格式化，可单测）：
 *  - 摘要行 = 工具名 + 参数摘要 + 状态；
 *  - 生成/编辑类增强：write_file/edit_file 显示「生成了什么」（路径 + 行数）。
 *
 * 宽度纪律（窄终端修复）：摘要行渲染形态有三种——终稿 `[运行中] name · detail`、
 * live 完成行 `name · detail · ok`、live 运行行——行级窗口账目一律按 1 行计。
 * 传 `cols` 时按视觉宽度收口（预留最宽装饰），保证三种形态单行不折。
 *
 * 内容可见性：write_file / edit_file 完成后 `toolPreviewRows` 产出统一 diff
 * 预览行（computeDiff 单源），`MessageBlocks` 渲染与 `live-tool-preview`
 * 共用本函数作为单源——行账与渲染不漂移。
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
 * 工具内容预览行（内容可见性，统一 diff 版）：edit_file / write_file 调用
 * `computeDiff`（diff-unified.ts）产出逐行 `DiffLine[]`（带行号 + kind，
 * 供 diff-view.tsx 上色/排行号）。其余工具 / 无内容 → 空数组。
 *
 * `opts.oldContent / opts.newContent`（side-channel）：live 运行完成事件
 * 携带读盘前后全文（与 model tool_result 严格分离）→ 精确 diff。缺省（历史
 * 持久化消息，meta 在 model 边界被丢弃）回退 intent-diff：
 *  - edit_file：input.old_str / input.new_str 片段 diff；
 *  - write_file：old 视为空串 → 纯 add；
 *  - 其余工具：空数组（无 diff 预览，保持历史行账）。
 *
 * SSOT：`MessageBlocks`（全可见路径渲染）与 `live-tool-preview`（live tail）
 * 共用本函数产 diff 行——行账与渲染不漂移。
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
 *  文本拼接全部落在此处，禁止复制 `${name} · ${detail} · ${status}` 模板。
 *
 *  字节规则:
 *   - detail 非空 → `${toolName} · ${detail} · ${status}`
 *   - detail 空   → `${toolName} · ${status}`（省去中间分隔符，避免残留）
 *
 *  `detail` 可选 override：装配层已完成事件携带 precomputed detail
 *  （如 liveToolReducer 落地）时，通过显式 detail 跳过 summarizeToolCall
 *  重算，保证完成事件渲染与 reducer state.detail 字节一致。 */
export function formatLiveToolEvent(opts: {
  readonly toolName: string;
  readonly input: unknown;
  readonly kind: string;
  /** 显式 detail override；提供时跳过 summarizeToolCall 重算。 */
  readonly detail?: string;
}): string {
  const detail =
    opts.detail ?? summarizeToolCall(opts.toolName, opts.input).detail;
  const status = opts.kind === "ok" ? "ok" : "failed";
  if (detail.length === 0) return `${opts.toolName} · ${status}`;
  return `${opts.toolName} · ${detail} · ${status}`;
}
