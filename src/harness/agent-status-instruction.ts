/**
 * spec agent-status-instruction-echo T2：真实用户消息甄别谓词（harness 层 SSOT）。
 *
 * 边界:
 *   - `extractLatestRealUserInstruction` 从 messages 尾向前扫第一条**真实**
 *     用户消息（invariant 2）：排除 `isHostInjectedUserText` 名册全部宿主注入，
 *     剥 memory prefetch overlay（marker 在场取**最后一个** marker 之后段，
 *     F6 宁欠勿过）；skill-load 信封计入真实用户消息但取 `\n\n` 后
 *     remainder 首行（首行是装配信封不是用户原话，remainder 空 → 前扫）；
 *   - 提取 = 首行（`\n` 前）、trim 行尾空白、100 **码点**截断（Array.from
 *     计数，非 UTF-16 单元），超限不加省略号（逐字纪律）；首行为空 → 该条
 *     无有效指令源，继续前扫（F2）；
 *   - 纯读取，零抛错（Input-contract 表）；无任何 LLM / adapter 参与（SC2，
 *     由 tests/harness/agent-status-instruction-seam.test.ts grep 锁钉住）；
 *   - 名册前缀常量（MCP 重连 / LOOP_DETECTED / compact 三缝）在本模块落
 *     字面锚：SEAM 完备性锁测试用产出方真常量（loop-engine / tool-loop-detect /
 *     full-compact）逐条校验不漂移，且新注入缝不挂名册即红；
 *   - 不 import loop-engine（T3 将由 loop-engine 消费本模块，防成环）、
 *     不 import TUI（harness 不反向依赖）。
 */
import type { AnthropicNativeMessage } from "./model-adapter/types.js";
import { isAgentStatusText } from "./agent-status.js";
import { isGraphModeText } from "./graph/notification.js";
import { isSubagentDrainText } from "./subagent/host-drain.js";
import { isVerifyInjectedText } from "./verify/inject.js";
import { isSkillIndexDeltaText } from "./skill/index-delta.js";
import { isSkillLoadText } from "./skill/body.js";
import { MEMORY_PREFETCH_END } from "./memory/prefetch.js";

/** instruction 回显上限（码点数，spec T2 提取规则）。 */
export const INSTRUCTION_MAX_CODEPOINTS = 100;

// 名册前缀锚（各自产出方见注释；漂移由 SEAM 锁测试拦截）。

/** = loop-engine `MCP_RECONNECT_NOTIFICATION_TEMPLATE` 的固定开头。 */
export const MCP_RECONNECT_INJECTION_PREFIX = "MCP server '";
/** = tool-loop-detect `LOOP_DETECTED_TEXT` 的固定开头。 */
export const LOOP_DETECTED_INJECTION_PREFIX = "LOOP_DETECTED:";
/** = compress/full-compact `buildCompactPrompt()` 的固定开头（NO_TOOLS_PREAMBLE）。 */
export const COMPACT_REQUEST_INJECTION_PREFIX =
  "CRITICAL: Respond with TEXT ONLY.";
/** = loop-engine 私有 `SUMMARY_PROMPT` 的固定开头（OQ1：即使未持久也先进名册，保守多滤）。 */
export const STOP_SUMMARY_INJECTION_PREFIX =
  "Briefly summarize in a few sentences";
/** = full-compact `SUMMARY_PREAMBLE`（compact 产物摘要，持久进 prior 的 user 消息）。 */
export const COMPACT_SUMMARY_INJECTION_PREFIX =
  "This session is being continued from a previous conversation";

const PREFIX_ANCHORS: ReadonlyArray<string> = [
  MCP_RECONNECT_INJECTION_PREFIX,
  LOOP_DETECTED_INJECTION_PREFIX,
  COMPACT_REQUEST_INJECTION_PREFIX,
  STOP_SUMMARY_INJECTION_PREFIX,
  COMPACT_SUMMARY_INJECTION_PREFIX,
];

/**
 * 甄别名册（现行全集，spec T2）：命中任一即宿主注入，不是操作员键入。
 * skill-load 信封**不在**名册内（计入真实用户消息，提取规则另行处理）。
 */
export function isHostInjectedUserText(text: string): boolean {
  if (
    isAgentStatusText(text) ||
    isGraphModeText(text) ||
    isSubagentDrainText(text) ||
    isVerifyInjectedText(text) ||
    isSkillIndexDeltaText(text)
  ) {
    return true;
  }
  const trimmed = text.trimStart();
  return PREFIX_ANCHORS.some((p) => trimmed.startsWith(p));
}

/**
 * 剥 memory prefetch overlay（invariant 2 + F6）：marker 在场取**最后一个**
 * marker 之后段为原文（用户可能把 marker 粘进原文，宁欠勿过）；无 marker →
 * 全文即原文。有意不复用 memory/prefetch.ts 的 `stripPrefetchOverlay`
 * （那个取第一个 marker 且带 legacy advisory 剥除，语义与本面 F6 不同）。
 */
export function stripMemoryPrefetchOverlay(text: string): string {
  const idx = text.lastIndexOf(MEMORY_PREFETCH_END);
  return idx >= 0 ? text.slice(idx + MEMORY_PREFETCH_END.length) : text;
}

/** user 消息 text 块拼接（同 TUI joinedUserText 形态，不 import TUI 侧件）。 */
function joinedUserText(message: AnthropicNativeMessage): string {
  return message.content
    .flatMap((b) => (b.type === "text" ? [b.text] : []))
    .join("\n");
}

/** 100 码点截断，不劈半字符、不加省略号（逐字纪律）。 */
function truncateCodePoints(line: string): string {
  const cps = Array.from(line);
  return cps.length <= INSTRUCTION_MAX_CODEPOINTS
    ? line
    : cps.slice(0, INSTRUCTION_MAX_CODEPOINTS).join("");
}

/**
 * skill-load 信封 → `\n\n` 后 remainder（spec T2 规则）；无 `\n\n` 或
 * remainder 纯空白 → null（该条视为无指令源，前扫）。
 */
function skillLoadRemainder(source: string): string | null {
  const idx = source.indexOf("\n\n");
  if (idx < 0) return null;
  const remainder = source.slice(idx + 2);
  return remainder.trim().length === 0 ? null : remainder;
}

/** 一条已剥 overlay、已过名册的原文 → 有效指令行（首行）或 null。 */
function instructionLine(source: string): string | null {
  const text = isSkillLoadText(source)
    ? skillLoadRemainder(source)
    : source;
  if (text === null) return null;
  const firstLine = text.split("\n", 1)[0]!.trimEnd();
  return firstLine.length === 0 ? null : truncateCodePoints(firstLine);
}

/** T2 提取结果：命中消息的对象引用（T3 reconcile 相关号）+ 逐字指令行。 */
export interface RealUserInstruction {
  readonly message: AnthropicNativeMessage;
  readonly instruction: string;
}

/**
 * SSOT 谓词：messages 尾向前扫第一条真实用户消息并提取 instruction。
 * 无真实用户消息 / 全部首行空（F1 / F2）→ null。纯函数，永不抛错。
 */
export function extractLatestRealUserInstruction(
  messages: ReadonlyArray<AnthropicNativeMessage>
): RealUserInstruction | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "user") continue;
    const joined = joinedUserText(m);
    if (joined.length === 0) continue; // 纯 tool_result 等无文本块
    const source = stripMemoryPrefetchOverlay(joined);
    if (isHostInjectedUserText(source)) continue;
    const line = instructionLine(source);
    if (line === null) continue;
    return Object.freeze({ message: m, instruction: line });
  }
  return null;
}
