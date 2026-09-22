/**
 * settings.verify section → VerifyConfig assembly (dedup of the failure-fix loop).
 *
 * Single assembly point: cli / serve / tui share it, eliminating the duplicate
 * resolveVerifyConfig copies (code-review SSOT finding). A CLI-layer shared
 * module that never imports harness — settings.verify default fallbacks live
 * at the consumption point (verify-loop's DEFAULT_* constants).
 *
 * Assembly-layer fixes for the verify-classifier loop:
 *  - missing `verify` section (zero user config) → still produce
 *    `{ command: "" }` (not undefined). The spec is explicit: with no
 *    verify.command the loop is **no longer** transparently off; instead a
 *    subagent judge (classifier) makes an evidence-backed completeness call.
 *    Empty command → verify-loop takes the classifier branch when a
 *    runClassifier seam is assembled (subagentManager present in chat/serve/tui).
 *  - `verify` present but command missing → same `{ command: "" }` (same semantics).
 *  - `command` configured → forwarded verbatim, zero behavior regression
 *    (illegal field values are still dropped, matching settings.ts
 *    drop-not-throw discipline).
 *
 * Cost and boundaries (honest comments):
 *  - Zero-config sessions (chat/tui/serve) spawn the judge subagent at every
 *    completed turn — intended behavior (the classifier takes over when
 *    command is unset), with LLM cost + latency.
 *  - Entrypoints without subagentManager (ask oneshot shape) → the assembly
 *    layer doesn't pass runClassifier, so verify-loop still goes
 *    transparently off at command="" (backward compatible); ask behavior is unchanged.
 */
import type { IknowSettingsVerify } from "./settings.js";
import type { VerifyConfig } from "../harness/verify/index.js";

/**
 * Parse the settings.verify section into a VerifyConfig.
 * command absent (including the whole verify section missing) → `{ command: "" }`
 * (classifier takes over instead of transparently off; effective only when a
 * runClassifier is assembled, otherwise still transparently off for backward
 * compatibility). Other fields are forwarded as-is (defaults fall back at the
 * verify-loop consumption point).
 */
export function resolveVerifyConfig(
  verify: IknowSettingsVerify | undefined
): VerifyConfig {
  const config: VerifyConfig = {
    command: verify?.command ?? "",
    ...(verify?.rerunTemplate !== undefined
      ? { rerunTemplate: verify.rerunTemplate }
      : {}),
    ...(verify?.countRegex !== undefined
      ? { countRegex: verify.countRegex }
      : {}),
    ...(verify?.timeoutSec !== undefined
      ? { timeoutSec: verify.timeoutSec }
      : {}),
    ...(verify?.onExhausted !== undefined
      ? { onExhausted: verify.onExhausted }
      : {}),
    ...(verify?.maxRounds !== undefined ? { maxRounds: verify.maxRounds } : {}),
  };
  return config;
}
