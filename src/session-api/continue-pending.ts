/**
 * continue_pending: transcript predicate + CLI/TUI whole-line NL.
 *
 * Host (hub / CLI / TUI) evaluates load+closeout messages + goal. Classification
 * may ignore a trailing interrupt system message; callers must not mutate disk
 * or the priorMessages passed to run (EXIT cancelled_keep_interrupt).
 */
import type { AnthropicNativeMessage } from "../harness/index.js";
import {
  LOOP_DETECTED_TEXT,
  VALIDATION_LOOP_DETECTED_TEXT,
} from "../harness/tool-loop-detect.js";
import {
  SkipAppendEmptyPriorError,
  SkipAppendWithTextError,
} from "../harness/errors.js";
import { ValidationError } from "../shared/errors.js";
import type { GoalState } from "./store/schema.js";

/** Trailing interrupt system text; same literal as loop-engine SYSTEM_INTERRUPT_TEXT. */
const SYSTEM_INTERRUPT_TEXT = "Interrupted by user.";

export type ContinuePendingExit =
  "nothing_pending" | "goal_active" | "fused_clean_stop";

export type ContinuePendingVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly exit: ContinuePendingExit };

/** Exact whole-line hits after trim; English compared case-insensitively. */
const CONTINUE_PENDING_NL_LINES: ReadonlySet<string> = new Set([
  "please continue",
  "continue please",
  "keep going",
  "go on",
  "请继续",
  "接着做",
  "接着跑",
  "继续跑",
]);

export function continuePredicateError(
  exit: ContinuePendingExit
): ValidationError {
  return new ValidationError(`${exit}: cannot continue this session`, {
    field: "continue",
  });
}

export function mapSkipAppendToContinueError(
  err: unknown
): ValidationError | null {
  if (
    err instanceof SkipAppendWithTextError ||
    err instanceof SkipAppendEmptyPriorError
  ) {
    return new ValidationError(err.message, { field: "continue" });
  }
  return null;
}

export function matchesContinuePendingNlLine(raw: string): boolean {
  return CONTINUE_PENDING_NL_LINES.has(raw.trim().toLowerCase());
}

export function shouldTriggerContinueFromNl(opts: {
  readonly line: string;
  readonly pending: boolean;
}): boolean {
  if (!opts.pending) return false;
  return matchesContinuePendingNlLine(opts.line);
}

export function evaluateContinuePending(opts: {
  readonly messages: ReadonlyArray<AnthropicNativeMessage>;
  readonly goal?: GoalState;
}): ContinuePendingVerdict {
  const { messages, goal } = opts;
  if (messages.length === 0) {
    return { ok: false, exit: "nothing_pending" };
  }
  if (isPinnedUserGoal(goal)) {
    return { ok: false, exit: "goal_active" };
  }
  const classified = stripTrailingInterrupt(messages);
  if (classified.length === 0) {
    return { ok: false, exit: "nothing_pending" };
  }
  // stripTrailingInterrupt only slices when the tail really is an interrupt
  // system message, so the length difference is exactly "did this
  // classification strip a trailing interrupt".
  const strippedTrailingInterrupt = classified.length !== messages.length;
  return classifyLastMessage(
    classified[classified.length - 1]!,
    strippedTrailingInterrupt
  );
}

function isPinnedUserGoal(goal: GoalState | undefined): boolean {
  return (
    goal !== undefined && goal.source === "user_pin" && goal.text.length > 0
  );
}

/**
 * View-only slice that drops a trailing `Interrupted by user.` system message.
 * Disk and the caller's `priorMessages` array stay untouched; callers in the
 * `/continue` path (hub.runContinuePending) pass the result to `run()` so the
 * model prior omits the interrupt, while the store keeps it for rewind / display.
 */
export function stripTrailingInterrupt(
  messages: ReadonlyArray<AnthropicNativeMessage>
): ReadonlyArray<AnthropicNativeMessage> {
  const last = messages[messages.length - 1];
  if (last !== undefined && isInterruptSystem(last)) {
    return messages.slice(0, -1);
  }
  return messages;
}

function isInterruptSystem(msg: AnthropicNativeMessage): boolean {
  if (msg.role !== "system" || msg.content.length !== 1) return false;
  const block = msg.content[0];
  return block?.type === "text" && block.text === SYSTEM_INTERRUPT_TEXT;
}

function classifyLastMessage(
  last: AnthropicNativeMessage,
  strippedTrailingInterrupt: boolean
): ContinuePendingVerdict {
  if (last.role === "user") {
    if (isToolResultOnlyUser(last)) return { ok: true };
    if (
      userTextOf(last) === LOOP_DETECTED_TEXT ||
      userTextOf(last) === VALIDATION_LOOP_DETECTED_TEXT
    ) {
      return { ok: false, exit: "fused_clean_stop" };
    }
    return { ok: true };
  }
  if (last.role === "assistant") {
    if (hasToolUse(last)) return { ok: true };
    if (hasNonEmptyText(last)) {
      // ADR-0108: a text assistant immediately followed by an interrupt means
      // the model was cut off mid-flight and the frozen prefix stays on disk —
      // a complete final answer is never followed by an interrupt, so this
      // turn is still pending and /continue can resume from the prefix.
      // A text final answer with no interrupt stays nothing_pending.
      return strippedTrailingInterrupt
        ? { ok: true }
        : { ok: false, exit: "nothing_pending" };
    }
    return { ok: true };
  }
  return { ok: false, exit: "nothing_pending" };
}

function isToolResultOnlyUser(msg: AnthropicNativeMessage): boolean {
  return (
    msg.role === "user" &&
    msg.content.length > 0 &&
    msg.content.every((b) => b.type === "tool_result")
  );
}

function userTextOf(msg: AnthropicNativeMessage): string {
  return msg.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");
}

function hasToolUse(msg: AnthropicNativeMessage): boolean {
  return msg.content.some((b) => b.type === "tool_use");
}

function hasNonEmptyText(msg: AnthropicNativeMessage): boolean {
  return msg.content.some((b) => b.type === "text" && b.text.trim().length > 0);
}
