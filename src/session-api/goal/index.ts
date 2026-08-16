/**
 * #458 T3: goal status transition pure functions.
 *
 * 设计原则：
 * - 纯函数 + IO 不外泄（hub 是唯一 IO 写者；本模块构造值，落盘由 hub 调 store.save）
 * - 全部 Result 化，fail-closed 显式
 * - 不读 messages 反推（G1 决议：防注入污染）
 * - 不扩 GoalStatus union（T1 OQ3：不 bump schema v5→v6）
 *
 * 两个核心函数：
 * - assertValidTransition: 状态转移合法性断言（active→achieved 等合法边，
 *   achieved→active / 自转移等非法边 reject）
 * - applyTransition: 把 goal.status 改成新值（已经通过 assertValidTransition
 *   校验）。纯函数，不做 IO。updatedAt 由调用方传入。
 *
 * 与 T6 model-propose / confirm 通道无关（按 #461 决议整体不落地）—— hub
 * 也不再走 propose / confirm 二段通道，goal 是纯用户固定锚（#459 term A）。
 */
import type { GoalState, GoalStatus } from "../store/schema.js";
import { err, goalError, ok, type GoalError, type Result } from "./errors.js";
import { VALID_GOAL_TRANSITIONS, type TransitionInput } from "./types.js";

export { err, goalError, ok };
export type { GoalError, Result };
export type { TransitionInput } from "./types.js";
export { VALID_GOAL_TRANSITIONS };

/**
 * 状态转移合法性断言。
 *
 * 合法转移表 VALID_GOAL_TRANSITIONS 限定为 GoalStatus union 现有 4 值
 * 之间的边（T1 OQ3 已定案：不扩 union，不 bump schema）。相同 status 的
 * 「空转移」视为非法（要求显式转移意图；T5 verify-writeback 路径的
 * failed/unstable outcome 即走 recordGoal 而非 applyTransition，因
 * active→active 不在白名单）。
 */
export function assertValidTransition(
  input: TransitionInput
): Result<true, GoalError> {
  if (input.from === input.to) {
    return err(
      goalError(
        "invalid_transition",
        "self-transition not allowed; pick a different target status",
        { from: input.from, to: input.to }
      )
    );
  }
  const isValid = VALID_GOAL_TRANSITIONS.some(
    ([from, to]) => from === input.from && to === input.to
  );
  if (!isValid) {
    return err(
      goalError(
        "invalid_transition",
        "transition rejected by VALID_GOAL_TRANSITIONS table",
        { from: input.from, to: input.to }
      )
    );
  }
  return ok(true);
}

/**
 * 把 goal.status 改成新值（已经通过 assertValidTransition 校验）。
 * 纯函数，不做 IO。updatedAt 由调用方传入。其他字段（text/source/
 * createdAt/history）保持不变。
 */
export function applyTransition(
  goal: GoalState,
  nextStatus: GoalStatus,
  now: string
): GoalState {
  return {
    ...goal,
    status: nextStatus,
    updatedAt: now,
  };
}
