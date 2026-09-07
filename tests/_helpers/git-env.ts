/**
 * 测试内 git 子进程调用的 env 免疫层。
 *
 * 背景：`git push` 等父 git 操作会向 hook 注入 GIT_DIR / GIT_WORK_TREE /
 * GIT_INDEX_FILE / GIT_OBJECT_DIRECTORY 等环境变量（worktree 场景下指向父
 * 仓库的 worktree gitdir）。husky pre-push → vitest → 测试内 `git init` 的
 * 临时 repo 会继承这些变量：GIT_DIR 钉死后 `git commit` 实际落到父仓库上，
 * 触发 husky pre-commit 并报 "Current directory is not a git directory!"，
 * 表现为「单独跑全过、push 时稳定挂」的幽灵失败。
 *
 * 唯一正确解法是测试发起的 git 子进程剥离这些环境变量，让临时 repo 按自己
 * 的 cwd 语义运行。使用方：tests 内 execFileSync("git", ...) 的统一入口。
 */
import { execFileSync } from "node:child_process";

const GIT_INHERITED_VARS = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_COMMON_DIR",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CEILING_DIRECTORIES",
  "GIT_CONFIG",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_PREFIX",
  "GIT_SUPER_PREFIX",
] as const;

/** 剥离父 git 注入的 env，返回可安全用于测试内 git 子进程的环境变量。 */
export function gitTestEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of GIT_INHERITED_VARS) {
    delete env[key];
  }
  return env;
}

/** execFileSync("git", args) 的测试专用形态：cwd 必填，env 已免疫。 */
export function gitIn(cwd: string, args: readonly string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: gitTestEnv(),
  });
}
