import type { WorkspaceGroup } from "./session-list";

/**
 * Visibility rule for the "+" button on a sidebar
 * workspace-group header.
 *
 * Shown only when the group is not "(未绑定)" (unbound). Sessions in the
 * unbound group are legacy rows without a workspaceRoot, and "new session"
 * inside that group is impossible: backend createSession takes the picker's
 * current boundRoot, so a rebuilt session still carries a root and never
 * lands in the unbound bucket (its key is a sentinel that can't collide with
 * a real path). A "+" there is meaningless and misleading — always hidden.
 *
 * Pure function: group -> boolean, shared by unit tests and JSX.
 */
export function shouldShowPlusButton(group: WorkspaceGroup): boolean {
  return !group.isUnbound;
}

/**
 * Aria-label / title text for the "+" button. Templatized
 * so unit tests can assert the "在 <basename> 内新建会话" (new session in
 * <basename>) shape directly, without drifting from JSX literals.
 */
export function plusButtonLabel(groupLabel: string): string {
  return `在 ${groupLabel} 内新建会话`;
}
