/** Typed errors for iknow (S3). */

export type IknowErrorCode =
  | "VALIDATION"
  | "NOT_FOUND"
  | "PERMISSION_DENIED"
  | "VERSION_STALE"
  | "GOVERNANCE_TIMEOUT"
  | "COMPILE_FAILED"
  | "G2_REQUIRED"
  | "MAX_HOPS";

export class IknowError extends Error {
  readonly code: IknowErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(
    code: IknowErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "IknowError";
    this.code = code;
    this.details = details;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class ValidationError extends IknowError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("VALIDATION", message, details);
    this.name = "ValidationError";
  }
}

export class NotFoundError extends IknowError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("NOT_FOUND", message, details);
    this.name = "NotFoundError";
  }
}

export class PermissionDeniedError extends IknowError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("PERMISSION_DENIED", message, details);
    this.name = "PermissionDeniedError";
  }
}

export class VersionStaleError extends IknowError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("VERSION_STALE", message, details);
    this.name = "VersionStaleError";
  }
}

export class GovernanceTimeoutError extends IknowError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("GOVERNANCE_TIMEOUT", message, details);
    this.name = "GovernanceTimeoutError";
  }
}

export class CompileFailedError extends IknowError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("COMPILE_FAILED", message, details);
    this.name = "CompileFailedError";
  }
}

/** Thrown when agent hop budget is exhausted. */
export class MaxHopsError extends IknowError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("MAX_HOPS", message, details);
    this.name = "MaxHopsError";
  }
}

/** Thrown when a final answer omits required G2 snapshot_id. */
export class G2RequiredError extends IknowError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("G2_REQUIRED", message, details);
    this.name = "G2RequiredError";
  }
}

export function isIknowError(err: unknown): err is IknowError {
  return err instanceof IknowError;
}
