/**
 * src/harness/hooks/ barrel export.
 *
 * 用户 command 钩子 + 插件 command 钩子 + Pre/Post multiplexer。
 * settings.hooks 与插件 hooks.json 共用编译器；挂 permission 5 步链。
 */

export { composePostHooks, composePreHooks } from "./user-hooks.js";

export {
  createPluginHookContribution,
  createPluginHooksFromCatalog,
  createSettingsHookContribution,
  evaluatePluginHookMatcher,
  pluginHookTimeoutMs,
  pluginHookToolNames,
} from "./plugin-hooks.js";
export type {
  CreatePluginHookContributionOpts,
  PluginHookFile,
  PluginInstallationRef,
} from "./plugin-hooks.js";

import type { PreToolUseHook, PostToolUseHook } from "../permission/types.js";

/**
 * HookContribution（specs/user-hook-router.md Does：「留下 HookContribution
 * 形状，供后续文件源接入」）—— 将来 `~/.iknow/hooks/` / 项目 `.iknow/hooks/`
 * 文件源（H1 第二刀）注册 hook 的最小贡献形状。V1 仅 settings 源（用户钩子（user hooks））
 * 经 createSettingsHookContribution 产出 Pre/Post；本类型是文件源与
 * settings 源共用的贡献形状。
 */
export interface HookContribution {
  readonly pre?: PreToolUseHook;
  readonly post?: PostToolUseHook;
}
