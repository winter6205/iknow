import type { WorkspaceGroup } from "./session-list";

/**
 * serve-workspace T6: Sidebar 工作空间组头部"+"按钮可见性判定。
 *
 * 仅当组**不是**"(未绑定)"时显示 — "(未绑定)" 组的会话是历史遗留, 它们
 * 没有 workspaceRoot, 用户无法在 "(未绑定)" 内"新建会话": 后端 createSession
 * 取 picker 当前 boundRoot, 重新建的还是带根会话, 不会落入 "(未绑定)"
 * 组(unbound key 是 sentinel, 不与真实路径同形态)。所以 + 在该组上既无
 * 业务意义也容易误导, 一律隐藏。
 *
 * 纯函数: 输入 group, 返回 boolean。供单测与 JSX 复用。
 */
export function shouldShowPlusButton(group: WorkspaceGroup): boolean {
  return !group.isUnbound;
}

/**
 * serve-workspace T6: + 按钮 aria-label / title 文案。模板化使单测能
 * 直接 assert "在 <basename> 内新建会话" 形态, 避免 JSX 字面值漂移。
 */
export function plusButtonLabel(groupLabel: string): string {
  return `在 ${groupLabel} 内新建会话`;
}
