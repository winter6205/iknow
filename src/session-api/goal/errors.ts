/**
 * Typed errors for goal status transitions.
 *
 * Shape mirrors the existing `{ kind: "schema_invalid", field }` contract
 * (schema.ts) so hub-side catch sites can log the kind without parsing
 * free text. Every goal-mutation function returns `Result<T, GoalError>`
 * (a union type, no third-party lib) so the fail-closed paths are
 * explicit, never silent.
 *
 * Scope: this module only backs assertValidTransition (the status
 * transition guard) and the `empty_text` semantics shared with
 * validateGoalText / hub. Former confirm-channel error kinds
 * (auto-rejected / timeout / mismatch) were dropped outright — the
 * narrowed GoalSource lifecycle no longer needs them.
 */
export type GoalErrorKind =
  /** Illegal status transition rejected by assertValidTransition (e.g. achieved→active). */
  | "invalid_transition"
  /** Empty text never writes a goal (same kind as validateGoalText). */
  | "empty_text";

export interface GoalError {
  readonly kind: GoalErrorKind;
  readonly reason: string;
  readonly context?: Readonly<Record<string, unknown>>;
}

/** Result type: success carries value, failure carries GoalError. */
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
