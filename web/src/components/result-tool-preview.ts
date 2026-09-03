/**
 * web/src/components/result-tool-preview.ts
 *
 * Mirrors `resultToolPreview` in src/tui/tool-summary.ts (T4 D4) — same rule,
 * separate code (web can't import src/). D6 web 一致性: web 端 toolCalls 活动
 * 流消费 D4 同规则 (5 行尾部窗口 + 溢出 `… +N 行` + ANSI 透传 + 空 / 全空白
 * / ANSI-only 不渲染)。
 *
 * Web 数据来源: wire `ToolCallView.outputPreview`(已 mask + 截断到
 * `MAX_TOOL_OUTPUT_PREVIEW_CHARS` = 1500 chars)。bash 走 JSON envelope →
 * mirror TUI 的 parse-then-extract 逻辑 (`stdout` / `stderr` 字段拼接)。
 *
 * 边界（与 TUI 一致）：
 *   - 输出为空 / 全空白 / ANSI strip 后为空 → `{ kind: "empty" }`；
 *   - 截取尾部 `RESULT_PREVIEW_WINDOW` (5) 行 + 溢出行数；
 *   - 单行直接显示 1 行（不强制 5 行格式）；
 *   - ANSI 序列按剥离后宽度计数，截断不得切断转义序列中间（行级截断天然不切
 *     字符）；
 *   - read_file / write_file / edit_file 等无 preview 需求的工具 → `empty`。
 *
 * 失败由渲染层在 ToolCallItem 外层 / OutputBlock 内层包 error 色 token 体现；
 * preview 文本本身不变（spec：「失败时内容照常显示但整体标红」）。
 */
import type { ToolCallView } from "../api/types.ts";

/** #693 T4 D4:结果预览可见窗（与 TUI 同值，5 行）。 */
export const RESULT_PREVIEW_WINDOW = 5;

/** 命名风格上沿用"result-tool-preview",与 TUI 端 `resultToolPreview` 同义。 */
export type ResultPreview =
  | { readonly kind: "empty" }
  | {
      readonly kind: "result";
      readonly lines: readonly string[];
      /** 被截掉的行数 = totalLines - visibleLines（visibleLines 始终 = min(5, totalLines)）。 */
      readonly hiddenLineCount: number;
    };

const ANSI_ESCAPE_RE =
  /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

/** 剥 ANSI 转义序列（仅用于「可见性判定」；不修改原字符串）。 */
export function stripAnsi(s: string): string {
  return s.replace(ANSI_ESCAPE_RE, "");
}

/** 溢出文案:`… +N 行`（spec D4 钉死）。 */
export function resultPreviewOverflowLabel(hiddenLineCount: number): string {
  return `… +${hiddenLineCount} 行`;
}

/** 可消费预览的工具集合。skill 类一行结果;bash JSON envelope 内嵌 stdout/stderr。
 *  read_file / write_file / edit_file / grep / glob / web_* / lsp_* 等无预览需求
 *  工具一律走 empty 输出（spec D4 边界）。 */
const PREVIEWABLE_TOOLS: ReadonlySet<string> = new Set(["bash", "skill"]);

/** bash tool_result 文本 → 拼接后的输出（与 TUI `bashPreview` 同语义）。
 *  若 JSON.parse 成功且含 `stdout` / `stderr` 字段 → 按 stdout + "\n" + stderr 拼；
 *  JSON 解析成功但缺字段 → 返回空串（让外层 isRenderableOutput 直接判 empty，
 *  与 TUI 行为一致 —— TUI 中 streams.length === 0 时整 preview 返回 empty）；
 *  parse 失败 → 退到把整段 resultText 当 stdout 处理。 */
function extractBashOutput(resultText: string): string {
  try {
    const parsed = JSON.parse(resultText) as Record<string, unknown>;
    const streams: string[] = [];
    if (typeof parsed.stdout === "string" && parsed.stdout.length > 0) {
      streams.push(parsed.stdout);
    }
    if (typeof parsed.stderr === "string" && parsed.stderr.length > 0) {
      streams.push(parsed.stderr);
    }
    return streams.join("\n");
  } catch {
    // 非 JSON 形态:整段当 stdout 处理(TUI 退路)。
  }
  return resultText;
}

/** 单源:从「可能含 ANSI 的输出」判定是否应渲染预览块。
 *  空 / 全空白 / ANSI strip 后为空 → 视为空(不渲染空块)。 */
function isRenderableOutput(s: string): boolean {
  if (s.length === 0) return false;
  const stripped = stripAnsi(s);
  if (stripped.trim().length === 0) return false;
  if (stripped.length === 0) return false;
  return true;
}

/** 按行切分(保留 ANSI);尾部空行去掉(bash 输出常见 trailing \n)。 */
function splitOutputLines(s: string): string[] {
  if (s.length === 0) return [];
  const lines = s.split("\n");
  return lines[lines.length - 1] === "" ? lines.slice(0, -1) : lines;
}

/** 尾部取 N 行 + 溢出计数。lines.length <= N → 整段透传。 */
function takeTailWindow(lines: readonly string[]): {
  readonly visible: string[];
  readonly hiddenLineCount: number;
} {
  if (lines.length <= RESULT_PREVIEW_WINDOW) {
    return { visible: lines.slice(), hiddenLineCount: 0 };
  }
  const tail = lines.slice(lines.length - RESULT_PREVIEW_WINDOW);
  return {
    visible: tail,
    hiddenLineCount: lines.length - RESULT_PREVIEW_WINDOW,
  };
}

/**
 * 单源:根据工具名 + wire 上的 `outputPreview` 产结果预览。
 *  无 preview 声明 / 无 outputPreview / 空输出 → `{ kind: "empty" }`。
 */
export function resultToolPreview(
  toolName: string,
  outputPreview: ToolCallView["outputPreview"]
): ResultPreview {
  if (outputPreview === undefined || outputPreview.length === 0) {
    return { kind: "empty" };
  }
  if (!PREVIEWABLE_TOOLS.has(toolName)) return { kind: "empty" };

  const raw =
    toolName === "bash" ? extractBashOutput(outputPreview) : outputPreview;
  if (!isRenderableOutput(raw)) return { kind: "empty" };

  const lines = splitOutputLines(raw);
  if (lines.length === 0) return { kind: "empty" };

  const { visible, hiddenLineCount } = takeTailWindow(lines);
  if (visible.length === 0) return { kind: "empty" };

  return { kind: "result", lines: visible, hiddenLineCount };
}
