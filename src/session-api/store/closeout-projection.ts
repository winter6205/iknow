/**
 * T4 (#621 / spec session-jsonl-resume D5–D6): process closeout 投影 ——
 * load 投影时为未配对 tool_use 补 synthetic tool_result,保证任何 consumer
 * (hub/chat/serve)拿到的 transcript 不含孤儿 tool_use(API 合法)。
 *
 * 纯投影,零额外 IO:盘上 JSONL 不变,每次 load 重新推导;下一次 save 会把
 * 补上的结果落成真实事件(self-healing)。
 *
 * 补洞走现有 `encodeToolResults`(adapter encoder SSOT,不新写编码器),
 * kind = execution_failed,reason 语义 = `process`(InterruptReason 预留值:
 * 进程死在 turn 中途)。spec D5 三分:本路径不得附带 `Interrupted by
 * user.` —— 那句 system 文案属于 harness 的 `cancelled` 路径。
 *
 * spec D6:mutating 工具(bash / edit_file / write_file,spec 点名集合)
 * 的 process 文案须指示模型「先检查副作用是否已生效,未生效再重跑」;
 * 只读工具(grep / read_file / glob / …)不含该句。
 *
 * 孤儿检测:assistant 事件的 tool_use 须由紧随其后、连续的纯 tool_result
 * user 消息覆盖(answer window);未覆盖者补在该 window 之后。append-only
 * 不变式下孤儿只可能出现在头链尾部(崩溃点在 assistant 已 append、
 * tool_result 未 append 之间),但投影对一般形状(多孤儿、mid-chain)同样
 * 成立。
 */
import { encodeToolResults } from "../../harness/model-adapter/anthropic-adapter.js";
import type {
  AnthropicContentBlock,
  AnthropicNativeMessage,
} from "../../harness/index.js";

type ToolUseBlock = Extract<AnthropicContentBlock, { type: "tool_use" }>;

/** spec D6 点名的 mutating 工具集合。 */
const MUTATING_TOOLS: ReadonlySet<string> = new Set([
  "bash",
  "edit_file",
  "write_file",
]);

/** process closeout 基底文案:reason 语义 = `process`;不得含
 *  `Interrupted by user.`(spec D5 negative 类)。 */
const PROCESS_CLOSEOUT_TEXT =
  "process exited before this tool's result was recorded; the tool's actual outcome is unknown (process closeout).";

/** mutating 工具追加句:先检查副作用是否已生效,未生效再重跑(spec D6)。 */
const MUTATING_SUFFIX =
  " This tool may have side effects: before re-running it, check whether the intended change already took effect, and re-run it only if it did not.";

/**
 * Backfill synthetic tool_result(s) for orphan tool_use(s). Pure.
 * Returns a new messages array; messages without orphans pass through
 * unchanged (element identity preserved).
 */
export function closeoutOrphanToolUses(
  messages: ReadonlyArray<AnthropicNativeMessage>
): AnthropicNativeMessage[] {
  const out: AnthropicNativeMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    out.push(msg);
    if (msg.role !== "assistant") continue;
    const toolUses = msg.content.filter(
      (b): b is ToolUseBlock => b.type === "tool_use"
    );
    if (toolUses.length === 0) continue;
    // Answer window: the immediately following consecutive tool_result-only
    // user messages (T3's per-tool commit shape produces one per result).
    const answered = new Set<string>();
    let j = i + 1;
    while (j < messages.length && isToolResultOnlyUserMessage(messages[j]!)) {
      for (const b of messages[j]!.content) {
        answered.add((b as { tool_use_id: string }).tool_use_id);
      }
      j++;
    }
    const orphans = toolUses.filter((tu) => !answered.has(tu.id));
    if (orphans.length === 0) continue;
    // Committed results stay put; the synthetic message goes right after the
    // answer window (== at the tail when the orphan is the last event).
    while (i + 1 < j) {
      out.push(messages[i + 1]!);
      i++;
    }
    out.push({
      role: "user",
      content: encodeToolResults(
        orphans.map((tu) => ({
          kind: "execution_failed" as const,
          toolUseId: tu.id,
          toolName: tu.name,
          message: MUTATING_TOOLS.has(tu.name)
            ? `${PROCESS_CLOSEOUT_TEXT}${MUTATING_SUFFIX}`
            : PROCESS_CLOSEOUT_TEXT,
        }))
      ),
    });
  }
  return out;
}

function isToolResultOnlyUserMessage(msg: AnthropicNativeMessage): boolean {
  return (
    msg.role === "user" &&
    msg.content.length > 0 &&
    msg.content.every((b) => b.type === "tool_result")
  );
}
