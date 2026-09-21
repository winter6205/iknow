/**
 * src/harness/hooks/user-hooks.ts
 *
 * Pre/Post multiplexer. User command hooks are compiled in plugin-hooks.ts
 * (createSettingsHookContribution); this file only composes sources.
 */
import type { PostToolUseHook, PreToolUseHook } from "../permission/types.js";

/**
 * Run Pre hooks in order; the first non-undefined result short-circuits
 * (first block wins). Undefined slots are skipped. Returns an async hook.
 */
export function composePreHooks(
  hooks: ReadonlyArray<PreToolUseHook | undefined>
): PreToolUseHook {
  return Object.freeze(async ({ tool, input }) => {
    for (const hook of hooks) {
      if (hook === undefined) continue;
      const blocked = await hook({ tool, input });
      if (blocked !== undefined) return blocked;
    }
    return undefined;
  });
}

/**
 * Await Post hooks in order. All slots absent -> undefined.
 */
export function composePostHooks(
  hooks: ReadonlyArray<PostToolUseHook | undefined>
): PostToolUseHook | undefined {
  const present = hooks.filter(
    (hook): hook is PostToolUseHook => hook !== undefined
  );
  if (present.length === 0) return undefined;
  return Object.freeze(async (result: Parameters<PostToolUseHook>[0]) => {
    for (const hook of present) {
      await hook(result);
    }
  });
}
