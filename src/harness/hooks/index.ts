/**
 * src/harness/hooks/ barrel export.
 *
 * user-hook-router 能力模块（specs/user-hook-router.md / ADR-0055）：
 * user lane 的声明式 deny-only hook router 工厂 + Pre hook multiplexer
 * 组合器。挂载到 permission 5 步链 Step 1 由 build-engine（T5）完成。
 */

export {
  composePreHooks,
  createUserHookRouter,
  isGitCommitCall,
} from "./user-lane.js";
export type { CreateUserHookRouterOpts } from "./user-lane.js";

import type { PreToolUseHook, PostToolUseHook } from "../permission/types.js";

/**
 * HookContribution（specs/user-hook-router.md Does：「留下 HookContribution
 * 形状，供后续文件源接入」）—— 将来 `~/.iknow/hooks/` / 项目 `.iknow/hooks/`
 * 文件源（H1 第二刀）注册 hook 的最小贡献形状。V1 仅 settings 源（user lane）
 * 经 createUserHookRouter 间接产出 Pre；本类型不参与运行时，只是第二刀的
 * 接缝合同，避免届时改 5 步链挂载面。
 */
export interface HookContribution {
  readonly pre?: PreToolUseHook;
  readonly post?: PostToolUseHook;
}
