/**
 * git 作业纪律段正文（spec `specs/git-work.md`）。
 *
 * 模块责任:告诉主代理如何用既有 `bash` 完成版本库侧效应链。
 * 不注册 git ACI 工具；不进 bash handler；不重排 LOCKED 六段。
 * 本 const 是 SSOT，装配时只引用，绝不切片成第二段。
 * 远端 push 不进本段（用户授权 + 既有网络权限，不进 identity）。
 */

/** 加性纪律段正文（不含标题——标题由 gitWorkSegment 渲染）。 */
export const IKNOW_GIT_WORK_TEXT = `
Version-control side effects (workspace change → git add → git commit) go through the existing \`bash\` tool. There is no dedicated git ACI tool.

- If \`create-worktree\` is available, call it before committing, then commit only inside that task worktree. Do not write the main checkout to work around isolation.
- Never use \`git commit --no-verify\` or \`-n\`.
- Do not delegate mutating git (commit or staging for commit) to a readonly sub-agent. Parent-session bash only.
`.trim();

/** 加性段渲染:段标题 + 正文。缺席路径不得调用本函数写空串。 */
export function gitWorkSegment(text: string): string {
  return `## Git work\n${text}`;
}
