/**
 * TUI /continue EXIT copy + client busy-guard.
 *
 * Busy is client-only (EXIT busy_stop_first). Predicate SSOT is load+messages+goal
 * via pendingFromLoadedSession — never TuiSessionState.lastStopReason.
 */
import type { AnthropicNativeMessage } from "../harness/model-adapter/types.js";
import { ValidationError } from "../shared/errors.js";
import {
  evaluateContinuePending,
  type ContinuePendingExit,
} from "../session-api/continue-pending.js";
import type { GoalState } from "../session-api/store/schema.js";
import type { SessionRunState } from "./session-state.js";

export type TuiContinueExit = "busy_stop_first" | "usage" | ContinuePendingExit;

export function tuiContinueBusy(opts: {
  readonly runState: SessionRunState;
  readonly compacting: boolean;
}): boolean {
  return opts.runState !== "idle" || opts.compacting;
}

export function continueNoticeFor(exit: TuiContinueExit): readonly string[] {
  switch (exit) {
    case "busy_stop_first":
      return ["当前会话正在运行；续跑等本轮结束后再执行。"];
    case "usage":
      return ["用法：/continue（不接受参数）"];
    case "nothing_pending":
      return ["当前没有未完成的工具环可续跑。"];
    case "goal_active":
      return ["当前有钉着的 goal；先 /goal clear 再续跑。"];
    case "fused_clean_stop":
      return ["已因循环检测干净停止，不能续跑。"];
    default: {
      const _exhaustive: never = exit;
      throw new Error(`unknown continue exit: ${String(_exhaustive)}`);
    }
  }
}

export function continueExitFromError(
  err: unknown
): ContinuePendingExit | undefined {
  if (!(err instanceof ValidationError)) return undefined;
  if (err.details?.field !== "continue") return undefined;
  const head = err.message.split(":", 1)[0];
  if (
    head === "nothing_pending" ||
    head === "goal_active" ||
    head === "fused_clean_stop"
  ) {
    return head;
  }
  return undefined;
}

export function isContinueValidationError(
  err: unknown
): err is ValidationError {
  return err instanceof ValidationError && err.details?.field === "continue";
}

/** lastStopReason on the input object is ignored (reload_before_continue SSOT). */
export function pendingFromLoadedSession(file: {
  readonly messages: ReadonlyArray<AnthropicNativeMessage>;
  readonly goal?: GoalState;
  readonly lastStopReason?: unknown;
}): boolean {
  return evaluateContinuePending({
    messages: file.messages,
    ...(file.goal !== undefined ? { goal: file.goal } : {}),
  }).ok;
}
