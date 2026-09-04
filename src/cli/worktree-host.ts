/**
 * src/cli/worktree-host.ts
 *
 * CLI 入口的 worktree isolation host 缝装配（ADR-0037 review High-1）。
 * 抽成独立工厂是为了让装配点可单测——PR #869 的 `name` 透传就是因为在
 * `cli.ts` main() 内联手工解构、测试够不到而静默漏改的。
 *
 * 纯透传契约：host 缝收到什么 ctx 就把什么交给 provisioner，不逐字段
 * 手工解构。未来 WorktreeProvisionContext 新增字段时这里零改动。
 */
import type { WorktreeIsolationHostOpts } from "../harness/isolation/worktree-gate.js";
import type { TaskWorktreeProvisioner } from "../session-api/worktree-rebind.js";

/** CLI host 缝装配依赖：provisioner 由调用方（cli.ts main）构造注入。 */
export interface WorktreeHostFactoryOpts {
  readonly worktreeProvisioner: TaskWorktreeProvisioner;
}

/** 装配 CLI 入口的 worktree isolation host opts（provision 纯透传）。 */
export function createWorktreeIsolationHost(
  opts: WorktreeHostFactoryOpts
): WorktreeIsolationHostOpts {
  const { worktreeProvisioner } = opts;
  // 纯透传（PR #869 漏改点修复）：手工解构在新增字段时会静默丢字段且编译
  // 仍绿；整 ctx 交给 provisioner，未来 WorktreeProvisionContext 新增字段
  // 时这里零改动。
  return {
    provision: (ctx) => worktreeProvisioner.provision(ctx),
  };
}
