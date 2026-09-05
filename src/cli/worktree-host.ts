/**
 * src/cli/worktree-host.ts
 *
 * CLI 入口的 worktree isolation host 缝装配（ADR-0037 review High-1）。
 * 透传本体收敛到共享 SSOT `harness/isolation/worktree-host.ts`（两次
 * 入口级手工解构丢 `name` 的真 bug——PR #881 与 2026-09-05 TUI 缝——
 * 之后的一致性收敛）；本文件保留 CLI 侧依赖形状（provisioner 注入）
 * 与既有导出，cli.ts main() 仍从这里装配。
 */
import type { WorktreeIsolationHostOpts } from "../harness/isolation/worktree-gate.js";
import type { TaskWorktreeProvisioner } from "../session-api/worktree-rebind.js";
import { createWorktreeHostProvision } from "../harness/isolation/worktree-host.js";

/** CLI host 缝装配依赖：provisioner 由调用方（cli.ts main）构造注入。 */
export interface WorktreeHostFactoryOpts {
  readonly worktreeProvisioner: TaskWorktreeProvisioner;
}

/** 装配 CLI 入口的 worktree isolation host opts（provision 纯透传）。 */
export function createWorktreeIsolationHost(
  opts: WorktreeHostFactoryOpts
): WorktreeIsolationHostOpts {
  const { worktreeProvisioner } = opts;
  // 纯透传走共享 SSOT（PR #869 漏改点修复；禁止入口级手工解构）。
  return createWorktreeHostProvision({
    provisionWorktree: (ctx) => worktreeProvisioner.provision(ctx),
  });
}
