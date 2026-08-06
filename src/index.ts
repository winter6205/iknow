/**
 * iknow — standalone agent harness toolkit (loop engine + Anthropic adapter + ACI tool set).
 * Runtime has zero dependency on any upstream host package or local reference clone.
 */

export { loadIknowEnv, getApiKey } from "./config/env.js";
export type { IknowEnv, LlmEnv } from "./config/env.js";

export type * from "./shared/schema.js";
export {
  IknowError,
  ValidationError,
  NotFoundError,
  isIknowError,
} from "./shared/errors.js";
export type { IknowErrorCode } from "./shared/errors.js";
