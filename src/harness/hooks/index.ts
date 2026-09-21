/**
 * src/harness/hooks/ barrel export.
 *
 * User command hooks + plugin command hooks + Pre/Post multiplexer.
 * settings.hooks and plugin hooks.json share one compiler; mounted onto the
 * 5-step permission chain.
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
 * HookContribution — the minimal contribution shape for future file sources
 * (`~/.iknow/hooks/` / project `.iknow/hooks/`) to register hooks. Today only
 * the settings source (user hooks) produces Pre/Post via
 * createSettingsHookContribution; this type is the shape shared by file and
 * settings sources.
 */
export interface HookContribution {
  readonly pre?: PreToolUseHook;
  readonly post?: PostToolUseHook;
}
