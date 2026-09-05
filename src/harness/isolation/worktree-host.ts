/**
 * src/harness/isolation/worktree-host.ts
 *
 * worktree isolation host `provision` 缝的**共享装配 SSOT**（ADR-0037）。
 *
 * 背景：缝契约（WorktreeIsolationHostOpts.provision →
 * WorktreeProvisionContext）是共享类型，但历史上每个入口各自内联手写
 * wrapper——手工逐字段解构在 WorktreeProvisionContext 新增字段时会静默
 * 丢字段且编译仍绿。这个模式已经两次撞成真 bug：
 *
 * - PR #881：cli.ts main() 内联解构丢 `name` → CLI 全部退化 UUID-only 叶子；
 * - 2026-09-05（trace dfce6b4f）：tui/run.tsx 内联解构丢 `name` → TUI 同款
 *   退化，模型传入合法 label 仍建出 UUID 树。
 *
 * 规则：任何入口（cli / tui / serve / hub / 未来新增）装配 provision 缝时
 * **必须**经由本工厂，禁止再手写逐字段解构 wrapper。工厂只做整 ctx
 * 纯透传；未来 WorktreeProvisionContext 新增字段时这里零改动。
 */
import type {
  WorktreeProvisionContext,
  WorktreeProvisionFn,
} from "./worktree-gate.js";

/** 共享 provision 缝装配依赖：hub 侧实现由入口注入。 */
export interface WorktreeHostProvisionOpts {
  /**
   * Hub 侧 provision 实现——收到**完整** WorktreeProvisionContext（含
   * `name`）。同步抛错 = fail-closed（如 hub 未就绪）。
   */
  readonly provisionWorktree: (
    ctx: WorktreeProvisionContext
  ) => Promise<string>;
}

/**
 * 装配 worktree isolation host 的 `provision` 字段（整 ctx 纯透传）。
 * 返回值直接填进 `WorktreeIsolationHostOpts.provision`。
 */
export function createWorktreeHostProvision(opts: WorktreeHostProvisionOpts): {
  provision: WorktreeProvisionFn;
} {
  const { provisionWorktree } = opts;
  return {
    provision: (ctx) => provisionWorktree(ctx),
  };
}
