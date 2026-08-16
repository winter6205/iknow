/**
 * #458 T3: status-machine edge types for the session-goal lifecycle.
 *
 * 仅承载 `VALID_GOAL_TRANSITIONS` 与 `TransitionInput`（裁剪自
 * worktree-408-not-yet-specified-impl 的 types.ts）。T6 model-propose /
 * confirm 通道的类型（#432 旧 T6-only 提议/确认形态）按 #461 决议整体
 * 不落地，整支不 merge。
 */
import type { GoalStatus } from "../store/schema.js";

/** 状态转移输入：current → next。供 assertValidTransition 守卫。 */
export interface TransitionInput {
  readonly from: GoalStatus;
  readonly to: GoalStatus;
}

/** 状态机的合法转移表（与 assertValidTransition 同源）。
 *  GoalStatus union 维持 active | achieved | aborted | superseded 四值
 *  （T1 OQ3：不扩 union，不 bump schema v5）。相同 status 的「空转移」
 *  视为非法（自转移由 assertValidTransition 显式拒绝）。 */
export const VALID_GOAL_TRANSITIONS: ReadonlyArray<
  readonly [GoalStatus, GoalStatus]
> = [
  ["active", "achieved"],
  ["active", "aborted"],
  ["active", "superseded"],
  ["achieved", "superseded"],
  ["aborted", "superseded"],
] as const;
