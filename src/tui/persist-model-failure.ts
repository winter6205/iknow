/**
 * /model persist failure: route vs write vs reload are different stages.
 * A route failure (the route did not resolve) changed nothing at all: the
 * conversation kept its old route AND the default was not written. A reload
 * error (e.g. provider_api_key_missing) must not be labeled as a
 * settings.json write failure.
 */
import {
  formatLlmProviderConfigError,
  isLlmProviderConfigError,
} from "../config/env.js";

export type PersistModelFailureStage = "route" | "write" | "reload";

/** Any /model persist failure, with the stage it failed at. */
export type PersistModelFailure = {
  readonly ok: false;
  readonly stage: PersistModelFailureStage;
  readonly reason: string;
};

/** The DEFAULT write's own failure: the settings write ("write") or the
 *  runtime reload after it ("reload"). A route failure cannot come from
 *  here — the route is resolved before the default is written. */
export type PersistModelDefaultFailure = {
  readonly ok: false;
  readonly stage: "write" | "reload";
  readonly reason: string;
};

/** The reason text of a failure: typed provider errors render their own
 *  message (they are plain objects, not Errors); anything else falls back to
 *  the Error message / String(). */
function reasonOf(err: unknown): string {
  return isLlmProviderConfigError(err)
    ? formatLlmProviderConfigError(err)
    : err instanceof Error
      ? err.message
      : String(err);
}

export function persistModelFailure(
  wrote: boolean,
  err: unknown
): PersistModelDefaultFailure {
  return {
    ok: false,
    stage: wrote ? "reload" : "write",
    reason: reasonOf(err),
  };
}

/** ADR-0145: the route did not resolve — the conversation kept its old route
 *  and the default was not written either. */
export function persistModelRouteFailure(err: unknown): PersistModelFailure {
  return {
    ok: false,
    stage: "route",
    reason: reasonOf(err),
  };
}

export function persistModelFailNotice(
  stage: PersistModelFailureStage | undefined,
  reason: string
): string {
  if (stage === "route") {
    // Nothing was switched: claiming a switch would be false.
    return `Model not switched: ${reason}`;
  }
  const verb =
    stage === "reload"
      ? "failed to reload runtime"
      : "failed to write settings.json";
  return `Model switched (this session), but ${verb}: ${reason}`;
}
