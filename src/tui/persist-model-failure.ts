/**
 * /model persist failure: write vs reload are different stages.
 * Reload errors (e.g. provider_api_key_missing) must not be labeled as a
 * settings.json write failure.
 */
import {
  formatLlmProviderConfigError,
  isLlmProviderConfigError,
} from "../config/env.js";

export type PersistModelFailureStage = "write" | "reload";

export type PersistModelFailure = {
  readonly ok: false;
  readonly stage: PersistModelFailureStage;
  readonly reason: string;
};

export function persistModelFailure(
  wrote: boolean,
  err: unknown
): PersistModelFailure {
  return {
    ok: false,
    stage: wrote ? "reload" : "write",
    reason: isLlmProviderConfigError(err)
      ? formatLlmProviderConfigError(err)
      : err instanceof Error
        ? err.message
        : String(err),
  };
}

export function persistModelFailNotice(
  stage: PersistModelFailureStage | undefined,
  reason: string
): string {
  const verb =
    stage === "reload"
      ? "failed to reload runtime"
      : "failed to write settings.json";
  return `Model switched (this session), but ${verb}: ${reason}`;
}
