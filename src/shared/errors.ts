/** Typed errors for iknow (S3). */

export type IknowErrorCode = "VALIDATION" | "NOT_FOUND";

export class IknowError extends Error {
  readonly code: IknowErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(
    code: IknowErrorCode,
    message: string,
    details?: Record<string, unknown>
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

export function isIknowError(err: unknown): err is IknowError {
  return err instanceof IknowError;
}
