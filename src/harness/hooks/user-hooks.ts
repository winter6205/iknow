/**
 * src/harness/hooks/user-hooks.ts
 *
 * Pre/Post multiplexer。用户 command 钩子编译在 plugin-hooks.ts
 * （createSettingsHookContribution）；本文件只组合各源。
 */
import type { PostToolUseHook, PreToolUseHook } from "../permission/types.js";

/**
 * 顺序执行各 Pre hook，第一个非 undefined 即短路（先拦先赢）。
 * undefined 槽跳过。返回 async hook。
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
 * 顺序 await 各 Post hook。全槽缺席 → undefined。
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
