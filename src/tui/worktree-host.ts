/**
 * src/tui/worktree-host.ts
 *
 * TUI 入口的 worktree isolation host 缝装配（ADR-0037）。与
 * src/cli/worktree-host.ts 同构：抽成独立工厂是为了让装配点可单测——
 * PR #869 的 `name` 透传在 CLI 缝静默漏改后，TUI 缝（run.tsx 内联
 * 手工解构）在 2026-09-05 trace 实测中复现了同一退化：模型传入合法
 * label，建出的却是 UUID-only 叶子。
 *
 * 纯透传契约：host 缝收到什么 ctx 就把什么交给 hub，不逐字段
 * 手工解构。未来 WorktreeProvisionContext 新增字段时这里零改动。
 */
import type { WorktreeProvisionContext } from "../harness/isolation/worktree-gate.js";

/** TUI host 缝装配依赖：hub 由调用方（run.tsx）注入。 */
export interface TuiWorktreeHostFactoryOpts {
  /** Hub 侧 provision 缝；工厂只在调用时机取值（bridgeRef 延迟绑定）。 */
  readonly provisionWorktree: (
    ctx: WorktreeProvisionContext
  ) => Promise<string>;
  /** hub 缺席时的 fail-closed 错误（run.tsx 桥未建好）。 */
  readonly notReadyError?: () => Error;
}

/** 装配 TUI 入口的 worktree isolation host opts（provision 纯透传）。 */
export function createTuiWorktreeIsolationHost(
  opts: TuiWorktreeHostFactoryOpts
): { provision: (ctx: WorktreeProvisionContext) => Promise<string> } {
  const { provisionWorktree } = opts;
  return {
    provision: (ctx) =>
      opts.notReadyError === undefined
        ? provisionWorktree(ctx)
        : Promise.reject(opts.notReadyError()),
  };
}
