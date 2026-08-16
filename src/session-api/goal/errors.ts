/**
 * #458 T3: typed errors for goal status transitions.
 *
 * Shape mirrors the existing `{ kind: "schema_invalid", field }` contract
 * (schema.ts) so hub-side catch sites can log the kind without parsing
 * free text. Every goal-mutation function returns `Result<T, GoalError>`
 * (a union type, no third-party lib) so the fail-closed paths are
 * explicit, never silent.
 *
 * ACR #1 (PLAN 建议)裁剪：本模块只服务于 assertValidTransition（status
 * 转移守卫）和共享给 validateGoalText / hub 的 `empty_text` 语义。T6-only
 * 错误 kinds（#432 旧 confirm 通道的 auto-rejected / timeout / mismatch
 * 区分态）按 #461 决议整体不落地。`GoalSource` 收缩后的 goal lifecycle
 * 也不再需要 confirm 通道的区分态。
 */
export type GoalErrorKind =
  /** assertValidTransition 拒绝的非法状态转移（如 achieved→active）。 */
  | "invalid_transition"
  /** 空 text 不写 goal（与 #458 T2 的 validateGoalText 复用同一 kind）。 */
  | "empty_text";

export interface GoalError {
  readonly kind: GoalErrorKind;
  readonly reason: string;
  readonly context?: Readonly<Record<string, unknown>>;
}

/** 一元结果类型：成功为 value，失败为 GoalError。 */
export type Result<T, E extends GoalError = GoalError> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const err = <T>(error: GoalError): Result<T> => ({ ok: false, error });

export const goalError = (
  kind: GoalErrorKind,
  reason: string,
  context?: Readonly<Record<string, unknown>>
): GoalError => ({ kind, reason, context });
