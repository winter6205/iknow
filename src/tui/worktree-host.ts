/**
 * src/tui/worktree-host.ts
 *
 * TUI 入口的 worktree isolation host 缝装配（ADR-0037）。透传本体收敛
 * 到共享 SSOT `harness/isolation/worktree-host.ts`（run.tsx 内联手工
 * 解构丢 `name` 的 2026-09-05 trace 实测 bug 修复）；本文件保留 TUI 侧
 * 依赖形状（延迟绑定的 hub bridgeRef）与既有导出。hub 缺席的 fail-closed
 * 属于 run.tsx 的桥接逻辑（bridgeRef 只有它知道），不进本壳。
 */
import type { WorktreeProvisionFn } from "../harness/isolation/worktree-gate.js";
import { createWorktreeHostProvision } from "../harness/isolation/worktree-host.js";

/** TUI host 缝装配依赖：hub 侧实现由调用方（run.tsx）注入。 */
export interface TuiWorktreeHostFactoryOpts {
  /** Hub 侧 provision 缝；工厂只在调用时机取值（bridgeRef 延迟绑定）。 */
  readonly provisionWorktree: WorktreeProvisionFn;
}

/** 装配 TUI 入口的 worktree isolation host opts（provision 纯透传）。 */
export function createTuiWorktreeIsolationHost(
  opts: TuiWorktreeHostFactoryOpts
): {
  provision: WorktreeProvisionFn;
} {
  // 纯透传走共享 SSOT（2026-09-05 run.tsx 手工解构丢 name 的修复点）。
  return createWorktreeHostProvision({
    provisionWorktree: opts.provisionWorktree,
  });
}
