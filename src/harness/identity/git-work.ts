/**
 * Git-work discipline segment body.
 *
 * Responsibility: tell the main agent how to run version-control side-effect
 * chains with the existing `bash` tool. No git ACI tool is registered; not
 * wired into the bash handler; does not reorder the LOCKED six segments.
 * This const is the SSOT — referenced at assembly time, never sliced into a
 * second segment. Remote push stays out of this segment (user authorization +
 * existing network permissions, not identity's concern).
 */

/** Additive discipline segment body (title excluded — gitWorkSegment renders it). */
export const IKNOW_GIT_WORK_TEXT = `
Version-control side effects (workspace change → git add → git commit) go through the existing \`bash\` tool. There is no dedicated git ACI tool.

- If \`create-worktree\` is available, call it before committing, then commit only inside that task worktree. Do not write the main checkout to work around isolation.
- Never use \`git commit --no-verify\` or \`-n\`.
- Do not delegate mutating git (commit or staging for commit) to a readonly sub-agent. Parent-session bash only.
`.trim();

/** Additive segment rendering: title + body. The absent path must not call
 *  this function to write an empty string. */
export function gitWorkSegment(text: string): string {
  return `## Git work\n${text}`;
}
