/**
 * Process-closeout projection: at load time, backfill synthetic
 * tool_results for unpaired tool_uses so every consumer (hub/chat/serve)
 * receives a transcript free of orphan tool_uses (API-valid).
 *
 * Pure projection, zero extra IO: the on-disk JSONL is unchanged and each
 * load re-derives the backfill; the next save persists the synthesized
 * results as real events (self-healing).
 *
 * Backfill goes through the existing `encodeToolResults` (adapter encoder
 * SSOT — no new encoder), kind = execution_failed, reason semantics =
 * `process` (a reserved InterruptReason value: the process died mid-turn).
 * This path must NOT carry the `Interrupted by user.` system text — that
 * belongs to the harness `cancelled` path.
 *
 * The closeout text for mutating tools (bash / edit_file / write_file)
 * instructs the model to check whether side effects already took effect
 * before re-running; read-only tools (grep / read_file / glob / …) omit it.
 *
 * Orphan detection: an assistant event's tool_use blocks must be covered by
 * the immediately following, consecutive tool_result-only user messages
 * (answer window); uncovered ones get a synthetic result appended right
 * after the window. Under the append-only invariant orphans can only appear
 * at the head-chain tail (crash between assistant append and tool_result
 * append), but the projection also handles general shapes (multiple
 * orphans, mid-chain).
 */
import { encodeToolResults } from "../../harness/model-adapter/anthropic-adapter.js";
import type {
  AnthropicContentBlock,
  AnthropicNativeMessage,
} from "../../harness/index.js";

type ToolUseBlock = Extract<AnthropicContentBlock, { type: "tool_use" }>;

/** Mutating tools whose closeout text carries the side-effect check. */
const MUTATING_TOOLS: ReadonlySet<string> = new Set([
  "bash",
  "edit_file",
  "write_file",
]);

/** Process-closeout base text: reason semantics = `process`; must never
 *  contain `Interrupted by user.` (that belongs to the cancelled path). */
const PROCESS_CLOSEOUT_TEXT =
  "process exited before this tool's result was recorded; the tool's actual outcome is unknown (process closeout).";

/** Mutating-tool suffix: check whether side effects already took effect
 *  before re-running. */
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
    // user messages (the per-tool commit shape produces one per result).
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
