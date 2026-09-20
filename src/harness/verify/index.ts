/**
 * verify bounded context — public exit.
 *
 * Minimal surface: re-exports only what assembly layers (cli / session-api)
 * need —
 *   - VerifyConfig: settings.verify section → loop config construction;
 *   - runVerifyLoop / VerifyLoopOptions / VerifyLoopResult / VerifyLoopOutcome:
 *     the run() wrapper points for chat / serve;
 *   - the pure layers (verdict / inject) are verify-loop internals, not
 *     consumed by assembly, so they stay unexported here (avoids surface
 *     bloat and context leakage).
 */
export type { VerifyConfig } from "./types.js";
export type { VerificationRecord } from "./types.js";

export {
  runVerifyLoop,
  DEFAULT_TIMEOUT_SEC,
  DEFAULT_MAX_ROUNDS,
} from "./verify-loop.js";
export type {
  RunOutcome,
  RunVerifyFn,
  VerifyLoopOptions,
  VerifyLoopResult,
  VerifyLoopOutcome,
} from "./verify-loop.js";
