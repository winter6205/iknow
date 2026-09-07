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
