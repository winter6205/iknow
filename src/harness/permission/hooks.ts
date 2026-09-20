/**
 * src/harness/permission/hooks.ts
 *
 * Pre/PostToolUse hook pair (plan T2). v0 is no-op; production callers can
 * replace either side by passing a custom pair via `createHooksPair(custom)`.
 *
 * Hooks are no-ops by default, but the call sites exist and are replaceable.
 */

import type { PreToolUseHook, PostToolUseHook } from "./types.js";

export interface HooksPair {
  readonly preToolUse: PreToolUseHook;
  readonly postToolUse: PostToolUseHook;
}

/**
 * Default factory: returns an Object.frozen pair of no-op hooks.
 * Documented that v0 is no-op; production wiring replaces this via createHooksPair(custom).
 */
export function createNoOpHooks(): HooksPair {
  return Object.freeze({
    preToolUse: Object.freeze(() => undefined),
    postToolUse: Object.freeze(() => undefined),
  });
}

export interface HooksCustom {
  readonly preToolUse?: PreToolUseHook;
  readonly postToolUse?: PostToolUseHook;
}

/**
 * Compose hook pair: caller-supplied overrides fall back to no-op. Production
 * implementations pass a custom preToolUse (deny-only, #126) and/or
 * postToolUse (projection / observability handlers).
 */
export function createHooksPair(custom?: HooksCustom): HooksPair {
  const defaults = createNoOpHooks();
  if (!custom) return defaults;
  return Object.freeze({
    preToolUse: Object.freeze(custom.preToolUse ?? defaults.preToolUse),
    postToolUse: Object.freeze(custom.postToolUse ?? defaults.postToolUse),
  });
}
